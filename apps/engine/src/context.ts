// Engine configuration and service context shared by route plugins.
import type { AppdirPaths } from '@jasper/config';

export type EngineConfig = {
	appdir: string;
	paths: AppdirPaths;
	dev: boolean;
	/**
	 * Per-launch token (ARCHITECTURE §4.2). An engine that listens always has one (`startEngine` makes it); null =
	 * no auth, which only exists for in-process servers (tests) and `JASPER_INSECURE_DEV=1`.
	 */
	token: string | null;
	/**
	 * The editor key (security review AGT-2): requests and `/agent` connections that carry it come from the editor
	 * window; everything else that holds the token is an agent (jasper-mcp, the CLI, `/mcp`, scripts) and needs the
	 * user's approval for destructive operations and can never answer an approval. null = no attestation: every
	 * authenticated client counts as the editor (in-process servers and `JASPER_INSECURE_DEV=1` only).
	 */
	editorKey: string | null;
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

/** The `Host` values (and so the origins) the engine answers to: its own loopback names, plus the dev web server's. */
export function allowedHosts(config: EngineConfig): Set<string> {
	const hosts = new Set<string>([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
	for (const h of config.extraHosts) hosts.add(h);
	return hosts;
}

/** Path prefix of the capability-addressed bundle files (security review MG-1; routes/mg-bundles.ts serves them). */
export const MG_SANDBOX_PREFIX = '/mg/sandbox/';
/** What a bundle's capability is made for (`UrlSigner.capability`). */
export const mgSandboxScope = (bundleKey: string): string => `mg-bundle:${bundleKey}`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}

declare module 'fastify' {
	interface FastifyInstance {
		jasper: EngineContext;
	}
	interface FastifyRequest {
		/** True when the request comes from the editor window itself (the user), false for agents. Set by the auth hook. */
		jasperEditor: boolean;
	}
}
