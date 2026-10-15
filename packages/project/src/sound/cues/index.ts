// Cue derivation (spec 12 §2.2): `deriveCues` and its building blocks. Pure (project layer).
export {
	applyBudgets,
	DENSITY_BUDGETS,
	HERO_MIN_SEC,
	MERGE_FRAMES,
	mergeCandidates,
	WEIGHT_FACTOR,
} from './budget.ts';
export { deriveCues, MAX_DERIVED_CUES } from './derive.ts';
export { DIALOGUE_BRIDGE_SEC, DIALOGUE_PAD_SEC, dialogueRanges } from './edits.ts';
export { parseSfxRequest } from './markers.ts';
export { mgPhases } from './mg.ts';
export {
	ABRUPT_STOP,
	K_ROT,
	K_SCALE,
	MAX_SAMPLES_PER_CLIP,
	MOVE_OFF,
	MOVE_ON,
	speedSegments,
} from './motion.ts';
export { PATTERN_MAX_PER_CLIP, PATTERN_MAX_PER_SEC, thinPattern, typewriterOffsets } from './text.ts';
export { type TransitionClass, transitionClass, transitionTravel, transitionWindow } from './transitions.ts';
export * from './types.ts';
