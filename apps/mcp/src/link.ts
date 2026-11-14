// The MCP server's connection to the engine: discovered lazily on the first tool call (so the server
// starts and lists its tools even when the editor is closed), re-discovered after network failures, and
// optionally backed by an engine this process started (`--start-engine`).
import { AGENT_NAME_HEADER } from '@jasper/api';
import { platformDefaultAppdir } from '@jasper/config';
import { EngineClient, EngineError } from '@jasper/engine-client';
import {
	type DiscoveryOptions,
	discoverEngine,
	type EngineTarget,
	findEngineEntry,
	type StartedEngine,
	startHeadlessEngine,
} from './discovery.ts';
import { ToolError } from './errors.ts';

/** No engine request may hang a tool call: the longest legitimate wait is a 60 s approval. */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

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

/** Error codes of a request the engine accepted but did not answer in time (Node's fetch gives up after 300 s). */
const NO_ANSWER = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

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
			// the engine took the request and went quiet (busy or paused): no other engine may be asked instead
			if (code && NO_ANSWER.has(code) && !init?.signal?.aborted)
				throw new EngineRequestAborted(
					'timeout',
					'The engine accepted the request but did not answer in time',
				);
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

	private async connect(): Promise<{ target: EngineTarget; client: EngineClient }> {
		const reasons: string[] = [];
		let target = await discoverEngine({
			...this.opts,
			log: (l) => {
				reasons.push(l);
				this.log(l);
			},
		});
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
			this.log(`starting a headless engine (${entry}, appdir ${appdir})`);
			this.started = await startHeadlessEngine({
				entry,
				appdir,
				port: this.opts.enginePort,
				env: this.opts.env,
				log: this.log,
			});
			target = this.started;
			this.log(`engine ready on ${target.url}`);
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
 * The retry goes only to the same engine (its runtime file or address): another engine found instead has other
 * jobs and projects (a job id asked there is "unknown" while it still runs), so the failure is reported and the
 * next call uses the new engine.
 */
export async function withEngine<T>(link: EngineConnection, fn: (c: EngineClient) => Promise<T>): Promise<T> {
	const c = await link.client();
	try {
		return await fn(c);
	} catch (e) {
		if (!(e instanceof EngineError) || (e.code !== 'NETWORK' && e.code !== 'UNAUTHORIZED')) throw e;
		const before = link.target?.token ?? null;
		const was = link.target;
		link.invalidate();
		const c2 = await link.client();
		if (c2 === c) throw e;
		const now = link.target;
		if (was && now && (was.detail ?? was.url) !== (now.detail ?? now.url)) throw e;
		// Same engine, same token: asking again would be refused again.
		if (e.code === 'UNAUTHORIZED' && (link.target?.token ?? null) === before) throw e;
		return fn(c2);
	}
}
