// Motion graphics routes (ARCHITECTURE §9.2, S04 §15). Owner: WP-2G.
//   GET  /api/motion-graphics/templates  catalog with JSON Schemas (native when jasper-mg is ready)
//   POST /api/motion-graphics/render     {spec, quality} → EngineJob (mg-render); `?wait=1` answers when done
//   GET  /mg/:key/:file                  cached master.mov / preview.webm / poster.png, with Range
import { createReadStream, statSync } from 'node:fs';
import { MgRenderRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import {
	createMgService,
	MG_SERVICE_KEY,
	MgRenderError,
	type MgService,
	mgCapabilityProvider,
	mgMasterHook,
} from '../mg/index.ts';
import { sendError } from '../server.ts';
import type { CoreServices } from '../tools/services.ts';

const CONTENT_TYPES: Record<string, string> = {
	'master.mov': 'video/quicktime',
	'preview.webm': 'video/webm',
	'poster.png': 'image/png',
};

type EventSink = { publish?: (type: string, payload: unknown, projectId?: string) => void };

/** Returns the engine's MG service, creating and probing it on first use. */
export async function ensureMgService(app: FastifyInstance): Promise<MgService> {
	const services = app.jasper.services;
	const existing = services[MG_SERVICE_KEY] as MgService | undefined;
	if (existing) return existing;
	const core0 = services.core as CoreServices | undefined;
	const service = createMgService({
		mgDir: app.jasper.config.paths.mgDir,
		...(core0 ? { tools: core0.ffmpeg.bins } : {}),
		// Forwards job events to the engine broadcaster when WP-2F registers one as services.events.
		emit: (type, job) => (services.events as EventSink | undefined)?.publish?.(type, job, job.projectId),
	});
	services[MG_SERVICE_KEY] = service;
	// Graceful shutdown (S04:ENG-004): kill jasper-mg/ffmpeg children and remove their temp dirs.
	app.addHook('onClose', async () => {
		await service.shutdown();
	});
	await service.refresh();
	// WP-2F hooks: `render.fframes` in GET /api/capabilities and MG masters for native exports.
	const core = services.core as CoreServices | undefined;
	if (core) {
		core.registerCapabilityProvider(mgCapabilityProvider(service));
		core.registerMgMasterProvider(mgMasterHook(service));
	}
	const cap = service.capability();
	app.log.info(`[mg] fframes ${cap.fframes}${cap.fframesReason ? `: ${cap.fframesReason}` : ''}`);
	return service;
}

function parseRange(header: string, size: number): { start: number; end: number } | null | 'invalid' {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
	let start: number;
	let end: number;
	if (m[1] === '') {
		const suffix = Number(m[2]);
		if (suffix === 0) return 'invalid';
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	}
	if (start > end || start >= size) return 'invalid';
	return { start, end };
}

export default async function mgRoutes(app: FastifyInstance): Promise<void> {
	const service = await ensureMgService(app);

	app.get('/api/motion-graphics/templates', async () => service.templates());

	app.post('/api/motion-graphics/render', async (req, reply) => {
		const parsed = MgRenderRequestSchema.safeParse(req.body);
		if (!parsed.success)
			return sendError(
				reply,
				400,
				'VALIDATION_FAILED',
				'Invalid motion-graphics render request',
				parsed.error.issues,
			);
		if (service.capability().fframes !== 'ready')
			return sendError(
				reply,
				503,
				'MG_UNAVAILABLE',
				`fframes renderer unavailable: ${service.capability().fframesReason ?? 'unknown reason'}`,
			);
		try {
			const { job, done } = service.requestRender(parsed.data.spec, parsed.data.quality);
			const wait = (req.query as Record<string, string | undefined>).wait === '1';
			return reply.code(wait ? 200 : 202).send(wait ? await done : job);
		} catch (e) {
			if (e instanceof MgRenderError) {
				const code =
					(e.detail as { code?: string } | undefined)?.code === 'TEMPLATE_NOT_FOUND'
						? 'TEMPLATE_NOT_FOUND'
						: e.code === 'INVALID_SPEC'
							? 'INVALID_SPEC'
							: 'MG_UNAVAILABLE';
				return sendError(reply, code === 'MG_UNAVAILABLE' ? 503 : 400, code, e.message);
			}
			throw e;
		}
	});

	app.get('/mg/:key/:file', async (req, reply) => {
		const { key, file } = req.params as { key: string; file: string };
		const path = service.fileFor(key, file);
		if (!path) return sendError(reply, 404, 'NOT_FOUND', `No motion-graphics file ${key}/${file}`);
		const size = statSync(path).size;
		reply
			.header('accept-ranges', 'bytes')
			.header('cache-control', 'public, max-age=31536000, immutable')
			.header('etag', `"${key}-${file}-${size}"`)
			.type(CONTENT_TYPES[file] ?? 'application/octet-stream');
		const range = req.headers.range;
		if (range) {
			const r = parseRange(range, size);
			if (r === 'invalid' || r === null)
				return reply.code(416).header('content-range', `bytes */${size}`).send();
			reply
				.code(206)
				.header('content-range', `bytes ${r.start}-${r.end}/${size}`)
				.header('content-length', String(r.end - r.start + 1));
			return reply.send(createReadStream(path, { start: r.start, end: r.end }));
		}
		reply.header('content-length', String(size));
		return reply.send(createReadStream(path));
	});
}
