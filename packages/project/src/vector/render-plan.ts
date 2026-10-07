// Render plan of a vector shape (wp shapes): the evaluated draws turned into paint primitives both renderers of the
// shape layer consume — SVG (every draw blends with a CSS-exact mode) and the canvas compositor (any other blend
// mode, through the shared blend kernel). One plan, so the two draw the same geometry, paint and clipping; the
// preview and every export path render the same composition (shape clips are always drawn by it).
import { blendModeIndex, isCssBlend } from '../blend-modes.ts';
import type { FillRuleValue, ShapeBlendMode } from '../schema/shapes.ts';
import {
	type ShapeDraw,
	type ShapePaint,
	drawLocalPaths,
	strokeIsVariable,
	variableStrokeOutline,
} from './evaluate.ts';
import { type Affine, type BezPath, pathBounds, toSvgPath } from './geom.ts';

export type PlanStroke = {
	width: number;
	cap: 'butt' | 'round' | 'square';
	join: 'miter' | 'round' | 'bevel';
	miterLimit: number;
	dash: number[] | null;
	dashOffset: number;
};

export type PlanPrimitive = {
	itemId: string;
	kind: 'fill' | 'stroke';
	/** Path data in paint-group space (`xf` maps it to content space). */
	d: string;
	xf: Affine;
	paint: ShapePaint;
	/** 0…1. */
	opacity: number;
	blend: ShapeBlendMode;
	groups: ShapeDraw['groups'];
	/** Fill `d` with this rule, or stroke it with `stroke`. */
	fillRule: FillRuleValue;
	stroke: PlanStroke | null;
	/** Inside strokes: painted only within this area (non-zero). */
	clip: string | null;
	/** Outside strokes: this area (non-zero) is cut out of the paint. */
	cut: string | null;
	/** Paint-group-space bounds of what the primitive touches (null = nothing). */
	bounds: { x0: number; y0: number; x1: number; y1: number } | null;
};

/**
 * Turns draws (top first, as `evaluateVectorShape` returns them) into primitives in painting order (bottom first).
 * `resScale` = device pixels per content pixel (tapered / waved stroke outlines are sampled every half pixel).
 */
export function vectorRenderPlan(draws: readonly ShapeDraw[], resScale = 1): PlanPrimitive[] {
	const out: PlanPrimitive[] = [];
	for (let i = draws.length - 1; i >= 0; i--) {
		const dr = draws[i]!;
		const local = drawLocalPaths(dr);
		if (!local || !local.length) continue;
		const base = {
			itemId: dr.itemId,
			kind: dr.kind,
			xf: dr.xf,
			paint: dr.paint,
			opacity: dr.opacity,
			blend: dr.blend,
			groups: dr.groups,
		};
		if (dr.kind === 'fill') {
			const b = pathBounds(local);
			out.push({ ...base, d: toSvgPath(local), fillRule: dr.fillRule, stroke: null, clip: null, cut: null, bounds: b && grow(b, 1) });
			continue;
		}
		const s = dr.stroke!;
		const geometry = toSvgPath(local);
		const clip = s.position === 'inside' ? geometry : null;
		const cut = s.position === 'outside' ? geometry : null;
		const visible = s.position === 'center' ? s.width : s.width * 2;
		if (strokeIsVariable(s)) {
			const outline: BezPath = variableStrokeOutline(dr, resScale);
			if (!outline.length) continue;
			const b = pathBounds(outline);
			out.push({ ...base, d: toSvgPath(outline), fillRule: 'nonzero', stroke: null, clip, cut, bounds: b && grow(b, 1) });
			continue;
		}
		const b = pathBounds(local);
		const reach = (visible / 2) * (s.join === 'miter' ? Math.max(1, s.miterLimit) : 1) + (s.cap === 'square' ? visible : 0);
		out.push({
			...base,
			d: geometry,
			fillRule: 'nonzero',
			stroke: {
				width: visible,
				cap: s.cap,
				join: s.join,
				miterLimit: s.miterLimit,
				dash: s.dash ? s.dash.pattern : null,
				dashOffset: s.dash ? s.dash.offset : 0,
			},
			clip,
			cut,
			bounds: b && grow(b, reach + 1),
		});
	}
	return out;
}

const grow = (b: { x0: number; y0: number; x1: number; y1: number }, r: number) => ({
	x0: b.x0 - r,
	y0: b.y0 - r,
	x1: b.x1 + r,
	y1: b.y1 + r,
});

/** True when every primitive (and every blended group) uses a mode CSS draws exactly: the SVG renderer applies. */
export function planIsCssExact(plan: readonly PlanPrimitive[]): boolean {
	return plan.every((p) => isCssBlend(p.blend) && p.groups.every((g) => isCssBlend(g.blend)));
}

/** Blend kernel mode number of a shape blend mode. */
export const planBlendIndex = (mode: ShapeBlendMode): number => blendModeIndex(mode);
