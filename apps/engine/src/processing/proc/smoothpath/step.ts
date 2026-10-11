// The smooth-path stabiliser frame step of jasper-proc (S07:PST-005), a port of the trailer's
// `grade/tools/smoothstab.py`:
//   analyse: decode the input as 8-bit luma (≤ 960 px wide), find scene cuts (the de-judder's cut guard),
//            track Shi-Tomasi corners frame to frame with pyramidal Lucas-Kanade (OpenCV.js, worker threads), fit
//            one similarity per pair with RANSAC (the moving subject is an outlier), and per SHOT (the segments
//            between cuts) accumulate the camera path, smooth it (Gaussian sigma in frames; y / roll optionally a
//            straight line) and choose ONE static zoom (capped; falls back to the largest smoothing that fits);
//   push:    warp each 16-bit RGB frame with its correction (a similarity), bicubic — through the vid.stab WASM
//            warp kernel (row bands in worker threads) when it loads, else OpenCV.js `warpAffine` (frames in
//            parallel in the OpenCV worker pool). 1 frame in, 1 frame out, one resampling.
import type { ProcessStep } from '@jasper/project';
import { CvPool, resolveWorkerUrl, type TrackParams } from '../dejudder/pool.ts';
import { CUT_THRESHOLD, cutScore, greyCellMeans } from '../dejudder/step.ts';
import { decodeFrames } from '../ffio.ts';
import type { DecodeSpec, FrameStep, RgbFrame, StepContext } from '../types.ts';
import { detectionSize } from '../vidstab/math.ts';
import { WarpPool } from '../vidstab/pool.ts';
import { loadVidstabModule, resolveVidstabWasm, type VsTransform } from '../vidstab/wasm.ts';
import {
	backwardToVsTransform,
	IDENTITY_SIM,
	planSegmentedSmoothPath,
	ransacSimilarity,
	type SegmentedPlan,
	type SegmentPlan,
	type Similarity,
} from './math.ts';

type StabilizeStep = Extract<ProcessStep, { op: 'stabilize' }>;

/** Defaults of the smooth-path parameters (the trailer's T01 settings, sigma 30 f, cap 112 %). */
const SMOOTHPATH_DEFAULTS = { sigma: 30, maxZoomPercent: 112 } as const;

/** smoothstab.py's tracking parameters (at ≤ 960 px wide). */
const TRACK_PARAMS: TrackParams = {
	maxCorners: 2000,
	quality: 0.01,
	minDistance: 6,
	winSize: 21,
	maxLevel: 3,
};

/** RANSAC inlier distance in tracking-frame pixels (smoothstab.py: 1.5). */
const RANSAC_THRESHOLD = 1.5;
/** Fewer background inliers than this: the pair is unreliable (blur, flat frame) and counts as still. */
const MIN_INLIERS = 12;
/**
 * A cut candidate (cell guard) is a cut when fewer than this share of the tracked corners fit one camera motion.
 * Measured on crudo.mp4 frames 0–1800: across its 7 real cuts 0.01–0.20 (Lucas-Kanade "tracks" into unrelated
 * content), across fast real motion (the T01 reframe, walking shots) never below 0.38; reframe.mp4's synthetic
 * cut 0.11.
 */
const CUT_MAX_INLIER_RATIO = 0.3;

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => Number(x.toFixed(2));
const f3 = (x: number) => Number(x.toFixed(3));

const isIdentity = (m: readonly number[]) =>
	Math.abs(m[0] - 1) < 1e-12 &&
	Math.abs(m[1]) < 1e-12 &&
	Math.abs(m[2]) < 1e-9 &&
	Math.abs(m[3]) < 1e-12 &&
	Math.abs(m[4] - 1) < 1e-12 &&
	Math.abs(m[5]) < 1e-9;

export function createSmoothPathStep(
	step: Pick<StabilizeStep, 'smoothing' | 'borders' | 'lockVertical' | 'lockRotation' | 'maxZoom'>,
): FrameStep {
	const sigma = Math.max(0, step.smoothing ?? SMOOTHPATH_DEFAULTS.sigma);
	const crop = step.borders !== 'keep';
	const maxZoomPercent = step.maxZoom ?? SMOOTHPATH_DEFAULTS.maxZoomPercent;
	const border: 0 | 1 = crop ? 1 : 0;
	let plan: SegmentedPlan | null = null;
	let size = { width: 0, height: 0 };
	let warpMs = 0;
	let warped = 0;
	let ctxRef: StepContext | null = null;
	// Warp engines.
	let engine: 'wasm' | 'opencv' | null = null;
	let wasmPool: WarpPool | null = null;
	let transforms: VsTransform[] = [];
	let cvPool: CvPool | null = null;
	const queue: Array<Promise<RgbFrame>> = [];

	const threadsFor = (ctx: StepContext) => Math.min(8, Math.max(1, ctx.threads));

	return {
		name: 'stabilize(smooth path)',
		async analyse(input: DecodeSpec, ctx: StepContext): Promise<void> {
			const t0 = performance.now();
			const det = detectionSize(input.width, input.height, 960);
			const sx = input.width / det.width;
			const sy = input.height / det.height;
			const cv = await CvPool.create(threadsFor(ctx), resolveWorkerUrl());
			const pairs: Array<Promise<Similarity | null>> = [];
			const inliers: number[] = [];
			const cutAfter = new Set<number>();
			let failed = 0;
			try {
				let prev: Uint8Array | null = null;
				let prevMeans: Float64Array | null = null;
				let index = 0;
				const inFlight = new Set<Promise<Similarity | null>>();
				const limit = Math.max(2, cv.size * 2);
				for await (const buf of decodeFrames(input, {
					pixFmt: 'gray',
					width: det.width,
					height: det.height,
					signal: ctx.signal,
				})) {
					const cur = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
					const means = greyCellMeans(cur, det.width, det.height);
					if (prev && prevMeans) {
						const pairIndex = index - 1;
						// Scene-cut candidate: the de-judder's cut guard (8×8-cell means). A fast pan can trip it too
						// (crudo.mp4's operator reframe scores > 0.10), so a candidate only counts as a cut when the
						// background cannot be tracked across it either (few RANSAC inliers among the tracked corners).
						const candidate = cutScore(prevMeans, means) > CUT_THRESHOLD;
						const job = cv.track(det.width, det.height, prev, cur, TRACK_PARAMS).then((r) => {
							// Tracking-frame pixel centres → input pixel centres.
							const map = (p: Float32Array) => {
								const out = new Float64Array(p.length);
								for (let i = 0; i < p.length; i += 2) {
									out[i] = (p[i] + 0.5) * sx - 0.5;
									out[i + 1] = (p[i + 1] + 0.5) * sy - 0.5;
								}
								return out;
							};
							const fit = ransacSimilarity(map(r.p0), map(r.p1), {
								threshold: RANSAC_THRESHOLD * Math.max(sx, sy),
								seed: 0x5eed + pairIndex,
							});
							inliers[pairIndex] = fit?.inliers ?? 0;
							const tracked = r.p0.length / 2;
							const ratio = tracked ? (fit?.inliers ?? 0) / tracked : 0;
							if (candidate && (ratio < CUT_MAX_INLIER_RATIO || !fit || fit.inliers < MIN_INLIERS)) {
								// A scene cut: not camera motion; the shots on both sides are planned separately.
								cutAfter.add(pairIndex);
								return IDENTITY_SIM;
							}
							return fit && fit.inliers >= MIN_INLIERS ? fit.sim : null;
						});
						pairs.push(job);
						inFlight.add(job);
						job.finally(() => inFlight.delete(job)).catch(() => {});
						while (inFlight.size >= limit) await Promise.race(inFlight);
					}
					prev = cur;
					prevMeans = means;
					index++;
					if (index % 8 === 0) ctx.analysisProgress(Math.min(0.99, index / input.frames));
				}
				const fits = await Promise.all(pairs);
				// Frames the decoder did not deliver count as still (the runner verifies the frame count anyway).
				while (fits.length < input.frames - 1) fits.push(null);
				const sims = fits.map((s) => {
					if (s) return s;
					failed++;
					return IDENTITY_SIM;
				});
				ctx.analysisProgress(1);
				const tTrack = performance.now();
				plan = planSegmentedSmoothPath(sims, cutAfter, input.width, input.height, {
					sigma,
					lockVertical: step.lockVertical === true,
					lockRotation: step.lockRotation === true,
					maxZoom: maxZoomPercent / 100,
					borders: crop ? 'crop' : 'keep',
				});
				report(ctx, plan, {
					det,
					pairs: sims.length,
					failed,
					inliers,
					cuts: [...cutAfter].map((i) => i + 1),
					trackSeconds: (tTrack - t0) / 1000,
					planSeconds: (performance.now() - tTrack) / 1000,
				});
			} finally {
				await cv.close();
			}
		},

		async open(ctx: StepContext): Promise<{ width: number; height: number }> {
			ctxRef = ctx;
			size = { width: ctx.width, height: ctx.height };
			if (!plan) throw new Error('stabilize: analyse() must run before open()');
			const pref = process.env.JASPER_SMOOTHPATH_WARP;
			if (pref !== 'opencv') {
				try {
					const module = await loadVidstabModule(resolveVidstabWasm());
					wasmPool = await WarpPool.create(module, threadsFor(ctx));
					transforms = plan.backward.map((m) => backwardToVsTransform(m, size.width, size.height));
					engine = 'wasm';
				} catch (e) {
					if (pref === 'wasm') throw e;
					ctx.info('warpFallbackReason', (e as Error).message);
				}
			}
			if (!engine) {
				cvPool = await CvPool.create(threadsFor(ctx), resolveWorkerUrl());
				engine = 'opencv';
			}
			ctx.signal.addEventListener('abort', () => void cvPool?.close(), { once: true });
			return size;
		},

		async push(frame: RgbFrame): Promise<RgbFrame[]> {
			if (!engine || !plan) throw new Error('stabilize: not opened');
			if (frame.width !== size.width || frame.height !== size.height)
				throw new Error(`stabilize: frame ${frame.width}x${frame.height} != ${size.width}x${size.height}`);
			const m = plan.backward[frame.index];
			if (engine === 'wasm' && wasmPool) {
				if (!m || isIdentity(m)) return [frame];
				const t0 = performance.now();
				await wasmPool.warp(frame.data, frame.width, frame.height, transforms[frame.index], border);
				warpMs += performance.now() - t0;
				warped++;
				return [frame];
			}
			// OpenCV: frames warp in parallel in the worker pool; output stays in order.
			const pool = cvPool as CvPool;
			if (!m || isIdentity(m)) queue.push(Promise.resolve(frame));
			else {
				const t0 = performance.now();
				queue.push(
					pool.warpAffine(frame.width, frame.height, frame.data, m, border).then((data) => {
						warpMs += performance.now() - t0;
						warped++;
						return { ...frame, data };
					}),
				);
			}
			const out: RgbFrame[] = [];
			const limit = Math.max(2, pool.size * 2);
			while (queue.length > limit) out.push(await (queue.shift() as Promise<RgbFrame>));
			return out;
		},

		async end(): Promise<RgbFrame[]> {
			const out: RgbFrame[] = [];
			while (queue.length) out.push(await (queue.shift() as Promise<RgbFrame>));
			if (ctxRef)
				ctxRef.info('warp', {
					engine,
					threads: wasmPool?.threads ?? cvPool?.size ?? 0,
					frames: warped,
					// OpenCV frames overlap: this is the mean latency per frame, not throughput.
					msPerFrame: warped ? Number((warpMs / warped).toFixed(2)) : 0,
				});
			return out;
		},

		async close(): Promise<void> {
			queue.length = 0;
			await wasmPool?.close();
			wasmPool = null;
			await cvPool?.close();
			cvPool = null;
		},
	};

	function report(
		ctx: StepContext,
		p: SegmentedPlan,
		t: {
			det: { width: number; height: number };
			pairs: number;
			failed: number;
			inliers: number[];
			cuts: number[];
			trackSeconds: number;
			planSeconds: number;
		},
	): void {
		const first = p.segments[0] as SegmentPlan;
		const shots = p.segments.length;
		const range = (s: SegmentPlan) => `frames ${s.firstFrame}–${s.firstFrame + s.stats.frames - 1}`;
		ctx.info('engine', 'smoothpath');
		ctx.info('request', {
			sigma,
			lockVertical: step.lockVertical === true,
			lockRotation: step.lockRotation === true,
			maxZoomPercent,
			borders: crop ? 'crop' : 'keep',
		});
		ctx.info('used', {
			sigma: Math.min(...p.segments.map((s) => s.sigma)),
			lockVertical: p.segments.every((s) => s.lockVertical),
			lockRotation: p.segments.every((s) => s.lockRotation),
		});
		ctx.info('zoomPercent', f2(p.zoom * 100));
		ctx.info('fallback', p.segments.find((s) => s.fallback)?.fallback ?? null);
		ctx.info('speed', {
			rawMaxPxPerFrame1080: f2(p.stats.rawSpeedMax1080),
			smoothedMaxPxPerFrame1080: f2(p.stats.smoothedSpeedMax1080),
			rawMaxAccel1080: f2(Math.max(...p.segments.map((s) => s.stats.rawAccelMax1080))),
			smoothedMaxAccel1080: f2(Math.max(...p.segments.map((s) => s.stats.smoothedAccelMax1080))),
		});
		ctx.info('camera', { travelPx: first.stats.travelPx.map(f2), rotationDeg: f3(first.stats.rotationDeg) });
		ctx.info('cuts', t.cuts);
		ctx.info(
			'segments',
			p.segments.map((s) => ({
				firstFrame: s.firstFrame,
				frames: s.stats.frames,
				zoomPercent: f2(s.zoom * 100),
				sigma: s.sigma,
				lockVertical: s.lockVertical,
				lockRotation: s.lockRotation,
				fallback: s.fallback,
				travelPx: s.stats.travelPx.map(f2),
				rotationDeg: f3(s.stats.rotationDeg),
				rawMaxPxPerFrame1080: f2(s.stats.rawSpeedMax1080),
				smoothedMaxPxPerFrame1080: f2(s.stats.smoothedSpeedMax1080),
			})),
		);
		const tracked = t.inliers.filter((x) => x !== undefined);
		ctx.info('tracking', {
			width: t.det.width,
			height: t.det.height,
			pairs: t.pairs,
			failedPairs: t.failed,
			minInliers: tracked.length ? Math.min(...tracked) : 0,
		});
		ctx.info('timing', { trackSeconds: f3(t.trackSeconds), planSeconds: f3(t.planSeconds) });
		for (const s of p.segments) {
			if (!s.fallback) continue;
			const f = s.fallback;
			ctx.note(
				`stabilize (smooth path): ${shots > 1 ? `shot ${range(s)}: ` : ''}smoothing ${f1(f.requestedSigma)} frames needs ${
					Number.isFinite(f.neededZoom) ? `${f1(f.neededZoom * 100)} %` : 'more than 400 %'
				} zoom, above the ${f1(maxZoomPercent)} % cap — used the largest smoothing that fits: ${f1(
					s.sigma,
				)} frames${f.locksReleased ? ' with vertical/rotation unlocked' : ''}. Raise Max zoom to keep the requested smoothing.`,
			);
		}
		const locks = [
			first.lockVertical && shots === 1 ? 'vertical locked' : '',
			first.lockRotation && shots === 1 ? 'rotation locked' : '',
		]
			.filter(Boolean)
			.join(', ');
		const perShot =
			shots > 1
				? `; ${shots} shots (cut${t.cuts.length > 1 ? 's' : ''} at frame ${t.cuts.join(', ')}) stabilised separately, zoom ${p.segments
						.map((s) => `${f1(s.zoom * 100)} %`)
						.join(' / ')}`
				: '';
		ctx.note(
			`stabilize (smooth path): zoom ${f1(p.zoom * 100)} %, camera speed max ${f1(
				p.stats.rawSpeedMax1080,
			)} → ${f1(p.stats.smoothedSpeedMax1080)} px/frame (1080p), smoothing ${f1(first.sigma)} frames${
				locks ? `, ${locks}` : ''
			}${perShot}`,
		);
		if (t.pairs > 0 && t.failed > t.pairs / 4)
			ctx.note(
				`stabilize (smooth path): the background could not be tracked in ${t.failed} of ${t.pairs} frame pairs (blur or flat image); those frames are treated as still`,
			);
	}
}
