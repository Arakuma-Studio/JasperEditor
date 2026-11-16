import type { Mat } from '@techstark/opencv-js';
import type { OpenCvApi } from '../tools/opencv.ts';
import type * as Align from './align.ts';
// Planar tracker `klt-homography@2` (S09:TRK-012). Runs inside the tracking worker with OpenCV.js.
//
// 1. Reference frame: Shi–Tomasi corners inside the reference quad (or in a ring 5–25 % outside it, or both), and a
//    dense template pyramid of the same region (align.ts). Hold-out regions of the frame are excluded from both.
// 2. Every frame: a crop around the plane predicted by a constant-velocity model is decoded into a 4-level pyramid
//    (only that crop is processed). KLT stage, at the pyramid level `kltLevel` (half resolution above 1280 px): the
//    crop is pre-warped into the anchor's geometry with the prediction, so pyramidal Lucas–Kanade only has to recover
//    the residual motion of the anchor's features, then a forward–backward check. Matches in a hold-out region are
//    dropped. The matches are mapped back into the frame, so the homography is measured from the anchor (the
//    reference frame itself unless re-anchored) directly: prediction errors never accumulate.
// 3. RANSAC homography (reprojection threshold `ransacThreshold` KLT-level px).
// 4. Dense stage (`dense`): robust inverse-compositional alignment of the reference template to the frame from the
//    KLT estimate (or from the prediction when the KLT stage failed, e.g. on a blurred frame where corners do not
//    survive), coarse to fine; Tukey-weighted residuals ignore occluders, hold-out pixels are skipped. The reference
//    template is tried first (no drift), the current anchor's when the reference no longer matches.
// 5. Survival < 30 %: re-anchor on the last good frame with fresh features (chained); every few frames the
//    reference anchor is tried again so the chain does not stay.
// 6. Confidence: dense — correlation × √(inlier share) × in-frame share; KLT only — inlier ratio × (1 − normalised
//    error) over the features that are in the frame and not held out. Per-frame edge refinement (`refineEdges`).
//
// WORKER-SAFE: evaluated from its source text in the worker. It may only use its parameters (`cv`, `G` = the
// geometry and alignment helpers, `cfg`) and JS globals.
import type * as Geometry from './geometry.ts';

export type PlanarConfig = {
	kind: 'planar';
	/** Tracking frame size. */
	width: number;
	height: number;
	/** Reference corners TL, TR, BR, BL in tracking px (8 numbers). */
	corners: number[];
	features: 'inside' | 'surroundings' | 'both';
	refineEdges: boolean;
	/** Robust dense refinement of the plane (align.ts). */
	dense: boolean;
	/** Pyramid level of the KLT stage (0 = tracking resolution, 1 = half). */
	kltLevel: number;
	maxFeatures: number;
	qualityLevel: number;
	/** KLT-level px. */
	minDistance: number;
	winSize: number;
	/** LK pyramid levels − 1. */
	maxLevel: number;
	fbMax: number;
	/** KLT-level px. */
	ransacThreshold: number;
	minSurvival: number;
};

export type FrameResult = {
	/** Geometry in tracking px (planar: 8 numbers; point: 2). */
	values: number[];
	confidence: number;
	lost: boolean;
};

export type FrameTracker = {
	/** `hold`: hold-out mask of the frame (tracking px, 1 = ignore), when the request has hold-out regions. */
	reference(img: Uint8Array, hold?: Uint8Array | null): FrameResult;
	track(img: Uint8Array, hold?: Uint8Array | null): FrameResult;
	dispose(): void;
};

export function createPlanarTracker(
	cv: OpenCvApi,
	G: typeof Geometry & typeof Align,
	cfg: PlanarConfig,
): FrameTracker {
	const W = cfg.width;
	const H = cfg.height;
	const K = cfg.kltLevel;
	const KS = 2 ** K;
	const LEVELS = 4;
	const TEMPLATE_PTS = [8000, 5000, 3000, 1500];
	const ITERS = [5, 6, 8, 12];
	const frame = new cv.Mat(H, W, cv.CV_8UC1);
	const lastGoodMat = new cv.Mat(H, W, cv.CV_8UC1);
	const win = new cv.Size(cfg.winSize, cfg.winSize);
	const lkCriteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 20, 0.03);
	const EDGE = { band: 4, n: 48, maxShift: 3, maxResidual: 0.75, minFraction: 0.35, minContrast: 2 };
	const EDGE_REF = { band: 6, n: 48, maxShift: 6, maxResidual: 1, minFraction: 0.35, minContrast: 2 };

	type Anchor = {
		/** Anchor ROI at the KLT level. */
		kimg: Mat;
		ptsRoi: Mat;
		/** Feature positions in the anchor frame (tracking px, x, y interleaved). */
		pts: Float64Array;
		n: number;
		/** ROI in tracking px. */
		roi: { x: number; y: number; w: number; h: number };
		/** Dense template per pyramid level (finest first). */
		levels: (Align.AlignLevel | null)[];
		/** Reference → anchor frame. */
		H: number[];
		seq: number;
	};
	type Measured = {
		ok: boolean;
		H: number[];
		inliers: number;
		/** Features in the frame and outside the hold-out (the confidence's denominator). */
		total: number;
		survival: number;
		meanErr: number;
	};
	type Pyramid = {
		/** Level k image (level 0 only once smoothed for the dense stage). */
		images: (Align.AlignImage | null)[];
		mats: Mat[];
		rect: { x: number; y: number; w: number; h: number };
	};

	let refQuad: number[] = cfg.corners.slice();
	let refAnchor: Anchor | null = null;
	let anchor: Anchor | null = null;
	let modes: (Geometry.EdgeMode | null)[] = [null, null, null, null];
	let last: { H: number[]; quad: number[]; out: number[] } | null = null;
	let prevH: number[] | null = null;
	let lostRun = 0;
	let goodSeq = 0;
	let sinceAnchor = 0;
	let hold: Uint8Array | null = null;
	let lastGoodHold: Uint8Array | null = null;

	const held = (h: Uint8Array | null, x: number, y: number): boolean => {
		if (!h) return false;
		const xi = Math.round(x);
		const yi = Math.round(y);
		return xi >= 0 && yi >= 0 && xi < W && yi < H && h[yi * W + xi] === 1;
	};

	function freeAnchor(a: Anchor | null): void {
		if (!a) return;
		a.kimg.delete();
		a.ptsRoi.delete();
	}

	/**
	 * Pyramid of the frame crop `rect` (tracking px), levels 1–3 (pyrDown). Level 0 (`images[0]`) is filled in by
	 * `smoothLevel0` for the dense stage only.
	 */
	function buildPyramid(src: Mat, rect: { x: number; y: number; w: number; h: number }): Pyramid {
		const images: (Align.AlignImage | null)[] = [null];
		const mats: Mat[] = [];
		const view = src.roi(new cv.Rect(rect.x, rect.y, rect.w, rect.h));
		let prev: Mat = view;
		for (let L = 1; L < LEVELS; L++) {
			if (prev.cols < 16 || prev.rows < 16) break;
			const m = new cv.Mat();
			cv.pyrDown(prev, m);
			mats.push(m);
			images.push({
				data: m.data.slice(),
				w: m.cols,
				h: m.rows,
				ox: rect.x / 2 ** L,
				oy: rect.y / 2 ** L,
				level: L,
			});
			prev = m;
		}
		view.delete();
		return { images, mats, rect };
	}

	/** Smoothed level 0 of the frame over the plane `quad` would cover (plus a margin), for the dense stage. */
	function smoothLevel0(img: Uint8Array, pyr: Pyramid, quad: number[]): void {
		const b = G.quadBounds(cfg.features === 'inside' ? quad : G.quadScale(quad, 1.25));
		const x0 = Math.max(0, Math.floor(b.x0 - 24));
		const y0 = Math.max(0, Math.floor(b.y0 - 24));
		const x1 = Math.min(W, Math.ceil(b.x1 + 24));
		const y1 = Math.min(H, Math.ceil(b.y1 + 24));
		if (x1 - x0 < 8 || y1 - y0 < 8) return;
		pyr.images[0] = {
			data: G.alignBlur5(img, W, H, x0, y0, x1 - x0, y1 - y0),
			w: x1 - x0,
			h: y1 - y0,
			ox: x0,
			oy: y0,
			level: 0,
		};
	}

	function freePyramid(p: Pyramid): void {
		for (const m of p.mats) m.delete();
	}

	/** Crop around the feature region of `quad` (tracking px) with room for the KLT search, clipped to the frame. */
	function cropAround(quad: number[]): { x: number; y: number; w: number; h: number } | null {
		const b = G.quadBounds(cfg.features === 'inside' ? quad : G.quadScale(quad, 1.25));
		const m = Math.max(48, 0.15 * Math.max(b.x1 - b.x0, b.y1 - b.y0));
		const x0 = Math.max(0, Math.floor((b.x0 - m) / 8) * 8);
		const y0 = Math.max(0, Math.floor((b.y0 - m) / 8) * 8);
		const x1 = Math.min(W, Math.ceil(b.x1 + m));
		const y1 = Math.min(H, Math.ceil(b.y1 + m));
		if (x1 - x0 < 32 || y1 - y0 < 32) return null;
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	}

	function makeAnchor(src: Mat, Hra: number[], h: Uint8Array | null): Anchor | null {
		const quad = G.quadApply(Hra, refQuad);
		const roi0 = G.featureRoi(quad, cfg.features, cfg.winSize * KS + 8, W, H);
		if (!roi0) return null;
		// Align the ROI to the pyramid grid so level px stay exact multiples.
		const x = Math.floor(roi0.x / 8) * 8;
		const y = Math.floor(roi0.y / 8) * 8;
		const roi = { x, y, w: roi0.x + roi0.w - x, h: roi0.y + roi0.h - y };
		let minSide = Number.POSITIVE_INFINITY;
		for (let k = 0; k < 4; k++) {
			const j = (k + 1) % 4;
			minSide = Math.min(
				minSide,
				Math.hypot(quad[2 * j]! - quad[2 * k]!, quad[2 * j + 1]! - quad[2 * k + 1]!),
			);
		}
		const view = src.roi(new cv.Rect(roi.x, roi.y, roi.w, roi.h));
		const lv: Mat[] = [];
		const img0 = new cv.Mat();
		view.copyTo(img0); // Mat.clone() of this OpenCV.js build shares the data
		view.delete();
		lv.push(img0);
		for (let L = 1; L < LEVELS; L++) {
			const p = lv[L - 1]!;
			if (p.cols < 16 || p.rows < 16) break;
			const m = new cv.Mat();
			cv.pyrDown(p, m);
			lv.push(m);
		}
		const levelMask = (L: number, inset: number): Uint8Array => {
			const m = lv[L]!;
			const s = 2 ** L;
			const lroi = { x: roi.x / s, y: roi.y / s, w: m.cols, h: m.rows };
			const mask = G.featureMask(
				quad.map((v) => v / s),
				lroi,
				cfg.features,
				inset,
			);
			if (h)
				for (let r = 0; r < m.rows; r++)
					for (let c = 0; c < m.cols; c++)
						if (mask[r * m.cols + c] && held(h, roi.x + s * c, roi.y + s * r)) mask[r * m.cols + c] = 0;
			return mask;
		};
		// KLT features at the KLT level.
		const kimg = lv[Math.min(K, lv.length - 1)]!;
		const inset = Math.min(cfg.winSize / 2, Math.max(2, (0.12 * minSide) / KS));
		const kmask = new cv.Mat(kimg.rows, kimg.cols, cv.CV_8UC1);
		kmask.data.set(levelMask(Math.min(K, lv.length - 1), inset));
		const corners = new cv.Mat();
		cv.goodFeaturesToTrack(
			kimg,
			corners,
			cfg.maxFeatures,
			cfg.qualityLevel,
			cfg.minDistance,
			kmask,
			3,
			false,
			0.04,
		);
		kmask.delete();
		const n = corners.rows;
		const levels: (Align.AlignLevel | null)[] = [];
		if (cfg.dense)
			for (let L = 0; L < lv.length; L++) {
				const m = lv[L]!;
				const s = 2 ** L;
				const data = L === 0 ? G.alignBlur5(m.data, m.cols, m.rows, 0, 0, m.cols, m.rows) : m.data;
				levels.push(
					G.alignBuildLevel(data, m.cols, m.rows, roi.x / s, roi.y / s, L, levelMask(L, 2), TEMPLATE_PTS[L]!),
				);
			}
		for (const m of lv) if (m !== kimg) m.delete();
		if (n < 8) {
			corners.delete();
			kimg.delete();
			return null;
		}
		const pts = new Float64Array(2 * n);
		const d = corners.data32F;
		for (let i = 0; i < n; i++) {
			pts[2 * i] = roi.x + KS * d[2 * i];
			pts[2 * i + 1] = roi.y + KS * d[2 * i + 1];
		}
		return { kimg, ptsRoi: corners, pts, n, roi, levels, H: Hra.slice(), seq: goodSeq };
	}

	function measure(a: Anchor, Hpred: number[], pyr: Pyramid): Measured {
		const fail = (count: number, total: number): Measured => ({
			ok: false,
			H: Hpred,
			inliers: 0,
			total,
			survival: total ? count / total : 0,
			meanErr: 0,
		});
		const kmat = K === 0 || pyr.mats.length < K ? null : pyr.mats[K - 1]!;
		const kox = kmat ? pyr.rect.x / KS : pyr.rect.x;
		const koy = kmat ? pyr.rect.y / KS : pyr.rect.y;
		// Anchor KLT-level ROI px → anchor tracking px → frame tracking px (prediction) → frame KLT-level crop px.
		const U = [KS, 0, a.roi.x, 0, KS, a.roi.y, 0, 0, 1];
		const toFrame = G.hMul(G.hMul(Hpred, G.hInv(a.H)), U);
		const D = kmat ? [1 / KS, 0, -kox, 0, 1 / KS, -koy, 0, 0, 1] : [1, 0, -kox, 0, 1, -koy, 0, 0, 1];
		const M = G.hMul(D, toFrame);
		if (!M.every(Number.isFinite) || !toFrame.every(Number.isFinite)) return fail(0, a.n);
		// Features the prediction puts inside the frame and outside the hold-out.
		let total = 0;
		const eligible = new Uint8Array(a.n);
		const pd = a.ptsRoi.data32F;
		for (let i = 0; i < a.n; i++) {
			const q = G.hApply(toFrame, pd[2 * i], pd[2 * i + 1]);
			if (!(q[0] >= 0 && q[1] >= 0 && q[0] <= W - 1 && q[1] <= H - 1)) continue;
			if (held(hold, q[0], q[1])) continue;
			eligible[i] = 1;
			total++;
		}
		if (total < 8) return fail(0, Math.max(total, 1));
		let srcMat: Mat;
		let ownSrc = false;
		if (kmat) srcMat = kmat;
		else {
			srcMat = frame.roi(new cv.Rect(pyr.rect.x, pyr.rect.y, pyr.rect.w, pyr.rect.h));
			ownSrc = true;
		}
		const Mm = cv.matFromArray(3, 3, cv.CV_64F, M);
		const warped = new cv.Mat();
		cv.warpPerspective(
			srcMat,
			warped,
			Mm,
			new cv.Size(a.kimg.cols, a.kimg.rows),
			cv.INTER_LINEAR + cv.WARP_INVERSE_MAP,
			cv.BORDER_REPLICATE,
			new cv.Scalar(),
		);
		Mm.delete();
		if (ownSrc) srcMat.delete();
		const p1 = new cv.Mat();
		const st1 = new cv.Mat();
		const e1 = new cv.Mat();
		const pb = new cv.Mat();
		const st2 = new cv.Mat();
		const e2 = new cv.Mat();
		const src: number[] = [];
		const dst: number[] = [];
		const r = (cfg.winSize * KS) / 2;
		try {
			cv.calcOpticalFlowPyrLK(a.kimg, warped, a.ptsRoi, p1, st1, e1, win, cfg.maxLevel, lkCriteria);
			cv.calcOpticalFlowPyrLK(warped, a.kimg, p1, pb, st2, e2, win, cfg.maxLevel, lkCriteria);
			const p0d = a.ptsRoi.data32F;
			const p1d = p1.data32F;
			const pbd = pb.data32F;
			for (let i = 0; i < a.n; i++) {
				if (!eligible[i] || !st1.data[i] || !st2.data[i]) continue;
				const x = p1d[2 * i];
				const y = p1d[2 * i + 1];
				if (!(x >= 0 && y >= 0 && x <= a.kimg.cols - 1 && y <= a.kimg.rows - 1)) continue;
				if (Math.hypot(pbd[2 * i] - p0d[2 * i], pbd[2 * i + 1] - p0d[2 * i + 1]) > cfg.fbMax) continue;
				const q = G.hApply(toFrame, x, y);
				// The feature's LK window must not touch the hold-out.
				if (
					hold &&
					(held(hold, q[0], q[1]) ||
						held(hold, q[0] - r, q[1] - r) ||
						held(hold, q[0] + r, q[1] - r) ||
						held(hold, q[0] - r, q[1] + r) ||
						held(hold, q[0] + r, q[1] + r))
				)
					continue;
				src.push(a.pts[2 * i]!, a.pts[2 * i + 1]!);
				dst.push(q[0], q[1]);
			}
		} finally {
			warped.delete();
			p1.delete();
			st1.delete();
			e1.delete();
			pb.delete();
			st2.delete();
			e2.delete();
		}
		const count = src.length / 2;
		if (count < 8) return fail(count, total);
		const srcM = cv.matFromArray(count, 1, cv.CV_32FC2, src);
		const dstM = cv.matFromArray(count, 1, cv.CV_32FC2, dst);
		const maskM = new cv.Mat();
		const thr = cfg.ransacThreshold * KS;
		let Hm: Mat | null = null;
		try {
			Hm = cv.findHomography(srcM, dstM, cv.RANSAC, thr, maskM, 2000, 0.995);
			if (!Hm || Hm.empty() || Hm.rows !== 3) return fail(count, total);
			const Haf = G.hNormalize(Array.from(Hm.data64F));
			if (!Haf.every(Number.isFinite)) return fail(count, total);
			let inliers = 0;
			let errSum = 0;
			for (let i = 0; i < count; i++) {
				if (!maskM.data[i]) continue;
				const q = G.hApply(Haf, src[2 * i]!, src[2 * i + 1]!);
				errSum += Math.hypot(q[0] - dst[2 * i]!, q[1] - dst[2 * i + 1]!);
				inliers++;
			}
			return {
				ok: inliers >= 8,
				H: G.hMul(Haf, a.H),
				inliers,
				total,
				survival: count / total,
				meanErr: inliers ? errSum / inliers / KS : 0,
			};
		} finally {
			srcM.delete();
			dstM.delete();
			maskM.delete();
			Hm?.delete();
		}
	}

	/**
	 * Dense refinement of `Hrf` (reference → frame): the anchor's template (anchor frame px) aligned to the frame from
	 * `Hrf · a.H⁻¹`, from pyramid level `start`. Returns reference → frame, or null when the alignment fails.
	 */
	function dense(
		a: Anchor,
		Hrf: number[],
		pyr: Pyramid,
		start: number,
	): { H: number[]; confidence: number } | null {
		if (!a.levels.some((l) => l)) return null;
		const H0 = G.hMul(Hrf, G.hInv(a.H));
		if (!H0.every(Number.isFinite)) return null;
		const r = G.alignPyramid(
			a.levels,
			pyr.images,
			H0,
			start,
			ITERS,
			hold ? { data: hold, w: W, h: H } : null,
		);
		if (!r.ok || r.visible === 0) return null;
		const share = r.inliers / r.visible;
		if (r.zncc < 0.5 || share < 0.25) return null;
		const Hout = G.hMul(r.H, a.H);
		if (!Hout.every(Number.isFinite)) return null;
		const fin = a.levels[0] ?? a.levels.find((l) => l);
		const inFrame = fin ? Math.min(1, (2 * r.visible) / fin.n) : 1;
		return {
			H: Hout,
			confidence: Math.max(0, Math.min(1, r.zncc * Math.sqrt(share) * Math.min(1, inFrame + 0.25))),
		};
	}

	function setAnchor(a: Anchor): void {
		if (anchor && anchor !== refAnchor && anchor !== a) freeAnchor(anchor);
		anchor = a;
		sinceAnchor = 0;
	}

	function resetToReference(): void {
		if (!refAnchor) return;
		setAnchor(refAnchor);
		last = { H: G.hIdentity(), quad: refQuad.slice(), out: refQuad.slice() };
		prevH = null;
		lostRun = 0;
		goodSeq++;
		refAnchor.seq = goodSeq;
	}

	/** Plausible next quad: convex, area within ×2 of the last, near the prediction. */
	function plausible(quad: number[], Hpred: number[]): boolean {
		if (!last) return false;
		const area = Math.abs(G.quadSignedArea(quad));
		const lastArea = Math.abs(G.quadSignedArea(last.quad));
		const b = G.quadBounds(last.quad);
		const diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
		return (
			G.quadIsConvex(quad) &&
			area >= 0.5 * lastArea &&
			area <= 2 * lastArea &&
			G.quadMaxDistance(quad, G.quadApply(Hpred, refQuad)) <= 0.35 * diag + 20
		);
	}

	return {
		reference(img, h) {
			frame.data.set(img);
			hold = h ?? null;
			if (cfg.refineEdges) {
				modes = G.chooseEdgeModes(img, W, H, refQuad, EDGE_REF);
				refQuad = G.refineQuadEdges(img, W, H, refQuad, modes, EDGE_REF).quad;
			}
			refAnchor = makeAnchor(frame, G.hIdentity(), hold);
			if (!refAnchor)
				throw new Error(
					'Not enough texture to track in the reference region (try tracking the surroundings, or a larger region)',
				);
			frame.copyTo(lastGoodMat);
			lastGoodHold = hold;
			resetToReference();
			return { values: refQuad.slice(), confidence: 1, lost: false };
		},

		track(img, h): FrameResult {
			if (!refAnchor || !anchor || !last) throw new Error('tracker has no reference');
			frame.data.set(img);
			hold = h ?? null;
			const Hpred = prevH && lostRun === 0 ? G.hMul(G.hMul(last.H, G.hInv(prevH)), last.H) : last.H;
			const rect = cropAround(G.quadApply(Hpred, refQuad)) ?? cropAround(last.quad);
			const lostResult = (): FrameResult => {
				lostRun++;
				return { values: last!.out.slice(), confidence: 0, lost: true };
			};
			if (!rect) return lostResult();
			const pyr = buildPyramid(frame, rect);
			try {
				let r = measure(anchor, Hpred, pyr);
				if (anchor !== refAnchor) {
					sinceAnchor++;
					if (!r.ok || sinceAnchor % 8 === 0) {
						const back = measure(refAnchor, Hpred, pyr);
						if (back.ok && back.survival >= 0.5 && (!r.ok || back.inliers >= 0.8 * r.inliers)) {
							setAnchor(refAnchor);
							r = back;
						}
					}
				}
				if ((!r.ok || r.survival < cfg.minSurvival) && anchor.seq !== goodSeq) {
					const fresh = makeAnchor(lastGoodMat, last.H, lastGoodHold);
					if (fresh) {
						const r2 = measure(fresh, Hpred, pyr);
						if (r2.ok && (!r.ok || r2.inliers > r.inliers)) {
							setAnchor(fresh);
							r = r2;
						} else freeAnchor(fresh);
					}
				}
				let kltOk =
					r.ok && r.inliers >= Math.max(8, 0.08 * r.total) && plausible(G.quadApply(r.H, refQuad), Hpred);
				let Hf = r.H;
				let confidence = kltOk ? G.planarConfidence(r.inliers, r.total, r.meanErr, cfg.ransacThreshold) : 0;
				if (cfg.dense) {
					const start = kltOk ? Math.min(2, LEVELS - 1) : LEVELS - 1;
					const from = kltOk ? r.H : Hpred;
					smoothLevel0(img, pyr, G.quadApply(from, refQuad));
					let d = dense(refAnchor, from, pyr, start);
					if (!d && anchor !== refAnchor) d = dense(anchor, from, pyr, start);
					if (d) {
						const quadD = G.quadApply(d.H, refQuad);
						const b = G.quadBounds(quadD);
						const diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
						// Without a KLT estimate the dense result must stand on its own; with one, it must agree with it.
						const agrees = kltOk
							? G.quadMaxDistance(quadD, G.quadApply(r.H, refQuad)) <= 0.05 * diag + 4
							: d.confidence >= 0.45 && plausible(quadD, Hpred);
						if (agrees) {
							Hf = d.H;
							confidence = d.confidence;
							kltOk = true;
						}
					}
				}
				if (!kltOk) return lostResult();
				const quad = G.quadApply(Hf, refQuad);
				let out = quad;
				if (cfg.refineEdges && modes.some((m) => m))
					out = G.refineQuadEdges(img, W, H, quad, modes, EDGE).quad;
				prevH = lostRun === 0 ? last.H : null;
				last = { H: Hf, quad, out };
				lostRun = 0;
				goodSeq++;
				frame.copyTo(lastGoodMat);
				lastGoodHold = hold;
				return { values: out.slice(), confidence, lost: false };
			} finally {
				freePyramid(pyr);
			}
		},

		dispose() {
			if (anchor !== refAnchor) freeAnchor(anchor);
			freeAnchor(refAnchor);
			anchor = null;
			refAnchor = null;
			frame.delete();
			lastGoodMat.delete();
		},
	};
}
