// Gaussian mixture colour models (full 3 × 3 covariances), as used by GrabCut (C. Rother, V. Kolmogorov and A. Blake,
// "GrabCut: Interactive Foreground Extraction using Iterated Graph Cuts", SIGGRAPH 2004). Ported from EffectCraft
// `crates/track/src/roto/gmm.rs` (MIT OR Apache-2.0, licenses/ported/roto.md).
//
// Fitting is deterministic: components are initialised by recursive splitting of the cluster with the largest
// variance along its principal axis (Orchard & Bouman, "Color Quantization of Images", IEEE TSP 1991), then refined
// by a few hard-assignment EM iterations. Colours are straight RGB in 0..1, packed as Float32Array triples.

/** One Gaussian: weight, mean, inverse covariance (row-major 9) and −log(weight) + ½·log(det Σ). */
export type Gauss = { weight: number; mean: [number, number, number]; inv: number[]; logNorm: number };
export type Gmm = { comps: Gauss[] };

/** Regularisation added to every covariance's diagonal (colour noise floor). */
const REG = 2e-4;

function det3(m: readonly number[]): number {
	return (
		m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
		m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
		m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
	);
}

function inv3(m: readonly number[]): number[] | null {
	const d = det3(m);
	if (Math.abs(d) < 1e-30) return null;
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

/** Sufficient statistics of a cluster. */
class Stats {
	n = 0;
	s = [0, 0, 0];
	ss = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	add(r: number, g: number, b: number): void {
		this.n++;
		const c = [r, g, b];
		for (let i = 0; i < 3; i++) {
			this.s[i] = this.s[i]! + c[i]!;
			for (let j = 0; j < 3; j++) this.ss[i * 3 + j] = this.ss[i * 3 + j]! + c[i]! * c[j]!;
		}
	}
	mean(): [number, number, number] {
		const n = Math.max(1, this.n);
		return [this.s[0]! / n, this.s[1]! / n, this.s[2]! / n];
	}
	cov(): number[] {
		const n = Math.max(1, this.n);
		const m = this.mean();
		const c = new Array<number>(9);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) c[i * 3 + j] = this.ss[i * 3 + j]! / n - m[i]! * m[j]!;
			c[i * 3 + i] = c[i * 3 + i]! + REG;
		}
		return c;
	}
}

/** Principal eigenvector and eigenvalue of a symmetric 3 × 3 matrix (power iteration). */
function principal(c: readonly number[]): { v: [number, number, number]; lambda: number } {
	let v: [number, number, number] = [0.577, 0.577, 0.577];
	let lambda = 0;
	for (let it = 0; it < 40; it++) {
		const w = [
			c[0]! * v[0] + c[1]! * v[1] + c[2]! * v[2],
			c[3]! * v[0] + c[4]! * v[1] + c[5]! * v[2],
			c[6]! * v[0] + c[7]! * v[1] + c[8]! * v[2],
		];
		const n = Math.hypot(w[0]!, w[1]!, w[2]!);
		if (n < 1e-30) break;
		lambda = n;
		v = [w[0]! / n, w[1]! / n, w[2]! / n];
	}
	return { v, lambda };
}

function fromLabels(xs: Float32Array, label: Int32Array, k: number): Gmm {
	const st = Array.from({ length: k }, () => new Stats());
	const n = label.length;
	for (let i = 0; i < n; i++) st[label[i]!]!.add(xs[i * 3]!, xs[i * 3 + 1]!, xs[i * 3 + 2]!);
	let total = 0;
	for (const s of st) total += s.n;
	total = Math.max(1, total);
	const comps: Gauss[] = [];
	for (const s of st) {
		if (s.n < 1) continue;
		const c = s.cov();
		const inv = inv3(c);
		if (!inv) continue;
		const det = Math.max(det3(c), 1e-300);
		const weight = s.n / total;
		comps.push({ weight, mean: s.mean(), inv, logNorm: -Math.log(weight) + 0.5 * Math.log(det) });
	}
	return { comps };
}

function compCost(g: Gauss, r: number, gr: number, b: number): number {
	const d0 = r - g.mean[0];
	const d1 = gr - g.mean[1];
	const d2 = b - g.mean[2];
	const m = g.inv;
	const q =
		d0 * (m[0]! * d0 + m[1]! * d1 + m[2]! * d2) +
		d1 * (m[3]! * d0 + m[4]! * d1 + m[5]! * d2) +
		d2 * (m[6]! * d0 + m[7]! * d1 + m[8]! * d2);
	return g.logNorm + 0.5 * q;
}

/** The most likely component of a colour. */
function gmmBest(g: Gmm, r: number, gr: number, b: number): number {
	let best = 0;
	let bv = Number.POSITIVE_INFINITY;
	for (let i = 0; i < g.comps.length; i++) {
		const v = compCost(g.comps[i]!, r, gr, b);
		if (v < bv) {
			bv = v;
			best = i;
		}
	}
	return best;
}

/** −log p(c) (up to a constant shared by all models), clamped to a finite range. */
export function gmmCost(g: Gmm, r: number, gr: number, b: number): number {
	const n = Math.min(16, g.comps.length);
	if (n === 0) return 10;
	let m = Number.POSITIVE_INFINITY;
	const costs = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		costs[i] = compCost(g.comps[i]!, r, gr, b);
		if (costs[i]! < m) m = costs[i]!;
	}
	let s = 0;
	for (let i = 0; i < n; i++) s += Math.exp(m - costs[i]!);
	return Math.min(60, Math.max(-20, m - Math.log(s)));
}

/**
 * Fits `k` components to `samples` (RGB triples; at most `maxSamples` are used, taken at a fixed stride).
 */
export function gmmFit(samples: Float32Array, k: number, maxSamples: number): Gmm {
	const count = Math.floor(samples.length / 3);
	if (count === 0) return { comps: [] };
	const stride = Math.max(1, Math.ceil(count / Math.max(1, maxSamples)));
	const n = Math.ceil(count / stride);
	const xs = new Float32Array(n * 3);
	for (let i = 0, j = 0; i < count; i += stride, j++) {
		xs[j * 3] = samples[i * 3]!;
		xs[j * 3 + 1] = samples[i * 3 + 1]!;
		xs[j * 3 + 2] = samples[i * 3 + 2]!;
	}
	// Orchard–Bouman splitting.
	const label = new Int32Array(n);
	let ncl = 1;
	while (ncl < k) {
		const st = Array.from({ length: ncl }, () => new Stats());
		for (let i = 0; i < n; i++) st[label[i]!]!.add(xs[i * 3]!, xs[i * 3 + 1]!, xs[i * 3 + 2]!);
		let best = -1;
		let bestL = 0;
		let axis: [number, number, number] = [0, 0, 0];
		for (let c = 0; c < ncl; c++) {
			const s = st[c]!;
			if (s.n < 2) continue;
			const { v, lambda } = principal(s.cov());
			if (lambda > bestL) {
				best = c;
				bestL = lambda;
				axis = v;
			}
		}
		if (best < 0 || bestL <= REG * 1.01) break;
		const m = st[best]!.mean();
		const thr = axis[0] * m[0] + axis[1] * m[1] + axis[2] * m[2];
		for (let i = 0; i < n; i++) {
			if (
				label[i] === best &&
				axis[0] * xs[i * 3]! + axis[1] * xs[i * 3 + 1]! + axis[2] * xs[i * 3 + 2]! > thr
			)
				label[i] = ncl;
		}
		ncl++;
	}
	let g = fromLabels(xs, label, ncl);
	// Hard EM.
	for (let it = 0; it < 3; it++) {
		for (let i = 0; i < n; i++) label[i] = gmmBest(g, xs[i * 3]!, xs[i * 3 + 1]!, xs[i * 3 + 2]!);
		const ng = fromLabels(xs, label, g.comps.length);
		if (ng.comps.length === 0) break;
		g = ng;
	}
	return g;
}
