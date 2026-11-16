// Dense planar alignment for the planar tracker (S09:TRK-012 refinement stage, `klt-homography@2`).
//
// Robust inverse-compositional image alignment of a template (the anchor frame's plane pixels) to a frame with an
// 8-parameter homography, coarse to fine over an image pyramid:
// - Efficient second-order minimisation (ESM; Benhimane & Malis 2004, "Real-time image-based tracking of planes using
//   Efficient Second-order Minimization", IROS): the Jacobian is built from the mean of the template's gradient and
//   the warped frame's gradient, and the warp is updated by composition (W ← W ∘ W(Δp)). Unlike the inverse
//   compositional solver (Baker & Matthews 2004, IJCV 56(3)), whose fixed point is biased when the frame is blurred
//   differently from the template, ESM converges to the least-squares optimum, in fewer iterations. Template
//   gradients are computed once per template.
// - Photometric invariance as in ECC (Evangelidis & Psarakis 2008, "Parametric Image Alignment Using Enhanced
//   Correlation Coefficient Maximization", PAMI 30(10)): every iteration first fits the frame's intensities to the
//   template's as I ≈ a·T + b (weighted least squares), so exposure and contrast changes do not bias the warp.
// - Iteratively reweighted least squares with Tukey's biweight on the residuals and a MAD scale estimate (Huber,
//   "Robust Statistics"; the M-estimator form used in direct tracking, e.g. Hager & Belhumeur 1998, "Efficient Region
//   Tracking With Parametric Models of Geometry and Illumination", PAMI 20(10)): pixels of occluders (hands passing in
//   front of a screen) get zero weight instead of pulling the plane.
// - Template pixels are a uniform subsample of the textured pixels of the feature region per level (the cost is bounded
//   by `maxPts`; flat pixels carry no information). The finest level of template and frame is smoothed with a 5-tap
//   binomial (σ = 1 px) first, as ECC smooths both images: unsmoothed full-resolution edges are aliased and compressed
//   differently in every frame and bias the fit by ~0.1 px (measured on the plate-planar fixture).
// - A hold-out mask (frame px) excludes pixels whose warped position lies in a user's "ignore" region.
//
// WORKER-SAFE: the tracking worker evaluates the source text of every function exported here (like geometry.ts):
// each function may only reference other function declarations of this file and JS globals.

/** One pyramid level of a template. Coordinates are "level frame px": tracking px / 2^level. */
export type AlignLevel = {
	level: number;
	n: number;
	/** Template pixel positions (level frame px). */
	x: Float32Array;
	y: Float32Array;
	/** Template intensities. */
	t: Float32Array;
	/** Template gradients w.r.t. the normalised coordinates. */
	gx: Float32Array;
	gy: Float32Array;
	/** Normalisation: x̃ = (x − cx)/s. */
	cx: number;
	cy: number;
	s: number;
	/** Template mean and standard deviation (for the correlation score). */
	mean: number;
	std: number;
};

/** A level image of a frame crop: pixel (c, r) is at level frame px (ox + c, oy + r). */
export type AlignImage = {
	data: Uint8Array | Float32Array;
	w: number;
	h: number;
	ox: number;
	oy: number;
	level: number;
};

export type AlignResult = {
	ok: boolean;
	/** Template (anchor tracking px) → frame tracking px. */
	H: number[];
	/** Template pixels of the finest level that fell inside the frame and outside the hold-out. */
	visible: number;
	/** Of those, the pixels the robust fit kept (weight > 0.5). */
	inliers: number;
	/** Template pixels of the finest level. */
	total: number;
	/** Weighted correlation of the photometrically fitted template with the frame over the inliers, 0..1. */
	zncc: number;
	/** Robust residual scale (gray levels, template units) at the finest level. */
	sigma: number;
	iterations: number;
};

/**
 * Builds one template level from a level image of the anchor (`img`, `w`×`h`, pixel (c, r) at level frame px
 * (ox + c, oy + r)). `mask`: nonzero = usable. Keeps at most `maxPts` of the pixels with a gradient of ≥ 2 gray
 * levels per px, evenly subsampled in raster order, skipping a 1-px border.
 */
export function alignBuildLevel(
	img: Uint8Array | Float32Array,
	w: number,
	h: number,
	ox: number,
	oy: number,
	level: number,
	mask: Uint8Array,
	maxPts: number,
): AlignLevel | null {
	const g2 = new Float32Array(w * h);
	let cand = 0;
	for (let r = 1; r < h - 1; r++) {
		for (let c = 1; c < w - 1; c++) {
			const i = r * w + c;
			if (!mask[i]) continue;
			const gx = 0.5 * (img[i + 1]! - img[i - 1]!);
			const gy = 0.5 * (img[i + w]! - img[i - w]!);
			const m = gx * gx + gy * gy;
			if (m < 4) continue; // |∇| < 2 gray levels per px: flat or noise
			g2[i] = m;
			cand++;
		}
	}
	if (cand < 24) return null;
	// A uniform subsample of the textured pixels: every pixel with some gradient is equally likely, so the fit is not
	// dominated by the strongest (often aliased or compressed) edges.
	const stride = Math.max(1, cand / maxPts);
	const xs: number[] = [];
	const ys: number[] = [];
	const ts: number[] = [];
	const gxs: number[] = [];
	const gys: number[] = [];
	let next = 0;
	let k = 0;
	for (let r = 1; r < h - 1; r++) {
		for (let c = 1; c < w - 1; c++) {
			const i = r * w + c;
			if (g2[i] === 0) continue;
			if (k++ < next) continue;
			next += stride;
			xs.push(ox + c);
			ys.push(oy + r);
			ts.push(img[i]!);
			gxs.push(0.5 * (img[i + 1]! - img[i - 1]!));
			gys.push(0.5 * (img[i + w]! - img[i - w]!));
		}
	}
	const n = xs.length;
	if (n < 24) return null;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < n; i++) {
		cx += xs[i]!;
		cy += ys[i]!;
	}
	cx /= n;
	cy /= n;
	let ss = 0;
	for (let i = 0; i < n; i++) ss += (xs[i]! - cx) ** 2 + (ys[i]! - cy) ** 2;
	const s = Math.sqrt(ss / n) || 1;
	const out: AlignLevel = {
		level,
		n,
		x: Float32Array.from(xs),
		y: Float32Array.from(ys),
		t: Float32Array.from(ts),
		gx: new Float32Array(n),
		gy: new Float32Array(n),
		cx,
		cy,
		s,
		mean: 0,
		std: 1,
	};
	let mean = 0;
	for (let i = 0; i < n; i++) mean += ts[i]!;
	mean /= n;
	let v = 0;
	for (let i = 0; i < n; i++) v += (ts[i]! - mean) ** 2;
	out.mean = mean;
	out.std = Math.sqrt(v / n) || 1;
	for (let i = 0; i < n; i++) {
		out.gx[i] = gxs[i]! * s;
		out.gy[i] = gys[i]! * s;
	}
	return out;
}

/**
 * Separable 5-tap binomial blur ([1 4 6 4 1]/16, σ = 1 px) of the `w`×`h` window at (`x0`, `y0`) of an 8-bit image
 * with row stride `stride` (edges replicated), as floats.
 */
export function alignBlur5(
	src: Uint8Array,
	stride: number,
	rows: number,
	x0: number,
	y0: number,
	w: number,
	h: number,
): Float32Array {
	const tmp = new Float32Array(w * (h + 4));
	const cols = stride;
	for (let r = -2; r < h + 2; r++) {
		const sr = Math.min(rows - 1, Math.max(0, y0 + r)) * stride;
		const o = (r + 2) * w;
		for (let c = 0; c < w; c++) {
			const x = x0 + c;
			const a = src[sr + Math.max(0, x - 2)]!;
			const b = src[sr + Math.max(0, x - 1)]!;
			const m = src[sr + x]!;
			const d = src[sr + Math.min(cols - 1, x + 1)]!;
			const e = src[sr + Math.min(cols - 1, x + 2)]!;
			tmp[o + c] = (a + e + 4 * (b + d) + 6 * m) * 0.0625;
		}
	}
	const out = new Float32Array(w * h);
	for (let r = 0; r < h; r++) {
		const o = r * w;
		const t0 = r * w;
		for (let c = 0; c < w; c++) {
			const k = t0 + c;
			out[o + c] =
				(tmp[k]! + tmp[k + 4 * w]! + 4 * (tmp[k + w]! + tmp[k + 3 * w]!) + 6 * tmp[k + 2 * w]!) * 0.0625;
		}
	}
	return out;
}

/** Solves the symmetric 8×8 system A·x = b (upper triangle packed row-major, 36 values) by Cholesky; null if singular. */
export function alignSolve8(Ap: Float64Array, b: Float64Array): number[] | null {
	const A = new Float64Array(64);
	let q = 0;
	for (let r = 0; r < 8; r++)
		for (let c = r; c < 8; c++) {
			A[r * 8 + c] = Ap[q]!;
			A[c * 8 + r] = Ap[q]!;
			q++;
		}
	// Levenberg-style damping of the diagonal keeps near-degenerate (e.g. thin) templates stable.
	for (let r = 0; r < 8; r++) A[r * 9] = A[r * 9]! * (1 + 1e-6) + 1e-9;
	const L = new Float64Array(64);
	for (let j = 0; j < 8; j++) {
		let d = A[j * 9]!;
		for (let k = 0; k < j; k++) d -= L[j * 8 + k]! ** 2;
		if (!(d > 0)) return null;
		const ljj = Math.sqrt(d);
		L[j * 9] = ljj;
		for (let i = j + 1; i < 8; i++) {
			let s = A[i * 8 + j]!;
			for (let k = 0; k < j; k++) s -= L[i * 8 + k]! * L[j * 8 + k]!;
			L[i * 8 + j] = s / ljj;
		}
	}
	const y = new Array<number>(8);
	for (let i = 0; i < 8; i++) {
		let s = b[i]!;
		for (let k = 0; k < i; k++) s -= L[i * 8 + k]! * y[k]!;
		y[i] = s / L[i * 9]!;
	}
	const x = new Array<number>(8);
	for (let i = 7; i >= 0; i--) {
		let s = y[i]!;
		for (let k = i + 1; k < 8; k++) s -= L[k * 8 + i]! * x[k]!;
		x[i] = s / L[i * 9]!;
	}
	return x.every(Number.isFinite) ? x : null;
}

/**
 * Robust ESM alignment of one template level to one frame level, starting from `Hl0` (template level px → frame
 * level px). `hold`: the hold-out mask at tracking px (null = none). Returns the refined homography and the statistics
 * of the last iteration.
 */
export function alignLevel(
	tl: AlignLevel,
	im: AlignImage,
	Hl0: number[],
	maxIter: number,
	hold: { data: Uint8Array; w: number; h: number } | null,
): {
	H: number[];
	visible: number;
	inliers: number;
	zncc: number;
	sigma: number;
	iterations: number;
	ok: boolean;
} {
	const n = tl.n;
	const vals = new Float32Array(n);
	const fgx = new Float32Array(n);
	const fgy = new Float32Array(n);
	const vis = new Uint8Array(n);
	const wts = new Float32Array(n).fill(1);
	const scale = 2 ** tl.level;
	const { data, w, h, ox, oy } = im;
	const N = [1 / tl.s, 0, -tl.cx / tl.s, 0, 1 / tl.s, -tl.cy / tl.s, 0, 0, 1];
	const Ninv = [tl.s, 0, tl.cx, 0, tl.s, tl.cy, 0, 0, 1];
	let H = Hl0.slice();
	let a = 1;
	let b = 0;
	let sigma = 8;
	let visible = 0;
	let inliers = 0;
	let zncc = 0;
	let it = 0;
	let ok = false;
	const hist = new Uint32Array(512);
	const Hs = new Float64Array(36);
	const g = new Float64Array(8);
	const J = new Float64Array(8);
	const bil = (c: number, r: number): number => {
		const c0 = c | 0;
		const r0 = r | 0;
		const fx = c - c0;
		const fy = r - r0;
		const o = r0 * w + c0;
		const top = data[o]! + (data[o + 1]! - data[o]!) * fx;
		const bot = data[o + w]! + (data[o + w + 1]! - data[o + w]!) * fx;
		return top + (bot - top) * fy;
	};
	for (; it < maxIter; it++) {
		// 1. Sample the frame and its gradient (w.r.t. template px, through the warp's Jacobian) at the warped
		//    template positions.
		visible = 0;
		const h0 = H[0]!;
		const h1 = H[1]!;
		const h2 = H[2]!;
		const h3 = H[3]!;
		const h4 = H[4]!;
		const h5 = H[5]!;
		const h6 = H[6]!;
		const h7 = H[7]!;
		const h8 = H[8]!;
		for (let i = 0; i < n; i++) {
			const px = tl.x[i]!;
			const py = tl.y[i]!;
			const zw = h6 * px + h7 * py + h8;
			const X = (h0 * px + h1 * py + h2) / zw;
			const Y = (h3 * px + h4 * py + h5) / zw;
			const c = X - ox;
			const r = Y - oy;
			if (!(c >= 1 && r >= 1 && c < w - 2 && r < h - 2 && zw > 0)) {
				vis[i] = 0;
				continue;
			}
			if (hold) {
				const hx = Math.round(X * scale);
				const hy = Math.round(Y * scale);
				if (hx >= 0 && hy >= 0 && hx < hold.w && hy < hold.h && hold.data[hy * hold.w + hx]) {
					vis[i] = 0;
					continue;
				}
			}
			vals[i] = bil(c, r);
			const gX = 0.5 * (bil(c + 1, r) - bil(c - 1, r));
			const gY = 0.5 * (bil(c, r + 1) - bil(c, r - 1));
			const j11 = (h0 - X * h6) / zw;
			const j12 = (h1 - X * h7) / zw;
			const j21 = (h3 - Y * h6) / zw;
			const j22 = (h4 - Y * h7) / zw;
			fgx[i] = gX * j11 + gY * j21;
			fgy[i] = gX * j12 + gY * j22;
			vis[i] = 1;
			visible++;
		}
		if (visible < Math.max(24, 0.05 * n)) {
			ok = false;
			break;
		}
		// 2. Photometric fit I ≈ a·T + b with the previous weights.
		let sw = 0;
		let st = 0;
		let si = 0;
		let stt = 0;
		let sti = 0;
		let sii = 0;
		for (let i = 0; i < n; i++) {
			if (!vis[i]) continue;
			const wi = wts[i]!;
			const t = tl.t[i]!;
			const v = vals[i]!;
			sw += wi;
			st += wi * t;
			si += wi * v;
			stt += wi * t * t;
			sti += wi * t * v;
			sii += wi * v * v;
		}
		if (sw > 0) {
			const mt = st / sw;
			const mi = si / sw;
			const vt = stt / sw - mt * mt;
			const cti = sti / sw - mt * mi;
			const vi = sii / sw - mi * mi;
			if (vt > 1e-6) {
				a = Math.min(3, Math.max(0.33, cti / vt));
				b = mi - a * mt;
			}
			zncc = vt > 1e-6 && vi > 1e-6 ? Math.max(0, cti / Math.sqrt(vt * vi)) : 0;
		}
		// 3. Residuals (template units), robust scale (MAD from a 1/8-gray-level histogram) and Tukey weights.
		hist.fill(0);
		let cnt = 0;
		for (let i = 0; i < n; i++) {
			if (!vis[i]) continue;
			const r = (vals[i]! - b) / a - tl.t[i]!;
			vals[i] = r;
			hist[Math.min(511, Math.floor(Math.abs(r) * 8))]!++;
			cnt++;
		}
		let acc = 0;
		let med = 0;
		for (let k = 0; k < 512; k++) {
			acc += hist[k]!;
			if (acc * 2 >= cnt) {
				med = (k + 0.5) / 8;
				break;
			}
		}
		sigma = Math.max(1.5, 1.4826 * med);
		const cT = 4.685 * sigma;
		const cT2 = cT * cT;
		Hs.fill(0);
		g.fill(0);
		inliers = 0;
		const sa = tl.s / a;
		for (let i = 0; i < n; i++) {
			if (!vis[i]) continue;
			const r = vals[i]!;
			const r2 = r * r;
			if (r2 >= cT2) {
				wts[i] = 0;
				continue;
			}
			const uu = 1 - r2 / cT2;
			const wi = uu * uu;
			wts[i] = wi;
			if (wi > 0.5) inliers++;
			// ESM Jacobian: mean of the template's and the (photometrically normalised) frame's gradients.
			const tx = 0.5 * (tl.gx[i]! + fgx[i]! * sa);
			const ty = 0.5 * (tl.gy[i]! + fgy[i]! * sa);
			const u = (tl.x[i]! - tl.cx) / tl.s;
			const q = (tl.y[i]! - tl.cy) / tl.s;
			const d = tx * u + ty * q;
			J[0] = tx * u;
			J[1] = tx * q;
			J[2] = tx;
			J[3] = ty * u;
			J[4] = ty * q;
			J[5] = ty;
			J[6] = -u * d;
			J[7] = -q * d;
			let k = 0;
			for (let p = 0; p < 8; p++) {
				const wp = wi * J[p]!;
				g[p] = g[p]! + wp * r;
				for (let m = p; m < 8; m++) {
					Hs[k] = Hs[k]! + wp * J[m]!;
					k++;
				}
			}
		}
		if (inliers < Math.max(16, 0.03 * n)) {
			ok = false;
			break;
		}
		const sol = alignSolve8(Hs, g);
		if (!sol) {
			ok = false;
			break;
		}
		// 4. Forward compositional update: H ← H · N⁻¹ · W(Δp) · N with Δp = −(JᵀWJ)⁻¹ JᵀW r.
		const Wd = [1 - sol[0]!, -sol[1]!, -sol[2]!, -sol[3]!, 1 - sol[4]!, -sol[5]!, -sol[6]!, -sol[7]!, 1];
		const D = alignMul3(alignMul3(Ninv, Wd), N);
		H = alignMul3(H, D);
		ok = H.every(Number.isFinite);
		if (!ok) break;
		// Converged when the increment moves the template's spread points by < 0.01 level px.
		let move = 0;
		for (let c = 0; c < 4; c++) {
			const x = tl.cx + (c === 0 || c === 3 ? -tl.s : tl.s);
			const y = tl.cy + (c < 2 ? -tl.s : tl.s);
			const zw = D[6]! * x + D[7]! * y + D[8]!;
			move = Math.max(
				move,
				Math.hypot((D[0]! * x + D[1]! * y + D[2]!) / zw - x, (D[3]! * x + D[4]! * y + D[5]!) / zw - y),
			);
		}
		if (move < 0.01) {
			it++;
			break;
		}
	}
	return { H, visible, inliers, zncc, sigma, iterations: it, ok };
}

/** Row-major 3×3 product (not normalised). */
export function alignMul3(a: number[], b: number[]): number[] {
	const o = new Array<number>(9);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
	const s = Math.abs(o[8]!) > 1e-12 ? o[8]! : 1;
	return o.map((v) => v / s);
}

/** Homography in tracking px → level px (pyrDown convention: level px = tracking px / 2^level). */
export function alignToLevel(Ht: number[], level: number): number[] {
	const k = 2 ** level;
	return alignMul3(alignMul3([1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1], Ht), [k, 0, 0, 0, k, 0, 0, 0, 1]);
}

/** Homography in level px → tracking px. */
export function alignFromLevel(Hl: number[], level: number): number[] {
	const k = 2 ** level;
	return alignMul3(alignMul3([k, 0, 0, 0, k, 0, 0, 0, 1], Hl), [1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1]);
}

/**
 * Coarse-to-fine alignment of a template pyramid (`levels[k]` = level k, finest first; missing levels skipped) to a
 * frame pyramid (`images[k]` = level k), from `H0` (template tracking px → frame tracking px), starting at level
 * `startLevel`. `iters[k]` = iteration budget of level k.
 */
export function alignPyramid(
	levels: (AlignLevel | null)[],
	images: (AlignImage | null)[],
	H0: number[],
	startLevel: number,
	iters: number[],
	hold: { data: Uint8Array; w: number; h: number } | null,
): AlignResult {
	let H = H0.slice();
	let last: ReturnType<typeof alignLevel> | null = null;
	let total = 0;
	let iterations = 0;
	for (let L = Math.min(startLevel, levels.length - 1, images.length - 1); L >= 0; L--) {
		const tl = levels[L];
		const im = images[L];
		if (!tl || !im) continue;
		const r = alignLevel(tl, im, alignToLevel(H, L), iters[L] ?? 6, hold);
		iterations += r.iterations;
		if (!r.ok)
			return {
				ok: false,
				H: H0,
				visible: r.visible,
				inliers: r.inliers,
				total: tl.n,
				zncc: 0,
				sigma: r.sigma,
				iterations,
			};
		H = alignFromLevel(r.H, L);
		last = r;
		total = tl.n;
	}
	if (!last) return { ok: false, H: H0, visible: 0, inliers: 0, total: 0, zncc: 0, sigma: 0, iterations };
	return {
		ok: true,
		H,
		visible: last.visible,
		inliers: last.inliers,
		total,
		zncc: last.zncc,
		sigma: last.sigma,
		iterations,
	};
}
