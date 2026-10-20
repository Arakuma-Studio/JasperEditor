// Picture motion of two consecutive frames (spec 12 §2.2 "pixel motion curve", P6-R2): the engine renders the
// sequence's picture at a low resolution (gray, long side ≈ 128 px) and measures each frame against the one before:
//
//   diff      mean |cur − prev| / 255 (how much the picture changed);
//   flow      block matching: 8×8 blocks, a coarse search on the half-size frames (±6 px there, ±12 px here), a ±2 px
//             refinement at full size and a parabolic sub-pixel fit per axis. A block moves only when its best match is
//             clearly better than staying put (cost < 50 % of the unmoved cost), really matches (≤ 10 gray levels per
//             pixel: across a cut every block finds some "match", none this close) and it has texture to match (flat
//             areas are ambiguous and count as still);
//   speed     median |v| of the moving blocks (px per frame; 0 below 2 moving blocks: noise, a flicker);
//   vx, vy    their median signed vector (screen x right, y down): the direction a whoosh pans along;
//   area      moving blocks / all blocks; cx their mean centre x (0 = left … 1 = right);
//   residual  what translation does not explain: mean best cost per pixel / 255 (a cut or a flash is high
//             everywhere, a move is low).
//
// Pure and deterministic; never throws on hostile input (sizes are checked, frames shorter than w×h measure as still).

/** Block size (analysis pixels). */
export const PIXEL_BLOCK = 8;
/** Search range at half size (± px); ±12 px at the analysis size. */
export const PIXEL_COARSE_SEARCH = 6;
/** Refinement around the coarse vector at the analysis size (± px). */
export const PIXEL_REFINE = 2;
/** A block moves when its best match costs less than this share of not moving… */
export const PIXEL_MATCH_GAIN = 0.5;
/** …and at most this much per pixel (gray levels). */
export const PIXEL_MATCH_MAX_COST = 10;
/** Least mean absolute gradient (gray levels) a block needs to be matched. */
export const PIXEL_TEXTURE_MIN = 2;
/** Unmoved cost per pixel (gray levels) below which a block is still (compression noise, grain). */
export const PIXEL_STILL_COST = 1.5;
/** Smallest vector (px per frame) that counts as moving. */
export const PIXEL_MIN_VECTOR = 0.3;
/** Fewer moving blocks than this is noise (speed 0). */
export const PIXEL_MIN_BLOCKS = 2;
/** Largest analysis frame accepted (pixels). */
export const PIXEL_MAX_SIZE = 512 * 512;

export type PixelFrameMotion = {
	/** Mean |v| of the moving blocks, analysis pixels per frame. */
	speedPx: number;
	/** Mean signed vector of the moving blocks (px per frame). */
	vx: number;
	vy: number;
	/** Share of the blocks that move (0…1). */
	area: number;
	/** Mean centre x of the moving blocks (0…1; 0.5 when none move). */
	cx: number;
	/** Mean unexplained change per pixel after motion compensation (0…1). */
	residual: number;
	/** Mean absolute frame difference (0…1). */
	diff: number;
};

const STILL: PixelFrameMotion = { speedPx: 0, vx: 0, vy: 0, area: 0, cx: 0.5, residual: 0, diff: 0 };

function half(src: Uint8Array, w: number, h: number): { data: Uint8Array; w: number; h: number } {
	const w2 = w >> 1;
	const h2 = h >> 1;
	const out = new Uint8Array(w2 * h2);
	for (let y = 0; y < h2; y++)
		for (let x = 0; x < w2; x++) {
			const i = 2 * y * w + 2 * x;
			out[y * w2 + x] = (src[i]! + src[i + 1]! + src[i + w]! + src[i + w + 1]! + 2) >> 2;
		}
	return { data: out, w: w2, h: h2 };
}

/** Sum of |cur(p) − prev(p − v)| over a block (prev sampled with edge clamping). */
function sad(
	cur: Uint8Array,
	prev: Uint8Array,
	w: number,
	h: number,
	x0: number,
	y0: number,
	b: number,
	dx: number,
	dy: number,
	limit: number,
): number {
	let s = 0;
	for (let y = 0; y < b; y++) {
		const yc = y0 + y;
		let yp = yc - dy;
		if (yp < 0) yp = 0;
		else if (yp >= h) yp = h - 1;
		const rc = yc * w;
		const rp = yp * w;
		for (let x = 0; x < b; x++) {
			const xc = x0 + x;
			let xp = xc - dx;
			if (xp < 0) xp = 0;
			else if (xp >= w) xp = w - 1;
			const d = cur[rc + xc]! - prev[rp + xp]!;
			s += d < 0 ? -d : d;
		}
		if (s >= limit) return s;
	}
	return s;
}

/** Median (the mean of the middle two for an even count). */
function median(v: number[]): number {
	const s = v.slice().sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * One Lucas–Kanade step for a block displaced by whole pixels (dx, dy): the sub-pixel correction δ minimising
 * Σ(cur(p) − prev(p − d − δ))² to first order, and the linearised cost Σ|It + ∇prev·δ| it predicts. Null when the
 * block's gradients do not determine both components (an edge, a flat area).
 */
function lucasKanade(
	cur: Uint8Array,
	prev: Uint8Array,
	w: number,
	h: number,
	x0: number,
	y0: number,
	b: number,
	dx: number,
	dy: number,
): { dx: number; dy: number; cost: number } | null {
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	let sxt = 0;
	let syt = 0;
	const n = b * b;
	const ix = new Float64Array(n);
	const iy = new Float64Array(n);
	const it = new Float64Array(n);
	const px = (x: number, y: number) =>
		prev[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
	let k = 0;
	for (let y = 0; y < b; y++)
		for (let x = 0; x < b; x++, k++) {
			const X = x0 + x - dx;
			const Y = y0 + y - dy;
			const gx = (px(X + 1, Y) - px(X - 1, Y)) / 2;
			const gy = (px(X, Y + 1) - px(X, Y - 1)) / 2;
			const t = cur[(y0 + y) * w + x0 + x]! - px(X, Y);
			ix[k] = gx;
			iy[k] = gy;
			it[k] = t;
			sxx += gx * gx;
			sxy += gx * gy;
			syy += gy * gy;
			sxt += gx * t;
			syt += gy * t;
		}
	const det = sxx * syy - sxy * sxy;
	const tr = sxx + syy;
	// both eigenvalues well away from 0 (a corner-like, textured block)
	if (!(det > 1e-6 * tr * tr) || !(tr > n)) return null;
	// cur ≈ prev(p − d) − ∇prev·δ  ⇒  It ≈ −∇prev·δ  ⇒  δ = −(AᵀA)⁻¹ Aᵀ It
	const ddx = -(syy * sxt - sxy * syt) / det;
	const ddy = -(sxx * syt - sxy * sxt) / det;
	if (!Number.isFinite(ddx) || !Number.isFinite(ddy)) return null;
	let cost = 0;
	for (let i = 0; i < n; i++) cost += Math.abs(it[i]! + ix[i]! * ddx + iy[i]! * ddy);
	return { dx: ddx, dy: ddy, cost };
}

/** Sub-pixel offset of a parabola through (−1, a), (0, b), (1, c), within ±0.5. */
function parabola(a: number, b: number, c: number): number {
	const den = a - 2 * b + c;
	if (!(den > 0)) return 0;
	const d = (0.5 * (a - c)) / den;
	return d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;
}

/**
 * The motion between two gray frames of `w × h` pixels (row-major, one byte per pixel). Frames of the wrong length or
 * an unusable size measure as still.
 */
export function measureFrameMotion(
	prev: Uint8Array,
	cur: Uint8Array,
	w: number,
	h: number,
): PixelFrameMotion {
	if (
		!Number.isInteger(w) ||
		!Number.isInteger(h) ||
		w < 2 * PIXEL_BLOCK ||
		h < 2 * PIXEL_BLOCK ||
		w * h > PIXEL_MAX_SIZE ||
		!(prev instanceof Uint8Array) ||
		!(cur instanceof Uint8Array) ||
		prev.length < w * h ||
		cur.length < w * h
	)
		return { ...STILL };
	const n = w * h;
	let diffSum = 0;
	for (let i = 0; i < n; i++) {
		const d = cur[i]! - prev[i]!;
		diffSum += d < 0 ? -d : d;
	}
	const diff = diffSum / n / 255;
	const B = PIXEL_BLOCK;
	const bw = Math.floor(w / B);
	const bh = Math.floor(h / B);
	const P = B * B;
	const c2 = half(cur, w, h);
	const p2 = half(prev, w, h);
	const b2 = B >> 1;
	let moving = 0;
	const lens: number[] = [];
	const xs: number[] = [];
	const ys: number[] = [];
	let sumCx = 0;
	let resid = 0;
	for (let by = 0; by < bh; by++)
		for (let bx = 0; bx < bw; bx++) {
			const x0 = bx * B;
			const y0 = by * B;
			const zero = sad(cur, prev, w, h, x0, y0, B, 0, 0, Number.POSITIVE_INFINITY);
			if (zero <= PIXEL_STILL_COST * P) {
				resid += zero;
				continue;
			}
			// Texture of the block (mean absolute horizontal + vertical gradient): flat blocks cannot be matched.
			let grad = 0;
			for (let y = 0; y < B; y++) {
				const r = (y0 + y) * w;
				for (let x = 0; x < B; x++) {
					const i = r + x0 + x;
					if (x0 + x + 1 < w) grad += Math.abs(cur[i + 1]! - cur[i]!);
					if (y0 + y + 1 < h) grad += Math.abs(cur[i + w]! - cur[i]!);
				}
			}
			if (grad / P < PIXEL_TEXTURE_MIN) {
				resid += zero;
				continue;
			}
			// Coarse search at half size, then refine at full size.
			let best = Number.POSITIVE_INFINITY;
			let cdx = 0;
			let cdy = 0;
			const hx = x0 >> 1;
			const hy = y0 >> 1;
			const S = PIXEL_COARSE_SEARCH;
			for (let dy = -S; dy <= S; dy++)
				for (let dx = -S; dx <= S; dx++) {
					const s = sad(c2.data, p2.data, c2.w, c2.h, hx, hy, b2, dx, dy, best);
					if (s < best || (s === best && dx * dx + dy * dy < cdx * cdx + cdy * cdy)) {
						best = s;
						cdx = dx;
						cdy = dy;
					}
				}
			best = Number.POSITIVE_INFINITY;
			let vx = 0;
			let vy = 0;
			const R = PIXEL_REFINE;
			const costs = new Map<number, number>();
			const at = (dx: number, dy: number) => {
				const k = (dy + 64) * 256 + (dx + 64);
				let s = costs.get(k);
				if (s === undefined) {
					s = sad(cur, prev, w, h, x0, y0, B, dx, dy, Number.POSITIVE_INFINITY);
					costs.set(k, s);
				}
				return s;
			};
			for (let dy = 2 * cdy - R; dy <= 2 * cdy + R; dy++)
				for (let dx = 2 * cdx - R; dx <= 2 * cdx + R; dx++) {
					const s = at(dx, dy);
					if (s < best || (s === best && dx * dx + dy * dy < vx * vx + vy * vy)) {
						best = s;
						vx = dx;
						vy = dy;
					}
				}
			// Sub-pixel: one Lucas–Kanade step around the best whole-pixel match (motion under a pixel per frame, which
			// whole-pixel matching cannot tell from noise); the parabola fit when the block's gradients are degenerate.
			const lk = lucasKanade(cur, prev, w, h, x0, y0, B, vx, vy);
			let fx: number;
			let fy: number;
			let cost: number;
			if (lk && Math.abs(lk.dx) <= 1.5 && Math.abs(lk.dy) <= 1.5 && lk.cost < best) {
				fx = vx + lk.dx;
				fy = vy + lk.dy;
				cost = lk.cost;
			} else {
				fx = vx === 0 && vy === 0 ? 0 : vx + parabola(at(vx - 1, vy), best, at(vx + 1, vy));
				fy = vx === 0 && vy === 0 ? 0 : vy + parabola(at(vx, vy - 1), best, at(vx, vy + 1));
				cost = best;
			}
			if (!(cost < PIXEL_MATCH_GAIN * zero) || cost > PIXEL_MATCH_MAX_COST * P || (fx === 0 && fy === 0)) {
				// motion does not explain this block's change
				resid += zero;
				continue;
			}
			resid += cost;
			const len = Math.hypot(fx, fy);
			if (len < PIXEL_MIN_VECTOR) continue;
			moving++;
			lens.push(len);
			xs.push(fx);
			ys.push(fy);
			sumCx += (x0 + B / 2) / w;
		}
	const blocks = bw * bh;
	const residual = blocks > 0 ? resid / (blocks * P) / 255 : 0;
	if (moving < PIXEL_MIN_BLOCKS) return { ...STILL, residual, diff };
	return {
		speedPx: median(lens),
		vx: median(xs),
		vy: median(ys),
		area: moving / blocks,
		cx: sumCx / moving,
		residual,
		diff,
	};
}

/** The analysis size of a picture: long side `longSide` (default 128), even sides, at least 2 blocks each way. */
export function pixelAnalysisSize(
	width: number,
	height: number,
	longSide = 128,
): { width: number; height: number } {
	const w = Number.isFinite(width) && width > 0 ? width : 16;
	const h = Number.isFinite(height) && height > 0 ? height : 9;
	const L = Math.max(4 * PIXEL_BLOCK, Math.min(512, Math.round(longSide)));
	const even = (x: number) => Math.max(2 * PIXEL_BLOCK, Math.round(x / 2) * 2);
	return w >= h
		? { width: even(L), height: even((L * h) / w) }
		: { width: even((L * w) / h), height: even(L) };
}
