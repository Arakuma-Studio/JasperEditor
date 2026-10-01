// Maps recipe steps to their implementations (S07 §4). Heavy runtimes (WASM vid.stab, OpenCV.js, ONNX Runtime)
// load lazily, only for recipes that use them.
import type { ProcessStep } from '@jasper/project';
import { createDeblockStep, createDenoiseStep, createDeshakeStep } from './filters.ts';
import { filterAdapter, ProcError, type StepEnv } from './runner.ts';
import type { FrameStep, StepImpl } from './types.ts';
import { createUpscaleStep } from './upscale.ts';
import { createNativeVidstabStep } from './vidstab-native.ts';

export type StabilizeEngine = 'wasm' | 'ffmpeg' | 'deshake';

/**
 * Which implementation a stabilise step uses: `deshake` when asked; otherwise vid.stab — FFmpeg's filters only
 * when the engine vouched for its build (`vidstabEngine: 'ffmpeg'`, PST-003), else the portable WASM build;
 * `auto` falls back to deshake when the WASM module cannot load.
 */
export async function stabilizeEngine(
	step: Extract<ProcessStep, { op: 'stabilize' }>,
	env: StepEnv,
	wasmAvailable: () => Promise<boolean>,
): Promise<StabilizeEngine> {
	if (step.method === 'deshake') return 'deshake';
	const pref = env.spec.vidstabEngine ?? 'auto';
	if (pref === 'ffmpeg') {
		if (env.filters.has('vidstabdetect') && env.filters.has('vidstabtransform')) return 'ffmpeg';
		throw new ProcError('VIDSTAB_UNAVAILABLE', 'the FFmpeg in use has no vid.stab filters');
	}
	if (await wasmAvailable()) return 'wasm';
	if (step.method === 'auto') return 'deshake';
	throw new ProcError('VIDSTAB_UNAVAILABLE', 'the vid.stab WASM module could not be loaded');
}

async function wasmModule() {
	return import('./vidstab/index.ts');
}

async function wasmAvailable(): Promise<boolean> {
	try {
		const m = await wasmModule();
		return await m.vidstabWasmAvailable();
	} catch {
		return false;
	}
}

export async function createStepImpl(step: ProcessStep, _index: number, env: StepEnv): Promise<StepImpl> {
	switch (step.op) {
		case 'deblock':
			return { kind: 'filter', step: createDeblockStep(step) };
		case 'denoise':
			return { kind: 'filter', step: createDenoiseStep(step) };
		case 'stabilize': {
			const engine = await stabilizeEngine(step, env, wasmAvailable);
			if (engine === 'deshake') return { kind: 'filter', step: createDeshakeStep(step) };
			if (engine === 'ffmpeg') {
				const fps = { num: 0, den: 1 };
				return {
					kind: 'frames',
					step: createNativeVidstabStep(step, (f) =>
						filterAdapterLazy(f, env.ffmpeg, fps, { allowVidstab: true }),
					),
				};
			}
			const m = await wasmModule();
			return { kind: 'frames', step: m.createVidstabStep(step) as FrameStep };
		}
		case 'dejudder': {
			const m = await import('./dejudder/step.ts');
			return { kind: 'frames', step: m.createDejudderStep(step) as FrameStep };
		}
		case 'upscale':
			return { kind: 'frames', step: createUpscaleStep(step) };
	}
}

/** filterAdapter that takes the frame rate from the step context at open time. */
function filterAdapterLazy(
	f: { name: string; format: 'yuv444p'; filter: () => string },
	ffmpeg: string,
	_fps: { num: number; den: number },
	opts: { allowVidstab?: boolean },
): FrameStep {
	let inner: FrameStep | null = null;
	return {
		name: f.name,
		async open(ctx) {
			inner = filterAdapter(f, ffmpeg, ctx.fps, opts);
			return inner.open(ctx);
		},
		push: (frame) => (inner as FrameStep).push(frame),
		end: () => (inner as FrameStep).end(),
		close: async () => inner?.close?.(),
	};
}
