// Small dense linear algebra for the camera solver (3D Camera Tracker). Port of EffectCraft
// `crates/track/src/camtrack/linalg.rs` (MIT OR Apache-2.0; licenses/ported/three-d.md), from the textbook methods:
// 3-vectors / 3×3 matrices and rotations (Rodrigues' formula and its inverse); the one-sided Jacobi SVD (Hestenes 1958;
// Golub & Van Loan §8.6.4); the cyclic Jacobi eigenvalue method (Golub & Van Loan §8.5); Cholesky for the bundle
// adjustment's normal equations; the closed-form similarity alignment of two point sets (Umeyama, PAMI 1991).

export type V3 = [number, number, number];
export type M3 = [V3, V3, V3];

export const I3 = (): M3 => [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3): number => Math.sqrt(dot(a, a));
export function normalize(a: V3): V3 {
	const n = norm(a);
	return n > 0 ? scale(a, 1 / n) : a;
}
export const mv = (m: M3, v: V3): V3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
/** `mᵀ v`. */
export const mtv = (m: M3, v: V3): V3 => [
	m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
	m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
	m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
];
export function mm(a: M3, b: M3): M3 {
	const o: M3 = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++) o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
	return o;
}
export const mt = (a: M3): M3 => [
	[a[0][0], a[1][0], a[2][0]],
	[a[0][1], a[1][1], a[2][1]],
	[a[0][2], a[1][2], a[2][2]],
];
export function madd(a: M3, b: M3, k: number): M3 {
	return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![j]! + k * b[i]![j]!)) as M3;
}
export const mscale = (a: M3, k: number): M3 => a.map((r) => r.map((x) => x * k)) as M3;
export const det3 = (m: M3): number =>
	m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
	m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
	m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
export const skew = (v: V3): M3 => [
	[0, -v[2], v[1]],
	[v[2], 0, -v[0]],
	[-v[1], v[0], 0],
];
export const outer = (a: V3, b: V3): M3 => [
	[a[0] * b[0], a[0] * b[1], a[0] * b[2]],
	[a[1] * b[0], a[1] * b[1], a[1] * b[2]],
	[a[2] * b[0], a[2] * b[1], a[2] * b[2]],
];
export const col = (m: M3, j: number): V3 => [m[0][j], m[1][j], m[2][j]];
export const fromCols = (a: V3, b: V3, c: V3): M3 => [
	[a[0], b[0], c[0]],
	[a[1], b[1], c[1]],
	[a[2], b[2], c[2]],
];
export function inv3(m: M3): M3 | null {
	const d = det3(m);
	if (!(Math.abs(d) >= 1e-300)) return null;
	const c = (r0: number, c0: number, r1: number, c1: number) =>
		m[r0]![c0]! * m[r1]![c1]! - m[r0]![c1]! * m[r1]![c0]!;
	const adj: M3 = [
		[c(1, 1, 2, 2), -c(0, 1, 2, 2), c(0, 1, 1, 2)],
		[-c(1, 0, 2, 2), c(0, 0, 2, 2), -c(0, 0, 1, 2)],
		[c(1, 0, 2, 1), -c(0, 0, 2, 1), c(0, 0, 1, 1)],
	];
	return mscale(adj, 1 / d);
}

/** Rotation matrix of an axis-angle vector (Rodrigues' formula). */
export function rodrigues(w: V3): M3 {
	const th = norm(w);
	const k = skew(w);
	if (th < 1e-12) return madd(I3(), k, 1);
	const a = Math.sin(th) / th;
	const b = (1 - Math.cos(th)) / (th * th);
	return madd(madd(I3(), k, a), mm(k, k), b);
}

/** Axis-angle vector of a rotation matrix (inverse of `rodrigues`). */
export function logRot(r: M3): V3 {
	const c = Math.min(1, Math.max(-1, (r[0][0] + r[1][1] + r[2][2] - 1) * 0.5));
	const th = Math.acos(c);
	const v: V3 = [r[2][1] - r[1][2], r[0][2] - r[2][0], r[1][0] - r[0][1]];
	if (th < 1e-9) return scale(v, 0.5);
	if (Math.PI - th < 1e-6) {
		const b = madd(r, I3(), 1);
		let j = 0;
		for (let a = 1; a < 3; a++) if (b[a]![a]! > b[j]![j]!) j = a;
		return scale(normalize(col(b, j)), th);
	}
	return scale(v, th / (2 * Math.sin(th)));
}

/** The rotation closest to `m` (Frobenius norm), via the SVD. */
export function nearestRotation(m: M3): M3 {
	const { u, v } = svd3(m);
	let r = mm(u, mt(v));
	if (det3(r) < 0) {
		const u2 = u.map((row) => [row[0], row[1], -row[2]]) as M3;
		r = mm(u2, mt(v));
	}
	return r;
}

/** Spherical interpolation between two rotations. */
export function slerpRot(a: M3, b: M3, t: number): M3 {
	const d = logRot(mm(b, mt(a)));
	return mm(rodrigues(scale(d, t)), a);
}

/**
 * Thin SVD `A = U diag(s) Vᵀ` of an `m × n` row-major matrix (one-sided Jacobi). `U` is `max(m, n) × n`, `s` sorted
 * descending, `V` is `n × n` (columns are the right singular vectors).
 */
export function svd(
	a: ArrayLike<number>,
	m: number,
	n: number,
): { u: Float64Array; s: number[]; v: Float64Array } {
	const rows = Math.max(m, n);
	const u = new Float64Array(rows * n);
	for (let i = 0; i < m * n; i++) u[i] = a[i]!;
	const v = new Float64Array(n * n);
	for (let i = 0; i < n; i++) v[i * n + i] = 1;
	for (let sweep = 0; sweep < 60; sweep++) {
		let off = 0;
		for (let p = 0; p < n; p++)
			for (let q = p + 1; q < n; q++) {
				let alpha = 0;
				let beta = 0;
				let gamma = 0;
				for (let r = 0; r < rows; r++) {
					const x = u[r * n + p]!;
					const y = u[r * n + q]!;
					alpha += x * x;
					beta += y * y;
					gamma += x * y;
				}
				if (gamma === 0) continue;
				const c0 = Math.abs(gamma) / Math.max(1e-300, Math.sqrt(alpha * beta));
				off = Math.max(off, c0);
				if (c0 < 1e-15) continue;
				const zeta = (beta - alpha) / (2 * gamma);
				const t = zeta === 0 ? 1 : Math.sign(zeta) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
				const c = 1 / Math.sqrt(1 + t * t);
				const s = c * t;
				for (let r = 0; r < rows; r++) {
					const x = u[r * n + p]!;
					const y = u[r * n + q]!;
					u[r * n + p] = c * x - s * y;
					u[r * n + q] = s * x + c * y;
				}
				for (let r = 0; r < n; r++) {
					const x = v[r * n + p]!;
					const y = v[r * n + q]!;
					v[r * n + p] = c * x - s * y;
					v[r * n + q] = s * x + c * y;
				}
			}
		if (off < 1e-15) break;
	}
	const s: number[] = [];
	for (let j = 0; j < n; j++) {
		let acc = 0;
		for (let r = 0; r < rows; r++) acc += u[r * n + j]! * u[r * n + j]!;
		s.push(Math.sqrt(acc));
	}
	for (let j = 0; j < n; j++)
		if (s[j]! > 1e-300) for (let r = 0; r < rows; r++) u[r * n + j] = u[r * n + j]! / s[j]!;
	const order = [...Array(n).keys()].sort((x, y) => s[y]! - s[x]!);
	const u2 = new Float64Array(rows * n);
	const v2 = new Float64Array(n * n);
	order.forEach((j, k) => {
		for (let r = 0; r < rows; r++) u2[r * n + k] = u[r * n + j]!;
		for (let r = 0; r < n; r++) v2[r * n + k] = v[r * n + j]!;
	});
	return { u: u2, s: order.map((j) => s[j]!), v: v2 };
}

/** SVD of a 3×3: `m = U diag(s) Vᵀ`, s descending. */
export function svd3(m: M3): { u: M3; s: V3; v: M3 } {
	const r = svd(m.flat(), 3, 3);
	const g = (x: Float64Array): M3 => [
		[x[0]!, x[1]!, x[2]!],
		[x[3]!, x[4]!, x[5]!],
		[x[6]!, x[7]!, x[8]!],
	];
	const um = g(r.u);
	if (r.s[2]! < 1e-300) {
		const c = cross(col(um, 0), col(um, 1));
		for (let i = 0; i < 3; i++) um[i]![2] = c[i]!;
	}
	return { u: um, s: [r.s[0]!, r.s[1]!, r.s[2]!], v: g(r.v) };
}

/** The unit `x` minimising |A x| (`m × n` row-major): the right singular vector of the smallest singular value. */
export function nullVector(a: ArrayLike<number>, m: number, n: number): number[] {
	// Tall systems: |A x| = |R x| for A = Q R, so the (much cheaper) SVD of the n × n triangle has the same V.
	const { v } = m > n ? svd(householderR(a, m, n), n, n) : svd(a, m, n);
	return [...Array(n).keys()].map((r) => v[r * n + n - 1]!);
}

/** The `n × n` upper triangle `R` of the QR decomposition of a tall `m × n` matrix (Householder reflections). */
function householderR(src: ArrayLike<number>, m: number, n: number): Float64Array {
	const a = Float64Array.from(src as ArrayLike<number>);
	for (let k = 0; k < n; k++) {
		let s = 0;
		for (let i = k; i < m; i++) s += a[i * n + k]! * a[i * n + k]!;
		const norm = Math.sqrt(s);
		if (norm < 1e-300) continue;
		const alpha = a[k * n + k]! > 0 ? -norm : norm;
		// v = x − alpha e1, stored in place below the diagonal (v0 kept apart).
		const v0 = a[k * n + k]! - alpha;
		const vv = s - a[k * n + k]! * a[k * n + k]! + v0 * v0;
		if (vv < 1e-300) continue;
		for (let j = k + 1; j < n; j++) {
			let d = v0 * a[k * n + j]!;
			for (let i = k + 1; i < m; i++) d += a[i * n + k]! * a[i * n + j]!;
			const f = (2 * d) / vv;
			a[k * n + j] = a[k * n + j]! - f * v0;
			for (let i = k + 1; i < m; i++) a[i * n + j] = a[i * n + j]! - f * a[i * n + k]!;
		}
		a[k * n + k] = alpha;
	}
	const r = new Float64Array(n * n);
	for (let i = 0; i < n; i++) for (let j = i; j < n; j++) r[i * n + j] = a[i * n + j]!;
	return r;
}

/** Symmetric eigen-decomposition (cyclic Jacobi): eigenvalues ascending, eigenvectors as columns (row-major). */
export function symEigen(src: ArrayLike<number>, n: number): { vals: number[]; vecs: Float64Array } {
	const a = Float64Array.from(src as ArrayLike<number>);
	const v = new Float64Array(n * n);
	for (let i = 0; i < n; i++) v[i * n + i] = 1;
	for (let it = 0; it < 100; it++) {
		let off = 0;
		for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! * a[p * n + q]!;
		if (off < 1e-30) break;
		for (let p = 0; p < n; p++)
			for (let q = p + 1; q < n; q++) {
				const apq = a[p * n + q]!;
				if (Math.abs(apq) < 1e-300) continue;
				const theta = (a[q * n + q]! - a[p * n + p]!) / (2 * apq);
				const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					const akp = a[k * n + p]!;
					const akq = a[k * n + q]!;
					a[k * n + p] = c * akp - s * akq;
					a[k * n + q] = s * akp + c * akq;
				}
				for (let k = 0; k < n; k++) {
					const apk = a[p * n + k]!;
					const aqk = a[q * n + k]!;
					a[p * n + k] = c * apk - s * aqk;
					a[q * n + k] = s * apk + c * aqk;
				}
				for (let k = 0; k < n; k++) {
					const vkp = v[k * n + p]!;
					const vkq = v[k * n + q]!;
					v[k * n + p] = c * vkp - s * vkq;
					v[k * n + q] = s * vkp + c * vkq;
				}
			}
	}
	const order = [...Array(n).keys()].sort((x, y) => a[x * n + x]! - a[y * n + y]!);
	const vecs = new Float64Array(n * n);
	order.forEach((j, k) => {
		for (let r = 0; r < n; r++) vecs[r * n + k] = v[r * n + j]!;
	});
	return { vals: order.map((j) => a[j * n + j]!), vecs };
}

/** Solves `A x = b` for symmetric positive definite `A` (`n × n` row-major) in place (Cholesky). */
export function choleskySolve(a: Float64Array, n: number, b: Float64Array): boolean {
	for (let j = 0; j < n; j++) {
		let d = a[j * n + j]!;
		for (let k = 0; k < j; k++) d -= a[j * n + k]! * a[j * n + k]!;
		if (!(d > 0) || !Number.isFinite(d)) return false;
		d = Math.sqrt(d);
		a[j * n + j] = d;
		for (let i = j + 1; i < n; i++) {
			let s = a[i * n + j]!;
			const ri = i * n;
			const rj = j * n;
			for (let k = 0; k < j; k++) s -= a[ri + k]! * a[rj + k]!;
			a[ri + j] = s / d;
		}
	}
	for (let i = 0; i < n; i++) {
		let s = b[i]!;
		for (let k = 0; k < i; k++) s -= a[i * n + k]! * b[k]!;
		b[i] = s / a[i * n + i]!;
	}
	for (let i = n - 1; i >= 0; i--) {
		let s = b[i]!;
		for (let k = i + 1; k < n; k++) s -= a[k * n + i]! * b[k]!;
		b[i] = s / a[i * n + i]!;
	}
	for (let i = 0; i < n; i++) if (!Number.isFinite(b[i]!)) return false;
	return true;
}

/** A similarity `x ↦ s R x + t`. */
export type Similarity = { s: number; r: M3; t: V3 };
export const applySim = (m: Similarity, x: V3): V3 => add(scale(mv(m.r, x), m.s), m.t);

/** The similarity minimising Σ |dst − (s R src + t)|² (Umeyama 1991). */
export function umeyama(src: V3[], dst: V3[]): Similarity | null {
	const n = Math.min(src.length, dst.length);
	if (n < 3) return null;
	const k = 1 / n;
	let ms: V3 = [0, 0, 0];
	let md: V3 = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		ms = add(ms, src[i]!);
		md = add(md, dst[i]!);
	}
	ms = scale(ms, k);
	md = scale(md, k);
	let cov: M3 = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	let variance = 0;
	for (let i = 0; i < n; i++) {
		const a = sub(src[i]!, ms);
		const b = sub(dst[i]!, md);
		cov = madd(cov, outer(b, a), k);
		variance += dot(a, a) * k;
	}
	if (variance < 1e-300) return null;
	const { u, s: d, v } = svd3(cov);
	const sgn: V3 = [1, 1, det3(u) * det3(v) < 0 ? -1 : 1];
	const ud = fromCols(scale(col(u, 0), sgn[0]), scale(col(u, 1), sgn[1]), scale(col(u, 2), sgn[2]));
	const r = mm(ud, mt(v));
	const s = (d[0] * sgn[0] + d[1] * sgn[1] + d[2] * sgn[2]) / variance;
	return { s, r, t: sub(md, scale(mv(r, ms), s)) };
}

/** Euler angles (degrees) `[x, y, z]` with `m = Rz(z) Ry(y) Rx(x)` (After Effects' Orientation order). */
export function eulerXyz(m: M3): V3 {
	const sy = Math.min(1, Math.max(-1, -m[2][0]));
	const y = Math.asin(sy);
	const [x, z] =
		Math.abs(sy) < 0.999999
			? [Math.atan2(m[2][1], m[2][2]), Math.atan2(m[1][0], m[0][0])]
			: [Math.atan2(-m[1][2], m[1][1]), 0];
	const deg = 180 / Math.PI;
	return [x * deg, y * deg, z * deg];
}
