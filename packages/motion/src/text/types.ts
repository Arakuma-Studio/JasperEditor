// Contract types of the text animator implementations (ARCHITECTURE §20.2, S11 §4.2).
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
	/**
	 * `reveal` drives a rise from behind a per-line mask (mask-reveal) instead of
	 * plain visibility (typewriter).
	 */
	lineMasks?: boolean;
	/** Draws a caret after the last shown unit when this returns true. */
	caret?(params: Record<string, unknown>): boolean;
	/**
	 * Whether the caret is lit at a frame of the window (blink). A pure function of the
	 * frame (S11:ANM-003), never the wall clock; absent = lit whenever `caret` is true.
	 */
	caretVisible?(ctx: TextCaretContext): boolean;
};

/** One frame of a window as the caret sees it (`caretVisible`). */
export type TextCaretContext = {
	/** The preset's params with defaults merged. */
	params: Record<string, unknown>;
	side: TextAnimationSide;
	/** Seek time of the In-ordered timeline (Out windows seek it mirrored). */
	ms: number;
	durationMs: number;
	fps: number;
	/** Units the timeline was built with. */
	units: number;
	/** Units fully shown at this frame (`reveal >= 1`). */
	shown: number;
};
