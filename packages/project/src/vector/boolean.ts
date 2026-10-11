// Curve-preserving boolean operations on filled paths (wp shapes): Merge Paths (Add, Subtract, Intersect, Exclude
// Intersections), Offset Paths and filled-area measurement. The planar arrangement comes from PathBool.js
// (`path-bool`, MIT, © Adam Platkevič), which splits curves at their intersections and keeps them as curves; this
// module chains its output into closed contours and re-joins the pieces that came from one input curve (exactly)
// or one smooth run (least-squares refit within `precision`), so results carry about as few vertices as the inputs.
// The tidy-up follows EffectCraft's `crates/path/src/boolean.rs` (adapted from VectorCraft, MIT OR Apache-2.0).
import { PathBoolean, PathBooleanOperation, FillRule as PBFillRule, type Path as PBPath } from 'path-bool';
import { fitSingle, isStraight, sampleCubic } from './fit.ts';
import {
	type BezPath,
	type Cubic,
	cBounds,
	cDegenerate,
	cEval,
	cNearest,
	cross,
	cSub,
	dot,
	endTangent,
	isLine,
	lineCubic,
	type P,
	pathBounds,
	pathLength,
	type SubPath,
	samePoint,
	signedArea,
	startTangent,
	walkSegments,
} from './geom.ts';

export type FillRule = 'nonzero' | 'evenodd';

/** Refit tolerance (pixels) used to merge split curve pieces back together. */
export const DEFAULT_PRECISION = 0.01;

type PBVec = [number, number];
type PBSeg = ['L', PBVec, PBVec] | ['C', PBVec, PBVec, PBVec, PBVec];

const v = (p: P): PBVec => [p[0], p[1]];

function finitePath(p: BezPath): boolean {
	return p.every((sp) =>
		sp.segs.every((c) => c.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))),
	);
}

/** Every subpath closed (a filled open path is painted as if closed), degenerate pieces dropped. */
function toPB(p: BezPath): PBPath {
	const out: PBSeg[] = [];
	for (const sp of p) {
		const segs = walkSegments({ segs: sp.segs, closed: true });
		if (!segs.length) continue;
		for (const c of segs)
			out.push(isLine(c) ? ['L', v(c[0]), v(c[3])] : ['C', v(c[0]), v(c[1]), v(c[2]), v(c[3])]);
	}
	return out as PBPath;
}

function fromPBSeg(s: PBPath[number]): Cubic | null {
	switch (s[0]) {
		case 'L':
			return lineCubic(s[1] as P, s[2] as P);
		case 'C':
			return [s[1] as P, s[2] as P, s[3] as P, s[4] as P];
		case 'Q': {
			const [, a, q, b] = s as unknown as [string, P, P, P];
			return [
				a,
				[a[0] + ((q[0] - a[0]) * 2) / 3, a[1] + ((q[1] - a[1]) * 2) / 3],
				[b[0] + ((q[0] - b[0]) * 2) / 3, b[1] + ((q[1] - b[1]) * 2) / 3],
				b,
			];
		}
		default:
			return null;
	}
}

/** Chains loose output segments into closed loops (endpoints matched within a tolerance). */
function chain(paths: PBPath[], tol: number): Cubic[][] {
	const pieces: Cubic[][] = [];
	for (const path of paths) {
		let cur: Cubic[] = [];
		for (const s of path) {
			const c = fromPBSeg(s);
			if (!c) continue;
			if (cur.length && !samePoint(cur[cur.length - 1]![3], c[0], tol)) {
				pieces.push(cur);
				cur = [];
			}
			cur.push(c);
		}
		if (cur.length) pieces.push(cur);
	}
	// Join open pieces end to start.
	const loops: Cubic[][] = [];
	const open = pieces.slice();
	while (open.length) {
		let run = open.shift()!;
		let guard = 0;
		while (!samePoint(run[run.length - 1]![3], run[0]![0], tol) && guard++ < 100000) {
			const end = run[run.length - 1]![3];
			const k = open.findIndex((q) => samePoint(q[0]![0], end, tol));
			if (k < 0) break;
			run = run.concat(open.splice(k, 1)[0]!);
		}
		loops.push(run);
	}
	return loops;
}

function eps(paths: BezPath[]): number {
	let m = 0;
	for (const p of paths) {
		const b = pathBounds(p);
		if (b) m = Math.max(m, Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.y0), Math.abs(b.y1));
	}
	return Math.max(1e-7, m * 1e-9);
}

export type Tidy = {
	precision: number;
	/** Input vertices that must survive (only joints the sweep introduced are merged away). */
	keep: P[];
	/** Input curves, to rebuild split pieces exactly. */
	curves: { b: { x0: number; y0: number; x1: number; y1: number }; c: Cubic }[];
};

export function tidyFree(precision = DEFAULT_PRECISION): Tidy {
	return { precision, keep: [], curves: [] };
}

export function tidyKeeping(paths: BezPath[], precision = DEFAULT_PRECISION): Tidy {
	const keep: P[] = [];
	const curves: Tidy['curves'] = [];
	for (const p of paths)
		for (const sp of p)
			for (const c of walkSegments({ segs: sp.segs, closed: true })) {
				keep.push(c[0]);
				if (!isLine(c) && !isStraight(c, 1e-9)) {
					const b = cBounds(c);
					curves.push({ b: { x0: b.x0 - 1e-6, y0: b.y0 - 1e-6, x1: b.x1 + 1e-6, y1: b.y1 + 1e-6 }, c });
				}
			}
	keep.sort((a, b) => a[0] - b[0]);
	return { precision, keep, curves };
}

function isKept(t: Tidy, p: P): boolean {
	const tol = 1e-6 * (1 + Math.max(Math.abs(p[0]), Math.abs(p[1])));
	let lo = 0;
	let hi = t.keep.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (t.keep[mid]![0] < p[0] - tol) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < t.keep.length && t.keep[i]![0] <= p[0] + tol; i++)
		if (Math.abs(t.keep[i]![1] - p[1]) <= tol) return true;
	return false;
}

const lineLike = (c: Cubic) =>
	isLine(c) || isStraight(c, 1e-9 * (1 + Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1])));

function exactMerge(run: Cubic[], t: Tidy): Cubic | null {
	const a = run[0]![0];
	const b = run[run.length - 1]![3];
	const scale = 1 + Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
	const tol = 1e-6 * scale;
	const inside = (r: Tidy['curves'][number]['b'], p: P) =>
		p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
	for (const { b: r, c } of t.curves) {
		if (!inside(r, a) || !inside(r, b)) continue;
		const na = cNearest(c, a);
		const nb = cNearest(c, b);
		if (Math.sqrt(na.d2) > tol || Math.sqrt(nb.d2) > tol) continue;
		if (!run.every((s) => Math.sqrt(cNearest(c, cEval(s, 0.5)).d2) <= tol * 10)) continue;
		if (Math.abs(na.t - nb.t) < 1e-12) continue;
		const s =
			na.t < nb.t
				? cSub(c, na.t, nb.t)
				: (() => {
						const r2 = cSub(c, nb.t, na.t);
						return [r2[3], r2[2], r2[1], r2[0]] as Cubic;
					})();
		return [a, s[1], s[2], b];
	}
	return null;
}

function tryMerge(run: Cubic[], t: Tidy): Cubic | null {
	const first = run[0]!;
	const last = run[run.length - 1]!;
	if (lineLike(first)) {
		const chord: P = [last[3][0] - first[0][0], last[3][1] - first[0][1]];
		const len = Math.hypot(chord[0], chord[1]);
		if (len < 1e-12) return null;
		const ok = run.every(
			(s) =>
				Math.abs(cross([s[3][0] - first[0][0], s[3][1] - first[0][1]], chord) / len) <= t.precision * 0.5,
		);
		return ok ? lineCubic(first[0], last[3]) : null;
	}
	const exact = exactMerge(run, t);
	if (exact) return exact;
	const pts: P[] = [];
	for (const [k, s] of run.entries()) sampleCubic(s, 12, pts, k === 0);
	const { c, err } = fitSingle(pts, startTangent(first), endTangent(last));
	return err > t.precision ? null : c;
}

/** Merges segments of a closed loop that were split from one curve (or collinear lines) back together. */
export function tidySegments(input: Cubic[], t: Tidy): Cubic[] {
	const scale = input.reduce((m, c) => Math.max(m, Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1])), 0);
	const tiny = Math.max(scale * 1e-9, 1e-9);
	const segs = input.filter((c) => {
		const b = cBounds(c);
		return b.x1 - b.x0 + (b.y1 - b.y0) > tiny;
	});
	const n = segs.length;
	if (n < 2) return segs;
	const mergeable = (a: Cubic, b: Cubic) => {
		if (lineLike(a) !== lineLike(b) || isKept(t, b[0])) return false;
		const ta = endTangent(a);
		const tb = startTangent(b);
		return dot(ta, tb) > 0.9998 && Math.abs(cross(ta, tb)) < 0.02;
	};
	// Start at a real corner when there is one.
	let k = 0;
	for (let i = 0; i < n; i++)
		if (!mergeable(segs[(i + n - 1) % n]!, segs[i]!)) {
			k = i;
			break;
		}
	const rot = [...segs.slice(k), ...segs.slice(0, k)];
	const out: Cubic[] = [];
	let i = 0;
	while (i < n) {
		let cur = rot[i]!;
		let j = i + 1;
		while (j < n && mergeable(rot[j - 1]!, rot[j]!)) {
			const m = tryMerge(rot.slice(i, j + 1), t);
			if (!m) break;
			cur = lineLike(rot[i]!) ? lineCubic(m[0], m[3]) : m;
			j++;
		}
		out.push(lineLike(cur) ? lineCubic(cur[0], cur[3]) : cur);
		i = j;
	}
	return out;
}

function isSliver(segs: Cubic[], precision: number): boolean {
	const sp: BezPath = [{ segs, closed: true }];
	const a = Math.abs(signedArea(sp));
	const per = pathLength(sp);
	return per <= 0 || (2 * a) / per < precision;
}

/** Closed loops → one tidy compound path. */
export function loopsToPath(loops: Cubic[][], t: Tidy): BezPath {
	const out: BezPath = [];
	for (const loop of loops) {
		const segs0 = loop.filter((c) => !cDegenerate(c, 1e-12));
		if (!segs0.length || isSliver(segs0, t.precision)) continue;
		const segs = tidySegments(segs0, t);
		if (segs.length < 2 && segs.every(lineLike)) continue;
		// Close exactly.
		const first = segs[0]![0];
		const last = segs[segs.length - 1]!;
		if (!samePoint(last[3], first, 0)) segs[segs.length - 1] = [last[0], last[1], last[2], first];
		out.push({ segs, closed: true } satisfies SubPath);
	}
	return out;
}

export type BoolOp = 'union' | 'difference' | 'intersection' | 'exclusion';

const OPS: Record<BoolOp, PathBooleanOperation> = {
	union: PathBooleanOperation.Union,
	difference: PathBooleanOperation.Difference,
	intersection: PathBooleanOperation.Intersection,
	exclusion: PathBooleanOperation.Exclusion,
};

/** Raw loops of a boolean of N filled inputs (difference: the first minus the others). */
export function booleanLoops(inputs: { path: BezPath; rule: FillRule }[], op: BoolOp): Cubic[][] {
	const nonEmpty = (x: { path: BezPath }) => x.path.some((sp) => sp.segs.length > 0) && finitePath(x.path);
	// Difference keeps the first input's area: nothing when it is empty.
	if (op === 'difference' && !(inputs[0] && nonEmpty(inputs[0]))) return [];
	const usable = inputs.filter(nonEmpty);
	if (!usable.length) return [];
	const pb = usable.map((x) => ({
		path: toPB(x.path),
		fillRule: x.rule === 'evenodd' ? PBFillRule.EvenOdd : PBFillRule.NonZero,
	}));
	if (!pb.some((x) => x.path.length)) return [];
	const tol = eps(usable.map((x) => x.path)) * 100;
	try {
		return chain(new PathBoolean(pb).get(OPS[op]), tol);
	} catch {
		// PathBool.js can trip over a degenerate configuration that depends on the orientation of the input (an edge
		// leaving a vertex exactly along an axis, see patches/path-bool@1.0.4.patch). The arrangement itself is
		// rotation invariant, so retry once in a rotated frame and rotate the result back (round-off ~1e-15 of the
		// extent) rather than silently dropping the shape.
		try {
			const rot = rotator(RETRY_ANGLE);
			const back = rotator(-RETRY_ANGLE);
			const turned = pb.map((x) => ({ ...x, path: x.path.map((s) => mapSeg(s, rot)) as PBPath }));
			const res = new PathBoolean(turned).get(OPS[op]);
			return chain(
				res.map((p) => p.map((s) => mapSeg(s, back)) as PBPath),
				tol,
			);
		} catch {
			return [];
		}
	}
}

/** An angle no input is aligned to in practice (≈ 0.45 rad, irrational in degrees). */
const RETRY_ANGLE = Math.SQRT2 / Math.PI;

function rotator(a: number): (p: PBVec) => PBVec {
	const c = Math.cos(a);
	const s = Math.sin(a);
	return (p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/** Maps the points of an L / C / Q segment (the only kinds we feed in, so the only kinds that come out). */
function mapSeg(s: PBPath[number], f: (p: PBVec) => PBVec): PBPath[number] {
	return (s as readonly unknown[]).map((q) => (Array.isArray(q) ? f(q as PBVec) : q)) as PBPath[number];
}

/** N-ary boolean (inputs in stacking order; difference = the first minus all the others) → one compound path. */
export function booleanOp(
	inputs: { path: BezPath; rule: FillRule }[],
	op: BoolOp,
	precision = DEFAULT_PRECISION,
): BezPath {
	const loops = booleanLoops(inputs, op);
	return loopsToPath(
		loops,
		tidyKeeping(
			inputs.map((x) => x.path),
			precision,
		),
	);
}

/** Resolves self-overlaps of one filled path into simple contours (same coverage under either fill rule). */
export function normalizeFill(p: BezPath, rule: FillRule): BezPath {
	return booleanOp([{ path: p, rule }], 'union');
}

/** Unsigned filled area of a path under a fill rule (overlaps resolved first). */
export function filledArea(p: BezPath, rule: FillRule = 'nonzero'): number {
	const loops = booleanLoops([{ path: p, rule }], 'union');
	let a = 0;
	for (const l of loops) a += signedArea([{ segs: l, closed: true }]);
	return Math.abs(a);
}
