// Spec 19 TL-054: the engine stores user looks across projects. The factory library comes from @jasper/project.
import { MAX_TITLE_LOOK_NAME, MAX_USER_LOOKS, UserLookSchema } from '@jasper/project';
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
