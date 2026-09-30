// Agent API service (ARCHITECTURE §11 Stage 1, S01 §21): schema, queries and transactions for external
// agents. Requests for a project whose editor session is connected to WS /agent are relayed to it
// (30 s timeout); otherwise the engine answers headlessly with @jasper/project (S01:AGT-020).
// Destructive transactions go through the approval gate (S01:AGT-011).
import {
	type AgentQueryRequest,
	type AgentTxResponse,
	type Approval,
	ENGINE_ERROR_CODES,
	TransactionResultSchema,
} from '@jasper/api';
import {
	AGENT_TX_LIMITS,
	AgentQueryError,
	type AgentTxInput,
	APPROVAL_COMMANDS,
	applyTransaction,
	approvalReasons,
	checkAgentTxLimits,
	createRandomIdSource,
	exportAgentQuerySchemas,
	exportAgentSchema,
	HISTORY_PSEUDO_COMMANDS,
	historyPseudoCommand,
	type IdSource,
	loadProject,
	makeEnvelope,
	normalizeAgentTransaction,
	type ProjectDocument,
	type Registries,
	resolveAgentAddresses,
	resolveCaptureArgs,
	runAgentQuery,
	SESSION_ONLY_QUERIES,
	summarizeTransaction,
	type TransactionResult,
} from '@jasper/project';
import { type ApprovalDecision, ApprovalGate } from './approvals.ts';
import { RevisionTracker } from './revisions.ts';
import { type AgentConnection, type AgentSocket, RelayError, SessionRegistry } from './sessions.ts';
import type { AgentProjectStore } from './store.ts';

export const RELAY_TIMEOUT_MS = 30_000;

/** An HTTP-level failure (S04:ENG-022 body `{code, message, detail?, retryable}`). */
export class AgentApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'AgentApiError';
	}
}

export type StillCaptureRequest = {
	projectId: string;
	envelope: Record<string, unknown>;
	sequenceId: string;
	frame: number;
	width: number;
};

export type AgentServiceOptions = {
	engineVersion: string;
	/** Resolved on every use so WP-2F's store can be registered after the agent routes. */
	store: () => AgentProjectStore;
	registries: Registries;
	/** Publishes an engine event (`/events`); `projectId` scopes it. */
	publish?(type: string, payload: unknown, projectId?: string): void;
	/** Renders a Program still (engine `/api/stills`) for `frame.capture`. */
	captureStill?(req: StillCaptureRequest): Promise<unknown>;
	relayTimeoutMs?: number;
	approvalTimeoutMs?: number;
	heartbeatMs?: number;
	ids?: IdSource;
	now?(): Date;
};

const fail = (revision: number, code: string, message: string, extra: object = {}): TransactionResult => ({
	ok: false,
	revision,
	errors: [{ commandIndex: -1, code, message, ...extra }],
});

const QUERY_ERROR_STATUS: Record<string, [number, string]> = {
	E_NOT_FOUND: [404, 'NOT_FOUND'],
	E_INVALID_PARAM: [400, 'VALIDATION_FAILED'],
	E_AMBIGUOUS: [400, 'VALIDATION_FAILED'],
	E_SCHEMA: [400, 'VALIDATION_FAILED'],
	E_NO_SESSION: [409, 'NO_SESSION'],
	E_NOT_IMPLEMENTED: [501, 'NOT_IMPLEMENTED'],
};

/** Maps a query failure code (E_* from a session or @jasper/project) to an HTTP error. */
export function queryError(code: string, message: string): AgentApiError {
	const [status, httpCode] = QUERY_ERROR_STATUS[code] ?? [502, 'INTERNAL'];
	return new AgentApiError(status, httpCode, message, { code });
}

const RELAYED_SESSION_EVENTS = new Set(['doc.changed', 'selection.changed', 'playhead.changed']);

export class AgentService {
	readonly sessions: SessionRegistry;
	readonly approvals: ApprovalGate;
	readonly revisions = new RevisionTracker();
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly ids: IdSource;
	private readonly now: () => Date;
	private readonly relayTimeoutMs: number;
	private schemaCache: Record<string, unknown> | null = null;

	constructor(private readonly opts: AgentServiceOptions) {
		this.ids = opts.ids ?? createRandomIdSource();
		this.now = opts.now ?? (() => new Date());
		this.relayTimeoutMs = opts.relayTimeoutMs ?? RELAY_TIMEOUT_MS;
		this.sessions = new SessionRegistry({
			engineVersion: opts.engineVersion,
			heartbeatMs: opts.heartbeatMs,
			onEvent: (conn, event, payload) => this.onSessionEvent(conn, event, payload),
		});
		this.approvals = new ApprovalGate({
			timeoutMs: opts.approvalTimeoutMs,
			onRequested: (a) => {
				this.publish('agent.approval.requested', a, a.projectId);
				this.sessions.sendEvent(a.projectId, 'agent.approval.requested', a);
			},
			onResolved: (a, decision) => {
				const payload = { approvalId: a.approvalId, decision };
				this.publish('agent.approval.resolved', payload, a.projectId);
				this.sessions.sendEvent(a.projectId, 'agent.approval.resolved', payload);
			},
		});
	}

	private publish(type: string, payload: unknown, projectId?: string): void {
		try {
			this.opts.publish?.(type, payload, projectId);
		} catch {
			// event fan-out must never break the agent API
		}
	}

	/** WS /agent entry point. */
	handleSocket(socket: AgentSocket): AgentConnection {
		return this.sessions.attach(socket);
	}

	close(): void {
		this.approvals.close();
		this.sessions.close();
	}

	// ------------------------------------------------------------ schema (S01:AGT-002)

	schema(): Record<string, unknown> {
		if (this.schemaCache) return this.schemaCache;
		this.schemaCache = {
			...exportAgentSchema(this.opts.registries),
			queries: exportAgentQuerySchemas(),
			pseudoCommands: {
				'history.undo': 'Undo the top history entry if this agent made it (S01:UND-008); needs a session.',
				'history.redo': 'Redo the next entry if this agent made it; needs a session.',
				list: HISTORY_PSEUDO_COMMANDS,
			},
			addressing: {
				trackLabels: 'Tracks accept ids or labels "V1", "A2", "C1".',
				tempRefs: 'Creating commands may declare "ref": "$name"; later commands use "$name".',
				selection: '"$selection" / "$selection.primary" resolve from the open session.',
				mediaByName: '{"mediaByName": "file.mov"} → media id (E_AMBIGUOUS if not unique).',
				clipAt: '{"clipAt": {"track": "V1", "at": "00:00:01:00"}} → the clip covering that frame.',
				markerByName: '{"markerByName": "Intro"} → marker id.',
				time: 'Times: frames, {frames}, {seconds} or timecode "HH:MM:SS:FF" (";" for drop-frame).',
			},
			concurrency:
				'Send expectedRevision; stale revisions are rejected with E_REVISION_MISMATCH unless none of the touched entities changed (fast-forward, S01:AGT-010).',
			approvals: {
				commands: APPROVAL_COMMANDS,
				force: 'Any command argument force: true',
				timeoutMs: this.approvals.timeoutMs,
				codes: ['E_APPROVAL_DENIED', 'E_APPROVAL_TIMEOUT'],
				headless: 'Rejected with E_APPROVAL_DENIED when no editor session is open.',
			},
			limits: AGENT_TX_LIMITS,
			events: [
				'doc.changed',
				'selection.changed',
				'playhead.changed',
				'agent.approval.requested',
				'agent.approval.resolved',
			],
			engineErrorCodes: ENGINE_ERROR_CODES,
		};
		return this.schemaCache;
	}

	// ------------------------------------------------------------ queries

	async query(
		req: AgentQueryRequest,
	): Promise<{ result: unknown; revision?: number; via: 'session' | 'headless' }> {
		const holder = this.sessions.holder(req.projectId) ?? this.anySession(req.projectId);
		if (holder) {
			try {
				const out = await this.sessions.request(
					holder,
					'query',
					{ query: req.query, args: req.args ?? {} },
					this.relayTimeoutMs,
				);
				if (out.error) throw queryError(out.error.code, out.error.message);
				const r = (out.result ?? {}) as { result?: unknown; revision?: number };
				return {
					result: r.result,
					...(typeof r.revision === 'number' ? { revision: r.revision } : {}),
					via: 'session',
				};
			} catch (e) {
				if (!(e instanceof RelayError)) throw e;
				if (SESSION_ONLY_QUERIES.has(req.query as never))
					throw new AgentApiError(503, 'NO_SESSION', e.message, { code: 'E_NO_SESSION' });
				// Read-only queries may fall back to the stored document.
			}
		}
		if (SESSION_ONLY_QUERIES.has(req.query as never))
			throw new AgentApiError(
				409,
				'NO_SESSION',
				`${req.query} needs an editor session with the project open`,
				{
					code: 'E_NO_SESSION',
				},
			);
		const { doc, revision, envelope } = await this.loadDocument(req.projectId);
		try {
			if (req.query === 'frame.capture') {
				const cap = resolveCaptureArgs({ doc }, req.args);
				if (!this.opts.captureStill)
					throw new AgentApiError(501, 'NOT_IMPLEMENTED', 'Stills are not available');
				const result = await this.opts.captureStill({ projectId: req.projectId, envelope, ...cap });
				return { result, revision, via: 'headless' };
			}
			const result = runAgentQuery(
				{
					doc,
					revision,
					effects: this.opts.registries.effects,
					dryRun: (tx) => this.dryRun(doc, revision, req.projectId, tx),
				},
				req.query,
				req.args ?? {},
			);
			return { result, revision, via: 'headless' };
		} catch (e) {
			if (e instanceof AgentQueryError) throw queryError(e.code, e.message);
			throw e;
		}
	}

	private anySession(projectId: string): AgentConnection | null {
		return this.sessions.connectionsFor(projectId).at(-1) ?? null;
	}

	private dryRun(
		doc: ProjectDocument,
		revision: number,
		projectId: string,
		raw: Record<string, unknown>,
	): TransactionResult {
		const tx = normalizeAgentTransaction(raw as AgentTxInput, 'validate');
		const addr = resolveAgentAddresses(doc, tx.commands, { sequenceId: tx.sequenceId });
		if (!addr.ok) return { ok: false, revision, errors: addr.errors };
		return applyTransaction(
			doc,
			{ ...tx, commands: addr.commands, dryRun: true },
			this.context(revision, projectId, tx.expectedRevision),
		).result;
	}

	private context(revision: number, projectId: string, expectedRevision?: number) {
		return {
			ids: this.ids,
			now: () => this.now().toISOString(),
			revision,
			registries: this.opts.registries,
			entityRevisions: this.revisions.mapFor(projectId, expectedRevision),
		};
	}

	private async loadDocument(projectId: string): Promise<{
		doc: ProjectDocument;
		revision: number;
		envelope: Record<string, unknown>;
		readOnly: boolean;
	}> {
		const stored = await this.opts.store().load(projectId);
		if (!stored) throw new AgentApiError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
		try {
			const loaded = loadProject(stored.envelope, { ids: this.ids, effects: this.opts.registries.effects });
			return {
				doc: loaded.document,
				revision: stored.revision,
				envelope: stored.envelope,
				readOnly: loaded.readOnly,
			};
		} catch (e) {
			throw new AgentApiError(
				422,
				'VALIDATION_FAILED',
				`The stored project cannot be loaded: ${(e as Error).message}`,
			);
		}
	}

	// ------------------------------------------------------------ transactions

	async transact(
		projectId: string,
		rawTx: AgentTxInput,
		opts: { byteLength?: number; fallbackAgent?: string } = {},
	): Promise<AgentTxResponse> {
		const tx = normalizeAgentTransaction(rawTx, opts.fallbackAgent ?? 'external');
		const holder = this.sessions.holder(projectId);
		const appliedBy = holder ? 'session' : 'headless';
		const limit = checkAgentTxLimits(tx, opts.byteLength);
		if (limit) return { result: { ok: false, revision: -1, errors: [limit] }, appliedBy };

		const reasons = approvalReasons(tx);
		let approved = false;
		if (reasons.length > 0) {
			if (!holder)
				return {
					result: fail(
						-1,
						'E_APPROVAL_DENIED',
						`Needs the user's approval (${reasons.join('; ')}) but no editor session has the project open; headless mode rejects destructive transactions`,
					),
					appliedBy: 'headless',
				};
			const decision = await this.requestApproval(projectId, tx, reasons);
			if (decision !== 'approved')
				return {
					result: fail(
						-1,
						decision === 'timeout' ? 'E_APPROVAL_TIMEOUT' : 'E_APPROVAL_DENIED',
						decision === 'timeout'
							? `The user did not answer the approval request within ${this.approvals.timeoutMs / 1000} s`
							: 'The user denied the transaction',
					),
					appliedBy: 'session',
				};
			approved = true;
		}

		const target = this.sessions.holder(projectId);
		if (target) {
			try {
				const out = await this.sessions.request(
					target,
					'tx',
					{ transaction: tx, approved },
					this.relayTimeoutMs,
				);
				if (out.error) return { result: fail(-1, out.error.code, out.error.message), appliedBy: 'session' };
				const parsed = TransactionResultSchema.safeParse(out.result);
				if (!parsed.success)
					return {
						result: fail(-1, 'E_INTERNAL', 'The editor session returned an invalid result'),
						appliedBy: 'session',
					};
				return { result: parsed.data as TransactionResult, appliedBy: 'session' };
			} catch (e) {
				if (!(e instanceof RelayError)) throw e;
				// A disconnect mid-request is ambiguous (the session may have applied it): never re-apply.
				if (e.code === 'E_NO_SESSION' || !(await this.leaseExpired(projectId)))
					return { result: fail(-1, 'E_NO_SESSION', e.message, { retryable: true }), appliedBy: 'session' };
				// Timed out and the lease expired: the editor is gone, apply headlessly.
			}
		} else if (approved) {
			return {
				result: fail(-1, 'E_NO_SESSION', 'The editor session disconnected during approval'),
				appliedBy: 'session',
			};
		}
		return { result: await this.headless(projectId, tx), appliedBy: 'headless' };
	}

	private async requestApproval(
		projectId: string,
		tx: ReturnType<typeof normalizeAgentTransaction>,
		reasons: string[],
	): Promise<ApprovalDecision> {
		const { decision } = this.approvals.request({
			projectId,
			label: tx.label,
			agent: tx.origin.agent,
			reasons,
			commandCount: tx.commands.length,
			summary: summarizeTransaction(tx),
			commands: tx.commands.slice(0, 50),
		});
		return decision;
	}

	/** True when the store reports no live lease (or cannot tell and no session is connected). */
	private async leaseExpired(projectId: string): Promise<boolean> {
		const store = this.opts.store();
		if (!store.leaseHolder) return false;
		const lease = await store.leaseHolder(projectId);
		return !lease || Date.parse(lease.expiresAt) <= this.now().getTime();
	}

	/** Headless apply + save with a new revision (S01:AGT-020), serialized per project. */
	private headless(
		projectId: string,
		tx: ReturnType<typeof normalizeAgentTransaction>,
	): Promise<TransactionResult> {
		return this.serialize(projectId, async () => {
			if (historyPseudoCommand(tx))
				return fail(
					-1,
					'E_NO_SESSION',
					'history.undo/redo need an open editor session (history is per session)',
				);
			const store = this.opts.store();
			if (store.leaseHolder && !(await this.leaseExpired(projectId))) {
				const lease = await store.leaseHolder(projectId);
				return fail(
					-1,
					'E_NO_SESSION',
					`Session ${lease?.sessionId ?? '?'} holds the project lease but is not connected to the agent relay; retry later`,
					{ retryable: true },
				);
			}
			for (let attempt = 0; attempt < 3; attempt++) {
				const { doc, revision, readOnly } = await this.loadDocument(projectId);
				if (readOnly)
					return fail(revision, 'E_NOT_OWNER', 'The project was saved by a newer version and is read-only');
				this.revisions.sync(projectId, revision);
				const addr = resolveAgentAddresses(doc, tx.commands, { sequenceId: tx.sequenceId });
				if (!addr.ok) return { ok: false, revision, errors: addr.errors };
				const { document, result } = applyTransaction(
					doc,
					{ ...tx, commands: addr.commands },
					this.context(revision, projectId, tx.expectedRevision),
				);
				if (!result.ok || tx.dryRun || document === doc) return result;
				const envelope = makeEnvelope(document, {
					revision: result.revision,
					savedAt: this.now().toISOString(),
					platform: 'engine-headless',
					appVersion: this.opts.engineVersion,
				}) as unknown as Record<string, unknown>;
				const saved = await store.save(projectId, envelope, revision);
				if (!saved.ok) continue; // someone saved in between: reload and re-apply
				this.revisions.observe(projectId, result.revision, [
					...result.created,
					...result.changed,
					...result.deleted,
				]);
				this.publish(
					'doc.changed',
					{
						projectId,
						revision: result.revision,
						label: tx.label.startsWith('Agent: ') ? tx.label : `Agent: ${tx.label}`,
						origin: tx.origin,
						created: result.created,
						changed: result.changed,
						deleted: result.deleted,
						isUndo: false,
						isRedo: false,
						headless: true,
					},
					projectId,
				);
				return result;
			}
			return fail(-1, 'E_REVISION_MISMATCH', 'The project kept changing while saving; retry', {
				retryable: true,
			});
		});
	}

	private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(projectId) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.catch(() => undefined);
		this.locks.set(projectId, tail);
		void tail.then(() => {
			if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
		});
		return next;
	}

	// ------------------------------------------------------------ session events

	private onSessionEvent(conn: AgentConnection, event: string, payload: unknown): void {
		if (event === 'agent.approval.resolve') {
			const p = payload as { approvalId?: unknown; decision?: unknown };
			if (typeof p?.approvalId === 'string' && (p.decision === 'approved' || p.decision === 'denied'))
				this.approvals.resolve(p.approvalId, p.decision, conn.projectId ?? undefined);
			return;
		}
		if (!conn.projectId || !RELAYED_SESSION_EVENTS.has(event)) return;
		if (event === 'doc.changed') {
			const d = payload as { revision?: unknown; created?: unknown; changed?: unknown; deleted?: unknown };
			if (typeof d?.revision === 'number') {
				const ids = [d.created, d.changed, d.deleted].flatMap((x) =>
					Array.isArray(x) ? x.filter((v) => typeof v === 'string') : [],
				);
				this.revisions.observe(conn.projectId, d.revision, ids);
			}
		}
		this.publish(event, { ...(payload as object), projectId: conn.projectId }, conn.projectId);
	}

	/** Pending approvals (for diagnostics and tests). */
	pendingApprovals(projectId?: string): Approval[] {
		return this.approvals.pending(projectId);
	}
}
