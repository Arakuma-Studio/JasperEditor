import { z } from 'zod';
import { RegisteredMediaSchema } from './media.ts';
import { EnvelopeSchema } from './projects.ts';

/** What part of the sequence is measured. */
export const AudioScopeSchema = z.discriminatedUnion('type', [
	/** The whole sequence's mix (the Mix output, before loudness normalisation). */
	z.object({ type: z.literal('sequence') }),
	/** The mix over sequence frames `[startFrame, endFrame)`; `inOut: true` = the sequence In/Out. */
	z.object({
		type: z.literal('range'),
		startFrame: z.number().int().min(0).optional(),
		endFrame: z.number().int().min(1).optional(),
		inOut: z.boolean().optional(),
	}),
	/** The mix with only these tracks playing (solo), through their strips and the Mix. */
	z.object({ type: z.literal('tracks'), trackIds: z.array(z.string().min(1)).min(1) }),
	/** Each clip on its own (pre-fader, with or without its gain/volume/fades/pan; see `levels`). */
	z.object({ type: z.literal('clips'), clipIds: z.array(z.string().min(1)).min(1) }),
]);
export type AudioScope = z.infer<typeof AudioScopeSchema>;

export const AudioAnalyzeRequestSchema = z.looseObject({
	projectId: z.string().optional(),
	sequenceId: z.string().min(1),
	envelope: EnvelopeSchema,
	scope: AudioScopeSchema,
	/**
	 * `clips` scope: `source` = the media as it is (no clip gain, volume, fades or pan: what Audio Gain normalises),
	 * `mix` = the clip as it reaches its track. Default `mix`.
	 */
	levels: z.enum(['mix', 'source']).optional(),
	/**
	 * Activity regions of the measured audio (auto-ducking triggers): RMS envelope (50 ms window, 10 ms hop), regions
	 * above the sensitivity threshold (`−20 − 4·sensitivity` dBFS), gaps < `bridgeMs` bridged, regions < `minOnMs`
	 * dropped. With `clips` scope the clips are mixed together (the triggers).
	 */
	activity: z
		.object({
			sensitivity: z.number().min(0).max(10),
			minOnMs: z.number().min(0).max(10_000).optional(),
			bridgeMs: z.number().min(0).max(10_000).optional(),
			/** Only within this window (sequence frames), e.g. the music clip being ducked. */
			startFrame: z.number().int().min(0).optional(),
			endFrame: z.number().int().min(1).optional(),
		})
		.optional(),
});
export type AudioAnalyzeRequest = z.infer<typeof AudioAnalyzeRequestSchema>;

/** BS.1770-4 / EBU R128 measurements (null = silence / not measurable). */
export const LoudnessMeasureSchema = z.object({
	integratedLufs: z.number().nullable(),
	lra: z.number().nullable(),
	truePeakDbtp: z.number().nullable(),
	samplePeakDb: z.number().nullable(),
	maxMomentaryLufs: z.number().nullable(),
	maxShortTermLufs: z.number().nullable(),
	durationSec: z.number(),
});
export type LoudnessMeasure = z.infer<typeof LoudnessMeasureSchema>;

export const AudioAnalyzeResultSchema = z.object({
	sampleRate: z.number().int(),
	/** The measured range (sequence frames). */
	range: z.object({ startFrame: z.number().int(), endFrame: z.number().int() }),
	/** The mix (sequence / range / tracks scope; clips scope: all clips mixed together). */
	loudness: LoudnessMeasureSchema,
	/** Per clip (clips scope). */
	clips: z.record(z.string(), LoudnessMeasureSchema).optional(),
	/** Activity regions in sequence flicks `[start, end)` and the threshold used. */
	activity: z
		.object({ regions: z.array(z.tuple([z.number(), z.number()])), thresholdDb: z.number() })
		.optional(),
	/** `mixFingerprint` of the analysed document (sequence scopes): stored with `mixer.setLoudness {analysis}`. */
	mixHash: z.string(),
});
export type AudioAnalyzeResult = z.infer<typeof AudioAnalyzeResultSchema>;

/** `POST /api/media/:key/loudness-normalize`: a loudness-normalised WAV version of one audio stream. */
export const LoudnessNormalizeRequestSchema = z.looseObject({
	targetLufs: z.number().min(-60).max(0),
	truePeakDb: z.number().min(-20).max(0).default(-1),
	/** Audio stream of the media (default: the first audio stream). */
	streamIndex: z.number().int().min(0).optional(),
	projectId: z.string().optional(),
});
export type LoudnessNormalizeRequest = z.infer<typeof LoudnessNormalizeRequestSchema>;

export const LoudnessNormalizeResultSchema = z.object({
	registered: RegisteredMediaSchema,
	fromMediaKey: z.string(),
	recipeVersion: z.number().int(),
	recipeHash: z.string(),
	streamIndex: z.number().int(),
	before: LoudnessMeasureSchema,
	after: LoudnessMeasureSchema,
	gainDb: z.number(),
});
export type LoudnessNormalizeResult = z.infer<typeof LoudnessNormalizeResultSchema>;
