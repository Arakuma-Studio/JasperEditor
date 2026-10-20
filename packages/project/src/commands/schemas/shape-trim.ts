// One-click Trim Paths animations and their helpers (docs/wp-notes/shapes.md § Trim Paths animations).
import { z } from 'zod';
import { CubicEaseSchema } from '../../ease/curve.ts';
import { SHAPE_LIMITS } from '../../registry/properties.ts';
import { TRIM_ANIMATION_LIMITS, TRIM_ANIMATION_STYLES } from '../../vector/trim-animate.ts';
import { cmd, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

const ClipIds = z
	.array(IdRefSchema)
	.min(1)
	.max(1000)
	.describe('Shape clips (rectangle / ellipse clips are converted to vector shapes first)');

/**
 * Animates Trim Paths on each clip: one trim at the end of the clip's top-level contents (it trims every path), keys
 * at `at` (default: each clip's start) over `durationFrames` sequence frames. Styles (u = position along the path,
 * p = eased progress): `in` draws on from the path start ([0, p]; reverse from the end), `out` erases from the start
 * ([p, 1]; reverse from the end), `inOut` draws on then wipes off (the tail starts `inOutLag · durationFrames`
 * later), `middleIn` grows from the middle (reverse: from both ends inward), `middleOut` shrinks to the middle
 * (reverse: towards both ends), `divideIn` / `divideOut` split the contents into `copies` parts drawing on / off
 * together. `animateOffset` also turns the Offset by `offsetDegrees` (negative with `reverse`). `curve` replaces the
 * default eases (entering: cubic-bezier(⅓, ⅓, ⅔, 1); exiting: cubic-bezier(⅓, 0, ⅔, ⅔)). Running it again on a clip
 * replaces the earlier animation (the last top-level trim is reused; earlier parts are merged back). Clips that
 * cannot hold a trim are skipped with W_TRIM_SKIPPED.
 */
export const ShapeAnimateTrimCmd = cmd('shape.animateTrim', {
	clipIds: ClipIds,
	style: z.enum(TRIM_ANIMATION_STYLES),
	reverse: z.boolean().optional(),
	animateOffset: z.boolean().optional(),
	/** Default 10. */
	durationFrames: z.number().int().min(1).max(TRIM_ANIMATION_LIMITS.durationFrames).optional(),
	/** Default 180 (half a turn = half the path length). */
	offsetDegrees: z
		.number()
		.min(-TRIM_ANIMATION_LIMITS.offsetDegrees)
		.max(TRIM_ANIMATION_LIMITS.offsetDegrees)
		.optional(),
	/** Divide styles: number of parts (default 4). */
	copies: z
		.number()
		.int()
		.min(TRIM_ANIMATION_LIMITS.minCopies)
		.max(TRIM_ANIMATION_LIMITS.maxCopies)
		.optional(),
	/** inOut: delay of the tail as a fraction of `durationFrames` (default 0.5). */
	inOutLag: z.number().min(0).max(1).optional(),
	/** Sequence time of the first key (default: each clip's start). */
	at: TimeInputSchema.optional(),
	curve: CubicEaseSchema.optional(),
});

/** Toggles the Path Direction (normal ↔ reversed) of every path item of each vector shape clip, at all depths. */
export const ShapeReversePathDirectionCmd = cmd('shape.reversePathDirection', {
	clipIds: ClipIds.describe('Vector shape clips'),
});

const unit = z.number().min(0).max(1);

/**
 * A vector shape clip holding one straight open path, stroked only, centred in the frame; the clip's anchor is the
 * line's centre. `length` defaults to 60 % of the frame width (horizontal) or height (vertical).
 */
export const ShapeAddLineCmd = cmd('shape.addLine', {
	sequenceId: IdRefSchema.optional(),
	orientation: z.enum(['horizontal', 'vertical']),
	length: z.number().gt(0).max(SHAPE_LIMITS.size).optional(),
	/** Default 8 px. */
	strokeWidth: z.number().gt(0).max(SHAPE_LIMITS.strokeWidth).optional(),
	/** Default white. */
	color: z.tuple([unit, unit, unit, unit]).optional(),
	/** Default frame 0. */
	at: TimeInputSchema.optional(),
	/** Default 5 s. */
	durationFrames: z.number().int().min(1).max(10_000_000).optional(),
	/** Default: the top video track when it is free over the range, else a new track on top. */
	trackId: TrackRefSchema.optional(),
	name: z.string().min(1).max(200).optional(),
	ref: RefDeclSchema.optional(),
});

export const SHAPE_TRIM_COMMANDS = [
	ShapeAnimateTrimCmd,
	ShapeReversePathDirectionCmd,
	ShapeAddLineCmd,
] as const;
