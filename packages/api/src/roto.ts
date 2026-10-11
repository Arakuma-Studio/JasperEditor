import { RotoStrokeSchema } from '@jasper/project';
import { z } from 'zod';
import { RationalSchema } from './common.ts';
import { TracedMaskPathSchema } from './masks.ts';

/** A roto stroke as stored in the document (media px, media frame). */
export const RotoStrokeWireSchema = z.object({
	...RotoStrokeSchema.shape,
	points: RotoStrokeSchema.shape.points.max(20_000),
});

/** Resolved segmentation settings (`rotoSettingsOf`). */
export const RotoSettingsWireSchema = z.object({
	engine: z.enum(['model', 'classic']),
	model: z.string(),
	quality: z.enum(['standard', 'best']),
	searchRadius: z.number().min(0).max(200),
	motionThreshold: z.number().min(0).max(100),
	motionDamping: z.number().min(0).max(100),
	edgeMode: z.enum(['off', 'guided', 'closed-form']),
	edgeRadius: z.number().min(0).max(100),
	edgeSmooth: z.number().min(0).max(100),
	faceThreshold: z.number().min(0.05).max(0.99),
	faceExpand: z.number().min(-50).max(200),
	faceShape: z.enum(['outline', 'ellipse']),
});

/**
 * `POST /api/roto/segment` → EngineJob (kind `roto`). Computes the mattes of one roto object of a media:
 * `brush` = Roto Brush segmentation from the base frame and propagation through the span (frames that were already
 * computed for the same inputs are reused); `faces` = face detection and landmark tracking over the span.
 */
export const RotoSegmentRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string().min(1),
	/** Document roto id (echoed in progress events). */
	rotoId: z.string().optional(),
	/** `rotoInputsHash` of the roto (recorded in the result; the client checks it for staleness). */
	inputs: z.string(),
	roto: z.object({
		kind: z.enum(['brush', 'faces']),
		rate: RationalSchema,
		base: z.number().int().min(0).nullable(),
		span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
		strokes: z.array(RotoStrokeWireSchema).max(5000),
		boxes: z
			.array(
				z.object({
					frame: z.number().int().min(0),
					rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
				}),
			)
			.max(1000)
			.optional(),
		settings: RotoSettingsWireSchema,
	}),
	/**
	 * Which frames: `both` (default: the whole span from the base), `forward` (base → end), `backward` (base →
	 * start), or `frame` (just `frame`, propagated from the nearest computed frame; interactive previews).
	 */
	direction: z.enum(['both', 'forward', 'backward', 'frame']).default('both'),
	frame: z.number().int().min(0).optional(),
});
export type RotoSegmentRequest = z.infer<typeof RotoSegmentRequestSchema>;

/** A tracked face over the computed frames (faces rotos). Poses in media px; angle radians clockwise. */
export const RotoFaceTrackSchema = z.object({
	id: z.number().int().min(0),
	startFrame: z.number().int().min(0),
	/** Per frame from `startFrame`, 4 numbers: cx, cy, size (forehead → chin), angle; `present` 0 = lost (held). */
	poses: z.array(z.number()),
	present: z.array(z.number().int().min(0).max(1)),
});
export type RotoFaceTrack = z.infer<typeof RotoFaceTrackSchema>;

/**
 * `EngineJob.result` of a `roto` job: the matte store (`roto.setResult` takes `{key, start, end, width, height,
 * inputs, model}`) plus statistics, and the face tracks of a faces roto.
 */
export const RotoSegmentResultSchema = z.object({
	key: z.string(),
	start: z.number().int().min(0),
	end: z.number().int().min(0),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	inputs: z.string(),
	model: z.string().nullable(),
	rotoId: z.string().optional(),
	/** Frames computed by this job / reused from earlier jobs. */
	computed: z.number().int().min(0),
	reused: z.number().int().min(0),
	/** Frames where the trained model was used (the rest: colour models only). */
	modelFrames: z.number().int().min(0),
	/** Foreground area per frame (fraction of the picture), `start`…`end`. */
	area: z.array(z.number().min(0).max(1)),
	faces: z.array(RotoFaceTrackSchema).optional(),
	framesPerSec: z.number().optional(),
});
export type RotoSegmentResult = z.infer<typeof RotoSegmentResultSchema>;

/** Live progress (`roto.progress` events): the frame just computed and its matte URL (preview overlay). */
export const ROTO_PROGRESS_EVENT = 'roto.progress';
export const RotoProgressSchema = z.object({
	jobId: z.string(),
	rotoId: z.string().optional(),
	mediaKey: z.string(),
	frame: z.number().int().min(0),
	done: z.number().int().min(0),
	total: z.number().int().min(0),
	area: z.number().min(0).max(1),
});
export type RotoProgress = z.infer<typeof RotoProgressSchema>;

/** A segmentation / face model of the catalogue (`vision` list of processing/models.json). */
export const VisionModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	task: z.enum(['segmentation', 'face']),
	description: z.string(),
	license: z.string(),
	licenseUrl: z.string(),
	attribution: z.string(),
	sourceUrl: z.string(),
	revision: z.string(),
	sizeBytes: z.number().int().min(0),
	installed: z.boolean(),
	missingBytes: z.number().int().min(0),
});
export type VisionModel = z.infer<typeof VisionModelSchema>;
export const VisionModelsResponseSchema = z.object({ models: z.array(VisionModelSchema) });

/** `GET /api/roto/:key/info` — what a matte store holds. */
export const RotoStoreInfoSchema = z.object({
	key: z.string(),
	start: z.number().int(),
	end: z.number().int(),
	width: z.number().int(),
	height: z.number().int(),
	frames: z.number().int(),
});
export type RotoStoreInfo = z.infer<typeof RotoStoreInfoSchema>;

/** `POST /api/roto/trace`: auto-traces frames of a matte set into mask paths (Convert to Masks). */
export const RotoTraceRequestSchema = z.object({
	key: z.string().regex(/^[0-9a-f]{32}$/),
	frames: z.array(z.number().int().min(0)).min(1).max(5000),
	threshold: z.number().min(0).max(1).default(0.5),
	/** Douglas–Peucker tolerance (matte px). */
	tolerance: z.number().min(0.01).max(100).default(1.5),
	minArea: z.number().min(0).default(40),
	cornerRoundness: z.number().min(0).max(1).default(0.6),
	maxPaths: z.number().int().min(1).max(100).default(20),
});
export type RotoTraceRequest = z.infer<typeof RotoTraceRequestSchema>;

export const RotoTraceResponseSchema = z.object({
	frames: z.array(
		z.object({
			frame: z.number().int(),
			/** Paths normalised to the picture (0..1, = the clip's layer box); depth odd = a hole. */
			paths: z.array(TracedMaskPathSchema),
		}),
	),
});
export type RotoTraceResponse = z.infer<typeof RotoTraceResponseSchema>;
