// `extrude` (spec 19 §8, not in the §5.1 table: the look layer of the Shaded Extrude effect, so both share this GLSL).
// Ported from Pachislop's extrude2d (effects/a/stylize.ts): the shape stacked along a direction with shaded sides.
//
// Pachislop walks up to 1024 copies per pixel at a step of 0.75 px. Here the field says how far is safe, so a ray takes few
// steps at any depth and any size, and normals come from the field, not from a blurred alpha clamped in pixels. A ray
// keeps its closest approach to the shape, whose distance antialiases the sides' outline. Like Pachislop's, it draws behind
// what is below it in the stack, so it works above or below the face.
import { fmtDistance, layerSwatch, lp, type TitleLayerInit } from '../contract.ts';
import { GLSL_TL_STAGE } from '../glsl.ts';
import { GLSL_TL_LIGHT } from '../light.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const DEG = Math.PI / 180;

/** Steps of a ray (a loop bound): the field reach below keeps a straight miss under it. */
const STEPS = 96;
/** The field's reach as a share of the depth: a miss crosses the depth in at most this many steps. */
const REACH_STEPS = 32;

const gradientPaint = (p: Record<string, unknown>) =>
	(p.paint as { kind?: string } | undefined)?.kind === 'gradient';

export const EXTRUDE_LAYER: TitleLayerInit = {
	type: 'extrude',
	label: 'Extrude',
	description:
		'The shape stacked along a direction, with shaded sides. Flat and one colour, it is a long shadow.',
	finish: false,
	outermost: true,
	params: [
		lp.angle('angle', 'Direction', 75),
		lp.distance('depth', 'Depth', 14, { softMax: 100 }),
		...lp.paint('paint', 'Sides', {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'block',
				angle: 0,
				stops: [
					{ at: 0, paint: { role: 'accent1' } },
					{ at: 1, paint: { role: 'shadow' } },
				],
			},
		}),
		lp.toggle('useLight', 'Use Light', false),
		lp.angle('lightAngle', 'Light From', 240),
		lp.percent('shading', 'Shading', 70),
		lp.percent('edge', 'Edge Darkening', 55),
		lp.percent('fade', 'Fade', 0),
		lp.percent('opacity', 'Opacity', 100),
	],
	shader(p) {
		return {
			glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  // Depth and light on screen: the sides go the same way however the title turns.
  vec2 dir = tl_fromScreen(fx_dir(u_angle));
  float len = max(tl_px(u_depth), 1.0);
  float least = max(1.0, len / 256.0);
  float t = 0.0;
  float best = 1.0e9;
  float bestT = 0.0;
  float bestOpacity = 0.0;
  vec2 bestUv = s.uv;
  for (int i = 0; i < ${STEPS} + int(min(0.0, u_resolution.x)); i++) { // an opaque bound: SwiftShader does not unroll it
    vec2 uv = s.uv - dir * t / u_canvasSize;
    TlSurface q = tl_surfaceAt(uv);
    float d = q.d - s.base;
    if (d < best) { best = d; bestT = t; bestUv = uv; bestOpacity = q.opacity; }
    if (d <= -0.5 || t >= len) break;
    t = min(t + max(d, least), len);
  }
  float cov = tl_inside(best, 0.0) * bestOpacity;
  if (cov <= 0.0) return vec4(0.0);
  // The outward normal of the face where the ray met it: the field's slope, wide enough to be smooth, resolution free.
  vec2 e = max(tl_px(0.6), 1.5) / u_canvasSize;
  vec2 g = vec2(tl_surfaceAt(bestUv + vec2(e.x, 0.0)).d - tl_surfaceAt(bestUv - vec2(e.x, 0.0)).d,
                tl_surfaceAt(bestUv + vec2(0.0, e.y)).d - tl_surfaceAt(bestUv - vec2(0.0, e.y)).d);
  float gl = length(g);
  vec2 n = gl > 1.0e-4 ? g / gl : dir;
  vec2 light = u_useLight ? u_tlLightDir : tl_fromScreen(fx_dir(u_lightAngle));
  float lit = 0.5 + 0.5 * dot(n, light);
  float x = bestT / len;
  vec4 c = ${gradientPaint(p) ? 'tl_ramp(u_paintRamp, x)' : 'tlPaint_paint(s)'};
  vec3 rgb = c.rgb * mix(1.0, 0.4 + 0.95 * lit, u_shading * 0.01);
  // A dark contact line where the side meets the face, and along the back edge.
  float line = tl_px(1.5);
  float edge = u_edge * 0.01;
  rgb *= 1.0 - edge * (1.0 - smoothstep(0.0, line, bestT));
  rgb *= 1.0 - 0.6 * edge * smoothstep(len - line, len, bestT);
  vec4 side = vec4(rgb, c.a) * cov * (1.0 - u_fade * 0.01 * x) * (u_opacity * 0.01);
  return tl_result(under, under + side * (1.0 - under.a));
}`,
			include: [GLSL_TL_LIGHT, GLSL_TL_STAGE],
		};
	},
	reach(p) {
		const a = num(p.angle) * DEG;
		const d = num(p.depth);
		const side = (v: number) => Math.max(0, v) * d;
		return {
			left: side(-Math.cos(a)),
			top: side(-Math.sin(a)),
			right: side(Math.cos(a)),
			bottom: side(Math.sin(a)),
		};
	},
	fieldReach: (p) => ({ outside: num(p.depth) / REACH_STEPS + 1, inside: 2 }),
	handles: [
		{ kind: 'offset', params: ['angle', 'depth'] },
		{ kind: 'angle', params: ['lightAngle'], when: { param: 'useLight', value: false } },
		{ kind: 'angle', params: ['angle'], target: 'light', when: { param: 'useLight', value: true } },
	],
	summary(p) {
		return {
			swatch: layerSwatch(EXTRUDE_LAYER, p),
			text: `${fmtDistance(p.depth)} deep`,
			primary: 'depth',
		};
	},
};
