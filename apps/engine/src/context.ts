// Engine configuration and service context shared by route plugins.
import type { AppdirPaths } from '@jasper/config';

export type EngineConfig = {
	appdir: string;
	paths: AppdirPaths;
	dev: boolean;
	/** Per-launch token (local token mode, ARCHITECTURE §4.2); null = no auth. */
	token: string | null;
	host: string;
	/** Actual listen port (known after listen; used by the Host check). */
	port: number;
	webDir: string | null;
	version: string;
	/** Extra accepted Host headers (dev: the Vite dev server origin). */
	extraHosts: string[];
};

export type EngineContext = {
	config: EngineConfig;
	/** Optional services registered by wave-2 packages (jobs, media registry, events, mg, agent…). */
	services: Record<string, unknown>;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}

declare module 'fastify' {
	interface FastifyInstance {
		jasper: EngineContext;
	}
}
