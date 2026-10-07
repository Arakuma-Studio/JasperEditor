// Mask model helpers (wp masks): defaults, creation, evaluation at a time and the mode algebra.
//
// Coordinates: mask paths are normalised to the layer's intrinsic box (0..1); feather / expansion / feather-point
// radii are layer pixels. Evaluation uses the shared keyframe evaluator (`evaluate`), whose path values
// interpolate through `path/interp.ts` (vertex-wise, or smart vertex matching for different vertex counts).
import { evaluate, isAnimated } from '../keyframes.ts';
import { type BezierPath, ellipsePath, rectPath } from '../path/model.ts';
import type { Animatable } from '../schema/common.ts';
import type { Mask, MaskFeatherFalloff, MaskMode, MaskShape, MaskTrackMethod } from '../schema/mask.ts';

/** Premiere's Mask Feather default (px). */
export const MASK_DEFAULT_FEATHER = 10;
export const MASK_FEATHER_RANGE = { min: 0, max: 1000 } as const;
export const MASK_OPACITY_RANGE = { min: 0, max: 100 } as const;
export const MASK_EXPANSION_RANGE = { min: -10000, max: 10000 } as const;
/** Mask path coordinates may leave the layer box, within reason (normalised units). */
export const MASK_PATH_RANGE = { min: -100, max: 101 } as const;
export const MASK_DEFAULT_TRACK_METHOD: MaskTrackMethod = 'position-scale-rotation';

export const MASK_MODE_LABELS: Record<MaskMode, string> = {
	none: 'None',
	add: 'Add',
	subtract: 'Subtract',
	intersect: 'Intersect',
	lighten: 'Lighten',
	darken: 'Darken',
	difference: 'Difference',
};

export const MASK_TRACK_METHOD_LABELS: Record<MaskTrackMethod, string> = {
	position: 'Position',
	'position-rotation': 'Position & Rotation',
	'position-scale-rotation': 'Position, Scale & Rotation',
	perspective: 'Perspective',
};

/** The animatable properties of a mask (ParamPath `["mask", maskId, <prop>]`). */
export const MASK_PROPS = ['path', 'feather', 'opacity', 'expansion'] as const;
export type MaskProp = (typeof MASK_PROPS)[number];

export const MASK_PROP_LABELS: Record<MaskProp, string> = {
	path: 'Mask Path',
	feather: 'Mask Feather',
	opacity: 'Mask Opacity',
	expansion: 'Mask Expansion',
};

/** Combine accumulated coverage `a` with a mask's coverage `m` (After Effects' mask modes). */
export function combineMaskMode(mode: MaskMode, a: number, m: number): number {
	switch (mode) {
		case 'add':
			return a + m - a * m;
		case 'subtract':
			return a * (1 - m);
		case 'intersect':
			return a * m;
		case 'lighten':
			return Math.max(a, m);
		case 'darken':
			return Math.min(a, m);
		case 'difference':
			return a + m - 2 * a * m;
		default:
			return a;
	}
}

/**
 * Starting coverage when `mode` is the first active mask: additive modes start from nothing, subtractive ones from
 * the whole layer (a first Subtract mask cuts a hole; a lone Intersect / Darken mask shows its inside, as in AE).
 */
export function maskModeStart(mode: MaskMode): number {
	return mode === 'subtract' || mode === 'intersect' || mode === 'darken' ? 1 : 0;
}

/** Shader index of a mode. */
export const MASK_MODE_INDEX: Record<MaskMode, number> = {
	none: 0,
	add: 1,
	subtract: 2,
	intersect: 3,
	lighten: 4,
	darken: 5,
	difference: 6,
};

const anim = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });

/** Default path of a new mask, centred on the layer (normalised units, `aspect` = box width / height). */
export function defaultMaskPath(shape: MaskShape, aspect = 16 / 9): BezierPath {
	// A circle / square whose side is 40 % of the shorter box side (Premiere draws a centred mask on the clip).
	const s = 0.2;
	const rx = aspect >= 1 ? s / aspect : s;
	const ry = aspect >= 1 ? s : s * aspect;
	if (shape === 'ellipse') return ellipsePath([0.5, 0.5], [rx, ry]);
	return rectPath(0.5 - rx, 0.5 - ry, 0.5 + rx, 0.5 + ry);
}

/** A new mask with Premiere's defaults (feather 10 px, opacity 100 %, expansion 0, Add). */
export function newMask(init: {
	id: string;
	name: string;
	shape: MaskShape;
	path: BezierPath;
	mode?: MaskMode;
	inverted?: boolean;
	feather?: number;
	opacity?: number;
	expansion?: number;
	featherFalloff?: MaskFeatherFalloff;
	trackMethod?: MaskTrackMethod;
}): Mask {
	return {
		id: init.id,
		name: init.name,
		shape: init.shape,
		mode: init.mode ?? 'add',
		inverted: init.inverted ?? false,
		path: anim(init.path) as Mask['path'],
		feather: anim(init.feather ?? MASK_DEFAULT_FEATHER),
		opacity: anim(init.opacity ?? 100),
		expansion: anim(init.expansion ?? 0),
		...(init.featherFalloff && init.featherFalloff !== 'smooth'
			? { featherFalloff: init.featherFalloff }
			: {}),
		...(init.trackMethod ? { trackMethod: init.trackMethod } : {}),
	};
}

/** "Mask (n)" with the next free number among `existing` names (Premiere's naming). */
export function nextMaskName(existing: readonly { name: string }[]): string {
	let n = 0;
	for (const m of existing) {
		const hit = /^Mask \((\d+)\)$/.exec(m.name);
		if (hit) n = Math.max(n, Number(hit[1]));
	}
	return `Mask (${n + 1})`;
}

/** A mask's values at content time `t` (flicks). */
export type ResolvedMask = {
	id: string;
	mode: MaskMode;
	inverted: boolean;
	/** Normalised layer-box coordinates. */
	path: BezierPath;
	/** Layer px, ≥ 0. */
	feather: number;
	/** 0..100. */
	opacity: number;
	/** Layer px. */
	expansion: number;
	falloff: MaskFeatherFalloff;
};

const clamp = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));

export function resolveMask(m: Mask, t: number): ResolvedMask {
	return {
		id: m.id,
		mode: m.mode,
		inverted: m.inverted,
		path: evaluate(m.path as Animatable<BezierPath>, t),
		feather: clamp(evaluate(m.feather, t), MASK_FEATHER_RANGE),
		opacity: clamp(evaluate(m.opacity, t), MASK_OPACITY_RANGE),
		expansion: clamp(evaluate(m.expansion, t), MASK_EXPANSION_RANGE),
		falloff: m.featherFalloff ?? 'smooth',
	};
}

/**
 * The masks that change the picture: mode ≠ none and a closed path with ≥ 2 vertices (an open path — a pen mask
 * not closed yet — has no inside and is ignored, as in After Effects).
 */
export function activeMasks(masks: readonly ResolvedMask[]): ResolvedMask[] {
	return masks.filter((m) => m.mode !== 'none' && m.path.closed && m.path.vertices.length >= 2);
}

export function resolveMasks(masks: readonly Mask[] | undefined, t: number): ResolvedMask[] {
	return (masks ?? []).map((m) => resolveMask(m, t));
}

/** True when any mask property is keyframed. */
export function masksAnimated(masks: readonly Mask[] | undefined): boolean {
	return (masks ?? []).some(
		(m) =>
			// Keyframes, or an active expression on feather / opacity / expansion (wave expressions).
			m.path.keyframes.length > 0 ||
			isAnimated(m.feather) ||
			isAnimated(m.opacity) ||
			isAnimated(m.expansion),
	);
}

/** True when the list has a mask that changes the picture at some time (mode ≠ none, closed path). */
export function hasActiveMasks(masks: readonly Mask[] | undefined): boolean {
	return (masks ?? []).some(
		(m) =>
			m.mode !== 'none' &&
			[m.path.value, ...m.path.keyframes.map((k) => k.value)].some((p) => p.closed && p.vertices.length >= 2),
	);
}

/** The clip has an enabled effect with an active mask (Premiere's per-effect masks). */
export function hasEffectMasks(c: { effects: readonly { enabled: boolean; masks?: Mask[] }[] }): boolean {
	return c.effects.some((fx) => fx.enabled && hasActiveMasks(fx.masks));
}

/** The clip's masks change its picture (an active Opacity mask or an enabled effect with an active mask). */
export function clipHasMasks(c: {
	masks?: Mask[];
	effects: readonly { enabled: boolean; masks?: Mask[] }[];
}): boolean {
	return hasActiveMasks(c.masks) || hasEffectMasks(c);
}

/** Effect id of the corner pin (also in render/scene.ts; repeated to keep this module free of render imports). */
const CORNER_PIN = 'jasper.corner-pin';
/** Kinds whose Opacity masks the native export kernel rasterises (stream/plan.ts). */
const MASK_STREAM_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'solid',
	'composition',
	'motion-graphic',
]);

/**
 * How the native export realises a clip's masks (wp masks; the planner never drops them):
 * - `none`: no active mask;
 * - `stream`: Opacity masks only, on a kind the sub-pixel kernel draws — the coverage (same definition as the
 *   preview's GL rasteriser) multiplies the decoded picture before the warp;
 * - `bake`: effect masks (an effect limited to its masks mixes pixels inside the stack), a corner-pinned layer,
 *   an animated image or a DOM layer — the whole layer is rendered by the composition (layer bake, `hybrid`), which
 *   runs the GL rasteriser itself.
 */
export function maskExportRoute(c: {
	kind: string;
	masks?: Mask[];
	effects: readonly { enabled: boolean; effectId: string; masks?: Mask[] }[];
}): 'none' | 'stream' | 'bake' {
	if (!clipHasMasks(c)) return 'none';
	if (hasEffectMasks(c)) return 'bake';
	if (c.effects.some((fx) => fx.enabled && fx.effectId === CORNER_PIN)) return 'bake';
	return MASK_STREAM_KINDS.has(c.kind) ? 'stream' : 'bake';
}
