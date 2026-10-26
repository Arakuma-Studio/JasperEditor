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
 * wp masks: multiplies the alpha of the picture in `src` (`sw` px rows, picture `cw×ch` top-left) by `cov` (same
 * layout, 0..1) — the layer's Opacity masks, before the warp (premultiplied colour × coverage = straight alpha ×
 * coverage). Self-contained (runs in the workers).
 */
export function applyCoverage(src: Uint8Array, sw: number, cw: number, ch: number, cov: Float32Array): void {
	for (let y = 0; y < ch; y++) {
		let o = y * sw;
		for (let x = 0; x < cw; x++, o++) {
			const k = cov[o]!;
			if (k >= 1) continue;
			const i = 4 * o + 3;
			src[i] = src[i]! * k + 0.5;
		}
	}
}

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

/**
 * spec 13 AS-070/073 — the multi-tap kernel of lowered layers (a still drawn through its Motion, the Transform
 * effect and S_Shake as per-frame affine maps, `stream/lowered.ts`): every output pixel of `rect` is the weighted sum
 * of `taps`, each a bilinear premultiplied sample of the picture through its own affine map, times the anti-aliased
 * coverage of the picture's visible rectangle and of each stage's rectangle (the layer box the Transform effect
 * samples from, the effect canvas S_Shake samples from), the way the effects' shaders sum their shutter taps
 * (`sum / wsum`). One tap without stages equals `drawLayer`. Self-contained (runs in the workers).
 *
 * `prog` (packed numbers): `[nTaps, wsum, …taps]`, a tap = `w, a0…a5 (output px → picture px, u = a0·x + a1·y + a2,
 * v = a3·x + a4·y + a5), clip u0, v0, u1, v1 (picture px), nStages, nStages × (s0…s5 (output px → stage coords),
 * r0, r1, r2, r3)`. `acc` = scratch of at least `4 × rect area` floats. `dst` is cleared outside `rect`.
 */
export function drawTaps(
	src: Uint8Array,
	sw: number,
	cw: number,
	ch: number,
	dst: Uint8Array,
	dw: number,
	dh: number,
	prog: ArrayLike<number>,
	opacity: number,
	rect: ArrayLike<number> | null,
	acc: Float32Array,
): void {
	dst.fill(0);
	const nTaps = prog[0]! | 0;
	const wsum = prog[1]!;
	if (!rect || !(opacity > 0) || nTaps < 1 || !(wsum > 0) || cw < 1 || ch < 1) return;
	const x0 = Math.max(0, Math.floor(rect[0]!));
	const y0 = Math.max(0, Math.floor(rect[1]!));
	const x1 = Math.min(dw, Math.ceil(rect[2]!));
	const y1 = Math.min(dh, Math.ceil(rect[3]!));
	if (x1 <= x0 || y1 <= y0) return;
	const rw = x1 - x0;
	const n = rw * (y1 - y0) * 4;
	acc.fill(0, 0, n);
	const s32 =
		src.byteOffset % 4 === 0
			? new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2)
			: new Uint32Array(src.slice().buffer);
	const maxU = cw - 1;
	const maxV = ch - 1;
	let p = 2;
	for (let t = 0; t < nTaps; t++) {
		const w = prog[p++]!;
		const m0 = prog[p++]!;
		const m1 = prog[p++]!;
		const m2 = prog[p++]!;
		const m3 = prog[p++]!;
		const m4 = prog[p++]!;
		const m5 = prog[p++]!;
		const cu0 = Math.max(0, prog[p++]!);
		const cv0 = Math.max(0, prog[p++]!);
		const cu1 = Math.min(cw, prog[p++]!);
		const cv1 = Math.min(ch, prog[p++]!);
		const ns = prog[p++]! | 0;
		// Stage maps and rectangles, with their output-px gradients (coverage ramps in output px).
		const stg = new Float64Array(ns * 12);
		for (let s = 0; s < ns; s++) {
			for (let k = 0; k < 10; k++) stg[s * 12 + k] = prog[p + s * 10 + k]!;
			stg[s * 12 + 10] = 1 / Math.hypot(stg[s * 12]!, stg[s * 12 + 1]!);
			stg[s * 12 + 11] = 1 / Math.hypot(stg[s * 12 + 3]!, stg[s * 12 + 4]!);
		}
		p += ns * 10;
		if (!(w > 0) || cu1 <= cu0 || cv1 <= cv0) continue;
		const lu = Math.min(cu0 + 0.5, (cu0 + cu1) / 2);
		const hu = Math.max(cu1 - 0.5, (cu0 + cu1) / 2);
		const lv = Math.min(cv0 + 0.5, (cv0 + cv1) / 2);
		const hv = Math.max(cv1 - 0.5, (cv0 + cv1) / 2);
		const gu = 1 / Math.hypot(m0, m1);
		const gv = 1 / Math.hypot(m3, m4);
		// Per row, every coverage term is linear in x: the pixels where it can be > 0 (`xa…xb`) and where every term is
		// 1 (`fa…fb`, coverage computations skipped) are intervals. `edge(a, b, g)` narrows them for one edge
		// distance a·X + b (X = x + ½, in the term's units; g its output-px gradient). Same pixels as the full test.
		let xa = 0;
		let xb = 0;
		let fa = 0;
		let fb = 0;
		const edge = (a: number, b: number, g: number) => {
			// Visible: a·X + b > −½ / g; full: a·X + b ≥ ½ / g (the ramp is ½ px on each side of the edge).
			const vis = -0.5 / g;
			const full = 0.5 / g;
			if (a === 0) {
				if (!(b > vis)) xb = xa;
				if (!(b >= full)) fb = fa;
				return;
			}
			const xv = (vis - b) / a - 0.5;
			const xf = (full - b) / a - 0.5;
			if (a > 0) {
				xa = Math.max(xa, Math.floor(xv));
				fa = Math.max(fa, Math.ceil(xf) + 1);
			} else {
				xb = Math.min(xb, Math.ceil(xv) + 1);
				fb = Math.min(fb, Math.floor(xf) - 1);
			}
		};
		for (let y = y0; y < y1; y++) {
			const Y = y + 0.5;
			xa = x0;
			xb = x1;
			fa = x0;
			fb = x1;
			edge(m0, m1 * Y + m2 - cu0, gu);
			edge(-m0, cu1 - m1 * Y - m2, gu);
			edge(m3, m4 * Y + m5 - cv0, gv);
			edge(-m3, cv1 - m4 * Y - m5, gv);
			for (let s = 0; s < ns; s++) {
				const q = s * 12;
				edge(stg[q]!, stg[q + 1]! * Y + stg[q + 2]! - stg[q + 6]!, stg[q + 10]!);
				edge(-stg[q]!, stg[q + 8]! - stg[q + 1]! * Y - stg[q + 2]!, stg[q + 10]!);
				edge(stg[q + 3]!, stg[q + 4]! * Y + stg[q + 5]! - stg[q + 7]!, stg[q + 11]!);
				edge(-stg[q + 3]!, stg[q + 9]! - stg[q + 4]! * Y - stg[q + 5]!, stg[q + 11]!);
			}
			if (xa < x0) xa = x0;
			if (xb > x1) xb = x1;
			if (xb <= xa) continue;
			if (fa < xa) fa = xa;
			if (fb > xb) fb = xb;
			const X0 = xa + 0.5;
			let u = m0 * X0 + m1 * Y + m2;
			let v = m3 * X0 + m4 * Y + m5;
			let o = ((y - y0) * rw + (xa - x0)) * 4;
			for (let x = xa; x < xb; x++, u += m0, v += m3, o += 4) {
				let cover = 1;
				if (x < fa || x >= fb) {
					let cu = 0.5 + Math.min(u - cu0, cu1 - u) * gu;
					if (cu <= 0) continue;
					let cv = 0.5 + Math.min(v - cv0, cv1 - v) * gv;
					if (cv <= 0) continue;
					if (cu > 1) cu = 1;
					if (cv > 1) cv = 1;
					cover = cu * cv;
					for (let s = 0; s < ns; s++) {
						const q = s * 12;
						const X = x + 0.5;
						const su = stg[q]! * X + stg[q + 1]! * Y + stg[q + 2]!;
						const sv = stg[q + 3]! * X + stg[q + 4]! * Y + stg[q + 5]!;
						let ku = 0.5 + Math.min(su - stg[q + 6]!, stg[q + 8]! - su) * stg[q + 10]!;
						let kv = 0.5 + Math.min(sv - stg[q + 7]!, stg[q + 9]! - sv) * stg[q + 11]!;
						if (ku <= 0 || kv <= 0) {
							cover = 0;
							break;
						}
						if (ku > 1) ku = 1;
						if (kv > 1) kv = 1;
						cover *= ku * kv;
					}
					if (!(cover > 0)) continue;
				}
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
				const a00 = (t00 >>> 24) * (1 - fx) * (1 - fy);
				const a10 = (t10 >>> 24) * fx * (1 - fy);
				const a01 = (t01 >>> 24) * (1 - fx) * fy;
				const a11 = (t11 >>> 24) * fx * fy;
				const a = a00 + a10 + a01 + a11;
				if (a <= 0) continue;
				const k = w * cover;
				acc[o] += (k * ((t00 & 255) * a00 + (t10 & 255) * a10 + (t01 & 255) * a01 + (t11 & 255) * a11)) / 255;
				acc[o + 1] +=
					(k *
						(((t00 >> 8) & 255) * a00 +
							((t10 >> 8) & 255) * a10 +
							((t01 >> 8) & 255) * a01 +
							((t11 >> 8) & 255) * a11)) /
					255;
				acc[o + 2] +=
					(k *
						(((t00 >> 16) & 255) * a00 +
							((t10 >> 16) & 255) * a10 +
							((t01 >> 16) & 255) * a01 +
							((t11 >> 16) & 255) * a11)) /
					255;
				acc[o + 3] += k * a;
			}
		}
	}
	const op = Math.min(1, opacity) / wsum;
	for (let y = y0; y < y1; y++) {
		let o = (y - y0) * rw * 4;
		let d = (y * dw + x0) * 4;
		for (let x = x0; x < x1; x++, o += 4, d += 4) {
			const a = acc[o + 3]!;
			if (!(a > 0)) continue;
			const k = 255 / a;
			const r = acc[o]! * k;
			const g = acc[o + 1]! * k;
			const b = acc[o + 2]! * k;
			const al = a * op;
			dst[d] = (r > 255 ? 255 : r) + 0.5;
			dst[d + 1] = (g > 255 ? 255 : g) + 0.5;
			dst[d + 2] = (b > 255 ? 255 : b) + 0.5;
			dst[d + 3] = (al > 255 ? 255 : al) + 0.5;
		}
	}
}
