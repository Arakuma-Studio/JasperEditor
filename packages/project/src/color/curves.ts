// Tone curves (M2, S06:CG-020 step 10): a monotone cubic Hermite spline (Fritsch–Carlson / PCHIP) through
// the control points, flat-extrapolated outside the first and last point. Pure; `curveFn` precomputes the
// slopes so evaluation inside a LUT bake allocates nothing.
import type { Vec2 } from '../schema/common.ts';

/** Most control points a curve may carry (S06:CGU-001). */
export const MAX_CURVE_POINTS = 64;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Normalizes control points: finite values clamped to 0..1, sorted by x, one point per x (the last one wins),
 * at most `MAX_CURVE_POINTS`. Returns null when fewer than two points remain.
 */
export function normalizeCurve(points: readonly (readonly number[])[] | null | undefined): Vec2[] | null {
	if (!Array.isArray(points)) return null;
	const pts: Vec2[] = [];
	for (const p of points) {
		if (!Array.isArray(p) || p.length < 2) continue;
		const x = Number(p[0]);
		const y = Number(p[1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		pts.push([clamp01(x), clamp01(y)]);
	}
	pts.sort((a, b) => a[0] - b[0]);
	const out: Vec2[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (last && Math.abs(last[0] - p[0]) < 1e-9) out[out.length - 1] = p;
		else out.push(p);
	}
	if (out.length > MAX_CURVE_POINTS) out.length = MAX_CURVE_POINTS;
	return out.length >= 2 ? out : null;
}

/** True when the points describe `y = x` on 0..1 (every point on the diagonal, ends at 0 and 1). */
function isIdentityCurve(points: readonly Vec2[]): boolean {
	const first = points[0]!;
	const last = points[points.length - 1]!;
	if (first[0] > 1e-9 || last[0] < 1 - 1e-9) {
		// Flat extrapolation: y = x everywhere only when the ends reach the corners.
		return false;
	}
	return points.every(([x, y]) => Math.abs(x - y) < 1e-9);
}

/** PCHIP end-point derivative (three-point, shape preserving; SciPy's convention). */
function edgeSlope(h0: number, h1: number, d0: number, d1: number): number {
	const d = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
	if (Math.sign(d) !== Math.sign(d0)) return 0;
	if (Math.sign(d0) !== Math.sign(d1) && Math.abs(d) > Math.abs(3 * d0)) return 3 * d0;
	return d;
}

/** Hermite slopes at each control point (Fritsch–Carlson with the weighted harmonic mean). */
function pchipSlopes(xs: readonly number[], ys: readonly number[]): number[] {
	const n = xs.length;
	const h: number[] = [];
	const d: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		h.push(xs[i + 1]! - xs[i]!);
		d.push((ys[i + 1]! - ys[i]!) / h[i]!);
	}
	if (n === 2) return [d[0]!, d[0]!];
	const m = new Array<number>(n).fill(0);
	for (let i = 1; i < n - 1; i++) {
		const a = d[i - 1]!;
		const b = d[i]!;
		if (a === 0 || b === 0 || Math.sign(a) !== Math.sign(b)) m[i] = 0;
		else {
			const w1 = 2 * h[i]! + h[i - 1]!;
			const w2 = h[i]! + 2 * h[i - 1]!;
			m[i] = (w1 + w2) / (w1 / a + w2 / b);
		}
	}
	m[0] = edgeSlope(h[0]!, h[1]!, d[0]!, d[1]!);
	m[n - 1] = edgeSlope(h[n - 2]!, h[n - 3]!, d[n - 2]!, d[n - 3]!);
	return m;
}

/**
 * The curve as a function 0..1 → 0..1 (inputs outside 0..1 are evaluated with flat extrapolation too), or
 * null for the identity. Accepts raw param values (unsorted / out of range points are normalized).
 */
export function curveFn(
	points: readonly (readonly number[])[] | null | undefined,
): ((x: number) => number) | null {
	const pts = normalizeCurve(points);
	if (!pts || isIdentityCurve(pts)) return null;
	const n = pts.length;
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const ms = pchipSlopes(xs, ys);
	const x0 = xs[0]!;
	const xN = xs[n - 1]!;
	const y0 = ys[0]!;
	const yN = ys[n - 1]!;
	// Flat arrays for the hot loop.
	const X = Float64Array.from(xs);
	const Y = Float64Array.from(ys);
	const M = Float64Array.from(ms);
	return (x: number) => {
		if (!(x > x0)) return y0;
		if (x >= xN) return yN;
		// Segment search (≤ 64 points: binary search).
		let lo = 0;
		let hi = n - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (X[mid]! <= x) lo = mid;
			else hi = mid;
		}
		const h = X[hi]! - X[lo]!;
		const t = (x - X[lo]!) / h;
		const t2 = t * t;
		const t3 = t2 * t;
		const h00 = 2 * t3 - 3 * t2 + 1;
		const h10 = t3 - 2 * t2 + t;
		const h01 = -2 * t3 + 3 * t2;
		const h11 = t3 - t2;
		return h00 * Y[lo]! + h10 * h * M[lo]! + h01 * Y[hi]! + h11 * h * M[hi]!;
	};
}

/** Samples a curve at `n` evenly spaced inputs for UI drawing. */
export function sampleCurve(points: readonly (readonly number[])[] | null | undefined, n = 256): number[] {
	const f = curveFn(points) ?? ((x: number) => x);
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(f(i / (n - 1)));
	return out;
}
