import { z } from 'zod';

/** Longest music range the Remix analyses (seconds). */
export const MAX_REMIX_SOURCE_SECONDS = 30 * 60;

export const RemixPlanRequestSchema = z.strictObject({
	mediaKey: z.string().min(1),
	/** Audio stream of the media (default: the first audio stream). */
	streamIndex: z.number().int().min(0).optional(),
	/** The clip's content range (seconds of media time): its intro and outro are kept. */
	startSeconds: z.number().min(0),
	/**
	 * At most 30 min: the analysis holds the decoded range (22.05 kHz mono) and a beats² similarity matrix, which
	 * for hours of audio would exhaust the engine's memory (≈ 3 GB per hour at 200 BPM).
	 */
	durationSeconds: z.number().positive().max(MAX_REMIX_SOURCE_SECONDS),
	targetSeconds: z
		.number()
		.positive()
		.max(4 * 3600),
	segments: z.number().min(0).max(100).optional(),
	variations: z.number().min(0).max(100).optional(),
});
export type RemixPlanRequest = z.infer<typeof RemixPlanRequestSchema>;

export const RemixPlanResultSchema = z.object({
	bpm: z.number(),
	/** Beat positions (seconds from the range start). */
	beats: z.array(z.number()),
	/** Pieces in output order (seconds from the range start). */
	pieces: z.array(z.object({ srcSeconds: z.number(), lenSeconds: z.number() })),
	/** Output length of the plan (seconds). */
	lengthSeconds: z.number(),
	/** Crossfade at each joint (seconds). */
	crossfadeSeconds: z.number(),
	/** Source position of each joint: [end of the outgoing piece, start of the incoming one] (seconds). */
	cuts: z.array(z.tuple([z.number(), z.number()])),
});
export type RemixPlanResult = z.infer<typeof RemixPlanResultSchema>;

/** Longest music range `POST /api/audio/beats` analyses at once (seconds). */
export const MAX_BEATS_SOURCE_SECONDS = 30 * 60;

/**
 * `POST /api/audio/beats` (spec 12 §2.8; wp-note "Phase 6 → WP6.2"): tempo, beats and (when one beat in four is clearly
 * accented) downbeats of a media's audio over a range, with the Remix tool's beat tracker (`analyzeBeats`). Cached per
 * media file and range. Sound Design's beat cues come from it.
 */
export const BeatsRequestSchema = z.strictObject({
	mediaKey: z.string().min(1).max(256),
	/** Audio stream of the media (default: the first audio stream). */
	streamIndex: z.number().int().min(0).max(1000).optional(),
	/** Media seconds where the range starts. */
	startSeconds: z.number().min(0).max(864_000),
	/** At most 30 min (the analysis holds the decoded range, 22.05 kHz mono). */
	durationSeconds: z.number().positive().max(MAX_BEATS_SOURCE_SECONDS),
});
export type BeatsRequest = z.infer<typeof BeatsRequestSchema>;

export const BeatsResultSchema = z.object({
	/** Tempo; null when the audio has no usable pulse (`reason`). */
	bpm: z.number().nullable(),
	/** Attack of each beat, media seconds (ascending). */
	beats: z.array(z.number()),
	/** The accented beats (media seconds), or null when no beat in four is clearly accented. */
	downbeats: z.array(z.number()).nullable(),
	/** How clear the downbeat accent is (0…1). */
	downbeatConfidence: z.number(),
	startSeconds: z.number(),
	durationSeconds: z.number(),
	/** Seconds of audio decoded (shorter than asked when the media ends earlier). */
	analysedSeconds: z.number(),
	/** Why there are no beats: NO_BEAT (no pulse, or fewer than 4 beats). */
	reason: z.enum(['NO_BEAT']).optional(),
	/** Served from the cache. */
	cached: z.boolean(),
});
export type BeatsResult = z.infer<typeof BeatsResultSchema>;
