// Scene resolution (S03:ARC-001/011): the visible layer stack at one frame, with evaluated values and
// layer matrices. Static clips resolve to the same `props` object on every frame.

import { contentTimeAt } from '../derive/index.ts';
import type { WarpAnalysisData } from '../gaps/warp/analysis.ts';
import { evaluate, isAnimated } from '../keyframes.ts';
import { masksAnimated, type ResolvedMask, resolveMasks } from '../masks/model.ts';
import { type ResolvedPuppet, resolvePuppet } from '../puppet/model.ts';
import { evaluateEffectParam } from '../registry/effects.ts';
import type { ParamValue, Vec2 } from '../schema/common.ts';
import { PUPPET_PIN_PROPS } from '../schema/puppet.ts';
import { TITLE_LOOK_EFFECT_ID } from '../title-looks/model.ts';
import {
	appearanceAnimated,
	type ResolvedAppearance,
	resolveAppearance,
	resolveGlobalLight,
} from '../title-looks/resolve.ts';
import { activeCameraAt, type CameraState, project3dProps } from '../three-d/scene.ts';
import { cropWindow } from './crop.ts';
import {
	applyMat3,
	boxToQuad,
	isConvexQuad,
	type Mat3,
	mat3FromMat2D,
	multiplyMat3,
	type Quad,
} from './homography.ts';
import type { RenderSnapshot, RenderVisualClip } from './snapshot.ts';
import {
	type Crop,
	IDENTITY,
	type LayerTransformValues,
	layerMatrix,
	layerQuad,
	type Mat2D,
	quadBounds,
	type Rect,
	visibleRect,
} from './transform.ts';

export type ResolvedEffect = {
	id: string;
	effectId: string;
	effectVersion: number;
	enabled: boolean;
	params: Record<string, ParamValue>;
	/** wp masks: the effect applies inside these masks (absent = no masks: everywhere). */
	masks?: ResolvedMask[];
	/** sim-warp: the Puppet effect's meshes and pins at the frame. */
	puppet?: ResolvedPuppet;
	/** gaps (FX-6): the Warp Stabilizer's stored analysis (not time-dependent). */
	warpAnalysis?: WarpAnalysisData;
	/** spec 19: a look's appearance at the frame (`jasper.title-look`). */
	appearance?: ResolvedAppearance;
};

/** Effect id of the corner pin (M2, S09:TRK-050). Params: TL/TR/BR/BL as vec2 normalized to the layer box. */
export const CORNER_PIN_EFFECT_ID = 'jasper.corner-pin';
export const CORNER_PIN_PARAMS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;

/**
 * The corner-pin quad of a layer in layer pixels (TL, TR, BR, BL), or null when the layer has no enabled,
 * valid (convex) corner pin. The first enabled corner pin of the stack wins (S09:TRK-051).
 */
export function cornerPinQuad(
	effects: readonly ResolvedEffect[],
	box: { width: number; height: number },
): Quad | null {
	const fx = effects.find((e) => e.enabled && e.effectId === CORNER_PIN_EFFECT_ID);
	if (!fx) return null;
	const defaults: Vec2[] = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	];
	const q = CORNER_PIN_PARAMS.map((name, i) => {
		const v = fx.params[name];
		const n = Array.isArray(v) && v.length === 2 ? (v as Vec2) : defaults[i]!;
		return [n[0] * box.width, n[1] * box.height] as Vec2;
	}) as Quad;
	return isConvexQuad(q) ? q : null;
}

export type ResolvedLayerProps = {
	transform: LayerTransformValues | null;
	opacity: number;
	effects: ResolvedEffect[];
	/** wp masks: evaluated Opacity masks (empty = none). */
	masks: ResolvedMask[];
	matrix: Mat2D;
	/**
	 * M2: the full projective layer map (Motion · corner pin) when the layer has a corner pin, else null (the
	 * layer map is `matrix`). Renderers use `matrix3d` / the native warp stage when this is set.
	 */
	projective: Mat3 | null;
	box: { width: number; height: number };
	crop: Crop | null;
	quad: [Vec2, Vec2, Vec2, Vec2];
	bounds: Rect;
};

export type ResolvedLayer = {
	clip: RenderVisualClip;
	trackIndex: number;
	/** Frame index inside the clip (0-based). */
	localFrame: number;
	/** Content time (flicks) at this frame (S01:CLP-004). */
	contentTime: number;
	props: ResolvedLayerProps;
};

function isStaticClip(c: RenderVisualClip): boolean {
	const t = c.transform;
	// Keyframes or an active expression (a function of time) make a property animated.
	if (isAnimated(c.opacity)) return false;
	if (
		t &&
		(isAnimated(t.position) ||
			isAnimated(t.anchor) ||
			isAnimated(t.scale) ||
			isAnimated(t.scaleWidth) ||
			isAnimated(t.rotation))
	)
		return false;
	if (masksAnimated(c.masks) || c.effects.some((fx) => masksAnimated(fx.masks))) return false;
	if (c.effects.some((fx) => fx.puppet?.pins.some((pin) => PUPPET_PIN_PROPS.some((k) => isAnimated(pin[k])))))
		return false; // sim-warp: animated Puppet pins
	const light = c.sequenceLight;
	if (light && (isAnimated(light.angle) || isAnimated(light.altitude))) return false; // spec 19 TL-017
	if (c.effects.some((fx) => fx.appearance && appearanceAnimated(fx.appearance))) return false; // spec 19
	return c.effects.every((fx) => Object.values(fx.params).every((p) => !isAnimated(p)));
}

type TimedClip = Parameters<typeof contentTimeAt>[0] & {
	frameHold?: { flicks: number; holdFilters?: boolean } | null;
};

/**
 * Content time (flicks) at which a render clip's properties — Motion, Opacity, effect params — are evaluated at
 * sequence frame `frame` (S01:CLP-004). A frame hold with Hold Filters (edit-structure) evaluates them at the held
 * time; otherwise they keep animating through the hold (Premiere).
 */
export function clipContentTime(
	clip: TimedClip,
	frame: number,
	rate: Parameters<typeof contentTimeAt>[2],
): number {
	const hold = clip.frameHold;
	if (hold?.holdFilters) return hold.flicks;
	return contentTimeAt(clip, frame, rate);
}

/** Content time of the picture a clip shows at `frame`: the held time under a frame hold (edit-structure). */
export function clipPictureTime(
	clip: TimedClip,
	frame: number,
	rate: Parameters<typeof contentTimeAt>[2],
): number {
	const hold = clip.frameHold;
	if (hold) return hold.flicks;
	return contentTimeAt(clip, frame, rate);
}

export type LayerPropertySource = Pick<
	RenderVisualClip,
	'transform' | 'opacity' | 'intrinsicBox' | 'masks'
> &
	Partial<Pick<RenderVisualClip, 'sequenceLight' | 'start' | 'duration' | 'sourceIn' | 'speed'>> & {
		effects: Readonly<RenderVisualClip['effects']>;
	};

/** spec 19 TL-017: the sequence's light at a clip's content time `t` (its keys are in sequence time). */
function sequenceLightAt(c: LayerPropertySource, t: number): { angle: number; altitude: number } | null {
	const g = c.sequenceLight;
	if (!g) return null;
	const F = g.flicksPerFrame;
	const rate = c.speed?.rate ?? 1;
	const i = rate > 0 && F > 0 ? (t - (c.sourceIn ?? 0)) / (F * rate) : 0;
	const local = c.speed?.reverse ? (c.duration ?? 1) - 1 - i : i;
	return resolveGlobalLight(g, ((c.start ?? 0) + local) * F);
}

/** Evaluated props of a clip at content time `t` (no caching). */
export function resolveLayerProps(c: LayerPropertySource, t: number): ResolvedLayerProps {
	const tr = c.transform;
	const transform: LayerTransformValues | null = tr
		? {
				position: evaluate(tr.position, t),
				anchor: evaluate(tr.anchor, t),
				scale: evaluate(tr.scale, t),
				scaleWidth: evaluate(tr.scaleWidth, t),
				uniformScale: tr.uniformScale,
				rotation: evaluate(tr.rotation, t),
				flipH: tr.flipH,
				flipV: tr.flipV,
			}
		: null;
	const effects: ResolvedEffect[] = c.effects.map((fx) => ({
		id: fx.id,
		effectId: fx.effectId,
		effectVersion: fx.effectVersion,
		enabled: fx.enabled,
		// spatial-points: effect points walk their paths in the layer box's pixels.
		params: Object.fromEntries(
			Object.entries(fx.params).map(([k, a]) => [k, evaluateEffectParam(fx, k, a, t, c.intrinsicBox)]),
		),
		...(fx.masks?.length ? { masks: resolveMasks(fx.masks, t) } : {}),
		...(fx.puppet ? { puppet: resolvePuppet(fx.puppet, t) } : {}),
		...(fx.warpAnalysis ? { warpAnalysis: fx.warpAnalysis } : {}),
		...(fx.appearance && fx.effectId === TITLE_LOOK_EFFECT_ID
			? { appearance: resolveAppearance(fx.appearance, t, sequenceLightAt(c, t)) }
			: {}),
	}));
	// crop-order: the window the stack's crops leave visible (flips after a crop mirror it; several intersect).
	const crop: Crop | null = cropWindow(effects);
	const matrix = transform ? layerMatrix(transform) : IDENTITY;
	const rect = visibleRect(c.intrinsicBox, crop ?? undefined);
	const pin = cornerPinQuad(effects, c.intrinsicBox);
	const pinMap = pin ? boxToQuad(c.intrinsicBox.width, c.intrinsicBox.height, pin) : null;
	const projective = pinMap ? multiplyMat3(mat3FromMat2D(matrix), pinMap) : null;
	const quad: [Vec2, Vec2, Vec2, Vec2] = projective
		? [
				applyMat3(projective, [rect.x, rect.y]),
				applyMat3(projective, [rect.x + rect.width, rect.y]),
				applyMat3(projective, [rect.x + rect.width, rect.y + rect.height]),
				applyMat3(projective, [rect.x, rect.y + rect.height]),
			]
		: layerQuad(matrix, rect);
	return {
		transform,
		opacity: Math.min(100, Math.max(0, evaluate(c.opacity, t))),
		effects,
		masks: c.masks?.length ? resolveMasks(c.masks, t) : NO_MASKS,
		matrix,
		projective,
		box: c.intrinsicBox,
		crop,
		quad,
		bounds: quadBounds(quad),
	};
}

/**
 * The full layer map (layer px → sequence px) of resolved props: the projective map when the layer is corner
 * pinned, else its affine Motion (M2, S09: tracking apply, warp stage, overlays).
 */
export function layerMapOf(props: Pick<ResolvedLayerProps, 'projective' | 'matrix'>): Mat3 {
	return props.projective ?? mat3FromMat2D(props.matrix);
}

const NO_MASKS: ResolvedMask[] = [];

const staticCache = new WeakMap<RenderVisualClip, ResolvedLayerProps>();

/**
 * Evaluated props for an immutable render clip. Static clips reuse their props across frames and callers;
 * checking the cache first also avoids rescanning every effect parameter on each playback frame.
 * Edited clips must have a new object identity, as with the render snapshot's existing static-props cache.
 */
export function resolveCachedLayerProps(clip: RenderVisualClip, contentTime: number): ResolvedLayerProps {
	const cached = staticCache.get(clip);
	if (cached) return cached;
	const props = resolveLayerProps(clip, contentTime);
	if (isStaticClip(clip)) staticCache.set(clip, props);
	return props;
}

/** Binary search for the clip covering `frame` in a start-sorted, non-overlapping list. */
function clipCovering(clips: readonly RenderVisualClip[], frame: number): RenderVisualClip | undefined {
	let lo = 0;
	let hi = clips.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const c = clips[mid]!;
		if (frame < c.start) hi = mid - 1;
		else if (frame >= c.start + c.duration) lo = mid + 1;
		else return c;
	}
	return undefined;
}

/**
 * Visible layers at a sequence frame, bottom (V1) → top (S01:RND-005). three-d: a 3D layer's props carry its
 * projective map through the active camera (or `opts.camera`, a Program monitor 3D view), so overlays, picking and
 * masks follow it on screen.
 */
export function resolveSceneAt(
	snapshot: RenderSnapshot,
	frame: number,
	opts: { camera?: CameraState } = {},
): ResolvedLayer[] {
	const out: ResolvedLayer[] = [];
	let cam: CameraState | null = opts.camera ?? null;
	snapshot.videoTracks.forEach((track, trackIndex) => {
		const c = clipCovering(track.clips, frame);
		if (!c) return;
		const t = clipContentTime(c, frame, snapshot.settings.fps);
		let props = resolveCachedLayerProps(c, t);
		if (c.threeD && c.kind !== 'adjustment') {
			cam ??= activeCameraAt(snapshot, frame);
			props = project3dProps(c, props, t, cam, snapshot.settings);
		}
		out.push({ clip: c, trackIndex, localFrame: frame - c.start, contentTime: t, props });
	});
	return out;
}
