// Offset Paths (wp shapes): grows or shrinks the filled region of a path by a distance with true curve offsetting
// (each cubic's offset is least-squares fitted and subdivided until within tolerance) and robust overlap removal
// (the boolean sweep). Closed subpaths are treated as a filled region; open subpaths are outlined with a band of
// width 2·|delta| (butt ends). Structure after EffectCraft's `crates/path/src/offset.rs` (adapted from VectorCraft,
// MIT OR Apache-2.0): ring = everything within |delta| of the outline; grow = region ∪ ring, shrink = region − ring;
// then holes (when growing) / islands (when shrinking) that lie entirely within |delta| of the path are dropped
// (they appear where the offset distance exceeds a curvature radius).
import { booleanLoops, type FillRule, loopsToPath, tidyFree } from './boolean.ts';
import {
	add,
	arcCubics,
	type BezPath,
	type Cubic,
	cEval,
	cross,
	distanceTo,
	dot,
	endTangent,
	flattenPath,
	isLine,
	lineCubic,
	mul,
	type P,
	perp,
	signedArea,
	startTangent,
	type SubPath,
	sub,
	tangentAt,
	walkSegments,
	windingAt,
} from './geom.ts';
import { fitSingle } from './fit.ts';

export type LineJoin = 'miter' | 'round' | 'bevel';
export type LineCap = 'butt' | 'round' | 'square';

/** Offset point of a cubic at t on side d (positive = left normal). */
const offsetAt = (c: Cubic, t: number, d: number): P => add(cEval(c, t), mul(perp(tangentAt(c, t)), d));

/** Cubics approximating the offset of `c` by `d` (fit tolerance `tol`). */
export function offsetCubic(c: Cubic, d: number, tol: number, depth = 0): Cubic[] {
	if (isLine(c)) {
		const n = perp(startTangent(c));
		return [lineCubic(add(c[0], mul(n, d)), add(c[3], mul(n, d)))];
	}
	const pts: P[] = [];
	for (let i = 0; i <= 16; i++) pts.push(offsetAt(c, i / 16, d));
	const { c: fit, err } = fitSingle(pts, startTangent(c), endTangent(c));
	// Check midpoints between the samples too.
	let e = err;
	if (e <= tol) {
		for (let i = 0; i < 16; i++) {
			const t = (i + 0.5) / 16;
			const want = offsetAt(c, t, d);
			let best = Number.POSITIVE_INFINITY;
			for (let k = 0; k <= 32; k++) {
				const q = cEval(fit, k / 32);
				best = Math.min(best, Math.hypot(q[0] - want[0], q[1] - want[1]));
			}
			e = Math.max(e, best);
		}
	}
	if (e <= tol * 2 || depth >= 7) return [fit];
	const h = 0.5;
	const left: Cubic = subCubic(c, 0, h);
	const right: Cubic = subCubic(c, h, 1);
	return [...offsetCubic(left, d, tol, depth + 1), ...offsetCubic(right, d, tol, depth + 1)];
}

function subCubic(c: Cubic, t0: number, t1: number): Cubic {
	// Local de Casteljau to avoid an import cycle on cSub's line shortcut (curves only here).
	const split = (q: Cubic, t: number): [Cubic, Cubic] => {
		const l = (a: P, b: P): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
		const ab = l(q[0], q[1]);
		const bc = l(q[1], q[2]);
		const cd = l(q[2], q[3]);
		const abc = l(ab, bc);
		const bcd = l(bc, cd);
		const m = l(abc, bcd);
		return [
			[q[0], ab, abc, m],
			[m, bcd, cd, q[3]],
		];
	};
	let r = c;
	if (t1 < 1) r = split(r, t1)[0];
	if (t0 > 0) r = split(r, t0 / t1)[1];
	return r;
}

/** True when the offset of `c` by `d` runs backwards somewhere (radius of curvature < |d| on that side). */
function reverses(c: Cubic, d: number): boolean {
	if (isLine(c)) return false;
	let prev = offsetAt(c, 0, d);
	for (let i = 1; i <= 24; i++) {
		const t = i / 24;
		const q = offsetAt(c, t, d);
		if (dot(sub(q, prev), tangentAt(c, (i - 0.5) / 24)) < 0) return true;
		prev = q;
	}
	return false;
}

function orientPositive(segs: Cubic[]): Cubic[] {
	const a = signedArea([{ segs, closed: true }]);
	return a < 0 ? segs.map((c) => [c[3], c[2], c[1], c[0]] as Cubic).reverse() : segs;
}

/** The band of one segment between its two offsets (closed, positively wound). */
function band(c: Cubic, d: number, tol: number): Cubic[] {
	const left = offsetCubic(c, d, tol);
	const right = offsetCubic(c, -d, tol)
		.map((q) => [q[3], q[2], q[1], q[0]] as Cubic)
		.reverse();
	const segs: Cubic[] = [...left];
	segs.push(lineCubic(left[left.length - 1]![3], right[0]![0]), ...right);
	segs.push(lineCubic(right[right.length - 1]![3], left[0]![0]));
	return orientPositive(segs);
}

/** The join wedge on the outer side of a corner at `v` (incoming tangent tin, outgoing tout). */
function joinWedge(v: P, tin: P, tout: P, d: number, join: LineJoin, miterLimit: number): Cubic[] | null {
	const turn = Math.atan2(cross(tin, tout), dot(tin, tout));
	if (Math.abs(turn) < 1e-6) return null;
	const s = turn > 0 ? -1 : 1;
	const a = add(v, mul(perp(tin), s * d));
	const b = add(v, mul(perp(tout), s * d));
	let segs: Cubic[];
	if (join === 'round') {
		const a0 = Math.atan2(a[1] - v[1], a[0] - v[0]);
		let a1 = Math.atan2(b[1] - v[1], b[0] - v[0]);
		// The short way round, in the direction of the turn's outer side.
		while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
		while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
		segs = [lineCubic(v, a), ...arcCubics(v, d, a0, a1), lineCubic(b, v)];
	} else {
		const ratio = 1 / Math.max(1e-9, Math.cos(turn / 2));
		if (join === 'miter' && ratio <= Math.max(1, miterLimit)) {
			const bis = perp(add(tin, tout));
			const bl = Math.hypot(bis[0], bis[1]);
			const m = bl > 1e-12 ? add(v, mul(bis, (s * d * ratio) / bl)) : a;
			segs = [lineCubic(v, a), lineCubic(a, m), lineCubic(m, b), lineCubic(b, v)];
		} else segs = [lineCubic(v, a), lineCubic(a, b), lineCubic(b, v)];
	}
	return orientPositive(segs);
}

/** Everything within d of a subpath: simple positive pieces in one list, self-crossing bands apart. */
function ringParts(sp: SubPath, d: number, join: LineJoin, miterLimit: number, tol: number) {
	const simple: SubPath[] = [];
	const complex: SubPath[] = [];
	const segs = walkSegments(sp);
	const n = segs.length;
	for (const c of segs) {
		const b = band(c, d, tol);
		if (reverses(c, d) || reverses(c, -d)) complex.push({ segs: b, closed: true });
		else simple.push({ segs: b, closed: true });
	}
	for (let i = 0; i < n; i++) {
		if (!sp.closed && i === 0) continue;
		const prev = segs[(i + n - 1) % n]!;
		const w = joinWedge(segs[i]![0], endTangent(prev), startTangent(segs[i]!), d, join, miterLimit);
		if (w) simple.push({ segs: w, closed: true });
	}
	return { simple, complex };
}

/** A point well inside a closed contour: the midpoint of the widest span on a few horizontal lines. */
function deepPoint(segs: Cubic[]): P | null {
	const poly = flattenPath([{ segs, closed: true }], 0.05)[0];
	if (!poly) return null;
	let x0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const p of poly.pts) {
		x0 = Math.min(x0, p[0]);
		x1 = Math.max(x1, p[0]);
		y0 = Math.min(y0, p[1]);
		y1 = Math.max(y1, p[1]);
	}
	if (!(x1 > x0 && y1 > y0)) return null;
	let best: { span: number; p: P } | null = null;
	for (const f of [0.5, 0.3, 0.7]) {
		const y = y0 + (y1 - y0) * f;
		const xs: number[] = [];
		const pts = poly.pts;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i]!;
			const b = pts[(i + 1) % pts.length]!;
			if (a[1] <= y !== b[1] <= y) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
		}
		xs.sort((p, q) => p - q);
		for (let i = 0; i + 1 < xs.length; i += 2) {
			const span = xs[i + 1]! - xs[i]!;
			if (!best || span > best.span) best = { span, p: [(xs[i]! + xs[i + 1]!) / 2, y] };
		}
	}
	return best?.p ?? null;
}

/**
 * Offsets a path by `delta`: positive grows the (non-zero) filled region, negative insets it. Returns a clean compound
 * path of closed contours.
 */
export function offsetPath(path: BezPath, delta: number, join: LineJoin, miterLimit: number): BezPath {
	if (!Number.isFinite(delta) || !path.some((sp) => sp.segs.length)) return [];
	if (delta === 0) return path;
	const d = Math.abs(delta);
	const tol = Math.max(0.005, d * 1e-4);
	const closed = path.filter((sp) => sp.closed && sp.segs.length);
	const open = path.filter((sp) => !sp.closed && sp.segs.length);
	const ringSimple: SubPath[] = [];
	const ringComplex: SubPath[] = [];
	for (const sp of closed) {
		const r = ringParts(sp, d, join, miterLimit, tol);
		ringSimple.push(...r.simple);
		ringComplex.push(...r.complex);
	}
	const openSimple: SubPath[] = [];
	const openComplex: SubPath[] = [];
	for (const sp of open) {
		const r = ringParts(sp, d, join, miterLimit, tol);
		openSimple.push(...r.simple);
		openComplex.push(...r.complex);
	}
	const nz = (p: BezPath) => ({ path: p, rule: 'nonzero' as FillRule });
	const ringInputs = [
		...(ringSimple.length ? [nz(ringSimple)] : []),
		...ringComplex.map((sp) => nz([sp])),
	];
	const openInputs = [...(openSimple.length ? [nz(openSimple)] : []), ...openComplex.map((sp) => nz([sp]))];
	let loops: Cubic[][];
	if (delta > 0) {
		loops = booleanLoops([...(closed.length ? [nz(closed)] : []), ...ringInputs, ...openInputs], 'union');
	} else {
		loops = closed.length ? booleanLoops([nz(closed), ...ringInputs], 'difference') : [];
		if (openInputs.length) {
			const shrunk: BezPath = loops.map((segs) => ({ segs, closed: true }));
			loops = booleanLoops([...(shrunk.length ? [nz(shrunk)] : []), ...openInputs], 'union');
		}
	}
	// Spurious contours: holes when growing, islands when insetting, lying within d of the path.
	const areas = loops.map((l) => signedArea([{ segs: l, closed: true }]));
	let outerSign = 0;
	let big = 0;
	areas.forEach((a) => {
		if (Math.abs(a) > big) {
			big = Math.abs(a);
			outerSign = Math.sign(a);
		}
	});
	const contains = (outer: Cubic[], inner: Cubic[]) => {
		const p = deepPoint(inner) ?? inner[0]![0];
		return windingAt([{ segs: outer, closed: true }], p) !== 0;
	};
	const parent = loops.map((l, i) => {
		let best = -1;
		for (let j = 0; j < loops.length; j++) {
			if (j === i || Math.abs(areas[j]!) <= Math.abs(areas[i]!)) continue;
			if (contains(loops[j]!, l) && (best < 0 || Math.abs(areas[j]!) < Math.abs(areas[best]!))) best = j;
		}
		return best;
	});
	const isOuter = (i: number) => Math.sign(areas[i]!) === outerSign;
	const spurious = loops.map((l, i) => {
		if (isOuter(i) !== delta < 0) return false;
		const p = deepPoint(l);
		return !!p && distanceTo(path, p) < d * (1 - 1e-4) - 1e-6;
	});
	const marked = (i: number): boolean => {
		for (let k = i, guard = 0; k >= 0 && guard < 1000; k = parent[k]!, guard++) if (spurious[k]) return true;
		return false;
	};
	const keep = loops.filter((_, i) => !marked(i));
	return loopsToPath(keep, tidyFree());
}

