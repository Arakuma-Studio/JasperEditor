// The in-page agent bridge (ARCHITECTURE §11 Stage 1, S01 §21): one per open EditorSession. It answers
// queries, applies agent transactions through the session (one `Agent: <label>` undo entry each), asks
// the user for approval of destructive transactions, keeps an activity feed (the shell toasts it), and relays
// requests/events over WS /agent so external agents reach the open editor.
import type { Approval } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	AgentQueryError,
	type AgentTxInput,
	applyTransaction,
	approvalReasons,
	checkAgentTxLimits,
	exportAgentQuerySchemas,
	exportAgentSchema,
	historyPseudoCommand,
	makeEnvelope,
	normalizeAgentTransaction,
	resolveAgentAddresses,
	resolveCaptureArgs,
	runAgentQuery,
	summarizeTransaction,
	type TransactionResult,
	type TxInput,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { transitionPreferences } from '../panels/effects/transition-prefs.ts';
import { AgentRelayClient, type RelayState } from './relay-client.ts';

const APPROVAL_TIMEOUT_MS = 60_000;
const PLAYHEAD_EVENT_INTERVAL_MS = 100; // ≤ 10 Hz (S01:AGT-004)
const MAX_ACTIVITY = 200;

export type ActivityEntry = {
	id: number;
	time: number;
	label: string;
	agent: string;
	via: 'in-page' | 'relay' | 'console';
	ok: boolean;
	dryRun: boolean;
	revision: number;
	summary: string;
	commandCount: number;
	created: string[];
	changed: string[];
	deleted: string[];
	errors: { code: string; message: string; commandIndex: number }[];
	warnings: { code: string; message: string }[];
};

export type PendingApproval = Approval & {
	source: 'local' | 'engine';
};

export type AgentBridgeState = {
	activity: ActivityEntry[];
	approvals: PendingApproval[];
	relay: RelayState;
};

export type AgentBridgeEvent =
	| 'doc.changed'
	| 'selection.changed'
	| 'playhead.changed'
	| 'approval.requested'
	| 'approval.resolved'
	| 'activity';

export type TransactOptions = {
	/** Already approved (by the engine's gate or the user in the console). */
	approved?: boolean;
	via?: ActivityEntry['via'];
	/** Agent name when the transaction's origin is not an agent. */
	fallbackAgent?: string;
};

/** window.jasper (ARCHITECTURE §11): the in-page agent API. */
export interface JasperAgentApi {
	readonly version: 1;
	readonly projectId: string;
	schema(): Record<string, unknown>;
	query(name: string, args?: Record<string, unknown>): Promise<unknown>;
	transact(tx: AgentTxInput): Promise<TransactionResult>;
	on(event: AgentBridgeEvent, cb: (payload: unknown) => void): () => void;
}

export type AgentBridgeOptions = {
	/** Connect WS /agent (off for in-memory demo sessions and tests). */
	relay?: boolean;
};

let activitySeq = 0;

function fail(revision: number, code: string, message: string): TransactionResult {
	return { ok: false, revision, errors: [{ commandIndex: -1, code, message }] };
}

export class AgentBridge {
	readonly store: StoreApi<AgentBridgeState>;
	readonly relay: AgentRelayClient | null;
	private readonly listeners = new Map<AgentBridgeEvent, Set<(p: unknown) => void>>();
	private readonly localApprovals = new Map<
		string,
		{ resolve(d: 'approved' | 'denied' | 'timeout'): void; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly disposers: (() => void)[] = [];
	private schemaCache: Record<string, unknown> | null = null;
	private disposed = false;

	constructor(
		readonly session: EditorSession,
		readonly engine: EngineClient | null,
		opts: AgentBridgeOptions = {},
	) {
		this.store = createStore<AgentBridgeState>(() => ({ activity: [], approvals: [], relay: 'off' }));
		this.relay =
			opts.relay && engine
				? new AgentRelayClient({
						url: engine.agentWsUrl(),
						hello: () => ({
							projectId: session.projectId,
							sessionId: session.sessionId,
							leaseId: session.getState().lease.leaseId ?? null,
						}),
						onRequest: (kind, payload) => this.onRelayRequest(kind, payload),
						onEvent: (event, payload) => this.onEngineEvent(event, payload),
						onState: (relay) => this.store.setState({ relay }),
					})
				: null;
		this.wireSessionEvents();
	}

	// ------------------------------------------------------------ lifecycle

	start(): this {
		this.relay?.start();
		return this;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.relay?.stop();
		for (const d of this.disposers.splice(0)) d();
		for (const [id, a] of this.localApprovals) {
			clearTimeout(a.timer);
			a.resolve('denied');
			this.localApprovals.delete(id);
		}
		this.listeners.clear();
	}

	on(event: AgentBridgeEvent, cb: (payload: unknown) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(cb);
		return () => set.delete(cb);
	}

	private emit(event: AgentBridgeEvent, payload: unknown): void {
		for (const cb of [...(this.listeners.get(event) ?? [])]) {
			try {
				cb(payload);
			} catch (e) {
				console.error('[agent-bridge] listener failed', e);
			}
		}
	}

	private wireSessionEvents(): void {
		const s = this.session;
		this.disposers.push(
			s.on('doc.changed', (e) => {
				const payload = { projectId: s.projectId, ...e };
				this.emit('doc.changed', payload);
				this.relay?.sendEvent('doc.changed', payload);
			}),
			s.on('selection.changed', (e) => {
				const payload = { projectId: s.projectId, selection: e.selection };
				this.emit('selection.changed', payload);
				this.relay?.sendEvent('selection.changed', payload);
			}),
		);
		// playhead.changed throttled to ≤ 10 Hz with a trailing update (S01:AGT-004).
		let last = 0;
		let trailing: ReturnType<typeof setTimeout> | null = null;
		const fire = () => {
			last = Date.now();
			const t = s.transport.getState();
			const payload = {
				projectId: s.projectId,
				sequenceId: s.getState().activeSequenceId,
				frame: t.frame,
				playing: t.playing,
			};
			this.emit('playhead.changed', payload);
			this.relay?.sendEvent('playhead.changed', payload);
		};
		const offTransport = s.transport.subscribe((next, prev) => {
			if (next.frame === prev.frame && next.playing === prev.playing) return;
			const wait = PLAYHEAD_EVENT_INTERVAL_MS - (Date.now() - last);
			if (wait <= 0) fire();
			else if (!trailing)
				trailing = setTimeout(() => {
					trailing = null;
					fire();
				}, wait);
		});
		this.disposers.push(offTransport, () => {
			if (trailing) clearTimeout(trailing);
		});
		// Re-announce when the lease changes (e.g. taken over), so the engine routes to the holder.
		let leaseId = s.getState().lease.leaseId;
		this.disposers.push(
			s.store.subscribe((st) => {
				if (st.lease.leaseId !== leaseId) {
					leaseId = st.lease.leaseId;
					this.relay?.sendHello();
				}
			}),
		);
	}

	// ------------------------------------------------------------ schema and queries

	schema(): Record<string, unknown> {
		if (!this.schemaCache)
			this.schemaCache = {
				...exportAgentSchema(this.session.ctx.registries),
				queries: exportAgentQuerySchemas(),
				pseudoCommands: ['history.undo', 'history.redo'],
			};
		return this.schemaCache;
	}

	private queryEnv() {
		const s = this.session;
		const st = s.getState();
		return {
			doc: s.getCommitted(),
			revision: st.revision,
			effects: s.ctx.registries.effects,
			dryRun: (tx: Record<string, unknown>) => this.dryRun(tx),
			session: {
				activeSequenceId: st.activeSequenceId,
				selection: () => s.getState().selection,
				playhead: () => {
					const t = s.transport.getState();
					return { frame: t.frame, playing: t.playing };
				},
				seek: (frame: number) => {
					if (s.transport.getState().playing) s.transport.pause();
					s.transport.seek(frame);
					return s.transport.getState().frame;
				},
				history: () => ({ entries: s.getState().history.entries, position: s.getState().history.index }),
				mediaRuntime: (id: string) => s.getState().media[id] ?? null,
				// M3 (S10:TUI-034): the user's default transitions, so agents apply the same ones as Ctrl+D.
				preferences: () => ({ transitions: transitionPreferences() }),
			},
		};
	}

	/** Runs a query (S01 §21.2). `frame.capture` renders a still through the engine. */
	async query(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
		if (name === 'frame.capture') return this.captureFrame(args);
		return runAgentQuery(this.queryEnv(), name, args);
	}

	private async captureFrame(args: Record<string, unknown>): Promise<unknown> {
		if (!this.engine) throw new AgentQueryError('E_NOT_IMPLEMENTED', 'frame.capture needs the engine');
		const env = this.queryEnv();
		const cap = resolveCaptureArgs(env, args);
		const envelope = makeEnvelope(env.doc, {
			revision: env.revision,
			savedAt: new Date(Date.now()).toISOString(),
			platform: 'web',
		});
		let job = await this.engine.requestStill({
			envelope: envelope as never,
			sequenceId: cap.sequenceId,
			frame: cap.frame,
			width: cap.width,
		});
		const until = Date.now() + 60_000;
		while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state)) {
			if (Date.now() > until)
				throw new AgentQueryError('E_NOT_IMPLEMENTED', 'Timed out waiting for the still');
			await new Promise((r) => setTimeout(r, 250));
			job = await this.engine.getJob(job.id);
		}
		if (job.state !== 'succeeded')
			throw new AgentQueryError('E_NOT_IMPLEMENTED', job.error?.message ?? `Still job ${job.state}`);
		return { jobId: job.id, sequenceId: cap.sequenceId, frame: cap.frame, ...(job.result as object) };
	}

	private dryRun(raw: Record<string, unknown>): TransactionResult {
		const s = this.session;
		const st = s.getState();
		const tx = normalizeAgentTransaction(raw as AgentTxInput, 'validate');
		const doc = s.getCommitted();
		const addr = resolveAgentAddresses(doc, tx.commands, { sequenceId: tx.sequenceId });
		if (!addr.ok) return { ok: false, revision: st.revision, errors: addr.errors };
		return applyTransaction(
			doc,
			{ ...tx, commands: addr.commands, dryRun: true },
			{
				...s.ctx,
				revision: st.revision,
				selection: { clips: st.selection.timeline.clips, primaryClip: st.selection.timeline.primaryClip },
				entityRevisions: s.getEntityRevisions(),
			},
		).result;
	}

	// ------------------------------------------------------------ transactions

	/**
	 * Applies an agent transaction through the session (queued during a gesture, S01:SES-006). Destructive
	 * transactions wait for the user's approval unless `approved` (S01:AGT-011).
	 */
	async transact(raw: AgentTxInput, opts: TransactOptions = {}): Promise<TransactionResult> {
		const via = opts.via ?? 'in-page';
		const tx = normalizeAgentTransaction(raw, opts.fallbackAgent ?? (via === 'relay' ? 'external' : via));
		const revision = this.session.revision;
		const limit = checkAgentTxLimits(tx);
		if (limit) return this.record(tx, via, { ok: false, revision, errors: [limit] });

		const pseudo = historyPseudoCommand(tx);
		if (pseudo) return this.record(tx, via, this.historyStep(pseudo, tx.origin.agent));

		const addr = resolveAgentAddresses(this.session.getCommitted(), tx.commands, {
			sequenceId: tx.sequenceId,
		});
		if (!addr.ok) return this.record(tx, via, { ok: false, revision, errors: addr.errors });

		const reasons = approvalReasons(tx);
		if (reasons.length > 0 && !opts.approved) {
			const decision = await this.requestLocalApproval(tx, reasons);
			if (decision !== 'approved')
				return this.record(
					tx,
					via,
					fail(
						this.session.revision,
						decision === 'timeout' ? 'E_APPROVAL_TIMEOUT' : 'E_APPROVAL_DENIED',
						decision === 'timeout' ? 'The approval request timed out' : 'The user denied the transaction',
					),
				);
		}
		const input: TxInput = {
			label: tx.label,
			origin: tx.origin,
			commands: addr.commands as TxInput['commands'],
			...(tx.expectedRevision !== undefined ? { expectedRevision: tx.expectedRevision } : {}),
			...(tx.dryRun ? { dryRun: true } : {}),
			...(tx.sequenceId ? { sequenceId: tx.sequenceId } : {}),
		};
		const result = await this.session.submit(input);
		return this.record(tx, via, result);
	}

	/** history.undo / history.redo for agents: only their own entry (S01:UND-008). */
	private historyStep(kind: 'history.undo' | 'history.redo', agent: string): TransactionResult {
		const s = this.session;
		let change: { created: string[]; changed: string[]; deleted: string[] } | null = null;
		const off = s.on('doc.changed', (e) => {
			change = { created: e.created, changed: e.changed, deleted: e.deleted };
		});
		const r = kind === 'history.undo' ? s.undo({ agent }) : s.redo({ agent });
		off();
		if (!r.ok)
			return fail(
				s.revision,
				r.code ?? 'E_NOT_FOUND',
				r.code === 'E_NOT_OWNER'
					? `The ${kind === 'history.undo' ? 'top' : 'next'} history entry was not made by ${agent}`
					: `Nothing to ${kind === 'history.undo' ? 'undo' : 'redo'}`,
			);
		const c = change ?? { created: [], changed: [], deleted: [] };
		return { ok: true, revision: s.revision, refs: {}, ...c, warnings: [], results: [{ [kind]: r.label }] };
	}

	private record(
		tx: ReturnType<typeof normalizeAgentTransaction>,
		via: ActivityEntry['via'],
		result: TransactionResult,
	) {
		const entry: ActivityEntry = {
			id: ++activitySeq,
			time: Date.now(),
			label: tx.label,
			agent: tx.origin.agent,
			via,
			ok: result.ok,
			dryRun: !!tx.dryRun,
			revision: result.revision,
			summary: summarizeTransaction(tx),
			commandCount: tx.commands.length,
			created: result.ok ? result.created : [],
			changed: result.ok ? result.changed : [],
			deleted: result.ok ? result.deleted : [],
			errors: result.ok
				? []
				: result.errors.map((e) => ({ code: e.code, message: e.message, commandIndex: e.commandIndex })),
			warnings: result.ok ? result.warnings.map((w) => ({ code: w.code, message: w.message })) : [],
		};
		const activity = [entry, ...this.store.getState().activity].slice(0, MAX_ACTIVITY);
		this.store.setState({ activity });
		this.emit('activity', entry);
		return result;
	}

	/** True when the entry's commit is the top of the undo stack (Undo link in the feed). */
	isTopOfHistory(entry: ActivityEntry): boolean {
		if (!entry.ok || entry.dryRun) return false;
		const h = this.session.getState().history;
		const top = h.entries[h.index - 1];
		return (
			!!top &&
			top.revisionAfter === entry.revision &&
			typeof top.origin === 'object' &&
			top.origin.agent === entry.agent
		);
	}

	clearActivity(): void {
		this.store.setState({ activity: [] });
	}

	// ------------------------------------------------------------ approvals (S01:AGT-011)

	private requestLocalApproval(
		tx: ReturnType<typeof normalizeAgentTransaction>,
		reasons: string[],
	): Promise<'approved' | 'denied' | 'timeout'> {
		const timeoutMs = APPROVAL_TIMEOUT_MS;
		const approvalId = `apr_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const approval: PendingApproval = {
			approvalId,
			projectId: this.session.projectId,
			label: tx.label,
			agent: tx.origin.agent,
			reasons,
			commandCount: tx.commands.length,
			expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
			summary: summarizeTransaction(tx),
			commands: tx.commands.slice(0, 50),
			source: 'local',
		};
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settleLocal(approvalId, 'timeout'), timeoutMs);
			this.localApprovals.set(approvalId, { resolve, timer });
			this.addApproval(approval);
		});
	}

	private settleLocal(approvalId: string, decision: 'approved' | 'denied' | 'timeout'): boolean {
		const a = this.localApprovals.get(approvalId);
		if (!a) return false;
		this.localApprovals.delete(approvalId);
		clearTimeout(a.timer);
		this.removeApproval(approvalId, decision);
		a.resolve(decision);
		return true;
	}

	private addApproval(a: PendingApproval): void {
		const approvals = [...this.store.getState().approvals.filter((x) => x.approvalId !== a.approvalId), a];
		this.store.setState({ approvals });
		this.emit('approval.requested', a);
	}

	private removeApproval(approvalId: string, decision: string): void {
		const approvals = this.store.getState().approvals.filter((x) => x.approvalId !== approvalId);
		if (approvals.length === this.store.getState().approvals.length) return;
		this.store.setState({ approvals });
		this.emit('approval.resolved', { approvalId, decision });
	}

	/** Approve / deny a pending card (shell/AgentApprovals.tsx). Engine approvals are answered over WS /agent. */
	resolveApproval(approvalId: string, decision: 'approved' | 'denied'): boolean {
		if (this.settleLocal(approvalId, decision)) return true;
		const a = this.store.getState().approvals.find((x) => x.approvalId === approvalId);
		if (a?.source !== 'engine') return false;
		const sent = this.relay?.sendEvent('agent.approval.resolve', { approvalId, decision }) ?? false;
		if (sent) this.removeApproval(approvalId, decision);
		return sent;
	}

	// ------------------------------------------------------------ relay

	private onEngineEvent(event: string, payload: unknown): void {
		if (event === 'agent.approval.requested') {
			const a = payload as Approval;
			if (a?.approvalId && a.projectId === this.session.projectId)
				this.addApproval({ ...a, source: 'engine' });
		} else if (event === 'agent.approval.resolved') {
			const p = payload as { approvalId?: string; decision?: string };
			if (p?.approvalId) this.removeApproval(p.approvalId, p.decision ?? 'resolved');
		}
	}

	private async onRelayRequest(
		kind: 'tx' | 'query' | 'schema',
		payload: unknown,
	): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
		try {
			if (kind === 'schema') return { result: this.schema() };
			if (kind === 'query') {
				const p = (payload ?? {}) as { query?: string; args?: Record<string, unknown> };
				const result = await this.query(String(p.query), p.args ?? {});
				return { result: { result, revision: this.session.revision } };
			}
			const p = (payload ?? {}) as { transaction?: AgentTxInput; approved?: boolean };
			const result = await this.transact(p.transaction ?? {}, { via: 'relay', approved: !!p.approved });
			return { result };
		} catch (e) {
			if (e instanceof AgentQueryError) return { error: { code: e.code, message: e.message } };
			return { error: { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) } };
		}
	}

	// ------------------------------------------------------------ window.jasper

	/** The object installed as `window.jasper`. */
	api(): JasperAgentApi {
		return {
			version: 1,
			projectId: this.session.projectId,
			schema: () => this.schema(),
			query: (name, args) => this.query(name, args ?? {}),
			transact: (tx) => this.transact(tx, { via: 'in-page' }),
			on: (event, cb) => this.on(event, cb),
		};
	}
}
