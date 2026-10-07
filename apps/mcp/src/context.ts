// Shared plumbing for the tool modules: the engine connection, the calling agent's name, document
// loading (live from the open editor when there is one), transactions with approval progress, and the
// tool registration wrapper that turns failures into MCP tool errors.
import type { AgentTxResponse, EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	approvalReasons,
	type Clip,
	type ProjectDocument,
	resolveFrameInput,
	type Sequence,
	type TransactionResult,
} from '@jasper/project';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
	CallToolResult,
	ServerNotification,
	ServerRequest,
	ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { ToolError, TX_ERROR_HINTS, toErrorResult } from './errors.ts';
import { type EngineConnection, withEngine } from './link.ts';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type ToolContext = {
	server: McpServer;
	link: EngineConnection;
	/** The agent name recorded in History ("Agent: <label>", origin {agent}). */
	agentName(): string;
	engine<T>(fn: (c: EngineClient) => Promise<T>): Promise<T>;
};

export function makeContext(server: McpServer, link: EngineConnection, agentName?: string): ToolContext {
	return {
		server,
		link,
		agentName: () => {
			if (agentName) return agentName;
			const client = server.server.getClientVersion()?.name;
			return client ? client.slice(0, 64) : 'mcp-agent';
		},
		engine: (fn) => withEngine(link, fn),
	};
}

type Shape = Record<string, z.ZodType>;

/**
 * Registers a tool whose handler returns a CallToolResult; any exception becomes an `isError` result
 * with an actionable hint.
 */
export function defineTool<S extends Shape>(
	ctx: ToolContext,
	name: string,
	config: { title: string; description: string; input: S; annotations?: ToolAnnotations },
	run: (args: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<CallToolResult>,
): void {
	ctx.server.registerTool(
		name,
		{
			title: config.title,
			description: config.description,
			inputSchema: config.input,
			annotations: { openWorldHint: false, ...config.annotations },
		},
		(async (args: unknown, extra: Extra) => {
			try {
				return await run(args as z.infer<z.ZodObject<S>>, extra);
			} catch (e) {
				return toErrorResult(e);
			}
		}) as never,
	);
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
export const EDIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

// ---------------------------------------------------------------- documents

type LoadedDoc = { doc: ProjectDocument; revision: number | undefined; live: boolean };

/** The current document: from the open editor when there is one (unsaved edits included), else stored. */
export async function loadDoc(ctx: ToolContext, projectId: string): Promise<LoadedDoc> {
	const r = await ctx.engine((c) => c.agentQuery({ projectId, query: 'doc.get', args: {} }));
	const doc = r.result as ProjectDocument;
	if (!doc || typeof doc !== 'object' || !doc.sequences)
		throw new ToolError('INTERNAL', 'The engine returned no document');
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

// ---------------------------------------------------------------- progress

/** Sends `notifications/progress` when the client asked for progress (`_meta.progressToken`). */
export function progressReporter(extra: Extra): (progress: number, total?: number, message?: string) => void {
	const token = extra._meta?.progressToken;
	if (token === undefined) return () => {};
	return (progress, total, message) => {
		void extra
			.sendNotification({
				method: 'notifications/progress',
				params: {
					progressToken: token,
					progress,
					...(total !== undefined ? { total } : {}),
					...(message ? { message } : {}),
				},
			})
			.catch(() => {});
	};
}

// ---------------------------------------------------------------- transactions

export type TxInput = {
	label: string;
	commands: unknown[];
	dryRun?: boolean;
	expectedRevision?: number;
	sequenceId?: string;
};

/**
 * Sends an agent transaction (`POST /api/agent/tx`): the engine applies it through the open editor (live,
 * one "Agent: <label>" undo entry) or headlessly. Destructive transactions wait for the user's approval in
 * the editor (up to 60 s); meanwhile the client gets progress notifications.
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
	try {
		return await ctx.engine((c) =>
			c.agentTx({
				projectId,
				transaction: {
					protocol: 'jasper.tx/1',
					label: input.label,
					origin: { agent: ctx.agentName() },
					commands: input.commands as never,
					...(input.dryRun ? { dryRun: true } : {}),
					...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
					...(input.sequenceId ? { sequenceId: input.sequenceId } : {}),
				} as never,
			}),
		);
	} finally {
		if (timer) clearInterval(timer);
	}
}

/** Throws a ToolError for a rejected transaction (first error's code + hint, all errors as details). */
export function requireOk(res: AgentTxResponse): Extract<TransactionResult, { ok: true }> {
	const r = res.result as TransactionResult;
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
export function txBody(res: AgentTxResponse, r: Extract<TransactionResult, { ok: true }>, dryRun = false) {
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

// ---------------------------------------------------------------- jobs

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

/** Polls a job until it finishes or `timeoutMs` passes (progress notifications on the way). */
export async function waitJob(
	ctx: ToolContext,
	jobId: string,
	timeoutMs: number,
	extra?: Extra,
): Promise<{ job: EngineJob; timedOut: boolean }> {
	const report = extra ? progressReporter(extra) : () => {};
	const until = Date.now() + timeoutMs;
	let last = -1;
	for (;;) {
		const job = await ctx.engine((c) => c.getJob(jobId));
		if (isTerminal(job)) {
			report(1, 1, `${job.title}: ${job.state}`);
			return { job, timedOut: false };
		}
		if (job.progress !== null && job.progress !== last) {
			last = job.progress;
			report(job.progress, 1, `${job.title}${job.stage ? ` — ${job.stage}` : ''}`);
		}
		if (Date.now() >= until) return { job, timedOut: true };
		await new Promise((r) => setTimeout(r, 400));
	}
}
