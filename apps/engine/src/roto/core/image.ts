// Small image helpers of the roto pipeline: 8-bit RGB → float, bilinear resampling of RGB images and planes (area
// averaging when shrinking a lot), luma. Pixel centres at +0.5 everywhere.

/** Straight RGB 0..1 floats from 8-bit `rgb24`. */
export function rgbFloat(rgb8: Uint8Array): Float32Array {
	const out = new Float32Array(rgb8.length);
	for (let i = 0; i < rgb8.length; i++) out[i] = rgb8[i]! / 255;
	return out;
}

/** 8-bit luma (Rec.709) of `rgb24`. */
export function luma8(rgb8: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++)
		out[i] = Math.round(0.2126 * rgb8[i * 3]! + 0.7152 * rgb8[i * 3 + 1]! + 0.0722 * rgb8[i * 3 + 2]!);
	return out;
}

/**
 * Resamples a `c`-channel float image (interleaved) to `ow × oh`: bilinear when the scale is ≥ ½ per axis, otherwise
 * a box average over the source footprint (no aliasing).
 */
export function resample(
	src: Float32Array,
	w: number,
	h: number,
	c: number,
	ow: number,
	oh: number,
): Float32Array {
	if (ow === w && oh === h) return src.slice();
	const out = new Float32Array(ow * oh * c);
	const sx = w / ow;
	const sy = h / oh;
	if (sx <= 2 && sy <= 2) {
		for (let y = 0; y < oh; y++) {
			const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
			const y0 = Math.floor(fy);
			const y1 = Math.min(h - 1, y0 + 1);
			const ty = fy - y0;
			for (let x = 0; x < ow; x++) {
				const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
				const x0 = Math.floor(fx);
				const x1 = Math.min(w - 1, x0 + 1);
				const tx = fx - x0;
				for (let k = 0; k < c; k++) {
					const a = src[(y0 * w + x0) * c + k]!;
					const b = src[(y0 * w + x1) * c + k]!;
					const d = src[(y1 * w + x0) * c + k]!;
					const e = src[(y1 * w + x1) * c + k]!;
					const top = a + (b - a) * tx;
					const bot = d + (e - d) * tx;
					out[(y * ow + x) * c + k] = top + (bot - top) * ty;
				}
			}
		}
		return out;
	}
	for (let y = 0; y < oh; y++) {
		const ya = y * sy;
		const yb = Math.min(h, (y + 1) * sy);
		for (let x = 0; x < ow; x++) {
			const xa = x * sx;
			const xb = Math.min(w, (x + 1) * sx);
			const acc = new Float64Array(c);
			let wsum = 0;
			for (let j = Math.floor(ya); j < Math.ceil(yb); j++) {
				const wy = Math.min(yb, j + 1) - Math.max(ya, j);
				if (wy <= 0) continue;
				for (let i = Math.floor(xa); i < Math.ceil(xb); i++) {
					const wx = Math.min(xb, i + 1) - Math.max(xa, i);
					if (wx <= 0) continue;
					const wgt = wx * wy;
					wsum += wgt;
					for (let k = 0; k < c; k++) acc[k] = acc[k]! + src[(j * w + i) * c + k]! * wgt;
				}
			}
			for (let k = 0; k < c; k++) out[(y * ow + x) * c + k] = acc[k]! / Math.max(1e-12, wsum);
		}
	}
	return out;
}

/** The working (matte) size of a picture: the display size, longest side capped at `maxSide`. */
export function matteSize(width: number, height: number, maxSide: number): { width: number; height: number } {
	const s = Math.min(1, maxSide / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}
