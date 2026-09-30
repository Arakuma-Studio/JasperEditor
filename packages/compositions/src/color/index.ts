// Colour stage of @jasper/compositions (M2, S06 §4.1): baked-LUT WebGL2 passes on the layer's source picture.

export { ColorCanvas, type ColorCanvasHandle, type ColorCanvasProps } from './ColorCanvas.tsx';
export {
	type ChainStep,
	COLOR_COMMUTING_EFFECTS,
	ColorDocContext,
	type ColorDocValue,
	type ColorPlan,
	type ColorStage,
	planColorStage,
	referencedMedia,
	useColorStage,
} from './chain.ts';
export { type ColorLutParams, type CssFilterParams, colorLut, cssFilter } from './effects.ts';
export {
	type ColorGl,
	canUseWebGl2,
	createColorGl,
	destroyColorGl,
	drawThroughLut,
	FRAGMENT_SHADER,
	lutTexture,
	sourceSize,
	VERTEX_SHADER,
} from './gl.ts';
export {
	BAKES_PER_LAYER,
	bakedRunLut,
	clearLutAssets,
	dropLayerBakes,
	loadedLutAsset,
	loadLutAsset,
	lutUrlKey,
} from './luts.ts';
export { type ColorStageState, colorStageStatus, useColorStageStatus } from './status.ts';
