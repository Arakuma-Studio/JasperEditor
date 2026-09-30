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

export async function startEngine(opts: StartEngineOptions): Promise<RunningEngine> {
	prepareAppdir(opts.appdir);
	const config = engineConfig(opts);
	const app = await createServer(config, { logger: opts.logger });
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

export type { EngineConfig, EngineContext } from './context.ts';
export { createServer } from './server.ts';
