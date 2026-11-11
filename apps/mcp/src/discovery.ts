// Finds a running JasperEditor engine for jasper-mcp (docs/wp-notes/wp-mcp.md):
//   1. explicit `--engine-url` / `--token`, else JASPER_ENGINE_URL / JASPER_ENGINE_TOKEN
//   2. `<appdir>/engine/runtime.json` written by a running engine, for `--appdir`, JASPER_APPDIR, the
//      platform default appdir and the desktop app's appdir (`<Electron userData>/jasper`)
//   3. the default dev engine on http://127.0.0.1:47900 (its token: from the runtime file its /health names)
// and, with `--start-engine`, forks a headless engine (random port, per-launch token) when none answers.
// A runtime file in the `starting` state (live pid, fresh heartbeat), or one that turned `ready` moments ago but
// does not answer yet, is reported as a starting engine: link.ts waits for it with backoff instead of failing.
// Everything here logs to stderr only: stdout belongs to the MCP stdio transport.
import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	appdirPaths,
	DEFAULT_ENGINE_HOST,
	DEFAULT_ENGINE_PORT,
	desktopAppdir,
	ENGINE_HEARTBEAT_STALE_MS,
	ENGINE_WARMUP_MS,
	ENV,
	EngineReadyMessageSchema,
	type EngineRuntimeInfo,
	type EngineRuntimeState,
	type Env,
	parseEngineRuntime,
	parseEngineRuntimeState,
	platformDefaultAppdir,
} from '@jasper/config';
import { ToolError } from './errors.ts';

export type EngineTarget = {
	url: string;
	token: string | null;
	/** How it was found: `explicit`, `runtime-file`, `default-port` or `started`. */
	source: 'explicit' | 'runtime-file' | 'default-port' | 'started';
	/** The runtime file it came from (runtime-file) or the appdir of a started engine. */
	detail?: string;
	version?: string;
};

export type DiscoveryOptions = {
	url?: string;
	token?: string;
	/** Extra appdir searched first (`--appdir`). */
	appdir?: string;
	env?: Env;
	fetch?: typeof fetch;
	healthTimeoutMs?: number;
	log?(line: string): void;
	/** Clock for heartbeat ages (default Date.now). */
	now?: () => number;
	/** Whether a process exists (default: signal 0). */
	pidAlive?: (pid: number) => boolean;
};

/** An engine whose runtime file says it is on its way: worth waiting for. */
export type StartingEngine = {
	pid: number;
	/** The runtime file. */
	file: string;
	/** `starting`: not listening yet; `warming`: listening moments ago, not answering yet. */
	phase: 'starting' | 'warming';
};

export type Discovery = { target: EngineTarget | null; starting: StartingEngine | null };

type HealthResult = { ok: true; version: string; runtimeFile: string | null } | { ok: false; reason: string };

/** GET /health with a short timeout (the route is public even in token mode). */
async function probeHealth(
	url: string,
	opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<HealthResult> {
	const f = opts.fetch ?? globalThis.fetch;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
	try {
		const res = await f(`${url.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
		if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
		const body = (await res.json()) as { ok?: unknown; version?: unknown; runtimeFile?: unknown };
		if (body?.ok !== true) return { ok: false, reason: 'not a JasperEditor engine' };
		return {
			ok: true,
			version: typeof body.version === 'string' ? body.version : 'unknown',
			runtimeFile: typeof body.runtimeFile === 'string' ? body.runtimeFile : null,
		};
	} catch (e) {
		return {
			ok: false,
			reason: e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e),
		};
	} finally {
		clearTimeout(timer);
	}
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Appdirs whose runtime file is checked, most specific first (deduplicated). */
function candidateAppdirs(opts: Pick<DiscoveryOptions, 'appdir' | 'env'> = {}): string[] {
	const env = opts.env ?? process.env;
	const out: string[] = [];
	for (const dir of [opts.appdir, env[ENV.APPDIR], platformDefaultAppdir(env), desktopAppdir(env)]) {
		if (!dir) continue;
		const abs = resolve(dir);
		if (!out.includes(abs)) out.push(abs);
	}
	return out;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function readRuntime(file: string): EngineRuntimeInfo | null {
	return parseEngineRuntime(readJson(file));
}

function readRuntimeState(file: string): EngineRuntimeState | null {
	return parseEngineRuntimeState(readJson(file));
}

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;

/**
 * Whether a live engine's runtime file promises an answer soon: `starting` with a fresh heartbeat, or `ready`
 * within ENGINE_WARMUP_MS. A heartbeat older than ENGINE_HEARTBEAT_STALE_MS means a hung start (logged, not waited for).
 */
function startingFrom(
	info: EngineRuntimeState,
	file: string,
	now: number,
	log: (line: string) => void,
): StartingEngine | null {
	if (info.state === 'starting') {
		const age = now - info.heartbeatAt;
		if (age > ENGINE_HEARTBEAT_STALE_MS) {
			log(
				`the engine in ${file} (pid ${info.pid}) stopped starting (no heartbeat for ${seconds(age)}): stop that process and start the engine again`,
			);
			return null;
		}
		return { pid: info.pid, file, phase: 'starting' };
	}
	if (info.readyAt !== undefined && now - info.readyAt <= ENGINE_WARMUP_MS)
		return { pid: info.pid, file, phase: 'warming' };
	return null;
}

/**
 * The token of an engine found by its address (an explicit URL without a token, or the default dev port). Every
 * engine has one (docs/security-review.md DEV-1) and says in its public `/health` where its runtime file is; the
 * file is readable by the engine's user only, so reading it is the authorisation. Null when the file is not ours
 * to read or describes another engine.
 */
function tokenFromRuntimeFile(
	url: string,
	runtimeFile: string | null,
	pidAlive: (pid: number) => boolean,
): { token: string; file: string } | null {
	if (!runtimeFile || !isAbsolute(runtimeFile)) return null;
	const info = readRuntime(runtimeFile);
	if (!info?.token) return null;
	let port = '';
	try {
		port = new URL(url).port;
	} catch {
		return null;
	}
	return String(info.port) === port && pidAlive(info.pid) ? { token: info.token, file: runtimeFile } : null;
}

/** Finds a reachable engine, or null (the reasons are passed to `log`). */
export async function discoverEngine(opts: DiscoveryOptions = {}): Promise<EngineTarget | null> {
	return (await findEngine(opts)).target;
}

/**
 * Finds a reachable engine; when there is none, also reports the first engine that is still starting (see
 * `startingFrom`), so the caller can wait for it. The reasons nothing answered are passed to `log`.
 */
export async function findEngine(opts: DiscoveryOptions = {}): Promise<Discovery> {
	const env = opts.env ?? process.env;
	const log = opts.log ?? (() => {});
	const now = opts.now ?? Date.now;
	const pidAlive = opts.pidAlive ?? defaultPidAlive;
	const probe = (url: string) => probeHealth(url, { fetch: opts.fetch, timeoutMs: opts.healthTimeoutMs });

	const url = opts.url ?? env[ENV.ENGINE_URL];
	const token = opts.token ?? env[ENV.ENGINE_TOKEN] ?? null;
	if (url) {
		const h = await probe(url);
		let starting: StartingEngine | null = null;
		if (!h.ok) {
			log(`engine at ${url} (explicit) is not answering: ${h.reason}`);
			starting = startingOnPort(url, candidateAppdirs(opts), now(), pidAlive, log);
		}
		const found = !token && h.ok ? tokenFromRuntimeFile(url, h.runtimeFile, pidAlive) : null;
		// Explicit targets are used even when down: the error then names the configured URL.
		const target: EngineTarget = {
			url: url.replace(/\/$/, ''),
			token: token || found?.token || null,
			source: 'explicit',
			...(found ? { detail: found.file } : {}),
			...(h.ok ? { version: h.version } : {}),
		};
		return starting ? { target: null, starting } : { target, starting: null };
	}

	let starting: StartingEngine | null = null;
	for (const dir of candidateAppdirs(opts)) {
		const file = appdirPaths(dir).runtimeFile;
		const info = readRuntimeState(file);
		if (!info) continue;
		if (!pidAlive(info.pid)) {
			log(`stale runtime file in ${dir} (pid ${info.pid} is gone)`);
			continue;
		}
		if (info.state === 'starting') {
			starting ??= startingFrom(info, file, now(), log);
			continue;
		}
		const h = await probe(info.url);
		if (!h.ok) {
			log(`engine from ${dir} (${info.url}) is not answering: ${h.reason}`);
			starting ??= startingFrom(info, file, now(), log);
			continue;
		}
		return {
			target: {
				url: info.url,
				token: token || info.token,
				source: 'runtime-file',
				detail: file,
				version: h.version,
			},
			starting: null,
		};
	}

	const def = `http://${DEFAULT_ENGINE_HOST}:${DEFAULT_ENGINE_PORT}`;
	const h = await probe(def);
	if (h.ok) {
		const found = token ? null : tokenFromRuntimeFile(def, h.runtimeFile, pidAlive);
		return {
			target: {
				url: def,
				token: token || found?.token || null,
				source: 'default-port',
				...(found ? { detail: found.file } : {}),
				version: h.version,
			},
			starting: null,
		};
	}
	log(`no engine on the default port ${DEFAULT_ENGINE_PORT}: ${h.reason}`);
	return { target: null, starting };
}

/** A starting engine whose runtime file names the port of an explicit URL that does not answer yet. */
function startingOnPort(
	url: string,
	dirs: string[],
	now: number,
	pidAlive: (pid: number) => boolean,
	log: (line: string) => void,
): StartingEngine | null {
	let port: number;
	try {
		port = Number(new URL(url).port);
	} catch {
		return null;
	}
	for (const dir of dirs) {
		const file = appdirPaths(dir).runtimeFile;
		const info = readRuntimeState(file);
		if (!info || info.port !== port || !pidAlive(info.pid)) continue;
		const s = startingFrom(info, file, now, log);
		if (s) return s;
	}
	return null;
}

/**
 * The engine bundle next to this server: `apps/engine/dist/engine.mjs` in a checkout (from `apps/mcp/dist`
 * or `apps/mcp/src`), `resources/engine/engine.mjs` in a packaged desktop app (from `resources/mcp`).
 */
export function findEngineEntry(
	env: Env = process.env,
	here = dirname(fileURLToPath(import.meta.url)),
): string | null {
	const explicit = env[ENV.ENGINE_ENTRY];
	if (explicit) return existsSync(explicit) ? resolve(explicit) : null;
	for (const c of [join(here, '../../engine/dist/engine.mjs'), join(here, '../engine/engine.mjs')])
		if (existsSync(c)) return resolve(c);
	return null;
}

export type StartedEngine = EngineTarget & { child: ChildProcess; stop(): Promise<void> };

/** Lines of the started engine's output kept for the error when it exits before it is ready. */
const OUTPUT_TAIL_LINES = 20;
const OUTPUT_LINE_MAX = 500;

/**
 * Forks a headless engine (`--port 0`, per-launch JASPER_LOCAL_TOKEN) on `appdir` and resolves when it
 * reports ready (it listens and has checked its tools). `progress` is called once a second meanwhile. An engine
 * that exits first rejects with its exit code and the end of its output; one that is not ready within
 * `readyTimeoutMs` is stopped. It lives as long as this process (stopped on exit).
 */
export function startHeadlessEngine(opts: {
	entry: string;
	appdir: string;
	/** Listen port (default 0 = random). */
	port?: number;
	env?: Env;
	readyTimeoutMs?: number;
	log?(line: string): void;
	progress?(elapsedMs: number): void;
}): Promise<StartedEngine> {
	const log = opts.log ?? ((l: string) => process.stderr.write(`[jasper-mcp] ${l}\n`));
	const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
	const token = randomBytes(24).toString('base64url');
	mkdirSync(opts.appdir, { recursive: true });
	const child = fork(opts.entry, ['--port', String(opts.port ?? 0), '--appdir', opts.appdir], {
		env: {
			...(opts.env ?? process.env),
			[ENV.LOCAL_TOKEN]: token,
			[ENV.APPDIR]: opts.appdir,
			[ENV.DEV]: '',
		},
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});
	// Engine output goes to our stderr: stdout is the MCP channel.
	const tail: string[] = [];
	const pipe = (s: NodeJS.ReadableStream | null) =>
		s?.on('data', (d: Buffer) => {
			for (const line of d.toString('utf8').split('\n')) {
				if (!line.trim()) continue;
				log(`engine: ${line}`);
				tail.push(line.length > OUTPUT_LINE_MAX ? `${line.slice(0, OUTPUT_LINE_MAX)}…` : line);
				if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
			}
		});
	pipe(child.stdout);
	pipe(child.stderr);
	const exited = new Promise<void>((r) => child.once('exit', () => r()));
	const stop = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	};
	const startedAt = Date.now();
	return new Promise((resolvePromise, reject) => {
		const ticker = setInterval(() => opts.progress?.(Date.now() - startedAt), 1000);
		ticker.unref?.();
		const settle = () => {
			clearTimeout(timer);
			clearInterval(ticker);
		};
		const timer = setTimeout(() => {
			settle();
			void stop();
			reject(
				new ToolError(
					'ENGINE_START_FAILED',
					`The headless engine (${opts.entry}) did not report ready within ${seconds(readyTimeoutMs)}; it was stopped.`,
					`Allow it longer with --startup-timeout <seconds> (env ${ENV.ENGINE_STARTUP_TIMEOUT}).`,
				),
			);
		}, readyTimeoutMs);
		child.on('message', (m: unknown) => {
			const msg = EngineReadyMessageSchema.safeParse(m);
			if (!msg.success) return;
			settle();
			resolvePromise({
				url: `http://${DEFAULT_ENGINE_HOST}:${msg.data.port}`,
				token,
				source: 'started',
				detail: opts.appdir,
				child,
				stop,
			});
		});
		child.once('error', (error) => {
			settle();
			reject(error);
		});
		child.once('exit', (code, signal) => {
			settle();
			const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
			reject(
				new ToolError(
					'ENGINE_START_FAILED',
					`The headless engine ${how} before it was ready.${tail.length ? ` Its last output:\n${tail.join('\n')}` : ''}`,
					`Fix what it reported, then retry; \`node ${opts.entry} --appdir ${opts.appdir}\` shows its full output.`,
					{ exitCode: code, signal, output: [...tail] },
				),
			);
		});
	});
}
