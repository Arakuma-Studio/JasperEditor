// Finds a running JasperEditor engine for jasper-mcp (docs/wp-notes/wp-mcp.md):
//   1. explicit `--engine-url` / `--token`, else JASPER_ENGINE_URL / JASPER_ENGINE_TOKEN
//   2. `<appdir>/engine/runtime.json` written by a running engine, for `--appdir`, JASPER_APPDIR, the
//      platform default appdir and the desktop app's appdir (`<Electron userData>/jasper`)
//   3. the default dev engine on http://127.0.0.1:47900
// and, with `--start-engine`, forks a headless engine (random port, per-launch token) when none answers.
// Everything here logs to stderr only: stdout belongs to the MCP stdio transport.
import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	appdirPaths,
	DEFAULT_ENGINE_HOST,
	DEFAULT_ENGINE_PORT,
	desktopAppdir,
	ENV,
	type EngineRuntimeInfo,
	type Env,
	parseEngineRuntime,
	platformDefaultAppdir,
} from '@jasper/config';

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
};

type HealthResult = { ok: true; version: string } | { ok: false; reason: string };

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
		const body = (await res.json()) as { ok?: unknown; version?: unknown };
		if (body?.ok !== true) return { ok: false, reason: 'not a JasperEditor engine' };
		return { ok: true, version: typeof body.version === 'string' ? body.version : 'unknown' };
	} catch (e) {
		return { ok: false, reason: (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message };
	} finally {
		clearTimeout(timer);
	}
}

function pidAlive(pid: number): boolean {
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

function readRuntimeFile(appdir: string): EngineRuntimeInfo | null {
	const file = appdirPaths(appdir).runtimeFile;
	try {
		return parseEngineRuntime(JSON.parse(readFileSync(file, 'utf8')));
	} catch {
		return null;
	}
}

/** Finds a reachable engine, or null (the reasons are passed to `log`). */
export async function discoverEngine(opts: DiscoveryOptions = {}): Promise<EngineTarget | null> {
	const env = opts.env ?? process.env;
	const log = opts.log ?? (() => {});
	const probe = (url: string) => probeHealth(url, { fetch: opts.fetch, timeoutMs: opts.healthTimeoutMs });

	const url = opts.url ?? env[ENV.ENGINE_URL];
	const token = opts.token ?? env[ENV.ENGINE_TOKEN] ?? null;
	if (url) {
		const h = await probe(url);
		if (!h.ok) log(`engine at ${url} (explicit) is not answering: ${h.reason}`);
		// Explicit targets are used even when down: the error then names the configured URL.
		return {
			url: url.replace(/\/$/, ''),
			token: token || null,
			source: 'explicit',
			...(h.ok ? { version: h.version } : {}),
		};
	}

	for (const dir of candidateAppdirs(opts)) {
		const info = readRuntimeFile(dir);
		if (!info) continue;
		if (!pidAlive(info.pid)) {
			log(`stale runtime file in ${dir} (pid ${info.pid} is gone)`);
			continue;
		}
		const h = await probe(info.url);
		if (!h.ok) {
			log(`engine from ${dir} (${info.url}) is not answering: ${h.reason}`);
			continue;
		}
		return {
			url: info.url,
			token: token || info.token,
			source: 'runtime-file',
			detail: appdirPaths(dir).runtimeFile,
			version: h.version,
		};
	}

	const def = `http://${DEFAULT_ENGINE_HOST}:${DEFAULT_ENGINE_PORT}`;
	const h = await probe(def);
	if (h.ok) return { url: def, token: token || null, source: 'default-port', version: h.version };
	log(`no engine on the default port ${DEFAULT_ENGINE_PORT}: ${h.reason}`);
	return null;
}

// ---------------------------------------------------------------- auto-start (`--start-engine`)

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

/**
 * Forks a headless engine (`--port 0`, per-launch JASPER_LOCAL_TOKEN) on `appdir` and resolves when it
 * reports ready. It lives as long as this process (stopped on exit).
 */
export function startHeadlessEngine(opts: {
	entry: string;
	appdir: string;
	/** Listen port (default 0 = random). */
	port?: number;
	env?: Env;
	readyTimeoutMs?: number;
	log?(line: string): void;
}): Promise<StartedEngine> {
	const log = opts.log ?? ((l: string) => process.stderr.write(`[jasper-mcp] ${l}\n`));
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
	const pipe = (s: NodeJS.ReadableStream | null) =>
		s?.on('data', (d: Buffer) => {
			for (const line of d.toString('utf8').split('\n')) if (line.trim()) log(`engine: ${line}`);
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
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			void stop();
			reject(new Error(`the engine did not report ready within ${opts.readyTimeoutMs ?? 60_000} ms`));
		}, opts.readyTimeoutMs ?? 60_000);
		child.on('message', (m: unknown) => {
			const msg = m as { type?: string; port?: number };
			if (msg?.type !== 'ready' || typeof msg.port !== 'number') return;
			clearTimeout(timer);
			resolvePromise({
				url: `http://${DEFAULT_ENGINE_HOST}:${msg.port}`,
				token,
				source: 'started',
				detail: opts.appdir,
				child,
				stop,
			});
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`the engine exited with code ${code} before it was ready`));
		});
	});
}
