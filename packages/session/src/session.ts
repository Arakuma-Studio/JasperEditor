// EditorSession (ARCHITECTURE §6, S01 §14–§17): one per open project, on a zustand vanilla store.
// Only EditorSession methods call setState; the document changes only through apply() and gestures.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	type CommandContext,
	diffDocuments,
	type Issue,
	invariantMode,
	type Origin,
	type ProjectDocument,
	type TransactionResult,
	TX_PROTOCOL,
	type TxInput,
	verifyDocument,
} from '@jasper/project';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { defaultMediaRuntime, defaultSequenceView, defaultToggles } from './defaults.ts';
import { agentLabel, COALESCE_WINDOW_MS, History } from './history.ts';
import type { ProjectStore, ProjectViewState } from './persistence/types.ts';
import { LeaseHeldError } from './persistence/types.ts';
import { combine, emptySelection, expandClipSelection, filterSelection } from './selection.ts';
import { TransportStore } from './transport.ts';
import type {
	MediaRuntime,
	Selection,
	SelectionDomain,
	SelectMode,
	SequenceViewState,
	SessionEventName,
	SessionEvents,
	SessionState,
	SessionToggles,
	Unsubscribe,
} from './types.ts';

export type SessionContext = Omit<CommandContext, 'revision' | 'selection' | 'entityRevisions'>;

/**
 * Transaction input accepted by the session; `coalesceKey` merges repeated user edits (S01:UND-006). `selectAfter`
 * (S01:SEL-006/008) picks the selection that follows the result (pasted clips, pasted items): it becomes the
 * history entry's "after" selection, so Redo restores it too.
 */
export type SessionTxInput = TxInput & {
	coalesceKey?: string;
	selectAfter?: (
		result: Extract<TransactionResult, { ok: true }>,
	) => { timeline?: readonly string[]; project?: readonly string[] } | null;
};

export type EditorSessionOptions = {
	projectId: string;
	document: ProjectDocument;
	revision?: number;
	ctx: SessionContext;
	store?: ProjectStore;
	engine?: EngineClient;
	readOnly?: boolean;
	view?: ProjectViewState | null;
	openIssues?: Issue[];
	historyCapacity?: number;
	coalesceWindowMs?: number;
	/** Run invariants on every gesture update (dev builds). Default false. */
	devInvariants?: boolean;
	clock?: () => number;
	sessionId?: string;
};

export interface Gesture {
	readonly label: string;
	readonly active: boolean;
	/** Re-applies the command list to the base document (never cumulative, S01:SES-006). */
	update(commands: SessionTxInput['commands']): TransactionResult;
	commit(): TransactionResult | null;
	cancel(): void;
}

type Queued = { tx: SessionTxInput; resolve(r: TransactionResult): void };

const READ_ONLY_RESULT = (revision: number): TransactionResult => ({
	ok: false,
	revision,
	errors: [{ commandIndex: -1, code: 'E_NOT_OWNER', message: 'This session is read-only' }],
});

export class EditorSession {
	readonly store: StoreApi<SessionState>;
	readonly transport = new TransportStore();
	readonly projectId: string;
	readonly sessionId: string;
	readonly ctx: SessionContext;
	readonly engine?: EngineClient;
	readonly projectStore?: ProjectStore;
	private readonly history: History;
	private readonly listeners = new Map<SessionEventName, Set<(p: never) => void>>();
	private readonly entityRevisions = new Map<string, number>();
	private readonly queue: Queued[] = [];
	private readonly clock: () => number;
	private readonly coalesceWindowMs: number;
	private readonly devInvariants: boolean;
	private gestureState: {
		label: string;
		base: ProjectDocument;
		commands: SessionTxInput['commands'] | null;
		baseRevision: number;
	} | null = null;
	private closed = false;
	private readonly txGuards = new Set<(tx: SessionTxInput) => Issue | null>();
	private leaseTimer: ReturnType<typeof setInterval> | null = null;

	constructor(opts: EditorSessionOptions) {
		this.projectId = opts.projectId;
		this.sessionId = opts.sessionId ?? `ses_${Math.random().toString(36).slice(2, 12)}`;
		this.ctx = opts.ctx;
		this.engine = opts.engine;
		this.projectStore = opts.store;
		this.clock = opts.clock ?? (() => Date.now());
		this.coalesceWindowMs = opts.coalesceWindowMs ?? COALESCE_WINDOW_MS;
		this.devInvariants = opts.devInvariants ?? false;
		this.history = new History(opts.historyCapacity);
		const seqIds = Object.keys(opts.document.sequences);
		const savedViews = opts.view?.views ?? {};
		const views: Record<string, SequenceViewState> = {};
		for (const id of seqIds) views[id] = { ...defaultSequenceView(), ...(savedViews[id] ?? {}) };
		const active =
			opts.view?.activeSequenceId && opts.document.sequences[opts.view.activeSequenceId]
				? opts.view.activeSequenceId
				: (seqIds[0] ?? null);
		this.store = createStore<SessionState>(() => ({
			document: opts.document,
			revision: opts.revision ?? 0,
			transient: null,
			gesture: null,
			selection: emptySelection(),
			views,
			tabs: {
				open: opts.view?.tabs.open.filter((id) => opts.document.sequences[id]) ?? (active ? [active] : []),
			},
			activeSequenceId: active,
			toggles: defaultToggles(),
			media: {},
			history: this.history.view(),
			dirty: false,
			lease: { status: opts.readOnly ? 'read-only' : 'none', leaseId: null },
			readOnly: !!opts.readOnly,
			openIssues: opts.openIssues ?? [],
		}));
		this.verifyWhenIdle();
	}

	private verifyScheduled = false;
	/** Warm invariant caches off the first edit's critical path, only when the browser supports idle work. */
	private verifyWhenIdle(): void {
		const ric = globalThis.requestIdleCallback;
		if (typeof ric !== 'function' || this.verifyScheduled) return;
		this.verifyScheduled = true;
		ric(
			() => {
				this.verifyScheduled = false;
				if (this.closed || invariantMode() === 'full') return;
				const registries = (this.ctx as Partial<CommandContext>).registries;
				verifyDocument(this.store.getState().document, registries ? { effects: registries.effects } : {});
			},
			{ timeout: 5000 },
		);
	}

	/** Opens a project through a ProjectStore and takes the lease; a held lease opens read-only (S01:PER-040). */
	static async open(opts: {
		store: ProjectStore;
		projectId: string;
		ctx: SessionContext;
		engine?: EngineClient;
		readOnly?: boolean;
		sessionId?: string;
	}): Promise<EditorSession> {
		const opened = await opts.store.open(opts.projectId, { readOnly: opts.readOnly });
		const session = new EditorSession({
			projectId: opts.projectId,
			document: opened.document,
			revision: opened.revision,
			ctx: opts.ctx,
			store: opts.store,
			engine: opts.engine,
			readOnly: opened.readOnly,
			view: opened.view,
			openIssues: [
				...opened.issues,
				...opened.repairs.map((r) => ({
					commandIndex: -1,
					code: 'W_REPAIRED',
					message: `${r.action} ${r.entity}: ${r.detail}`,
				})),
			],
			sessionId: opts.sessionId,
		});
		if (!opened.readOnly) await session.acquireLease();
		return session;
	}

	private async acquireLease(): Promise<void> {
		const store = this.projectStore;
		if (!store) return;
		try {
			const lease = await store.acquireLease(this.projectId, this.sessionId);
			this.store.setState({ lease: { status: 'held', leaseId: lease.leaseId } });
			if (store.heartbeatLease) {
				this.leaseTimer = setInterval(() => {
					void store.heartbeatLease!(this.projectId, lease.leaseId).catch(() =>
						this.store.setState({ lease: { status: 'lost', leaseId: lease.leaseId } }),
					);
				}, lease.heartbeatMs);
				(this.leaseTimer as { unref?: () => void }).unref?.();
			}
		} catch (e) {
			if (e instanceof LeaseHeldError)
				this.store.setState({
					readOnly: true,
					lease: { status: 'read-only', leaseId: null, holder: e.holderSessionId },
				});
			else throw e;
		}
	}

	getState(): SessionState {
		return this.store.getState();
	}
	/** The committed document (autosave, agents, clipboard; S01:SES-007). */
	getCommitted(): ProjectDocument {
		return this.store.getState().document;
	}
	/** The transient gesture document if any, else the committed one (timeline, monitors). */
	getDrawn(): ProjectDocument {
		const s = this.store.getState();
		return s.transient ?? s.document;
	}
	get revision(): number {
		return this.store.getState().revision;
	}
	get gestureActive(): boolean {
		return this.gestureState !== null;
	}
	/** Last-changed revision per entity, for the AGT-010 fast-forward rule. */
	getEntityRevisions(): ReadonlyMap<string, number> {
		return this.entityRevisions;
	}

	on<E extends SessionEventName>(event: E, cb: (payload: SessionEvents[E]) => void): Unsubscribe {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(cb as (p: never) => void);
		return () => set.delete(cb as (p: never) => void);
	}
	private emit<E extends SessionEventName>(event: E, payload: SessionEvents[E]): void {
		for (const cb of [...(this.listeners.get(event) ?? [])]) (cb as (p: SessionEvents[E]) => void)(payload);
	}

	private commandContext(extra: Partial<CommandContext> = {}): CommandContext {
		const s = this.store.getState();
		return {
			...this.ctx,
			revision: s.revision,
			selection: { clips: s.selection.timeline.clips, primaryClip: s.selection.timeline.primaryClip },
			entityRevisions: this.entityRevisions,
			...extra,
		};
	}

	/**
	 * Applies a transaction (S01:SES-003). While a gesture is active, agent transactions must use
	 * `submit()` (they are queued, S01:SES-006); `apply()` refuses them with `E_QUEUED`.
	 */
	apply(tx: SessionTxInput): TransactionResult {
		const s = this.store.getState();
		if (this.closed)
			return {
				ok: false,
				revision: s.revision,
				errors: [{ commandIndex: -1, code: 'E_NO_SESSION', message: 'Session closed' }],
			};
		if (s.readOnly) return READ_ONLY_RESULT(s.revision);
		for (const guard of this.txGuards) {
			const refused = guard(tx);
			if (refused) return { ok: false, revision: s.revision, errors: [refused] };
		}
		if (this.gestureState && tx.origin !== 'user' && tx.origin !== 'system') {
			return {
				ok: false,
				revision: s.revision,
				errors: [{ commandIndex: -1, code: 'E_QUEUED', message: 'A gesture is in progress; use submit()' }],
			};
		}
		return this.commit(tx, this.commandContext());
	}

	/**
	 * A host check every transaction passes before it applies; returning an issue refuses it. The web app refuses
	 * destructive edits that an agent's live-UI automation triggers (they need the user's approval, security
	 * review AGT-1).
	 */
	addTxGuard(guard: (tx: SessionTxInput) => Issue | null): () => void {
		this.txGuards.add(guard);
		return () => {
			this.txGuards.delete(guard);
		};
	}

	/** Applies now, or after the active gesture ends (agent transactions, S01:SES-006, S02:TL-056). */
	submit(tx: SessionTxInput): Promise<TransactionResult> {
		if (!this.gestureState) return Promise.resolve(this.apply(tx));
		return new Promise((resolve) => this.queue.push({ tx, resolve }));
	}

	private commit(tx: SessionTxInput, ctx: CommandContext): TransactionResult {
		const before = this.store.getState();
		const { coalesceKey, selectAfter, ...rest } = tx;
		const { document, result } = applyTransaction(before.document, { protocol: TX_PROTOCOL, ...rest }, ctx);
		if (!result.ok || tx.dryRun || document === before.document) return result;
		const origin = tx.origin as Origin;
		const label = agentLabel(tx.label, origin);
		let selectionAfter = filterSelection(before.selection, document);
		const follow = selectAfter?.(result);
		if (follow) {
			const s = selectionAfter;
			const clips = follow.timeline
				? [...new Set(follow.timeline)].filter((id) => isClipIn(document, id))
				: null;
			const items = follow.project ? [...new Set(follow.project)].filter((id) => !!document.items[id]) : null;
			selectionAfter = {
				...s,
				...(clips
					? { timeline: { ...s.timeline, clips, transitions: [], gaps: [], primaryClip: clips[0] ?? null } }
					: {}),
				...(items ? { project: { items, primary: items[items.length - 1] ?? null } } : {}),
			};
		}
		for (const id of [...result.created, ...result.changed, ...result.deleted])
			this.entityRevisions.set(id, result.revision);
		if (origin !== 'system' && origin !== 'migration') {
			this.history.push(
				{
					label,
					origin,
					time: this.clock(),
					revisionBefore: before.revision,
					revisionAfter: result.revision,
					before: before.document,
					after: document,
					selectionBefore: before.selection,
					selectionAfter,
					created: result.created,
					changed: result.changed,
					deleted: result.deleted,
					coalesceKey,
				},
				this.clock(),
				this.coalesceWindowMs,
			);
		}
		this.store.setState({
			document,
			revision: result.revision,
			selection: selectionAfter,
			views: this.syncViews(document, before.views),
			history: this.history.view(),
			dirty: true,
		});
		this.transport.setMaxFrame(Number.POSITIVE_INFINITY);
		this.emit('doc.changed', {
			revision: result.revision,
			label,
			origin,
			created: result.created,
			changed: result.changed,
			deleted: result.deleted,
			isUndo: false,
			isRedo: false,
		});
		if (typeof origin === 'object') {
			const clips = [...result.created, ...result.changed].filter((id) => id.startsWith('clp_'));
			if (clips.length) this.emit('agent.flash', { clipIds: clips, agent: origin.agent });
		}
		if (selectionAfter !== before.selection) this.emit('selection.changed', { selection: selectionAfter });
		return result;
	}

	private syncViews(
		doc: ProjectDocument,
		views: Record<string, SequenceViewState>,
	): Record<string, SequenceViewState> {
		const ids = Object.keys(doc.sequences);
		if (ids.length === Object.keys(views).length && ids.every((id) => views[id])) return views;
		const next: Record<string, SequenceViewState> = {};
		for (const id of ids) next[id] = views[id] ?? defaultSequenceView();
		return next;
	}

	/**
	 * Replaces the committed document with `doc` as one undoable History step (File ▸ Recover Unsaved Changes,
	 * S01:PER-021). `doc` must belong to this project and have been through the load pipeline (migrated,
	 * validated, repaired). The session becomes dirty, so autosave writes it; Undo returns to the document before.
	 */
	replaceDocument(doc: ProjectDocument, label: string): TransactionResult {
		const before = this.store.getState();
		const fail = (code: string, message: string): TransactionResult => ({
			ok: false,
			revision: before.revision,
			errors: [{ commandIndex: -1, code, message }],
		});
		if (this.closed) return fail('E_NO_SESSION', 'Session closed');
		if (before.readOnly) return READ_ONLY_RESULT(before.revision);
		if (this.gestureState) return fail('E_QUEUED', 'A gesture is in progress');
		if (doc.projectId !== this.projectId)
			return fail('E_INVALID_PARAM', 'The document belongs to another project');
		if (doc === before.document) return fail('E_INVALID_PARAM', 'Nothing to replace');
		const revision = before.revision + 1;
		const selection = filterSelection(before.selection, doc);
		const origin: Origin = 'user';
		// Any entity may differ: agents holding an older revision must not fast-forward over it (AGT-010).
		for (const d of [before.document, doc])
			for (const id of entityIds(d)) this.entityRevisions.set(id, revision);
		this.history.push(
			{
				label,
				origin,
				time: this.clock(),
				revisionBefore: before.revision,
				revisionAfter: revision,
				before: before.document,
				after: doc,
				selectionBefore: before.selection,
				selectionAfter: selection,
				created: [],
				changed: [],
				deleted: [],
			},
			this.clock(),
			0,
		);
		this.store.setState({
			document: doc,
			revision,
			selection,
			views: this.syncViews(doc, before.views),
			history: this.history.view(),
			dirty: true,
		});
		this.transport.setMaxFrame(Number.POSITIVE_INFINITY);
		this.emit('doc.changed', {
			revision,
			label,
			origin,
			created: [],
			changed: [],
			deleted: [],
			isUndo: false,
			isRedo: false,
		});
		if (selection !== before.selection) this.emit('selection.changed', { selection });
		this.verifyWhenIdle();
		return { ok: true, revision, refs: {}, created: [], changed: [], deleted: [], warnings: [], results: [] };
	}

	beginGesture(label: string): Gesture {
		if (this.gestureState) throw new Error(`Gesture "${this.gestureState.label}" is already active`);
		const s = this.store.getState();
		const state = {
			label,
			base: s.document,
			commands: null as SessionTxInput['commands'] | null,
			baseRevision: s.revision,
		};
		this.gestureState = state;
		this.store.setState({ gesture: { label } });
		this.emit('gesture.changed', { active: true, label });
		const self = this;
		const ensure = () => {
			if (self.gestureState !== state) throw new Error('Gesture is no longer active');
		};
		return {
			label,
			get active() {
				return self.gestureState === state;
			},
			update(commands) {
				ensure();
				const { document, result } = applyTransaction(
					state.base,
					{ protocol: TX_PROTOCOL, label, origin: 'user', commands },
					self.commandContext({ checkInvariants: self.devInvariants, revision: state.baseRevision }),
				);
				if (result.ok) {
					state.commands = commands;
					self.store.setState({ transient: document === state.base ? null : document });
				}
				return result;
			},
			commit() {
				ensure();
				const commands = state.commands;
				self.endGesture();
				const result =
					commands && commands.length > 0
						? self.commit({ label, origin: 'user', commands }, self.commandContext())
						: null;
				self.flushQueue();
				return result;
			},
			cancel() {
				if (self.gestureState !== state) return;
				self.endGesture();
				self.flushQueue();
			},
		};
	}

	private endGesture(): void {
		const label = this.gestureState?.label ?? null;
		this.gestureState = null;
		this.store.setState({ gesture: null, transient: null });
		this.emit('gesture.changed', { active: false, label });
	}

	private flushQueue(): void {
		while (this.queue.length > 0 && !this.gestureState) {
			const q = this.queue.shift()!;
			q.resolve(this.apply(q.tx));
		}
	}

	/** Undo; agents may only undo their own top entry (S01:UND-008). */
	undo(opts: { agent?: string } = {}): { ok: boolean; code?: string; label?: string } {
		if (this.gestureState || this.store.getState().readOnly) return { ok: false, code: 'E_BUSY' };
		const top = this.history.peekUndo();
		if (!top) return { ok: false, code: 'E_NOT_FOUND' };
		if (opts.agent !== undefined && !(typeof top.origin === 'object' && top.origin.agent === opts.agent))
			return { ok: false, code: 'E_NOT_OWNER' };
		this.history.undo();
		this.restore(top.before, top.selectionBefore, top.label, top.origin, { isUndo: true, isRedo: false });
		return { ok: true, label: top.label };
	}

	redo(opts: { agent?: string } = {}): { ok: boolean; code?: string; label?: string } {
		if (this.gestureState || this.store.getState().readOnly) return { ok: false, code: 'E_BUSY' };
		const next = this.history.peekRedo();
		if (!next) return { ok: false, code: 'E_NOT_FOUND' };
		if (opts.agent !== undefined && !(typeof next.origin === 'object' && next.origin.agent === opts.agent))
			return { ok: false, code: 'E_NOT_OWNER' };
		this.history.redo();
		this.restore(next.after, next.selectionAfter, next.label, next.origin, { isUndo: false, isRedo: true });
		return { ok: true, label: next.label };
	}

	/** History panel: move to the state after entry `index - 1` (0 = opened state). */
	jumpTo(index: number): void {
		while (this.history.position > index && this.undo().ok) {}
		while (this.history.position < index && this.redo().ok) {}
	}

	clearHistory(): void {
		this.history.clear();
		this.store.setState({ history: this.history.view() });
	}

	private restore(
		doc: ProjectDocument,
		selection: Selection,
		label: string,
		origin: Origin,
		flags: { isUndo: boolean; isRedo: boolean },
	): void {
		const s = this.store.getState();
		const diff = diffDocuments(s.document, doc);
		const revision = s.revision + 1;
		for (const id of [...diff.created, ...diff.changed, ...diff.deleted])
			this.entityRevisions.set(id, revision);
		const sel = filterSelection(selection, doc);
		this.store.setState({
			document: doc,
			revision,
			selection: sel,
			views: this.syncViews(doc, s.views),
			history: this.history.view(),
			dirty: true,
		});
		this.emit('doc.changed', { revision, label, origin, ...diff, ...flags });
		this.emit('selection.changed', { selection: sel });
	}

	select(
		domain: SelectionDomain,
		ids: readonly string[],
		mode: SelectMode = 'replace',
		opts: { linked?: boolean; primary?: string | null; groups?: boolean } = {},
	): void {
		const s = this.store.getState();
		const sel = s.selection;
		let next: Selection;
		switch (domain) {
			case 'timeline': {
				const linked = opts.linked ?? s.toggles.linkedSelection;
				const expanded = expandClipSelection(this.getDrawn(), ids, linked, opts.groups ?? true);
				const clips = combine(sel.timeline.clips, expanded, mode);
				const primary =
					opts.primary !== undefined
						? opts.primary
						: mode === 'remove'
							? clips.includes(sel.timeline.primaryClip ?? '')
								? sel.timeline.primaryClip
								: null
							: (ids[ids.length - 1] ?? null);
				next = {
					...sel,
					timeline: {
						...sel.timeline,
						clips,
						primaryClip: primary && clips.includes(primary) ? primary : (clips[clips.length - 1] ?? null),
					},
				};
				break;
			}
			case 'transitions':
				next = {
					...sel,
					timeline: { ...sel.timeline, transitions: combine(sel.timeline.transitions, ids, mode) },
				};
				break;
			case 'project': {
				const items = combine(sel.project.items, ids, mode);
				next = {
					...sel,
					project: {
						items,
						primary: items.includes(ids[ids.length - 1] ?? '')
							? ids[ids.length - 1]!
							: (items[items.length - 1] ?? null),
					},
				};
				break;
			}
			case 'markers':
				next = { ...sel, markers: combine(sel.markers, ids, mode) };
				break;
			case 'tracks':
				next = { ...sel, tracks: combine(sel.tracks, ids, mode) };
				break;
			default:
				return;
		}
		this.setSelection(next);
	}

	selectGaps(gaps: Selection['timeline']['gaps']): void {
		this.setSelection({
			...this.store.getState().selection,
			timeline: { ...this.store.getState().selection.timeline, gaps },
		});
	}
	selectKeyframes(k: Selection['keyframes']): void {
		this.setSelection({ ...this.store.getState().selection, keyframes: k });
	}
	clearSelection(domain?: SelectionDomain): void {
		if (!domain) this.setSelection(emptySelection());
		else this.select(domain, [], 'replace');
	}
	private setSelection(selection: Selection): void {
		this.store.setState({ selection });
		this.emit('selection.changed', { selection });
	}

	setView(sequenceId: string, patch: Partial<SequenceViewState>): void {
		const views = this.store.getState().views;
		this.store.setState({
			views: { ...views, [sequenceId]: { ...(views[sequenceId] ?? defaultSequenceView()), ...patch } },
		});
	}
	openSequence(sequenceId: string): void {
		const s = this.store.getState();
		if (!s.document.sequences[sequenceId]) return;
		this.store.setState({
			activeSequenceId: sequenceId,
			tabs: { open: s.tabs.open.includes(sequenceId) ? s.tabs.open : [...s.tabs.open, sequenceId] },
		});
	}
	closeSequenceTab(sequenceId: string): void {
		const s = this.store.getState();
		const open = s.tabs.open.filter((x) => x !== sequenceId);
		this.store.setState({
			tabs: { open },
			activeSequenceId: s.activeSequenceId === sequenceId ? (open[0] ?? null) : s.activeSequenceId,
		});
	}
	setToggles(patch: Partial<SessionToggles>): void {
		this.store.setState({ toggles: { ...this.store.getState().toggles, ...patch } });
	}
	setMediaRuntime(mediaId: string, patch: Partial<MediaRuntime>): void {
		this.setMediaRuntimes([[mediaId, patch]]);
	}
	/** Batch ordered patches so resolving many assets notifies each subscriber once. */
	setMediaRuntimes(patches: Iterable<readonly [string, Partial<MediaRuntime>]>): void {
		const media = { ...this.store.getState().media };
		let changed = false;
		for (const [id, patch] of patches) {
			media[id] = { ...(media[id] ?? defaultMediaRuntime()), ...patch };
			changed = true;
		}
		if (changed) this.store.setState({ media });
	}
	viewRecord(): ProjectViewState {
		const s = this.store.getState();
		return { version: 1, views: s.views, tabs: s.tabs, activeSequenceId: s.activeSequenceId };
	}
	markSaved(revision: number): void {
		if (this.store.getState().revision === revision) this.store.setState({ dirty: false });
	}

	/** Cancels any gesture, releases the lease and notifies listeners. Autosave flushing is the caller's job. */
	async close(): Promise<void> {
		if (this.closed) return;
		if (this.gestureState) this.endGesture();
		this.closed = true;
		for (const q of this.queue.splice(0))
			q.resolve({
				ok: false,
				revision: this.revision,
				errors: [{ commandIndex: -1, code: 'E_NO_SESSION', message: 'Session closed' }],
			});
		if (this.leaseTimer) clearInterval(this.leaseTimer);
		const lease = this.store.getState().lease;
		if (lease.status === 'held' && lease.leaseId && this.projectStore?.releaseLease) {
			await this.projectStore.releaseLease(this.projectId, lease.leaseId).catch(() => undefined);
		}
		this.emit('closed', {});
		this.listeners.clear();
	}
}

function entityIds(doc: ProjectDocument): string[] {
	const ids = [...Object.keys(doc.items), ...Object.keys(doc.media), ...Object.keys(doc.sequences)];
	for (const seq of Object.values(doc.sequences)) {
		ids.push(...Object.keys(seq.clips), ...Object.keys(seq.transitions ?? {}));
		for (const t of [...seq.videoTracks, ...seq.audioTracks]) ids.push(t.id);
	}
	return ids;
}

function isClipIn(doc: ProjectDocument, clipId: string): boolean {
	return Object.values(doc.sequences).some((seq) => !!seq.clips[clipId]);
}
