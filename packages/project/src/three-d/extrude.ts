// Extruded geometry of the Advanced 3D renderer (three-d, docs/wp-notes/three-d.md): After Effects' Geometry Options
// for text and shape layers (Extrusion Depth, Bevel Style None / Angular / Concave / Convex, Bevel Depth, Hole Bevel
// Depth). The outline comes from the layer's own picture — the alpha traced at 50 % with marching squares (sub-pixel
// edge positions, saddles split by the cell average), simplified (Douglas–Peucker) and sorted into outlines and holes
// by nesting — so whatever the layer draws (any font, stroke, path, animator) is what gets extruded, exactly where
// its 2D picture is. The front face is triangulated (triangulate.ts), offset inwards by the bevel; bevel rings follow
// the profile; the side walls join the front and back bevels; the back face closes the solid.
//
// Coordinates: layer space (pixels, x right, y down), extrusion along +z (away from the viewer, as After Effects:
// the front face stays on the layer's plane).
import type { BevelStyle } from '../schema/three-d.ts';
import { earcut } from './triangulate.ts';

type P = [number, number];

/** Closed outlines (picture px) of the pixels whose alpha ≥ `threshold`. `alpha(x, y)` in 0..255. */
export function traceContours(
	width: number,
	height: number,
	alpha: (x: number, y: number) => number,
	threshold = 127.5,
): P[][] {
	const v = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : alpha(x, y));
	// Edge points: horizontal edge (i, j)-(i+1, j) → key 2·(j·W2 + i); vertical (i, j)-(i, j+1) → key + 1.
	const W2 = width + 2;
	const key = (i: number, j: number, vertical: boolean) => 2 * ((j + 1) * W2 + (i + 1)) + (vertical ? 1 : 0);
	const pos = new Map<number, P>();
	const adj = new Map<number, number[]>();
	const link = (a: number, b: number) => {
		(adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
		(adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
	};
	const cross = (ax: number, ay: number, va: number, bx: number, by: number, vb: number): P => {
		const t = va === vb ? 0.5 : (threshold - va) / (vb - va);
		return [ax + (bx - ax) * t + 0.5, ay + (by - ay) * t + 0.5];
	};
	for (let j = -1; j < height; j++)
		for (let i = -1; i < width; i++) {
			const tl = v(i, j);
			const tr = v(i + 1, j);
			const br = v(i + 1, j + 1);
			const bl = v(i, j + 1);
			const c =
				(tl >= threshold ? 8 : 0) |
				(tr >= threshold ? 4 : 0) |
				(br >= threshold ? 2 : 0) |
				(bl >= threshold ? 1 : 0);
			if (c === 0 || c === 15) continue;
			const T = key(i, j, false);
			const B = key(i, j + 1, false);
			const L = key(i, j, true);
			const R = key(i + 1, j, true);
			const at = (k: number) => {
				if (pos.has(k)) return;
				if (k === T) pos.set(k, cross(i, j, tl, i + 1, j, tr));
				else if (k === B) pos.set(k, cross(i, j + 1, bl, i + 1, j + 1, br));
				else if (k === L) pos.set(k, cross(i, j, tl, i, j + 1, bl));
				else pos.set(k, cross(i + 1, j, tr, i + 1, j + 1, br));
			};
			const seg = (a: number, b: number) => {
				at(a);
				at(b);
				link(a, b);
			};
			const centre = (tl + tr + br + bl) / 4 >= threshold;
			switch (c) {
				case 1:
				case 14:
					seg(L, B);
					break;
				case 2:
				case 13:
					seg(B, R);
					break;
				case 3:
				case 12:
					seg(L, R);
					break;
				case 4:
				case 11:
					seg(T, R);
					break;
				case 6:
				case 9:
					seg(T, B);
					break;
				case 7:
				case 8:
					seg(T, L);
					break;
				case 5:
					if (centre) {
						seg(T, L);
						seg(B, R);
					} else {
						seg(T, R);
						seg(L, B);
					}
					break;
				case 10:
					if (centre) {
						seg(T, R);
						seg(L, B);
					} else {
						seg(T, L);
						seg(B, R);
					}
					break;
			}
		}
	const loops: P[][] = [];
	const seen = new Set<number>();
	for (const start of adj.keys()) {
		if (seen.has(start)) continue;
		const loop: P[] = [];
		let prev = -1;
		let cur = start;
		while (!seen.has(cur)) {
			seen.add(cur);
			loop.push(pos.get(cur)!);
			const n = adj.get(cur)!;
			const next = n[0] !== prev ? n[0]! : n[1]!;
			prev = cur;
			cur = next;
			if (cur === undefined) break;
		}
		if (loop.length >= 3) loops.push(loop);
	}
	return loops;
}

/** Signed area (Σ xᵢ yᵢ₊₁ − xᵢ₊₁ yᵢ) / 2. */
export function loopArea(p: readonly P[]): number {
	let s = 0;
	for (let i = 0; i < p.length; i++) {
		const a = p[i]!;
		const b = p[(i + 1) % p.length]!;
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s / 2;
}

/** Douglas–Peucker simplification of a closed loop. */
export function simplifyLoop(p: readonly P[], tolerance: number): P[] {
	const n = p.length;
	if (n < 4) return [...p];
	// Split at the point farthest from the first one.
	let far = 0;
	let best = -1;
	for (let i = 1; i < n; i++) {
		const d = (p[i]![0] - p[0]![0]) ** 2 + (p[i]![1] - p[0]![1]) ** 2;
		if (d > best) {
			best = d;
			far = i;
		}
	}
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[far] = 1;
	const t2 = tolerance * tolerance;
	const stack: [number, number][] = [
		[0, far],
		[far, n],
	];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const A = p[a % n]!;
		const B = p[b % n]!;
		const dx = B[0] - A[0];
		const dy = B[1] - A[1];
		const l2 = dx * dx + dy * dy;
		let worst = -1;
		let wi = -1;
		for (let i = a + 1; i < b; i++) {
			const q = p[i]!;
			const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / l2)) : 0;
			const d = (q[0] - A[0] - t * dx) ** 2 + (q[1] - A[1] - t * dy) ** 2;
			if (d > worst) {
				worst = d;
				wi = i;
			}
		}
		if (wi >= 0 && worst > t2) {
			keep[wi] = 1;
			stack.push([a, wi], [wi, b]);
		}
	}
	const out: P[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]!);
	return out;
}

function inside(pt: P, loop: readonly P[]): boolean {
	let c = false;
	for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
		const a = loop[i]!;
		const b = loop[j]!;
		if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0])
			c = !c;
	}
	return c;
}

/** An outline with its holes. */
export type Shape2D = { outer: P[]; holes: P[][] };

/** Sorts loops into outlines and holes by nesting (even depth = outline, odd = hole of the enclosing outline). */
export function nestLoops(loops: readonly P[][]): Shape2D[] {
	const depth = loops.map((l, i) => loops.reduce((d, m, k) => (k !== i && inside(l[0]!, m) ? d + 1 : d), 0));
	const shapes = new Map<number, Shape2D>();
	loops.forEach((l, i) => {
		if (depth[i]! % 2 === 0) shapes.set(i, { outer: l, holes: [] });
	});
	loops.forEach((l, i) => {
		if (depth[i]! % 2 === 0) return;
		// The enclosing outline one level up with the smallest area.
		let owner = -1;
		let ownerArea = Number.POSITIVE_INFINITY;
		loops.forEach((m, k) => {
			if (depth[k] !== depth[i]! - 1 || !inside(l[0]!, m)) return;
			const a = Math.abs(loopArea(m));
			if (a < ownerArea) {
				ownerArea = a;
				owner = k;
			}
		});
		if (owner >= 0) shapes.get(owner)!.holes.push(l);
	});
	return [...shapes.values()];
}

export type ExtrudeOptions = {
	depth: number;
	bevelStyle: BevelStyle;
	bevelDepth: number;
	/** Hole Bevel Depth (% of the bevel depth). */
	holeBevel: number;
};

/**
 * A triangle mesh: per vertex position (3), normal (3), uv (2, layer px of the colour to show) and kind (1: 0 = a
 * face, textured by the picture at `uv`; 1 = a wall or bevel, the opaque colour at `uv`). Indices, three per triangle.
 */
export type Mesh = { vertices: Float32Array; indices: Uint32Array; stride: 9 };

/** The bevel profile at t ∈ [0, 1] (front edge → full outline): inward offset and depth, as fractions of the bevel. */
function profile(style: BevelStyle, t: number): { inset: number; z: number; dInset: number; dz: number } {
	if (style === 'convex') {
		const th = (t * Math.PI) / 2;
		return { inset: 1 - Math.sin(th), z: 1 - Math.cos(th), dInset: -Math.cos(th), dz: Math.sin(th) };
	}
	if (style === 'concave') {
		const th = (t * Math.PI) / 2;
		return { inset: Math.cos(th), z: Math.sin(th), dInset: -Math.sin(th), dz: Math.cos(th) };
	}
	return { inset: 1 - t, z: t, dInset: -1, dz: 1 };
}

/** Outward unit normals at the vertices of a loop of the solid (holes: pointing into the hole), with miter offsets. */
function ringOf(loop: readonly P[], hole: boolean): { pts: P[]; normals: P[]; miter: P[]; hard: boolean[] } {
	const n = loop.length;
	const s = (loopArea(loop) > 0 ? 1 : -1) * (hole ? -1 : 1);
	const en: P[] = [];
	for (let i = 0; i < n; i++) {
		const a = loop[i]!;
		const b = loop[(i + 1) % n]!;
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const l = Math.hypot(dx, dy) || 1;
		en.push([(s * dy) / l, (-s * dx) / l]);
	}
	const normals: P[] = [];
	const miter: P[] = [];
	const hard: boolean[] = [];
	for (let i = 0; i < n; i++) {
		const n1 = en[(i - 1 + n) % n]!;
		const n2 = en[i]!;
		const sx = n1[0] + n2[0];
		const sy = n1[1] + n2[1];
		const l = Math.hypot(sx, sy) || 1;
		normals.push([sx / l, sy / l]);
		const c = 1 + n1[0] * n2[0] + n1[1] * n2[1];
		const k = c > 0.25 ? 2 / c : 8;
		miter.push([(sx / 2) * Math.min(k, 3), (sy / 2) * Math.min(k, 3)]);
		hard.push(n1[0] * n2[0] + n1[1] * n2[1] < Math.cos((35 * Math.PI) / 180));
	}
	return { pts: [...loop], normals, miter, hard };
}

/** The extruded solid of shapes (layer px); wall vertices take their colour from 1.5 px inside the outline. */
export function extrudeShapes(shapes: readonly Shape2D[], o: ExtrudeOptions): Mesh {
	const verts: number[] = [];
	const idx: number[] = [];
	const D = Math.max(0, o.depth);
	const push = (
		x: number,
		y: number,
		z: number,
		nx: number,
		ny: number,
		nz: number,
		u: number,
		v: number,
		kind: number,
	) => {
		verts.push(x, y, z, nx, ny, nz, u, v, kind);
		return verts.length / 9 - 1;
	};
	const steps = o.bevelStyle === 'none' ? 0 : o.bevelStyle === 'angular' ? 1 : 6;
	for (const shape of shapes) {
		const loops = [shape.outer, ...shape.holes];
		const rings = loops.map((l, k) => ringOf(l, k > 0));
		const bevelOf = (k: number) => {
			if (steps === 0) return 0;
			const b = Math.max(0, o.bevelDepth) * (k > 0 ? Math.max(0, o.holeBevel) / 100 : 1);
			return Math.min(b, D / 2);
		};
		// Faces: the triangulation of the outline, offset inwards by the bevel (front at z 0, back at z D).
		const flat: number[] = [];
		const holeStarts: number[] = [];
		const faceRing: P[] = [];
		rings.forEach((r, k) => {
			if (k > 0) holeStarts.push(flat.length / 2);
			const b = bevelOf(k);
			for (let i = 0; i < r.pts.length; i++) {
				const p: P = [r.pts[i]![0] - r.miter[i]![0] * b, r.pts[i]![1] - r.miter[i]![1] * b];
				faceRing.push(p);
				flat.push(r.pts[i]![0], r.pts[i]![1]);
			}
		});
		const tris = earcut(flat, holeStarts);
		const front = faceRing.map((p) => push(p[0], p[1], 0, 0, 0, -1, p[0], p[1], 0));
		for (let t = 0; t < tris.length; t += 3)
			idx.push(front[tris[t]!]!, front[tris[t + 1]!]!, front[tris[t + 2]!]!);
		if (D <= 0) continue;
		const back = faceRing.map((p) => push(p[0], p[1], D, 0, 0, 1, p[0], p[1], 0));
		for (let t = 0; t < tris.length; t += 3)
			idx.push(back[tris[t]!]!, back[tris[t + 2]!]!, back[tris[t + 1]!]!);
		// Walls: profile stations from the front edge to the back edge.
		rings.forEach((r, k) => {
			const b = bevelOf(k);
			const st: { inset: number; z: number; nIn: number; nz: number }[] = [];
			const add = (inset: number, z: number, dInset: number, dz: number) => {
				// Profile tangent (−dInset along the outward normal, dz along z) → outward normal (dz, +dInset·…).
				const a = -dInset;
				const l = Math.hypot(a, dz) || 1;
				st.push({ inset, z, nIn: dz / l, nz: -a / l });
			};
			if (b > 0) {
				for (let s = 0; s <= steps; s++) {
					const q = profile(o.bevelStyle, s / steps);
					add(q.inset * b, q.z * b, q.dInset * b, q.dz * b);
				}
				for (let s = steps; s >= 0; s--) {
					const q = profile(o.bevelStyle, s / steps);
					const e = { inset: q.inset * b, z: D - q.z * b, dInset: -q.dInset * b, dz: q.dz * b };
					add(e.inset, e.z, e.dInset, e.dz);
				}
			} else {
				add(0, 0, 0, 1);
				add(0, D, 0, 1);
			}
			const n = r.pts.length;
			for (let s = 0; s + 1 < st.length; s++) {
				const A = st[s]!;
				const B = st[s + 1]!;
				if (Math.abs(A.z - B.z) < 1e-9 && Math.abs(A.inset - B.inset) < 1e-9) continue;
				for (let i = 0; i < n; i++) {
					const j = (i + 1) % n;
					// Edge normal for hard corners, vertex normals for smooth ones.
					const ex = r.pts[j]![0] - r.pts[i]![0];
					const ey = r.pts[j]![1] - r.pts[i]![1];
					const el = Math.hypot(ex, ey) || 1;
					const sgn = (loopArea(r.pts) > 0 ? 1 : -1) * (k > 0 ? -1 : 1);
					const edgeN: P = [(sgn * ey) / el, (-sgn * ex) / el];
					const nI = r.hard[i] ? edgeN : r.normals[i]!;
					const nJ = r.hard[j] ? edgeN : r.normals[j]!;
					const corner = (vi: number, nv: P, S: typeof A) => {
						const p = r.pts[vi]!;
						const m = r.miter[vi]!;
						const x = p[0] - m[0] * S.inset;
						const y = p[1] - m[1] * S.inset;
						// The colour of a wall comes from just inside the outline.
						const u = p[0] - r.normals[vi]![0] * 1.5;
						const v = p[1] - r.normals[vi]![1] * 1.5;
						return push(x, y, S.z, nv[0] * S.nIn, nv[1] * S.nIn, S.nz, u, v, 1);
					};
					const a0 = corner(i, nI, A);
					const a1 = corner(j, nJ, A);
					const b0 = corner(i, nI, B);
					const b1 = corner(j, nJ, B);
					idx.push(a0, b0, a1, a1, b0, b1);
				}
			}
		});
	}
	return { vertices: Float32Array.from(verts), indices: Uint32Array.from(idx), stride: 9 };
}

/** Outlines of a picture's alpha (picture px), simplified, small specks dropped, sorted into shapes. */
export function shapesOfAlpha(
	width: number,
	height: number,
	alpha: (x: number, y: number) => number,
	opts: { tolerance?: number; minArea?: number } = {},
): Shape2D[] {
	const loops = traceContours(width, height, alpha)
		.map((l) => simplifyLoop(l, opts.tolerance ?? 0.35))
		.filter((l) => l.length >= 3 && Math.abs(loopArea(l)) >= (opts.minArea ?? 2));
	return nestLoops(loops);
}
