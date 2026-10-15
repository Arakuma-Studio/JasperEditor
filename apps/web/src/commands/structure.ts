import type { CommandOf, Sequence } from '@jasper/project';
import {
	type Clip,
	clipAt,
	clipPictureTime,
	flicksPerFrame,
	gapNavigation,
	isNestClip,
	kindCapabilities,
	matchFrame as matchFrameQuery,
	type ProjectDocument,
	reverseMatchFrame as reverseMatchFrameQuery,
	SYNTHETIC_INFO,
	type SyntheticKind,
	throughEdits,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { getSourceTransport } from '../panels/program/transport-registry.ts';
import { openInSource, sourceMonitorState } from '../panels/source/source-state.ts';
import {
	COLOR_MATTE_DIALOG,
	FRAME_HOLD_DIALOG,
	LEADER_DIALOG,
	NEST_DIALOG,
	registerStructureDialogs,
} from '../structure/dialogs.tsx';
import {
	applySequenceCommands as apply,
	type ResolvedSequenceCommandContext as Env,
	sequenceContext as envOf,
	selectedSequenceClips as selected,
} from './sequence-context.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerStructureDialogs();

const editable = (ctx: CommandCtx) => !!envOf(ctx) && !ctx.session!.getState().readOnly;

/** Targeted video tracks (top first), else every unlocked video track. */
function videoTargets(e: Env): string[] {
	const view = e.session.getState().views[e.seq.id];
	const targeted = view?.targeting.video ?? [];
	const ids = (targeted.length ? targeted : e.seq.videoTracks.map((t) => t.id)).filter(
		(id) => !e.seq.videoTracks.find((t) => t.id === id)?.locked,
	);
	const order = e.seq.videoTracks.map((t) => t.id);
	return [...ids].sort((a, b) => order.indexOf(b) - order.indexOf(a));
}

/** The clip the frame-hold and match-frame commands act on: a selected one under the playhead, else the topmost. */
function clipUnderPlayhead(e: Env, kinds?: (c: Clip) => boolean): Clip | null {
	const at = e.playhead;
	const ok = (c: Clip) => c.start <= at && at < c.start + c.duration && (!kinds || kinds(c));
	const sel = selected(e).find(ok);
	if (sel) return sel;
	for (const t of videoTargets(e)) {
		const c = clipAt(e.seq, t, at);
		if (c && ok(c)) return c;
	}
	return null;
}

/** Clips with a picture a frame hold can freeze (video-track kinds except adjustment layers). */
const hasPicture = (c: Clip) => kindCapabilities(c.kind)?.trackKind === 'video' && c.kind !== 'adjustment';

function matchFrame(ctx: CommandCtx, e: Env): void {
	const view = e.session.getState().views[e.seq.id];
	const targeted = [...(view?.targeting.video ?? []), ...(view?.targeting.audio ?? [])];
	const doc = e.session.getCommitted();
	// A selected clip under the playhead wins over the track order (Premiere).
	const sel = e.session.getState().selection.timeline;
	const hit = matchFrameQuery(doc, e.seq.id, e.playhead, {
		trackIds: targeted,
		...(sel.primaryClip ? { clipId: sel.primaryClip } : {}),
	});
	if (!hit) {
		ctx.ui.toast({ kind: 'info', message: 'Match Frame: no clip with a source under the playhead' });
		return;
	}
	const itemId = hit.itemId;
	if (!itemId || !openInSource(e.session, itemId)) {
		ctx.ui.toast({ kind: 'info', message: 'Match Frame: the clip has no project item' });
		return;
	}
	const seq = doc.sequences[hit.sequenceId] ?? e.seq;
	// The Source monitor shows the item after its next render; seek once its transport exists.
	const target = Math.round((hit.sourceTime / 705_600_000) * sourceFpsOf(doc, itemId, seq));
	queueMicrotask(() => {
		const t = getSourceTransport();
		if (t) {
			t.pause();
			t.seek(target);
		}
	});
	setTimeout(() => getSourceTransport()?.seek(target), 50);
}

function sourceFpsOf(doc: ProjectDocument, itemId: string, seq: Sequence): number {
	const it = doc.items[itemId];
	if (it?.kind === 'media' || it?.kind === 'subclip') {
		const vs = doc.media[it.mediaId]?.probe.streams.find((s) => s.type === 'video');
		if (vs?.type === 'video' && doc.media[it.mediaId]?.kind === 'video')
			return vs.frameRate.num / vs.frameRate.den;
	}
	return seq.settings.frameRate.num / seq.settings.frameRate.den;
}

/** Reverse Match Frame (Shift+R): the Source monitor frame in the active sequence, through nests. */
function reverseMatchFrame(ctx: CommandCtx, e: Env): void {
	const doc = e.session.getCommitted();
	const src = sourceMonitorState.getState();
	const item = src.itemId ? doc.items[src.itemId] : undefined;
	if (!item || (item.kind !== 'media' && item.kind !== 'synthetic' && item.kind !== 'subclip')) {
		ctx.ui.toast({ kind: 'info', message: 'Reverse Match Frame: open a clip in the Source monitor' });
		return;
	}
	const sf = getSourceTransport()?.getState().frame ?? 0;
	const flicks = (sf / src.fps) * 705_600_000;
	const view = e.session.getState().views[e.seq.id];
	const found = reverseMatchFrameQuery(
		doc,
		e.seq.id,
		{ itemId: item.id, time: flicks },
		{ trackIds: [...(view?.targeting.video ?? []), ...(view?.targeting.audio ?? [])] },
	);
	if (found === null) {
		ctx.ui.toast({ kind: 'info', message: 'Reverse Match Frame: that frame is not used in this sequence' });
		return;
	}
	e.session.transport.seek(found.frame);
	e.handle?.controller.reveal(found.frame);
}

/** Reveal Nested Sequence (Ctrl+Shift+F) / double-click: opens the nested sequence at the frame shown. */
export function revealNested(session: EditorSession, seq: Sequence, clip: Clip, frame: number): boolean {
	if (!isNestClip(clip)) return false;
	const nested = session.getCommitted().sequences[clip.sequenceId];
	if (!nested) return false;
	const f = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
	const t = clipPictureTime(clip, f, seq.settings.frameRate);
	const nf = Math.max(0, Math.floor(t / flicksPerFrame(nested.settings.frameRate) + 1e-6));
	session.openSequence(nested.id);
	session.transport.seek(nf);
	return true;
}

/** Creates a synthetic source item in the current bin (Project panel), returns its item id. */
export function createSynthetic(
	ctx: CommandCtx,
	kind: SyntheticKind,
	params?: CommandOf<'synthetic.create'>['params'],
	binId?: string | null,
): string | null {
	const session = ctx.session;
	if (!session) return null;
	const r = session.apply({
		label: `New ${SYNTHETIC_INFO[kind].label}`,
		origin: 'user',
		commands: [
			{
				type: 'synthetic.create',
				kind,
				...(params ? { params } : {}),
				...(binId !== undefined ? { binId } : {}),
			},
		],
	});
	if (!r.ok) {
		ctx.ui.toast({
			kind: 'warning',
			message: `Could not create the ${SYNTHETIC_INFO[kind].label}`,
			detail: r.errors[0]?.message,
		});
		return null;
	}
	const itemId = (r.results[0] as { itemId: string }).itemId;
	session.select('project', [itemId], 'replace');
	return itemId;
}

const binArg = (args: unknown) => {
	const b = (args as { binId?: string | null } | undefined)?.binId;
	return b === undefined ? undefined : b;
};

const newItem = (id: string, kind: SyntheticKind, label: string, dialog?: string): UiCommand => ({
	id,
	label,
	scope: 'global',
	when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
	run: (ctx, args) => {
		if (dialog) ctx.ui.openDialog(dialog, { session: ctx.session, binId: binArg(args) ?? null });
		else createSynthetic(ctx, kind, undefined, binArg(args));
	},
	agentExposed: true,
});

const E: CommandScope = 'editing';
const T: CommandScope = 'timeline';

function cmd(
	id: string,
	label: string,
	scope: CommandScope,
	run: (ctx: CommandCtx, e: Env, args?: unknown) => void,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		scope,
		when: (ctx) => !!envOf(ctx),
		run: (ctx, args) => {
			const e = envOf(ctx);
			if (e) run(ctx, e, args);
		},
		agentExposed: true,
		...extra,
	};
}

export const structureCommands: UiCommand[] = [
	cmd(
		'timeline.group',
		'Group',
		T,
		(ctx, e) => {
			const clips = selected(e);
			if (clips.length < 2) return;
			apply(ctx, e, 'Group', [{ type: 'clip.group', clipIds: clips.map((c) => c.id) }]);
		},
		{ when: (ctx) => editable(ctx) && selected(envOf(ctx)!).length > 1 },
	),
	cmd(
		'timeline.ungroup',
		'Ungroup',
		T,
		(ctx, e) => {
			const clips = selected(e).filter((c) => c.groupId);
			if (clips.length) apply(ctx, e, 'Ungroup', [{ type: 'clip.ungroup', clipIds: clips.map((c) => c.id) }]);
		},
		{ when: (ctx) => editable(ctx) && selected(envOf(ctx)!).some((c) => c.groupId) },
	),
	cmd(
		'clip.nest',
		'Nest…',
		T,
		(ctx, e) => {
			const clips = selected(e);
			if (!clips.length) return;
			ctx.ui.openDialog(NEST_DIALOG, {
				session: e.session,
				sequenceId: e.seq.id,
				clipIds: clips.map((c) => c.id),
			});
		},
		{ when: (ctx) => editable(ctx) && selected(envOf(ctx)!).length > 0 },
	),
	cmd(
		'clip.unnest',
		'Unnest',
		T,
		(ctx, e) => {
			const clips = selected(e).filter(isNestClip);
			if (!clips.length) return;
			apply(ctx, e, 'Unnest', [{ type: 'clip.unnest', clipIds: clips.map((c) => c.id) }], (r) => ({
				timeline: (r.results[0] as { clipIds: string[] }).clipIds,
			}));
		},
		{ when: (ctx) => editable(ctx) && selected(envOf(ctx)!).some(isNestClip) },
	),
	cmd('timeline.revealNested', 'Reveal Nested Sequence', E, (ctx, e) => {
		const c = clipUnderPlayhead(e, isNestClip);
		if (!c || !revealNested(e.session, e.seq, c, e.playhead))
			ctx.ui.toast({ kind: 'info', message: 'No nested sequence under the playhead' });
	}),
	cmd('timeline.matchFrame', 'Match Frame', E, (ctx, e) => matchFrame(ctx, e)),
	cmd('timeline.reverseMatchFrame', 'Reverse Match Frame', E, (ctx, e) => reverseMatchFrame(ctx, e)),
	cmd(
		'timeline.addFrameHold',
		'Add Frame Hold',
		E,
		(ctx, e) => {
			const sel = selected(e).filter(
				(c) => hasPicture(c) && c.start <= e.playhead && e.playhead < c.start + c.duration,
			);
			const target = sel.length ? sel : [clipUnderPlayhead(e, hasPicture)].filter((c): c is Clip => !!c);
			if (!target.length) {
				ctx.ui.toast({ kind: 'info', message: 'Add Frame Hold: place the playhead over a video clip' });
				return;
			}
			apply(
				ctx,
				e,
				'Add Frame Hold',
				[{ type: 'clip.addFrameHold', at: e.playhead, clipIds: target.map((c) => c.id) }],
				(r) => ({ timeline: (r.results[0] as { clipIds: string[] }).clipIds }),
			);
		},
		{ when: editable },
	),
	cmd(
		'timeline.insertFrameHoldSegment',
		'Insert Frame Hold Segment',
		E,
		(ctx, e) => {
			const c = clipUnderPlayhead(e, hasPicture);
			if (!c) {
				ctx.ui.toast({
					kind: 'info',
					message: 'Insert Frame Hold Segment: place the playhead over a video clip',
				});
				return;
			}
			apply(
				ctx,
				e,
				'Insert Frame Hold Segment',
				[{ type: 'clip.insertFrameHoldSegment', clipId: c.id, at: e.playhead }],
				(r) => ({ timeline: [(r.results[0] as { clipId: string }).clipId] }),
			);
		},
		{ when: editable },
	),
	cmd(
		'timeline.frameHoldOptions',
		'Frame Hold Options…',
		T,
		(ctx, e) => {
			const clips = selected(e).filter(hasPicture);
			if (!clips.length) return;
			ctx.ui.openDialog(FRAME_HOLD_DIALOG, {
				session: e.session,
				sequenceId: e.seq.id,
				clipIds: clips.map((c) => c.id),
				playhead: e.playhead,
			});
		},
		{ when: (ctx) => editable(ctx) && selected(envOf(ctx)!).some(hasPicture) },
	),
	cmd(
		'sequence.showThroughEdits',
		'Show Through Edits',
		E,
		(_ctx, e) =>
			e.session.setToggles({ showThroughEdits: e.session.getState().toggles.showThroughEdits === false }),
		{ checked: (ctx) => ctx.session?.getState().toggles.showThroughEdits !== false },
	),
	cmd(
		'timeline.joinThroughEdits',
		'Join Through Edits',
		T,
		(ctx, e) => {
			const clips = selected(e);
			apply(ctx, e, 'Join Through Edits', [
				{ type: 'sequence.joinThroughEdits', ...(clips.length ? { clipIds: clips.map((c) => c.id) } : {}) },
			]);
		},
		{ when: (ctx) => editable(ctx) && throughEdits(envOf(ctx)!.seq).length > 0 },
	),
	...(
		[
			['sequence.goToNextGap', 'Go to Next Gap in Sequence', 1, false],
			['sequence.goToPrevGap', 'Go to Previous Gap in Sequence', -1, false],
			['sequence.goToNextGapInTrack', 'Go to Next Gap in Track', 1, true],
			['sequence.goToPrevGapInTrack', 'Go to Previous Gap in Track', -1, true],
		] as const
	).map(([id, label, dir, inTrack]) =>
		cmd(id, label, E, (ctx, e) => {
			const view = e.session.getState().views[e.seq.id];
			const targeted = [...(view?.targeting.video ?? []), ...(view?.targeting.audio ?? [])];
			const tracks = inTrack
				? targeted.length
					? targeted
					: [...e.seq.videoTracks, ...e.seq.audioTracks].map((t) => t.id)
				: undefined;
			const f = gapNavigation(e.seq, e.playhead, dir, tracks);
			if (f === null) {
				ctx.ui.toast({ kind: 'info', message: 'No gap there' });
				return;
			}
			e.session.transport.seek(f);
			e.handle?.controller.reveal(f);
		}),
	),
	cmd(
		'sequence.makeSubsequence',
		'Make Subsequence',
		E,
		(ctx, e) => {
			const clips = selected(e);
			const view = e.session.getState().views[e.seq.id];
			const targeted = [...(view?.targeting.video ?? []), ...(view?.targeting.audio ?? [])];
			if (!clips.length && (e.seq.inPoint === null || e.seq.outPoint === null)) {
				ctx.ui.toast({ kind: 'info', message: 'Make Subsequence: select clips or mark In and Out' });
				return;
			}
			const r = apply(ctx, e, 'Make Subsequence', [
				{
					type: 'sequence.makeSubsequence',
					sequenceId: e.seq.id,
					...(clips.length
						? { clipIds: clips.map((c) => c.id) }
						: targeted.length
							? { tracks: targeted }
							: {}),
				},
			]);
			if (r.ok) e.session.select('project', [(r.results[0] as { itemId: string }).itemId], 'replace');
		},
		{ when: editable },
	),
	cmd(
		'timeline.toggleNestInsert',
		'Insert and Overwrite Sequences as Nests or Individual Clips',
		E,
		(_ctx, e) =>
			e.session.setToggles({
				insertSequencesAsNests: e.session.getState().toggles.insertSequencesAsNests === false,
			}),
		{ checked: (ctx) => ctx.session?.getState().toggles.insertSequencesAsNests !== false },
	),
	newItem('project.newAdjustmentLayer', 'adjustment', 'Adjustment Layer'),
	newItem('project.newBarsAndTone', 'bars-and-tone', 'Bars and Tone'),
	newItem('project.newBlackVideo', 'black-video', 'Black Video'),
	newItem('project.newColorMatte', 'color-matte', 'Color Matte…', COLOR_MATTE_DIALOG),
	newItem('project.newTransparentVideo', 'transparent', 'Transparent Video'),
	newItem('project.newCountingLeader', 'counting-leader', 'Universal Counting Leader…', LEADER_DIALOG),
	{
		id: 'project.editSynthetic',
		label: 'Edit Synthetic…',
		scope: 'global',
		when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
		run: (ctx, args) => {
			const session = ctx.session;
			const itemId = (args as { itemId?: string } | undefined)?.itemId;
			const item = itemId ? session?.getCommitted().items[itemId] : undefined;
			if (!session || item?.kind !== 'synthetic') return;
			const syn = session.getCommitted().synthetics[item.syntheticId];
			if (syn?.kind === 'color-matte')
				ctx.ui.openDialog(COLOR_MATTE_DIALOG, { session, syntheticId: syn.id });
			else if (syn?.kind === 'counting-leader')
				ctx.ui.openDialog(LEADER_DIALOG, { session, syntheticId: syn.id });
		},
	},
	{
		id: 'project.duplicateSequence',
		label: 'Duplicate',
		scope: 'global',
		when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
		run: (ctx, args) => {
			const session = ctx.session;
			if (!session) return;
			const doc = session.getCommitted();
			const ids =
				(args as { itemIds?: string[] } | undefined)?.itemIds ?? session.getState().selection.project.items;
			const seqs = ids
				.map((id) => doc.items[id])
				.filter((it): it is Extract<typeof it, { kind: 'sequence' }> => it?.kind === 'sequence');
			if (!seqs.length) return;
			const r = session.apply({
				label: 'Duplicate',
				origin: 'user',
				commands: seqs.map((it) => ({ type: 'sequence.duplicate', sequenceId: it.sequenceId })),
			});
			if (!r.ok) ctx.ui.toast({ kind: 'warning', message: 'Duplicate failed', detail: r.errors[0]?.message });
			else
				session.select(
					'project',
					r.results.map((x) => (x as { itemId: string }).itemId),
					'replace',
				);
		},
	},
	{
		id: 'edit.removeUnused',
		label: 'Remove Unused',
		scope: 'global',
		when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
		run: (ctx) => {
			const session = ctx.session;
			if (!session) return;
			const r = session.apply({
				label: 'Remove Unused',
				origin: 'user',
				commands: [{ type: 'media.removeUnused' }],
			});
			if (!r.ok)
				ctx.ui.toast({ kind: 'warning', message: 'Remove Unused failed', detail: r.errors[0]?.message });
			else {
				const n = (r.results[0] as { removed: string[] }).removed.length;
				ctx.ui.toast({
					kind: 'info',
					message: n ? `Removed ${n} unused item${n === 1 ? '' : 's'}` : 'No unused items',
				});
			}
		},
		agentExposed: true,
	},
];
