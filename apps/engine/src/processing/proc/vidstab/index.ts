// Entry point of the vid.stab WASM step (imported dynamically by the jasper-proc runner).
export {
	backwardAffine,
	cubicWeights,
	detectionSize,
	rowBands,
	scaleTransform,
	sourcePoint,
	sourceRows,
	warpRgb48Reference,
} from './math.ts';
export { WarpPool } from './pool.ts';
export { createVidstabStep, type VidstabStepOptions } from './step.ts';
export {
	LM_STRIDE,
	loadVidstabModule,
	resolveVidstabWasm,
	VidstabWasm,
	type VsTransform,
	vidstabWasmAvailable,
} from './wasm.ts';
