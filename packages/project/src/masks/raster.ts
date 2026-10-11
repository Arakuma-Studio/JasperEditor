// Mask coverage (wp masks): the single definition shared by the GL rasteriser (preview and Remotion renders, the
// shader in `masks/glsl.ts`), the CPU rasteriser (native export kernel, preview fallback) and the tests.
//
// Per mask, for a pixel centre `p` (canvas px):
//
//   sd  = signed distance from p to the flattened outline (> 0 inside, nonzero winding), clamped to ±band
//   s   = sd + expansion
//   ro, ri = outer / inner radius of the variable feather (feather points) at the nearest outline position
//   lo  = max(ro + feather/2, ½),  hi = max(ri + feather/2, ½)
//   u   = clamp((s + lo) / (lo + hi), 0, 1)
//   c   = linear falloff ? u : u + (smoothstep(u) − u) · clamp(lo + hi − 1, 0, 1)
//   m   = opacity · (inverted ? 1 − c : c)
//
// A hard mask (feather 0) is the analytic box-filtered coverage of its edge (a one-pixel ramp across the boundary:
// exact for straight edges); Mask Feather spreads it smoothly over `feather` pixels centred on the (expanded) edge,
// so corners round off and the width is the same along the whole outline (Premiere's feather); feather points add
// After Effects' variable-width feather outwards (ro) or inwards (ri), interpolated along the arc length.
// `band` = |expansion| + feather/2 + max feather-point radius + 1.5 bounds the distance that matters: beyond it the
// coverage is saturated, so only outline edges within the band of a pixel are visited.
//
// Masks combine top to bottom: the first active mask starts the accumulator (`maskModeStart`), then
// `acc = clamp(combine(mode, acc, m), 0, 1)` (`combineMaskMode`).
//
// Acceleration (identical on GPU and CPU): the canvas is cut into 16-px tiles; each tile lists the outline edges
// within `band` of it, and stores, for each of its 16 pixel rows, the winding number contributed by the edges NOT
// in its list that cross the row left of the tile (those edges are ≥ band away, so the decision has a margin). A
// pixel's winding = that row value + the signed crossings of its tile's listed edges left of the pixel; its
// distance = the minimum over the listed edges. Everything is packed into one RGBA32F texture (`MaskPack`).

import { flattenPath, type PathPoint } from '../path/model.ts';
import type { MaskFeatherFalloff, MaskMode } from '../schema/mask.ts';
import { activeMasks, combineMaskMode, MASK_MODE_INDEX, maskModeStart, type ResolvedMask } from './model.ts';

/** Flattening tolerance, canvas px. */
export const MASK_FLATTEN_TOLERANCE = 0.05;
/** Tile edge, px (16 rows of windings = 4 texels). */
export const MASK_TILE = 16;
/** Width of the packed data texture (texels). */
export const MASK_DATA_WIDTH = 1024;

const f32 = Math.fround;

/** One mask ready for rasterising, in canvas pixels. */
export type PreparedMask = {
	mode: MaskMode;
	inverted: boolean;
	/** 0..1. */
	opacity: number;
	/** px ≥ 0. */
	feather: number;
	/** px. */
	expansion: number;
	falloff: MaskFeatherFalloff;
	/** Closed polygon, x/y interleaved (float32-rounded). */
	pts: Float64Array;
	/** Arc length at each point (px). */
	arcs: Float64Array;
	/** Total outline length (px). */
	length: number;
	/** Feather profile: (arc, outer, inner, tension), sorted by arc. */
	profile: [number, number, number, number][];
	band: number;
};

/**
 * Prepares the active masks for a canvas: `toCanvas` maps normalised layer-box coordinates to canvas px, and
 * `pxScale` is canvas px per layer px (feather, expansion and feather radii are layer px).
 */
export function prepareMasks(
	masks: readonly ResolvedMask[],
	toCanvas: (q: PathPoint) => PathPoint,
	pxScale: number,
): PreparedMask[] {
	const out: PreparedMask[] = [];
	for (const m of activeMasks(masks)) {
		const mapped = {
			closed: true,
			vertices: m.path.vertices.map((v) => {
				const p = toCanvas(v.p);
				const hi = toCanvas([v.p[0] + v.in[0], v.p[1] + v.in[1]]);
				const ho = toCanvas([v.p[0] + v.out[0], v.p[1] + v.out[1]]);
				return {
					p,
					in: [hi[0] - p[0], hi[1] - p[1]] as PathPoint,
					out: [ho[0] - p[0], ho[1] - p[1]] as PathPoint,
				};
			}),
		};
		const flat = flattenPath(mapped, MASK_FLATTEN_TOLERANCE);
		const n = flat.pts.length;
		const pts = new Float64Array(2 * n);
		const arcs = new Float64Array(n + 1);
		for (let i = 0; i < n; i++) {
			pts[2 * i] = f32(flat.pts[i]![0]);
			pts[2 * i + 1] = f32(flat.pts[i]![1]);
		}
		for (let i = 1; i <= n; i++) {
			const j = i % n;
			arcs[i] = arcs[i - 1]! + Math.hypot(pts[2 * j]! - pts[2 * i - 2]!, pts[2 * j + 1]! - pts[2 * i - 1]!);
		}
		const length = arcs[n]!;
		// Arc length of a feather point: the flattened points are monotonic in g = segment + t (the closing point n,
		// back on vertex 0, has g = segment count); interpolate the arc length in g.
		const segs = mapped.vertices.length;
		const g = new Float64Array(n + 1);
		for (let i = 0; i < n; i++) g[i] = flat.segOf[i]! + flat.tOf[i]!;
		g[n] = segs;
		const arcOf = (segment: number, t: number): number | null => {
			if (segment < 0 || segment >= segs) return null;
			const target = segment + t;
			let i = 0;
			while (i < n - 1 && g[i + 1]! < target) i++;
			const span = g[i + 1]! - g[i]!;
			const k = span > 0 ? Math.min(1, Math.max(0, (target - g[i]!) / span)) : 0;
			return arcs[i]! + (arcs[i + 1]! - arcs[i]!) * k;
		};
		const profile: [number, number, number, number][] = [];
		for (const f of m.path.feather ?? []) {
			const a = arcOf(f.segment, Math.min(1, Math.max(0, f.t)));
			if (a === null) continue;
			const r = f.radius * pxScale;
			profile.push([a, Math.max(0, r), Math.max(0, -r), Math.min(1, Math.max(0, f.tension))]);
		}
		profile.sort((a, b) => a[0] - b[0]);
		const feather = Math.max(0, m.feather) * pxScale;
		const expansion = m.expansion * pxScale;
		const rmax = profile.reduce((x, p) => Math.max(x, p[1], p[2]), 0);
		out.push({
			mode: m.mode,
			inverted: m.inverted,
			opacity: Math.min(1, Math.max(0, m.opacity / 100)),
			feather,
			expansion,
			falloff: m.falloff,
			pts,
			arcs,
			length,
			profile,
			band: Math.abs(expansion) + feather / 2 + rmax + 1.5,
		});
	}
	return out;
}

/** Outer / inner radius at arc length `u` (closed outline: the profile wraps around). */
export function featherProfileAt(
	profile: readonly [number, number, number, number][],
	length: number,
	u: number,
): [number, number] {
	const n = profile.length;
	if (n === 0) return [0, 0];
	if (n === 1) return [profile[0]![1], profile[0]![2]];
	const blend = (a: readonly number[], b: readonly number[], x: number): [number, number] => {
		const xx = Math.min(1, Math.max(0, x));
		const smooth = xx * xx * (3 - 2 * xx);
		const tension = Math.min(1, Math.max(0, (a[3]! + b[3]!) / 2));
		const w = smooth + (xx - smooth) * tension;
		return [a[1]! + (b[1]! - a[1]!) * w, a[2]! + (b[2]! - a[2]!) * w];
	};
	const first = profile[0]!;
	const last = profile[n - 1]!;
	if (u < first[0] || u >= last[0]) {
		const span = length - last[0] + first[0];
		const x = u >= last[0] ? u - last[0] : u + length - last[0];
		return blend(last, first, span > 1e-9 ? x / span : 0);
	}
	let i = 1;
	while (i < n - 1 && profile[i]![0] <= u) i++;
	const a = profile[i - 1]!;
	const b = profile[i]!;
	const span = b[0] - a[0];
	return blend(a, b, span > 1e-9 ? (u - a[0]) / span : 0);
}

/** Coverage of one mask from its signed distance and outline position (the definition above). */
export function maskValue(m: PreparedMask, sd: number, arc: number): number {
	const s = sd + m.expansion;
	const [ro, ri] = featherProfileAt(m.profile, m.length, arc);
	const lo = Math.max(ro + m.feather / 2, 0.5);
	const hi = Math.max(ri + m.feather / 2, 0.5);
	const u = Math.min(1, Math.max(0, (s + lo) / (lo + hi)));
	let c = u;
	if (m.falloff !== 'linear') {
		const k = Math.min(1, Math.max(0, lo + hi - 1));
		c = u + (u * u * (3 - 2 * u) - u) * k;
	}
	return m.opacity * (m.inverted ? 1 - c : c);
}

function edgeDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
	const dx = bx - ax;
	const dy = by - ay;
	const qx = px - ax;
	const qy = py - ay;
	const l2 = dx * dx + dy * dy;
	const t = l2 > 0 ? Math.min(1, Math.max(0, (qx * dx + qy * dy) / l2)) : 0;
	const ex = qx - dx * t;
	const ey = qy - dy * t;
	return [ex * ex + ey * ey, t];
}

/**
 * Brute-force combined coverage at one point (every edge; the definition the tiled rasterisers implement). Null
 * when no mask is active (the caller applies nothing).
 */
export function maskCoverageAt(masks: readonly PreparedMask[], x: number, y: number): number | null {
	if (masks.length === 0) return null;
	let acc = maskModeStart(masks[0]!.mode);
	for (const m of masks) {
		const n = m.pts.length / 2;
		let wind = 0;
		let d2 = m.band * m.band;
		let arc = 0;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ax = m.pts[2 * i]!;
			const ay = m.pts[2 * i + 1]!;
			const bx = m.pts[2 * j]!;
			const by = m.pts[2 * j + 1]!;
			if (ay <= y !== by <= y) {
				const xc = ax + ((y - ay) * (bx - ax)) / (by - ay);
				if (xc < x) wind += by > ay ? 1 : -1;
			}
			const [dd, t] = edgeDist2(x, y, ax, ay, bx, by);
			if (dd < d2) {
				d2 = dd;
				arc = m.arcs[i]! + (m.arcs[i + 1]! - m.arcs[i]!) * t;
			}
		}
		const d = Math.sqrt(d2);
		acc = Math.min(1, Math.max(0, combineMaskMode(m.mode, acc, maskValue(m, wind !== 0 ? d : -d, arc))));
	}
	return acc;
}

// packing (GPU + CPU tiled rasterisers)

/** Everything the tiled rasteriser needs, as RGBA32F texels. */
export type MaskPack = {
	width: number;
	height: number;
	count: number;
	grid: [number, number];
	tile: number;
	/** RGBA32F texels, `MASK_DATA_WIDTH` per row. */
	data: Float32Array;
	dataHeight: number;
	/** Texel index where the edge-index lists start (4 indices per texel). */
	listBase: number;
};

const INFO = 4;
const TILE_TEXELS = 1 + MASK_TILE / 4;

/**
 * Packs prepared masks for a `width × height` canvas. Layout (texel indices): mask `m`'s info at `4m … 4m+3`:
 *   0: (mode index, inverted, opacity, feather)   1: (expansion, band, linear falloff, profile count)
 *   2: (edge base, tile base, profile base, edge count)   3: (outline length, 0, 0, 0)
 * edges: 2 texels each, (ax, ay, bx, by), (arc a, arc b, 0, 0); tiles: per tile (list offset (in indices), count,
 * 0, 0) + 4 texels of row windings; profile points (arc, outer, inner, tension); edge index lists, 4 per texel.
 */
export function packMasks(masks: readonly PreparedMask[], width: number, height: number): MaskPack | null {
	if (masks.length === 0 || width <= 0 || height <= 0) return null;
	const T = MASK_TILE;
	const gw = Math.ceil(width / T);
	const gh = Math.ceil(height / T);
	const tiles = gw * gh;
	type Built = { edges: number; lists: number[][]; wind: Int32Array; profile: number };
	const built: Built[] = [];
	let texels = masks.length * INFO;
	let listTotal = 0;
	for (const m of masks) {
		const n = m.pts.length / 2;
		const lists: number[][] = Array.from({ length: tiles }, () => []);
		const inList: Set<number>[] = [];
		const b = m.band;
		for (let e = 0; e < n; e++) {
			const j = (e + 1) % n;
			const ax = m.pts[2 * e]!;
			const ay = m.pts[2 * e + 1]!;
			const bx = m.pts[2 * j]!;
			const by = m.pts[2 * j + 1]!;
			const tx0 = Math.max(0, Math.floor((Math.min(ax, bx) - b) / T));
			const tx1 = Math.min(gw - 1, Math.floor((Math.max(ax, bx) + b) / T));
			const ty0 = Math.max(0, Math.floor((Math.min(ay, by) - b) / T));
			const ty1 = Math.min(gh - 1, Math.floor((Math.max(ay, by) + b) / T));
			for (let ty = ty0; ty <= ty1; ty++)
				for (let tx = tx0; tx <= tx1; tx++) {
					// Exact test: the edge's distance to the tile rectangle ≤ band (cheap enough, keeps lists short).
					if (segRectDist(ax, ay, bx, by, tx * T, ty * T, (tx + 1) * T, (ty + 1) * T) <= b)
						lists[ty * gw + tx]!.push(e);
				}
		}
		for (let t = 0; t < tiles; t++) inList.push(new Set(lists[t]));
		// Row windings: for each pixel row, the crossings of the row (sorted); per tile, those left of the tile edge
		// that are not in the tile's list.
		const wind = new Int32Array(tiles * T);
		const xs: number[] = [];
		const ds: number[] = [];
		const es: number[] = [];
		for (let y = 0; y < gh * T; y++) {
			const py = y + 0.5;
			xs.length = 0;
			ds.length = 0;
			es.length = 0;
			for (let e = 0; e < n; e++) {
				const j = (e + 1) % n;
				const ay = m.pts[2 * e + 1]!;
				const by = m.pts[2 * j + 1]!;
				if (ay <= py !== by <= py) {
					const ax = m.pts[2 * e]!;
					const bx = m.pts[2 * j]!;
					xs.push(ax + ((py - ay) * (bx - ax)) / (by - ay));
					ds.push(by > ay ? 1 : -1);
					es.push(e);
				}
			}
			const ty = Math.floor(y / T);
			const row = y - ty * T;
			for (let tx = 0; tx < gw; tx++) {
				const x0 = tx * T;
				const set = inList[ty * gw + tx]!;
				let w = 0;
				for (let k = 0; k < xs.length; k++) if (xs[k]! < x0 && !set.has(es[k]!)) w += ds[k]!;
				wind[(ty * gw + tx) * T + row] = w;
			}
		}
		const listLen = lists.reduce((s, l) => s + l.length, 0);
		built.push({ edges: n, lists, wind, profile: m.profile.length });
		texels += 2 * n + tiles * TILE_TEXELS + m.profile.length;
		listTotal += listLen;
	}
	const listTexels = Math.ceil(listTotal / 4);
	const total = texels + listTexels;
	const dataHeight = Math.max(1, Math.ceil(total / MASK_DATA_WIDTH));
	const data = new Float32Array(dataHeight * MASK_DATA_WIDTH * 4);
	const put = (texel: number, a: number, b: number, c: number, d: number) => {
		data[4 * texel] = a;
		data[4 * texel + 1] = b;
		data[4 * texel + 2] = c;
		data[4 * texel + 3] = d;
	};
	let cursor = masks.length * INFO;
	const listBase = texels; // texel index where the index lists start
	let listCursor = 0; // in indices
	masks.forEach((m, mi) => {
		const bi = built[mi]!;
		const edgeBase = cursor;
		cursor += 2 * bi.edges;
		const tileBase = cursor;
		cursor += tiles * TILE_TEXELS;
		const profileBase = cursor;
		cursor += bi.profile;
		put(mi * INFO, MASK_MODE_INDEX[m.mode], m.inverted ? 1 : 0, m.opacity, m.feather);
		put(mi * INFO + 1, m.expansion, m.band, m.falloff === 'linear' ? 1 : 0, bi.profile);
		put(mi * INFO + 2, edgeBase, tileBase, profileBase, bi.edges);
		put(mi * INFO + 3, m.length, 0, 0, 0);
		const n = bi.edges;
		for (let e = 0; e < n; e++) {
			const j = (e + 1) % n;
			put(edgeBase + 2 * e, m.pts[2 * e]!, m.pts[2 * e + 1]!, m.pts[2 * j]!, m.pts[2 * j + 1]!);
			put(edgeBase + 2 * e + 1, m.arcs[e]!, m.arcs[e + 1]!, 0, 0);
		}
		for (let t = 0; t < tiles; t++) {
			const list = bi.lists[t]!;
			put(tileBase + t * TILE_TEXELS, listCursor, list.length, 0, 0);
			for (let r = 0; r < MASK_TILE / 4; r++) {
				const w = bi.wind;
				const o = t * MASK_TILE + 4 * r;
				put(tileBase + t * TILE_TEXELS + 1 + r, w[o]!, w[o + 1]!, w[o + 2]!, w[o + 3]!);
			}
			for (const e of list) {
				data[4 * listBase + listCursor] = e;
				listCursor++;
			}
		}
		m.profile.forEach((p, k) => {
			put(profileBase + k, p[0], p[1], p[2], p[3]);
		});
	});
	// Lists start at texel `listBase`: offsets stored per tile are relative to it (shader adds u_maskListBase · 4).
	return {
		width,
		height,
		count: masks.length,
		grid: [gw, gh],
		tile: MASK_TILE,
		data,
		dataHeight,
		listBase,
	};
}

/** Distance from segment ab to the axis-aligned rectangle [x0, x1] × [y0, y1] (0 when they intersect). */
function segRectDist(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): number {
	const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
	if (inside(ax, ay) || inside(bx, by)) return 0;
	// Segment vs each rectangle side; then corner-to-segment distances.
	const sides: [number, number, number, number][] = [
		[x0, y0, x1, y0],
		[x1, y0, x1, y1],
		[x1, y1, x0, y1],
		[x0, y1, x0, y0],
	];
	let best = Number.POSITIVE_INFINITY;
	for (const [cx, cy, dx, dy] of sides) {
		if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
		best = Math.min(best, Math.sqrt(edgeDist2(cx, cy, ax, ay, bx, by)[0]));
	}
	// Endpoints of the segment to the rectangle.
	for (const [px, py] of [
		[ax, ay],
		[bx, by],
	] as const) {
		const qx = Math.min(x1, Math.max(x0, px));
		const qy = Math.min(y1, Math.max(y0, py));
		best = Math.min(best, Math.hypot(px - qx, py - qy));
	}
	return best;
}

function segmentsIntersect(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	dx: number,
	dy: number,
): boolean {
	const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
		(qx - px) * (ry - py) - (qy - py) * (rx - px);
	const d1 = o(cx, cy, dx, dy, ax, ay);
	const d2 = o(cx, cy, dx, dy, bx, by);
	const d3 = o(ax, ay, bx, by, cx, cy);
	const d4 = o(ax, ay, bx, by, dx, dy);
	return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0);
}

/**
 * CPU tiled rasteriser over a pack (the GL shader's exact algorithm): combined coverage of every pixel centre,
 * row-major `width × height`.
 */
export function rasterizeMaskPack(pack: MaskPack): Float32Array {
	const { width: W, height: H, data, count, grid, tile: T } = pack;
	const listBase = pack.listBase;
	const out = new Float32Array(W * H);
	const md = (i: number, c: number) => data[4 * i + c]!;
	type Info = {
		mode: number;
		inverted: boolean;
		opacity: number;
		feather: number;
		expansion: number;
		band: number;
		linear: boolean;
		profileCount: number;
		edgeBase: number;
		tileBase: number;
		profileBase: number;
		length: number;
		profile: [number, number, number, number][];
	};
	const modes: MaskMode[] = ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'];
	const infos: Info[] = [];
	for (let m = 0; m < count; m++) {
		const b = m * INFO;
		const profileCount = md(b + 1, 3);
		const profileBase = md(b + 2, 2);
		infos.push({
			mode: md(b, 0),
			inverted: md(b, 1) > 0.5,
			opacity: md(b, 2),
			feather: md(b, 3),
			expansion: md(b + 1, 0),
			band: md(b + 1, 1),
			linear: md(b + 1, 2) > 0.5,
			profileCount,
			edgeBase: md(b + 2, 0),
			tileBase: md(b + 2, 1),
			profileBase,
			length: md(b + 3, 0),
			profile: Array.from(
				{ length: profileCount },
				(_, k) =>
					[
						md(profileBase + k, 0),
						md(profileBase + k, 1),
						md(profileBase + k, 2),
						md(profileBase + k, 3),
					] as [number, number, number, number],
			),
		});
	}
	for (let y = 0; y < H; y++) {
		const py = y + 0.5;
		const ty = Math.floor(y / T);
		const row = y - ty * T;
		for (let x = 0; x < W; x++) {
			const px = x + 0.5;
			const tile = ty * grid[0] + Math.floor(x / T);
			let acc = 0;
			for (let m = 0; m < count; m++) {
				const inf = infos[m]!;
				const mode = modes[inf.mode]!;
				if (m === 0) acc = maskModeStart(mode);
				const tb = inf.tileBase + tile * TILE_TEXELS;
				const off = md(tb, 0);
				const cnt = md(tb, 1);
				let wind = md(tb + 1 + (row >> 2), row & 3);
				let d2 = inf.band * inf.band;
				let arc = 0;
				for (let k = 0; k < cnt; k++) {
					const li = off + k;
					const e = data[4 * listBase + li]!;
					const eb = inf.edgeBase + 2 * e;
					const ax = md(eb, 0);
					const ay = md(eb, 1);
					const bx = md(eb, 2);
					const by = md(eb, 3);
					if (ay <= py !== by <= py) {
						const xc = ax + ((py - ay) * (bx - ax)) / (by - ay);
						if (xc < px) wind += by > ay ? 1 : -1;
					}
					const [dd, t] = edgeDist2(px, py, ax, ay, bx, by);
					if (dd < d2) {
						d2 = dd;
						arc = md(eb + 1, 0) + (md(eb + 1, 1) - md(eb + 1, 0)) * t;
					}
				}
				const d = Math.sqrt(d2);
				const v = maskValue(
					{
						mode,
						inverted: inf.inverted,
						opacity: inf.opacity,
						feather: inf.feather,
						expansion: inf.expansion,
						falloff: inf.linear ? 'linear' : 'smooth',
						pts: new Float64Array(0),
						arcs: new Float64Array(0),
						length: inf.length,
						profile: inf.profile,
						band: inf.band,
					},
					wind !== 0 ? d : -d,
					arc,
				);
				acc = Math.min(1, Math.max(0, combineMaskMode(mode, acc, v)));
			}
			out[y * W + x] = acc;
		}
	}
	return out;
}

/** Convenience: combined coverage of resolved masks over a canvas (CPU), or null without active masks. */
export function rasterizeMasks(
	masks: readonly ResolvedMask[],
	width: number,
	height: number,
	toCanvas: (q: PathPoint) => PathPoint,
	pxScale: number,
): Float32Array | null {
	const pack = packMasks(prepareMasks(masks, toCanvas, pxScale), width, height);
	return pack ? rasterizeMaskPack(pack) : null;
}

/** Normalised layer coordinates → canvas px for a layer box at (x, y, w, h) in the canvas. */
export function boxToCanvas(box: {
	x: number;
	y: number;
	w: number;
	h: number;
}): (q: PathPoint) => PathPoint {
	return (q) => [box.x + q[0] * box.w, box.y + q[1] * box.h];
}
