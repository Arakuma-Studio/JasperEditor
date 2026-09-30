// The MCP server's connection to the engine: discovered lazily on the first tool call (so the server
// starts and lists its tools even when the editor is closed), re-discovered after network failures, and
// optionally backed by an engine this process started (`--start-engine`).
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
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

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
export function guardedFetch(
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

export type LinkOptions = DiscoveryOptions & {
	/** Fork a headless engine when none is reachable. */
	startEngine?: boolean;
	/** Engine bundle for `startEngine` (default: next to this server, or JASPER_ENGINE_ENTRY). */
	engineEntry?: string;
	/** Port for `startEngine` (default 0 = random). */
	enginePort?: number;
	/** Deadline per engine request (default DEFAULT_REQUEST_TIMEOUT_MS). */
	requestTimeoutMs?: number;
};

export interface EngineConnection {
	/** A client for the current engine (discovers / starts one if needed). */
	client(): Promise<EngineClient>;
	/** Where the engine was found (null before the first successful call). */
	readonly target: EngineTarget | null;
	/** Forget the current engine (next call re-discovers). */
	invalidate(): void;
	close(): Promise<void>;
}

/** A fixed engine (the engine's own `/mcp` endpoint talks to itself). */
export class FixedEngineLink implements EngineConnection {
	private readonly c: EngineClient;
	readonly target: EngineTarget;
	constructor(url: string, token: string | null, fetchImpl?: typeof fetch, requestTimeoutMs?: number) {
		this.target = { url, token, source: 'explicit' };
		this.c = new EngineClient({
			baseUrl: url,
			token: token ?? undefined,
			fetch: guardedFetch(fetchImpl, requestTimeoutMs),
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
 * reopened) re-discovers once before giving up.
 */
export async function withEngine<T>(link: EngineConnection, fn: (c: EngineClient) => Promise<T>): Promise<T> {
	const c = await link.client();
	try {
		return await fn(c);
	} catch (e) {
		if (!(e instanceof EngineError) || e.code !== 'NETWORK') throw e;
		link.invalidate();
		const c2 = await link.client();
		if (c2 === c) throw e;
		return fn(c2);
	}
}
