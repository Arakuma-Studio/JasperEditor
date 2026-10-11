import {
	AssetRelinkRequestSchema,
	INTERCHANGE_FORMATS,
	InterchangeExportRequestSchema,
	InterchangeImportRequestSchema,
	InterchangePrerenderPlanRequestSchema,
	RelinkScanRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { InterchangeService } from '../interchange/service.ts';
import { serveFile } from '../tools/http.ts';
import { fail, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Out = { Params: { jobId: string; name: string } };

export default async function interchangeRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new InterchangeService(core);
	svc.registerRunners();
	core.registerCapabilityProvider(() => ({
		features: {
			interchange: {
				state: 'ready',
				formats: [...INTERCHANGE_FORMATS],
				prerender: core.ffmpeg.bins.ffmpeg ? 'ready' : 'unavailable',
				audioEssence: core.ffmpeg.bins.ffmpeg ? 'ready' : 'unavailable',
			},
		},
	}));

	app.post(
		'/api/interchange/import',
		guarded(async (req) => svc.importDocument(parseOr400(InterchangeImportRequestSchema, req.body))),
	);

	app.post(
		'/api/interchange/prerender-plan',
		guarded(async (req) => svc.prerenderPlan(parseOr400(InterchangePrerenderPlanRequestSchema, req.body))),
	);

	app.post(
		'/api/interchange/export',
		guarded(async (req, reply) => {
			const body = parseOr400(InterchangeExportRequestSchema, req.body);
			return reply.code(202).send(await svc.startExport(body));
		}),
	);

	app.get<Out>(
		'/renders/:jobId/interchange/:name',
		guarded<Out>(async (req, reply) => {
			const file = await svc.outputFile(req.params.jobId, req.params.name);
			if (!file) return fail(reply, 404, 'NOT_FOUND', 'No such file for this job');
			const q = req.query as { download?: string };
			return serveFile(req, reply, file, {
				cache: 'revalidate',
				...(q.download ? { downloadName: req.params.name } : {}),
			});
		}),
	);

	app.post<{ Params: { assetId: string } }>(
		'/api/assets/:assetId/relink',
		guarded<{ Params: { assetId: string } }>(async (req) => {
			const body = parseOr400(AssetRelinkRequestSchema, req.body);
			if (body.asset.id !== req.params.assetId)
				throw new HttpError(400, 'VALIDATION_FAILED', 'The asset does not match the path parameter');
			return svc.relink(body);
		}),
	);

	app.post<{ Params: { projectId: string } }>(
		'/api/projects/:projectId/relink-scan',
		guarded<{ Params: { projectId: string } }>(async (req, reply) => {
			const body = parseOr400(RelinkScanRequestSchema, req.body);
			return reply.code(202).send(await svc.startScan(req.params.projectId, body));
		}),
	);
}
