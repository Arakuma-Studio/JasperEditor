// Style recipes (spec 15 EA-010, EA-011; docs/wp-notes/edit-automation.md "Style recipes"): a named, versioned set of
// pass parameters — Clean Up Voice's preset (spec 14), the subtitle template and rules (spec 13), and the parameter
// objects of the seven editing-automation passes as they are (`AUTOMATION_PARAM_SCHEMAS`: composed, not forked) —
// plus the asset roles the passes draw from (whoosh sounds, reaction pictures, songs, static noise) and the targets
// Style Check compares a sequence with. Stored in the user library (`<appdir>/style-recipes/`, the engine) and copied
// into a project that uses one (`ProjectDocument.styleRecipes`, schema v9, read leniently: `projectStyleRecipes`,
// INV-STYLE-RECIPE, `repairStyleRecipes`). Built-ins are code (`BUILTIN_STYLE_RECIPES`, neutral names, the measured
// parameters). Pure.
import { z } from 'zod';
import { CutAwareSchema, SubtitleRulesSchema, SubtitleTextSchema } from '../captions/subtitles/rules.ts';
import { CleanupOverridesSchema } from '../cleanup/schema.ts';
import { utf8Length } from '../clipboard/payload.ts';
import { CROCKFORD_ALPHABET } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import {
	AUTOMATION_PASSES,
	AutomationAssetsSchema,
	type AutomationPass,
	AutomationSfxSchema,
	DecorateCutsParamsSchema,
	KenBurnsParamsSchema,
	MusicParamsSchema,
	PunchInParamsSchema,
	ReactionParamsSchema,
	SlideParamsSchema,
	StingerParamsSchema,
} from './params.ts';

export const STYLE_RECIPE_FORMAT = 'jasper-style-recipe';
/** The recipe format this build reads and writes; a recipe of a later version is kept but never used or rewritten. */
export const STYLE_RECIPE_VERSION = 1;
/** Most recipes a project keeps a copy of. */
export const MAX_PROJECT_STYLE_RECIPES = 100;
/** A serialized recipe stays below this (a pack of custom kits is the largest part). */
export const MAX_STYLE_RECIPE_BYTES = 512 * 1024;

/**
 * The stages of a recipe in the order `apply_style` runs them (EA-012): cleanup and subtitles first (they change or
 * cover the timeline the decorations are planned on), then the seven passes in the spec's order, stingers last.
 */
export const STYLE_STAGES = ['cleanup', 'subtitles', ...AUTOMATION_PASSES] as const;
export type StyleStage = (typeof STYLE_STAGES)[number];

/** English names of the stages (model strings: the editor translates them). */
export const STYLE_STAGE_NAMES: Record<StyleStage, string> = {
	cleanup: 'Voice cleanup',
	subtitles: 'Subtitles',
	'decorate-cuts': 'Cut kits',
	'punch-ins': 'Punch-ins',
	'ken-burns': 'Ken Burns',
	reactions: 'Reactions',
	slides: 'Overlay slides',
	music: 'Music beds',
	stingers: 'Stingers',
};

export const STYLE_RECIPE_ID_RE = /^(?:builtin:[a-z0-9-]{1,40}|rcp_[0-9A-HJKMNP-TV-Z]{16})$/;
const RecipeIdSchema = z
	.string()
	.regex(STYLE_RECIPE_ID_RE, 'a recipe id is builtin:<name> or rcp_<16 characters>');

const Enabled = z.boolean();

/** Clean Up Voice in a recipe: a built-in (`builtin.fast`, `builtin.natural`) or user preset id and overrides. */
export const RecipeCleanupSchema = z.strictObject({
	enabled: Enabled,
	preset: z.string().min(1).max(200),
	overrides: CleanupOverridesSchema.optional(),
});

/** Subtitles in a recipe: `captions.generate`'s template (an id: built-in, project or user library) and rules. */
export const RecipeSubtitlesSchema = z.strictObject({
	enabled: Enabled,
	template: z.string().min(1).max(80),
	rules: SubtitleRulesSchema.optional(),
	text: SubtitleTextSchema.optional(),
	cutAware: z.union([z.boolean(), CutAwareSchema]).optional(),
	output: z.enum(['text-clips', 'caption-track']).optional(),
	/** Transcript language (default the transcript's). */
	language: z.string().min(1).max(35).optional(),
});

const passEntry = <T extends z.ZodType>(params: T) =>
	z.strictObject({ enabled: Enabled, params: params.optional() });

/** The reactions' and music's sources come from the recipe's asset roles when the parameters leave them out. */
const RecipeReactionParams = ReactionParamsSchema.extend({ assets: AutomationAssetsSchema.optional() });
const RecipeMusicParams = MusicParamsSchema.extend({ assets: AutomationAssetsSchema.optional() });

export const RecipePassesSchema = z.strictObject({
	cleanup: RecipeCleanupSchema.optional(),
	subtitles: RecipeSubtitlesSchema.optional(),
	'decorate-cuts': passEntry(DecorateCutsParamsSchema).optional(),
	'punch-ins': passEntry(PunchInParamsSchema).optional(),
	'ken-burns': passEntry(KenBurnsParamsSchema).optional(),
	reactions: passEntry(RecipeReactionParams).optional(),
	slides: passEntry(SlideParamsSchema).optional(),
	music: passEntry(RecipeMusicParams).optional(),
	stingers: passEntry(StingerParamsSchema).optional(),
});
export type RecipePasses = z.infer<typeof RecipePassesSchema>;

/**
 * Asset roles (EA-011): what the passes draw from, resolved from the user's library, bins or folders — never shipped.
 * `whoosh`: the library sounds of the kits' and punch-ins' whooshes (installed CC0 packs, the starter kit, the user's
 * sound folders); `reactionImages` / `musicFolder`: a bin (by name), an engine folder or media; `staticNoise`: the
 * stingers' noise sound (generated by Jasper Synth, or library sounds).
 */
export const RecipeAssetsSchema = z.strictObject({
	whoosh: AutomationSfxSchema.optional(),
	reactionImages: AutomationAssetsSchema.optional(),
	musicFolder: AutomationAssetsSchema.optional(),
	staticNoise: z
		.strictObject({
			sound: z.enum(['generated', 'library', 'none']),
			sfx: AutomationSfxSchema.optional(),
		})
		.optional(),
});
export type RecipeAssets = z.infer<typeof RecipeAssetsSchema>;
export const ASSET_ROLES = ['whoosh', 'reactionImages', 'musicFolder', 'staticNoise'] as const;
export type AssetRoleId = (typeof ASSET_ROLES)[number];

const Target = z.strictObject({
	value: z.number().min(-1000).max(1000),
	tolerance: z.number().min(0).max(1000),
});
/** What Style Check compares a sequence with (EA-013); every target optional (absent = not checked). */
export const RecipeTargetsSchema = z.strictObject({
	/** Picture cuts per minute of the sequence. */
	cutsPerMinute: Target.optional(),
	/** Share (0…1) of the cuts with an adjustment clip over them (a cut kit). */
	kitCoverage: Target.optional(),
	/** Punch-in zooms per minute. */
	punchInsPerMinute: Target.optional(),
	/** Median start of the punch-ins as a fraction (0…1) of their clip. */
	punchInStart: Target.optional(),
	/** Share (0…1) of the A-roll clips with a Ken Burns move. */
	kenBurnsShare: Target.optional(),
	/** Dead air left (spec 14's statistic): at most this many seconds of non-speech per minute. */
	deadAirPerMinute: z.strictObject({ max: z.number().min(0).max(60) }).optional(),
	/** Subtitles (spec 13): at least `min` (0…1) of the speech cuts start a subtitle; at most `maxCrossing` cross a cut. */
	subtitleOnCut: z
		.strictObject({ min: z.number().min(0).max(1), maxCrossing: z.number().int().min(0).max(100_000) })
		.optional(),
	/** Clip gain of the music beds (dB). */
	musicGainDb: Target.optional(),
});
export type RecipeTargets = z.infer<typeof RecipeTargetsSchema>;
export const STYLE_TARGETS = [
	'cutsPerMinute',
	'kitCoverage',
	'punchInsPerMinute',
	'punchInStart',
	'kenBurnsShare',
	'deadAirPerMinute',
	'subtitleOnCut',
	'musicGainDb',
] as const;
export type StyleTargetId = (typeof STYLE_TARGETS)[number];

const IsoTime = z.string().min(1).max(40);

export const StyleRecipeSchema = z.strictObject({
	format: z.literal(STYLE_RECIPE_FORMAT),
	version: z.literal(STYLE_RECIPE_VERSION),
	id: RecipeIdSchema,
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2000).optional(),
	/** The recipe's own version: 1 when made, +1 at every save. */
	revision: z.number().int().min(1).max(1e9),
	/** The recipe it started from (a built-in or library id). */
	basedOn: RecipeIdSchema.optional(),
	/** Which sequences it is meant for (informational; parameters left out resolve per sequence aspect). */
	aspect: z.enum(['vertical', 'landscape', 'any']).optional(),
	builtIn: z.boolean().optional(),
	passes: RecipePassesSchema,
	assets: RecipeAssetsSchema.optional(),
	targets: RecipeTargetsSchema.optional(),
	createdAt: IsoTime.optional(),
	updatedAt: IsoTime.optional(),
});
export type StyleRecipe = z.infer<typeof StyleRecipeSchema>;

const byteLength = (v: unknown): number => {
	try {
		return utf8Length(JSON.stringify(v) ?? '');
	} catch {
		return Number.POSITIVE_INFINITY;
	}
};
/** A deep copy of plain JSON data. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export type RecipeParse =
	| { ok: true; recipe: StyleRecipe }
	| { ok: false; code: 'E_INVALID_PARAM' | 'E_TOO_LARGE' | 'E_NEWER_VERSION'; message: string };

/** Whether a stored value is a recipe written by a later JasperEditor (kept as it is, never used or rewritten). */
export function isNewerRecipe(v: unknown): boolean {
	const r = v && typeof v === 'object' ? (v as { format?: unknown; version?: unknown }) : null;
	return (
		!!r &&
		r.format === STYLE_RECIPE_FORMAT &&
		typeof r.version === 'number' &&
		Number.isInteger(r.version) &&
		r.version > STYLE_RECIPE_VERSION
	);
}

/** Validates a recipe (strict). Never throws. */
export function parseStyleRecipe(v: unknown): RecipeParse {
	if (isNewerRecipe(v))
		return {
			ok: false,
			code: 'E_NEWER_VERSION',
			message: `The recipe was made by a newer JasperEditor (format version ${(v as { version: number }).version}; this build reads ${STYLE_RECIPE_VERSION}): update JasperEditor to use it`,
		};
	if (byteLength(v) > MAX_STYLE_RECIPE_BYTES)
		return {
			ok: false,
			code: 'E_TOO_LARGE',
			message: `A recipe holds at most ${MAX_STYLE_RECIPE_BYTES} bytes`,
		};
	const r = StyleRecipeSchema.safeParse(v);
	if (!r.success)
		return {
			ok: false,
			code: 'E_INVALID_PARAM',
			message: r.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join('.') || 'recipe'}: ${i.message}`)
				.join('; '),
		};
	return { ok: true, recipe: r.data };
}

/** A new user recipe id (`rcp_` + 16 Crockford characters) from 16 random bytes. */
export function styleRecipeIdFrom(bytes: ArrayLike<number>): string {
	let out = '';
	for (let i = 0; i < 16; i++) out += CROCKFORD_ALPHABET[(bytes[i] ?? 0) & 31];
	return `rcp_${out}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in recipes (EA-011): the measured parameters (FINDINGS §3; the kits / overlays work packages' defaults)

/** Default asset roles of the built-ins: bins named for the role, the library's whooshes, generated noise. */
export const DEFAULT_RECIPE_ASSETS: Required<
	Pick<RecipeAssets, 'reactionImages' | 'musicFolder' | 'staticNoise'>
> & {
	whoosh: NonNullable<RecipeAssets['whoosh']>;
} = {
	whoosh: { type: 'whoosh' },
	reactionImages: { bin: 'Reactions' },
	musicFolder: { bin: 'Music' },
	staticNoise: { sound: 'generated' },
};

const BUILTIN_TIME = '2026-10-26T00:00:00.000Z';
const builtin = (
	id: string,
	name: string,
	description: string,
	body: Pick<StyleRecipe, 'aspect' | 'passes' | 'targets'>,
): StyleRecipe => ({
	format: STYLE_RECIPE_FORMAT,
	version: STYLE_RECIPE_VERSION,
	id: `builtin:${id}`,
	name,
	description,
	revision: 1,
	builtIn: true,
	...body,
	assets: copy(DEFAULT_RECIPE_ASSETS),
	createdAt: BUILTIN_TIME,
	updatedAt: BUILTIN_TIME,
});

/**
 * Built-ins. Targets are the user's measured figures (FINDINGS §3, spec 14's dead air, spec 13's subtitle target); the
 * tolerances are assumptions (labelled in the wp-note): about ±30 % of a rate, ±0.1 of a share, ±2 dB.
 */
export const BUILTIN_STYLE_RECIPES: readonly StyleRecipe[] = [
	builtin(
		'fast-shorts',
		'Fast Shorts',
		'Vertical shorts: tight voice cleanup, pixel subtitles, a shake on every cut, Ken Burns on 15 % of the clips, reactions at the bottom slots and one music bed with an intro step.',
		{
			aspect: 'vertical',
			passes: {
				cleanup: { enabled: true, preset: 'builtin.fast' },
				subtitles: { enabled: true, template: 'builtin:pixel-pop' },
				'decorate-cuts': { enabled: true, params: { pack: 'shorts-shake' } },
				'punch-ins': { enabled: false },
				'ken-burns': { enabled: true, params: { share: 0.15, scale: 118 } },
				reactions: { enabled: true, params: {} },
				slides: { enabled: false },
				music: { enabled: true, params: { gainDb: -33, intro: { enabled: true, gainDb: -25 } } },
				stingers: { enabled: false },
			},
			targets: {
				cutsPerMinute: { value: 23.8, tolerance: 7 },
				kitCoverage: { value: 0.857, tolerance: 0.1 },
				kenBurnsShare: { value: 0.15, tolerance: 0.05 },
				deadAirPerMinute: { max: 1 },
				subtitleOnCut: { min: 0.95, maxCrossing: 0 },
				musicGainDb: { value: -33, tolerance: 2 },
			},
		},
	),
	builtin(
		'fast-long-form',
		'Fast Long-form',
		'Landscape videos: tight voice cleanup, pixel subtitles, the five-family transition pack on the cuts, punch-ins at clip midpoints, Ken Burns on 15 % of the rest, overlay slides and music beds switching on cuts.',
		{
			aspect: 'landscape',
			passes: {
				cleanup: { enabled: true, preset: 'builtin.fast' },
				subtitles: { enabled: true, template: 'builtin:pixel-pop' },
				'decorate-cuts': { enabled: true, params: { pack: 'long-pack' } },
				'punch-ins': {
					enabled: true,
					params: { density: 0.7, scale: 180, rampFrames: 7, minClipSeconds: 1.5, start: 'midpoint' },
				},
				'ken-burns': { enabled: true, params: { share: 0.15, scale: 130 } },
				reactions: { enabled: false },
				slides: { enabled: true, params: {} },
				music: { enabled: true, params: { bedSeconds: 52, gainDb: -33 } },
				stingers: { enabled: false },
			},
			targets: {
				cutsPerMinute: { value: 17.9, tolerance: 5 },
				kitCoverage: { value: 0.951, tolerance: 0.06 },
				punchInsPerMinute: { value: 9, tolerance: 3 },
				punchInStart: { value: 0.5, tolerance: 0.1 },
				kenBurnsShare: { value: 0.15, tolerance: 0.05 },
				deadAirPerMinute: { max: 1 },
				subtitleOnCut: { min: 0.95, maxCrossing: 0 },
				musicGainDb: { value: -33, tolerance: 2 },
			},
		},
	),
	builtin(
		'clean',
		'Clean',
		'No decorations: a calm voice cleanup that keeps short pauses and breaths, and plain subtitles.',
		{
			aspect: 'any',
			passes: {
				cleanup: { enabled: true, preset: 'builtin.natural' },
				subtitles: { enabled: true, template: 'builtin:subtitles' },
				'decorate-cuts': { enabled: false },
				'punch-ins': { enabled: false },
				'ken-burns': { enabled: false },
				reactions: { enabled: false },
				slides: { enabled: false },
				music: { enabled: false },
				stingers: { enabled: false },
			},
			targets: { deadAirPerMinute: { max: 3 }, subtitleOnCut: { min: 0.95, maxCrossing: 0 } },
		},
	),
];

export function builtinStyleRecipe(id: string): StyleRecipe | null {
	const r = BUILTIN_STYLE_RECIPES.find((x) => x.id === id);
	return r ? copy(r) : null;
}

/** Names and descriptions the editor translates (`pnpm i18n` model strings). */
export const STYLE_RECIPE_MODEL_STRINGS: readonly string[] = [
	...BUILTIN_STYLE_RECIPES.flatMap((r) => [r.name, r.description ?? '']),
	...Object.values(STYLE_STAGE_NAMES),
].filter(Boolean);

// ---------------------------------------------------------------------------------------------------------------
// Resolving a recipe for a run

/** A stage of a recipe ready to plan: the pass and its parameters with the asset roles filled in. */
export type ResolvedStage =
	| { stage: 'cleanup'; enabled: boolean; preset: string; overrides?: z.infer<typeof CleanupOverridesSchema> }
	| ({ stage: 'subtitles'; enabled: boolean } & Omit<z.infer<typeof RecipeSubtitlesSchema>, 'enabled'>)
	| { stage: AutomationPass; enabled: boolean; params: Record<string, unknown> };

/** Per-stage switches of a run (`apply_style {passes: {kits: false}}`): override the recipe's `enabled`. */
export type StageSwitches = Partial<Record<StyleStage, boolean>>;

/**
 * The recipe's stages in run order with the asset roles filled into the pass parameters: kits' and punch-ins' `sfx`
 * from `whoosh` (the pass's own `sfx` fields win), reactions' and music's `assets` from `reactionImages` /
 * `musicFolder` when they have none, stingers' sound from `staticNoise`. Absent passes are disabled.
 */
export function resolveRecipeStages(recipe: StyleRecipe, switches: StageSwitches = {}): ResolvedStage[] {
	const roles = { ...DEFAULT_RECIPE_ASSETS, ...(recipe.assets ?? {}) };
	const out: ResolvedStage[] = [];
	for (const stage of STYLE_STAGES) {
		const sw = switches[stage];
		if (stage === 'cleanup') {
			const c = recipe.passes.cleanup;
			out.push({
				stage,
				enabled: sw ?? c?.enabled ?? false,
				preset: c?.preset ?? 'builtin.fast',
				...(c?.overrides ? { overrides: copy(c.overrides) } : {}),
			});
			continue;
		}
		if (stage === 'subtitles') {
			const s = recipe.passes.subtitles;
			const { enabled, ...rest } = s ?? { enabled: false, template: 'builtin:subtitles' };
			out.push({ stage, enabled: sw ?? enabled, ...copy(rest) });
			continue;
		}
		const entry = recipe.passes[stage] as { enabled: boolean; params?: Record<string, unknown> } | undefined;
		const params: Record<string, unknown> = copy(entry?.params ?? {});
		if (stage === 'decorate-cuts' || stage === 'punch-ins')
			params.sfx = { ...roles.whoosh, ...((params.sfx as object | undefined) ?? {}) };
		if (stage === 'reactions' && params.assets === undefined) params.assets = copy(roles.reactionImages);
		if (stage === 'music' && params.assets === undefined) params.assets = copy(roles.musicFolder);
		if (stage === 'stingers' && params.sound === undefined) {
			params.sound = roles.staticNoise.sound;
			if (roles.staticNoise.sfx && params.sfx === undefined) params.sfx = copy(roles.staticNoise.sfx);
		}
		out.push({ stage, enabled: sw ?? entry?.enabled ?? false, params });
	}
	return out;
}

/** The parameters a pass dialog starts from with this recipe (its roles filled in), or null when it has none. */
export function recipePassParams(recipe: StyleRecipe, pass: AutomationPass): Record<string, unknown> | null {
	const s = resolveRecipeStages(recipe).find((x) => x.stage === pass);
	return s && 'params' in s ? s.params : null;
}

/**
 * A recipe made from `base` with some pass parameters replaced (Save Current Settings as Recipe…, MCP
 * `save_style_recipe`): each given pass keeps its `enabled` (or turns on) with the new parameters. Not validated.
 */
export function recipeWithPassParams(
	base: StyleRecipe,
	params: Partial<Record<AutomationPass, Record<string, unknown>>>,
): StyleRecipe {
	const next = copy(base);
	for (const [pass, p] of Object.entries(params) as [AutomationPass, Record<string, unknown>][]) {
		if (!p) continue;
		const { range: _r, excludeClipIds: _x, ...kept } = p as Record<string, unknown>;
		const cur = next.passes[pass] as { enabled: boolean } | undefined;
		(next.passes as Record<string, unknown>)[pass] = { enabled: cur?.enabled ?? true, params: kept };
	}
	return next;
}

// ---------------------------------------------------------------------------------------------------------------
// The project copy (`ProjectDocument.styleRecipes`, schema v9)

/** What `ProjectDocument.styleRecipes` holds: the recipes the project used and the active one. */
export type ProjectStyleRecipes = {
	/** The active recipe (a key of `recipes` or a built-in id); absent = none. */
	active?: string;
	recipes: Record<string, StyleRecipe>;
};

const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** The readable project recipes (newer-format ones are left out: `newer` lists their keys) and the active id. */
export function projectStyleRecipes(doc: Pick<ProjectDocument, 'sequences'>): {
	active: string | null;
	recipes: Record<string, StyleRecipe>;
	newer: string[];
} {
	const raw = (doc as { styleRecipes?: unknown }).styleRecipes;
	const out: Record<string, StyleRecipe> = {};
	const newer: string[] = [];
	if (!isPlain(raw)) return { active: null, recipes: out, newer };
	const rec = isPlain(raw.recipes) ? raw.recipes : {};
	for (const [k, v] of Object.entries(rec)) {
		if (isNewerRecipe(v)) {
			newer.push(k);
			continue;
		}
		const r = parseStyleRecipe(v);
		if (r.ok && r.recipe.id === k) out[k] = r.recipe;
	}
	const a = typeof raw.active === 'string' ? raw.active : null;
	const active = a && (out[a] || builtinStyleRecipe(a)) ? a : null;
	return { active, recipes: out, newer };
}

/** A recipe the project can use: its copy, else a built-in. */
export function findStyleRecipe(doc: Pick<ProjectDocument, 'sequences'>, id: string): StyleRecipe | null {
	return projectStyleRecipes(doc).recipes[id] ?? builtinStyleRecipe(id);
}

/** The project's active recipe (resolved), or null. */
export function activeStyleRecipe(doc: Pick<ProjectDocument, 'sequences'>): StyleRecipe | null {
	const p = projectStyleRecipes(doc);
	return p.active ? (p.recipes[p.active] ?? builtinStyleRecipe(p.active)) : null;
}

/** INV-STYLE-RECIPE: the stored `styleRecipes` record (newer-format entries are accepted as they are). */
export function styleRecipesIssues(doc: ProjectDocument): [string, string[]][] {
	const raw = (doc as { styleRecipes?: unknown }).styleRecipes;
	if (raw === undefined) return [];
	if (!isPlain(raw)) return [['styleRecipes must be an object {active?, recipes}', ['styleRecipes']]];
	const out: [string, string[]][] = [];
	for (const k of Object.keys(raw))
		if (k !== 'active' && k !== 'recipes')
			out.push([`styleRecipes has an unknown field ${k}`, ['styleRecipes', k]]);
	if (!isPlain(raw.recipes)) {
		out.push(['styleRecipes.recipes must be an object of recipes by id', ['styleRecipes', 'recipes']]);
		return out;
	}
	const keys = Object.keys(raw.recipes);
	if (keys.length > MAX_PROJECT_STYLE_RECIPES)
		out.push([`more than ${MAX_PROJECT_STYLE_RECIPES} style recipes`, ['styleRecipes', 'recipes']]);
	for (const k of keys) {
		const v = raw.recipes[k];
		if (isNewerRecipe(v)) continue;
		const r = parseStyleRecipe(v);
		if (!r.ok) out.push([`Style recipe ${k}: ${r.message}`, ['styleRecipes', 'recipes', k]]);
		else if (r.recipe.id !== k)
			out.push([
				`Style recipe ${k}: record key differs from id ${r.recipe.id}`,
				['styleRecipes', 'recipes', k],
			]);
	}
	if (raw.active !== undefined) {
		const a = raw.active;
		if (typeof a !== 'string' || !(Object.hasOwn(raw.recipes, a) || builtinStyleRecipe(a)))
			out.push(['styleRecipes.active names no recipe of the project', ['styleRecipes', 'active']]);
	}
	return out;
}

/**
 * Load repair of `styleRecipes` (mutates; idempotent): an unreadable record dropped, unreadable recipes dropped (newer
 * ones kept), keys = ids, at most 100, an active id naming nothing removed, the field removed when empty.
 */
export function repairStyleRecipes(
	doc: ProjectDocument,
	note: (action: string, entity: string, detail: string) => void,
): void {
	const d = doc as { styleRecipes?: unknown };
	if (d.styleRecipes === undefined) return;
	if (!isPlain(d.styleRecipes)) {
		delete d.styleRecipes;
		note('drop-style-recipes', 'styleRecipes', 'unreadable style recipes record removed');
		return;
	}
	const sr = d.styleRecipes;
	for (const k of Object.keys(sr))
		if (k !== 'active' && k !== 'recipes') {
			delete sr[k];
			note('repair-style-recipes', 'styleRecipes', `unknown field ${k} removed`);
		}
	if (!isPlain(sr.recipes)) {
		if (sr.recipes !== undefined)
			note('repair-style-recipes', 'styleRecipes', 'unreadable recipe list removed');
		sr.recipes = {};
	}
	const rec = sr.recipes as Record<string, unknown>;
	for (const k of Object.keys(rec)) {
		const v = rec[k];
		if (isNewerRecipe(v)) continue;
		const r = parseStyleRecipe(v);
		if (!r.ok) {
			delete rec[k];
			note('drop-style-recipe', k, `unreadable style recipe removed (${r.message})`.slice(0, 500));
			continue;
		}
		if (r.recipe.id !== k) {
			if (STYLE_RECIPE_ID_RE.test(k)) {
				(rec[k] as Record<string, unknown>).id = k;
				note('fix-id', k, 'style recipe record key and id made equal');
			} else {
				delete rec[k];
				if (!Object.hasOwn(rec, r.recipe.id)) {
					rec[r.recipe.id] = r.recipe;
					note('fix-id', r.recipe.id, `style recipe re-keyed from ${k.slice(0, 80)} to its id`);
				} else note('drop-style-recipe', k, 'style recipe stored under a malformed key, its id is taken');
			}
		}
	}
	for (const k of Object.keys(rec).slice(MAX_PROJECT_STYLE_RECIPES)) {
		delete rec[k];
		note('drop-style-recipe', k, `more than ${MAX_PROJECT_STYLE_RECIPES} style recipes`);
	}
	if (sr.active !== undefined) {
		const a = sr.active;
		if (typeof a !== 'string' || !(Object.hasOwn(rec, a) || builtinStyleRecipe(a))) {
			delete sr.active;
			note(
				'repair-style-recipes',
				'styleRecipes',
				'the active recipe names no recipe of the project: cleared',
			);
		}
	}
	if (Object.keys(rec).length === 0 && sr.active === undefined) delete d.styleRecipes;
}
