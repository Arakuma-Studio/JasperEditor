// Speech-to-text (wp speech):
//   GET    /api/speech/models                    the catalogue's speech models with install state and licences
//   POST   /api/speech/models/:modelId/install   → `model-download` job (the processing catalogue's installer)
//   DELETE /api/speech/models/:modelId           removes a downloaded model
//   POST   /api/media/:key/transcribe            → `transcription` job (`?wait=1` → the finished job)
//   POST   /api/speech/transcribe-sequence       → `transcription` job over the sequence mix (`?wait=1`)
// Also registers the `features.speech` capability block.
import { TranscribeMediaRequestSchema, TranscribeSequenceRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { JobError } from '../jobs/types.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import type { ProcessingService } from '../processing/service.ts';
import { SpeechService } from '../speech/service.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type Wait = { Querystring: { wait?: string } };
type ModelParams = { Params: { modelId: string } };

function httpOf(e: unknown): never {
	if (e instanceof JobError) {
		const status = /NOT_FOUND|UNKNOWN/.test(e.code)
			? 404
			: e.code === 'SPEECH_MODEL_NOT_INSTALLED'
				? 409
				: 422;
		throw new HttpError(status, e.code, e.message);
	}
	throw e;
}

export default async function speechRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const processing = app.jasper.services.processing as ProcessingService | undefined;
	if (!processing) throw new Error('speech routes need the processing routes (model catalogue) first');
	const svc = new SpeechService(core, processing);
	app.jasper.services.speech = svc;
	svc.registerRunners();
	core.registerCapabilityProvider(async () => ({ features: { speech: await svc.features() } }));

	const finish = async (
		job: { id: string },
		wait: string | undefined,
		reply: { code(n: number): { send(x: unknown): unknown } },
	) => {
		if (wait !== '1') return reply.code(202).send(job);
		const done = await core.queue.wait(job.id);
		if (done.state !== 'succeeded')
			throw new HttpError(
				422,
				done.error?.code ?? 'TRANSCRIPTION_FAILED',
				done.error?.message ?? done.state,
				{
					jobId: done.id,
				},
			);
		return done;
	};

	app.get(
		'/api/speech/models',
		guarded(async () => ({ models: await svc.models.list() })),
	);

	app.post<ModelParams>(
		'/api/speech/models/:modelId/install',
		guarded<ModelParams>(async (req) => {
			if (!svc.models.entry(req.params.modelId))
				throw new HttpError(404, 'SPEECH_MODEL_UNKNOWN', `Unknown speech model ${req.params.modelId}`);
			return processing.submitInstall(req.params.modelId);
		}),
	);

	app.delete<ModelParams>(
		'/api/speech/models/:modelId',
		guarded<ModelParams>(async (req) => {
			if (!svc.models.entry(req.params.modelId))
				throw new HttpError(404, 'SPEECH_MODEL_UNKNOWN', `Unknown speech model ${req.params.modelId}`);
			const active = core.queue
				.list({ active: true })
				.some((j) => j.kind === 'model-download' && j.dedupeKey === `model:${req.params.modelId}`);
			if (active)
				throw new HttpError(409, 'SPEECH_MODEL_BUSY', 'The model is being downloaded; cancel the job first');
			// Security review AGT-3: see the roto models.
			await requireUserApproval(app, req, {
				label: 'Remove a downloaded model',
				summary: `remove the downloaded speech model ${req.params.modelId} from this computer`,
				reasons: ['transcription with this model stops working until it is downloaded again'],
			});
			const r = await svc.models.remove(req.params.modelId);
			core.capabilities.changed();
			return { modelId: req.params.modelId, ...r };
		}),
	);

	app.post<{ Params: { key: string }; Querystring: { wait?: string } }>(
		'/api/media/:key/transcribe',
		guarded<{ Params: { key: string }; Querystring: { wait?: string } }>(async (req, reply) => {
			if (!MEDIA_KEY_RE.test(req.params.key) || !core.registry.get(req.params.key))
				throw new HttpError(404, 'ASSET_NOT_FOUND', 'Unknown media key');
			const body = parseOr400(TranscribeMediaRequestSchema, req.body ?? {});
			const job = await svc.submitMedia(req.params.key, body).catch(httpOf);
			return finish(job, req.query.wait, reply);
		}),
	);

	app.post<Wait>(
		'/api/speech/transcribe-sequence',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(TranscribeSequenceRequestSchema, req.body);
			const job = await svc.submitSequence(body).catch(httpOf);
			return finish(job, req.query.wait, reply);
		}),
	);
}
