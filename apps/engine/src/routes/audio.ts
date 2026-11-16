import { AudioAnalyzeRequestSchema, LoudnessNormalizeRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { AudioService } from '../audio/service.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { JobError } from '../jobs/types.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Wait = { Querystring: { wait?: string } };

export default async function audioRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new AudioService(core);
	app.jasper.services.audio = svc;
	svc.registerRunners();

	app.post<Wait>(
		'/api/audio/analyze',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(AudioAnalyzeRequestSchema, req.body);
			const { job, cached } = await svc.submitAnalysis(body);
			// a kept measurement of the same mix finishes at once: answered finished even without wait
			return replyWithJob(core.queue, job, cached ? '1' : req.query.wait, reply, 'ANALYSIS_FAILED');
		}),
	);

	app.post<{ Params: { key: string }; Querystring: { wait?: string } }>(
		'/api/media/:key/loudness-normalize',
		guarded<{ Params: { key: string }; Querystring: { wait?: string } }>(async (req, reply) => {
			if (!MEDIA_KEY_RE.test(req.params.key) || !core.registry.get(req.params.key))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const body = parseOr400(LoudnessNormalizeRequestSchema, req.body ?? {});
			let job: ReturnType<AudioService['submitNormalize']>;
			try {
				job = svc.submitNormalize(req.params.key, body);
			} catch (e) {
				if (e instanceof JobError) throw new HttpError(422, e.code, e.message);
				throw e;
			}
			return replyWithJob(core.queue, job, req.query.wait, reply, 'ANALYSIS_FAILED');
		}),
	);
}
