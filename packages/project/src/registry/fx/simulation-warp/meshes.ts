// Distortion meshes of Mesh Warp and Liquify: the layouts of their keyframable `mesh` params
// (flat number lists that interpolate number by number between keys) and the pure functions that edit them — the
// commands (`meshWarp.setVertex`, `liquify.stroke`) and the Program monitor tools use these, the renderers read them.
// Liquify's brushes are ported from EffectCraft crates/effects/src/distort4.rs (build_mesh; MIT OR Apache-2.0) and
// extended with the reconstruction modes and a keyframable mesh; see licenses/ported/sim-warp.md.
import { clamp, h01 } from './core.ts';

/** Mesh Warp: version, columns, rows, then per vertex (row-major, (rows+1) × (cols+1)): x, y (layer-normalised), and
 * the offsets (layer-normalised) of its left, right, up and down tangent handles. */
export const MESH_WARP_VERSION = 1;
export const MW_STRIDE = 10;

/** The rest mesh (a straight grid, tangents a third of a cell). */
export function meshWarpRest(cols: number, rows: number): number[] {
	const out = [MESH_WARP_VERSION, cols, rows];
	for (let j = 0; j <= rows; j++)
		for (let i = 0; i <= cols; i++) {
			const cw = 1 / cols / 3;
			const ch = 1 / rows / 3;
			out.push(i / cols, j / rows, -cw, 0, cw, 0, 0, -ch, 0, ch);
		}
	return out;
}

/** A Mesh Warp value valid for `cols` × `rows` (else the rest mesh). */
export function meshWarpOf(v: unknown, cols: number, rows: number): number[] {
	if (
		Array.isArray(v) &&
		v[0] === MESH_WARP_VERSION &&
		v[1] === cols &&
		v[2] === rows &&
		v.length === 3 + (cols + 1) * (rows + 1) * MW_STRIDE &&
		v.every((x) => typeof x === 'number' && Number.isFinite(x))
	)
		return v as number[];
	return meshWarpRest(cols, rows);
}

/** True when the mesh is the rest grid (Mesh Warp draws the layer unchanged). */
export function meshWarpIsRest(m: readonly number[]): boolean {
	const r = meshWarpRest(m[1]!, m[2]!);
	return m.every((x, i) => Math.abs(x - r[i]!) < 1e-9);
}

/**
 * Moves one vertex (and optionally its tangents) of a Mesh Warp mesh: `at` = new position (layer-normalised);
 * `tangents` = new handle offsets [left, right, up, down] (each [dx, dy]) — omitted ones keep theirs.
 */
export function meshWarpSetVertex(
	m: readonly number[],
	col: number,
	row: number,
	at?: readonly [number, number],
	tangents?: Partial<Record<'left' | 'right' | 'up' | 'down', readonly [number, number]>>,
): number[] {
	const cols = m[1]!;
	const out = [...m];
	const o = 3 + (row * (cols + 1) + col) * MW_STRIDE;
	if (at) {
		out[o] = at[0];
		out[o + 1] = at[1];
	}
	(['left', 'right', 'up', 'down'] as const).forEach((k, i) => {
		const t = tangents?.[k];
		if (t) {
			out[o + 2 + i * 2] = t[0];
			out[o + 3 + i * 2] = t[1];
		}
	});
	return out;
}

/**
 * Liquify: version, nx, ny, then per grid node (row-major) the displacement (dx, dy) in grid cells. Cells (not
 * pixels) keep the mesh valid at every resolution the layer is drawn at (a downscaled preview, a proxy, a smaller
 * render): the grid always has 128 cells on the layer's long side.
 */
export const LIQUIFY_VERSION = 2;
/** Cells on the long side of the layer. */
export const LIQUIFY_CELLS = 128;

/** Grid of a Liquify mesh over a w × h layer: nodes every `cell` layer px (128 cells on the long side). */
export function liquifyGrid(w: number, h: number) {
	const cell = Math.max(1e-6, Math.max(w, h) / LIQUIFY_CELLS);
	// The epsilon keeps nx / ny the same at every scale of the same box (float noise in w / cell).
	return { cell, nx: Math.ceil(w / cell - 1e-6) + 1, ny: Math.ceil(h / cell - 1e-6) + 1 };
}

/** An empty (undistorted) Liquify mesh. */
export function liquifyEmpty(w: number, h: number): number[] {
	const g = liquifyGrid(w, h);
	return [LIQUIFY_VERSION, g.nx, g.ny, ...new Array(g.nx * g.ny * 2).fill(0)];
}

/** A Liquify value valid for a w × h layer (else empty). */
export function liquifyOf(v: unknown, w: number, h: number): number[] {
	const g = liquifyGrid(w, h);
	if (
		Array.isArray(v) &&
		v[0] === LIQUIFY_VERSION &&
		v[1] === g.nx &&
		v[2] === g.ny &&
		v.length === 3 + g.nx * g.ny * 2 &&
		v.every((x) => typeof x === 'number' && Number.isFinite(x))
	)
		return v as number[];
	return liquifyEmpty(w, h);
}

export const LIQUIFY_TOOLS = [
	'warp',
	'turbulence',
	'twirlClockwise',
	'twirlCounterclockwise',
	'pucker',
	'bloat',
	'shiftPixels',
	'reflection',
	'clone',
	'reconstruction',
] as const;
export type LiquifyTool = (typeof LIQUIFY_TOOLS)[number];
export const LIQUIFY_TOOL_LABELS = [
	'Warp',
	'Turbulence',
	'Twirl Clockwise',
	'Twirl Counterclockwise',
	'Pucker',
	'Bloat',
	'Shift Pixels',
	'Reflection',
	'Clone',
	'Reconstruction',
] as const;
export const RECONSTRUCTION_MODES = ['revert', 'displace', 'amplitwist', 'affine'] as const;

export type LiquifyStroke = {
	tool: LiquifyTool;
	/** Brush centre path, layer px. */
	points: readonly (readonly [number, number])[];
	/** Brush diameter (layer px) and pressure (1…100). */
	size: number;
	pressure: number;
	/** Turbulent Jitter (1…100), Clone Offset (layer px), Reconstruction Mode. */
	jitter?: number;
	cloneOffset?: readonly [number, number];
	reconstruction?: (typeof RECONSTRUCTION_MODES)[number];
	/** Deterministic seed of turbulence. */
	seed?: number;
	/** Frozen points (Freeze Area Mask): true = the brush does not change the mesh there. */
	frozen?: (x: number, y: number) => boolean;
};

/**
 * Applies one brush stroke to a Liquify mesh (returns a new value). The mesh is a backward map (the output at p shows
 * the source at p + d(p)); every tool changes d where the brush passes, weighted by a smooth falloff, the pressure
 * and the freeze mask. Dabs every quarter radius along the path.
 */
export function liquifyApplyStroke(
	mesh: readonly number[],
	w: number,
	h: number,
	s: LiquifyStroke,
): number[] {
	const g = liquifyGrid(w, h);
	const stored = liquifyOf(mesh, w, h);
	// Work in layer px; stored back in cells at the end.
	const m = stored.map((v, i) => (i >= 3 ? v * g.cell : v));
	const nx = g.nx;
	const ny = g.ny;
	const cell = g.cell;
	const D = 3;
	const at = (i: number, j: number): [number, number] => [
		m[D + (j * nx + i) * 2]!,
		m[D + (j * nx + i) * 2 + 1]!,
	];
	const sample = (x: number, y: number): [number, number] => {
		const fx = clamp(x / cell, 0, nx - 1);
		const fy = clamp(y / cell, 0, ny - 1);
		const x0 = Math.min(nx - 2, Math.floor(fx));
		const y0 = Math.min(ny - 2, Math.floor(fy));
		const tx = fx - x0;
		const ty = fy - y0;
		const a = at(x0, y0);
		const b = at(x0 + 1, y0);
		const c = at(x0, y0 + 1);
		const d = at(x0 + 1, y0 + 1);
		return [
			(a[0] * (1 - tx) + b[0] * tx) * (1 - ty) + (c[0] * (1 - tx) + d[0] * tx) * ty,
			(a[1] * (1 - tx) + b[1] * tx) * (1 - ty) + (c[1] * (1 - tx) + d[1] * tx) * ty,
		];
	};
	const r = Math.max(1, s.size * 0.5);
	const pr = clamp(s.pressure / 100, 0, 1);
	const pts = s.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
	if (pts.length === 0) return stored.slice();
	const dabs: { c: [number, number]; mv: [number, number] }[] = [];
	if (pts.length === 1) dabs.push({ c: [pts[0]![0], pts[0]![1]], mv: [0, 0] });
	for (let k = 0; k + 1 < pts.length; k++) {
		const a = pts[k]!;
		const b = pts[k + 1]!;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const steps = Math.min(4096, Math.max(1, Math.ceil(len / (r * 0.25))));
		const st: [number, number] = [(b[0] - a[0]) / steps, (b[1] - a[1]) / steps];
		for (let q = 1; q <= steps; q++) dabs.push({ c: [a[0] + st[0] * q, a[1] + st[1] * q], mv: st });
	}
	// Reconstruction targets: the displacement (and its gradient) at the stroke's start.
	const p0 = pts[0]!;
	const d0 = sample(p0[0], p0[1]);
	const e = cell;
	const dx1 = sample(p0[0] + e, p0[1]);
	const dx0 = sample(p0[0] - e, p0[1]);
	const dy1 = sample(p0[0], p0[1] + e);
	const dy0 = sample(p0[0], p0[1] - e);
	const grad = [
		[(dx1[0] - dx0[0]) / (2 * e), (dy1[0] - dy0[0]) / (2 * e)],
		[(dx1[1] - dx0[1]) / (2 * e), (dy1[1] - dy0[1]) / (2 * e)],
	];
	const amp = { a: (grad[0]![0]! + grad[1]![1]!) / 2, b: (grad[1]![0]! - grad[0]![1]!) / 2 };
	const seed = s.seed ?? 0;
	const jitter = (clamp(s.jitter ?? 70, 1, 100) / 100) * r * 0.1;
	const clone = s.cloneOffset ?? [0, 0];
	dabs.forEach(({ c, mv }, di) => {
		const gx0 = Math.max(0, Math.floor((c[0] - r) / cell));
		const gx1 = Math.min(nx - 1, Math.ceil((c[0] + r) / cell));
		const gy0 = Math.max(0, Math.floor((c[1] - r) / cell));
		const gy1 = Math.min(ny - 1, Math.ceil((c[1] + r) / cell));
		const prev = s.tool === 'clone' ? m.slice() : m;
		for (let gy = gy0; gy <= gy1; gy++)
			for (let gx = gx0; gx <= gx1; gx++) {
				const x = gx * cell;
				const y = gy * cell;
				const ddx = x - c[0];
				const ddy = y - c[1];
				const dist = Math.hypot(ddx, ddy);
				if (dist >= r) continue;
				if (s.frozen?.(x, y)) continue;
				const t = 1 - dist / r;
				const w = pr * t * t * (3 - 2 * t) * 0.5;
				const o = D + (gy * nx + gx) * 2;
				const d = [m[o]!, m[o + 1]!];
				switch (s.tool) {
					case 'warp':
						d[0] -= mv[0] * w * 2;
						d[1] -= mv[1] * w * 2;
						break;
					case 'turbulence': {
						const sd = (Math.imul(seed, 7919) ^ di) | 0;
						d[0] += (h01(gx, gy, sd) * 2 - 1) * jitter * w - mv[0] * w;
						d[1] += (h01(gx, gy, sd ^ 0x55) * 2 - 1) * jitter * w - mv[1] * w;
						break;
					}
					case 'twirlClockwise':
					case 'twirlCounterclockwise': {
						const a = (s.tool === 'twirlClockwise' ? -1 : 1) * 0.08 * w;
						d[0] += ddx * Math.cos(a) - ddy * Math.sin(a) - ddx;
						d[1] += ddx * Math.sin(a) + ddy * Math.cos(a) - ddy;
						break;
					}
					case 'pucker':
						d[0] += ddx * 0.05 * w;
						d[1] += ddy * 0.05 * w;
						break;
					case 'bloat':
						d[0] -= ddx * 0.05 * w;
						d[1] -= ddy * 0.05 * w;
						break;
					case 'shiftPixels':
						// Perpendicular to the stroke (to its left).
						d[0] -= mv[1] * w * 2;
						d[1] += mv[0] * w * 2;
						break;
					case 'reflection': {
						const l = Math.hypot(mv[0], mv[1]);
						if (l > 1e-9) {
							const nn = [-mv[1] / l, mv[0] / l];
							const k = ddx * nn[0]! + ddy * nn[1]!;
							d[0] += (-2 * k * nn[0]! - d[0]!) * w;
							d[1] += (-2 * k * nn[1]! - d[1]!) * w;
						}
						break;
					}
					case 'clone': {
						const fx = clamp(Math.round((x + clone[0]) / cell), 0, nx - 1);
						const fy = clamp(Math.round((y + clone[1]) / cell), 0, ny - 1);
						const so = D + (fy * nx + fx) * 2;
						d[0] += (prev[so]! + clone[0] - d[0]!) * w;
						d[1] += (prev[so + 1]! + clone[1] - d[1]!) * w;
						break;
					}
					default: {
						// Reconstruction.
						const px = x - p0[0];
						const py = y - p0[1];
						let tgt: [number, number] = [0, 0];
						if (s.reconstruction === 'displace') tgt = d0;
						else if (s.reconstruction === 'amplitwist')
							tgt = [d0[0] + amp.a * px - amp.b * py, d0[1] + amp.b * px + amp.a * py];
						else if (s.reconstruction === 'affine')
							tgt = [
								d0[0] + grad[0]![0]! * px + grad[0]![1]! * py,
								d0[1] + grad[1]![0]! * px + grad[1]![1]! * py,
							];
						d[0] += (tgt[0] - d[0]!) * w * 2;
						d[1] += (tgt[1] - d[1]!) * w * 2;
					}
				}
				m[o] = d[0]!;
				m[o + 1] = d[1]!;
			}
	});
	return m.map((v, i) => (i >= 3 ? Math.round((v / cell) * 10000) / 10000 : v));
}
