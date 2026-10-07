// Feature tracking of the 3D Camera Tracker (after EffectCraft `crates/track/src/camtrack/features.rs`, MIT OR
// Apache-2.0; licenses/ported/three-d.md): Shi–Tomasi corners (OpenCV goodFeaturesToTrack) followed frame to frame
// by pyramidal Lucas–Kanade with a forward–backward check; each step's matches are checked against a RANSAC
// fundamental matrix (normalised 8-point, Sampson distance), which drops features on independently moving objects
// and mismatches; new corners are detected away from the live ones whenever the count falls below the target. A
// lost feature is never revived, so each track is one run of consecutive frames.
import { type P2, Rng, sampson2 } from './core/geometry.ts';
import { type M3, mm, mt, nullVector, svd3 } from './core/linalg.ts';
import type { CameraTracks, Track2D } from './core/types.ts';

type CV = any;

export type FeatureConfig = {
	/** Analysis size (pixels). */
	width: number;
	height: number;
	/** Display pixels per analysis pixel. */
	factor: number;
	/** Features kept alive. */
	target: number;
	/** Minimum distance between features (analysis px). */
	minDistance: number;
	qualityLevel: number;
	winSize: number;
	maxLevel: number;
	/** Forward–backward error limit (analysis px). */
	fbMax: number;
	/** Epipolar (Sampson) inlier distance (analysis px). */
	epipolar: number;
};

/** Analysis size and feature settings for a picture (Detailed Analysis: larger size, more and closer features). */
export function featureConfig(display: { width: number; height: number }, detailed: boolean): FeatureConfig {
	const maxSide = detailed ? 1440 : 960;
	const s = Math.min(1, maxSide / Math.max(display.width, display.height));
	const width = Math.max(16, Math.round(display.width * s));
	const height = Math.max(16, Math.round(display.height * s));
	const short = Math.min(width, height);
	return {
		width,
		height,
		factor: display.width / width,
		target: detailed ? 900 : 450,
		minDistance: Math.max(5, Math.round(short / (detailed ? 70 : 45))),
		qualityLevel: 0.005,
		winSize: 21,
		maxLevel: 3,
		fbMax: 0.6,
		epipolar: 1.25,
	};
}

/** Hartley normalisation (H&Z §4.4.4). */
function normalizer(p: P2[]): M3 {
	const n = Math.max(1, p.length);
	let cx = 0;
	let cy = 0;
	for (const q of p) {
		cx += q[0];
		cy += q[1];
	}
	cx /= n;
	cy /= n;
	let d = 0;
	for (const q of p) d += Math.hypot(q[0] - cx, q[1] - cy);
	d /= n;
	const s = d > 1e-12 ? Math.SQRT2 / d : 1;
	return [
		[s, 0, -s * cx],
		[0, s, -s * cy],
		[0, 0, 1],
	];
}

/** Fundamental matrix from ≥ 8 correspondences (normalised 8-point, rank 2 enforced). */
export function fundamental8pt(x1: P2[], x2: P2[]): M3 | null {
	const n = Math.min(x1.length, x2.length);
	if (n < 8) return null;
	const t1 = normalizer(x1.slice(0, n));
	const t2 = normalizer(x2.slice(0, n));
	const a = new Float64Array(n * 9);
	for (let i = 0; i < n; i++) {
		const p = x1[i]!;
		const q = x2[i]!;
		const px = t1[0][0] * p[0] + t1[0][2];
		const py = t1[1][1] * p[1] + t1[1][2];
		const qx = t2[0][0] * q[0] + t2[0][2];
		const qy = t2[1][1] * q[1] + t2[1][2];
		a.set([qx * px, qx * py, qx, qy * px, qy * py, qy, px, py, 1], i * 9);
	}
	const f = nullVector(a, n, 9);
	const fn: M3 = [
		[f[0]!, f[1]!, f[2]!],
		[f[3]!, f[4]!, f[5]!],
		[f[6]!, f[7]!, f[8]!],
	];
	const { u, s, v } = svd3(fn);
	const r2: M3 = [
		[s[0], 0, 0],
		[0, s[1], 0],
		[0, 0, 0],
	];
	const F = mm(mt(t2), mm(mm(u, mm(r2, mt(v))), t1));
	return F.flat().every(Number.isFinite) ? F : null;
}

/** Inliers of the best RANSAC fundamental matrix (all true when there are too few matches to tell). */
export function epipolarInliers(x1: P2[], x2: P2[], thr: number, seed: number): boolean[] {
	const n = x1.length;
	if (n < 16) return new Array<boolean>(n).fill(true);
	const t2 = thr * thr;
	const rng = new Rng(seed | 1);
	let best: boolean[] | null = null;
	let bestC = -1;
	let maxIter = 200;
	for (let it = 0; it < maxIter; it++) {
		const idx = rng.sample(n, 8);
		const F = fundamental8pt(
			idx.map((i) => x1[i]!),
			idx.map((i) => x2[i]!),
		);
		if (!F) continue;
		const inl = x1.map((p, i) => sampson2(F, p, x2[i]!) < t2);
		const c = inl.filter(Boolean).length;
		if (c > bestC) {
			bestC = c;
			best = inl;
			const pGood = (c / n) ** 8;
			if (pGood > 1e-9)
				maxIter = Math.min(maxIter, Math.max(20, Math.ceil(Math.log(0.01) / Math.log(1 - pGood))));
		}
	}
	if (!best) return new Array<boolean>(n).fill(true);
	const a = x1.filter((_, i) => best![i]);
	const b = x2.filter((_, i) => best![i]);
	const F = fundamental8pt(a, b);
	if (!F) return best;
	return x1.map((p, i) => sampson2(F, p, x2[i]!) < t2);
}

/** Tracks features through grey frames (analysis size) fed in order. */
export function createFeatureTracker(cv: CV, cfg: FeatureConfig) {
	const W = cfg.width;
	const H = cfg.height;
	const win = new cv.Size(cfg.winSize, cfg.winSize);
	const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
	let prev: CV = null;
	let pts: P2[] = [];
	let ids: number[] = [];
	let nextId = 0;
	let frame = -1;
	const tracks = new Map<number, Track2D>();
	const border = 3;
	const inside = (p: P2) => p[0] >= border && p[1] >= border && p[0] < W - border && p[1] < H - border;
	const toDisplay = (p: P2): [number, number] => [
		(p[0] + 0.5) * cfg.factor - 0.5,
		(p[1] + 0.5) * cfg.factor - 0.5,
	];

	function detect(img: CV): void {
		const want = cfg.target - pts.length;
		if (want < cfg.target * 0.1) return;
		const mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
		const corners = new cv.Mat();
		try {
			for (const p of pts)
				cv.circle(
					mask,
					new cv.Point(Math.round(p[0]), Math.round(p[1])),
					cfg.minDistance,
					new cv.Scalar(0),
					-1,
				);
			cv.goodFeaturesToTrack(img, corners, want, cfg.qualityLevel, cfg.minDistance, mask, 3, false, 0.04);
			const d = corners.data32F;
			for (let i = 0; i < corners.rows; i++) {
				const p: P2 = [d[2 * i], d[2 * i + 1]];
				if (!inside(p)) continue;
				pts.push(p);
				const id = nextId++;
				ids.push(id);
				tracks.set(id, { id, start: frame, pts: [toDisplay(p)] });
			}
		} finally {
			mask.delete();
			corners.delete();
		}
	}

	function follow(img: CV): void {
		if (!prev || pts.length === 0) {
			pts = [];
			ids = [];
			return;
		}
		const n = pts.length;
		const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, pts.flat());
		const p1 = new cv.Mat();
		const st1 = new cv.Mat();
		const e1 = new cv.Mat();
		const pb = new cv.Mat();
		const st2 = new cv.Mat();
		const e2 = new cv.Mat();
		const a: P2[] = [];
		const b: P2[] = [];
		const keep: number[] = [];
		try {
			cv.calcOpticalFlowPyrLK(prev, img, p0, p1, st1, e1, win, cfg.maxLevel, crit);
			cv.calcOpticalFlowPyrLK(img, prev, p1, pb, st2, e2, win, cfg.maxLevel, crit);
			const q = p1.data32F;
			const r = pb.data32F;
			for (let i = 0; i < n; i++) {
				if (!st1.data[i] || !st2.data[i]) continue;
				const np: P2 = [q[2 * i], q[2 * i + 1]];
				if (!inside(np)) continue;
				if (Math.hypot(r[2 * i] - pts[i]![0], r[2 * i + 1] - pts[i]![1]) > cfg.fbMax) continue;
				a.push(pts[i]!);
				b.push(np);
				keep.push(i);
			}
		} finally {
			for (const m of [p0, p1, st1, e1, pb, st2, e2]) m.delete();
		}
		const inl = epipolarInliers(a, b, cfg.epipolar, frame * 2654435761);
		const nextPts: P2[] = [];
		const nextIds: number[] = [];
		keep.forEach((i, k) => {
			if (!inl[k]) return;
			const id = ids[i]!;
			nextPts.push(b[k]!);
			nextIds.push(id);
			tracks.get(id)!.pts.push(toDisplay(b[k]!));
		});
		pts = nextPts;
		ids = nextIds;
	}

	return {
		/** Feeds the next frame (grey, W × H). Returns the live feature count. */
		push(grey: Uint8Array): number {
			frame++;
			const img = new cv.Mat(H, W, cv.CV_8UC1);
			img.data.set(grey);
			follow(img);
			detect(img);
			prev?.delete();
			prev = img;
			return pts.length;
		},
		/** The tracks so far (display px). */
		result(display: { width: number; height: number }, detailed: boolean): CameraTracks {
			return {
				size: [display.width, display.height],
				frames: frame + 1,
				factor: cfg.factor,
				detailed,
				tracks: [...tracks.values()].filter((t) => t.pts.length >= 3),
			};
		},
		dispose(): void {
			prev?.delete();
			prev = null;
		},
	};
}

/** RGB24 → 8-bit luma (Rec. 601 weights). */
export function greyOf(rgb: Uint8Array, out: Uint8Array): Uint8Array {
	for (let i = 0, j = 0; j < out.length; i += 3, j++)
		out[j] = (rgb[i]! * 77 + rgb[i + 1]! * 150 + rgb[i + 2]! * 29) >> 8;
	return out;
}
