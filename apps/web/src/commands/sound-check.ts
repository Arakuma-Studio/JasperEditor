// Sound Check commands (spec 12 §2.7 "Menus: Sequence ▸ Sound Design ▸ Run Sound Check", P5-R3; wp-note "Phase 5 →
// WP5.2"): Run Sound Check opens the Sound Check panel and runs the check of the active sequence (the engine's
// `sound-check` job, the summary stored as the user's edit); Fix All Safe applies the report's safe fixes (one undo step,
// engine jobs after it) and runs the check again. Agents reach both through the UI command catalogue; the same check
// is MCP `sound_check`, whose fixes they apply with the tools each fix names.
import { t } from '../i18n/runtime.ts';
import { safeFixable } from '../sound/check-model.ts';
import {
	type CheckEngine,
	fixAllSafe,
	reportFor,
	runSoundCheck,
	soundCheckStore,
} from '../sound/check-run.ts';
import { runCommand } from './registry.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const engineOf = (ctx: CommandCtx) => ctx.engine as unknown as CheckEngine;

function pendingSafe(ctx: CommandCtx): number {
	const e = sequenceContext(ctx);
	if (!e) return 0;
	const r = reportFor(e.session, e.seq.id);
	if (!r) return 0;
	const fixed = soundCheckStore(e.session).getState().fixed;
	return safeFixable(r.report.issues).filter((i) => !fixed.includes(i.id)).length;
}

export const soundCheckCommands: UiCommand[] = [
	{
		id: 'sound.runSoundCheck',
		label: 'Run Sound Check',
		description:
			'Open the Sound Check panel and measure the active sequence’s mix as it will be delivered (sync of every placed sound, loudness and true peak against the delivery target, masking, music under the voice, silences, dips, cues, density, repeats, licences, credits); stores the summary (one undo step) and lists the findings with their fixes and five listen-here moments',
		scope: 'global',
		capability: 'engine',
		agentExposed: true,
		when: (ctx) => !!sequenceContext(ctx),
		disabledReason: () => t('Open a sequence first'),
		run: async (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			await runCommand('panel.open.soundCheck', ctx);
			const r = await runSoundCheck(e.session, engineOf(ctx), { sequenceId: e.seq.id });
			if (!r.ok && !r.cancelled)
				ctx.ui.toast({ kind: 'warning', message: t('The Sound Check failed'), detail: r.message });
		},
	},
	{
		id: 'sound.fixAllSafe',
		label: 'Fix All Safe',
		description:
			'Apply every fix the last Sound Check marked safe (each changes only what its finding is about) as one undoable edit — engine jobs such as ducking after it — then run the check again',
		scope: 'global',
		capability: 'engine',
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && pendingSafe(ctx) > 0;
		},
		disabledReason: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return t('Open a sequence first');
			if (e.session.getState().readOnly) return t('The project is read-only');
			return reportFor(e.session, e.seq.id) ? t('No safe fixes left') : t('Run the Sound Check first');
		},
		run: async (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const r = await fixAllSafe(e.session, engineOf(ctx));
			ctx.ui.toast({ kind: r.ok ? 'success' : 'warning', message: r.message });
		},
	},
];
