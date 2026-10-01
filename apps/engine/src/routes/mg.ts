// Motion graphics routes (ARCHITECTURE §9.2, S04 §15). Owner: WP-2G.
//   GET  /api/motion-graphics/templates  catalog with JSON Schemas (native when jasper-mg is ready)
//   POST /api/motion-graphics/render     {spec, quality} → EngineJob (mg-render); `?wait=1` answers when done
//   GET  /mg/:key/:file                  cached master.mov / preview.webm / poster.png, with Range
import { createReadStream, statSync } from 'node:fs';
import { MgRenderRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { JobError } from '../jobs/types.ts';
import {
	createMgService,
	MG_SERVICE_KEY,
	MgRenderError,
	mgCapabilityProvider,
	mgMasterHook,
} from '../mg/index.ts';
import { sendError } from '../server.ts';
import { coreServices } from '../tools/services.ts';

const CONTENT_TYPES: Record<string, string> = {
	'master.mov': 'video/quicktime',
	'preview.webm': 'video/webm',
	'poster.png': 'image/png',
};

export default async function mgRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const service = createMgService({
		mgDir: app.jasper.config.paths.mgDir,
		tools: core.ffmpeg.bins,
		emit: (type, job) => core.broadcaster.publish(type, job, job.projectId),
	});
	app.jasper.services[MG_SERVICE_KEY] = service;
	// Graceful shutdown (S04:ENG-004): kill jasper-mg/ffmpeg children and remove their temp dirs.
	app.addHook('onClose', async () => {
		await service.shutdown();
	});
	await service.refresh();
	core.registerCapabilityProvider(mgCapabilityProvider(service));
	core.registerMgMasterProvider(mgMasterHook(service));
	// mg-render jobs run on the MG service's scheduler; list/get/cancel/retry them through /api/jobs.
	core.queue.registerExternalSource({
		owns: (id) => id.startsWith('job_mg_'),
		list: () => service.listJobs(),
		get: (id) => service.getJob(id),
		cancel: (id) => service.cancel(id),
		retry: (id) => {
			const job = service.retry(id);
			if (!job) throw new JobError('JOB_NOT_RETRYABLE', `Job ${id} cannot be retried`);
			return job;
		},
	});
	const cap = service.capability();
	app.log.info(`[mg] fframes ${cap.fframes}${cap.fframesReason ? `: ${cap.fframesReason}` : ''}`);

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
		// wp-m2-anime-templates (S11:ATP-008): anime templates are refused whatever the fframes state.
		try {
			service.refuseAnime(parsed.data.spec);
		} catch (e) {
			if (e instanceof MgRenderError) return sendError(reply, 400, 'ANIME_TEMPLATE', e.message);
			throw e;
		}
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
				const detailCode = (e.detail as { code?: string } | undefined)?.code;
				const code =
					detailCode === 'TEMPLATE_NOT_FOUND' || detailCode === 'ANIME_TEMPLATE'
						? detailCode
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
			if (r === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
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

function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' {
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
