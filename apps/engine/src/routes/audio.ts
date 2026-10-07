// Audio buses (audio-mix):
//   POST /api/audio/analyze                  loudness / peaks / activity of a sequence, range, tracks or clips
//                                            → 202 EngineJob kind `analysis` (`?wait=1` → the finished job)
//   POST /api/media/:key/loudness-normalize  a loudness-normalised WAV version of a media → 202 EngineJob
//                                            (`?wait=1` → the finished job; result LoudnessNormalizeResult)
import { AudioAnalyzeRequestSchema, LoudnessNormalizeRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { AudioService } from '../audio/service.ts';
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

	const finish = async (job: { id: string }, wait: string | undefined, reply: { code(n: number): { send(x: unknown): unknown } }) => {
		if (wait !== '1') return reply.code(202).send(job);
		const done = await core.queue.wait(job.id);
		if (done.state !== 'succeeded')
			throw new HttpError(422, done.error?.code ?? 'ANALYSIS_FAILED', done.error?.message ?? done.state, {
				jobId: done.id,
			});
		return done;
	};

	app.post<Wait>(
		'/api/audio/analyze',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(AudioAnalyzeRequestSchema, req.body);
			const job = await svc.submitAnalysis(body);
			return finish(job, req.query.wait, reply);
		}),
	);

	app.post<{ Params: { key: string }; Querystring: { wait?: string } }>(
		'/api/media/:key/loudness-normalize',
		guarded<{ Params: { key: string }; Querystring: { wait?: string } }>(async (req, reply) => {
			if (!MEDIA_KEY_RE.test(req.params.key) || !core.registry.get(req.params.key))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const body = parseOr400(LoudnessNormalizeRequestSchema, req.body ?? {});
			let job: { id: string };
			try {
				job = svc.submitNormalize(req.params.key, body);
			} catch (e) {
				if (e instanceof JobError) throw new HttpError(422, e.code, e.message);
				throw e;
			}
			return finish(job, req.query.wait, reply);
		}),
	);
}
