// startEngine (ARCHITECTURE §9.1): builds the config, prepares the appdir, listens on 127.0.0.1.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	appdirPaths,
	DEFAULT_ENGINE_HOST,
	DEV_WEB_PORT,
	ENV,
	type EngineRuntimeInfo,
	isTruthyEnv,
	parseEngineRuntime,
} from '@jasper/config';
import type { FastifyInstance } from 'fastify';
import { repairCacheLocation } from './cache/location.ts';
import { type EngineConfig, isLoopbackHost } from './context.ts';
import { createServer } from './server.ts';
import { ENGINE_VERSION } from './version.ts';

export type StartEngineOptions = {
	appdir: string;
	port: number;
	host?: string;
	dev?: boolean;
	token?: string | null;
	webDir?: string | null;
	logger?: boolean;
	env?: Record<string, string | undefined>;
};

export type RunningEngine = {
	app: FastifyInstance;
	port: number;
	host: string;
	url: string;
	stop(): Promise<void>;
};

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
		token: opts.token ?? env[ENV.LOCAL_TOKEN] ?? null,
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
	// M1 binds loopback only (ARCHITECTURE §4.2, S04:ENG-020). The Host check alone does not protect a
	// network-reachable engine (remote clients can send any Host header), so a non-loopback bind
	// without a token is refused until remote password mode lands (M2).
	if (!isLoopbackHost(config.host) && !config.token) {
		throw new Error(
			`Refusing to bind ${config.host} without ${ENV.LOCAL_TOKEN}: remote mode is M2 and the engine would be unauthenticated`,
		);
	}
	prepareAppdir(opts.appdir);
	const app = await createServer(config, { logger: opts.logger, env: opts.env });
	await app.listen({ host: config.host, port: opts.port });
	const addr = app.server.address();
	const port = typeof addr === 'object' && addr ? addr.port : opts.port;
	config.port = port;
	const url = `http://${config.host}:${port}`;
	const runtimeFile = writeRuntimeFile(config, url);
	return {
		app,
		port,
		host: config.host,
		url,
		stop: async () => {
			removeRuntimeFile(runtimeFile);
			await app.close();
		},
	};
}

/**
 * `<appdir>/engine/runtime.json` (0600): lets local tools on the same machine (jasper-mcp, scripts) find
 * this engine's port and token (docs/wp-notes/wp-mcp.md). The appdir is the user's own data directory, so
 * the file is as private as the projects next to it. Failures are logged, never fatal.
 */
function writeRuntimeFile(config: EngineConfig, url: string): string | null {
	const file = config.paths.runtimeFile;
	const info: EngineRuntimeInfo = {
		url,
		host: config.host,
		port: config.port,
		pid: process.pid,
		token: config.token,
		version: config.version,
		appdir: config.appdir,
		startedAt: new Date().toISOString(),
	};
	try {
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
		return file;
	} catch (e) {
		console.warn(`[engine] could not write ${file}: ${(e as Error).message}`);
		return null;
	}
}

/** Removes the runtime file if it still describes this process (another engine may have replaced it). */
function removeRuntimeFile(file: string | null): void {
	if (!file) return;
	try {
		const cur = parseEngineRuntime(JSON.parse(readFileSync(file, 'utf8')));
		if (cur && cur.pid !== process.pid) return;
		rmSync(file, { force: true });
	} catch {
		// already gone
	}
}

// ---------------------------------------------------------------- service interface for WP-2G / WP-2H
// (documented in docs/wp-notes/WP-2F.md)
export { UrlSigner } from './auth/signed-url.ts';
export { type EngineConfig, type EngineContext, isLoopbackHost } from './context.ts';
export { Broadcaster } from './events/broadcaster.ts';
export type { MgMasterProvider, MgMasterRequest } from './export/service.ts';
export { JobQueue } from './jobs/queue.ts';
export { type JobContext, JobError, type JobRunner, type JobSubmit } from './jobs/types.ts';
export { fingerprintFile, mediaKeyFor } from './media/fingerprint.ts';
export { type MediaRecord, MediaRegistry } from './media/registry.ts';
// Motion graphics (WP-2G). routes/mg.ts creates the service at startup as app.jasper.services.mg and
// registers its capability provider and native-export master hook with WP-2F's core services.
export { createMgService, type MgService, mgCapabilityProvider, mgMasterHook } from './mg/index.ts';
export { LeaseManager } from './projects/leases.ts';
export { ProjectError, ProjectStoreFs } from './projects/store.ts';
export { createServer } from './server.ts';
export type { CapabilityPatch, CapabilityProvider } from './tools/capabilities.ts';
export { Ffmpeg, type FfmpegProgress, resolveBinaries } from './tools/ffmpeg.ts';
export { runTool, spawnTool, ToolError, terminateTree } from './tools/process.ts';
export { type CoreServices, coreServices } from './tools/services.ts';
