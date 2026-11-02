// `satin` (§5.1): Photoshop's Satin as Pachislop's: the |difference| of two copies of the blurred silhouette shifted either
// way along an angle, blended in its colour. It follows the inside of the shape as soft bands. Blends run in the signal, as
// Photoshop's do; a look's colours stay linear either side.
import { GLSL_TL_RELIEF, reliefPasses } from '../../glsl/title-relief.ts';
import { defineFinish, lp } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SILHOUETTE = (edge: string) => /* glsl */ `
${edge}
float tl_reliefRaw(TlSurface s) { return tl_inside(-tl_depth(s), 0.0); }`;

/** Satin of `c` at `s`, for finishes and Title Material. */
export const SATIN_GLSL = /* glsl */ `
vec3 tl_satin(vec3 c, TlSurface s, vec2 offset) {
  vec2 o = offset / u_canvasSize;
  float v = abs(tl_height(s.uv + o) - tl_height(s.uv - o));
  if (u_satinInvert) v = 1.0 - v;
  v = clamp(v * u_satinIntensity * 0.01, 0.0, 1.0);
  vec3 b = fx_linearToSrgb(clamp(c, 0.0, 1.0));
  vec3 k = u_satinColor.rgb;
  vec3 r = k;
  if (u_satinBlend == 1) r = b * k;
  else if (u_satinBlend == 2) r = tl_screen(b, k);
  else if (u_satinBlend == 3) r = mix(2.0 * b * k, 1.0 - 2.0 * (1.0 - b) * (1.0 - k), step(0.5, b));
  return tl_linear(mix(b, r, v));
}
`;

export const FINISH_SATIN = defineFinish({
	id: 'satin',
	label: 'Satin',
	description: 'Soft bands of light that follow the shape.',
	params: [
		lp.distance('satinSize', 'Size', 14, { softMax: 50 }),
		lp.distance('satinOffset', 'Offset', 10, { softMax: 40 }),
		lp.angle('satinAngle', 'Angle', 45),
		lp.percent('satinIntensity', 'Intensity', 60),
		lp.color('satinColor', 'Colour', [0, 0, 0, 1]),
		lp.choice('satinBlend', 'Blend', ['normal', 'multiply', 'screen', 'overlay'], ['Normal', 'Multiply', 'Screen', 'Overlay'], 'multiply'),
		lp.toggle('satinInvert', 'Invert', true),
	],
	include: [GLSL_TL_RELIEF],
	glsl: /* glsl */ `${SATIN_GLSL}
vec4 tl_finish(vec4 paint, TlSurface s) {
  return vec4(tl_satin(tl_straight(paint), s, fx_dir(u_satinAngle) * tl_px(u_satinOffset)) * paint.a, paint.a);
}`,
	fieldReach: (p) => ({ inside: num(p.satinSize) * 2 + num(p.satinOffset) + 2 }),
	prepass: (p, ctx) =>
		reliefPasses(ctx, {
			size: 1,
			softness: num(p.satinSize),
			profile: 0,
			fit: false,
			raw: SILHOUETTE(ctx.depth.glsl),
		}),
	summary: () => 'satin',
});
