// Inflate mode of 3D titles (spec 19 TL-072), ported from Pachislop `src/engine/three/inflate.ts`
// (licenses/ported/pachislop-three-d.md): the front of every shape is a height field over its outline's distance
// field, the silhouette meets a straight side wall, and a flat back closes the solid.
//
// Front surface: a square grid of spacing `step` clipped EXACTLY to the outline. Cells fully inside are two triangles;
// a cell the outline passes through becomes the polygon(s) cell ∩ shape, traced from the outline pieces inside the cell
// and the cell border between them. Every point where the outline crosses a grid line is ONE shared vertex: both cells
// beside it and the side wall use it, so the surface, the wall and neighbouring cells meet without cracks or
// T-junctions. Heights come from the exact distance of each grid node to the outline, relaxed so the medial-axis
// ridges round off. Normals are area-weighted vertex averages, or, with Smoothness above 0, the exact slope of the
// profile along the distance gradient, averaged over neighbours a few times: a mirror finish then shows no facet
// ripples at the grid step.
//
// Coordinates: layer px, y down; the outline's loops are oriented here so the code's "counter-clockwise" holds in the
// math sense of (x, y). z goes away from the viewer, so the top of the surface sits at z 0 and the rest at z > 0.
import type { InflateCurvePoint } from '../schema/three-d.ts';
import type { Shape2D } from './extrude.ts';
import type { MeshBuilder } from './solid.ts';
import { earcut } from './triangulate.ts';

/** Grid nodes across the largest inset (≈ half the widest stroke) at the estimated scale. */
const NODES_PER_INSET = 12;
/** Most grid nodes per title; larger titles get a coarser grid. */
const MAX_NODES = 200_000;
/** Finest grid step, output px. */
const MIN_STEP_PX = 0.75;
/** Relaxation passes over the distance field. */
const SMOOTH_PASSES = 2;
/** Wall normals: edges turning more than this stay creased. */
const CREASE_COS = Math.cos((32 * Math.PI) / 180);
/** Grid phase as a fraction of the step: keeps outline vertices off the grid lines. */
const PHASE = 0.3183098861837907;
const DEGENERATE_RETRIES = 6;

type P = [number, number];

/** A shape's front-surface mesh with its distance field. */
export type InflateField = {
	/** Vertex positions, interleaved x, y. */
	xy: number[];
	/** Distance of every vertex to the outline (0 on it), relaxed. */
	dist: Float64Array;
	/** Unit gradient of the exact distance per vertex, interleaved x, y. */
	grad: Float64Array;
	/** Front triangles as vertex index triples. */
	tris: number[];
	/** Outline contours with every grid crossing inserted (vertex indices): outer first, then holes. */
	rings: number[][];
	maxDist: number;
};

const area = (c: readonly P[]) => {
	let a = 0;
	for (let i = 0, n = c.length; i < n; i++) {
		const p = c[i]!;
		const q = c[(i + 1) % n]!;
		a += p[0] * q[1] - q[0] * p[1];
	}
	return a / 2;
};

const perimeter = (c: readonly P[]) => {
	let l = 0;
	for (let i = 0, n = c.length; i < n; i++) {
		const p = c[i]!;
		const q = c[(i + 1) % n]!;
		l += Math.hypot(q[0] - p[0], q[1] - p[1]);
	}
	return l;
};

/** Outer loop with positive area, holes negative: the shape lies left of every edge. */
function normalised(shape: Shape2D): Shape2D {
	const fix = (l: P[], positive: boolean) => (area(l) > 0 === positive ? l : [...l].reverse());
	return { outer: fix(shape.outer, true), holes: shape.holes.map((h) => fix(h, false)) };
}

/** Output scale as the grid sees it: the nearest power of two, so preview zooms rarely rebuild. */
export function inflateScale(outputScale: number): number {
	return 2 ** Math.round(Math.log2(Math.max(outputScale, 1e-6)));
}

/** Grid step (layer px) for inflating `shapes` together. */
export function inflateStep(shapes: readonly Shape2D[], outputScale: number, detail = 1): number {
	let total = 0;
	let scale = 0;
	for (const s of shapes) {
		const a = Math.abs(area(s.outer)) - s.holes.reduce((t, h) => t + Math.abs(area(h)), 0);
		const p = perimeter(s.outer) + s.holes.reduce((t, h) => t + perimeter(h), 0);
		if (a <= 0 || p <= 0) continue;
		total += a;
		scale = Math.max(scale, (1.5 * a) / p);
	}
	if (total <= 0) return 1;
	return Math.max(
		scale / (NODES_PER_INSET * detail),
		Math.sqrt(total / MAX_NODES),
		MIN_STEP_PX / Math.max(outputScale, 1e-6),
	);
}

/** The inflate field of a shape at grid spacing `step`. */
export function inflateField(shape: Shape2D, step: number): InflateField {
	const s = normalised(shape);
	let field: InflateField | null = null;
	// A crossing exactly on a grid node or an outline vertex on a grid line has no well-defined cell: shift and retry.
	for (let k = 0; k < DEGENERATE_RETRIES && !field; k++) field = buildField(s, step, PHASE + k * 0.1372);
	return (
		field ?? { xy: [], dist: new Float64Array(0), grad: new Float64Array(0), tris: [], rings: [], maxDist: 0 }
	);
}

/** One outline piece inside a cell: from the crossing it enters by to the one it leaves by. */
type Piece = {
	pts: number[];
	/** Cell-border parameter of the entry / exit crossing (0…4, CCW from the first corner). */
	sIn: number;
	sOut: number;
};

/** Triangles of a polygon with holes over vertex ids. */
function triangulate(xy: readonly number[], poly: readonly number[], holes: readonly number[][]): number[] {
	const flat: number[] = [];
	const ids: number[] = [];
	const starts: number[] = [];
	const add = (ring: readonly number[]) => {
		for (const v of ring) {
			flat.push(xy[2 * v]!, xy[2 * v + 1]!);
			ids.push(v);
		}
	};
	add(poly);
	for (const h of holes) {
		starts.push(ids.length);
		add(h);
	}
	return earcut(flat, starts).map((i) => ids[i]!);
}

function buildField(shape: Shape2D, h: number, phase: number): InflateField | null {
	const contours = [shape.outer, ...shape.holes];
	let bx0 = Number.POSITIVE_INFINITY;
	let by0 = Number.POSITIVE_INFINITY;
	let bx1 = Number.NEGATIVE_INFINITY;
	let by1 = Number.NEGATIVE_INFINITY;
	for (const c of contours)
		for (const p of c) {
			if (p[0] < bx0) bx0 = p[0];
			if (p[0] > bx1) bx1 = p[0];
			if (p[1] < by0) by0 = p[1];
			if (p[1] > by1) by1 = p[1];
		}
	const x0 = bx0 - h * phase;
	const y0 = by0 - h * phase;
	const nx = Math.floor((bx1 - x0) / h) + 2;
	const ny = Math.floor((by1 - y0) / h) + 2;
	const X = (i: number) => x0 + i * h;
	const Y = (j: number) => y0 + j * h;
	const offLine = (v: number, o: number) => {
		const f = (v - o) / h;
		return Math.abs(f - Math.round(f)) > 1e-7;
	};
	for (const c of contours) for (const p of c) if (!offLine(p[0], x0) || !offLine(p[1], y0)) return null;

	// Vertices: outline points and crossings first (dist 0), grid nodes after.
	const xy: number[] = [];
	/** Per vertex: crossing kind (0 = on vertical line `line`, 1 = on horizontal line), −1 outline vertex, −2 grid node. */
	const kind: number[] = [];
	const line: number[] = [];
	const addVertex = (x: number, y: number, k: number, l: number) => {
		xy.push(x, y);
		kind.push(k);
		line.push(l);
		return kind.length - 1;
	};
	/** Crossings on each horizontal grid line (x values): a node is inside by parity. */
	const rowCross: number[][] = Array.from({ length: ny }, () => []);
	const rings: number[][] = [];
	const crossings: { t: number; k: number; l: number; x: number; y: number }[] = [];
	for (const c of contours) {
		const ring: number[] = [];
		for (let e = 0, n = c.length; e < n; e++) {
			const a = c[e]!;
			const b = c[(e + 1) % n]!;
			ring.push(addVertex(a[0], a[1], -1, -1));
			crossings.length = 0;
			if (a[0] !== b[0]) {
				const lo = Math.ceil((Math.min(a[0], b[0]) - x0) / h);
				const hi = Math.floor((Math.max(a[0], b[0]) - x0) / h);
				for (let i = lo; i <= hi; i++) {
					const t = (X(i) - a[0]) / (b[0] - a[0]);
					if (t <= 0 || t >= 1) continue;
					crossings.push({ t, k: 0, l: i, x: X(i), y: a[1] + t * (b[1] - a[1]) });
				}
			}
			if (a[1] !== b[1]) {
				const lo = Math.ceil((Math.min(a[1], b[1]) - y0) / h);
				const hi = Math.floor((Math.max(a[1], b[1]) - y0) / h);
				for (let j = lo; j <= hi; j++) {
					const t = (Y(j) - a[1]) / (b[1] - a[1]);
					if (t <= 0 || t >= 1) continue;
					crossings.push({ t, k: 1, l: j, x: a[0] + t * (b[0] - a[0]), y: Y(j) });
				}
			}
			crossings.sort((p, q) => p.t - q.t);
			for (let q = 0; q < crossings.length; q++) {
				const cr = crossings[q]!;
				if (q > 0 && cr.t - crossings[q - 1]!.t < 1e-12) return null; // through a grid node
				ring.push(addVertex(cr.x, cr.y, cr.k, cr.l));
				if (cr.k === 1) rowCross[cr.l]!.push(cr.x);
			}
		}
		rings.push(ring);
	}
	const boundaryCount = kind.length;
	for (const r of rowCross) r.sort((a, b) => a - b);

	// Outline pieces per cell (cell id = row · nx + column).
	const pieces = new Map<number, Piece[]>();
	const fulls = new Map<number, number[][]>();
	/** Cell-border parameter of crossing vertex v on cell (ci, cj); NaN if it is not on that cell. */
	const borderS = (v: number, ci: number, cj: number) => {
		const x = xy[2 * v]!;
		const y = xy[2 * v + 1]!;
		if (kind[v] === 0) {
			if (line[v] === ci) return 3 + (Y(cj + 1) - y) / h;
			if (line[v] === ci + 1) return 1 + (y - Y(cj)) / h;
		} else if (kind[v] === 1) {
			if (line[v] === cj) return (x - X(ci)) / h;
			if (line[v] === cj + 1) return 2 + (X(ci + 1) - x) / h;
		}
		return Number.NaN;
	};
	for (const ring of rings) {
		const n = ring.length;
		const start = ring.findIndex((v) => kind[v]! >= 0);
		const mid = (k: number) => {
			const a = ring[k % n]!;
			const b = ring[(k + 1) % n]!;
			return (
				Math.floor(((xy[2 * a + 1]! + xy[2 * b + 1]!) / 2 - y0) / h) * nx +
				Math.floor(((xy[2 * a]! + xy[2 * b]!) / 2 - x0) / h)
			);
		};
		if (start < 0) {
			const cell = mid(0);
			const list = fulls.get(cell);
			if (list) list.push(ring);
			else fulls.set(cell, [ring]);
			continue;
		}
		let k = start;
		do {
			const cell = mid(k);
			const pts = [ring[k]!];
			let m = k + 1;
			while (kind[ring[m % n]!]! < 0) pts.push(ring[m++ % n]!);
			pts.push(ring[m % n]!);
			const ci = cell % nx;
			const cj = (cell - ci) / nx;
			const sIn = borderS(pts[0]!, ci, cj);
			const sOut = borderS(pts[pts.length - 1]!, ci, cj);
			if (Number.isNaN(sIn) || Number.isNaN(sOut)) return null;
			const list = pieces.get(cell);
			if (list) list.push({ pts, sIn, sOut });
			else pieces.set(cell, [{ pts, sIn, sOut }]);
			k = m % n;
		} while (k !== start);
	}

	// Grid nodes.
	const nodeVertex = new Int32Array(nx * ny).fill(-1);
	const node = (i: number, j: number) => {
		const id = j * nx + i;
		let v = nodeVertex[id]!;
		if (v < 0) nodeVertex[id] = v = addVertex(X(i), Y(j), -2, -1);
		return v;
	};
	const nodeInside = (i: number, j: number) => {
		const row = rowCross[j]!;
		const x = X(i);
		let lo = 0;
		let hi = row.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (row[m]! < x) lo = m + 1;
			else hi = m;
		}
		return (lo & 1) === 1;
	};

	// Triangles.
	const tris: number[] = [];
	const tri = (a: number, b: number, c: number) => {
		const ax = xy[2 * a]!;
		const ay = xy[2 * a + 1]!;
		const cross = (xy[2 * b]! - ax) * (xy[2 * c + 1]! - ay) - (xy[2 * b + 1]! - ay) * (xy[2 * c]! - ax);
		if (cross > 0) tris.push(a, b, c);
		else if (cross < 0) tris.push(a, c, b);
	};
	const polyArea = (poly: readonly number[]) => {
		let s = 0;
		for (let i = 0, n = poly.length; i < n; i++) {
			const a = poly[i]!;
			const b = poly[(i + 1) % n]!;
			s += xy[2 * a]! * xy[2 * b + 1]! - xy[2 * b]! * xy[2 * a + 1]!;
		}
		return s / 2;
	};
	const polyContains = (poly: readonly number[], x: number, y: number) => {
		let inside = false;
		for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
			const ax = xy[2 * poly[i]!]!;
			const ay = xy[2 * poly[i]! + 1]!;
			const bx = xy[2 * poly[j]!]!;
			const by = xy[2 * poly[j]! + 1]!;
			if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
		}
		return inside;
	};
	for (let cj = 0; cj < ny - 1; cj++) {
		for (let ci = 0; ci < nx - 1; ci++) {
			const cell = cj * nx + ci;
			const list = pieces.get(cell);
			const full = fulls.get(cell);
			const polys: number[][] = [];
			if (!list) {
				if (!nodeInside(ci, cj)) {
					if (!full) continue;
				} else if (!full) {
					// A whole cell inside: alternate the diagonal so the facets have no common direction.
					const a = node(ci, cj);
					const b = node(ci + 1, cj);
					const c = node(ci + 1, cj + 1);
					const d = node(ci, cj + 1);
					if ((ci + cj) & 1) {
						tri(a, b, c);
						tri(a, c, d);
					} else {
						tri(a, b, d);
						tri(b, c, d);
					}
					continue;
				} else polys.push([node(ci, cj), node(ci + 1, cj), node(ci + 1, cj + 1), node(ci, cj + 1)]);
			} else {
				// Cell ∩ shape: an outline piece, then along the border (picking up corners) to the next piece's entry.
				const corner = (c: number) =>
					c === 0
						? node(ci, cj)
						: c === 1
							? node(ci + 1, cj)
							: c === 2
								? node(ci + 1, cj + 1)
								: node(ci, cj + 1);
				const used = new Uint8Array(list.length);
				for (let p0 = 0; p0 < list.length; p0++) {
					if (used[p0]) continue;
					const poly: number[] = [];
					let p = p0;
					for (;;) {
						used[p] = 1;
						poly.push(...list[p]!.pts);
						const s = list[p]!.sOut;
						let next = -1;
						let gap = Number.POSITIVE_INFINITY;
						for (let q = 0; q < list.length; q++) {
							let d = list[q]!.sIn - s;
							if (d <= 0) d += 4;
							if (d < gap) {
								gap = d;
								next = q;
							}
						}
						for (let k = 1; k <= 4; k++) {
							const c = Math.floor(s) + k;
							if (c - s >= gap) break;
							poly.push(corner(c % 4));
						}
						if (next === p0) break;
						if (used[next]) return null;
						p = next;
					}
					polys.push(poly);
				}
			}
			// Contours wholly inside the cell: islands are polygons of their own, holes go into the smallest polygon around them.
			const holes: number[][][] = polys.map(() => []);
			for (const f of full ?? [])
				if (polyArea(f) > 0) {
					polys.push(f);
					holes.push([]);
				}
			for (const f of full ?? []) {
				if (polyArea(f) > 0) continue;
				const x = xy[2 * f[0]!]!;
				const y = xy[2 * f[0]! + 1]!;
				let best = -1;
				let bestArea = Number.POSITIVE_INFINITY;
				polys.forEach((poly, k) => {
					const a = polyArea(poly);
					if (a < bestArea && polyContains(poly, x, y)) {
						best = k;
						bestArea = a;
					}
				});
				if (best >= 0) holes[best]!.push(f);
			}
			polys.forEach((poly, k) => {
				const t = triangulate(xy, poly, holes[k]!);
				for (let q = 0; q < t.length; q += 3) tri(t[q]!, t[q + 1]!, t[q + 2]!);
			});
		}
	}

	// Distance of the grid nodes to the outline, by bucketed exact segment distances.
	const dist = new Float64Array(kind.length);
	const segs: number[] = [];
	for (const c of contours)
		for (let i = 0, n = c.length; i < n; i++)
			segs.push(c[i]![0], c[i]![1], c[(i + 1) % n]![0], c[(i + 1) % n]![1]);
	const bucket = Math.max(4 * h, 1e-6);
	const bw = Math.max(1, Math.ceil((bx1 - bx0) / bucket) + 1);
	const bh = Math.max(1, Math.ceil((by1 - by0) / bucket) + 1);
	const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
	const bClamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
	for (let s = 0; s < segs.length; s += 4) {
		const i0 = bClamp((Math.min(segs[s]!, segs[s + 2]!) - bx0) / bucket, bw);
		const i1 = bClamp((Math.max(segs[s]!, segs[s + 2]!) - bx0) / bucket, bw);
		const j0 = bClamp((Math.min(segs[s + 1]!, segs[s + 3]!) - by0) / bucket, bh);
		const j1 = bClamp((Math.max(segs[s + 1]!, segs[s + 3]!) - by0) / bucket, bh);
		for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * bw + i]!.push(s);
	}
	const segDist2 = (s: number, px: number, py: number) => {
		const ax = segs[s]!;
		const ay = segs[s + 1]!;
		const ex = segs[s + 2]! - ax;
		const ey = segs[s + 3]! - ay;
		const l2 = ex * ex + ey * ey;
		const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
		const dx = ax + t * ex - px;
		const dy = ay + t * ey - py;
		return dx * dx + dy * dy;
	};
	const maxRing = Math.max(bw, bh);
	const grad = new Float64Array(kind.length * 2);
	for (let v = boundaryCount; v < kind.length; v++) {
		const px = xy[2 * v]!;
		const py = xy[2 * v + 1]!;
		const bi = bClamp((px - bx0) / bucket, bw);
		const bj = bClamp((py - by0) / bucket, bh);
		let best = Number.POSITIVE_INFINITY;
		let bs = -1;
		for (let r = 0; r <= maxRing; r++) {
			for (let j = bj - r; j <= bj + r; j++) {
				if (j < 0 || j >= bh) continue;
				const edge = j === bj - r || j === bj + r;
				const inc = edge ? 1 : Math.max(1, 2 * r);
				for (let i = bi - r; i <= bi + r; i += inc) {
					if (i < 0 || i >= bw) continue;
					for (const s of buckets[j * bw + i]!) {
						const d = segDist2(s, px, py);
						if (d < best) {
							best = d;
							bs = s;
						}
					}
				}
			}
			if (best <= r * bucket * r * bucket) break;
		}
		dist[v] = Math.sqrt(best);
		if (bs >= 0 && best > 0) {
			const ax = segs[bs]!;
			const ay = segs[bs + 1]!;
			const ex = segs[bs + 2]! - ax;
			const ey = segs[bs + 3]! - ay;
			const l2 = ex * ex + ey * ey;
			const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
			grad[2 * v] = (px - ax - t * ex) / dist[v]!;
			grad[2 * v + 1] = (py - ay - t * ey) / dist[v]!;
		}
	}
	// On the outline: the inward normal, averaged over the two edges (the shape is left of every edge).
	for (const ring of rings) {
		const k = ring.length;
		for (let i = 0; i < k; i++) {
			const p = ring[(i - 1 + k) % k]!;
			const v = ring[i]!;
			const q = ring[(i + 1) % k]!;
			const dx1 = xy[2 * v]! - xy[2 * p]!;
			const dy1 = xy[2 * v + 1]! - xy[2 * p + 1]!;
			const dx2 = xy[2 * q]! - xy[2 * v]!;
			const dy2 = xy[2 * q + 1]! - xy[2 * v + 1]!;
			const l1 = Math.hypot(dx1, dy1) || 1;
			const l2 = Math.hypot(dx2, dy2) || 1;
			const gx = -dy1 / l1 - dy2 / l2;
			const gy = dx1 / l1 + dx2 / l2;
			const l = Math.hypot(gx, gy) || 1;
			grad[2 * v] = gx / l;
			grad[2 * v + 1] = gy / l;
		}
	}

	// Relax the field (outline fixed at 0): rounds the ridges along the medial axis.
	const sum = new Float64Array(kind.length);
	const cnt = new Float64Array(kind.length);
	for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
		sum.fill(0);
		cnt.fill(0);
		for (let t = 0; t < tris.length; t += 3)
			for (let e = 0; e < 3; e++) {
				const a = tris[t + e]!;
				const b = tris[t + ((e + 1) % 3)]!;
				sum[a]! += dist[b]!;
				cnt[a]!++;
				sum[b]! += dist[a]!;
				cnt[b]!++;
			}
		for (let v = boundaryCount; v < kind.length; v++)
			if (cnt[v]) dist[v] = 0.5 * dist[v]! + (0.5 * sum[v]!) / cnt[v]!;
	}
	let maxDist = 0;
	for (let v = boundaryCount; v < kind.length; v++) if (dist[v]! > maxDist) maxDist = dist[v]!;
	return { xy, dist, grad, tris, rings, maxDist };
}

export type InflateSpec = {
	faceSlot: number;
	wallSlot: number;
	backSlot: number;
	/** Rise of the surface above its silhouette at full profile (layer px). */
	height: number;
	/** Distance from the edge / `maxDist` (0…1) → 0…1. */
	profile: (t: number) => number;
	/** Distance that maps to the top of the profile (shared by all shapes of a title). */
	maxDist: number;
	/** z of the flat back. */
	zBack: number;
	/** 0…100: 0 = mesh normals, else exact normals with ⌈smoothness / 10⌉ ridge-rounding passes. */
	smoothness: number;
};

/** z of the silhouette (and the wall top): the profile at the edge, with the profile's top at z 0. */
export function inflateWallTop(height: number, profile: (t: number) => number): number {
	return height * (1 - profile(0));
}

/** Front surface, side wall and flat back of one inflate field. */
export function emitInflate(b: MeshBuilder, f: InflateField, spec: InflateSpec): void {
	const nv = f.dist.length;
	if (!nv) return;
	const { xy, tris } = f;
	const m = spec.maxDist > 0 ? spec.maxDist : 1;
	const z = new Float64Array(nv);
	for (let v = 0; v < nv; v++) z[v] = spec.height * (1 - spec.profile(Math.min(1, f.dist[v]! / m)));
	const wallTop = inflateWallTop(spec.height, spec.profile);
	// Normals with +z towards the viewer in this block; flipped when written (z goes away from the viewer here).
	const n = new Float64Array(nv * 3);
	if (spec.smoothness > 0) {
		const eps = 1e-3;
		for (let v = 0; v < nv; v++) {
			const t = f.dist[v]! / m;
			let slope = 0;
			if (t < 1) {
				const t0 = Math.max(0, t - eps);
				const t1 = Math.min(1, t + eps);
				slope = (spec.height * (spec.profile(t1) - spec.profile(t0))) / ((t1 - t0) * m);
			}
			const nx = -slope * f.grad[2 * v]!;
			const ny = -slope * f.grad[2 * v + 1]!;
			const l = Math.hypot(nx, ny, 1);
			n[3 * v] = nx / l;
			n[3 * v + 1] = ny / l;
			n[3 * v + 2] = 1 / l;
		}
		// The gradient flips across the medial axis: average with the neighbours (outline fixed).
		const acc = new Float64Array(nv * 3);
		for (let pass = 0, passes = Math.ceil(spec.smoothness / 10); pass < passes; pass++) {
			acc.set(n);
			for (let t = 0; t < tris.length; t += 3)
				for (let e = 0; e < 3; e++) {
					const a = tris[t + e]!;
					const c = tris[t + ((e + 1) % 3)]!;
					acc[3 * a]! += n[3 * c]!;
					acc[3 * a + 1]! += n[3 * c + 1]!;
					acc[3 * a + 2]! += n[3 * c + 2]!;
					acc[3 * c]! += n[3 * a]!;
					acc[3 * c + 1]! += n[3 * a + 1]!;
					acc[3 * c + 2]! += n[3 * a + 2]!;
				}
			for (let v = 0; v < nv; v++) {
				if (f.dist[v]! <= 0) continue;
				const l = Math.hypot(acc[3 * v]!, acc[3 * v + 1]!, acc[3 * v + 2]!) || 1;
				n[3 * v] = acc[3 * v]! / l;
				n[3 * v + 1] = acc[3 * v + 1]! / l;
				n[3 * v + 2] = acc[3 * v + 2]! / l;
			}
		}
	} else {
		// Area-weighted vertex normals over the surface; heights rise towards the viewer as −z.
		for (let t = 0; t < tris.length; t += 3) {
			const a = tris[t]!;
			const c = tris[t + 1]!;
			const e = tris[t + 2]!;
			const ux = xy[2 * c]! - xy[2 * a]!;
			const uy = xy[2 * c + 1]! - xy[2 * a + 1]!;
			const uz = z[a]! - z[c]!;
			const vx = xy[2 * e]! - xy[2 * a]!;
			const vy = xy[2 * e + 1]! - xy[2 * a + 1]!;
			const vz = z[a]! - z[e]!;
			const cx = uy * vz - uz * vy;
			const cy = uz * vx - ux * vz;
			const cz = ux * vy - uy * vx;
			for (const k of [a, c, e]) {
				n[3 * k]! += cx;
				n[3 * k + 1]! += cy;
				n[3 * k + 2]! += cz;
			}
		}
		for (let v = 0; v < nv; v++) {
			const l = Math.hypot(n[3 * v]!, n[3 * v + 1]!, n[3 * v + 2]!) || 1;
			n[3 * v] = n[3 * v]! / l;
			n[3 * v + 1] = n[3 * v + 1]! / l;
			n[3 * v + 2] = n[3 * v + 2]! / l;
		}
	}
	const ids = new Int32Array(nv).fill(-1);
	const vertexOf = (v: number) => {
		if (ids[v]! < 0)
			ids[v] = b.vertex(
				xy[2 * v]!,
				xy[2 * v + 1]!,
				z[v]!,
				n[3 * v]!,
				n[3 * v + 1]!,
				-n[3 * v + 2]!,
				xy[2 * v]!,
				xy[2 * v + 1]!,
				spec.faceSlot,
			);
		return ids[v]!;
	};
	for (let t = 0; t < tris.length; t += 3)
		b.tri(vertexOf(tris[t]!), vertexOf(tris[t + 1]!), vertexOf(tris[t + 2]!));

	// Wall: through every outline vertex and crossing, smooth across shallow turns.
	const zb = spec.zBack;
	if (zb - wallTop > 1e-4)
		for (const ring of f.rings) {
			const pts = ring.filter((v, i) => {
				const w = ring[(i + 1) % ring.length]!;
				return Math.abs(xy[2 * v]! - xy[2 * w]!) > 1e-9 || Math.abs(xy[2 * v + 1]! - xy[2 * w + 1]!) > 1e-9;
			});
			const k = pts.length;
			if (k < 3) continue;
			const en: P[] = []; // outward normal of edge i → i+1
			for (let i = 0; i < k; i++) {
				const a = pts[i]!;
				const c = pts[(i + 1) % k]!;
				const dx = xy[2 * c]! - xy[2 * a]!;
				const dy = xy[2 * c + 1]! - xy[2 * a + 1]!;
				const l = Math.hypot(dx, dy) || 1;
				en.push([dy / l, -dx / l]);
			}
			const vn = (i: number, e: number): P => {
				const p = en[(i - 1 + k) % k]!;
				const q = en[i % k]!;
				if (p[0] * q[0] + p[1] * q[1] < CREASE_COS) return en[e]!;
				const sx = p[0] + q[0];
				const sy = p[1] + q[1];
				const l = Math.hypot(sx, sy) || 1;
				return [sx / l, sy / l];
			};
			for (let i = 0; i < k; i++) {
				const j = (i + 1) % k;
				const a = pts[i]!;
				const c = pts[j]!;
				const na = vn(i, i);
				const nb = vn(j, i);
				const ax = xy[2 * a]!;
				const ay = xy[2 * a + 1]!;
				const bx = xy[2 * c]!;
				const by = xy[2 * c + 1]!;
				// The colour of a wall comes from just inside the outline.
				const uA = ax - na[0] * 1.5;
				const vA = ay - na[1] * 1.5;
				const uB = bx - nb[0] * 1.5;
				const vB = by - nb[1] * 1.5;
				const a0 = b.vertex(ax, ay, wallTop, na[0], na[1], 0, uA, vA, spec.wallSlot);
				const a1 = b.vertex(ax, ay, zb, na[0], na[1], 0, uA, vA, spec.wallSlot);
				const b1 = b.vertex(bx, by, zb, nb[0], nb[1], 0, uB, vB, spec.wallSlot);
				const b0 = b.vertex(bx, by, wallTop, nb[0], nb[1], 0, uB, vB, spec.wallSlot);
				b.tri(a0, a1, b1);
				b.tri(a0, b1, b0);
			}
		}

	// Back: the same rings, facing away from the viewer.
	if (!f.rings.length) return;
	const back = triangulate(xy, f.rings[0]!, f.rings.slice(1));
	const backIds = new Map<number, number>();
	const backOf = (v: number) => {
		let id = backIds.get(v);
		if (id === undefined) {
			id = b.vertex(xy[2 * v]!, xy[2 * v + 1]!, zb, 0, 0, 1, xy[2 * v]!, xy[2 * v + 1]!, spec.backSlot);
			backIds.set(v, id);
		}
		return id;
	};
	for (let t = 0; t < back.length; t += 3)
		b.tri(backOf(back[t]!), backOf(back[t + 1]!), backOf(back[t + 2]!));
}

/** Monotone cubic evaluator of an inflate curve (Fritsch–Butland tangents; a corner point keeps both secants). */
export function inflateCurveFn(points: readonly InflateCurvePoint[]): (x: number) => number {
	const pts = points
		.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), corner: !!p.corner }))
		.sort((a, b) => a.x - b.x);
	if (pts.length === 0) return (x) => Math.min(1, Math.max(0, x));
	if (pts[0]!.x > 0) pts.unshift({ x: 0, y: pts[0]!.y, corner: false });
	if (pts[pts.length - 1]!.x < 1) pts.push({ x: 1, y: pts[pts.length - 1]!.y, corner: false });
	const n = pts.length;
	if (n === 1) return () => pts[0]!.y;
	const h: number[] = [];
	const d: number[] = [];
	for (let k = 0; k < n - 1; k++) {
		h.push(pts[k + 1]!.x - pts[k]!.x);
		d.push(h[k]! > 1e-6 ? (pts[k + 1]!.y - pts[k]!.y) / h[k]! : 0);
	}
	const tin = new Array<number>(n).fill(0);
	const tout = new Array<number>(n).fill(0);
	tout[0] = d[0]!;
	tin[n - 1] = d[n - 2]!;
	for (let k = 1; k < n - 1; k++) {
		if (pts[k]!.corner) {
			tin[k] = d[k - 1]!;
			tout[k] = d[k]!;
		} else if (d[k - 1]! * d[k]! <= 0) {
			tin[k] = tout[k] = 0;
		} else {
			const w1 = 2 * h[k]! + h[k - 1]!;
			const w2 = h[k]! + 2 * h[k - 1]!;
			tin[k] = tout[k] = (w1 + w2) / (w1 / d[k - 1]! + w2 / d[k]!);
		}
	}
	return (xIn: number) => {
		const x = Math.min(1, Math.max(0, xIn));
		let k = 0;
		while (k < n - 2 && x > pts[k + 1]!.x) k++;
		if (h[k]! <= 1e-6) return Math.min(1, Math.max(0, pts[k + 1]!.y));
		const t = (x - pts[k]!.x) / h[k]!;
		const t2 = t * t;
		const t3 = t2 * t;
		const y =
			(2 * t3 - 3 * t2 + 1) * pts[k]!.y +
			(t3 - 2 * t2 + t) * h[k]! * tout[k]! +
			(-2 * t3 + 3 * t2) * pts[k + 1]!.y +
			(t3 - t2) * h[k]! * tin[k + 1]!;
		return Math.min(1, Math.max(0, y));
	};
}
