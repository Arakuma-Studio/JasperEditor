// Voice analysis routes (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md "Voice analysis"):
//   POST /api/media/:key/voice-analysis[?wait=1]  {streamIndex?, projectId?} → `voice-analysis` job
//   GET  /api/media/:key/voice-analysis?streamIndex=N → the cached analysis file (application/octet-stream), validated
//        before it is sent; 404 VOICE_ANALYSIS_NOT_FOUND when the stream has none yet (run the job).
import { VoiceAnalysisQuerySchema, VoiceAnalyzeRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { replyWithJob } from '../jobs/reply.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import { VoiceAnalysisService } from '../voice/service.ts';

type Params = { Params: { key: string } };
type Post = Params & { Querystring: { wait?: string } };
type Get = Params & { Querystring: Record<string, string | undefined> };

export default async function voiceRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const svc = new VoiceAnalysisService(core, app.jasper.config.paths.cacheDir, {
		log: (m) => app.log.warn(m),
	});
	svc.registerRunner();
	app.jasper.services.voice = svc;

	const mediaKey = (key: string) => {
		if (!MEDIA_KEY_RE.test(key) || !core.registry.get(key))
			throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
		return key;
	};

	app.post<Post>(
		'/api/media/:key/voice-analysis',
		guarded<Post>(async (req, reply) => {
			const key = mediaKey(req.params.key);
			const body = parseOr400(VoiceAnalyzeRequestSchema, req.body ?? {});
			const job = svc.submit(key, body);
			return replyWithJob(core.queue, job, req.query.wait, reply, 'VOICE_ANALYSIS_FAILED');
		}),
	);

	app.get<Get>(
		'/api/media/:key/voice-analysis',
		guarded<Get>(async (req, reply) => {
			const key = mediaKey(req.params.key);
			const q = parseOr400(VoiceAnalysisQuerySchema, req.query ?? {});
			const { rec, streamIndex } = svc.target(
				key,
				q.streamIndex === undefined ? undefined : Number(q.streamIndex),
			);
			const bytes = await svc.readBytes(rec, streamIndex);
			if (!bytes)
				throw new HttpError(
					404,
					'VOICE_ANALYSIS_NOT_FOUND',
					`No voice analysis of stream ${streamIndex} yet: POST /api/media/${key}/voice-analysis`,
				);
			return reply
				.header('content-type', 'application/octet-stream')
				.header('cache-control', 'no-store')
				.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		}),
	);
}
