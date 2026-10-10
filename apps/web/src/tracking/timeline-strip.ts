// Timeline tracker glyphs, pure part (S09:TRU-005): tracked samples (content time) → the plate clip's sequence
// frames (sourceIn, speed.rate, speed.reverse; clipped to the clip's duration), per-frame confidence classes,
// worst-of-column aggregation for low zoom (a min pyramid cached per samples object, so redraws on scroll/zoom
// cost O(visible columns · log samples)) and the texts of the badge / strip / link tooltips.
import {
	type Clip,
	type ClipTracker,
	flicksPerFrame,
	formatTimecode,
	type Rational,
	samplesSummary,
	type TimecodeOptions,
	type TrackerSamples,
} from '@jasper/project';

type ClipTiming = Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>;

const EPS = 1e-6;

// ------------------------------------------------------------------ content time ↔ clip frames

/** Content time (flicks) shown at clip-relative frame `f` (same mapping as `contentTimeAt`, S01:CLP-004). */
function contentTimeOfFrame(clip: ClipTiming, F: number, f: number): number {
	const i = clip.speed.reverse ? clip.duration - 1 - f : f;
	return clip.sourceIn + i * F * clip.speed.rate;
}

/** Fractional sample index (`(t − start) / step`) shown at clip-relative frame `f`. */
function sampleUAt(clip: ClipTiming, F: number, s: TrackerSamples, f: number): number {
	return (contentTimeOfFrame(clip, F, f) - s.start) / s.step;
}

function countOf(s: TrackerSamples): number {
	return Math.min(Math.floor(s.data.length / s.stride), s.confidence.length);
}

/**
 * Clip-relative frames `[first, last]` (inclusive) whose content time lies inside the samples' span (first …
 * last sample), clipped to the clip's duration; null when the clip shows none of the tracked span.
 */
export function trackedFrames(
	clip: ClipTiming,
	seqRate: Rational,
	samples: TrackerSamples | null,
): { first: number; last: number } | null {
	if (!samples || clip.duration <= 0 || clip.speed.rate <= 0) return null;
	const n = countOf(samples);
	if (n === 0) return null;
	const perFrame = flicksPerFrame(seqRate) * clip.speed.rate;
	const end = samples.start + (n - 1) * samples.step;
	// Forward index j shows content sourceIn + j·perFrame; the reverse clip shows it at frame duration−1−j.
	const j0 = Math.ceil((samples.start - clip.sourceIn) / perFrame - EPS);
	const j1 = Math.floor((end - clip.sourceIn) / perFrame + EPS);
	let first = j0;
	let last = j1;
	if (clip.speed.reverse) [first, last] = [clip.duration - 1 - j1, clip.duration - 1 - j0];
	first = Math.max(0, first);
	last = Math.min(clip.duration - 1, last);
	return last >= first ? { first, last } : null;
}

/** Sample indices `[lo, hi]` shown by clip-relative frames `[f0, f1]` (neighbours of a fractional index). */
export function sampleRangeOfFrames(
	clip: ClipTiming,
	seqRate: Rational,
	samples: TrackerSamples,
	f0: number,
	f1: number,
): { lo: number; hi: number } | null {
	const n = countOf(samples);
	if (n === 0) return null;
	const F = flicksPerFrame(seqRate);
	const ua = sampleUAt(clip, F, samples, f0);
	const ub = sampleUAt(clip, F, samples, f1);
	const lo = Math.max(0, Math.floor(Math.min(ua, ub) + EPS));
	const hi = Math.min(n - 1, Math.ceil(Math.max(ua, ub) - EPS));
	return hi >= lo ? { lo, hi } : null;
}

// ------------------------------------------------------------------ worst-of-range confidence

/** Min pyramid of a samples object's confidence: level k holds the min of 2^k consecutive samples. */
type ConfidenceIndex = { n: number; levels: Float64Array[] };

const indexCache = new WeakMap<TrackerSamples, ConfidenceIndex>();

/** The (cached, per samples object) min pyramid of the confidence. */
function confidenceIndex(samples: TrackerSamples): ConfidenceIndex {
	const hit = indexCache.get(samples);
	if (hit) return hit;
	const n = countOf(samples);
	const base = new Float64Array(n);
	for (let i = 0; i < n; i++) base[i] = samples.confidence[i] ?? 0;
	const levels = [base];
	let cur = base;
	while (cur.length > 1) {
		const next = new Float64Array(Math.ceil(cur.length / 2));
		for (let i = 0; i < next.length; i++) {
			const a = cur[2 * i]!;
			const b = 2 * i + 1 < cur.length ? cur[2 * i + 1]! : a;
			next[i] = a < b ? a : b;
		}
		levels.push(next);
		cur = next;
	}
	const index = { n, levels };
	indexCache.set(samples, index);
	return index;
}

/** Minimum confidence of samples `[lo, hi]` (inclusive) in O(log n). */
function minConfidence(index: ConfidenceIndex, lo: number, hi: number): number {
	let a = Math.max(0, lo);
	let b = Math.min(index.n - 1, hi);
	let min = Number.POSITIVE_INFINITY;
	for (let k = 0; a <= b && k < index.levels.length; k++) {
		const level = index.levels[k]!;
		if (a & 1) min = Math.min(min, level[a++]!);
		if (!(b & 1)) min = Math.min(min, level[b--]!);
		a >>= 1;
		b >>= 1;
	}
	return min;
}

// ------------------------------------------------------------------ classes

/** Strip colour class: good ≥ 0.8, fair ≥ 0.5, poor > 0, lost = 0 (TRU-002 tones plus "lost"). */
type ConfidenceClass = 'good' | 'fair' | 'poor' | 'lost';

export function confidenceClass(c: number): ConfidenceClass {
	return c <= 0 ? 'lost' : c < 0.5 ? 'poor' : c < 0.8 ? 'fair' : 'good';
}

/** Tooltip class of a frame: Lost (0), Low (< 0.5), OK. */
function confidenceLabel(c: number): 'Lost' | 'Low' | 'OK' {
	return c <= 0 ? 'Lost' : c < 0.5 ? 'Low' : 'OK';
}

// ------------------------------------------------------------------ strip runs

/** A drawn piece of a strip in clip-area px, with the worst confidence it covers. */
export type StripRun = { x0: number; x1: number; confidence: number; cls: ConfidenceClass };

type StripInput = {
	clip: ClipTiming;
	seqRate: Rational;
	samples: TrackerSamples | null;
	/** Clip-area x of the clip's first frame (unrounded) and px per sequence frame. */
	clipX: number;
	pxPerFrame: number;
	/** Clip-area px range to draw (the visible part / one canvas tile). */
	x0: number;
	x1: number;
};

/** Clip-area px span `[x0, x1)` of the tracked frames (null when the clip shows none of them). */
export function stripSpanPx(
	input: Pick<StripInput, 'clip' | 'seqRate' | 'samples' | 'clipX' | 'pxPerFrame'>,
): { x0: number; x1: number; first: number; last: number } | null {
	const span = trackedFrames(input.clip, input.seqRate, input.samples);
	if (!span) return null;
	return {
		x0: input.clipX + span.first * input.pxPerFrame,
		x1: input.clipX + (span.last + 1) * input.pxPerFrame,
		...span,
	};
}

/**
 * The runs to draw over `[x0, x1)`: one cell per frame when a frame is ≥ 1 px wide, else one cell per px
 * column holding the WORST confidence of the frames in it (a single lost frame is never hidden). Adjacent
 * cells of the same class merge; a run keeps its minimum confidence.
 */
export function stripRuns(input: StripInput): StripRun[] {
	const { clip, seqRate, samples, clipX, pxPerFrame: ppf } = input;
	if (!samples || ppf <= 0) return [];
	const span = stripSpanPx(input);
	if (!span) return [];
	const a = Math.max(input.x0, span.x0);
	const b = Math.min(input.x1, span.x1);
	if (b <= a) return [];
	const index = confidenceIndex(samples);
	const worst = (f0: number, f1: number): number | null => {
		const r = sampleRangeOfFrames(clip, seqRate, samples, f0, f1);
		return r ? minConfidence(index, r.lo, r.hi) : null;
	};
	const out: StripRun[] = [];
	const push = (x0: number, x1: number, c: number | null) => {
		if (c === null || x1 <= x0) return;
		const cls = confidenceClass(c);
		const prev = out[out.length - 1];
		if (prev && prev.cls === cls && Math.abs(prev.x1 - x0) < 1e-9) {
			prev.x1 = x1;
			prev.confidence = Math.min(prev.confidence, c);
		} else out.push({ x0, x1, confidence: c, cls });
	};
	if (ppf >= 1) {
		const fa = Math.max(span.first, Math.floor((a - clipX) / ppf));
		const fb = Math.min(span.last, Math.ceil((b - clipX) / ppf) - 1);
		for (let f = fa; f <= fb; f++) {
			const cx0 = Math.max(a, clipX + f * ppf);
			const cx1 = Math.min(b, clipX + (f + 1) * ppf);
			push(cx0, cx1, worst(f, f));
		}
		return out;
	}
	for (let X = Math.floor(a); X < b; X++) {
		const cx0 = Math.max(a, X);
		const cx1 = Math.min(b, X + 1);
		const f0 = Math.max(span.first, Math.floor((cx0 - clipX) / ppf));
		const f1 = Math.min(span.last, Math.ceil((cx1 - clipX) / ppf) - 1);
		if (f1 < f0) continue;
		push(cx0, cx1, worst(f0, f1));
	}
	return out;
}

/**
 * The frame a pointer at clip-area x points at: at low zoom the worst frame of its px column (so hovering a
 * column flagged lost names the lost frame). Null outside the tracked frames.
 */
export function frameUnderPointer(
	input: Omit<StripInput, 'x0' | 'x1'>,
	x: number,
): { frame: number; confidence: number } | null {
	const { clip, seqRate, samples, clipX, pxPerFrame: ppf } = input;
	if (!samples || ppf <= 0) return null;
	const span = trackedFrames(clip, seqRate, samples);
	if (!span) return null;
	const index = confidenceIndex(samples);
	let f0: number;
	let f1: number;
	if (ppf >= 1) {
		f0 = f1 = Math.floor((x - clipX) / ppf);
	} else {
		const X = Math.floor(x);
		f0 = Math.floor((X - clipX) / ppf);
		f1 = Math.ceil((X + 1 - clipX) / ppf) - 1;
	}
	f0 = Math.max(span.first, f0);
	f1 = Math.min(span.last, f1);
	if (f1 < f0) return null;
	let best: { frame: number; confidence: number } | null = null;
	for (let f = f0; f <= f1; f++) {
		const r = sampleRangeOfFrames(clip, seqRate, samples, f, f);
		if (!r) continue;
		const c = minConfidence(index, r.lo, r.hi);
		if (!best || c < best.confidence) best = { frame: f, confidence: c };
		if (c <= 0) break;
	}
	return best;
}

// ------------------------------------------------------------------ tooltip texts

type SamplesStats = ReturnType<typeof samplesSummary> & { low: number };
const statsCache = new WeakMap<TrackerSamples, SamplesStats>();

/** `samplesSummary` plus the number of low (0 < c < 0.5) samples, cached per samples object. */
function samplesStats(samples: TrackerSamples): SamplesStats {
	const hit = statsCache.get(samples);
	if (hit) return hit;
	let low = 0;
	for (const c of samples.confidence) if (c > 0 && c < 0.5) low++;
	const stats = { ...samplesSummary(samples), low };
	statsCache.set(samples, stats);
	return stats;
}

const pct = (c: number) => `${Math.round(c * 100)}%`;

/** One tooltip line per tracker: name, kind, span (sequence timecode), samples, mean confidence, low/lost. */
export function trackerLine(
	clip: ClipTiming,
	tracker: Pick<ClipTracker, 'name' | 'kind' | 'samples'>,
	seqRate: Rational,
	tc: TimecodeOptions = {},
): string {
	const head = `${tracker.name} (${tracker.kind === 'planar' ? 'Planar' : 'Point'})`;
	const s = tracker.samples;
	const stats = s ? samplesStats(s) : null;
	if (!s || !stats || stats.count === 0) return `${head} · Not tracked`;
	const span = trackedFrames(clip, seqRate, s);
	const where = span
		? `${formatTimecode(clip.start + span.first, seqRate, tc)}–${formatTimecode(clip.start + span.last, seqRate, tc)}`
		: 'outside the clip';
	const parts = [
		head,
		where,
		`${stats.count} ${stats.count === 1 ? 'frame' : 'frames'}`,
		`mean ${pct(stats.meanConfidence ?? 0)}`,
	];
	if (stats.low) parts.push(`${stats.low} low`);
	if (stats.lost) parts.push(`${stats.lost} lost`);
	return parts.join(' · ');
}

/** The plate badge tooltip lines (a header line first when there are several trackers). */
export function plateBadgeLines(
	clip: ClipTiming & { trackers?: readonly Pick<ClipTracker, 'name' | 'kind' | 'samples'>[] },
	seqRate: Rational,
	tc: TimecodeOptions = {},
): string[] {
	const trackers = clip.trackers ?? [];
	const lines = trackers.map((t) => trackerLine(clip, t, seqRate, tc));
	return trackers.length > 1 ? [`${trackers.length} trackers`, ...lines] : lines;
}

/** The strip tooltip for one frame: tracker, sequence timecode, confidence % and class. */
export function stripFrameText(
	trackerName: string,
	seqFrame: number,
	confidence: number,
	seqRate: Rational,
	tc: TimecodeOptions = {},
): string {
	return `${trackerName} · ${formatTimecode(seqFrame, seqRate, tc)} · ${pct(confidence)} ${confidenceLabel(confidence)}`;
}

/** The target link tooltip: "Follows <tracker> on <plate> · Corner Pin|Motion", or "Tracker removed". */
export function linkText(
	found: { trackerName: string; plateName: string } | null,
	mode: 'corner-pin' | 'transform',
): string {
	if (!found) return 'Tracker removed';
	return `Follows ${found.trackerName} on ${found.plateName || 'plate'} · ${mode === 'corner-pin' ? 'Corner Pin' : 'Motion'}`;
}
