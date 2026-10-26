// Clean Up Voice commands (spec 14 TC-040…TC-043; docs/wp-notes/transcript-cleanup.md "Clean Up UI"): Sequence ▸ Clean
// Up Voice… opens the Text panel's Transcript tab in Clean Up mode; the review keys live in the Text panel's scope and
// are enabled only while a review is open there and no text field has the focus (so they never take a key from
// another panel or from typing): ↑ / ↓ previous / next finding, Enter cut it, Backspace / Delete keep it, U clear the
// decision, Shift+Enter / Shift+Backspace the whole kind, Space plays ±1 s around it, Shift+Space plays the result,
// Esc stops a preview, Ctrl+Enter (mac Cmd+Enter) applies. Agents reach the same through the UI command catalogue
// (and the MCP tools analyze_voice / plan_cleanup / apply_cleanup).
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { cleanupFor } from '../panels/text/cleanup/controller.ts';
import { registerCleanupUi } from '../panels/text/cleanup/register.tsx';
import { textPanelRequests } from '../panels/text/state.ts';
import { classifyTarget } from '../shell/keymap/dispatcher.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerCleanupUi();

/** No text field, list box or dialog has the focus (the review keys are single keys / Enter). */
function notTyping(): boolean {
	if (typeof document === 'undefined') return true;
	const k = classifyTarget(document.activeElement);
	return k !== 'editable' && k !== 'overlay';
}

const reviewOpen = (ctx: CommandCtx) => {
	if (!ctx.session) return false;
	const s = cleanupFor(ctx.session).getState();
	return s.mode === 'cleanup' && s.phase === 'review' && !!s.analysis;
};
const reviewKeys = (ctx: CommandCtx) => reviewOpen(ctx) && notTyping();
const reason = (ctx: CommandCtx) =>
	!ctx.session
		? t('Open a project first')
		: t('Open Clean Up (Sequence ▸ Clean Up Voice…) and Analyze first');

const FindingArgs = z
	.object({
		/** The finding (`f…` of the review); default the current one. */
		findingId: z.string().min(1).max(64).optional(),
	})
	.strict()
	.optional();

const KindArgs = z
	.object({ kind: z.string().min(1).max(40).optional() })
	.strict()
	.optional();

function review(
	id: string,
	label: string,
	description: string,
	run: (ctx: CommandCtx, args?: unknown) => void,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		description,
		scope: 'text',
		when: reviewKeys,
		disabledReason: reason,
		run,
		agentExposed: true,
		...extra,
	};
}

const findingOf = (args: unknown) => FindingArgs.parse(args)?.findingId;

export const cleanupCommands: UiCommand[] = [
	{
		id: 'transcript.cleanUpVoice',
		label: 'Clean Up Voice…',
		description:
			'Open the Text panel ▸ Transcript in Clean Up mode: find retakes, restarts, fillers, pauses and breaths in the transcribed speech, review them and cut them in one undo step',
		scope: 'global',
		when: (ctx) => !!sequenceContext(ctx) && !ctx.session!.getState().readOnly,
		disabledReason: (ctx) =>
			!ctx.session
				? t('Open a project first')
				: !sequenceContext(ctx)
					? t('Open a sequence first')
					: t('The project is read-only'),
		run: (ctx) => {
			if (!ctx.session) return;
			const c = cleanupFor(ctx.session);
			c.attachEngine(ctx.engine);
			c.setMode('cleanup');
			textPanelRequests.open('transcript', undefined, 'cleanup');
			ctx.services.get('shell')?.focusPanel('text');
		},
		agentExposed: true,
	},
	{
		id: 'cleanup.analyze',
		label: 'Analyze Speech for Clean Up',
		description:
			'Run the Clean Up analysis of the active sequence with its preset, script and the chosen scope',
		scope: 'global',
		when: (ctx) => {
			if (!ctx.session || !sequenceContext(ctx)) return false;
			const p = cleanupFor(ctx.session).getState().phase;
			return p !== 'analyzing' && p !== 'loading' && p !== 'applying';
		},
		disabledReason: (ctx) => (!ctx.session ? t('Open a project first') : t('An analysis is running')),
		run: async (ctx) => {
			if (!ctx.session) return;
			const c = cleanupFor(ctx.session);
			c.setMode('cleanup');
			textPanelRequests.open('transcript', undefined, 'cleanup');
			const r = await c.analyze(ctx.engine);
			if (!r.ok && r.reason !== 'superseded')
				ctx.ui.toast({ kind: 'warning', message: t('Clean Up Voice'), detail: r.reason });
		},
		agentExposed: true,
	},
	{
		id: 'cleanup.cancel',
		label: 'Cancel Clean Up Analysis',
		scope: 'global',
		when: (ctx) => {
			if (!ctx.session) return false;
			const p = cleanupFor(ctx.session).getState().phase;
			return p === 'analyzing' || p === 'loading';
		},
		disabledReason: () => t('No analysis is running'),
		run: async (ctx) => {
			if (ctx.session) await cleanupFor(ctx.session).cancel();
		},
		agentExposed: true,
	},
	review(
		'cleanup.nextFinding',
		'Next Clean Up Finding',
		'Move to the next finding in the list',
		(ctx) => {
			cleanupFor(ctx.session!).step(1);
		},
		{ repeat: true },
	),
	review(
		'cleanup.prevFinding',
		'Previous Clean Up Finding',
		'Move to the previous finding in the list',
		(ctx) => {
			cleanupFor(ctx.session!).step(-1);
		},
		{ repeat: true },
	),
	review(
		'cleanup.acceptFinding',
		'Cut Finding',
		'Cut the current finding (then move on when auto-advance is on)',
		(ctx, args) => {
			cleanupFor(ctx.session!).decide('accept', findingOf(args));
		},
		{ argsSchema: FindingArgs },
	),
	review(
		'cleanup.rejectFinding',
		'Keep Finding',
		'Keep the current finding: it is not cut, and Apply remembers the rejection for later analyses',
		(ctx, args) => {
			cleanupFor(ctx.session!).decide('reject', findingOf(args));
		},
		{ argsSchema: FindingArgs },
	),
	review(
		'cleanup.clearFinding',
		'Clear Finding Decision',
		'Back to the suggestion for the current finding',
		(ctx, args) => {
			cleanupFor(ctx.session!).decide('clear', findingOf(args));
		},
		{ argsSchema: FindingArgs },
	),
	review(
		'cleanup.acceptKind',
		'Cut Every Finding of This Kind',
		'Cut all findings of the current finding’s kind',
		(ctx, args) => {
			const k = KindArgs.parse(args)?.kind;
			cleanupFor(ctx.session!).decideKind('accept', k as never);
		},
		{ argsSchema: KindArgs },
	),
	review(
		'cleanup.rejectKind',
		'Keep Every Finding of This Kind',
		'Keep all findings of the current finding’s kind',
		(ctx, args) => {
			const k = KindArgs.parse(args)?.kind;
			cleanupFor(ctx.session!).decideKind('reject', k as never);
		},
		{ argsSchema: KindArgs },
	),
	review(
		'cleanup.previewFinding',
		'Play Around Finding',
		'Play the timeline from 1 s before the current finding to 1 s after it',
		(ctx, args) => {
			const r = cleanupFor(ctx.session!).previewFinding(findingOf(args));
			if (!r.ok) ctx.ui.toast({ kind: 'info', message: r.reason });
		},
		{ argsSchema: FindingArgs },
	),
	review(
		'cleanup.playResult',
		'Play Clean Up Result',
		'Play the timeline with the cuts applied (nothing changes)',
		(ctx) => {
			const r = cleanupFor(ctx.session!).playResult();
			if (!r.ok) ctx.ui.toast({ kind: 'info', message: r.reason });
		},
	),
	review(
		'cleanup.playRemoved',
		'Play What Clean Up Removes',
		'Play only the parts the cuts remove',
		(ctx) => {
			const r = cleanupFor(ctx.session!).playRemoved();
			if (!r.ok) ctx.ui.toast({ kind: 'info', message: r.reason });
		},
	),
	{
		id: 'cleanup.stopPreview',
		label: 'Stop Clean Up Preview',
		scope: 'text',
		when: (ctx) => !!ctx.session && cleanupFor(ctx.session).getState().preview !== null,
		disabledReason: () => t('No Clean Up preview is playing'),
		run: (ctx) => cleanupFor(ctx.session!).stopPreview(),
		agentExposed: true,
	},
	review(
		'cleanup.apply',
		'Apply Clean Up',
		'Cut everything the review removes, in one undo step ("Clean Up Voice: N cuts")',
		(ctx) => {
			const r = cleanupFor(ctx.session!).apply();
			ctx.ui.toast(
				r.ok
					? {
							kind: 'success',
							message: t('Clean Up applied'),
							detail: t('Edit ▸ Undo reverts it in one step.'),
						}
					: { kind: 'warning', message: t('Clean Up Voice'), detail: r.reason },
			);
		},
		{
			when: (ctx) =>
				reviewKeys(ctx) &&
				!ctx.session!.getState().readOnly &&
				cleanupFor(ctx.session!).applyBlocker() === null,
			disabledReason: (ctx) =>
				ctx.session ? (cleanupFor(ctx.session).applyBlocker() ?? reason(ctx)) : reason(ctx),
		},
	),
];
