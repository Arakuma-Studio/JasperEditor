// Auto-trace (port of effectcraft `crates/path/src/trace.rs` + `fit.rs`, MIT OR Apache-2.0; see
// licenses/ported/masks.md): outlines of a scalar field (a layer's alpha, luminance or a matte) as Bézier paths.
//
// 1. Marching squares over the samples at pixel centres, with linear interpolation of the threshold crossing on each
//    cell edge (saddles resolved by the cell mean), on a field padded with "outside" so every contour closes.
// 2. Douglas–Peucker simplification of each closed loop to the tolerance (pixels).
// 3. Bézier fitting: each simplified span is fitted with one cubic (least squares with fixed end tangents and Newton
//    reparameterisation, Graphics Gems "An Algorithm for Automatically Fitting Digitized Curves", Schneider 1990).
//    The tangent at each vertex is the chord direction at corner roundness 0 and the smooth (Catmull–Rom) direction
//    at 1, blended between.
// Loops smaller than the minimum area are dropped. Each loop carries its nesting depth (0 = outermost; odd = hole),
// so callers can add outer outlines and subtract holes.
//
// Pure function of the field — the `roto` workstream converts mattes to masks with it.
import { type BezierPath, type PathPoint, polygonPath, polygonSignedArea } from './model.ts';

export type TraceOptions = {
	/** Inside where the field is ≥ this (0…1). */
	threshold: number;
	/** Douglas–Peucker tolerance, pixels. */
	tolerance: number;
	/** Loops with a smaller area (pixels²) are dropped. */
	minArea: number;
	/** 0 = polygons, 1 = fully smooth. */
	cornerRoundness: number;
};

export const DEFAULT_TRACE_OPTIONS: TraceOptions = { threshold: 0.5, tolerance: 1, minArea: 10, cornerRoundness: 0.5 };

export type TracedPath = {
	/** Closed path in pixel coordinates of the field (x right, y down; pixel (x, y) covers [x, x+1)×[y, y+1)). */
	path: BezierPath;
	/** How many other outlines contain this one (even = filled region, odd = hole). */
	depth: number;
	/** Signed area of the simplified polygon (pixels², > 0 clockwise on screen). */
	area: number;
};

/** Traces `field` (`w × h`, row-major, sample (x, y) at pixel centre (x + 0.5, y + 0.5)). */
export function tracePaths(
	field: ArrayLike<number>,
	w: number,
	h: number,
	opts: Partial<TraceOptions> = {},
): TracedPath[] {
	const o = { ...DEFAULT_TRACE_OPTIONS, ...opts };
	if (w <= 0 || h <= 0 || field.length < w * h) return [];
	const loops = contours(field, w, h, o.threshold);
	const polys: { raw: PathPoint[]; simp: PathPoint[]; area: number }[] = [];
	for (const raw of loops) {
		const a = polygonSignedArea(raw);
		if (Math.abs(a) < Math.max(0, o.minArea) || raw.length < 3) continue;
		const simp = simplifyClosed(raw, Math.max(0.01, o.tolerance));
		if (simp.length < 3) continue;
		polys.push({ raw, simp, area: a });
	}
	const depths = polys.map((pi, i) => {
		const p = pi.simp[0]!;
		let d = 0;
		polys.forEach((pj, j) => {
			if (j !== i && Math.abs(pj.area) > Math.abs(pi.area) && pointInPolygon(p, pj.simp)) d++;
		});
		return d;
	});
	const round = Math.min(1, Math.max(0, o.cornerRoundness));
	const out = polys.map(
		(pp, i): TracedPath => ({ path: fitLoop(pp.raw, pp.simp, round), depth: depths[i]!, area: pp.area }),
	);
	// Outer outlines first, then holes, islands…; larger first within a depth.
	out.sort((a, b) => a.depth - b.depth || Math.abs(b.area) - Math.abs(a.area));
	return out;
}

/** Marching squares: closed polylines (pixel coordinates). */
function contours(field: ArrayLike<number>, w: number, h: number, thr: number): PathPoint[][] {
	const gw = w + 2;
	const gh = h + 2;
	const val = (i: number, j: number): number =>
		i === 0 || j === 0 || i > w || j > h ? Number.NEGATIVE_INFINITY : (field[(j - 1) * w + (i - 1)] as number);
	const inside = (i: number, j: number) => val(i, j) >= thr;
	const pos = (i: number, j: number): PathPoint => [i - 0.5, j - 0.5];
	const cross = (a: [number, number], b: [number, number]): PathPoint => {
		const va = val(a[0], a[1]);
		const vb = val(b[0], b[1]);
		let t: number;
		if (Number.isFinite(va) && Number.isFinite(vb) && Math.abs(vb - va) > 1e-12)
			t = Math.min(1, Math.max(0, (thr - va) / (vb - va)));
		else if (Number.isFinite(va)) t = va >= thr ? 0.5 : 0;
		else t = vb >= thr ? 0.5 : 1;
		const pa = pos(a[0], a[1]);
		const pb = pos(b[0], b[1]);
		return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
	};
	const hid = (i: number, j: number) => 2 * (j * gw + i);
	const vid = (i: number, j: number) => 2 * (j * gw + i) + 1;
	const next = new Map<number, number>();
	const point = new Map<number, PathPoint>();
	for (let j = 0; j < gh - 1; j++) {
		for (let i = 0; i < gw - 1; i++) {
			const tl = inside(i, j);
			const tr = inside(i + 1, j);
			const br = inside(i + 1, j + 1);
			const bl = inside(i, j + 1);
			const code = (+tl << 3) | (+tr << 2) | (+br << 1) | +bl;
			if (code === 0 || code === 15) continue;
			const top = hid(i, j);
			const bottom = hid(i, j + 1);
			const left = vid(i, j);
			const right = vid(i + 1, j);
			const seg = (a: number, b: number) => next.set(a, b);
			const centre = () => (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4;
			switch (code) {
				case 1:
					seg(left, bottom);
					break;
				case 2:
					seg(bottom, right);
					break;
				case 3:
					seg(left, right);
					break;
				case 4:
					seg(right, top);
					break;
				case 5:
					if (centre() >= thr) {
						seg(left, top);
						seg(right, bottom);
					} else {
						seg(left, bottom);
						seg(right, top);
					}
					break;
				case 6:
					seg(bottom, top);
					break;
				case 7:
					seg(left, top);
					break;
				case 8:
					seg(top, left);
					break;
				case 9:
					seg(top, bottom);
					break;
				case 10:
					if (centre() >= thr) {
						seg(top, right);
						seg(bottom, left);
					} else {
						seg(top, left);
						seg(bottom, right);
					}
					break;
				case 11:
					seg(top, right);
					break;
				case 12:
					seg(right, left);
					break;
				case 13:
					seg(right, bottom);
					break;
				case 14:
					seg(bottom, left);
					break;
			}
			const edges: [number, [number, number], [number, number]][] = [
				[top, [i, j], [i + 1, j]],
				[bottom, [i, j + 1], [i + 1, j + 1]],
				[left, [i, j], [i, j + 1]],
				[right, [i + 1, j], [i + 1, j + 1]],
			];
			for (const [e, a, b] of edges)
				if (inside(a[0], a[1]) !== inside(b[0], b[1]) && !point.has(e)) point.set(e, cross(a, b));
		}
	}
	const out: PathPoint[][] = [];
	const keys = [...next.keys()].sort((a, b) => a - b);
	for (const start of keys) {
		if (!next.has(start)) continue;
		const poly: PathPoint[] = [];
		let e = start;
		for (;;) {
			const n = next.get(e);
			if (n === undefined) break;
			next.delete(e);
			const p = point.get(e);
			if (p) poly.push(p);
			e = n;
			if (e === start) break;
		}
		if (poly.length >= 3) out.push(poly);
	}
	return out;
}

function pointInPolygon(p: PathPoint, poly: readonly PathPoint[]): boolean {
	let inside = false;
	const n = poly.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const a = poly[i]!;
		const b = poly[j]!;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
			inside = !inside;
	}
	return inside;
}

function segDist(p: PathPoint, a: PathPoint, b: PathPoint): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const l2 = dx * dx + dy * dy;
	const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
	return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker on an open polyline (iterative): kept indices between lo and hi (exclusive). */
function dp(p: readonly PathPoint[], lo: number, hi: number, tol: number, keep: number[]): void {
	const stack: [number, number][] = [[lo, hi]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		if (b <= a + 1) continue;
		let best = 0;
		let bi = a;
		for (let k = a + 1; k < b; k++) {
			const d = segDist(p[k]!, p[a]!, p[b]!);
			if (d > best) {
				best = d;
				bi = k;
			}
		}
		if (best > tol) {
			keep.push(bi);
			stack.push([a, bi], [bi, b]);
		}
	}
}

/** Douglas–Peucker on a closed loop: indices of the kept vertices, in order. */
function simplifyIdx(p: readonly PathPoint[], tol: number): number[] {
	const n = p.length;
	let far = 0;
	let fd = -1;
	for (let i = 0; i < n; i++) {
		const d = (p[i]![0] - p[0]![0]) ** 2 + (p[i]![1] - p[0]![1]) ** 2;
		if (d > fd) {
			fd = d;
			far = i;
		}
	}
	const ext = [...p, p[0]!];
	const keep = [0, far];
	dp(ext, 0, far, tol, keep);
	dp(ext, far, n, tol, keep);
	return [...new Set(keep)].filter((i) => i < n).sort((a, b) => a - b);
}

function simplifyClosed(p: readonly PathPoint[], tol: number): PathPoint[] {
	return simplifyIdx(p, tol).map((i) => p[i]!);
}

// ---------------------------------------------------------------- cubic fitting (Schneider 1990)

type V = [number, number];
const unit = (v: V): V | null => {
	const l = Math.hypot(v[0], v[1]);
	return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
};
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];

function bern(t: number): [number, number, number, number] {
	const s = 1 - t;
	return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

function evalC(c: [V, V, V, V], t: number): V {
	const b = bern(t);
	return [
		b[0] * c[0][0] + b[1] * c[1][0] + b[2] * c[2][0] + b[3] * c[3][0],
		b[0] * c[0][1] + b[1] * c[1][1] + b[2] * c[2][1] + b[3] * c[3][1],
	];
}

function chordParams(pts: readonly V[]): number[] {
	const u = [0];
	let acc = 0;
	for (let i = 1; i < pts.length; i++) {
		acc += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
		u.push(acc);
	}
	return acc > 0 ? u.map((x) => x / acc) : u;
}

function generate(pts: readonly V[], u: readonly number[], t0: V, t1: V): [V, V, V, V] {
	const p0 = pts[0]!;
	const p3 = pts[pts.length - 1]!;
	const din: V = [-t1[0], -t1[1]];
	let c00 = 0;
	let c01 = 0;
	let c11 = 0;
	let x0 = 0;
	let x1 = 0;
	pts.forEach((p, i) => {
		const b = bern(u[i]!);
		const a0: V = [t0[0] * b[1], t0[1] * b[1]];
		const a1: V = [din[0] * b[2], din[1] * b[2]];
		c00 += dot(a0, a0);
		c01 += dot(a0, a1);
		c11 += dot(a1, a1);
		const tmp: V = [
			p[0] - (p0[0] * (b[0] + b[1]) + p3[0] * (b[2] + b[3])),
			p[1] - (p0[1] * (b[0] + b[1]) + p3[1] * (b[2] + b[3])),
		];
		x0 += dot(a0, tmp);
		x1 += dot(a1, tmp);
	});
	const det = c00 * c11 - c01 * c01;
	const seg = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
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
	return [p0, [p0[0] + t0[0] * al, p0[1] + t0[1] * al], [p3[0] + din[0] * ar, p3[1] + din[1] * ar], p3];
}

function maxError(pts: readonly V[], c: [V, V, V, V], u: readonly number[]): number {
	let e = 0;
	pts.forEach((p, i) => {
		const q = evalC(c, u[i]!);
		e = Math.max(e, Math.hypot(q[0] - p[0], q[1] - p[1]));
	});
	return e;
}

function newton(c: [V, V, V, V], p: V, t: number): number {
	const d1: [V, V, V] = [
		[3 * (c[1][0] - c[0][0]), 3 * (c[1][1] - c[0][1])],
		[3 * (c[2][0] - c[1][0]), 3 * (c[2][1] - c[1][1])],
		[3 * (c[3][0] - c[2][0]), 3 * (c[3][1] - c[2][1])],
	];
	const d2: [V, V] = [
		[2 * (d1[1][0] - d1[0][0]), 2 * (d1[1][1] - d1[0][1])],
		[2 * (d1[2][0] - d1[1][0]), 2 * (d1[2][1] - d1[1][1])],
	];
	const s = 1 - t;
	const q = evalC(c, t);
	const q1: V = [
		s * s * d1[0][0] + 2 * s * t * d1[1][0] + t * t * d1[2][0],
		s * s * d1[0][1] + 2 * s * t * d1[1][1] + t * t * d1[2][1],
	];
	const q2: V = [s * d2[0][0] + t * d2[1][0], s * d2[0][1] + t * d2[1][1]];
	const diff: V = [q[0] - p[0], q[1] - p[1]];
	const num = dot(diff, q1);
	const den = dot(q1, q1) + dot(diff, q2);
	if (Math.abs(den) < 1e-12) return t;
	const nt = t - num / den;
	return Number.isFinite(nt) ? Math.min(1, Math.max(0, nt)) : t;
}

/** Best single cubic for `pts` with the given unit end tangents (`t1` points forward at the end). */
export function fitCubicWithTangents(pts: readonly V[], t0: V, t1: V): [V, V, V, V] {
	let u = chordParams(pts);
	let best = generate(pts, u, t0, t1);
	let bestErr = maxError(pts, best, u);
	for (let k = 0; k < 6; k++) {
		const nu = u.map((ui, i) => newton(best, pts[i]!, ui));
		const c = generate(pts, nu, t0, t1);
		const e = maxError(pts, c, nu);
		if (e < bestErr) {
			best = c;
			bestErr = e;
			u = nu;
		} else break;
	}
	return best;
}

/** Fit cubics through the simplified vertices of a loop (`raw` is the full contour). */
function fitLoop(raw: readonly PathPoint[], simp: readonly PathPoint[], round: number): BezierPath {
	const n = simp.length;
	if (round <= 1e-6) return polygonPath(simp, true);
	const idx = simp.map((s) => {
		const i = raw.findIndex((r) => r[0] === s[0] && r[1] === s[1]);
		return i < 0 ? 0 : i;
	});
	const sub = (a: PathPoint, b: PathPoint): V => [b[0] - a[0], b[1] - a[1]];
	const dirs = simp.map((cur, i) => {
		const prev = simp[(i + n - 1) % n]!;
		const nxt = simp[(i + 1) % n]!;
		const smooth = unit(sub(prev, nxt)) ?? [1, 0];
		const outChord = unit(sub(cur, nxt)) ?? smooth;
		const inChord = unit(sub(prev, cur)) ?? smooth;
		const leave =
			unit([outChord[0] * (1 - round) + smooth[0] * round, outChord[1] * (1 - round) + smooth[1] * round]) ??
			outChord;
		const arrive =
			unit([inChord[0] * (1 - round) + smooth[0] * round, inChord[1] * (1 - round) + smooth[1] * round]) ?? inChord;
		return { leave, arrive };
	});
	const path = polygonPath(simp, true);
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const a = idx[i]!;
		const b = idx[j]!;
		let pts: V[] = (b > a ? raw.slice(a, b + 1) : [...raw.slice(a), ...raw.slice(0, b + 1)]).map(
			(q) => [q[0], q[1]] as V,
		);
		if (pts.length < 2) pts = [simp[i]! as V, simp[j]! as V];
		const first = pts[0]!;
		const last = pts[pts.length - 1]!;
		const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
		const t0 = dirs[i]!.leave;
		const t1 = dirs[j]!.arrive;
		let l0: number;
		let l1: number;
		if (pts.length >= 3) {
			const c = fitCubicWithTangents(pts, t0, t1);
			const max = chord * 0.5 * Math.max(round, 0.34);
			l0 = Math.min(max, Math.max(0, dot([c[1][0] - c[0][0], c[1][1] - c[0][1]], t0)));
			l1 = Math.min(max, Math.max(0, dot([c[3][0] - c[2][0], c[3][1] - c[2][1]], t1)));
		} else {
			l0 = (chord / 3) * round;
			l1 = (chord / 3) * round;
		}
		path.vertices[i]!.out = [t0[0] * l0, t0[1] * l0];
		path.vertices[j]!.in = [-t1[0] * l1, -t1[1] * l1];
	}
	return path;
}

/** Luminance (Rec. 709 on the stored values) or alpha field of straight RGBA8 pixels, 0..1. */
export function traceFieldOf(
	rgba: ArrayLike<number>,
	w: number,
	h: number,
	channel: 'alpha' | 'luma' | 'red' | 'green' | 'blue',
): Float32Array {
	const out = new Float32Array(w * h);
	for (let i = 0; i < w * h; i++) {
		const r = (rgba[4 * i] as number) / 255;
		const g = (rgba[4 * i + 1] as number) / 255;
		const b = (rgba[4 * i + 2] as number) / 255;
		const a = (rgba[4 * i + 3] as number) / 255;
		out[i] =
			channel === 'alpha'
				? a
				: channel === 'red'
					? r * a
					: channel === 'green'
						? g * a
						: channel === 'blue'
							? b * a
							: (0.2126 * r + 0.7152 * g + 0.0722 * b) * a;
	}
	return out;
}
