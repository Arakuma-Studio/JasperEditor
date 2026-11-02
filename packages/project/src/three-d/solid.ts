// Ring-stack extruder of 3D titles (spec 19 TL-070), ported from Pachislop `src/engine/three/extrude.ts`
// (licenses/ported/pachislop-three-d.md), for outlines traced from a picture's alpha instead of font outlines.
//
// A solid is a PROFILE: a polyline in (offset, z) space walked from the front cap outwards and back to the side wall.
// `offset` is the signed distance from the outline in its plane (+ = outward, − = inward). Every profile point becomes
// a ring (the outline moved by `offset` with per-vertex miter vectors), consecutive rings are joined by quad strips,
// the cap is the first ring triangulated, the side wall runs from the last ring to `zBack`, a flat back closes it.
//
// Rings are clamped per vertex: an offset never travels more than 45 % of the way to the opposite side of the stroke
// along its miter ray, so thin strokes and tight counters (CJK, hairlines, traced noise) never invert: bevels just get
// narrower there. `untangle` then settles what ray limits miss. Overlap between SEPARATE shapes is fine: the depth
// buffer shows their union.
//
// Unlike a font outline, a traced one has a tiny edge at every antialiased corner and many short edges on tight curves.
// Pachislop's per-vertex miters stop both ends of an edge where it collapses, which on a trace would leave a spike at
// every corner. So rings here are a shrinking wavefront (`waveOf`): each ring is the outline's edges moved inward, and
// an edge that collapses is dropped, its neighbours meeting where their offset lines do. Rings keep their vertex count
// (merged vertices coincide), so strips between rings stay simple quads.
//
// Coordinates: layer space (x right, y down); +z is away from the viewer, so the front cap sits at z 0 and bands that
// drop go towards +z. Unlike Pachislop, whose z points at the viewer, every z and normal z here is negated.
import type { BevelProfile } from '../schema/three-d.ts';
import type { Mesh, Shape2D } from './extrude.ts';
import { earcut } from './triangulate.ts';
import { unitBevel } from './bevel.ts';

type P = [number, number];

/** Longest miter, in multiples of the offset. */
const MAX_MITER = 2;
/** Turns sharper than 32° stay creased. */
const CREASE_COS = Math.cos((32 * Math.PI) / 180);

export type ProfilePoint = {
	off: number;
	z: number;
	/** Analytic (radial, z) surface normal for smooth profiles; faceted from the polyline when omitted. */
	n?: [number, number];
};

/** One strip of the profile between two points, drawn as surface slot `slot`. */
export type ProfileSpan = { slot: number; a: ProfilePoint; b: ProfilePoint };

export type SolidSpec = {
	/** Ring of the front cap. */
	cap: { off: number; z: number; slot: number };
	spans: ProfileSpan[];
	/** Side wall from the last span's end to `zBack`, then the back cap. */
	wallSlot: number;
	backSlot: number;
	zBack: number;
	/** Hole rings take this share of every offset (Hole Bevel Depth). */
	holeScale?: number;
	/** The colour of a band or wall vertex (layer px); default: 1.5 px inside the outline. */
	colourAt?: (x: number, y: number, nx: number, ny: number) => P;
	/** Caps take their colour through `colourAt` too (plates: they lie outside the picture). */
	capColour?: boolean;
};

const norm2 = (v: [number, number]): [number, number] => {
	const l = Math.hypot(v[0], v[1]) || 1;
	return [v[0] / l, v[1] / l];
};

/**
 * Appends the spans of one band running outward from (off0, z0) across `width` and along `depth`, with the
 * cross-section of `profile`. Returns the end point.
 */
export function bandSpans(
	out: ProfileSpan[],
	slot: number,
	off0: number,
	z0: number,
	width: number,
	depth: number,
	shape: { profile: BevelProfile; curve: number },
	segments: number,
): { off: number; z: number } {
	const pieces = unitBevel(shape.profile, segments, shape.curve);
	// Analytic normals need a non-degenerate scaled tangent.
	const smooth = width > 1e-6 && depth > 1e-6;
	let end = { off: off0, z: z0 };
	for (const piece of pieces) {
		const pts: ProfilePoint[] = piece.map(({ o, h, t }) => ({
			off: off0 + width * o,
			z: z0 + depth * h,
			// Tangent (w·do, d·dh) in (radial, z), +z away from the viewer → outward normal (d·dh, −w·do).
			...(t && smooth ? { n: norm2([depth * t[1], -width * t[0]]) } : {}),
		}));
		for (let k = 0; k < pts.length - 1; k++) {
			const a = pts[k]!;
			const b = pts[k + 1]!;
			if (Math.abs(b.off - a.off) < 1e-6 && Math.abs(b.z - a.z) < 1e-6) continue;
			out.push({ slot, a, b });
		}
		end = pts[pts.length - 1]!;
	}
	return { off: end.off, z: end.z };
}

/** Growable indexed mesh, in `Mesh`'s vertex layout. */
export class MeshBuilder {
	private v = new Float32Array(9 * 4096);
	private i = new Uint32Array(6 * 4096);
	private nv = 0;
	private ni = 0;

	vertex(
		x: number,
		y: number,
		z: number,
		nx: number,
		ny: number,
		nz: number,
		u: number,
		v: number,
		slot: number,
	): number {
		if ((this.nv + 1) * 9 > this.v.length) {
			const g = new Float32Array(this.v.length * 2);
			g.set(this.v);
			this.v = g;
		}
		const o = this.nv * 9;
		const d = this.v;
		d[o] = x;
		d[o + 1] = y;
		d[o + 2] = z;
		d[o + 3] = nx;
		d[o + 4] = ny;
		d[o + 5] = nz;
		d[o + 6] = u;
		d[o + 7] = v;
		d[o + 8] = slot;
		return this.nv++;
	}

	tri(a: number, b: number, c: number): void {
		if (this.ni + 3 > this.i.length) {
			const g = new Uint32Array(this.i.length * 2);
			g.set(this.i);
			this.i = g;
		}
		this.i[this.ni++] = a;
		this.i[this.ni++] = b;
		this.i[this.ni++] = c;
	}

	get vertexCount(): number {
		return this.nv;
	}

	build(): Mesh {
		return { vertices: this.v.slice(0, this.nv * 9), indices: this.i.slice(0, this.ni), stride: 9 };
	}
}

type Ring = {
	pts: P[];
	miter: P[];
	smoothN: P[];
	/** Normal of edge i → i+1. */
	edgeN: P[];
	crease: boolean[];
	/** Max inward travel before the ring would cross the opposite side. */
	maxIn: number[];
	/** Share of every offset this ring takes. */
	scale: number;
	/** Where the wavefront puts every vertex at `steps[k]` of inward travel. */
	steps: number[];
	xs: Float64Array[];
	ys: Float64Array[];
};

/** A loop as a ring; `loop` runs so that (dy, −dx) points out of the solid (outer: area > 0, hole: area < 0). */
function makeRing(pts: P[], scale: number): Ring {
	const n = pts.length;
	const edgeN: P[] = [];
	for (let i = 0; i < n; i++) {
		const a = pts[i]!;
		const b = pts[(i + 1) % n]!;
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const len = Math.hypot(dx, dy) || 1;
		edgeN.push([dy / len, -dx / len]);
	}
	const miter: P[] = [];
	const smoothN: P[] = [];
	const crease: boolean[] = [];
	for (let i = 0; i < n; i++) {
		const n0 = edgeN[(i - 1 + n) % n]!;
		const n1 = edgeN[i]!;
		const bx = n0[0] + n1[0];
		const by = n0[1] + n1[1];
		crease.push(n0[0] * n1[0] + n0[1] * n1[1] < CREASE_COS);
		if (bx * bx + by * by < 1e-10) {
			// A 180° spike: push along the incoming edge direction.
			const dir: P = [-n0[1], n0[0]];
			smoothN.push(dir);
			miter.push([dir[0] * MAX_MITER, dir[1] * MAX_MITER]);
			continue;
		}
		const l = Math.hypot(bx, by);
		const sx = bx / l;
		const sy = by / l;
		smoothN.push([sx, sy]);
		const k = 1 / Math.max(sx * n0[0] + sy * n0[1], 1 / MAX_MITER);
		miter.push([sx * k, sy * k]);
	}
	return { pts, miter, smoothN, edgeN, crease, maxIn: [], scale, steps: [], xs: [], ys: [] };
}

/**
 * The shrinking wavefront of a ring at inward travels `steps` (ascending, starting at 0): the positions of every
 * vertex. An edge whose direction reverses has collapsed: it leaves the front, and its two neighbours meet at the
 * intersection of their offset lines. Vertices travel at most MAX_MITER per unit of offset, so a sharp reflex corner
 * cannot throw a vertex across the stroke.
 */
function waveOf(r: Ring, steps: readonly number[]): void {
	const n = r.pts.length;
	const next = new Int32Array(n);
	const prev = new Int32Array(n);
	/** The original edge leaving each active vertex. */
	const edge = new Int32Array(n);
	/** The vertex each original vertex has merged into. */
	const rep = new Int32Array(n);
	const c = new Float64Array(n);
	const ex = new Float64Array(n);
	const ey = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		next[i] = (i + 1) % n;
		prev[i] = (i - 1 + n) % n;
		edge[i] = i;
		rep[i] = i;
		const a = r.pts[i]!;
		const b = r.pts[(i + 1) % n]!;
		const nn = r.edgeN[i]!;
		c[i] = nn[0] * a[0] + nn[1] * a[1];
		ex[i] = b[0] - a[0];
		ey[i] = b[1] - a[1];
	}
	const find = (i: number) => {
		let k = i;
		while (rep[k] !== k) {
			rep[k] = rep[rep[k]!]!;
			k = rep[k]!;
		}
		return k;
	};
	let active = n;
	let qx = Float64Array.from(r.pts, (p) => p[0]);
	let qy = Float64Array.from(r.pts, (p) => p[1]);
	r.steps = [...steps];
	r.xs = [qx];
	r.ys = [qy];
	for (let k = 1; k < steps.length; k++) {
		const s = steps[k]!;
		const ds = s - steps[k - 1]!;
		const px = qx;
		const py = qy;
		const x = new Float64Array(n);
		const y = new Float64Array(n);
		const place = (v: number) => {
			const e1 = edge[prev[v]!]!;
			const e2 = edge[v]!;
			const n1 = r.edgeN[e1]!;
			const n2 = r.edgeN[e2]!;
			const det = n1[0] * n2[1] - n1[1] * n2[0];
			let qxv: number;
			let qyv: number;
			if (Math.abs(det) > 1e-3) {
				// n·x = c − s on both offset lines.
				const c1 = c[e1]! - s;
				const c2 = c[e2]! - s;
				qxv = (c1 * n2[1] - c2 * n1[1]) / det;
				qyv = (n1[0] * c2 - n2[0] * c1) / det;
			} else {
				qxv = px[v]! - n1[0] * ds;
				qyv = py[v]! - n1[1] * ds;
			}
			const dx = qxv - px[v]!;
			const dy = qyv - py[v]!;
			const l = Math.hypot(dx, dy);
			const lim = MAX_MITER * ds;
			if (l > lim) {
				qxv = px[v]! + (dx / l) * lim;
				qyv = py[v]! + (dy / l) * lim;
			}
			x[v] = qxv;
			y[v] = qyv;
		};
		let v0 = 0;
		while (rep[v0] !== v0) v0++;
		for (let pass = 0; pass < n; pass++) {
			let v = v0;
			for (let i = 0; i < active; i++) {
				place(v);
				v = next[v]!;
			}
			let collapsed = false;
			if (active > 3) {
				v = v0;
				for (let i = 0, m = active; i < m && active > 3; i++) {
					const w = next[v]!;
					const e = edge[v]!;
					if ((x[w]! - x[v]!) * ex[e]! + (y[w]! - y[v]!) * ey[e]! < 0) {
						// Edge v → w has reversed: w joins v, which takes over w's outgoing edge.
						rep[w] = v;
						edge[v] = edge[w]!;
						next[v] = next[w]!;
						prev[next[w]!] = v;
						if (w === v0) v0 = v;
						active--;
						collapsed = true;
					} else v = w;
				}
			}
			if (!collapsed) break;
		}
		for (let i = 0; i < n; i++) {
			const o = find(i);
			x[i] = x[o]!;
			y[i] = y[o]!;
		}
		qx = x;
		qy = y;
		r.xs.push(x);
		r.ys.push(y);
	}
}

/** Ring vertex i at inward travel `d` ≥ 0, between the wave's steps. */
function waveAt(r: Ring, i: number, d: number): P {
	const st = r.steps;
	const last = st.length - 1;
	if (d <= 0 || last < 1) return r.pts[i]!;
	if (d >= st[last]!) return [r.xs[last]![i]!, r.ys[last]![i]!];
	let lo = 0;
	let hi = last;
	while (hi - lo > 1) {
		const m = (lo + hi) >> 1;
		if (st[m]! <= d) lo = m;
		else hi = m;
	}
	const t = (d - st[lo]!) / Math.max(st[hi]! - st[lo]!, 1e-12);
	return [
		r.xs[lo]![i]! + (r.xs[hi]![i]! - r.xs[lo]![i]!) * t,
		r.ys[lo]![i]! + (r.ys[hi]![i]! - r.ys[lo]![i]!) * t,
	];
}

/** Distance along (dx, dy) from a ring vertex to the nearest edge of the shape (without the vertex's own edges). */
function rayHit(rings: readonly Ring[], self: Ring, i: number, dx: number, dy: number): number {
	const p = self.pts[i]!;
	let best = Number.POSITIVE_INFINITY;
	for (const q of rings) {
		const qn = q.pts.length;
		for (let k = 0; k < qn; k++) {
			if (q === self && (k === i || (k + 1) % qn === i)) continue;
			const a = q.pts[k]!;
			const b = q.pts[(k + 1) % qn]!;
			const ex = b[0] - a[0];
			const ey = b[1] - a[1];
			const den = dx * ey - dy * ex;
			if (Math.abs(den) < 1e-12) continue;
			const wx = a[0] - p[0];
			const wy = a[1] - p[1];
			const t = (wx * ey - wy * ex) / den;
			const u = (wx * dy - wy * dx) / den;
			if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
		}
	}
	return best;
}

/** Per-vertex limit: a vertex stops at 45 % of the way to the opposite side of the stroke along its miter ray. */
function computeLimits(rings: readonly Ring[]): void {
	for (const r of rings) {
		const n = r.pts.length;
		r.maxIn = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
		for (let i = 0; i < n; i++) {
			const m = r.miter[i]!;
			const ml = Math.hypot(m[0], m[1]) || 1;
			r.maxIn[i] = (0.45 * rayHit(rings, r, i, -m[0] / ml, -m[1] / ml)) / ml;
		}
	}
}

/** Ring vertex i at offset `d` ≤ 0, clamped to the local stroke or counter size. */
function posOf(r: Ring, i: number, d: number): P {
	return waveAt(r, i, Math.min(-d * r.scale, r.maxIn[i]!));
}

/** Whether segments ab and cd meet, touching and collinear overlap included. */
function meets(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	dx: number,
	dy: number,
): boolean {
	const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
	const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
	if (d1 === 0 && d2 === 0) {
		const useX = Math.abs(bx - ax) >= Math.abs(by - ay);
		const a0 = useX ? Math.min(ax, bx) : Math.min(ay, by);
		const a1 = useX ? Math.max(ax, bx) : Math.max(ay, by);
		const c0 = useX ? Math.min(cx, dx) : Math.min(cy, dy);
		const c1 = useX ? Math.max(cx, dx) : Math.max(cy, dy);
		return a0 <= c1 && c0 <= a1;
	}
	const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
	const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
	return d1 * d2 <= 0 && d3 * d4 <= 0;
}

/** Rounds that halve a vertex's offset before offending vertices are pinned to the outline. */
const UNTANGLE_STEPS = 8;
/** Ring points closer than this (layer px) are the same point (edges collapsed by `computeLimits`). */
const SAME_PT = 1e-7;

/**
 * Tightens the per-vertex limits until the rings at offset `d` neither cross nor touch each other or themselves. Ray
 * limits keep each vertex short of the opposite side, but two counters can still grow into the stroke between them
 * where their long miters meet. Each round halves the offset of every vertex on a meeting edge; later rounds pin them
 * to the outline, and it stops once nothing moves.
 */
function untangle(rings: readonly Ring[], d: number): void {
	if (d >= 0) return;
	type Edge = {
		r: Ring;
		i: number;
		j: number;
		x0: number;
		x1: number;
		y0: number;
		y1: number;
		ax: number;
		ay: number;
		bx: number;
		by: number;
	};
	const edges: Edge[] = [];
	for (let round = 0; ; round++) {
		edges.length = 0;
		for (const r of rings) {
			const n = r.pts.length;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				const [ax, ay] = posOf(r, i, d);
				const [bx, by] = posOf(r, j, d);
				if (Math.abs(ax - bx) < SAME_PT && Math.abs(ay - by) < SAME_PT) continue;
				edges.push({
					r,
					i,
					j,
					x0: Math.min(ax, bx),
					x1: Math.max(ax, bx),
					y0: Math.min(ay, by),
					y1: Math.max(ay, by),
					ax,
					ay,
					bx,
					by,
				});
			}
		}
		edges.sort((a, b) => a.x0 - b.x0);
		const bad = new Map<Ring, Set<number>>();
		const mark = (e: Edge) => {
			let s = bad.get(e.r);
			if (!s) bad.set(e.r, (s = new Set()));
			s.add(e.i).add(e.j);
		};
		for (let s = 0; s < edges.length; s++) {
			const e = edges[s]!;
			for (let t = s + 1; t < edges.length && edges[t]!.x0 <= e.x1; t++) {
				const f = edges[t]!;
				if (f.y0 > e.y1 || f.y1 < e.y0) continue;
				if (e.r === f.r) {
					if (e.i === f.j || e.j === f.i) continue;
					if (
						(Math.abs(e.ax - f.bx) < SAME_PT && Math.abs(e.ay - f.by) < SAME_PT) ||
						(Math.abs(e.bx - f.ax) < SAME_PT && Math.abs(e.by - f.ay) < SAME_PT)
					)
						continue;
				}
				if (meets(e.ax, e.ay, e.bx, e.by, f.ax, f.ay, f.bx, f.by)) {
					mark(e);
					mark(f);
				}
			}
		}
		if (!bad.size) return;
		const pin = round >= UNTANGLE_STEPS;
		let moved = false;
		for (const [r, verts] of bad)
			for (const k of verts) {
				const cur = Math.min(-d * r.scale, r.maxIn[k]!);
				if (cur <= 0) continue;
				moved = true;
				r.maxIn[k] = pin ? 0 : cur / 2;
			}
		if (!moved) return;
	}
}

/** A flat cap at `z` facing `nz` over a ring set (outer first, then its holes), triangulated on its own points. */
function emitCap(
	b: MeshBuilder,
	rings: readonly P[][],
	slot: number,
	z: number,
	nz: number,
	uvOf: (p: P) => P,
): void {
	const flat: number[] = [];
	const holes: number[] = [];
	rings.forEach((r, k) => {
		if (k > 0) holes.push(flat.length / 2);
		for (const p of r) flat.push(p[0], p[1]);
	});
	const tris = earcut(flat, holes);
	const pts = rings.flat();
	const ids = pts.map((p) => {
		const uv = uvOf(p);
		return b.vertex(p[0], p[1], z, 0, 0, nz, uv[0], uv[1], slot);
	});
	for (let t = 0; t < tris.length; t += 3) b.tri(ids[tris[t]!]!, ids[tris[t + 1]!]!, ids[tris[t + 2]!]!);
}

/** Quad strips between profile points A and B along every ring. */
function emitStrip(
	b: MeshBuilder,
	rings: readonly Ring[],
	uvs: readonly P[][],
	slot: number,
	A: ProfilePoint,
	B: ProfilePoint,
): void {
	const nf = norm2([B.z - A.z, -(B.off - A.off)]); // faceted (radial, z)
	const nA = A.n ?? nf;
	const nB = B.n ?? nf;
	rings.forEach((r, ri) => {
		const n = r.pts.length;
		const uv = uvs[ri]!;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ni = r.crease[i] ? r.edgeN[i]! : r.smoothN[i]!;
			const nj = r.crease[j] ? r.edgeN[i]! : r.smoothN[j]!;
			const iA = posOf(r, i, A.off);
			const jA = posOf(r, j, A.off);
			const iB = posOf(r, i, B.off);
			const jB = posOf(r, j, B.off);
			const a0 = b.vertex(
				iA[0],
				iA[1],
				A.z,
				ni[0] * nA[0],
				ni[1] * nA[0],
				nA[1],
				uv[i]![0],
				uv[i]![1],
				slot,
			);
			const a1 = b.vertex(
				jA[0],
				jA[1],
				A.z,
				nj[0] * nA[0],
				nj[1] * nA[0],
				nA[1],
				uv[j]![0],
				uv[j]![1],
				slot,
			);
			const b1 = b.vertex(
				jB[0],
				jB[1],
				B.z,
				nj[0] * nB[0],
				nj[1] * nB[0],
				nB[1],
				uv[j]![0],
				uv[j]![1],
				slot,
			);
			const b0 = b.vertex(
				iB[0],
				iB[1],
				B.z,
				ni[0] * nB[0],
				ni[1] * nB[0],
				nB[1],
				uv[i]![0],
				uv[i]![1],
				slot,
			);
			b.tri(a0, a1, b1);
			b.tri(a0, b1, b0);
		}
	});
}

/** Most steps of a wavefront. */
const MAX_WAVE_STEPS = 96;

/** Inward travels the wave stops at: every profile offset, and enough between them to see edges collapse in order. */
function waveSteps(offs: readonly number[], deepest: number): number[] {
	const out = new Set<number>([0]);
	for (const o of offs) if (o < 0) out.add(-o);
	const fine = Math.max(deepest / MAX_WAVE_STEPS, 0.5);
	for (let t = fine; t < deepest; t += fine) out.add(t);
	return [...out].sort((a, b) => a - b);
}

/** Loop oriented so (dy, −dx) points out of the solid. */
function oriented(loop: readonly P[], hole: boolean): P[] {
	let s = 0;
	for (let i = 0; i < loop.length; i++) {
		const a = loop[i]!;
		const b = loop[(i + 1) % loop.length]!;
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s > 0 !== hole ? [...loop] : [...loop].reverse();
}

/** Every shape extruded per `spec` into the builder. */
export function extrudeSolid(b: MeshBuilder, shapes: readonly Shape2D[], spec: SolidSpec): void {
	const offs = [spec.cap.off, ...spec.spans.flatMap((s) => [s.a.off, s.b.off])];
	const deepest = Math.max(0, ...offs.map((o) => -o));
	const steps = waveSteps(offs, deepest);
	const last = spec.spans.length ? spec.spans[spec.spans.length - 1]!.b : spec.cap;
	const holeScale = Math.max(0, spec.holeScale ?? 1);
	for (const shape of shapes) {
		const rings = [
			makeRing(oriented(shape.outer, false), 1),
			...shape.holes.map((h) => makeRing(oriented(h, true), holeScale)),
		];
		for (const r of rings) waveOf(r, r.scale === 1 ? steps : steps.map((t) => t * r.scale));
		computeLimits(rings);
		untangle(rings, spec.cap.off);
		untangle(rings, last.off);
		const uvs = rings.map((r) =>
			r.pts.map((p, i): P => {
				const n = r.smoothN[i]!;
				return spec.colourAt ? spec.colourAt(p[0], p[1], n[0], n[1]) : [p[0] - n[0] * 1.5, p[1] - n[1] * 1.5];
			}),
		);
		const ringPts = (off: number): P[][] =>
			rings.map((r) =>
				r.pts.map((_, i): P => {
					const q = posOf(r, i, off);
					return [q[0], q[1]];
				}),
			);
		const colourOfCap = (p: P): P =>
			spec.colourAt && spec.capColour ? spec.colourAt(p[0], p[1], 0, 0) : p;
		emitCap(b, ringPts(spec.cap.off), spec.cap.slot, spec.cap.z, -1, colourOfCap);
		emitCap(b, ringPts(last.off), spec.backSlot, spec.zBack, 1, colourOfCap);
		for (const s of spec.spans) emitStrip(b, rings, uvs, s.slot, s.a, s.b);
		if (spec.zBack - last.z > 1e-4)
			emitStrip(
				b,
				rings,
				uvs,
				spec.wallSlot,
				{ off: last.off, z: last.z, n: [1, 0] },
				{ off: last.off, z: spec.zBack, n: [1, 0] },
			);
	}
}
