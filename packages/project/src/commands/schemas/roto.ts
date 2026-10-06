// Roto / object matte commands (parity workstream `roto`). Handlers: handlers/roto.ts.
import { z } from 'zod';
import { ParamValueSchema, Vec2Schema } from '../../schema/common.ts';
import { RotoResultSchema, RotoSettingsSchema } from '../../schema/sequence.ts';
import { cmd, IdRefSchema, ParamAtSchema, RefDeclSchema } from './common.ts';

/** A stroke as drawn: kind, brush radius and polyline in media pixels (the frame comes from `at`). */
export const RotoStrokeInputSchema = z.strictObject({
	kind: z.enum(['fg', 'bg', 'refine', 'refineErase']),
	radius: z.number().positive().max(10_000),
	points: z.array(Vec2Schema).min(1).max(20_000),
});
/** A point prompt (media px): `fg` false = background. Stored as a one-point stroke. */
export const RotoPointInputSchema = z.strictObject({
	x: z.number(),
	y: z.number(),
	fg: z.boolean().optional(),
	/** Radius (media px) of the hard constraint; default 1 % of the picture's shorter side (≥ 2 px). */
	radius: z.number().positive().max(10_000).optional(),
});
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Span = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
/** Partial settings: only the keys given change. */
const SettingsPatch = RotoSettingsSchema.partial();

export const RotoAddCmd = cmd('roto.add', {
	/** A video or still clip. */
	clipId: IdRefSchema,
	name: z.string().min(1).optional(),
	/** `brush` (Roto Brush: strokes, points, box) or `faces` (face tracking mattes). */
	kind: z.enum(['brush', 'faces']).optional(),
	/** Frame of the strokes / points / box (clip-relative frames, sequence frame, content flicks or timecode). */
	at: ParamAtSchema.optional(),
	strokes: z.array(RotoStrokeInputSchema).optional(),
	points: z.array(RotoPointInputSchema).optional(),
	box: Rect.optional(),
	/** Segmentation span in media frames (inclusive); default: the source frames the clip shows. */
	span: Span.optional(),
	settings: SettingsPatch.optional(),
	ref: RefDeclSchema.optional(),
});
export const RotoUpdateCmd = cmd('roto.update', {
	rotoId: IdRefSchema,
	name: z.string().min(1).optional(),
	span: Span.optional(),
	/** Base frame (media frame inside the span); strokes on other frames are corrections. */
	base: z.number().int().min(0).optional(),
	settings: SettingsPatch.optional(),
});
export const RotoAddStrokesCmd = cmd('roto.addStrokes', {
	rotoId: IdRefSchema,
	at: ParamAtSchema.optional(),
	strokes: z.array(RotoStrokeInputSchema).optional(),
	points: z.array(RotoPointInputSchema).optional(),
});
export const RotoRemoveStrokesCmd = cmd('roto.removeStrokes', {
	rotoId: IdRefSchema,
	/** Only the strokes (and box) of this frame; absent = every frame. */
	at: ParamAtSchema.optional(),
	/** Only these stroke kinds (default all; boxes go with `fg`). */
	kinds: z
		.array(z.enum(['fg', 'bg', 'refine', 'refineErase']))
		.min(1)
		.optional(),
	/** Remove only the last N strokes of the frame (undo-like "remove last stroke"). */
	last: z.number().int().positive().optional(),
});
export const RotoSetBoxCmd = cmd('roto.setBox', {
	rotoId: IdRefSchema,
	at: ParamAtSchema.optional(),
	/** [x0, y0, x1, y1] media px, or null to remove the frame's box. */
	rect: Rect.nullable(),
});
/** Stores the result of a `roto` engine job (or clears it). */
export const RotoSetResultCmd = cmd('roto.setResult', {
	rotoId: IdRefSchema,
	result: RotoResultSchema.nullable(),
});
export const RotoFreezeCmd = cmd('roto.freeze', { rotoId: IdRefSchema, frozen: z.boolean() });
/** Removes roto objects and the Object Matte / Object Blur effects bound to them. */
export const RotoRemoveCmd = cmd('roto.remove', { rotoIds: z.array(IdRefSchema).min(1) });
/** Adds (or updates) an Object Matte (cut out) or Object Blur effect on the roto's clip, bound to it. */
export const RotoApplyCmd = cmd('roto.apply', {
	rotoId: IdRefSchema,
	effect: z.enum(['matte', 'blur']).optional(),
	/** Effect params (values) to set, e.g. `{ view: 'overlay' }` or `{ method: 'mosaic' }`. */
	params: z.record(z.string(), ParamValueSchema).optional(),
	ref: RefDeclSchema.optional(),
});

export const ROTO_COMMANDS = [
	RotoAddCmd,
	RotoUpdateCmd,
	RotoAddStrokesCmd,
	RotoRemoveStrokesCmd,
	RotoSetBoxCmd,
	RotoSetResultCmd,
	RotoFreezeCmd,
	RotoRemoveCmd,
	RotoApplyCmd,
] as const;
