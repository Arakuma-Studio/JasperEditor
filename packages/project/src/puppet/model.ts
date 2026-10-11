// The Puppet model (sim-warp): resolution of the instance's meshes and pins at a time, mesh building
// (cached by outline and options), the pin constraints of the solver (Position / Advanced / Bend / Starch / Overlap
// pins, as After Effects' Puppet tools) and the deformed triangles the renderer draws back to front.
// Ported in part from EffectCraft crates/effects/src/puppet/mod.rs (solve, starch_weights, depths; MIT OR
// Apache-2.0); see licenses/ported/sim-warp.md.
import { evaluate } from '../keyframes.ts';
import type { Puppet, PuppetPinKind } from '../schema/puppet.ts';
import { deform, type EdgeTarget, type Handles } from './arap.ts';
import {
	DEFAULT_MESH_OPTS,
	type MeshOpts,
	outlineOfMask,
	type Pt,
	type PuppetMeshGeometry,
	rasterisePolygon,
	triangulate,
} from './mesh.ts';

export type ResolvedPuppetMesh = { id: string; outline: Pt[] | null; seed: Pt; opts: MeshOpts };
export type ResolvedPuppetPin = {
	id: string;
	kind: PuppetPinKind;
	meshId: string;
	/** Layer-box-normalised. */
	rest: Pt;
	position: Pt;
	/** Fraction (1 = 100 %). */
	scale: number;
	/** Degrees. */
	rotation: number;
	amount: number;
	extent: number;
	inFront: number;
};
export type ResolvedPuppet = { meshes: ResolvedPuppetMesh[]; pins: ResolvedPuppetPin[] };

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pt = (v: unknown, d: Pt): Pt =>
	Array.isArray(v) && v.length >= 2 ? [fin(v[0], d[0]), fin(v[1], d[1])] : d;

/** The puppet at content time `t` (keyframes and expressions evaluated). */
export function resolvePuppet(p: Puppet, t: number): ResolvedPuppet {
	return {
		meshes: p.meshes.map((m) => ({
			id: m.id,
			outline: m.outline ? m.outline.map((q) => pt(q, [0, 0])) : null,
			seed: pt(m.seed, [0.5, 0.5]),
			opts: { density: fin(m.density, 50), expansion: fin(m.expansion, 3), triangles: fin(m.triangles, 350) },
		})),
		pins: p.pins.map((q) => ({
			id: q.id,
			kind: q.kind,
			meshId: q.meshId,
			rest: pt(q.rest, [0.5, 0.5]),
			position: pt(evaluate(q.position, t), pt(q.rest, [0.5, 0.5])),
			scale: fin(evaluate(q.scale, t), 100) / 100,
			rotation: fin(evaluate(q.rotation, t), 0),
			amount: fin(evaluate(q.amount, t), 50),
			extent: fin(evaluate(q.extent, t), 15),
			inFront: fin(evaluate(q.inFront, t), 50),
		})),
	};
}

/** Pins that hold a position (Starch and Overlap pins sit on the rest mesh). */
export const pinMoves = (k: PuppetPinKind) => k === 'position' || k === 'advanced';

const meshCache = new Map<string, PuppetMeshGeometry>();

/**
 * The mesh of a mesh definition over a w × h layer (layer px): the outline (or the box) rasterised, grown by
 * Expansion, the region under the seed traced, then triangulated. Cached by everything that shapes it.
 */
export function puppetMesh(m: ResolvedPuppetMesh, w: number, h: number): PuppetMeshGeometry {
	const key = JSON.stringify([m.outline, m.seed, m.opts, w, h]);
	const hit = meshCache.get(key);
	if (hit) return hit;
	const poly: Pt[] = m.outline?.length
		? m.outline.map(([x, y]) => [x * w, y * h])
		: [
				[0, 0],
				[w, 0],
				[w, h],
				[0, h],
			];
	// Rasterise at ≤ 512 cells on the long side, so Expansion grows the outline like an alpha region.
	const cell = Math.max(w, h) / Math.min(512, Math.max(16, Math.ceil(Math.max(w, h))));
	const grid = rasterisePolygon(poly, w, h, cell);
	const outline = outlineOfMask(grid, cell, [m.seed[0] * w, m.seed[1] * h], m.opts.expansion);
	const geom = triangulate(outline.length >= 3 ? outline : poly, m.opts);
	meshCache.set(key, geom);
	if (meshCache.size > 32) meshCache.delete(meshCache.keys().next().value!);
	return geom;
}

const nearest = (verts: readonly Pt[], p: Pt) => {
	let best = -1;
	let bd = Number.POSITIVE_INFINITY;
	verts.forEach((v, i) => {
		const d = (v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2;
		if (d < bd) {
			bd = d;
			best = i;
		}
	});
	return best;
};
const centroid = (g: PuppetMeshGeometry, t: [number, number, number]): Pt => [
	(g.verts[t[0]]![0] + g.verts[t[1]]![0] + g.verts[t[2]]![0]) / 3,
	(g.verts[t[0]]![1] + g.verts[t[1]]![1] + g.verts[t[2]]![1]) / 3,
];

/** Deformed vertices of one mesh for its pins (layer px). `refine` = extra rigid-fit iterations. */
export function solvePuppetMesh(
	g: PuppetMeshGeometry,
	pins: readonly ResolvedPuppetPin[],
	w: number,
	h: number,
	refine: number,
): Pt[] {
	const adj: number[][] = g.verts.map(() => []);
	for (const t of g.tris)
		for (const [a, b] of [
			[t[0], t[1]],
			[t[1], t[2]],
			[t[2], t[0]],
		] as const) {
			if (!adj[a]!.includes(b)) adj[a]!.push(b);
			if (!adj[b]!.includes(a)) adj[b]!.push(a);
		}
	const handles: Handles = { fixed: [], edges: [] };
	const used = new Set<number>();
	for (const p of pins) {
		const rest: Pt = [p.rest[0] * w, p.rest[1] * h];
		const v = nearest(g.verts, rest);
		if (v < 0) continue;
		const r = g.verts[v]!;
		if (pinMoves(p.kind) && !used.has(v)) {
			used.add(v);
			handles.fixed.push([v, [p.position[0] * w + r[0] - rest[0], p.position[1] * h + r[1] - rest[1]]]);
		}
		if (p.kind === 'advanced' || p.kind === 'bend') {
			const a = (p.rotation * Math.PI) / 180;
			const [s, c] = [Math.sin(a), Math.cos(a)];
			for (const j of adj[v]!) {
				const e = [g.verts[j]![0] - r[0], g.verts[j]![1] - r[1]];
				const vec: Pt = [p.scale * (e[0]! * c - e[1]! * s), p.scale * (e[0]! * s + e[1]! * c)];
				handles.edges.push({ i: v, j, vec, weight: 10 } satisfies EdgeTarget);
			}
		}
	}
	if (handles.fixed.length === 0 && handles.edges.length === 0) return g.verts.map((q) => [q[0], q[1]]);
	// Starch: stiffer triangles near starch pins.
	const weights = g.tris.map((t) => {
		const c = centroid(g, t);
		let wgt = 1;
		for (const p of pins)
			if (p.kind === 'starch') {
				const d = Math.hypot(c[0] - p.rest[0] * w, c[1] - p.rest[1] * h);
				const f = Math.min(1, Math.max(0, 1 - d / (Math.max(0, p.extent) * 2 + 1e-9)));
				wgt += f * Math.max(0, p.amount) * 2;
			}
		return wgt;
	});
	return deform(g.verts, g.tris, weights, handles, refine);
}

/** Overlap depth of each triangle (higher draws in front). */
export function triangleDepths(
	g: PuppetMeshGeometry,
	pins: readonly ResolvedPuppetPin[],
	w: number,
	h: number,
): number[] {
	return g.tris.map((t) => {
		const c = centroid(g, t);
		let d: number | null = null;
		for (const p of pins)
			if (
				p.kind === 'overlap' &&
				Math.hypot(c[0] - p.rest[0] * w, c[1] - p.rest[1] * h) <= Math.max(0, p.extent) + 1e-9
			)
				d = d === null ? p.inFront : Math.max(d, p.inFront);
		return d ?? 0;
	});
}

/** Everything the renderer and the overlays need: per mesh its geometry and deformed vertices (layer px). */
export function solvePuppet(p: ResolvedPuppet, w: number, h: number, refine: number) {
	return p.meshes.map((m) => {
		const g = puppetMesh(m, w, h);
		const pins = p.pins.filter((q) => q.meshId === m.id);
		return {
			mesh: m,
			geometry: g,
			deformed: solvePuppetMesh(g, pins, w, h, refine),
			depths: triangleDepths(g, pins, w, h),
		};
	});
}

/** The mesh (id) whose outline contains a layer-normalised point, else null. */
export function meshAt(p: ResolvedPuppet, at: Pt, w: number, h: number): string | null {
	for (const m of p.meshes) {
		const g = puppetMesh(m, w, h);
		const q: Pt = [at[0] * w, at[1] * h];
		for (const t of g.tris) {
			const [a, b, c] = [g.verts[t[0]]!, g.verts[t[1]]!, g.verts[t[2]]!];
			const d1 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
			const d2 = (c[0] - b[0]) * (q[1] - b[1]) - (c[1] - b[1]) * (q[0] - b[0]);
			const d3 = (a[0] - c[0]) * (q[1] - c[1]) - (a[1] - c[1]) * (q[0] - c[0]);
			if (d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) return m.id;
		}
	}
	return null;
}

export { DEFAULT_MESH_OPTS };
