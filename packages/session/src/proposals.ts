// Proposals slice of a session (spec 12 §2.5 "Session", P3-R4): the project's proposals kept in sync with the engine
// (list + `proposal.changed`), the one under review, its local decisions, a preview document and the ghosts.
//
// - The engine stores proposals and their decided states (rejected, applied = `accepted`). "Accepted but not applied
//   yet" is a local decision of this window until Apply; reject / clear go to the engine (`reject` / `reopen`).
// - `previewProposal` builds a NON-committed document on the committed one (one transaction per item, ids seeded per
//   item so a recomputed preview keeps its entities), recomputed debounced (150 ms) on `doc.changed` and on decision
//   changes, with a local re-validation (`revalidate`) that flags stale items. The Program monitor renders picture AND
//   sound from `preview.document` while `hear` is on; the session's document and History are never touched by it.
// - Apply (a trusted user gesture only) goes through the engine's accept route with the editor key: the engine composes
//   ONE transaction (`composeAcceptTx`), relays it into this session as the user's edit (History "Accept <title> (n of
//   m)", origin `user`) and records the items accepted atomically with it. Undoing that History entry reopens the items
//   (route `reopen`) with their decisions intact (they come back locally accepted); redoing it records them applied
//   again (route `applied`).
//
// Nothing here throws: every action resolves to `{ok: true, …}` or `{ok: false, code, message}`.
import type {
	ProposalAcceptResponse,
	ProposalChangedEvent,
	ProposalDecisionResponse,
	ProposalSummary,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	createSeededIdSource,
	dependencyClosure,
	isSetupItem,
	issueReason,
	type ProjectDocument,
	type Proposal,
	type ProposalContext,
	type ProposalGhost,
	type ProposalItem,
	type ProposalItemState,
	type ProposalPreview,
	previewProposal,
	previewProposalSteps,
	revalidate,
	type StaleProblem,
} from '@jasper/project';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { combine } from './selection.ts';
import type { EditorSession } from './session.ts';
import type { HistoryEntryView, SelectMode, Unsubscribe } from './types.ts';

/** The engine calls the slice makes (the editor's `EngineClient`; tests pass a fake). */
export type ProposalsEngine = Pick<
	EngineClient,
	| 'listProposals'
	| 'getProposal'
	| 'acceptProposal'
	| 'rejectProposal'
	| 'reopenProposal'
	| 'noteProposalItem'
	| 'selectProposalAlternative'
	| 'markProposalApplied'
	| 'deleteProposal'
> &
	// spec 15 EA-003 "Refresh proposal" (optional: an engine without it refuses the action with a reason)
	Partial<Pick<EngineClient, 'refreshProposal'>>;

/** What an item shows in review: the engine's state, refined by the local re-validation and decisions. */
export type ReviewItemState = 'pending' | 'accepted' | 'rejected' | 'stale' | 'invalid' | 'applied';

export type ReviewItem = {
	id: string;
	label: string;
	group: string;
	requires: string[];
	/**
	 * A setup item (`meta.setup`: a bin, a sound's media, a cue the placements need; WP3.2): the review folds it under
	 * the items that require it — their accept brings it, their reject settles it.
	 */
	setup: boolean;
	state: ReviewItemState;
	/** The stored state (engine). */
	engineState: ProposalItemState;
	/** Why it is stale / invalid (or the stored reason), in English (agents read the same). */
	reason?: string;
	/** Why it is stale, structured (the editor says it in the user's language); absent for a stored reason only. */
	problem?: StaleProblem;
	note?: string;
	/** Command sets to choose from (its own + alternatives), the chosen one and their labels. */
	alternatives: number;
	selectedAlternative: number;
	alternativeLabels: string[];
	meta: unknown;
	/** The meta of the chosen command set: the selected alternative's when it has one, else the item's. */
	selectedMeta?: unknown;
	/**
	 * Spec 17 SC-061: the item's default selection (false: offered unchecked, e.g. a Maybe transcript fix). Accept all
	 * leaves unselected items out; accepting one explicitly (✓, Enter) takes it.
	 */
	selected: boolean;
};

export type ProposalPreviewState = {
	proposalId: string;
	/** Session revision the preview was built on, and that committed document. */
	revision: number;
	base: ProjectDocument;
	/** What "Hear proposal" plays: pending, stale and locally accepted items applied (rejected ones left out). */
	document: ProjectDocument;
	/** Every reviewable item applied (rejected included), one transaction each: the ghosts' geometry. */
	result: ProposalPreview;
	/** `result.ghost`: every created / changed / deleted entity id. */
	ghost: ProposalGhost;
	/** Items applied in `document`, in order. */
	heard: string[];
	/** Entity id → the item whose transaction created, changed or deleted it. */
	owner: Record<string, string>;
};

export type ProposalsState = {
	status: 'idle' | 'loading' | 'ready' | 'error' | 'offline';
	/** Why the list could not be read. */
	error: string | null;
	/** The project's proposals (summaries, newest first). */
	list: ProposalSummary[];
	warnings: string[];
	/** The proposal under review (null: not reviewing). */
	activeId: string | null;
	/** It, as last read from the engine. */
	proposal: Proposal | null;
	/** Its items with their review state. */
	items: ReviewItem[];
	/** Local decisions: proposal id → items accepted here and not applied yet. */
	accepted: Record<string, string[]>;
	/** Selected review items (ids of `items`). */
	selection: string[];
	/** "Hear proposal" (A/B): the Program monitor plays `preview.document`. */
	hear: boolean;
	preview: ProposalPreviewState | null;
	/** Items the local re-validation found stale on the live document, with why. */
	stale: Record<string, string>;
	/** The same, structured (what moved where, which requirement, what failed). */
	staleProblems: Record<string, StaleProblem>;
	/** A route call is in flight. */
	busy: boolean;
	/** The preview is being rebuilt (a large proposal's preview is spread over several frames). */
	previewing: boolean;
	/** The last action that failed. */
	lastError: { code: string; message: string } | null;
};

export type ActionResult = { ok: true; changed: string[] } | { ok: false; code: string; message: string };

export type ApplyResult =
	| {
			ok: true;
			/** Items applied (the requested ones and what they require). */
			applied: string[];
			/** Requested items left out because they are stale on the current document. */
			stale: { itemId: string; reason: string }[];
			/** The History label of the one transaction ("Accept <title> (n of m)"). */
			label: string | null;
			revision: number | null;
			/**
			 * The per-command results of the accept transaction, in order (empty when nothing was applied): a producer's
			 * report after Apply (spec 17 SC-053: the subtitles a transcript fix patched or skipped).
			 */
			results: unknown[];
	  }
	| { ok: false; code: string; message: string; stale?: { itemId: string; reason: string }[] };

export type ItemDecision = 'accept' | 'reject' | 'clear';

export type ProposalsOptions = {
	engine?: ProposalsEngine | null;
	/** Debounce of the preview / re-validation recompute (default 150 ms). */
	debounceMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

const DEBOUNCE_MS = 150;
// Larger previews yield between 8 ms slices; the previous preview stays visible until completion.
const SLICE_MS = 8;
const SYNC_ITEMS = 64;

/** Fingerprints of command lists (by identity: a proposal fetched again brings new lists). */
const commandPrints = new WeakMap<readonly unknown[], string>();
/** FNV-1a and length of a command list's JSON: a refresh or Reroll replaces it under the same item id. */
function commandsPrint(commands: readonly unknown[]): string {
	let s = commandPrints.get(commands);
	if (s === undefined) {
		const json = JSON.stringify(commands);
		let h = 0x811c9dc5;
		for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
		s = `${(h >>> 0).toString(36)}.${json.length}`;
		commandPrints.set(commands, s);
	}
	return s;
}

/**
 * What a preview depends on in a proposal: which items it applies, with which command set (its content: a refresh or
 * Reroll re-plans an item in place) and recorded refs.
 */
function previewKey(p: Proposal, itemIds: readonly string[]): string {
	const want = new Set(itemIds);
	const parts: string[] = [p.id];
	for (const it of p.items) {
		if (want.has(it.id)) {
			const k = it.selectedAlternative ?? 0;
			const commands = k >= 1 ? (it.alternatives?.[k - 1]?.commands ?? []) : it.commands;
			parts.push(`${it.id}#${k}:${commandsPrint(commands)}`);
		} else if (it.state === 'accepted') parts.push(`${it.id}=${JSON.stringify(it.applied?.refs ?? {})}`);
	}
	return parts.join('|');
}
const LIST_DEBOUNCE_MS = 100;

/**
 * An applied accept followed through Undo / Redo of its History entry: this window's Apply, or any accept the engine
 * relayed into this session (an allowed agent's), learnt from `proposal.changed` `accepted`.
 */
type AppliedRecord = {
	proposalId: string;
	itemIds: string[];
	entryId: number;
	refs: Record<string, string>;
	/** What the accept created (`TransactionResult.created`): the engine checks it when recording a Redo. */
	created: string[];
	state: 'applied' | 'undone';
};

/** Engine answers to a follow-up that only say a race resolved itself (an Undo and a Redo in quick succession). */
const BENIGN_FOLLOW_UP = new Set([
	'E_STILL_APPLIED',
	'E_NOT_APPLIED',
	'PROPOSAL_STILL_APPLIED',
	'PROPOSAL_NOT_APPLIED',
]);

function errorOf(e: unknown): { code: string; message: string } {
	if (e && typeof e === 'object') {
		const o = e as { code?: unknown; message?: unknown; detail?: unknown };
		const detailCode = (o.detail as { code?: unknown } | undefined)?.code;
		const code =
			typeof detailCode === 'string' ? detailCode : typeof o.code === 'string' ? o.code : 'E_INTERNAL';
		return { code, message: typeof o.message === 'string' ? o.message : String(e) };
	}
	return { code: 'E_INTERNAL', message: String(e) };
}

const fail = (code: string, message: string) => ({ ok: false as const, code, message });

const reviewable = (s: ProposalItemState) => s === 'pending' || s === 'stale' || s === 'rejected';

/** The proposals slice of one session. Use `proposalsFor(session)`. */
export class ProposalsController {
	readonly store: StoreApi<ProposalsState>;
	private engine: ProposalsEngine | null;
	private readonly debounceMs: number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private recomputeTimer: unknown = null;
	private readonly clock: () => number;
	/** The preview being built in slices (null: none). */
	private job: { run: Generator<unknown, void, void>; timer: unknown } | null = null;
	/** The last previews built, reused while what they depend on is unchanged. */
	private memo: { doc: ProjectDocument; key: string; preview: ProposalPreview } | null = null;
	private heardMemo: { doc: ProjectDocument; key: string; preview: ProposalPreview } | null = null;
	private revalidated: {
		doc: ProjectDocument;
		proposal: Proposal;
		result: ReturnType<typeof revalidate>;
	} | null = null;
	/** Items the last preview could not apply (shown stale until the next preview says otherwise). */
	private lastFailed: Record<string, string> = {};
	private listTimer: unknown = null;
	private activeFetch = 0;
	private disposed = false;
	private readonly offs: Unsubscribe[] = [];
	private records: AppliedRecord[] = [];
	/** Undo / Redo follow-ups (reopen, applied) reach the engine one after another, in History order. */
	private followUps: Promise<void> = Promise.resolve();
	/** Decisions in flight (the stored state they will give), shown before the engine answers. */
	private optimistic = new Map<string, 'rejected' | 'pending'>();

	constructor(
		readonly session: EditorSession,
		opts: ProposalsOptions = {},
	) {
		this.engine = opts.engine ?? (session.engine as ProposalsEngine | undefined) ?? null;
		this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
		this.clock = () => globalThis.performance?.now?.() ?? Date.now();
		this.setTimer = opts.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
		this.clearTimer = opts.clearTimer ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
		this.store = createStore<ProposalsState>(() => ({
			status: this.engine ? 'idle' : 'offline',
			error: null,
			list: [],
			warnings: [],
			activeId: null,
			proposal: null,
			items: [],
			accepted: {},
			selection: [],
			hear: false,
			preview: null,
			stale: {},
			staleProblems: {},
			busy: false,
			previewing: false,
			lastError: null,
		}));
		this.offs.push(
			session.on('doc.changed', () => {
				this.followHistory();
				if (this.store.getState().activeId) this.schedule();
			}),
			session.on('closed', () => this.dispose()),
		);
	}

	getState(): ProposalsState {
		return this.store.getState();
	}

	/** The engine to talk to (the session's client by default). */
	setEngine(engine: ProposalsEngine | null): void {
		this.engine = engine;
		if (!engine) this.store.setState({ status: 'offline' });
	}

	/**
	 * Follows the engine's `proposal.changed` events of this project (the editor wires its event stream here): the list
	 * is re-read, and the proposal under review when it is the one that changed.
	 */
	connect(subscribe: (cb: (e: ProposalChangedEvent) => void) => Unsubscribe): Unsubscribe {
		const off = subscribe((e) => this.handleEvent(e));
		this.offs.push(off);
		return off;
	}

	handleEvent(e: ProposalChangedEvent): void {
		if (this.disposed || e.projectId !== this.session.projectId) return;
		this.scheduleList();
		if (e.change === 'accepted' && typeof e.revision === 'number')
			void this.learnAccept(e.proposalId, e.revision);
		const s = this.store.getState();
		// an agent started / stopped waiting for the review: only the list says so (the proposal did not change)
		if (e.change === 'waiting' || e.proposalId !== s.activeId) return;
		if (e.change === 'deleted' || e.change === 'expired' || e.change === 'evicted') {
			this.store.setState({
				lastError: { code: 'E_PROPOSAL_GONE', message: `The proposal under review was ${e.change}` },
			});
			this.exit();
			return;
		}
		void this.fetchActive();
	}

	// ---- list

	/** Reads the project's proposals. */
	async load(): Promise<ActionResult> {
		const engine = this.engine;
		if (!engine) return fail('E_NO_ENGINE', 'The engine is not connected');
		if (this.store.getState().status !== 'ready') this.store.setState({ status: 'loading' });
		try {
			const r = await engine.listProposals(this.session.projectId);
			if (this.disposed) return { ok: true, changed: [] };
			this.store.setState({ status: 'ready', error: null, list: r.proposals, warnings: r.warnings });
			const active = this.store.getState().activeId;
			if (active && !r.proposals.some((p) => p.id === active)) this.exit();
			return { ok: true, changed: [] };
		} catch (e) {
			const err = errorOf(e);
			this.store.setState({ status: 'error', error: err.message });
			return fail(err.code, err.message);
		}
	}

	/** Reads any proposal of the project as stored (e.g. for a card's counts); null when it cannot be read. */
	async read(proposalId: string): Promise<Proposal | null> {
		const engine = this.engine;
		if (!engine) return null;
		try {
			return (await engine.getProposal(this.session.projectId, proposalId)).proposal;
		} catch {
			return null;
		}
	}

	/** Re-reads the list and the proposal under review. */
	async refresh(): Promise<ActionResult> {
		const r = await this.load();
		if (this.store.getState().activeId) await this.fetchActive();
		return r;
	}

	private scheduleList(): void {
		if (this.listTimer !== null) return;
		this.listTimer = this.setTimer(() => {
			this.listTimer = null;
			void this.load();
		}, LIST_DEBOUNCE_MS);
	}

	// ---- review

	/** Starts reviewing a proposal (null: stop). The preview follows. */
	async setActive(proposalId: string | null): Promise<ActionResult> {
		if (proposalId === null) {
			this.exit();
			return { ok: true, changed: [] };
		}
		const engine = this.engine;
		if (!engine) return fail('E_NO_ENGINE', 'The engine is not connected');
		const prev = this.store.getState();
		if (prev.activeId !== proposalId) this.lastFailed = {};
		if (prev.activeId !== proposalId)
			this.store.setState({
				activeId: proposalId,
				proposal: null,
				items: [],
				selection: [],
				preview: null,
				stale: {},
				staleProblems: {},
			});
		const r = await this.fetchActive();
		if (!r.ok && this.store.getState().activeId === proposalId) this.exit();
		return r;
	}

	/** Leaves review: no proposal, no preview, "Hear proposal" off (local decisions are kept per proposal). */
	exit(): void {
		if (this.recomputeTimer !== null) this.clearTimer(this.recomputeTimer);
		this.recomputeTimer = null;
		this.cancelJob();
		this.optimistic.clear();
		this.lastFailed = {};
		this.store.setState({
			activeId: null,
			proposal: null,
			items: [],
			selection: [],
			hear: false,
			preview: null,
			stale: {},
			staleProblems: {},
			previewing: false,
		});
	}

	private async fetchActive(): Promise<ActionResult> {
		const engine = this.engine;
		const id = this.store.getState().activeId;
		if (!engine || !id) return fail('E_NO_ENGINE', 'The engine is not connected');
		const n = ++this.activeFetch;
		try {
			const r = await engine.getProposal(this.session.projectId, id);
			if (this.disposed || this.store.getState().activeId !== id || n !== this.activeFetch)
				return { ok: true, changed: [] };
			this.adopt(r.proposal);
			return { ok: true, changed: [] };
		} catch (e) {
			const err = errorOf(e);
			if (this.store.getState().activeId === id) this.store.setState({ lastError: err });
			return fail(err.code, err.message);
		}
	}

	/** Takes a proposal the engine returned (never an older copy than the one held). */
	private adopt(p: Proposal): void {
		const s = this.store.getState();
		if (s.activeId !== p.id) return;
		if (s.proposal && s.proposal.updatedAt > p.updatedAt) return;
		// Local accepts of items the engine has decided otherwise (applied, invalid, rejected meanwhile) are dropped.
		const local = (s.accepted[p.id] ?? []).filter((id) => {
			const it = p.items.find((x) => x.id === id);
			return !!it && (it.state === 'pending' || it.state === 'stale');
		});
		const known = new Set(p.items.map((it) => it.id));
		this.store.setState({
			proposal: p,
			accepted: { ...s.accepted, [p.id]: local },
			selection: s.selection.filter((id) => known.has(id)),
		});
		this.publishItems();
		this.schedule();
	}

	select(itemIds: readonly string[], mode: SelectMode = 'replace'): void {
		const s = this.store.getState();
		const known = new Set(s.items.map((it) => it.id));
		const ids = itemIds.filter((id) => known.has(id));
		this.store.setState({ selection: combine(s.selection, ids, mode) });
	}

	setHear(on: boolean): void {
		if (this.store.getState().hear !== on) this.store.setState({ hear: on });
		if (!on) return;
		// a small proposal's preview is made ready now; a large one's starts now and comes in slices
		const n = this.store.getState().proposal?.items.length ?? 0;
		if (n <= SYNC_ITEMS) this.flush();
		else if (this.recomputeTimer !== null) {
			this.clearTimer(this.recomputeTimer);
			this.recomputeTimer = null;
			this.recompute(false);
		}
	}
	toggleHear(): boolean {
		const on = !this.store.getState().hear;
		this.setHear(on);
		return on;
	}

	/** Items locally accepted and not applied yet (the proposal under review). */
	acceptedIds(): string[] {
		const s = this.store.getState();
		return s.activeId ? (s.accepted[s.activeId] ?? []) : [];
	}

	/**
	 * Accept (locally, until Apply; with what the items require), reject (engine) or clear (back to pending) items.
	 * Accepting a rejected item reopens it first; rejecting an applied one is refused (undo it in History).
	 */
	async setItemDecision(itemIds: readonly string[], decision: ItemDecision): Promise<ActionResult> {
		const s = this.store.getState();
		const p = s.proposal;
		if (!p || !s.activeId) return fail('E_NOT_FOUND', 'No proposal is under review');
		const byId = new Map(p.items.map((it) => [it.id, it]));
		const unknown = itemIds.find((id) => !byId.has(id));
		if (unknown) return fail('E_NOT_FOUND', `No item ${unknown} in the proposal`);
		const applied = itemIds.find((id) => byId.get(id)!.state === 'accepted');
		if (applied && decision !== 'accept')
			return fail('E_INVALID_PARAM', `Item ${applied} is already applied: undo it in History instead`);
		if (decision === 'accept') {
			const closure = dependencyClosure(
				p,
				itemIds,
				(it) => it.state === 'accepted' || it.state === 'invalid',
			);
			const invalid = itemIds.find((id) => byId.get(id)!.state === 'invalid');
			if (invalid)
				return fail('E_INVALID_PARAM', `Item ${invalid} is invalid: ${byId.get(invalid)!.reason ?? ''}`);
			const ids = closure.map((it) => it.id);
			const rejected = closure.filter((it) => it.state === 'rejected').map((it) => it.id);
			this.setLocal(p.id, ids, true);
			if (rejected.length) {
				const r = await this.decide('reopen', rejected, 'pending');
				if (!r.ok) return r;
				// the reopened items are accepted here (adopt dropped them while they were rejected)
				this.setLocal(p.id, ids, true);
			}
			return { ok: true, changed: ids };
		}
		this.setLocal(p.id, [...itemIds], false);
		if (decision === 'reject') {
			const ids = itemIds.filter((id) => {
				const st = byId.get(id)!.state;
				return st === 'pending' || st === 'stale';
			});
			if (!ids.length) return { ok: true, changed: [...itemIds] };
			return this.decide('reject', ids, 'rejected');
		}
		const ids = itemIds.filter((id) => byId.get(id)!.state === 'rejected');
		if (!ids.length) return { ok: true, changed: [...itemIds] };
		return this.decide('reopen', ids, 'pending');
	}

	private setLocal(proposalId: string, ids: readonly string[], on: boolean): void {
		const s = this.store.getState();
		const cur = new Set(s.accepted[proposalId] ?? []);
		for (const id of ids) {
			if (on) cur.add(id);
			else cur.delete(id);
		}
		const p = s.proposal;
		const order = p ? p.items.map((it) => it.id).filter((id) => cur.has(id)) : [...cur];
		this.store.setState({ accepted: { ...s.accepted, [proposalId]: order } });
		this.publishItems();
		this.schedule();
	}

	private async decide(
		kind: 'reject' | 'reopen',
		ids: string[],
		shown: 'rejected' | 'pending',
	): Promise<ActionResult> {
		const engine = this.engine;
		const id = this.store.getState().activeId;
		if (!engine || !id) return fail('E_NO_ENGINE', 'The engine is not connected');
		for (const x of ids) this.optimistic.set(x, shown);
		this.publishItems();
		this.schedule();
		return this.call(async () => {
			try {
				const r =
					kind === 'reject'
						? await engine.rejectProposal(this.session.projectId, id, { itemIds: ids })
						: await engine.reopenProposal(this.session.projectId, id, { itemIds: ids });
				return r;
			} finally {
				for (const x of ids) this.optimistic.delete(x);
			}
		});
	}

	/** Runs a decision route and adopts the proposal it returns. */
	private async call(fn: () => Promise<ProposalDecisionResponse>): Promise<ActionResult> {
		this.store.setState({ busy: true });
		try {
			const r = await fn();
			this.adopt(r.proposal);
			this.store.setState({ busy: false, lastError: null });
			return { ok: true, changed: r.changed };
		} catch (e) {
			const err = errorOf(e);
			this.store.setState({ busy: false, lastError: err });
			this.publishItems();
			this.schedule();
			return fail(err.code, err.message);
		}
	}

	/** Chooses an item's command set (0 = its own, k = alternative k), stored by the engine (agents read it). */
	async selectAlternative(itemId: string, alternative: number): Promise<ActionResult> {
		const engine = this.engine;
		const s = this.store.getState();
		if (!engine || !s.activeId) return fail('E_NO_ENGINE', 'No proposal is under review');
		const it = s.proposal?.items.find((x) => x.id === itemId);
		if (!it) return fail('E_NOT_FOUND', `No item ${itemId} in the proposal`);
		const n = (it.alternatives?.length ?? 0) + 1;
		if (!Number.isInteger(alternative) || alternative < 0 || alternative >= n)
			return fail('E_INVALID_PARAM', `Item ${itemId} has ${n} command sets (0–${n - 1})`);
		const id = s.activeId;
		return this.call(() =>
			engine.selectProposalAlternative(this.session.projectId, id, { itemId, alternative }),
		);
	}

	/** Next / previous alternative of an item (wraps). */
	cycleAlternative(itemId: string, dir: 1 | -1): Promise<ActionResult> {
		const it = this.store.getState().proposal?.items.find((x) => x.id === itemId);
		if (!it) return Promise.resolve(fail('E_NOT_FOUND', `No item ${itemId} in the proposal`));
		const n = (it.alternatives?.length ?? 0) + 1;
		return this.selectAlternative(itemId, ((((it.selectedAlternative ?? 0) + dir) % n) + n) % n);
	}

	/**
	 * "Refresh proposal" (spec 15 EA-003): the feature's producer re-plans the stale items (or `itemIds`) on the current
	 * document; they come back pending for review (nothing is applied). Refused with the engine's reason when the
	 * feature's producer does not refresh (E_NOT_REFRESHABLE). `reroll` (spec 15 EA-032 "Reroll"): re-plan the items with
	 * the next seed of each (another draw of the same pass).
	 */
	async refreshItems(
		itemIds: readonly string[] | 'stale' = 'stale',
		opts: { reroll?: boolean } = {},
	): Promise<ActionResult> {
		const engine = this.engine;
		const id = this.store.getState().activeId;
		if (!engine || !id) return fail('E_NO_ENGINE', 'No proposal is under review');
		if (!engine.refreshProposal) return fail('E_NOT_REFRESHABLE', 'This engine cannot refresh proposals');
		const refresh = engine.refreshProposal.bind(engine);
		return this.call(async () => {
			const r = await refresh(this.session.projectId, id, {
				itemIds: itemIds === 'stale' ? 'stale' : [...itemIds],
				...(opts.reroll ? { reroll: true } : {}),
			});
			return { proposal: r.proposal, changed: [...r.refreshed, ...r.dropped] };
		});
	}

	/** The reviewer's note on an item (null / "" clears it); returned to agents. */
	async note(itemId: string, note: string | null): Promise<ActionResult> {
		const engine = this.engine;
		const id = this.store.getState().activeId;
		if (!engine || !id) return fail('E_NO_ENGINE', 'No proposal is under review');
		return this.call(() => engine.noteProposalItem(this.session.projectId, id, { itemId, note }));
	}

	/**
	 * Applies the locally accepted items (or `itemIds`) as ONE undoable transaction, through the engine's accept route
	 * with the editor key (it relays the transaction into this session as the user's edit and records the decisions
	 * with it). Needs a trusted user gesture (`trusted`: the event's `isTrusted`): agents never apply through the
	 * editor. Stale items are left out and reported (`partial`).
	 */
	async apply(opts: { trusted: boolean; itemIds?: readonly string[] }): Promise<ApplyResult> {
		if (!opts.trusted) return fail('E_UNTRUSTED', 'Apply needs a click or key press by the user');
		const engine = this.engine;
		const s = this.store.getState();
		if (!engine) return fail('E_NO_ENGINE', 'The engine is not connected');
		if (!s.activeId || !s.proposal) return fail('E_NOT_FOUND', 'No proposal is under review');
		if (this.session.getState().readOnly) return fail('E_NOT_OWNER', 'The project is read-only');
		const ids = [...(opts.itemIds ?? s.accepted[s.activeId] ?? [])];
		if (ids.length === 0) return fail('E_NOTHING', 'No accepted items to apply');
		const proposalId = s.activeId;
		this.store.setState({ busy: true });
		let r: ProposalAcceptResponse;
		try {
			r = await engine.acceptProposal(this.session.projectId, proposalId, {
				itemIds: ids,
				partial: true,
				expectedRevision: this.session.revision,
			});
		} catch (e) {
			const err = errorOf(e);
			this.store.setState({ busy: false, lastError: err });
			const stale = (e as { detail?: { stale?: { itemId: string; reason: string }[] } })?.detail?.stale;
			void this.fetchActive();
			return { ...fail(err.code, err.message), ...(stale ? { stale } : {}) };
		}
		this.store.setState({ busy: false, lastError: null });
		const entry = r.result?.ok ? this.entryAt(r.revision) : undefined;
		const label = entry?.label ?? null;
		if (r.applied.length && r.result?.ok && entry) {
			this.track({
				proposalId,
				itemIds: [...r.applied],
				entryId: entry.id,
				refs: { ...r.result.refs },
				created: [...r.result.created],
				state: 'applied',
			});
		}
		const cur = this.store.getState();
		this.store.setState({
			accepted: {
				...cur.accepted,
				[proposalId]: (cur.accepted[proposalId] ?? []).filter((id) => !r.applied.includes(id)),
			},
		});
		this.adopt(r.proposal);
		this.followHistory();
		return {
			ok: true,
			applied: r.applied,
			stale: r.stale,
			label,
			revision: r.revision,
			results: r.result?.ok ? [...r.result.results] : [],
		};
	}

	/** Leaves the review rejecting every undecided item (the proposal stays, with its notes, for agents to read). */
	async discard(): Promise<ActionResult> {
		const engine = this.engine;
		const s = this.store.getState();
		if (!engine || !s.activeId || !s.proposal) return fail('E_NOT_FOUND', 'No proposal is under review');
		const id = s.activeId;
		const undecided = s.proposal.items.some((it) => it.state === 'pending' || it.state === 'stale');
		this.store.setState({ accepted: { ...s.accepted, [id]: [] } });
		const r = undecided
			? await this.call(() => engine.rejectProposal(this.session.projectId, id, { itemIds: 'all' }))
			: ({ ok: true, changed: [] } as ActionResult);
		if (r.ok) this.exit();
		return r;
	}

	/** Deletes a proposal from the engine store. */
	async remove(proposalId: string): Promise<ActionResult> {
		const engine = this.engine;
		if (!engine) return fail('E_NO_ENGINE', 'The engine is not connected');
		try {
			await engine.deleteProposal(this.session.projectId, proposalId);
			if (this.store.getState().activeId === proposalId) this.exit();
			this.scheduleList();
			return { ok: true, changed: [] };
		} catch (e) {
			const err = errorOf(e);
			this.store.setState({ lastError: err });
			return fail(err.code, err.message);
		}
	}

	// ---- History: Undo of an applied accept reopens it, Redo records it again

	/** The History entry a transaction made (by the revision after it), whoever's it was. */
	private entryAt(revisionAfter: number | null): HistoryEntryView | undefined {
		if (revisionAfter === null) return undefined;
		return this.session.getState().history.entries.find((e) => e.revisionAfter === revisionAfter);
	}

	private track(rec: AppliedRecord): void {
		if (this.records.some((r) => r.entryId === rec.entryId)) return;
		this.records.push(rec);
		this.followHistory();
	}

	/**
	 * An accept the engine applied into this session that this window did not make (an allowed agent's): follow its
	 * History entry too, so undoing it puts the items back into review and redoing it records them again.
	 */
	private async learnAccept(proposalId: string, revision: number): Promise<void> {
		const entryId = this.entryAt(revision)?.id;
		if (entryId === undefined || this.records.some((r) => r.entryId === entryId)) return;
		const p = await this.read(proposalId);
		if (!p || this.disposed || this.records.some((r) => r.entryId === entryId)) return;
		const items = p.items.filter((it) => it.state === 'accepted' && it.applied?.revision === revision);
		if (!items.length) return;
		this.track({
			proposalId,
			itemIds: items.map((it) => it.id),
			entryId,
			refs: { ...(items[0]!.applied?.refs ?? {}) },
			created: [...(items[0]!.applied?.created ?? [])],
			state: 'applied',
		});
	}

	private followHistory(): void {
		if (!this.records.length) return;
		const h = this.session.getState().history;
		const keep: AppliedRecord[] = [];
		for (const rec of this.records) {
			const pos = h.entries.findIndex((e) => e.id === rec.entryId);
			if (pos < 0) continue; // gone: trimmed (can no longer be undone) or a new edit dropped the redo
			const applied = pos < h.index;
			if (rec.state === 'applied' && !applied) {
				rec.state = 'undone';
				this.followUp(() => this.reopenUndone(rec));
			} else if (rec.state === 'undone' && applied) {
				rec.state = 'applied';
				this.followUp(() => this.recordRedone(rec));
			}
			keep.push(rec);
		}
		this.records = keep;
	}

	private followUp(fn: () => Promise<void>): void {
		this.followUps = this.followUps.then(fn, fn);
	}

	/** Resolves once every Undo / Redo follow-up sent so far has been answered (tests, Apply). */
	settled(): Promise<void> {
		return this.followUps;
	}

	private async reopenUndone(rec: AppliedRecord): Promise<void> {
		const engine = this.engine;
		if (!engine || this.disposed) return;
		try {
			const r = await engine.reopenProposal(this.session.projectId, rec.proposalId, { itemIds: rec.itemIds });
			// decisions intact: the items come back accepted here, ready to apply again
			const s = this.store.getState();
			const local = new Set([...(s.accepted[rec.proposalId] ?? []), ...rec.itemIds]);
			this.store.setState({ accepted: { ...s.accepted, [rec.proposalId]: [...local] } });
			if (s.activeId === rec.proposalId) this.adopt(r.proposal);
			this.scheduleList();
		} catch (e) {
			const err = errorOf(e);
			// redone meanwhile: the engine kept them accepted, which is what the document says
			if (!BENIGN_FOLLOW_UP.has(err.code)) this.store.setState({ lastError: err });
		}
	}

	private async recordRedone(rec: AppliedRecord): Promise<void> {
		const engine = this.engine;
		if (!engine || this.disposed) return;
		const s = this.store.getState();
		this.store.setState({
			accepted: {
				...s.accepted,
				[rec.proposalId]: (s.accepted[rec.proposalId] ?? []).filter((id) => !rec.itemIds.includes(id)),
			},
		});
		try {
			const r = await engine.markProposalApplied(this.session.projectId, rec.proposalId, {
				itemIds: rec.itemIds,
				revision: this.session.revision,
				refs: rec.refs,
				...(rec.created.length ? { created: rec.created } : {}),
			});
			if (this.store.getState().activeId === rec.proposalId) this.adopt(r.proposal);
			this.scheduleList();
		} catch (e) {
			const err = errorOf(e);
			// undone again meanwhile: nothing to record (the engine says pending, as the document does)
			if (!BENIGN_FOLLOW_UP.has(err.code)) this.store.setState({ lastError: err });
		}
	}

	// ---- preview

	/**
	 * A non-committed preview of some items of the proposal under review on the committed document (spec 12 §2.5
	 * `previewProposal(id, itemIds)`), with the same seeded ids as the slice's own preview: e.g. one item alone for
	 * "▶ in context". Null when `proposalId` is not under review. Never touches the session.
	 */
	previewProposal(proposalId: string, itemIds: readonly string[] | 'undecided'): ProposalPreview | null {
		const p = this.store.getState().proposal;
		if (!p || p.id !== proposalId) return null;
		const idsFor = (it: ProposalItem) =>
			createSeededIdSource(`${p.id}:${it.id}:${it.selectedAlternative ?? 0}`);
		return previewProposal(this.session.getCommitted(), p, itemIds, this.context(), { idsFor });
	}

	/** Recompute the preview and the local re-validation after the debounce. */
	schedule(): void {
		if (this.disposed) return;
		if (this.recomputeTimer !== null) this.clearTimer(this.recomputeTimer);
		this.recomputeTimer = this.setTimer(() => {
			this.recomputeTimer = null;
			this.recompute(false);
		}, this.debounceMs);
	}

	/** Recomputes now (to completion, synchronously) if a recompute is pending or being built in slices. */
	flush(): void {
		const pending = this.recomputeTimer !== null || this.job !== null;
		if (this.recomputeTimer !== null) this.clearTimer(this.recomputeTimer);
		this.recomputeTimer = null;
		if (pending) this.recompute(true);
	}

	private cancelJob(): void {
		if (!this.job) return;
		if (this.job.timer !== null) this.clearTimer(this.job.timer);
		this.job = null;
	}

	/** Runs the sliced preview job for at most `SLICE_MS`, then yields to the event loop (or to completion: `sync`). */
	private step(job: NonNullable<ProposalsController['job']>, sync: boolean): void {
		job.timer = null;
		const start = this.clock();
		for (;;) {
			if (this.job !== job || this.disposed) return;
			const r = job.run.next();
			if (r.done) {
				if (this.job === job) this.job = null;
				return;
			}
			if (!sync && this.clock() - start >= SLICE_MS) break;
		}
		job.timer = this.setTimer(() => this.step(job, false), 0);
	}
	private context(): ProposalContext {
		const ctx = this.session.ctx;
		return {
			registries: ctx.registries,
			revision: this.session.revision,
			now: ctx.now ?? (() => new Date().toISOString()),
			invariants: 'incremental',
		};
	}

	/** The local review state of every item (engine state + local re-validation + decisions). */
	private publishItems(
		stale = this.store.getState().stale,
		failed: Record<string, string> = this.lastFailed,
	): void {
		this.lastFailed = failed;
		const s = this.store.getState();
		const problems = s.staleProblems;
		const p = s.proposal;
		if (!p) {
			if (s.items.length) this.store.setState({ items: [] });
			return;
		}
		const local = new Set(s.accepted[p.id] ?? []);
		const items = p.items.map((it): ReviewItem => {
			// a decision in flight counts as made (rejected, or reopened = pending)
			const stored = this.optimistic.get(it.id) ?? it.state;
			let state: ReviewItemState;
			let reason = it.reason;
			let problem: StaleProblem | undefined;
			if (it.state === 'accepted') state = 'applied';
			else if (it.state === 'invalid') state = 'invalid';
			else if (stored === 'rejected') state = 'rejected';
			else if (stale[it.id] !== undefined || failed[it.id] !== undefined) {
				state = 'stale';
				reason = stale[it.id] ?? failed[it.id];
				problem =
					stale[it.id] !== undefined ? problems[it.id] : { type: 'conflict', issue: failed[it.id] ?? '' };
			} else if (local.has(it.id)) state = 'accepted';
			else state = 'pending';
			if (state === 'pending' || state === 'accepted' || state === 'rejected') {
				reason = undefined;
				problem = undefined;
			}
			return {
				id: it.id,
				label: it.label,
				group: it.group,
				requires: it.requires,
				setup: isSetupItem(it),
				state,
				engineState: it.state,
				...(reason ? { reason } : {}),
				...(problem ? { problem } : {}),
				...(it.note ? { note: it.note } : {}),
				alternatives: (it.alternatives?.length ?? 0) + 1,
				selectedAlternative: it.selectedAlternative ?? 0,
				alternativeLabels: [it.label, ...(it.alternatives ?? []).map((a) => a.label)],
				selectedMeta:
					(it.selectedAlternative ?? 0) > 0
						? (it.alternatives?.[(it.selectedAlternative ?? 0) - 1]?.meta ?? it.meta)
						: it.meta,
				meta: it.meta,
				selected: it.selected !== false,
			};
		});
		this.store.setState({ items });
	}

	/**
	 * Rebuilds the preview and the local re-validation on the committed document: anchors (cheap) at once, then the
	 * previews — every reviewable item (the ghosts) and, when something is rejected, what Hear plays — reusing the last
	 * ones while what they depend on did not change (a local accept or clear rebuilds nothing; what Hear plays after a
	 * reject starts from the ghosts' preview where the two go the same way). Items are applied in batches (one
	 * transaction for several items, ghosts attributed per item) and the result is checked once as Apply checks it;
	 * when it breaks an invariant, the first item after which it does is found (bisection over the batches) and shown
	 * stale with the issue, whatever the proposal's size. A large proposal is built in slices (`SLICE_MS`, each batch
	 * kept near one slice) unless `sync`.
	 */
	private recompute(sync: boolean): void {
		if (this.disposed) return;
		this.cancelJob();
		const s = this.store.getState();
		const p = s.proposal;
		if (!p) {
			if (s.preview || s.previewing) this.store.setState({ preview: null, previewing: false });
			return;
		}
		const doc = this.session.getCommitted();
		const ctx = this.context();
		// the anchors' re-validation depends on the document and the stored proposal only (not on local decisions)
		const rvMemo = this.revalidated;
		const rv =
			rvMemo && rvMemo.doc === doc && rvMemo.proposal === p
				? rvMemo.result
				: revalidate(doc, p, ctx, { dryRuns: false });
		this.revalidated = { doc, proposal: p, result: rv };
		const stale: Record<string, string> = {};
		const staleProblems: Record<string, StaleProblem> = {};
		for (const x of rv.stale) {
			stale[x.itemId] = x.reason;
			if (x.problem) staleProblems[x.itemId] = x.problem;
		}
		// the decisions in flight count as made
		const viewed: Proposal = {
			...rv.proposal,
			items: rv.proposal.items.map((it) => {
				const opt = this.optimistic.get(it.id);
				return opt === 'rejected' && it.state !== 'accepted'
					? { ...it, state: 'rejected' as const }
					: opt === 'pending' && it.state === 'rejected'
						? { ...it, state: 'pending' as const }
						: it;
			}),
		};
		const all = viewed.items.filter((it) => reviewable(it.state)).map((it) => it.id);
		const rejected = new Set(viewed.items.filter((it) => it.state === 'rejected').map((it) => it.id));
		const heardIds = all.filter((id) => !rejected.has(id));
		const key = previewKey(viewed, all);
		const heardKey = previewKey(viewed, heardIds);
		const revision = this.session.revision;
		const finish = (result: ProposalPreview, heard: ProposalPreview) => {
			const owner: Record<string, string> = {};
			for (const [itemId, g] of Object.entries(result.items))
				for (const id of [...g.created, ...g.changed, ...g.deleted]) owner[id] ??= itemId;
			const failed: Record<string, string> = {};
			for (const [itemId, errors] of Object.entries(result.failed))
				if (!rejected.has(itemId)) failed[itemId] = issueReason(errors);
			this.store.setState({
				stale,
				staleProblems,
				previewing: false,
				preview: {
					proposalId: p.id,
					revision,
					base: doc,
					document: heard.document,
					result,
					ghost: result.ghost,
					heard: heard.applied,
					owner,
				},
			});
			this.publishItems(stale, failed);
		};
		const memo = this.memo;
		const heardMemo = this.heardMemo;
		const resultHit = memo && memo.doc === doc && memo.key === key ? memo.preview : null;
		const heardHit =
			rejected.size === 0
				? resultHit
				: heardMemo && heardMemo.doc === doc && heardMemo.key === heardKey
					? heardMemo.preview
					: null;
		if (resultHit && heardHit) {
			finish(resultHit, heardHit);
			return;
		}
		// stale anchors show at once; the previews follow
		this.store.setState({ stale, staleProblems, previewing: true });
		this.publishItems(stale);
		const idsFor = (it: ProposalItem) =>
			createSeededIdSource(`${p.id}:${it.id}:${it.selectedAlternative ?? 0}`);
		const self = this;
		const sliced = !sync && all.length > SYNC_ITEMS;
		// Every item applied in batches, and the result checked as Apply checks it (an item that breaks an invariant
		// together with the ones before it fails with the issue; the rest is applied again without it), whatever the
		// size of the proposal. What Hear plays starts from the ghosts' preview where the two go the same way.
		function* build(
			ids: readonly string[],
			reuse: ProposalPreview | null,
		): Generator<unknown, ProposalPreview, void> {
			return yield* previewProposalSteps(doc, viewed, ids, ctx, {
				idsFor,
				reuse,
				// a large proposal is built in slices: each batch of items stays near one slice of work
				...(sliced ? { batchMs: SLICE_MS, clock: self.clock } : {}),
			});
		}
		function* work(): Generator<unknown, void, void> {
			const result = resultHit ?? (yield* build(all, null));
			self.memo = { doc, key, preview: result };
			const heard = rejected.size === 0 ? result : (heardHit ?? (yield* build(heardIds, result)));
			if (rejected.size) self.heardMemo = { doc, key: heardKey, preview: heard };
			yield; // publishing (the store's listeners redraw) starts a slice of its own
			finish(result, heard);
		}
		const job = { run: work(), timer: null as unknown };
		this.job = job;
		this.step(job, sync || all.length <= SYNC_ITEMS);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.recomputeTimer !== null) this.clearTimer(this.recomputeTimer);
		this.cancelJob();
		if (this.listTimer !== null) this.clearTimer(this.listTimer);
		for (const off of this.offs.splice(0)) off();
		controllers.delete(this.session);
	}
}

const controllers = new WeakMap<EditorSession, ProposalsController>();

/** The proposals slice of a session (created on first use, disposed with the session). */
export function proposalsFor(session: EditorSession, opts?: ProposalsOptions): ProposalsController {
	let c = controllers.get(session);
	if (!c) {
		c = new ProposalsController(session, opts);
		controllers.set(session, c);
	}
	return c;
}

/**
 * The document the Program monitor plays: the proposal preview while "Hear proposal" is on and no gesture draws
 * (a drag or an In Context audition shows its own transient), else null (the session's drawn document).
 */
export function heardDocument(
	proposals: Pick<ProposalsState, 'hear' | 'preview' | 'activeId'>,
	session: Pick<EditorSession, 'gestureActive'>,
): ProjectDocument | null {
	if (!proposals.hear || !proposals.preview || proposals.preview.proposalId !== proposals.activeId)
		return null;
	if (session.gestureActive) return null;
	return proposals.preview.document;
}
