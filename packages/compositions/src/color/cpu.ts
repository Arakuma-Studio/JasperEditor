// CPU realization of a colour-run pass (S06:CG-043) for hosts whose WebGL2 is a software rasterizer
// (SwiftShader, llvmpipe): there the GPU path is dominated by the texture upload and the WebGL → 2D canvas
// read-back (measured 1080p: 255 ms GL vs 125 ms CPU; 960×540: 63 ms vs 22 ms, headless Chrome, 12 cores,
// no GPU), while the arithmetic is identical. Same tetrahedral interpolation as `applyLut` / `lut3d`, in
// float64, so it equals the TypeScript reference exactly (8-bit rounding by Uint8ClampedArray).
import type { Lut } from '@jasper/project';

export type PreparedLut = {
	/** Lattice offset of the lower corner per 8-bit code value, per axis (already × stride). */
	r0: Int32Array;
	g0: Int32Array;
	b0: Int32Array;
	/** Fractional position inside the cell per code value, per axis. */
	fr: Float64Array;
	fg: Float64Array;
	fb: Float64Array;
	sg: number;
	sb: number;
	/** Table values × 255. */
	d: Float64Array;
};

const prepared = new WeakMap<Lut, PreparedLut>();

/** Per-code-value lookup tables for a 3D LUT (cached per LUT object). */
export function prepareLut(lut: Lut): PreparedLut {
	const hit = prepared.get(lut);
	if (hit) return hit;
	const n = lut.size;
	const s = n - 1;
	const sg = 3 * n;
	const sb = 3 * n * n;
	const axis = (k: number, stride: number) => {
		const off = new Int32Array(256);
		const frac = new Float64Array(256);
		const lo = lut.domainMin[k]!;
		const hi = lut.domainMax[k]!;
		for (let v = 0; v < 256; v++) {
			const t = (v / 255 - lo) / (hi - lo);
			const x = (t < 0 ? 0 : t > 1 ? 1 : t) * s;
			const i = Math.min(s - 1, Math.floor(x));
			off[v] = i * stride;
			frac[v] = x - i;
		}
		return [off, frac] as const;
	};
	const [r0, fr] = axis(0, 3);
	const [g0, fg] = axis(1, sg);
	const [b0, fb] = axis(2, sb);
	const d = new Float64Array(lut.data.length);
	for (let i = 0; i < d.length; i++) d[i] = lut.data[i]! * 255;
	const p: PreparedLut = { r0, g0, b0, fr, fg, fb, sg, sb, d };
	prepared.set(lut, p);
	return p;
}

/** Applies a 3D LUT in place to straight-alpha RGBA8 pixels (alpha untouched). */
export function applyLutRgba8(lut: Lut, px: Uint8ClampedArray): void {
	const { r0, g0, b0, fr: FR, fg: FG, fb: FB, sg, sb, d } = prepareLut(lut);
	for (let p = 0; p < px.length; p += 4) {
		const R = px[p]!;
		const G = px[p + 1]!;
		const B = px[p + 2]!;
		const fr = FR[R]!;
		const fg = FG[G]!;
		const fb = FB[B]!;
		const c000 = r0[R]! + g0[G]! + b0[B]!;
		const c111 = c000 + 3 + sg + sb;
		let a: number;
		let b: number;
		let w0: number;
		let w1: number;
		let w2: number;
		let w3: number;
		if (fr > fg) {
			if (fg > fb) {
				a = c000 + 3;
				b = c000 + 3 + sg;
				w0 = 1 - fr;
				w1 = fr - fg;
				w2 = fg - fb;
				w3 = fb;
			} else if (fr > fb) {
				a = c000 + 3;
				b = c000 + 3 + sb;
				w0 = 1 - fr;
				w1 = fr - fb;
				w2 = fb - fg;
				w3 = fg;
			} else {
				a = c000 + sb;
				b = c000 + 3 + sb;
				w0 = 1 - fb;
				w1 = fb - fr;
				w2 = fr - fg;
				w3 = fg;
			}
		} else if (fb > fg) {
			a = c000 + sb;
			b = c000 + sg + sb;
			w0 = 1 - fb;
			w1 = fb - fg;
			w2 = fg - fr;
			w3 = fr;
		} else if (fb > fr) {
			a = c000 + sg;
			b = c000 + sg + sb;
			w0 = 1 - fg;
			w1 = fg - fb;
			w2 = fb - fr;
			w3 = fr;
		} else {
			a = c000 + sg;
			b = c000 + 3 + sg;
			w0 = 1 - fg;
			w1 = fg - fr;
			w2 = fr - fb;
			w3 = fb;
		}
		// Uint8ClampedArray stores round-to-nearest with clamping.
		px[p] = w0 * d[c000]! + w1 * d[a]! + w2 * d[b]! + w3 * d[c111]!;
		px[p + 1] = w0 * d[c000 + 1]! + w1 * d[a + 1]! + w2 * d[b + 1]! + w3 * d[c111 + 1]!;
		px[p + 2] = w0 * d[c000 + 2]! + w1 * d[a + 2]! + w2 * d[b + 2]! + w3 * d[c111 + 2]!;
	}
}
