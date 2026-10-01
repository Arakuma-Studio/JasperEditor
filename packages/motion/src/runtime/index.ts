// @jasper/motion runtime (ARCHITECTURE §20.2, D-31, S11 §2–§3): anime.js 4 as a seek-driven value engine for
// Remotion-rendered layers. The only place in the repo that imports `animejs` (S11:ANM-001); compositions is
// the only package that imports `@jasper/motion` (§3.1). Owner: wp-m2-anime-core.
export { EASE_NAMES, EASES, type EaseName, isEaseName, resolveEase } from './eases.ts';
export { useAnimeDom, useAnimeValues } from './hooks.ts';
export { hash32, seededRandom } from './random.ts';
export { groupLines, needsShaping, segmentText, type TextSegment, type TextUnit } from './text.ts';
export {
	ANIMEJS_VERSION,
	createPausedTimeline,
	frameToMs,
	seekCanonical,
	type Timeline,
	type TimelineParams,
} from './timeline.ts';
