// three-d: Classic 3D depth of field — a bokeh-shaped gather blur (CPU reference; the GL renderer gathers with the
// same row-span kernels over row prefix sums). Port of EffectCraft `render/three_d/bokeh.rs` (MIT OR Apache-2.0).
// Iris Shape (Fast Rectangle or a 3…10-sided polygon), Rotation, Roundness and Aspect Ratio shape the kernel; Iris
// Diffraction Fringe brightens its rim; Highlight Gain / Threshold / Saturation boost the bright parts before the
// blur. A plane whose depth varies is blurred progressively: at up to eight radii, each pixel blending the two levels
// that bracket its own circle of confusion.
import { luminance709 } from '../blend-modes.ts';
import type { Highlight, Iris } from './scene.ts';

/** A premultiplied float RGBA image. */
export type FloatImage = { width: number; height: number; data: Float32Array };

export function newFloatImage(width: number, height: number): FloatImage {
	return { width, height, data: new Float32Array(Math.max(0, width * height * 4)) };
}

/** A kernel row: offset `dy`, fractional x extent [x0, x1]. */
export type Span = [dy: number, x0: number, x1: number];
/** Weighted span sets and the sum of weights × areas. */
export type Kernels = { kernels: { weight: number; spans: Span[] }[]; norm: number };

const TAU = Math.PI * 2;

/** Normalised boundary distance (1 = circumscribed circle) of the iris at angle `a`. */
function boundary(iris: Iris, a: number): number {
	const n = Math.max(3, iris.sides);
	const seg = TAU / n;
	const rel = ((((a - (iris.rotation * Math.PI) / 180) % seg) + seg) % seg) - seg * 0.5;
	const poly = Math.cos(Math.PI / n) / Math.cos(rel);
	const r = Math.min(1, Math.max(-1, iris.roundness));
	return r >= 0 ? poly + (1 - poly) * r : Math.max(0.05, poly + (1 - poly) * r * 2);
}

function inside(iris: Iris, r: number, dx: number, dy: number): boolean {
	const a = Math.sqrt(Math.min(100, Math.max(0.01, iris.aspect)));
	const u = dx / a;
	const v = dy * a;
	const d = Math.hypot(u, v);
	return d < 1e-9 || d <= boundary(iris, Math.atan2(v, u)) * r;
}

/** The iris of radius `r` as horizontal spans (see EffectCraft `Iris::spans`). */
export function irisSpans(iris: Iris, r: number): Span[] {
	const a = Math.sqrt(Math.min(100, Math.max(0.01, iris.aspect)));
	const extX = r * a + 1;
	const extY = Math.ceil(r / a) + 1;
	const out: Span[] = [];
	const step = 0.5;
	for (let dy = -extY; dy <= extY; dy++) {
		let first: number | null = null;
		let last: number | null = null;
		for (let x = -extX; x <= extX; x += step) {
			if (inside(iris, r, x, dy)) {
				if (first === null) first = x;
				last = x;
			}
		}
		if (first === null || last === null) continue;
		const refine = (inX: number, outX: number) => {
			let i = inX;
			let o = outX;
			for (let k = 0; k < 12; k++) {
				const m = (i + o) * 0.5;
				if (inside(iris, r, m, dy)) i = m;
				else o = m;
			}
			return (i + o) * 0.5;
		};
		out.push([dy, refine(first, first - step), refine(last, last + step)]);
	}
	return out;
}

/** Bokeh kernel of radius `r` as weighted spans; null when it does nothing (r < 0.3 px). */
export function kernelSpans(iris: Iris, r: number): Kernels | null {
	if (!(r >= 0.3)) return null;
	if (iris.sides === 0) {
		const a = Math.sqrt(Math.min(100, Math.max(0.01, iris.aspect)));
		const rx = Math.max(0, Math.round(r * a));
		const ry = Math.max(0, Math.round(r / a));
		if (rx === 0 && ry === 0) return null;
		const spans: Span[] = [];
		for (let dy = -ry; dy <= ry; dy++) spans.push([dy, -rx - 0.5, rx + 0.5]);
		return { kernels: [{ weight: 1, spans }], norm: (2 * rx + 1) * (2 * ry + 1) };
	}
	const outer = irisSpans(iris, r);
	const area = (sp: Span[]) => sp.reduce((s, x) => s + (x[2] - x[1]), 0);
	const kernels = [{ weight: 1, spans: outer }];
	if (iris.fringe > 0) {
		const rim = Math.max(1, r * 0.15);
		const inner = r - rim > 0.5 ? irisSpans(iris, r - rim) : [];
		kernels[0]!.weight = 1 + iris.fringe;
		kernels.push({ weight: -iris.fringe, spans: inner });
	}
	const norm = kernels.reduce((s, k) => s + k.weight * area(k.spans), 0);
	return norm > 0 ? { kernels, norm } : null;
}

/** Row prefix sums per channel: p[y][(x)·4 + c] = sum of pixels 0…x−1. */
function rowPrefix(img: FloatImage): Float64Array[] {
	const w = img.width;
	const rows: Float64Array[] = [];
	for (let y = 0; y < img.height; y++) {
		const p = new Float64Array((w + 1) * 4);
		for (let x = 0; x < w; x++)
			for (let c = 0; c < 4; c++) p[(x + 1) * 4 + c] = p[x * 4 + c]! + img.data[(y * w + x) * 4 + c]!;
		rows.push(p);
	}
	return rows;
}

/** Continuous prefix: sum over [0, t) with linear interpolation inside a pixel. */
function prefixAt(p: Float64Array, n: number, t: number, c: number): number {
	if (t <= 0) return 0;
	if (t >= n) return p[n * 4 + c]!;
	const i = Math.floor(t);
	const f = t - i;
	const a = p[i * 4 + c]!;
	return a + (p[(i + 1) * 4 + c]! - a) * f;
}

/** Gather blur with span kernels (pixels beyond the image are transparent). */
export function spanGather(img: FloatImage, k: Kernels): FloatImage {
	const pre = rowPrefix(img);
	const { width: w, height: h } = img;
	const out = newFloatImage(w, h);
	const inv = 1 / k.norm;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4;
			for (const { weight, spans } of k.kernels)
				for (const [dy, x0, x1] of spans) {
					const sy = y + dy;
					if (sy < 0 || sy >= h) continue;
					const pr = pre[sy]!;
					for (let c = 0; c < 4; c++)
						out.data[o + c] =
							out.data[o + c]! +
							(prefixAt(pr, w, x + x1 + 0.5, c) - prefixAt(pr, w, x + x0 + 0.5, c)) * weight;
				}
			for (let c = 0; c < 4; c++) out.data[o + c] = out.data[o + c]! * inv;
		}
	return out;
}

/** Bokeh blur of radius `r` (pixels). */
export function bokehBlur(img: FloatImage, iris: Iris, r: number): FloatImage {
	const k = kernelSpans(iris, r);
	return k ? spanGather(img, k) : { ...img, data: img.data.slice() };
}

/** Boosts the highlights of a premultiplied image in place (Highlight Gain / Threshold / Saturation). */
export function boostHighlights(img: FloatImage, hl: Highlight): void {
	if (hl.gain <= 0) return;
	const thr = Math.min(1, Math.max(0, hl.threshold));
	const d = img.data;
	for (let i = 0; i < d.length; i += 4) {
		const a = d[i + 3]!;
		if (a <= 0) continue;
		const r = d[i]! / a;
		const g = d[i + 1]! / a;
		const b = d[i + 2]! / a;
		const l = luminance709(r, g, b);
		if (l < thr || (thr >= 1 && l < 1)) continue;
		const over = thr < 1 ? Math.min(1, Math.max(0, (l - thr) / (1 - thr))) : 1;
		const k = 1 + hl.gain * 4 * Math.max(0.25, over);
		const sat = 1 + hl.saturation;
		d[i] = Math.max(0, l + (r - l) * sat) * k * a;
		d[i + 1] = Math.max(0, l + (g - l) * sat) * k * a;
		d[i + 2] = Math.max(0, l + (b - l) * sat) * k * a;
	}
}

/** The blur levels of a depth-varying blur: null when nothing blurs; one for a near-constant radius; ≤ 8. */
export function blurLevels(radius: ArrayLike<number>): number[] | null {
	let lo = Number.POSITIVE_INFINITY;
	let hi = 0;
	for (let i = 0; i < radius.length; i++) {
		lo = Math.min(lo, radius[i]!);
		hi = Math.max(hi, radius[i]!);
	}
	if (!Number.isFinite(lo) || hi < 0.3) return null;
	if (hi - lo < 0.75) return [(lo + hi) * 0.5];
	const n = Math.min(8, Math.max(2, Math.ceil((hi - lo) / 2) + 1));
	return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

/** Depth-varying blur: `radius[i]` = blur radius of pixel i (row-major). */
export function progressiveBlur(
	img: FloatImage,
	iris: Iris,
	radius: ArrayLike<number>,
	given?: number[] | null,
): FloatImage {
	const levels = given === undefined ? blurLevels(radius) : given;
	if (!levels) return { ...img, data: img.data.slice() };
	if (levels.length === 1) return bokehBlur(img, iris, levels[0]!);
	const n = levels.length;
	const lo = levels[0]!;
	const hi = levels[n - 1]!;
	const blurred = levels.map((r) => bokehBlur(img, iris, r));
	const out = newFloatImage(img.width, img.height);
	for (let i = 0; i < img.width * img.height; i++) {
		const f = Math.min(n - 1, Math.max(0, ((radius[i]! - lo) / (hi - lo)) * (n - 1)));
		const k = Math.min(n - 2, Math.floor(f));
		const t = f - k;
		const a = blurred[k]!.data;
		const b = blurred[k + 1]!.data;
		for (let c = 0; c < 4; c++) out.data[i * 4 + c] = a[i * 4 + c]! + (b[i * 4 + c]! - a[i * 4 + c]!) * t;
	}
	return out;
}

/** Padding (pixels) a buffer needs around it for a blur of largest radius `rmax`. */
export function dofPad(iris: Iris, rmax: number): number {
	const a = Math.min(100, Math.max(0.01, iris.aspect));
	return Math.ceil(rmax * Math.max(Math.sqrt(a), 1 / Math.sqrt(a))) + 2;
}
