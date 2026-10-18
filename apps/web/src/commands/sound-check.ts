// Sound Check commands (spec 12 §2.7 "Menus: Sequence ▸ Sound Design ▸ Run Sound Check", P5-R3; wp-note "Phase 5 →
// WP5.2"): Run Sound Check opens the Sound Check panel and runs the check of the active sequence (the engine's
// `sound-check` job, the summary stored as the user's edit); Fix All Safe applies the report's safe fixes (one undo step,
// engine jobs after it) and runs the check again. Agents reach both through the UI command catalogue; the same check
// is MCP `sound_check`, whose fixes they apply with the tools each fix names. Listen to Sequence opens the panel's Log
// tab and runs the listening transcript (spec 12 §4 P6-E6; MCP `listen_to_sequence`). The findings list's keys are commands of
// the Sound Check scope (Keyboard Shortcuts lists them; remappable): ↑ ↓ Home End move, Enter goes to the finding, F
// applies its fix (one that needs judgement asks first), A acknowledges it with a reason (P6-E4), → / ← open / close its
// sync strip, Space plays 4 s around it.
import { t } from '../i18n/runtime.ts';
import { type ListenEngine, runListen, setListenTab } from '../panels/soundCheck/listen-run.ts';
import { canApply, hasSyncStrip, safeFixable } from '../sound/check-model.ts';
import {
	applyCheckFix,
	type CheckEngine,
	currentFinding,
	findingOrder,
	fixAllSafe,
	jumpToIssue,
	openFindings,
	playFinding,
	reportFor,
	runSoundCheck,
	setAckOpen,
	setSyncStrip,
	soundCheckStore,
	stepFinding,
} from '../sound/check-run.ts';
import { runCommand } from './registry.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const engineOf = (ctx: CommandCtx) => ctx.engine as unknown as CheckEngine;
const reveal = (ctx: CommandCtx) => (f: number) => ctx.services.get('timelineViewport')?.scrollToFrame(f);
const hasFindings = (ctx: CommandCtx) => !!ctx.session && findingOrder(ctx.session).length > 0;
const noFindings = () => t('Run the Sound Check first: there are no findings to go through');
const onFinding = (ctx: CommandCtx) => !!ctx.session && currentFinding(ctx.session) !== null;
const noCurrent = () => t('Choose a finding in the Sound Check list first');

const step = (to: number | 'first' | 'last') => ({
	scope: 'soundCheck' as const,
	repeat: typeof to === 'number',
	when: hasFindings,
	disabledReason: noFindings,
	run: (ctx: CommandCtx) => {
		if (ctx.session) stepFinding(ctx.session, to);
	},
});
const strip = (open: boolean) => ({
	scope: 'soundCheck' as const,
	when: (ctx: CommandCtx) => {
		const i = ctx.session && currentFinding(ctx.session);
		return !!i && (!open || hasSyncStrip(i));
	},
	disabledReason: () => (open ? t('Only sync findings have a sync strip') : noCurrent()),
	run: (ctx: CommandCtx) => {
		const i = ctx.session && currentFinding(ctx.session);
		if (ctx.session && i) setSyncStrip(ctx.session, i, open);
	},
});

/** The findings list commands (scope `soundCheck`: the Sound Check panel's list). */
const findingCommands: UiCommand[] = [
	{
		id: 'soundCheck.nextFinding',
		label: 'Next Sound Check Finding',
		description: 'Move the Sound Check findings list to the next finding',
		...step(1),
	},
	{
		id: 'soundCheck.prevFinding',
		label: 'Previous Sound Check Finding',
		description: 'Move the Sound Check findings list to the previous finding',
		...step(-1),
	},
	{
		id: 'soundCheck.firstFinding',
		label: 'First Sound Check Finding',
		description: 'Move the Sound Check findings list to its first finding',
		...step('first'),
	},
	{
		id: 'soundCheck.lastFinding',
		label: 'Last Sound Check Finding',
		description: 'Move the Sound Check findings list to its last finding',
		...step('last'),
	},
	{
		id: 'soundCheck.goToFinding',
		label: 'Go to Sound Check Finding',
		description:
			'Move the playhead to the current Sound Check finding, select its clips (else its cue) and scroll the Timeline there',
		scope: 'soundCheck',
		when: onFinding,
		disabledReason: noCurrent,
		run: (ctx) => {
			const i = ctx.session && currentFinding(ctx.session);
			if (ctx.session && i) jumpToIssue(ctx.session, i, reveal(ctx));
		},
	},
	{
		id: 'soundCheck.fixFinding',
		label: 'Fix Sound Check Finding',
		description:
			'Apply the current Sound Check finding’s fix as one undo step (a fix that needs your judgement asks first, naming what it changes)',
		scope: 'soundCheck',
		capability: 'engine',
		when: (ctx) => {
			const i = ctx.session && currentFinding(ctx.session);
			return !!i && !!i.fix && canApply(i) && !ctx.session!.getState().readOnly;
		},
		disabledReason: (ctx) =>
			ctx.session?.getState().readOnly ? t('The project is read-only') : t('This finding has no fix'),
		run: async (ctx) => {
			const i = ctx.session && currentFinding(ctx.session);
			if (ctx.session && i) await applyCheckFix(ctx.session, engineOf(ctx), i);
		},
	},
	{
		id: 'soundCheck.acknowledgeFinding',
		label: 'Acknowledge Sound Check Finding…',
		description:
			'Mark the current Sound Check finding as a deliberate exception, with a reason: it no longer counts against the verdict until what it is about changes. One undo step',
		scope: 'soundCheck',
		when: (ctx) => onFinding(ctx) && !ctx.session!.getState().readOnly,
		disabledReason: (ctx) =>
			ctx.session?.getState().readOnly ? t('The project is read-only') : noCurrent(),
		run: (ctx) => {
			const i = ctx.session && currentFinding(ctx.session);
			if (ctx.session && i) setAckOpen(ctx.session, i.id);
		},
	},
	{
		id: 'soundCheck.openSyncStrip',
		label: 'Open Sync Strip',
		description:
			'Open the sync strip of the current Sound Check sync finding: five frames around the cue above the sound effects over the bed',
		...strip(true),
	},
	{
		id: 'soundCheck.closeSyncStrip',
		label: 'Close Sync Strip',
		description: 'Close the sync strip of the current Sound Check finding',
		...strip(false),
	},
	{
		id: 'soundCheck.playFinding',
		label: 'Play Sound Check Finding',
		description:
			'Play 4 s around the current Sound Check finding through the Program; the playhead comes back after',
		scope: 'soundCheck',
		when: (ctx) => {
			const i = ctx.session && currentFinding(ctx.session);
			return !!i && (i.frame !== undefined || i.range !== undefined);
		},
		disabledReason: noCurrent,
		run: (ctx) => {
			const i = ctx.session && currentFinding(ctx.session);
			if (ctx.session && i) playFinding(ctx.session, i, reveal(ctx));
		},
	},
];

function pendingSafe(ctx: CommandCtx): number {
	const e = sequenceContext(ctx);
	if (!e) return 0;
	const r = reportFor(e.session, e.seq.id);
	if (!r) return 0;
	const fixed = soundCheckStore(e.session).getState().fixed;
	return safeFixable(openFindings(e.session, r)).filter((i) => !fixed.includes(i.id)).length;
}

export const soundCheckCommands: UiCommand[] = [
	...findingCommands,
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
		id: 'sound.listenToSequence',
		label: 'Listen to Sequence',
		description:
			'Open the Sound Check panel on its Log tab and listen to the active sequence (up to 10 minutes): a written log of the mix — every sound with the clip that plays it and the cue it fills, the sections, the silences, and which cuts and cues have a sound, each share next to what random timing would score (the same log agents read with listen_to_sequence)',
		scope: 'global',
		capability: 'engine',
		agentExposed: true,
		when: (ctx) => !!sequenceContext(ctx),
		disabledReason: () => t('Open a sequence first'),
		run: async (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			await runCommand('panel.open.soundCheck', ctx);
			setListenTab(e.session, 'log');
			const r = await runListen(e.session, ctx.engine as unknown as ListenEngine, { sequenceId: e.seq.id });
			if (!r.ok && !r.cancelled)
				ctx.ui.toast({ kind: 'warning', message: t('The listen failed'), detail: r.message });
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
