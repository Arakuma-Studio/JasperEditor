// Scene resolution (S03:ARC-001/011): the visible layer stack at one frame, with evaluated values and
// layer matrices. Static clips resolve to the same `props` object on every frame.

import { contentTimeAt } from '../derive/index.ts';
import { evaluate } from '../keyframes.ts';
import type { ParamValue, Vec2 } from '../schema/common.ts';
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
	if (c.opacity.keyframes.length) return false;
	if (
		t &&
		(t.position.keyframes.length ||
			t.anchor.keyframes.length ||
			t.scale.keyframes.length ||
			t.scaleWidth.keyframes.length ||
			t.rotation.keyframes.length)
	)
		return false;
	return c.effects.every((fx) => Object.values(fx.params).every((p) => p.keyframes.length === 0));
}

export { contentTimeAt as clipContentTime };

/** Evaluated props of a clip at content time `t` (no caching). */
export function resolveLayerProps(c: RenderVisualClip, t: number): ResolvedLayerProps {
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
		params: Object.fromEntries(Object.entries(fx.params).map(([k, a]) => [k, evaluate(a, t)])),
	}));
	const cropFx = effects.find((e) => e.effectId === 'jasper.crop' && e.enabled);
	const crop: Crop | null = cropFx
		? {
				left: Number(cropFx.params.left ?? 0),
				top: Number(cropFx.params.top ?? 0),
				right: Number(cropFx.params.right ?? 0),
				bottom: Number(cropFx.params.bottom ?? 0),
			}
		: null;
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

const staticCache = new WeakMap<RenderVisualClip, ResolvedLayerProps>();

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

/** Visible layers at a sequence frame, bottom (V1) → top (S01:RND-005). */
export function resolveSceneAt(snapshot: RenderSnapshot, frame: number): ResolvedLayer[] {
	const out: ResolvedLayer[] = [];
	snapshot.videoTracks.forEach((track, trackIndex) => {
		const c = clipCovering(track.clips, frame);
		if (!c) return;
		const t = contentTimeAt(c, frame, snapshot.settings.fps);
		let props: ResolvedLayerProps;
		if (isStaticClip(c)) {
			props = staticCache.get(c) ?? resolveLayerProps(c, t);
			staticCache.set(c, props);
		} else props = resolveLayerProps(c, t);
		out.push({ clip: c, trackIndex, localFrame: frame - c.start, contentTime: t, props });
	});
	return out;
}
