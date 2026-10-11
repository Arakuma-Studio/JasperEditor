import {
	PreviewDeleteRequestSchema,
	PreviewRenderRequestSchema,
	PreviewStatusRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
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
		guarded(async (req) => {
			const body = parseOr400(PreviewDeleteRequestSchema, req.body);
			// Security review AGT-3. Deleting named segments (a range of one sequence: Sequence ▸ Delete Render Files)
			// is not gated: nothing in a project changes and Render In to Out makes them again. `all` deletes the render
			// files of every project on this engine: an agent needs the user's approval.
			if ('all' in body)
				await requireUserApproval(app, req, {
					label: 'Delete all render files',
					summary: 'delete the render preview files of every project',
					reasons: ['every rendered segment of every sequence has to be rendered again'],
				});
			return previews.delete(body);
		}),
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
