// Point tracker `template@1` (S09:TRK-013). Runs inside the tracking worker with OpenCV.js.
//
// Normalised cross-correlation (`matchTemplate` TM_CCOEFF_NORMED) of the REFERENCE patch within the search window
// around the predicted position (previous position + velocity), sub-pixel peak, then refined with Lucas–Kanade from
// the reference frame. The template is never updated (re-anchored to the reference every frame, so no drift).
// Confidence = correlation score; below `minScore` the frame is lost (confidence 0, last good position repeated) and
// the next search window doubles.
//
// WORKER-SAFE: evaluated from its source text in the worker; only its parameters and JS globals are used.
import type { FrameTracker } from './planar.ts';

export type PointConfig = {
	kind: 'point';
	width: number;
	height: number;
	/** Reference point, tracking px. */
	point: [number, number];
	/** Template edge, tracking px (odd). */
	patch: number;
	/** Search radius around the prediction, tracking px. */
	search: number;
	minScore: number;
};

type CV = any;

export function createPointTracker(cv: CV, cfg: PointConfig): FrameTracker {
	const W = cfg.width;
	const H = cfg.height;
	const patch = Math.max(5, cfg.patch | 1);
	const hp = (patch - 1) / 2;
	const frame = new cv.Mat(H, W, cv.CV_8UC1);
	const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.005);
	const lkWin = new cv.Size(patch, patch);
	const lkMargin = hp + 6;
	let template: CV = null;
	let refRoi: CV = null;
	let refRoiRect: { x: number; y: number; w: number; h: number } | null = null;
	/** Reference point minus the template centre. */
	let dx = 0;
	let dy = 0;
	const ref: [number, number] = [cfg.point[0], cfg.point[1]];
	let last: [number, number] = [ref[0], ref[1]];
	let prev: [number, number] | null = null;
	let lostRun = 0;

	const clampRect = (cx: number, cy: number, half: number) => {
		const x = Math.round(cx) - half;
		const y = Math.round(cy) - half;
		const s = 2 * half + 1;
		if (x < 0 || y < 0 || x + s > W || y + s > H) return null;
		return { x, y, w: s, h: s };
	};

	function lkRefine(est: [number, number]): [number, number] | null {
		if (!refRoi || !refRoiRect) return null;
		const r2 = clampRect(est[0], est[1], lkMargin);
		if (!r2) return null;
		const view = frame.roi(new cv.Rect(r2.x, r2.y, r2.w, r2.h));
		const cur = new cv.Mat();
		view.copyTo(cur); // Mat.clone() of this OpenCV.js build shares the data
		view.delete();
		const p0 = cv.matFromArray(1, 1, cv.CV_32FC2, [ref[0] - refRoiRect.x, ref[1] - refRoiRect.y]);
		const p1 = cv.matFromArray(1, 1, cv.CV_32FC2, [est[0] - r2.x, est[1] - r2.y]);
		const st = new cv.Mat();
		const err = new cv.Mat();
		try {
			cv.calcOpticalFlowPyrLK(refRoi, cur, p0, p1, st, err, lkWin, 1, criteria, cv.OPTFLOW_USE_INITIAL_FLOW);
			if (!st.data[0]) return null;
			const x = p1.data32F[0] + r2.x;
			const y = p1.data32F[1] + r2.y;
			if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
			return [x, y];
		} finally {
			cur.delete();
			p0.delete();
			p1.delete();
			st.delete();
			err.delete();
		}
	}

	return {
		reference(img) {
			frame.data.set(img);
			const cx = Math.min(W - 1 - hp, Math.max(hp, Math.round(ref[0])));
			const cy = Math.min(H - 1 - hp, Math.max(hp, Math.round(ref[1])));
			const view = frame.roi(new cv.Rect(cx - hp, cy - hp, patch, patch));
			template = new cv.Mat();
			view.copyTo(template);
			view.delete();
			dx = ref[0] - cx;
			dy = ref[1] - cy;
			refRoiRect = clampRect(ref[0], ref[1], lkMargin);
			if (refRoiRect) {
				const v = frame.roi(new cv.Rect(refRoiRect.x, refRoiRect.y, refRoiRect.w, refRoiRect.h));
				refRoi = new cv.Mat();
				v.copyTo(refRoi);
				v.delete();
			}
			last = [ref[0], ref[1]];
			prev = null;
			lostRun = 0;
			return { values: [ref[0], ref[1]], confidence: 1, lost: false };
		},

		track(img) {
			if (!template) throw new Error('tracker has no reference');
			frame.data.set(img);
			const pred: [number, number] =
				prev && lostRun === 0 ? [2 * last[0] - prev[0], 2 * last[1] - prev[1]] : [last[0], last[1]];
			const radius = Math.round(cfg.search * (lostRun > 0 ? 2 : 1));
			const tcx = Math.round(pred[0] - dx);
			const tcy = Math.round(pred[1] - dy);
			const x0 = Math.max(0, tcx - radius - hp);
			const y0 = Math.max(0, tcy - radius - hp);
			const x1 = Math.min(W, tcx + radius + hp + 1);
			const y1 = Math.min(H, tcy + radius + hp + 1);
			const lostResult = () => {
				lostRun++;
				return { values: [last[0], last[1]], confidence: 0, lost: true };
			};
			if (x1 - x0 < patch + 2 || y1 - y0 < patch + 2) return lostResult();
			const region = frame.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
			const res = new cv.Mat();
			let score = 0;
			let est: [number, number];
			try {
				cv.matchTemplate(region, template, res, cv.TM_CCOEFF_NORMED);
				const mm = cv.minMaxLoc(res);
				score = mm.maxVal;
				const mx = mm.maxLoc.x;
				const my = mm.maxLoc.y;
				const rw = res.cols;
				const rh = res.rows;
				const at = (x: number, y: number) => res.data32F[y * rw + x] as number;
				let sx = 0;
				let sy = 0;
				if (mx > 0 && mx < rw - 1) {
					const den = at(mx - 1, my) - 2 * at(mx, my) + at(mx + 1, my);
					if (Math.abs(den) > 1e-9) sx = (0.5 * (at(mx - 1, my) - at(mx + 1, my))) / den;
				}
				if (my > 0 && my < rh - 1) {
					const den = at(mx, my - 1) - 2 * at(mx, my) + at(mx, my + 1);
					if (Math.abs(den) > 1e-9) sy = (0.5 * (at(mx, my - 1) - at(mx, my + 1))) / den;
				}
				sx = Math.max(-0.5, Math.min(0.5, sx));
				sy = Math.max(-0.5, Math.min(0.5, sy));
				est = [x0 + mx + sx + hp + dx, y0 + my + sy + hp + dy];
			} finally {
				region.delete();
				res.delete();
			}
			if (!(score >= cfg.minScore)) return lostResult();
			const lk = lkRefine(est);
			const pos: [number, number] = lk && Math.hypot(lk[0] - est[0], lk[1] - est[1]) < 1.5 ? lk : est;
			prev = lostRun === 0 ? last : null;
			last = pos;
			lostRun = 0;
			return { values: [pos[0], pos[1]], confidence: Math.max(0, Math.min(1, score)), lost: false };
		},

		dispose() {
			template?.delete();
			refRoi?.delete();
			template = null;
			refRoi = null;
			frame.delete();
		},
	};
}
