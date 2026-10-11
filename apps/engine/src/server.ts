// Fastify factory (ARCHITECTURE §9.1): error handler with the S04:ENG-022 shape, x-jasper-api header,
// auth + Host check (§4.2), /health, static SPA with a fallback that never shadows engine paths.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import {
	AGENT_INPUT_HEADER,
	API_HEADER,
	API_VERSION,
	AUTH_COOKIE,
	EDITOR_COOKIE,
	isEnginePath,
	portCookieName,
} from '@jasper/api';
import { loadExpressionEngine } from '@jasper/expressions';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createCoreAgentStore } from './agent/core-store.ts';
import { secretsEqual } from './auth/secrets.ts';
import {
	allowedHosts,
	type EngineConfig,
	type EngineContext,
	MG_SANDBOX_PREFIX,
	mgSandboxScope,
} from './context.ts';
import { registerRoutes } from './routes/index.ts';
import { fail, systemErrorReply } from './tools/reply.ts';
import { createCoreServices } from './tools/services.ts';

const JSON_BODY_LIMIT = 20 * 1024 * 1024;

function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
	}
	return null;
}

/** A secret presented as a cookie, under its plain or its per-port name (`portCookieName`). */
function cookieMatches(header: string | undefined, name: string, port: number, secret: string): boolean {
	for (const n of [portCookieName(name, port), name]) {
		let v: string | null = null;
		try {
			v = readCookie(header, n);
		} catch {
			v = null; // malformed percent-encoding
		}
		if (v && secretsEqual(v, secret)) return true;
	}
	return false;
}

/**
 * Security review AGT-2: is this request the editor window's (the user's) or an agent's? The editor proves itself
 * with the editor key, which jasper-mcp, the CLI and everything else that reads runtime.json never have; a request
 * the editor makes on behalf of an agent's live-UI input says so and counts as the agent's.
 */
export function isEditorRequest(
	headers: { cookie?: string | undefined; [name: string]: string | string[] | undefined },
	config: EngineConfig,
): boolean {
	if (headers[AGENT_INPUT_HEADER] !== undefined) return false;
	if (!config.editorKey) return true;
	return cookieMatches(headers.cookie, EDITOR_COOKIE, config.port, config.editorKey);
}

const PAIRED_PAGE =
	'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>JasperEditor</title><a href="/">Open JasperEditor</a>';
const UNPAIRED_PAGE =
	'<!doctype html><meta charset="utf-8"><title>JasperEditor</title><body style="font:14px system-ui;margin:3rem;max-width:40rem"><h1 style="font-size:18px">This browser is not signed in to the JasperEditor engine</h1><p>Open the link the engine printed when it started (<code>…/pair?key=…</code>), or use the JasperEditor desktop app. The link changes every time the engine starts.</p>';

function isAllowedOrigin(origin: string, config: EngineConfig): boolean {
	try {
		const u = new URL(origin);
		return (
			(u.protocol === 'http:' || u.protocol === 'https:') && allowedHosts(config).has(u.host.toLowerCase())
		);
	} catch {
		return false; // includes the opaque "null" origin
	}
}

export async function createServer(
	config: EngineConfig,
	opts: { logger?: boolean; env?: Record<string, string | undefined>; totalSlots?: number } = {},
): Promise<FastifyInstance> {
	// Snapshots, export sampling and queries must all see evaluated expressions.
	await loadExpressionEngine();
	const app = Fastify({ logger: opts.logger ?? false, bodyLimit: JSON_BODY_LIMIT, trustProxy: false });
	const ctx: EngineContext = { config, services: {} };
	app.decorate('jasper', ctx);
	app.decorateRequest('jasperEditor', false);

	const core = await createCoreServices(config, {
		jsonBodyLimit: JSON_BODY_LIMIT,
		env: opts.env,
		totalSlots: opts.totalSlots,
		log: (m) => app.log.info(m),
	});
	Object.assign(ctx.services, {
		core,
		broadcaster: core.broadcaster,
		events: core.broadcaster,
		// Headless agent writes go through the same store, mutex and leases as editor saves.
		agentStore: createCoreAgentStore(core.projects, core.leases),
	});
	app.addHook('onReady', async () => core.start());
	app.addHook('onClose', async () => core.stop());

	// Upload bodies are streamed to disk.
	app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

	app.addHook('onSend', async (_req, reply, payload) => {
		reply.header(API_HEADER, String(API_VERSION));
		return payload;
	});

	// Auth (ARCHITECTURE §4.2, S04:ENG-020): Host check always; token/cookie when a token is configured.
	app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
		const host = (req.headers.host ?? '').toLowerCase();
		if (!allowedHosts(config).has(host)) {
			return fail(reply, 403, 'FORBIDDEN_HOST', `Host "${host}" is not allowed`);
		}
		// Signed media/font/render URLs (S04:MS-003) serve the headless Remotion browser, which cannot
		// send the session cookie and fetches cross-origin from its own bundle server. Read-only methods only:
		// a signature never authorizes a state-changing request.
		const readOnly = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
		if (readOnly && core.signer.verify(req.url)) {
			reply.header('access-control-allow-origin', '*');
			reply.header('access-control-expose-headers', 'content-length, content-range, accept-ranges, etag');
			reply.header('cross-origin-resource-policy', 'cross-origin');
			if (req.method === 'OPTIONS') {
				return reply
					.code(204)
					.header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
					.header('access-control-allow-headers', 'range, if-range, if-none-match')
					.header('access-control-max-age', '600')
					.send();
			}
			return;
		}
		// Security review MG-1: the files of a motion-graphics bundle are requested by its sandboxed host page, whose
		// origin is opaque (`Origin: null`, no cookies). They are served under a capability path instead:
		// `/mg/sandbox/<capability>/<bundle key>/…`, read-only, readable from any origin (the capability is the
		// authorisation; the bytes are the bundle's own).
		if (req.url.startsWith(MG_SANDBOX_PREFIX)) {
			const [capability = '', key = ''] = req.url.slice(MG_SANDBOX_PREFIX.length).split('?')[0]!.split('/');
			let bundleKey = '';
			try {
				bundleKey = decodeURIComponent(key);
			} catch {
				bundleKey = '';
			}
			if (!readOnly || !bundleKey || !core.signer.verifyCapability(mgSandboxScope(bundleKey), capability))
				return fail(reply, 403, 'FORBIDDEN', 'Invalid bundle capability');
			reply.header('access-control-allow-origin', '*');
			reply.header('cross-origin-resource-policy', 'cross-origin');
			if (req.method === 'OPTIONS')
				return reply
					.code(204)
					.header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
					.header('access-control-allow-headers', 'range, if-range, if-none-match')
					.header('access-control-max-age', '600')
					.send();
			return;
		}
		// Same-origin only (S04:SC-001): browsers send Origin on cross-origin requests, including
		// "simple" no-cors POSTs that would otherwise reach the engine from any web page (CSRF).
		const origin = req.headers.origin;
		if (origin !== undefined && !isAllowedOrigin(origin, config)) {
			return fail(reply, 403, 'FORBIDDEN_ORIGIN', `Origin "${origin}" is not allowed`);
		}
		req.jasperEditor = isEditorRequest(req.headers, config);
		if (!config.token) return;
		const path = req.url.split('?')[0]!;
		// /pair authenticates with the editor key in its query (below).
		if (path === '/health' || path === '/pair') return;
		const auth = req.headers.authorization;
		const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
		if (
			(bearer && secretsEqual(bearer, config.token)) ||
			cookieMatches(req.headers.cookie, AUTH_COOKIE, config.port, config.token)
		)
			return;
		// A browser that opens the engine's address without having been paired gets an explanation, not JSON.
		if (
			req.method === 'GET' &&
			!isEnginePath(path) &&
			req.headers['sec-fetch-dest'] === 'document' &&
			(req.headers.accept ?? '').includes('text/html')
		)
			return reply.code(401).header('cache-control', 'no-store').type('text/html').send(UNPAIRED_PAGE);
		return fail(reply, 401, 'UNAUTHORIZED', 'Missing or invalid engine token');
	});

	app.setErrorHandler(
		(error: Error & { statusCode?: number; code?: string; validation?: unknown }, _req, reply) => {
			const sys = systemErrorReply(error);
			if (sys) {
				if (sys.status >= 500) app.log.error(error);
				return fail(reply, sys.status, sys.code, sys.message, sys.detail);
			}
			const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
			const code =
				status === 413
					? 'PAYLOAD_TOO_LARGE'
					: error.validation || status === 400
						? 'VALIDATION_FAILED'
						: status === 404
							? 'NOT_FOUND'
							: status === 415
								? 'BAD_REQUEST'
								: status >= 500
									? 'INTERNAL'
									: (error.code ?? 'BAD_REQUEST');
			if (status >= 500) app.log.error(error);
			return fail(
				reply,
				status,
				code,
				status >= 500 ? 'Internal engine error' : error.message,
				error.validation,
			);
		},
	);

	// Public. `runtimeFile` is where local tools find the token (jasper-mcp, the Vite dev server): the path is not a
	// secret, the file is readable by the engine's user only.
	app.get('/health', async () => ({
		ok: true as const,
		version: config.version,
		apiVersion: API_VERSION,
		runtimeFile: config.paths.runtimeFile,
	}));

	// Browser pairing (security review DEV-1 / AGT-2): an engine that serves the web app and was not started by
	// something that already holds the editor key (the desktop shell sets the cookies itself) prints
	// `<origin>/pair?key=<editor key>` on its terminal. Opening it makes that browser the editor: it gets the session
	// token and the editor key as HttpOnly, SameSite=Strict cookies, which page scripts and agents cannot read.
	app.get('/pair', async (req, reply) => {
		const key = (req.query as { key?: unknown } | undefined)?.key;
		if (!config.token || !config.editorKey || typeof key !== 'string' || !secretsEqual(key, config.editorKey))
			return fail(reply, 401, 'UNAUTHORIZED', 'Invalid pairing key');
		const cookie = (name: string, value: string) =>
			`${portCookieName(name, config.port)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
		return (
			reply
				.header('set-cookie', [cookie(AUTH_COOKIE, config.token), cookie(EDITOR_COOKIE, config.editorKey)])
				.header('cache-control', 'no-store')
				.header('referrer-policy', 'no-referrer')
				// Not a redirect: a navigation that started on another site would not carry SameSite=Strict cookies to
				// the redirect target; the page navigates by itself.
				.type('text/html')
				.send(PAIRED_PAGE)
		);
	});

	await registerRoutes(app);

	const indexHtml = config.webDir ? join(config.webDir, 'index.html') : null;
	if (config.webDir && indexHtml && existsSync(indexHtml)) {
		await app.register(fastifyStatic, {
			root: config.webDir,
			prefix: '/',
			// One wildcard route instead of a route per file found at startup: files of a web build made
			// while the engine runs (new hashed bundles) are served too. Misses fall through to the
			// not-found handler below (SPA fallback for HTML navigations, ENG-022 404 otherwise).
			wildcard: true,
			index: ['index.html'],
		});
	}
	app.setNotFoundHandler((req, reply) => {
		const path = req.url.split('?')[0]!;
		const wantsHtml = (req.headers.accept ?? '').includes('text/html') || !req.headers.accept;
		if (req.method === 'GET' && !isEnginePath(path) && indexHtml && existsSync(indexHtml) && wantsHtml) {
			return reply.type('text/html').sendFile('index.html');
		}
		return fail(reply, 404, 'NOT_FOUND', `No route for ${req.method} ${path}`);
	});

	return app;
}
