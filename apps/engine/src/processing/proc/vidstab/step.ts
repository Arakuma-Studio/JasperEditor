// The vid.stab frame step of jasper-proc (S07 PST-001/002, D-25), cross-platform through vidstab.wasm:
//   analyse: decode the input as 8-bit luma (downscaled to ≤ detectMaxWidth), vid.stab motion detection
//            (vidstabdetect shakiness=<s>:accuracy=15:stepsize=4:mincontrast=0.2), then the camera path
//            (vidstabtransform smoothing=<n>:optalgo=gauss:maxshift:maxangle:optzoom=<1 crop | 0 keep>),
//            translations scaled back to the full frame;
//   push:    apply each frame's transform to the 16-bit RGB frame in float (bicubic, vid.stab geometry) in
//            worker threads — 1 frame in, 1 frame out.
import type { ProcessStep } from '@jasper/project';
import { decodeFrames } from '../ffio.ts';
import type { DecodeSpec, FrameStep, RgbFrame, StepContext } from '../types.ts';
import { correctionStats, detectionSize, scaleTransform } from './math.ts';
import { WarpPool } from './pool.ts';
import { loadVidstabModule, resolveVidstabWasm, VidstabWasm, type VsTransform } from './wasm.ts';

type StabilizeStep = Extract<ProcessStep, { op: 'stabilize' }>;

export type VidstabStepParams = Pick<StabilizeStep, 'smoothing' | 'borders' | 'shakiness' | 'rotation'> & {
	method?: StabilizeStep['method'];
};

export type VidstabStepOptions = {
	/** Motion detection runs on luma at most this wide (default 960; vid.stab's fields scale with the frame). */
	detectMaxWidth?: number;
	/** vidstabdetect accuracy / stepsize / mincontrast (defaults 15 / 4 / 0.2, the trailer's settings). */
	accuracy?: number;
	stepSize?: number;
	minContrast?: number;
	/** Camera-path algorithm (default 'gauss', as measured; 'opt' is vid.stab 1.4's L1 optimal path). */
	algo?: 'gauss' | 'opt' | 'avg';
	/**
	 * Largest correcting shift in pixels of the step's input; default 20 px per 848 px of width (the
	 * trailer's "medium" preset: maxshift=20 at 848x480). null = unlimited.
	 */
	maxShift?: number | null;
	/** Largest correcting rotation in rad (default 0.03; forced to 0 when `rotation` is false). */
	maxAngle?: number;
	/** Warp worker threads (default ctx.threads, at most 8; 1 = on the calling thread). */
	threads?: number;
	/** Explicit vidstab.wasm (default resolveVidstabWasm()). */
	wasmPath?: string;
};

const IDENTITY: VsTransform = { x: 0, y: 0, alpha: 0, zoom: 0 };

export function createVidstabStep(step: VidstabStepParams, opts: VidstabStepOptions = {}): FrameStep {
	const shakiness = Math.min(10, Math.max(1, Math.round(step.shakiness ?? 5)));
	const smoothing = Math.max(0, Math.round(step.smoothing));
	const crop = step.borders === 'crop';
	const rotation = step.rotation !== false;
	let transforms: VsTransform[] | null = null;
	let module: WebAssembly.Module | null = null;
	let pool: WarpPool | null = null;
	let size = { width: 0, height: 0 };
	let warpMs = 0;
	let warped = 0;
	let ctxRef: StepContext | null = null;

	return {
		name: 'stabilize',

		async analyse(input: DecodeSpec, ctx: StepContext): Promise<void> {
			const t0 = performance.now();
			const wasmPath = opts.wasmPath ?? resolveVidstabWasm();
			module = await loadVidstabModule(wasmPath);
			const vs = await VidstabWasm.create(module);
			const det = detectionSize(input.width, input.height, opts.detectMaxWidth ?? 960);
			const sx = input.width / det.width;
			const sy = input.height / det.height;
			vs.detectInit(det.width, det.height, {
				shakiness,
				accuracy: opts.accuracy ?? 15,
				stepSize: opts.stepSize ?? 4,
				minContrast: opts.minContrast ?? 0.2,
			});
			const motions: Float64Array[] = [];
			let empty = 0;
			for await (const buf of decodeFrames(input, {
				pixFmt: 'gray',
				width: det.width,
				height: det.height,
				signal: ctx.signal,
			})) {
				const m = vs.detectFrame(buf);
				if (motions.length > 0 && m.length === 0) empty++;
				motions.push(m);
				if (motions.length % 8 === 0) ctx.analysisProgress(Math.min(1, motions.length / input.frames));
			}
			vs.detectFree();
			const tDetect = performance.now();
			// Frames the decoder did not deliver get no correction (the runner verifies the count anyway).
			while (motions.length < input.frames) motions.push(new Float64Array(0));

			const maxShiftFull =
				opts.maxShift === undefined ? Math.round((20 * input.width) / 848) : (opts.maxShift ?? -1);
			const maxAngle = rotation ? (opts.maxAngle ?? 0.03) : 0;
			vs.pathInit(det.width, det.height);
			for (const m of motions) vs.pathAdd(m);
			const path = vs.pathCompute({
				smoothing,
				algo: opts.algo ?? 'gauss',
				optZoom: crop ? 1 : 0,
				zoom: 0,
				zoomSpeed: 0.25,
				maxShift: maxShiftFull < 0 ? -1 : Math.max(1, maxShiftFull / Math.max(sx, sy)),
				maxAngle,
			});
			const log = vs.takeLog();
			vs.pathFree();
			transforms = path.transforms.map((t) => scaleTransform(t, sx, sy));
			const tPath = performance.now();

			const stats = correctionStats(transforms);
			ctx.info('engine', 'vidstab-wasm');
			ctx.info('vidstab', {
				version: vs.version(),
				simd: vs.simd(),
				wasm: wasmPath,
				detect: { width: det.width, height: det.height, shakiness, accuracy: opts.accuracy ?? 15 },
				transform: {
					smoothing,
					algo: opts.algo ?? 'gauss',
					optzoom: crop ? 1 : 0,
					maxShift: maxShiftFull,
					maxAngle,
					borders: crop ? 'crop (optimal static zoom, edges replicated)' : 'keep (no zoom, black borders)',
				},
			});
			ctx.info('zoomPercent', Number(path.zoom.toFixed(3)));
			ctx.info('correction', {
				meanShiftPx: Number(stats.meanShift.toFixed(3)),
				maxShiftPx: Number(stats.maxShift.toFixed(3)),
				maxAngleRad: Number(stats.maxAngle.toFixed(5)),
			});
			ctx.info('timing', {
				detectSeconds: Number(((tDetect - t0) / 1000).toFixed(3)),
				pathSeconds: Number(((tPath - tDetect) / 1000).toFixed(3)),
			});
			ctx.info('framesWithoutMotion', empty);
			if (crop && path.zoom > 10) {
				ctx.note(`stabilize: vid.stab needed a ${path.zoom.toFixed(1)} % zoom to hide the borders`);
			}
			if (motions.length > 1 && empty > motions.length / 4) {
				ctx.note(`stabilize: no usable motion found in ${empty} of ${motions.length} frames (low contrast)`);
			}
			for (const line of log.filter((l) => l.startsWith('error') || l.startsWith('warn')).slice(0, 3)) {
				ctx.note(`stabilize: vid.stab ${line}`);
			}
		},

		async open(ctx: StepContext): Promise<{ width: number; height: number }> {
			ctxRef = ctx;
			size = { width: ctx.width, height: ctx.height };
			if (!transforms || !module) throw new Error('stabilize: analyse() must run before open()');
			const threads = opts.threads ?? Math.min(8, Math.max(1, ctx.threads));
			pool = await WarpPool.create(module, threads);
			return size;
		},

		async push(frame: RgbFrame): Promise<RgbFrame[]> {
			if (!transforms || !pool) throw new Error('stabilize: not opened');
			if (frame.width !== size.width || frame.height !== size.height) {
				throw new Error(`stabilize: frame ${frame.width}x${frame.height} != ${size.width}x${size.height}`);
			}
			const t = transforms[frame.index] ?? IDENTITY;
			if (t.x === 0 && t.y === 0 && t.alpha === 0 && t.zoom === 0) return [frame];
			const t0 = performance.now();
			await pool.warp(frame.data, frame.width, frame.height, t, crop ? 1 : 0);
			warpMs += performance.now() - t0;
			warped++;
			return [frame];
		},

		async end(): Promise<RgbFrame[]> {
			if (ctxRef && warped > 0) {
				ctxRef.info('warp', {
					threads: pool?.threads ?? 0,
					frames: warped,
					msPerFrame: Number((warpMs / warped).toFixed(2)),
				});
			}
			return [];
		},

		async close(): Promise<void> {
			await pool?.close();
			pool = null;
		},
	};
}
