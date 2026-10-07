// Matte utilities: exact Euclidean distance transforms (Felzenszwalb & Huttenlocher, "Distance Transforms of Sampled
// Functions", Theory of Computing 8, 2012), box and Gaussian filters, the colour guided filter (K. He, J. Sun and
// X. Tang, "Guided Image Filtering", ECCV 2010 / IEEE PAMI 2013) and closed-form matting (A. Levin, D. Lischinski and
// Y. Weiss, "A Closed-Form Solution to Natural Image Matting", IEEE PAMI 30(2), 2008) with the box-filter Laplacian of
// He, Sun and Tang ("Fast Matting Using Large Kernel Matting Laplacian Matrices", CVPR 2010). Ported from EffectCraft
// `crates/track/src/roto/matting.rs` (MIT OR Apache-2.0, licenses/ported/roto.md).
//
// Planes are Float32Array (w·h); colour images Float32Array RGB triples (straight colour, 0..1).

const BIG = 1e12;

/** 1-D squared distance transform of `f` (lower envelope of parabolas) into `d`. */
function dt1(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
	if (n === 0) return;
	const ff = (q: number) => f[q]! + q * q;
	let k = 0;
	v[0] = 0;
	z[0] = Number.NEGATIVE_INFINITY;
	z[1] = Number.POSITIVE_INFINITY;
	for (let q = 1; q < n; q++) {
		let s = (ff(q) - ff(v[k]!)) / (2 * (q - v[k]!));
		while (s <= z[k]!) {
			if (k === 0) break;
			k--;
			s = (ff(q) - ff(v[k]!)) / (2 * (q - v[k]!));
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Number.POSITIVE_INFINITY;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1]! < q) k++;
		const p = v[k]!;
		const dd = q - p;
		d[q] = dd * dd + f[p]!;
	}
}

/** Euclidean distance from every pixel to the nearest pixel where `seed` is set (1e6 when there is none). */
export function distance(seed: Uint8Array, w: number, h: number): Float32Array {
	const out = new Float32Array(w * h);
	if (w === 0 || h === 0) return out;
	const g = new Float64Array(w * h);
	for (let i = 0; i < w * h; i++) g[i] = seed[i] ? 0 : BIG;
	const m = Math.max(w, h);
	const f = new Float64Array(m);
	const d = new Float64Array(m);
	const v = new Int32Array(m);
	const z = new Float64Array(m + 1);
	// Columns.
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) f[y] = g[y * w + x]!;
		dt1(f, d, v, z, h);
		for (let y = 0; y < h; y++) g[y * w + x] = d[y]!;
	}
	// Rows.
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) f[x] = g[y * w + x]!;
		dt1(f, d, v, z, w);
		for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]!);
	}
	return out;
}

/** Signed distance to a binary matte's edge: positive inside (distance to the nearest background pixel − ½). */
export function signedDistance(m: Uint8Array, w: number, h: number): Float32Array {
	const n = w * h;
	const fg = new Uint8Array(n);
	const bg = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		if (m[i]) fg[i] = 1;
		else bg[i] = 1;
	}
	const din = distance(bg, w, h);
	const dout = distance(fg, w, h);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = m[i] ? din[i]! - 0.5 : 0.5 - dout[i]!;
	return out;
}

/** Mean over the (2r+1)² window (clamped at the edges: averages only the pixels inside). */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
	const out = new Float32Array(w * h);
	if (w === 0 || h === 0) return out;
	// Horizontal window sums per row.
	const tmp = new Float64Array(w * h);
	for (let y = 0; y < h; y++) {
		const o = y * w;
		let acc = 0;
		for (let x = 0; x < Math.min(r, w); x++) acc += src[o + x]!;
		for (let x = 0; x < w; x++) {
			if (x + r < w) acc += src[o + x + r]!;
			if (x > r) acc -= src[o + x - r - 1]!;
			tmp[o + x] = acc;
		}
	}
	// Vertical running sums.
	const col = new Float64Array(w);
	for (let y = 0; y < Math.min(r, h); y++) for (let x = 0; x < w; x++) col[x] = col[x]! + tmp[y * w + x]!;
	for (let y = 0; y < h; y++) {
		if (y + r < h) for (let x = 0; x < w; x++) col[x] = col[x]! + tmp[(y + r) * w + x]!;
		if (y > r) for (let x = 0; x < w; x++) col[x] = col[x]! - tmp[(y - r - 1) * w + x]!;
		const cy = Math.min(y + r + 1, h) - Math.max(y - r, 0);
		for (let x = 0; x < w; x++) {
			const cx = Math.min(x + r + 1, w) - Math.max(x - r, 0);
			out[y * w + x] = col[x]! / (cx * cy);
		}
	}
	return out;
}

/** Approximate Gaussian blur (three box passes) with standard deviation `sigma` pixels. */
export function gauss(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
	if (!(sigma >= 0.3)) return src.slice();
	const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
	return boxMean(boxMean(boxMean(src, w, h, r), w, h, r), w, h, r);
}

function inv3f(m: readonly number[]): number[] {
	let d =
		m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
		m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
		m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
	if (Math.abs(d) < 1e-20) d = 1e-20;
	return [
		(m[4]! * m[8]! - m[5]! * m[7]!) / d,
		(m[2]! * m[7]! - m[1]! * m[8]!) / d,
		(m[1]! * m[5]! - m[2]! * m[4]!) / d,
		(m[5]! * m[6]! - m[3]! * m[8]!) / d,
		(m[0]! * m[8]! - m[2]! * m[6]!) / d,
		(m[2]! * m[3]! - m[0]! * m[5]!) / d,
		(m[3]! * m[7]! - m[4]! * m[6]!) / d,
		(m[1]! * m[6]! - m[0]! * m[7]!) / d,
		(m[0]! * m[4]! - m[1]! * m[3]!) / d,
	];
}

function channel(img: Float32Array, n: number, c: number): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = img[i * 3 + c]!;
	return out;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i]! * b[i]!;
	return out;
}

/** The colour guided filter of `p` with guide `img` (RGB), window radius `r`, regularisation `eps` (He et al. §3.5). */
export function guidedFilter(
	img: Float32Array,
	p: Float32Array,
	w: number,
	h: number,
	r: number,
	eps: number,
): Float32Array {
	const n = w * h;
	const ir = channel(img, n, 0);
	const ig = channel(img, n, 1);
	const ib = channel(img, n, 2);
	const bm = (v: Float32Array) => boxMean(v, w, h, r);
	const mr = bm(ir);
	const mg = bm(ig);
	const mb = bm(ib);
	const mp = bm(p);
	const mrp = bm(mul(ir, p));
	const mgp = bm(mul(ig, p));
	const mbp = bm(mul(ib, p));
	const vrr = bm(mul(ir, ir));
	const vrg = bm(mul(ir, ig));
	const vrb = bm(mul(ir, ib));
	const vgg = bm(mul(ig, ig));
	const vgb = bm(mul(ig, ib));
	const vbb = bm(mul(ib, ib));
	const a0 = new Float32Array(n);
	const a1 = new Float32Array(n);
	const a2 = new Float32Array(n);
	const bb = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const c0 = mrp[i]! - mr[i]! * mp[i]!;
		const c1 = mgp[i]! - mg[i]! * mp[i]!;
		const c2 = mbp[i]! - mb[i]! * mp[i]!;
		const sRG = vrg[i]! - mr[i]! * mg[i]!;
		const sRB = vrb[i]! - mr[i]! * mb[i]!;
		const sGB = vgb[i]! - mg[i]! * mb[i]!;
		const inv = inv3f([
			vrr[i]! - mr[i]! * mr[i]! + eps,
			sRG,
			sRB,
			sRG,
			vgg[i]! - mg[i]! * mg[i]! + eps,
			sGB,
			sRB,
			sGB,
			vbb[i]! - mb[i]! * mb[i]! + eps,
		]);
		const x = c0 * inv[0]! + c1 * inv[3]! + c2 * inv[6]!;
		const y = c0 * inv[1]! + c1 * inv[4]! + c2 * inv[7]!;
		const z = c0 * inv[2]! + c1 * inv[5]! + c2 * inv[8]!;
		a0[i] = x;
		a1[i] = y;
		a2[i] = z;
		bb[i] = mp[i]! - x * mr[i]! - y * mg[i]! - z * mb[i]!;
	}
	const ma0 = bm(a0);
	const ma1 = bm(a1);
	const ma2 = bm(a2);
	const mbb = bm(bb);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = ma0[i]! * ir[i]! + ma1[i]! * ig[i]! + ma2[i]! * ib[i]! + mbb[i]!;
	return out;
}

/**
 * Closed-form matting: the alpha minimising αᵀLα with the matting Laplacian L of the colour image, `known` pixels
 * fixed to `init`; conjugate gradients over the unknown pixels starting from `init`, L·x with box filters:
 * `(L·x)ᵢ = |ωᵢ|·(xᵢ − āᵢᵀIᵢ − b̄ᵢ)` with (a_k, b_k) the ridge-regression fit of x to the colours of window k.
 */
export function closedForm(
	img: Float32Array,
	init: Float32Array,
	known: Uint8Array,
	w: number,
	h: number,
	r: number,
	eps: number,
	iters: number,
): Float32Array {
	const n = w * h;
	let unknown = 0;
	for (let i = 0; i < n; i++) if (!known[i]) unknown++;
	if (n === 0 || unknown === 0) return init.slice();
	const ic = [channel(img, n, 0), channel(img, n, 1), channel(img, n, 2)];
	const bm = (v: Float32Array) => boxMean(v, w, h, r);
	const mu = ic.map(bm);
	const cov: Float32Array[][] = [[], [], []];
	for (let a = 0; a < 3; a++)
		for (let b = a; b < 3; b++) {
			const m = bm(mul(ic[a]!, ic[b]!));
			cov[a]![b] = m;
			cov[b]![a] = m;
		}
	const inv = new Float32Array(n * 9);
	const s = new Array<number>(9);
	for (let i = 0; i < n; i++) {
		for (let a = 0; a < 3; a++)
			for (let b = 0; b < 3; b++)
				s[a * 3 + b] = cov[a]![b]![i]! - mu[a]![i]! * mu[b]![i]! + (a === b ? eps : 0);
		const m = inv3f(s);
		for (let k = 0; k < 9; k++) inv[i * 9 + k] = m[k]!;
	}
	const cnt = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const x = i % w;
		const y = (i / w) | 0;
		const cx = Math.min(x + r, w - 1) - Math.max(x - r, 0) + 1;
		const cy = Math.min(y + r, h - 1) - Math.max(y - r, 0) + 1;
		cnt[i] = cx * cy;
	}
	const A0 = new Float32Array(n);
	const A1 = new Float32Array(n);
	const A2 = new Float32Array(n);
	const B = new Float32Array(n);
	const lap = (x: Float32Array): Float32Array => {
		const pm = bm(x);
		const ipm = [bm(mul(ic[0]!, x)), bm(mul(ic[1]!, x)), bm(mul(ic[2]!, x))];
		for (let i = 0; i < n; i++) {
			const c0 = ipm[0]![i]! - mu[0]![i]! * pm[i]!;
			const c1 = ipm[1]![i]! - mu[1]![i]! * pm[i]!;
			const c2 = ipm[2]![i]! - mu[2]![i]! * pm[i]!;
			const o = i * 9;
			const a0 = inv[o]! * c0 + inv[o + 1]! * c1 + inv[o + 2]! * c2;
			const a1 = inv[o + 3]! * c0 + inv[o + 4]! * c1 + inv[o + 5]! * c2;
			const a2 = inv[o + 6]! * c0 + inv[o + 7]! * c1 + inv[o + 8]! * c2;
			A0[i] = a0;
			A1[i] = a1;
			A2[i] = a2;
			B[i] = pm[i]! - a0 * mu[0]![i]! - a1 * mu[1]![i]! - a2 * mu[2]![i]!;
		}
		const s0 = bm(A0);
		const s1 = bm(A1);
		const s2 = bm(A2);
		const sb = bm(B);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++)
			out[i] = cnt[i]! * (x[i]! - s0[i]! * ic[0]![i]! - s1[i]! * ic[1]![i]! - s2[i]! * ic[2]![i]! - sb[i]!);
		return out;
	};
	// L_UU x = −(L α_K)_U.
	const ak = new Float32Array(n);
	for (let i = 0; i < n; i++) if (known[i]) ak[i] = init[i]!;
	const la0 = lap(ak);
	const x = new Float32Array(n);
	for (let i = 0; i < n; i++) if (!known[i]) x[i] = init[i]!;
	const lx = lap(x);
	const res = new Float64Array(n);
	for (let i = 0; i < n; i++) if (!known[i]) res[i] = -la0[i]! - lx[i]!;
	const p = Float64Array.from(res);
	let rs = 0;
	for (let i = 0; i < n; i++) rs += res[i]! * res[i]!;
	const rs0 = Math.max(rs, 1e-30);
	const pf = new Float32Array(n);
	for (let it = 0; it < iters; it++) {
		if (rs <= rs0 * 1e-8) break;
		for (let i = 0; i < n; i++) pf[i] = p[i]!;
		const ap = lap(pf);
		let pap = 0;
		for (let i = 0; i < n; i++) if (!known[i]) pap += p[i]! * ap[i]!;
		if (pap <= 1e-30) break;
		const alpha = rs / pap;
		let rsNew = 0;
		for (let i = 0; i < n; i++) {
			if (known[i]) continue;
			x[i] = x[i]! + alpha * p[i]!;
			res[i] = res[i]! - alpha * ap[i]!;
			rsNew += res[i]! * res[i]!;
		}
		const beta = rsNew / rs;
		rs = rsNew;
		for (let i = 0; i < n; i++) p[i] = res[i]! + beta * p[i]!;
	}
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = known[i] ? init[i]! : Math.min(1, Math.max(0, x[i]!));
	return out;
}

/** Samples a plane bilinearly at continuous coordinates (pixel centres at +0.5), clamped. */
export function sample(p: Float32Array, w: number, h: number, x: number, y: number): number {
	if (w === 0 || h === 0) return 0;
	const fx = Math.min(w - 1, Math.max(0, x - 0.5));
	const fy = Math.min(h - 1, Math.max(0, y - 0.5));
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(x0 + 1, w - 1);
	const y1 = Math.min(y0 + 1, h - 1);
	const tx = fx - x0;
	const ty = fy - y0;
	const top = p[y0 * w + x0]! + (p[y0 * w + x1]! - p[y0 * w + x0]!) * tx;
	const bot = p[y1 * w + x0]! + (p[y1 * w + x1]! - p[y1 * w + x0]!) * tx;
	return top + (bot - top) * ty;
}
