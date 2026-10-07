// edit-structure UI commands (docs/wp-notes/edit-structure.md): Group / Ungroup, Nest… / Unnest, Reveal Nested
// Sequence, Match Frame and Reverse Match Frame (through nests), frame holds, through edits, Go to Gap, Make
// Subsequence, the nest/individual-clips placement toggle and Project panel ▸ New Item synthetics, Duplicate and
// Remove Unused. Each edit is one document transaction (the commands of @jasper/project).
import {
	type Clip,
	clipAt,
	clipPictureTime,
	flicksPerFrame,
	gapNavigation,
	isNestClip,
	kindCapabilities,
	multicamView,
	type ProjectDocument,
	type Rational,
	type Sequence,
	SYNTHETIC_INFO,
	type SyntheticKind,
	type TransactionResult,
	throughEdits,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { getSourceTransport } from '../panels/program/transport-registry.ts';
import { openInSource, sourceMonitorState } from '../panels/source/source-state.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import {
	COLOR_MATTE_DIALOG,
	FRAME_HOLD_DIALOG,
	LEADER_DIALOG,
	NEST_DIALOG,
	registerStructureDialogs,
} from '../structure/dialogs.tsx';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerStructureDialogs();

type Env = { session: EditorSession; seq: Sequence; playhead: number };

function envOf(ctx: CommandCtx): Env | null {
	const session = ctx.session;
	if (!session) return null;
	const s = session.getState();
	const seqId = activeTimeline(ctx.services)?.sequenceId() ?? s.activeSequenceId;
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return null;
	return { session, seq, playhead: session.transport.getState().frame };
}

const editable = (ctx: CommandCtx) => !!envOf(ctx) && !ctx.session!.getState().readOnly;
const selected = (e: Env): Clip[] =>
	e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c);

function apply(
	ctx: CommandCtx,
	e: Env,
	label: string,
	commands: unknown[],
	selectAfter?: (r: Extract<TransactionResult, { ok: true }>) => { timeline: string[] },
): TransactionResult {
	const r = e.session.apply({
		label,
		origin: 'user',
		sequenceId: e.seq.id,
		commands: commands as never[],
		...(selectAfter ? { selectAfter: selectAfter as never } : {}),
	});
	if (!r.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
	else if (r.warnings.length) ctx.ui.toast({ kind: 'info', message: r.warnings[0]!.message });
	return r;
}

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

// ---------------------------------------------------------------- match frame through nests

/** The media clip shown at `frame` of `seq` (topmost video first, then audio), descending into nests. */
export function resolveMatchFrame(
	doc: ProjectDocument,
	seq: Sequence,
	frame: number,
	trackIds?: readonly string[],
	depth = 0,
): { clip: Clip; seq: Sequence; contentFlicks: number } | null {
	if (depth > 16) return null;
	const rate = seq.settings.frameRate as Rational;
	const order = [
		...[...seq.videoTracks].reverse().map((t) => t.id),
		...seq.audioTracks.map((t) => t.id),
	].filter((id) => !trackIds || trackIds.includes(id));
	for (const t of order) {
		const c = clipAt(seq, t, frame);
		if (!c) continue;
		const time = clipPictureTime(c as never, frame, rate);
		if (isNestClip(c)) {
			const whole = doc.sequences[(c as { sequenceId: string }).sequenceId];
			if (!whole) continue;
			// wp-multicam: an enabled multi-camera clip matches its active angle only (Premiere).
			const nested = multicamView(whole as Sequence, c);
			const only =
				nested === whole
					? undefined
					: [
							...nested.videoTracks.filter((t) => t.output !== false).map((t) => t.id),
							...nested.audioTracks.filter((t) => !t.mute).map((t) => t.id),
						];
			const nf = Math.floor(time / flicksPerFrame(nested.settings.frameRate as Rational) + 1e-6);
			const hit = resolveMatchFrame(doc, nested as Sequence, nf, only, depth + 1);
			if (hit) return hit;
			continue;
		}
		if ((c as { mediaId?: string }).mediaId || (c as { syntheticId?: string }).syntheticId)
			return { clip: c, seq, contentFlicks: time };
	}
	return null;
}

function projectItemOfClip(doc: ProjectDocument, c: Clip): string | null {
	const m = (c as { mediaId?: string }).mediaId;
	const s = (c as { syntheticId?: string }).syntheticId;
	for (const it of Object.values(doc.items)) {
		if (m && it.kind === 'media' && it.mediaId === m) return it.id;
		if (s && it.kind === 'synthetic' && it.syntheticId === s) return it.id;
	}
	return null;
}

function matchFrame(ctx: CommandCtx, e: Env): void {
	const view = e.session.getState().views[e.seq.id];
	const targeted = [...(view?.targeting.video ?? []), ...(view?.targeting.audio ?? [])];
	const doc = e.session.getCommitted();
	const hit =
		resolveMatchFrame(doc, e.seq, e.playhead, targeted.length ? targeted : undefined) ??
		resolveMatchFrame(doc, e.seq, e.playhead);
	if (!hit) {
		ctx.ui.toast({ kind: 'info', message: 'Match Frame: no clip with a source under the playhead' });
		return;
	}
	const itemId = projectItemOfClip(doc, hit.clip);
	if (!itemId || !openInSource(e.session, itemId)) {
		ctx.ui.toast({ kind: 'info', message: 'Match Frame: the clip has no project item' });
		return;
	}
	// The Source monitor shows the item after its next render; seek once its transport exists.
	const target = Math.round((hit.contentFlicks / 705_600_000) * sourceFpsOf(doc, itemId, hit.seq));
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
	if (it?.kind === 'media') {
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
	if (!item || (item.kind !== 'media' && item.kind !== 'synthetic')) {
		ctx.ui.toast({ kind: 'info', message: 'Reverse Match Frame: open a clip in the Source monitor' });
		return;
	}
	const sf = getSourceTransport()?.getState().frame ?? 0;
	const flicks = (sf / src.fps) * 705_600_000;
	const matches = (c: Clip) =>
		item.kind === 'media'
			? (c as { mediaId?: string }).mediaId === item.mediaId
			: (c as { syntheticId?: string }).syntheticId === item.syntheticId;
	const found = findContentFrame(doc, e.seq, matches, flicks, 0);
	if (found === null) {
		ctx.ui.toast({ kind: 'info', message: 'Reverse Match Frame: that frame is not used in this sequence' });
		return;
	}
	e.session.transport.seek(found);
	activeTimeline(ctx.services)?.controller.reveal(found);
}

/** The first sequence frame of `seq` showing content `flicks` of a clip matching `pred` (through nests). */
function findContentFrame(
	doc: ProjectDocument,
	seq: Sequence,
	pred: (c: Clip) => boolean,
	flicks: number,
	depth: number,
): number | null {
	if (depth > 16) return null;
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const tracks = [...[...seq.videoTracks].reverse(), ...seq.audioTracks].map((t) => t.id);
	let best: number | null = null;
	const consider = (f: number) => {
		if (best === null || f < best) best = f;
	};
	for (const c of Object.values(seq.clips).sort(
		(a, b) => tracks.indexOf(a.trackId) - tracks.indexOf(b.trackId) || a.start - b.start,
	)) {
		const frameOf = (target: number): number | null => {
			if (c.frameHold) return Math.abs(c.frameHold.flicks - target) < F / 2 ? c.start : null;
			const step = F * c.speed.rate;
			const i = Math.floor((target - c.sourceIn) / step + 1e-6);
			const local = c.speed.reverse ? c.duration - 1 - i : i;
			return local >= 0 && local < c.duration ? c.start + local : null;
		};
		if (pred(c)) {
			const f = frameOf(flicks);
			if (f !== null) consider(f);
		} else if (isNestClip(c)) {
			const nested = doc.sequences[(c as { sequenceId: string }).sequenceId] as Sequence | undefined;
			if (!nested) continue;
			const nf = findContentFrame(doc, nested, pred, flicks, depth + 1);
			if (nf === null) continue;
			const f = frameOf(nf * flicksPerFrame(nested.settings.frameRate as Rational));
			if (f !== null) consider(f);
		}
	}
	return best;
}

/** Reveal Nested Sequence (Ctrl+Shift+F) / double-click: opens the nested sequence at the frame shown. */
export function revealNested(session: EditorSession, seq: Sequence, clip: Clip, frame: number): boolean {
	if (!isNestClip(clip)) return false;
	const nested = session.getCommitted().sequences[(clip as { sequenceId: string }).sequenceId];
	if (!nested) return false;
	const f = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
	const t = clipPictureTime(clip as never, f, seq.settings.frameRate as Rational);
	const nf = Math.max(0, Math.floor(t / flicksPerFrame(nested.settings.frameRate as Rational) + 1e-6));
	session.openSequence(nested.id);
	session.transport.seek(nf);
	return true;
}

// ---------------------------------------------------------------- synthetics (Project panel ▸ New Item)

/** Creates a synthetic source item in the current bin (Project panel), returns its item id. */
export function createSynthetic(
	ctx: CommandCtx,
	kind: SyntheticKind,
	params?: Record<string, unknown>,
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
			} as never,
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

// ---------------------------------------------------------------- the list

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
			activeTimeline(ctx.services)?.controller.reveal(f);
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
				commands: seqs.map((it) => ({ type: 'sequence.duplicate', sequenceId: it.sequenceId }) as never),
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
				commands: [{ type: 'media.removeUnused' } as never],
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
