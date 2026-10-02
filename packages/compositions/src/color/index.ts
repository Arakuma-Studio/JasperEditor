// Colour stage of @jasper/compositions (M2, S06 §4.1): baked-LUT WebGL2 passes on the layer's source picture.

export { ColorCanvas, type ColorCanvasHandle, type ColorCanvasProps } from './ColorCanvas.tsx';
export {
	ColorDocContext,
	type ColorDocValue,
	type ColorStage,
	useColorStage,
} from './chain.ts';
export { applyLutRgba8 } from './cpu.ts';
export { type ColorLutParams, type CssFilterParams, colorLut, colorLutCpu, cssFilter } from './effects.ts';
export {
	type ColorGl,
	type ColorStageBackend,
	canUseWebGl2,
	colorStageBackend,
	createColorGl,
	destroyColorGl,
	drawThroughLut,
	lutTexture,
	sourceSize,
	webGl2Renderer,
} from './gl.ts';
export { loadLutAsset } from './luts.ts';
