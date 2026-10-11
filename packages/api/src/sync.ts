import { z } from 'zod';

/** One recording to analyse: a media file, its audio stream and the stretch of it to compare. */
export const SyncAudioClipSchema = z.object({
	/** Caller's key (a clip or item id); results come back keyed by it. */
	key: z.string().min(1),
	mediaKey: z.string().min(1),
	/** Container index of the audio stream (an audio clip's `channels.streamIndex`); default the first. */
	streamIndex: z.number().int().min(0).optional(),
	/** Media time where the analysed stretch starts (flicks; default 0). */
	startFlicks: z.number().int().min(0).optional(),
	/** Length of the stretch (flicks; default to the media end). At most 30 minutes are analysed. */
	durationFlicks: z.number().int().positive().optional(),
});
export type SyncAudioClip = z.infer<typeof SyncAudioClipSchema>;

export const SyncAudioRequestSchema = z.object({
	projectId: z.string().optional(),
	clips: z.array(SyncAudioClipSchema).min(2).max(32),
	/** Key of the reference recording (default: the first clip). */
	reference: z.string().optional(),
	/** Largest offset considered between the reference and a clip (seconds; default: anything that overlaps). */
	maxOffsetSeconds: z.number().positive().optional(),
});
export type SyncAudioRequest = z.infer<typeof SyncAudioRequestSchema>;

export const SyncAudioResultSchema = z.object({
	key: z.string(),
	/**
	 * This clip's media time at the instant the reference's media time is 0 (flicks): coincident media times satisfy
	 * `t_clip = t_ref + offsetFlicks`. 0 for the reference. Pass these to `clip.synchronize` / `item.mergeClips` /
	 * `multicam.create` as `audioOffsets`.
	 */
	offsetFlicks: z.number().int(),
	/** The lag of the analysed stretches at 48 kHz: clip sample n lines up with reference sample n + lag. */
	lagSamples: z.number().int(),
	/** The same with sub-sample precision. */
	lagFine: z.number(),
	/** Coarse correlation peak over its RMS (≥ 8 for a clear match). Null for the reference. */
	confidence: z.number().nullable(),
	/** Peak over the next-highest peak more than 50 ms away (≥ 1.5: no competing match). Null for the reference. */
	distinct: z.number().nullable(),
	/** Confidence ≥ 8 and distinct ≥ 1.5. */
	reliable: z.boolean(),
	/** One recording has inverted polarity. */
	inverted: z.boolean(),
	/** Set when this clip could not be matched (no audio, silent, no overlap); the other fields are then 0/false. */
	error: z.string().optional(),
});
export type SyncAudioResult = z.infer<typeof SyncAudioResultSchema>;

export const SyncAudioResponseSchema = z.object({
	reference: z.string(),
	sampleRate: z.literal(48000),
	results: z.array(SyncAudioResultSchema),
	/** Wall time of the analysis (ms). */
	elapsedMs: z.number(),
});
export type SyncAudioResponse = z.infer<typeof SyncAudioResponseSchema>;
