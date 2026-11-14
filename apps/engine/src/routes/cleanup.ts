// Transcript cleanup routes (spec 14; docs/wp-notes/transcript-cleanup.md "Engine"):
//   POST   /api/cleanup/analyze[?wait=1]        → `cleanup-analysis` job (result CleanupAnalysisJobResult)
//   GET    /api/cleanup/analyses/:analysisId    → the full analysis (findings, retake groups, plan, statistics)
//   GET    /api/cleanup-presets                 → the user's cleanup presets {revision, presets}
//   POST   /api/cleanup-presets                 → a new user preset
//   PUT    /api/cleanup-presets/:presetId       → rename / change it
//   DELETE /api/cleanup-presets/:presetId       → delete it (an agent needs the user's approval in the editor)
import {
	CleanupAnalyzeRequestSchema,
	CleanupPresetCreateRequestSchema,
	CleanupPresetUpdateRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { requireUserApproval } from '../agent/user-approval.ts';
import { EditWordsService, speechTranscriber } from '../cleanup/edit-words.ts';
import { CleanupPresetLibrary } from '../cleanup/presets.ts';
import { CleanupAnalysisService } from '../cleanup/service.ts';
import { replyWithJob } from '../jobs/reply.ts';
import type { SpeechService } from '../speech/service.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';

type PresetParams = { Params: { presetId: string } };
type AnalysisParams = { Params: { analysisId: string } };

export default async function cleanupRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const services = app.jasper.services;
	const presets = new CleanupPresetLibrary(core.config.paths.cleanupPresetsFile, {
		onChange: (revision) => core.broadcaster.publish('cleanupPresets.changed', { revision }),
		log: (m) => app.log.warn(m),
	});
	let editWords: EditWordsService | undefined;
	const svc = new CleanupAnalysisService(core, {
		voice: () => services.voiceAnalysis as VoiceAnalysisService | undefined,
		agent: () => services.agent as AgentService | undefined,
		presets,
		editWords: () => {
			const speech = services.speech as SpeechService | undefined;
			if (!speech) return undefined;
			editWords ??= new EditWordsService(
				core.config.paths.cacheDir,
				speechTranscriber((req, origin) => speech.submitSequence(req, origin), core.queue),
			);
			return editWords;
		},
	});
	svc.registerRunner();
	services.cleanupPresets = presets;
	services.cleanupAnalysis = svc;

	app.post<{ Querystring: { wait?: string } }>(
		'/api/cleanup/analyze',
		guarded<{ Querystring: { wait?: string } }>(async (req, reply) => {
			const body = parseOr400(CleanupAnalyzeRequestSchema, req.body ?? {});
			const job = svc.submit(body);
			return replyWithJob(core.queue, job, req.query.wait, reply, 'CLEANUP_ANALYSIS_FAILED');
		}),
	);

	app.get<AnalysisParams>(
		'/api/cleanup/analyses/:analysisId',
		guarded<AnalysisParams>(async (req, reply) => {
			const file = svc.get(req.params.analysisId);
			if (!file)
				throw new HttpError(
					404,
					'CLEANUP_ANALYSIS_NOT_FOUND',
					'No such analysis (only the 16 newest are kept): run POST /api/cleanup/analyze again',
				);
			reply.header('cache-control', 'no-store');
			return file;
		}),
	);

	app.get(
		'/api/cleanup-presets',
		guarded(async () => presets.list()),
	);
	app.post(
		'/api/cleanup-presets',
		guarded(async (req, reply) => {
			const body = parseOr400(CleanupPresetCreateRequestSchema, req.body ?? {});
			reply.code(201);
			return presets.create(body);
		}),
	);
	app.put<PresetParams>(
		'/api/cleanup-presets/:presetId',
		guarded<PresetParams>(async (req) =>
			presets.update(req.params.presetId, parseOr400(CleanupPresetUpdateRequestSchema, req.body ?? {})),
		),
	);
	// The library is the user's, shared by every project, and has no undo: an agent's delete is asked about in the
	// editor first (as for effect presets, security review AGT-3).
	app.delete<PresetParams>(
		'/api/cleanup-presets/:presetId',
		guarded<PresetParams>(async (req) => {
			const preset = await presets.get(req.params.presetId);
			await requireUserApproval(app, req, {
				label: 'Delete cleanup preset',
				summary: `delete the Clean Up preset "${preset.name}" from your preset library`,
				reasons: ['deletes a preset of your library; this cannot be undone'],
			});
			return { ok: true as const, ...(await presets.remove(req.params.presetId)) };
		}),
	);
}
