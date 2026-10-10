// GPU shader-effect runtime of @jasper/compositions (wave-1 fx framework; specs and planning live in
// @jasper/project registry/fx, authoring guide docs/wp-notes/fx-shader-framework.md).
export {
	type FxLutParams,
	type FxShaderParams,
	type FxTapParams,
	fxCrop,
	fxFlip,
	fxLut,
	fxShader,
	fxTap,
} from './effects.ts';
export {
	canUseHtmlInCanvas,
	FxDomPicture,
	type FxFeed,
	FxFeedContext,
	FxPicture,
	fxDescriptors,
	loadFxImage,
	useFxFeed,
} from './FxPicture.tsx';
export { type FxHost, type FxRunInputs, FxShaderError, fxHost, runLutPass, runShaderPlan } from './host.ts';
export {
	type FxBypass,
	type FxCanvasLayout,
	type FxStep,
	fxCanvasLayout,
	type LayerFxPlan,
	planLayerFx,
} from './plan.ts';
export { fxEffectRegistry, setFxEffectRegistry } from './registry.ts';
export { FxImageFeed, FxMediaInputs, FxSolidFeed, FxVideoFeed, FxVideoSources } from './sources.tsx';
export { type FxMediaInput, type FxPreparedStep, type FxStage, type LayerFx, useLayerFx } from './stage.ts';
export { type FxGpuState, fxStatus, useFxStatus } from './status.ts';
export { fxRemapFrame, hasTimeDependentFx } from './time.ts';
export {
	TransitionHub,
	type TransitionMode,
	type TransitionSideEntry,
	TransitionSidesContext,
	TransitionStage,
	transitionFallbackFactor,
	transitionParamsAt,
	transitionProgressAt,
	transitionRunMode,
} from './transition.tsx';
