// The 3D Camera Tracker (parity workstream `three-d`, docs/wp-notes/three-d.md). Owner: three-d.
//
// `POST /api/camtrack/solve` → EngineJob (kind `camtrack`): tracks features through a span of a video's frames and
// solves the camera that filmed them (and the lens: focal length, optionally radial distortion), with the 3D points of
// the tracked features. The result is committed to the clip's `cameraTracker` with `cameraTracker.setResult`.
import { z } from 'zod';
import { RationalSchema } from './common.ts';

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** 3D Camera Tracker ▸ Shot Type / Solve Method. */
export const CAMTRACK_SHOT_TYPES = ['fixed', 'variable', 'specify'] as const;
export const CAMTRACK_SOLVE_METHODS = ['auto', 'typical', 'flat', 'tripod'] as const;

export const CamTrackSettingsWireSchema = z.object({
	shot: z.enum(CAMTRACK_SHOT_TYPES),
	/** Horizontal angle of view (degrees) for `specify`. */
	hfov: z.number().min(1).max(170),
	method: z.enum(CAMTRACK_SOLVE_METHODS),
	/** Detailed Analysis: more features at a larger analysis size (slower). */
	detailed: z.boolean(),
	/** Solve radial lens distortion (k1, k2) with the camera. */
	lensDistortion: z.boolean(),
});
export type CamTrackSettingsWire = z.infer<typeof CamTrackSettingsWireSchema>;

export const CamTrackSolveRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string().min(1),
	/** Echoed in the result (the clip and tracker the client commits it to). */
	clipId: z.string().optional(),
	trackerId: z.string().optional(),
	/** Inclusive media frames (at the media's own frame rate). */
	span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
	settings: CamTrackSettingsWireSchema,
	/** Feature track ids to leave out of the solve (deleted track points); the cached tracks are reused. */
	deleted: z.array(z.number().int().min(0)).max(100_000).optional(),
});
export type CamTrackSolveRequest = z.infer<typeof CamTrackSolveRequestSchema>;

/** A solved 3D track point: canonical solve space, mean reprojection error (px), first / last media frame tracked. */
export const CamTrackPointSchema = z.object({
	id: z.number().int().min(0),
	pos: Vec3,
	error: z.number().min(0),
	first: z.number().int().min(0),
	last: z.number().int().min(0),
});
export type CamTrackPoint = z.infer<typeof CamTrackPointSchema>;

/**
 * `EngineJob.result` of a `camtrack` job. Cameras are in the canonical solve space: the first solved frame's camera at
 * the origin looking along +z (x right, y down), scaled so the median depth of the points it sees is 1. `frames` holds
 * 8 numbers per media frame of the span: the world → camera rotation as an axis-angle vector (3), the camera centre
 * (3), the focal length in media pixels, and 1 / 0 = solved / interpolated.
 */
export const CamTrackResultSchema = z.object({
	clipId: z.string().optional(),
	trackerId: z.string().optional(),
	mediaKey: z.string(),
	span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
	rate: RationalSchema,
	/** Display size of the media (pixels the solve is in). */
	size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
	shot: z.enum(CAMTRACK_SHOT_TYPES),
	methodUsed: z.enum(['typical', 'flat', 'tripod']),
	/** Average reprojection error (pixels). */
	averageError: z.number().min(0),
	frames: z.array(z.number()),
	points: z.array(CamTrackPointSchema),
	distortion: z.object({ k1: z.number(), k2: z.number(), radius: z.number() }).nullable(),
	/** Feature tracks found (before the solve kept its points). */
	tracks: z.number().int().min(0),
	method: z.string(),
});
export type CamTrackResult = z.infer<typeof CamTrackResultSchema>;
