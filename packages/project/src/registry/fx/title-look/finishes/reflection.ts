// `reflection` (§5.1, TL-038): the view ray mirrored off the relief into an environment, a preset or the user's picture (a
// `{mediaId}` param, equirectangular, row 0 the zenith). `Colorize` keeps the fill's hue as Pachislop's does: dark reflections
// deepen the fill, mid tones keep it and only the brightest run to white, so a saturated colour never washes to pastel.
import { GLSL_TL_ENV, TL_ENV_LABELS, TL_ENV_PRESETS } from '../../glsl/title-env.ts';
import { GLSL_TL_RELIEF, reliefPasses, reliefReach } from '../../glsl/title-relief.ts';
import { defineFinish, lp } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const FINISH_REFLECTION = defineFinish({
	id: 'reflection',
	label: 'Reflection',
	description: 'Mirrors an environment, a preset or your own panorama, on the shape’s relief.',
	params: [
		lp.choice('reflectionEnv', 'Environment', TL_ENV_PRESETS, TL_ENV_LABELS, 'studio'),
		lp.media('reflectionImage', 'Image', ['image']),
		lp.angle('reflectionRotation', 'Rotation', 0),
		lp.percent('reflectionBlur', 'Blur', 8),
		lp.percent('reflectionStrength', 'Strength', 100),
		lp.percent('reflectionColorize', 'Colorize', 0),
		lp.distance('reflectionSize', 'Size', 12, { softMax: 50 }),
		lp.number('reflectionDepth', 'Depth', 110, { min: 0, max: 1000, softMax: 400, step: 1 }, { unit: '%' }),
		lp.toggle('reflectionFit', 'Fit to Stroke Width', true),
	],
	include: [GLSL_TL_RELIEF, GLSL_TL_ENV],
	glsl: /* glsl */ `
vec4 tl_finish(vec4 paint, TlSurface s) {
  vec3 c = tl_straight(paint);
  vec3 n = tl_reliefNormal(s, tl_px(max(u_reflectionSize, 0.05)) * u_reflectionDepth * 0.01);
  vec3 r = tl_mirror(n);
  float rot = radians(u_reflectionRotation);
  float blur = u_reflectionBlur * 0.01 * 0.6;
  // No picture bound (none chosen, or offline: the chip and the export warning say so): the preset.
  vec3 e = u_reflectionImage_size.x > 0.0 ? tl_envImage(u_reflectionImage, r, rot, blur) : tl_envTone(tl_envAA(u_reflectionEnv, r, rot, blur));
  float l = clamp(fx_luma(e), 0.0, 1.0);
  float w = max(2.0 * l - 1.0, 0.0);
  vec3 tinted = l < 0.5 ? 2.0 * c * l : mix(c, vec3(1.0), w * w);
  return vec4(mix(c, mix(e, tinted, u_reflectionColorize * 0.01), u_reflectionStrength * 0.01) * paint.a, paint.a);
}`,
	fieldReach: (p) => reliefReach(num(p.reflectionSize), p.reflectionFit === true),
	prepass: (p, ctx) =>
		reliefPasses(ctx, {
			size: num(p.reflectionSize),
			softness: 3,
			profile: 0,
			fit: p.reflectionFit === true,
		}),
	summary: (p) => `${String(p.reflectionEnv)} reflection`,
});
