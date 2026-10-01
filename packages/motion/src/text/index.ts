// @jasper/motion/text — text animator implementations (S11 §4.2, ARCHITECTURE §20.2), keyed `id@version` like
// `TEXT_ANIMATION_SPECS` in @jasper/project (a test asserts both lists match). Owner: wp-m2-text-anim.
import type { TextAnimationSide } from '@jasper/project';
import type { TextUnit, Timeline } from '../runtime/index.ts';

/**
 * Animated values of one unit (char / word / line), all numbers: `opacity` 0…1, `x`/`y` px in the text box
 * space, `scale` factor, `rotate` degrees, `blur` px, `letterSpacing` em (added to the style's tracking),
 * `reveal` 0…1 (mask/typewriter progress; 1 = fully shown).
 */
export type UnitValues = {
	opacity: number;
	x: number;
	y: number;
	scale: number;
	rotate: number;
	blur: number;
	letterSpacing: number;
	reveal: number;
};

/** Values of a unit at rest (outside every window, S11:ANM-009). */
export const REST_UNIT_VALUES: Readonly<UnitValues> = Object.freeze({
	opacity: 1,
	x: 0,
	y: 0,
	scale: 1,
	rotate: 0,
	blur: 0,
	letterSpacing: 0,
	reveal: 1,
});

export type TextAnimationBuildContext = {
	/** Number of units (segments with `space: false`). */
	units: number;
	/** Line index per unit (line units and line-aware presets; from `groupLines`). */
	lineOf?: number[];
	side: TextAnimationSide;
	/** Window length (compressed frames → ms). */
	durationMs: number;
	/** The preset's params with defaults merged (snapshot `animation.<side>.params`). */
	params: Record<string, unknown>;
	/** `hash32(clipId, 'text-anim', side)`. */
	seed: number;
	/** Text box in layer pixels. */
	box: { width: number; height: number };
};

export type TextAnimationImpl = {
	/** `id@version`. */
	key: string;
	unitDefault: TextUnit;
	/** Pure: fresh targets (one per unit) and a paused timeline over them, `durationMs` long. */
	build(ctx: TextAnimationBuildContext): { timeline: Timeline; targets: UnitValues[] };
};

/** The shipped implementations. Empty until wp-m2-text-anim lands. */
export const TEXT_ANIMATION_IMPLS: Readonly<Record<string, TextAnimationImpl>> = {};
