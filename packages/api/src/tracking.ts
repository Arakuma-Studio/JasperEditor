// Tracking contracts (M2, S09, ARCHITECTURE §19.5). Owner: wp-m2-track.
import { z } from 'zod';

const Vec2 = z.tuple([z.number(), z.number()]);

/** `POST /api/tracking/track` → EngineJob (kind `track`). Frames are source frames of the media. */
export const TrackRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string(),
	kind: z.enum(['point', 'planar']),
	/** Reference frame (source frame index) and geometry in media pixels. */
	reference: z.object({
		frame: z.number().int().min(0),
		corners: z.array(Vec2).length(4).optional(),
		point: Vec2.optional(),
		patch: z.number().int().positive().optional(),
		search: z.number().int().positive().optional(),
	}),
	/** Source frames to track, inclusive start, exclusive end; must contain the reference frame. */
	range: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }),
	direction: z.enum(['forward', 'backward', 'both']).default('both'),
	/** Tracker quality/speed trade-off. */
	quality: z.enum(['fast', 'balanced', 'best']).default('balanced'),
});
export type TrackRequest = z.infer<typeof TrackRequestSchema>;

/**
 * `EngineJob.result` of a `track` job: dense samples over `range` in media pixels. The client converts frames to
 * content flicks (`start = startFrame·flicksPerFrame(mediaRate)`) and commits `tracker.setSamples`.
 */
export const TrackResultSchema = z.object({
	startFrame: z.number().int().min(0),
	/** Media frame rate the frames refer to. */
	fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
	stride: z.union([z.literal(2), z.literal(8)]),
	data: z.array(z.number()),
	confidence: z.array(z.number().min(0).max(1)),
	method: z.string(),
	/** Frames where tracking was lost (confidence 0). */
	lost: z.array(z.number().int()),
});
export type TrackResult = z.infer<typeof TrackResultSchema>;
