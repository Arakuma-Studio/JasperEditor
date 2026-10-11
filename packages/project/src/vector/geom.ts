// Vector geometry kernel (wp shapes): cubic Bézier paths as compound paths of subpaths, the shared geometry of
// shape layers (preview and export draw the same paths: the composition renders them as SVG, the bake renders that
// composition). Every segment is a cubic; straight segments keep their handles on their end points (`isLine`), which
// is how the After Effects vertex/tangent model stores them (zero tangents) and how SVG output writes `L`.
//
// Ported in spirit from EffectCraft's `effectcraft-path` (kurbo based, MIT OR Apache-2.0); see
// licenses/ported/shapes.md. Pure TypeScript, no DOM.

export type P = readonly [number, number];
export type Cubic = readonly [P, P, P, P];
/** One subpath: consecutive cubics (segs[i][3] === segs[i+1][0]); `closed` adds the implicit closing join. */
export type SubPath = { segs: Cubic[]; closed: boolean };
/** A compound path (filled as one, fill rule decides overlaps). */
export type BezPath = SubPath[];
/** 2D affine matrix in SVG order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

// ---------------------------------------------------------------- vectors

export const add = (a: P, b: P): [number, number] => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: P, b: P): [number, number] => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: P, k: number): [number, number] => [a[0] * k, a[1] * k];
export const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: P, b: P): number => a[0] * b[1] - a[1] * b[0];
export const hypot = (a: P): number => Math.hypot(a[0], a[1]);
export const dist = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: P, b: P, t: number): [number, number] => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
];
/** Left normal (rotate +90° in a y-down frame it points to the right of travel… callers only rely on consistency). */
export const perp = (v: P): [number, number] => [-v[1], v[0]];
export const samePoint = (a: P, b: P, eps = 1e-9): boolean =>
	Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

/** Unit vector, or null when (nearly) zero. */
export function unit(v: P): [number, number] | null {
	const l = Math.hypot(v[0], v[1]);
	return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
}

// ---------------------------------------------------------------- cubics

export const lineCubic = (a: P, b: P): Cubic => [a, a, b, b];

/** True when the cubic is a straight segment stored the vertex-model way (handles on the end points). */
export function isLine(c: Cubic): boolean {
	return samePoint(c[0], c[1], 0) && samePoint(c[2], c[3], 0);
}

/** Point at t. Straight segments (`isLine`) are parameterised uniformly, like a line. */
export function cEval(c: Cubic, t: number): [number, number] {
	if (isLine(c)) return lerp(c[0], c[3], t);
	const s = 1 - t;
	const a = s * s * s;
	const b = 3 * s * s * t;
	const d = 3 * s * t * t;
	const e = t * t * t;
	return [
		a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
		a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
	];
}

export function cDeriv(c: Cubic, t: number): [number, number] {
	if (isLine(c)) return sub(c[3], c[0]);
	const s = 1 - t;
	const a = 3 * s * s;
	const b = 6 * s * t;
	const d = 3 * t * t;
	return [
		a * (c[1][0] - c[0][0]) + b * (c[2][0] - c[1][0]) + d * (c[3][0] - c[2][0]),
		a * (c[1][1] - c[0][1]) + b * (c[2][1] - c[1][1]) + d * (c[3][1] - c[2][1]),
	];
}

export function cDeriv2(c: Cubic, t: number): [number, number] {
	if (isLine(c)) return [0, 0];
	const s = 1 - t;
	return [
		6 * s * (c[2][0] - 2 * c[1][0] + c[0][0]) + 6 * t * (c[3][0] - 2 * c[2][0] + c[1][0]),
		6 * s * (c[2][1] - 2 * c[1][1] + c[0][1]) + 6 * t * (c[3][1] - 2 * c[2][1] + c[1][1]),
	];
}

/** De Casteljau split at t. */
export function cSplit(c: Cubic, t: number): [Cubic, Cubic] {
	if (isLine(c)) {
		const m = lerp(c[0], c[3], t);
		return [lineCubic(c[0], m), lineCubic(m, c[3])];
	}
	const ab = lerp(c[0], c[1], t);
	const bc = lerp(c[1], c[2], t);
	const cd = lerp(c[2], c[3], t);
	const abc = lerp(ab, bc, t);
	const bcd = lerp(bc, cd, t);
	const m = lerp(abc, bcd, t);
	return [
		[c[0], ab, abc, m],
		[m, bcd, cd, c[3]],
	];
}

/** The part of a cubic between parameters t0 < t1 (lines stay lines). */
export function cSub(c: Cubic, t0: number, t1: number): Cubic {
	if (t0 <= 0 && t1 >= 1) return c;
	if (isLine(c)) return lineCubic(lerp(c[0], c[3], t0), lerp(c[0], c[3], t1));
	let r = c;
	if (t1 < 1) r = cSplit(r, t1)[0];
	if (t0 > 0) r = cSplit(r, t1 > 0 ? t0 / t1 : 0)[1];
	return r;
}

export const cReverse = (c: Cubic): Cubic => [c[3], c[2], c[1], c[0]];

export function cTransform(c: Cubic, m: Affine): Cubic {
	return [apply(m, c[0]), apply(m, c[1]), apply(m, c[2]), apply(m, c[3])];
}

/** Every control point equal (a dot). */
export function cDegenerate(c: Cubic, eps = 1e-9): boolean {
	return samePoint(c[0], c[1], eps) && samePoint(c[0], c[2], eps) && samePoint(c[0], c[3], eps);
}

/** Direction the curve leaves p0 (robust to retracted handles). */
export function startTangent(c: Cubic): [number, number] {
	return unit(sub(c[1], c[0])) ?? unit(sub(c[2], c[0])) ?? unit(sub(c[3], c[0])) ?? [1, 0];
}

/** Direction the curve arrives at p3 (pointing forward along travel). */
export function endTangent(c: Cubic): [number, number] {
	return unit(sub(c[3], c[2])) ?? unit(sub(c[3], c[1])) ?? unit(sub(c[3], c[0])) ?? [1, 0];
}

/** Unit tangent at t (robust at retracted handles). */
export function tangentAt(c: Cubic, t: number): [number, number] {
	if (t <= 1e-9) return startTangent(c);
	if (t >= 1 - 1e-9) return endTangent(c);
	return unit(cDeriv(c, t)) ?? startTangent(c);
}

// Gauss–Legendre 8-point nodes/weights on [-1, 1].
const GL_X = [
	-0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498, 0.1834346424956498,
	0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
	0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
	0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

function glLength(c: Cubic, t0: number, t1: number): number {
	const h = (t1 - t0) / 2;
	const m = (t1 + t0) / 2;
	let s = 0;
	for (let i = 0; i < 8; i++) s += GL_W[i]! * hypot(cDeriv(c, m + h * GL_X[i]!));
	return s * h;
}

function adaptiveLength(c: Cubic, t0: number, t1: number, whole: number, acc: number, depth: number): number {
	const m = (t0 + t1) / 2;
	const a = glLength(c, t0, m);
	const b = glLength(c, m, t1);
	if (depth >= 12 || Math.abs(a + b - whole) <= acc) return a + b;
	return adaptiveLength(c, t0, m, a, acc / 2, depth + 1) + adaptiveLength(c, m, t1, b, acc / 2, depth + 1);
}

/** Arc length from t0 to t1 (default the whole curve), accurate to about `acc` pixels. */
export function cArclen(c: Cubic, t0 = 0, t1 = 1, acc = 1e-4): number {
	if (t1 <= t0) return 0;
	if (isLine(c)) return dist(c[0], c[3]) * (t1 - t0);
	return adaptiveLength(c, t0, t1, glLength(c, t0, t1), acc, 0);
}

/** Parameter at arc length `s` from the start (0 ≤ s ≤ len). */
export function cInvArclen(c: Cubic, s: number, len = cArclen(c), acc = 1e-4): number {
	if (s <= 0) return 0;
	if (s >= len) return 1;
	if (isLine(c)) return s / len;
	let lo = 0;
	let hi = 1;
	let t = s / len;
	for (let i = 0; i < 40; i++) {
		const f = cArclen(c, 0, t, acc / 4) - s;
		if (Math.abs(f) <= acc) return t;
		if (f > 0) hi = t;
		else lo = t;
		const d = hypot(cDeriv(c, t));
		let next = d > 1e-12 ? t - f / d : (lo + hi) / 2;
		if (!(next > lo && next < hi)) next = (lo + hi) / 2;
		t = next;
	}
	return t;
}

/** Roots of a·t² + b·t + c in (0, 1). */
function quadRoots01(a: number, b: number, c: number): number[] {
	const out: number[] = [];
	if (Math.abs(a) < 1e-12) {
		if (Math.abs(b) > 1e-12) out.push(-c / b);
	} else {
		const disc = b * b - 4 * a * c;
		if (disc >= 0) {
			const s = Math.sqrt(disc);
			out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
		}
	}
	return out.filter((t) => t > 0 && t < 1);
}

/** Parameters of the x and y extrema strictly inside (0, 1). */
export function cExtrema(c: Cubic): number[] {
	const out: number[] = [];
	for (const k of [0, 1] as const) {
		const p0 = c[0][k];
		const p1 = c[1][k];
		const p2 = c[2][k];
		const p3 = c[3][k];
		// Derivative / 3 = a t² + b t + c
		const a = -p0 + 3 * p1 - 3 * p2 + p3;
		const b = 2 * (p0 - 2 * p1 + p2);
		const cc = p1 - p0;
		out.push(...quadRoots01(a, b, cc));
	}
	return out;
}

export type Bounds = { x0: number; y0: number; x1: number; y1: number };

export function cBounds(c: Cubic): Bounds {
	let x0 = Math.min(c[0][0], c[3][0]);
	let x1 = Math.max(c[0][0], c[3][0]);
	let y0 = Math.min(c[0][1], c[3][1]);
	let y1 = Math.max(c[0][1], c[3][1]);
	if (!isLine(c)) {
		for (const t of cExtrema(c)) {
			const p = cEval(c, t);
			x0 = Math.min(x0, p[0]);
			x1 = Math.max(x1, p[0]);
			y0 = Math.min(y0, p[1]);
			y1 = Math.max(y1, p[1]);
		}
	}
	return { x0, y0, x1, y1 };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
	if (!a) return b;
	if (!b) return a;
	return {
		x0: Math.min(a.x0, b.x0),
		y0: Math.min(a.y0, b.y0),
		x1: Math.max(a.x1, b.x1),
		y1: Math.max(a.y1, b.y1),
	};
}

export function pathBounds(p: BezPath): Bounds | null {
	let b: Bounds | null = null;
	for (const sp of p) for (const c of sp.segs) b = unionBounds(b, cBounds(c));
	return b;
}

/** Nearest point on a cubic: parameter and squared distance. */
export function cNearest(c: Cubic, p: P): { t: number; d2: number } {
	const N = isLine(c) ? 1 : 16;
	let best = { t: 0, d2: Number.POSITIVE_INFINITY };
	if (isLine(c)) {
		const d = sub(c[3], c[0]);
		const l2 = dot(d, d);
		const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, c[0]), d) / l2)) : 0;
		const q = lerp(c[0], c[3], t);
		return { t, d2: (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 };
	}
	for (let i = 0; i <= N; i++) {
		const t = i / N;
		const q = cEval(c, t);
		const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
		if (d2 < best.d2) best = { t, d2 };
	}
	// Newton refinement on f(t) = (B(t) − p)·B'(t).
	let t = best.t;
	for (let i = 0; i < 8; i++) {
		const q = sub(cEval(c, t), p);
		const d1 = cDeriv(c, t);
		const d2v = cDeriv2(c, t);
		const f = dot(q, d1);
		const df = dot(d1, d1) + dot(q, d2v);
		if (Math.abs(df) < 1e-12) break;
		const nt = Math.min(1, Math.max(0, t - f / df));
		if (Math.abs(nt - t) < 1e-10) {
			t = nt;
			break;
		}
		t = nt;
	}
	const q = cEval(c, t);
	const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
	return d2 < best.d2 ? { t, d2 } : best;
}

/** Signed area under the cubic for Green's theorem (sum over a closed loop = signed area; y-down: clockwise > 0). */
export function cAreaTerm(c: Cubic): number {
	const [p0, p1, p2, p3] = c;
	// ½∮(x dy − y dx) over the cubic, closed form (as kurbo's CubicBez::signed_area).
	return (
		(p0[0] * (6 * p1[1] + 3 * p2[1] + p3[1]) +
			3 * (p1[0] * (-2 * p0[1] + p2[1] + p3[1]) - p2[0] * (p0[1] + p1[1] - 2 * p3[1])) -
			p3[0] * (p0[1] + 3 * p1[1] + 6 * p2[1])) /
		20
	);
}

/** Flattens a cubic into points (excluding its start) with `tol` maximum deviation. */
export function cFlatten(c: Cubic, tol: number, out: [number, number][]): void {
	if (isLine(c)) {
		out.push([c[3][0], c[3][1]]);
		return;
	}
	// Number of pieces from the second-difference bound (Wang's formula).
	const ddx = Math.max(Math.abs(c[0][0] - 2 * c[1][0] + c[2][0]), Math.abs(c[1][0] - 2 * c[2][0] + c[3][0]));
	const ddy = Math.max(Math.abs(c[0][1] - 2 * c[1][1] + c[2][1]), Math.abs(c[1][1] - 2 * c[2][1] + c[3][1]));
	const dd = Math.hypot(ddx, ddy);
	const n = Math.min(4096, Math.max(1, Math.ceil(Math.sqrt((3 * dd) / (4 * Math.max(tol, 1e-6))))));
	for (let i = 1; i <= n; i++) out.push(cEval(c, i / n));
}

// ---------------------------------------------------------------- affine

export function apply(m: Affine, p: P): [number, number] {
	return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** m · n (n applied first). */
export function compose(m: Affine, n: Affine): Affine {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

export function invert(m: Affine): Affine | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
	const a = m[3] / det;
	const b = -m[1] / det;
	const c = -m[2] / det;
	const d = m[0] / det;
	return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
export const scale = (x: number, y: number): Affine => [x, 0, 0, y, 0, 0];
export function rotateDeg(deg: number): Affine {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return [c, s, -s, c, 0, 0];
}
/**
 * Shear along an axis: rotate the axis onto x, x' = x + tan(skew)·y, rotate back (EffectCraft's `Mat3::skew_deg`).
 * Shape group transforms pass −Skew, so a positive After Effects Skew leans the top of the content to the right.
 */
export function skewDeg(skewDegrees: number, axisDeg: number): Affine {
	if (skewDegrees === 0) return IDENTITY;
	const k = Math.tan((Math.max(-89.9, Math.min(89.9, skewDegrees)) * Math.PI) / 180);
	const shear: Affine = [1, 0, k, 1, 0, 0];
	return compose(rotateDeg(axisDeg), compose(shear, rotateDeg(-axisDeg)));
}

/** Mean linear scale of a matrix (√|det|). */
export const meanScale = (m: Affine): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export function transformPath(p: BezPath, m: Affine): BezPath {
	if (m === IDENTITY) return p;
	return p.map((sp) => ({ closed: sp.closed, segs: sp.segs.map((c) => cTransform(c, m)) }));
}

// ---------------------------------------------------------------- paths

export function reversePath(p: BezPath): BezPath {
	return p.map((sp) => ({ closed: sp.closed, segs: sp.segs.map(cReverse).reverse() }));
}

/** Signed area of the closed interpretation of every subpath (y-down: clockwise > 0). */
export function signedArea(p: BezPath): number {
	let a = 0;
	for (const sp of p) {
		if (!sp.segs.length) continue;
		for (const c of sp.segs) a += cAreaTerm(c);
		const first = sp.segs[0]![0];
		const last = sp.segs[sp.segs.length - 1]![3];
		if (!samePoint(first, last)) a += cAreaTerm(lineCubic(last, first));
	}
	return a;
}

export function pathLength(p: BezPath): number {
	let l = 0;
	for (const sp of p) {
		for (const c of sp.segs) l += cArclen(c);
		if (sp.closed) l += closingLength(sp);
	}
	return l;
}

function closingLength(sp: SubPath): number {
	const first = sp.segs[0]?.[0];
	const last = sp.segs[sp.segs.length - 1]?.[3];
	return first && last ? dist(first, last) : 0;
}

/**
 * The segments of a subpath including the closing line of a closed one (when its ends differ); degenerate segments
 * removed. This is the "walked" outline every operator works on.
 */
export function walkSegments(sp: SubPath): Cubic[] {
	const out = sp.segs.filter((c) => !cDegenerate(c));
	if (sp.closed && sp.segs.length) {
		const first = sp.segs[0]![0];
		const last = sp.segs[sp.segs.length - 1]![3];
		if (!samePoint(first, last, 1e-9)) out.push(lineCubic(last, first));
	}
	return out;
}

/** Normalises subpaths: closing lines made explicit, degenerate segments and empty subpaths dropped. */
export function normalizePath(p: BezPath): BezPath {
	const out: BezPath = [];
	for (const sp of p) {
		const segs = walkSegments(sp);
		if (segs.length) out.push({ segs, closed: sp.closed });
	}
	return out;
}

/** On-curve vertex count (closing duplicates excluded). */
export function vertexCount(p: BezPath): number {
	let n = 0;
	for (const sp of normalizePath(p)) n += sp.segs.length + (sp.closed ? 0 : 1);
	return n;
}

/** Flattened polylines of a path (closed ones repeat their first point at the end). */
export function flattenPath(p: BezPath, tol: number): { pts: [number, number][]; closed: boolean }[] {
	const out: { pts: [number, number][]; closed: boolean }[] = [];
	for (const sp of p) {
		if (!sp.segs.length) continue;
		const pts: [number, number][] = [[sp.segs[0]![0][0], sp.segs[0]![0][1]]];
		for (const c of walkSegments(sp)) cFlatten(c, tol, pts);
		out.push({ pts, closed: sp.closed });
	}
	return out;
}

/** Winding number of a point against the closed interpretation of every subpath (flattened at `tol`). */
export function windingAt(p: BezPath, pt: P, tol = 0.05): number {
	let w = 0;
	for (const { pts } of flattenPath(p, tol)) {
		const n = pts.length;
		for (let i = 0; i < n; i++) {
			const a = pts[i]!;
			const b = pts[(i + 1) % n]!;
			if (a[1] <= pt[1]) {
				if (b[1] > pt[1] && cross(sub(b, a), sub(pt, a)) > 0) w++;
			} else if (b[1] <= pt[1] && cross(sub(b, a), sub(pt, a)) < 0) w--;
		}
	}
	return w;
}

/** Distance from a point to the nearest point of the path (open interpretation plus closing lines). */
export function distanceTo(p: BezPath, pt: P): number {
	let d2 = Number.POSITIVE_INFINITY;
	for (const sp of p) for (const c of walkSegments(sp)) d2 = Math.min(d2, cNearest(c, pt).d2);
	return Math.sqrt(d2);
}

// ---------------------------------------------------------------- SVG path data

/** Number formatting for SVG path data (enough precision for sub-pixel accuracy, no exponent). */
export function fmt(v: number): string {
	if (!Number.isFinite(v)) return '0';
	const r = Math.round(v * 1000) / 1000;
	return Object.is(r, -0) ? '0' : String(r);
}

/** SVG path data of a compound path (lines as L, curves as C, closed subpaths with Z). */
export function toSvgPath(p: BezPath): string {
	const parts: string[] = [];
	for (const sp of p) {
		if (!sp.segs.length) continue;
		const s = sp.segs[0]![0];
		parts.push(`M${fmt(s[0])} ${fmt(s[1])}`);
		const n = sp.segs.length;
		for (let i = 0; i < n; i++) {
			const c = sp.segs[i]!;
			// The final explicit line back to the start of a closed subpath is implied by Z.
			if (sp.closed && i === n - 1 && isLine(c) && samePoint(c[3], s, 1e-9) && n > 1) continue;
			if (isLine(c)) parts.push(`L${fmt(c[3][0])} ${fmt(c[3][1])}`);
			else
				parts.push(
					`C${fmt(c[1][0])} ${fmt(c[1][1])} ${fmt(c[2][0])} ${fmt(c[2][1])} ${fmt(c[3][0])} ${fmt(c[3][1])}`,
				);
		}
		if (sp.closed) parts.push('Z');
	}
	return parts.join('');
}

/** A subpath from a polyline. */
export function polyline(pts: readonly P[], closed: boolean): SubPath {
	const segs: Cubic[] = [];
	for (let i = 0; i + 1 < pts.length; i++) segs.push(lineCubic(pts[i]!, pts[i + 1]!));
	if (closed && pts.length > 2 && !samePoint(pts[0]!, pts[pts.length - 1]!))
		segs.push(lineCubic(pts[pts.length - 1]!, pts[0]!));
	return { segs, closed };
}

/** Kappa for quarter-circle cubic approximation. */
export const KAPPA = 0.5522847498307936;

/** Circular arc from angle a0 to a1 (radians, any direction) around `c` with radius r, as cubics (≤ 90° each). */
export function arcCubics(c: P, r: number, a0: number, a1: number): Cubic[] {
	const sweep = a1 - a0;
	const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
	const step = sweep / n;
	const k = (4 / 3) * Math.tan(step / 4);
	const out: Cubic[] = [];
	for (let i = 0; i < n; i++) {
		const t0 = a0 + step * i;
		const t1 = t0 + step;
		const p0: P = [c[0] + r * Math.cos(t0), c[1] + r * Math.sin(t0)];
		const p3: P = [c[0] + r * Math.cos(t1), c[1] + r * Math.sin(t1)];
		const p1: P = [p0[0] - k * r * Math.sin(t0), p0[1] + k * r * Math.cos(t0)];
		const p2: P = [p3[0] + k * r * Math.sin(t1), p3[1] - k * r * Math.cos(t1)];
		out.push([p0, p1, p2, p3]);
	}
	return out;
}

export function circlePath(c: P, r: number): SubPath {
	return { segs: arcCubics(c, r, 0, 2 * Math.PI), closed: true };
}
