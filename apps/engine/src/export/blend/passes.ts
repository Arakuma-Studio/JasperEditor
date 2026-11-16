// The GL chain of a native adjustment layer on the CPU (blend/adjust.ts): the effects the preview runs on the
// composite below the layer (AdjustmentScope's canvas chain), one pass each, in stack order, exactly as the GPU host
// runs them (packages/compositions/src/fx/host.ts): the effect canvas is the layer box plus the effects' padding, every
// pass reads its input through `texture()` (bilinear, texel centres, CLAMP_TO_EDGE) and writes premultiplied RGBA8
// (the host's `rgba8` targets), and each pass is the effect's fragment shader written out for one pixel:
// - `tf` — Transform (`tf_sample` / `tf_at`): its inverse maps from the shader's own uniforms (`transformPoses`: the
//   single map × opacity, or the shutter taps at the strata centres), samples outside the canvas transparent;
// - `shake` — S_Shake without motion blur (`sh_src` / `sh_rgb` through `dw_tap` with Wrap No / Tile / Reflect, the
//   wrap applying inside the box as `dw_wrapAt` does), its pose from the shader's `uniforms` (`u_shakeNow`);
// - `mirror` — Mirror (`warp_at`: transparent outside the box), `replicate` — Replicate, `offset` — Offset
//   (`fx_sampleLayer` with FX_EDGE_REPEAT, Blend With Original), `dblur` — Directional Blur (33 taps over ±length into
//   an RGBA8 target, then 9 taps over one tap spacing).
// The documented difference: a Transform's capped shutter takes the strata centres where the shader jitters its taps
// per pixel (as for lowered layers).
//
// `chainStackedFrame` is self-contained (no imports, no closures over module scope): its source text runs in the
// worker threads (pool.ts), so tests and production share one implementation.

/** One pass of the chain (numbers only: posted to the workers per frame). */
export type ChainPass =
	/** Transform: `taps` = (w, m0…m5) per tap, layer px → source layer px (u = m0·x + m1·y + m2). */
	| { k: 'tf'; taps: number[]; wsum: number; mb?: ChainShutter }
	/** S_Shake: `q` = 3 poses (dx, dy, cos θ / zoom, sin θ / zoom), `rgb` = per-channel poses, wrap 0 No, 1 Tile, 2 Reflect. */
	| { k: 'shake'; q: number[]; rgb: boolean; z: number; wx: number; wy: number }
	/** Mirror: reflection centre (box fractions) and the unit direction of the angle. */
	| { k: 'mirror'; cx: number; cy: number; dx: number; dy: number }
	| { k: 'replicate'; n: number }
	/** Offset: Shift Center To (box fractions), Blend With Original (%). */
	| { k: 'offset'; sx: number; sy: number; blend: number }
	/** Directional Blur: `u_dbStep` (canvas px). */
	| { k: 'dblur'; sx: number; sy: number };

/**
 * A Transform's planned shutter (`mbUniforms`: `u_mbPlan` taps, keys, stride, flags 1 jitter / 2 time warp; `u_mbKeys`;
 * `u_mbWarp`) and its `u_seed`: the shader's taps per pixel (`fx_mbTap`, `fx_mbPose`, `fx_mbJitter`).
 */
export type ChainShutter = {
	n: number;
	K: number;
	S: number;
	flags: number;
	keys: number[];
	warp: number[];
	seed: number;
};

/** The chain at one frame: the canvas padding (left, top, right, bottom) and the passes in stack order. */
export type ChainFrame = { pad: [number, number, number, number]; passes: ChainPass[] };

/** Per-worker buffers (grown on demand). */
export type ChainScratch = { a?: Uint8Array; b?: Uint8Array; c?: Uint8Array };

/**
 * One frame of the cut: `src` = the composite (`W×H` straight RGBA8), `out` = `2W×H`, the composite ‖ the chain's
 * output inside the box (straight RGBA8). `frame` null = the layer is not drawn on this frame (the right half repeats
 * the composite; the next process does not read it).
 */
export function chainStackedFrame(
	src: Uint8Array,
	W: number,
	H: number,
	frame: ChainFrame | null,
	out: Uint8Array,
	scratch: ChainScratch,
): void {
	const row = W * 4;
	if (!frame) {
		for (let y = 0; y < H; y++) {
			const s = src.subarray(y * row, (y + 1) * row);
			out.set(s, 2 * y * row);
			out.set(s, 2 * y * row + row);
		}
		return;
	}
	const pl = frame.pad[0];
	const pt = frame.pad[1];
	const CW = W + pl + frame.pad[2];
	const CH = H + pt + frame.pad[3];
	const N = CW * CH * 4;
	if (!scratch.a || scratch.a.length < N) {
		scratch.a = new Uint8Array(N);
		scratch.b = new Uint8Array(N);
		scratch.c = new Uint8Array(N);
	}
	let A = scratch.a.subarray(0, N);
	let B = (scratch.b as Uint8Array).subarray(0, N);
	const C = (scratch.c as Uint8Array).subarray(0, N);
	A.fill(0);
	// The captured composite, premultiplied (UNPACK_PREMULTIPLY_ALPHA), in the box.
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const o = ((y + pt) * CW + x + pl) * 4;
			const a = src[i + 3]!;
			A[o] = Math.round((src[i]! * a) / 255);
			A[o + 1] = Math.round((src[i + 1]! * a) / 255);
			A[o + 2] = Math.round((src[i + 2]! * a) / 255);
			A[o + 3] = a;
		}
	// texture(T, uv): bilinear at texel centres, CLAMP_TO_EDGE; result in px (premultiplied, 0…1).
	const px = new Float64Array(4);
	const tex = (T: Uint8Array, u: number, v: number) => {
		const x = u * CW - 0.5;
		const y = v * CH - 0.5;
		const xf = Math.floor(x);
		const yf = Math.floor(y);
		const fx = x - xf;
		const fy = y - yf;
		const x0 = xf < 0 ? 0 : xf > CW - 1 ? CW - 1 : xf;
		const x1 = xf + 1 < 0 ? 0 : xf + 1 > CW - 1 ? CW - 1 : xf + 1;
		const y0 = yf < 0 ? 0 : yf > CH - 1 ? CH - 1 : yf;
		const y1 = yf + 1 < 0 ? 0 : yf + 1 > CH - 1 ? CH - 1 : yf + 1;
		const i00 = (y0 * CW + x0) * 4;
		const i10 = (y0 * CW + x1) * 4;
		const i01 = (y1 * CW + x0) * 4;
		const i11 = (y1 * CW + x1) * 4;
		const w00 = (1 - fx) * (1 - fy);
		const w10 = fx * (1 - fy);
		const w01 = (1 - fx) * fy;
		const w11 = fx * fy;
		for (let k = 0; k < 4; k++)
			px[k] = (T[i00 + k]! * w00 + T[i10 + k]! * w10 + T[i01 + k]! * w01 + T[i11 + k]! * w11) / 255;
	};
	const acc = new Float64Array(4);
	const store = (T: Uint8Array, o: number, r: number, g: number, b: number, a: number) => {
		T[o] = Math.round((r < 0 ? 0 : r > 1 ? 1 : r) * 255);
		T[o + 1] = Math.round((g < 0 ? 0 : g > 1 ? 1 : g) * 255);
		T[o + 2] = Math.round((b < 0 ? 0 : b > 1 ? 1 : b) * 255);
		T[o + 3] = Math.round((a < 0 ? 0 : a > 1 ? 1 : a) * 255);
	};
	// dw_cov1: 1 inside [0, 1], 0 outside, a one-pixel ramp across the edge.
	const cov1 = (n: number, size: number) => {
		const c = Math.min(n, 1 - n) * size + 0.5;
		return c < 0 ? 0 : c > 1 ? 1 : c;
	};
	const wrap1 = (x: number, m: number) => {
		if (m === 1) return x - Math.floor(x);
		if (m === 2) {
			const t = x - 2 * Math.floor(x / 2);
			return t > 1 ? 2 - t : t;
		}
		return x;
	};
	const aspect = H / W;
	// fx_pcg(fx_seedBits(u_seed) ^ 0x5bd1e995u) of fx_mbJitter (u_seed and the product in float32, as the GPU).
	const pcg = (v: number) => {
		const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
		const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
		return ((word >>> 22) ^ word) >>> 0;
	};
	const mbSeed = (seed: number) => {
		const f = Math.fround(Math.min(1, Math.max(0, Math.fround(seed))));
		return pcg((Math.fround(f * 4294967040) >>> 0) ^ 0x5bd1e995);
	};
	// dw_tap(src (frame units), wrap) of S_Shake's input A into px.
	const dwTap = (sx: number, sy: number, wx: number, wy: number) => {
		let nx = sx + 0.5;
		let ny = sy / aspect + 0.5;
		if (wx === 0 && wy === 0) {
			const u = (nx * W + pl) / CW;
			const v = (ny * H + pt) / CH;
			const c = cov1(u, CW) * cov1(v, CH);
			if (!(c > 0)) {
				px.fill(0);
				return;
			}
			tex(A, u < 0 ? 0 : u > 1 ? 1 : u, v < 0 ? 0 : v > 1 ? 1 : v);
			for (let k = 0; k < 4; k++) px[k] = px[k]! * c;
			return;
		}
		let c = 1;
		if (wx === 0) c *= cov1(nx, W);
		else nx = wrap1(nx, wx);
		if (wy === 0) c *= cov1(ny, H);
		else ny = wrap1(ny, wy);
		if (!(c > 0)) {
			px.fill(0);
			return;
		}
		const lx = 0.5 / W;
		const ly = 0.5 / H;
		nx = nx < lx ? lx : nx > 1 - lx ? 1 - lx : nx;
		ny = ny < ly ? ly : ny > 1 - ly ? 1 - ly : ny;
		tex(A, (nx * W + pl) / CW, (ny * H + pt) / CH);
		for (let k = 0; k < 4; k++) px[k] = px[k]! * c;
	};
	for (const p of frame.passes) {
		if (p.k === 'dblur') {
			// Pass 1 (`coarse`, RGBA8): 33 taps over ±length; pass 2: 9 taps over one tap spacing.
			const dx = p.sx / CW;
			const dy = p.sy / CH;
			for (let y = 0; y < CH; y++)
				for (let x = 0; x < CW; x++) {
					const u = (x + 0.5) / CW;
					const v = (y + 0.5) / CH;
					acc.fill(0);
					for (let i = 0; i < 33; i++) {
						const t = i / 16 - 1;
						tex(A, u + dx * t, v + dy * t);
						for (let k = 0; k < 4; k++) acc[k] = acc[k]! + px[k]!;
					}
					store(C, (y * CW + x) * 4, acc[0]! / 33, acc[1]! / 33, acc[2]! / 33, acc[3]! / 33);
				}
			for (let y = 0; y < CH; y++)
				for (let x = 0; x < CW; x++) {
					const u = (x + 0.5) / CW;
					const v = (y + 0.5) / CH;
					acc.fill(0);
					for (let i = 0; i < 9; i++) {
						const t = (i / 8 - 0.5) / 16;
						tex(C, u + dx * t, v + dy * t);
						for (let k = 0; k < 4; k++) acc[k] = acc[k]! + px[k]!;
					}
					store(B, (y * CW + x) * 4, acc[0]! / 9, acc[1]! / 9, acc[2]! / 9, acc[3]! / 9);
				}
		} else
			for (let y = 0; y < CH; y++)
				for (let x = 0; x < CW; x++) {
					const o = (y * CW + x) * 4;
					const lx = x + 0.5 - pl;
					const ly = y + 0.5 - pt;
					const inBox = lx >= 0 && lx < W && ly >= 0 && ly < H;
					if (p.k === 'tf' && p.mb) {
						// The shader's motion blur loop: taps at (i + j) / n through the time warp, poses interpolated between
						// the keys, weight t.y × opacity, normalised by Σ t.y; j = the pixel's R2 jitter when the plan says so.
						const mb = p.mb;
						let j = 0.5;
						if (mb.flags & 1) {
							const seedHash = ((mb as { hash?: number }).hash ??= mbSeed(mb.seed));
							const h = (Math.imul(x, 3242174889 | 0) + Math.imul(y, 2447445414 | 0) + seedHash) >>> 0;
							j = (h >>> 8) / 16777216;
						}
						acc.fill(0);
						let wsum = 0;
						const K = Math.max(mb.K, 2);
						const S = Math.max(mb.S, 1);
						for (let i = 0; i < mb.n; i++) {
							const a = (i + j) / mb.n;
							let st = a;
							let wt = 1;
							if (mb.flags & 2) {
								const xw = (a < 0 ? 0 : a > 1 ? 1 : a) * 31;
								const m = Math.min(Math.floor(xw), 30);
								const t0 = mb.warp[m]!;
								const t1 = mb.warp[m + 1]!;
								st = t0 + (t1 - t0) * (xw - m);
								wt = Math.max(t1 - t0, 0) * 31;
							}
							wsum += wt;
							const uu = (st < 0 ? 0 : st > 1 ? 1 : st) * (K - 1);
							const kk = Math.min(Math.floor(uu), K - 2);
							const fr = uu - kk;
							const pose = (c: number) => {
								const lo = mb.keys[kk * S * 4 + c]!;
								return lo + (mb.keys[(kk + 1) * S * 4 + c]! - lo) * fr;
							};
							if (pose(7) <= 0.5) continue;
							const sx = pose(0) * lx + pose(2) * ly + pose(4);
							const sy = pose(1) * lx + pose(3) * ly + pose(5);
							const u = (sx + pl) / CW;
							const v = (sy + pt) / CH;
							if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue;
							tex(A, u, v);
							const op = pose(6) / 100;
							const k = (op < 0 ? 0 : op > 1 ? 1 : op) * wt;
							for (let c = 0; c < 4; c++) acc[c] = acc[c]! + px[c]! * k;
						}
						const s = 1 / Math.max(wsum, 1e-6);
						store(B, o, acc[0]! * s, acc[1]! * s, acc[2]! * s, acc[3]! * s);
					} else if (p.k === 'tf') {
						acc.fill(0);
						const t = p.taps;
						for (let j = 0; j < t.length; j += 7) {
							const sx = t[j + 1]! * lx + t[j + 2]! * ly + t[j + 3]!;
							const sy = t[j + 4]! * lx + t[j + 5]! * ly + t[j + 6]!;
							const u = (sx + pl) / CW;
							const v = (sy + pt) / CH;
							if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue;
							tex(A, u, v);
							for (let k = 0; k < 4; k++) acc[k] = acc[k]! + px[k]! * t[j]!;
						}
						const s = 1 / Math.max(p.wsum, 1e-6);
						store(B, o, acc[0]! * s, acc[1]! * s, acc[2]! * s, acc[3]! * s);
					} else if (p.k === 'shake') {
						const fx = (x + 0.5 - pl - 0.5 * W) / W;
						const fy = (y + 0.5 - pt - 0.5 * H) / W;
						const nx = fx + 0.5;
						const ny = fy / aspect + 0.5;
						const box = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
						const wx = box ? p.wx : 0;
						const wy = box ? p.wy : 0;
						const at = (i: number) => {
							const q = p.q;
							const dx = fx - q[i]!;
							const dy = fy - q[i + 1]!;
							dwTap(
								(q[i + 2]! * dx + q[i + 3]! * dy) * p.z,
								(-q[i + 3]! * dx + q[i + 2]! * dy) * p.z,
								wx,
								wy,
							);
						};
						if (p.rgb) {
							at(0);
							const r = px[0]!;
							const ar = px[3]!;
							at(4);
							const g = px[1]!;
							const ag = px[3]!;
							at(8);
							store(B, o, r, g, px[2]!, Math.max(ar, ag, px[3]!));
						} else {
							at(4);
							store(B, o, px[0]!, px[1]!, px[2]!, px[3]!);
						}
					} else if (p.k === 'mirror') {
						if (!inBox) {
							store(B, o, 0, 0, 0, 0);
							continue;
						}
						const cx = p.cx * W;
						const cy = p.cy * H;
						const s = (lx - cx) * p.dx + (ly - cy) * p.dy;
						const sx = s > 0 ? lx - 2 * s * p.dx : lx;
						const sy = s > 0 ? ly - 2 * s * p.dy : ly;
						const nx = sx / W;
						const ny = sy / H;
						if (nx < 0 || ny < 0 || nx > 1 || ny > 1) {
							store(B, o, 0, 0, 0, 0);
							continue;
						}
						tex(A, (nx * W + pl) / CW, (ny * H + pt) / CH);
						store(B, o, px[0]!, px[1]!, px[2]!, px[3]!);
					} else if (p.k === 'replicate') {
						if (!inBox) {
							store(B, o, 0, 0, 0, 0);
							continue;
						}
						const n = Math.min(64, Math.max(1, Math.floor(p.n)));
						let tx = (lx / W) * n;
						let ty = (ly / H) * n;
						tx -= Math.floor(tx);
						ty -= Math.floor(ty);
						const hx = 0.5 / W;
						const hy = 0.5 / H;
						tx = tx < hx ? hx : tx > 1 - hx ? 1 - hx : tx;
						ty = ty < hy ? hy : ty > 1 - hy ? 1 - hy : ty;
						tex(A, (tx * W + pl) / CW, (ty * H + pt) / CH);
						store(B, o, px[0]!, px[1]!, px[2]!, px[3]!);
					} else {
						// offset
						tex(A, (x + 0.5) / CW, (y + 0.5) / CH);
						if (!inBox) {
							store(B, o, px[0]!, px[1]!, px[2]!, px[3]!);
							continue;
						}
						const r0 = px[0]!;
						const g0 = px[1]!;
						const b0 = px[2]!;
						const a0 = px[3]!;
						let nx = lx / W - (p.sx - 0.5);
						let ny = ly / H - (p.sy - 0.5);
						nx -= Math.floor(nx);
						ny -= Math.floor(ny);
						tex(A, (nx * W + pl) / CW, (ny * H + pt) / CH);
						const m = Math.min(1, Math.max(0, p.blend / 100));
						store(
							B,
							o,
							px[0]! + (r0 - px[0]!) * m,
							px[1]! + (g0 - px[1]!) * m,
							px[2]! + (b0 - px[2]!) * m,
							px[3]! + (a0 - px[3]!) * m,
						);
					}
				}
		const t = A;
		A = B;
		B = t;
	}
	// The box of the chain's output, straight alpha, beside the composite.
	for (let y = 0; y < H; y++) {
		out.set(src.subarray(y * row, (y + 1) * row), 2 * y * row);
		for (let x = 0; x < W; x++) {
			const i = ((y + pt) * CW + x + pl) * 4;
			const o = 2 * y * row + row + x * 4;
			const a = A[i + 3]!;
			if (a === 0) {
				out[o] = 0;
				out[o + 1] = 0;
				out[o + 2] = 0;
				out[o + 3] = 0;
				continue;
			}
			out[o] = Math.min(255, Math.round((A[i]! * 255) / a));
			out[o + 1] = Math.min(255, Math.round((A[i + 1]! * 255) / a));
			out[o + 2] = Math.min(255, Math.round((A[i + 2]! * 255) / a));
			out[o + 3] = a;
		}
	}
}
