// Style recipes, Apply Style and Style Check tools (spec 15 EA-010…EA-013, EA-041): list_style_recipes,
// get_style_recipe, save_style_recipe, apply_style, style_check. A recipe is plain data (the passes' parameter
// objects, Clean Up Voice's preset, the subtitle template, asset roles, Style Check targets); apply_style runs its
// stages into ONE proposal of feature "edit-automation" (mode "dryRun" only reports). Guide: STYLE_GUIDE.
import {
	type ApplyStyleResult,
	ApplyStyleResultSchema,
	type EngineJob,
	StyleCheckResponseSchema,
	type StyleRecipeEntry,
	StyleRecipeLibraryResponseSchema,
} from '@jasper/api';
import {
	projectStyleRecipes,
	RecipeAssetsSchema,
	RecipePassesSchema,
	RecipeTargetsSchema,
	STYLE_STAGES,
	type StyleRecipe,
	TimeInputSchema,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	EDIT,
	type Extra,
	frameOf,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { runOne } from './subtitles.ts';

export const STYLE_GUIDE = `Style recipes, Apply Style and Style Check (spec 15 EA-010…EA-013). A style recipe is a named, versioned set of pass parameters: Clean Up Voice's preset (spec 14), the subtitle template and rules (spec 13), the parameters of decorate_cuts / add_punch_ins / add_ken_burns / place_reactions / slide_overlays / lay_music_bed / add_stingers as they are, the asset roles they draw from (whoosh sounds from the installed CC0 packs / starter kit / sound folders, the user's reaction pictures and songs from a bin named "Reactions" / "Music" or a folder, generated static noise) and the targets Style Check compares with. Built-ins: Fast Shorts (vertical: Fast cleanup, Pixel Pop subtitles, shake kit on every cut, Ken Burns 15 %, reactions at the bottom slots, one music bed with an intro step), Fast Long-form (landscape: Fast cleanup, Pixel Pop subtitles, the five-family transition pack, punch-ins at clip midpoints, Ken Burns 15 % of the rest, overlay slides, beds switching on cuts), Clean (Natural cleanup and plain subtitles, no decorations). The user's library is shared by every project; a project keeps a copy of each recipe it used and an active one (the pass dialogs start from it).
- list_style_recipes / get_style_recipe: the recipes (built-ins, the library, the project's copies and its active recipe).
- save_style_recipe: a new library recipe from basedOn (or the project's active one) with passes / assets / targets replaced per stage, or recipeId to change one of the library; projectId keeps a copy in the project (activate makes it the active recipe; undoable).
- apply_style: runs the recipe's stages in the order cleanup → subtitles → kits → punch-ins → Ken Burns → reactions → slides → music → stingers into ONE proposal. Later stages are planned on what earlier ones planned: on the cleaned-up timeline with its subtitles, so kits sit on the new cuts, punch-ins and Ken Burns never share a clip, kits never overlap, reactions avoid the subtitles and the kits' FX track sits above them. passes {"cleanup": false, …} turns stages off for a run (an edit cleaned up and subtitled already: the cleanup finds nothing and a sequence with subtitles keeps them). A stage that cannot run is reported with the reason (a missing role: "no bin named Reactions" → ask the user which bin or folder holds their pictures; no transcript → transcribe first), never skipped silently. mode "dryRun" gives the counts per stage, coverage, skips, the export cost class (native / hybrid: layers baked by the layer bake / remotion: kits render the whole export through Remotion) and whether it fits one proposal (else E_TOO_LARGE with a range). Every decoration requires the cleanup item (its frames are those of the cleaned-up timeline) and the recipe copy; accepting everything is one undo step; refresh_proposal re-plans stale items and rerolls one ({reroll: true}); a stale cleanup means: run apply_style again. Agents may accept it only when the project allows agents to apply editing-automation proposals AND, for its cleanup and subtitles, transcript-cleanup and subtitles proposals (Project Settings ▸ Agent Proposals).
- style_check: compares a sequence with a recipe's targets (cuts per minute, kit coverage, punch-in rate and start, Ken Burns share, dead air from the voice analysis, subtitles starting on speech cuts and crossing none, music level); every deviation lists "look here" timecodes (set_playhead to show one).
- Recommended workflow: 0. transcript: attach_script → fix_transcript {mode: "dryRun"} → fix_transcript {mode: "propose"} → the user reviews and accepts (jasper://guide/transcript-fix); 1. cleanup: analyze_voice / plan_cleanup → the user reviews → apply_cleanup (or let apply_style include it); 2. subtitles: captions_from_transcript with the recipe's template (or let apply_style include them); 3. apply_style {mode: "dryRun"} → read the stages and warnings, fix missing roles with the user → apply_style {mode: "propose"} → ASK THE USER to review it (wait_for_proposal); 4. accept_proposal only when the user asked you to and the project allows it; 5. style_check → report the deviations with their timecodes and fix them with the single passes.`;

const RecipeIdArg = z.string().min(1).max(80);
const ModeArg = z
	.enum(['propose', 'dryRun'])
	.optional()
	.describe('"propose" (default): store a proposal for review; "dryRun": only say what Apply Style would do');

type Entry = StyleRecipeEntry;

async function libraryList(ctx: ToolContext) {
	return StyleRecipeLibraryResponseSchema.parse(await ctx.engine((c) => c.styleRecipes()));
}

/** A recipe by id: the project's copy (when `projectId`), else the engine's (built-in or library). */
async function recipeById(
	ctx: ToolContext,
	id: string,
	projectId?: string,
): Promise<{ recipe: StyleRecipe; source: string }> {
	if (projectId) {
		const { doc } = await loadDoc(ctx, projectId);
		const p = projectStyleRecipes(doc);
		if (p.recipes[id]) return { recipe: p.recipes[id]!, source: 'project' };
		if (p.newer.includes(id))
			throw new ToolError(
				'E_NEWER_VERSION',
				`The project's recipe ${id} was made by a newer JasperEditor`,
				'Update JasperEditor to use it.',
			);
	}
	const e = (await ctx
		.engine((c) => c.styleRecipe(id))
		.catch((err: Error & { code?: string }) => {
			if (err.code === 'RECIPE_NOT_FOUND' || /not found/i.test(err.message))
				throw new ToolError('E_NOT_FOUND', `No style recipe ${id}`, 'list_style_recipes lists them.');
			throw err;
		})) as Entry;
	if (!e.recipe)
		throw new ToolError(
			'E_NEWER_VERSION',
			`The recipe ${id} was made by a newer JasperEditor`,
			'Update JasperEditor to use it.',
		);
	return { recipe: e.recipe as unknown as StyleRecipe, source: e.source };
}

const brief = (r: {
	id: string;
	name: string;
	source?: string;
	readOnly?: boolean;
	newer?: boolean;
	recipe?: unknown;
}) => {
	const rec = r.recipe as StyleRecipe | undefined;
	return {
		id: r.id,
		name: r.name,
		...(r.source ? { source: r.source } : {}),
		...(r.readOnly ? { readOnly: true } : {}),
		...(r.newer ? { newer: true } : {}),
		...(rec
			? {
					revision: rec.revision,
					...(rec.aspect ? { aspect: rec.aspect } : {}),
					...(rec.description ? { description: rec.description } : {}),
					stages: STYLE_STAGES.filter((s) => (rec.passes[s] as { enabled?: boolean } | undefined)?.enabled),
				}
			: {}),
	};
};

function compact(r: ApplyStyleResult) {
	return {
		mode: r.mode,
		sequenceId: r.sequenceId,
		recipe: r.recipe,
		stages: r.stages.map((s) => ({
			stage: s.stage,
			status: s.status,
			count: s.count,
			...(s.reason ? { reason: s.reason } : {}),
			...(s.cost ? { cost: s.cost } : {}),
			...(s.summary
				? {
						considered: s.summary.considered,
						coverage: s.summary.coverage,
						...(s.summary.families ? { families: s.summary.families } : {}),
						...(s.summary.skipped.count
							? {
									skipped: {
										count: s.summary.skipped.count,
										byCode: s.summary.skipped.byCode,
										first: s.summary.skipped.first
											.slice(0, 10)
											.map((x) => ({ timecode: x.timecode, reason: x.reason })),
									},
								}
							: {}),
					}
				: {}),
			...(s.cleanup ? { cleanup: { cuts: s.cleanup.ranges, removedFrames: s.cleanup.removedFrames } } : {}),
			...(s.sfx ? { sounds: s.sfx } : {}),
			...(s.dropped.length ? { dropped: s.dropped.slice(0, 10) } : {}),
			...(s.warnings.length ? { warnings: s.warnings.slice(0, 10) } : {}),
		})),
		export: {
			cost: r.cost,
			note:
				r.cost === 'native'
					? 'Native: the ffmpeg export draws everything.'
					: r.cost === 'hybrid'
						? 'Hybrid: the export stays native; layers with GPU effects (subtitle animation, reactions, slides, stingers) are pre-rendered by the layer bake.'
						: 'Remotion: the cut kits (adjustment clips with GPU effects) send the whole export through the Remotion renderer (slower; measured in docs/wp-notes/edit-automation.md).',
		},
		budget: r.budget,
		proposalId: r.proposalId,
		itemCount: r.itemCount,
		...(r.invalid.length ? { invalid: r.invalid.slice(0, 50) } : {}),
		warnings: r.warnings.slice(0, 50),
	};
}

type ApplyArgs = {
	projectId: string;
	sequenceId?: string;
	mode?: 'propose' | 'dryRun';
	recipeId?: string;
	recipe?: Record<string, unknown>;
	seed?: number;
	range?: { start: unknown; end: unknown };
	passes?: Record<string, boolean>;
	timeoutSeconds?: number;
};

async function applyStyle(ctx: ToolContext, a: ApplyArgs, extra: Extra) {
	const { doc } = await loadDoc(ctx, a.projectId);
	const seq = pickSequence(doc, a.sequenceId);
	let range: { start: number; end: number } | undefined;
	if (a.range) {
		range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
		if (range.end <= range.start)
			throw new ToolError(
				'E_INVALID_PARAM',
				`range.end (${range.end}) must be after range.start (${range.start})`,
			);
	}
	const body = {
		sequenceId: seq.id,
		mode: a.mode ?? 'propose',
		...(a.recipeId ? { recipeId: a.recipeId } : {}),
		...(a.recipe ? { recipe: a.recipe } : {}),
		...(a.seed !== undefined ? { seed: a.seed } : {}),
		...(range ? { range } : {}),
		...(a.passes ? { passes: a.passes } : {}),
	};
	const out = await ctx.engine((c) => c.applyStyle(a.projectId, body as never, extra.signal));
	if (body.mode === 'dryRun') {
		const r = ApplyStyleResultSchema.parse(out);
		return jsonResult({
			...compact(r),
			next: r.budget.fits
				? 'Nothing changed. Fix what the warnings ask for (missing roles, transcript), then call apply_style with mode "propose".'
				: `Too big for one proposal: run it on range ${JSON.stringify(r.budget.suggestedRange)} first, then on the rest.`,
		});
	}
	const job = out as EngineJob;
	await cancelIfAborted(ctx, extra, job.id);
	const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 600) * 1000, extra);
	if (timedOut)
		return jsonResult({
			jobId: done.id,
			state: done.state,
			progress: done.progress,
			next: `Apply Style is still running: wait_for_job {jobId: "${done.id}"}; its result names the proposal.`,
		});
	if (done.state !== 'succeeded')
		throw new ToolError(
			done.error?.code === 'PROPOSAL_TOO_LARGE' ? 'E_TOO_LARGE' : (done.error?.code ?? 'JOB_FAILED'),
			done.error?.message ?? `Apply Style ${done.state}`,
			done.error?.code === 'PROPOSAL_TOO_LARGE'
				? 'Run apply_style on the suggested range (details.suggestedRange), then on the rest.'
				: 'Check the recipe (get_style_recipe) and the project (get_timeline), then run apply_style again.',
			(done.error as { detail?: Record<string, unknown> } | undefined)?.detail,
		);
	const r = ApplyStyleResultSchema.parse(done.result);
	return jsonResult({
		...compact(r),
		next: r.proposalId
			? `Proposal ${r.proposalId} is ready: ask the user to review it in the editor's Review panel and call wait_for_proposal; accept_proposal only if the user asked you to apply it. Then style_check.`
			: 'Nothing to propose (see the stages and warnings).',
	});
}

export function registerStyleTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_style_recipes',
		{
			title: 'List style recipes',
			description:
				"The style recipes: the built-ins (Fast Shorts, Fast Long-form, Clean), the user's library (shared by every project; repairs made when it was loaded are reported) and, with projectId, the project's copies and its active recipe. Each with its stages switched on.",
			input: { projectId: ProjectIdArg.optional() },
			annotations: READ_ONLY,
		},
		async (a) => {
			const lib = await libraryList(ctx);
			let project: Record<string, unknown> | undefined;
			if (a.projectId) {
				const { doc } = await loadDoc(ctx, a.projectId);
				const p = projectStyleRecipes(doc);
				project = {
					active: p.active,
					recipes: Object.values(p.recipes).map((r) => brief({ id: r.id, name: r.name, recipe: r })),
					...(p.newer.length ? { newer: p.newer } : {}),
				};
			}
			return jsonResult({
				revision: lib.revision,
				recipes: lib.recipes.map(brief),
				...(lib.readOnly
					? {
							readOnly: true,
							note: 'The library was written by a newer JasperEditor: nothing can be saved to it.',
						}
					: {}),
				...(lib.repairs.length ? { repairs: lib.repairs } : {}),
				...(project ? { project } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'get_style_recipe',
		{
			title: 'Get a style recipe',
			description:
				"One style recipe as data (passes with their parameters, asset roles, Style Check targets): with projectId the project's copy first, else the built-in or library recipe.",
			input: { recipeId: RecipeIdArg, projectId: ProjectIdArg.optional() },
			annotations: READ_ONLY,
		},
		async (a) => {
			const r = await recipeById(ctx, a.recipeId, a.projectId);
			return jsonResult({ source: r.source, recipe: r.recipe });
		},
	);

	defineTool(
		ctx,
		'save_style_recipe',
		{
			title: 'Save a style recipe',
			description:
				"Saves a style recipe in the user's library: a new one made from basedOn (a recipe id; default the project's active recipe) with name and the stages of passes / assets / targets given here replaced (passes: {\"ken-burns\": {enabled: true, params: {share: 0.2}}, …}: each a stage entry of the recipe format), or recipeId to change a library recipe (revision + 1; built-ins are read-only: save a copy). With projectId the project keeps a copy too (activate: make it the project's active recipe, one undo step).",
			input: {
				name: z.string().trim().min(1).max(120),
				description: z.string().max(2000).optional(),
				basedOn: RecipeIdArg.optional(),
				recipeId: RecipeIdArg.optional(),
				passes: RecipePassesSchema.optional(),
				assets: RecipeAssetsSchema.optional(),
				targets: RecipeTargetsSchema.optional(),
				projectId: ProjectIdArg.optional(),
				activate: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			let base: StyleRecipe;
			if (a.recipeId) base = (await recipeById(ctx, a.recipeId)).recipe;
			else if (a.basedOn) base = (await recipeById(ctx, a.basedOn, a.projectId)).recipe;
			else if (a.projectId) {
				const { doc } = await loadDoc(ctx, a.projectId);
				const p = projectStyleRecipes(doc);
				if (!p.active)
					throw new ToolError(
						'E_INVALID_PARAM',
						'The project has no active recipe',
						'Pass basedOn (list_style_recipes).',
					);
				base = (await recipeById(ctx, p.active, a.projectId)).recipe;
			} else
				throw new ToolError(
					'E_INVALID_PARAM',
					'Say which recipe to start from',
					'Pass basedOn (list_style_recipes) or projectId.',
				);
			const recipe: Record<string, unknown> = {
				...base,
				name: a.name,
				...(a.description !== undefined ? { description: a.description } : {}),
				passes: { ...base.passes, ...(a.passes ?? {}) },
				...(a.assets || base.assets ? { assets: { ...(base.assets ?? {}), ...(a.assets ?? {}) } } : {}),
				...(a.targets ? { targets: a.targets } : base.targets ? { targets: base.targets } : {}),
			};
			delete recipe.builtIn;
			const saved = (await ctx.engine((c) =>
				a.recipeId
					? c.updateStyleRecipe(a.recipeId, { recipe })
					: c.createStyleRecipe({ recipe: { ...recipe, id: base.id } }),
			)) as Entry;
			let project: unknown;
			if (a.projectId) {
				const { body } = await runOne(
					ctx,
					a.projectId,
					'Add Style Recipe',
					{ type: 'styleRecipe.add', recipe: saved.recipe, ...(a.activate ? { activate: true } : {}) },
					extra,
				);
				project = body;
			}
			return jsonResult({
				recipeId: saved.id,
				name: saved.name,
				revision: (saved.recipe as { revision?: number } | undefined)?.revision,
				...(project ? { project } : {}),
				next: 'apply_style {recipeId} with mode "dryRun" shows what it does on a sequence.',
			});
		},
	);

	defineTool(
		ctx,
		'apply_style',
		{
			title: 'Apply a style recipe (propose)',
			description:
				'Spec 15 Apply Style: runs a style recipe\'s stages — Clean Up Voice, subtitles, cut kits, punch-ins, Ken Burns, reactions, overlay slides, music beds, stingers — into ONE proposal for review, each stage planned on what the earlier ones planned (the cleaned-up timeline with its subtitles: kits on the new cuts, never overlapping, punch-ins never on a Ken Burns clip, reactions clear of the subtitles). recipeId (built-in, library or project copy; default the project\'s active recipe) or a whole recipe; passes turns stages on / off for this run; seed and range as in the single passes. mode "dryRun" reports per stage (count, coverage, skips with reasons, missing asset roles, export cost class, budget) without storing anything. Nothing changes until the proposal is accepted (one undo step).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				recipeId: RecipeIdArg.optional(),
				recipe: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('A whole recipe (format "jasper-style-recipe")'),
				seed: z
					.number()
					.int()
					.min(0)
					.max(0xffff_ffff)
					.optional()
					.describe("Seed of every pass (default each pass's, else 1)"),
				range: z
					.object({ start: TimeInputSchema, end: TimeInputSchema })
					.optional()
					.describe('Only this part of the sequence [start, end): frames, {"seconds": x} or "HH:MM:SS:FF"'),
				passes: z
					.partialRecord(z.enum(STYLE_STAGES), z.boolean())
					.optional()
					.describe('Stages on / off for this run, e.g. {"cleanup": false, "stingers": true}'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(1800)
					.optional()
					.describe('Wait for the proposal (default 600 s)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => applyStyle(ctx, a as ApplyArgs, extra),
	);

	defineTool(
		ctx,
		'style_check',
		{
			title: 'Style Check',
			description:
				"Spec 15 Style Check: compares a sequence with a recipe's targets (default the project's active recipe) — cuts per minute, cuts with a kit, punch-ins per minute and their start in the clip, Ken Burns share, dead air (spec 14, from the voice analyses already made), subtitles starting on speech cuts and crossing none (spec 13), music level — with each measure's value, target and status (ok / off / unmeasured / unchecked) and, for a deviation, \"look here\" timecodes. Read-only.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				recipeId: RecipeIdArg.optional(),
				deadAir: z.boolean().optional().describe('Measure dead air (default true)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const r = StyleCheckResponseSchema.parse(
				await ctx.engine((c) =>
					c.styleCheck(
						a.projectId,
						{
							sequenceId: seq.id,
							...(a.recipeId ? { recipeId: a.recipeId } : {}),
							...(a.deadAir !== undefined ? { deadAir: a.deadAir } : {}),
						},
						extra.signal,
					),
				),
			);
			return jsonResult({
				recipe: r.recipe,
				sequenceId: r.sequenceId,
				durationSeconds: r.durationSeconds,
				counts: r.counts,
				metrics: r.metrics.map((m) => ({
					id: m.id,
					label: m.label,
					status: m.status,
					value: m.value,
					target: m.target,
					message: m.message,
					...(m.lookHere.length
						? {
								lookHere: m.lookHere
									.slice(0, 20)
									.map((x) => ({ timecode: x.timecode, frame: x.frame, note: x.note })),
							}
						: {}),
				})),
				...(r.warnings.length ? { warnings: r.warnings } : {}),
				next: r.counts.off
					? 'Show the user the deviations (set_playhead to a lookHere frame) and fix them with the single passes or apply_style.'
					: 'On target.',
			});
		},
	);
}
