// Face detection and landmarks: Google MediaPipe's Face Landmarker models (BlazeFace short-range detector + Face Mesh
// V2, 478 landmarks), Apache-2.0, as ONNX conversions (processing/models.json, pinned revisions), run through ONNX
// Runtime. The graph around them follows MediaPipe's published face landmarker graph (Apache-2.0; the same contract
// EffectCraft `crates/segment/src/mediapipe.rs` follows):
//
// - detector: the frame letterboxed into 128 × 128 (RGB in [−1, 1]); 896 SSD anchors (strides 8, 16, 16, 16;
//   2 + 6 anchors per cell; fixed anchor size); box + 6 keypoints regressed in 128-px units; sigmoid scores;
//   weighted non-maximum suppression at IoU 0.3. Small faces in large frames: the frame is also scanned in
//   overlapping tiles (the short-range model is trained on faces filling a good part of its input);
// - region of interest: the detection box made square on its long side × 1.5, rotated so the eyes are level
//   (keypoints 0 → 1, target angle 0); while tracking, the next frame's ROI comes from the previous landmarks
//   (their bounding box in the face frame, rotation from landmarks 33 → 263, square × 1.5);
// - landmarks: the ROI warped to 256 × 256 (RGB in [0, 1]), 478 (x, y, z) in crop pixels + a face-presence score,
//   projected back through the ROI.
//
// Coordinates are frame pixels (pixel centres at +0.5).
import { resample } from '../core/image.ts';
import { loadOrt } from './sam.ts';

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;

export type Detection = {
	/** Box (frame px). */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	score: number;
	/** 6 keypoints: right eye, left eye, nose tip, mouth, right ear tragion, left ear tragion (image right = subject left). */
	keypoints: [number, number][];
};

/** A rotated square region (frame px): centre, side, rotation (radians, clockwise on screen). */
export type Roi = { cx: number; cy: number; size: number; angle: number };

export type FaceLandmarks = {
	/** 478 points (x, y frame px, z relative). */
	points: Float32Array;
	presence: number;
	roi: Roi;
};

/** MediaPipe's face oval (silhouette) landmark indices, clockwise from the top of the forehead. */
export const FACE_OVAL = [
	10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
	172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const;
/** Eye corners used for the in-plane rotation (subject's right eye outer → left eye outer). */
const EYE_A = 33;
const EYE_B = 263;

const DET = 128;
const LMK = 256;

/** The 896 anchor centres of the short-range detector (normalised 0..1). */
export function blazeFaceAnchors(): Float32Array {
	const strides = [8, 16, 16, 16];
	const out: number[] = [];
	let layer = 0;
	while (layer < strides.length) {
		let last = layer;
		let count = 0;
		while (last < strides.length && strides[last] === strides[layer]) {
			count += 2; // aspect ratio 1 + the interpolated scale, per layer
			last++;
		}
		const stride = strides[layer]!;
		const fm = Math.ceil(DET / stride);
		for (let y = 0; y < fm; y++)
			for (let x = 0; x < fm; x++)
				for (let k = 0; k < count; k++) out.push((x + 0.5) / fm, (y + 0.5) / fm);
		layer = last;
	}
	return Float32Array.from(out);
}

const ANCHORS = blazeFaceAnchors();

function iouBox(a: Detection, b: Detection): number {
	const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
	const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
	const inter = ix * iy;
	const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
	return u > 0 ? inter / u : 0;
}

/** MediaPipe's weighted non-maximum suppression: overlapping detections are averaged, weighted by score. */
export function weightedNms(dets: Detection[], iouThreshold = 0.3): Detection[] {
	const rest = [...dets].sort((a, b) => b.score - a.score);
	const out: Detection[] = [];
	while (rest.length) {
		const top = rest[0]!;
		const group = rest.filter((d) => iouBox(top, d) > iouThreshold);
		const keep = rest.filter((d) => iouBox(top, d) <= iouThreshold);
		let ws = 0;
		const acc = { x0: 0, y0: 0, x1: 0, y1: 0, kp: top.keypoints.map(() => [0, 0] as [number, number]) };
		for (const d of group) {
			ws += d.score;
			acc.x0 += d.x0 * d.score;
			acc.y0 += d.y0 * d.score;
			acc.x1 += d.x1 * d.score;
			acc.y1 += d.y1 * d.score;
			d.keypoints.forEach((k, i) => {
				acc.kp[i]![0] += k[0] * d.score;
				acc.kp[i]![1] += k[1] * d.score;
			});
		}
		out.push({
			x0: acc.x0 / ws,
			y0: acc.y0 / ws,
			x1: acc.x1 / ws,
			y1: acc.y1 / ws,
			score: top.score,
			keypoints: acc.kp.map(([x, y]) => [x / ws, y / ws] as [number, number]),
		});
		rest.splice(0, rest.length, ...keep);
	}
	return out;
}

/** ROI of a detection (MediaPipe face_detection → roi: square long side × 1.5, eyes level). */
export function roiOfDetection(d: Detection): Roi {
	const [a, b] = [d.keypoints[0]!, d.keypoints[1]!];
	const angle = normAngle(-Math.atan2(-(b[1] - a[1]), b[0] - a[0]));
	const w = d.x1 - d.x0;
	const h = d.y1 - d.y0;
	return { cx: (d.x0 + d.x1) / 2, cy: (d.y0 + d.y1) / 2, size: Math.max(w, h) * 1.5, angle };
}

/** ROI for the next frame from landmarks (bounding box in the face frame, rotation from the eye corners, × 1.5). */
export function roiOfLandmarks(points: Float32Array): Roi {
	const ax = points[EYE_A * 3]!;
	const ay = points[EYE_A * 3 + 1]!;
	const bx = points[EYE_B * 3]!;
	const by = points[EYE_B * 3 + 1]!;
	const angle = normAngle(-Math.atan2(-(by - ay), bx - ax));
	const c = Math.cos(-angle);
	const s = Math.sin(-angle);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	const n = points.length / 3;
	for (let i = 0; i < n; i++) {
		const x = points[i * 3]!;
		const y = points[i * 3 + 1]!;
		const u = x * c - y * s;
		const v = x * s + y * c;
		x0 = Math.min(x0, u);
		x1 = Math.max(x1, u);
		y0 = Math.min(y0, v);
		y1 = Math.max(y1, v);
	}
	const cu = (x0 + x1) / 2;
	const cv = (y0 + y1) / 2;
	// Back to frame coordinates (rotate by +angle).
	const cr = Math.cos(angle);
	const sr = Math.sin(angle);
	return { cx: cu * cr - cv * sr, cy: cu * sr + cv * cr, size: Math.max(x1 - x0, y1 - y0) * 1.5, angle };
}

function normAngle(a: number): number {
	return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** Bilinear sample of an RGB float image (0 outside). */
function sampleRgb(img: Float32Array, w: number, h: number, x: number, y: number, out: number[]): void {
	const fx = x - 0.5;
	const fy = y - 0.5;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const tx = fx - x0;
	const ty = fy - y0;
	out[0] = out[1] = out[2] = 0;
	for (const [dx, dy, wt] of [
		[0, 0, (1 - tx) * (1 - ty)],
		[1, 0, tx * (1 - ty)],
		[0, 1, (1 - tx) * ty],
		[1, 1, tx * ty],
	] as const) {
		const xi = x0 + dx;
		const yi = y0 + dy;
		if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
		const o = (yi * w + xi) * 3;
		out[0] += img[o]! * wt;
		out[1] += img[o + 1]! * wt;
		out[2] += img[o + 2]! * wt;
	}
}

export class FaceModels {
	private constructor(
		private readonly ort: Ort,
		private readonly detector: Session,
		private readonly landmarker: Session,
		readonly id: string,
	) {}

	static async load(id: string, files: { detector: string; landmarks: string }, threads: number) {
		const ort = loadOrt();
		const opts = {
			intraOpNumThreads: Math.max(1, threads),
			interOpNumThreads: 1,
			graphOptimizationLevel: 'all' as const,
			logSeverityLevel: 3 as const,
		};
		return new FaceModels(
			ort,
			await ort.InferenceSession.create(files.detector, opts),
			await ort.InferenceSession.create(files.landmarks, opts),
			id,
		);
	}

	async release(): Promise<void> {
		await this.detector.release();
		await this.landmarker.release();
	}

	/** Detections in one square window of the frame (letterboxed into 128²). */
	private async detectWindow(
		img: Float32Array,
		w: number,
		h: number,
		win: { x: number; y: number; size: number },
		minScore: number,
	): Promise<Detection[]> {
		const input = new Float32Array(DET * DET * 3);
		const px = [0, 0, 0];
		const step = win.size / DET;
		// Area-average when the window is much larger than the input (no aliasing).
		const taps = Math.max(1, Math.min(4, Math.round(step)));
		for (let y = 0; y < DET; y++)
			for (let x = 0; x < DET; x++) {
				let r = 0;
				let g = 0;
				let b = 0;
				for (let j = 0; j < taps; j++)
					for (let i = 0; i < taps; i++) {
						const sx = win.x + (x + (i + 0.5) / taps) * step;
						const sy = win.y + (y + (j + 0.5) / taps) * step;
						sampleRgb(img, w, h, sx, sy, px);
						r += px[0]!;
						g += px[1]!;
						b += px[2]!;
					}
				const o = (y * DET + x) * 3;
				const t = taps * taps;
				input[o] = (r / t) * 2 - 1;
				input[o + 1] = (g / t) * 2 - 1;
				input[o + 2] = (b / t) * 2 - 1;
			}
		const out = await this.detector.run({ input: new this.ort.Tensor('float32', input, [1, DET, DET, 3]) });
		const reg = out.regressors!.data as Float32Array;
		const cls = out.classificators!.data as Float32Array;
		const dets: Detection[] = [];
		for (let a = 0; a < 896; a++) {
			const logit = Math.max(-100, Math.min(100, cls[a]!));
			const score = 1 / (1 + Math.exp(-logit));
			if (score < minScore) continue;
			const ax = ANCHORS[a * 2]!;
			const ay = ANCHORS[a * 2 + 1]!;
			const o = a * 16;
			const cx = reg[o]! / DET + ax;
			const cy = reg[o + 1]! / DET + ay;
			const bw = reg[o + 2]! / DET;
			const bh = reg[o + 3]! / DET;
			const toX = (u: number) => win.x + u * win.size;
			const toY = (v: number) => win.y + v * win.size;
			const keypoints: [number, number][] = [];
			for (let k = 0; k < 6; k++)
				keypoints.push([toX(reg[o + 4 + k * 2]! / DET + ax), toY(reg[o + 5 + k * 2]! / DET + ay)]);
			dets.push({
				x0: toX(cx - bw / 2),
				y0: toY(cy - bh / 2),
				x1: toX(cx + bw / 2),
				y1: toY(cy + bh / 2),
				score,
				keypoints,
			});
		}
		return dets;
	}

	/**
	 * Faces in a frame: the whole frame (letterboxed) plus, for frames much larger than the detector input, two
	 * levels of overlapping square tiles (faces down to ~1/12 of the short side). Weighted NMS merges duplicates.
	 */
	async detect(img: Float32Array, w: number, h: number, minScore = 0.5): Promise<Detection[]> {
		const side = Math.max(w, h);
		const windows: { x: number; y: number; size: number }[] = [
			{ x: (w - side) / 2, y: (h - side) / 2, size: side },
		];
		const short = Math.min(w, h);
		for (const frac of [1, 0.5]) {
			const size = short * frac;
			if (size < DET * 1.5 || size >= side * 0.999) continue;
			const stride = size * 0.5;
			for (let y = 0; y + size <= h + 1e-6; y += stride) {
				for (let x = 0; x + size <= w + 1e-6; x += stride) windows.push({ x, y, size });
				if (w - size > 0 && (w - size) % stride > 1) windows.push({ x: w - size, y, size });
			}
			if (h - size > 0 && (h - size) % stride > 1)
				for (let x = 0; x + size <= w + 1e-6; x += stride) windows.push({ x, y: h - size, size });
		}
		const all: Detection[] = [];
		for (const win of windows) all.push(...(await this.detectWindow(img, w, h, win, minScore)));
		return weightedNms(all, 0.3);
	}

	/** Landmarks of the face in `roi`. */
	async landmarks(img: Float32Array, w: number, h: number, roi: Roi): Promise<FaceLandmarks> {
		const input = new Float32Array(LMK * LMK * 3);
		const c = Math.cos(roi.angle);
		const s = Math.sin(roi.angle);
		const px = [0, 0, 0];
		const step = roi.size / LMK;
		for (let y = 0; y < LMK; y++)
			for (let x = 0; x < LMK; x++) {
				const u = ((x + 0.5) / LMK - 0.5) * roi.size;
				const v = ((y + 0.5) / LMK - 0.5) * roi.size;
				sampleRgb(img, w, h, roi.cx + u * c - v * s, roi.cy + u * s + v * c, px);
				const o = (y * LMK + x) * 3;
				input[o] = px[0]!;
				input[o + 1] = px[1]!;
				input[o + 2] = px[2]!;
			}
		void step;
		const out = await this.landmarker.run({
			[this.landmarker.inputNames[0]!]: new this.ort.Tensor('float32', input, [1, LMK, LMK, 3]),
		});
		const names = this.landmarker.outputNames;
		const raw = out[names[0]!]!.data as Float32Array;
		const presLogit = (out[names[1]!]!.data as Float32Array)[0]!;
		const presence = 1 / (1 + Math.exp(-presLogit));
		const n = Math.floor(raw.length / 3);
		const points = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			const u = (raw[i * 3]! / LMK - 0.5) * roi.size;
			const v = (raw[i * 3 + 1]! / LMK - 0.5) * roi.size;
			points[i * 3] = roi.cx + u * c - v * s;
			points[i * 3 + 1] = roi.cy + u * s + v * c;
			points[i * 3 + 2] = (raw[i * 3 + 2]! / LMK) * roi.size;
		}
		return { points, presence, roi };
	}
}

/** The face-oval polygon of a landmark set, grown about its centroid by `expand` (0.1 = 10 %). */
export function faceOutline(points: Float32Array, expand = 0): [number, number][] {
	const poly = FACE_OVAL.map((i) => [points[i * 3]!, points[i * 3 + 1]!] as [number, number]);
	if (expand === 0) return poly;
	let cx = 0;
	let cy = 0;
	for (const [x, y] of poly) {
		cx += x;
		cy += y;
	}
	cx /= poly.length;
	cy /= poly.length;
	return poly.map(([x, y]) => [cx + (x - cx) * (1 + expand), cy + (y - cy) * (1 + expand)]);
}

/**
 * Face pose from landmarks: centre (face-oval centroid), size (oval height: forehead 10 → chin 152) and roll
 * (eye line, radians clockwise).
 */
export function facePose(points: Float32Array): { cx: number; cy: number; size: number; angle: number } {
	const poly = faceOutline(points);
	let cx = 0;
	let cy = 0;
	for (const [x, y] of poly) {
		cx += x;
		cy += y;
	}
	cx /= poly.length;
	cy /= poly.length;
	const size = Math.hypot(points[152 * 3]! - points[10 * 3]!, points[152 * 3 + 1]! - points[10 * 3 + 1]!);
	const angle = Math.atan2(points[EYE_B * 3 + 1]! - points[EYE_A * 3 + 1]!, points[EYE_B * 3]! - points[EYE_A * 3]!);
	return { cx, cy, size, angle };
}

/** Rasterises polygons (non-zero winding) with 4 × 4 supersampling into an 8-bit coverage plane (union, max). */
export function rasterPolygons(polys: readonly (readonly [number, number])[][], w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h);
	const SS = 4;
	for (const poly of polys) {
		if (poly.length < 3) continue;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		for (const [x, y] of poly) {
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
		}
		const y0 = Math.max(0, Math.floor(minY));
		const y1 = Math.min(h, Math.ceil(maxY));
		const x0 = Math.max(0, Math.floor(minX));
		const x1 = Math.min(w, Math.ceil(maxX));
		if (x1 <= x0 || y1 <= y0) continue;
		const cov = new Uint16Array(x1 - x0);
		for (let y = y0; y < y1; y++) {
			cov.fill(0);
			for (let sy = 0; sy < SS; sy++) {
				const py = y + (sy + 0.5) / SS;
				const xs: { x: number; d: number }[] = [];
				for (let i = 0; i < poly.length; i++) {
					const a = poly[i]!;
					const b = poly[(i + 1) % poly.length]!;
					if (a[1] === b[1]) continue;
					const up = a[1] < b[1];
					const lo = up ? a : b;
					const hi = up ? b : a;
					if (py < lo[1] || py >= hi[1]) continue;
					xs.push({ x: lo[0] + ((py - lo[1]) / (hi[1] - lo[1])) * (hi[0] - lo[0]), d: up ? 1 : -1 });
				}
				xs.sort((p, q) => p.x - q.x);
				let wind = 0;
				for (let k = 0; k < xs.length - 1; k++) {
					wind += xs[k]!.d;
					if (wind === 0) continue;
					const xa = xs[k]!.x;
					const xb = xs[k + 1]!.x;
					for (let sx = 0; sx < SS; sx++) {
						const off = (sx + 0.5) / SS;
						const start = Math.max(x0, Math.ceil(xa - off));
						const end = Math.min(x1 - 1, Math.floor(xb - off - 1e-9));
						for (let x = start; x <= end; x++) cov[x - x0] = cov[x - x0]! + 1;
					}
				}
			}
			for (let x = x0; x < x1; x++) {
				const v = Math.round((cov[x - x0]! / (SS * SS)) * 255);
				if (v > out[y * w + x]!) out[y * w + x] = v;
			}
		}
	}
	return out;
}

export { resample };
