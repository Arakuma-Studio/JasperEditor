// Warp Stabilizer maths (docs/wp-notes/gaps.md §FX-6): 3×3 homographies, least-squares motion fits,
// small dense / banded solvers and a symmetric eigensolver. Ported from effectcraft `crates/track/src/{solve,fit}.rs`
// and `camtrack/linalg.rs` (MIT OR Apache-2.0, see licenses/ported/gaps.md); the banded Cholesky and the warm-started
// subspace iteration are ours (the JS budget of a live effect).

/** Row-major 3×3 matrix (h[8] = 1 after `hNorm`). Maps source → destination: `hApply(h, p)`. */
export type H3 = readonly number[];
export type P2 = readonly [number, number];

export const H_IDENTITY: H3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function hApply(m: H3, p: P2): [number, number] {
	let w = m[6]! * p[0] + m[7]! * p[1] + m[8]!;
	if (Math.abs(w) < 1e-12) w = 1e-12;
	return [(m[0]! * p[0] + m[1]! * p[1] + m[2]!) / w, (m[3]! * p[0] + m[4]! * p[1] + m[5]!) / w];
}

/** Scale so that h33 = 1 (when it isn't ≈ 0). */
export function hNorm(m: H3): number[] {
	const s = m[8]!;
	if (Math.abs(s) < 1e-12 || s === 1) return m.slice();
	return m.map((v) => v / s);
}

/** `a ∘ b` (apply `b` first), normalised. */
export function hMul(a: H3, b: H3): number[] {
	const o = new Array<number>(9);
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
	return hNorm(o);
}

/** The inverse map, or null when singular. */
export function hInv(m: H3): number[] | null {
	const c00 = m[4]! * m[8]! - m[5]! * m[7]!;
	const c01 = m[5]! * m[6]! - m[3]! * m[8]!;
	const c02 = m[3]! * m[7]! - m[4]! * m[6]!;
	const det = m[0]! * c00 + m[1]! * c01 + m[2]! * c02;
	if (Math.abs(det) < 1e-18 || !Number.isFinite(det)) return null;
	const inv = [
		c00,
		m[2]! * m[7]! - m[1]! * m[8]!,
		m[1]! * m[5]! - m[2]! * m[4]!,
		c01,
		m[0]! * m[8]! - m[2]! * m[6]!,
		m[2]! * m[3]! - m[0]! * m[5]!,
		c02,
		m[1]! * m[6]! - m[0]! * m[7]!,
		m[0]! * m[4]! - m[1]! * m[3]!,
	];
	return hNorm(inv.map((v) => v / det));
}

export const hTranslation = (t: P2): number[] => [1, 0, t[0], 0, 1, t[1], 0, 0, 1];
/** Uniform scale `k` about `c`. */
export const hScaleAbout = (k: number, c: P2): number[] => [
	k,
	0,
	c[0] * (1 - k),
	0,
	k,
	c[1] * (1 - k),
	0,
	0,
	1,
];

/** `(1 − t)·a + t·b` element-wise (both normalised). */
export function hLerp(a: H3, b: H3, t: number): number[] {
	const x = hNorm(a);
	const y = hNorm(b);
	return x.map((v, i) => v + (y[i]! - v) * t);
}

export function hMaxDiff(a: H3, b: H3): number {
	const x = hNorm(a);
	const y = hNorm(b);
	let d = 0;
	for (let i = 0; i < 9; i++) d = Math.max(d, Math.abs(x[i]! - y[i]!));
	return d;
}

/** Gaussian elimination with partial pivoting (small systems); null when singular. */
export function solveLinear(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	const m = a.map((r) => r.slice());
	const x = b.slice();
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
		if (Math.abs(m[p]![c]!) < 1e-14) return null;
		[m[c], m[p]] = [m[p]!, m[c]!];
		[x[c], x[p]] = [x[p]!, x[c]!];
		for (let r = c + 1; r < n; r++) {
			const f = m[r]![c]! / m[c]![c]!;
			if (f === 0) continue;
			for (let k = c; k < n; k++) m[r]![k]! -= f * m[c]![k]!;
			x[r]! -= f * x[c]!;
		}
	}
	for (let r = n - 1; r >= 0; r--) {
		let s = x[r]!;
		for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!;
		x[r] = s / m[r]![r]!;
	}
	return x.every(Number.isFinite) ? x : null;
}

export type MotionModel = 'translation' | 'similarity' | 'homography';

function centroid(p: readonly P2[]): [number, number] {
	const n = Math.max(1, p.length);
	let x = 0;
	let y = 0;
	for (const q of p) {
		x += q[0];
		y += q[1];
	}
	return [x / n, y / n];
}

/** Least-squares fit of `model` taking `src` to `dst`; null when degenerate. */
export function leastSquares(model: MotionModel, src: readonly P2[], dst: readonly P2[]): number[] | null {
	const n = Math.min(src.length, dst.length);
	const min = model === 'translation' ? 1 : model === 'similarity' ? 2 : 4;
	if (n < min) return null;
	const s = src.slice(0, n);
	const d = dst.slice(0, n);
	const cs = centroid(s);
	const cd = centroid(d);
	let h: number[];
	if (model === 'translation') h = hTranslation([cd[0] - cs[0], cd[1] - cs[1]]);
	else if (model === 'similarity') {
		let ss = 0;
		let dot = 0;
		let cross = 0;
		for (let i = 0; i < n; i++) {
			const ax = s[i]![0] - cs[0];
			const ay = s[i]![1] - cs[1];
			const bx = d[i]![0] - cd[0];
			const by = d[i]![1] - cd[1];
			ss += ax * ax + ay * ay;
			dot += ax * bx + ay * by;
			cross += ax * by - ay * bx;
		}
		if (ss < 1e-12) return null;
		const a = dot / ss;
		const b = cross / ss;
		if (Math.hypot(a, b) < 1e-9) return null;
		h = [a, -b, cd[0] - (a * cs[0] - b * cs[1]), b, a, cd[1] - (b * cs[0] + a * cs[1]), 0, 0, 1];
	} else {
		// Normalised DLT with h33 = 1 (normal equations).
		const norm = (p: readonly P2[], c: P2) => {
			let t = 0;
			for (const q of p) t += Math.hypot(q[0] - c[0], q[1] - c[1]);
			t /= p.length;
			return t > 1e-12 ? Math.SQRT2 / t : 1;
		};
		const ks = norm(s, cs);
		const kd = norm(d, cd);
		const A = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
		const B = new Array<number>(8).fill(0);
		for (let i = 0; i < n; i++) {
			const x = (s[i]![0] - cs[0]) * ks;
			const y = (s[i]![1] - cs[1]) * ks;
			const u = (d[i]![0] - cd[0]) * kd;
			const v = (d[i]![1] - cd[1]) * kd;
			const rows: [number[], number][] = [
				[[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
				[[0, 0, 0, x, y, 1, -v * x, -v * y], v],
			];
			for (const [r, t] of rows)
				for (let a = 0; a < 8; a++) {
					B[a]! += r[a]! * t;
					for (let b = 0; b < 8; b++) A[a]![b]! += r[a]! * r[b]!;
				}
		}
		const x = solveLinear(A, B);
		if (!x) return null;
		const hn = [...x, 1];
		const ts = [ks, 0, -ks * cs[0], 0, ks, -ks * cs[1], 0, 0, 1];
		const tdInv = [1 / kd, 0, cd[0], 0, 1 / kd, cd[1], 0, 0, 1];
		const raw = hMul(tdInv, hMul(hn, ts));
		h = raw;
	}
	return h.every(Number.isFinite) ? h : null;
}

/**
 * A symmetric banded matrix in LOWER band storage: entry (i, j), j ≤ i ≤ j + band, at `data[i * (band + 1) + (i - j)]`.
 */
export class BandMatrix {
	readonly data: Float64Array;
	readonly w: number;
	constructor(
		readonly n: number,
		readonly band: number,
	) {
		this.w = band + 1;
		this.data = new Float64Array(n * this.w);
	}
	/** Adds `v` at (i, j) (and implicitly (j, i)); entries outside the band are an error. */
	add(i: number, j: number, v: number): void {
		const r = i >= j ? i : j;
		const d = i >= j ? i - j : j - i;
		if (d > this.band) throw new Error('BandMatrix: entry outside the band');
		this.data[r * this.w + d]! += v;
	}
	clone(): BandMatrix {
		const m = new BandMatrix(this.n, this.band);
		m.data.set(this.data);
		return m;
	}
}

/**
 * Solves `A x = b` for a symmetric positive definite banded `A` in place (Cholesky in band storage, O(n·band²)).
 * Returns false when `A` is not positive definite.
 */
export function bandedCholeskySolve(A: BandMatrix, b: Float64Array): boolean {
	const { n, band, w, data: a } = A;
	const at = (i: number, j: number) => i * w + (i - j);
	for (let j = 0; j < n; j++) {
		const k0 = Math.max(0, j - band);
		let d = a[at(j, j)]!;
		for (let k = k0; k < j; k++) d -= a[at(j, k)]! ** 2;
		if (!(d > 0) || !Number.isFinite(d)) return false;
		d = Math.sqrt(d);
		a[at(j, j)] = d;
		const iMax = Math.min(n - 1, j + band);
		for (let i = j + 1; i <= iMax; i++) {
			let s = a[at(i, j)]!;
			for (let k = Math.max(k0, i - band); k < j; k++) s -= a[at(i, k)]! * a[at(j, k)]!;
			a[at(i, j)] = s / d;
		}
	}
	for (let i = 0; i < n; i++) {
		let s = b[i]!;
		for (let k = Math.max(0, i - band); k < i; k++) s -= a[at(i, k)]! * b[k]!;
		b[i] = s / a[at(i, i)]!;
	}
	for (let i = n - 1; i >= 0; i--) {
		let s = b[i]!;
		const kMax = Math.min(n - 1, i + band);
		for (let k = i + 1; k <= kMax; k++) s -= a[at(k, i)]! * b[k]!;
		b[i] = s / a[at(i, i)]!;
	}
	for (let i = 0; i < n; i++) if (!Number.isFinite(b[i]!)) return false;
	return true;
}

/** Dense Cholesky solve of a small `n × n` row-major SPD system. */
export function choleskySolve(a: Float64Array, n: number, b: Float64Array): boolean {
	const m = new BandMatrix(n, Math.max(0, n - 1));
	for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) m.data[i * m.w + (i - j)] = a[i * n + j]!;
	return bandedCholeskySolve(m, b);
}

/**
 * The top `k` eigenvectors of the symmetric PSD `n × n` matrix `g` (row-major) by orthogonal (subspace) iteration,
 * warm-started from `start` (k vectors of length n, e.g. the previous window's basis): rows of the result, largest
 * eigenvalue first. Converges in a few steps when the start is close (sliding windows).
 */
export function topEigenvectors(
	g: Float64Array,
	n: number,
	k: number,
	start: number[][] | null,
	iters = 40,
): number[][] {
	let q: number[][] = [];
	for (let i = 0; i < k; i++) {
		const s = start?.[i];
		if (s && s.length === n) q.push(s.slice());
		else
			q.push(Array.from({ length: n }, (_, j) => (j === i ? 1 : 0) + 0.01 * Math.sin(1 + i * 7.3 + j * 1.7)));
	}
	const orth = (vs: number[][]) => {
		for (let i = 0; i < vs.length; i++) {
			const v = vs[i]!;
			// Modified Gram–Schmidt, twice ("twice is enough": the eigenvalues span many decades).
			for (let pass = 0; pass < 2; pass++)
				for (let j = 0; j < i; j++) {
					const u = vs[j]!;
					let d = 0;
					for (let t = 0; t < n; t++) d += v[t]! * u[t]!;
					for (let t = 0; t < n; t++) v[t]! -= d * u[t]!;
				}
			let l = 0;
			for (let t = 0; t < n; t++) l += v[t]! * v[t]!;
			l = Math.sqrt(l);
			if (l < 1e-300) {
				for (let t = 0; t < n; t++) v[t] = t === i ? 1 : 0;
				continue;
			}
			for (let t = 0; t < n; t++) v[t]! /= l;
		}
	};
	orth(q);
	let prevRayleigh = Number.NaN;
	for (let it = 0; it < iters; it++) {
		const z = q.map((v) => {
			const o = new Array<number>(n).fill(0);
			for (let r = 0; r < n; r++) {
				let s = 0;
				for (let c = 0; c < n; c++) s += g[r * n + c]! * v[c]!;
				o[r] = s;
			}
			return o;
		});
		// Rayleigh quotients (for ordering and the stopping test).
		let ray = 0;
		for (let i = 0; i < k; i++) for (let t = 0; t < n; t++) ray += q[i]![t]! * z[i]![t]!;
		orth(z);
		q = z;
		if (Math.abs(ray - prevRayleigh) <= 1e-10 * Math.abs(ray)) break;
		prevRayleigh = ray;
	}
	// Order by Rayleigh quotient (largest first).
	const rq = q.map((v) => {
		let s = 0;
		for (let r = 0; r < n; r++) {
			let t = 0;
			for (let c = 0; c < n; c++) t += g[r * n + c]! * v[c]!;
			s += v[r]! * t;
		}
		return s;
	});
	return q
		.map((v, i) => ({ v, r: rq[i]! }))
		.sort((a, b) => b.r - a.r)
		.map((e) => e.v);
}
