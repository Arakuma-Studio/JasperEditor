// As-rigid-as-possible mesh deformation (sim-warp workstream), after Igarashi, Moscovich & Hughes, "As-Rigid-As-
// Possible Shape Manipulation" (SIGGRAPH 2005): a similarity step (each triangle keeps its shape up to rotation and
// uniform scale) then a scale-adjustment step (each triangle is fitted with a rigid copy of its rest shape and the
// positions match the fitted edges), with optional refinement iterations. Triangle weights stiffen regions (Starch);
// edge-vector targets implement Advanced/Bend pin rotation and scale. Jacobi-preconditioned conjugate gradients on
// sparse symmetric systems. Ported from EffectCraft crates/effects/src/puppet/arap.rs (MIT OR Apache-2.0); see
// licenses/ported/sim-warp.md.
import type { Pt } from './mesh.ts';

export type EdgeTarget = { i: number; j: number; vec: Pt; weight: number };
export type Handles = { fixed: [number, Pt][]; edges: EdgeTarget[] };

class Sparse {
	rows: Map<number, number>[];
	constructor(n: number) {
		this.rows = Array.from({ length: n }, () => new Map());
	}
	add(i: number, j: number, v: number) {
		const r = this.rows[i]!;
		r.set(j, (r.get(j) ?? 0) + v);
	}
}

/** Solves A x = b over the free unknowns, starting from x (fixed unknowns keep their values). */
function solve(a: Sparse, b: Float64Array, x: Float64Array, free: Uint8Array): void {
	const n = b.length;
	const idx: number[] = [];
	for (let i = 0; i < n; i++) if (free[i]) idx.push(i);
	if (idx.length === 0) return;
	const pos = new Int32Array(n).fill(-1);
	idx.forEach((i, k) => {
		pos[i] = k;
	});
	const m = idx.length;
	const ptr = [0];
	const col: number[] = [];
	const val: number[] = [];
	const diag = new Float64Array(m).fill(1);
	const rhs = new Float64Array(m);
	idx.forEach((i, k) => {
		let r = b[i]!;
		const keys = [...a.rows[i]!.keys()].sort((p, q) => p - q);
		for (const j of keys) {
			const v = a.rows[i]!.get(j)!;
			if (free[j]) {
				col.push(pos[j]!);
				val.push(v);
				if (j === i) diag[k] = Math.abs(v) > 1e-300 ? v : 1;
			} else r -= v * x[j]!;
		}
		rhs[k] = r;
		ptr.push(col.length);
	});
	const mul = (inp: Float64Array, out: Float64Array) => {
		for (let r = 0; r < m; r++) {
			let s = 0;
			for (let k = ptr[r]!; k < ptr[r + 1]!; k++) s += val[k]! * inp[col[k]!]!;
			out[r] = s;
		}
	};
	const xf = Float64Array.from(idx, (i) => x[i]!);
	const ax = new Float64Array(m);
	mul(xf, ax);
	const r = Float64Array.from(rhs, (v, k) => v - ax[k]!);
	let bn = 0;
	for (const v of rhs) bn += v * v;
	const bnorm = Math.max(Math.sqrt(bn), 1e-30);
	const z = Float64Array.from(r, (v, k) => v / diag[k]!);
	const p = z.slice();
	let rz = 0;
	for (let k = 0; k < m; k++) rz += r[k]! * z[k]!;
	const ap = new Float64Array(m);
	for (let it = 0; it < 4 * m + 50; it++) {
		let rn = 0;
		for (const v of r) rn += v * v;
		if (Math.sqrt(rn) <= 1e-13 * bnorm) break;
		mul(p, ap);
		let pap = 0;
		for (let k = 0; k < m; k++) pap += p[k]! * ap[k]!;
		if (Math.abs(pap) < 1e-300) break;
		const alpha = rz / pap;
		for (let k = 0; k < m; k++) {
			xf[k] = xf[k]! + alpha * p[k]!;
			r[k] = r[k]! - alpha * ap[k]!;
		}
		let rz2 = 0;
		for (let k = 0; k < m; k++) {
			z[k] = r[k]! / diag[k]!;
			rz2 += r[k]! * z[k]!;
		}
		const beta = rz2 / rz;
		rz = rz2;
		for (let k = 0; k < m; k++) p[k] = z[k]! + beta * p[k]!;
	}
	idx.forEach((i, k) => {
		x[i] = xf[k]!;
	});
}

const REG = 1e-9;

/** Best rigid copy of triangle `rest` over `cur` (rotation about the centroids). */
export function fitRigid(rest: [Pt, Pt, Pt], cur: [Pt, Pt, Pt]): [Pt, Pt, Pt] {
	const cr = [(rest[0][0] + rest[1][0] + rest[2][0]) / 3, (rest[0][1] + rest[1][1] + rest[2][1]) / 3];
	const cc = [(cur[0][0] + cur[1][0] + cur[2][0]) / 3, (cur[0][1] + cur[1][1] + cur[2][1]) / 3];
	let sd = 0;
	let sc = 0;
	for (let k = 0; k < 3; k++) {
		const p = [rest[k]![0] - cr[0]!, rest[k]![1] - cr[1]!];
		const q = [cur[k]![0] - cc[0]!, cur[k]![1] - cc[1]!];
		sd += p[0]! * q[0]! + p[1]! * q[1]!;
		sc += p[0]! * q[1]! - p[1]! * q[0]!;
	}
	const ang = Math.atan2(sc, sd);
	const [s, c] = [Math.sin(ang), Math.cos(ang)];
	return rest.map((v) => {
		const p = [v[0] - cr[0]!, v[1] - cr[1]!];
		return [cc[0]! + p[0]! * c - p[1]! * s, cc[1]! + p[0]! * s + p[1]! * c] as Pt;
	}) as [Pt, Pt, Pt];
}

/** Deformed vertices of a mesh (rest vertices, CCW triangles, per-triangle weights, constraints, refinement). */
export function deform(
	rest: readonly Pt[],
	tris: readonly [number, number, number][],
	weights: readonly number[],
	h: Handles,
	refine: number,
): Pt[] {
	const n = rest.length;
	if (n === 0) return [];
	const t = [0, 0];
	for (const [i, p] of h.fixed) {
		t[0] = t[0]! + p[0] - rest[i]![0];
		t[1] = t[1]! + p[1] - rest[i]![1];
	}
	if (h.fixed.length) {
		t[0] = t[0]! / h.fixed.length;
		t[1] = t[1]! / h.fixed.length;
	}
	const x0: Pt[] = rest.map((p) => [p[0] + t[0]!, p[1] + t[1]!]);
	const fixed = new Uint8Array(n);
	for (const [i] of h.fixed) fixed[i] = 1;
	const w = (k: number) => weights[k] ?? 1;
	let me = 0;
	for (const tr of tris)
		me += (rest[tr[0]]![0] - rest[tr[1]]![0]) ** 2 + (rest[tr[0]]![1] - rest[tr[1]]![1]) ** 2;
	const scale2 = Math.max(tris.length ? me / tris.length : 1, 1e-12);
	const reg = REG * Math.min(1, 1 / scale2);
	// Step 1: similarity-invariant energy over 2n unknowns.
	const a = new Sparse(2 * n);
	const b = new Float64Array(2 * n);
	tris.forEach((tr, k) => {
		const wk = w(k);
		for (const [i, j, l] of [
			[tr[0], tr[1], tr[2]],
			[tr[1], tr[2], tr[0]],
			[tr[2], tr[0], tr[1]],
		] as const) {
			const e = [rest[j]![0] - rest[i]![0], rest[j]![1] - rest[i]![1]];
			const d = [rest[l]![0] - rest[i]![0], rest[l]![1] - rest[i]![1]];
			const ee = e[0]! * e[0]! + e[1]! * e[1]!;
			if (ee <= 1e-18) continue;
			const r90 = [-e[1]!, e[0]!];
			const x = (d[0]! * e[0]! + d[1]! * e[1]!) / ee;
			const y = (d[0]! * r90[0]! + d[1]! * r90[1]!) / ee;
			const blocks: [number, number[][]][] = [
				[
					l,
					[
						[1, 0],
						[0, 1],
					],
				],
				[
					i,
					[
						[x - 1, -y],
						[y, x - 1],
					],
				],
				[
					j,
					[
						[-x, y],
						[-y, -x],
					],
				],
			];
			for (const [va, ba] of blocks)
				for (const [vb, bb] of blocks)
					for (let r = 0; r < 2; r++)
						for (let c = 0; c < 2; c++) {
							const v = ba[0]![r]! * bb[0]![c]! + ba[1]![r]! * bb[1]![c]!;
							if (v !== 0) a.add(2 * va + r, 2 * vb + c, wk * v);
						}
		}
	});
	for (const e of h.edges)
		for (let c = 0; c < 2; c++) {
			a.add(2 * e.i + c, 2 * e.i + c, e.weight);
			a.add(2 * e.j + c, 2 * e.j + c, e.weight);
			a.add(2 * e.i + c, 2 * e.j + c, -e.weight);
			a.add(2 * e.j + c, 2 * e.i + c, -e.weight);
			b[2 * e.j + c] = b[2 * e.j + c]! + e.weight * e.vec[c]!;
			b[2 * e.i + c] = b[2 * e.i + c]! - e.weight * e.vec[c]!;
		}
	for (let i = 0; i < n; i++)
		for (let c = 0; c < 2; c++) {
			a.add(2 * i + c, 2 * i + c, reg);
			b[2 * i + c] = b[2 * i + c]! + reg * x0[i]![c]!;
		}
	const x = new Float64Array(2 * n);
	x0.forEach((p, i) => {
		x[2 * i] = p[0];
		x[2 * i + 1] = p[1];
	});
	for (const [i, p] of h.fixed) {
		x[2 * i] = p[0];
		x[2 * i + 1] = p[1];
	}
	solve(
		a,
		b,
		x,
		Uint8Array.from({ length: 2 * n }, (_, k) => (fixed[k >> 1] ? 0 : 1)),
	);
	let cur: Pt[] = Array.from({ length: n }, (_, i) => [x[2 * i]!, x[2 * i + 1]!]);
	// Step 2: rigid triangles, then matched edge vectors (x and y separately).
	const L = new Sparse(n);
	tris.forEach((tr, k) => {
		const wk = w(k);
		for (const [i, j] of [
			[tr[0], tr[1]],
			[tr[1], tr[2]],
			[tr[2], tr[0]],
		] as const) {
			L.add(i, i, wk);
			L.add(j, j, wk);
			L.add(i, j, -wk);
			L.add(j, i, -wk);
		}
	});
	for (const e of h.edges) {
		L.add(e.i, e.i, e.weight);
		L.add(e.j, e.j, e.weight);
		L.add(e.i, e.j, -e.weight);
		L.add(e.j, e.i, -e.weight);
	}
	for (let i = 0; i < n; i++) L.add(i, i, reg);
	const free1 = Uint8Array.from({ length: n }, (_, i) => (fixed[i] ? 0 : 1));
	for (let it = 0; it <= refine; it++) {
		const bx = new Float64Array(n);
		const by = new Float64Array(n);
		tris.forEach((tr, k) => {
			const wk = w(k);
			const f = fitRigid([rest[tr[0]]!, rest[tr[1]]!, rest[tr[2]]!], [cur[tr[0]]!, cur[tr[1]]!, cur[tr[2]]!]);
			for (const [a2, b2] of [
				[0, 1],
				[1, 2],
				[2, 0],
			] as const) {
				const i = tr[a2];
				const j = tr[b2];
				const d = [f[b2]![0] - f[a2]![0], f[b2]![1] - f[a2]![1]];
				bx[j] = bx[j]! + wk * d[0]!;
				bx[i] = bx[i]! - wk * d[0]!;
				by[j] = by[j]! + wk * d[1]!;
				by[i] = by[i]! - wk * d[1]!;
			}
		});
		for (const e of h.edges) {
			bx[e.j] = bx[e.j]! + e.weight * e.vec[0];
			bx[e.i] = bx[e.i]! - e.weight * e.vec[0];
			by[e.j] = by[e.j]! + e.weight * e.vec[1];
			by[e.i] = by[e.i]! - e.weight * e.vec[1];
		}
		for (let i = 0; i < n; i++) {
			bx[i] = bx[i]! + reg * x0[i]![0];
			by[i] = by[i]! + reg * x0[i]![1];
		}
		const xs = Float64Array.from(cur, (p) => p[0]);
		const ys = Float64Array.from(cur, (p) => p[1]);
		for (const [i, p] of h.fixed) {
			xs[i] = p[0];
			ys[i] = p[1];
		}
		solve(L, bx, xs, free1);
		solve(L, by, ys, free1);
		cur = Array.from({ length: n }, (_, i) => [xs[i]!, ys[i]!]);
	}
	return cur;
}
