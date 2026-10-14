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
