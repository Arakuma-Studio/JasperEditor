// Spec 19 TL-115: a still into its connected parts as separate clips, one undo step. The engine cuts and registers the
// parts' pictures; the command replaces the clip by one clip per part.
import { z } from 'zod';
import { cmd, IdRefSchema, RefDeclSchema } from './common.ts';

/** Most parts of one split: each is a clip on a track of its own (`E_LIMIT` above). */
export const MAX_SPLIT_CLIPS = 64;

export const ClipSplitImageCmd = cmd('clip.splitImage', {
	clipId: IdRefSchema,
	/** One entry per part, left to right; `box` is its pixel box in the clip's picture. */
	parts: z
		.array(
			z.strictObject({
				mediaId: IdRefSchema,
				box: z.strictObject({
					x: z.number().int().min(0),
					y: z.number().int().min(0),
					w: z.number().int().min(1),
					h: z.number().int().min(1),
				}),
				name: z.string().min(1).max(200).optional(),
			}),
		)
		.min(2)
		.max(10_000),
	ref: RefDeclSchema.optional(),
});

export const IMAGE_SPLIT_COMMANDS = [ClipSplitImageCmd] as const;
