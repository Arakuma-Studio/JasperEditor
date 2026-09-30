// startEngine (ARCHITECTURE §9.1): builds the config, prepares the appdir, listens on 127.0.0.1.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appdirPaths, DEFAULT_ENGINE_HOST, DEV_WEB_PORT, ENV, isTruthyEnv } from '@jasper/config';
import type { FastifyInstance } from 'fastify';
import type { EngineConfig } from './context.ts';
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
	return {
		appdir: opts.appdir,
		paths: appdirPaths(opts.appdir),
		dev,
		token: opts.token ?? env[ENV.LOCAL_TOKEN] ?? null,
		host: opts.host ?? DEFAULT_ENGINE_HOST,
		port: opts.port,
		webDir: opts.webDir ?? env[ENV.WEB_DIR] ?? null,
		version: ENGINE_VERSION,
		extraHosts: dev ? [`127.0.0.1:${DEV_WEB_PORT}`, `localhost:${DEV_WEB_PORT}`] : [],
	};
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
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
	return {
		app,
		port,
		host: config.host,
		url: `http://${config.host}:${port}`,
		stop: () => app.close(),
	};
}

// ---------------------------------------------------------------- service interface for WP-2G / WP-2H
// (documented in docs/wp-notes/WP-2F.md)
export { UrlSigner } from './auth/signed-url.ts';
export type { EngineConfig, EngineContext } from './context.ts';
export { Broadcaster } from './events/broadcaster.ts';
export type { MgMasterProvider, MgMasterRequest } from './export/service.ts';
export { JobQueue } from './jobs/queue.ts';
export { type JobContext, JobError, type JobRunner, type JobSubmit } from './jobs/types.ts';
export { fingerprintFile, mediaKeyFor } from './media/fingerprint.ts';
export { type MediaRecord, MediaRegistry } from './media/registry.ts';
export { LeaseManager } from './projects/leases.ts';
export { ProjectError, ProjectStoreFs } from './projects/store.ts';
// Motion graphics (WP-2G). routes/mg.ts creates the service at startup as app.jasper.services.mg and
// registers its capability provider and native-export master hook with WP-2F's core services.
export { createMgService, type MgService, mgCapabilityProvider, mgMasterHook } from './mg/index.ts';
export { createServer } from './server.ts';
export type { CapabilityPatch, CapabilityProvider } from './tools/capabilities.ts';
export { Ffmpeg, type FfmpegProgress, resolveBinaries } from './tools/ffmpeg.ts';
export { runTool, spawnTool, ToolError, terminateTree } from './tools/process.ts';
export { type CoreServices, coreServices } from './tools/services.ts';
