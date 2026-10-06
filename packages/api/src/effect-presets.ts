// Effect preset library contracts (S03:FX-030, AGT-020, S05:EFX-001). Owner: wp-m3-presets.
// User presets live on the engine (`<appdir>/presets/effect-presets.json`), so they persist across projects and
// sessions and the editor and agents (jasper-mcp) share one library. Built-in presets ship in @jasper/project
// (`BUILTIN_EFFECT_PRESETS`) and are never stored or served here.
import { EffectPresetFolderSchema, EffectPresetSchema, EffectPresetTypeSchema } from '@jasper/project';
import { z } from 'zod';

export const EffectPresetLibraryResponseSchema = z.object({
	/** Bumped on every change (the `effectPresets.changed` event carries it). */
	revision: z.number().int().min(0),
	folders: z.array(EffectPresetFolderSchema),
	presets: z.array(EffectPresetSchema),
});
export type EffectPresetLibraryResponse = z.infer<typeof EffectPresetLibraryResponseSchema>;

/** Save Preset: a preset JSON (validated with `parseEffectPreset`; the engine assigns `id` and timestamps). */
export const EffectPresetCreateRequestSchema = z.object({
	preset: z.record(z.string(), z.unknown()),
	folderId: z.string().nullable().optional(),
});

/** Rename, move to a bin, change type or description. */
export const EffectPresetUpdateRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().max(2000).optional(),
	type: EffectPresetTypeSchema.optional(),
	folderId: z.string().nullable().optional(),
});

export const EffectPresetFolderCreateRequestSchema = z.object({
	name: z.string().trim().min(1).max(120),
	parentId: z.string().nullable().optional(),
});
export const EffectPresetFolderUpdateRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	parentId: z.string().nullable().optional(),
});

/** Import… of a `.json` file: a preset, a bundle (`jasper-effect-presets`), a library file or an array. */
export const EffectPresetImportRequestSchema = z.object({
	file: z.unknown(),
	/** Bin the imported presets (and bins) go into; default the root. */
	folderId: z.string().nullable().optional(),
});
export const EffectPresetImportResponseSchema = z.object({
	presets: z.array(EffectPresetSchema),
	folders: z.array(EffectPresetFolderSchema),
	/** Entries that were not valid presets (index in the file's list). */
	errors: z.array(z.object({ index: z.number().int(), message: z.string() })),
});

export const EffectPresetDeleteResponseSchema = z.object({
	ok: z.literal(true),
	/** Presets removed (a deleted bin removes everything inside it). */
	removedPresets: z.array(z.string()),
	removedFolders: z.array(z.string()),
});
