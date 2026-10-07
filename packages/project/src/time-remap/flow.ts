// Optical flow and motion-compensated frame interpolation (workstream `time`): Premiere's Time Interpolation ▸
// Optical Flow, the same algorithm on the CPU (this file: native export, scene detection, tests) and on the GPU
// (flow-glsl.ts + compositions/src/retime/flow-gl.ts: preview and Remotion renders).
//
// Port of effectcraft `crates/raster/src/flow.rs` (MIT OR Apache-2.0, see licenses/ported/time.md), extended:
// 1. analysis luma (Rec. 709 luma + ¼ alpha) of both frames, box-reduced by an integer factor k so the long side is
//    ≤ 1024 px (preview and export analyse the same picture whatever their output size);
// 2. luma pyramids (2×2 box, up to 4 levels while a level stays ≥ 2 blocks wide);
// 3. hierarchical block matching per 8×8 tile: SAD search ±4 at the coarsest level, then ±1 around the doubled
//    vectors of the tile and its 4 neighbours at each finer level (a tiny bias to short vectors breaks ties);
// 4. sub-pixel refinement by a parabola through the SAD of the ±1 neighbours; 3×3 component-wise vector median;
// 5. both directions (A → B and B → A);
// 6. interpolation at w with two motion hypotheses per pixel (A's and B's flow there) checked against the flow at
//    both ends (`interpolateFlow`): pixels that disappear come from A only, pixels that appear from B only, instead
//    of effectcraft's plain cross-fade of two warps of the same field.
//
// Pixels are RGBA (straight or premultiplied, any range); the interpolation is linear in them.

export const FLOW_BLOCK = 8;
export const FLOW_RADIUS = 4;
export const FLOW_MAX_LEVELS = 4;
/** Long side of the analysis picture. */
export const FLOW_ANALYSIS_MAX = 1024;
/** Vector agreement: full below t0 = 1 px + 50 % of the vector, none above 2·t0 (full-resolution px). */
export const FLOW_CONSISTENCY_BASE = 1;
export const FLOW_CONSISTENCY_SLOPE = 0.5;
/** Floor weight of an inconsistent sample (both inconsistent → a plain cross-fade). */
export const FLOW_DELTA = 0.02;

/** An RGBA picture: 4 floats (or bytes) per pixel, row-major. */
export type FlowImage = { width: number; height: number; data: ArrayLike<number> };

/** A plane of floats. */
export type Plane = { w: number; h: number; d: Float32Array };

/** Sharpness of the soft choice between motion hypotheses. */
export const FLOW_CHOICE_SHARPNESS = 8;
/** Preference for the slower hypothesis when both explain the pixel equally (occluded areas are background). */
export const FLOW_SLOW_BIAS = 0.002;
/** Hypotheses per output pixel: A's and B's interpolated flow there, and the vectors of the 4 nearest tiles of each. */
export const FLOW_CANDIDATES = 10;
/** Weight of the photometric mismatch (per unit of summed RGB difference at full scale). */
export const FLOW_PHOTO_WEIGHT = 8;

/** The constants of the algorithm (shared with the GPU shaders). */
export const FLOW_CONSTANTS = {
	block: FLOW_BLOCK,
	radius: FLOW_RADIUS,
	maxLevels: FLOW_MAX_LEVELS,
	analysisMax: FLOW_ANALYSIS_MAX,
	consistencyBase: FLOW_CONSISTENCY_BASE,
	consistencySlope: FLOW_CONSISTENCY_SLOPE,
	delta: FLOW_DELTA,
	sharpness: FLOW_CHOICE_SHARPNESS,
	slowBias: FLOW_SLOW_BIAS,
	candidates: FLOW_CANDIDATES,
	photoWeight: FLOW_PHOTO_WEIGHT,
} as const;
export type FlowConstants = { readonly [K in keyof typeof FLOW_CONSTANTS]: number };

/** A block motion field: one vector per tile, in analysis pixels. */
export type BlockFlow = {
	/** Analysis size. */
	w: number;
	h: number;
	block: number;
	cols: number;
	rows: number;
	/** x, y per tile. */
	v: Float32Array;
};
/** Forward (A → B) and backward (B → A) flows of two frames. */
export type FlowPair = {
	k: number;
	ab: BlockFlow;
	ba: BlockFlow /** Pixel value of full scale (1 or 255). */;
	scale: number;
};

/**
 * The whole CPU algorithm as one self-contained function of its constants, so worker threads can run it from source
 * (`(${createFlowKernel.toString()})(${JSON.stringify(FLOW_CONSTANTS)})`, engine export/retime) — it references
 * nothing outside its own scope.
 */
export function createFlowKernel(C: FlowConstants) {
	/** Integer reduction factor of the analysis picture for a frame of this size. */
	function analysisFactor(width: number, height: number): number {
		return Math.max(1, Math.ceil(Math.max(width, height) / C.analysisMax));
	}

	/** Analysis size for a frame size and factor. */
	function analysisSize(width: number, height: number, k: number): { w: number; h: number } {
		return { w: Math.max(1, Math.floor(width / k)), h: Math.max(1, Math.floor(height / k)) };
	}

	/**
	 * Analysis luma of an RGBA picture: the mean of each k×k block (clamped at the edges) of 0.2126 R + 0.7152 G +
	 * 0.0722 B + 0.25 A, divided by `scale` (255 for 8-bit pictures).
	 */
	function analysisLuma(img: FlowImage, k: number, scale = 1): Plane {
		const { w, h } = analysisSize(img.width, img.height, k);
		const d = new Float32Array(w * h);
		const W = img.width;
		const H = img.height;
		const src = img.data;
		const inv = 1 / (k * k * scale);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				let s = 0;
				for (let j = 0; j < k; j++) {
					const yy = Math.min(H - 1, y * k + j);
					for (let i = 0; i < k; i++) {
						const xx = Math.min(W - 1, x * k + i);
						const o = (yy * W + xx) * 4;
						s += 0.2126 * src[o]! + 0.7152 * src[o + 1]! + 0.0722 * src[o + 2]! + 0.25 * src[o + 3]!;
					}
				}
				d[y * w + x] = s * inv;
			}
		return { w, h, d };
	}

	/** 2×2 box reduction (clamped). */
	function halfPlane(p: Plane): Plane {
		const w = Math.max(1, Math.floor(p.w / 2));
		const h = Math.max(1, Math.floor(p.h / 2));
		const d = new Float32Array(w * h);
		for (let y = 0; y < h; y++) {
			const y0 = Math.min(p.h - 1, y * 2);
			const y1 = Math.min(p.h - 1, y * 2 + 1);
			for (let x = 0; x < w; x++) {
				const x0 = Math.min(p.w - 1, x * 2);
				const x1 = Math.min(p.w - 1, x * 2 + 1);
				d[y * w + x] =
					(p.d[y0 * p.w + x0]! + p.d[y0 * p.w + x1]! + p.d[y1 * p.w + x0]! + p.d[y1 * p.w + x1]!) * 0.25;
			}
		}
		return { w, h, d };
	}

	/** Sum of absolute differences of the `bs`×`bs` block at (bx, by) in `a` and the block displaced by (dx, dy) in b. */
	function sad(a: Plane, b: Plane, bx: number, by: number, bs: number, dx: number, dy: number): number {
		const aw = a.w;
		const ah = a.h;
		const ad = a.d;
		const bd = b.d;
		let s = 0;
		// Fast path: both blocks fully inside.
		if (
			bx >= 0 &&
			by >= 0 &&
			bx + bs <= aw &&
			by + bs <= ah &&
			bx + dx >= 0 &&
			by + dy >= 0 &&
			bx + dx + bs <= aw &&
			by + dy + bs <= ah
		) {
			for (let y = by; y < by + bs; y++) {
				let ia = y * aw + bx;
				let ib = (y + dy) * aw + bx + dx;
				for (let x = 0; x < bs; x++) s += Math.abs(ad[ia++]! - bd[ib++]!);
			}
			return s;
		}
		for (let y = by; y < by + bs; y++) {
			const ya = Math.min(ah - 1, Math.max(0, y));
			const yb = Math.min(ah - 1, Math.max(0, y + dy));
			for (let x = bx; x < bx + bs; x++) {
				const xa = Math.min(aw - 1, Math.max(0, x));
				const xb = Math.min(aw - 1, Math.max(0, x + dx));
				s += Math.abs(ad[ya * aw + xa]! - bd[yb * aw + xb]!);
			}
		}
		return s;
	}

	/** Pyramid of a plane (level 0 = the plane). */
	function pyramid(p: Plane, block = C.block): Plane[] {
		const out = [p];
		while (out.length < C.maxLevels) {
			const last = out[out.length - 1]!;
			if (!(Math.floor(last.w / 2) >= block * 2 && Math.floor(last.h / 2) >= block * 2)) break;
			out.push(halfPlane(last));
		}
		return out;
	}

	/** Number of pyramid levels for an analysis size (the same rule as `pyramid`). */
	function pyramidLevels(w: number, h: number, block = C.block): number {
		let n = 1;
		while (n < C.maxLevels) {
			const f = 2 ** (n - 1);
			const lw = Math.max(1, Math.floor(w / f));
			const lh = Math.max(1, Math.floor(h / f));
			if (!(Math.floor(lw / 2) >= block * 2 && Math.floor(lh / 2) >= block * 2)) break;
			n++;
		}
		return n;
	}

	/**
	 * Block-matching flow from pyramid `pa` to pyramid `pb` (same sizes). Steps 3–4 of the header. Vectors point from a
	 * tile of A to where it is in B.
	 */
	function blockFlow(pa: Plane[], pb: Plane[], block = C.block, radius = C.radius): BlockFlow {
		const w = pa[0]!.w;
		const h = pa[0]!.h;
		const bs = Math.max(2, block);
		const cols = Math.max(1, Math.ceil(w / bs));
		const rows = Math.max(1, Math.ceil(h / bs));
		const n = cols * rows;
		const flow: BlockFlow = { w, h, block: bs, cols, rows, v: new Float32Array(n * 2) };
		if (w < bs || h < bs) return flow;
		const top = pa.length - 1;
		let cur = new Int32Array(n * 2);
		const seeds: number[] = [];
		for (let level = top; level >= 0; level--) {
			const la = pa[level]!;
			const lb = pb[level]!;
			const k = 2 ** level;
			const lbs = Math.max(Math.floor(bs / k), 4);
			const r = level === top ? radius : 1;
			const prev = cur;
			const next = new Int32Array(n * 2);
			for (let i = 0; i < n; i++) {
				const c = i % cols;
				const rr = (i - c) / cols;
				const bx = Math.floor((c * bs) / k);
				const by = Math.floor((rr * bs) / k);
				seeds.length = 0;
				seeds.push(0, 0);
				if (level !== top) {
					for (const [dc, dr] of NEIGHBOURS) {
						const nc = c + dc;
						const nr = rr + dr;
						if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
						const j = nr * cols + nc;
						seeds.push(prev[j * 2]! * 2, prev[j * 2 + 1]! * 2);
					}
				}
				const uniq = sortedUniqueSeeds(seeds);
				let bestX = 0;
				let bestY = 0;
				let bestE = Number.POSITIVE_INFINITY;
				for (let s = 0; s < uniq.length; s += 2) {
					const sx = uniq[s]!;
					const sy = uniq[s + 1]!;
					for (let dy = -r; dy <= r; dy++)
						for (let dx = -r; dx <= r; dx++) {
							const x = sx + dx;
							const y = sy + dy;
							const e = sad(la, lb, bx, by, lbs, x, y) + 1e-4 * (Math.abs(x) + Math.abs(y));
							if (e < bestE) {
								bestE = e;
								bestX = x;
								bestY = y;
							}
						}
				}
				next[i * 2] = bestX;
				next[i * 2 + 1] = bestY;
			}
			cur = next;
		}
		// Sub-pixel parabola at full analysis resolution.
		const la = pa[0]!;
		const lb = pb[0]!;
		const fine = new Float32Array(n * 2);
		const fit = (em: number, e0: number, ep: number) => {
			const den = em - 2 * e0 + ep;
			return den > 1e-6 ? Math.min(0.5, Math.max(-0.5, (0.5 * (em - ep)) / den)) : 0;
		};
		for (let i = 0; i < n; i++) {
			const c = i % cols;
			const rr = (i - c) / cols;
			const bx = c * bs;
			const by = rr * bs;
			const dx = cur[i * 2]!;
			const dy = cur[i * 2 + 1]!;
			const e0 = sad(la, lb, bx, by, bs, dx, dy);
			const sx = fit(sad(la, lb, bx, by, bs, dx - 1, dy), e0, sad(la, lb, bx, by, bs, dx + 1, dy));
			const sy = fit(sad(la, lb, bx, by, bs, dx, dy - 1), e0, sad(la, lb, bx, by, bs, dx, dy + 1));
			fine[i * 2] = dx + sx;
			fine[i * 2 + 1] = dy + sy;
		}
		// 3×3 component-wise median.
		const xs: number[] = [];
		const ys: number[] = [];
		for (let i = 0; i < n; i++) {
			const c = i % cols;
			const rr = (i - c) / cols;
			xs.length = 0;
			ys.length = 0;
			for (let dr = -1; dr <= 1; dr++)
				for (let dc = -1; dc <= 1; dc++) {
					const nc = c + dc;
					const nr = rr + dr;
					if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
					const j = nr * cols + nc;
					xs.push(fine[j * 2]!);
					ys.push(fine[j * 2 + 1]!);
				}
			xs.sort((a, b) => a - b);
			ys.sort((a, b) => a - b);
			flow.v[i * 2] = xs[xs.length >> 1]!;
			flow.v[i * 2 + 1] = ys[ys.length >> 1]!;
		}
		return flow;
	}

	const NEIGHBOURS: readonly [number, number][] = [
		[0, 0],
		[-1, 0],
		[1, 0],
		[0, -1],
		[0, 1],
	];

	/** Seeds (x, y pairs) sorted lexicographically, duplicates removed (the search order of effectcraft). */
	function sortedUniqueSeeds(seeds: number[]): number[] {
		const pairs: [number, number][] = [];
		for (let i = 0; i < seeds.length; i += 2) pairs.push([seeds[i]!, seeds[i + 1]!]);
		pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const out: number[] = [];
		for (let i = 0; i < pairs.length; i++) {
			const p = pairs[i]!;
			if (i > 0 && p[0] === pairs[i - 1]![0] && p[1] === pairs[i - 1]![1]) continue;
			out.push(p[0], p[1]);
		}
		return out;
	}

	/** The flow at analysis position (x, y), bilinear between tile centres. Writes into `out`. */
	function flowAt(f: BlockFlow, x: number, y: number, out: [number, number]): [number, number] {
		const b = f.block;
		const fx = Math.min(f.cols - 1, Math.max(0, x / b - 0.5));
		const fy = Math.min(f.rows - 1, Math.max(0, y / b - 0.5));
		const x0 = Math.floor(fx);
		const y0 = Math.floor(fy);
		const x1 = Math.min(x0 + 1, f.cols - 1);
		const y1 = Math.min(y0 + 1, f.rows - 1);
		const tx = fx - x0;
		const ty = fy - y0;
		const v = f.v;
		const c = f.cols;
		for (let i = 0; i < 2; i++) {
			const a = v[(y0 * c + x0) * 2 + i]!;
			const bb = v[(y0 * c + x1) * 2 + i]!;
			const cc = v[(y1 * c + x0) * 2 + i]!;
			const d = v[(y1 * c + x1) * 2 + i]!;
			const top = a + (bb - a) * tx;
			const bot = cc + (d - cc) * tx;
			out[i] = top + (bot - top) * ty;
		}
		return out;
	}

	/** Steps 1–5: analysis, pyramids and both flows of two RGBA frames of the same size. */
	function computeFlowPair(a: FlowImage, b: FlowImage, scale = 1): FlowPair {
		const k = analysisFactor(a.width, a.height);
		const pa = pyramid(analysisLuma(a, k, scale));
		const pb = pyramid(analysisLuma(b, k, scale));
		return { k, ab: blockFlow(pa, pb), ba: blockFlow(pb, pa), scale };
	}

	/** Bilinear sample of an RGBA picture at pixel position (x, y) (pixel centres at +0.5), clamped. */
	function sample(img: FlowImage, x: number, y: number, out: number[]): void {
		const W = img.width;
		const H = img.height;
		const fx = Math.min(W - 1, Math.max(0, x - 0.5));
		const fy = Math.min(H - 1, Math.max(0, y - 0.5));
		const x0 = Math.floor(fx);
		const y0 = Math.floor(fy);
		const x1 = Math.min(x0 + 1, W - 1);
		const y1 = Math.min(y0 + 1, H - 1);
		const tx = fx - x0;
		const ty = fy - y0;
		const d = img.data;
		const o00 = (y0 * W + x0) * 4;
		const o10 = (y0 * W + x1) * 4;
		const o01 = (y1 * W + x0) * 4;
		const o11 = (y1 * W + x1) * 4;
		for (let c = 0; c < 4; c++) {
			const top = d[o00 + c]! + (d[o10 + c]! - d[o00 + c]!) * tx;
			const bot = d[o01 + c]! + (d[o11 + c]! - d[o01 + c]!) * tx;
			out[c] = top + (bot - top) * ty;
		}
	}

	/** Agreement (0…1) of two motion vectors (full px): 1 within t0 = 1 px + 50 % of |v|, 0 beyond 2·t0. */
	function vectorMatch(ux: number, uy: number, vx: number, vy: number): number {
		const err = Math.hypot(ux - vx, uy - vy);
		const t0 = C.consistencyBase + C.consistencySlope * Math.hypot(vx, vy);
		return Math.min(1, Math.max(0, 2 - err / t0));
	}

	/**
	 * Step 6: the motion-compensated picture at fraction `w` (0 = A, 1 = B) between two frames, into `out` (a new
	 * Float32Array when absent). Rows [y0, y1) only when given (worker slices).
	 *
	 * For each output pixel p ten motion hypotheses are tried (`flowCandidates`): F(p) and −G(p) (the interpolated
	 * motion of A's and of B's pixel at p) and the vectors of the 4 nearest tiles of each field (sharp motion edges). A
	 * hypothesis v samples A at q_a = p − w·v and B at q_b = p + (1 − w)·v and checks that v really is the motion of
	 * those pixels: c_a = match(F(q_a), v), c_b = match(−G(q_b), v). Its colour is the cross-fade of the two samples
	 * weighted (1 − w)·(c_a + δ) and w·(c_b + δ) — at an occlusion only the frame that sees the pixel contributes — and
	 * the hypotheses are mixed by softmax(8·(c_a + c_b − 8·|A(q_a) − B(q_b)|·c_a·c_b − 0.002·|v|)).
	 */
	function interpolateFlow(
		a: FlowImage,
		b: FlowImage,
		w: number,
		flow: FlowPair,
		out?: { data: Float32Array | Uint8Array | Uint8ClampedArray },
		rows?: { y0: number; y1: number },
	): Float32Array | Uint8Array | Uint8ClampedArray {
		const W = a.width;
		const H = a.height;
		const dst = out?.data ?? new Float32Array(W * H * 4);
		const k = flow.k;
		const T: [number, number] = [0, 0];
		const pa: number[] = [0, 0, 0, 0];
		const pb: number[] = [0, 0, 0, 0];
		const acc: number[] = [0, 0, 0, 0];
		const round = !(dst instanceof Float32Array);
		const y0 = rows?.y0 ?? 0;
		const y1 = rows?.y1 ?? H;
		const NC = C.candidates;
		const vx = new Float64Array(NC);
		const vy = new Float64Array(NC);
		const scores = new Float64Array(NC);
		const cols = new Float64Array(NC * 4);
		const photoScale = C.photoWeight / (flow.scale || 1);
		for (let y = y0; y < y1; y++)
			for (let x = 0; x < W; x++) {
				const px = x + 0.5;
				const py = y + 0.5;
				flowCandidates(flow, px, py, vx, vy, T);
				let best = Number.NEGATIVE_INFINITY;
				for (let hI = 0; hI < NC; hI++) {
					const hx = vx[hI]!;
					const hy = vy[hI]!;
					const qax = px - w * hx;
					const qay = py - w * hy;
					const qbx = px + (1 - w) * hx;
					const qby = py + (1 - w) * hy;
					flowAt(flow.ab, qax / k, qay / k, T);
					const ca = vectorMatch(T[0] * k, T[1] * k, hx, hy);
					flowAt(flow.ba, qbx / k, qby / k, T);
					const cb = vectorMatch(-T[0] * k, -T[1] * k, hx, hy);
					sample(a, qax, qay, pa);
					sample(b, qbx, qby, pb);
					const wa = (1 - w) * (ca + C.delta);
					const wb = w * (cb + C.delta);
					const s = 1 / (wa + wb);
					let photo = 0;
					for (let c = 0; c < 4; c++) {
						cols[hI * 4 + c] = (pa[c]! * wa + pb[c]! * wb) * s;
						if (c < 3) photo += Math.abs(pa[c]! - pb[c]!);
					}
					// The photometric term only counts where both ends see the pixel.
					const score = ca + cb - photoScale * photo * ca * cb - C.slowBias * Math.hypot(hx, hy);
					scores[hI] = score;
					if (score > best) best = score;
				}
				let sum = 0;
				acc[0] = acc[1] = acc[2] = acc[3] = 0;
				for (let hI = 0; hI < NC; hI++) {
					const e = Math.exp(C.sharpness * (scores[hI]! - best));
					sum += e;
					for (let c = 0; c < 4; c++) acc[c]! += cols[hI * 4 + c]! * e;
				}
				const o = (y * W + x) * 4;
				for (let c = 0; c < 4; c++) {
					const v = acc[c]! / sum;
					dst[o + c] = round ? Math.round(v) : v;
				}
			}
		return dst;
	}

	/** Fills the candidate vectors (full px) of output pixel (px, py). */
	function flowCandidates(
		flow: FlowPair,
		px: number,
		py: number,
		vx: Float64Array,
		vy: Float64Array,
		T: [number, number],
	): void {
		const k = flow.k;
		flowAt(flow.ab, px / k, py / k, T);
		vx[0] = T[0] * k;
		vy[0] = T[1] * k;
		flowAt(flow.ba, px / k, py / k, T);
		vx[1] = -T[0] * k;
		vy[1] = -T[1] * k;
		let n = 2;
		for (const [f, sign] of [
			[flow.ab, 1],
			[flow.ba, -1],
		] as const) {
			const bsz = f.block;
			const fx = Math.min(f.cols - 1, Math.max(0, px / k / bsz - 0.5));
			const fy = Math.min(f.rows - 1, Math.max(0, py / k / bsz - 0.5));
			const x0 = Math.floor(fx);
			const yy0 = Math.floor(fy);
			for (const [dx, dy] of TILE_CORNERS) {
				const cx = Math.min(f.cols - 1, x0 + dx);
				const cy = Math.min(f.rows - 1, yy0 + dy);
				const j = (cy * f.cols + cx) * 2;
				vx[n] = sign * f.v[j]! * k;
				vy[n] = sign * f.v[j + 1]! * k;
				n++;
			}
		}
	}

	const TILE_CORNERS: readonly [number, number][] = [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	];

	/** Frame Blending: a·(1 − w) + b·w (Premiere "repeats frames and blends between them"). */
	function blendFrames(
		a: FlowImage,
		b: FlowImage,
		w: number,
		out?: { data: Float32Array | Uint8Array | Uint8ClampedArray },
	): Float32Array | Uint8Array | Uint8ClampedArray {
		const n = a.width * a.height * 4;
		const dst = out?.data ?? new Float32Array(n);
		const round = !(dst instanceof Float32Array);
		const da = a.data;
		const db = b.data;
		for (let i = 0; i < n; i++) {
			const v = da[i]! + (db[i]! - da[i]!) * w;
			dst[i] = round ? Math.round(v) : v;
		}
		return dst;
	}

	/** Plain cross-fade of effectcraft (for comparisons in tests). */
	function interpolateEffectcraft(
		a: FlowImage,
		b: FlowImage,
		w: number,
		flowAB: BlockFlow,
		k: number,
	): Float32Array {
		const W = a.width;
		const H = a.height;
		const dst = new Float32Array(W * H * 4);
		const F: [number, number] = [0, 0];
		const pa: number[] = [0, 0, 0, 0];
		const pb: number[] = [0, 0, 0, 0];
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const px = x + 0.5;
				const py = y + 0.5;
				flowAt(flowAB, px / k, py / k, F);
				const fx = F[0] * k;
				const fy = F[1] * k;
				sample(a, px - w * fx, py - w * fy, pa);
				sample(b, px + (1 - w) * fx, py + (1 - w) * fy, pb);
				const o = (y * W + x) * 4;
				for (let c = 0; c < 4; c++) dst[o + c] = pa[c]! + (pb[c]! - pa[c]!) * w;
			}
		return dst;
	}

	return {
		analysisFactor,
		analysisSize,
		analysisLuma,
		halfPlane,
		pyramid,
		pyramidLevels,
		blockFlow,
		flowAt,
		computeFlowPair,
		vectorMatch,
		interpolateFlow,
		flowCandidates,
		blendFrames,
		interpolateEffectcraft,
		sad,
		sample,
	};
}

/**
 * JavaScript source that evaluates to a kernel with the default constants (worker threads). `__name` is the helper
 * esbuild/tsx insert around named inner functions when names are kept.
 */
export function flowKernelSource(): string {
	return `(function () { const __name = (f) => f; return (${createFlowKernel.toString()})(${JSON.stringify(FLOW_CONSTANTS)}); })()`;
}

/** The kernel with the default constants (main thread). */
const K = createFlowKernel(FLOW_CONSTANTS);
export const analysisFactor = K.analysisFactor;
export const analysisSize = K.analysisSize;
export const analysisLuma = K.analysisLuma;
export const halfPlane = K.halfPlane;
export const pyramid = K.pyramid;
export const pyramidLevels = K.pyramidLevels;
export const blockFlow = K.blockFlow;
export const flowAt = K.flowAt;
export const computeFlowPair = K.computeFlowPair;
export const vectorMatch = K.vectorMatch;
export const interpolateFlow = K.interpolateFlow;
export const flowCandidates = K.flowCandidates;
export const blendFrames = K.blendFrames;
export const interpolateEffectcraft = K.interpolateEffectcraft;
