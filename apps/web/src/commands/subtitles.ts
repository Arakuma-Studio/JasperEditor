// spec 13 AS-040 / AS-012: UI commands of automatic subtitles — Create Subtitles…, Align Subtitles to Cuts (the
// selected subtitles' groups, else every group of the sequence), the Text panel's Subtitles tab, Select Subtitle Group.
import { captionGroupsOf, captionOf, type Sequence } from '@jasper/project';
import { textPanelRequests } from '../panels/text/state.ts';
import { openCreateSubtitles } from '../subtitles/open.ts';
import { registerSubtitlesUi } from '../subtitles/register.ts';
import { sequenceContext as envOf } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerSubtitlesUi();

const editable = (ctx: CommandCtx) => !!envOf(ctx) && !ctx.session!.getState().readOnly;
const why = (ctx: CommandCtx) =>
	!ctx.session ? 'Open a project first' : !envOf(ctx) ? 'Open a sequence first' : 'The project is read-only';

/** The groups an Align to Cuts targets: those of the selected subtitles, else every group of the sequence. */
export function alignTargets(seq: Sequence, selected: readonly string[]): string[] {
	const fromSel = [
		...new Set(selected.map((id) => captionOf(seq.clips[id])?.groupId).filter((g): g is string => !!g)),
	];
	return fromSel.length ? fromSel : Object.keys(captionGroupsOf(seq));
}

export const subtitleCommands: UiCommand[] = [
	{
		id: 'subtitles.create',
		label: 'Create Subtitles…',
		description:
			'Makes subtitles from the transcript as editable text clips (or a caption track) with a template, Premiere-like rules and cut-aware timing.',
		scope: 'global',
		when: editable,
		disabledReason: why,
		run: (ctx) => {
			const e = envOf(ctx);
			if (e) openCreateSubtitles(e.session, e.seq.id);
		},
	},
	{
		id: 'subtitles.alignToCuts',
		label: 'Align Subtitles to Cuts',
		description:
			'Re-times the selected subtitles’ groups (or every subtitle group) to the picture cuts: splits at cuts, starts on cuts, never across one.',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => {
			const e = envOf(ctx);
			return !!e && editable(ctx) && Object.keys(captionGroupsOf(e.seq)).length > 0;
		},
		disabledReason: (ctx) => {
			const e = envOf(ctx);
			if (!e || !editable(ctx)) return why(ctx);
			return 'The sequence has no subtitle groups (Create Subtitles first).';
		},
		run: (ctx) => {
			const e = envOf(ctx);
			if (!e) return;
			const groups = alignTargets(e.seq, e.session.getState().selection.timeline.clips);
			const r = e.session.apply({
				label: 'Align Subtitles to Cuts',
				origin: 'user',
				sequenceId: e.seq.id,
				commands: groups.map((groupId) => ({ type: 'captions.alignToCuts', groupId })),
			});
			if (!r.ok)
				ctx.ui.toast({
					kind: 'warning',
					message: 'Align Subtitles to Cuts: not possible',
					detail: r.errors[0]?.message,
				});
			else {
				const n = r.results.reduce(
					(s: number, x) => s + ((x as { splitAtCuts?: number }).splitAtCuts ?? 0),
					0,
				);
				const m = r.results.reduce((s: number, x) => s + ((x as { moved?: number }).moved ?? 0), 0);
				ctx.ui.toast({ kind: 'info', message: `Subtitles aligned: ${m} moved, ${n} split at cuts` });
			}
		},
	},
	{
		id: 'subtitles.openPanel',
		label: 'Subtitles',
		description: 'Opens Text ▸ Subtitles (subtitle groups and their text).',
		scope: 'global',
		when: (ctx) => !!envOf(ctx),
		run: (ctx) => {
			textPanelRequests.open('subtitles');
			ctx.services.get('shell')?.focusPanel('text');
		},
	},
];
