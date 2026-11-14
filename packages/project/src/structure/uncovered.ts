// Uncovered picture (docs/wp-notes/edit-ux.md "Uncovered video"): sequence frames where no shown video track draws a
// picture of a source, so the frame renders the background (black) with at most graphics over it — a hole left by a
// lift or a trim. Reported on a real cut: two 7-frame holes on V1 under kept audio exported as a subtitle over black.
// `audible` marks the frames an audio clip plays under (almost never intended). Picture = the cut map's picture
// layers (cuts.ts): enabled video, still, animated-image, nest-video and solid clips (not Transparent Video, not
// adjustment layers) on video tracks whose output is on; text, shapes, motion graphics, compositions and captions
// draw over black and do not cover. Interval arithmetic only (no coverage geometry): a scaled-down clip counts.
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';

export type UncoveredRange = { start: number; end: number; audible: boolean };

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
	}
	const from = Math.max(0, range?.start ?? 0);
	const to = range?.end ?? last;
	if (!(to > from)) return [];
	const sound = merged(audio);
	const out: UncoveredRange[] = [];
	for (const [a, b] of holes(merged(picture), from, to)) {
		// split the hole where sound plays / stops
		let at = a;
		for (const [s, e] of sound) {
			if (e <= at) continue;
			if (s >= b) break;
			if (s > at) out.push({ start: at, end: s, audible: false });
			out.push({ start: Math.max(at, s), end: Math.min(b, e), audible: true });
			at = Math.min(b, e);
		}
		if (at < b) out.push({ start: at, end: b, audible: false });
	}
	return out;
}

/** Frames of the audible ranges in `list`. */
export function audibleUncoveredFrames(list: readonly UncoveredRange[]): number {
	let n = 0;
	for (const r of list) if (r.audible) n += r.end - r.start;
	return n;
}
