// Sequence ▸ Automate (spec 15 EA-040): Decorate Cuts…, Punch-ins…, Ken Burns…, Reactions…, Slide Overlays…, Music
// Bed…, Stingers… — each opens its pass's dialog (parameters, dry-run summary, Propose → review). Agents reach the same
// passes through MCP (decorate_cuts, add_punch_ins, add_ken_burns, place_reactions, slide_overlays, lay_music_bed,
// add_stingers); these UI commands are exposed to them too (`ui_command`) with optional starting
// parameters (`params`: the pass's plain-data parameters, e.g. a style recipe's).
import type { AutomationPassId } from '@jasper/api';
import { z } from 'zod';
import { AUTOMATION_DIALOG, registerAutomationDialog } from '../automation/AutomationDialog.tsx';
import { t } from '../i18n/runtime.ts';
import { runCommand } from './registry.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerAutomationDialog();

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
			ctx.ui.openDialog(AUTOMATION_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				pass,
				...(a?.params ? { initialParams: a.params } : {}),
				toast: ctx.ui.toast,
				onReview: () => void runCommand('panel.focus.review', ctx),
			});
		},
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
];
