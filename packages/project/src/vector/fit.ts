// Least-squares cubic Bézier fitting of point runs (wp shapes), used to merge split curve pieces back together after
// booleans and offsets. Port of EffectCraft's `crates/path/src/fit.rs` (adapted from VectorCraft's pathops; the
// classic "fit a cubic with fixed end tangents, reparameterise with Newton steps" approach from Graphics Gems).
import { add, type Cubic, cDeriv, cDeriv2, cEval, dist, dot, mul, type P, sub } from './geom.ts';

const MAX_REPARAM = 6;

function chordParams(pts: readonly P[]): number[] {
	const u = [0];
	let acc = 0;
	for (let i = 1; i < pts.length; i++) {
		acc += dist(pts[i - 1]!, pts[i]!);
		u.push(acc);
	}
	return acc > 0 ? u.map((x) => x / acc) : u;
}

function bern(t: number): [number, number, number, number] {
	const s = 1 - t;
	return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

function generate(pts: readonly P[], u: readonly number[], t0: P, t1: P): Cubic {
	const p0 = pts[0]!;
	const p3 = pts[pts.length - 1]!;
	const dirIn: P = [-t1[0], -t1[1]];
	let c00 = 0;
	let c01 = 0;
	let c11 = 0;
	let x0 = 0;
	let x1 = 0;
	pts.forEach((p, i) => {
		const b = bern(u[i]!);
		const a0 = mul(t0, b[1]);
		const a1 = mul(dirIn, b[2]);
		c00 += dot(a0, a0);
		c01 += dot(a0, a1);
		c11 += dot(a1, a1);
		const base = add(mul(p0, b[0] + b[1]), mul(p3, b[2] + b[3]));
		const tmp = sub(p, base);
		x0 += dot(a0, tmp);
		x1 += dot(a1, tmp);
	});
	const det = c00 * c11 - c01 * c01;
	const seg = dist(p0, p3);
	const eps = 1e-6 * seg;
	let al = seg / 3;
	let ar = seg / 3;
	if (Math.abs(det) > 1e-12) {
		al = (x0 * c11 - x1 * c01) / det;
		ar = (c00 * x1 - c01 * x0) / det;
	}
	if (!Number.isFinite(al) || !Number.isFinite(ar) || al < eps || ar < eps) {
		al = seg / 3;
		ar = seg / 3;
	}
	const cap = seg * 4 + 1e-9;
	al = Math.min(al, cap);
	ar = Math.min(ar, cap);
	return [p0, add(p0, mul(t0, al)), add(p3, mul(dirIn, ar)), p3];
}

function maxError(pts: readonly P[], c: Cubic, u: readonly number[]): number {
	let e = 0;
	pts.forEach((p, i) => {
		e = Math.max(e, dist(cEval(c, u[i]!), p));
	});
	return e;
}

function newton(c: Cubic, p: P, t: number): number {
	const q = sub(cEval(c, t), p);
	const q1 = cDeriv(c, t);
	const q2 = cDeriv2(c, t);
	const num = dot(q, q1);
	const den = dot(q1, q1) + dot(q, q2);
	if (Math.abs(den) < 1e-12) return t;
	const nt = t - num / den;
	return Number.isFinite(nt) ? Math.min(1, Math.max(0, nt)) : t;
}

/** Best single cubic through `pts` with the given unit end tangents; returns the curve and its max error. */
export function fitSingle(pts: readonly P[], t0: P, t1: P): { c: Cubic; err: number } {
	let u = chordParams(pts);
	let best = generate(pts, u, t0, t1);
	let bestErr = maxError(pts, best, u);
	for (let i = 0; i < MAX_REPARAM; i++) {
		u = u.map((ui, k) => newton(best, pts[k]!, ui));
		const c = generate(pts, u, t0, t1);
		const e = maxError(pts, c, u);
		if (e < bestErr) {
			best = c;
			bestErr = e;
		} else break;
	}
	return { c: best, err: bestErr };
}

/** Samples a cubic at n+1 evenly spaced parameters. */
export function sampleCubic(c: Cubic, n: number, out: P[], includeStart: boolean): void {
	for (let i = includeStart ? 0 : 1; i <= n; i++) out.push(cEval(c, i / n));
}

/** Is the cubic (within tol) a straight line from p0 to p3 with handles inside the chord? */
export function isStraight(c: Cubic, tol: number): boolean {
	const chord = sub(c[3], c[0]);
	const len = Math.hypot(chord[0], chord[1]);
	if (len < 1e-12) return dist(c[1], c[0]) <= tol && dist(c[2], c[0]) <= tol;
	const d: P = [chord[0] / len, chord[1] / len];
	return [c[1], c[2]].every((h) => {
		const v = sub(h, c[0]);
		const along = dot(v, d);
		return Math.abs(v[0] * d[1] - v[1] * d[0]) <= tol && along >= -tol && along <= len + tol;
	});
}
