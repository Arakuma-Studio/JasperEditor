// Puppet meshes (sim-warp workstream): an outline → constrained triangulation with density control, and the outline
// of an alpha region (threshold 50 %, grown or shrunk by Expansion with an exact Euclidean distance transform —
// Felzenszwalb & Huttenlocher, "Distance Transforms of Sampled Functions" —, the 4-connected region under a seed with
// holes filled, traced along pixel cracks and simplified with Douglas–Peucker). Interior points on a jittered
// hexagonal lattice, Bowyer–Watson Delaunay, constraint edges recovered by flips, triangles outside dropped.
// Ported from EffectCraft crates/effects/src/puppet/mesh.rs (MIT OR Apache-2.0); see licenses/ported/sim-warp.md.

export type Pt = [number, number];
/** A triangle mesh (CCW triangles in y-down coordinates: cross(b − a, c − a) > 0). */
export type PuppetMeshGeometry = { verts: Pt[]; tris: [number, number, number][]; outline: Pt[] };
export type MeshOpts = { triangles: number; density: number; expansion: number };
export const DEFAULT_MESH_OPTS: MeshOpts = { triangles: 350, density: 50, expansion: 3 };

export type Grid = { w: number; h: number; on: Uint8Array };
const at = (g: Grid, x: number, y: number) =>
	x >= 0 && y >= 0 && x < g.w && y < g.h && g.on[y * g.w + x] === 1;

export const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const dist2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function dt1(f: Float64Array, out: Float64Array): void {
	const n = f.length;
	if (n === 0) return;
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	let k = 0;
	z[0] = Number.NEGATIVE_INFINITY;
	z[1] = Number.POSITIVE_INFINITY;
	const inter = (q: number, p: number) => (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
	for (let q = 1; q < n; q++) {
		let s = inter(q, v[k]!);
		while (s <= z[k]!) {
			k--;
			s = inter(q, v[k]!);
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Number.POSITIVE_INFINITY;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1]! < q) k++;
		const p = v[k]!;
		out[q] = (q - p) ** 2 + f[p]!;
	}
}

/** Squared Euclidean distance of every cell to the nearest `src` cell. */
export function distanceSq(w: number, h: number, src: Uint8Array): Float64Array {
	const inf = 1e20;
	const g = new Float64Array(w * h);
	const col = new Float64Array(h);
	const colo = new Float64Array(h);
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) col[y] = src[y * w + x] ? 0 : inf;
		dt1(col, colo);
		for (let y = 0; y < h; y++) g[y * w + x] = colo[y]!;
	}
	const out = new Float64Array(w * h);
	const row = new Float64Array(w);
	for (let y = 0; y < h; y++) {
		dt1(g.subarray(y * w, (y + 1) * w), row);
		out.set(row, y * w);
	}
	return out;
}

export function expand(g: Grid, e: number): Grid {
	if (Math.abs(e) < 1e-9) return g;
	if (e > 0) {
		const d = distanceSq(g.w, g.h, g.on);
		return { w: g.w, h: g.h, on: Uint8Array.from(d, (v) => (v <= e * e ? 1 : 0)) };
	}
	const off = Uint8Array.from(g.on, (b) => (b ? 0 : 1));
	const d = distanceSq(g.w, g.h, off);
	return { w: g.w, h: g.h, on: Uint8Array.from(d, (v, i) => (g.on[i] && v > e * e ? 1 : 0)) };
}

/** The 4-connected region containing (or nearest to) `seed`, with holes filled. */
export function region(g: Grid, seed: Pt): Grid | null {
	const { w, h } = g;
	if (w === 0 || h === 0) return null;
	const sx = Math.min(w - 1, Math.max(0, Math.floor(seed[0])));
	const sy = Math.min(h - 1, Math.max(0, Math.floor(seed[1])));
	let start: Pt | null = at(g, sx, sy) ? [sx, sy] : null;
	if (!start) {
		let best = Number.POSITIVE_INFINITY;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				if (g.on[y * w + x]) {
					const d = (x - sx) ** 2 + (y - sy) ** 2;
					if (d < best) {
						best = d;
						start = [x, y];
					}
				}
	}
	if (!start) return null;
	const on = new Uint8Array(w * h);
	const q: number[] = [start[1] * w + start[0]];
	on[q[0]!] = 1;
	for (let qi = 0; qi < q.length; qi++) {
		const i = q[qi]!;
		const x = i % w;
		const y = (i - x) / w;
		for (const [nx, ny] of [
			[x - 1, y],
			[x + 1, y],
			[x, y - 1],
			[x, y + 1],
		] as const)
			if (at(g, nx, ny) && !on[ny * w + nx]) {
				on[ny * w + nx] = 1;
				q.push(ny * w + nx);
			}
	}
	// Fill holes: everything not reachable from the border through off-cells.
	const outside = new Uint8Array(w * h);
	const q2: number[] = [];
	const seedOut = (x: number, y: number) => {
		const i = y * w + x;
		if (!on[i] && !outside[i]) {
			outside[i] = 1;
			q2.push(i);
		}
	};
	for (let x = 0; x < w; x++) {
		seedOut(x, 0);
		seedOut(x, h - 1);
	}
	for (let y = 0; y < h; y++) {
		seedOut(0, y);
		seedOut(w - 1, y);
	}
	for (let qi = 0; qi < q2.length; qi++) {
		const i = q2[qi]!;
		const x = i % w;
		const y = (i - x) / w;
		for (const [nx, ny] of [
			[x - 1, y],
			[x + 1, y],
			[x, y - 1],
			[x, y + 1],
		] as const)
			if (nx >= 0 && ny >= 0 && nx < w && ny < h) seedOut(nx, ny);
	}
	return { w, h, on: Uint8Array.from(outside, (o) => (o ? 0 : 1)) };
}

export function signedArea(p: readonly Pt[]): number {
	let a = 0;
	for (let i = 0; i < p.length; i++) {
		const u = p[i]!;
		const v = p[(i + 1) % p.length]!;
		a += u[0] * v[1] - v[0] * u[1];
	}
	return a / 2;
}

/** The outer boundary of a hole-free region along pixel cracks (a closed polygon through pixel corners). */
export function trace(g: Grid): Pt[] {
	const next = new Map<number, number[]>();
	const key = (x: number, y: number) => y * (g.w + 2) + x;
	const push = (a: [number, number], b: [number, number]) => {
		const k = key(a[0], a[1]);
		const l = next.get(k);
		if (l) l.push(key(b[0], b[1]));
		else next.set(k, [key(b[0], b[1])]);
	};
	for (let y = 0; y < g.h; y++)
		for (let x = 0; x < g.w; x++) {
			if (!at(g, x, y)) continue;
			if (!at(g, x, y - 1)) push([x, y], [x + 1, y]);
			if (!at(g, x + 1, y)) push([x + 1, y], [x + 1, y + 1]);
			if (!at(g, x, y + 1)) push([x + 1, y + 1], [x, y + 1]);
			if (!at(g, x - 1, y)) push([x, y + 1], [x, y]);
		}
	const W = g.w + 2;
	const xy = (k: number): Pt => [k % W, Math.floor(k / W)];
	let best: Pt[] = [];
	let bestArea = 0;
	const keys = [...next.keys()].sort((a, b) => a - b);
	for (const start of keys) {
		if (!next.get(start)?.length) continue;
		const lp: number[] = [start];
		let cur = start;
		let dir: Pt = [0, 0];
		let guard = 0;
		for (;;) {
			if (++guard > 4 * (g.w + 2) * (g.h + 2)) break;
			const outs = next.get(cur);
			if (!outs?.length) break;
			let k = 0;
			if (outs.length > 1 && (dir[0] !== 0 || dir[1] !== 0)) {
				// At a saddle corner take the right-most turn relative to the incoming direction.
				let bestScore = Number.NEGATIVE_INFINITY;
				const c = xy(cur);
				outs.forEach((o, i) => {
					const p = xy(o);
					const d = [p[0] - c[0], p[1] - c[1]];
					const s = dir[0] * d[1]! - dir[1] * d[0]!;
					if (s > bestScore) {
						bestScore = s;
						k = i;
					}
				});
			}
			const nx = outs.splice(k, 1)[0]!;
			const a = xy(cur);
			const b = xy(nx);
			dir = [b[0] - a[0], b[1] - a[1]];
			cur = nx;
			if (cur === start) break;
			lp.push(cur);
		}
		const pts = lp.map(xy);
		const ar = Math.abs(signedArea(pts));
		if (ar > bestArea) {
			bestArea = ar;
			best = pts;
		}
	}
	if (best.length < 3) return best;
	return best.filter(
		(b, i) =>
			Math.abs(cross(best[(i + best.length - 1) % best.length]!, b, best[(i + 1) % best.length]!)) > 1e-12,
	);
}

function segDist2(p: Pt, a: Pt, b: Pt): number {
	const ab: Pt = [b[0] - a[0], b[1] - a[1]];
	const l = ab[0] * ab[0] + ab[1] * ab[1];
	const t = l > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l)) : 0;
	return dist2(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}

/** Douglas–Peucker simplification of a closed polygon. */
export function simplify(p: readonly Pt[], tol: number): Pt[] {
	const n = p.length;
	if (n <= 4) return [...p];
	let far = 1;
	for (let i = 1; i < n; i++) if (dist2(p[0]!, p[i]!) > dist2(p[0]!, p[far]!)) far = i;
	const ext = [...p, p[0]!];
	const keep = new Uint8Array(n + 1);
	keep[0] = 1;
	keep[far] = 1;
	const stack: [number, number][] = [
		[0, far],
		[far, n],
	];
	const tol2 = tol * tol;
	while (stack.length) {
		const [a, b] = stack.pop()!;
		if (b <= a + 1) continue;
		let bd = 0;
		let bi = 0;
		for (let i = a + 1; i < b; i++) {
			const d = segDist2(ext[i]!, ext[a]!, ext[b]!);
			if (d > bd) {
				bd = d;
				bi = i;
			}
		}
		if (bd > tol2) {
			keep[bi] = 1;
			stack.push([a, bi], [bi, b]);
		}
	}
	return p.filter((_, i) => keep[i]);
}

/** Splits polygon edges so none is longer than `maxLen`. */
export function densify(p: readonly Pt[], maxLen: number): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i < p.length; i++) {
		const a = p[i]!;
		const b = p[(i + 1) % p.length]!;
		out.push(a);
		const k = Math.ceil(Math.sqrt(dist2(a, b)) / Math.max(maxLen, 1e-6));
		for (let j = 1; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
	}
	return out;
}

/** Even-odd point in polygon. */
export function inside(poly: readonly Pt[], p: Pt): boolean {
	let c = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]!;
		const b = poly[j]!;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
	}
	return c;
}

function polyDist2(poly: readonly Pt[], p: Pt): number {
	let m = Number.POSITIVE_INFINITY;
	for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist2(p, poly[i]!, poly[(i + 1) % poly.length]!));
	return m;
}

function inCircle(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
	const [ax, ay] = [a[0] - d[0], a[1] - d[1]];
	const [bx, by] = [b[0] - d[0], b[1] - d[1]];
	const [cx, cy] = [c[0] - d[0], c[1] - d[1]];
	const la = ax * ax + ay * ay;
	const lb = bx * bx + by * by;
	const lc = cx * cx + cy * cy;
	const det = la * (bx * cy - cx * by) - lb * (ax * cy - cx * ay) + lc * (ax * by - bx * ay);
	const m = Math.max(la, lb, lc);
	return det > 1e-12 * m * m;
}

const orient = (v: readonly Pt[], t: [number, number, number]): [number, number, number] =>
	cross(v[t[0]]!, v[t[1]]!, v[t[2]]!) < 0 ? [t[0], t[2], t[1]] : t;

/** Bowyer–Watson Delaunay triangulation (CCW triangles). */
export function delaunay(pts: readonly Pt[]): [number, number, number][] {
	const n = pts.length;
	if (n < 3) return [];
	let [x0, y0, x1, y1] = [
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];
	for (const p of pts) {
		x0 = Math.min(x0, p[0]);
		y0 = Math.min(y0, p[1]);
		x1 = Math.max(x1, p[0]);
		y1 = Math.max(y1, p[1]);
	}
	const d = Math.max(x1 - x0, y1 - y0, 1) * 20;
	const cx = (x0 + x1) / 2;
	const cy = (y0 + y1) / 2;
	const v: Pt[] = [...pts, [cx - d, cy - d], [cx + d, cy - d], [cx, cy + d]];
	let tris: [number, number, number][] = [orient(v, [n, n + 1, n + 2])];
	for (let i = 0; i < n; i++) {
		const p = v[i]!;
		let bad: number[] = [];
		tris.forEach((t, k) => {
			if (inCircle(v[t[0]]!, v[t[1]]!, v[t[2]]!, p)) bad.push(k);
		});
		if (bad.length === 0) {
			const k = tris.findIndex(
				(t) =>
					cross(v[t[0]]!, v[t[1]]!, p) >= 0 &&
					cross(v[t[1]]!, v[t[2]]!, p) >= 0 &&
					cross(v[t[2]]!, v[t[0]]!, p) >= 0,
			);
			if (k < 0) continue;
			bad = [k];
		}
		const count = new Map<string, number>();
		const ek = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
		for (const k of bad) {
			const t = tris[k]!;
			for (const [a, b] of [
				[t[0], t[1]],
				[t[1], t[2]],
				[t[2], t[0]],
			] as const)
				count.set(ek(a, b), (count.get(ek(a, b)) ?? 0) + 1);
		}
		const edges: [number, number][] = [];
		for (const k of bad) {
			const t = tris[k]!;
			for (const [a, b] of [
				[t[0], t[1]],
				[t[1], t[2]],
				[t[2], t[0]],
			] as const)
				if (count.get(ek(a, b)) === 1) edges.push([a, b]);
		}
		const badSet = new Set(bad);
		tris = tris.filter((_, k) => !badSet.has(k));
		for (const [a, b] of edges) if (Math.abs(cross(v[a]!, v[b]!, p)) > 1e-12) tris.push(orient(v, [a, b, i]));
	}
	return tris.filter((t) => t.every((i) => i < n));
}

function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
	const d1 = cross(a, b, c);
	const d2 = cross(a, b, d);
	const d3 = cross(c, d, a);
	const d4 = cross(c, d, b);
	return (
		((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) &&
		((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))
	);
}

/** Recovers constraint edges in a triangulation by flipping crossing edges. */
export function recoverEdges(
	v: readonly Pt[],
	tris: [number, number, number][],
	constraints: readonly [number, number][],
): void {
	const ek = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
	const edgeTris = new Map<string, number[]>();
	const addTri = (k: number) => {
		const t = tris[k]!;
		for (const [a, b] of [
			[t[0], t[1]],
			[t[1], t[2]],
			[t[2], t[0]],
		] as const) {
			const l = edgeTris.get(ek(a, b));
			if (l) l.push(k);
			else edgeTris.set(ek(a, b), [k]);
		}
	};
	const removeTri = (k: number) => {
		const t = tris[k]!;
		for (const [a, b] of [
			[t[0], t[1]],
			[t[1], t[2]],
			[t[2], t[0]],
		] as const) {
			const l = edgeTris.get(ek(a, b));
			if (l) {
				const idx = l.indexOf(k);
				if (idx >= 0) l.splice(idx, 1);
				if (l.length === 0) edgeTris.delete(ek(a, b));
			}
		}
	};
	for (let k = 0; k < tris.length; k++) addTri(k);
	const fixed = new Set(constraints.map(([a, b]) => ek(a, b)));
	const parse = (s: string): [number, number] => s.split(',').map(Number) as [number, number];
	for (const [a, b] of constraints) {
		if (edgeTris.get(ek(a, b))?.length) continue;
		const queue: string[] = [...edgeTris.entries()]
			.filter(
				([e, t]) =>
					t.length === 2 &&
					(() => {
						const [p, q] = parse(e);
						return segCross(v[a]!, v[b]!, v[p]!, v[q]!);
					})(),
			)
			.map(([e]) => e)
			.sort();
		let guard = 0;
		while (queue.length) {
			if (++guard > 20000) break;
			const e = queue.shift()!;
			const ts = edgeTris.get(e);
			if (ts?.length !== 2 || fixed.has(e)) continue;
			const [u, w] = parse(e);
			const t0 = tris[ts[0]!]!;
			const t1 = tris[ts[1]!]!;
			const p = t0.find((x) => x !== u && x !== w);
			const q = t1.find((x) => x !== u && x !== w);
			if (p === undefined || q === undefined) continue;
			if (!segCross(v[p]!, v[q]!, v[u]!, v[w]!)) {
				if (queue.length === 0) break;
				queue.push(e);
				continue;
			}
			const [k0, k1] = [ts[0]!, ts[1]!];
			removeTri(k0);
			removeTri(k1);
			tris[k0] = orient(v, [p, q, u]);
			tris[k1] = orient(v, [p, q, w]);
			addTri(k0);
			addTri(k1);
			if (segCross(v[a]!, v[b]!, v[p]!, v[q]!)) queue.push(ek(p, q));
		}
	}
}

function jitter(i: number): number {
	let x = BigInt.asUintN(64, BigInt(i) * 0x9e3779b97f4a7c15n) ^ 0x2545f4914f6cdd1dn;
	x ^= x >> 31n;
	x = BigInt.asUintN(64, x * 0xbf58476d1ce4e5b9n);
	x ^= x >> 29n;
	return Number(x >> 11n) / 2 ** 53 - 0.5;
}

/** A mesh over a polygon outline (layer px) with the options' target triangle count. */
export function triangulate(outline: readonly Pt[], opts: MeshOpts): PuppetMeshGeometry {
	let poly = [...outline];
	if (signedArea(poly) < 0) poly.reverse();
	const area = Math.abs(signedArea(poly));
	if (poly.length < 3 || !(area > 0)) return { verts: [], tris: [], outline: poly };
	const target = Math.min(20000, Math.max(2, Math.max(2, opts.triangles) * 2 ** ((opts.density - 50) / 25)));
	const l = Math.max(0.5, Math.sqrt((4 * area) / (Math.sqrt(3) * target)));
	const boundary = densify(poly, l);
	const nb = boundary.length;
	const pts: Pt[] = [...boundary];
	let [x0, y0, x1, y1] = [
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];
	for (const p of poly) {
		x0 = Math.min(x0, p[0]);
		y0 = Math.min(y0, p[1]);
		x1 = Math.max(x1, p[0]);
		y1 = Math.max(y1, p[1]);
	}
	const dy = l * Math.sqrt(3) * 0.5;
	const minD2 = (0.55 * l) ** 2;
	let row = 0;
	for (let y = y0 + dy * 0.5; y < y1; y += dy, row++) {
		let col = 0;
		for (let x = x0 + (row % 2 === 1 ? l * 0.5 : 0) + l * 0.25; x < x1; x += l, col++) {
			const id = row * 100003 + col;
			const p: Pt = [x + jitter(id * 2) * l * 0.08, y + jitter(id * 2 + 1) * l * 0.08];
			if (inside(poly, p) && polyDist2(boundary, p) >= minD2) pts.push(p);
		}
	}
	let tris = delaunay(pts);
	recoverEdges(
		pts,
		tris,
		Array.from({ length: nb }, (_, i) => [i, (i + 1) % nb] as [number, number]),
	);
	tris = tris.filter((t) => {
		const c: Pt = [
			(pts[t[0]]![0] + pts[t[1]]![0] + pts[t[2]]![0]) / 3,
			(pts[t[0]]![1] + pts[t[1]]![1] + pts[t[2]]![1]) / 3,
		];
		return cross(pts[t[0]]!, pts[t[1]]!, pts[t[2]]!) > 1e-9 && inside(poly, c);
	});
	const map = new Int32Array(pts.length).fill(-1);
	const verts: Pt[] = [];
	for (const t of tris)
		for (let k = 0; k < 3; k++) {
			if (map[t[k]!] === -1) {
				map[t[k]!] = verts.length;
				verts.push(pts[t[k]!]!);
			}
			t[k] = map[t[k]!]!;
		}
	poly = poly.map((p) => [p[0], p[1]]);
	return { verts, tris, outline: poly };
}

/**
 * The outline (layer px) of the region of `mask` (1 = inside, w × h cells of `cell` layer px each) under `seed`
 * (layer px), grown by `expansion` layer px.
 */
export function outlineOfMask(mask: Grid, cell: number, seed: Pt, expansion: number): Pt[] {
	const pad = Math.ceil(Math.max(0, expansion) / cell) + 2;
	const pw = mask.w + 2 * pad;
	const ph = mask.h + 2 * pad;
	const on = new Uint8Array(pw * ph);
	for (let y = 0; y < mask.h; y++)
		for (let x = 0; x < mask.w; x++) on[(y + pad) * pw + x + pad] = mask.on[y * mask.w + x]!;
	const g = expand({ w: pw, h: ph, on }, expansion / cell);
	const r = region(g, [seed[0] / cell + pad, seed[1] / cell + pad]);
	if (!r) return [];
	return simplify(trace(r), 0.75).map((p) => [(p[0] - pad) * cell, (p[1] - pad) * cell]);
}

/** Rasterises a polygon (layer px) into a grid of `cell` px over a w × h layer. */
export function rasterisePolygon(poly: readonly Pt[], w: number, h: number, cell: number): Grid {
	const gw = Math.max(1, Math.ceil(w / cell));
	const gh = Math.max(1, Math.ceil(h / cell));
	const on = new Uint8Array(gw * gh);
	for (let y = 0; y < gh; y++)
		for (let x = 0; x < gw; x++) on[y * gw + x] = inside(poly, [(x + 0.5) * cell, (y + 0.5) * cell]) ? 1 : 0;
	return { w: gw, h: gh, on };
}
