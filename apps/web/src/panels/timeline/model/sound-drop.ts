// sound-design (spec 12 §2.7 "Insert"): where a library sound dragged over the timeline goes. The pointer marks the
// sound's aligned point: its type's (`resolveSoundAlign`: the PEAK of hits and whooshes, the END of risers and
// reverses, the start of UI blips), or its start with Alt. With snapping on, that point is the primary snap edge: it
// snaps first (playhead > marker > In/Out > clip edge, TL-453); only when it finds no target within the threshold do
// the clip's other edges snap. The placement itself is `planSoundPlacement` (free track, never overwriting audio). Pure.
import { resolveSoundAlign, type Sequence, type SoundAlign, type SoundAlignRequest } from '@jasper/project';
import {
	planSoundPlacement,
	type SoundDragInfo,
	type SoundPlacement,
	timingOf,
} from '../../../sound/insert.ts';
import { collectSnapTargets, findSnap } from './snapping.ts';

export type SoundDropTarget = {
	/** The frame the aligned point (peak / end / start by type, or start with Alt) lands on. */
	cue: number;
	align: SoundAlign;
	/** What the insert asks for: `start` with Alt, else `auto` (the sound's type decides, also for a drag from another window). */
	request: SoundAlignRequest;
	/** The audio track under the pointer (preferred when free). */
	preferredTrackId: string | null;
	/** Null when the sound's details are unknown (a drag from another window). */
	plan: SoundPlacement | null;
	/** The snap target hit, or null. */
	snapFrame: number | null;
	/** Which edge snapped. */
	snapEdge: 'peak' | 'start' | 'end' | null;
};

export function resolveSoundDrop(input: {
	seq: Sequence;
	info: SoundDragInfo | null;
	pointerFrame: number;
	preferredTrackId: string | null;
	alt: boolean;
	snapping: boolean;
	playhead: number | null;
	thresholdFrames: number;
	targeted?: readonly string[];
}): SoundDropTarget {
	const align: SoundAlign = input.alt ? 'start' : resolveSoundAlign(input.info?.types ?? null, 'auto');
	const pointer = Math.max(0, Math.round(input.pointerFrame));
	const request: SoundAlignRequest = input.alt ? 'start' : 'auto';
	const base = {
		align,
		request,
		preferredTrackId: input.preferredTrackId,
		snapFrame: null,
		snapEdge: null,
	} as const;
	if (!input.info) return { ...base, cue: pointer, plan: null };
	const timing = timingOf(input.info);
	const plan = (cue: number) =>
		planSoundPlacement({
			seq: input.seq,
			timing,
			cueFrame: cue,
			align,
			preferredTrackId: input.preferredTrackId,
			targeted: input.targeted ?? [],
		});
	const first = plan(pointer);
	if (!first.ok) return { ...base, cue: pointer, plan: null };
	let cue = pointer;
	let snapFrame: number | null = null;
	let snapEdge: SoundDropTarget['snapEdge'] = null;
	if (input.snapping && input.thresholdFrames > 0) {
		const targets = collectSnapTargets(input.seq, { playhead: input.playhead });
		const p = first.placement;
		const start = p.start;
		const end = p.start + p.frames;
		// The aligned point is primary; the clip's edges only when it snaps to nothing.
		const primary = findSnap(targets, [pointer], input.thresholdFrames, pointer);
		const edges = align === 'peak' ? [start, end] : align === 'end' ? [start] : [end];
		const secondary = primary ? null : findSnap(targets, edges, input.thresholdFrames, pointer);
		const hit = primary ?? secondary;
		if (hit) {
			cue = Math.max(0, pointer + hit.offset);
			snapFrame = hit.target.frame;
			snapEdge = primary ? align : hit.edge === start ? 'start' : 'end';
		}
	}
	const final = cue === pointer ? first : plan(cue);
	return {
		cue,
		align,
		request,
		preferredTrackId: input.preferredTrackId,
		plan: final.ok ? final.placement : first.placement,
		snapFrame,
		snapEdge,
	};
}
