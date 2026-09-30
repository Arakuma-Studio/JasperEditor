// Scene resolution (S03:ARC-001/011): the visible layer stack at one frame, with evaluated values and
// layer matrices. Static clips resolve to the same `props` object on every frame.
import { evaluate } from '../keyframes.ts';
import type { ParamValue, Vec2 } from '../schema/common.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
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

export type ResolvedLayerProps = {
	transform: LayerTransformValues | null;
	opacity: number;
	effects: ResolvedEffect[];
	matrix: Mat2D;
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

/** Content time at a sequence frame for a snapshot clip (S01:CLP-004). */
export function clipContentTime(
	c: Pick<RenderVisualClip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	frame: number,
	fps: Rational,
): number {
	const F = flicksPerFrame(fps);
	const i = frame - c.start;
	return c.speed.reverse
		? c.sourceIn + (c.duration - 1 - i) * F * c.speed.rate
		: c.sourceIn + i * F * c.speed.rate;
}

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
	const quad = layerQuad(matrix, visibleRect(c.intrinsicBox, crop ?? undefined));
	return {
		transform,
		opacity: Math.min(100, Math.max(0, evaluate(c.opacity, t))),
		effects,
		matrix,
		box: c.intrinsicBox,
		crop,
		quad,
		bounds: quadBounds(quad),
	};
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
		const t = clipContentTime(c, frame, snapshot.settings.fps);
		let props: ResolvedLayerProps;
		if (isStaticClip(c)) {
			props = staticCache.get(c) ?? resolveLayerProps(c, t);
			staticCache.set(c, props);
		} else props = resolveLayerProps(c, t);
		out.push({ clip: c, trackIndex, localFrame: frame - c.start, contentTime: t, props });
	});
	return out;
}
