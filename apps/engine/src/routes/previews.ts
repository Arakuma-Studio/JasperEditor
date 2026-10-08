// Render previews (workstream `previews`, docs/wp-notes/previews.md):
//   POST /api/previews/status   PreviewStatusRequest → PreviewStatus (which segment hashes have files)
//   POST /api/previews/render   PreviewRenderRequest → 202 EngineJob kind `preview` (`?wait=1`: the finished job);
//                               200 {job: null, existing} when every segment of the range is rendered already
//   POST /api/previews/delete   PreviewDeleteRequest → {deleted, bytes} (Delete Render Files [In to Out])
//   GET  /renders/previews/:format/:name   a preview file (byte ranges, immutable: names are content hashes)
import {
	PreviewDeleteRequestSchema,
	PreviewRenderRequestSchema,
	PreviewStatusRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { JobError } from '../jobs/types.ts';
import { PerfMonitor } from '../perf/stats.ts';
import { PreviewService } from '../previews/service.ts';
import { serveFile } from '../tools/http.ts';
import { fail, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Wait = { Querystring: { wait?: string } };

export default async function previewsRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const previews = new PreviewService({
		cacheDir: app.jasper.config.paths.cacheDir,
		exports: core.exports,
		queue: core.queue,
		broadcaster: core.broadcaster,
	});
	previews.registerRunner();
	// Export ▸ Use Previews reads the files of the segments that have one.
	core.exports.registerPreviewSource((doc, seqId) => previews.piecesFor(doc, seqId));
	app.addHook('onClose', async () => core.exports.registerPreviewSource(null));
	app.jasper.services.previews = previews;
	// Cleaning passes remove files behind the listings.
	const off = core.broadcaster.subscribe((e) => {
		if (e.type === 'cache.cleaned') previews.invalidate();
	});
	app.addHook('onClose', async () => off());

	// Performance instrumentation (GET /api/perf, MCP perf_stats).
	const perf = new PerfMonitor(core.queue);
	perf.provide('previews', () => previews.usage());
	app.jasper.services.perf = perf;
	app.addHook('onClose', async () => perf.close());
	app.get(
		'/api/perf',
		guarded(async () => perf.stats()),
	);

	app.post(
		'/api/previews/status',
		guarded(async (req) => previews.status(parseOr400(PreviewStatusRequestSchema, req.body))),
	);

	app.post<Wait>(
		'/api/previews/render',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(PreviewRenderRequestSchema, req.body);
			let r: Awaited<ReturnType<PreviewService['render']>>;
			try {
				r = await previews.render(body);
			} catch (e) {
				if (e instanceof JobError) throw new HttpError(400, e.code, e.message);
				throw e;
			}
			if (!r.job) return reply.code(200).send({ job: null, existing: r.planned.existing });
			if (req.query.wait !== '1') return reply.code(202).send(r.job);
			return core.queue.wait(r.job.id);
		}),
	);

	app.post(
		'/api/previews/delete',
		guarded(async (req) => previews.delete(parseOr400(PreviewDeleteRequestSchema, req.body))),
	);

	app.get<{ Params: { format: string; name: string } }>(
		'/renders/previews/:format/:name',
		guarded<{ Params: { format: string; name: string } }>(async (req, reply) => {
			const file = await previews.file(req.params.format, req.params.name);
			if (!file) return fail(reply, 404, 'NOT_FOUND', 'No such preview file');
			return serveFile(req, reply, file, { cache: 'immutable' });
		}),
	);
}
