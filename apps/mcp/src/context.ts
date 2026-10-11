import type { AgentTxResponse, EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { loadExpressionEngine } from '@jasper/expressions';
import {
	approvalReasons,
	bindExpressions,
	type Clip,
	documentHasActiveExpressions,
	type ProjectDocument,
	resolveCaptureArgs,
	resolveFrameInput,
	type Sequence,
} from '@jasper/project';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
	CallToolResult,
	ProgressNotification,
	ServerNotification,
	ServerRequest,
	ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { toolEnvelope } from './envelope.ts';
import { cancelledResult, RequestCancelled, ToolError, TX_ERROR_HINTS, toErrorResult } from './errors.ts';
import { type EngineConnection, withEngine } from './link.ts';
import { strictInputSchema } from './strict.ts';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type ToolContext = {
	server: McpServer;
	link: EngineConnection;
	/** The agent name recorded in History ("Agent: <label>", origin {agent}). */
	agentName(): string;
	engine<T>(fn: (c: EngineClient) => Promise<T>): Promise<T>;
};

export function makeContext(server: McpServer, link: EngineConnection, agentName?: string): ToolContext {
	const name = () => {
		if (agentName) return agentName;
		const client = server.server.getClientVersion()?.name;
		return client ? client.slice(0, 64) : 'mcp-agent';
	};
	// The engine shows this name on the approval card of a destructive operation (security review AGT-3).
	link.agentName = name;
	return {
		server,
		link,
		agentName: name,
		engine: (fn) => withEngine(link, fn),
	};
}

type Shape = Record<string, z.ZodType>;

/**
 * MCP tool annotations, all four hints required (docs/wp-notes/mcp-cli.md §1): clients use them to let
 * read-only tools run without asking and to confirm destructive ones.
 * - readOnlyHint: the tool changes nothing (projects, files, jobs, settings, the editor's view).
 * - destructiveHint: it deletes or overwrites something (clips, items, transitions, keyframes, files,
 *   cache entries, settings, jobs) rather than only adding to or adjusting the project.
 * - idempotentHint: calling it again with the same arguments changes nothing more.
 * - openWorldHint: it reaches beyond the local engine and the user's files (network downloads, remote
 *   executors).
 */
export type FullToolAnnotations = Required<
	Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
>;

/**
 * Registers a tool whose handler returns a CallToolResult; any exception becomes an `isError` result
 * with an actionable hint. The input shape becomes a deep-strict schema: unknown argument keys at any
 * level are rejected with the accepted ones listed (strict.ts installs the matching validation).
 */
export function defineTool<S extends Shape>(
	ctx: ToolContext,
	name: string,
	config: { title: string; description: string; input: S; annotations: FullToolAnnotations },
	run: (args: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<CallToolResult>,
): void {
	ctx.server.registerTool<z.ZodType, z.ZodObject<S>>(
		name,
		{
			title: config.title,
			description: config.description,
			inputSchema: strictInputSchema(config.input),
			annotations: { ...config.annotations },
		},
		async (args, extra) => {
			try {
				return await run(args, extra);
			} catch (e) {
				if (extra.signal.aborted) return cancelledResult();
				return toErrorResult(e);
			} finally {
				disposeReporters(extra);
			}
		},
	);
}

/** Lists, inspections and renders that change nothing. */
export const READ_ONLY: FullToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
/** An additive edit; calling it again adds again (a second clip, marker, import…). */
export const EDIT: FullToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};
/** A setter: the same arguments leave the same state. */
export const EDIT_IDEMPOTENT: FullToolAnnotations = { ...EDIT, idempotentHint: true };
/** Deletes or overwrites; calling it again may remove or change more. */
export const DESTRUCTIVE: FullToolAnnotations = { ...EDIT, destructiveHint: true };
/** Deletes or overwrites a named target; calling it again changes nothing more. */
export const DESTRUCTIVE_IDEMPOTENT: FullToolAnnotations = { ...DESTRUCTIVE, idempotentHint: true };

export type LoadedDoc = { doc: ProjectDocument; revision: number | undefined; live: boolean };

/** The current document: from the open editor when there is one (unsaved edits included), else stored. */
export async function loadDoc(ctx: ToolContext, projectId: string): Promise<LoadedDoc> {
	const r = await ctx.engine((c) => c.agentQuery({ projectId, query: 'doc.get', args: {} }));
	let doc = r.result as ProjectDocument;
	if (!doc || typeof doc !== 'object' || !doc.sequences)
		throw new ToolError('INTERNAL', 'The engine returned no document');
	// Property tools report post-expression values so their output matches the renderer.
	if (documentHasActiveExpressions(doc)) {
		await loadExpressionEngine();
		doc = bindExpressions(doc);
	}
	return { doc, revision: r.revision, live: r.via === 'session' };
}

export function findClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: Clip } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId];
		if (clip) return { seq, clip };
	}
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Call get_timeline for clip ids.');
}

/** Resolve a tool's sequence time while preserving its actionable input hint. */
export function frameOf(
	seq: Sequence,
	t: unknown,
	hint = 'Times are frames, {"seconds": x} or "HH:MM:SS:FF".',
): number {
	try {
		return resolveFrameInput(seq, t);
	} catch (e) {
		throw new ToolError('E_INVALID_PARAM', (e as Error).message, hint);
	}
}

/** At most one `notifications/progress` per request every this many ms (docs/wp-notes/mcp-cli.md §2). */
export const PROGRESS_INTERVAL_MS = 100;

export type ProgressReporter = {
	(progress: number, total?: number, message?: string): void;
	/** Sends the latest pending update (waiting out the interval) so it arrives before the result. */
	flush(): Promise<void>;
	/** Drops a pending update (the request is over). */
	dispose(): void;
};

type ProgressParams = ProgressNotification['params'];

/** Per-request progress state, shared by every reporter of the request (nested waits included). */
type ProgressChannel = {
	lastSentAt: number;
	lastProgress: number;
	pending: ProgressParams | null;
	timer: ReturnType<typeof setTimeout> | null;
};

const channels = new WeakMap<Extra, ProgressChannel>();

/**
 * Sends `notifications/progress` when the client asked for progress (`_meta.progressToken`): throttled to
 * one every PROGRESS_INTERVAL_MS per request (the latest value wins; a trailing update follows a burst) and
 * strictly increasing across every reporter of the request, as the MCP progress utility requires.
 */
export function progressReporter(
	extra: Extra,
	opts: { intervalMs?: number; now?: () => number } = {},
): ProgressReporter {
	const token = extra._meta?.progressToken;
	const interval = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
	const now = opts.now ?? (() => Date.now());
	let ch = channels.get(extra);
	if (!ch) {
		ch = {
			lastSentAt: Number.NEGATIVE_INFINITY,
			lastProgress: Number.NEGATIVE_INFINITY,
			pending: null,
			timer: null,
		};
		channels.set(extra, ch);
	}
	const c = ch;
	const send = () => {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		const p = c.pending;
		c.pending = null;
		if (!p || extra.signal.aborted) return;
		c.lastSentAt = now();
		void extra.sendNotification({ method: 'notifications/progress', params: p }).catch(() => {});
	};
	const report = ((progress: number, total?: number, message?: string) => {
		if (token === undefined || !Number.isFinite(progress) || progress <= c.lastProgress) return;
		c.lastProgress = progress;
		c.pending = {
			progressToken: token,
			progress,
			...(total !== undefined ? { total } : {}),
			...(message ? { message } : {}),
		};
		const wait = c.lastSentAt + interval - now();
		if (wait <= 0) send();
		else if (!c.timer) c.timer = setTimeout(send, wait);
	}) as ProgressReporter;
	report.flush = async () => {
		if (!c.pending) return;
		const wait = c.lastSentAt + interval - now();
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		send();
	};
	report.dispose = () => {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		c.pending = null;
	};
	return report;
}

/** Drops the pending progress update of a finished request (defineTool calls it). */
export function disposeReporters(extra: Extra): void {
	const c = channels.get(extra);
	if (c?.timer) clearTimeout(c.timer);
	channels.delete(extra);
}

export type TxInput = {
	label: string;
	commands: unknown[];
	dryRun?: boolean;
	expectedRevision?: number;
	sequenceId?: string;
};

/** The command system's refusal when a sequence-scoped command has no sequenceId and the project has several. */
const SEQUENCE_REQUIRED = /sequenceId is required when the project has several sequences/;

/** The project's first sequence: the documented default of every tool's optional `sequenceId`. */
async function firstSequenceId(ctx: ToolContext, projectId: string): Promise<string | undefined> {
	const r = await ctx.engine((c) => c.agentQuery({ projectId, query: 'doc.get', args: {} }));
	const doc = r.result as ProjectDocument | undefined;
	return doc?.sequences ? Object.keys(doc.sequences)[0] : undefined;
}

function refusedForSequence(res: AgentTxResponse): boolean {
	const r = res.result;
	return !r.ok && r.errors.some((e) => SEQUENCE_REQUIRED.test(e.message));
}

/**
 * Sends an agent transaction (`POST /api/agent/tx`): the engine applies it through the open editor (live,
 * one "Agent: <label>" undo entry) or headlessly. Destructive transactions wait for the user's approval in
 * the editor (up to 60 s); meanwhile the client gets progress notifications.
 *
 * Without `sequenceId`, sequence-scoped commands use the project's first sequence, as every tool documents
 * ("default: the project's first sequence"). The command system itself refuses them when the project has several
 * sequences (a nest or a multi-camera source is enough), so such a refusal is retried once with the first sequence
 * (a refused transaction applied nothing). A transaction that needs the user's approval resolves the sequence first
 * instead, so the user is never asked twice.
 */
export async function transact(
	ctx: ToolContext,
	projectId: string,
	input: TxInput,
	extra?: Extra,
): Promise<AgentTxResponse> {
	const needsApproval = approvalReasons({ commands: input.commands, dryRun: input.dryRun });
	let timer: ReturnType<typeof setInterval> | null = null;
	if (needsApproval.length && extra) {
		const report = progressReporter(extra);
		let n = 0;
		const tick = () =>
			report(n++, undefined, `Waiting for the user to approve "${input.label}" in the JasperEditor window…`);
		tick();
		timer = setInterval(tick, 5000);
	}
	const send = (sequenceId: string | undefined) =>
		ctx.engine((c) =>
			c.agentTx({
				projectId,
				transaction: {
					protocol: 'jasper.tx/1',
					label: input.label,
					origin: { agent: ctx.agentName() },
					commands: input.commands as never,
					...(input.dryRun ? { dryRun: true } : {}),
					...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
					...(sequenceId ? { sequenceId } : {}),
				} as never,
			}),
		);
	try {
		if (input.sequenceId) return await send(input.sequenceId);
		if (needsApproval.length) return await send(await firstSequenceId(ctx, projectId));
		const res = await send(undefined);
		if (!refusedForSequence(res)) return res;
		const first = await firstSequenceId(ctx, projectId);
		return first ? await send(first) : res;
	} finally {
		if (timer) clearInterval(timer);
	}
}

/** Throws a ToolError for a rejected transaction (first error's code + hint, all errors as details). */
export function requireOk(res: AgentTxResponse): Extract<AgentTxResponse['result'], { ok: true }> {
	const r = res.result;
	if (r.ok) return r;
	const first = r.errors[0];
	const code = first?.code ?? 'E_INTERNAL';
	const where = first && first.commandIndex >= 0 ? ` (command ${first.commandIndex + 1})` : '';
	throw new ToolError(
		code,
		`${first?.message ?? 'The transaction was rejected'}${where}`,
		TX_ERROR_HINTS[code],
		{
			appliedBy: res.appliedBy,
			revision: r.revision,
			errors: r.errors.map((e) => ({
				commandIndex: e.commandIndex,
				code: e.code,
				message: e.message,
				...(e.path ? { path: e.path } : {}),
			})),
		},
	);
}

/** The JSON body of an applied transaction. */
export function txBody(
	res: AgentTxResponse,
	r: Extract<AgentTxResponse['result'], { ok: true }>,
	dryRun = false,
) {
	return {
		ok: true,
		...(dryRun ? { dryRun: true } : {}),
		appliedBy: res.appliedBy,
		appliedLive: res.appliedBy === 'session',
		revision: r.revision,
		...(Object.keys(r.refs).length ? { refs: r.refs } : {}),
		created: r.created,
		changed: r.changed,
		deleted: r.deleted,
		...(r.results.some((x) => x !== undefined && x !== null) ? { results: r.results } : {}),
		...(r.warnings.length ? { warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })) } : {}),
	};
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const isTerminal = (job: EngineJob) => TERMINAL.has(job.state);

/** Compact job view; engine-relative URLs become absolute. */
export function jobBody(job: EngineJob, baseUrl: string) {
	const result = job.result as Record<string, unknown> | undefined;
	const abs = (u: unknown) => (typeof u === 'string' && u.startsWith('/') ? `${baseUrl}${u}` : u);
	return {
		jobId: job.id,
		kind: job.kind,
		title: job.title,
		state: job.state,
		progress: job.progress === null ? null : Math.round(job.progress * 1000) / 10,
		...(job.stage ? { stage: job.stage } : {}),
		...(job.etaSec !== undefined ? { etaSec: Math.round(job.etaSec) } : {}),
		...(job.error ? { error: job.error } : {}),
		...(result
			? {
					result: {
						...result,
						...(result.downloadUrl ? { downloadUrl: abs(result.downloadUrl) } : {}),
						...(result.url ? { url: abs(result.url) } : {}),
					},
				}
			: {}),
	};
}

/** How long a cancelled job may take to reach `cancelled` (the engine guarantees 5 s). */
const CANCEL_WAIT_MS = 10_000;
const POLL_MS = 250;

/** Sleeps `ms`, or less when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

/**
 * Cancels an engine job and waits until it is terminal: the engine kills its processes and deletes its
 * partial outputs before it reports `cancelled`. Errors are swallowed (the job may already be gone).
 */
export async function cancelJobAndWait(ctx: ToolContext, jobId: string): Promise<EngineJob | null> {
	try {
		let job = await ctx.engine((c) => c.cancelJob(jobId));
		const until = Date.now() + CANCEL_WAIT_MS;
		while (!isTerminal(job) && Date.now() < until) {
			await sleep(POLL_MS);
			job = await ctx.engine((c) => c.getJob(jobId));
		}
		return job;
	} catch {
		return null;
	}
}

/**
 * When the MCP request was cancelled (`notifications/cancelled` aborts `extra.signal`): cancels the
 * engine job (partial outputs are deleted) and throws RequestCancelled. Tools call it right after they
 * started a job, so a cancel that arrived while it was being submitted is not lost.
 */
export async function cancelIfAborted(
	ctx: ToolContext,
	extra: Extra | undefined,
	jobId: string,
): Promise<void> {
	if (!extra?.signal.aborted) return;
	await cancelJobAndWait(ctx, jobId);
	throw new RequestCancelled(jobId);
}

/**
 * Polls a job until it finishes or `timeoutMs` passes, with throttled progress notifications. A cancelled
 * MCP request cancels the job (and its partial outputs) unless `cancelJobOnAbort` is false.
 */
export async function waitJob(
	ctx: ToolContext,
	jobId: string,
	timeoutMs: number,
	extra?: Extra,
	opts: { cancelJobOnAbort?: boolean } = {},
): Promise<{ job: EngineJob; timedOut: boolean }> {
	const report = extra ? progressReporter(extra) : null;
	const signal = extra?.signal;
	const until = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) {
			if (opts.cancelJobOnAbort !== false) await cancelJobAndWait(ctx, jobId);
			throw new RequestCancelled(jobId);
		}
		const job = await ctx.engine((c) => c.getJob(jobId));
		if (isTerminal(job)) {
			report?.(1, 1, `${job.title}: ${job.state}`);
			await report?.flush();
			return { job, timedOut: false };
		}
		if (job.progress !== null)
			report?.(Math.min(job.progress, 0.999), 1, `${job.title}${job.stage ? ` — ${job.stage}` : ''}`);
		if (Date.now() >= until) {
			await report?.flush();
			return { job, timedOut: true };
		}
		await sleep(POLL_MS, signal);
	}
}

export type StillResult = {
	jobId: string;
	sequenceId: string;
	frame: number;
	width: number;
	url: string;
	renderPath?: string;
	bytes: Uint8Array;
	contentType: string;
};

/**
 * Renders a Program still the way `frame.capture` does (the open editor's document when the project is
 * open, else the saved one) but as a job this tool owns, so a cancelled request cancels the render.
 */
export async function captureStill(
	ctx: ToolContext,
	args: { projectId: string; frame: unknown; width?: number; sequenceId?: string },
	extra?: Extra,
	doc?: LoadedDoc,
	/** Builds the error for a failed still job (render hints live in tools/templates.ts). */
	failed?: (job: EngineJob) => Promise<Error>,
): Promise<StillResult> {
	const loaded = doc ?? (await loadDoc(ctx, args.projectId));
	// The documented default (the project's first sequence); `frame.capture` alone refuses when there are several.
	const sequenceId = args.sequenceId ?? Object.keys(loaded.doc.sequences)[0];
	let cap: { sequenceId: string; frame: number; width: number };
	try {
		cap = resolveCaptureArgs(
			{ doc: loaded.doc },
			{
				frame: args.frame,
				...(args.width ? { width: args.width } : {}),
				...(sequenceId ? { sequenceId } : {}),
			},
		);
	} catch (e) {
		throw new ToolError(
			(e as { code?: string }).code ?? 'E_INVALID_PARAM',
			(e as Error).message,
			'Times are frames, {"seconds": x} or "HH:MM:SS:FF"; sequence ids come from get_project.',
		);
	}
	const envelope = toolEnvelope(loaded.doc, loaded.revision);
	const job = await ctx.engine((c) =>
		c.requestStill({ envelope, sequenceId: cap.sequenceId, frame: cap.frame, width: cap.width }),
	);
	await cancelIfAborted(ctx, extra, job.id);
	const { job: done, timedOut } = await waitJob(ctx, job.id, STILL_TIMEOUT_MS, extra);
	if (timedOut)
		throw new ToolError(
			'RENDER_TIMEOUT',
			`The frame is still rendering after ${STILL_TIMEOUT_MS / 1000} s`,
			'The first Remotion render bundles the compositions and may download a browser: wait_for_job with this jobId, then try again.',
			{ jobId: job.id },
		);
	if (done.state !== 'succeeded') {
		if (failed) throw await failed(done);
		throw new ToolError(
			done.error?.code ?? `JOB_${done.state.toUpperCase()}`,
			done.error?.message ?? `The still ${done.state}`,
			undefined,
			{ jobId: done.id },
		);
	}
	const result = done.result as { url?: string; renderPath?: string };
	if (!result?.url) throw new ToolError('INTERNAL', 'The engine returned no image');
	const { bytes, contentType } = await ctx.engine((c) => c.fetchBytes(result.url!));
	return {
		jobId: done.id,
		sequenceId: cap.sequenceId,
		frame: cap.frame,
		width: cap.width,
		url: result.url,
		...(result.renderPath ? { renderPath: result.renderPath } : {}),
		bytes,
		contentType,
	};
}

const STILL_TIMEOUT_MS = 120_000;
