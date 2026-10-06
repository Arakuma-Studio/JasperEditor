// Smart path interpolation (port of effectcraft `crates/path/src/interp.rs`, MIT OR Apache-2.0; see
// licenses/ported/masks.md): give two path shapes the same vertex count with a sensible vertex correspondence and
// compute in-between shapes. Used by Mask Path keyframes whose shapes have different vertex counts.
//
// - Vertex insertion splits Bézier segments with de Casteljau subdivision, so both shapes keep their exact outline
//   while gaining vertices; extra vertices are distributed by arc length (largest remainder per segment).
// - Correspondence picks the cyclic offset (and, for closed shapes, the winding) of the second shape that minimises
//   a matching cost: normalised position differences plus, when quality > 0, the χ² distance of log-polar shape
//   context histograms (Belongie, Malik & Puzicha, "Shape Matching and Object Recognition Using Shape Contexts",
//   PAMI 2002). `firstVerticesMatch` pins the offset to 0; `oneToOne` keeps the original vertices when counts agree.
// - In-betweens move vertices along straight lines (`linear`) or with the shapes' best-fit rotation and scale
//   (Procrustes) interpolated, weighted by `bendingResistance`.
import {
	addP,
	type BezierPath,
	type Cubic,
	clonePath,
	cubicLength,
	cubicPoint,
	type FeatherPoint,
	lerpP,
	mulP,
	type PathPoint,
	pathLength,
	polygonPath,
	polygonSignedArea,
	reversePath,
	rotatePathStart,
	segmentAt,
	segmentCount,
	splitCubic,
	subP,
} from './model.ts';

export type PathMatching = 'auto' | 'curve' | 'polyline';
export type AddVertices = { pixels: number } | { total: number } | { percent: number };

export type PathInterpOptions = {
	linear: boolean;
	/** 0–100. */
	bendingResistance: number;
	/** 0–100. */
	quality: number;
	addVertices: AddVertices | null;
	matching: PathMatching;
	oneToOne: boolean;
	firstVerticesMatch: boolean;
};

export const DEFAULT_PATH_INTERP: PathInterpOptions = {
	linear: false,
	bendingResistance: 50,
	quality: 50,
	addVertices: { pixels: 15 },
	matching: 'auto',
	oneToOne: false,
	firstVerticesMatch: true,
};

/** Split `c` at parameters `ts` (increasing, in (0, 1)). */
function splitMany(c: Cubic, ts: readonly number[]): Cubic[] {
	const out: Cubic[] = [];
	let rest = c;
	let t0 = 0;
	for (const t of ts) {
		const u = Math.min(1, Math.max(0, (t - t0) / (1 - t0)));
		const [l, r] = splitCubic(rest, u);
		out.push(l);
		rest = r;
		t0 = t;
	}
	out.push(rest);
	return out;
}

/** Parameters splitting `c` into `k` pieces of (approximately) equal arc length. */
function arcParams(c: Cubic, k: number): number[] {
	if (k <= 1) return [];
	const S = 64;
	const cum = new Array<number>(S + 1).fill(0);
	let prev = c[0];
	for (let i = 1; i <= S; i++) {
		const q = cubicPoint(c, i / S);
		cum[i] = cum[i - 1]! + Math.hypot(q[0] - prev[0], q[1] - prev[1]);
		prev = q;
	}
	const total = cum[S]!;
	if (total < 1e-12) return Array.from({ length: k - 1 }, (_, j) => (j + 1) / k);
	const out: number[] = [];
	for (let j = 1; j < k; j++) {
		const target = (total * j) / k;
		let i = 1;
		while (i < S && cum[i]! < target) i++;
		const f = (target - cum[i - 1]!) / Math.max(1e-12, cum[i]! - cum[i - 1]!);
		out.push((i - 1 + f) / S);
	}
	return out;
}

/** Rebuild a path from consecutive cubics (closed: the last ends at the first's start). */
function fromCubics(cs: readonly Cubic[], closed: boolean): BezierPath {
	const n = closed ? cs.length : cs.length + 1;
	const v = Array.from({ length: n }, () => ({
		p: [0, 0] as PathPoint,
		in: [0, 0] as PathPoint,
		out: [0, 0] as PathPoint,
	}));
	cs.forEach((c, i) => {
		const j = closed ? (i + 1) % n : i + 1;
		v[i]!.p = [c[0][0], c[0][1]];
		v[i]!.out = subP(c[1], c[0]);
		v[j]!.in = subP(c[2], c[3]);
		if (!closed && j === n - 1) v[j]!.p = [c[3][0], c[3][1]];
	});
	return { closed, vertices: v };
}

/** Exactly the same outline with `total` vertices (≥ the current count), extras distributed by segment length. */
export function pathWithVertexCount(p: BezierPath, total: number): BezierPath {
	const m = segmentCount(p);
	const base = p.closed ? m : m + 1;
	if (m === 0 || total <= base) return clonePath(p);
	const segs = Array.from({ length: m }, (_, i) => segmentAt(p, i));
	const lens = segs.map((c) => cubicLength(c));
	const sum = Math.max(1e-12, lens.reduce((a, b) => a + b, 0));
	const pieces = total - base + m;
	const extra = pieces - m;
	const want = lens.map((l) => (l / sum) * extra);
	const k = want.map((w) => 1 + Math.floor(w));
	let left = pieces - k.reduce((a, b) => a + b, 0);
	const order = Array.from({ length: m }, (_, i) => i).sort(
		(a, b) => want[b]! - Math.floor(want[b]!) - (want[a]! - Math.floor(want[a]!)) || a - b,
	);
	for (let i = 0; left > 0; i = (i + 1) % m) {
		k[order[i]!]!++;
		left--;
	}
	const cubics: Cubic[] = [];
	segs.forEach((c, i) => {
		cubics.push(...splitMany(c, arcParams(c, k[i]!)));
	});
	return fromCubics(cubics, p.closed);
}

/** The outline as a polyline of `total` vertices at equal arc-length spacing, starting at vertex 0. */
export function pathAsPolyline(p: BezierPath, total: number): BezierPath {
	const m = segmentCount(p);
	if (m === 0 || total < 2) return polygonPath(p.vertices.map((v) => v.p), p.closed);
	const pts: PathPoint[] = [p.vertices[0]!.p];
	for (let i = 0; i < m; i++) {
		const c = segmentAt(p, i);
		for (let k = 1; k <= 32; k++) pts.push(cubicPoint(c, k / 32));
	}
	const cum = [0];
	for (let i = 1; i < pts.length; i++)
		cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
	const L = cum[cum.length - 1]!;
	const div = p.closed ? total : total - 1;
	const out: PathPoint[] = [];
	for (let j = 0; j < total; j++) {
		const target = (L * j) / div;
		let i = 1;
		while (i < cum.length - 1 && cum[i]! < target) i++;
		const f = (target - cum[i - 1]!) / Math.max(1e-12, cum[i]! - cum[i - 1]!);
		out.push(lerpP(pts[i - 1]!, pts[i]!, f));
	}
	return polygonPath(out, p.closed);
}

function hasCurves(p: BezierPath): boolean {
	return p.vertices.some((v) => v.in[0] !== 0 || v.in[1] !== 0 || v.out[0] !== 0 || v.out[1] !== 0);
}

/** Centroid and RMS radius of points. */
function frame(v: readonly PathPoint[]): { c: PathPoint; r: number } {
	const n = Math.max(1, v.length);
	let x = 0;
	let y = 0;
	for (const q of v) {
		x += q[0];
		y += q[1];
	}
	const c: PathPoint = [x / n, y / n];
	let s = 0;
	for (const q of v) s += (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2;
	return { c, r: Math.max(1e-9, Math.sqrt(s / n)) };
}

const RBINS = 5;
const ABINS = 12;

/** Log-polar shape context histograms of every point (normalised by the RMS radius). */
function shapeContexts(v: readonly PathPoint[]): Float64Array[] {
	const { r } = frame(v);
	const n = v.length;
	return v.map((pi, i) => {
		const h = new Float64Array(RBINS * ABINS);
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const dx = v[j]![0] - pi[0];
			const dy = v[j]![1] - pi[1];
			const dist = Math.hypot(dx, dy) / r;
			// log radius in [1/8, 2] → 5 bins.
			const lr = ((Math.log2(Math.max(1e-6, dist)) + 3) / 4) * RBINS;
			if (!(lr >= 0 && lr < RBINS)) continue;
			const a = ((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * ABINS;
			const ai = Math.min(ABINS - 1, Math.floor(a));
			h[Math.floor(lr) * ABINS + ai]! += 1;
		}
		let s = 0;
		for (const x of h) s += x;
		s = Math.max(1, s);
		for (let k = 0; k < h.length; k++) h[k]! /= s;
		return h;
	});
}

function chi2(a: Float64Array, b: Float64Array): number {
	let s = 0;
	for (let k = 0; k < a.length; k++) {
		const x = a[k]!;
		const y = b[k]!;
		if (x + y > 1e-12) s += ((x - y) * (x - y)) / (x + y);
	}
	return s * 0.5;
}

/** Matching cost of `a[i] ↔ b[(i + k) % n]`. */
function cost(
	a: readonly PathPoint[],
	b: readonly PathPoint[],
	sa: Float64Array[] | null,
	sb: Float64Array[] | null,
	k: number,
): number {
	const n = a.length;
	const fa = frame(a);
	const fb = frame(b);
	let c = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + k) % n;
		const pa = mulP(subP(a[i]!, fa.c), 1 / fa.r);
		const pb = mulP(subP(b[j]!, fb.c), 1 / fb.r);
		c += (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2;
		if (sa && sb) c += chi2(sa[i]!, sb[j]!);
	}
	return c / n;
}

/**
 * Gives `a` and `b` the same vertex count with matching vertices (the shapes the first and last keys get, and the
 * input of `interpolatePaths`). `units` scales `addVertices.pixels` (path units per pixel, e.g. 1/width for
 * layer-normalised paths).
 */
export function correspondPaths(
	a: BezierPath,
	b: BezierPath,
	o: PathInterpOptions = DEFAULT_PATH_INTERP,
	unitsPerPixel = 1,
): [BezierPath, BezierPath] {
	if (a.vertices.length === 0 || b.vertices.length === 0) return [clonePath(a), clonePath(b)];
	const closed = a.closed && b.closed;
	const curves = o.matching === 'curve' ? true : o.matching === 'polyline' ? false : hasCurves(a) || hasCurves(b);
	let ra: BezierPath;
	let rb: BezierPath;
	if (o.oneToOne && a.vertices.length === b.vertices.length) {
		ra = clonePath(a);
		rb = clonePath(b);
	} else {
		let n = Math.max(a.vertices.length, b.vertices.length);
		if (o.addVertices) {
			const L = Math.max(pathLength(a), pathLength(b));
			const av = o.addVertices;
			const want =
				'pixels' in av
					? Math.ceil(L / Math.max(1e-9, Math.max(1, av.pixels) * unitsPerPixel))
					: 'total' in av
						? av.total
						: Math.ceil(100 / Math.min(100, Math.max(0.1, av.percent)));
			n = Math.max(n, Math.min(2000, want));
		}
		if (curves) {
			ra = pathWithVertexCount(a, n);
			rb = pathWithVertexCount(b, n);
		} else {
			ra = pathAsPolyline(a, n);
			rb = pathAsPolyline(b, n);
		}
		// Proportional splitting can leave counts unequal (a shape already had more vertices than its share).
		if (ra.vertices.length !== rb.vertices.length) {
			ra = pathAsPolyline(a, n);
			rb = pathAsPolyline(b, n);
		}
	}
	if (closed && ra.vertices.length === rb.vertices.length && ra.vertices.length >= 3) {
		const va = ra.vertices.map((v) => v.p);
		if (Math.sign(polygonSignedArea(va)) !== Math.sign(polygonSignedArea(rb.vertices.map((v) => v.p))))
			rb = reversePath(rb);
		if (!o.firstVerticesMatch) {
			const n = ra.vertices.length;
			const vb = rb.vertices.map((v) => v.p);
			const useSc = o.quality > 0;
			const sa = useSc ? shapeContexts(va) : null;
			const sb = useSc ? shapeContexts(vb) : null;
			const step = o.quality >= 50 ? 1 : Math.max(1, Math.ceil(n / 24));
			let best = { c: Number.POSITIVE_INFINITY, k: 0 };
			for (let k = 0; k < n; k += step) {
				const c = cost(va, vb, sa, sb, k);
				if (c < best.c) best = { c, k };
			}
			if (step > 1) {
				const k0 = best.k;
				for (let d = 1; d < step; d++)
					for (const k of [(k0 + d) % n, (k0 + n - d) % n]) {
						const c = cost(va, vb, sa, sb, k);
						if (c < best.c) best = { c, k };
					}
			}
			rb = rotatePathStart(rb, best.k);
		}
	}
	// Feather points: kept on the first shape only when they could not be matched (see interpolatePaths).
	return [ra, rb];
}

function lerpFeather(a: FeatherPoint[] | undefined, b: FeatherPoint[] | undefined, u: number): FeatherPoint[] | undefined {
	if (!a?.length) return u < 1 || !b?.length ? undefined : b.map((f) => ({ ...f }));
	if (!b?.length || a.length !== b.length) return (u < 1 ? a : b)?.map((f) => ({ ...f }));
	return a.map((f, i) => {
		const g = b[i]!;
		return f.segment === g.segment
			? {
					segment: f.segment,
					t: f.t + (g.t - f.t) * u,
					radius: f.radius + (g.radius - f.radius) * u,
					tension: f.tension + (g.tension - f.tension) * u,
				}
			: { ...(u < 0.5 ? f : g), radius: f.radius + (g.radius - f.radius) * u };
	});
}

/** The in-between shape at fraction `u` of two corresponded shapes (equal vertex counts). */
export function interpolatePaths(
	a: BezierPath,
	b: BezierPath,
	u: number,
	o: Pick<PathInterpOptions, 'linear' | 'bendingResistance'> = DEFAULT_PATH_INTERP,
): BezierPath {
	if (a.vertices.length !== b.vertices.length || a.vertices.length === 0) return clonePath(u < 1 ? a : b);
	const n = a.vertices.length;
	const feather = lerpFeather(a.feather, b.feather, u);
	const done = (vertices: BezierPath['vertices']): BezierPath => ({
		closed: a.closed,
		vertices,
		...(feather?.length ? { feather } : {}),
	});
	if (o.linear) {
		return done(
			a.vertices.map((va, i) => {
				const vb = b.vertices[i]!;
				return { p: lerpP(va.p, vb.p, u), in: lerpP(va.in, vb.in, u), out: lerpP(va.out, vb.out, u) };
			}),
		);
	}
	// Procrustes: b ≈ s R (a − ca) + cb.
	const ca = frame(a.vertices.map((v) => v.p)).c;
	const cb = frame(b.vertices.map((v) => v.p)).c;
	let ss = 0;
	let dot = 0;
	let cross = 0;
	for (let i = 0; i < n; i++) {
		const p = subP(a.vertices[i]!.p, ca);
		const q = subP(b.vertices[i]!.p, cb);
		ss += p[0] * p[0] + p[1] * p[1];
		dot += p[0] * q[0] + p[1] * q[1];
		cross += p[0] * q[1] - p[1] * q[0];
	}
	const theta = Math.atan2(cross, dot);
	const s = ss > 1e-12 ? Math.hypot(dot, cross) / ss : 1;
	const rot = (v: PathPoint, ang: number, k: number): PathPoint => {
		const sn = Math.sin(ang);
		const cs = Math.cos(ang);
		return [k * (cs * v[0] - sn * v[1]), k * (sn * v[0] + cs * v[1])];
	};
	const thU = theta * u;
	const sU = Math.max(1e-9, s) ** u;
	const cU = lerpP(ca, cb, u);
	const w = Math.min(1, Math.max(0, o.bendingResistance / 100));
	return done(
		a.vertices.map((va, i) => {
			const vb = b.vertices[i]!;
			const pa = subP(va.p, ca);
			const full = addP(rot(pa, theta, s), cb);
			const resid = subP(vb.p, full);
			const rigid = addP(addP(rot(pa, thU, sU), cU), mulP(resid, u));
			const p = lerpP(lerpP(va.p, vb.p, u), rigid, w);
			const tan = (ta: PathPoint, tb: PathPoint): PathPoint => {
				const tr = subP(tb, rot(ta, theta, s));
				const rigidT = addP(rot(ta, thU, sU), mulP(tr, u));
				return lerpP(lerpP(ta, tb, u), rigidT, w);
			};
			return { p, in: tan(va.in, vb.in), out: tan(va.out, vb.out) };
		}),
	);
}

/** Number of crossing pairs of the straight vertex paths a[i] → b[i] (a sanity measure of a correspondence). */
export function vertexPathsCross(a: BezierPath, b: BezierPath): number {
	const n = Math.min(a.vertices.length, b.vertices.length);
	const d = (p: PathPoint, q: PathPoint, r: PathPoint) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	let c = 0;
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			const p1 = a.vertices[i]!.p;
			const p2 = b.vertices[i]!.p;
			const p3 = a.vertices[j]!.p;
			const p4 = b.vertices[j]!.p;
			if (d(p3, p4, p1) * d(p3, p4, p2) < 0 && d(p1, p2, p3) * d(p1, p2, p4) < 0) c++;
		}
	return c;
}

// ---------------------------------------------------------------- keyframe interpolation

/**
 * Options Mask Path keyframes use: equal vertex counts interpolate vertex by vertex in a straight line (Premiere's
 * behaviour); different counts are corresponded first (arc-length vertex insertion, winding fix, shape-context
 * cyclic matching) and then interpolated linearly.
 */
export const KEYFRAME_PATH_INTERP: PathInterpOptions = {
	linear: true,
	bendingResistance: 0,
	quality: 50,
	addVertices: null,
	matching: 'auto',
	oneToOne: true,
	firstVerticesMatch: false,
};

const corrCache = new WeakMap<BezierPath, WeakMap<BezierPath, [BezierPath, BezierPath]>>();

/** Corresponded pair for two keyframe shapes (cached by the identity of the immutable key values). */
export function correspondKeyPaths(a: BezierPath, b: BezierPath): [BezierPath, BezierPath] {
	let inner = corrCache.get(a);
	const hit = inner?.get(b);
	if (hit) return hit;
	const pair: [BezierPath, BezierPath] =
		a.vertices.length === b.vertices.length && a.closed === b.closed
			? [a, b]
			: correspondPaths(a, b, KEYFRAME_PATH_INTERP);
	if (!inner) {
		inner = new WeakMap();
		corrCache.set(a, inner);
	}
	inner.set(b, pair);
	return pair;
}

/** Keyframe in-between of two path values at progress `p` (0..1). */
export function lerpPathValues(a: BezierPath, b: BezierPath, p: number): BezierPath {
	if (p <= 0) return a;
	if (p >= 1) return b;
	const [ra, rb] = correspondKeyPaths(a, b);
	if (ra.vertices.length !== rb.vertices.length) return p < 1 ? a : b;
	return interpolatePaths(ra, rb, p, KEYFRAME_PATH_INTERP);
}

/** RMS vertex displacement between two path values (the "distance" of auto-Bézier keyframe speeds). */
export function pathValueDistance(a: BezierPath, b: BezierPath): number {
	const [ra, rb] = correspondKeyPaths(a, b);
	const n = Math.min(ra.vertices.length, rb.vertices.length);
	if (n === 0) return 0;
	let s = 0;
	for (let i = 0; i < n; i++) {
		const p = ra.vertices[i]!.p;
		const q = rb.vertices[i]!.p;
		s += (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
	}
	return Math.sqrt(s / n);
}
