// Through edits, gaps and range copies (edit-structure; ported from FilmCraft `crates/edit/src/through.rs`,
// MIT OR Apache-2.0).
// - A through edit is a cut between two adjacent pieces of the same source that continue each other in content
//   time (what Add Edit leaves behind). Sequence ▸ Show Through Edits marks them; Join Through Edits heals them,
//   the left piece's attributes winning.
// - A gap is empty time followed by material: on one track, or on every video and audio track at once (Sequence ▸
//   Go to Gap ▸ Next / Previous in Sequence / in Track).
// - `clipToRange` trims a copy of a clip to a time range (Make Subsequence).
import { allTracks, clipEnd, clipsOnTrack, isThroughEdit } from '../derive/index.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { contentSpanFlicks, type Rational } from '../time.ts';

export type ThroughEdit = { trackId: string; leftId: string; rightId: string; frame: number };

/** Through edits of one track, left to right. */
export function trackThroughEdits(seq: Sequence, trackId: string): ThroughEdit[] {
	const list = clipsOnTrack(seq, trackId);
	const out: ThroughEdit[] = [];
	for (let i = 1; i < list.length; i++) {
		const a = list[i - 1]!;
		const b = list[i]!;
		if (isThroughEdit(a, b, seq.settings.frameRate))
			out.push({ trackId, leftId: a.id, rightId: b.id, frame: b.start });
	}
	return out;
}

/** Through edits on every track of a sequence (video, audio, captions), track order then time. */
export function throughEdits(seq: Sequence): ThroughEdit[] {
	return allTracks(seq).flatMap((t) => trackThroughEdits(seq, t.id));
}

export type GapRange = { start: number; end: number };

/** Gaps between sorted spans, from frame 0 (empty time followed by material). */
function gapsOf(spans: readonly GapRange[]): GapRange[] {
	const out: GapRange[] = [];
	let covered = 0;
	for (const r of [...spans].sort((a, b) => a.start - b.start)) {
		if (r.start > covered) out.push({ start: covered, end: r.start });
		covered = Math.max(covered, r.end);
	}
	return out;
}

/** Gaps of one track (empty time from 0 or a clip end up to the next clip; trailing time is not a gap). */
export function trackGaps(seq: Sequence, trackId: string): GapRange[] {
	return gapsOf(clipsOnTrack(seq, trackId).map((c) => ({ start: c.start, end: clipEnd(c) })));
}

/** Gaps of the whole sequence: time where no video or audio track has material, followed by material. */
export function sequenceGaps(seq: Sequence): GapRange[] {
	const spans: GapRange[] = [];
	const tracks = new Set([...seq.videoTracks, ...seq.audioTracks].map((t) => t.id));
	for (const c of Object.values(seq.clips))
		if (tracks.has(c.trackId)) spans.push({ start: c.start, end: clipEnd(c) });
	return gapsOf(spans);
}

/**
 * The start of the next (`dir` 1) or previous (`dir` −1) gap from `frame`, in the sequence or on the given tracks
 * (Premiere's Go to Gap), or null.
 */
export function gapNavigation(
	seq: Sequence,
	frame: number,
	dir: 1 | -1,
	trackIds?: readonly string[],
): number | null {
	const gaps = trackIds ? trackIds.flatMap((t) => trackGaps(seq, t)) : sequenceGaps(seq);
	const starts = [...new Set(gaps.map((g) => g.start))].sort((a, b) => a - b);
	if (dir > 0) return starts.find((s) => s > frame) ?? null;
	const before = starts.filter((s) => s < frame);
	return before.length ? before[before.length - 1]! : null;
}

/**
 * A copy of `clip` trimmed to the sequence range `[from, to)` (null when they do not overlap). Content follows the
 * trim (speed and reverse aware), so the copy shows the same content at the same sequence frames.
 */
export function clipToRange(clip: Clip, from: number, to: number, rate: Rational): Clip | null {
	const a = Math.max(clip.start, from);
	const b = Math.min(clipEnd(clip), to);
	if (b <= a) return null;
	const head = a - clip.start;
	const tail = clipEnd(clip) - b;
	const copy = JSON.parse(JSON.stringify(clip)) as Clip;
	if (clip.speed.reverse) copy.sourceIn = clip.sourceIn + contentSpanFlicks(tail, rate, clip.speed.rate);
	else copy.sourceIn = clip.sourceIn + contentSpanFlicks(head, rate, clip.speed.rate);
	copy.start = a;
	copy.duration = b - a;
	return copy;
}
