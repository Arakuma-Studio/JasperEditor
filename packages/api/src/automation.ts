// Editing automation passes (spec 15 EA-020…EA-026, EA-033, EA-041): `POST /api/projects/:projectId/automation/:pass`
// with `pass` = decorate-cuts | punch-ins | ken-burns | reactions | slides | music | stingers. `mode: 'dryRun'` answers at once with what the pass would do
// (counts, coverage, why cuts / clips were left out, export cost, whether it fits one proposal, the sounds available);
// `mode: 'propose'` (default) starts an `edit-automation` job (202) that plans, registers the pass's sounds and stores
// a proposal of feature `edit-automation` (nothing applied: review it, or an allowed agent accepts it). The pass
// parameters are the plain-data objects of `@jasper/project` (`DecorateCutsParamsSchema`, …), validated strictly by the
// engine. Times are sequence frames.
import { AUTOMATION_PASSES } from '@jasper/project';
import { z } from 'zod';

export const AutomationPassIdSchema = z.enum(AUTOMATION_PASSES);
export type AutomationPassId = z.infer<typeof AutomationPassIdSchema>;

export const AUTOMATION_MODES = ['propose', 'dryRun'] as const;

export const AutomationPassRequestSchema = z.strictObject({
	sequenceId: z.string().min(1).max(128).optional(),
	mode: z.enum(AUTOMATION_MODES).optional(),
	/** The pass's parameters (strict; see the pass schemas of @jasper/project). */
	params: z.record(z.string(), z.unknown()).optional(),
});
export type AutomationPassRequest = z.infer<typeof AutomationPassRequestSchema>;

const SkipSchema = z.object({
	frame: z.number(),
	timecode: z.string(),
	code: z.string(),
	reason: z.string(),
	clipId: z.string().optional(),
});

export const AutomationSummarySchema = z.object({
	pass: AutomationPassIdSchema,
	sequenceId: z.string(),
	seed: z.number(),
	count: z.number().int(),
	considered: z.number().int(),
	coverage: z.number(),
	skipped: z.object({
		count: z.number().int(),
		byCode: z.record(z.string(), z.number()),
		first: z.array(SkipSchema),
	}),
	families: z.record(z.string(), z.number()).optional(),
	/** Pass-specific counts (reaction triggers, slide heads / tails / directions, bed switches, stinger sources). */
	detail: z.record(z.string(), z.number()).optional(),
	/** Reactions / music: the user's assets the pass draws from. */
	assets: z.object({ count: z.number().int(), names: z.array(z.string()) }).optional(),
	cost: z.object({
		/** `native`; `hybrid` = native with layers / transition spans baked by the Remotion renderer; `remotion`. */
		class: z.enum(['native', 'hybrid', 'remotion']),
		frames: z.number(),
		effects: z.array(z.string()),
	}),
	track: z.string().optional(),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type AutomationSummaryDto = z.infer<typeof AutomationSummarySchema>;

/** The pass's sounds: the asset role, how many library sounds of it the pass may use, and how many it placed. */
export const AutomationSfxReportSchema = z.object({
	enabled: z.boolean(),
	type: z.string(),
	available: z.number().int(),
	placed: z.number().int(),
	/** Distinct sounds the rotation uses. */
	sounds: z.number().int(),
	unsounded: z.number().int(),
});

export const AutomationBudgetSchema = z.object({
	fits: z.boolean(),
	items: z.number().int(),
	commands: z.number().int(),
	/** When it does not fit: the frames [start, end) a pass fitting one proposal covers (run it on that range). */
	suggestedRange: z.object({ start: z.number().int(), end: z.number().int() }).nullable().optional(),
});

export const AutomationPassResultSchema = z.object({
	mode: z.enum(AUTOMATION_MODES),
	pass: AutomationPassIdSchema,
	projectId: z.string(),
	sequenceId: z.string(),
	summary: AutomationSummarySchema,
	sfx: AutomationSfxReportSchema.nullable(),
	budget: AutomationBudgetSchema,
	/** The stored proposal (`propose`; null when nothing was planned or in a dry run). */
	proposalId: z.string().nullable(),
	revision: z.number().int().nullable(),
	itemCount: z.number().int(),
	invalid: z.array(z.object({ itemId: z.string(), reason: z.string() })),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type AutomationPassResult = z.infer<typeof AutomationPassResultSchema>;
