// Motion-path clean-up (keyframe assistant ▸ Clean Up Path): the fewest keys of a span of point keys whose drawn
// motion path stays within a tolerance of the original path. Unlike `keyframes.simplify` (which keeps the timing at
// every frame and refits temporal eases) this measures the path only — the timing becomes linear between the kept
// keys — and refits the spatial Bézier tangents across removed keys.
//
// Method (curve fitting after P. J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves", Graphics
// Gems, 1990 — implemented from the published description): the original path between kept keys i and j is sampled;
// a single cubic from key i to key j with its end tangents along the original path's directions there is fitted by
// least squares on chord-length parameters, refined by Newton re-parameterisation; the fit is accepted when the
// two-sided distance between the fitted curve and the original samples is within the tolerance. Consecutive keys keep
// their original segment exactly, so a solution always exists. The fewest kept keys come from a shortest path over the
// accepted spans (dynamic programming): a span is only fitted when it can improve a key count, and each scan from a
// key stops after a run of rejected ends.
import {
	activeMetric,
	type BezierSegment,
	bezierPoint,
	fromMetric,
	keysInMetric,
	type SpatialMetric,
	spatialSegment,
} from '../keyframes-spatial.ts';
import type { Keyframe, Vec2 } from '../schema/common.ts';

type Keys = Keyframe<unknown>[];

/** Samples per original segment. */
const SEGMENT_SAMPLES = 24;
/** Samples of a fitted curve when measuring it. */
const FIT_SAMPLES = 64;
/** Newton re-parameterisation passes per fit. */
const REPARAM_PASSES = 4;
/** Consecutive rejected span ends after which the scan from a key stops. */
const MISS_LIMIT = 6;
/** Longest span (in original segments) one fitted cubic may replace. */
const MAX_FIT_SEGMENTS = 128;

export type PathFitPlan = {
	/** Indices (into the key array) of the kept keys, first and last of the span included. */
	kept: number[];
	/** Tangents of the kept keys (offsets from their values), per kept index. */
	tangents: Map<number, { in: Vec2; out: Vec2 }>;
	/** Largest measured distance between the new and the original path (value units, sequence px for Motion; with a
	 * metric, its pixels). */
	maxError: number;
};

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
function unit(v: Vec2): Vec2 | null {
	const l = Math.hypot(v[0], v[1]);
	return l > 1e-12 ? [v[0] / l, v[1] / l] : null;
}

/** The segment leaving key i as a cubic (straight segments with controls at the thirds). */
function segmentOf(kfs: Keys, i: number): BezierSegment {
	const seg = spatialSegment(kfs, i);
	if (seg) return seg;
	const p0 = kfs[i]!.value as Vec2;
	const p3 = kfs[i + 1]!.value as Vec2;
	const d = sub(p3, p0);
	return [[p0[0], p0[1]], add(p0, scale(d, 1 / 3)), add(p0, scale(d, 2 / 3)), [p3[0], p3[1]]];
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
	const abx = b[0] - a[0];
	const aby = b[1] - a[1];
	const L2 = abx * abx + aby * aby;
	const t = L2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / L2)) : 0;
	return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
}

/** Polyline segments searched around the previous point's nearest one before a full scan. */
const SEARCH_WINDOW = 8;

/**
 * Largest distance from the points (in path order) to the polyline, or Infinity as soon as one exceeds `limit`.
 * Each point's distance is the nearest segment near the previous point's (an upper bound of its true distance, so
 * accepting it is conservative), with a full scan when that is beyond the limit.
 */
function maxDistanceToPolyline(points: readonly Vec2[], poly: readonly Vec2[], limit: number): number {
	if (poly.length === 1) {
		let worst = 0;
		for (const p of points) worst = Math.max(worst, Math.hypot(p[0] - poly[0]![0], p[1] - poly[0]![1]));
		return worst > limit ? Number.POSITIVE_INFINITY : worst;
	}
	const last = poly.length - 2;
	let worst = 0;
	let hint = 0;
	for (const p of points) {
		let best = Number.POSITIVE_INFINITY;
		let bestK = hint;
		const scan = (lo: number, hi: number) => {
			for (let k = lo; k <= hi; k++) {
				const d = pointSegmentDistance(p, poly[k]!, poly[k + 1]!);
				if (d < best) {
					best = d;
					bestK = k;
				}
			}
		};
		scan(Math.max(0, hint - SEARCH_WINDOW), Math.min(last, hint + SEARCH_WINDOW));
		if (best > limit) scan(0, last);
		if (best > limit) return Number.POSITIVE_INFINITY;
		hint = bestK;
		if (best > worst) worst = best;
	}
	return worst;
}

/** First derivative of a cubic. */
function derivative(c: BezierSegment, t: number): Vec2 {
	const s = 1 - t;
	const d = (k: 0 | 1) =>
		3 * s * s * (c[1][k] - c[0][k]) + 6 * s * t * (c[2][k] - c[1][k]) + 3 * t * t * (c[3][k] - c[2][k]);
	return [d(0), d(1)];
}
function secondDerivative(c: BezierSegment, t: number): Vec2 {
	const d = (k: 0 | 1) =>
		6 * (1 - t) * (c[2][k] - 2 * c[1][k] + c[0][k]) + 6 * t * (c[3][k] - 2 * c[2][k] + c[1][k]);
	return [d(0), d(1)];
}

/** Least-squares handle lengths along fixed end tangents (Schneider's 2×2 system), with a chord fallback. */
function fitHandles(points: readonly Vec2[], u: readonly number[], p0: Vec2, p3: Vec2, t1: Vec2, t2: Vec2) {
	let c00 = 0;
	let c01 = 0;
	let c11 = 0;
	let x0 = 0;
	let x1 = 0;
	points.forEach((d, i) => {
		const t = u[i]!;
		const s = 1 - t;
		const b0 = s * s * s;
		const b1 = 3 * s * s * t;
		const b2 = 3 * s * t * t;
		const b3 = t * t * t;
		const a1 = scale(t1, b1);
		const a2 = scale(t2, b2);
		c00 += dot(a1, a1);
		c01 += dot(a1, a2);
		c11 += dot(a2, a2);
		const tmp = sub(d, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
		x0 += dot(a1, tmp);
		x1 += dot(a2, tmp);
	});
	const det = c00 * c11 - c01 * c01;
	const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
	let alpha1 = Math.abs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : 0;
	let alpha2 = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : 0;
	const eps = 1e-6 * Math.max(chord, 1e-6);
	if (!(alpha1 > eps) || !(alpha2 > eps) || !Number.isFinite(alpha1) || !Number.isFinite(alpha2)) {
		alpha1 = chord / 3;
		alpha2 = chord / 3;
	}
	return { alpha1, alpha2 };
}

type Span = { seg: BezierSegment; error: number };

/**
 * Plans the clean-up of span a → b (point keys, plain array). `dirs` give the path's direction leaving / arriving at
 * each key (null where the path does not move).
 */
export function planPathCleanup(
	kfs: Keys,
	a: number,
	b: number,
	tolerance: number,
	/**
	 * spatial-points: the evaluator's metric of the point values (effect points: [box width, box height]). The path is
	 * fitted on the keys in its pixels — `tolerance` and `maxError` are layer px — and the tangents mapped back to value
	 * units (the same Béziers).
	 */
	metric?: SpatialMetric | null,
): PathFitPlan {
	const m = activeMetric(metric);
	if (m) {
		const plan = planPathCleanup(keysInMetric(kfs, m), a, b, tolerance);
		for (const t of plan.tangents.values()) {
			t.in = fromMetric(t.in, m);
			t.out = fromMetric(t.out, m);
		}
		return plan;
	}
	const segs: BezierSegment[] = [];
	for (let i = a; i < b; i++) segs.push(segmentOf(kfs, i));
	const samples = segs.map((s) =>
		Array.from({ length: SEGMENT_SAMPLES + 1 }, (_, k) => bezierPoint(s, k / SEGMENT_SAMPLES)),
	);
	const startDir = (i: number): Vec2 | null => {
		const s = segs[i - a]!;
		return unit(sub(s[1], s[0])) ?? unit(sub(s[2], s[0])) ?? unit(sub(s[3], s[0]));
	};
	const endDir = (j: number): Vec2 | null => {
		const s = segs[j - 1 - a]!;
		return unit(sub(s[3], s[2])) ?? unit(sub(s[3], s[1])) ?? unit(sub(s[3], s[0]));
	};

	const fit = (i: number, j: number): Span | null => {
		const points: Vec2[] = [];
		for (let k = i; k < j; k++) {
			const list = samples[k - a]!;
			for (let q = k === i ? 0 : 1; q < list.length; q++) points.push(list[q]!);
		}
		const p0 = kfs[i]!.value as Vec2;
		const p3 = kfs[j]!.value as Vec2;
		const chordDir = unit(sub(p3, p0));
		const t1 = startDir(i) ?? chordDir;
		const back = endDir(j);
		const t2: Vec2 | null = back ? [-back[0], -back[1]] : chordDir ? [-chordDir[0], -chordDir[1]] : null;
		if (!t1 || !t2) return null;
		// Chord-length parameters.
		const u = [0];
		for (let k = 1; k < points.length; k++)
			u.push(u[k - 1]! + Math.hypot(points[k]![0] - points[k - 1]![0], points[k]![1] - points[k - 1]![1]));
		const L = u[u.length - 1]!;
		if (!(L > 0)) return null;
		for (let k = 0; k < u.length; k++) u[k] = u[k]! / L;
		let seg: BezierSegment = [p0, p0, p3, p3];
		for (let pass = 0; pass <= REPARAM_PASSES; pass++) {
			const { alpha1, alpha2 } = fitHandles(points, u, p0, p3, t1, t2);
			seg = [p0, add(p0, scale(t1, alpha1)), add(p3, scale(t2, alpha2)), p3];
			if (pass === REPARAM_PASSES) break;
			for (let k = 1; k + 1 < u.length; k++) {
				const t = u[k]!;
				const d = sub(bezierPoint(seg, t), points[k]!);
				const d1 = derivative(seg, t);
				const d2 = secondDerivative(seg, t);
				const den = dot(d1, d1) + dot(d, d2);
				if (Math.abs(den) > 1e-12) u[k] = Math.min(1, Math.max(0, t - dot(d, d1) / den));
			}
		}
		const fitted = Array.from({ length: FIT_SAMPLES + 1 }, (_, k) => bezierPoint(seg, k / FIT_SAMPLES));
		const there = maxDistanceToPolyline(points, fitted, tolerance);
		if (!(there <= tolerance)) return null;
		const returning = maxDistanceToPolyline(fitted, points, tolerance);
		if (!(returning <= tolerance)) return null;
		return { seg, error: Math.max(there, returning) };
	};

	// Shortest path over accepted spans: best[i] = fewest segments from a to i.
	const n = b - a;
	const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
	const from = new Array<number>(n + 1).fill(-1);
	const spans = new Map<string, Span>();
	best[0] = 0;
	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(best[i]!)) continue;
		if (best[i]! + 1 < best[i + 1]!) {
			best[i + 1] = best[i]! + 1;
			from[i + 1] = i;
		}
		let misses = 0;
		for (let j = i + 2; j <= n && j - i <= MAX_FIT_SEGMENTS && misses < MISS_LIMIT; j++) {
			// Only fit spans that can improve a key count.
			if (best[i]! + 1 >= best[j]!) continue;
			const s = fit(a + i, a + j);
			if (!s) {
				misses++;
				continue;
			}
			misses = 0;
			spans.set(`${i}:${j}`, s);
			if (best[i]! + 1 < best[j]!) {
				best[j] = best[i]! + 1;
				from[j] = i;
			}
		}
	}
	const chain: number[] = [n];
	while (chain[0]! > 0) chain.unshift(from[chain[0]!]!);
	const kept = chain.map((c) => a + c);
	const tangents = new Map<number, { in: Vec2; out: Vec2 }>();
	for (const k of kept) tangents.set(k, { in: [0, 0], out: [0, 0] });
	let maxError = 0;
	for (let c = 0; c + 1 < chain.length; c++) {
		const i = chain[c]!;
		const j = chain[c + 1]!;
		const seg = j === i + 1 ? segs[i]! : spans.get(`${i}:${j}`)!.seg;
		if (j > i + 1) maxError = Math.max(maxError, spans.get(`${i}:${j}`)!.error);
		const ki = a + i;
		const kj = a + j;
		const vi = kfs[ki]!.value as Vec2;
		const vj = kfs[kj]!.value as Vec2;
		// Straight original segments keep zero tangents (linear).
		const straight = j === i + 1 && !spatialSegment(kfs, ki);
		tangents.get(ki)!.out = straight ? [0, 0] : sub(seg[1], vi);
		tangents.get(kj)!.in = straight ? [0, 0] : sub(seg[2], vj);
	}
	return { kept, tangents, maxError };
}
