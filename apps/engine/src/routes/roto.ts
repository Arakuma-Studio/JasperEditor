// Roto / object mattes and face tracking (parity workstream `roto`):
//   GET    /api/roto/models                    segmentation and face models with install state and licences
//   POST   /api/roto/models/:modelId/install   → `model-download` job (the processing catalogue's installer)
//   DELETE /api/roto/models/:modelId           removes a downloaded model
//   POST   /api/roto/segment                   RotoSegmentRequest → `roto` job (`?wait=1` → the finished job)
//   GET    /api/roto/sets/:key                 what a matte set holds (RotoStoreInfo)
//   GET    /mg/roto/:key?n=<frame>             frame n of a matte set (8-bit grey PNG; signable for headless renders)
// Also registers the `roto` job runner, its cache adapter and the `features.roto` capability block.
import { RotoSegmentRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import type { ProcessingService } from '../processing/service.ts';
import { RotoService } from '../roto/service.ts';
import { serveFile } from '../tools/http.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type ModelParams = { Params: { modelId: string } };
type Wait = { Querystring: { wait?: string } };
type SetParams = { Params: { key: string }; Querystring: { n?: string } };

export default async function rotoRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const processing = app.jasper.services.processing as ProcessingService | undefined;
	if (!processing) throw new Error('roto routes need the processing routes (model catalogue) first');
	const svc = new RotoService(core, processing);
	app.jasper.services.roto = svc;
	svc.registerRunners();
	core.registerCapabilityProvider(async () => ({ features: { roto: await svc.features() } }));

	app.get(
		'/api/roto/models',
		guarded(async () => ({ models: await svc.models.list() })),
	);

	app.post<ModelParams>(
		'/api/roto/models/:modelId/install',
		guarded<ModelParams>(async (req) => {
			if (!svc.models.entry(req.params.modelId))
				throw new HttpError(404, 'MODEL_UNKNOWN', `Unknown roto model ${req.params.modelId}`);
			return processing.submitInstall(req.params.modelId);
		}),
	);

	app.delete<ModelParams>(
		'/api/roto/models/:modelId',
		guarded<ModelParams>(async (req) => {
			if (!svc.models.entry(req.params.modelId))
				throw new HttpError(404, 'MODEL_UNKNOWN', `Unknown roto model ${req.params.modelId}`);
			const active = core.queue
				.list({ active: true })
				.some(
					(j) =>
						(j.kind === 'model-download' && j.dedupeKey === `model:${req.params.modelId}`) || j.kind === 'roto',
				);
			if (active)
				throw new HttpError(409, 'MODEL_BUSY', 'The model is in use or being downloaded; wait or cancel the job');
			const r = await svc.models.remove(req.params.modelId);
			core.capabilities.changed();
			return { modelId: req.params.modelId, ...r };
		}),
	);

	app.post<Wait>(
		'/api/roto/segment',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(RotoSegmentRequestSchema, req.body);
			const job = await svc.submit(body);
			if (req.query.wait !== '1') return reply.code(202).send(job);
			const done = await core.queue.wait(job.id);
			if (done.state !== 'succeeded')
				throw new HttpError(422, done.error?.code ?? 'ROTO_FAILED', done.error?.message ?? done.state, {
					jobId: done.id,
				});
			return done;
		}),
	);

	app.get<SetParams>(
		'/api/roto/sets/:key',
		guarded<SetParams>(async (req) => {
			const s = await svc.store.readSet(req.params.key);
			if (!s) throw new HttpError(404, 'NOT_FOUND', 'No such matte set');
			return { key: s.key, start: s.start, end: s.end, width: s.width, height: s.height, frames: s.frames.length };
		}),
	);

	app.get<SetParams>(
		'/mg/roto/:key',
		guarded<SetParams>(async (req, reply) => {
			const n = Number(req.query.n ?? 0);
			const path = await svc.store.framePath(req.params.key, n);
			if (!path) throw new HttpError(404, 'NOT_FOUND', 'No such matte frame');
			return serveFile(req, reply, path, { cache: 'immutable', contentType: 'image/png' });
		}),
	);
}
