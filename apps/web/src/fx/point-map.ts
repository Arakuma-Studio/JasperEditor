// Layer-box-normalised points (fx framework `ui.control: 'point'`, spatial-points motion paths) ↔ sequence pixels,
// through a layer's full map (Motion and, when pinned, the corner pin's projective map).
import type { Vec2 } from '@jasper/project';
import { applyMat3, invertMat3, layerMapOf, type ResolvedLayer } from '@jasper/project';

/** A normalised point of a layer → sequence pixels (through the full layer map). */
export function pointToSequence(layer: Pick<ResolvedLayer, 'props'>, n: Vec2): Vec2 {
	const { box } = layer.props;
	return applyMat3(layerMapOf(layer.props), [n[0] * box.width, n[1] * box.height]) as Vec2;
}

/** Sequence pixels → the normalised point of a layer (null when the layer map is singular). */
export function sequenceToPoint(layer: Pick<ResolvedLayer, 'props'>, s: Vec2): Vec2 | null {
	const inv = invertMat3(layerMapOf(layer.props));
	if (!inv) return null;
	const { box } = layer.props;
	const p = applyMat3(inv, s);
	const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
	return [r(p[0] / box.width), r(p[1] / box.height)];
}
