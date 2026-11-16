// Tracker samples (S09:TRK-001/002/020): lookup at a content time (linear interpolation, nearest sample held
// outside the tracked span), temporal smoothing, merging a re-tracked span, re-anchoring to a corrected
// reference and scaling for a source of another size. Pure functions; geometry in media pixels.
import { applyMat3, type Quad, quadToQuad } from '../render/homography.ts';
import type { Vec2 } from '../schema/common.ts';
import type { ClipTracker, TrackerSamples } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, type Rational } from '../time.ts';

const PLANAR_STRIDE = 8;
const POINT_STRIDE = 2;

/** Values per sample for a tracker kind. */
export function strideOf(kind: ClipTracker['kind']): 2 | 8 {
	return kind === 'planar' ? PLANAR_STRIDE : POINT_STRIDE;
}

/** Number of samples. */
export function sampleCount(s: Pick<TrackerSamples, 'data' | 'stride'>): number {
	return Math.floor(s.data.length / s.stride);
}

/** Content time (flicks) of the last sample. */
export function samplesEnd(s: TrackerSamples): number {
	return s.start + Math.max(0, sampleCount(s) - 1) * s.step;
}

/** Flicks per source frame of a media rate, rounded to an integer (the samples' `step`). */
export function stepOfRate(rate: Rational): number {
	return Math.round((FLICKS_PER_SECOND * rate.den) / rate.num);
}

/** Raw values and confidence of sample `i`. The caller bounds the index. */
function sampleValues(s: TrackerSamples, i: number): { values: number[]; confidence: number } {
	return {
		values: s.data.slice(i * s.stride, (i + 1) * s.stride),
		confidence: s.confidence[i] ?? 0,
	};
}

/** Values at content time `t`: linear interpolation between neighbouring samples; held outside the span. */
export function valuesAt(s: TrackerSamples, t: number): { values: number[]; confidence: number } | null {
	const n = sampleCount(s);
	if (n === 0) return null;
	const u = (t - s.start) / s.step;
	if (u <= 0) return sampleValues(s, 0);
	if (u >= n - 1) return sampleValues(s, n - 1);
	const i = Math.floor(u);
	const f = u - i;
	const a = sampleValues(s, i);
	if (f < 1e-9) return a;
	const b = sampleValues(s, i + 1);
	return {
		values: a.values.map((v, k) => v + (b.values[k]! - v) * f),
		confidence: Math.min(a.confidence, b.confidence),
	};
}

function valuesToQuad(v: readonly number[]): Quad {
	return [
		[v[0]!, v[1]!],
		[v[2]!, v[3]!],
		[v[4]!, v[5]!],
		[v[6]!, v[7]!],
	];
}

function quadToValues(q: Quad): number[] {
	return [q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1]];
}

/**
 * Confidence-weighted local linear regression (LOESS of degree 1, Cleveland 1979, "Robust Locally Weighted Regression
 * and Smoothing Scatterplots", JASA 74(368)) over a window of radius `radius` samples: weight = confidence × tricube
 * of the distance. A straight-line motion is reproduced exactly (no lag, also at the ends), jitter is averaged away,
 * and lost or unreliable samples (confidence 0, which repeat the last good values) do not pull the result: they are
 * filled from their neighbours. Samples without any confident neighbour keep their values. Confidence is unchanged.
 */
export function smoothSamples(s: TrackerSamples, radius: number): TrackerSamples {
	const r = Math.max(0, Math.floor(radius));
	const n = sampleCount(s);
	if (r === 0 || n < 2) return s;
	const out = s.data.slice(0, n * s.stride);
	for (let i = 0; i < n; i++) {
		const j0 = Math.max(0, i - r);
		const j1 = Math.min(n - 1, i + r);
		// Weighted sums of 1, d, d² (d = j − i) over the window.
		let sw = 0;
		let sd = 0;
		let sdd = 0;
		for (let j = j0; j <= j1; j++) {
			const w = sampleWeight(s, i, j, r);
			const d = j - i;
			sw += w;
			sd += w * d;
			sdd += w * d * d;
		}
		if (!(sw > 1e-9)) continue;
		const det = sw * sdd - sd * sd;
		for (let k = 0; k < s.stride; k++) {
			let sy = 0;
			let sdy = 0;
			for (let j = j0; j <= j1; j++) {
				const w = sampleWeight(s, i, j, r);
				const y = s.data[j * s.stride + k]!;
				sy += w * y;
				sdy += w * (j - i) * y;
			}
			// Value of the fitted line at d = 0; a weighted mean when the weights sit on one sample.
			out[i * s.stride + k] = det > 1e-9 * sw * sw ? (sdd * sy - sd * sdy) / det : sy / sw;
		}
	}
	return { ...s, data: out };
}

function sampleWeight(s: TrackerSamples, i: number, j: number, r: number): number {
	const c = s.confidence[j] ?? 0;
	if (!(c > 0)) return 0;
	const u = Math.abs(j - i) / (r + 1);
	const t = 1 - u * u * u;
	return c * t * t * t;
}

/** The tracker's geometry at content time `t`: from the samples (smoothed), else the reference. */
export type TrackerGeometry = {
	corners: Quad | null;
	point: Vec2 | null;
	confidence: number;
	tracked: boolean;
};

export function trackerGeometryAt(
	tracker: Pick<ClipTracker, 'kind' | 'reference' | 'samples' | 'smoothing'>,
	t: number,
	opts: { smoothing?: number; samples?: TrackerSamples | null } = {},
): TrackerGeometry {
	const base = opts.samples !== undefined ? opts.samples : tracker.samples;
	const radius = opts.smoothing ?? tracker.smoothing ?? 0;
	const samples = base && radius > 0 ? smoothSamples(base, radius) : base;
	const v = samples ? valuesAt(samples, t) : null;
	if (v && v.values.length === strideOf(tracker.kind)) {
		return tracker.kind === 'planar'
			? { corners: valuesToQuad(v.values), point: null, confidence: v.confidence, tracked: true }
			: { corners: null, point: [v.values[0]!, v.values[1]!], confidence: v.confidence, tracked: true };
	}
	const ref = tracker.reference;
	return {
		corners: tracker.kind === 'planar' && ref.corners ? (ref.corners.map((p) => [p[0], p[1]]) as Quad) : null,
		point: tracker.kind === 'point' && ref.point ? [ref.point[0], ref.point[1]] : null,
		confidence: 1,
		tracked: false,
	};
}

/**
 * Merges `incoming` into `existing` (S09:TRK-004): `replace` returns `incoming`; `span` replaces only the samples
 * `incoming` covers and keeps the others. Grids must share `step` and `stride`; the incoming start is snapped
 * to the existing grid. A gap between the spans is filled with lost samples (confidence 0) holding the last value.
 */
export function mergeSamples(
	existing: TrackerSamples | null,
	incoming: TrackerSamples,
	merge: 'replace' | 'span' = 'replace',
): TrackerSamples {
	if (merge === 'replace' || !existing || sampleCount(existing) === 0) return cloneSamples(incoming);
	if (existing.step !== incoming.step || existing.stride !== incoming.stride) return cloneSamples(incoming);
	const stride = existing.stride;
	const step = existing.step;
	const offset = Math.round((incoming.start - existing.start) / step);
	const inN = sampleCount(incoming);
	const exN = sampleCount(existing);
	const first = Math.min(0, offset);
	const last = Math.max(exN - 1, offset + inN - 1);
	const n = last - first + 1;
	const data = new Array<number>(n * stride);
	const conf = new Array<number>(n);
	const filled = new Array<boolean>(n).fill(false);
	for (let i = 0; i < exN; i++) {
		const j = i - first;
		for (let k = 0; k < stride; k++) data[j * stride + k] = existing.data[i * stride + k]!;
		conf[j] = existing.confidence[i] ?? 0;
		filled[j] = true;
	}
	for (let i = 0; i < inN; i++) {
		const j = offset + i - first;
		for (let k = 0; k < stride; k++) data[j * stride + k] = incoming.data[i * stride + k]!;
		conf[j] = incoming.confidence[i] ?? 0;
		filled[j] = true;
	}
	// Gaps (only between disjoint spans): hold the previous sample, confidence 0.
	for (let j = 0; j < n; j++) {
		if (filled[j]) continue;
		for (let k = 0; k < stride; k++) data[j * stride + k] = data[(j - 1) * stride + k]!;
		conf[j] = 0;
	}
	return { start: existing.start + first * step, step, stride, data, confidence: conf };
}

function cloneSamples(s: TrackerSamples): TrackerSamples {
	return { start: s.start, step: s.step, stride: s.stride, data: [...s.data], confidence: [...s.confidence] };
}

/**
 * Re-anchors a track on corrected geometry at content time `t` (the user moved the reference corners after
 * tracking): every planar sample is mapped through the homography sample(t) → sample(i), so the whole track
 * follows the correction exactly (the plane motion is kept, the corners change); point samples are shifted.
 */
export function reanchorSamples(
	s: TrackerSamples,
	t: number,
	geometry: { corners?: Quad; point?: Vec2 },
): TrackerSamples {
	const at = valuesAt(s, t);
	if (!at) return s;
	const n = sampleCount(s);
	const data = [...s.data];
	if (s.stride === PLANAR_STRIDE && geometry.corners) {
		const from = valuesToQuad(at.values);
		for (let i = 0; i < n; i++) {
			const q = valuesToQuad(s.data.slice(i * 8, i * 8 + 8));
			const H = quadToQuad(from, q);
			if (!H) continue;
			const mapped = geometry.corners.map((p) => applyMat3(H, p)) as Quad;
			data.splice(i * 8, 8, ...quadToValues(mapped));
		}
	} else if (s.stride === POINT_STRIDE && geometry.point) {
		const dx = geometry.point[0] - at.values[0]!;
		const dy = geometry.point[1] - at.values[1]!;
		for (let i = 0; i < n; i++) {
			data[i * 2] = data[i * 2]! + dx;
			data[i * 2 + 1] = data[i * 2 + 1]! + dy;
		}
	}
	return { ...s, data };
}

/**
 * Scales a tracker's geometry (reference, samples, patch/search) by `sx, sy`: used when the clip's source is
 * swapped for a processed version of another size (S09:TRK-003, S07:PRC-006). Returns a new tracker.
 */
export function scaleTracker<T extends Pick<ClipTracker, 'reference' | 'samples'>>(
	tracker: T,
	sx: number,
	sy: number,
): T {
	const sc = (p: readonly number[]): Vec2 => [p[0]! * sx, p[1]! * sy];
	const k = Math.sqrt(Math.abs(sx * sy));
	const ref = tracker.reference;
	const reference = {
		...ref,
		...(ref.corners ? { corners: ref.corners.map(sc) } : {}),
		...(ref.point ? { point: sc(ref.point) } : {}),
		...(ref.patch !== undefined ? { patch: Math.max(1, Math.round(ref.patch * k)) } : {}),
		...(ref.search !== undefined ? { search: Math.max(1, Math.round(ref.search * k)) } : {}),
	};
	const samples = tracker.samples
		? { ...tracker.samples, data: tracker.samples.data.map((v, i) => (i % 2 === 0 ? v * sx : v * sy)) }
		: null;
	return { ...tracker, reference, samples };
}

/** Summary for lists and agents: span, mean/min confidence, lost samples. */
export function samplesSummary(s: TrackerSamples | null): {
	count: number;
	start: number | null;
	end: number | null;
	meanConfidence: number | null;
	minConfidence: number | null;
	lost: number;
} {
	const n = s ? sampleCount(s) : 0;
	if (!s || n === 0)
		return { count: 0, start: null, end: null, meanConfidence: null, minConfidence: null, lost: 0 };
	let sum = 0;
	let min = 1;
	let lost = 0;
	for (let i = 0; i < n; i++) {
		const c = s.confidence[i] ?? 0;
		sum += c;
		min = Math.min(min, c);
		if (c <= 0) lost++;
	}
	return { count: n, start: s.start, end: samplesEnd(s), meanConfidence: sum / n, minConfidence: min, lost };
}
