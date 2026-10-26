// Style recipes, Apply Style and Style Check (spec 15 EA-010…EA-013, EA-041):
//   GET    /api/style-recipes                         the built-ins and the user library (+ repairs, read-only flag)
//   GET    /api/style-recipes/:recipeId               one recipe
//   POST   /api/style-recipes                         save a new recipe in the library (id, revision, times assigned)
//   PUT    /api/style-recipes/:recipeId               rename / replace a library recipe (revision + 1)
//   POST   /api/style-recipes/:recipeId/duplicate     a copy in the library (of a built-in or library recipe)
//   DELETE /api/style-recipes/:recipeId               delete it (agents: the user approves it in the editor)
//   POST   /api/projects/:projectId/style/apply       `dryRun` → counts at once; `propose` → an `apply-style` job
//   POST   /api/projects/:projectId/style/check       Style Check of a sequence against a recipe's targets
// Recipes are `@jasper/project`'s `StyleRecipeSchema` (strict); a recipe made by a newer JasperEditor is listed as
// read-only (`newer`) and refused for use.

import { STYLE_STAGES, STYLE_TARGETS } from '@jasper/project';
import { z } from 'zod';
import { AutomationBudgetSchema, AutomationSfxReportSchema, AutomationSummarySchema } from './automation.ts';

const Warning = z.object({ code: z.string(), message: z.string() });

/** A recipe as stored (validated by the engine with `parseStyleRecipe`; kept loose here for newer formats). */
const RecipeJson = z.record(z.string(), z.unknown());

export const StyleRecipeEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	source: z.enum(['builtin', 'library']),
	/** Built-ins and recipes of a newer JasperEditor (or a read-only library) cannot be changed. */
	readOnly: z.boolean(),
	/** Made by a newer JasperEditor: listed, never used or rewritten. */
	newer: z.boolean().optional(),
	/** The recipe (absent for `newer` ones, which this build cannot read). */
	recipe: RecipeJson.optional(),
});
export type StyleRecipeEntry = z.infer<typeof StyleRecipeEntrySchema>;

export const StyleRecipeRepairSchema = z.object({
	action: z.string(),
	entity: z.string(),
	detail: z.string(),
});

export const StyleRecipeLibraryResponseSchema = z.object({
	/** Bumped on every change (the `styleRecipes.changed` event carries it). */
	revision: z.number().int().min(0),
	recipes: z.array(StyleRecipeEntrySchema),
	/** What loading the library repaired (shown to the user once). */
	repairs: z.array(StyleRecipeRepairSchema),
	/** The library was written by a newer JasperEditor: nothing can be saved. */
	readOnly: z.boolean(),
});
export type StyleRecipeLibraryResponse = z.infer<typeof StyleRecipeLibraryResponseSchema>;

/** Save a new recipe (its id, revision and times are assigned; `basedOn` kept). */
export const StyleRecipeCreateRequestSchema = z.strictObject({ recipe: RecipeJson });
/** Rename or replace a library recipe. */
export const StyleRecipeUpdateRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().max(2000).optional(),
	recipe: RecipeJson.optional(),
});
export const StyleRecipeDuplicateRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
});
export type StyleRecipeCreateRequest = z.infer<typeof StyleRecipeCreateRequestSchema>;
export type StyleRecipeUpdateRequest = z.infer<typeof StyleRecipeUpdateRequestSchema>;
export type StyleRecipeDuplicateRequest = z.infer<typeof StyleRecipeDuplicateRequestSchema>;
export const StyleRecipeDeleteResponseSchema = z.object({ ok: z.literal(true), removed: z.string() });

const Frame = z.number().int().min(0).max(1e9);
export const STYLE_MODES = ['propose', 'dryRun'] as const;

export const ApplyStyleRequestSchema = z.strictObject({
	sequenceId: z.string().min(1).max(128).optional(),
	mode: z.enum(STYLE_MODES).optional(),
	/** A built-in, library or project recipe id (default: the project's active recipe). */
	recipeId: z.string().min(1).max(80).optional(),
	/** Or a whole recipe (validated strictly). */
	recipe: RecipeJson.optional(),
	seed: z.number().int().min(0).max(0xffff_ffff).optional(),
	range: z
		.strictObject({ start: Frame, end: Frame })
		.refine((r) => r.end > r.start, 'range.end must be after range.start')
		.optional(),
	/** Turn stages on or off for this run (cleanup, subtitles, decorate-cuts, …). */
	passes: z.partialRecord(z.enum(STYLE_STAGES), z.boolean()).optional(),
});
export type ApplyStyleRequest = z.infer<typeof ApplyStyleRequestSchema>;

export const StyleStageReportSchema = z.object({
	stage: z.enum(STYLE_STAGES),
	name: z.string(),
	status: z.enum(['planned', 'empty', 'off', 'skipped']),
	count: z.number().int(),
	items: z.number().int(),
	reason: z.string().optional(),
	summary: AutomationSummarySchema.optional(),
	sfx: AutomationSfxReportSchema.nullable().optional(),
	cleanup: z
		.object({
			ranges: z.number().int(),
			removedFrames: z.number().int(),
			findings: z.number().int(),
			stats: z.record(z.string(), z.unknown()).optional(),
		})
		.optional(),
	dropped: z.array(z.object({ itemId: z.string(), reason: z.string() })),
	cost: z.enum(['native', 'hybrid', 'remotion']).nullable(),
	warnings: z.array(Warning),
});
export type StyleStageReportDto = z.infer<typeof StyleStageReportSchema>;

export const ApplyStyleResultSchema = z.object({
	mode: z.enum(STYLE_MODES),
	projectId: z.string(),
	sequenceId: z.string(),
	recipe: z.object({ id: z.string(), name: z.string(), revision: z.number().int() }),
	stages: z.array(StyleStageReportSchema),
	/** The export cost class of the whole result (the highest of the stages). */
	cost: z.enum(['native', 'hybrid', 'remotion']),
	budget: AutomationBudgetSchema,
	proposalId: z.string().nullable(),
	revision: z.number().int().nullable(),
	itemCount: z.number().int(),
	invalid: z.array(z.object({ itemId: z.string(), reason: z.string() })),
	warnings: z.array(Warning),
});
export type ApplyStyleResult = z.infer<typeof ApplyStyleResultSchema>;

export const StyleCheckRequestSchema = z.strictObject({
	sequenceId: z.string().min(1).max(128).optional(),
	/** Default: the project's active recipe. */
	recipeId: z.string().min(1).max(80).optional(),
	recipe: RecipeJson.optional(),
	/** Measure dead air (a cleanup analysis with the voice analyses already made; default true). */
	deadAir: z.boolean().optional(),
});
export type StyleCheckRequest = z.infer<typeof StyleCheckRequestSchema>;

const LookHere = z.object({ frame: z.number().int(), timecode: z.string(), note: z.string() });
export const StyleCheckMetricSchema = z.object({
	id: z.enum(STYLE_TARGETS),
	label: z.string(),
	unit: z.enum(['per-minute', 'share', 'fraction', 'seconds-per-minute', 'db']),
	value: z.number().nullable(),
	target: z
		.object({
			value: z.number().optional(),
			tolerance: z.number().optional(),
			min: z.number().optional(),
			max: z.number().optional(),
		})
		.nullable(),
	status: z.enum(['ok', 'off', 'unmeasured', 'unchecked']),
	message: z.string(),
	count: z.number().int().optional(),
	of: z.number().int().optional(),
	lookHere: z.array(LookHere),
});
export type StyleCheckMetricDto = z.infer<typeof StyleCheckMetricSchema>;

export const StyleCheckResponseSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	recipe: z.object({ id: z.string(), name: z.string() }),
	durationSeconds: z.number(),
	metrics: z.array(StyleCheckMetricSchema),
	counts: z.object({
		ok: z.number().int(),
		off: z.number().int(),
		unmeasured: z.number().int(),
		unchecked: z.number().int(),
	}),
	warnings: z.array(Warning),
});
export type StyleCheckResponse = z.infer<typeof StyleCheckResponseSchema>;
