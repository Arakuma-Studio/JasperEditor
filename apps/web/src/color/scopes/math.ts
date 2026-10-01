// Scope maths (S06:SCP-001/003): pure functions over a read-back RGBA frame (≤ 256 px wide). Waveform (luma and
// RGB parade), Rec.709 YUV vectorscope with 75 % targets and the skin-tone line, and the histogram. They count
// hits into density planes; `renderDensity` maps densities to trace pixels (log scale) with a given colour, so
// the worker can hand an ImageData to the panel. No DOM, no colours of their own (colours are passed in).

export type ScopeMode = 'waveform' | 'parade' | 'vectorscope' | 'histogram';
export const SCOPE_MODES: readonly ScopeMode[] = ['waveform', 'parade', 'vectorscope', 'histogram'];

export type RGB = readonly [number, number, number];

/** Rec.709 luma weights (the same `Y` as the grade maths, S06 §3). */
export const KR = 0.2126;
export const KG = 0.7152;
export const KB = 0.0722;

export const luma = (r: number, g: number, b: number) => KR * r + KG * g + KB * b;

/** Rec.709 colour difference, normalised to ±0.5: Cb = (B − Y)/1.8556, Cr = (R − Y)/1.5748 (inputs 0..1). */
export function ycbcr(r: number, g: number, b: number): { y: number; cb: number; cr: number } {
	const y = luma(r, g, b);
	return { y, cb: (b - y) / (2 * (1 - KB)), cr: (r - y) / (2 * (1 - KR)) };
}

export type Plane = { width: number; height: number; counts: Uint32Array };

const plane = (width: number, height: number): Plane => ({
	width,
	height,
	counts: new Uint32Array(width * height),
});

/**
 * Waveform: for every source column band the distribution of values (bottom = 0, top = 1). `luma` counts `Y`;
 * `parade` returns three planes (R, G, B), each `outW` wide (the panel draws them side by side).
 */
export function waveform(
	data: Uint8ClampedArray | Uint8Array,
	w: number,
	h: number,
	outW: number,
	outH: number,
	kind: 'luma' | 'parade',
): Plane[] {
	const planes =
		kind === 'luma' ? [plane(outW, outH)] : [plane(outW, outH), plane(outW, outH), plane(outW, outH)];
	const sx = outW / w;
	const top = outH - 1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			if (data[i + 3] === 0) continue;
			const col = Math.min(outW - 1, Math.floor(x * sx));
			const r = data[i]! / 255;
			const g = data[i + 1]! / 255;
			const b = data[i + 2]! / 255;
			if (kind === 'luma') {
				const row = top - Math.round(luma(r, g, b) * top);
				planes[0]!.counts[row * outW + col]!++;
			} else {
				planes[0]!.counts[(top - Math.round(r * top)) * outW + col]!++;
				planes[1]!.counts[(top - Math.round(g * top)) * outW + col]!++;
				planes[2]!.counts[(top - Math.round(b * top)) * outW + col]!++;
			}
		}
	}
	return planes;
}

/** Position of a (Cb, Cr) pair on a `size`² vectorscope (centre = neutral, +Cr up, +Cb right; ±0.5 at the edge). */
export function vectorscopePoint(cb: number, cr: number, size: number): { x: number; y: number } {
	const half = (size - 1) / 2;
	return { x: half + cb * 2 * half, y: half - cr * 2 * half };
}

export function vectorscope(data: Uint8ClampedArray | Uint8Array, w: number, h: number, size: number): Plane {
	const p = plane(size, size);
	for (let i = 0; i < w * h * 4; i += 4) {
		if (data[i + 3] === 0) continue;
		const { cb, cr } = ycbcr(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255);
		const { x, y } = vectorscopePoint(cb, cr, size);
		const xi = Math.min(size - 1, Math.max(0, Math.round(x)));
		const yi = Math.min(size - 1, Math.max(0, Math.round(y)));
		p.counts[yi * size + xi]!++;
	}
	return p;
}

export type Histogram = { r: Uint32Array; g: Uint32Array; b: Uint32Array; y: Uint32Array };

/** 256-bin histograms of R, G, B and luma (8-bit code values). */
export function histogram(data: Uint8ClampedArray | Uint8Array, w: number, h: number): Histogram {
	const out: Histogram = {
		r: new Uint32Array(256),
		g: new Uint32Array(256),
		b: new Uint32Array(256),
		y: new Uint32Array(256),
	};
	for (let i = 0; i < w * h * 4; i += 4) {
		if (data[i + 3] === 0) continue;
		const r = data[i]!;
		const g = data[i + 1]!;
		const b = data[i + 2]!;
		out.r[r]!++;
		out.g[g]!++;
		out.b[b]!++;
		out.y[Math.min(255, Math.round(luma(r, g, b)))]!++;
	}
	return out;
}

/** The six 75 % colour-bar targets (R, Mg, B, Cy, G, Yl) as (Cb, Cr). */
export function vectorscopeTargets(level = 0.75): { name: string; cb: number; cr: number }[] {
	const bars: [string, number, number, number][] = [
		['R', 1, 0, 0],
		['Mg', 1, 0, 1],
		['B', 0, 0, 1],
		['Cy', 0, 1, 1],
		['G', 0, 1, 0],
		['Yl', 1, 1, 0],
	];
	return bars.map(([name, r, g, b]) => {
		const { cb, cr } = ycbcr(r * level, g * level, b * level);
		return { name, cb, cr };
	});
}

/** Skin-tone ("I") line: 123° counter-clockwise from the +Cb axis. Returns its unit direction in (Cb, Cr). */
export function skinToneDirection(): { cb: number; cr: number } {
	const a = (123 * Math.PI) / 180;
	return { cb: Math.cos(a), cr: Math.sin(a) };
}

/**
 * Density → RGBA trace pixels with a log response (`gain` scales the brightness). Transparent where empty so
 * the panel's background and graticule show through.
 */
export function renderDensity(
	counts: Uint32Array,
	width: number,
	height: number,
	color: RGB,
	out: Uint8ClampedArray = new Uint8ClampedArray(width * height * 4),
	opts: { gain?: number; xOffset?: number; stride?: number; additive?: boolean } = {},
): Uint8ClampedArray {
	const gain = opts.gain ?? 1;
	const stride = opts.stride ?? width;
	const x0 = opts.xOffset ?? 0;
	let max = 0;
	for (let i = 0; i < counts.length; i++) if (counts[i]! > max) max = counts[i]!;
	if (max === 0) return out;
	const norm = 1 / Math.log1p(max);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const c = counts[y * width + x]!;
			if (c === 0) continue;
			const a = Math.min(1, Math.log1p(c) * norm * gain * 1.6 + 0.18);
			const o = (y * stride + x + x0) * 4;
			if (opts.additive) {
				out[o] = Math.min(255, out[o]! + color[0] * a);
				out[o + 1] = Math.min(255, out[o + 1]! + color[1] * a);
				out[o + 2] = Math.min(255, out[o + 2]! + color[2] * a);
				out[o + 3] = Math.max(out[o + 3]!, 255 * a);
			} else {
				out[o] = color[0];
				out[o + 1] = color[1];
				out[o + 2] = color[2];
				out[o + 3] = 255 * a;
			}
		}
	}
	return out;
}

export type ScopeRequest = {
	id: number;
	mode: ScopeMode;
	data: Uint8ClampedArray;
	width: number;
	height: number;
	/** Output raster size. */
	outW: number;
	outH: number;
	colors: { trace: RGB; luma: RGB; red: RGB; green: RGB; blue: RGB };
	gain?: number;
};

export type ScopeResult = {
	id: number;
	mode: ScopeMode;
	width: number;
	height: number;
	/** RGBA trace image (waveform, parade, vectorscope); empty for the histogram. */
	image: Uint8ClampedArray;
	histogram?: Histogram;
};

/** Everything the worker does for one frame (also used synchronously when Workers are unavailable). */
export function computeScope(req: ScopeRequest): ScopeResult {
	const { data, width, height, outW, outH, colors, gain } = req;
	if (req.mode === 'histogram')
		return {
			id: req.id,
			mode: req.mode,
			width: 0,
			height: 0,
			image: new Uint8ClampedArray(0),
			histogram: histogram(data, width, height),
		};
	if (req.mode === 'vectorscope') {
		const size = Math.min(outW, outH);
		const p = vectorscope(data, width, height, size);
		return {
			id: req.id,
			mode: req.mode,
			width: size,
			height: size,
			image: renderDensity(p.counts, size, size, colors.trace, undefined, { gain }),
		};
	}
	if (req.mode === 'waveform') {
		const [p] = waveform(data, width, height, outW, outH, 'luma');
		return {
			id: req.id,
			mode: req.mode,
			width: outW,
			height: outH,
			image: renderDensity(p!.counts, outW, outH, colors.luma, undefined, { gain }),
		};
	}
	// RGB parade: three bands side by side.
	const band = Math.max(1, Math.floor(outW / 3));
	const planes = waveform(data, width, height, band, outH, 'parade');
	const image = new Uint8ClampedArray(band * 3 * outH * 4);
	const cols = [colors.red, colors.green, colors.blue];
	planes.forEach((p, i) => {
		renderDensity(p.counts, band, outH, cols[i]!, image, { gain, xOffset: i * band, stride: band * 3 });
	});
	return { id: req.id, mode: req.mode, width: band * 3, height: outH, image };
}
