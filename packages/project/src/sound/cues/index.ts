// Cue derivation (spec 12 §2.2): `deriveCues` and its building blocks. Pure (project layer).
export {
	applyBudgets,
	DENSITY_BUDGETS,
	HERO_MIN_SEC,
	MERGE_FRAMES,
	mergeCandidates,
	WEIGHT_FACTOR,
} from './budget.ts';
export {
	PIXEL_CUT_RATIO,
	PIXEL_CUT_RESIDUAL,
	PIXEL_GLOBAL_AREA,
	PIXEL_MAX_CONFIDENCE,
	PIXEL_MAX_FRAMES,
	PIXEL_MIN_AREA,
	type PixelAnchorAt,
	type PixelCutEvent,
	type PixelLandEvent,
	type PixelMotionCurve,
	type PixelMotionEvent,
	type PixelMoveEvent,
	pixelCutIndices,
	pixelMotionCues,
	pixelMotionEvents,
} from './curve.ts';
export { deriveCues, MAX_DERIVED_CUES } from './derive.ts';
export { DIALOGUE_BRIDGE_SEC, DIALOGUE_PAD_SEC, dialogueRanges, sequenceDialogueRanges } from './edits.ts';
export {
	BEAT_SNAP_FRAMES,
	BEAT_SNAP_KINDS,
	type BeatData,
	beatCues,
	beatFramesOf,
	clipFrameOfMediaSec,
	type EngineSourceClip,
	footageClips,
	MAX_BEATS_PER_CLIP,
	MAX_SCENE_SCAN_FRAMES,
	musicClips,
	type SceneCutData,
	sceneAnchorAt,
	sceneCutCues,
	snapCuesToBeats,
} from './engine-sources.ts';
export { parseSfxRequest } from './markers.ts';
export { MG_CONFIDENCE, type MgCuePhases, mgCuePhases, mgPhases } from './mg.ts';
export {
	ABRUPT_STOP,
	K_ROT,
	K_SCALE,
	MAX_SAMPLES_PER_CLIP,
	MOVE_OFF,
	MOVE_ON,
	speedSegments,
} from './motion.ts';
export {
	measureFrameMotion,
	PIXEL_BLOCK,
	PIXEL_COARSE_SEARCH,
	PIXEL_MATCH_GAIN,
	PIXEL_MATCH_MAX_COST,
	PIXEL_MIN_BLOCKS,
	PIXEL_MIN_VECTOR,
	PIXEL_REFINE,
	PIXEL_STILL_COST,
	PIXEL_TEXTURE_MIN,
	type PixelFrameMotion,
	pixelAnalysisSize,
} from './pixel-motion.ts';
export { PATTERN_MAX_PER_CLIP, PATTERN_MAX_PER_SEC, thinPattern, typewriterOffsets } from './text.ts';
export { type TransitionClass, transitionClass, transitionTravel, transitionWindow } from './transitions.ts';
export * from './types.ts';
export { MAX_SAMPLES_PER_DERIVATION } from './util.ts';
