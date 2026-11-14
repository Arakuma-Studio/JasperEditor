// Edits that could leave video frames uncovered under kept audio (a lift or trim of one side of a linked pair) warn
// with `W_UNCOVERED_VIDEO` when they add such frames (structure/uncovered.ts; docs/wp-notes/edit-ux.md "Uncovered
// video"). Reported: two 7-frame holes on V1 under kept audio exported as black with only the subtitle.
import type { Clip } from '../schema/sequence.ts';
import { audibleUncoveredFrames, type UncoveredRange, uncoveredPicture } from '../structure/uncovered.ts';
import type { DDoc, DSeq, HandlerContext } from './context.ts';
import { latest, valuesOf } from './draft-read.ts';

/** Frames without picture while audio plays, now (read without drafting). */
export function audibleHoles(doc: DDoc, seq: DSeq): UncoveredRange[] {
	const s = latest(seq);
	return uncoveredPicture(
		{ synthetics: latest(doc).synthetics },
		{
			clips: valuesOf(seq.clips) as Clip[],
			videoTracks: latest(s.videoTracks),
			audioTracks: latest(s.audioTracks),
		},
	).filter((r) => r.audible);
}

/** The audible-hole frame count before an edit (pass to `warnNewHoles` after it). */
export function holesBefore(doc: DDoc, seq: DSeq): number {
	return audibleUncoveredFrames(audibleHoles(doc, seq));
}

/** `W_UNCOVERED_VIDEO` when the edit left more frames without picture under playing audio than `before`. */
export function warnNewHoles(doc: DDoc, seq: DSeq, before: number, h: HandlerContext): void {
	const after = audibleHoles(doc, seq);
	const n = audibleUncoveredFrames(after);
	if (n <= before) return;
	const list = after.slice(0, 5).map((r) => `${r.start}–${r.end}`);
	h.warn(
		'W_UNCOVERED_VIDEO',
		`No picture on any video track while audio plays at frames ${list.join(', ')}${after.length > 5 ? ` and ${after.length - 5} more` : ''} (${n} frames; they export black): extend a neighbouring video clip over them, or remove the time on every track (range.extract)`,
	);
}
