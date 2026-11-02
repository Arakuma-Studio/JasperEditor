// Sunburst (TL-061): rays from a centre, after Pachislop's lines/sunburst.ts: alternating ray wedges merging into a disc
// with a centre glow, or wedges, focus lines and speed rings around a cleared centre. Rotation and twist are closed forms
// of time. In a look the rays end at Extent, because a look's canvas ends at its padding; standalone they fill the frame.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, lp } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const STYLES = ['sunburst', 'wedges', 'focus', 'rings'];

export const GENERATOR_SUNBURST = defineGenerator({
	id: 'sunburst',
	label: 'Sunburst',
	description: 'Rays from the title or a point: a rotating sunburst, wedges, focus lines or speed rings.',
	keywords: ['rays', 'burst', 'radial', 'focus lines', 'manga', 'rotate'],
	params: [
		lp.choice('style', 'Style', STYLES, ['Sunburst', 'Wedges', 'Focus Lines', 'Speed Rings'], 'sunburst'),
		lp.choice('centre', 'Centre', ['title', 'point'], ['Title', 'Point'], 'title'),
		lp.point('center', 'Centre Point', [0.5, 0.5]),
		lp.toggle('clip', 'Clip to Title', false),
		lp.number('rays', 'Rays', 24, { min: 2, max: 300, softMax: 120, step: 1 }),
		lp.angle('rotation', 'Rotation', 0),
		lp.number(
			'spin',
			'Spin',
			12,
			{ min: -720, max: 720, softMin: -90, softMax: 90, step: 0.1 },
			{ unit: 'deg' },
		),
		lp.percent('rayWidth', 'Ray Width', 50),
		lp.percent('widthVariation', 'Width Variation', 40),
		lp.percent('lengthVariation', 'Length Variation', 60),
		lp.number(
			'twist',
			'Twist',
			0,
			{ min: -3600, max: 3600, softMin: -360, softMax: 360, step: 0.1 },
			{ unit: 'deg' },
		),
		lp.number(
			'twistRate',
			'Twist Speed',
			0,
			{ min: -720, max: 720, softMin: -90, softMax: 90, step: 0.1 },
			{ unit: 'deg' },
		),
		lp.distance('inner', 'Inner Radius', 70, { softMax: 300 }),
		lp.percent('softness', 'Softness', 10),
		lp.percent('innerSoftness', 'Inner Softness', 60),
		lp.choice('rayColors', 'Ray Colour', ['flat', 'radial'], ['Colour A', 'Along the Radius'], 'flat'),
		lp.color('colorA', 'Colour A', hex('#ffc93c')),
		lp.color('colorB', 'Colour B', hex('#c2121c')),
		lp.color('colorEdge', 'Radius End Colour', hex('#7a4a0a')),
		lp.toggle('alternate', 'Two Colours', false),
		lp.number('centreGlow', 'Centre Glow', 70, { min: 0, max: 300, step: 1 }, { unit: '%' }),
		lp.percent('rayOpacity', 'Ray Opacity', 70),
		lp.distance('extent', 'Extent', 260, { min: 10, softMax: 800 }),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	usesBounds: () => true,
	defines: (p) => `#define TLG_SUNBURST ${Math.max(0, STYLES.indexOf(String(p.style)))}\n`,
	color: { role: 'accent1', mode: 'luma' },
	presets: [
		{ id: 'redGold', label: 'Red and Gold Rays', params: {} },
		{
			id: 'blue',
			label: 'Blue Rays',
			params: { rays: 32, softness: 30, colorA: hex('#4fc3ff'), colorB: hex('#0a2a8a'), centreGlow: 60 },
		},
		{
			id: 'halo',
			label: 'Rainbow Halo',
			params: {
				rays: 48,
				inner: 45,
				softness: 60,
				rayColors: 'radial',
				colorA: hex('#fff27a'),
				colorB: hex('#120c24'),
				colorEdge: hex('#3ab8ff'),
				centreGlow: 100,
			},
		},
		{
			id: 'focusLines',
			label: 'Focus Lines',
			params: {
				style: 'focus',
				rays: 90,
				rayWidth: 30,
				widthVariation: 60,
				lengthVariation: 70,
				inner: 120,
				innerSoftness: 40,
				colorA: hex('#ffffff'),
				rayOpacity: 55,
				spin: 0,
				variation: 6,
			},
		},
		{
			id: 'wedges',
			label: 'Two-Colour Wedges',
			params: {
				style: 'wedges',
				rays: 40,
				rayWidth: 40,
				widthVariation: 50,
				inner: 0,
				alternate: true,
				colorA: hex('#e8962a'),
				colorB: hex('#2e1000'),
				rayOpacity: 100,
				variation: 4,
			},
		},
	],
	reach: (p) => (p.clip === true ? 0 : num(p.extent)),
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.spin) !== 0 || num(p.twistRate) !== 0,
	summary: (p) => `${String(p.style)}, ${num(p.rays)} rays, ${pct(p.extent)}`,
	glsl: /* glsl */ `
vec2 tlg_centre() {
  if (u_centre == 0) { vec4 b = tl_bounds(); return (b.xy + b.zw) * 0.5; }
  return fx_uvOfLayerNorm(u_center) * u_canvasSize;
}
#if TLG_SUNBURST == 0
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  vec2 c0 = tlg_centre();
  vec2 d = s.px - c0;
  float r = length(d);
  float n = max(2.0, floor(u_rays + 0.5));
  float time = u_tlTime;
  // One turn of twist per 500 % of the unit of radius.
  float twist = radians(u_twist + u_twistRate * time) / max(tl_px(500.0), 1.0);
  float th = atan(d.y, d.x) - radians(u_rotation + u_spin * time) + twist * r;
  float u = fract(th / FX_TAU * n + 0.5) - 0.5;
  // One period's arc in px, shortened by the slant of twisted edges.
  float period = FX_TAU * r / n / sqrt(1.0 + r * r * twist * twist);
  float soft = u_softness * 0.01;
  float duty = clamp(u_rayWidth * 0.01, 0.01, 1.0);
  float edge = mix(1.0, 0.5 * period, soft);
  float cov = smoothstep(0.0, 1.0, clamp((0.5 * duty - abs(u)) * period / max(edge, 1.0e-3) + 0.5, 0.0, 1.0));
  cov = mix(0.5, cov, clamp(0.5 * period - 1.0, 0.0, 1.0));
  // Inside the inner radius the rays merge into a disc of the ray colour.
  float inner = tl_px(u_inner);
  cov = max(cov, clamp((inner - r) / max(1.0, soft * inner * 0.6) + 0.5, 0.0, 1.0));
#ifdef TLG_STANDALONE
  vec2 far = max(abs(c0 - u_box.xy), abs(u_box.xy + u_box.zw - c0));
  float rc = max(length(far), 1.0);
  float fade = 1.0;
#else
  float rc = max(tl_px(u_extent), 1.0);
  float fade = 1.0 - smoothstep(0.72, 1.0, r / rc);
#endif
  vec3 a = tlg_rgb(u_colorA), b = tlg_rgb(u_colorB);
  vec3 ray = u_rayColors == 1 ? mix(a, tlg_rgb(u_colorEdge), clamp(r / rc, 0.0, 1.0)) : a;
  vec3 c = mix(b, ray, cov);
  // Centre glow: a whitened ray colour, about twice the inner disc wide.
  float gr = max(inner * 1.6, 0.15 * rc);
  c += mix(a, vec3(1.0), 0.6) * (u_centreGlow * 0.01) * exp(-2.0 * r * r / (gr * gr));
  float alpha = fade * (u_clip ? s.alpha : 1.0);
  return vec4(c * alpha, alpha);
}
#else
float tlg_lin1(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  vec2 d = s.px - tlg_centre();
  float r = length(d);
  float time = u_tlTime;
  float ang = atan(d.y, d.x) - radians(u_rotation + u_spin * time);
  float N = max(1.0, floor(u_rays + 0.5));
  float duty = clamp(u_rayWidth * 0.01, 0.01, 1.0);
  float vary = u_widthVariation * 0.01;
  float lenVar = u_lengthVariation * 0.01;
  float inner = tl_px(u_inner);
  float soft = clamp(u_innerSoftness * 0.01, 0.0, 1.0);
  float cov = 0.0;
  float k = 0.0;
#if TLG_SUNBURST < 3
  float u = fract(ang / FX_TAU) * N;
  float i = min(floor(u), N - 1.0);
  float f = u - i;
  int id = int(i);
  float h1 = tlg_h(id, 1), h2 = tlg_h(id, 2), h3 = tlg_h(id, 3);
  float sectorPx = FX_TAU * r / N;
#if TLG_SUNBURST == 1
  // Wedges: the angular width varies per ray.
  float w = duty * (1.0 - vary * h1);
  float c0 = 0.5 + (h2 - 0.5) * (1.0 - w) * vary;
  cov = clamp((0.5 * w - abs(f - c0)) * sectorPx + 0.5, 0.0, 1.0);
#else
  // Focus lines: needle rays starting at random radii beyond the inner radius.
  float start = inner * (1.0 + lenVar * 1.5 * h3);
  float grow = max(inner * 0.6, tl_px(20.0));
  float w = duty * (1.0 - vary * h1) * smoothstep(start, start + grow, r);
  float c0 = 0.5 + (h2 - 0.5) * 0.7;
  cov = clamp((0.5 * w - abs(f - c0)) * sectorPx + 0.5, 0.0, 1.0) * step(start, r);
  k = step(0.5, h3);
#endif
#else
  // Concentric speed rings: broken arcs at regular radii, rings per 500 % of the unit.
  float spacing = tl_px(500.0) / N;
  float fj = floor(r / spacing);
  float fr = r / spacing - fj;
  int id = int(fj);
  float h1 = tlg_h(id, 1), h2 = tlg_h(id, 2), h3 = tlg_h(id, 3);
  float w = duty * (1.0 - vary * h1);
  float band = clamp((0.5 * w - abs(fr - 0.5)) * spacing + 0.5, 0.0, 1.0);
  float segs = floor(3.0 + 9.0 * h2);
  float sa = fract(ang / FX_TAU * segs + h3);
  float arcLen = mix(1.0, 0.35 + 0.5 * h1, lenVar);
  cov = band * clamp((0.5 * arcLen - abs(sa - 0.5)) * (FX_TAU * r / segs) + 0.5, 0.0, 1.0);
  k = mod(fj, 2.0);
#endif
  // Clear the centre with a soft edge.
  float hole = smoothstep(inner * (1.0 - soft) - 1.0, inner, r);
#ifdef TLG_STANDALONE
  float fade = 1.0;
#else
  float fade = 1.0 - smoothstep(0.72, 1.0, r / max(tl_px(u_extent), 1.0));
#endif
  vec3 c1 = tlg_rgb(u_colorA), c2 = tlg_rgb(u_colorB);
  vec3 c;
  float a;
#if TLG_SUNBURST == 1
  if (u_alternate) { c = mix(c2, c1, cov); a = hole * (u_rayOpacity * 0.01); }
  else { c = c1; a = cov * hole * (u_rayOpacity * 0.01); }
#else
  c = u_alternate && k > 0.5 ? c2 : c1;
  a = cov * hole * (u_rayOpacity * 0.01);
#endif
  // Ray opacity is perceptual: the alpha that gives the same brightness over black as a mix in the signal.
  vec3 sig = fx_linearToSrgb(clamp(c, 0.0, 1.0));
  float ls = dot(sig, vec3(0.2126, 0.7152, 0.0722));
  float aT = ls > 1.0e-4 ? clamp(tlg_lin1(a * ls) / tlg_lin1(ls), 0.0, 1.0) : a;
  aT *= fade * (u_clip ? s.alpha : 1.0);
  return vec4(c * aT, aT);
}
#endif
`,
});
