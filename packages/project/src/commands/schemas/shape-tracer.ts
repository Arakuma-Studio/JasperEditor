// Trim tracer (path-trace): a follower clip whose Position (and optionally Rotation) is an expression riding the
// moving tip of a Trim Paths. docs/wp-notes/expressions.md § Path methods and the trim tracer.
import { z } from 'zod';
import { cmd, IdRefSchema, RefDeclSchema } from './common.ts';

/**
 * Makes a follower clip ride the moving tip of a Trim Paths: its Position (and Rotation with `orient`) becomes an
 * expression that computes the tip in sequence pixels at every frame — the trim's Start / End and Offset at that time
 * (Offset wraps by whole lengths, Simultaneously / Individually as rendered), through the trim's group transforms and
 * the shape clip's Motion. Without `follower` a small dot shape clip ("Tracer") is created on the track above the shape
 * clip (a new track when that one is locked or busy) over the same time span. An existing expression on the follower's
 * Position / Rotation is replaced (warning W_EXPRESSION_REPLACED). The expressions address the clip and items by id.
 */
export const ShapeAddTrimTracerCmd = cmd('shape.addTrimTracer', {
	clipId: IdRefSchema.describe('Vector shape clip holding the Trim Paths'),
	trimItemId: z.string().min(1).describe('Trim Paths item to follow'),
	pathItemId: IdRefSchema.optional().describe(
		'Path the tracer follows: one of the paths the trim affects (default: the first, in stacking order). ' +
			'An Individually trim measures all its paths laid end to end, so its tracer follows all of them.',
	),
	tip: z
		.enum(['start', 'end', 'auto'])
		.optional()
		.describe(
			'Which end of the trimmed stroke to follow; auto (default) = the one whose keyframes change most (End on a tie)',
		),
	follower: z
		.strictObject({ clipId: IdRefSchema.describe('Visual clip of the same sequence to drive') })
		.optional()
		.describe('Existing clip to drive instead of creating a dot'),
	orient: z
		.boolean()
		.optional()
		.describe('Also rotate the follower along the path (its own Rotation adds); default false'),
	name: z.string().min(1).max(200).optional().describe('Name of the created follower (default "Tracer")'),
	ref: RefDeclSchema.optional().describe('Binds the follower clip id'),
});

export const SHAPE_TRACER_COMMANDS = [ShapeAddTrimTracerCmd] as const;
