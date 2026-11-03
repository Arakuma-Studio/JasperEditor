// `glass` (§5.1): Pachislop's Glass2D in linear light. What is seen through takes the glass colour and deepens as thick glass
// does; steep slopes darken (a Fresnel rim); light entering on the lit side focuses into a caustic band inside the far edge;
// rims and caustics are more opaque than the body. It refracts only its own fill, as §5.1 says: the paint is read where the
// tilted surface bends the view. Footage behind a title is §9's.
import { GLSL_TL_ENV, TL_ENV_LABELS, TL_ENV_PRESETS } from '../../glsl/title-env.ts';
import { GLSL_TL_RELIEF, reliefPasses, reliefReach } from '../../glsl/title-relief.ts';
import { defineFinish, lp } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Glass over `body` (the fill, read through the surface), for finishes and Title Material. */
export const GLASS_GLSL = /* glsl */ `
vec4 tl_glass(vec3 body, float bodyAlpha, TlSurface s, vec3 n, float widthPx) {
  vec3 base = mix(body, tl_linear(u_glassColor.rgb), u_glassTint * 0.01);
  vec3 gc = base * base * 0.55 + base * 0.2;
  float slope = clamp(1.0 - n.z, 0.0, 1.0);
  float fres = smoothstep(0.0, 0.7, slope);
  float edge = u_glassEdge * 0.01;
  float caustics = u_glassCaustic * 0.01;
  gc *= 1.0 - fres * edge * 0.85;
  vec2 lightDir = normalize(u_tlLight.xy + 1.0e-6);
  float here = tl_height(s.uv);
  float back = tl_height(s.uv - lightDir * widthPx * 1.6 / u_canvasSize);
  float caus = clamp(1.0 - back, 0.0, 1.0) * smoothstep(0.05, 0.6, here) * (1.0 - fres * 0.6);
  gc += mix(base, vec3(1.0), 0.3) * caus * caus * caustics * 1.8;
  gc += base * 0.15 * smoothstep(0.5, 1.0, here) * caustics;
  // The sky on what leans towards it, and the room mirrored by the surface.
  gc += vec3(0.5) * smoothstep(0.1, 0.8, -n.y) * slope;
  gc += tl_env(u_glassEnv, tl_mirror(n), 0.0, 0.04) * (0.04 + 0.96 * pow(1.0 - clamp(n.z, 0.0, 1.0), 5.0)) * u_glassReflection * 0.01;
  float a = clamp(u_glassOpacity * 0.01 + (1.0 - u_glassOpacity * 0.01) * (fres * edge * 0.8 + caus * caustics * 0.6), 0.0, 1.0);
  // The highlight stays visible on clear glass.
  vec2 lit = tl_lit(n);
  a = clamp(a + lit.x, 0.0, 1.0);
  vec3 h = normalize(u_tlLight + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 120.0) * 2.5;
  a = clamp(a + spec, 0.0, 1.0);
  return vec4((gc + vec3(spec)) * a, a) * bodyAlpha;
}
`;

export const FINISH_GLASS = defineFinish({
	id: 'glass',
	label: 'Glass',
	description: 'Tinted glass with Fresnel edges and caustics, refracting its own fill.',
	params: [
		lp.distance('glassSize', 'Size', 9, { softMax: 40 }),
		lp.number('glassDepth', 'Depth', 120, { min: 0, max: 1000, softMax: 400, step: 1 }, { unit: '%' }),
		lp.distance('glassSoftness', 'Softness', 3, { softMax: 20 }),
		lp.toggle('glassFit', 'Fit to Stroke Width', false),
		lp.distance('glassRefraction', 'Refraction', 5, { softMax: 30 }),
		lp.color('glassColor', 'Glass Colour', [0.75, 0.9, 1, 1]),
		lp.percent('glassTint', 'Tint', 35),
		lp.percent('glassOpacity', 'Opacity', 45),
		lp.percent('glassEdge', 'Edge', 70),
		lp.percent('glassCaustic', 'Caustics', 60),
		lp.choice('glassEnv', 'Environment', TL_ENV_PRESETS, TL_ENV_LABELS, 'studio'),
		lp.percent('glassReflection', 'Reflection', 45),
	],
	include: [GLSL_TL_RELIEF, GLSL_TL_ENV],
	glsl: /* glsl */ `${GLASS_GLSL}
vec4 tl_finish(vec4 paint, TlSurface s) {
  float k = tl_px(max(u_glassSize, 0.05));
  vec3 n = tl_reliefNormal(s, k * u_glassDepth * 0.01);
  TlSurface q = s;
  q.uv = s.uv - n.xy * tl_px(u_glassRefraction) / u_canvasSize;
  q.px = q.uv * u_canvasSize;
  vec4 seen = tlPaint_paint(q);
  // A read off the shape keeps the colour here.
  if (texture(u_source, q.uv).a <= 0.02) seen = paint;
  return tl_glass(tl_straight(seen), paint.a, s, n, k);
}`,
	fieldReach: (p) => reliefReach(num(p.glassSize), p.glassFit === true),
	prepass: (p, ctx) =>
		reliefPasses(ctx, {
			size: num(p.glassSize),
			softness: num(p.glassSoftness),
			profile: 0,
			fit: p.glassFit === true,
		}),
	summary: () => 'glass',
});
