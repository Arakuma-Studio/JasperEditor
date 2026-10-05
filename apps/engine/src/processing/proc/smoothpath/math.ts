// Pure math of the smooth-path stabiliser (S07:PST-005). Port of the
// trailer project's `grade/tools/smoothstab.py` (our own pipeline code):
//
//  1. frame-to-frame similarity (tx, ty, rotation, scale) from tracked corners, fitted with RANSAC so moving
//     subjects are outliers and only the background (the camera) counts;
//  2. accumulated to a camera path relative to frame 0 about the frame centre, smoothed with a Gaussian (sigma
//     in frames, edges held) — or, for y and/or roll, replaced by a straight line (no intended vertical / roll
//     motion in a static-operator shot);
//  3. correction_i = smoothed_i ∘ actual_i⁻¹, plus ONE static zoom about the centre for the whole shot (the
//     smallest that hides every border), capped; when the cap is not enough, the largest smoothing that fits.
//
// Coordinates: pixel centres at integer positions (OpenCV convention). Matrices are 3×3 row-major arrays.

type Mat3 = [number, number, number, number, number, number, number, number, number];

/** A similarity x' = a·x − b·y + tx, y' = b·x + a·y + ty (scale √(a²+b²), angle atan2(b, a)). */
export type Similarity = { a: number; b: number; tx: number; ty: number };

export const IDENTITY_SIM: Similarity = { a: 1, b: 0, tx: 0, ty: 0 };

function simToMat(s: Similarity): Mat3 {
	return [s.a, -s.b, s.tx, s.b, s.a, s.ty, 0, 0, 1];
}

function mul(m: Mat3, n: Mat3): Mat3 {
	return [
		m[0] * n[0] + m[1] * n[3] + m[2] * n[6],
		m[0] * n[1] + m[1] * n[4] + m[2] * n[7],
		m[0] * n[2] + m[1] * n[5] + m[2] * n[8],
		m[3] * n[0] + m[4] * n[3] + m[5] * n[6],
		m[3] * n[1] + m[4] * n[4] + m[5] * n[7],
		m[3] * n[2] + m[4] * n[5] + m[5] * n[8],
		m[6] * n[0] + m[7] * n[3] + m[8] * n[6],
		m[6] * n[1] + m[7] * n[4] + m[8] * n[7],
		m[6] * n[2] + m[7] * n[5] + m[8] * n[8],
	];
}

/** Inverse of an affine 3×3 (last row 0 0 1). */
function invAffine(m: Mat3): Mat3 {
	const det = m[0] * m[4] - m[1] * m[3];
	const a = m[4] / det;
	const b = -m[1] / det;
	const c = -m[3] / det;
	const d = m[0] / det;
	return [a, b, -(a * m[2] + b * m[5]), c, d, -(c * m[2] + d * m[5]), 0, 0, 1];
}

const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];

/** Similarity from parameters (translation, angle in rad, scale), as smoothstab.py `sim`. */
function simMat(tx: number, ty: number, angle: number, scale: number): Mat3 {
	const c = Math.cos(angle) * scale;
	const s = Math.sin(angle) * scale;
	return [c, -s, tx, s, c, ty, 0, 0, 1];
}

// ------------------------------------------------------------------ similarity fit

/**
 * Least-squares similarity mapping `src[i] → dst[i]` over the points selected by `use` (all when absent):
 * closed form on centred coordinates. Points are interleaved x,y. Null when fewer than 2 points or degenerate.
 */
function fitSimilarity(
	src: ArrayLike<number>,
	dst: ArrayLike<number>,
	use?: ArrayLike<number> | null,
): Similarity | null {
	const n = src.length / 2;
	let cnt = 0;
	let mx = 0;
	let my = 0;
	let nx = 0;
	let ny = 0;
	for (let i = 0; i < n; i++) {
		if (use && !use[i]) continue;
		mx += src[2 * i];
		my += src[2 * i + 1];
		nx += dst[2 * i];
		ny += dst[2 * i + 1];
		cnt++;
	}
	if (cnt < 2) return null;
	mx /= cnt;
	my /= cnt;
	nx /= cnt;
	ny /= cnt;
	let sxx = 0;
	let sa = 0;
	let sb = 0;
	for (let i = 0; i < n; i++) {
		if (use && !use[i]) continue;
		const xs = src[2 * i] - mx;
		const ys = src[2 * i + 1] - my;
		const xd = dst[2 * i] - nx;
		const yd = dst[2 * i + 1] - ny;
		sxx += xs * xs + ys * ys;
		sa += xs * xd + ys * yd;
		sb += xs * yd - ys * xd;
	}
	if (!(sxx > 1e-9)) return null;
	const a = sa / sxx;
	const b = sb / sxx;
	return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

/** Deterministic PRNG (mulberry32) so every run of a recipe gives the same output. */
function rng(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

type RansacOptions = {
	/** Inlier distance in pixels (smoothstab.py: 1.5 px at the source size). */
	threshold?: number;
	maxIters?: number;
	confidence?: number;
	seed?: number;
};

type RansacResult = { sim: Similarity; inliers: number; mask: Uint8Array };

function countInliers(
	s: Similarity,
	src: ArrayLike<number>,
	dst: ArrayLike<number>,
	t2: number,
	mask: Uint8Array,
) {
	let k = 0;
	for (let i = 0; i < mask.length; i++) {
		const x = src[2 * i];
		const y = src[2 * i + 1];
		const ex = s.a * x - s.b * y + s.tx - dst[2 * i];
		const ey = s.b * x + s.a * y + s.ty - dst[2 * i + 1];
		const ok = ex * ex + ey * ey <= t2;
		mask[i] = ok ? 1 : 0;
		if (ok) k++;
	}
	return k;
}

/**
 * Robust similarity (the role of OpenCV's `estimateAffinePartial2D(..., RANSAC)`, which OpenCV.js does not
 * export): 2-point minimal samples with an adaptive iteration count, then least-squares refits on the inliers.
 * Moving subjects are outliers as long as the background holds the majority of the tracked corners.
 */
export function ransacSimilarity(
	src: ArrayLike<number>,
	dst: ArrayLike<number>,
	opts: RansacOptions = {},
): RansacResult | null {
	const n = src.length / 2;
	if (n < 2) return null;
	const thr = opts.threshold ?? 1.5;
	const t2 = thr * thr;
	const conf = opts.confidence ?? 0.99;
	let iters = opts.maxIters ?? 2000;
	const rand = rng(opts.seed ?? 0x5eed);
	const mask = new Uint8Array(n);
	let best: Similarity | null = null;
	let bestCount = -1;
	const pair = new Float64Array(4);
	const pairDst = new Float64Array(4);
	for (let it = 0; it < iters; it++) {
		const i = Math.floor(rand() * n);
		let j = Math.floor(rand() * (n - 1));
		if (j >= i) j++;
		pair[0] = src[2 * i];
		pair[1] = src[2 * i + 1];
		pair[2] = src[2 * j];
		pair[3] = src[2 * j + 1];
		if (Math.hypot(pair[0] - pair[2], pair[1] - pair[3]) < 1) continue;
		pairDst[0] = dst[2 * i];
		pairDst[1] = dst[2 * i + 1];
		pairDst[2] = dst[2 * j];
		pairDst[3] = dst[2 * j + 1];
		const s = fitSimilarity(pair, pairDst);
		if (!s) continue;
		const k = countInliers(s, src, dst, t2, mask);
		if (k > bestCount) {
			bestCount = k;
			best = s;
			const w = k / n;
			const p = 1 - w * w;
			if (p <= 0) break;
			const need = Math.ceil(Math.log(1 - conf) / Math.log(p));
			if (Number.isFinite(need)) iters = Math.min(iters, Math.max(need, it + 1));
		}
	}
	if (!best || bestCount < 2) return null;
	// Refinement: least squares on the inliers with an adaptive, tighter threshold (3 robust sigmas of the
	// inlier residuals, between thr/3 and thr), a few rounds. This removes the bias of the particular 2-point
	// hypothesis that won (measured on crudo.mp4: vertical frame-to-frame noise 0.100 → 0.038 px rms; the
	// result no longer depends on which hypothesis RANSAC happened to draw).
	let sim = best;
	const res = new Float64Array(n);
	const residuals = (s: Similarity) => {
		for (let i = 0; i < n; i++) {
			const x = src[2 * i];
			const y = src[2 * i + 1];
			res[i] = Math.hypot(s.a * x - s.b * y + s.tx - dst[2 * i], s.b * x + s.a * y + s.ty - dst[2 * i + 1]);
		}
	};
	let t = thr;
	for (let r = 0; r < 5; r++) {
		residuals(sim);
		const inl: number[] = [];
		for (let i = 0; i < n; i++) if (res[i] <= thr) inl.push(res[i]);
		if (inl.length < 2) break;
		inl.sort((p, q) => p - q);
		const med = inl[Math.floor((inl.length - 1) / 2)];
		t = Math.min(thr, Math.max(thr / 3, 3 * 1.4826 * med));
		for (let i = 0; i < n; i++) mask[i] = res[i] <= t ? 1 : 0;
		const refit = fitSimilarity(src, dst, mask);
		if (!refit) break;
		const moved = Math.abs(refit.tx - sim.tx) + Math.abs(refit.ty - sim.ty);
		sim = refit;
		if (moved < 1e-4) break;
	}
	residuals(sim);
	let count = 0;
	for (let i = 0; i < n; i++) {
		mask[i] = res[i] <= t ? 1 : 0;
		count += mask[i];
	}
	return { sim, inliers: count, mask };
}

// ------------------------------------------------------------------ path smoothing

/** Gaussian smoothing (sigma in samples, kernel radius ⌊3σ⌋, edge values held), as smoothstab.py `gauss`. */
function gaussSmooth(a: ArrayLike<number>, sigma: number): Float64Array {
	const n = a.length;
	const out = Float64Array.from(a as ArrayLike<number>);
	if (!(sigma > 0) || n === 0) return out;
	const r = Math.floor(3 * sigma);
	const k = new Float64Array(2 * r + 1);
	let sum = 0;
	for (let i = -r; i <= r; i++) {
		k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2);
		sum += k[i + r];
	}
	for (let i = 0; i < k.length; i++) k[i] /= sum;
	for (let i = 0; i < n; i++) {
		let acc = 0;
		for (let j = -r; j <= r; j++) {
			const idx = Math.min(n - 1, Math.max(0, i + j));
			acc += k[j + r] * a[idx];
		}
		out[i] = acc;
	}
	return out;
}

/** Least-squares straight line through `a` over its index (smoothstab.py `line`). */
function lineFit(a: ArrayLike<number>): Float64Array {
	const n = a.length;
	const out = new Float64Array(n);
	if (n === 0) return out;
	if (n === 1) {
		out[0] = a[0];
		return out;
	}
	let st = 0;
	let sy = 0;
	for (let i = 0; i < n; i++) {
		st += i;
		sy += a[i];
	}
	const mt = st / n;
	const my = sy / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		num += (i - mt) * (a[i] - my);
		den += (i - mt) ** 2;
	}
	const slope = den > 0 ? num / den : 0;
	for (let i = 0; i < n; i++) out[i] = my + slope * (i - mt);
	return out;
}

/** Camera parameters per frame relative to frame 0, about the frame centre. */
type CameraPath = {
	tx: Float64Array;
	ty: Float64Array;
	angle: Float64Array;
	scale: Float64Array;
	/** Q_i: frame-0 centred coordinates → frame-i centred coordinates. */
	q: Mat3[];
};

/**
 * Accumulates the frame-to-frame similarities (`pairs[i]` maps frame i → frame i+1, in pixel coordinates)
 * into the camera path: P_0 = I, P_i = M_{i−1} · P_{i−1}; Q_i = C⁻¹ P_i C with C the translation to the centre.
 */
function cameraPath(pairs: readonly Similarity[], width: number, height: number): CameraPath {
	const n = pairs.length + 1;
	const C = translate(width / 2, height / 2);
	const Ci = translate(-width / 2, -height / 2);
	const tx = new Float64Array(n);
	const ty = new Float64Array(n);
	const angle = new Float64Array(n);
	const scale = new Float64Array(n);
	const q: Mat3[] = [];
	let P: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	for (let i = 0; i < n; i++) {
		if (i > 0) P = mul(simToMat(pairs[i - 1]), P);
		const Q = mul(mul(Ci, P), C);
		q.push(Q);
		tx[i] = Q[2];
		ty[i] = Q[5];
		angle[i] = Math.atan2(Q[3], Q[0]);
		scale[i] = Math.hypot(Q[0], Q[3]);
	}
	// Unwrap the angle so a smoothed path never averages across ±π.
	for (let i = 1; i < n; i++) {
		while (angle[i] - angle[i - 1] > Math.PI) angle[i] -= 2 * Math.PI;
		while (angle[i] - angle[i - 1] < -Math.PI) angle[i] += 2 * Math.PI;
	}
	return { tx, ty, angle, scale, q };
}

type SmoothOptions = { sigma: number; lockVertical: boolean; lockRotation: boolean };

type SmoothedPath = { tx: Float64Array; ty: Float64Array; angle: Float64Array; scale: Float64Array };

function smoothCameraPath(p: CameraPath, o: SmoothOptions): SmoothedPath {
	return {
		tx: gaussSmooth(p.tx, o.sigma),
		ty: o.lockVertical ? lineFit(p.ty) : gaussSmooth(p.ty, o.sigma),
		angle: o.lockRotation ? lineFit(p.angle) : gaussSmooth(p.angle, o.sigma),
		scale: gaussSmooth(p.scale, o.sigma),
	};
}

/** Centred corrections K_i = S_i · Q_i⁻¹ (actual camera → smoothed camera). */
function corrections(p: CameraPath, s: SmoothedPath): Mat3[] {
	return p.q.map((Q, i) => mul(simMat(s.tx[i], s.ty[i], s.angle[i], s.scale[i]), invAffine(Q)));
}

/**
 * Whether a static zoom `z` (about the centre) hides every border: the output frame's corners, brought back
 * through each correction, stay inside the source frame (half a pixel of margin), as smoothstab.py `ok`.
 */
function bordersHidden(corr: readonly Mat3[], z: number, width: number, height: number): boolean {
	const hw = width / 2 / z;
	const hh = height / 2 / z;
	const lx = width / 2 - 0.5;
	const ly = height / 2 - 0.5;
	for (const K of corr) {
		const I = invAffine(K);
		for (const [x, y] of [
			[-hw, -hh],
			[hw, -hh],
			[hw, hh],
			[-hw, hh],
		]) {
			const sx = I[0] * x + I[1] * y + I[2];
			const sy = I[3] * x + I[4] * y + I[5];
			if (Math.abs(sx) > lx || Math.abs(sy) > ly) return false;
		}
	}
	return true;
}

/** Margin on the found zoom (smoothstab.py: ×1.002) so bicubic taps never reach the replicated edge. */
const ZOOM_MARGIN = 1.002;

/**
 * The smallest static zoom ≤ `cap` that hides the borders (bisection, 30 steps), with the margin; null when
 * even `cap` is not enough. `needed` (no cap, up to 4×) is reported for the explanation.
 */
function minimalZoom(
	corr: readonly Mat3[],
	width: number,
	height: number,
	cap: number,
): { zoom: number | null; needed: number } {
	const need = (hiStart: number): number | null => {
		if (bordersHidden(corr, 1, width, height)) return 1;
		if (!bordersHidden(corr, hiStart, width, height)) return null;
		let lo = 1;
		let hi = hiStart;
		for (let k = 0; k < 30; k++) {
			const mid = (lo + hi) / 2;
			if (bordersHidden(corr, mid, width, height)) hi = mid;
			else lo = mid;
		}
		return hi;
	};
	const capped = need(cap);
	if (capped !== null) {
		// The margin never pushes the zoom over the cap (the cap itself hides the borders).
		const z = capped === 1 ? 1 : Math.min(cap, capped * ZOOM_MARGIN);
		return { zoom: z, needed: z };
	}
	const free = need(4);
	return { zoom: null, needed: free === null ? Number.POSITIVE_INFINITY : free * ZOOM_MARGIN };
}

// ------------------------------------------------------------------ plan

type SmoothPathOptions = {
	/** Gaussian sigma of the camera path, frames. */
	sigma: number;
	lockVertical: boolean;
	lockRotation: boolean;
	/** Largest static zoom as a factor (1.12 = 112 %). */
	maxZoom: number;
	/** `crop` = one static zoom hides the borders; `keep` = no zoom, the moving borders stay visible. */
	borders: 'crop' | 'keep';
};

type SmoothPathPlan = {
	/** Per output frame: the backward map (output pixel → source pixel) as a 2×3 affine [a, b, c, d, e, f]. */
	backward: number[][];
	zoom: number;
	/** What was actually used (differs from the request after a fallback). */
	sigma: number;
	lockVertical: boolean;
	lockRotation: boolean;
	/** Set when the request needed more zoom than the cap. */
	fallback: null | { requestedSigma: number; neededZoom: number; locksReleased: boolean };
	stats: {
		frames: number;
		/** Camera travel over the shot in source pixels (centred path). */
		travelPx: [number, number];
		rotationDeg: number;
		/** Max frame-to-frame camera speed, px/frame scaled to a 1920-wide frame: raw path vs output (×zoom). */
		rawSpeedMax1080: number;
		smoothedSpeedMax1080: number;
		/** Max frame-to-frame camera acceleration (px/frame², 1920 wide): raw vs output. */
		rawAccelMax1080: number;
		smoothedAccelMax1080: number;
	};
};

function speeds(tx: ArrayLike<number>, ty: ArrayLike<number>, k: number): { speed: number; accel: number } {
	let speed = 0;
	let accel = 0;
	let pvx = 0;
	let pvy = 0;
	for (let i = 1; i < tx.length; i++) {
		const vx = tx[i] - tx[i - 1];
		const vy = ty[i] - ty[i - 1];
		speed = Math.max(speed, Math.hypot(vx, vy) * k);
		if (i > 1) accel = Math.max(accel, Math.hypot(vx - pvx, vy - pvy) * k);
		pvx = vx;
		pvy = vy;
	}
	return { speed, accel };
}

/**
 * Plans the stabilisation of a shot from its frame-to-frame similarities: smoothed path, the static zoom and,
 * when the requested smoothing needs more zoom than `maxZoom`, the largest smoothing that fits — first keeping
 * the locks (bisection on sigma), then without them. Without locks a smoothing of 0 is the identity (zoom 1),
 * so a plan always exists.
 */
function planSmoothPath(
	pairs: readonly Similarity[],
	width: number,
	height: number,
	o: SmoothPathOptions,
): SmoothPathPlan {
	const path = cameraPath(pairs, width, height);
	const crop = o.borders === 'crop';
	const cap = Math.max(1, o.maxZoom);
	const attempt = (sigma: number, lockVertical: boolean, lockRotation: boolean) => {
		const sm = smoothCameraPath(path, { sigma, lockVertical, lockRotation });
		const corr = corrections(path, sm);
		const z = crop ? minimalZoom(corr, width, height, cap) : { zoom: 1, needed: 1 };
		return { sm, corr, zoom: z.zoom, needed: z.needed, sigma, lockVertical, lockRotation };
	};
	let best = attempt(o.sigma, o.lockVertical, o.lockRotation);
	let fallback: SmoothPathPlan['fallback'] = null;
	if (best.zoom === null) {
		const neededZoom = best.needed;
		const search = (lockV: boolean, lockR: boolean) => {
			const floor = attempt(0, lockV, lockR);
			if (floor.zoom === null) return null;
			let ok = floor;
			let lo = 0;
			let hi = o.sigma;
			for (let k = 0; k < 14; k++) {
				const mid = (lo + hi) / 2;
				const a = attempt(mid, lockV, lockR);
				if (a.zoom !== null) {
					ok = a;
					lo = mid;
				} else hi = mid;
			}
			return ok;
		};
		const kept = o.lockVertical || o.lockRotation ? search(o.lockVertical, o.lockRotation) : null;
		const found = kept ?? search(false, false) ?? attempt(0, false, false);
		best = found;
		fallback = {
			requestedSigma: o.sigma,
			neededZoom,
			locksReleased: !kept && (o.lockVertical || o.lockRotation),
		};
	}
	const zoom = best.zoom ?? 1;
	const C = translate(width / 2, height / 2);
	const Ci = translate(-width / 2, -height / 2);
	const Z: Mat3 = [zoom, 0, 0, 0, zoom, 0, 0, 0, 1];
	const backward = best.corr.map((K) => {
		const B = invAffine(mul(mul(mul(C, Z), K), Ci));
		return [B[0], B[1], B[2], B[3], B[4], B[5]];
	});
	const k = 1920 / width;
	const raw = speeds(path.tx, path.ty, k);
	const out = speeds(best.sm.tx, best.sm.ty, k * zoom);
	const n = path.tx.length;
	return {
		backward,
		zoom,
		sigma: Math.round(best.sigma * 100) / 100,
		lockVertical: best.lockVertical,
		lockRotation: best.lockRotation,
		fallback,
		stats: {
			frames: n,
			travelPx: [path.tx[n - 1] - path.tx[0], path.ty[n - 1] - path.ty[0]],
			rotationDeg: ((path.angle[n - 1] - path.angle[0]) * 180) / Math.PI,
			rawSpeedMax1080: raw.speed,
			smoothedSpeedMax1080: out.speed,
			rawAccelMax1080: raw.accel,
			smoothedAccelMax1080: out.accel,
		},
	};
}

/**
 * A backward similarity map (output → source, 2×3) as vid.stab's transform (x, y, alpha, zoom %) for the
 * shared 16-bit warp kernel (vidstab/math.ts `sourcePoint` maps points with the result).
 */
export function backwardToVsTransform(
	m: readonly number[],
	width: number,
	height: number,
): { x: number; y: number; alpha: number; zoom: number } {
	const c = m[0];
	const s = m[3];
	const z = Math.hypot(c, s);
	const cx = Math.floor(width / 2);
	const cy = Math.floor(height / 2);
	return {
		x: -c * cx + s * cy + cx - m[2],
		y: -s * cx - c * cy + cy - m[5],
		alpha: Math.atan2(s, c),
		zoom: (1 - z) * 100,
	};
}

// ------------------------------------------------------------------ shots with cuts

export type SegmentPlan = SmoothPathPlan & { firstFrame: number };

export type SegmentedPlan = {
	/** Per output frame, as SmoothPathPlan.backward (all segments concatenated). */
	backward: number[][];
	/** Each segment = one shot between cuts, planned on its own (own path, own smoothing fallback, own zoom). */
	segments: SegmentPlan[];
	/** Largest zoom of the segments (report). */
	zoom: number;
	/** Peak speeds over all segments (the pair across a cut is not a camera move and is never counted). */
	stats: { rawSpeedMax1080: number; smoothedSpeedMax1080: number };
};

/**
 * Splits a shot at its cuts and plans every segment independently (S07:PST-005, M3): the pairs across a cut
 * (`cutAfter` holds pair indices i: frame i → i+1 is a cut) are not camera motion, so each shot gets its own
 * camera path, smoothing (and fallback) and its OWN static zoom. A shared zoom (the max) was rejected: the framing
 * change would coincide with the cut anyway, and the shot needing less zoom would lose resolution for nothing.
 */
export function planSegmentedSmoothPath(
	pairs: readonly Similarity[],
	cutAfter: ReadonlySet<number>,
	width: number,
	height: number,
	o: SmoothPathOptions,
): SegmentedPlan {
	const frames = pairs.length + 1;
	const segments: SegmentPlan[] = [];
	let first = 0;
	for (let i = 0; i <= pairs.length; i++) {
		const end = i === pairs.length || cutAfter.has(i);
		if (!end) continue;
		const last = i; // frames first..last
		const plan = planSmoothPath(pairs.slice(first, last), width, height, o);
		segments.push({ ...plan, firstFrame: first });
		first = last + 1;
	}
	const backward = segments.flatMap((s) => s.backward);
	if (backward.length !== frames) throw new Error(`segmented plan: ${backward.length} frames for ${frames}`);
	return {
		backward,
		segments,
		zoom: Math.max(...segments.map((s) => s.zoom)),
		stats: {
			rawSpeedMax1080: Math.max(...segments.map((s) => s.stats.rawSpeedMax1080)),
			smoothedSpeedMax1080: Math.max(...segments.map((s) => s.stats.smoothedSpeedMax1080)),
		},
	};
}
