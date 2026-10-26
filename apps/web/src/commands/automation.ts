// Sequence ▸ Automate (spec 15 EA-040): Decorate Cuts…, Punch-ins…, Ken Burns…, Reactions…, Slide Overlays…, Music
// Bed…, Stingers… — each opens its pass's dialog (parameters, dry-run summary, Propose → review). Agents reach the same
// passes through MCP (decorate_cuts, add_punch_ins, add_ken_burns, place_reactions, slide_overlays, lay_music_bed,
// add_stingers); these UI commands are exposed to them too (`ui_command`) with optional starting
// parameters (`params`: the pass's plain-data parameters, e.g. a style recipe's).
import type { AutomationPassId } from '@jasper/api';
import { activeStyleRecipe, recipePassParams } from '@jasper/project';
import { z } from 'zod';
import { APPLY_STYLE_DIALOG, registerApplyStyleDialog } from '../automation/ApplyStyleDialog.tsx';
import { AUTOMATION_DIALOG, registerAutomationDialog } from '../automation/AutomationDialog.tsx';
import { registerStyleCheckDialog, STYLE_CHECK_DIALOG } from '../automation/StyleCheckDialog.tsx';
import { registerStyleRecipesDialog, STYLE_RECIPES_DIALOG } from '../automation/StyleRecipesDialog.tsx';
import { t } from '../i18n/runtime.ts';
import { runCommand } from './registry.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerAutomationDialog();
registerApplyStyleDialog();
registerStyleCheckDialog();
registerStyleRecipesDialog();

const PassArgs = z
	.object({ params: z.record(z.string(), z.unknown()).optional() })
	.strict()
	.optional();

/** What the three pass commands share (their id, label and description are literals: translated when read). */
function passCommand(pass: AutomationPassId): Omit<UiCommand, 'id' | 'label'> {
	return {
		scope: 'global',
		capability: 'engine',
		agentExposed: true,
		argsSchema: PassArgs,
		when: (ctx: CommandCtx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly;
		},
		disabledReason: (ctx: CommandCtx) =>
			sequenceContext(ctx)?.session.getState().readOnly
				? t('The project is read-only')
				: t('Open a sequence first'),
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const a = args as z.infer<typeof PassArgs>;
			// the pass's parameters of the project's active style recipe (EA-040), unless the caller gives some
			const active = activeStyleRecipe(e.session.getCommitted());
			const fromRecipe = active ? recipePassParams(active, pass) : null;
			const initial = a?.params ?? fromRecipe;
			ctx.ui.openDialog(AUTOMATION_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				pass,
				...(initial ? { initialParams: initial } : {}),
				toast: ctx.ui.toast,
				onReview: () => void runCommand('panel.focus.review', ctx),
			});
		},
	};
}

const RecipeArgs = z
	.object({ recipeId: z.string().min(1).max(80).optional() })
	.strict()
	.optional();

/** What the style commands share (open a dialog on the active sequence). */
function styleCommand(engine: boolean): Omit<UiCommand, 'id' | 'label' | 'description' | 'run'> {
	return {
		scope: 'global',
		...(engine ? { capability: 'engine' as const } : {}),
		agentExposed: true,
		argsSchema: RecipeArgs,
		when: (ctx: CommandCtx) => !!sequenceContext(ctx),
		disabledReason: () => t('Open a sequence first'),
	};
}

export const automationCommands: UiCommand[] = [
	{
		...passCommand('decorate-cuts'),
		id: 'automation.decorateCuts',
		label: 'Decorate Cuts…',
		description:
			'Put a cut kit on every picture cut of the active sequence (an adjustment clip centred on the cut on an FX track, plus a whoosh of the same length): kit pack and family shares, fewer repeats, cuts track, coverage, spacing, sounds and seed, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...passCommand('punch-ins'),
		id: 'automation.punchIns',
		label: 'Punch-ins…',
		description:
			'Zoom into the A-roll clips of the active sequence: density, shortest clip, zoom size and ramp, start (midpoint or word), target (centre, subject, point), Motion keys or a Transform adjustment clip, whoosh and seed, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...passCommand('ken-burns'),
		id: 'automation.kenBurns',
		label: 'Ken Burns…',
		description:
			'Give a share of the remaining A-roll clips of the active sequence a slow zoom over the whole clip: share, zoom size, zoom-ins per zoom-out, shortest clip and seed, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...passCommand('reactions'),
		id: 'automation.reactions',
		label: 'Reactions…',
		description:
			'Place your reaction pictures (from a bin or folder) over the active sequence at markers, calls to action and exclamations of the transcript and, optionally, where face tracking sees no face: slots, length, scale, wobble, word lists, rate per minute and seed, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...passCommand('slides'),
		id: 'automation.slides',
		label: 'Slide Overlays…',
		description:
			'Slide the overlay clips (pictures above the A-roll) of the active sequence in and out with one-sided Smooth Slide transitions at their free heads and tails: shares, length, direction and easing weights, motion blur and seed, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...passCommand('music'),
		id: 'automation.musicBed',
		label: 'Music Bed…',
		description:
			'Lay your songs (from a bin or folder) end to end under the active sequence on a Music track: bed length, switching on cuts, gain, intro step, ducking under dialogue, order and seed, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...passCommand('stingers'),
		id: 'automation.stingers',
		label: 'Stingers…',
		description:
			'Put a short burst of generated TV static (picture and sound) after the shouted punchlines of the active sequence, found by loudness peaks and "!" phrases: match rule, threshold, length, rate, gain and sound, with a dry-run summary; Propose stores a proposal and opens review',
	},
	{
		...styleCommand(true),
		when: (ctx: CommandCtx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly;
		},
		disabledReason: (ctx: CommandCtx) =>
			sequenceContext(ctx)?.session.getState().readOnly ? t('The project is read-only') : t('Open a sequence first'),
		id: 'automation.applyStyle',
		label: 'Apply Style…',
		description:
			'Run a style recipe on the active sequence (voice cleanup, subtitles, cut kits, punch-ins, Ken Burns, reactions, overlay slides, music beds, stingers), each step planned on what the earlier ones planned: the recipe, its steps for this run, range and seed, with a dry run per step (what is planned, why a step is skipped, export cost); Propose stores one proposal and opens review',
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const a = args as z.infer<typeof RecipeArgs>;
			ctx.ui.openDialog(APPLY_STYLE_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				...(a?.recipeId ? { recipeId: a.recipeId } : {}),
				toast: ctx.ui.toast,
				onReview: () => void runCommand('panel.focus.review', ctx),
			});
		},
	},
	{
		...styleCommand(true),
		id: 'automation.styleCheck',
		label: 'Style Check',
		description:
			'Compare the active sequence with a style recipe’s targets (cuts per minute, cuts with a kit, punch-ins, Ken Burns share, dead air, subtitles on the cuts, music level); each deviation lists timecodes that move the playhead there',
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const a = args as z.infer<typeof RecipeArgs>;
			ctx.ui.openDialog(STYLE_CHECK_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				...(a?.recipeId ? { recipeId: a.recipeId } : {}),
			});
		},
	},
	{
		...styleCommand(false),
		argsSchema: z.object({}).strict().optional(),
		id: 'automation.styleRecipes',
		label: 'Style Recipes…',
		description:
			'The style recipes (built in, your library, this project’s copies): use one as the project’s active recipe, duplicate, rename, delete, or save the settings last used in the Automate dialogs as a new recipe',
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(STYLE_RECIPES_DIALOG, { session: e.session, sequenceId: e.seq.id });
		},
	},
];
