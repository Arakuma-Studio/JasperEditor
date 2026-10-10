// Tracking contracts (M2, S09, ARCHITECTURE §19.5). Owner: wp-m2-track.
import { z } from 'zod';
import { RationalSchema } from './common.ts';

const Vec2 = z.tuple([z.number(), z.number()]);

/** `POST /api/tracking/track` → EngineJob (kind `track`). Frames are source frames of the media. */
export const TrackRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string(),
	/** wp masks: `mask` follows the pixels inside `reference.polygon` frame to frame (Premiere's mask tracking). */
	kind: z.enum(['point', 'planar', 'mask']),
	/** Reference frame (source frame index) and geometry in media pixels. */
	reference: z.object({
		frame: z.number().int().min(0),
		corners: z.array(Vec2).length(4).optional(),
		/** wp masks (kind `mask`): the mask outline (flattened, closed) in media pixels at the reference frame. */
		polygon: z.array(Vec2).min(3).max(20_000).optional(),
		point: Vec2.optional(),
		patch: z.number().int().positive().optional(),
		search: z.number().int().positive().optional(),
	}),
	/** Source frames to track, inclusive start, exclusive end; must contain the reference frame. */
	range: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }),
	direction: z.enum(['forward', 'backward', 'both']).default('both'),
	/** Tracker quality/speed trade-off. */
	quality: z.enum(['fast', 'balanced', 'best']).default('balanced'),
	/**
	 * wp-m2-track (additive): the document tracker this job is for. Echoed in `tracking.progress` events so the
	 * Program overlay can draw the live track of the right tracker.
	 */
	trackerId: z.string().optional(),
	/** wp-m2-track (additive): planar tracker options. */
	options: z
		.object({
			/**
			 * Where planar features come from: `inside` the quad (default; the plane's own texture), `surroundings`
			 * (a ring 5–25 % of the quad size outside it: screens whose content changes) or `both`.
			 */
			features: z.enum(['inside', 'surroundings', 'both']).optional(),
			/**
			 * Snap the quad's sides to the strongest straight luminance edges near them on every frame (screen
			 * bezels, sign borders): sub-pixel line fits intersected into corners. Sides that leave the frame keep the
			 * tracked line.
			 */
			refineEdges: z.boolean().optional(),
			/**
			 * wp masks (kind `mask`): the motion model — Position, Position & Rotation, Position, Scale & Rotation
			 * (Premiere's methods) or Perspective (a homography).
			 */
			maskMethod: z
				.enum(['position', 'position-rotation', 'position-scale-rotation', 'perspective'])
				.optional(),
		})
		.optional(),
});
export type TrackRequest = z.infer<typeof TrackRequestSchema>;

/**
 * `EngineJob.result` of a `track` job: dense samples over `range` in media pixels. The client converts frames to
 * content flicks (`start = startFrame·flicksPerFrame(mediaRate)`) and commits `tracker.setSamples`.
 */
export const TrackResultSchema = z.object({
	startFrame: z.number().int().min(0),
	/** Media frame rate the frames refer to. */
	fps: RationalSchema,
	/**
	 * Values per frame: point 2, planar 8, mask 9 (wp masks: the row-major homography from the reference frame's
	 * media px to the frame's media px; the client maps the mask path through it).
	 */
	stride: z.union([z.literal(2), z.literal(8), z.literal(9)]),
	data: z.array(z.number()),
	confidence: z.array(z.number().min(0).max(1)),
	method: z.string(),
	/** Frames where tracking was lost (confidence 0). */
	lost: z.array(z.number().int()),
	/** wp-m2-track (additive): echo of the request's tracker id. */
	trackerId: z.string().optional(),
	/** wp-m2-track (additive): frames tracked per second (TRK-014 budget). */
	framesPerSec: z.number().optional(),
});
export type TrackResult = z.infer<typeof TrackResultSchema>;

/**
 * wp-m2-track (additive): payload of the `tracking.progress` engine event (published on `GET /events` about 10 times
 * per second while a track job runs; clients receive it as a raw envelope). `data` holds the current frame's
 * geometry in media pixels (planar: 8 numbers TL, TR, BR, BL; point: 2).
 */
export const TRACKING_PROGRESS_EVENT = 'tracking.progress';
export const TrackProgressSchema = z.object({
	jobId: z.string(),
	trackerId: z.string().optional(),
	mediaKey: z.string(),
	/** Source frame the geometry belongs to. */
	frame: z.number().int().min(0),
	data: z.array(z.number()),
	confidence: z.number().min(0).max(1),
	/** Frames tracked so far / to track. */
	done: z.number().int().min(0),
	total: z.number().int().min(0),
});
export type TrackProgress = z.infer<typeof TrackProgressSchema>;
