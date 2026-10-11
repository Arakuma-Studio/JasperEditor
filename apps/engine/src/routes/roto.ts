import { RotoSegmentRequestSchema, RotoTraceRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { replyWithJob } from '../jobs/reply.ts';
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
	core.exports.registerRotoSets(async (key) => {
		const s = await svc.store.readSet(key);
		return s ? { start: s.start, end: s.end } : null;
	});
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
						(j.kind === 'model-download' && j.dedupeKey === `model:${req.params.modelId}`) ||
						j.kind === 'roto',
				);
			if (active)
				throw new HttpError(
					409,
					'MODEL_BUSY',
					'The model is in use or being downloaded; wait or cancel the job',
				);
			// Security review AGT-3: a model can be downloaded again, but that is gigabytes and needs the network.
			await requireUserApproval(app, req, {
				label: 'Remove a downloaded model',
				summary: `remove the downloaded model ${req.params.modelId} from this computer`,
				reasons: ['features that use the model stop working until it is downloaded again'],
			});
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
			return replyWithJob(core.queue, job, req.query.wait, reply, 'ROTO_FAILED');
		}),
	);

	app.post(
		'/api/roto/trace',
		guarded(async (req) => svc.trace(parseOr400(RotoTraceRequestSchema, req.body))),
	);

	app.get<SetParams>(
		'/api/roto/sets/:key',
		guarded<SetParams>(async (req) => {
			const s = await svc.store.readSet(req.params.key);
			if (!s) throw new HttpError(404, 'NOT_FOUND', 'No such matte set');
			return {
				key: s.key,
				start: s.start,
				end: s.end,
				width: s.width,
				height: s.height,
				frames: s.frames.length,
			};
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
