// `metal` (§5.1): gold, silver, chrome, copper and brushed steel. A metal has no colour of its own but what it mirrors: the
// surface domes over each stroke (Fit, as Pachislop's chrome preset), the mirrored view ray reads an environment (TL-038), and
// the metal tints it by its reflectance at normal incidence, rising to white at grazing angles (Schlick's approximation of
// Fresnel). `Curve` bends the whole title like a sheet, so the horizon runs across the letters and a large flat face is not
// one flat colour. Reflectances: linear sRGB values of measured metals, from Lagarde's "Feeding a physically based shading
// model" table (2011); chrome uses silver's brightness for the airbrushed look (see the note).

import { GLSL_NOISE } from '../../glsl/noise.ts';
import { GLSL_TL_ENV, TL_ENV_LABELS, TL_ENV_PRESETS } from '../../glsl/title-env.ts';
import { GLSL_TL_RELIEF, reliefPasses, reliefReach } from '../../glsl/title-relief.ts';
import { defineFinish, lp } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const METAL_KINDS = ['gold', 'silver', 'chrome', 'copper', 'brushed'] as const;

/** The mirror every metal shares, for finishes and Title Material. */
export const METAL_GLSL = /* glsl */ `
const vec3 TL_METAL_F0[5] = vec3[5](
  vec3(1.0, 0.71, 0.29),
  vec3(0.97, 0.96, 0.91),
  vec3(0.86, 0.87, 0.89),
  vec3(0.95, 0.54, 0.37),
  vec3(0.74, 0.75, 0.77)
);
// Metal's slope from the brushing: fine lines across the grain, long along it. Fades out below a pixel of grain, so a
// small render shows the mean of what a big one resolves.
vec2 tl_metalBrush(TlSurface s, vec2 grain, float px) {
  vec2 across = vec2(-grain.y, grain.x);
  vec2 q = (s.px - u_box.xy) / max(px, 1.0e-3);
  float v = dot(q, across);
  float u = dot(q, grain) * 0.03;
  float n = fx_valueNoise(vec2(v, u), u_tlSeed) + 0.5 * fx_valueNoise(vec2(v * 2.3, u * 1.7 + 9.0), u_tlSeed);
  return across * n * 0.5 * clamp(px * 0.5, 0.0, 1.0);
}
vec4 tl_metal(vec4 paint, TlSurface s, int kind, vec2 slope, float footprint, int env, float rotation, float rough, float tint) {
  vec2 b0 = vec2(0.0);
  float spread = rough;
  if (kind == 4) {
    b0 = tl_metalBrush(s, fx_dir(u_metalGrainAngle), tl_px(max(u_metalGrain, 0.02))) * 0.5;
    spread += 0.1;
  }
  vec3 n = normalize(vec3(-slope - b0, 1.0));
  vec3 r = tl_mirror(n);
  vec3 f0 = TL_METAL_F0[kind];
  f0 = mix(f0, tl_straight(paint) * dot(f0, vec3(0.333)) * 1.3, tint);
  float fresnel = pow(1.0 - clamp(n.z, 0.0, 1.0), 5.0);
  vec3 c = tl_envAA(env, r, rotation, spread, footprint);
  if (kind == 4) {
    // Brushed metal smears a light across the grain.
    vec2 grain = fx_dir(u_metalGrainAngle);
    vec3 side = vec3(-grain.y, grain.x, 0.0) * 0.32;
    c = (c + tl_envAA(env, normalize(r + side), rotation, spread, footprint) + tl_envAA(env, normalize(r - side), rotation, spread, footprint)) / 3.0;
  }
  c = tl_envTone(c) * (f0 + (1.0 - f0) * fresnel);
  // The look's light as a tight highlight on what faces it.
  vec3 h = normalize(u_tlLight + vec3(0.0, 0.0, 1.0));
  float gloss = mix(240.0, 24.0, clamp(spread * 2.0, 0.0, 1.0));
  c += f0 * pow(max(dot(n, h), 0.0), gloss) * 2.5;
  return vec4(c * paint.a, paint.a);
}
`;

export const FINISH_METAL = defineFinish({
	id: 'metal',
	label: 'Metal',
	description: 'Polished or brushed metal mirroring an environment: gold, silver, chrome, copper, brushed.',
	params: [
		lp.choice('metalKind', 'Metal', METAL_KINDS, ['Gold', 'Silver', 'Chrome', 'Copper', 'Brushed'], 'chrome'),
		lp.choice('metalEnv', 'Environment', TL_ENV_PRESETS, TL_ENV_LABELS, 'chromeBands'),
		lp.distance('metalSize', 'Size', 14, { softMax: 50 }),
		lp.number('metalDepth', 'Depth', 110, { min: 0, max: 1000, softMax: 400, step: 1 }, { unit: '%' }),
		lp.distance('metalSoftness', 'Softness', 5, { softMax: 20 }),
		lp.toggle('metalFit', 'Fit to Stroke Width', true),
		lp.percent('metalCurve', 'Curve', 45),
		lp.angle('metalRotation', 'Rotation', 0),
		lp.percent('metalRoughness', 'Roughness', 6),
		lp.percent('metalTint', 'Tint from Paint', 0),
		lp.distance('metalGrain', 'Grain', 0.6, { softMax: 5 }),
		lp.angle('metalGrainAngle', 'Grain Angle', 0),
	],
	include: [GLSL_TL_RELIEF, GLSL_TL_ENV, GLSL_NOISE],
	glsl: /* glsl */ `${METAL_GLSL}
vec4 tl_finish(vec4 paint, TlSurface s) {
  float k = tl_px(max(u_metalSize, 0.05)) * u_metalDepth * 0.01;
  vec2 slope = tl_heightSlope(s.uv) * k;
  // The sheet's bend: a cylinder across the shape's height, top leaning back to the sky.
  vec4 b = tl_bounds();
  slope.y -= (s.px.y - (b.y + b.w) * 0.5) / max((b.w - b.y) * 0.5, 1.0) * u_metalCurve * 0.01;
  return tl_metal(paint, s, u_metalKind, slope, tl_reliefFootprint(s, k), u_metalEnv, radians(u_metalRotation), u_metalRoughness * 0.01, u_metalTint * 0.01);
}`,
	fieldReach: (p) => reliefReach(num(p.metalSize), p.metalFit === true),
	prepass: (p, ctx) =>
		reliefPasses(ctx, {
			size: num(p.metalSize),
			softness: num(p.metalSoftness),
			profile: 0,
			fit: p.metalFit === true,
		}),
	summary: (p) => String(p.metalKind),
});
