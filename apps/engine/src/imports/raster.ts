// Closed cubic Bézier paths become
// an 8-bit coverage mask, anti-aliased with 4×4 supersampling per pixel (scanline crossings at 4 sub-rows, exact
// horizontal coverage per sub-row), non-zero or even-odd fill. Pure; bounded by the mask size.

export type Pt = [number, number];
/** A closed sub-path of cubic segments: `[p0, c0, c1, p1]` each. */
export type CubicPath = { segments: [Pt, Pt, Pt, Pt][]; fillRule: 'non-zero' | 'even-odd' };

const SUB = 4;

/** Flattens a cubic into line points (adaptive by its control polygon length; ≤ 0.25 px chords). */
function flatten(seg: [Pt, Pt, Pt, Pt], out: Pt[]): void {
	const [p0, c0, c1, p1] = seg;
	const len =
		Math.hypot(c0[0] - p0[0], c0[1] - p0[1]) +
		Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) +
		Math.hypot(p1[0] - c1[0], p1[1] - c1[1]);
	const n = Math.max(1, Math.min(4096, Math.ceil(len / 0.5)));
	for (let i = 1; i <= n; i++) {
		const t = i / n;
		const u = 1 - t;
		const a = u * u * u;
		const b = 3 * u * u * t;
		const c = 3 * u * t * t;
		const d = t * t * t;
		out.push([a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]]);
	}
}

/**
 * Coverage (0…255) of `paths` (one fill rule each, combined by union) over a `width`×`height` grid whose origin is
 * document pixel (`left`, `top`).
 */
export function rasterizePaths(
	paths: CubicPath[],
	left: number,
	top: number,
	width: number,
	height: number,
): Uint8Array {
	const out = new Uint8Array(width * height);
	if (width <= 0 || height <= 0) return out;
	for (const path of paths) {
		const poly: Pt[][] = [];
		if (path.segments.length === 0) continue;
		const pts: Pt[] = [path.segments[0]![0]];
		for (const s of path.segments) flatten(s, pts);
		poly.push(pts.map(([x, y]) => [x - left, y - top]));
		const cov = coverage(poly, path.fillRule, width, height);
		for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i]!, cov[i]!);
	}
	return out;
}

/** Coverage of one polygon set with a fill rule. */
function coverage(polys: Pt[][], rule: 'non-zero' | 'even-odd', width: number, height: number): Uint8Array {
	const acc = new Float32Array(width * height);
	type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number };
	const edges: Edge[] = [];
	for (const p of polys)
		for (let i = 0; i < p.length; i++) {
			const a = p[i]!;
			const b = p[(i + 1) % p.length]!;
			if (a[1] === b[1]) continue;
			edges.push(
				a[1] < b[1]
					? { x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: 1 }
					: { x0: b[0], y0: b[1], x1: a[0], y1: a[1], dir: -1 },
			);
		}
	const xs: { x: number; dir: number }[] = [];
	for (let y = 0; y < height; y++) {
		for (let s = 0; s < SUB; s++) {
			const sy = y + (s + 0.5) / SUB;
			xs.length = 0;
			for (const e of edges) {
				if (sy < e.y0 || sy >= e.y1) continue;
				xs.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
			}
			if (xs.length < 2) continue;
			xs.sort((a, b) => a.x - b.x);
			let wind = 0;
			for (let i = 0; i < xs.length - 1; i++) {
				wind += xs[i]!.dir;
				const inside = rule === 'even-odd' ? (i + 1) % 2 === 1 : wind !== 0;
				if (!inside) continue;
				spanCoverage(acc, y * width, width, xs[i]!.x, xs[i + 1]!.x, 1 / SUB);
			}
		}
	}
	const out = new Uint8Array(width * height);
	for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, acc[i]!) * 255);
	return out;
}

/** Adds the horizontal coverage of [xa, xb) on one row (fractional ends), weighted by `w`. */
function spanCoverage(
	acc: Float32Array,
	row: number,
	width: number,
	xa: number,
	xb: number,
	w: number,
): void {
	const a = Math.max(0, xa);
	const b = Math.min(width, xb);
	if (b <= a) return;
	const ia = Math.floor(a);
	const ib = Math.floor(b);
	if (ia === ib) {
		acc[row + ia]! += (b - a) * w;
		return;
	}
	acc[row + ia]! += (ia + 1 - a) * w;
	for (let x = ia + 1; x < ib && x < width; x++) acc[row + x]! += w;
	if (ib < width) acc[row + ib]! += (b - ib) * w;
}
