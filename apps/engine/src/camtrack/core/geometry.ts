// Two-view and multi-view geometry of the camera solver. Port of EffectCraft `crates/track/src/camtrack/geometry.rs`
// and the homography fit of `crates/track/src/fit.rs` (MIT OR Apache-2.0), from Hartley & Zisserman (H&Z), *Multiple
// View Geometry in Computer Vision* (2nd ed.) and Ma et al., *An Invitation to 3-D Vision* (2004). Image points are
// normalised (calibrated) `x = (u − c) / f`; a camera is `(R, C)` with `X_cam = R (X − C)`.
import {
	add,
	col,
	cross,
	det3,
	dot,
	fromCols,
	I3,
	type M3,
	madd,
	mm,
	mscale,
	mt,
	mtv,
	mv,
	nearestRotation,
	normalize,
	nullVector,
	outer,
	scale,
	sub,
	svd3,
	symEigen,
	type V3,
} from './linalg.ts';

export type P2 = [number, number];

/** A deterministic xorshift generator (RANSAC samples). */
export class Rng {
	private s: number;
	constructor(seed: number) {
		this.s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
	}
	next(): number {
		let x = this.s;
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		this.s = x;
		return x >>> 0;
	}
	below(n: number): number {
		return this.next() % Math.max(1, n);
	}
	/** Uniform in [0, 1). */
	unit(): number {
		return this.next() / 4294967296;
	}
	/** `k` distinct indices below `n`. */
	sample(n: number, k: number): number[] {
		const out: number[] = [];
		let guard = 0;
		while (out.length < k && guard < 1000) {
			guard++;
			const c = this.below(n);
			if (!out.includes(c)) out.push(c);
		}
		return out;
	}
}

/** Hartley normalisation (H&Z §4.4.4): centroid to the origin, mean distance √2. */
function normalizer(p: P2[]): M3 {
	const n = Math.max(1, p.length);
	const c: P2 = [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n];
	const d = p.reduce((s, q) => s + Math.hypot(q[0] - c[0], q[1] - c[1]), 0) / n;
	const s = d > 1e-12 ? Math.SQRT2 / d : 1;
	return [
		[s, 0, -s * c[0]],
		[0, s, -s * c[1]],
		[0, 0, 1],
	];
}
const h2 = (m: M3, p: P2): V3 => mv(m, [p[0], p[1], 1]);

/** Essential matrix from ≥ 8 correspondences (`x2ᵀ E x1 = 0`), normalised 8-point with the essential constraint. */
export function essential8pt(x1: P2[], x2: P2[]): M3 | null {
	const n = Math.min(x1.length, x2.length);
	if (n < 8) return null;
	const t1 = normalizer(x1.slice(0, n));
	const t2 = normalizer(x2.slice(0, n));
	const a = new Float64Array(n * 9);
	for (let i = 0; i < n; i++) {
		const p = h2(t1, x1[i]!);
		const q = h2(t2, x2[i]!);
		a.set([q[0] * p[0], q[0] * p[1], q[0], q[1] * p[0], q[1] * p[1], q[1], p[0], p[1], 1], i * 9);
	}
	const e = nullVector(a, n, 9);
	const en: M3 = [
		[e[0]!, e[1]!, e[2]!],
		[e[3]!, e[4]!, e[5]!],
		[e[6]!, e[7]!, e[8]!],
	];
	const E = mm(mt(t2), mm(en, t1));
	const { u, s, v } = svd3(E);
	const m = (s[0] + s[1]) * 0.5;
	if (!(m > 0) || !Number.isFinite(m)) return null;
	const D: M3 = [
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 0],
	];
	return mm(u, mm(D, mt(v)));
}

/** Squared Sampson distance of a correspondence to `x2ᵀ E x1 = 0` (H&Z §11.4.3). */
export function sampson2(e: M3, p: P2, q: P2): number {
	const x1: V3 = [p[0], p[1], 1];
	const x2: V3 = [q[0], q[1], 1];
	const ex1 = mv(e, x1);
	const etx2 = mtv(e, x2);
	const num = dot(x2, ex1);
	const den = ex1[0] * ex1[0] + ex1[1] * ex1[1] + etx2[0] * etx2[0] + etx2[1] * etx2[1];
	return den < 1e-300 ? Number.POSITIVE_INFINITY : (num * num) / den;
}

/** RANSAC essential matrix (8-point samples, Sampson below `thr`), refitted on the consensus set. */
export function ransacEssential(
	x1: P2[],
	x2: P2[],
	thr: number,
	iterations: number,
	seed: number,
): { e: M3; inliers: boolean[] } | null {
	const n = Math.min(x1.length, x2.length);
	if (n < 8) return null;
	const t2 = thr * thr;
	const rng = new Rng(Math.imul(seed + 1, 0x9e3779b1) | 1);
	let best: { c: number; err: number; e: M3 } | null = null;
	let maxIter = iterations;
	for (let it = 0; it < maxIter; it++) {
		const idx = rng.sample(n, 8);
		if (idx.length < 8) break;
		const e = essential8pt(
			idx.map((i) => x1[i]!),
			idx.map((i) => x2[i]!),
		);
		if (!e) continue;
		let c = 0;
		let err = 0;
		for (let i = 0; i < n; i++) {
			const d = sampson2(e, x1[i]!, x2[i]!);
			if (d < t2) {
				c++;
				err += d;
			}
		}
		if (!best || c > best.c || (c === best.c && err < best.err)) {
			best = { c, err, e };
			const pGood = (c / n) ** 8;
			if (pGood > 1e-9) {
				const need = Math.ceil(Math.log(0.01) / Math.log(Math.max(1e-12, 1 - pGood)));
				if (Number.isFinite(need)) maxIter = Math.min(maxIter, Math.max(30, need));
			}
		}
	}
	if (!best) return null;
	let e = best.e;
	let inl = new Array<boolean>(n).fill(false);
	for (let pass = 0; pass < 2; pass++) {
		for (let i = 0; i < n; i++) inl[i] = sampson2(e, x1[i]!, x2[i]!) < t2;
		const a: P2[] = [];
		const b: P2[] = [];
		for (let i = 0; i < n; i++)
			if (inl[i]) {
				a.push(x1[i]!);
				b.push(x2[i]!);
			}
		const e2 = essential8pt(a, b);
		if (!e2) break;
		e = e2;
	}
	inl = inl.map((_, i) => sampson2(e, x1[i]!, x2[i]!) < t2);
	return { e, inliers: inl };
}

/** The four `(R, t)` with `x2 ~ R x1 + t` (|t| = 1) of an essential matrix (H&Z Result 9.19). */
export function decomposeEssential(e: M3): [M3, V3][] {
	let { u, v } = svd3(e);
	if (det3(u) < 0) u = u.map((r) => [r[0], r[1], -r[2]]) as M3;
	if (det3(v) < 0) v = v.map((r) => [r[0], r[1], -r[2]]) as M3;
	const w: M3 = [
		[0, -1, 0],
		[1, 0, 0],
		[0, 0, 1],
	];
	const r1 = mm(u, mm(w, mt(v)));
	const r2 = mm(u, mm(mt(w), mt(v)));
	const t = col(u, 2);
	return [
		[r1, t],
		[r1, scale(t, -1)],
		[r2, t],
		[r2, scale(t, -1)],
	];
}

/** A camera `(R, C)`. */
export type Pose = { r: M3; c: V3 };
export const poseIdentity = (): Pose => ({ r: I3(), c: [0, 0, 0] });
/** From `x_cam = R X + t`. */
export const poseFromRt = (r: M3, t: V3): Pose => ({ r, c: scale(mtv(r, t), -1) });
export const poseT = (p: Pose): V3 => scale(mv(p.r, p.c), -1);
export const toCam = (p: Pose, x: V3): V3 => mv(p.r, sub(x, p.c));

/** Linear (DLT) triangulation from normalised observations (H&Z §12.2). */
export function triangulate(views: { pose: Pose; x: P2 }[]): V3 | null {
	if (views.length < 2) return null;
	const ata = new Float64Array(16);
	for (const { pose: p, x } of views) {
		const t = poseT(p);
		const rows = [
			[p.r[0][0], p.r[0][1], p.r[0][2], t[0]],
			[p.r[1][0], p.r[1][1], p.r[1][2], t[1]],
			[p.r[2][0], p.r[2][1], p.r[2][2], t[2]],
		];
		const a0 = [0, 1, 2, 3].map((j) => x[0] * rows[2]![j]! - rows[0]![j]!);
		const a1 = [0, 1, 2, 3].map((j) => x[1] * rows[2]![j]! - rows[1]![j]!);
		for (const a of [a0, a1]) {
			const nrm = Math.max(1e-300, Math.sqrt(a.reduce((s, v) => s + v * v, 0)));
			for (let i = 0; i < 4; i++)
				for (let j = 0; j < 4; j++) ata[i * 4 + j]! += (a[i]! * a[j]!) / (nrm * nrm);
		}
	}
	const { vecs } = symEigen(ata, 4);
	const h = [vecs[0]!, vecs[4]!, vecs[8]!, vecs[12]!];
	if (Math.abs(h[3]!) < 1e-12) return null;
	const X: V3 = [h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!];
	return X.every(Number.isFinite) ? X : null;
}

/** Angle (radians) between the rays from two camera centres to `x`. */
export function rayAngle(a: V3, b: V3, x: V3): number {
	const u = normalize(sub(x, a));
	const v = normalize(sub(x, b));
	return Math.acos(Math.min(1, Math.max(-1, dot(u, v))));
}

/** Squared reprojection error (normalised units), null behind the camera. */
export function reproj2(pose: Pose, x: V3, o: P2): number | null {
	const c = toCam(pose, x);
	if (c[2] <= 1e-9) return null;
	const u = c[0] / c[2] - o[0];
	const v = c[1] / c[2] - o[1];
	return u * u + v * v;
}

/** The essential decomposition with the most points in front of both cameras. */
export function selectPose(cands: [M3, V3][], x1: P2[], x2: P2[]): { pose: Pose; count: number } | null {
	let best: { pose: Pose; count: number } | null = null;
	for (const [r, t] of cands) {
		const p2 = poseFromRt(r, t);
		let c = 0;
		for (let i = 0; i < x1.length; i++) {
			const x = triangulate([
				{ pose: poseIdentity(), x: x1[i]! },
				{ pose: p2, x: x2[i]! },
			]);
			if (x && x[2] > 0 && toCam(p2, x)[2] > 0) c++;
		}
		if (!best || c > best.count) best = { pose: p2, count: c };
	}
	return best;
}

/**
 * Decompose a calibrated planar homography `H ~ R + t nᵀ / d` (`x2 ~ H x1`) into `(R, t/d, n)` (Ma et al. §5.3.3).
 * Solutions putting the plane behind the first camera are dropped.
 */
export function decomposeHomography(h: M3, x1: P2[], x2: P2[]): { r: M3; t: V3; n: V3 }[] {
	const { s } = svd3(h);
	if (s[1] <= 1e-12) return [];
	let hn = mscale(h, 1 / s[1]);
	let pos = 0;
	for (let i = 0; i < x1.length; i++)
		if (dot([x2[i]![0], x2[i]![1], 1], mv(hn, [x1[i]![0], x1[i]![1], 1])) > 0) pos++;
	if (pos * 2 < x1.length) hn = mscale(hn, -1);
	const hth = mm(mt(hn), hn);
	const { vals, vecs } = symEigen(hth.flat(), 3);
	const v1: V3 = [vecs[2]!, vecs[5]!, vecs[8]!];
	const v2: V3 = [vecs[1]!, vecs[4]!, vecs[7]!];
	const v3: V3 = [vecs[0]!, vecs[3]!, vecs[6]!];
	const s1 = Math.max(1, vals[2]!);
	const s3 = Math.min(1, Math.max(0, vals[0]!));
	if (s1 - s3 < 1e-10) return [{ r: nearestRotation(hn), t: [0, 0, 0], n: [0, 0, 1] }];
	const k = Math.sqrt(s1 - s3);
	const a1 = Math.sqrt(1 - s3);
	const a3 = Math.sqrt(s1 - 1);
	const u1 = scale(add(scale(v1, a1), scale(v3, a3)), 1 / k);
	const u2 = scale(sub(scale(v1, a1), scale(v3, a3)), 1 / k);
	const out: { r: M3; t: V3; n: V3 }[] = [];
	for (const u of [u1, u2]) {
		const uu = fromCols(v2, u, cross(v2, u));
		const hv2 = mv(hn, v2);
		const hu = mv(hn, u);
		const ww = fromCols(hv2, hu, cross(hv2, hu));
		const r = mm(ww, mt(uu));
		const n = cross(v2, u);
		const t = mv(madd(hn, r, -1), n);
		for (const sgn of [1, -1]) {
			const n2 = scale(n, sgn);
			const t2 = scale(t, sgn);
			let front = 0;
			for (const p of x1) if (dot(n2, [p[0], p[1], 1]) > 0) front++;
			if (front * 2 >= x1.length) out.push({ r, t: t2, n: n2 });
		}
	}
	return out;
}

/** Least-squares plane through points: centroid, unit normal and RMS in-plane spread. */
export function fitPlane(p: V3[]): { c: V3; n: V3; spread: number } | null {
	if (p.length < 3) return null;
	const k = 1 / p.length;
	let c: V3 = [0, 0, 0];
	for (const q of p) c = add(c, q);
	c = scale(c, k);
	const cov = new Float64Array(9);
	for (const q of p) {
		const d = sub(q, c);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j]! += d[i]! * d[j]! * k;
	}
	const { vals, vecs } = symEigen(cov, 3);
	if (vals[1]! <= 1e-18) return null;
	const n = normalize([vecs[0]!, vecs[3]!, vecs[6]!]);
	return { c, n, spread: Math.sqrt(Math.max(0, vals[1]! + vals[2]!)) };
}

/** The rotation `R` minimising Σ |b − R a|² over unit rays (orthogonal Procrustes / Kabsch). */
export function procrustes(a: V3[], b: V3[]): M3 | null {
	if (a.length < 2) return null;
	let m: M3 = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	for (let i = 0; i < a.length; i++) m = madd(m, outer(b[i]!, a[i]!), 1);
	const { u, v } = svd3(m);
	let r = mm(u, mt(v));
	if (det3(r) < 0) r = mm(u.map((row) => [row[0], row[1], -row[2]]) as M3, mt(v));
	return r;
}

export type H3 = M3;
export function applyH(h: H3, p: P2): P2 {
	const w = h[2][0] * p[0] + h[2][1] * p[1] + h[2][2];
	return [(h[0][0] * p[0] + h[0][1] * p[1] + h[0][2]) / w, (h[1][0] * p[0] + h[1][1] * p[1] + h[1][2]) / w];
}

/** Solves an n×n dense system (Gaussian elimination with partial pivoting); null when singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	const m = a.map((r, i) => [...r, b[i]!]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
		if (Math.abs(m[p]![c]!) < 1e-14) return null;
		[m[c], m[p]] = [m[p]!, m[c]!];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = m[r]![c]! / m[c]![c]!;
			if (f === 0) continue;
			for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
		}
	}
	const x = m.map((r, i) => r[n]! / r[i]!);
	return x.every(Number.isFinite) ? x : null;
}

/** Least-squares homography `src → dst` (normalised DLT, h33 = 1). */
export function homographyLs(src: P2[], dst: P2[]): H3 | null {
	const n = Math.min(src.length, dst.length);
	if (n < 4) return null;
	const cen = (p: P2[]): P2 => [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n];
	const cs = cen(src.slice(0, n));
	const cd = cen(dst.slice(0, n));
	const nk = (p: P2[], c: P2) => {
		const d = p.slice(0, n).reduce((s, q) => s + Math.hypot(q[0] - c[0], q[1] - c[1]), 0) / n;
		return d > 1e-12 ? Math.SQRT2 / d : 1;
	};
	const ks = nk(src, cs);
	const kd = nk(dst, cd);
	const A = [...Array(8)].map(() => new Array<number>(8).fill(0));
	const B = new Array<number>(8).fill(0);
	for (let i = 0; i < n; i++) {
		const x = (src[i]![0] - cs[0]) * ks;
		const y = (src[i]![1] - cs[1]) * ks;
		const u = (dst[i]![0] - cd[0]) * kd;
		const v = (dst[i]![1] - cd[1]) * kd;
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
	const h = solveLinear(A, B);
	if (!h) return null;
	const hn: M3 = [
		[h[0]!, h[1]!, h[2]!],
		[h[3]!, h[4]!, h[5]!],
		[h[6]!, h[7]!, 1],
	];
	const ts: M3 = [
		[ks, 0, -ks * cs[0]],
		[0, ks, -ks * cs[1]],
		[0, 0, 1],
	];
	const tdInv: M3 = [
		[1 / kd, 0, cd[0]],
		[0, 1 / kd, cd[1]],
		[0, 0, 1],
	];
	const m = mm(tdInv, mm(hn, ts));
	if (Math.abs(m[2][2]) < 1e-12) return null;
	const out = mscale(m, 1 / m[2][2]);
	return out.flat().every(Number.isFinite) ? out : null;
}

/** RANSAC homography (pixels, inlier threshold `threshold`). */
export function ransacHomography(
	src: P2[],
	dst: P2[],
	threshold: number,
	iterations: number,
	seed: number,
): { h: H3; inliers: boolean[] } | null {
	const n = Math.min(src.length, dst.length);
	if (n < 4) return null;
	const t2 = threshold * threshold;
	const r2 = (h: H3, i: number) => {
		const m = applyH(h, src[i]!);
		return (m[0] - dst[i]![0]) ** 2 + (m[1] - dst[i]![1]) ** 2;
	};
	const rng = new Rng(Math.imul(seed + 7, 0x9e3779b1) | 1);
	let best: { c: number; e: number; h: H3 } | null = null;
	let maxIter = Math.max(1, iterations);
	for (let it = 0; it < maxIter; it++) {
		const idx = rng.sample(n, 4);
		if (idx.length < 4) continue;
		const h = homographyLs(
			idx.map((i) => src[i]!),
			idx.map((i) => dst[i]!),
		);
		if (!h) continue;
		let c = 0;
		let e = 0;
		for (let i = 0; i < n; i++) {
			const r = r2(h, i);
			if (r < t2) {
				c++;
				e += r;
			}
		}
		if (!best || c > best.c || (c === best.c && e < best.e)) {
			best = { c, e, h };
			const pGood = (c / n) ** 4;
			if (pGood >= 1) break;
			if (pGood > 1e-9) {
				const need = Math.ceil(Math.log(0.01) / Math.log(1 - pGood));
				if (Number.isFinite(need)) maxIter = Math.min(maxIter, Math.max(it + 1, need));
			}
		}
	}
	if (!best) return null;
	let h = best.h;
	let inl = [...Array(n).keys()].map((i) => r2(h, i) < t2);
	for (let pass = 0; pass < 2; pass++) {
		const s2 = src.filter((_, i) => inl[i]);
		const d2 = dst.filter((_, i) => inl[i]);
		if (s2.length < 4) break;
		const r = homographyLs(s2, d2);
		if (r) h = r;
		inl = [...Array(n).keys()].map((i) => r2(h, i) < t2);
	}
	return { h, inliers: inl };
}

export { I3 };
