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
 * the composite; the next process does not read it). `replace`: `out` = `W×H`, the chain's output as the adjustment
 * chain would mix it at Opacity 100 % — premultiplied, alpha 1 (`premultiply`, `lutrgb=a=maxval`) — or the composite
 * where `frame` is null.
 */
export function chainStackedFrame(
	src: Uint8Array,
	W: number,
	H: number,
	frame: ChainFrame | null,
	out: Uint8Array,
	scratch: ChainScratch,
	replace: boolean,
): void {
	const row = W * 4;
	if (!frame) {
		if (replace) {
			out.set(src.subarray(0, W * H * 4));
			return;
		}
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
	// texture() in texel coordinates (x = u·CW − ½): acc += w × bilinear(T) (0…255 scale), CLAMP_TO_EDGE.
	const texAdd = (T: Uint8Array, xs: number, ys: number, w: number) => {
		const xf = Math.floor(xs);
		const yf = Math.floor(ys);
		const fx = xs - xf;
		const fy = ys - yf;
		const x0 = xf < 0 ? 0 : xf >= CW ? CW - 1 : xf;
		const x1 = xf + 1 < 0 ? 0 : xf + 1 >= CW ? CW - 1 : xf + 1;
		const r0 = (yf < 0 ? 0 : yf >= CH ? CH - 1 : yf) * CW;
		const r1 = (yf + 1 < 0 ? 0 : yf + 1 >= CH ? CH - 1 : yf + 1) * CW;
		const i00 = (r0 + x0) * 4;
		const i10 = (r0 + x1) * 4;
		const i01 = (r1 + x0) * 4;
		const i11 = (r1 + x1) * 4;
		const w11 = fx * fy * w;
		const w10 = fx * w - w11;
		const w01 = fy * w - w11;
		const w00 = w - w10 - w01 - w11;
		acc[0] = acc[0]! + T[i00]! * w00 + T[i10]! * w10 + T[i01]! * w01 + T[i11]! * w11;
		acc[1] = acc[1]! + T[i00 + 1]! * w00 + T[i10 + 1]! * w10 + T[i01 + 1]! * w01 + T[i11 + 1]! * w11;
		acc[2] = acc[2]! + T[i00 + 2]! * w00 + T[i10 + 2]! * w10 + T[i01 + 2]! * w01 + T[i11 + 2]! * w11;
		acc[3] = acc[3]! + T[i00 + 3]! * w00 + T[i10 + 3]! * w10 + T[i01 + 3]! * w01 + T[i11 + 3]! * w11;
	};
	/** acc (0…255 scale) × k → T at o, rounded (the RGBA8 target). */
	const put = (T: Uint8Array, o: number, k: number) => {
		for (let c = 0; c < 4; c++) {
			const v = acc[c]! * k;
			T[o + c] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
		}
	};
	/**
	 * Directional Blur's box of `taps` texel offsets t·(sx, sy), t = t0 + i·dt, averaged, from S into D. Along an axis
	 * every tap is a lerp of two neighbours with the same fraction for every pixel: one sparse 1D kernel per pass.
	 */
	const box = (
		S: Uint8Array,
		D: Uint8Array,
		sx: number,
		sy: number,
		taps: number,
		t0: number,
		dt: number,
	) => {
		const horizontal = Math.abs(sy) < 1e-9;
		const vertical = Math.abs(sx) < 1e-9;
		if (horizontal || vertical) {
			const step = horizontal ? sx : sy;
			const ks: number[] = [];
			const ws: number[] = [];
			const add = (k: number, w: number) => {
				const at = ks.indexOf(k);
				if (at >= 0) ws[at] = ws[at]! + w;
				else {
					ks.push(k);
					ws.push(w);
				}
			};
			for (let i = 0; i < taps; i++) {
				const off = step * (t0 + i * dt);
				const k = Math.floor(off);
				add(k, 1 - (off - k));
				add(k + 1, off - k);
			}
			const n = ks.length;
			const scale = 1 / (taps * 255);
			const len = horizontal ? CW : CH;
			const lines = horizontal ? CH : CW;
			const stride = horizontal ? 4 : CW * 4;
			const lineStep = horizontal ? CW * 4 : 4;
			for (let l = 0; l < lines; l++) {
				const base = l * lineStep;
				for (let x = 0; x < len; x++) {
					let a0 = 0;
					let a1 = 0;
					let a2 = 0;
					let a3 = 0;
					for (let j = 0; j < n; j++) {
						let xi = x + ks[j]!;
						xi = xi < 0 ? 0 : xi >= len ? len - 1 : xi;
						const i = base + xi * stride;
						const w = ws[j]!;
						a0 += S[i]! * w;
						a1 += S[i + 1]! * w;
						a2 += S[i + 2]! * w;
						a3 += S[i + 3]! * w;
					}
					const o = base + x * stride;
					const v0 = a0 * scale;
					const v1 = a1 * scale;
					const v2 = a2 * scale;
					const v3 = a3 * scale;
					D[o] = Math.round((v0 < 0 ? 0 : v0 > 1 ? 1 : v0) * 255);
					D[o + 1] = Math.round((v1 < 0 ? 0 : v1 > 1 ? 1 : v1) * 255);
					D[o + 2] = Math.round((v2 < 0 ? 0 : v2 > 1 ? 1 : v2) * 255);
					D[o + 3] = Math.round((v3 < 0 ? 0 : v3 > 1 ? 1 : v3) * 255);
				}
			}
			return;
		}
		const k = 1 / (taps * 255);
		for (let y = 0; y < CH; y++)
			for (let x = 0; x < CW; x++) {
				acc.fill(0);
				for (let i = 0; i < taps; i++) {
					const t = t0 + i * dt;
					texAdd(S, x + sx * t, y + sy * t, 1);
				}
				put(D, (y * CW + x) * 4, k);
			}
	};
	for (const p of frame.passes) {
		if (p.k === 'dblur') {
			// Pass 1 (`coarse`, RGBA8): 33 taps over ±length; pass 2: 9 taps over one tap spacing. Length 0: the identity.
			if (p.sx === 0 && p.sy === 0) continue;
			box(A, C, p.sx, p.sy, 33, -1, 1 / 16);
			box(C, B, p.sx, p.sy, 9, -0.5 / 16, 1 / 128);
		} else if (p.k === 'tf') {
			if (p.mb) {
				// The shader's motion blur loop: taps at (i + j) / n through the time warp, poses interpolated between the
				// keys, weight t.y × opacity, normalised by Σ t.y. Per pixel only j changes (its R2 jitter when the plan says
				// so): the taps are tabulated over j (1024 steps; 0.5 without jitter).
				const mb = p.mb;
				const n = mb.n;
				const J = mb.flags & 1 ? 1024 : 1;
				const K = Math.max(mb.K, 2);
				const S = Math.max(mb.S, 1);
				const tab = new Float64Array(J * n * 7);
				const wsums = new Float64Array(J);
				for (let q = 0; q < J; q++) {
					const j = J === 1 ? 0.5 : (q + 0.5) / J;
					let wsum = 0;
					for (let i = 0; i < n; i++) {
						const a = (i + j) / n;
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
						const o = (q * n + i) * 7;
						const op = pose(6) / 100;
						tab[o] = pose(7) > 0.5 ? (op < 0 ? 0 : op > 1 ? 1 : op) * wt : 0;
						tab[o + 1] = pose(0);
						tab[o + 2] = pose(2);
						tab[o + 3] = pose(4) + pl - 0.5;
						tab[o + 4] = pose(1);
						tab[o + 5] = pose(3);
						tab[o + 6] = pose(5) + pt - 0.5;
					}
					wsums[q] = 1 / Math.max(wsum, 1e-6) / 255;
				}
				const seedHash = mbSeed(mb.seed);
				for (let y = 0; y < CH; y++) {
					const ly = y + 0.5 - pt;
					for (let x = 0; x < CW; x++) {
						const lx = x + 0.5 - pl;
						const q =
							J === 1
								? 0
								: ((Math.imul(x, 3242174889 | 0) + Math.imul(y, 2447445414 | 0) + seedHash) >>> 8) >>> 14;
						acc.fill(0);
						let o = q * n * 7;
						for (let i = 0; i < n; i++, o += 7) {
							const w = tab[o]!;
							if (w === 0) continue;
							const xs = tab[o + 1]! * lx + tab[o + 2]! * ly + tab[o + 3]!;
							const ys = tab[o + 4]! * lx + tab[o + 5]! * ly + tab[o + 6]!;
							if (!(xs >= -0.5 && xs <= CW - 0.5 && ys >= -0.5 && ys <= CH - 0.5)) continue;
							texAdd(A, xs, ys, w);
						}
						put(B, (y * CW + x) * 4, wsums[q]!);
					}
				}
			} else {
				const t = p.taps;
				// The identity (one tap, no move, full opacity): bilinear at texel centres reproduces the input.
				if (
					t.length === 7 &&
					p.wsum === 1 &&
					t[0] === 1 &&
					t[1] === 1 &&
					t[2] === 0 &&
					t[3] === 0 &&
					t[4] === 0 &&
					t[5] === 1 &&
					t[6] === 0
				)
					continue;
				const k = 1 / Math.max(p.wsum, 1e-6) / 255;
				for (let y = 0; y < CH; y++) {
					const ly = y + 0.5 - pt;
					for (let x = 0; x < CW; x++) {
						const lx = x + 0.5 - pl;
						acc.fill(0);
						for (let j = 0; j < t.length; j += 7) {
							const xs = t[j + 1]! * lx + t[j + 2]! * ly + t[j + 3]! + pl - 0.5;
							const ys = t[j + 4]! * lx + t[j + 5]! * ly + t[j + 6]! + pt - 0.5;
							if (!(xs >= -0.5 && xs <= CW - 0.5 && ys >= -0.5 && ys <= CH - 0.5)) continue;
							texAdd(A, xs, ys, t[j]!);
						}
						put(B, (y * CW + x) * 4, k);
					}
				}
			}
		} else
			for (let y = 0; y < CH; y++)
				for (let x = 0; x < CW; x++) {
					const o = (y * CW + x) * 4;
					const lx = x + 0.5 - pl;
					const ly = y + 0.5 - pt;
					const inBox = lx >= 0 && lx < W && ly >= 0 && ly < H;
					if (p.k === 'shake') {
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
	if (replace) {
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = ((y + pt) * CW + x + pl) * 4;
				const o = (y * W + x) * 4;
				out[o] = A[i]!;
				out[o + 1] = A[i + 1]!;
				out[o + 2] = A[i + 2]!;
				out[o + 3] = 255;
			}
		return;
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
