import type { Mat } from '@techstark/opencv-js';
import type { OpenCvApi } from '../tools/opencv.ts';
// Planar tracker `klt-homography@1` (S09:TRK-012). Runs inside the tracking worker with OpenCV.js.
//
// 1. Reference frame: Shi–Tomasi corners inside the reference quad (or in a ring 5–25 % outside it, or both).
// 2. Every frame: the frame is pre-warped into the anchor's geometry with the predicted homography (constant
//    velocity), so pyramidal Lucas–Kanade only has to recover the residual motion of the anchor's features, then a
//    forward–backward check (≤ 1 px). The matches are mapped back into the frame, so the homography is measured from
//    the anchor (the reference frame itself unless re-anchored) directly: prediction errors never accumulate.
// 3. RANSAC homography (reprojection threshold 2 px); confidence = inlier ratio × (1 − normalised error).
// 4. Survival < 30 %: re-anchor on the last good frame with fresh features (chained); every few frames the
//    reference anchor is tried again so the chain does not stay.
// 5. Options: ECC refinement against the reference (quality `best`), per-frame edge refinement (`refineEdges`).
//
// WORKER-SAFE: evaluated from its source text in the worker. It may only use its parameters (`cv`, `G` = the
// geometry helpers, `cfg`) and JS globals.
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
	ecc: boolean;
	maxFeatures: number;
	qualityLevel: number;
	minDistance: number;
	winSize: number;
	/** Pyramid levels − 1. */
	maxLevel: number;
	fbMax: number;
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
	reference(img: Uint8Array): FrameResult;
	track(img: Uint8Array): FrameResult;
	dispose(): void;
};

export function createPlanarTracker(cv: OpenCvApi, G: typeof Geometry, cfg: PlanarConfig): FrameTracker {
	const W = cfg.width;
	const H = cfg.height;
	const frame = new cv.Mat(H, W, cv.CV_8UC1);
	const lastGoodMat = new cv.Mat(H, W, cv.CV_8UC1);
	const win = new cv.Size(cfg.winSize, cfg.winSize);
	const lkCriteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
	const eccCriteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 40, 1e-5);
	const EDGE = { band: 4, n: 48, maxShift: 3, maxResidual: 0.75, minFraction: 0.35, minContrast: 2 };
	const EDGE_REF = { band: 6, n: 48, maxShift: 6, maxResidual: 1, minFraction: 0.35, minContrast: 2 };

	type Anchor = {
		img: Mat;
		ptsRoi: Mat;
		/** Feature positions in the anchor frame (x, y interleaved). */
		pts: Float64Array;
		n: number;
		roi: { x: number; y: number; w: number; h: number };
		/** Reference → anchor frame. */
		H: number[];
		seq: number;
	};
	type Measured = {
		ok: boolean;
		H: number[];
		inliers: number;
		total: number;
		survival: number;
		meanErr: number;
	};

	let refQuad: number[] = cfg.corners.slice();
	let refAnchor: Anchor | null = null;
	let anchor: Anchor | null = null;
	let modes: (Geometry.EdgeMode | null)[] = [null, null, null, null];
	let last: { H: number[]; quad: number[]; out: number[] } | null = null;
	let prevH: number[] | null = null;
	let lostRun = 0;
	let goodSeq = 0;
	let eccMask: Mat | null = null;
	let sinceAnchor = 0;

	function freeAnchor(a: Anchor | null): void {
		if (!a) return;
		a.img.delete();
		a.ptsRoi.delete();
	}

	function makeAnchor(src: Mat, Hra: number[]): Anchor | null {
		const quad = G.quadApply(Hra, refQuad);
		const roi = G.featureRoi(quad, cfg.features, cfg.winSize + 8, W, H);
		if (!roi) return null;
		let minSide = Number.POSITIVE_INFINITY;
		for (let k = 0; k < 4; k++) {
			const j = (k + 1) % 4;
			minSide = Math.min(
				minSide,
				Math.hypot(quad[2 * j]! - quad[2 * k]!, quad[2 * j + 1]! - quad[2 * k + 1]!),
			);
		}
		const inset = Math.min(cfg.winSize / 2, Math.max(2, 0.12 * minSide));
		const rect = new cv.Rect(roi.x, roi.y, roi.w, roi.h);
		const view = src.roi(rect);
		const img = new cv.Mat();
		view.copyTo(img); // Mat.clone() of this OpenCV.js build shares the data
		view.delete();
		const mask = new cv.Mat(roi.h, roi.w, cv.CV_8UC1);
		mask.data.set(G.featureMask(quad, roi, cfg.features, inset));
		const corners = new cv.Mat();
		cv.goodFeaturesToTrack(
			img,
			corners,
			cfg.maxFeatures,
			cfg.qualityLevel,
			cfg.minDistance,
			mask,
			3,
			false,
			0.04,
		);
		mask.delete();
		const n = corners.rows;
		if (n < 8) {
			corners.delete();
			img.delete();
			return null;
		}
		const pts = new Float64Array(2 * n);
		const d = corners.data32F;
		for (let i = 0; i < n; i++) {
			pts[2 * i] = d[2 * i] + roi.x;
			pts[2 * i + 1] = d[2 * i + 1] + roi.y;
		}
		return { img, ptsRoi: corners, pts, n, roi, H: Hra.slice(), seq: goodSeq };
	}

	function measure(a: Anchor, Hpred: number[]): Measured {
		const fail = (count: number): Measured => ({
			ok: false,
			H: Hpred,
			inliers: 0,
			total: a.n,
			survival: count / a.n,
			meanErr: 0,
		});
		// ROI coordinates of the anchor → frame coordinates, through the predicted motion.
		const M = G.hMul(G.hMul(Hpred, G.hInv(a.H)), G.hTranslate(a.roi.x, a.roi.y));
		if (!M.every(Number.isFinite)) return fail(0);
		const Mm = cv.matFromArray(3, 3, cv.CV_64F, M);
		const warped = new cv.Mat();
		cv.warpPerspective(
			frame,
			warped,
			Mm,
			new cv.Size(a.roi.w, a.roi.h),
			cv.INTER_LINEAR + cv.WARP_INVERSE_MAP,
			cv.BORDER_REPLICATE,
			new cv.Scalar(),
		);
		Mm.delete();
		const p1 = new cv.Mat();
		const st1 = new cv.Mat();
		const e1 = new cv.Mat();
		const pb = new cv.Mat();
		const st2 = new cv.Mat();
		const e2 = new cv.Mat();
		const src: number[] = [];
		const dst: number[] = [];
		try {
			cv.calcOpticalFlowPyrLK(a.img, warped, a.ptsRoi, p1, st1, e1, win, cfg.maxLevel, lkCriteria);
			cv.calcOpticalFlowPyrLK(warped, a.img, p1, pb, st2, e2, win, cfg.maxLevel, lkCriteria);
			const p0d = a.ptsRoi.data32F;
			const p1d = p1.data32F;
			const pbd = pb.data32F;
			for (let i = 0; i < a.n; i++) {
				if (!st1.data[i] || !st2.data[i]) continue;
				const x = p1d[2 * i];
				const y = p1d[2 * i + 1];
				if (!(x >= 0 && y >= 0 && x <= a.roi.w - 1 && y <= a.roi.h - 1)) continue;
				if (Math.hypot(pbd[2 * i] - p0d[2 * i], pbd[2 * i + 1] - p0d[2 * i + 1]) > cfg.fbMax) continue;
				const q = G.hApply(M, x, y);
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
		if (count < 8) return fail(count);
		const srcM = cv.matFromArray(count, 1, cv.CV_32FC2, src);
		const dstM = cv.matFromArray(count, 1, cv.CV_32FC2, dst);
		const maskM = new cv.Mat();
		let Hm: Mat | null = null;
		try {
			Hm = cv.findHomography(srcM, dstM, cv.RANSAC, cfg.ransacThreshold, maskM, 2000, 0.995);
			if (!Hm || Hm.empty() || Hm.rows !== 3) return fail(count);
			const Haf = G.hNormalize(Array.from(Hm.data64F));
			if (!Haf.every(Number.isFinite)) return fail(count);
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
				total: a.n,
				survival: count / a.n,
				meanErr: inliers ? errSum / inliers : 0,
			};
		} finally {
			srcM.delete();
			dstM.delete();
			maskM.delete();
			Hm?.delete();
		}
	}

	/**
	 * ECC (homography model) of the reference feature region against the frame, starting from `Hrf`. OpenCV's mask
	 * is on the input image, so it is the predicted feature region in the frame. Any OpenCV exception leaks WASM memory
	 * (no unwinding), so the call is only made with valid inputs.
	 */
	function eccRefine(Hrf: number[]): number[] | null {
		const a = refAnchor;
		if (!a) return null;
		const quadF = G.quadApply(Hrf, refQuad);
		const roi = G.featureRoi(quadF, cfg.features, 0, W, H);
		if (!roi) return null;
		if (!eccMask) eccMask = new cv.Mat(H, W, cv.CV_8UC1);
		eccMask.data.fill(0);
		const m = G.featureMask(quadF, roi, cfg.features, 2);
		const md = eccMask.data;
		for (let y = 0; y < roi.h; y++) md.set(m.subarray(y * roi.w, (y + 1) * roi.w), (roi.y + y) * W + roi.x);
		const w0 = G.hMul(Hrf, G.hTranslate(a.roi.x, a.roi.y));
		const warpM = cv.matFromArray(3, 3, cv.CV_32F, w0);
		try {
			const rho = cv.findTransformECC(a.img, frame, warpM, cv.MOTION_HOMOGRAPHY, eccCriteria, eccMask, 5);
			if (!(rho > 0.5)) return null;
			const He = G.hMul(G.hNormalize(Array.from(warpM.data32F)), G.hTranslate(-a.roi.x, -a.roi.y));
			if (!He.every(Number.isFinite)) return null;
			if (G.quadMaxDistance(G.quadApply(He, refQuad), quadF) > 3) return null;
			return He;
		} catch {
			return null;
		} finally {
			warpM.delete();
		}
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

	return {
		reference(img) {
			frame.data.set(img);
			if (cfg.refineEdges) {
				modes = G.chooseEdgeModes(img, W, H, refQuad, EDGE_REF);
				refQuad = G.refineQuadEdges(img, W, H, refQuad, modes, EDGE_REF).quad;
			}
			refAnchor = makeAnchor(frame, G.hIdentity());
			if (!refAnchor)
				throw new Error(
					'Not enough texture to track in the reference region (try tracking the surroundings, or a larger region)',
				);
			frame.copyTo(lastGoodMat);
			resetToReference();
			return { values: refQuad.slice(), confidence: 1, lost: false };
		},

		track(img): FrameResult {
			if (!refAnchor || !anchor || !last) throw new Error('tracker has no reference');
			frame.data.set(img);
			const Hpred = prevH && lostRun === 0 ? G.hMul(G.hMul(last.H, G.hInv(prevH)), last.H) : last.H;
			let r = measure(anchor, Hpred);
			if (anchor !== refAnchor) {
				sinceAnchor++;
				if (!r.ok || sinceAnchor % 8 === 0) {
					const back = measure(refAnchor, Hpred);
					if (back.ok && back.survival >= 0.5 && (!r.ok || back.inliers >= 0.8 * r.inliers)) {
						setAnchor(refAnchor);
						r = back;
					}
				}
			}
			if ((!r.ok || r.survival < cfg.minSurvival) && anchor.seq !== goodSeq) {
				const fresh = makeAnchor(lastGoodMat, last.H);
				if (fresh) {
					const r2 = measure(fresh, Hpred);
					if (r2.ok && (!r.ok || r2.inliers > r.inliers)) {
						setAnchor(fresh);
						r = r2;
					} else freeAnchor(fresh);
				}
			}
			let lost = !r.ok || r.inliers < Math.max(8, 0.08 * r.total);
			let Hf = r.H;
			let quad = G.quadApply(Hf, refQuad);
			if (!lost) {
				const area = Math.abs(G.quadSignedArea(quad));
				const lastArea = Math.abs(G.quadSignedArea(last.quad));
				const b = G.quadBounds(last.quad);
				const diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
				if (
					!G.quadIsConvex(quad) ||
					area < 0.5 * lastArea ||
					area > 2 * lastArea ||
					G.quadMaxDistance(quad, G.quadApply(Hpred, refQuad)) > 0.35 * diag + 20
				)
					lost = true;
			}
			if (lost) {
				lostRun++;
				return {
					values: last.out.slice(),
					confidence: 0,
					lost: true,
				};
			}
			if (cfg.ecc) {
				const He = eccRefine(Hf);
				if (He) {
					Hf = He;
					quad = G.quadApply(Hf, refQuad);
				}
			}
			const confidence = G.planarConfidence(r.inliers, r.total, r.meanErr, cfg.ransacThreshold);
			let out = quad;
			if (cfg.refineEdges && modes.some((m) => m)) {
				const e = G.refineQuadEdges(img, W, H, quad, modes, EDGE);
				out = e.quad;
			}
			prevH = lostRun === 0 ? last.H : null;
			last = { H: Hf, quad, out };
			lostRun = 0;
			goodSeq++;
			frame.copyTo(lastGoodMat);
			return {
				values: out.slice(),
				confidence,
				lost: false,
			};
		},

		dispose() {
			if (anchor !== refAnchor) freeAnchor(anchor);
			freeAnchor(refAnchor);
			anchor = null;
			refAnchor = null;
			frame.delete();
			lastGoodMat.delete();
			eccMask?.delete();
		},
	};
}
