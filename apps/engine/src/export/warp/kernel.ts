// The warp kernel of the native warp stage (S09:TRK-032…034, ARCHITECTURE D-28): one straight-alpha RGBA source
// frame → one sequence-sized straight-alpha frame through a projective map. It samples like the preview's CSS
// `matrix3d` (pixel centres, bilinear): destination pixel centre (x + ½, y + ½) → source point p through the
// inverse map, bilinear over the texels around p − ½ with premultiplied colour, texels outside the source are
// transparent (antialiased edges), then un-premultiply and multiply alpha by the layer opacity.
//
// Output formats: `rgba` (8-bit, interleaved) or `yuva444p10` (planar little-endian 10-bit Y, Cb, Cr, A:
// BT.709 TV-range colour from the unrounded RGB, full-range alpha) which the ProRes 4444 encoder takes as is, so
// the RGB → YUV conversion runs in the worker threads instead of a single-threaded ffmpeg scaler.
//
// `warpFrame` is self-contained (no imports, no closures over module scope): its source text also runs inside
// the worker threads (see pool.ts), so tests and production share one implementation.
import type { Mat3 } from '@jasper/project';

/** Destination rectangle `[x0, y0, x1, y1)` in pixels. */
export type PixelRect = [number, number, number, number];

export type WarpOutputFormat = 'rgba' | 'yuva444p10';

/** Bytes of one destination frame. */
export function frameBytes(format: WarpOutputFormat, width: number, height: number): number {
	return width * height * (format === 'rgba' ? 4 : 8);
}

/**
 * Warps `src` (`sw×sh` RGBA, straight alpha) into `dst` (`dw×dh`, `format`). `inv` maps destination pixel
 * coordinates to source pixel coordinates (row-major 3×3). Only `rect` is computed; `dst` outside it is cleared
 * (transparent). `inv` or `rect` null = a fully transparent frame.
 */
export function warpFrame(
	src: Uint8Array,
	sw: number,
	sh: number,
	dstBytes: Uint8Array,
	dw: number,
	dh: number,
	format: 'rgba' | 'yuva444p10',
	inv: ArrayLike<number> | null,
	opacity: number,
	rect: ArrayLike<number> | null,
): void {
	const yuv = format === 'yuva444p10';
	const plane = dw * dh;
	const d8 = dstBytes;
	const d16 = yuv ? new Uint16Array(dstBytes.buffer, dstBytes.byteOffset, plane * 4) : null;
	// Transparent frame: black, alpha 0 (Y 64, Cb/Cr 512 in 10-bit TV range).
	if (d16) {
		d16.fill(64, 0, plane);
		d16.fill(512, plane, 3 * plane);
		d16.fill(0, 3 * plane, 4 * plane);
	} else d8.fill(0);
	if (!inv || !rect || !(opacity > 0)) return;
	const x0 = Math.max(0, Math.floor(rect[0]!));
	const y0 = Math.max(0, Math.floor(rect[1]!));
	const x1 = Math.min(dw, Math.ceil(rect[2]!));
	const y1 = Math.min(dh, Math.ceil(rect[3]!));
	if (x1 <= x0 || y1 <= y0) return;
	const m0 = inv[0]!;
	const m1 = inv[1]!;
	const m2 = inv[2]!;
	const m3 = inv[3]!;
	const m4 = inv[4]!;
	const m5 = inv[5]!;
	const m6 = inv[6]!;
	const m7 = inv[7]!;
	const m8 = inv[8]!;
	const op = Math.min(1, opacity);
	// Texels as little-endian 32-bit words (R | G << 8 | B << 16 | A << 24): one load per texel.
	const s32 =
		src.byteOffset % 4 === 0
			? new Uint32Array(src.buffer, src.byteOffset, sw * sh)
			: new Uint32Array(src.slice(0, sw * sh * 4).buffer);
	const maxU = sw - 1;
	const maxV = sh - 1;
	const affine = m6 === 0 && m7 === 0;
	const affineK = 1 / m8;
	// BT.709, 8-bit full-range RGB → 10-bit TV-range Y'CbCr; alpha 8 → 10 bit.
	const KR = 0.2126;
	const KB = 0.0722;
	const KG = 1 - KR - KB;
	const YS = 876 / 255;
	const CBS = 896 / 255 / (2 * (1 - KB));
	const CRS = 896 / 255 / (2 * (1 - KR));
	const AS = (1023 / 255) * op;
	const plane2 = 2 * plane;
	const plane3 = 3 * plane;
	for (let y = y0; y < y1; y++) {
		const Y = y + 0.5;
		// Numerators/denominator are linear in x: step them along the row.
		const X0 = x0 + 0.5;
		let nx = m0 * X0 + m1 * Y + m2;
		let ny = m3 * X0 + m4 * Y + m5;
		let nw = m6 * X0 + m7 * Y + m8;
		let i = y * dw + x0;
		for (let x = x0; x < x1; x++, nx += m0, ny += m3, nw += m6, i++) {
			let kw = affineK;
			if (!affine) {
				if (nw <= 1e-12) continue;
				kw = 1 / nw;
			}
			const u = nx * kw - 0.5;
			const v = ny * kw - 0.5;
			if (u <= -1 || v <= -1 || u >= sw || v >= sh) continue;
			// u, v > −1: truncation of u + 1 is floor(u) + 1.
			const iu = ((u + 1) | 0) - 1;
			const iv = ((v + 1) | 0) - 1;
			const fx = u - iu;
			const fy = v - iv;
			const gx = 1 - fx;
			const gy = 1 - fy;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			if (iu >= 0 && iv >= 0 && iu < maxU && iv < maxV) {
				// Interior: all four texels exist.
				const p = iv * sw + iu;
				const t00 = s32[p]!;
				const t10 = s32[p + 1]!;
				const t01 = s32[p + sw]!;
				const t11 = s32[p + sw + 1]!;
				const w00 = gx * gy;
				const w10 = fx * gy;
				const w01 = gx * fy;
				const w11 = fx * fy;
				if ((t00 & t10 & t01 & t11) >>> 24 === 255) {
					// Opaque texels: plain bilinear.
					a = 255;
					r = (t00 & 255) * w00 + (t10 & 255) * w10 + (t01 & 255) * w01 + (t11 & 255) * w11;
					g =
						((t00 >> 8) & 255) * w00 +
						((t10 >> 8) & 255) * w10 +
						((t01 >> 8) & 255) * w01 +
						((t11 >> 8) & 255) * w11;
					b =
						((t00 >> 16) & 255) * w00 +
						((t10 >> 16) & 255) * w10 +
						((t01 >> 16) & 255) * w01 +
						((t11 >> 16) & 255) * w11;
				} else {
					const a00 = (t00 >>> 24) * w00;
					const a10 = (t10 >>> 24) * w10;
					const a01 = (t01 >>> 24) * w01;
					const a11 = (t11 >>> 24) * w11;
					a = a00 + a10 + a01 + a11;
					if (a <= 0) continue;
					const k = 1 / a;
					r = ((t00 & 255) * a00 + (t10 & 255) * a10 + (t01 & 255) * a01 + (t11 & 255) * a11) * k;
					g =
						(((t00 >> 8) & 255) * a00 +
							((t10 >> 8) & 255) * a10 +
							((t01 >> 8) & 255) * a01 +
							((t11 >> 8) & 255) * a11) *
						k;
					b =
						(((t00 >> 16) & 255) * a00 +
							((t10 >> 16) & 255) * a10 +
							((t01 >> 16) & 255) * a01 +
							((t11 >> 16) & 255) * a11) *
						k;
				}
			} else {
				// Border: texels outside the source are transparent.
				for (let t = 0; t < 4; t++) {
					const tu = iu + (t & 1);
					const tv = iv + (t >> 1);
					if (tu < 0 || tv < 0 || tu > maxU || tv > maxV) continue;
					const px = s32[tv * sw + tu]!;
					const wa = (px >>> 24) * (t & 1 ? fx : gx) * (t >> 1 ? fy : gy);
					a += wa;
					r += (px & 255) * wa;
					g += ((px >> 8) & 255) * wa;
					b += ((px >> 16) & 255) * wa;
				}
				if (a <= 0) continue;
				const k = 1 / a;
				r *= k;
				g *= k;
				b *= k;
			}
			if (d16) {
				const l = KR * r + KG * g + KB * b;
				d16[i] = 64 + l * YS + 0.5;
				d16[plane + i] = 512 + (b - l) * CBS + 0.5;
				d16[plane2 + i] = 512 + (r - l) * CRS + 0.5;
				d16[plane3 + i] = a * AS + 0.5;
			} else {
				const o = i * 4;
				d8[o] = r + 0.5;
				d8[o + 1] = g + 0.5;
				d8[o + 2] = b + 0.5;
				d8[o + 3] = a * op + 0.5;
			}
		}
	}
}

/**
 * Integer destination rectangle covering the image of the source rectangle `(0,0)-(sw,sh)` under `fwd`
 * (source px → destination px), grown by one pixel for the bilinear fringe and clamped to `dw×dh`; null when
 * nothing is visible. Corners behind the projection plane (w ≤ 0) make the whole frame the rectangle.
 */
export function destRect(fwd: Mat3, sw: number, sh: number, dw: number, dh: number): PixelRect | null {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const [u, v] of [
		[0, 0],
		[sw, 0],
		[sw, sh],
		[0, sh],
	] as const) {
		const w = fwd[6] * u + fwd[7] * v + fwd[8];
		if (!(w > 1e-12)) return [0, 0, dw, dh];
		const x = (fwd[0] * u + fwd[1] * v + fwd[2]) / w;
		const y = (fwd[3] * u + fwd[4] * v + fwd[5]) / w;
		if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0, dw, dh];
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	const r: PixelRect = [
		Math.max(0, Math.floor(x0) - 1),
		Math.max(0, Math.floor(y0) - 1),
		Math.min(dw, Math.ceil(x1) + 1),
		Math.min(dh, Math.ceil(y1) + 1),
	];
	return r[2] > r[0] && r[3] > r[1] ? r : null;
}
