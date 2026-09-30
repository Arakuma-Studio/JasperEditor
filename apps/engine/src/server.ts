// Fastify factory (ARCHITECTURE §9.1): error handler with the S04:ENG-022 shape, x-jasper-api header,
// auth + Host check (§4.2), /health, static SPA with a fallback that never shadows engine paths.

import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { API_HEADER, API_VERSION, AUTH_COOKIE, errorBody, isEnginePath } from '@jasper/api';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { EngineConfig, EngineContext } from './context.ts';
import { registerRoutes } from './routes/index.ts';
import { createCoreServices } from './tools/services.ts';

export const JSON_BODY_LIMIT = 20 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
	}
	return null;
}

export function allowedHosts(config: EngineConfig): Set<string> {
	const hosts = new Set<string>([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
	for (const h of config.extraHosts) hosts.add(h);
	return hosts;
}

export function isAllowedOrigin(origin: string, config: EngineConfig): boolean {
	try {
		const u = new URL(origin);
		return (
			(u.protocol === 'http:' || u.protocol === 'https:') && allowedHosts(config).has(u.host.toLowerCase())
		);
	} catch {
		return false; // includes the opaque "null" origin
	}
}

export function sendError(
	reply: FastifyReply,
	status: number,
	code: string,
	message: string,
	detail?: unknown,
) {
	return reply
		.code(status)
		.type('application/json')
		.send(errorBody(code, message, detail));
}

export async function createServer(
	config: EngineConfig,
	opts: { logger?: boolean; env?: Record<string, string | undefined>; totalSlots?: number } = {},
): Promise<FastifyInstance> {
	const app = Fastify({ logger: opts.logger ?? false, bodyLimit: JSON_BODY_LIMIT, trustProxy: false });
	const ctx: EngineContext = { config, services: {} };
	app.decorate('jasper', ctx);

	// Core services (WP-2F): jobs, events, media, projects, exports… Other packages reach them through
	// `coreServices(app)` (see docs/wp-notes/WP-2F.md).
	const core = await createCoreServices(config, {
		jsonBodyLimit: JSON_BODY_LIMIT,
		env: opts.env,
		totalSlots: opts.totalSlots,
		log: (m) => app.log.info(m),
	});
	Object.assign(ctx.services, {
		core,
		jobs: core.queue,
		broadcaster: core.broadcaster,
		mediaRegistry: core.registry,
		projects: core.projects,
		ffmpeg: core.ffmpeg,
	});
	app.addHook('onReady', async () => core.start());
	app.addHook('onClose', async () => core.stop());

	// Raw bodies for chunked uploads (streamed to disk by WP-2F).
	app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

	app.addHook('onSend', async (_req, reply, payload) => {
		reply.header(API_HEADER, String(API_VERSION));
		return payload;
	});

	// Auth (ARCHITECTURE §4.2, S04:ENG-020): Host check always; token/cookie when a token is configured.
	app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
		const host = (req.headers.host ?? '').toLowerCase();
		if (!allowedHosts(config).has(host)) {
			return sendError(reply, 403, 'FORBIDDEN_HOST', `Host "${host}" is not allowed`);
		}
		// Signed media/font/render URLs (S04:MS-003) serve the headless Remotion browser, which cannot
		// send the session cookie and fetches cross-origin from its own bundle server.
		if (core.signer.verify(req.url)) {
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
		// Same-origin only (S04:SC-001): browsers send Origin on cross-origin requests, including
		// "simple" no-cors POSTs that would otherwise reach the engine from any web page (CSRF).
		const origin = req.headers.origin;
		if (origin !== undefined && !isAllowedOrigin(origin, config)) {
			return sendError(reply, 403, 'FORBIDDEN_ORIGIN', `Origin "${origin}" is not allowed`);
		}
		if (!config.token) return;
		const path = req.url.split('?')[0]!;
		if (path === '/health') return;
		const auth = req.headers.authorization;
		const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
		const cookie = readCookie(req.headers.cookie, AUTH_COOKIE);
		if ((bearer && safeEqual(bearer, config.token)) || (cookie && safeEqual(cookie, config.token))) return;
		return sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid engine token');
	});

	app.setErrorHandler(
		(error: Error & { statusCode?: number; code?: string; validation?: unknown }, _req, reply) => {
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
			return sendError(
				reply,
				status,
				code,
				status >= 500 ? 'Internal engine error' : error.message,
				error.validation,
			);
		},
	);

	app.get('/health', async () => ({ ok: true as const, version: config.version, apiVersion: API_VERSION }));

	await registerRoutes(app);

	const indexHtml = config.webDir ? join(config.webDir, 'index.html') : null;
	if (config.webDir && indexHtml && existsSync(indexHtml)) {
		await app.register(fastifyStatic, {
			root: config.webDir,
			prefix: '/',
			wildcard: false,
			index: ['index.html'],
		});
	}
	app.setNotFoundHandler((req, reply) => {
		const path = req.url.split('?')[0]!;
		const wantsHtml = (req.headers.accept ?? '').includes('text/html') || !req.headers.accept;
		if (req.method === 'GET' && !isEnginePath(path) && indexHtml && existsSync(indexHtml) && wantsHtml) {
			return reply.type('text/html').sendFile('index.html');
		}
		return sendError(reply, 404, 'NOT_FOUND', `No route for ${req.method} ${path}`);
	});

	return app;
}
