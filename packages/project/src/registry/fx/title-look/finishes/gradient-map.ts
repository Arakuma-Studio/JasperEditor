// `gradientMap` (§5.1): tones through a gradient, Pachislop's metal `finish` ramp. A flat paint has no tones of its own, so
// the input is a choice: `relief` lights a dome over the shape and maps that (the classic gold text), `luma` maps the paint's
// luminance, `depth` the distance from the edge.
import { GLSL_TL_RELIEF, reliefPasses, reliefReach } from '../../glsl/title-relief.ts';
import { defineFinish, lp } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const relief = (p: Record<string, unknown>) => p.gradientMapInput === 'relief';

export const FINISH_GRADIENT_MAP = defineFinish({
	id: 'gradientMap',
	label: 'Gradient Map',
	description: 'Maps the shape’s tones through a gradient.',
	params: [
		...lp.paint('gradientMapRamp', 'Gradient', {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'block',
				angle: 0,
				stops: [
					{ at: 0, paint: { role: 'shadow' } },
					{ at: 0.45, paint: { role: 'face' } },
					{ at: 0.8, paint: { role: 'faceAlt' } },
					{ at: 1, paint: { color: [1, 1, 1, 1] } },
				],
			},
		}),
		lp.choice('gradientMapInput', 'Input', ['relief', 'luma', 'depth'], ['Relief', 'Luminance', 'Depth'], 'relief'),
		lp.percent('gradientMapAmount', 'Amount', 100),
		lp.distance('gradientMapSize', 'Size', 14, { softMax: 50 }),
		lp.toggle('gradientMapFit', 'Fit to Stroke Width', true),
	],
	include: [GLSL_TL_RELIEF],
	defines: (p) => (relief(p) ? '#define TL_GM_RELIEF\n' : ''),
	glsl: /* glsl */ `
vec4 tl_finish(vec4 paint, TlSurface s) {
  vec3 c = tl_straight(paint);
  float x = fx_luma(fx_linearToSrgb(clamp(c, 0.0, 1.0)));
#ifdef TL_GM_RELIEF
  vec3 n = tl_reliefNormal(s, tl_px(max(u_gradientMapSize, 0.05)) * 1.3);
  x = clamp(0.5 + 0.5 * (dot(n, u_tlLight) - u_tlLight.z) / max(1.0 - u_tlLight.z, 0.05), 0.0, 1.0);
#else
  if (u_gradientMapInput == 2) x = clamp(-s.d / max(tl_px(u_gradientMapSize), 1.0), 0.0, 1.0);
#endif
  vec4 m = tlPaintAt_gradientMapRamp(x, s);
  return vec4(mix(c, tl_straight(m), m.a * u_gradientMapAmount * 0.01) * paint.a, paint.a);
}`,
	fieldReach: (p) =>
		relief(p) ? reliefReach(num(p.gradientMapSize), p.gradientMapFit === true) : { inside: num(p.gradientMapSize) + 1 },
	prepass: (p, ctx) =>
		relief(p)
			? reliefPasses(ctx, {
					size: num(p.gradientMapSize),
					softness: 2,
					profile: 0,
					fit: p.gradientMapFit === true,
				})
			: [],
	summary: (p) => `${String(p.gradientMapInput)} gradient map`,
});
