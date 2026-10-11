// Warp Stabilizer ▸ the stabilisation step (docs/wp-notes/gaps.md §FX-6). Ported from effectcraft
// `crates/track/src/stabilize.rs` and `subspace.rs` (MIT OR Apache-2.0, licenses/ported/gaps.md), which follow:
// - Matsushita et al., "Full-Frame Video Stabilization with Motion Inpainting" (PAMI 2006): Smooth Motion warps each
//   frame to the Gaussian-weighted average of its neighbours' viewpoints; No Motion maps every frame onto one;
// - Grundmann et al., "Auto-Directed Video Stabilization with Robust L1 Optimal Camera Paths" (CVPR 2011): the
//   correction is relaxed towards identity where it would need more than Maximum Scale (per frame here);
// - Liu et al., "Subspace Video Stabilization" (TOG 2011) and "Content-Preserving Warps for 3D Video Stabilization"
//   (TOG 2009): Subspace Warp smooths eigen-trajectories of the feature tracks and fits a mesh per frame.
// Coordinates are analysis pixels (the media's display size); transforms map SOURCE pixels to STABILISED pixels.
// Differences from the Rust: a banded Cholesky for the mesh systems and a warm-started subspace iteration instead of
// a full Jacobi eigen-decomposition per frame (the same subspace, ~50× less work in JS).
import {
	BandMatrix,
	bandedCholeskySolve,
	choleskySolve,
	H_IDENTITY,
	type H3,
	hApply,
	hInv,
	hLerp,
	hMul,
	hNorm,
	hScaleAbout,
	hTranslation,
	leastSquares,
	type P2,
	topEigenvectors,
} from './math.ts';

/** Inter-frame motion of one frame (previous frame → this one). */
export type FrameMotion = {
	/** Translation [tx, ty]. */
	t: P2;
	/** Similarity [a, b, tx, ty] (x' = a x − b y + tx, y' = b x + a y + ty). */
	s: readonly [number, number, number, number];
	/** Homography, row-major without h33 = 1. */
	h: readonly number[];
};

/** One feature trajectory: positions on consecutive frames from `start`. */
export type Track2D = { start: number; pts: readonly P2[] };

/** The analysis the stabilisation reads (decoded from `WarpAnalysisData`). */
export type WarpAnalysis = {
	size: P2;
	frames: readonly FrameMotion[];
	tracks: readonly Track2D[];
};

export type StabResult = 'smoothMotion' | 'noMotion';
export type StabMethod = 'position' | 'positionScaleRotation' | 'perspective' | 'subspaceWarp';
export type StabFraming = 'stabilizeOnly' | 'stabilizeCrop' | 'stabilizeCropAutoScale' | 'synthesizeEdges';
export type StabRipple = 'automatic' | 'enhanced';

export type StabSettings = {
	result: StabResult;
	/** Smoothness, percent (50 = default). */
	smoothness: number;
	method: StabMethod;
	preserveScale: boolean;
	framing: StabFraming;
	/** Maximum Scale, percent. */
	maxScale: number;
	/** Action-Safe Margin, percent of the frame on each side. */
	actionSafe: number;
	/** Additional Scale, percent. */
	additionalScale: number;
	/** Crop Less ↔ Smooth More, −100…100. */
	cropLessSmoothMore: number;
	/** Frames per second of the analysed frames (Smoothness is in time). */
	fps: number;
	ripple: StabRipple;
};

export const DEFAULT_STAB_SETTINGS: StabSettings = {
	result: 'smoothMotion',
	smoothness: 50,
	method: 'subspaceWarp',
	preserveScale: false,
	framing: 'stabilizeCropAutoScale',
	maxScale: 150,
	actionSafe: 0,
	additionalScale: 100,
	cropLessSmoothMore: 0,
	fps: 30,
	ripple: 'automatic',
};

/** Gaussian smoothing sigma in frames. */
export function stabSigma(s: StabSettings): number {
	const base = (Math.max(0, s.smoothness) / 100) * Math.max(1, s.fps) * 0.6;
	return base * 2 ** (Math.max(-100, Math.min(100, s.cropLessSmoothMore)) / 100);
}

/** The frame's motion under a method. */
export function motionOf(f: FrameMotion, method: StabMethod): number[] {
	if (method === 'position') return hTranslation(f.t);
	if (method === 'positionScaleRotation') {
		const s = f.s;
		return [s[0], -s[1], s[2], s[1], s[0], s[3], 0, 0, 1];
	}
	return [...f.h.slice(0, 8), 1];
}

export type WarpMeshOpts = { cols: number; rows: number; alpha: number; prior: number };

export function rippleMesh(r: StabRipple): WarpMeshOpts {
	return r === 'enhanced'
		? { cols: 12, rows: 16, alpha: 0.5, prior: 0.02 }
		: { cols: 12, rows: 8, alpha: 1, prior: 0.02 };
}

/**
 * A warp mesh: a regular `cols × rows` grid over the stabilised frame (`size`); every vertex holds the source position
 * it shows (`verts`: x, y interleaved, row-major, `(rows + 1) × (cols + 1)` vertices). Rendering = a bilinear lookup.
 */
export class WarpMesh {
	readonly verts: Float64Array;
	constructor(
		readonly cols: number,
		readonly rows: number,
		readonly size: P2,
		verts?: Float64Array,
	) {
		this.verts = verts ?? new Float64Array((cols + 1) * (rows + 1) * 2);
		if (!verts)
			for (let j = 0; j <= rows; j++)
				for (let i = 0; i <= cols; i++) {
					const k = this.idx(i, j);
					const g = this.grid(i, j);
					this.verts[2 * k] = g[0];
					this.verts[2 * k + 1] = g[1];
				}
	}

	static identity(cols: number, rows: number, size: P2): WarpMesh {
		return new WarpMesh(Math.max(1, cols), Math.max(1, rows), size);
	}

	/** The mesh of a homography (`h`: source → stabilised). */
	static fromHomography(cols: number, rows: number, size: P2, h: H3): WarpMesh {
		const inv = hInv(h) ?? H_IDENTITY;
		const m = WarpMesh.identity(cols, rows, size);
		for (let k = 0; k < m.verts.length / 2; k++) {
			const q = hApply(inv, [m.verts[2 * k]!, m.verts[2 * k + 1]!]);
			m.verts[2 * k] = q[0];
			m.verts[2 * k + 1] = q[1];
		}
		return m;
	}

	cell(): P2 {
		return [this.size[0] / this.cols, this.size[1] / this.rows];
	}
	grid(i: number, j: number): P2 {
		const c = this.cell();
		return [i * c[0], j * c[1]];
	}
	idx(i: number, j: number): number {
		return j * (this.cols + 1) + i;
	}
	/** Cell and bilinear coordinates of a stabilised point (outer cells extrapolate). */
	locate(p: P2): [number, number, number, number] {
		const c = this.cell();
		const fx = p[0] / c[0];
		const fy = p[1] / c[1];
		const i = Math.min(this.cols - 1, Math.max(0, Math.floor(fx)));
		const j = Math.min(this.rows - 1, Math.max(0, Math.floor(fy)));
		return [i, j, fx - i, fy - j];
	}
	/** The source position shown at stabilised point `p`. */
	sample(p: P2): [number, number] {
		const [i, j, u, v] = this.locate(p);
		const a = this.idx(i, j);
		const b = this.idx(i + 1, j);
		const c = this.idx(i, j + 1);
		const d = this.idx(i + 1, j + 1);
		const w0 = (1 - u) * (1 - v);
		const w1 = u * (1 - v);
		const w2 = (1 - u) * v;
		const w3 = u * v;
		const V = this.verts;
		return [
			w0 * V[2 * a]! + w1 * V[2 * b]! + w2 * V[2 * c]! + w3 * V[2 * d]!,
			w0 * V[2 * a + 1]! + w1 * V[2 * b + 1]! + w2 * V[2 * c + 1]! + w3 * V[2 * d + 1]!,
		];
	}
	/** Where source point `q` lands (Newton on `sample`); null when it does not converge (a folded mesh). */
	forward(q: P2): [number, number] | null {
		const s = this.sample(q);
		const p: [number, number] = [2 * q[0] - s[0], 2 * q[1] - s[1]];
		for (let it = 0; it < 30; it++) {
			const f = this.sample(p);
			const e0 = f[0] - q[0];
			const e1 = f[1] - q[1];
			if (Math.hypot(e0, e1) < 1e-6) return p;
			const h = 0.5;
			const fx = this.sample([p[0] + h, p[1]]);
			const fy = this.sample([p[0], p[1] + h]);
			const j00 = (fx[0] - f[0]) / h;
			const j01 = (fy[0] - f[0]) / h;
			const j10 = (fx[1] - f[1]) / h;
			const j11 = (fy[1] - f[1]) / h;
			const det = j00 * j11 - j01 * j10;
			if (Math.abs(det) < 1e-12) return null;
			p[0] -= (j11 * e0 - j01 * e1) / det;
			p[1] -= (-j10 * e0 + j00 * e1) / det;
		}
		const f = this.sample(p);
		return Math.hypot(f[0] - q[0], f[1] - q[1]) < 1e-3 ? p : null;
	}
	/** `(1 − t)·identity + t·self` per vertex. */
	lerpIdentity(t: number): WarpMesh {
		const m = new WarpMesh(this.cols, this.rows, this.size, new Float64Array(this.verts));
		for (let j = 0; j <= this.rows; j++)
			for (let i = 0; i <= this.cols; i++) {
				const g = this.grid(i, j);
				const k = this.idx(i, j);
				m.verts[2 * k] = g[0] + (this.verts[2 * k]! - g[0]) * t;
				m.verts[2 * k + 1] = g[1] + (this.verts[2 * k + 1]! - g[1]) * t;
			}
		return m;
	}
	/** Largest s ∈ [0, 1] whose centred s·W × s·H rectangle shows only source pixels. */
	validFraction(): number {
		const [w, h] = this.size;
		const c: P2 = [w / 2, h / 2];
		const tol = 1e-6;
		const inside = (q: P2) => q[0] >= -tol && q[1] >= -tol && q[0] <= w + tol && q[1] <= h + tol;
		const fits = (s: number) => {
			const hw = (s * w) / 2;
			const hh = (s * h) / 2;
			const n = 48;
			for (let k = 0; k <= n; k++) {
				const t = k / n;
				const x = c[0] - hw + 2 * hw * t;
				const y = c[1] - hh + 2 * hh * t;
				if (
					!inside(this.sample([x, c[1] - hh])) ||
					!inside(this.sample([x, c[1] + hh])) ||
					!inside(this.sample([c[0] - hw, y])) ||
					!inside(this.sample([c[0] + hw, y]))
				)
					return false;
			}
			return true;
		};
		if (fits(1)) return 1;
		if (!fits(0)) return 0;
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 24; i++) {
			const mid = 0.5 * (lo + hi);
			if (fits(mid)) lo = mid;
			else hi = mid;
		}
		return lo;
	}
	/** The homography (source → stabilised) closest to the mesh. */
	homography(): number[] {
		const src: P2[] = [];
		const dst: P2[] = [];
		for (let j = 0; j <= this.rows; j++)
			for (let i = 0; i <= this.cols; i++) {
				const k = this.idx(i, j);
				src.push([this.verts[2 * k]!, this.verts[2 * k + 1]!]);
				dst.push(this.grid(i, j));
			}
		return leastSquares('homography', src, dst) ?? H_IDENTITY.slice();
	}
}

/**
 * Fits the content-preserving warp of one frame: `pairs` = (source position, wanted stabilised position) of its
 * features; `base` = the frame's perspective correction (source → stabilised), the prior.
 */
/** The data-independent part of the mesh system (prior on the diagonal + the similarity term), per grid. */
const meshSystems = new Map<string, BandMatrix>();
function meshSystem(m: WarpMesh, o: WarpMeshOpts): BandMatrix {
	const key = `${m.cols}x${m.rows}|${m.size[0]}x${m.size[1]}|${o.alpha}|${o.prior}`;
	const hit = meshSystems.get(key);
	if (hit) return hit;
	const nv = (m.cols + 1) * (m.rows + 1);
	const A = new BandMatrix(2 * nv, 2 * (m.cols + 2) + 1);
	for (let k = 0; k < 2 * nv; k++) A.add(k, k, o.prior);
	const a2 = o.alpha * o.alpha;
	const rowA = (ix: number[], cf: number[]) => {
		for (let a = 0; a < ix.length; a++)
			for (let b = 0; b <= a; b++) {
				const v = a2 * cf[a]! * cf[b]!;
				A.add(ix[a]!, ix[b]!, v);
				if (a !== b && ix[a] === ix[b]) A.add(ix[a]!, ix[b]!, v);
			}
	};
	for (let j = 0; j < m.rows; j++)
		for (let i = 0; i < m.cols; i++) {
			const a: P2 = [i, j];
			const b: P2 = [i + 1, j];
			const c: P2 = [i + 1, j + 1];
			const d: P2 = [i, j + 1];
			for (const [v1, v2, v3] of [
				[a, b, d],
				[b, c, a],
				[c, d, b],
				[d, a, c],
			] as const) {
				const g1 = m.grid(v1[0], v1[1]);
				const g2 = m.grid(v2[0], v2[1]);
				const g3 = m.grid(v3[0], v3[1]);
				const dv = [g3[0] - g2[0], g3[1] - g2[1]];
				const e = [g1[0] - g2[0], g1[1] - g2[1]];
				const l2 = dv[0]! * dv[0]! + dv[1]! * dv[1]!;
				const u = (e[0]! * dv[0]! + e[1]! * dv[1]!) / l2;
				const v = (e[0]! * -dv[1]! + e[1]! * dv[0]!) / l2;
				const k1 = m.idx(v1[0], v1[1]);
				const k2 = m.idx(v2[0], v2[1]);
				const k3 = m.idx(v3[0], v3[1]);
				// x: V1x − V2x − u (V3x − V2x) + v (V3y − V2y) = 0; y: V1y − V2y − u (V3y − V2y) − v (V3x − V2x) = 0
				rowA([2 * k1, 2 * k2, 2 * k3, 2 * k3 + 1, 2 * k2 + 1], [1, u - 1, -u, v, -v]);
				rowA([2 * k1 + 1, 2 * k2 + 1, 2 * k3 + 1, 2 * k3, 2 * k2], [1, u - 1, -u, -v, v]);
			}
		}
	if (meshSystems.size > 8) meshSystems.clear();
	meshSystems.set(key, A);
	return A;
}

/**
 * Fits the content-preserving warp of one frame: `pairs` = (source position, wanted stabilised position) of its
 * features; `base` = the frame's perspective correction (source → stabilised), the prior.
 */
export function solveMesh(
	size: P2,
	o: WarpMeshOpts,
	pairs: readonly (readonly [P2, P2])[],
	base: H3,
): WarpMesh {
	const m = WarpMesh.fromHomography(o.cols, o.rows, size, base);
	const n = m.verts.length;
	const B = new Float64Array(n);
	for (let k = 0; k < n; k++) B[k] = o.prior * m.verts[k]!;
	let A: BandMatrix | null = null;
	const W = m.cols + 1;
	for (const [src, dst] of pairs) {
		if (!(dst[0] >= 0 && dst[1] >= 0 && dst[0] <= size[0] && dst[1] <= size[1])) continue;
		if (!Number.isFinite(src[0]) || !Number.isFinite(src[1])) continue;
		A ??= meshSystem(m, o).clone();
		const [i, j, u, v] = m.locate(dst);
		const k0 = j * W + i;
		const ks = [k0, k0 + 1, k0 + W, k0 + W + 1];
		const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
		for (let d = 0; d < 2; d++)
			for (let a = 0; a < 4; a++) {
				const ia = 2 * ks[a]! + d;
				B[ia]! += w[a]! * src[d]!;
				for (let b = 0; b <= a; b++) A.add(ia, 2 * ks[b]! + d, w[a]! * w[b]!);
			}
	}
	if (!A) return m;
	if (bandedCholeskySolve(A, B)) m.verts.set(B);
	return m;
}

function gauss(lo: number, hi: number, t: number, sigma: number): number[] {
	const g: number[] = [];
	let s = 0;
	for (let j = lo; j <= hi; j++) {
		const v = Math.exp(-((j - t) ** 2) / (2 * sigma * sigma));
		g.push(v);
		s += v;
	}
	return g.map((v) => v / Math.max(s, 1e-300));
}

const trackAt = (tr: Track2D, k: number): P2 | null => {
	const i = k - tr.start;
	return i >= 0 && i < tr.pts.length ? tr.pts[i]! : null;
};
const trackEnd = (tr: Track2D) => tr.start + tr.pts.length;

/**
 * Subspace-smoothed feature positions: for every frame, the (original, smoothed) positions of the trajectories seen on
 * it. `sigma`: Gaussian smoothing (frames); `rank`: the subspace dimension (9 in the paper).
 */
export function smoothTrajectories(
	tracks: readonly Track2D[],
	frames: number,
	sigma: number,
	rank: number,
): [P2, P2][][] {
	const maxR = Math.min(30, Math.max(1, Math.ceil(3 * sigma)));
	const out: [P2, P2][][] = [];
	let warm: { lo: number; vecs: number[][] } | null = null;
	for (let t = 0; t < frames; t++) {
		let r = maxR;
		let lo = 0;
		let hi = 0;
		let complete: Track2D[] = [];
		for (;;) {
			lo = Math.max(0, t - r);
			hi = Math.min(frames - 1, t + r);
			complete = tracks.filter((tr) => tr.start <= lo && trackEnd(tr) > hi);
			if (complete.length >= 8 || r <= 2) break;
			r = Math.max(2, Math.floor((r * 2) / 3));
		}
		if (complete.length < 4) {
			out.push([]);
			warm = null;
			continue;
		}
		const m = hi - lo + 1;
		const rows = 2 * complete.length;
		const k = Math.max(1, Math.min(rank, m, rows));
		const mat = new Float64Array(rows * m);
		complete.forEach((tr, i) => {
			for (let c = 0; c < m; c++) {
				const p = trackAt(tr, lo + c) ?? [0, 0];
				mat[2 * i * m + c] = p[0];
				mat[(2 * i + 1) * m + c] = p[1];
			}
		});
		const gram = new Float64Array(m * m);
		for (let q = 0; q < rows; q++) {
			const o = q * m;
			for (let a = 0; a < m; a++) {
				const x = mat[o + a]!;
				for (let b = a; b < m; b++) gram[a * m + b]! += x * mat[o + b]!;
			}
		}
		for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) gram[b * m + a] = gram[a * m + b]!;
		// Warm start: the previous window's basis shifted to this window's frames.
		let start: number[][] | null = null;
		if (warm?.vecs[0]) {
			const w = warm;
			start = w.vecs.slice(0, k).map((v) => {
				const o: number[] = [];
				for (let c = 0; c < m; c++) {
					const src = lo + c - w.lo;
					o.push(v[Math.max(0, Math.min(v.length - 1, src))]!);
				}
				return o;
			});
		}
		const cmat = topEigenvectors(gram, m, k, start, start ? 8 : 60);
		warm = { lo, vecs: cmat };
		const g = gauss(lo, hi, t, Math.max(sigma, 1e-6));
		const chat = cmat.map((rw) => rw.reduce((s, a, i) => s + a * g[i]!, 0));
		const tc = t - lo;
		const pairs: [P2, P2][] = [];
		for (let i = 0; i < complete.length; i++) {
			const src: P2 = [mat[2 * i * m + tc]!, mat[(2 * i + 1) * m + tc]!];
			const dst: [number, number] = [0, 0];
			for (let d = 0; d < 2; d++) {
				const off = (2 * i + d) * m;
				for (let q = 0; q < k; q++) {
					let w = 0;
					const cq = cmat[q]!;
					for (let c = 0; c < m; c++) w += mat[off + c]! * cq[c]!;
					dst[d]! += w * chat[q]!;
				}
			}
			pairs.push([src, dst]);
		}
		const need = Math.max(k + 3, Math.floor(m / 2));
		for (const tr of tracks) {
			if (!trackAt(tr, t) || (tr.start <= lo && trackEnd(tr) > hi)) continue;
			const cols: number[] = [];
			for (let c = 0; c < m; c++) if (trackAt(tr, lo + c)) cols.push(c);
			if (cols.length < need) continue;
			const ata = new Float64Array(k * k);
			const atb = [new Float64Array(k), new Float64Array(k)];
			for (const c of cols) {
				const p = trackAt(tr, lo + c)!;
				for (let a = 0; a < k; a++) for (let d = 0; d < 2; d++) atb[d]![a]! += cmat[a]![c]! * p[d]!;
			}
			// CᵀC over the covered columns = I − the missing columns' outer products (C's rows are orthonormal):
			// the cheaper of the two sums.
			const missing = m - cols.length;
			if (missing < cols.length) {
				for (let a = 0; a < k; a++) ata[a * k + a] = 1;
				const have = new Uint8Array(m);
				for (const c of cols) have[c] = 1;
				for (let c = 0; c < m; c++) {
					if (have[c]) continue;
					for (let a = 0; a < k; a++)
						for (let b = 0; b < k; b++) ata[a * k + b]! -= cmat[a]![c]! * cmat[b]![c]!;
				}
			} else
				for (const c of cols)
					for (let a = 0; a < k; a++)
						for (let b = 0; b < k; b++) ata[a * k + b]! += cmat[a]![c]! * cmat[b]![c]!;
			for (let a = 0; a < k; a++) ata[a * k + a]! += 1e-9;
			const dst: [number, number] = [0, 0];
			let ok = true;
			for (let d = 0; d < 2; d++) {
				const x = new Float64Array(atb[d]!);
				if (!choleskySolve(new Float64Array(ata), k, x)) {
					ok = false;
					break;
				}
				let s = 0;
				for (let a = 0; a < k; a++) s += x[a]! * chat[a]!;
				dst[d] = s;
			}
			if (ok) pairs.push([trackAt(tr, t)!, dst]);
		}
		out.push(pairs);
	}
	return out;
}

function removeScale(b: H3, c: P2): number[] {
	const p0 = hApply(b, c);
	const px = hApply(b, [c[0] + 1, c[1]]);
	const py = hApply(b, [c[0], c[1] + 1]);
	const det = Math.abs((px[0] - p0[0]) * (py[1] - p0[1]) - (px[1] - p0[1]) * (py[0] - p0[0]));
	const s = Math.sqrt(det);
	if (s < 1e-9) return b.slice();
	return hMul(hScaleAbout(1 / s, p0), b);
}

/** Corrective transforms (source → stabilised, before framing) of every frame. */
export function corrections(a: WarpAnalysis, s: StabSettings): number[][] {
	const n = a.frames.length;
	if (!n) return [];
	const inter = a.frames.map((f) => motionOf(f, s.method));
	const inv = inter.map((h) => hInv(h) ?? H_IDENTITY.slice());
	const c: P2 = [a.size[0] / 2, a.size[1] / 2];
	let out: number[][] = [];
	if (s.result === 'noMotion') {
		const cum: number[][] = [];
		let cur = H_IDENTITY.slice();
		inter.forEach((h, k) => {
			if (k > 0) cur = hMul(h, cur);
			cum.push(cur);
		});
		const r = Math.floor(n / 2);
		for (const ct of cum) out.push(hMul(cum[r]!, hInv(ct) ?? H_IDENTITY));
	} else {
		const sigma = stabSigma(s);
		const rad = Math.min(Math.ceil(3 * sigma), Math.max(0, n - 1));
		for (let t = 0; t < n; t++) {
			if (sigma < 0.3 || rad === 0) {
				out.push(H_IDENTITY.slice());
				continue;
			}
			const acc = new Array<number>(9).fill(0);
			let wsum = 0;
			const add = (h: H3, d: number) => {
				const w = Math.exp(-(d * d) / (2 * sigma * sigma));
				const m = hNorm(h);
				for (let i = 0; i < 9; i++) acc[i]! += w * m[i]!;
				wsum += w;
			};
			add(H_IDENTITY, 0);
			let tf = H_IDENTITY.slice();
			for (let i = t + 1; i <= Math.min(t + rad, n - 1); i++) {
				tf = hMul(inter[i]!, tf);
				add(tf, i - t);
			}
			let tb = H_IDENTITY.slice();
			for (let i = t - 1; i >= Math.max(0, t - rad); i--) {
				tb = hMul(inv[i + 1]!, tb);
				add(tb, t - i);
			}
			out.push(hNorm(acc.map((v) => v / wsum)));
		}
	}
	if (s.preserveScale && s.method !== 'position') out = out.map((b) => removeScale(b, c));
	return out;
}

function convexContains(q: readonly P2[], p: P2): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = q[i]!;
		const b = q[(i + 1) % 4]!;
		const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
		if (Math.abs(c) < 1e-12) continue;
		if (sign === 0) sign = Math.sign(c);
		else if (Math.sign(c) !== sign) return false;
	}
	return true;
}

/** Largest s ∈ [0, 1] whose centred s·W × s·H rectangle lies inside the frame outline mapped by `b`. */
export function validFraction(b: H3, size: P2): number {
	const [w, h] = size;
	const corners: P2[] = [
		[0, 0],
		[w, 0],
		[w, h],
		[0, h],
	];
	const m = hNorm(b);
	for (const p of corners) if (m[6]! * p[0] + m[7]! * p[1] + m[8]! <= 1e-9) return 0;
	const quad = corners.map((p) => hApply(b, p));
	const c: P2 = [w / 2, h / 2];
	const fits = (s: number) => {
		const hw = (s * w) / 2;
		const hh = (s * h) / 2;
		const r: P2[] = [
			[c[0] - hw, c[1] - hh],
			[c[0] + hw, c[1] - hh],
			[c[0] + hw, c[1] + hh],
			[c[0] - hw, c[1] + hh],
		];
		return r.every((p) => convexContains(quad, p));
	};
	if (fits(1)) return 1;
	if (!fits(0)) return 0;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 30; i++) {
		const mid = 0.5 * (lo + hi);
		if (fits(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}

type Warp = { h: number[]; mesh: null } | { h: null; mesh: WarpMesh };
const warpValid = (w: Warp, size: P2) => (w.mesh ? w.mesh.validFraction() : validFraction(w.h!, size));
const warpRelax = (w: Warp, l: number): Warp =>
	w.mesh ? { h: null, mesh: w.mesh.lerpIdentity(l) } : { h: hLerp(H_IDENTITY, w.h!, l), mesh: null };
const warpHomography = (w: Warp) => (w.mesh ? w.mesh.homography() : w.h!);

/** Remove the uniform scale of the correspondences' best similarity (Preserve Scale with meshes). */
function unscale(pairs: [P2, P2][]): void {
	const h = leastSquares(
		'similarity',
		pairs.map((p) => p[0]),
		pairs.map((p) => p[1]),
	);
	if (!h) return;
	const k = Math.sqrt(Math.abs(h[0]! * h[4]! - h[1]! * h[3]!));
	if (k < 1e-6) return;
	let cx = 0;
	let cy = 0;
	for (const [, d] of pairs) {
		cx += d[0];
		cy += d[1];
	}
	cx /= pairs.length;
	cy /= pairs.length;
	for (const p of pairs) p[1] = [cx + (p[1][0] - cx) / k, cy + (p[1][1] - cy) / k];
}

/** Subspace Warp's meshes (stabilised → source, before framing); null for the other methods / without tracks. */
export function stabMeshes(a: WarpAnalysis, s: StabSettings, base: readonly H3[]): WarpMesh[] | null {
	if (s.method !== 'subspaceWarp' || !a.tracks.length || base.length !== a.frames.length) return null;
	const n = a.frames.length;
	const o = rippleMesh(s.ripple);
	let pairs: [P2, P2][][];
	if (s.result === 'noMotion') {
		pairs = [];
		for (let t = 0; t < n; t++) {
			const pr: [P2, P2][] = [];
			for (const tr of a.tracks) {
				const p = trackAt(tr, t);
				if (p) pr.push([p, hApply(base[t]!, p)]);
			}
			pairs.push(pr);
		}
	} else {
		const sigma = stabSigma(s);
		if (sigma < 0.3) return Array.from({ length: n }, () => WarpMesh.identity(o.cols, o.rows, a.size));
		pairs = smoothTrajectories(a.tracks, n, sigma, 9);
	}
	return pairs.map((pr, t) => {
		if (s.preserveScale && pr.length >= 2) unscale(pr);
		return pr.length < 6
			? WarpMesh.fromHomography(o.cols, o.rows, a.size, base[t]!)
			: solveMesh(a.size, o, pr, base[t]!);
	});
}

/** The per-frame stabilisation of a clip. */
export type StabPlan = {
	/** Final source → output homography per frame (framing included); for meshes the closest homography. */
	warps: number[][];
	/** Subspace Warp: per frame the mesh (stabilised before framing → source); empty for the other methods. */
	meshes: WarpMesh[];
	/** Framing (auto-scale × Additional Scale about the centre) after the stabilisation. */
	framing: number[];
	/** Visible region in output pixels [x0, y0, x1, y1] (Stabilize, Crop / Auto-scale); null = everything. */
	crop: [number, number, number, number] | null;
	/** Auto-scale factor (1 = none). */
	autoScale: number;
	/** Fraction of the frame (per side) valid on every frame before scaling. */
	validFraction: number;
	/** Frames whose correction was relaxed to respect Maximum Scale. */
	relaxedFrames: number;
};

/** Source position (frame k, analysis px) shown at output point `p`. */
export function planSourceOf(plan: StabPlan, k: number, p: P2): [number, number] | null {
	const m = plan.meshes[k];
	if (m) {
		const inv = hInv(plan.framing);
		return inv ? m.sample(hApply(inv, p)) : null;
	}
	const w = plan.warps[k];
	const inv = w ? hInv(w) : null;
	return inv ? hApply(inv, p) : null;
}

/** Where source point `q` of frame k lands in the output. */
export function planOutputOf(plan: StabPlan, k: number, q: P2): [number, number] | null {
	const m = plan.meshes[k];
	if (m) {
		const p = m.forward(q);
		return p ? hApply(plan.framing, p) : null;
	}
	const w = plan.warps[k];
	return w ? hApply(w, q) : null;
}

/** Stabilisation plan: corrections plus framing. */
export function stabPlan(a: WarpAnalysis, s: StabSettings): StabPlan {
	const base = corrections(a, s);
	const meshes = stabMeshes(a, s, base);
	let b: Warp[] = meshes ? meshes.map((mesh) => ({ h: null, mesh })) : base.map((h) => ({ h, mesh: null }));
	const size = a.size;
	const c: P2 = [size[0] / 2, size[1] / 2];
	const add = Math.max(0.01, s.additionalScale / 100);
	const zAdd = hScaleAbout(add, c);
	let fr = b.map((w) => warpValid(w, size));
	let vmin = fr.reduce((m, v) => Math.min(m, v), 1);
	const margin = Math.max(0, Math.min(0.45, s.actionSafe / 100));
	const needCover = 1 - 2 * margin;
	const maxScale = Math.max(1, s.maxScale / 100);
	let relaxedFrames = 0;
	if (s.framing === 'stabilizeCropAutoScale' && vmin * maxScale < needCover && b.length) {
		const target = needCover / maxScale;
		const n = b.length;
		const lam = b.map((w, t) => {
			if (fr[t]! >= target) return 1;
			let lo = 0;
			let hi = 1;
			for (let i = 0; i < 24; i++) {
				const mid = 0.5 * (lo + hi);
				if (warpValid(warpRelax(w, mid), size) >= target) lo = mid;
				else hi = mid;
			}
			return lo;
		});
		const r = Math.max(1, Math.ceil(stabSigma(s) * 0.5));
		const minf = lam.map((_, t) => {
			let v = 1;
			for (let i = Math.max(0, t - r); i <= Math.min(n - 1, t + r); i++) v = Math.min(v, lam[i]!);
			return v;
		});
		const sig = r / 2;
		const smooth = lam.map((l, t) => {
			let acc = 0;
			let ws = 0;
			for (let i = Math.max(0, t - r); i <= Math.min(n - 1, t + r); i++) {
				const d = i - t;
				const w = Math.exp(-(d * d) / (2 * sig * sig));
				acc += w * minf[i]!;
				ws += w;
			}
			return Math.min(acc / ws, l);
		});
		b = b.map((w, t) => (smooth[t]! >= 1 ? w : warpRelax(w, smooth[t]!)));
		relaxedFrames = smooth.filter((v) => v < 1).length;
		fr = b.map((w) => warpValid(w, size));
		vmin = fr.reduce((m, v) => Math.min(m, v), 1);
	}
	const rect = (k: number): [number, number, number, number] => [
		c[0] - (k * size[0]) / 2,
		c[1] - (k * size[1]) / 2,
		c[0] + (k * size[0]) / 2,
		c[1] + (k * size[1]) / 2,
	];
	let auto = 1;
	let crop: [number, number, number, number] | null = null;
	if (s.framing === 'stabilizeCrop') crop = rect(vmin * add);
	else if (s.framing === 'stabilizeCropAutoScale') {
		auto = vmin > 1e-6 ? Math.max(1, Math.min(maxScale, needCover / vmin)) : maxScale;
		const vis = vmin * auto * add;
		crop = vis >= 1 - 1e-9 ? null : rect(vis);
	}
	const framing = hMul(zAdd, hScaleAbout(auto, c));
	return {
		warps: b.map((w) => hMul(framing, warpHomography(w))),
		meshes: b.flatMap((w) => (w.mesh ? [w.mesh] : [])),
		framing,
		crop,
		autoScale: auto,
		validFraction: vmin,
		relaxedFrames,
	};
}

/**
 * The homography taking frame `from`'s source pixels to frame `to`'s (the analysed perspective motion chained):
 * Synthesize Edges reads neighbouring frames through it.
 */
export function frameToFrame(a: WarpAnalysis, from: number, to: number): number[] {
	let h = H_IDENTITY.slice();
	const n = a.frames.length;
	const f = Math.max(0, Math.min(n - 1, from));
	const t = Math.max(0, Math.min(n - 1, to));
	if (t > f) for (let i = f + 1; i <= t; i++) h = hMul(motionOf(a.frames[i]!, 'perspective'), h);
	else
		for (let i = f; i > t; i--)
			h = hMul(hInv(motionOf(a.frames[i]!, 'perspective')) ?? H_IDENTITY.slice(), h);
	return h;
}
