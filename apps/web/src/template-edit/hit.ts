// Which template text a Program-monitor double-click lands on (WP7b canvas-edit). Pure: the scene, the point and a
// measurement callback (measure.ts reads the rendered DOM; tests pass fixed boxes).
//
// The scene is walked from the top layer down, as the viewer sees it:
// - an anime-template layer is hit on its editable texts (`data-template-param` boxes, a few screen px of slack) and
//   blocks the layers below on its painted boxes (card body, pictures); elsewhere it is transparent;
// - any other layer under the point blocks the layers below (its drawn content covers them);
// - 3D template layers are not edited in place (their DOM is not where the camera draws them).
// The topmost hit wins, except that a hit on a selected clip wins over hits on unselected clips (select a card in the
// Timeline to reach it under another one). Locked tracks are not skipped: when the topmost hit is on a locked track it
// is returned whatever is selected (the first click of a double-click selects the unlocked layer under a locked one),
// and the caller refuses it with feedback.
import type { ResolvedLayer, Vec2 } from '@jasper/project';
import { applyMat3, applyMatrix, invertMat3, invertMatrix } from '@jasper/project';
import { pointInQuad } from '../panels/program/transform-math.ts';
import { hitsLayerGeometry, layerEditQuad, layerHitSlop } from '../shapes/geometry.ts';
import type { LayerMeasurement, LayerRect, ParamBox } from './measure.ts';

/** Slack around a text box, screen px. */
export const TEXT_HIT_SCREEN_PX = 4;

export type TemplateParamHit = {
	layer: ResolvedLayer;
	box: ParamBox;
	/** The point in layer px. */
	local: Vec2;
	/** Where in the box (0…1 of its width and height) the point lies. */
	at: Vec2;
};

/** Layer px of a sequence point (null when the layer map is degenerate). */
function sequenceToLayer(l: ResolvedLayer, p: Vec2): Vec2 | null {
	if (l.props.projective) {
		const inv = invertMat3(l.props.projective);
		if (!inv) return null;
		const q = applyMat3(inv, p) as Vec2;
		return Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
	}
	const inv = invertMatrix(l.props.matrix);
	return inv ? (applyMatrix(inv, p) as Vec2) : null;
}

/** Sequence px of a layer point. */
export function layerToSequence(l: ResolvedLayer, p: Vec2): Vec2 {
	return (l.props.projective ? applyMat3(l.props.projective, p) : applyMatrix(l.props.matrix, p)) as Vec2;
}

const inside = (r: LayerRect, p: Vec2, slop: number) =>
	p[0] >= r.x - slop && p[0] <= r.x + r.width + slop && p[1] >= r.y - slop && p[1] <= r.y + r.height + slop;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/**
 * The editable template text under sequence point `p`, or null. `isTemplate` says which layers draw anime templates;
 * `measure` returns a layer's measured boxes (null: not measurable, treated as transparent).
 */
export function pickTemplateParam(
	scene: readonly ResolvedLayer[],
	p: Vec2,
	opts: {
		viewScale: number;
		selected: ReadonlySet<string>;
		/** Locked track ids. */
		locked?: ReadonlySet<string>;
		isTemplate(l: ResolvedLayer): boolean;
		measure(l: ResolvedLayer): LayerMeasurement | null;
	},
): TemplateParamHit | null {
	const hits: TemplateParamHit[] = [];
	for (let i = scene.length - 1; i >= 0; i--) {
		const l = scene[i]!;
		if (!l.props.transform || !(l.props.opacity > 0)) continue;
		const slop = layerHitSlop(l, opts.viewScale, TEXT_HIT_SCREEN_PX);
		if (!opts.isTemplate(l) || l.clip.threeD) {
			if (pointInQuad(p, layerEditQuad(l, slop)) && hitsLayerGeometry(l, p, slop)) break;
			continue;
		}
		const local = sequenceToLayer(l, p);
		if (!local) continue;
		const m = opts.measure(l);
		if (!m) continue;
		// Nested editable boxes: the innermost (smallest) under the point.
		let best: ParamBox | null = null;
		for (const b of m.params)
			if (
				inside(b.rect, local, slop) &&
				(!best || b.rect.width * b.rect.height < best.rect.width * best.rect.height)
			)
				best = b;
		if (best) {
			hits.push({
				layer: l,
				box: best,
				local,
				at: [
					clamp01((local[0] - best.rect.x) / best.rect.width),
					clamp01((local[1] - best.rect.y) / best.rect.height),
				],
			});
			continue;
		}
		if (m.opaque.some((r) => inside(r, local, 0))) break;
	}
	const top = hits[0];
	if (!top) return null;
	const locked = (h: TemplateParamHit) => !!opts.locked?.has(h.layer.clip.trackId);
	if (locked(top)) return top;
	return hits.find((h) => opts.selected.has(h.layer.clip.clipId) && !locked(h)) ?? top;
}
