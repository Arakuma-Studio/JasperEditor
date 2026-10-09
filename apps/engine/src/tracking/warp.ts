// Warp Stabilizer analysis tracker `warp-klt@1` (workstream gaps, docs/wp-notes/gaps.md §FX-6; the analysis of
// effectcraft `crates/track/src/stabilize.rs`, MIT OR Apache-2.0, licenses/ported/gaps.md). Runs inside the tracking
// worker with OpenCV.js, frame to frame over the whole clip:
// 1. Shi–Tomasi corners spread over the frame (minimum distance ∝ frame size); features keep their id while they are
//    tracked, so they form trajectories (Subspace Warp's input); lost ones are replaced by fresh corners away from
//    the survivors;
// 2. pyramidal Lucas–Kanade into the next frame with a forward–backward check;
// 3. the dominant (background) motion between the two frames fitted robustly for three models at once: translation
//    (median + inlier mean), similarity (2-point RANSAC + least squares, Umeyama) and homography (OpenCV RANSAC; the
//    similarity when there are too few matches).
// Result values per frame: [tx, ty, a, b, stx, sty, h0…h7, inliers, features, n, (id, x, y) × n], tracking px.
//
// WORKER-SAFE: evaluated from its source text in the worker. It may only use its parameters and JS globals.
import type * as Geometry from './geometry.ts';

export type WarpConfig = {
	kind: 'warp';
	width: number;
	height: number;
	maxFeatures: number;
	qualityLevel: number;
	minDistance: number;
	winSize: number;
	maxLevel: number;
	fbMax: number;
	/** RANSAC inlier distance (tracking px). */
	threshold: number;
};

type CV = any;

export function createWarpTracker(cv: CV, G: typeof Geometry, cfg: WarpConfig) {
	const W = cfg.width;
	const H = cfg.height;
	let prev: CV = null;
	/** Active features: x, y interleaved, and their ids. */
	let pts: number[] = [];
	let ids: number[] = [];
	let nextId = 0;
	const win = new cv.Size(cfg.winSize, cfg.winSize);
	const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);

	let seed = 0x5eed;
	const rnd = (n: number) => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return seed % n;
	};

	function similarityFit(src: number[], dst: number[], idx: number[]): number[] | null {
		const n = idx.length;
		if (n < 2) return null;
		let mx = 0;
		let my = 0;
		let nx = 0;
		let ny = 0;
		for (const i of idx) {
			mx += src[2 * i]!;
			my += src[2 * i + 1]!;
			nx += dst[2 * i]!;
			ny += dst[2 * i + 1]!;
		}
		mx /= n;
		my /= n;
		nx /= n;
		ny /= n;
		let a = 0;
		let b = 0;
		let ss = 0;
		for (const i of idx) {
			const px = src[2 * i]! - mx;
			const py = src[2 * i + 1]! - my;
			const qx = dst[2 * i]! - nx;
			const qy = dst[2 * i + 1]! - ny;
			a += px * qx + py * qy;
			b += px * qy - py * qx;
			ss += px * px + py * py;
		}
		if (ss < 1e-9) return null;
		const c = a / ss;
		const s = b / ss;
		if (Math.hypot(c, s) < 1e-9) return null;
		return [c, -s, nx - (c * mx - s * my), s, c, ny - (s * mx + c * my), 0, 0, 1];
	}

	const residual = (Hm: number[], src: number[], dst: number[], i: number) => {
		const q = G.hApply(Hm, src[2 * i]!, src[2 * i + 1]!);
		return Math.hypot(q[0] - dst[2 * i]!, q[1] - dst[2 * i + 1]!);
	};

	function ransacSimilarity(src: number[], dst: number[]): { H: number[]; inliers: number } | null {
		const n = src.length / 2;
		if (n < 3) return null;
		let best: number[] = [];
		for (let it = 0; it < 300; it++) {
			const i = rnd(n);
			let j = rnd(n);
			if (j === i) j = (i + 1) % n;
			const Hm = similarityFit(src, dst, [i, j]);
			if (!Hm) continue;
			const inl: number[] = [];
			for (let k = 0; k < n; k++) if (residual(Hm, src, dst, k) <= cfg.threshold * 1.5) inl.push(k);
			if (inl.length > best.length) best = inl;
		}
		if (best.length < 3) return null;
		const Hm = similarityFit(src, dst, best);
		return Hm ? { H: Hm, inliers: best.length } : null;
	}

	function translationFit(src: number[], dst: number[]): number[] | null {
		const n = src.length / 2;
		if (n < 3) return null;
		const dx: number[] = [];
		const dy: number[] = [];
		for (let i = 0; i < n; i++) {
			dx.push(dst[2 * i]! - src[2 * i]!);
			dy.push(dst[2 * i + 1]! - src[2 * i + 1]!);
		}
		const med = (v: number[]) => {
			const s = v.slice().sort((a, b) => a - b);
			const m = s.length >> 1;
			return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
		};
		let tx = med(dx);
		let ty = med(dy);
		const inl: number[] = [];
		for (let i = 0; i < n; i++) if (Math.hypot(dx[i]! - tx, dy[i]! - ty) <= cfg.threshold * 1.5) inl.push(i);
		if (inl.length >= 3) {
			tx = inl.reduce((s, i) => s + dx[i]!, 0) / inl.length;
			ty = inl.reduce((s, i) => s + dy[i]!, 0) / inl.length;
		}
		return [tx, ty];
	}

	function homographyFit(src: number[], dst: number[]): { H: number[]; inliers: number } | null {
		const n = src.length / 2;
		if (n < 8) return null;
		const s = cv.matFromArray(n, 1, cv.CV_32FC2, src);
		const d = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
		const mask = new cv.Mat();
		let Hm: CV = null;
		try {
			Hm = cv.findHomography(s, d, cv.RANSAC, cfg.threshold, mask, 2000, 0.995);
			if (!Hm || Hm.empty() || Hm.rows !== 3) return null;
			const h = G.hNormalize(Array.from(Hm.data64F as Float64Array));
			if (!h.every(Number.isFinite)) return null;
			let inl = 0;
			for (let i = 0; i < n; i++) if (mask.data[i]) inl++;
			return inl >= 8 ? { H: h, inliers: inl } : null;
		} finally {
			s.delete();
			d.delete();
			mask.delete();
			Hm?.delete();
		}
	}

	/** Fresh corners of `img` away from the active features, up to the budget. */
	function replenish(img: CV): void {
		const want = cfg.maxFeatures - ids.length;
		if (want < cfg.maxFeatures * 0.1) return;
		const mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
		const r = Math.max(2, Math.round(cfg.minDistance));
		for (let i = 0; i < pts.length; i += 2)
			cv.circle(mask, new cv.Point(Math.round(pts[i]!), Math.round(pts[i + 1]!)), r, new cv.Scalar(0), -1);
		const corners = new cv.Mat();
		try {
			cv.goodFeaturesToTrack(img, corners, want, cfg.qualityLevel, cfg.minDistance, mask, 3, false, 0.04);
			const c = corners.data32F;
			for (let i = 0; i < corners.rows; i++) {
				pts.push(c[2 * i], c[2 * i + 1]);
				ids.push(nextId++);
			}
		} finally {
			mask.delete();
			corners.delete();
		}
	}

	function result(t: number[], s: number[], h: number[], inliers: number, features: number) {
		const values = [
			t[0]!,
			t[1]!,
			s[0]!,
			s[3]!,
			s[2]!,
			s[5]!,
			...h.slice(0, 8),
			inliers,
			features,
			ids.length,
		];
		for (let i = 0; i < ids.length; i++) values.push(ids[i]!, pts[2 * i]!, pts[2 * i + 1]!);
		return { values, confidence: features ? inliers / features : 0, lost: features < 8 };
	}

	const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

	return {
		reference(img: Uint8Array) {
			prev?.delete();
			prev = new cv.Mat(H, W, cv.CV_8UC1);
			prev.data.set(img);
			pts = [];
			ids = [];
			replenish(prev);
			return result([0, 0], IDENT, IDENT, 0, 0);
		},
		track(img: Uint8Array) {
			if (!prev) throw new Error('tracker has no reference');
			const cur = new cv.Mat(H, W, cv.CV_8UC1);
			cur.data.set(img);
			try {
				const n = ids.length;
				const src: number[] = [];
				const dst: number[] = [];
				const keptPts: number[] = [];
				const keptIds: number[] = [];
				if (n > 0) {
					const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, pts);
					const p1 = new cv.Mat();
					const st1 = new cv.Mat();
					const e1 = new cv.Mat();
					const pb = new cv.Mat();
					const st2 = new cv.Mat();
					const e2 = new cv.Mat();
					try {
						cv.calcOpticalFlowPyrLK(prev, cur, p0, p1, st1, e1, win, cfg.maxLevel, crit);
						cv.calcOpticalFlowPyrLK(cur, prev, p1, pb, st2, e2, win, cfg.maxLevel, crit);
						const q = p1.data32F;
						const r = pb.data32F;
						for (let i = 0; i < n; i++) {
							if (!st1.data[i] || !st2.data[i]) continue;
							if (Math.hypot(r[2 * i] - pts[2 * i]!, r[2 * i + 1] - pts[2 * i + 1]!) > cfg.fbMax) continue;
							const x = q[2 * i];
							const y = q[2 * i + 1];
							if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) continue;
							src.push(pts[2 * i]!, pts[2 * i + 1]!);
							dst.push(x, y);
							keptPts.push(x, y);
							keptIds.push(ids[i]!);
						}
					} finally {
						p0.delete();
						p1.delete();
						st1.delete();
						e1.delete();
						pb.delete();
						st2.delete();
						e2.delete();
					}
				}
				const count = src.length / 2;
				const t = translationFit(src, dst) ?? [0, 0];
				const sim = ransacSimilarity(src, dst);
				const s = sim?.H ?? [1, 0, t[0]!, 0, 1, t[1]!, 0, 0, 1];
				const hom = homographyFit(src, dst);
				const h = hom?.H ?? s;
				pts = keptPts;
				ids = keptIds;
				replenish(cur);
				return result(t, s, h, hom?.inliers ?? sim?.inliers ?? 0, count);
			} finally {
				prev.delete();
				prev = cur;
			}
		},
		dispose() {
			prev?.delete();
			prev = null;
		},
	};
}
