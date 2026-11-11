// The canonical form of a scene layer (docs/wp-notes/scene-file.md § Canonical form): what `resolveScene` makes of a
// file layer and `readSceneLayer` makes of a clip, in document units (frames, RGBA 0…1, cubic ease handles). Both
// sides of the diff use it; an aspect absent from a resolved file layer is not managed by the scene.
import type { RGBA, Vec2 } from '../schema/common.ts';
import type { BlendMode } from '../schema/sequence.ts';
import type { SceneProp } from './format.ts';

/** The segment leaving a key. */
export type SceneEaseR =
	| { kind: 'linear' }
	| { kind: 'hold' }
	| { kind: 'cubic'; x1: number; y1: number; x2: number; y2: number };

export type SceneValueR = number | boolean | string | number[] | Record<string, unknown> | null;

/** A key at a frame counted from the layer's start. `path` only for points (motion path to the next key). */
export type SceneKeyR = { frame: number; value: SceneValueR; ease: SceneEaseR; path?: 'linear' | 'auto' };

export type SceneAnimR = { kind: 'static'; value: SceneValueR } | { kind: 'keys'; keys: SceneKeyR[] };

export type SceneEffectR = {
	effectId: string;
	enabled: boolean;
	/** Every param of the effect (defaults filled). */
	params: Record<string, SceneAnimR>;
};

export type SceneMaskVertexR = { p: Vec2; in: Vec2; out: Vec2 };
export type SceneMaskR = {
	/** Informational (the tool that made it): kept out of comparisons. */
	shape: 'ellipse' | 'polygon' | 'bezier';
	mode: string;
	inverted: boolean;
	feather: number;
	opacity: number;
	expansion: number;
	falloff: 'smooth' | 'linear';
	closed: boolean;
	vertices: SceneMaskVertexR[];
};

export type SceneStrokeR = { color: RGBA; width: number; position: 'inside' | 'center' | 'outside' };
export type SceneAnimatorR = {
	preset: string;
	version: number;
	durationFrames: number;
	params: Record<string, unknown>;
};

export type SceneTextR = {
	text: string;
	font?: string;
	sizePx?: number;
	weight?: number;
	italic?: boolean;
	fill?: RGBA;
	align?: 'left' | 'center' | 'right' | 'justify';
	lineHeight?: number;
	trackingEm?: number;
	allCaps?: boolean;
	stroke?: SceneStrokeR | null;
	shadow?: { color: RGBA; angleDeg: number; distancePx: number; blurPx: number; spreadPx: number } | null;
	background?: { color: RGBA; paddingPx: number; radiusPx: number } | null;
	/** `point` = auto width (`autoSize: width`), `paragraph` = fixed width, `box` = fixed width and height. */
	box?:
		| { mode: 'point' }
		| { mode: 'paragraph'; width: number }
		| { mode: 'box'; width: number; height: number };
	animIn?: SceneAnimatorR | null;
	animOut?: SceneAnimatorR | null;
};

export type SceneLayerKind = 'text' | 'image' | 'shape' | 'composition';

export type ResolvedSceneLayer = {
	id: string;
	name: string;
	kind: SceneLayerKind;
	/** Clip id the file pins the layer to. */
	clipPin?: string;
	start: number;
	duration: number;
	/** 1-based video track. */
	track: number;
	/** Managed animatable properties. */
	props: Partial<Record<SceneProp, SceneAnimR>>;
	blend?: BlendMode;
	effects?: SceneEffectR[];
	masks?: SceneMaskR[];
	text?: SceneTextR;
	/** image / svg: the media shown. */
	mediaId?: string;
	shape?: { type: 'rect' | 'ellipse'; stroke?: SceneStrokeR | null };
	composition?: { mediaId: string; id: string; props?: Record<string, unknown> };
	/** Where the layer is in the file (for error paths). */
	index: number;
};

export type ResolvedSequence = {
	name: string;
	width?: number;
	height?: number;
	frameRate?: { num: number; den: number };
	background?: RGBA;
};

export type ResolvedScene = { sequence: ResolvedSequence; layers: ResolvedSceneLayer[] };

// --- comparison --------------------------------------------------------------------------------------------------

const NUM_TOL = 1e-3;
const EASE_TOL = 2e-3;

/** Deep equality with an absolute tolerance on numbers (exports round to four decimals, colours to 8 bits). */
export function nearlyEqual(a: unknown, b: unknown, tol = NUM_TOL): boolean {
	if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= tol;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((x, i) => nearlyEqual(x, b[i], tol));
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
		const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
		if (ka.length !== kb.length) return false;
		return ka.every((k) =>
			nearlyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol),
		);
	}
	return a === b || (a == null && b == null);
}

/** Colours (8-bit hex in files): within half a step of 1/255. */
export const colorEqual = (a: RGBA | null | undefined, b: RGBA | null | undefined) =>
	a == null || b == null ? a == null && b == null : nearlyEqual(a, b, 0.0025);

export function easeEqual(a: SceneEaseR, b: SceneEaseR): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind !== 'cubic' || b.kind !== 'cubic') return true;
	return (
		Math.abs(a.x1 - b.x1) <= EASE_TOL &&
		Math.abs(a.y1 - b.y1) <= EASE_TOL &&
		Math.abs(a.x2 - b.x2) <= EASE_TOL &&
		Math.abs(a.y2 - b.y2) <= EASE_TOL
	);
}

export function animEqual(a: SceneAnimR, b: SceneAnimR): boolean {
	if (a.kind === 'static' && b.kind === 'static') return nearlyEqual(a.value, b.value);
	if (a.kind !== 'keys' || b.kind !== 'keys' || a.keys.length !== b.keys.length) return false;
	return a.keys.every((k, i) => {
		const o = b.keys[i]!;
		const last = i === a.keys.length - 1;
		return (
			k.frame === o.frame &&
			nearlyEqual(k.value, o.value) &&
			// the last key's ease shapes nothing
			(last || easeEqual(k.ease, o.ease)) &&
			(last || (k.path ?? 'linear') === (o.path ?? 'linear'))
		);
	});
}

export function effectEqual(a: SceneEffectR, b: SceneEffectR): boolean {
	if (a.effectId !== b.effectId || a.enabled !== b.enabled) return false;
	const names = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
	for (const n of names) {
		const x = a.params[n];
		const y = b.params[n];
		if (!x || !y || !animEqual(x, y)) return false;
	}
	return true;
}

export function maskEqual(a: SceneMaskR, b: SceneMaskR): boolean {
	return (
		a.mode === b.mode &&
		a.inverted === b.inverted &&
		a.falloff === b.falloff &&
		a.closed === b.closed &&
		nearlyEqual(a.feather, b.feather) &&
		nearlyEqual(a.opacity, b.opacity) &&
		nearlyEqual(a.expansion, b.expansion) &&
		nearlyEqual(a.vertices, b.vertices, 1e-4)
	);
}

export const animatorEqual = (a: SceneAnimatorR | null, b: SceneAnimatorR | null) =>
	a === null || b === null
		? a === b
		: a.preset === b.preset &&
			a.version === b.version &&
			a.durationFrames === b.durationFrames &&
			nearlyEqual(a.params, b.params);

export const strokeEqual = (a: SceneStrokeR | null, b: SceneStrokeR | null) =>
	a === null || b === null
		? a === b
		: colorEqual(a.color, b.color) && nearlyEqual(a.width, b.width) && a.position === b.position;
