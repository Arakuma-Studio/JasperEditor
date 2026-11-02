// Spec 19 TL-087: `POST /api/title-looks/poster`, a look's thumbnail from the real render path. The answer is a PNG;
// the recipe is checked by `look.apply` in the engine, so a limit overflow answers like the command would.
import { COLOR_ROLES, LookColorSchema } from '@jasper/project';
import { z } from 'zod';

/** Poster sizes the engine renders (16:9, px): a cache key per tile size, not per panel width. */
export const LOOK_POSTER_WIDTHS = [240, 360, 540] as const;

const PosterRoles = z.partialRecord(z.enum(COLOR_ROLES), LookColorSchema);

export const LookPosterRequestSchema = z.strictObject({
	/** The look as authored (`LookRecipe`). */
	recipe: z.unknown(),
	/** Role values over the recipe's palette: a colourway. */
	palette: PosterRoles.optional(),
	/** Sample text: the selected title's own, or the panel's. */
	text: z.string().trim().min(1).max(160),
	/** The title's font, when it has one the render should use. */
	font: z
		.strictObject({
			family: z.string().min(1).max(256),
			weight: z.number().int().min(1).max(1000).optional(),
			italic: z.boolean().optional(),
		})
		.optional(),
	/** Output width in px; the height follows 16:9. */
	width: z
		.number()
		.int()
		.refine((w) => (LOOK_POSTER_WIDTHS as readonly number[]).includes(w), 'unsupported poster width')
		.default(240),
});
export type LookPosterRequest = z.infer<typeof LookPosterRequestSchema>;
