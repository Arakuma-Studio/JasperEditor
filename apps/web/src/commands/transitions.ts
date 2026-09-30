// M2 UI commands: Apply Default Transitions (Ctrl+D, Ctrl+Shift+D, Shift+D), transition editing. Owner: wp-m2-transitions (ARCHITECTURE §19.10).
// This module is imported at start-up (commands/index.ts), so it is also where the package registers its UI
// extensions (extensions/index.ts: effect editors, clip sections, Program overlays, menu entries).
//
// S10:TUI-030: the keymap ids already bound in keymap-defaults.ts; every invocation is one history entry
// through `transition.applyDefault` with the M2 fields. TUI-015: Delete / Backspace with transitions selected
// removes them (the Timeline's Clear / Ripple Delete are wrapped: with no transition selected they run as
// before). TUI-046: the clip context menu gains "Apply Default Transitions".
import type { Clip, Sequence, TransactionResult } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { clipMenuExtensions } from '../extensions/index.ts';
import { transitionDefaults } from '../panels/effects/transition-prefs.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import { nearestEditPoint } from '../panels/timeline/model/transitions.ts';
import { timelineCommands } from './timeline.ts';
import type { CommandCtx, UiCommand } from './types.ts';

type Medium = 'video' | 'audio';

type Env = { session: EditorSession; seq: Sequence };

function envOf(ctx: CommandCtx): Env | null {
	const session = ctx.session;
	if (!session) return null;
	const handle = activeTimeline(ctx.services);
	const seqId = handle?.sequenceId() ?? session.getState().activeSequenceId;
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	return seq ? { session, seq } : null;
}

const hasSeq = (ctx: CommandCtx) => envOf(ctx) !== null;

function tracksOf(seq: Sequence, medium: Medium) {
	return medium === 'video' ? seq.videoTracks : seq.audioTracks;
}

function selectedClips(e: Env, media: readonly Medium[]): Clip[] {
	const ids = new Set(media.flatMap((m) => tracksOf(e.seq, m).map((t) => t.id)));
	return e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c && ids.has(c.trackId));
}

/** Frames visible in the active Timeline panel (the playhead edit point must be on screen, TUI-030). */
function visibleRange(ctx: CommandCtx): { f0: number; f1: number } | undefined {
	const handle = activeTimeline(ctx.services);
	if (!handle) return undefined;
	const v = handle.controller.env.geometry().viewport;
	if (!(v.width > 0 && v.pxPerFrame > 0)) return undefined;
	return { f0: v.scrollFrame, f1: v.scrollFrame + v.width / v.pxPerFrame };
}

/** Targeted tracks of a medium (all unlocked tracks of it when none is targeted, TL-251). */
function targetedTracks(e: Env, medium: Medium): string[] {
	const view = e.session.getState().views[e.seq.id];
	const unlocked = tracksOf(e.seq, medium).filter((t) => !t.locked);
	const targeted = (medium === 'video' ? view?.targeting.video : view?.targeting.audio) ?? [];
	const list = unlocked.filter((t) => targeted.includes(t.id));
	return (list.length ? list : unlocked).map((t) => t.id);
}

/** The `transition.applyDefault` commands of one invocation (TUI-030). */
export function defaultTransitionCommands(
	ctx: CommandCtx,
	e: Env,
	media: readonly Medium[],
	requireSelection: boolean,
): Record<string, unknown>[] {
	const prefs = transitionDefaults().getState();
	const fields = {
		media: [...media],
		...(media.includes('video') ? { videoEffectId: prefs.video } : {}),
		...(media.includes('audio') ? { audioEffectId: prefs.audio } : {}),
	};
	const clips = selectedClips(e, media);
	if (clips.length)
		return [{ type: 'transition.applyDefault', clipIds: clips.map((c) => c.id), edges: 'both', ...fields }];
	if (requireSelection) return [];
	// No clip selected: the edit point nearest the playhead (within the visible range) on every targeted track.
	const playhead = e.session.transport.getState().frame;
	const range = visibleRange(ctx);
	const byEdge: Record<'in' | 'out', string[]> = { in: [], out: [] };
	for (const medium of media)
		for (const trackId of targetedTracks(e, medium)) {
			const ep = nearestEditPoint(e.seq, trackId, playhead, range);
			if (ep) byEdge[ep.edge].push(ep.clip.id);
		}
	return (['in', 'out'] as const)
		.filter((edge) => byEdge[edge].length)
		.map((edge) => ({ type: 'transition.applyDefault', clipIds: byEdge[edge], edges: edge, ...fields }));
}

function applyDefaults(
	ctx: CommandCtx,
	media: readonly Medium[],
	label: string,
	requireSelection = false,
): TransactionResult | null {
	const e = envOf(ctx);
	if (!e) return null;
	const commands = defaultTransitionCommands(ctx, e, media, requireSelection);
	if (!commands.length) {
		ctx.ui.toast({
			kind: 'info',
			message: requireSelection
				? 'Select clips first'
				: 'No edit point near the playhead on the targeted tracks',
		});
		return null;
	}
	const r = e.session.apply({ label, origin: 'user', sequenceId: e.seq.id, commands: commands as never[] });
	if (!r.ok) {
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
		return r;
	}
	const created = r.results.flatMap((x) => (x as { transitionIds?: string[] })?.transitionIds ?? []);
	if (!created.length)
		ctx.ui.toast({ kind: 'info', message: 'No room for a transition there (media handles or clip length)' });
	else if (r.warnings.length)
		ctx.ui.toast({
			kind: 'warning',
			message: `${label}: ${created.length} added`,
			detail: r.warnings[0]!.message,
		});
	return r;
}

/** TUI-015: removes the selected transitions (one entry). False when none is selected. */
export function clearSelectedTransitions(ctx: CommandCtx): boolean {
	const e = envOf(ctx);
	if (!e) return false;
	const ids = e.session.getState().selection.timeline.transitions.filter((id) => !!e.seq.transitions[id]);
	if (!ids.length) return false;
	const r = e.session.apply({
		label: ids.length > 1 ? 'Clear Transitions' : 'Clear Transition',
		origin: 'user',
		sequenceId: e.seq.id,
		commands: [{ type: 'transition.remove', transitionIds: ids }] as never[],
	});
	if (r.ok) e.session.select('transitions', [], 'replace');
	else ctx.ui.toast({ kind: 'warning', message: 'Clear: not possible', detail: r.errors[0]?.message });
	return true;
}

/** Wraps a Timeline delete command: selected transitions go first, otherwise the original runs. */
function withTransitionClear(id: string): UiCommand[] {
	const base = timelineCommands.find((c) => c.id === id);
	if (!base) return [];
	return [
		{
			...base,
			run: (ctx, args) => {
				if (clearSelectedTransitions(ctx)) return;
				return base.run(ctx, args);
			},
		},
	];
}

const T = 'timeline' as const;

export const transitionCommands: UiCommand[] = [
	{
		id: 'timeline.applyDefaultVideoTransition',
		label: 'Apply Video Transition',
		description:
			'Default video transition at both edges of the selected clips, or at the edit point nearest the playhead on the targeted video tracks',
		scope: T,
		when: hasSeq,
		agentExposed: true,
		run: (ctx) => void applyDefaults(ctx, ['video'], 'Apply Video Transition'),
	},
	{
		id: 'timeline.applyDefaultAudioTransition',
		label: 'Apply Audio Transition',
		description:
			'Default audio transition at both edges of the selected clips, or at the edit point nearest the playhead on the targeted audio tracks',
		scope: T,
		when: hasSeq,
		agentExposed: true,
		run: (ctx) => void applyDefaults(ctx, ['audio'], 'Apply Audio Transition'),
	},
	{
		id: 'timeline.applyDefaultTransitionsToSelection',
		label: 'Apply Default Transitions to Selection',
		description: 'Default video and audio transitions at both edges of the selected clips',
		scope: T,
		when: hasSeq,
		agentExposed: true,
		run: (ctx) => void applyDefaults(ctx, ['video', 'audio'], 'Apply Default Transitions', true),
	},
	...withTransitionClear('timeline.clear'),
	...withTransitionClear('timeline.rippleDelete'),
];

// TUI-046 (P1): "Apply Default Transitions" in the timeline clip context menu.
clipMenuExtensions.register({
	id: 'wp-m2-transitions.apply-default',
	order: 50,
	items: ({ session, clip, selection }) => {
		const ids = selection.includes(clip.id) ? [...selection] : [clip.id];
		const run = (edges: 'in' | 'out' | 'both') => {
			const prefs = transitionDefaults().getState();
			const r = session.apply({
				label: 'Apply Default Transitions',
				origin: 'user',
				commands: [
					{
						type: 'transition.applyDefault',
						clipIds: ids,
						edges,
						media: ['video', 'audio'],
						videoEffectId: prefs.video,
						audioEffectId: prefs.audio,
					},
				] as never[],
			});
			if (!r.ok) console.warn('[transitions] Apply Default Transitions refused', r.errors);
		};
		return [
			{
				kind: 'submenu',
				label: 'Apply Default Transitions',
				items: [
					{ kind: 'item', label: 'In', run: () => run('in') },
					{ kind: 'item', label: 'Out', run: () => run('out') },
					{ kind: 'item', label: 'Both', run: () => run('both') },
				],
			},
		];
	},
});
