// Spec 19 title-look requests.
// TL-054: the engine stores user looks across projects. The factory library comes from @jasper/project.
// TL-087: `POST /api/title-looks/poster`, a look's thumbnail from the real render path. The answer is a PNG;
// the recipe is checked by `look.apply` in the engine, so a limit overflow answers like the command would.
import {
	COLOR_ROLES,
	LookColorSchema,
	MAX_TITLE_LOOK_NAME,
	MAX_USER_LOOKS,
	UserLookSchema,
} from '@jasper/project';
import { z } from 'zod';

export const TitleLookLibraryResponseSchema = z.object({
	/** Bumped on every change (the `titleLooks.changed` event carries it). */
	revision: z.number().int().min(0),
	/** The file was written by a newer build: it is shown and never changed. */
	readOnly: z.boolean(),
	looks: z.array(UserLookSchema),
});
export type TitleLookLibraryResponse = z.infer<typeof TitleLookLibraryResponseSchema>;

const Tags = z.array(z.string().max(64)).max(64);

/** Save Look: a recipe (`recipeFromAppearance` of a clip's look, or an agent's). The engine assigns id and timestamps. */
export const TitleLookCreateRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(MAX_TITLE_LOOK_NAME),
	recipe: z.unknown(),
	tags: Tags.optional(),
	category: z.string().max(64).optional(),
	colorways: z.array(z.unknown()).max(64).optional(),
});

/** Rename and retag. */
export const TitleLookUpdateRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(MAX_TITLE_LOOK_NAME).optional(),
	tags: Tags.optional(),
	category: z.string().max(64).optional(),
});

/** Import… of a `.json` file: a bundle, a library file, one look or a list. */
export const TitleLookImportRequestSchema = z.strictObject({ file: z.unknown() });
export const TitleLookImportResponseSchema = z.object({
	looks: z.array(UserLookSchema),
	/** Entries that were not valid looks (index in the file's list). */
	errors: z.array(z.object({ index: z.number().int(), message: z.string() })),
});

/** Export…: the chosen looks, default all. */
export const TitleLookExportRequestSchema = z.strictObject({
	ids: z.array(z.string().max(64)).max(MAX_USER_LOOKS).optional(),
});
export const TitleLookExportResponseSchema = z.object({
	format: z.string(),
	version: z.number().int(),
	looks: z.array(UserLookSchema),
});

export const TitleLookDeleteResponseSchema = z.object({ ok: z.literal(true), removed: z.string() });

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
