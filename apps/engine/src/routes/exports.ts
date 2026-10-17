import { ExportPlanRequestSchema, ExportStartRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { serveFile } from '../tools/http.ts';
import { fail, guarded, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

export default async function exportsRoutes(app: FastifyInstance): Promise<void> {
	const { exports } = coreServices(app);

	app.post(
		'/api/exports/plan',
		guarded(async (req) => {
			const body = parseOr400(ExportPlanRequestSchema, req.body);
			return (await exports.plan(body)).plan;
		}),
	);

	app.post(
		'/api/exports',
		guarded(async (req, reply) => {
			const body = parseOr400(ExportStartRequestSchema, req.body);
			return reply.code(202).send(await exports.start(body));
		}),
	);

	app.get<{ Params: { jobId: string } }>(
		'/renders/:jobId/output',
		guarded<{ Params: { jobId: string } }>(async (req, reply) => {
			const file = await exports.outputFile(req.params.jobId);
			if (!file) return fail(reply, 404, 'NOT_FOUND', 'No output for this job');
			const q = req.query as { download?: string };
			return serveFile(req, reply, file, {
				cache: 'revalidate',
				...(q.download ? { downloadName: `${req.params.jobId}${file.slice(file.lastIndexOf('.'))}` } : {}),
			});
		}),
	);

	// wp captions: sidecar caption files of a finished export.
	app.get<{ Params: { jobId: string; name: string } }>(
		'/renders/:jobId/captions/:name',
		guarded<{ Params: { jobId: string; name: string } }>(async (req, reply) => {
			const file = await exports.sidecarFile(req.params.jobId, req.params.name);
			if (!file) return fail(reply, 404, 'NOT_FOUND', 'No such caption file for this job');
			const q = req.query as { download?: string };
			return serveFile(req, reply, file, {
				cache: 'revalidate',
				...(q.download ? { downloadName: req.params.name.replace(/^output/, req.params.jobId) } : {}),
			});
		}),
	);

	// spec 12 §2.11: the sound credits sidecar of a finished export.
	app.get<{ Params: { jobId: string; name: string } }>(
		'/renders/:jobId/credits/:name',
		guarded<{ Params: { jobId: string; name: string } }>(async (req, reply) => {
			const file = await exports.creditsFile(req.params.jobId, req.params.name);
			if (!file) return fail(reply, 404, 'NOT_FOUND', 'No such credits file for this job');
			const q = req.query as { download?: string };
			return serveFile(req, reply, file, {
				cache: 'revalidate',
				...(q.download ? { downloadName: req.params.name.replace(/^output/, req.params.jobId) } : {}),
			});
		}),
	);
}
