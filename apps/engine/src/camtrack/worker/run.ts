// One 3D Camera Tracker job inside the `jasper-camtrack` process: decode the span (ffmpeg, the roto worker's frame
// reader), track features (features.ts, OpenCV.js), solve the camera (core/solver.ts). The feature tracks are cached
// in `tracksCache` so a re-solve (deleted track points, other solve settings) skips the tracking.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CancelledError, decodeFrames } from '../../roto/worker/frames.ts';
import { solveCamera } from '../core/solver.ts';
import { type CameraSolve, type CameraTracks, type ShotType, type SolveMethod, SolveError } from '../core/types.ts';
import { createFeatureTracker, featureConfig, greyOf } from '../features.ts';

export { CancelledError };

export type CamTrackJobSpec = {
	ffmpeg: string;
	file: string;
	rate: { num: number; den: number };
	/** Display size of the media. */
	display: { width: number; height: number };
	/** Inclusive media frames. */
	span: [number, number];
	settings: { shot: ShotType; hfov: number; method: SolveMethod; detailed: boolean; lensDistortion: boolean };
	deleted: number[];
	/** Where the feature tracks are cached (read when present). */
	tracksCache?: string;
};

export type CamTrackJobOutput = { solve: CameraSolve; tracks: number };

let cvModule: any = null;
/** OpenCV.js, wrapped: the Emscripten module is a thenable, so returning it from an async function never settles. */
async function loadCv(): Promise<{ cv: any }> {
	if (cvModule) return { cv: cvModule };
	const cv = createRequire(import.meta.url)('@techstark/opencv-js');
	await new Promise<void>((resolve) => {
		if (typeof cv.then === 'function') cv.then(() => resolve());
		else if (cv.Mat) resolve();
		else cv.onRuntimeInitialized = () => resolve();
	});
	cvModule = cv;
	return { cv };
}

function readCache(path: string | undefined, spec: CamTrackJobSpec): CameraTracks | null {
	if (!path || !existsSync(path)) return null;
	try {
		const t = JSON.parse(readFileSync(path, 'utf8')) as CameraTracks;
		const frames = spec.span[1] - spec.span[0] + 1;
		if (t.frames !== frames || t.detailed !== spec.settings.detailed || !Array.isArray(t.tracks)) return null;
		return t;
	} catch {
		return null;
	}
}

/** Tracks the span's features (fraction 0..1 of the tracking stage reported). */
export async function trackFeatures(
	spec: CamTrackJobSpec,
	o: { signal?: AbortSignal; onProgress?: (fraction: number, stage: string) => void },
): Promise<CameraTracks> {
	const { cv } = await loadCv();
	const cfg = featureConfig(spec.display, spec.settings.detailed);
	const tracker = createFeatureTracker(cv, cfg);
	const total = spec.span[1] - spec.span[0] + 1;
	const grey = new Uint8Array(cfg.width * cfg.height);
	let k = 0;
	try {
		for await (const rgb of decodeFrames(
			{
				ffmpeg: spec.ffmpeg,
				file: spec.file,
				rate: spec.rate,
				width: cfg.width,
				height: cfg.height,
				display: spec.display,
				still: false,
			},
			spec.span[0],
			total,
			o.signal,
		)) {
			if (o.signal?.aborted) throw new CancelledError();
			const live = tracker.push(greyOf(rgb, grey));
			k++;
			o.onProgress?.(k / total, `Analyzing frame ${k}/${total} (${live} features)`);
		}
		if (k < 2) throw new SolveError('The span has fewer than two frames that could be decoded');
		return tracker.result(spec.display, spec.settings.detailed);
	} finally {
		tracker.dispose();
	}
}

export async function runCamTrackJob(
	spec: CamTrackJobSpec,
	o: { signal?: AbortSignal; onProgress?: (fraction: number, stage: string) => void } = {},
): Promise<CamTrackJobOutput> {
	const progress = o.onProgress ?? (() => {});
	let tracks = readCache(spec.tracksCache, spec);
	if (!tracks) {
		tracks = await trackFeatures(spec, { ...o, onProgress: (f, s) => progress(f * 0.5, s) });
		if (spec.tracksCache) {
			const tmp = `${spec.tracksCache}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(tracks));
			renameSync(tmp, spec.tracksCache);
		}
	}
	if (o.signal?.aborted) throw new CancelledError();
	try {
		const solve = solveCamera(
			tracks,
			{
				shot: spec.settings.shot,
				hfov: spec.settings.hfov,
				method: spec.settings.method,
				deleted: spec.deleted,
				lensDistortion: spec.settings.lensDistortion,
			},
			{ ...(o.signal ? { signal: o.signal } : {}), onProgress: (f, s) => progress(0.5 + f * 0.5, s) },
		);
		return { solve, tracks: tracks.tracks.length };
	} catch (e) {
		if (o.signal?.aborted || (e instanceof SolveError && e.message === 'cancelled')) throw new CancelledError();
		throw e;
	}
}
