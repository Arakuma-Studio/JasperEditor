// One roto job, in-process (used by the `jasper-roto` child process, cli.ts, and by tests): Roto Brush segmentation
// and propagation over a span, or face tracking, writing the content-addressed frames of the matte store
// (store.ts). Deterministic: a frame's segmentation is a function of its chain key (chainKeys), so frames already
// in the store are reused, never recomputed.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { matteSize, resample, rgbFloat } from '../core/image.ts';
import { decodeSeg, encodeGreyPng, encodeSeg } from '../core/codec.ts';
import {
	type Box,
	type EdgeOpts,
	type FrameSeg,
	type MaskModel,
	matteAlpha,
	propagateWith,
	type SegOpts,
	type Stroke,
	segmentWith,
	warpPrior,
} from '../core/segment.ts';
import {
	type FaceLandmarks,
	FaceModels,
	faceOutline,
	facePose,
	rasterPolygons,
	type Roi,
	roiOfDetection,
	roiOfLandmarks,
} from '../models/face.ts';
import { SamModel } from '../models/sam.ts';
import { hashKey, RotoStore } from '../store.ts';
import { CancelledError, type FrameSource, framesInOrder } from './frames.ts';

export { CancelledError };

/** Version of the segmentation pipeline (part of every chain key: bump when results change). */
export const ROTO_SEG_VERSION = 'roto-seg@1';
export const ROTO_FACE_VERSION = 'roto-face@1';
/** Longest side of the working (matte) resolution. */
export const MATTE_MAX_SIDE = 1920;
/** Longest side of the optical flow computation. */
const FLOW_MAX_SIDE = 960;
/** Frames between full face re-detections while tracking. */
const FACE_REDETECT = 12;

export type RotoJobSpec = {
	store: string;
	jobId: string;
	ffmpeg: string;
	file: string;
	mediaKey: string;
	display: { width: number; height: number };
	rate: { num: number; den: number };
	still: boolean;
	/** Number of media frames (null unknown). */
	frameCount: number | null;
	roto: {
		kind: 'brush' | 'faces';
		base: number | null;
		span: [number, number];
		strokes: { kind: Stroke['kind']; frame: number; radius: number; points: [number, number][] }[];
		boxes: { frame: number; rect: [number, number, number, number] }[];
		settings: {
			engine: 'model' | 'classic';
			model: string;
			quality: 'standard' | 'best';
			searchRadius: number;
			motionThreshold: number;
			motionDamping: number;
			edgeMode: 'off' | 'guided' | 'closed-form';
			edgeRadius: number;
			edgeSmooth: number;
			faceThreshold: number;
			faceExpand: number;
			faceShape: 'outline' | 'ellipse';
		};
	};
	direction: 'both' | 'forward' | 'backward' | 'frame';
	frame?: number;
	/** Installed model directories: SAM (brush, engine `model`), the face models (faces). */
	samDir?: string | null;
	faceDir?: string | null;
	threads?: number;
};

export type RotoFaceTrackOut = {
	id: number;
	startFrame: number;
	poses: [number, number, number, number][];
	present: number[];
};

export type RotoJobOutput = {
	width: number;
	height: number;
	/** Frame → matte key of every frame now in the store for this roto (contiguous around the base). */
	frames: Record<number, string>;
	start: number;
	end: number;
	computed: number;
	reused: number;
	modelFrames: number;
	area: Record<number, number>;
	model: string | null;
	faces?: RotoFaceTrackOut[];
	ms: number;
};

export type RotoRunOptions = {
	signal?: AbortSignal;
	onProgress?(fraction: number, stage: string): void;
	onFrame?(frame: number, area: number, done: number, total: number): void;
};

/** Chain keys of the frames of a brush roto (empty without a base). */
export function chainKeys(
	seed: string,
	base: number | null,
	span: [number, number],
	strokesAt: (f: number) => unknown,
): Map<number, string> {
	const out = new Map<number, string>();
	if (base === null) return out;
	const k0 = hashKey(seed, base, strokesAt(base));
	out.set(base, k0);
	let k = k0;
	for (let f = base + 1; f <= span[1]; f++) {
		k = hashKey(k, f, strokesAt(f));
		out.set(f, k);
	}
	k = k0;
	for (let f = base - 1; f >= span[0]; f--) {
		k = hashKey(k, f, strokesAt(f));
		out.set(f, k);
	}
	return out;
}

let cvModule: any = null;
let cvReady: Promise<void> | null = null;
/**
 * OpenCV.js (Farnebäck optical flow), loaded once. The module object is a thenable, so it never travels through a
 * promise (that would adopt it forever): the promise only signals readiness.
 */
async function loadCv(): Promise<any> {
	if (!cvReady)
		cvReady = new Promise<void>((resolve) => {
			const cv = createRequire(import.meta.url)('@techstark/opencv-js');
			const done = () => {
				cvModule = cv;
				resolve();
			};
			if (typeof cv.then === 'function') cv.then(done);
			else cv.onRuntimeInitialized = done;
		});
	await cvReady;
	return { cv: cvModule };
}

/**
 * Dense optical flow next → prev (per pixel of `next`, where it was in `prev`), matte px, by Farnebäck on grey
 * images at ≤ FLOW_MAX_SIDE, upsampled.
 */
async function flowNextToPrev(
	prev: Uint8Array,
	next: Uint8Array,
	w: number,
	h: number,
): Promise<Float32Array> {
	const { cv } = await loadCv();
	const s = Math.min(1, FLOW_MAX_SIDE / Math.max(w, h));
	const fw = Math.max(8, Math.round(w * s));
	const fh = Math.max(8, Math.round(h * s));
	const grey = (rgb: Uint8Array) => {
		const g = new Float32Array(w * h);
		for (let i = 0; i < w * h; i++)
			g[i] = (0.2126 * rgb[i * 3]! + 0.7152 * rgb[i * 3 + 1]! + 0.0722 * rgb[i * 3 + 2]!) / 255;
		const r = resample(g, w, h, 1, fw, fh);
		const m = new cv.Mat(fh, fw, cv.CV_8UC1);
		for (let i = 0; i < fw * fh; i++) m.data[i] = Math.round(Math.min(1, Math.max(0, r[i]!)) * 255);
		return m;
	};
	const a = grey(next);
	const b = grey(prev);
	const f = new cv.Mat();
	try {
		cv.calcOpticalFlowFarneback(a, b, f, 0.5, 4, 21, 3, 5, 1.2, 0);
		const small = Float32Array.from(f.data32F as Float32Array);
		const up = resample(small, fw, fh, 2, w, h);
		for (let i = 0; i < up.length; i++) up[i] = up[i]! / s;
		return up;
	} finally {
		a.delete();
		b.delete();
		f.delete();
	}
}

function quantize(alpha: Float32Array): Uint8Array {
	const out = new Uint8Array(alpha.length);
	for (let i = 0; i < alpha.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, alpha[i]!)) * 255);
	return out;
}

function areaOf(m: Uint8Array): number {
	let s = 0;
	for (let i = 0; i < m.length; i++) s += m[i]!;
	return Math.round((s / (255 * Math.max(1, m.length))) * 1e6) / 1e6;
}

/** Runs a roto job. */
export async function runRotoJob(spec: RotoJobSpec, opts: RotoRunOptions = {}): Promise<RotoJobOutput> {
	const t0 = performance.now();
	const store = new RotoStore(spec.store);
	const { width, height } = matteSize(spec.display.width, spec.display.height, MATTE_MAX_SIDE);
	const src: FrameSource = {
		ffmpeg: spec.ffmpeg,
		file: spec.file,
		rate: spec.rate,
		width,
		height,
		display: spec.display,
		still: spec.still,
	};
	const lastFrame = spec.frameCount !== null ? spec.frameCount - 1 : Number.POSITIVE_INFINITY;
	const span: [number, number] = [
		Math.max(0, spec.roto.span[0]),
		Math.min(spec.roto.span[1], spec.still ? 0 : lastFrame),
	];
	if (span[1] < span[0]) throw new Error('The roto span lies outside the media');
	const write = (path: string, data: Uint8Array | string) => store.write(path, data);
	if (spec.roto.kind === 'faces') return runFaces(spec, src, span, store, write, opts, t0);
	return runBrush(spec, src, span, store, write, opts, t0);
}

// ---------------------------------------------------------------- Roto Brush

async function runBrush(
	spec: RotoJobSpec,
	src: FrameSource,
	span: [number, number],
	store: RotoStore,
	write: (p: string, d: Uint8Array | string) => Promise<void>,
	opts: RotoRunOptions,
	t0: number,
): Promise<RotoJobOutput> {
	const { width: w, height: h } = src;
	const st = spec.roto.settings;
	const base = spec.roto.base;
	if (base === null) throw new Error('The roto has nothing selected yet: paint a stroke or draw a box');
	if (base < span[0] || base > span[1]) throw new Error('The base frame lies outside the span');
	const sx = w / spec.display.width;
	const sy = h / spec.display.height;
	const sr = Math.sqrt(sx * sy);
	const strokesByFrame = new Map<number, Stroke[]>();
	const rawByFrame = new Map<number, unknown[]>();
	for (const s of spec.roto.strokes) {
		const list = strokesByFrame.get(s.frame) ?? [];
		list.push({
			kind: s.kind,
			radius: s.radius * sr,
			points: s.points.map(([x, y]) => [x * sx, y * sy] as const),
		});
		strokesByFrame.set(s.frame, list);
		const raw = rawByFrame.get(s.frame) ?? [];
		raw.push([s.kind, s.radius, s.points]);
		rawByFrame.set(s.frame, raw);
	}
	const boxes = new Map<number, Box>();
	for (const b of spec.roto.boxes) {
		boxes.set(b.frame, [b.rect[0] * sx, b.rect[1] * sy, b.rect[2] * sx, b.rect[3] * sy]);
		const raw = rawByFrame.get(b.frame) ?? [];
		raw.push(['box', b.rect]);
		rawByFrame.set(b.frame, raw);
	}
	const useModel = st.engine === 'model' && !!spec.samDir;
	const modelId = useModel ? st.model : null;
	const seed = hashKey(
		ROTO_SEG_VERSION,
		spec.mediaKey,
		w,
		h,
		spec.rate,
		st.quality,
		st.searchRadius,
		st.motionThreshold,
		st.motionDamping,
		modelId,
	);
	const keys = chainKeys(seed, base, span, (f) => rawByFrame.get(f) ?? []);
	const edge: EdgeOpts = { mode: st.edgeMode, radius: st.edgeRadius * sr, smooth: st.edgeSmooth };
	const matteKeyOf = (f: number) => hashKey(keys.get(f)!, 'edge@1', edge);
	const opts2: SegOpts = {
		searchRadius: st.searchRadius * sr,
		motionThreshold: st.motionThreshold,
		motionDamping: st.motionDamping,
		best: st.quality === 'best',
	};
	const refineRadius = Math.max(
		0,
		...spec.roto.strokes.filter((s) => s.kind === 'refine').map((s) => s.radius * sr),
	);

	// Runs: base outwards, per direction.
	const runs: number[][] = [];
	const fwd: number[] = [];
	const bwd: number[] = [];
	for (let f = base; f <= span[1]; f++) fwd.push(f);
	for (let f = base; f >= span[0]; f--) bwd.push(f);
	if (spec.direction === 'frame') {
		const target = Math.min(span[1], Math.max(span[0], spec.frame ?? base));
		runs.push(target >= base ? fwd.slice(0, target - base + 1) : bwd.slice(0, base - target + 1));
	} else {
		if (spec.direction !== 'backward') runs.push(fwd);
		if (spec.direction !== 'forward') runs.push(bwd);
	}
	const total = new Set(runs.flat()).size;
	let done = 0;
	let computed = 0;
	let reused = 0;
	let modelFrames = 0;
	const frames: Record<number, string> = {};
	const area: Record<number, number> = {};
	let model: MaskModel | null = null;
	const getModel = async (): Promise<MaskModel | null> => {
		if (!useModel) return null;
		if (!model) {
			opts.onProgress?.(0, 'Loading the segmentation model');
			model = await SamModel.load(
				st.model,
				{
					encoder: `${spec.samDir}/vision_encoder.onnx`,
					decoder: `${spec.samDir}/prompt_encoder_mask_decoder.onnx`,
				},
				spec.threads ?? 2,
			);
		}
		return model;
	};
	const cached = async (f: number) =>
		(await store.has(store.pngPath(matteKeyOf(f)))) && (await store.has(store.segPath(keys.get(f)!)));
	const seen = new Set<number>();
	const finishFrame = async (f: number, alpha8: Uint8Array | null, wasReused: boolean) => {
		frames[f] = matteKeyOf(f);
		if (alpha8) area[f] = areaOf(alpha8);
		if (seen.has(f)) return;
		seen.add(f);
		done++;
		if (wasReused) reused++;
		else computed++;
		opts.onFrame?.(f, area[f] ?? 0, done, total);
		opts.onProgress?.(done / total, `Frame ${done}/${total}`);
	};
	try {
		for (const run of runs) {
			if (opts.signal?.aborted) throw new CancelledError();
			// Leading frames already in the store.
			let i = 0;
			while (i < run.length && (await cached(run[i]!))) {
				await finishFrame(run[i]!, null, true);
				i++;
			}
			if (i === run.length) continue;
			// Decode from the predecessor of the first missing frame (its picture feeds the flow).
			const from = Math.max(0, i - 1);
			let prevSeg: FrameSeg | null = null;
			let prevRgb: Uint8Array | null = null;
			let k = from;
			for await (const { frame, rgb } of framesInOrder(src, run.slice(from), opts.signal)) {
				if (opts.signal?.aborted) throw new CancelledError();
				if (frame !== run[k]) throw new Error(`Frame order mismatch at ${frame}`);
				const chain = keys.get(frame)!;
				if (k < i || (await cached(frame))) {
					// Known: load its segmentation for the next frame.
					const buf = await readFile(store.segPath(chain));
					prevSeg = decodeSeg(buf);
					if (!prevSeg) throw new Error(`Corrupt segmentation record ${chain}`);
					prevRgb = rgb;
					if (k >= i) await finishFrame(frame, null, true);
					k++;
					continue;
				}
				const img = rgbFloat(rgb);
				const strokes = strokesByFrame.get(frame) ?? [];
				const box = boxes.get(frame) ?? null;
				const m = await getModel();
				let res: { seg: FrameSeg; usedModel: boolean };
				if (frame === base || !prevSeg || !prevRgb) {
					res = await segmentWith(img, w, h, strokes, box, null, opts2, refineRadius, m, `${frame}`);
				} else {
					const flow = await flowNextToPrev(prevRgb, rgb, w, h);
					if (box) {
						const prior = warpPrior(prevSeg, flow, w, h, opts2);
						res = await segmentWith(img, w, h, strokes, box, prior, opts2, refineRadius, m, `${frame}`);
					} else
						res = await propagateWith(prevSeg, flow, img, w, h, strokes, opts2, refineRadius, m, `${frame}`);
				}
				if (res.usedModel) modelFrames++;
				const alpha8 = quantize(matteAlpha(img, res.seg, edge, refineRadius));
				await write(store.segPath(chain), encodeSeg(res.seg));
				await write(store.pngPath(matteKeyOf(frame)), encodeGreyPng(alpha8, w, h));
				prevSeg = res.seg;
				prevRgb = rgb;
				await finishFrame(frame, alpha8, false);
				k++;
			}
			if (k < run.length)
				throw new Error(`The media ended at frame ${run[k - 1] ?? run[0]}: shorten the span`);
		}
	} finally {
		if (model) await (model as SamModel).release();
	}
	// The contiguous range around the base that is now in the store.
	let start = base;
	let end = base;
	if (!frames[base]) throw new Error('The base frame was not computed');
	while (start - 1 >= span[0] && (frames[start - 1] || (await cached(start - 1)))) {
		start--;
		frames[start] ??= matteKeyOf(start);
	}
	while (end + 1 <= span[1] && (frames[end + 1] || (await cached(end + 1)))) {
		end++;
		frames[end] ??= matteKeyOf(end);
	}
	for (const f of Object.keys(frames).map(Number)) if (f < start || f > end) delete frames[f];
	return {
		width: w,
		height: h,
		frames,
		start,
		end,
		computed,
		reused,
		modelFrames,
		area,
		model: modelId,
		ms: Math.round(performance.now() - t0),
	};
}

// ---------------------------------------------------------------- faces

type FaceTrack = {
	id: number;
	startFrame: number;
	roi: Roi | null;
	last: FaceLandmarks | null;
	lost: number;
	poses: [number, number, number, number][];
	present: number[];
};

function boxOfPoints(points: Float32Array): [number, number, number, number] {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < points.length / 3; i++) {
		x0 = Math.min(x0, points[i * 3]!);
		x1 = Math.max(x1, points[i * 3]!);
		y0 = Math.min(y0, points[i * 3 + 1]!);
		y1 = Math.max(y1, points[i * 3 + 1]!);
	}
	return [x0, y0, x1, y1];
}

function iou4(a: readonly number[], b: readonly number[]): number {
	const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
	const iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
	const inter = ix * iy;
	const u = (a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter;
	return u > 0 ? inter / u : 0;
}

/** An ellipse polygon around a face pose (Face Tracking "ellipse" shape). */
function ellipseOf(
	pose: { cx: number; cy: number; size: number; angle: number },
	grow: number,
): [number, number][] {
	const out: [number, number][] = [];
	const ry = (pose.size / 2) * 1.12 * grow;
	const rx = ry * 0.78;
	const c = Math.cos(pose.angle);
	const s = Math.sin(pose.angle);
	for (let i = 0; i < 48; i++) {
		const t = (i / 48) * Math.PI * 2;
		const u = Math.cos(t) * rx;
		const v = Math.sin(t) * ry;
		out.push([pose.cx + u * c - v * s, pose.cy + u * s + v * c]);
	}
	return out;
}

async function runFaces(
	spec: RotoJobSpec,
	src: FrameSource,
	span: [number, number],
	store: RotoStore,
	write: (p: string, d: Uint8Array | string) => Promise<void>,
	opts: RotoRunOptions,
	t0: number,
): Promise<RotoJobOutput> {
	if (!spec.faceDir) throw new Error('The face tracking model is not installed');
	const { width: w, height: h } = src;
	const st = spec.roto.settings;
	const sx = spec.display.width / w;
	const sy = spec.display.height / h;
	opts.onProgress?.(0, 'Loading the face models');
	const models = await FaceModels.load(
		'mediapipe-face-landmarker',
		{ detector: `${spec.faceDir}/face_detector.onnx`, landmarks: `${spec.faceDir}/face_landmarks.onnx` },
		spec.threads ?? 2,
	);
	const seed = hashKey(
		ROTO_FACE_VERSION,
		spec.mediaKey,
		w,
		h,
		spec.rate,
		span[0],
		st.faceThreshold,
		st.faceExpand,
		st.faceShape,
	);
	const frames: Record<number, string> = {};
	const area: Record<number, number> = {};
	const tracks: FaceTrack[] = [];
	let nextId = 0;
	const total = span[1] - span[0] + 1;
	let done = 0;
	const list: number[] = [];
	for (let f = span[0]; f <= span[1]; f++) list.push(f);
	try {
		for await (const { frame, rgb } of framesInOrder(src, list, opts.signal)) {
			if (opts.signal?.aborted) throw new CancelledError();
			const img = rgbFloat(rgb);
			const k = frame - span[0];
			const live = tracks.filter((t) => t.lost < 3);
			// Re-detect on the first frame, every FACE_REDETECT frames, and whenever a face was lost.
			if (k % FACE_REDETECT === 0 || live.length === 0 || live.some((t) => t.lost > 0)) {
				const dets = await models.detect(img, w, h, st.faceThreshold);
				for (const d of dets) {
					const db = [d.x0, d.y0, d.x1, d.y1];
					const match = live.find((t) => t.last && iou4(boxOfPoints(t.last.points), db) > 0.3);
					if (match) {
						if (match.lost > 0) match.roi = roiOfDetection(d);
						continue;
					}
					tracks.push({
						id: nextId++,
						startFrame: frame,
						roi: roiOfDetection(d),
						last: null,
						lost: 0,
						poses: [],
						present: [],
					});
				}
			}
			const polys: [number, number][][] = [];
			for (const t of tracks) {
				if (t.startFrame > frame) continue;
				let ok = false;
				if (t.roi && t.lost < 3) {
					const lm = await models.landmarks(img, w, h, t.roi);
					if (lm.presence >= 0.5) {
						t.last = lm;
						t.roi = roiOfLandmarks(lm.points);
						t.lost = 0;
						ok = true;
					} else t.lost++;
				} else if (t.lost < 3) t.lost++;
				const pose = t.last ? facePose(t.last.points) : null;
				t.poses.push(
					pose
						? [pose.cx * sx, pose.cy * sy, pose.size * Math.sqrt(sx * sy), pose.angle]
						: (t.poses[t.poses.length - 1] ?? [0, 0, 0, 0]),
				);
				t.present.push(ok ? 1 : 0);
				if (ok && t.last && pose) {
					const grow = 1 + st.faceExpand / 100;
					polys.push(
						st.faceShape === 'ellipse' ? ellipseOf(pose, grow) : faceOutline(t.last.points, grow - 1),
					);
				}
			}
			const matte = rasterPolygons(polys, w, h);
			const mk = hashKey(seed, frame);
			await write(store.pngPath(mk), encodeGreyPng(matte, w, h));
			frames[frame] = mk;
			area[frame] = areaOf(matte);
			done++;
			opts.onFrame?.(frame, area[frame]!, done, total);
			opts.onProgress?.(
				done / total,
				`Frame ${done}/${total} · ${tracks.filter((t) => t.lost === 0).length} face(s)`,
			);
		}
	} finally {
		await models.release();
	}
	if (done < total) throw new Error(`The media ended at frame ${span[0] + done - 1}: shorten the span`);
	return {
		width: w,
		height: h,
		frames,
		start: span[0],
		end: span[1],
		computed: done,
		reused: 0,
		modelFrames: done,
		area,
		model: 'mediapipe-face-landmarker',
		faces: tracks
			.filter((t) => t.present.some((p) => p === 1))
			.map((t) => ({ id: t.id, startFrame: t.startFrame, poses: t.poses, present: t.present })),
		ms: Math.round(performance.now() - t0),
	};
}
