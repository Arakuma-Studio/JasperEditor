import { SpeechSettingsPatchSchema, TranscribeMediaRequestSchema, TranscribeSequenceRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { JobError } from '../jobs/types.ts';
import { MEDIA_KEY_RE } from '../media/fingerprint.ts';
import type { ProcessingService } from '../processing/service.ts';
import { SpeechService } from '../speech/service.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';
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
				: e.code === 'UNSUPPORTED_PLATFORM'
					? 501
					: 422;
		throw new HttpError(status, e.code, e.message);
	}
	throw e;
}

export default async function speechRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const processing = app.jasper.services.processing as ProcessingService | undefined;
	if (!processing) throw new Error('speech routes need the processing routes (model catalogue) first');
	const svc = new SpeechService(
		core,
		processing,
		process.env,
		undefined,
		undefined,
		() => app.jasper.services.voice as VoiceAnalysisService | undefined,
	);
	app.jasper.services.speech = svc;
	svc.registerRunners();
	await svc.init();
	// spec 16 SG-008: the upscaler reads the same provider probe
	processing.setOrtProviderSource((probe) => svc.upscalerProviders(probe));
	processing.cudaRuntimeInfo = async () => ({ dir: svc.cuda.dir, installed: (await svc.cuda.state()) === 'installed' });
	core.registerCapabilityProvider(async () => ({ features: { speech: await svc.features() } }));

	app.get(
		'/api/speech/models',
		guarded(async () => ({ models: await svc.listModels() })),
	);

	app.get(
		'/api/speech/settings',
		guarded(async () => svc.settings()),
	);

	app.put(
		'/api/speech/settings',
		guarded(async (req) => svc.updateSettings(parseOr400(SpeechSettingsPatchSchema, req.body ?? {}))),
	);

	app.get(
		'/api/speech/probe',
		guarded(async () => svc.probeReport()),
	);

	app.post(
		'/api/speech/probe',
		guarded(async () => svc.probeReport(await svc.probe(true))),
	);

	app.get(
		'/api/speech/cuda',
		guarded(async () => svc.cudaStatus()),
	);

	app.post(
		'/api/speech/cuda/install',
		guarded(async () => {
			try {
				return svc.submitCudaInstall();
			} catch (e) {
				return httpOf(e);
			}
		}),
	);

	app.delete(
		'/api/speech/cuda',
		guarded(async (req) => {
			const active = core.queue.list({ active: true }).some((j) => j.kind === 'runtime-download');
			if (active)
				throw new HttpError(409, 'SPEECH_CUDA_BUSY', 'The CUDA provider is being downloaded; cancel the job first');
			await requireUserApproval(app, req, {
				label: 'Remove the NVIDIA GPU provider',
				summary: 'remove the downloaded ONNX Runtime CUDA provider from this computer',
				reasons: ['transcription and upscaling use the CPU until it is downloaded again'],
			});
			const r = await svc.removeCuda();
			await svc.updateSettings({ nvidiaGpu: false });
			return r;
		}),
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
			return replyWithJob(core.queue, job, req.query.wait, reply, 'TRANSCRIPTION_FAILED');
		}),
	);

	app.post<Wait>(
		'/api/speech/transcribe-sequence',
		guarded<Wait>(async (req, reply) => {
			const body = parseOr400(TranscribeSequenceRequestSchema, req.body);
			const job = await svc.submitSequence(body).catch(httpOf);
			return replyWithJob(core.queue, job, req.query.wait, reply, 'TRANSCRIPTION_FAILED');
		}),
	);
}
