import { z } from 'zod';

// Voice analysis of a media's audio stream (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md "Voice analysis").
// The analysis itself (`VoiceAnalysis`, its binary file and `decodeVoiceAnalysis`) is @jasper/project's
// `cleanup/voice-analysis.ts`, re-exported here for the engine client.
export {
	decodeVoiceAnalysis,
	encodeVoiceAnalysis,
	summarizeVoiceAnalysis,
	VOICE_ANALYSIS_MAX_FILE_BYTES,
	VOICE_ANALYSIS_VERSION,
	type VoiceAnalysis,
	type VoiceAnalysisSummary,
	voiceAnalysisPage,
	voiceRuns,
} from '@jasper/project';

/** `POST /api/media/:key/voice-analysis[?wait=1]` → a `voice-analysis` job (result `VoiceAnalysisJobResult`). */
export const VoiceAnalyzeRequestSchema = z
	.object({
		projectId: z.string().max(200).optional(),
		/** Container stream index of the audio stream (default: the first audio stream). */
		streamIndex: z.number().int().min(0).max(65_535).optional(),
	})
	.strict();
export type VoiceAnalyzeRequest = z.infer<typeof VoiceAnalyzeRequestSchema>;

/** `GET /api/media/:key/voice-analysis?streamIndex=N` → the analysis file (application/octet-stream). */
export const VoiceAnalysisQuerySchema = z
	.object({
		streamIndex: z
			.string()
			.regex(/^\d{1,5}$/)
			.optional(),
	})
	.strict();

const Db = z.number().nullable();

/** The `voice-analysis` job's result: where the analysis is and its totals (the frames are in the file). */
export const VoiceAnalysisJobResultSchema = z.object({
	mediaKey: z.string(),
	streamIndex: z.number().int().min(0),
	analysisVersion: z.number().int(),
	/** The analysis existed already (nothing was decoded). */
	cached: z.boolean(),
	frameCount: z.number().int().min(0),
	durationSeconds: z.number().min(0),
	floorDb: Db,
	speechDb: Db,
	speechThresholdDb: Db,
	/** Seconds of each class. */
	seconds: z.object({ silence: z.number(), breath: z.number(), speech: z.number() }),
	/** Bytes of the cached file. */
	bytes: z.number().int().min(0),
	/** Engine-relative URL of the file (`GET`, authenticated). */
	url: z.string(),
	/** Wall time of the decode + analysis (0 when cached). */
	elapsedMs: z.number().min(0),
});
export type VoiceAnalysisJobResult = z.infer<typeof VoiceAnalysisJobResultSchema>;
