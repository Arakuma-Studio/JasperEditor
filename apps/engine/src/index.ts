// startEngine (ARCHITECTURE §9.1): builds the config, prepares the appdir, listens on 127.0.0.1.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appdirPaths, DEFAULT_ENGINE_HOST, DEV_WEB_PORT, ENV, isTruthyEnv } from '@jasper/config';
import { setInvariantMode } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { repairCacheLocation } from './cache/location.ts';
import { type EngineConfig, isLoopbackHost } from './context.ts';
import { type RuntimeFile, startRuntimeFile } from './runtime-file.ts';
import { createServer } from './server.ts';
import { ENGINE_VERSION } from './version.ts';

type StartEngineOptions = {
	appdir: string;
	port: number;
	host?: string;
	dev?: boolean;
	/** Default: `JASPER_LOCAL_TOKEN`, else a new random token (an engine that listens is never unauthenticated). */
	token?: string | null;
	/** Default: `JASPER_EDITOR_KEY`, else the dev key file (dev engines), else a new random key. */
	editorKey?: string | null;
	/**
	 * Listen without a token and without editor attestation: every local process is the user. For tests that
	 * exercise an engine over real sockets; `JASPER_INSECURE_DEV=1` does the same from the environment, with a
	 * warning. Ignored when a token is given.
	 */
	insecure?: boolean;
	webDir?: string | null;
	logger?: boolean;
	env?: Record<string, string | undefined>;
	/** The runtime file, already `starting` (cli.ts marks it before loading the engine); default: started here. */
	runtime?: RuntimeFile;
};

export type RunningEngine = {
	app: FastifyInstance;
	port: number;
	host: string;
	url: string;
	/** The Bearer token (null only for an insecure engine). */
	token: string | null;
	/**
	 * `<url>/pair?key=…` when this engine serves the web app and made its own editor key: opening it in a browser
	 * makes that browser the editor (it receives the HttpOnly session and editor cookies). null when whoever
	 * started the engine already holds the key (desktop shell, E2E harness, Vite dev server) or nothing is served.
	 */
	pairingUrl: string | null;
	stop(): Promise<void>;
};

const newSecret = (): string => randomBytes(32).toString('base64url');
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * Dev engines (`JASPER_DEV=1`) keep their editor key in `<appdir>/engine/editor-key.dev` (0600) and reuse it, so
 * the Vite dev server can hand it to the browser and a `tsx watch` restart does not sign the editor out. A dev
 * checkout is not a security boundary against a process that can read the user's files (it can edit the sources
 * too); packaged and headless engines never write the key anywhere.
 */
function devEditorKey(file: string): string {
	try {
		const cur = readFileSync(file, 'utf8').trim();
		if (SECRET_RE.test(cur)) return cur;
	} catch {
		// first start
	}
	const key = newSecret();
	try {
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	} catch (e) {
		console.warn(`[engine] could not write ${file}: ${(e as Error).message}`);
	}
	return key;
}

export function prepareAppdir(appdir: string): void {
	const p = appdirPaths(appdir);
	// M3 (wp-m3-cachegc, S04:CA-021): the cache folders may live elsewhere (links); finish an interrupted move first.
	repairCacheLocation(appdir, (m) => console.warn(m));
	for (const dir of [
		p.engineDir,
		p.logsDir,
		p.projectsDir,
		p.mediaDir,
		p.cacheDir,
		p.mgDir,
		p.rendersDir,
		p.tmpDir,
	])
		mkdirSync(dir, { recursive: true });
	// tmp/ is wiped on start (ARCHITECTURE §4.3); a committed .gitkeep (dev .stage) survives.
	for (const name of readdirSync(p.tmpDir)) {
		if (name !== '.gitkeep') rmSync(join(p.tmpDir, name), { recursive: true, force: true });
	}
}

export function engineConfig(opts: StartEngineOptions): EngineConfig {
	const env = opts.env ?? process.env;
	const dev = opts.dev ?? isTruthyEnv(env[ENV.DEV]);
	// A second dev stack (other worktree, E2E) runs Vite on another port: JASPER_DEV_WEB_PORT.
	const devWebPort = Number.parseInt(env[ENV.DEV_WEB_PORT] ?? '', 10) || DEV_WEB_PORT;
	const webDir = opts.webDir ?? env[ENV.WEB_DIR] ?? null;
	return {
		appdir: opts.appdir,
		paths: appdirPaths(opts.appdir),
		dev,
		token: opts.token ?? (env[ENV.LOCAL_TOKEN] || null),
		editorKey: opts.editorKey ?? (env[ENV.EDITOR_KEY] || null),
		host: opts.host ?? DEFAULT_ENGINE_HOST,
		port: opts.port,
		// @fastify/static only accepts an absolute root; `JASPER_WEB_DIR=apps/web/dist` is relative to the cwd.
		webDir: webDir ? resolve(webDir) : null,
		version: ENGINE_VERSION,
		extraHosts: dev ? [`127.0.0.1:${devWebPort}`, `localhost:${devWebPort}`] : [],
	};
}

export async function startEngine(opts: StartEngineOptions): Promise<RunningEngine> {
	const config = engineConfig(opts);
	// perf-core: dev engines check every transaction both incrementally and fully (they must agree).
	if (config.dev) setInvariantMode('verify');
	// M1 binds loopback only (ARCHITECTURE §4.2, S04:ENG-020). The Host check alone does not protect a
	// network-reachable engine (remote clients can send any Host header), so a non-loopback bind
	// without a token is refused until remote password mode lands (M2).
	if (!isLoopbackHost(config.host) && !config.token) {
		throw new Error(
			`Refusing to bind ${config.host} without ${ENV.LOCAL_TOKEN}: remote mode is M2 and the engine would be unauthenticated`,
		);
	}
	// The runtime file says "starting" before the slow part (cache repair, services, routes), so local tools started
	// meanwhile wait for this engine instead of reporting that none is running (runtime-file.ts).
	mkdirSync(config.paths.engineDir, { recursive: true });
	const runtime =
		opts.runtime ??
		(await startRuntimeFile(config.paths.runtimeFile, {
			host: config.host,
			port: opts.port,
			version: config.version,
			appdir: config.appdir,
		}));
	let app: FastifyInstance | null = null;
	let ownEditorKey = false;
	try {
		prepareAppdir(opts.appdir);
		// Security review DEV-1: an engine that listens always has a token. There is no unauthenticated mode short of
		// asking for one by name.
		const env = opts.env ?? process.env;
		if (!config.token) {
			if (opts.insecure || isTruthyEnv(env[ENV.INSECURE_DEV])) {
				config.editorKey = null;
				if (!opts.insecure) console.warn(INSECURE_WARNING);
			} else config.token = newSecret();
		}
		if (config.token && !config.editorKey) {
			config.editorKey = config.dev ? devEditorKey(config.paths.devEditorKeyFile) : newSecret();
			ownEditorKey = !config.dev;
		}
		app = await createServer(config, { logger: opts.logger, env: opts.env });
		await app.listen({ host: config.host, port: opts.port });
	} catch (e) {
		await app?.close().catch(() => {});
		await runtime.remove();
		throw e;
	}
	const addr = app.server.address();
	const port = typeof addr === 'object' && addr ? addr.port : opts.port;
	config.port = port;
	const url = `http://${config.host}:${port}`;
	await runtime.ready({
		url,
		host: config.host,
		port,
		token: config.token,
		version: config.version,
		appdir: config.appdir,
	});
	const running = app;
	return {
		app: running,
		port,
		host: config.host,
		url,
		token: config.token,
		pairingUrl:
			ownEditorKey && config.webDir && config.editorKey
				? `${url}/pair?key=${encodeURIComponent(config.editorKey)}`
				: null,
		stop: async () => {
			await runtime.remove();
			await running.close();
		},
	};
}

const INSECURE_WARNING = [
	'',
	'  ******************************************************************************',
	`  *  ${ENV.INSECURE_DEV} is set: THIS ENGINE HAS NO TOKEN.`,
	'  *  Every process on this machine, of every user, can read and write your files',
	'  *  through it, and agents can approve their own destructive requests.',
	'  *  Unset it unless you are debugging the authentication itself.',
	'  ******************************************************************************',
	'',
].join('\n');

export { createServer };
