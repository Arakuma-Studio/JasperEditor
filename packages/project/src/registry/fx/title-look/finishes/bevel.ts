// `bevel` (§5.1): Photoshop's Bevel & Emboss as Pachislop's material does it: the layer's shape through a profile into a
// height field, lit by the look's light as a highlight screen and a shadow multiply. Size, softness and Fit are the relief's;
// a rim or inline fits as a tube across its width.
import {
	curveLut,
	curveParam,
	GLSL_TL_RELIEF,
	reliefPasses,
	reliefReach,
	TL_PROFILE_LABELS,
	TL_PROFILES,
} from '../../glsl/title-relief.ts';
import { defineFinish, type LayerParams, lp } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const profileOf = (p: LayerParams) =>
	Math.max(0, TL_PROFILES.indexOf(p.bevelProfile as (typeof TL_PROFILES)[number]));

/** Bevel depth at 100 %: the surface's slope at a round profile's edge is about 1.5 (57°). */
export const BEVEL_GLSL = /* glsl */ `
vec4 tl_finish(vec4 paint, TlSurface s) {
  vec3 c = tl_straight(paint);
  vec3 n = tl_reliefNormal(s, tl_px(max(u_bevelSize, 0.05)) * u_bevelDepth * 0.01);
  vec2 lit = tl_lit(n);
  c = tl_screen(c, tl_linear(u_bevelHighlightColor.rgb) * lit.x * u_bevelHighlight * 0.01);
  c *= mix(vec3(1.0), tl_linear(u_bevelShadowColor.rgb), clamp(lit.y * u_bevelShadow * 0.01, 0.0, 1.0));
  return vec4(c * paint.a, paint.a);
}`;

export const FINISH_BEVEL = defineFinish({
	id: 'bevel',
	label: 'Bevel',
	description: 'Raised edges lit by the look’s light: round, chamfer, ridge, cove or a custom curve.',
	params: [
		lp.choice('bevelProfile', 'Profile', TL_PROFILES, TL_PROFILE_LABELS, 'round'),
		lp.distance('bevelSize', 'Size', 8, { softMax: 40 }),
		lp.number('bevelDepth', 'Depth', 100, { min: 0, max: 1000, softMax: 400, step: 1 }, { unit: '%' }),
		lp.distance('bevelSoftness', 'Softness', 2, { softMax: 20 }),
		lp.toggle('bevelFit', 'Fit to Stroke Width', false),
		curveParam('bevelCurve', 'Curve'),
		lp.percent('bevelHighlight', 'Highlight', 85),
		lp.percent('bevelShadow', 'Shadow', 60),
		lp.color('bevelHighlightColor', 'Highlight Colour', [1, 1, 1, 1]),
		lp.color('bevelShadowColor', 'Shadow Colour', [0, 0, 0, 1]),
	],
	glsl: BEVEL_GLSL,
	include: [GLSL_TL_RELIEF],
	fieldReach: (p) => reliefReach(num(p.bevelSize), p.bevelFit === true),
	prepass: (p, ctx) =>
		reliefPasses(ctx, {
			size: num(p.bevelSize),
			softness: num(p.bevelSoftness),
			profile: profileOf(p),
			fit: p.bevelFit === true,
			curve: curveLut(p.bevelCurve),
		}),
	summary: (p) => `${String(p.bevelProfile)} bevel`,
});
