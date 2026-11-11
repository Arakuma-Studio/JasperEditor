// The MCP server's connection to the engine: discovered lazily on the first tool call (so the server
// starts and lists its tools even when the editor is closed), re-discovered after network failures, and
// optionally backed by an engine this process started (`--start-engine`). An engine that is still starting
// (its runtime file says so, discovery.ts) is waited for with capped exponential backoff, with progress on the
// log and as MCP logging notifications, up to the startup timeout — a budget separate from --request-timeout.
import { AGENT_NAME_HEADER } from '@jasper/api';
import { ENV, platformDefaultAppdir } from '@jasper/config';
import { EngineClient, EngineError } from '@jasper/engine-client';
import {
	type DiscoveryOptions,
	type EngineTarget,
	findEngine,
	findEngineEntry,
	type StartedEngine,
	type StartingEngine,
	startHeadlessEngine,
} from './discovery.ts';
import { ToolError } from './errors.ts';

/** No engine request may hang a tool call: the longest legitimate wait is a 60 s approval. */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
/** How long a starting engine (found or started) is waited for: a cold start on a loaded machine takes tens of seconds. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
/** Backoff between discovery attempts while an engine starts: doubles from the first delay up to the cap. */
const STARTUP_POLL_FIRST_MS = 200;
const STARTUP_POLL_MAX_MS = 2000;

/** `--startup-timeout <s>` / JASPER_ENGINE_STARTUP_TIMEOUT in ms (undefined: the default). */
export function startupTimeoutMs(
	flag: string | undefined,
	env: Record<string, string | undefined>,
): number | undefined {
	const sec = Number(flag ?? env[ENV.ENGINE_STARTUP_TIMEOUT]);
	return Number.isFinite(sec) && sec > 0 ? Math.min(sec, 3600) * 1000 : undefined;
}

/**
 * Thrown (as an `AbortError`, so the engine client does not turn it into a retryable NETWORK error) when a
 * request ran out of time or lost its connection after it was sent. Neither is retried automatically: a
 * transaction may already have been applied.
 */
export class EngineRequestAborted extends Error {
	override readonly name = 'AbortError';
	constructor(
		readonly kind: 'timeout' | 'connection-lost',
		message: string,
	) {
		super(message);
	}
}

/** Error codes of a connection that never reached the engine (safe to retry after re-discovery). */
const NEVER_SENT = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EAI_AGAIN',
	'EADDRNOTAVAIL',
]);

function causeCode(e: unknown): string | undefined {
	const cause = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } })?.cause;
	const code = cause?.code ?? cause?.errors?.[0]?.code;
	return typeof code === 'string' ? code : undefined;
}

/**
 * Wraps `fetch` for engine calls: every request (headers and body) gets a deadline, and a request that
 * was cut off mid-flight is reported as such instead of being retried. Reads (GET) stay retryable.
 */
function guardedFetch(
	fetchImpl: typeof fetch = globalThis.fetch,
	timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const deadline = AbortSignal.timeout(timeoutMs);
		const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
		try {
			return await fetchImpl(input, { ...init, signal });
		} catch (e) {
			if (deadline.aborted)
				throw new EngineRequestAborted(
					'timeout',
					`The engine did not answer within ${Math.round(timeoutMs / 1000)} s`,
				);
			const method = (init?.method ?? 'GET').toUpperCase();
			const code = causeCode(e);
			if (method !== 'GET' && !(code && NEVER_SENT.has(code)) && !init?.signal?.aborted)
				throw new EngineRequestAborted(
					'connection-lost',
					`The connection to the engine was lost during the request${code ? ` (${code})` : ''}`,
				);
			throw e;
		}
	}) as typeof fetch;
}

type LinkOptions = DiscoveryOptions & {
	/** Fork a headless engine when none is reachable. */
	startEngine?: boolean;
	/** Engine bundle for `startEngine` (default: next to this server, or JASPER_ENGINE_ENTRY). */
	engineEntry?: string;
	/** Port for `startEngine` (default 0 = random). */
	enginePort?: number;
	/** Deadline per engine request (default DEFAULT_REQUEST_TIMEOUT_MS). */
	requestTimeoutMs?: number;
	/** How long to wait for a starting engine, found or started (default DEFAULT_STARTUP_TIMEOUT_MS). */
	startupTimeoutMs?: number;
	/** Waits between discovery attempts (default: a timer). */
	sleep?: (ms: number) => Promise<void>;
};

/**
 * Names the agent on every engine request (`x-jasper-agent`), so the approval card the engine shows for a
 * destructive operation says who is asking (security review AGT-3). URI-encoded: header values are Latin-1.
 */
function agentHeaders(name: () => string): () => Record<string, string> {
	return (): Record<string, string> => {
		const n = name().slice(0, 64);
		return n ? { [AGENT_NAME_HEADER]: encodeURIComponent(n) } : {};
	};
}

export interface EngineConnection {
	/** A client for the current engine (discovers / starts one if needed). */
	client(): Promise<EngineClient>;
	/** Where the engine was found (null before the first successful call). */
	readonly target: EngineTarget | null;
	/** Forget the current engine (next call re-discovers). */
	invalidate(): void;
	close(): Promise<void>;
	/** The name shown on approval cards for this connection's requests (set by the server once it knows its client). */
	agentName?: () => string;
	/** Where progress while waiting for the engine also goes (the server sets MCP logging notifications). */
	notify?: (message: string) => void;
}

/** A fixed engine (the engine's own `/mcp` endpoint talks to itself). */
export class FixedEngineLink implements EngineConnection {
	private readonly c: EngineClient;
	readonly target: EngineTarget;
	agentName?: () => string;
	constructor(url: string, token: string | null) {
		this.target = { url, token, source: 'explicit' };
		this.c = new EngineClient({
			baseUrl: url,
			token: token ?? undefined,
			fetch: guardedFetch(),
			requestHeaders: agentHeaders(() => this.agentName?.() ?? ''),
		});
	}
	async client(): Promise<EngineClient> {
		return this.c;
	}
	invalidate(): void {}
	async close(): Promise<void> {}
}

export class EngineLink implements EngineConnection {
	private current: { target: EngineTarget; client: EngineClient } | null = null;
	private pending: Promise<{ target: EngineTarget; client: EngineClient }> | null = null;
	private started: StartedEngine | null = null;
	private readonly log: (line: string) => void;
	agentName?: () => string;
	notify?: (message: string) => void;

	constructor(private readonly opts: LinkOptions = {}) {
		this.log = opts.log ?? ((l) => process.stderr.write(`[jasper-mcp] ${l}\n`));
	}

	get target(): EngineTarget | null {
		return this.current?.target ?? null;
	}

	invalidate(): void {
		this.current = null;
	}

	async client(): Promise<EngineClient> {
		if (this.current) return this.current.client;
		this.pending ??= this.connect().finally(() => {
			this.pending = null;
		});
		this.current = await this.pending;
		return this.current.client;
	}

	/** Progress while waiting: the log (stderr) and, through the server, MCP logging notifications. */
	private progress(message: string): void {
		this.log(message);
		this.notify?.(message);
	}

	private async connect(): Promise<{ target: EngineTarget; client: EngineClient }> {
		const now = this.opts.now ?? Date.now;
		const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const timeoutMs = this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		const t0 = now();
		let delay = STARTUP_POLL_FIRST_MS;
		let waitingFor: StartingEngine | null = null;
		let lastSecond = -1;
		let reasons: string[] = [];
		let target: EngineTarget | null = null;
		for (;;) {
			// The reasons nothing answered are logged on the first attempt only; later ones go to the final error.
			const first = waitingFor === null;
			reasons = [];
			const found = await findEngine({
				...this.opts,
				log: (l) => {
					reasons.push(l);
					if (first) this.log(l);
				},
			});
			target = found.target;
			if (target || !found.starting) break;
			const elapsed = now() - t0;
			if (elapsed >= timeoutMs)
				throw new ToolError(
					'ENGINE_NOT_READY',
					`The JasperEditor engine (pid ${found.starting.pid}, ${found.starting.file}) is still starting after ${Math.round(elapsed / 1000)} s.`,
					`Retry once it has started, or wait longer with --startup-timeout <seconds> (env ${ENV.ENGINE_STARTUP_TIMEOUT}).`,
				);
			if (!waitingFor || waitingFor.pid !== found.starting.pid)
				this.progress(
					`the engine (pid ${found.starting.pid}, ${found.starting.file}) is ${found.starting.phase === 'starting' ? 'starting' : 'warming up'}; waiting up to ${Math.round(timeoutMs / 1000)} s`,
				);
			else if (Math.floor(elapsed / 1000) > lastSecond)
				this.progress(`engine starting… ${Math.floor(elapsed / 1000)} s`);
			lastSecond = Math.floor(elapsed / 1000);
			waitingFor = found.starting;
			await sleep(Math.min(delay, Math.max(0, timeoutMs - elapsed)));
			delay = Math.min(delay * 2, STARTUP_POLL_MAX_MS);
		}
		if (target && waitingFor)
			this.progress(`engine ready on ${target.url} after ${Math.round((now() - t0) / 1000)} s`);
		if (!target && this.opts.startEngine) {
			if (this.started) {
				// Our own engine died: start a fresh one.
				await this.started.stop().catch(() => {});
				this.started = null;
			}
			const entry = this.opts.engineEntry ?? findEngineEntry(this.opts.env);
			if (!entry)
				throw new ToolError(
					'ENGINE_NOT_FOUND',
					'No JasperEditor engine is running and the engine bundle to start one was not found.',
					'Build it with `pnpm build` (apps/engine/dist/engine.mjs) or pass --engine-entry <path>.',
				);
			const appdir = this.opts.appdir ?? this.opts.env?.JASPER_APPDIR ?? platformDefaultAppdir(this.opts.env);
			this.progress(`starting a headless engine (${entry}, appdir ${appdir})`);
			this.started = await startHeadlessEngine({
				entry,
				appdir,
				port: this.opts.enginePort,
				env: this.opts.env,
				readyTimeoutMs: timeoutMs,
				log: this.log,
				progress: (ms) => this.progress(`engine starting… ${Math.floor(ms / 1000)} s`),
			});
			target = this.started;
			this.progress(`engine ready on ${target.url}`);
		}
		if (!target)
			throw new ToolError(
				'ENGINE_NOT_FOUND',
				'The JasperEditor engine is not running.',
				'Open the JasperEditor desktop app or run `pnpm dev` / `pnpm dev:engine`, or restart jasper-mcp with --start-engine to run a headless engine. ' +
					`Searched: ${reasons.join('; ') || 'nothing found'}.`,
			);
		return {
			target,
			client: new EngineClient({
				baseUrl: target.url,
				token: target.token ?? undefined,
				fetch: guardedFetch(this.opts.fetch, this.opts.requestTimeoutMs),
				requestHeaders: agentHeaders(() => this.agentName?.() ?? ''),
			}),
		};
	}

	async close(): Promise<void> {
		const s = this.started;
		this.started = null;
		await s?.stop().catch(() => {});
	}
}

/**
 * Runs `fn` with the engine client; a network failure (engine restarted on another port, desktop app
 * reopened) or a rejected token (the engine restarted on the same port: every start has a new token, dev engines
 * included) re-discovers once before giving up. A 401 means the request was not processed, so re-sending is safe.
 */
export async function withEngine<T>(link: EngineConnection, fn: (c: EngineClient) => Promise<T>): Promise<T> {
	const c = await link.client();
	try {
		return await fn(c);
	} catch (e) {
		if (!(e instanceof EngineError) || (e.code !== 'NETWORK' && e.code !== 'UNAUTHORIZED')) throw e;
		const before = link.target?.token ?? null;
		link.invalidate();
		const c2 = await link.client();
		if (c2 === c) throw e;
		// Same engine, same token: asking again would be refused again.
		if (e.code === 'UNAUTHORIZED' && (link.target?.token ?? null) === before) throw e;
		return fn(c2);
	}
}
