// Masks (wp masks, S03 §17 MSK-001…004): Premiere-style masks on a visual clip's Opacity (`clip.masks`) and on
// every video effect instance (`effect.masks`). Optional fields (no schema-version bump): absent = no masks.
import { z } from 'zod';
import type { DeepStrip } from './common.ts';
import { AnimNumberSchema, animatable, Vec2Schema } from './common.ts';

/** A cubic Bézier path value (see `path/model.ts`): positions and relative tangent handles. */
export const PathVertexSchema = z.looseObject({ p: Vec2Schema, in: Vec2Schema, out: Vec2Schema });
export const FeatherPointSchema = z.looseObject({
	segment: z.number().int().min(0),
	t: z.number().min(0).max(1),
	radius: z.number(),
	tension: z.number().min(0).max(1),
});
export const BezierPathSchema = z.looseObject({
	closed: z.boolean(),
	vertices: z.array(PathVertexSchema),
	feather: z.array(FeatherPointSchema).optional(),
});

/** After Effects' mask modes (Premiere masks always add; the modes combine a layer's masks top to bottom). */
export const MASK_MODES = ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'] as const;
export const MaskModeSchema = z.enum(MASK_MODES);
export type MaskMode = (typeof MASK_MODES)[number];

/** The tool that created the mask (Premiere: ellipse, 4-point polygon, free-draw Bézier pen). Informational. */
export const MASK_SHAPES = ['ellipse', 'polygon', 'bezier'] as const;
export const MaskShapeSchema = z.enum(MASK_SHAPES);
export type MaskShape = (typeof MASK_SHAPES)[number];

/** Premiere's mask tracking methods (+ Perspective: a homography of the mask region). */
export const MASK_TRACK_METHODS = ['position', 'position-rotation', 'position-scale-rotation', 'perspective'] as const;
export const MaskTrackMethodSchema = z.enum(MASK_TRACK_METHODS);
export type MaskTrackMethod = (typeof MASK_TRACK_METHODS)[number];

export const MASK_FEATHER_FALLOFFS = ['smooth', 'linear'] as const;
export type MaskFeatherFalloff = (typeof MASK_FEATHER_FALLOFFS)[number];

/**
 * One mask. `path` is in layer-box-normalised coordinates (0..1 over the layer's intrinsic box, so a resized or
 * replaced source keeps the shape); `feather` and `expansion` are layer pixels; `opacity` is 0..100. All four are
 * animatable (Mask Path keyframes interpolate vertex by vertex, or through smart vertex matching when the counts
 * differ).
 */
export const MaskSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	shape: MaskShapeSchema.optional(),
	mode: MaskModeSchema,
	inverted: z.boolean(),
	path: animatable(BezierPathSchema),
	feather: AnimNumberSchema,
	opacity: AnimNumberSchema,
	expansion: AnimNumberSchema,
	/** Absent = smooth. */
	featherFalloff: z.enum(MASK_FEATHER_FALLOFFS).optional(),
	/** Absent = position-scale-rotation (Premiere's default). */
	trackMethod: MaskTrackMethodSchema.optional(),
	/** The monitor does not edit a locked mask. */
	locked: z.boolean().optional(),
});
export type Mask = DeepStrip<z.infer<typeof MaskSchema>>;
export type BezierPathValue = DeepStrip<z.infer<typeof BezierPathSchema>>;
