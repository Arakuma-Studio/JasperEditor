// Timeline UI commands (owned by WP-2B). Ids follow S02:TL-903 and match keymap-defaults.ts. Each
// command reads session context (playhead, targeting, selection) and emits one document transaction
// (ARCHITECTURE §2.3 "two layers"). Transport keys (Space, JKL, ←/→, Home/End) belong to WP-2C.
import {
	type Clip,
	clipAt,
	type Sequence,
	sequenceDuration,
	type TransactionResult,
	trackLabel,
} from '@jasper/project';
import type { ActiveTool, EditorSession, SequenceViewState, SessionTxInput } from '@jasper/session';
import { getSourceTransport } from '../panels/program/transport-registry.ts';
import { setSourceMarks, sourceMonitorState } from '../panels/source/source-state.ts';
import { activeTimeline, type TimelineHandle } from '../panels/timeline/env.tsx';
import { clipsAtPlayhead, unlockedTrackIds } from '../panels/timeline/model/gestures.ts';
import { stepHeight, trackHeight } from '../panels/timeline/model/layout.ts';
import { TOOLS } from '../panels/timeline/model/tools.ts';
import { cancelDynamicTrim, exitTrimMode, stopPlayAround } from '../panels/timeline/state/trim-mode.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

export type Env = {
	session: EditorSession;
	seq: Sequence;
	view: SequenceViewState;
	playhead: number;
	handle: TimelineHandle | null;
};

export function envOf(ctx: CommandCtx): Env | null {
	const session = ctx.session;
	if (!session) return null;
	const s = session.getState();
	const handle = activeTimeline(ctx.services);
	const seqId = handle?.sequenceId() ?? s.activeSequenceId;
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return null;
	return { session, seq, view: s.views[seq.id]!, playhead: session.transport.getState().frame, handle };
}

const hasSeq = (ctx: CommandCtx) => envOf(ctx) !== null;

export function apply(
	ctx: CommandCtx,
	e: Env,
	label: string,
	commands: unknown[],
	opts: { coalesceKey?: string; quiet?: boolean; selectAfter?: SessionTxInput['selectAfter'] } = {},
): TransactionResult | null {
	if (commands.length === 0) return null;
	const r = e.session.apply({
		label,
		origin: 'user',
		sequenceId: e.seq.id,
		commands: commands as never[],
		...(opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}),
		...(opts.selectAfter ? { selectAfter: opts.selectAfter } : {}),
	});
	if (!r.ok && !opts.quiet) {
		const err = r.errors[0];
		let detail = err?.message;
		if (err?.code === 'E_SYNC_CONFLICT' && err.blocking?.length) {
			const blockers = err.blocking
				.map((id) => e.seq.clips[id]?.trackId)
				.filter((t): t is string => !!t)
				.map((t) => trackLabel(e.seq, t) ?? t);
			detail = `Sync-locked track ${[...new Set(blockers)].join(', ')} has content in the range.`;
		}
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail });
	}
	return r;
}

export const selectedClips = (e: Env): Clip[] =>
	e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c);

/** Targeted track ids (both kinds), or every unlocked track when nothing is targeted (TL-251). */
export function targetedTracks(e: Env): string[] {
	const locked = new Set(
		[...e.seq.videoTracks, ...e.seq.audioTracks].filter((t) => t.locked).map((t) => t.id),
	);
	const t = [...e.view.targeting.video, ...e.view.targeting.audio].filter((id) => !locked.has(id));
	return t.length ? t : unlockedTrackIds(e.seq);
}

export function isLocked(seq: Sequence, trackId: string): boolean {
	return [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].some(
		(t) => t.id === trackId && t.locked,
	);
}

/** One clip per link group (commands that already follow links must not run twice). */
function onePerLink(clips: readonly Clip[]): Clip[] {
	const seen = new Set<string>();
	return clips.filter((c) => {
		if (!c.linkId) return true;
		if (seen.has(c.linkId)) return false;
		seen.add(c.linkId);
		return true;
	});
}

export function seekReveal(e: Env, frame: number): void {
	e.session.transport.seek(frame);
	e.handle?.controller.reveal(frame);
}

// ---------------------------------------------------------------- Source monitor marks (S03:SRC-003)

type SourceMarkAction = 'in' | 'out' | 'clearIn' | 'clearOut' | 'clearInOut' | 'goToIn' | 'goToOut';

/** The Source monitor is focused with an item open: In/Out commands act on that item (WP-2C). */
function sourceFocused(ctx: CommandCtx): boolean {
	return (
		ctx.focus.panel === 'source' &&
		!!ctx.session &&
		getSourceTransport() !== null &&
		sourceMonitorState.getState().itemId !== null
	);
}

function sourceMarks(ctx: CommandCtx, action: SourceMarkAction): boolean {
	const t = getSourceTransport();
	if (!sourceFocused(ctx) || !t || !ctx.session) return false;
	const s = ctx.session;
	const st = sourceMonitorState.getState();
	const f = t.getState().frame;
	const seek = (frame: number) => {
		if (t.getState().playing) t.pause();
		t.seek(Math.max(0, Math.min(st.durationFrames - 1, frame)));
	};
	switch (action) {
		case 'in':
			setSourceMarks(s, { in: f }, 'Mark In');
			break;
		case 'out':
			setSourceMarks(s, { out: f + 1 }, 'Mark Out');
			break;
		case 'clearIn':
			setSourceMarks(s, { in: null }, 'Clear In');
			break;
		case 'clearOut':
			setSourceMarks(s, { out: null }, 'Clear Out');
			break;
		case 'clearInOut':
			setSourceMarks(s, { in: null, out: null }, 'Clear In and Out');
			break;
		case 'goToIn':
			seek(st.markIn ?? 0);
			break;
		case 'goToOut':
			seek(st.markOut !== null ? st.markOut - 1 : st.durationFrames - 1);
			break;
	}
	return true;
}

/** A mark command that defers to the focused Source monitor, else acts on the sequence. */
const markCmd = (
	id: string,
	label: string,
	action: SourceMarkAction,
	run: (ctx: CommandCtx, e: Env) => void,
): UiCommand => ({
	id,
	label,
	scope: 'editing',
	when: (ctx) => sourceFocused(ctx) || hasSeq(ctx),
	agentExposed: true,
	run: (ctx) => {
		if (sourceMarks(ctx, action)) return;
		const e = envOf(ctx);
		if (e) run(ctx, e);
	},
});

const cmd = (
	id: string,
	label: string,
	scope: CommandScope,
	run: (ctx: CommandCtx, e: Env) => void,
	extra: Partial<UiCommand> = {},
): UiCommand => ({
	id,
	label,
	scope,
	when: hasSeq,
	agentExposed: true,
	run: (ctx) => {
		const e = envOf(ctx);
		if (e) run(ctx, e);
	},
	...extra,
});

// ---------------------------------------------------------------- tools (TL-590, S05:TOOL-003)

const TOOL_IDS: ActiveTool[] = [
	'selection',
	'trackSelectForward',
	'trackSelectBackward',
	'ripple',
	'rolling',
	'rateStretch',
	'remix',
	'razor',
	'slip',
	'slide',
	'pen',
	'hand',
	'zoom',
	'type',
	'camera',
];

/**
 * edit-ux: spring-loaded tools (Premiere: hold a tool's key to use it temporarily; releasing returns to the previous
 * tool; a quick tap switches for good). A key held at least SPRING_HOLD_MS counts as a hold.
 */
export const SPRING_HOLD_MS = 250;
const springs = new Map<string, { previous: ActiveTool; at: number }>();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const toolCommands: UiCommand[] = TOOL_IDS.map((tool) => ({
	id: `tool.${tool}`,
	label: TOOLS[tool].label,
	scope: 'editing' as const,
	agentExposed: true,
	when: (ctx) => !!ctx.session,
	checked: (ctx) => ctx.session?.getState().toggles.activeTool === tool,
	run: (ctx) => {
		const s = ctx.session;
		if (!s) return;
		const previous = s.getState().toggles.activeTool;
		if (previous !== tool) springs.set(tool, { previous, at: now() });
		else springs.delete(tool);
		s.setToggles({ activeTool: tool });
	},
	onKeyUp: (ctx) => {
		const spring = springs.get(tool);
		springs.delete(tool);
		const s = ctx.session;
		if (!spring || !s || s.getState().toggles.activeTool !== tool) return;
		// Released after a hold: back to the tool that was active (unless a gesture is still running with it).
		if (now() - spring.at >= SPRING_HOLD_MS && !s.gestureActive)
			s.setToggles({ activeTool: spring.previous });
	},
}));

// ---------------------------------------------------------------- edits (TL-680…704)

function addEdit(ctx: CommandCtx, e: Env, all: boolean): void {
	const at = e.playhead;
	const crossing = (c: Clip) => c.start < at && at < c.start + c.duration;
	if (all) {
		apply(ctx, e, 'Add Edit to All Tracks', [{ type: 'clip.split', at, scope: 'all-unlocked' }]);
		return;
	}
	// TL-680: with a selection, only selected clips crossing the playhead are split.
	const sel = selectedClips(e).filter((c) => crossing(c) && !isLocked(e.seq, c.trackId));
	if (sel.length) {
		apply(ctx, e, 'Add Edit', [{ type: 'clip.split', at, clipIds: sel.map((c) => c.id) }]);
		return;
	}
	const tracks = targetedTracks(e).filter((id) =>
		Object.values(e.seq.clips).some((c) => c.trackId === id && crossing(c)),
	);
	if (!tracks.length) return;
	apply(ctx, e, 'Add Edit', [{ type: 'clip.split', at, tracks }]);
}

function clear(ctx: CommandCtx, e: Env, ripple: boolean): void {
	const sel = e.session.getState().selection;
	if (sel.timeline.gaps.length) {
		// TL-741: Delete and Ripple Delete both close selected gaps.
		const gaps = [...sel.timeline.gaps].sort((a, b) => b.start - a.start);
		apply(
			ctx,
			e,
			gaps.length > 1 ? 'Close Gaps' : 'Close Gap',
			gaps.map((g) => ({ type: 'gap.close', trackId: g.trackId, at: g.start })),
		);
		e.session.selectGaps([]);
		return;
	}
	// edit-ux: keyframes selected on a clip's lane (rubber band) are deleted first, as in Premiere.
	const kf = sel.keyframes;
	if (!ripple && kf && kf.keyframeIds.length && e.seq.clips[kf.clipOrTrackId]) {
		const r = apply(ctx, e, 'Delete Keyframes', [{ type: 'keyframe.remove', keyframeIds: kf.keyframeIds }]);
		if (r?.ok) e.session.selectKeyframes(null);
		return;
	}
	const clips = selectedClips(e);
	if (clips.length) {
		apply(ctx, e, ripple ? 'Ripple Delete' : 'Clear', [
			{
				type: ripple ? 'clip.extract' : 'clip.lift',
				clipIds: clips.map((c) => c.id),
				groups: false,
				...(ripple ? { rippleMarkers: e.session.getState().toggles.rippleMarkers } : {}),
			},
		]);
		return;
	}
	if (sel.markers.length) apply(ctx, e, 'Clear Marker', [{ type: 'marker.remove', markerIds: sel.markers }]);
}

function nudge(ctx: CommandCtx, e: Env, delta: number): void {
	const clips = selectedClips(e).filter((c) => !isLocked(e.seq, c.trackId));
	if (!clips.length) return;
	const min = Math.min(...clips.map((c) => c.start));
	const d = Math.max(-min, delta); // TL-497: clamped at frame 0
	if (d === 0) return;
	apply(
		ctx,
		e,
		'Nudge',
		[{ type: 'clip.move', clipIds: clips.map((c) => c.id), deltaFrames: d, groups: false }],
		{
			coalesceKey: 'nudge',
		},
	);
}

function nudgeTrack(ctx: CommandCtx, e: Env, up: boolean): void {
	const clips = selectedClips(e).filter((c) => !isLocked(e.seq, c.trackId));
	if (!clips.length) return;
	// Visually up: video index +1, audio index −1. Refuses at the edges instead of creating tracks.
	apply(
		ctx,
		e,
		'Nudge',
		[
			{
				type: 'clip.move',
				clipIds: clips.map((c) => c.id),
				deltaFrames: 0,
				deltaTracks: { video: up ? 1 : -1, audio: up ? -1 : 1 },
				createTracks: false,
				groups: false,
			},
		],
		{ coalesceKey: 'nudge-track', quiet: true },
	);
}

function slip(ctx: CommandCtx, e: Env, delta: number): void {
	const clips = selectedClips(e).filter((c) => !isLocked(e.seq, c.trackId));
	if (!clips.length) return;
	apply(ctx, e, 'Slip', [{ type: 'clip.slip', clipIds: clips.map((c) => c.id), deltaFrames: delta }], {
		coalesceKey: 'slip',
	});
}

function slide(ctx: CommandCtx, e: Env, delta: number): void {
	const clips = onePerLink(selectedClips(e).filter((c) => !isLocked(e.seq, c.trackId)));
	if (!clips.length) return;
	apply(
		ctx,
		e,
		'Slide',
		clips.map((c) => ({ type: 'clip.slide', clipId: c.id, deltaFrames: delta })),
		{ coalesceKey: 'slide' },
	);
}

// ---------------------------------------------------------------- playhead trims (TL-549)

function playheadTrim(ctx: CommandCtx, e: Env, side: 'prev' | 'next', ripple: boolean): void {
	const p = e.playhead;
	const clips = onePerLink(
		targetedTracks(e)
			.map((id) => clipAt(e.seq, id, p))
			.filter((c): c is Clip => !!c && c.start < p && !isLocked(e.seq, c.trackId)),
	);
	if (!clips.length) {
		ctx.ui.toast({ kind: 'info', message: 'No clip under the playhead on the targeted tracks' });
		return;
	}
	const commands = clips.map((c) =>
		side === 'prev'
			? {
					type: 'clip.trim',
					clipId: c.id,
					edge: 'in',
					deltaFrames: p - c.start,
					mode: ripple ? 'ripple' : 'regular',
				}
			: {
					type: 'clip.trim',
					clipId: c.id,
					edge: 'out',
					deltaFrames: p - (c.start + c.duration),
					mode: ripple ? 'ripple' : 'regular',
				},
	);
	const label = ripple
		? side === 'prev'
			? 'Ripple Trim Previous Edit to Playhead'
			: 'Ripple Trim Next Edit to Playhead'
		: side === 'prev'
			? 'Trim Previous Edit to Playhead'
			: 'Trim Next Edit to Playhead';
	const r = apply(ctx, e, label, commands);
	// Q moves the playhead to the old clip start so it stays on the same content.
	if (r?.ok && ripple && side === 'prev') seekReveal(e, Math.min(...clips.map((c) => c.start)));
}

// ---------------------------------------------------------------- in/out (TL-760…766)

function setInOut(ctx: CommandCtx, e: Env, label: string, i: number | null, o: number | null): void {
	apply(ctx, e, label, [{ type: 'sequence.setInOut', in: i, out: o }]);
}

function markClipRange(e: Env): { start: number; end: number } | null {
	const p = e.playhead;
	const targeted = [...e.view.targeting.video, ...e.view.targeting.audio];
	const tracks = targeted.length
		? targeted
		: [...[...e.seq.videoTracks].reverse(), ...e.seq.audioTracks].map((t) => t.id); // topmost first
	const hits = clipsAtPlayhead(e.seq, p, tracks).map((id) => e.seq.clips[id]!);
	if (!hits.length) return null;
	const pick = targeted.length ? hits : [hits[0]!];
	return {
		start: Math.min(...pick.map((c) => c.start)),
		end: Math.max(...pick.map((c) => c.start + c.duration)),
	};
}

function liftExtract(ctx: CommandCtx, e: Env, extract: boolean): void {
	const { inPoint, outPoint } = e.seq;
	if (inPoint === null || outPoint === null) {
		ctx.ui.toast({ kind: 'info', message: 'Set In and Out first' }); // TL-691
		return;
	}
	const targeted = [...e.view.targeting.video, ...e.view.targeting.audio].filter(
		(id) => !isLocked(e.seq, id),
	);
	const range = {
		type: extract ? 'range.extract' : 'range.lift',
		from: inPoint,
		to: outPoint,
		...(targeted.length ? { tracks: targeted } : {}),
		...(extract ? { rippleMarkers: e.session.getState().toggles.rippleMarkers } : {}),
	};
	const r = apply(ctx, e, extract ? 'Extract' : 'Lift', [
		range,
		{ type: 'sequence.setInOut', in: null, out: null },
	]);
	if (r?.ok) seekReveal(e, inPoint); // TL-690: playhead goes to the old In
}

// ---------------------------------------------------------------- markers (TL-790…794)

function markerNav(e: Env, dir: 1 | -1): void {
	const frames = [...new Set(e.seq.markers.map((m) => m.frame))].sort((a, b) => a - b);
	const f = dir > 0 ? frames.find((x) => x > e.playhead) : [...frames].reverse().find((x) => x < e.playhead);
	if (f !== undefined) seekReveal(e, f);
}

// ---------------------------------------------------------------- track heights (TL-263)

function setHeights(
	e: Env,
	kind: 'video' | 'audio' | 'both',
	fn: (h: number, k: 'video' | 'audio') => number,
): void {
	const heights = { ...e.view.trackHeights };
	const kinds: ('video' | 'audio')[] = kind === 'both' ? ['video', 'audio'] : [kind];
	for (const k of kinds)
		for (const t of k === 'video' ? e.seq.videoTracks : e.seq.audioTracks)
			heights[t.id] = fn(trackHeight(e.view.trackHeights, t.id, k), k);
	e.session.setView(e.seq.id, { trackHeights: heights });
}

// ---------------------------------------------------------------- the list

const T: CommandScope = 'timeline';
const E: CommandScope = 'editing';

export const timelineCommands: UiCommand[] = [
	...toolCommands,

	cmd('timeline.addEdit', 'Add Edit', E, (ctx, e) => addEdit(ctx, e, false)),
	cmd('timeline.addEditAllTracks', 'Add Edit to All Tracks', E, (ctx, e) => addEdit(ctx, e, true)),
	cmd('timeline.clear', 'Clear', T, (ctx, e) => clear(ctx, e, false)),
	cmd('timeline.rippleDelete', 'Ripple Delete', T, (ctx, e) => clear(ctx, e, true)),
	cmd('timeline.selectAll', 'Select All', T, (_ctx, e) => {
		const unlocked = new Set(unlockedTrackIds(e.seq));
		e.session.selectGaps([]);
		e.session.select(
			'timeline',
			Object.values(e.seq.clips)
				.filter((c) => unlocked.has(c.trackId))
				.map((c) => c.id),
			'replace',
			{ linked: false },
		);
	}),
	cmd('timeline.deselectAll', 'Deselect All', T, (_ctx, e) => {
		e.session.select('timeline', [], 'replace');
		e.session.selectGaps([]);
		e.handle?.ui.setState({ editPoints: [] });
	}),
	cmd('timeline.selectClipAtPlayhead', 'Select Clip at Playhead', T, (_ctx, e) => {
		const ids = clipsAtPlayhead(e.seq, e.playhead, targetedTracks(e));
		e.session.select('timeline', ids, 'replace');
	}),
	cmd('timeline.selectNextClip', 'Select Next Clip', T, (_ctx, e) => selectNeighbour(e, 1)),
	cmd('timeline.selectPrevClip', 'Select Previous Clip', T, (_ctx, e) => selectNeighbour(e, -1)),

	cmd('timeline.nudgeLeft', 'Nudge Clip Selection Left One Frame', T, (ctx, e) => nudge(ctx, e, -1), {
		repeat: true,
	}),
	cmd('timeline.nudgeRight', 'Nudge Clip Selection Right One Frame', T, (ctx, e) => nudge(ctx, e, 1), {
		repeat: true,
	}),
	cmd('timeline.nudgeLeftMany', 'Nudge Clip Selection Left Five Frames', T, (ctx, e) => nudge(ctx, e, -5), {
		repeat: true,
	}),
	cmd('timeline.nudgeRightMany', 'Nudge Clip Selection Right Five Frames', T, (ctx, e) => nudge(ctx, e, 5), {
		repeat: true,
	}),
	cmd('timeline.nudgeUp', 'Nudge Clip Selection Up', T, (ctx, e) => nudgeTrack(ctx, e, true), {
		repeat: true,
	}),
	cmd('timeline.nudgeDown', 'Nudge Clip Selection Down', T, (ctx, e) => nudgeTrack(ctx, e, false), {
		repeat: true,
	}),
	cmd('timeline.slipLeft', 'Slip Clip Selection Left One Frame', T, (ctx, e) => slip(ctx, e, -1), {
		repeat: true,
	}),
	cmd('timeline.slipRight', 'Slip Clip Selection Right One Frame', T, (ctx, e) => slip(ctx, e, 1), {
		repeat: true,
	}),
	cmd('timeline.slipLeftMany', 'Slip Clip Selection Left Five Frames', T, (ctx, e) => slip(ctx, e, -5), {
		repeat: true,
	}),
	cmd('timeline.slipRightMany', 'Slip Clip Selection Right Five Frames', T, (ctx, e) => slip(ctx, e, 5), {
		repeat: true,
	}),
	cmd('timeline.slideLeft', 'Slide Clip Selection Left One Frame', T, (ctx, e) => slide(ctx, e, -1), {
		repeat: true,
	}),
	cmd('timeline.slideRight', 'Slide Clip Selection Right One Frame', T, (ctx, e) => slide(ctx, e, 1), {
		repeat: true,
	}),
	cmd('timeline.slideLeftMany', 'Slide Clip Selection Left Five Frames', T, (ctx, e) => slide(ctx, e, -5), {
		repeat: true,
	}),
	cmd('timeline.slideRightMany', 'Slide Clip Selection Right Five Frames', T, (ctx, e) => slide(ctx, e, 5), {
		repeat: true,
	}),

	markCmd('timeline.markIn', 'Mark In', 'in', (ctx, e) => {
		const i = e.playhead;
		setInOut(ctx, e, 'Mark In', i, e.seq.outPoint !== null && e.seq.outPoint <= i ? null : e.seq.outPoint);
	}),
	markCmd('timeline.markOut', 'Mark Out', 'out', (ctx, e) => {
		const o = e.playhead + 1; // TL-760: the Out frame is included
		setInOut(ctx, e, 'Mark Out', e.seq.inPoint !== null && e.seq.inPoint >= o ? null : e.seq.inPoint, o);
	}),
	cmd('timeline.markClip', 'Mark Clip', T, (ctx, e) => {
		const r = markClipRange(e);
		if (r) setInOut(ctx, e, 'Mark Clip', r.start, r.end);
	}),
	cmd('timeline.markSelection', 'Mark Selection', T, (ctx, e) => {
		const clips = selectedClips(e);
		if (!clips.length) return;
		setInOut(
			ctx,
			e,
			'Mark Selection',
			Math.min(...clips.map((c) => c.start)),
			Math.max(...clips.map((c) => c.start + c.duration)),
		);
	}),
	markCmd('timeline.clearIn', 'Clear In', 'clearIn', (ctx, e) =>
		setInOut(ctx, e, 'Clear In', null, e.seq.outPoint),
	),
	markCmd('timeline.clearOut', 'Clear Out', 'clearOut', (ctx, e) =>
		setInOut(ctx, e, 'Clear Out', e.seq.inPoint, null),
	),
	markCmd('timeline.clearInOut', 'Clear In and Out', 'clearInOut', (ctx, e) =>
		setInOut(ctx, e, 'Clear In and Out', null, null),
	),
	markCmd('timeline.goToIn', 'Go to In', 'goToIn', (_ctx, e) => {
		if (e.seq.inPoint !== null) seekReveal(e, e.seq.inPoint);
	}),
	markCmd('timeline.goToOut', 'Go to Out', 'goToOut', (_ctx, e) => {
		if (e.seq.outPoint !== null) seekReveal(e, e.seq.outPoint - 1);
	}),
	cmd('timeline.lift', 'Lift', E, (ctx, e) => liftExtract(ctx, e, false)),
	cmd('timeline.extract', 'Extract', E, (ctx, e) => liftExtract(ctx, e, true)),

	cmd('timeline.addMarker', 'Add Marker', E, (ctx, e) => {
		const existing = e.seq.markers.find((m) => m.frame === e.playhead);
		if (existing) {
			// TL-791: a second M on the same frame opens the marker dialog.
			ctx.ui.openDialog('marker', { sequenceId: e.seq.id, markerId: existing.id });
			return;
		}
		apply(ctx, e, 'Add Marker', [{ type: 'marker.add', frame: e.playhead }]);
	}),
	cmd('timeline.nextMarker', 'Go to Next Marker', E, (_ctx, e) => markerNav(e, 1)),
	cmd('timeline.prevMarker', 'Go to Previous Marker', E, (_ctx, e) => markerNav(e, -1)),
	cmd('timeline.clearMarker', 'Clear Selected Marker', E, (ctx, e) => {
		const sel = e.session.getState().selection.markers.filter((id) => e.seq.markers.some((m) => m.id === id));
		const ids = sel.length ? sel : e.seq.markers.filter((m) => m.frame === e.playhead).map((m) => m.id);
		if (ids.length) apply(ctx, e, 'Clear Marker', [{ type: 'marker.remove', markerIds: ids }]);
	}),
	cmd('timeline.clearAllMarkers', 'Clear All Markers', E, (ctx, e) => {
		if (!e.seq.markers.length) return;
		if (
			e.seq.markers.length > 10 &&
			typeof window !== 'undefined' &&
			typeof window.confirm === 'function' &&
			!window.confirm(`Clear all ${e.seq.markers.length} markers?`)
		)
			return;
		apply(ctx, e, 'Clear All Markers', [
			{ type: 'marker.remove', markerIds: e.seq.markers.map((m) => m.id) },
		]);
	}),

	// Edit-point navigation (transport.prevEdit/nextEdit/…Any, TL-880, A.7) is registered once, in
	// commands/transport.ts (WP-2C): it honors track targeting and the focused Source monitor.

	cmd(
		'timeline.toggleSnap',
		'Snap in Timeline',
		T,
		(_ctx, e) => e.session.setToggles({ snapping: !e.session.getState().toggles.snapping }),
		{ checked: (ctx) => !!ctx.session?.getState().toggles.snapping },
	),
	cmd('timeline.linkUnlink', 'Link / Unlink', T, (ctx, e) => {
		const clips = selectedClips(e);
		if (!clips.length) return;
		if (clips.some((c) => c.linkId))
			apply(ctx, e, 'Unlink', [{ type: 'clip.unlink', clipIds: clips.map((c) => c.id) }]);
		else if (clips.length > 1)
			apply(ctx, e, 'Link', [{ type: 'clip.link', clipIds: clips.map((c) => c.id) }]);
	}),
	cmd('timeline.toggleEnable', 'Enable', T, (ctx, e) => {
		const clips = selectedClips(e).filter((c) => !isLocked(e.seq, c.trackId));
		if (!clips.length) return;
		const enable = !clips.every((c) => c.enabled);
		apply(ctx, e, enable ? 'Enable' : 'Disable', [
			{ type: 'clip.update', clipIds: clips.map((c) => c.id), patch: { enabled: enable } },
		]);
	}),
	cmd('timeline.duplicate', 'Duplicate', T, (ctx, e) => {
		const clips = selectedClips(e);
		if (!clips.length) return;
		// SEL-006/008: the copies are selected, and Redo restores that selection.
		apply(ctx, e, 'Duplicate', [{ type: 'clip.duplicate', clipIds: clips.map((c) => c.id) }], {
			selectAfter: (r) => ({ timeline: (r.results[0] as { clipIds: string[] }).clipIds }),
		});
	}),

	cmd('timeline.zoomIn', 'Zoom In', T, (_ctx, e) => e.handle?.controller.zoomStep(1), { repeat: true }),
	cmd('timeline.zoomOut', 'Zoom Out', T, (_ctx, e) => e.handle?.controller.zoomStep(-1), { repeat: true }),
	cmd('timeline.zoomToSequence', 'Zoom to Sequence', T, (_ctx, e) =>
		e.handle?.controller.toggleZoomToSequence(),
	),
	cmd('timeline.pageLeft', 'Scroll Left One Page', T, (_ctx, e) => e.handle?.controller.page(-1), {
		repeat: true,
	}),
	cmd('timeline.pageRight', 'Scroll Right One Page', T, (_ctx, e) => e.handle?.controller.page(1), {
		repeat: true,
	}),
	cmd('timeline.videoTracksTaller', 'Increase Video Track Height', T, (_ctx, e) =>
		setHeights(e, 'video', (h) => stepHeight(h, 1)),
	),
	cmd('timeline.videoTracksShorter', 'Decrease Video Track Height', T, (_ctx, e) =>
		setHeights(e, 'video', (h) => stepHeight(h, -1)),
	),
	cmd('timeline.audioTracksTaller', 'Increase Audio Track Height', T, (_ctx, e) =>
		setHeights(e, 'audio', (h) => stepHeight(h, 1)),
	),
	cmd('timeline.audioTracksShorter', 'Decrease Audio Track Height', T, (_ctx, e) =>
		setHeights(e, 'audio', (h) => stepHeight(h, -1)),
	),
	cmd('timeline.expandAllTracks', 'Expand All Tracks', T, (_ctx, e) =>
		setHeights(e, 'both', (h) => Math.max(h, 72)),
	),
	cmd('timeline.minimizeAllTracks', 'Minimize All Tracks', T, (_ctx, e) => setHeights(e, 'both', () => 20)),

	cmd('timeline.rippleTrimPrevToPlayhead', 'Ripple Trim Previous Edit to Playhead', T, (ctx, e) =>
		playheadTrim(ctx, e, 'prev', true),
	),
	cmd('timeline.rippleTrimNextToPlayhead', 'Ripple Trim Next Edit to Playhead', T, (ctx, e) =>
		playheadTrim(ctx, e, 'next', true),
	),
	cmd('timeline.trimPrevToPlayhead', 'Trim Previous Edit to Playhead', T, (ctx, e) =>
		playheadTrim(ctx, e, 'prev', false),
	),
	cmd('timeline.trimNextToPlayhead', 'Trim Next Edit to Playhead', T, (ctx, e) =>
		playheadTrim(ctx, e, 'next', false),
	),
	cmd('timeline.setWorkAreaIn', 'Set Work Area In', T, (ctx, e) => {
		const end = e.seq.workArea?.end ?? Math.max(e.playhead + 1, sequenceDuration(e.seq));
		if (end > e.playhead)
			apply(ctx, e, 'Work Area', [{ type: 'sequence.setWorkArea', start: e.playhead, end }]);
	}),
	cmd('timeline.setWorkAreaOut', 'Set Work Area Out', T, (ctx, e) => {
		const start = e.seq.workArea?.start ?? 0;
		if (e.playhead + 1 > start)
			apply(ctx, e, 'Work Area', [{ type: 'sequence.setWorkArea', start, end: e.playhead + 1 }]);
	}),
	{
		id: 'gesture.cancel',
		label: 'Cancel Gesture',
		scope: E,
		when: (ctx) => !!ctx.session,
		run: (ctx) => {
			const handle = activeTimeline(ctx.services);
			// edit-ux: Esc first drops a dynamic (J/K/L) trim in progress, restoring the edit.
			if (cancelDynamicTrim()) return;
			if (handle?.cancelGesture()) return;
			stopPlayAround();
			exitTrimMode();
			// TL-903: otherwise Escape deselects.
			ctx.session?.select('timeline', [], 'replace');
			ctx.session?.selectGaps([]);
			handle?.ui.setState({ editPoints: [], contextMenu: null });
		},
	},
];

function selectNeighbour(e: Env, dir: 1 | -1): void {
	const sel = selectedClips(e);
	const anchor = sel.sort((a, b) => (dir > 0 ? b.start - a.start : a.start - b.start))[0];
	if (!anchor) return;
	const same = Object.values(e.seq.clips)
		.filter((c) => c.trackId === anchor.trackId)
		.sort((a, b) => a.start - b.start);
	const i = same.findIndex((c) => c.id === anchor.id);
	const next = same[i + dir];
	if (next) e.session.select('timeline', [next.id], 'replace');
}
