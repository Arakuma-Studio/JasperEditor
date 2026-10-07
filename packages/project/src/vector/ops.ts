// Shape-layer path operators (wp shapes) — After Effects' "Add ▸" path operations. Every operator maps the list of
// paths above it (one entry per shape, in the space of the group it lives in) to a list of the same length, except
// Merge Paths, which combines them into one. Port of EffectCraft's `crates/path/src/ops.rs` (MIT OR Apache-2.0;
// see licenses/ported/shapes.md), plus Wiggle Paths' Spatial Phase, which EffectCraft lacks.
import { booleanOp, type FillRule } from './boolean.ts';
import {
	add,
	type BezPath,
	type Cubic,
	cArclen,
	cEval,
	cInvArclen,
	cross,
	cSub,
	dist,
	dot,
	endTangent,
	isLine,
	lineCubic,
	mul,
	normalizePath,
	type P,
	perp,
	reversePath,
	type SubPath,
	startTangent,
	sub,
	tangentAt,
	unit,
	walkSegments,
} from './geom.ts';
import { type LineJoin, offsetPath } from './offset.ts';

const ACC = 1e-3;

/** Reverses every subpath (the Path Direction toggle). */
export const reverse = (paths: BezPath[]): BezPath[] => paths.map(reversePath);

// ---------------------------------------------------------------- Trim Paths

/** A path measured for trimming: its walked segments (closing lines included) laid end to end. */
class Measured {
	segs: Cubic[];
	lens: number[];
	total: number;
	constructor(p: BezPath) {
		this.segs = [];
		for (const sp of p) this.segs.push(...walkSegments(sp));
		this.lens = this.segs.map((c) => cArclen(c, 0, 1, ACC / 10));
		this.total = this.lens.reduce((a, b) => a + b, 0);
	}
	/**
	 * Appends the part between absolute lengths sa..sb, continuing the current subpath when the piece starts where
	 * `out` ends (e.g. across the start point of a closed path).
	 */
	append(sa: number, sb: number, out: BezPath): void {
		let acc = 0;
		for (let i = 0; i < this.segs.length; i++) {
			const seg = this.segs[i]!;
			const len = this.lens[i]!;
			const s0 = acc;
			const s1 = acc + len;
			acc = s1;
			if (s1 <= sa || s0 >= sb || len <= 0) continue;
			const t0 = sa > s0 ? cInvArclen(seg, sa - s0, len, ACC / 10) : 0;
			const t1 = sb < s1 ? cInvArclen(seg, sb - s0, len, ACC / 10) : 1;
			if (t1 <= t0) continue;
			const piece = cSub(seg, t0, t1);
			const last = out[out.length - 1];
			const end = last?.segs[last.segs.length - 1]?.[3];
			if (last && end && dist(end, piece[0]) <= 1e-6) last.segs.push(piece);
			else out.push({ segs: [piece], closed: false });
		}
	}
}

/** Fractional intervals kept by a trim, or null when nothing is trimmed. */
function trimIntervals(start: number, end: number, offsetDeg: number): [number, number][] | null {
	let s = start / 100;
	let e = end / 100;
	if (s > e) [s, e] = [e, s];
	s = Math.min(1, Math.max(0, s));
	e = Math.min(1, Math.max(0, e));
	if (e - s >= 1 - 1e-9) return null;
	if (e - s <= 1e-9) return [];
	const off = (((offsetDeg / 360) % 1) + 1) % 1;
	const a = s + off;
	const b = e + off;
	if (b <= 1) return [[a, b]];
	if (a >= 1) return [[a - 1, b - 1]];
	return [
		[a, 1],
		[0, b - 1],
	];
}

/**
 * Trim Paths, "Trim Multiple Shapes: Simultaneously": every path is trimmed by the same fractions of its own length.
 * `start`/`end` in percent, `offset` in degrees (360° = one full length). Fully trimmed paths come back empty.
 */
export function trim(paths: BezPath[], start: number, end: number, offsetDeg: number): BezPath[] {
	const iv = trimIntervals(start, end, offsetDeg);
	if (!iv) return paths;
	return paths.map((p) => {
		const m = new Measured(p);
		const out: BezPath = [];
		if (m.total > 0) for (const [a, b] of iv) m.append(a * m.total, b * m.total, out);
		return out;
	});
}

/**
 * Trim Paths, "Trim Multiple Shapes: Individually": the paths are laid end to end in stacking order and trimmed as
 * one continuous length, so they draw on one after another.
 */
export function trimIndividually(paths: BezPath[], start: number, end: number, offsetDeg: number): BezPath[] {
	const iv = trimIntervals(start, end, offsetDeg);
	if (!iv) return paths;
	const ms = paths.map((p) => new Measured(p));
	const total = ms.reduce((a, m) => a + m.total, 0);
	let base = 0;
	return ms.map((m) => {
		const out: BezPath = [];
		for (const [a, b] of iv) {
			const la = Math.max(0, a * total - base);
			const lb = Math.min(m.total, b * total - base);
			if (lb > la) m.append(la, lb, out);
		}
		base += m.total;
		return out;
	});
}

// ---------------------------------------------------------------- Pucker & Bloat

/**
 * Pucker & Bloat (`amount` −100…100 %). Positive (bloat) moves the vertices towards the path's centre (the mean of
 * its vertices) and pushes the handles away from it, so segments bulge outwards; negative (pucker) does the
 * opposite, giving spiky shapes.
 */
export function puckerBloat(paths: BezPath[], amount: number): BezPath[] {
	const a = amount / 100;
	if (a === 0 || !Number.isFinite(a)) return paths;
	return paths.map((p) => {
		const norm = normalizePath(p);
		const verts: P[] = [];
		for (const sp of norm) {
			verts.push(sp.segs[0]![0]);
			for (let i = 0; i < sp.segs.length - (sp.closed ? 1 : 0); i++) verts.push(sp.segs[i]![3]);
		}
		if (!verts.length) return p;
		const c: P = [
			verts.reduce((s, q) => s + q[0], 0) / verts.length,
			verts.reduce((s, q) => s + q[1], 0) / verts.length,
		];
		const mv = (q: P): P => [q[0] + (c[0] - q[0]) * a, q[1] + (c[1] - q[1]) * a];
		const mvh = (q: P): P => [q[0] + (q[0] - c[0]) * a, q[1] + (q[1] - c[1]) * a];
		return norm.map((sp) => ({
			closed: sp.closed,
			segs: sp.segs.map(
				(s) => [mv(s[0]), mvh(isLine(s) ? s[0] : s[1]), mvh(isLine(s) ? s[3] : s[2]), mv(s[3])] as Cubic,
			),
		}));
	});
}

// ---------------------------------------------------------------- Round Corners

/**
 * Round Corners: every corner vertex (a tangent discontinuity) is replaced by a circular arc that starts and ends
 * `radius` along the adjacent segments (clamped to half of each segment). Smooth vertices and open ends are kept.
 */
export function roundCorners(paths: BezPath[], radius: number): BezPath[] {
	if (!(radius > 0) || !Number.isFinite(radius)) return paths;
	return paths.map((p) => normalizePath(p).map((sp) => roundSub(sp, radius)));
}

function roundSub(sp: SubPath, r: number): SubPath {
	const segs = sp.segs;
	const n = segs.length;
	const lens = segs.map((c) => cArclen(c, 0, 1, ACC / 10));
	const cut = new Array<number>(n).fill(0);
	const phi = new Array<number>(n).fill(0);
	for (let i = 0; i < n; i++) {
		if (!sp.closed && i === 0) continue;
		const prev = (i + n - 1) % n;
		const tin = endTangent(segs[prev]!);
		const tout = startTangent(segs[i]!);
		const turn = Math.abs(Math.atan2(cross(tin, tout), dot(tin, tout)));
		if (!(turn >= 1e-3 && turn <= Math.PI - 1e-3)) continue;
		cut[i] = Math.min(r, lens[prev]! / 2, lens[i]! / 2);
		phi[i] = turn;
	}
	type T = { c: Cubic; t0: P; t1: P };
	const trimmed: T[] = segs.map((c, j) => {
		const a = cut[j]!;
		const b = sp.closed || j + 1 < n ? cut[(j + 1) % n]! : 0;
		if (a <= 0 && b <= 0) return { c, t0: startTangent(c), t1: endTangent(c) };
		const ta = a > 0 ? cInvArclen(c, a, lens[j]!, ACC / 10) : 0;
		const tb = Math.max(ta, b > 0 ? cInvArclen(c, Math.max(0, lens[j]! - b), lens[j]!, ACC / 10) : 1);
		return { c: cSub(c, ta, tb), t0: tangentAt(c, ta), t1: tangentAt(c, tb) };
	});
	const out: Cubic[] = [];
	const arc = (from: T, to: T, corner: P, ph: number) => {
		const p = from.c[3];
		const q = to.c[0];
		// Circular arc through the two tangent points: handle = 4/3·tan(φ/4)·R with R = d / tan(φ/2).
		const k = ((4 / 3) * Math.tan(ph / 4)) / Math.tan(ph / 2);
		const hp = dist(p, corner) * k;
		const hq = dist(q, corner) * k;
		out.push([p, add(p, mul(from.t1, hp)), sub(q, mul(to.t0, hq)), q]);
	};
	const piece = (t: T) => {
		if (dist(t.c[0], t.c[3]) > 1e-9 || !isLine(t.c)) out.push(t.c);
	};
	piece(trimmed[0]!);
	for (let j = 1; j < n; j++) {
		if (cut[j]! > 0) arc(trimmed[j - 1]!, trimmed[j]!, segs[j]![0], phi[j]!);
		piece(trimmed[j]!);
	}
	if (sp.closed && cut[0]! > 0) arc(trimmed[n - 1]!, trimmed[0]!, segs[0]![0], phi[0]!);
	return { segs: out, closed: sp.closed };
}

// ---------------------------------------------------------------- Offset Paths

/**
 * Offset Paths: grows (positive `amount`) or shrinks every path with the given line join. `copies` copies are made,
 * copy i (0-based) offset by amount·(i + 1 + copyOffset), all returned in the same compound path.
 */
export function offset(
	paths: BezPath[],
	amount: number,
	join: LineJoin,
	miterLimit: number,
	copies: number,
	copyOffset: number,
): BezPath[] {
	const n = Math.round(Math.min(1000, Math.max(1, Number.isFinite(copies) ? copies : 1)));
	return paths.map((p) => {
		const out: BezPath = [];
		for (let i = 0; i < n; i++) out.push(...offsetPath(p, amount * (i + 1 + copyOffset), join, miterLimit));
		return out;
	});
}

// ---------------------------------------------------------------- Twist

/**
 * Twist: rotates the paths about `center` by an angle growing linearly with the distance from the centre, from 0
 * at the centre to `angleDeg` at the farthest point. Segments are subdivided and their handles mapped through the
 * exact derivative of the warp, which keeps the result smooth.
 */
export function twist(paths: BezPath[], angleDeg: number, center: P): BezPath[] {
	let rmax = 0;
	for (const p of paths)
		for (const sp of p)
			for (const c of sp.segs) rmax = Math.max(rmax, dist(c[0], center), dist(c[3], center));
	const a = (angleDeg * Math.PI) / 180;
	if (a === 0 || rmax <= 1e-9 || !Number.isFinite(a)) return paths;
	const k = a / rmax;
	const rot = (v: P, th: number): P => {
		const s = Math.sin(th);
		const co = Math.cos(th);
		return [v[0] * co - v[1] * s, v[0] * s + v[1] * co];
	};
	const map = (p: P): P => {
		const v = sub(p, center);
		return add(center, rot(v, k * Math.hypot(v[0], v[1])));
	};
	const jac = (p: P, dv: P): P => {
		const v = sub(p, center);
		const r = Math.hypot(v[0], v[1]);
		let w: P = dv;
		if (r > 1e-12) w = add(w, mul(perp(v), (k * dot(v, dv)) / r));
		return rot(w, k * r);
	};
	return paths.map((p) =>
		normalizePath(p).map((sp) => {
			const segs: Cubic[] = [];
			for (const seg of sp.segs) {
				const len = cArclen(seg, 0, 1, ACC);
				const m = Math.min(64, Math.max(1, Math.ceil((Math.abs(a) * len) / rmax / 0.15 + len / 50)));
				for (let i = 0; i < m; i++) {
					const q = cSub(seg, i / m, (i + 1) / m);
					const p0 = map(q[0]);
					const p3 = map(q[3]);
					segs.push([p0, add(p0, jac(q[0], sub(q[1], q[0]))), add(p3, jac(q[3], sub(q[2], q[3]))), p3]);
				}
			}
			return { segs, closed: sp.closed };
		}),
	);
}

// ---------------------------------------------------------------- resampling (Zig Zag, Wiggle Paths)

type Sample = { p: P; tan: P; lenPrev: number; lenNext: number };

/**
 * Splits every segment into `m` pieces of equal arc length. Original vertices get the average of their incoming
 * and outgoing tangents (so a corner's normal is its bisector).
 */
function resample(sp: SubPath, m: number): Sample[] {
	const segs = sp.segs;
	const n = segs.length;
	const lens = segs.map((c) => cArclen(c, 0, 1, ACC));
	const out: Sample[] = [];
	for (let j = 0; j < n; j++) {
		const piece = lens[j]! / m;
		for (let k = 0; k < m; k++) {
			if (k === 0) {
				const tout = startTangent(segs[j]!);
				const prev = sp.closed || j > 0 ? (j + n - 1) % n : null;
				const tan = prev === null ? tout : (unit(add(endTangent(segs[prev]!), tout)) ?? tout);
				out.push({ p: segs[j]![0], tan, lenPrev: prev === null ? 0 : lens[prev]! / m, lenNext: piece });
			} else {
				const t = cInvArclen(segs[j]!, piece * k, lens[j]!, ACC);
				out.push({ p: cEval(segs[j]!, t), tan: tangentAt(segs[j]!, t), lenPrev: piece, lenNext: piece });
			}
		}
	}
	if (!sp.closed) {
		const last = segs[n - 1]!;
		out.push({ p: last[3], tan: endTangent(last), lenPrev: lens[n - 1]! / m, lenNext: 0 });
	}
	return out;
}

/** Emits displaced samples as corner (polyline) or smooth (tangent-aligned cubic) points. */
function emit(samples: Sample[], disp: P[], closed: boolean, smooth: boolean, handle: number): SubPath {
	const n = samples.length;
	const pt = (i: number) => add(samples[i]!.p, disp[i]!);
	const segs: Cubic[] = [];
	const count = closed ? n : n - 1;
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % n;
		if (smooth) {
			const a = samples[i]!;
			const b = samples[j]!;
			segs.push([
				pt(i),
				add(pt(i), mul(a.tan, a.lenNext * handle)),
				sub(pt(j), mul(b.tan, b.lenPrev * handle)),
				pt(j),
			]);
		} else segs.push(lineCubic(pt(i), pt(j)));
	}
	return { segs, closed };
}

/**
 * Zig Zag: each segment gets `ridges` ridges — it is split into ridges + 1 equal pieces and the points (original
 * vertices included) are pushed alternately `size` to either side. `smooth` makes rounded waves.
 */
export function zigzag(paths: BezPath[], size: number, ridges: number, smooth: boolean): BezPath[] {
	const m = Math.round(Math.min(1000, Math.max(0, Number.isFinite(ridges) ? ridges : 0))) + 1;
	return paths.map((p) =>
		normalizePath(p).map((sp) => {
			const s = resample(sp, m);
			const disp = s.map((x, i) => mul(perp(x.tan), i % 2 === 0 ? size : -size));
			return emit(s, disp, sp.closed, smooth, 0.36);
		}),
	);
}

export type WiggleParams = {
	/** Maximum displacement (px). */
	size: number;
	/** Subdivisions per segment. */
	detail: number;
	smooth: boolean;
	/** Wiggles per second. */
	speed: number;
	/** 0…100 %: how much neighbouring points move together. */
	correlation: number;
	/** Degrees (360° = one wiggle period). */
	temporalPhase: number;
	/** Degrees (360° shifts the pattern by one point along the path). */
	spatialPhase: number;
	seed: number;
};

export const DEFAULT_WIGGLE: WiggleParams = {
	size: 10,
	detail: 10,
	smooth: true,
	speed: 2,
	correlation: 50,
	temporalPhase: 0,
	spatialPhase: 0,
	seed: 0,
};

/** Deterministic 32-bit integer hash (lowbias32 by Chris Wellons, public domain) → [−1, 1]. */
function hash3(seed: number, idx: number, t: number): number {
	let h = (seed | 0) ^ Math.imul(idx | 0, 0x9e3779b1) ^ Math.imul(t | 0, 0x85ebca77);
	h ^= h >>> 16;
	h = Math.imul(h, 0x7feb352d);
	h ^= h >>> 15;
	h = Math.imul(h, 0x846ca68b);
	h ^= h >>> 16;
	return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Catmull-Rom through four lattice values (C1-continuous). */
function cr(p0: number, p1: number, p2: number, p3: number, f: number): number {
	return (
		0.5 *
		(2 * p1 +
			(-p0 + p2) * f +
			(2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
			(-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
	);
}

/** Smooth 1D value noise in [−1, 1]. */
function noise1(seed: number, idx: number, t: number): number {
	const i = Math.floor(t);
	const f = t - i;
	return Math.min(
		1,
		Math.max(
			-1,
			cr(hash3(seed, idx, i - 1), hash3(seed, idx, i), hash3(seed, idx, i + 1), hash3(seed, idx, i + 2), f),
		),
	);
}

/** Point noise smooth in both the point index u (spatial) and time t. */
function noise2(seed: number, channel: number, u: number, t: number): number {
	const i = Math.floor(u);
	const f = u - i;
	const at = (k: number) => noise1(seed, channel + 2 * k, t + k * 0.37 + channel * 0.61);
	if (f === 0) return at(i);
	return Math.min(1, Math.max(-1, cr(at(i - 1), at(i), at(i + 1), at(i + 2), f)));
}

/**
 * Wiggle Paths: subdivides the paths (`detail` points per segment) and displaces every point by smooth random noise
 * of up to `size` pixels that evolves over `timeS` seconds at `speed` wiggles per second. Deterministic for a given
 * seed and time.
 */
export function wiggle(paths: BezPath[], w: WiggleParams, timeS: number): BezPath[] {
	if (w.size === 0 || !Number.isFinite(w.size)) return paths;
	const m = Math.round(Math.min(1000, Math.max(0, Number.isFinite(w.detail) ? w.detail : 0))) + 1;
	const seed = Math.round(w.seed) | 0;
	const t = timeS * w.speed + w.temporalPhase / 360;
	const corr = Math.min(1, Math.max(0, w.correlation / 100));
	const shared: P = [noise1(seed, -1, t), noise1(seed, -2, t)];
	const shift = w.spatialPhase / 360;
	let idx = 0;
	return paths.map((p) =>
		normalizePath(p).map((sp) => {
			const s = resample(sp, m);
			const disp = s.map(() => {
				const u = idx + shift;
				const own: P = [noise2(seed, 0, u, t), noise2(seed, 1, u, t)];
				idx++;
				return mul(add(mul(shared, corr), mul(own, 1 - corr)), w.size);
			});
			return emit(s, disp, sp.closed, w.smooth, 1 / 3);
		}),
	);
}

// ---------------------------------------------------------------- Merge Paths

export type MergeMode = 'merge' | 'add' | 'subtract' | 'intersect' | 'exclude';

/**
 * Merge Paths: combines the paths (in stacking order, each filled non-zero) into one path. Merge = one compound
 * path; Add = union; Subtract = the first (topmost) path minus all the others; Intersect = area covered by every
 * path; Exclude Intersections = area covered by an odd number of paths.
 */
export function merge(paths: BezPath[], mode: MergeMode): BezPath {
	if (mode === 'merge') return paths.flat();
	const inputs = paths
		.filter((p) => p.some((sp) => sp.segs.length > 0))
		.map((path) => ({ path, rule: 'nonzero' as FillRule }));
	if (!inputs.length) return [];
	if (mode === 'subtract' && !paths[0]?.some((sp) => sp.segs.length)) return [];
	switch (mode) {
		case 'add':
			return booleanOp(inputs, 'union');
		case 'subtract':
			return booleanOp(inputs, 'difference');
		case 'intersect':
			return inputs.length === 1 ? booleanOp(inputs, 'union') : booleanOp(inputs, 'intersection');
		case 'exclude':
			return booleanOp(inputs, 'exclusion');
	}
}
