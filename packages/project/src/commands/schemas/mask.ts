// Mask commands (wp masks, S03 §17 MSK-001…004). Handlers: handlers/mask.ts.
//
// Masks live on a visual clip's Opacity (`clipId`) or on one of its video effect instances (`effectId`). Paths are
// in layer-box-normalised coordinates (0..1 over the clip's intrinsic box); feather / expansion are layer pixels.
// Mask properties are also ordinary animatable parameters: `param.set` / `param.setAnimated` / `keyframe.*` with
// the ParamPath `["mask", maskId, "path" | "feather" | "opacity" | "expansion"]`.
import { z } from 'zod';
import { Vec2Schema } from '../../schema/common.ts';
import {
	BezierPathSchema,
	FeatherPointSchema,
	MASK_FEATHER_FALLOFFS,
	MaskModeSchema,
	MaskShapeSchema,
	MaskTrackMethodSchema,
} from '../../schema/mask.ts';
import { cmd, IdRefSchema, ParamAtSchema, RefDeclSchema } from './common.ts';

const VertexIndices = z.array(z.number().int().min(0)).min(1);

export const MaskAddCmd = cmd('mask.add', {
	/** Opacity mask of this clip (exactly one of clipId / effectId). */
	clipId: IdRefSchema.optional(),
	/** Mask of this effect instance (a video effect on a clip). */
	effectId: IdRefSchema.optional(),
	/** Tool: ellipse / 4-point polygon create a centred default shape; bezier (pen) needs `path`. */
	shape: MaskShapeSchema,
	/** Explicit path (normalised layer coordinates); default: the tool's centred shape. */
	path: BezierPathSchema.optional(),
	name: z.string().min(1).optional(),
	mode: MaskModeSchema.optional(),
	inverted: z.boolean().optional(),
	/** Layer px (default 10, Premiere). */
	feather: z.number().min(0).optional(),
	/** 0..100 (default 100). */
	opacity: z.number().min(0).max(100).optional(),
	/** Layer px (default 0). */
	expansion: z.number().optional(),
	featherFalloff: z.enum(MASK_FEATHER_FALLOFFS).optional(),
	trackMethod: MaskTrackMethodSchema.optional(),
	/** Position in the owner's mask list (default: last). */
	index: z.number().int().min(0).optional(),
	ref: RefDeclSchema.optional(),
});

export const MaskRemoveCmd = cmd('mask.remove', { maskIds: z.array(IdRefSchema).min(1) });

export const MaskUpdateCmd = cmd('mask.update', {
	maskId: IdRefSchema,
	name: z.string().min(1).optional(),
	mode: MaskModeSchema.optional(),
	inverted: z.boolean().optional(),
	featherFalloff: z.enum(MASK_FEATHER_FALLOFFS).optional(),
	trackMethod: MaskTrackMethodSchema.optional(),
	locked: z.boolean().optional(),
});

/** Moves a mask within its owner's list (masks combine top to bottom). */
export const MaskReorderCmd = cmd('mask.reorder', { maskId: IdRefSchema, index: z.number().int().min(0) });

/** Copies masks (new ids, keyframes included) right after the originals, or onto another owner. */
export const MaskDuplicateCmd = cmd('mask.duplicate', {
	maskIds: z.array(IdRefSchema).min(1),
	/** Paste target (Premiere: copy a mask and paste it on another effect or clip); default: the same owner. */
	toClipId: IdRefSchema.optional(),
	toEffectId: IdRefSchema.optional(),
});

const MaskPathOpSchema = z.discriminatedUnion('op', [
	/** Replace the whole path at `at`. */
	z.strictObject({ op: z.literal('set'), path: BezierPathSchema }),
	/** Move vertices (and their handles) by `delta` (normalised units). */
	z.strictObject({ op: z.literal('moveVertices'), vertices: VertexIndices, delta: Vec2Schema }),
	/**
	 * Set one vertex: position and/or absolute handles (relative to the vertex). `breakHandles` false (default) keeps
	 * a smooth vertex smooth: setting one handle mirrors the other's direction (keeping its length).
	 */
	z.strictObject({
		op: z.literal('setVertex'),
		vertex: z.number().int().min(0),
		p: Vec2Schema.optional(),
		in: Vec2Schema.optional(),
		out: Vec2Schema.optional(),
		breakHandles: z.boolean().optional(),
	}),
	/**
	 * Similarity transform of the whole path (or of `vertices`) about `origin` (default: the vertices' centroid):
	 * scale (uniform or [x, y]), rotation (degrees, clockwise on screen: computed in layer pixels), then translate
	 * (normalised units).
	 */
	z.strictObject({
		op: z.literal('transform'),
		vertices: VertexIndices.optional(),
		origin: Vec2Schema.optional(),
		translate: Vec2Schema.optional(),
		scale: z.union([z.number(), Vec2Schema]).optional(),
		rotation: z.number().optional(),
	}),
	/** Corner ↔ smooth (Premiere's Convert Vertex: Alt-click). */
	z.strictObject({ op: z.literal('convert'), vertices: VertexIndices, to: z.enum(['smooth', 'corner']) }),
	/** Insert a vertex on segment `segment` at Bézier parameter `t` (all keyframes; the outline is unchanged). */
	z.strictObject({
		op: z.literal('insertVertex'),
		segment: z.number().int().min(0),
		t: z.number().gt(0).lt(1),
	}),
	/** Delete vertices (all keyframes; a closed mask keeps at least 3). */
	z.strictObject({ op: z.literal('removeVertices'), vertices: VertexIndices }),
	/** Append a vertex at the end of an open pen path (all keyframes), with optional handles. */
	z.strictObject({
		op: z.literal('appendVertex'),
		p: Vec2Schema,
		in: Vec2Schema.optional(),
		out: Vec2Schema.optional(),
	}),
	/** Close or open the path (all keyframes). */
	z.strictObject({ op: z.literal('setClosed'), closed: z.boolean() }),
	/** Variable feather: add a feather point (all keyframes). Radius layer px: > 0 outer, < 0 inner. */
	z.strictObject({ op: z.literal('addFeatherPoint'), point: FeatherPointSchema }),
	/** Variable feather: edit a feather point at `at` (radius / tension / position on its segment). */
	z.strictObject({
		op: z.literal('setFeatherPoint'),
		index: z.number().int().min(0),
		radius: z.number().optional(),
		tension: z.number().min(0).max(1).optional(),
		t: z.number().min(0).max(1).optional(),
	}),
	/** Variable feather: remove feather points (all keyframes). */
	z.strictObject({ op: z.literal('removeFeatherPoints'), indices: VertexIndices }),
]);
export type MaskPathOp = z.infer<typeof MaskPathOpSchema>;

/**
 * Geometry edits of a mask path. Shape edits (set, moveVertices, setVertex, transform, convert, setFeatherPoint)
 * change the path at `at` (a keyframe when the path is animated, the static value otherwise — the stopwatch rule)
 * or, with `allKeyframes`, every keyframe; topology edits (insert / remove / append vertex, close, feather points
 * added / removed) apply to the value and every keyframe so all keys keep matching vertices.
 */
export const MaskEditPathCmd = cmd('mask.editPath', {
	maskId: IdRefSchema,
	at: ParamAtSchema.optional(),
	allKeyframes: z.boolean().optional(),
	ops: z.array(MaskPathOpSchema).min(1),
});

/**
 * Writes Mask Path keyframes in bulk (mask tracking results, imports). `at` per key (content time of the owning
 * clip); existing keys at those times are replaced. `clearSpan`: also delete other path keys strictly inside the
 * span of the written keys (re-tracking a range).
 */
export const MaskSetPathKeysCmd = cmd('mask.setPathKeys', {
	maskId: IdRefSchema,
	keys: z
		.array(z.strictObject({ at: ParamAtSchema, path: BezierPathSchema }))
		.min(1)
		.max(100_000),
	clearSpan: z.boolean().optional(),
});

export const MASK_COMMANDS = [
	MaskAddCmd,
	MaskRemoveCmd,
	MaskUpdateCmd,
	MaskReorderCmd,
	MaskDuplicateCmd,
	MaskEditPathCmd,
	MaskSetPathKeysCmd,
] as const;
