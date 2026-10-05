// The sub-pixel layer kernel (wave1b native-subpixel, S03:DM-012): draws one decoded RGBA picture (straight alpha)
// through an affine map into a small RGBA frame, the way a browser composites a transformed layer box:
// - the picture's visible rectangle (the picture, or its crop, S01:FX-003) gets anti-aliased edges from geometric
//   coverage (signed distance of the pixel centre to
//   each edge, in output pixels; ½ px ramp on each side, product at corners), so its edges move continuously at any
//   scale (bilinear "texels outside are transparent" edges step under minification and wobble under magnification);
// - the colour is sampled bilinearly at pixel centres with clamp-to-edge, on premultiplied colour;
// - alpha = picture alpha × coverage × opacity, written as straight-alpha RGBA.
//
// `drawLayer` is self-contained (no imports, no closures over module scope): its source text runs inside the worker
// threads (pool.ts), so tests and production share one implementation.

/**
 * Draws `src` (`sw` px wide rows, picture in its top-left `cw×ch`) into `dst` (`dw×dh` RGBA). `inv` maps output
 * pixel coordinates to picture coordinates (affine, row-major 2×3: u = m0·x + m1·y + m2, v = m3·x + m4·y + m5).
 * `clip` (`[u0, v0, u1, v1]`, picture px, fractions allowed) is the visible part. Only `rect` (`[x0, y0, x1, y1)`,
 * output px) is drawn; the rest of `dst` is cleared. `inv` null = a transparent frame.
 */
export function drawLayer(
	src: Uint8Array,
	sw: number,
	cw: number,
	ch: number,
	clip: ArrayLike<number>,
	dst: Uint8Array,
	dw: number,
	dh: number,
	inv: ArrayLike<number> | null,
	opacity: number,
	rect: ArrayLike<number> | null,
): void {
	dst.fill(0);
	if (!inv || !rect || !(opacity > 0) || cw < 1 || ch < 1) return;
	const cu0 = Math.max(0, clip[0]!);
	const cv0 = Math.max(0, clip[1]!);
	const cu1 = Math.min(cw, clip[2]!);
	const cv1 = Math.min(ch, clip[3]!);
	if (cu1 <= cu0 || cv1 <= cv0) return;
	// Sample positions stay on the visible texels (clamp to edge).
	const lu = Math.min(cu0 + 0.5, (cu0 + cu1) / 2);
	const hu = Math.max(cu1 - 0.5, (cu0 + cu1) / 2);
	const lv = Math.min(cv0 + 0.5, (cv0 + cv1) / 2);
	const hv = Math.max(cv1 - 0.5, (cv0 + cv1) / 2);
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
	// Output px per picture px across each picture axis: distances to the visible rectangle's edges.
	const gu = 1 / Math.hypot(m0, m1);
	const gv = 1 / Math.hypot(m3, m4);
	const op = Math.min(1, opacity);
	const s32 =
		src.byteOffset % 4 === 0
			? new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2)
			: new Uint32Array(src.slice().buffer);
	const maxU = cw - 1;
	const maxV = ch - 1;
	for (let y = y0; y < y1; y++) {
		const Y = y + 0.5;
		const X0 = x0 + 0.5;
		let u = m0 * X0 + m1 * Y + m2;
		let v = m3 * X0 + m4 * Y + m5;
		let o = (y * dw + x0) * 4;
		for (let x = x0; x < x1; x++, u += m0, v += m3, o += 4) {
			// Coverage of the picture rectangle (½ px ramps across each edge, in output px).
			let cu = 0.5 + Math.min(u - cu0, cu1 - u) * gu;
			if (cu <= 0) continue;
			let cv = 0.5 + Math.min(v - cv0, cv1 - v) * gv;
			if (cv <= 0) continue;
			if (cu > 1) cu = 1;
			if (cv > 1) cv = 1;
			const cover = cu * cv * op;
			// Bilinear, clamp to edge, texel centres at i + ½.
			let su = (u < lu ? lu : u > hu ? hu : u) - 0.5;
			let sv = (v < lv ? lv : v > hv ? hv : v) - 0.5;
			if (su < 0) su = 0;
			else if (su > maxU) su = maxU;
			if (sv < 0) sv = 0;
			else if (sv > maxV) sv = maxV;
			const iu = su | 0;
			const iv = sv | 0;
			const fx = su - iu;
			const fy = sv - iv;
			const iu1 = iu < maxU ? iu + 1 : iu;
			const iv1 = iv < maxV ? iv + 1 : iv;
			const t00 = s32[iv * sw + iu]!;
			const t10 = s32[iv * sw + iu1]!;
			const t01 = s32[iv1 * sw + iu]!;
			const t11 = s32[iv1 * sw + iu1]!;
			const w00 = (1 - fx) * (1 - fy);
			const w10 = fx * (1 - fy);
			const w01 = (1 - fx) * fy;
			const w11 = fx * fy;
			let r: number;
			let g: number;
			let b: number;
			let a: number;
			if ((t00 & t10 & t01 & t11) >>> 24 === 255) {
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
			dst[o] = r + 0.5;
			dst[o + 1] = g + 0.5;
			dst[o + 2] = b + 0.5;
			dst[o + 3] = a * cover + 0.5;
		}
	}
}
