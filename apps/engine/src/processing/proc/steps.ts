// Maps recipe steps to their implementations (S07 §4). Heavy runtimes (WASM vid.stab, OpenCV.js, ONNX Runtime)
// load lazily, only for recipes that use them.
import type { ProcessStep } from '@jasper/project';
import { createDeblockStep, createDenoiseStep, createDeshakeStep } from './filters.ts';
import { filterAdapter, ProcError, type StepEnv } from './runner.ts';
import type { StepImpl } from './types.ts';
import { createUpscaleStep } from './upscale.ts';
import { createNativeVidstabStep } from './vidstab-native.ts';

type StabilizeEngine = 'wasm' | 'ffmpeg' | 'deshake';

/**
 * Which implementation a stabilise step uses: `deshake` when asked; otherwise vid.stab — FFmpeg's filters only
 * when the engine vouched for its build (`vidstabEngine: 'ffmpeg'`, PST-003), else the portable WASM build;
 * `auto` falls back to deshake when the WASM module cannot load.
 */
async function stabilizeEngine(
	step: Extract<ProcessStep, { op: 'stabilize' }>,
	env: StepEnv,
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

async function wasmAvailable(): Promise<boolean> {
	try {
		const m = await import('./vidstab/wasm.ts');
		return await m.vidstabWasmAvailable();
	} catch {
		return false;
	}
}

export async function createStepImpl(step: ProcessStep, env: StepEnv): Promise<StepImpl> {
	switch (step.op) {
		case 'deblock':
			return { kind: 'filter', step: createDeblockStep(step) };
		case 'denoise':
			return { kind: 'filter', step: createDenoiseStep(step) };
		case 'stabilize': {
			if (step.method === 'smoothpath') {
				// PST-005: OpenCV.js tracking; the warp uses the vid.stab WASM kernel when it loads, else OpenCV.js.
				// Never silently replaced by another method (a different kind of stabilisation).
				let m: typeof import('./smoothpath/step.ts');
				try {
					m = await import('./smoothpath/step.ts');
				} catch (e) {
					throw new ProcError(
						'SMOOTHPATH_UNAVAILABLE',
						`smooth path needs OpenCV.js: ${(e as Error).message}`,
					);
				}
				return { kind: 'frames', step: m.createSmoothPathStep(step) };
			}
			const engine = await stabilizeEngine(step, env);
			if (engine === 'deshake') return { kind: 'filter', step: createDeshakeStep(step) };
			if (engine === 'ffmpeg') {
				return {
					kind: 'frames',
					step: createNativeVidstabStep(step, (f) => filterAdapter(f, env.ffmpeg, { allowVidstab: true })),
				};
			}
			const m = await import('./vidstab/step.ts');
			return { kind: 'frames', step: m.createVidstabStep(step) };
		}
		case 'dejudder': {
			const m = await import('./dejudder/step.ts');
			return { kind: 'frames', step: m.createDejudderStep(step) };
		}
		case 'upscale':
			return { kind: 'frames', step: createUpscaleStep(step) };
	}
}
