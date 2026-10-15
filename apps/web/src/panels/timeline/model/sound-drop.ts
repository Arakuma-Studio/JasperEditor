// sound-design (spec 12 §2.7 "Insert"): where a library sound dragged over the timeline goes. The pointer marks the
// sound's PEAK (Alt: its start). With snapping on, the peak is the primary snap edge: it snaps first (playhead >
// marker > In/Out > clip edge, TL-453); only when the peak finds no target within the threshold do the clip's start
// and end edges snap. The placement itself is `planSoundPlacement` (free track, never overwriting audio). Pure.
import type { Sequence } from '@jasper/project';
import {
	planSoundPlacement,
	type SoundDragInfo,
	type SoundPlacement,
	timingOf,
} from '../../../sound/insert.ts';
import { collectSnapTargets, findSnap } from './snapping.ts';

export type SoundDropTarget = {
	/** The frame the aligned point (peak, or start with Alt) lands on. */
	cue: number;
	align: 'peak' | 'start';
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
	const align = input.alt ? 'start' : 'peak';
	const pointer = Math.max(0, Math.round(input.pointerFrame));
	const base = {
		align,
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
		const secondary = primary
			? null
			: findSnap(targets, align === 'peak' ? [start, end] : [end], input.thresholdFrames, pointer);
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
		preferredTrackId: input.preferredTrackId,
		plan: final.ok ? final.placement : first.placement,
		snapFrame,
		snapEdge,
	};
}
