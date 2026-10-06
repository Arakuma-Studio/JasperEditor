// Shared cubic Bézier path model (wp masks; reusable by shapes, text animators and roto).
//
// A path is a list of vertices, each with a position `p` and two tangent handles stored RELATIVE to `p`
// (`in` points backwards along the incoming segment, `out` forwards along the outgoing one). Zero handles are a
// corner. Segment i runs from vertex i to vertex i+1 (and, for a closed path, from the last vertex back to the
// first) as the cubic `p_i, p_i + out_i, p_{i+1} + in_{i+1}, p_{i+1}` — the After Effects / Premiere vertex
// model (also effectcraft's `ShapePath` and filmcraft's `MaskPath`).
//
// Units are the caller's: masks store layer-box-normalised coordinates (0..1 over the layer box), shapes may store
// pixels. Everything here is pure and allocation-light; values are plain JSON so they can be keyframed and stored.
//
// Optional `feather` points (After Effects' Mask Feather tool) sit on segments (`segment`, parameter `t`) with a
// signed radius (outer > 0, inner < 0, in the caller's distance unit — layer px for masks) and a tension; they are
// part of the path value so they animate with it (see `path/feather.ts`).

export type PathPoint = [number, number];

export type PathVertex = {
	/** Position. */
	p: PathPoint;
	/** Incoming tangent handle, relative to `p` (zero = corner on that side). */
	in: PathPoint;
	/** Outgoing tangent handle, relative to `p`. */
	out: PathPoint;
};

export type FeatherPoint = {
	/** Segment index (vertex `segment` → `segment + 1`). */
	segment: number;
	/** Bézier parameter on the segment, 0..1. */
	t: number;
	/** Signed feather radius: > 0 feathers outwards, < 0 inwards (distance units of the caller). */
	radius: number;
	/** 0 = smooth (smoothstep) blend between neighbouring points, 1 = linear. */
	tension: number;
};

export type BezierPath = {
	closed: boolean;
	vertices: PathVertex[];
	/** Variable-width feather points (optional; absent = none). */
	feather?: FeatherPoint[];
};

/** A cubic segment as four control points. */
export type Cubic = [PathPoint, PathPoint, PathPoint, PathPoint];

/** Circle tangent length of a 4-segment cubic quarter circle. */
export const PATH_KAPPA = 0.5522847498307936;

const ZERO: PathPoint = [0, 0];

export const addP = (a: PathPoint, b: PathPoint): PathPoint => [a[0] + b[0], a[1] + b[1]];
export const subP = (a: PathPoint, b: PathPoint): PathPoint => [a[0] - b[0], a[1] - b[1]];
export const mulP = (a: PathPoint, k: number): PathPoint => [a[0] * k, a[1] * k];
export const lerpP = (a: PathPoint, b: PathPoint, t: number): PathPoint => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
];
export const distP = (a: PathPoint, b: PathPoint): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function cornerVertex(p: PathPoint): PathVertex {
	return { p: [p[0], p[1]], in: [0, 0], out: [0, 0] };
}

/** A smooth vertex with mirrored handles (`out = t`, `in = −t`). */
export function smoothVertex(p: PathPoint, t: PathPoint): PathVertex {
	return { p: [p[0], p[1]], in: [-t[0], -t[1]], out: [t[0], t[1]] };
}

export function isCornerVertex(v: PathVertex): boolean {
	return v.in[0] === 0 && v.in[1] === 0 && v.out[0] === 0 && v.out[1] === 0;
}

/** Axis-aligned ellipse: four smooth vertices (top, right, bottom, left — clockwise on screen, y down). */
export function ellipsePath(center: PathPoint, radius: PathPoint): BezierPath {
	const [cx, cy] = center;
	const [rx, ry] = radius;
	const k = PATH_KAPPA;
	return {
		closed: true,
		vertices: [
			smoothVertex([cx, cy - ry], [rx * k, 0]),
			smoothVertex([cx + rx, cy], [0, ry * k]),
			smoothVertex([cx, cy + ry], [-rx * k, 0]),
			smoothVertex([cx - rx, cy], [0, -ry * k]),
		],
	};
}

/** A closed polygon of corner vertices. */
export function polygonPath(points: readonly PathPoint[], closed = true): BezierPath {
	return { closed, vertices: points.map(cornerVertex) };
}

/** Axis-aligned rectangle (Premiere's 4-point polygon mask): TL, TR, BR, BL. */
export function rectPath(x0: number, y0: number, x1: number, y1: number): BezierPath {
	return polygonPath([
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	]);
}

export function segmentCount(p: Pick<BezierPath, 'closed' | 'vertices'>): number {
	const n = p.vertices.length;
	if (n < 2) return 0;
	return p.closed ? n : n - 1;
}

/** Segment `i` as cubic control points. */
export function segmentAt(p: Pick<BezierPath, 'vertices'>, i: number): Cubic {
	const n = p.vertices.length;
	const a = p.vertices[i]!;
	const b = p.vertices[(i + 1) % n]!;
	return [a.p, addP(a.p, a.out ?? ZERO), addP(b.p, b.in ?? ZERO), b.p];
}

export function segments(p: Pick<BezierPath, 'closed' | 'vertices'>): Cubic[] {
	const out: Cubic[] = [];
	const m = segmentCount(p);
	for (let i = 0; i < m; i++) out.push(segmentAt(p, i));
	return out;
}

export function isStraightCubic(c: Cubic): boolean {
	return c[1][0] === c[0][0] && c[1][1] === c[0][1] && c[2][0] === c[3][0] && c[2][1] === c[3][1];
}

export function cubicPoint(c: Cubic, t: number): PathPoint {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const d = 3 * u * t * t;
	const e = t * t * t;
	return [
		a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
		a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
	];
}

/** First derivative of a cubic. */
export function cubicDerivative(c: Cubic, t: number): PathPoint {
	const u = 1 - t;
	return [
		3 * u * u * (c[1][0] - c[0][0]) + 6 * u * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]),
		3 * u * u * (c[1][1] - c[0][1]) + 6 * u * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1]),
	];
}

/** de Casteljau split at `t`. */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
	const p01 = lerpP(c[0], c[1], t);
	const p12 = lerpP(c[1], c[2], t);
	const p23 = lerpP(c[2], c[3], t);
	const a = lerpP(p01, p12, t);
	const b = lerpP(p12, p23, t);
	const m = lerpP(a, b, t);
	return [
		[c[0], p01, a, m],
		[m, b, p23, c[3]],
	];
}

/** Number of chords (Wang's bound) so a flattened cubic deviates from the curve by at most `tol`. */
export function cubicFlattenSteps(c: Cubic, tol: number): number {
	if (isStraightCubic(c)) return 1;
	const d1x = c[0][0] - 2 * c[1][0] + c[2][0];
	const d1y = c[0][1] - 2 * c[1][1] + c[2][1];
	const d2x = c[1][0] - 2 * c[2][0] + c[3][0];
	const d2y = c[1][1] - 2 * c[2][1] + c[3][1];
	const m = Math.max(Math.hypot(d1x, d1y), Math.hypot(d2x, d2y));
	return Math.min(256, Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / Math.max(1e-6, tol)))));
}

/**
 * Flattens the path to a polyline whose chords deviate from the curve by at most `tol` (path units). A closed
 * path's polyline is implicitly closed (the first point is not repeated). Corner-only segments emit just their end.
 * `segOf[i]` / `tOf[i]` give the segment and parameter of point i (for arc-length / feather lookups).
 */
export function flattenPath(
	p: Pick<BezierPath, 'closed' | 'vertices'>,
	tol: number,
): { pts: PathPoint[]; segOf: number[]; tOf: number[] } {
	const pts: PathPoint[] = [];
	const segOf: number[] = [];
	const tOf: number[] = [];
	const n = p.vertices.length;
	if (n === 0) return { pts, segOf, tOf };
	pts.push([p.vertices[0]!.p[0], p.vertices[0]!.p[1]]);
	segOf.push(0);
	tOf.push(0);
	const m = segmentCount(p);
	for (let i = 0; i < m; i++) {
		const c = segmentAt(p, i);
		const steps = cubicFlattenSteps(c, tol);
		for (let k = 1; k < steps; k++) {
			const t = k / steps;
			pts.push(cubicPoint(c, t));
			segOf.push(i);
			tOf.push(t);
		}
		// The closing segment ends on vertex 0 (already the first point).
		if (!(p.closed && i === m - 1)) {
			pts.push([c[3][0], c[3][1]]);
			segOf.push(i);
			tOf.push(1);
		}
	}
	return { pts, segOf, tOf };
}

/** Arc length of a cubic (polyline of `samples` chords). */
export function cubicLength(c: Cubic, samples = 24): number {
	if (isStraightCubic(c)) return distP(c[0], c[3]);
	let l = 0;
	let prev = c[0];
	for (let k = 1; k <= samples; k++) {
		const q = cubicPoint(c, k / samples);
		l += distP(prev, q);
		prev = q;
	}
	return l;
}

export function pathLength(p: Pick<BezierPath, 'closed' | 'vertices'>): number {
	let l = 0;
	for (const c of segments(p)) l += cubicLength(c);
	return l;
}

/** Bounds of the control polygon (contains the curve): [x0, y0, x1, y1]. */
export function pathControlBounds(p: Pick<BezierPath, 'vertices'>): [number, number, number, number] {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const v of p.vertices) {
		for (const q of [v.p, addP(v.p, v.in), addP(v.p, v.out)]) {
			x0 = Math.min(x0, q[0]);
			y0 = Math.min(y0, q[1]);
			x1 = Math.max(x1, q[0]);
			y1 = Math.max(y1, q[1]);
		}
	}
	return [x0, y0, x1, y1];
}

/** Mean of the vertex positions. */
export function pathCentroid(p: Pick<BezierPath, 'vertices'>): PathPoint {
	const n = p.vertices.length;
	if (n === 0) return [0, 0];
	let x = 0;
	let y = 0;
	for (const v of p.vertices) {
		x += v.p[0];
		y += v.p[1];
	}
	return [x / n, y / n];
}

/** Deep copy (plain JSON values). */
export function clonePath(p: BezierPath): BezierPath {
	return {
		closed: p.closed,
		vertices: p.vertices.map((v) => ({ p: [v.p[0], v.p[1]], in: [v.in[0], v.in[1]], out: [v.out[0], v.out[1]] })),
		...(p.feather?.length ? { feather: p.feather.map((f) => ({ ...f })) } : {}),
	};
}

/**
 * The path with every point mapped by `map` (positions) — tangent handles are mapped as the points `p + h` and
 * re-expressed relative to the mapped vertex, which is exact for affine maps and the usual control-point
 * approximation for projective ones. Feather points keep their segment/t (and radius).
 */
export function mapPath(p: BezierPath, map: (q: PathPoint) => PathPoint): BezierPath {
	return {
		closed: p.closed,
		vertices: p.vertices.map((v) => {
			const q = map(v.p);
			const hi = isZeroP(v.in) ? q : map(addP(v.p, v.in));
			const ho = isZeroP(v.out) ? q : map(addP(v.p, v.out));
			return { p: q, in: subP(hi, q), out: subP(ho, q) };
		}),
		...(p.feather?.length ? { feather: p.feather.map((f) => ({ ...f })) } : {}),
	};
}

const isZeroP = (h: PathPoint) => h[0] === 0 && h[1] === 0;

/** 2D affine `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f (the `Mat2D` convention). */
export type PathAffine = [number, number, number, number, number, number];

export function applyAffineP(m: PathAffine, q: PathPoint): PathPoint {
	return [m[0] * q[0] + m[2] * q[1] + m[4], m[1] * q[0] + m[3] * q[1] + m[5]];
}

export function transformPath(p: BezierPath, m: PathAffine): BezierPath {
	return mapPath(p, (q) => applyAffineP(m, q));
}

/** Scale about `origin`, rotate (degrees, clockwise on screen) about it, then translate. */
export function similarityAffine(
	origin: PathPoint,
	opts: { translate?: PathPoint; scale?: PathPoint | number; rotation?: number },
): PathAffine {
	const s = typeof opts.scale === 'number' ? [opts.scale, opts.scale] : (opts.scale ?? [1, 1]);
	const r = ((opts.rotation ?? 0) * Math.PI) / 180;
	const cos = Math.cos(r);
	const sin = Math.sin(r);
	const [tx, ty] = opts.translate ?? [0, 0];
	// q' = origin + R·S·(q − origin) + t
	const a = cos * s[0]!;
	const b = sin * s[0]!;
	const c = -sin * s[1]!;
	const d = cos * s[1]!;
	return [a, b, c, d, origin[0] - a * origin[0] - c * origin[1] + tx, origin[1] - b * origin[0] - d * origin[1] + ty];
}

/** The same outline traversed the other way (closed paths keep vertex 0 first). Feather points are remapped. */
export function reversePath(p: BezierPath): BezierPath {
	const n = p.vertices.length;
	if (n === 0) return clonePath(p);
	const idx = p.closed ? Array.from({ length: n }, (_, i) => (n - i) % n) : Array.from({ length: n }, (_, i) => n - 1 - i);
	const m = segmentCount(p);
	return {
		closed: p.closed,
		vertices: idx.map((i) => {
			const v = p.vertices[i]!;
			return { p: [v.p[0], v.p[1]], in: [v.out[0], v.out[1]], out: [v.in[0], v.in[1]] };
		}),
		...(p.feather?.length
			? {
					// Segment s (i → i+1) becomes segment m−1−s traversed backwards.
					feather: p.feather.map((f) => ({ ...f, segment: m - 1 - f.segment, t: 1 - f.t })),
				}
			: {}),
	};
}

/** A closed path's vertex order rotated to start at `k`. */
export function rotatePathStart(p: BezierPath, k: number): BezierPath {
	const n = p.vertices.length;
	if (n === 0 || !p.closed || k % n === 0) return clonePath(p);
	const s = ((k % n) + n) % n;
	const c = clonePath(p);
	return {
		closed: true,
		vertices: Array.from({ length: n }, (_, i) => c.vertices[(i + s) % n]!),
		...(c.feather?.length ? { feather: c.feather.map((f) => ({ ...f, segment: (f.segment - s + n) % n })) } : {}),
	};
}

/** Signed area of the flattened outline (> 0: clockwise on screen with y down). */
export function pathSignedArea(p: Pick<BezierPath, 'closed' | 'vertices'>, tol = 0.01): number {
	const { pts } = flattenPath({ closed: true, vertices: p.vertices }, tol);
	return polygonSignedArea(pts);
}

export function polygonSignedArea(pts: readonly PathPoint[]): number {
	let a = 0;
	const n = pts.length;
	for (let i = 0; i < n; i++) {
		const q = pts[i]!;
		const r = pts[(i + 1) % n]!;
		a += q[0] * r[1] - r[0] * q[1];
	}
	return a / 2;
}

/** Nearest point of the path to `q`: segment, parameter, point and distance (path units). */
export function nearestOnPath(
	p: Pick<BezierPath, 'closed' | 'vertices'>,
	q: PathPoint,
): { segment: number; t: number; point: PathPoint; distance: number } | null {
	const m = segmentCount(p);
	let best: { segment: number; t: number; point: PathPoint; distance: number } | null = null;
	for (let i = 0; i < m; i++) {
		const c = segmentAt(p, i);
		const N = isStraightCubic(c) ? 1 : 48;
		// Coarse samples, then golden refinement around the best one.
		let bt = 0;
		let bd = Number.POSITIVE_INFINITY;
		if (N === 1) {
			const dx = c[3][0] - c[0][0];
			const dy = c[3][1] - c[0][1];
			const l2 = dx * dx + dy * dy;
			bt = l2 > 0 ? Math.min(1, Math.max(0, ((q[0] - c[0][0]) * dx + (q[1] - c[0][1]) * dy) / l2)) : 0;
			bd = distP(cubicPoint(c, bt), q);
		} else {
			for (let k = 0; k <= N; k++) {
				const t = k / N;
				const d = distP(cubicPoint(c, t), q);
				if (d < bd) {
					bd = d;
					bt = t;
				}
			}
			let lo = Math.max(0, bt - 1 / N);
			let hi = Math.min(1, bt + 1 / N);
			for (let it = 0; it < 30; it++) {
				const a = lo + (hi - lo) / 3;
				const b = hi - (hi - lo) / 3;
				if (distP(cubicPoint(c, a), q) < distP(cubicPoint(c, b), q)) hi = b;
				else lo = a;
			}
			bt = (lo + hi) / 2;
			bd = distP(cubicPoint(c, bt), q);
		}
		if (!best || bd < best.distance) best = { segment: i, t: bt, point: cubicPoint(c, bt), distance: bd };
	}
	return best;
}

/**
 * Inserts a vertex on segment `segment` at parameter `t` (de Casteljau: the outline is unchanged). Returns the new
 * path and the new vertex index. Feather points on the split segment move to the matching half.
 */
export function insertVertexAt(p: BezierPath, segment: number, t: number): { path: BezierPath; index: number } {
	const n = p.vertices.length;
	const m = segmentCount(p);
	if (segment < 0 || segment >= m) return { path: clonePath(p), index: -1 };
	const tt = Math.min(1 - 1e-6, Math.max(1e-6, t));
	const c = segmentAt(p, segment);
	const [l, r] = splitCubic(c, tt);
	const out = clonePath(p);
	const a = out.vertices[segment]!;
	const bi = (segment + 1) % n;
	const b = out.vertices[bi]!;
	a.out = subP(l[1], l[0]);
	b.in = subP(r[2], r[3]);
	const v: PathVertex = { p: [l[3][0], l[3][1]], in: subP(l[2], l[3]), out: subP(r[1], r[0]) };
	out.vertices.splice(segment + 1, 0, v);
	if (out.feather?.length) {
		out.feather = out.feather.map((f) => {
			if (f.segment < segment) return f;
			if (f.segment > segment) return { ...f, segment: f.segment + 1 };
			return f.t <= tt ? { ...f, t: f.t / tt } : { ...f, segment: f.segment + 1, t: (f.t - tt) / (1 - tt) };
		});
	}
	return { path: out, index: segment + 1 };
}

/** Removes vertices (indices into `p.vertices`); feather points on removed segments are dropped. */
export function removeVertices(p: BezierPath, indices: readonly number[]): BezierPath {
	const drop = new Set(indices);
	const keep: number[] = [];
	p.vertices.forEach((_, i) => {
		if (!drop.has(i)) keep.push(i);
	});
	const copy = clonePath(p);
	const out: BezierPath = { closed: p.closed, vertices: keep.map((i) => copy.vertices[i]!) };
	if (p.feather?.length) {
		// A feather point survives when its segment's start and end vertices both survive and stay adjacent.
		const n = p.vertices.length;
		const newIndex = new Map(keep.map((old, i) => [old, i]));
		const f = p.feather
			.filter((x) => newIndex.has(x.segment) && newIndex.has((x.segment + 1) % n))
			.map((x) => ({ ...x, segment: newIndex.get(x.segment)! }))
			.filter((x) => x.segment < segmentCount(out));
		if (f.length) out.feather = f;
	}
	return out;
}

/**
 * Converts vertices between smooth and corner (Premiere's Convert Vertex tool / Alt-click). `smooth` gives the
 * vertex mirrored handles along the neighbours' direction, a sixth of the distance between them (Catmull–Rom).
 */
export function convertVertices(p: BezierPath, indices: readonly number[], to: 'smooth' | 'corner'): BezierPath {
	const out = clonePath(p);
	const n = out.vertices.length;
	for (const i of indices) {
		const v = out.vertices[i];
		if (!v) continue;
		if (to === 'corner') {
			v.in = [0, 0];
			v.out = [0, 0];
			continue;
		}
		const prev = p.closed || i > 0 ? p.vertices[(i - 1 + n) % n]!.p : v.p;
		const next = p.closed || i < n - 1 ? p.vertices[(i + 1) % n]!.p : v.p;
		const d = mulP(subP(next, prev), 1 / 6);
		v.out = d;
		v.in = [-d[0], -d[1]];
	}
	return out;
}

/** SVG path data (`M … C … Z`) of a path, through an optional point map (e.g. layer → screen). */
export function pathToSvg(p: Pick<BezierPath, 'closed' | 'vertices'>, map: (q: PathPoint) => PathPoint = (q) => q): string {
	const n = p.vertices.length;
	if (n === 0) return '';
	const f = (q: PathPoint) => {
		const r = map(q);
		return `${+r[0].toFixed(3)} ${+r[1].toFixed(3)}`;
	};
	let d = `M ${f(p.vertices[0]!.p)}`;
	for (const c of segments(p)) d += ` C ${f(c[1])} ${f(c[2])} ${f(c[3])}`;
	if (p.closed) d += ' Z';
	return d;
}

/** True for a structurally valid path value (finite numbers, vertex objects). */
export function isBezierPath(v: unknown): v is BezierPath {
	if (!v || typeof v !== 'object') return false;
	const o = v as { closed?: unknown; vertices?: unknown };
	if (typeof o.closed !== 'boolean' || !Array.isArray(o.vertices)) return false;
	const pt = (q: unknown) =>
		Array.isArray(q) && q.length === 2 && typeof q[0] === 'number' && typeof q[1] === 'number' && Number.isFinite(q[0]) && Number.isFinite(q[1]);
	return o.vertices.every((x) => {
		const vv = x as Partial<PathVertex> | null;
		return !!vv && pt(vv.p) && pt(vv.in) && pt(vv.out);
	});
}
