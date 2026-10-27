// Agent API service (ARCHITECTURE §11 Stage 1, S01 §21): schema, queries and transactions for external
// agents. Requests for a project whose editor session is connected to WS /agent are relayed to it
// (30 s timeout); otherwise the engine answers headlessly with @jasper/project (S01:AGT-020).
// Destructive transactions go through the approval gate (S01:AGT-011).
import { randomBytes } from 'node:crypto';
import {
	AgentApprovalResolveSchema,
	type AgentQueryRequest,
	type AgentTxResponse,
	type AgentUiRequest,
	type AgentUiResponse,
	type Approval,
	type ApprovalCard,
	ENGINE_ERROR_CODES,
	type EnvelopeJson,
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
	createPresetIdSource,
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
	type TextMeasurer,
	type TransactionResult,
	unknownCommandKeyIssues,
} from '@jasper/project';
import { secretsEqual } from '../auth/secrets.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import { type ApprovalDecision, ApprovalGate, type ApprovalRequest } from './approvals.ts';
import { RevisionTracker } from './revisions.ts';
import { type AgentConnection, type AgentSocket, RelayError, SessionRegistry } from './sessions.ts';
import type { AgentProjectStore } from './store.ts';

const RELAY_TIMEOUT_MS = 30_000;

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
	envelope: EnvelopeJson;
	sequenceId: string;
	frame: number;
	width: number;
};

type AgentServiceOptions = {
	engineVersion: string;
	/** Resolves the engine's project-store adapter. */
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
	/**
	 * spec 13 SH-004: runs a headless transaction with a text measurer (the engine's render browser), so text boxes
	 * follow glyph metrics without an editor window. Absent = estimated boxes marked `layoutPending`.
	 */
	textMeasurer?: { apply<R>(run: (m: TextMeasurer) => R): Promise<R> };
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
function queryError(code: string, message: string): AgentApiError {
	const [status, httpCode] = QUERY_ERROR_STATUS[code] ?? [502, 'INTERNAL'];
	return new AgentApiError(status, httpCode, message, { code });
}

const RELAYED_SESSION_EVENTS = new Set(['doc.changed', 'selection.changed', 'playhead.changed']);

/** The user's answer, or `no-editor`: no editor window that could show the card is connected. */
type UserApprovalOutcome = ApprovalDecision | 'no-editor';

export class AgentService {
	readonly sessions: SessionRegistry;
	readonly approvals: ApprovalGate;
	readonly revisions = new RevisionTracker();
	private readonly mutex = new KeyedMutex();
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
			onHello: (conn) => this.onSessionHello(conn),
		});
		this.approvals = new ApprovalGate({
			timeoutMs: opts.approvalTimeoutMs,
			onResolved: (a, decision) => {
				const payload = { approvalId: a.approvalId, decision };
				this.publish('agent.approval.resolved', payload, a.projectId || undefined);
				// Exactly the windows that showed the card take it down.
				for (const c of this.cardHolders.get(a.approvalId) ?? []) {
					c.approvalKeys.delete(a.approvalId);
					this.sessions.sendTo(c, 'agent.approval.resolved', payload);
				}
				this.cardHolders.delete(a.approvalId);
			},
		});
	}

	/** approvalId → the editor connections showing its card. */
	private readonly cardHolders = new Map<string, Set<AgentConnection>>();

	/**
	 * Shows one editor connection the card of a pending approval, with an answer key made for that connection and
	 * that approval. The key travels only on this WebSocket: it is in no engine event, no HTTP response and no log,
	 * so nothing but the window that displays the card can answer it.
	 */
	private showCard(conn: AgentConnection, approval: Approval): void {
		if (!conn.editor || !conn.projectId || conn.approvalKeys.has(approval.approvalId)) return;
		const answerKey = randomBytes(24).toString('base64url');
		conn.approvalKeys.set(approval.approvalId, answerKey);
		let holders = this.cardHolders.get(approval.approvalId);
		if (!holders) {
			holders = new Set();
			this.cardHolders.set(approval.approvalId, holders);
		}
		holders.add(conn);
		// The window filters cards by its own project; a project-less approval is shown under the window's.
		const card: ApprovalCard = { ...approval, projectId: conn.projectId, answerKey };
		if (!this.sessions.sendTo(conn, 'agent.approval.requested', card)) {
			conn.approvalKeys.delete(approval.approvalId);
			holders.delete(conn);
		}
	}

	/**
	 * Asks the user: a card in every editor window of the project (or of any project when the request is not about
	 * one). Resolves with the decision, `timeout`, or `no-editor` at once when no editor window is connected — an
	 * agent, jasper-mcp or the CLI holding the engine token is not one and is never asked.
	 */
	askUser(req: ApprovalRequest): Promise<UserApprovalOutcome> {
		const targets = this.sessions.editors(req.projectId);
		if (targets.length === 0) return Promise.resolve('no-editor');
		const { approval, decision } = this.approvals.request(req);
		this.publish('agent.approval.requested', approval, req.projectId ?? undefined);
		for (const c of targets) this.showCard(c, approval);
		return decision;
	}

	/** True when an editor window that can show an approval card is connected (for a project, or at all). */
	hasEditor(projectId?: string | null): boolean {
		return this.sessions.editors(projectId).length > 0;
	}

	/** An editor window (re)announced itself: it shows what is pending for it, and forgets other projects' cards. */
	private onSessionHello(conn: AgentConnection): void {
		if (!conn.editor || !conn.projectId) return;
		for (const approvalId of [...conn.approvalKeys.keys()]) {
			const scope = this.approvals.scopeOf(approvalId);
			if (scope === null || scope === conn.projectId) continue;
			conn.approvalKeys.delete(approvalId);
			this.cardHolders.get(approvalId)?.delete(conn);
			this.sessions.sendTo(conn, 'agent.approval.resolved', { approvalId, decision: 'moved' });
		}
		for (const a of this.approvals.pending(conn.projectId)) this.showCard(conn, a);
	}

	private publish(type: string, payload: unknown, projectId?: string): void {
		try {
			this.opts.publish?.(type, payload, projectId);
		} catch {
			// event fan-out must never break the agent API
		}
	}

	/**
	 * WS /agent entry point. `editor`: the upgrade request carried the editor key (routes/agent.ts), so this is the
	 * editor window and not something else that holds the token.
	 */
	handleSocket(socket: AgentSocket, opts: { editor?: boolean } = {}): AgentConnection {
		const conn = this.sessions.attach(socket, opts);
		socket.on('close', () => {
			for (const holders of this.cardHolders.values()) holders.delete(conn);
		});
		return conn;
	}

	close(): void {
		this.approvals.close();
		this.sessions.close();
		this.cardHolders.clear();
	}

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

	async query(
		req: AgentQueryRequest,
	): Promise<{ result: unknown; revision?: number; via: 'session' | 'headless' }> {
		const holder = this.sessions.holder(req.projectId) ?? this.sessions.connectionsFor(req.projectId).at(-1);
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
					mgTemplates: this.opts.registries.mgTemplates,
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
		envelope: EnvelopeJson;
		readOnly: boolean;
	}> {
		const stored = await this.opts.store().load(projectId);
		if (!stored) throw new AgentApiError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
		try {
			const loaded = loadProject(stored.envelope, {
				ids: this.ids,
				effects: this.opts.registries.effects,
				mgTemplates: this.opts.registries.mgTemplates,
			});
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

	async transact(
		projectId: string,
		rawTx: AgentTxInput,
		opts: {
			byteLength?: number;
			fallbackAgent?: string;
			/**
			 * Internal callers only (never from a request body): the user already decided in the editor window (the
			 * request carried the editor key), so destructive commands need no approval card (proposal accept).
			 */
			preApproved?: boolean;
			/** Internal callers only: apply as the user's own edit (History "Accept …", not "Agent: …"). */
			asUser?: boolean;
			/**
			 * Internal callers only: id bodies the entities are created with (`createPresetIdSource`), journalled by the
			 * proposal accept before the transaction so that a crash in between can be reconciled with the document.
			 */
			ids?: readonly string[];
		} = {},
	): Promise<AgentTxResponse> {
		const tx = normalizeAgentTransaction(rawTx, opts.fallbackAgent ?? 'external');
		const asUser = opts.asUser === true;
		const holder = this.sessions.holder(projectId);
		const appliedBy = holder ? 'session' : 'headless';
		const limit = checkAgentTxLimits(tx, opts.byteLength);
		if (limit) return { result: { ok: false, revision: -1, errors: [limit] }, appliedBy };
		// Unknown keys anywhere in a command are errors, never silently stripped (mcp-cli §1).
		const unknownKeys = unknownCommandKeyIssues(tx.commands);
		if (unknownKeys.length) return { result: { ok: false, revision: -1, errors: unknownKeys }, appliedBy };

		const reasons = opts.preApproved ? [] : approvalReasons(tx);
		let approved = opts.preApproved === true;
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
							: decision === 'no-editor'
								? `Needs the user's approval (${reasons.join('; ')}) but no editor window that can show the request has the project open`
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
					{
						transaction: tx,
						approved,
						...(asUser ? { asUser: true } : {}),
						...(opts.ids?.length ? { ids: opts.ids } : {}),
					},
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
		} else if (approved && !opts.preApproved) {
			return {
				result: fail(-1, 'E_NO_SESSION', 'The editor session disconnected during approval'),
				appliedBy: 'session',
			};
		}
		return { result: await this.headless(projectId, tx, asUser, opts.ids), appliedBy: 'headless' };
	}

	private async requestApproval(
		projectId: string,
		tx: ReturnType<typeof normalizeAgentTransaction>,
		reasons: string[],
	): Promise<UserApprovalOutcome> {
		return this.askUser({
			projectId,
			label: tx.label,
			agent: tx.origin.agent,
			reasons,
			commandCount: tx.commands.length,
			summary: summarizeTransaction(tx),
			commands: tx.commands.slice(0, 50),
			kind: 'transaction',
		});
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
		asUser = false,
		presetIds?: readonly string[],
	): Promise<TransactionResult> {
		return this.mutex.run(projectId, async () => {
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
				const ctx = this.context(revision, projectId, tx.expectedRevision);
				const run = (textMeasurer?: TextMeasurer) =>
					applyTransaction(
						doc,
						{ ...tx, commands: addr.commands, ...(asUser ? { origin: 'user' } : {}) },
						// every attempt (and measuring round) starts from the first journalled id (only one result is saved)
						{
							...(presetIds?.length ? { ...ctx, ids: createPresetIdSource(presetIds, ctx.ids) } : ctx),
							...(textMeasurer ? { textMeasurer } : {}),
						},
					);
				const { document, result } = this.opts.textMeasurer ? await this.opts.textMeasurer.apply(run) : run();
				if (!result.ok || tx.dryRun || document === doc) return result;
				const envelope = makeEnvelope(document, {
					revision: result.revision,
					savedAt: this.now().toISOString(),
					platform: 'engine-headless',
					appVersion: this.opts.engineVersion,
				});
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
						label: asUser || tx.label.startsWith('Agent: ') ? tx.label : `Agent: ${tx.label}`,
						origin: asUser ? 'user' : tx.origin,
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

	private onSessionEvent(conn: AgentConnection, event: string, payload: unknown): void {
		if (event === 'agent.approval.resolve') {
			// Security review AGT-2: an answer counts only from the editor connection that was shown the card, proven by
			// the answer key that connection alone received. Approve and deny alike: a connection that merely holds the
			// engine token (an agent, jasper-mcp, the CLI) can do neither.
			const p = AgentApprovalResolveSchema.safeParse(payload);
			if (!p.success || !conn.editor || !conn.projectId) return;
			const key = conn.approvalKeys.get(p.data.approvalId);
			if (!key || !secretsEqual(key, p.data.answerKey)) return;
			this.approvals.resolve(p.data.approvalId, p.data.decision, conn.projectId);
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

	/** True when the project exists in the store. */
	async projectExists(projectId: string): Promise<boolean> {
		return (await this.opts.store().load(projectId)) !== null;
	}

	/** True when an editor session holding the lease is connected (transactions apply live). */
	isLive(projectId: string): boolean {
		return this.sessions.holder(projectId) !== null;
	}

	/**
	 * True when no editor session is connected but one still holds an unexpired lease: that window may come back with
	 * edits it has not saved yet, so the saved project does not say everything about the document.
	 */
	async editorAway(projectId: string): Promise<boolean> {
		if (this.isLive(projectId)) return false;
		try {
			return !(await this.leaseExpired(projectId));
		} catch {
			return true;
		}
	}

	/**
	 * Relays a UI automation request (elements, input, screenshot, coordinate mapping, UI commands) to an open
	 * editor window and returns its answer and which window answered.
	 */
	async ui(req: AgentUiRequest): Promise<AgentUiResponse> {
		const conn = this.sessions.uiTarget(req.projectId);
		if (!conn?.projectId || !conn.sessionId)
			throw new AgentApiError(
				409,
				'NO_SESSION',
				req.projectId
					? `No editor window has project ${req.projectId} open`
					: 'No editor window is open (open a project in the web app or the desktop app first)',
				{ code: 'E_NO_SESSION' },
			);
		let out: { result: unknown; error?: { code: string; message: string } };
		try {
			out = await this.sessions.request(
				conn,
				'ui',
				{ action: req.action, args: req.args ?? {} },
				Math.max(this.relayTimeoutMs, UI_TIMEOUT_MS),
			);
		} catch (e) {
			if (e instanceof RelayError)
				throw new AgentApiError(
					e.code === 'E_TIMEOUT' ? 504 : 409,
					e.code === 'E_TIMEOUT' ? 'TIMEOUT' : 'NO_SESSION',
					e.message,
					{
						code: e.code,
					},
				);
			throw e;
		}
		if (out.error)
			throw new AgentApiError(
				out.error.code === 'E_NOT_FOUND' ? 404 : 400,
				out.error.code === 'E_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
				out.error.message,
				{ code: out.error.code },
			);
		return { result: out.result, window: { projectId: conn.projectId, sessionId: conn.sessionId } };
	}
}

/** UI requests may wait for a few frames, a lazy panel or a screenshot of a large window. */
const UI_TIMEOUT_MS = 60_000;
