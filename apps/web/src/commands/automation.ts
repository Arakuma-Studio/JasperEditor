// Sequence ▸ Automate (spec 15 EA-040): Decorate Cuts…, Punch-ins…, Ken Burns… — each opens its pass's dialog
// (parameters, dry-run summary, Propose → review). Agents reach the same passes through MCP (decorate_cuts,
// add_punch_ins, add_ken_burns); these UI commands are exposed to them too (`ui_command`) with optional starting
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
];
