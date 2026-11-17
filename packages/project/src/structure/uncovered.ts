// Uncovered picture (docs/wp-notes/edit-ux.md "Uncovered video"): sequence frames where no shown video track draws a
// picture of a source, so the frame renders the background (black) with at most graphics over it — a hole left by a
// lift or a trim. Reported on a real cut: two 7-frame holes on V1 under kept audio exported as a subtitle over black.
// `audible` marks the frames an audio clip plays under (almost never intended). Picture = the cut map's picture
// layers (cuts.ts): enabled video, still, animated-image, nest-video and solid clips (not Transparent Video, not
// adjustment layers) on video tracks whose output is on; text, shapes, motion graphics, compositions and captions
// draw over black and do not cover. Interval arithmetic only (no coverage geometry): a scaled-down clip counts.
// `hidden` names the video tracks whose output (the track eye) is off and that hold picture over a hole: a Shift+click on
// an eye hides every track, and the export is then black with nothing else saying why.
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';

export type UncoveredRange = {
	start: number;
	end: number;
	audible: boolean;
	/** Ids of the hidden video tracks (output off) with picture over part of the range, in track order; absent = none. */
	hidden?: string[];
};

const PICTURE_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'solid',
	'nest-video',
]);

/** True when the clip draws a picture of a source (the cut map's picture layers). */
export function drawsPicture(doc: Pick<ProjectDocument, 'synthetics'>, c: Clip): boolean {
	if (c.enabled === false || !PICTURE_KINDS.has(c.kind)) return false;
	if (c.kind === 'solid') {
		const s = doc.synthetics?.[(c as { syntheticId?: string }).syntheticId ?? ''];
		return !!s && s.kind !== 'transparent' && s.kind !== 'adjustment';
	}
	return true;
}

type Span = [number, number];

function merged(spans: Span[]): Span[] {
	spans.sort((a, b) => a[0] - b[0]);
	const out: Span[] = [];
	for (const [a, b] of spans) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** `[from, to)` minus `covered` (merged, sorted). */
function holes(covered: readonly Span[], from: number, to: number): Span[] {
	const out: Span[] = [];
	let at = from;
	for (const [a, b] of covered) {
		if (b <= at) continue;
		if (a >= to) break;
		if (a > at) out.push([at, a]);
		at = Math.max(at, b);
	}
	if (at < to) out.push([at, to]);
	return out;
}

/**
 * Frames of `[range.start, range.end)` (default: the whole sequence, to its last clip) with no picture, split where
 * audio starts or stops playing under them. Sorted, disjoint.
 */
export function uncoveredPicture(
	doc: Pick<ProjectDocument, 'synthetics'>,
	seq: Pick<Sequence, 'videoTracks' | 'audioTracks'> & {
		clips: Readonly<Record<string, Clip>> | readonly Clip[];
	},
	range?: { start: number; end: number },
): UncoveredRange[] {
	const shown = new Set(seq.videoTracks.filter((t) => t.output !== false).map((t) => t.id));
	const hiddenOrder = seq.videoTracks.filter((t) => t.output === false).map((t) => t.id);
	const hiddenSpans = new Map<string, Span[]>(hiddenOrder.map((id) => [id, []]));
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	const picture: Span[] = [];
	const audio: Span[] = [];
	let last = 0;
	for (const c of Array.isArray(seq.clips) ? seq.clips : Object.values(seq.clips)) {
		const span: Span = [c.start, c.start + c.duration];
		if (!(span[1] > span[0])) continue;
		last = Math.max(last, span[1]);
		if (shown.has(c.trackId) && drawsPicture(doc, c)) picture.push(span);
		else if (audioTracks.has(c.trackId) && c.enabled !== false) audio.push(span);
		else if (hiddenSpans.has(c.trackId) && drawsPicture(doc, c)) hiddenSpans.get(c.trackId)!.push(span);
	}
	const from = Math.max(0, range?.start ?? 0);
	const to = range?.end ?? last;
	if (!(to > from)) return [];
	const sound = merged(audio);
	const hiddenMerged = hiddenOrder
		.map((id) => ({ id, spans: merged(hiddenSpans.get(id)!) }))
		.filter((h) => h.spans.length > 0);
	const withHidden = (r: UncoveredRange): UncoveredRange => {
		const ids = hiddenMerged
			.filter((h) => h.spans.some(([a, b]) => a < r.end && b > r.start))
			.map((h) => h.id);
		return ids.length ? { ...r, hidden: ids } : r;
	};
	const out: UncoveredRange[] = [];
	for (const [a, b] of holes(merged(picture), from, to)) {
		// split the hole where sound plays / stops
		let at = a;
		for (const [s, e] of sound) {
			if (e <= at) continue;
			if (s >= b) break;
			if (s > at) out.push(withHidden({ start: at, end: s, audible: false }));
			out.push(withHidden({ start: Math.max(at, s), end: Math.min(b, e), audible: true }));
			at = Math.min(b, e);
		}
		if (at < b) out.push(withHidden({ start: at, end: b, audible: false }));
	}
	return out;
}

/**
 * Frames of `list` (uncoveredPicture's, of one range) a hidden video track would cover: the holes intersected with
 * the picture of the tracks each range names. `tracks`: every track named, in track order.
 */
export function hiddenCover(
	doc: Pick<ProjectDocument, 'synthetics'>,
	seq: Pick<Sequence, 'videoTracks'> & { clips: Readonly<Record<string, Clip>> | readonly Clip[] },
	list: readonly UncoveredRange[],
): { tracks: string[]; frames: number } {
	const named = new Set(list.flatMap((r) => r.hidden ?? []));
	if (!named.size) return { tracks: [], frames: 0 };
	const spans: Span[] = [];
	for (const c of Array.isArray(seq.clips) ? seq.clips : Object.values(seq.clips))
		if (named.has(c.trackId) && c.duration > 0 && drawsPicture(doc, c))
			spans.push([c.start, c.start + c.duration]);
	const cover = merged(spans);
	let frames = 0;
	for (const r of list)
		if (r.hidden)
			for (const [a, b] of cover) frames += Math.max(0, Math.min(b, r.end) - Math.max(a, r.start));
	return { tracks: seq.videoTracks.filter((t) => named.has(t.id)).map((t) => t.id), frames };
}

/** Frames of the audible ranges in `list`. */
export function audibleUncoveredFrames(list: readonly UncoveredRange[]): number {
	let n = 0;
	for (const r of list) if (r.audible) n += r.end - r.start;
	return n;
}

/** "V1, V2, V3" / "V1, V2, … and 4 more": at most `max` of `total` track labels (default: all of them). */
export function trackLabelList(labels: readonly string[], max = 8, total = labels.length): string {
	const listed = labels.slice(0, max);
	const more = total - listed.length;
	return listed.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/**
 * "8 video tracks have output off (V1, V2, …)" / "video track V1 has output off": the hidden tracks named in plan
 * warnings, verify rows and tool results (`total`: when more were hidden than `labels` lists).
 */
export function hiddenTracksPhrase(labels: readonly string[], total = labels.length): string {
	return total === 1
		? `video track ${labels[0]} has output off`
		: `${total} video tracks have output off (${trackLabelList(labels, 8, total)})`;
}

/**
 * The video tracks with an enabled clip (over `range` when given), in track order, when every one of them has its
 * output (the track eye) off; empty otherwise. A Shift+click on an eye hides them all: the Program monitor shows a chip
 * and the export plan warns `VIDEO_TRACKS_HIDDEN`.
 */
export function allUsedVideoTracksHidden(
	seq: Sequence,
	range?: { start: number; end: number },
): Sequence['videoTracks'] {
	const used = new Set<string>();
	for (const c of Object.values(seq.clips)) {
		if (c.enabled === false) continue;
		if (range && !(c.start < range.end && c.start + c.duration > range.start)) continue;
		used.add(c.trackId);
	}
	const tracks = seq.videoTracks.filter((t) => used.has(t.id));
	return tracks.length && tracks.every((t) => t.output === false) ? tracks : [];
}
