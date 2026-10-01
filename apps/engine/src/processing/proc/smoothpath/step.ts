// The smooth-path stabiliser frame step of jasper-proc (S07:PST-005), a port of the trailer's
// `grade/tools/smoothstab.py`:
//   analyse: decode the input as 8-bit luma (≤ 960 px wide), track Shi-Tomasi corners frame to frame with
//            pyramidal Lucas-Kanade (OpenCV.js, worker threads), fit one similarity per pair with RANSAC (the
//            moving subject is an outlier), accumulate the camera path, smooth it (Gaussian sigma in frames;
//            y / roll optionally a straight line), and choose ONE static zoom for the whole shot (capped;
//            falls back to the largest smoothing that fits the cap);
//   push:    warp each 16-bit RGB frame with its correction (similarity) through the vid.stab WASM warp kernel
//            (bicubic, worker threads) — 1 frame in, 1 frame out, one resampling.
import type { ProcessStep } from '@jasper/project';
import { CvPool, resolveWorkerUrl, type TrackParams } from '../dejudder/pool.ts';
import { decodeFrames } from '../ffio.ts';
import type { DecodeSpec, FrameStep, RgbFrame, StepContext } from '../types.ts';
import { detectionSize } from '../vidstab/math.ts';
import { WarpPool } from '../vidstab/pool.ts';
import { loadVidstabModule, resolveVidstabWasm, type VsTransform } from '../vidstab/wasm.ts';
import {
	backwardToVsTransform,
	IDENTITY_SIM,
	planSmoothPath,
	ransacSimilarity,
	type Similarity,
	type SmoothPathPlan,
} from './math.ts';

type StabilizeStep = Extract<ProcessStep, { op: 'stabilize' }>;

/** Defaults of the smooth-path parameters (the trailer's T01 settings, sigma 30 f, cap 112 %). */
export const SMOOTHPATH_DEFAULTS = { sigma: 30, maxZoomPercent: 112 } as const;

/** smoothstab.py's tracking parameters (at ≤ 960 px wide). */
export const TRACK_PARAMS: TrackParams = {
	maxCorners: 2000,
	quality: 0.01,
	minDistance: 6,
	winSize: 21,
	maxLevel: 3,
};

/** RANSAC inlier distance in tracking-frame pixels (smoothstab.py: 1.5). */
const RANSAC_THRESHOLD = 1.5;
/** Fewer background inliers than this: the pair is unreliable (cut, blur, flat frame) and counts as still. */
const MIN_INLIERS = 12;

export type SmoothPathStepOptions = {
	/** Tracking frame at most this wide (default 960). */
	trackMaxWidth?: number;
	/** OpenCV worker threads (default ctx.threads, ≤ 8). */
	threads?: number;
	/** Warp worker threads (default ctx.threads, ≤ 8). */
	warpThreads?: number;
	workerUrl?: URL;
	wasmPath?: string;
};

export type SmoothPathFrameStep = FrameStep & { readonly plan: SmoothPathPlan | null };

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => Number(x.toFixed(2));
const f3 = (x: number) => Number(x.toFixed(3));

export function createSmoothPathStep(
	step: Pick<StabilizeStep, 'smoothing' | 'borders' | 'lockVertical' | 'lockRotation' | 'maxZoom'>,
	opts: SmoothPathStepOptions = {},
): SmoothPathFrameStep {
	const sigma = Math.max(0, step.smoothing ?? SMOOTHPATH_DEFAULTS.sigma);
	const crop = step.borders !== 'keep';
	const maxZoomPercent = step.maxZoom ?? SMOOTHPATH_DEFAULTS.maxZoomPercent;
	let plan: SmoothPathPlan | null = null;
	let transforms: VsTransform[] = [];
	let module: WebAssembly.Module | null = null;
	let pool: WarpPool | null = null;
	let size = { width: 0, height: 0 };
	let warpMs = 0;
	let warped = 0;
	let ctxRef: StepContext | null = null;

	return {
		name: 'stabilize(smooth path)',
		get plan() {
			return plan;
		},

		async analyse(input: DecodeSpec, ctx: StepContext): Promise<void> {
			const t0 = performance.now();
			const wasmPath = opts.wasmPath ?? resolveVidstabWasm();
			module = await loadVidstabModule(wasmPath);
			const det = detectionSize(input.width, input.height, opts.trackMaxWidth ?? 960);
			const sx = input.width / det.width;
			const sy = input.height / det.height;
			const cv = await CvPool.create(
				opts.threads ?? Math.min(8, Math.max(1, ctx.threads)),
				opts.workerUrl ?? resolveWorkerUrl(),
			);
			const pairs: Array<Promise<Similarity | null>> = [];
			const inliers: number[] = [];
			let failed = 0;
			try {
				let prev: Uint8Array | null = null;
				let index = 0;
				const inFlight = new Set<Promise<unknown>>();
				const limit = Math.max(2, cv.size * 2);
				for await (const buf of decodeFrames(input, {
					pixFmt: 'gray',
					width: det.width,
					height: det.height,
					signal: ctx.signal,
				})) {
					const cur = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
					if (prev) {
						const pairIndex = index - 1;
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
							return fit && fit.inliers >= MIN_INLIERS ? fit.sim : null;
						});
						pairs.push(job);
						inFlight.add(job);
						job.finally(() => inFlight.delete(job)).catch(() => {});
						while (inFlight.size >= limit) await Promise.race(inFlight);
					}
					prev = cur;
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
				plan = planSmoothPath(sims, input.width, input.height, {
					sigma,
					lockVertical: step.lockVertical === true,
					lockRotation: step.lockRotation === true,
					maxZoom: maxZoomPercent / 100,
					borders: crop ? 'crop' : 'keep',
				});
				transforms = plan.backward.map((m) => backwardToVsTransform(m, input.width, input.height));
				const s = plan.stats;
				ctx.info('engine', 'smoothpath');
				ctx.info('request', {
					sigma,
					lockVertical: step.lockVertical === true,
					lockRotation: step.lockRotation === true,
					maxZoomPercent,
					borders: crop ? 'crop' : 'keep',
				});
				ctx.info('used', {
					sigma: plan.sigma,
					lockVertical: plan.lockVertical,
					lockRotation: plan.lockRotation,
				});
				ctx.info('zoomPercent', f2(plan.zoom * 100));
				ctx.info('fallback', plan.fallback);
				ctx.info('speed', {
					rawMaxPxPerFrame1080: f2(s.rawSpeedMax1080),
					smoothedMaxPxPerFrame1080: f2(s.smoothedSpeedMax1080),
					rawMaxAccel1080: f2(s.rawAccelMax1080),
					smoothedMaxAccel1080: f2(s.smoothedAccelMax1080),
				});
				ctx.info('camera', { travelPx: s.travelPx.map(f2), rotationDeg: f3(s.rotationDeg) });
				const tracked = inliers.filter((x) => x !== undefined);
				ctx.info('tracking', {
					width: det.width,
					height: det.height,
					pairs: sims.length,
					failedPairs: failed,
					minInliers: tracked.length ? Math.min(...tracked) : 0,
				});
				ctx.info('timing', {
					trackSeconds: f3((tTrack - t0) / 1000),
					planSeconds: f3((performance.now() - tTrack) / 1000),
				});
				const locks = [plan.lockVertical ? 'vertical locked' : '', plan.lockRotation ? 'rotation locked' : '']
					.filter(Boolean)
					.join(', ');
				if (plan.fallback) {
					const f = plan.fallback;
					ctx.note(
						`stabilize (smooth path): smoothing ${f1(f.requestedSigma)} frames needs ${
							Number.isFinite(f.neededZoom) ? `${f1(f.neededZoom * 100)} %` : 'more than 400 %'
						} zoom, above the ${f1(maxZoomPercent)} % cap — used the largest smoothing that fits: ${f1(
							plan.sigma,
						)} frames${f.locksReleased ? ' with vertical/rotation unlocked' : ''}. Raise Max zoom to keep the requested smoothing.`,
					);
				}
				ctx.note(
					`stabilize (smooth path): zoom ${f1(plan.zoom * 100)} %, camera speed max ${f1(
						s.rawSpeedMax1080,
					)} → ${f1(s.smoothedSpeedMax1080)} px/frame (1080p), smoothing ${f1(plan.sigma)} frames${
						locks ? `, ${locks}` : ''
					}`,
				);
				if (sims.length > 0 && failed > sims.length / 4) {
					ctx.note(
						`stabilize (smooth path): the background could not be tracked in ${failed} of ${sims.length} frame pairs (cuts, blur or flat image); those frames are treated as still`,
					);
				}
			} finally {
				await cv.close();
			}
		},

		async open(ctx: StepContext): Promise<{ width: number; height: number }> {
			ctxRef = ctx;
			size = { width: ctx.width, height: ctx.height };
			if (!plan || !module) throw new Error('stabilize: analyse() must run before open()');
			pool = await WarpPool.create(module, opts.warpThreads ?? Math.min(8, Math.max(1, ctx.threads)));
			return size;
		},

		async push(frame: RgbFrame): Promise<RgbFrame[]> {
			if (!pool) throw new Error('stabilize: not opened');
			if (frame.width !== size.width || frame.height !== size.height)
				throw new Error(`stabilize: frame ${frame.width}x${frame.height} != ${size.width}x${size.height}`);
			const t = transforms[frame.index];
			if (
				!t ||
				(Math.abs(t.x) < 1e-9 && Math.abs(t.y) < 1e-9 && Math.abs(t.alpha) < 1e-12 && Math.abs(t.zoom) < 1e-9)
			)
				return [frame];
			const t0 = performance.now();
			await pool.warp(frame.data, frame.width, frame.height, t, crop ? 1 : 0);
			warpMs += performance.now() - t0;
			warped++;
			return [frame];
		},

		async end(): Promise<RgbFrame[]> {
			if (ctxRef && warped > 0)
				ctxRef.info('warp', {
					threads: pool?.threads ?? 0,
					frames: warped,
					msPerFrame: Number((warpMs / warped).toFixed(2)),
				});
			return [];
		},

		async close(): Promise<void> {
			await pool?.close();
			pool = null;
		},
	};
}
