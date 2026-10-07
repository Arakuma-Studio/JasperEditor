// Mask tracker `mask-klt@1` (wp masks; Premiere's Track Selected Mask; the approach of effectcraft
// `crates/track/src/mask.rs`, MIT OR Apache-2.0, see licenses/ported/masks.md). Runs inside the tracking worker with
// OpenCV.js. Frame to frame (forward or backward):
// 1. Shi–Tomasi corners of the previous frame inside the current mask outline (a scanline-filled polygon mask over
//    the outline's bounds);
// 2. pyramidal Lucas–Kanade into the next frame with a forward–backward check (≤ fbMax px);
// 3. the motion model fitted robustly: Position = median translation; Position & Rotation = RANSAC rigid motion;
//    Position, Scale & Rotation = RANSAC similarity (2-point samples, least-squares refit on the inliers, Umeyama);
//    Perspective = OpenCV RANSAC homography (falls back to the similarity with fewer than 8 matches);
// 4. the outline moves by the step; the result is the accumulated homography reference → frame.
// Too few features (or a degenerate fit) = lost: the last motion is kept, confidence 0.
//
// WORKER-SAFE: evaluated from its source text in the worker. It may only use its parameters and JS globals.
import type * as Geometry from './geometry.ts';

export type MaskTrackMethod = 'position' | 'position-rotation' | 'position-scale-rotation' | 'perspective';

export type MaskConfig = {
	kind: 'mask';
	width: number;
	height: number;
	/** Outline at the reference frame, tracking px (x, y interleaved, closed). */
	polygon: number[];
	method: MaskTrackMethod;
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

export function createMaskTracker(cv: CV, G: typeof Geometry, cfg: MaskConfig) {
	const W = cfg.width;
	const H = cfg.height;
	let prev: CV = null;
	let outline: number[] = cfg.polygon.slice();
	let total: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const win = new cv.Size(cfg.winSize, cfg.winSize);
	const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);

	function bounds(p: number[]) {
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < p.length; i += 2) {
			x0 = Math.min(x0, p[i]!);
			x1 = Math.max(x1, p[i]!);
			y0 = Math.min(y0, p[i + 1]!);
			y1 = Math.max(y1, p[i + 1]!);
		}
		return { x0, y0, x1, y1 };
	}

	/** Scanline fill of the outline into a `w × h` mask at offset (ox, oy) (even–odd). */
	function polygonMask(p: number[], ox: number, oy: number, w: number, h: number): Uint8Array {
		const m = new Uint8Array(w * h);
		const n = p.length / 2;
		const xs: number[] = [];
		for (let y = 0; y < h; y++) {
			const py = oy + y + 0.5;
			xs.length = 0;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				const ay = p[2 * i + 1]!;
				const by = p[2 * j + 1]!;
				if (ay <= py !== by <= py) xs.push(p[2 * i]! + ((py - ay) * (p[2 * j]! - p[2 * i]!)) / (by - ay));
			}
			xs.sort((a, b) => a - b);
			for (let k = 0; k + 1 < xs.length; k += 2) {
				const a = Math.max(0, Math.ceil(xs[k]! - ox - 0.5));
				const b = Math.min(w - 1, Math.floor(xs[k + 1]! - ox - 0.5));
				for (let x = a; x <= b; x++) m[y * w + x] = 255;
			}
		}
		return m;
	}

	let seed = 0x5eed;
	const rnd = (n: number) => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return seed % n;
	};

	/** Least-squares similarity (Umeyama) of point pairs; `rigid` fixes the scale to 1. */
	function similarityFit(src: number[], dst: number[], idx: number[], rigid: boolean): number[] | null {
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
		const r = Math.hypot(a, b);
		if (r < 1e-12) return null;
		const s = rigid ? 1 : r / ss;
		const c = (a / r) * s;
		const sn = (b / r) * s;
		return [c, -sn, nx - (c * mx - sn * my), sn, c, ny - (sn * mx + c * my), 0, 0, 1];
	}

	function residual(Hm: number[], src: number[], dst: number[], i: number): number {
		const q = G.hApply(Hm, src[2 * i]!, src[2 * i + 1]!);
		return Math.hypot(q[0] - dst[2 * i]!, q[1] - dst[2 * i + 1]!);
	}

	function ransacSimilarity(
		src: number[],
		dst: number[],
		rigid: boolean,
	): { H: number[]; inliers: number } | null {
		const n = src.length / 2;
		let best: number[] = [];
		for (let it = 0; it < 300; it++) {
			const i = rnd(n);
			let j = rnd(n);
			if (j === i) j = (i + 1) % n;
			const Hm = similarityFit(src, dst, [i, j], rigid);
			if (!Hm) continue;
			const inl: number[] = [];
			for (let k = 0; k < n; k++) if (residual(Hm, src, dst, k) <= cfg.threshold) inl.push(k);
			if (inl.length > best.length) best = inl;
		}
		if (best.length < 3) return null;
		const Hm = similarityFit(src, dst, best, rigid);
		if (!Hm) return null;
		const inl: number[] = [];
		for (let k = 0; k < n; k++) if (residual(Hm, src, dst, k) <= cfg.threshold) inl.push(k);
		const refit = similarityFit(src, dst, inl.length >= 3 ? inl : best, rigid);
		return refit ? { H: refit, inliers: inl.length } : null;
	}

	function translationFit(src: number[], dst: number[]): { H: number[]; inliers: number } | null {
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
		for (let i = 0; i < n; i++) if (Math.hypot(dx[i]! - tx, dy[i]! - ty) <= cfg.threshold) inl.push(i);
		if (inl.length < 3) return null;
		tx = inl.reduce((s, i) => s + dx[i]!, 0) / inl.length;
		ty = inl.reduce((s, i) => s + dy[i]!, 0) / inl.length;
		return { H: [1, 0, tx, 0, 1, ty, 0, 0, 1], inliers: inl.length };
	}

	function homographyFit(src: number[], dst: number[]): { H: number[]; inliers: number } | null {
		const n = src.length / 2;
		if (n < 8) return ransacSimilarity(src, dst, false);
		const s = cv.matFromArray(n, 1, cv.CV_32FC2, src);
		const d = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
		const mask = new cv.Mat();
		let Hm: CV = null;
		try {
			Hm = cv.findHomography(s, d, cv.RANSAC, cfg.threshold, mask, 2000, 0.995);
			if (!Hm || Hm.empty() || Hm.rows !== 3) return ransacSimilarity(src, dst, false);
			const h = G.hNormalize(Array.from(Hm.data64F as Float64Array));
			if (!h.every(Number.isFinite)) return ransacSimilarity(src, dst, false);
			let inl = 0;
			for (let i = 0; i < n; i++) if (mask.data[i]) inl++;
			return inl >= 8 ? { H: h, inliers: inl } : ransacSimilarity(src, dst, false);
		} finally {
			s.delete();
			d.delete();
			mask.delete();
			Hm?.delete();
		}
	}

	function result(confidence: number, lost: boolean) {
		return { values: total.slice(), confidence, lost };
	}

	return {
		reference(img: Uint8Array) {
			prev?.delete();
			prev = new cv.Mat(H, W, cv.CV_8UC1);
			prev.data.set(img);
			outline = cfg.polygon.slice();
			total = [1, 0, 0, 0, 1, 0, 0, 0, 1];
			return result(1, false);
		},
		track(img: Uint8Array) {
			if (!prev) throw new Error('tracker has no reference');
			const cur = new cv.Mat(H, W, cv.CV_8UC1);
			cur.data.set(img);
			try {
				const b = bounds(outline);
				const x0 = Math.max(0, Math.floor(b.x0));
				const y0 = Math.max(0, Math.floor(b.y0));
				const x1 = Math.min(W, Math.ceil(b.x1));
				const y1 = Math.min(H, Math.ceil(b.y1));
				const rw = x1 - x0;
				const rh = y1 - y0;
				if (rw < 4 || rh < 4) return result(0, true);
				const mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(0));
				const m = polygonMask(outline, x0, y0, rw, rh);
				for (let y = 0; y < rh; y++) mask.data.set(m.subarray(y * rw, (y + 1) * rw), (y0 + y) * W + x0);
				const area = m.reduce((s, v) => s + (v ? 1 : 0), 0);
				const corners = new cv.Mat();
				const md = Math.max(3, Math.min(cfg.minDistance, Math.sqrt(area / 400)));
				cv.goodFeaturesToTrack(prev, corners, cfg.maxFeatures, cfg.qualityLevel, md, mask, 3, false, 0.04);
				mask.delete();
				const n = corners.rows;
				if (n < 3) {
					corners.delete();
					return result(0, true);
				}
				const p1 = new cv.Mat();
				const st1 = new cv.Mat();
				const e1 = new cv.Mat();
				const pb = new cv.Mat();
				const st2 = new cv.Mat();
				const e2 = new cv.Mat();
				const src: number[] = [];
				const dst: number[] = [];
				try {
					cv.calcOpticalFlowPyrLK(prev, cur, corners, p1, st1, e1, win, cfg.maxLevel, crit);
					cv.calcOpticalFlowPyrLK(cur, prev, p1, pb, st2, e2, win, cfg.maxLevel, crit);
					const a = corners.data32F;
					const q = p1.data32F;
					const r = pb.data32F;
					for (let i = 0; i < n; i++) {
						if (!st1.data[i] || !st2.data[i]) continue;
						if (Math.hypot(r[2 * i] - a[2 * i], r[2 * i + 1] - a[2 * i + 1]) > cfg.fbMax) continue;
						src.push(a[2 * i], a[2 * i + 1]);
						dst.push(q[2 * i], q[2 * i + 1]);
					}
				} finally {
					corners.delete();
					p1.delete();
					st1.delete();
					e1.delete();
					pb.delete();
					st2.delete();
					e2.delete();
				}
				const count = src.length / 2;
				const fit =
					cfg.method === 'position'
						? translationFit(src, dst)
						: cfg.method === 'position-rotation'
							? ransacSimilarity(src, dst, true)
							: cfg.method === 'position-scale-rotation'
								? ransacSimilarity(src, dst, false)
								: homographyFit(src, dst);
				if (!fit || fit.inliers < 3 || fit.inliers * 3 < count) return result(0, true);
				total = G.hNormalize(G.hMul(fit.H, total));
				const next: number[] = [];
				for (let i = 0; i < outline.length; i += 2) {
					const pt = G.hApply(fit.H, outline[i]!, outline[i + 1]!);
					next.push(pt[0], pt[1]);
				}
				outline = next;
				return result(Math.min(1, fit.inliers / Math.max(1, n)), false);
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
