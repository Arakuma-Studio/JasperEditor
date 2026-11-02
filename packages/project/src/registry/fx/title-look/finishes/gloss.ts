// `gloss` (§5.1): a cap of light across the upper part of the layer, Pachislop's Gloss2D. The same GLSL as the `gloss` layer.
import { GLSL_TL_SURFACE } from '../glsl.ts';
import { defineFinish, lp } from '../contract.ts';

/**
 * Coverage of the cap at `s`, 0..1. height: 0..1 of the shape's bounds from the top along the tilted axis, curve: how far the
 * lower edge bows down at the middle, soft: 0..1 of the same span, angle: the band's tilt, radians. Fades towards its edge.
 */
export const GLOSS_CAP_GLSL = /* glsl */ `
float tl_glossCap(TlSurface s, float height, float curve, float soft, float angle) {
  vec4 b = tl_bounds();
  vec2 c = (b.xy + b.zw) * 0.5;
  vec2 h = max((b.zw - b.xy) * 0.5, vec2(0.5));
  vec2 down = vec2(-sin(angle), cos(angle));
  vec2 across = vec2(down.y, -down.x);
  float ed = abs(down.x) * h.x + abs(down.y) * h.y;
  float ea = abs(across.x) * h.x + abs(across.y) * h.y;
  float y = (dot(s.px - c, down) + ed) / (2.0 * ed);
  float u = dot(s.px - c, across) / ea;
  float edge = height + curve * 0.25 * (1.0 - u * u);
  float w = max(soft, 0.002) * 0.5;
  float cap = 1.0 - smoothstep(edge - w, edge + w, y);
  return cap * mix(1.0, 0.55, clamp(y / max(edge, 1.0e-3), 0.0, 1.0));
}
`;

export const FINISH_GLOSS = defineFinish({
	id: 'gloss',
	label: 'Gloss',
	description: 'A cap of light across the upper part of the shape.',
	params: [
		lp.percent('glossHeight', 'Height', 48),
		lp.percent('glossCurve', 'Curve', 45),
		lp.percent('glossSoftness', 'Softness', 6),
		lp.percent('glossIntensity', 'Intensity', 70),
		lp.angle('glossAngle', 'Angle', 0),
		lp.color('glossColor', 'Colour', [1, 1, 1, 1]),
	],
	include: [GLSL_TL_SURFACE],
	glsl: /* glsl */ `${GLOSS_CAP_GLSL}
vec4 tl_finish(vec4 paint, TlSurface s) {
  float cap = tl_glossCap(s, u_glossHeight * 0.01, u_glossCurve * 0.01, u_glossSoftness * 0.01, radians(u_glossAngle));
  vec3 c = paint.a > 0.0 ? paint.rgb / paint.a : vec3(0.0);
  return vec4(mix(c, tl_linear(u_glossColor.rgb), clamp(cap * u_glossIntensity * 0.01, 0.0, 1.0)) * paint.a, paint.a);
}`,
	summary: () => 'gloss',
});
