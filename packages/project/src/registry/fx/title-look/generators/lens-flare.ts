// Lens Flare (TL-061): an anamorphic flare drawn as light, after Pachislop's light/lensFlare.ts: core, streak, starburst,
// halo ring and ghosts. Position and intensity keyframe, Flicker is a closed form of time. `jasper.lens-flare` and
// `jasper.s.lens-flare` remain the lens models; this one sits in a look, centres on the title and recolours with it.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, lp } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

/** Anamorphic streak along x: a hot thin line in a softer sheath, white at the centre (Pachislop's common.ts). */
const ANAMORPHIC = /* glsl */ `
vec3 tlg_anamorphic(vec2 lv, float size, float len, vec3 col) {
  float sy = abs(lv.y) / size;
  float sx = abs(lv.x) / max(len, 1.0);
  float streak = exp(-sy * 28.0) * exp(-sx * 2.2) * 1.4 + exp(-sy * 7.0) * exp(-sx * 4.0) * 0.35;
  return mix(col, vec3(1.0), exp(-sx * 6.0) * exp(-sy * 40.0)) * streak;
}`;

export { ANAMORPHIC };

export const GENERATOR_LENS_FLARE = defineGenerator({
	id: 'lensFlare',
	label: 'Lens Flare',
	effectLabel: 'Title Flare',
	description: 'An anamorphic flare as light: core, streak, starburst, halo ring and ghosts, on the title or a point.',
	keywords: ['flare', 'anamorphic', 'streak', 'ghosts', 'light'],
	params: [
		lp.choice('centre', 'Centre', ['point', 'title'], ['Point', 'Title'], 'point'),
		lp.point('center', 'Position', [0.25, 0.3]),
		lp.distance('size', 'Size', 35, { min: 1, softMax: 300 }),
		lp.distance('streak', 'Streak Length', 150, { softMax: 800 }),
		lp.angle('rotation', 'Streak Angle', 0),
		lp.number('rays', 'Starburst', 60, { min: 0, max: 200, step: 1 }, { unit: '%' }),
		lp.toggle('ghosts', 'Ghosts', true),
		lp.color('color', 'Colour', hex('#7cc4ff')),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 400, step: 1 }, { unit: '%' }),
		lp.percent('flicker', 'Flicker', 6),
		lp.number('flickerRate', 'Flicker Rate', 3, { min: 0, max: 30, step: 0.1 }, { unit: 'Hz' }),
		lp.distance('extent', 'Extent', 260, { min: 10, softMax: 800 }),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	front: true,
	usesBounds: () => true,
	color: { role: 'glow', mode: 'light' },
	presets: [
		{ id: 'blue', label: 'Blue Flare', params: {} },
		{
			id: 'gold',
			label: 'Gold Flare',
			params: { center: [0.72, 0.3], size: 30, streak: 180, color: hex('#ffd27a'), intensity: 110 },
		},
		{
			id: 'streak',
			label: 'Long Streak',
			params: { centre: 'title', size: 20, streak: 240, rays: 20, ghosts: false, color: hex('#5ab0ff'), intensity: 120 },
		},
	],
	reach: (p) => num(p.extent),
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.flicker) > 0 && num(p.flickerRate) > 0,
	summary: (p) => `size ${pct(p.size)}`,
	glsl: /* glsl */ `${ANAMORPHIC}
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  vec2 pos;
  if (u_centre == 1) { vec4 b = tl_bounds(); pos = (b.xy + b.zw) * 0.5; }
  else pos = fx_uvOfLayerNorm(u_center) * u_canvasSize;
  float size = max(tl_px(u_size), 1.0);
  vec2 v = s.px - pos;
  float c = cos(radians(u_rotation)), sn = sin(radians(u_rotation));
  vec2 lv = vec2(c * v.x + sn * v.y, -sn * v.x + c * v.y);
  float r = length(v) / size;
  vec3 col = tlg_rgb(u_color);
  vec3 L = vec3(exp(-r * r * 18.0) * 2.0 + 0.25 / (1.0 + r * r * 6.0));
  L += col * 0.35 / (1.0 + r * r * 1.5);
  L += tlg_anamorphic(lv, size, tl_px(u_streak), col);
  // Starburst spikes.
  float ang = atan(v.y, v.x);
  vec2 cd = vec2(cos(ang), sin(ang));
  float sp = pow(tlg_vnoise(cd * 9.0 + 40.0), 3.0) * 2.5 + pow(tlg_vnoise(cd * 23.0 + 80.0), 6.0) * 4.0;
  L += mix(col, vec3(1.0), 0.6) * sp * (u_rays * 0.01) * 0.5 / (1.0 + r * r * 2.5) * smoothstep(0.0, 0.15, r);
  // Chromatic halo ring.
  vec3 ring = vec3(exp(-pow((r - 2.35) / 0.07, 2.0)), exp(-pow((r - 2.25) / 0.07, 2.0)), exp(-pow((r - 2.15) / 0.07, 2.0)));
  L += ring * 0.18;
  if (u_ghosts) {
    vec2 axis = 0.5 * u_canvasSize - pos;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float k = 0.35 + fi * 0.33 + (tlg_h(i, 1) - 0.5) * 0.2;
      float gs = size * (0.25 + 0.9 * tlg_h(i, 2));
      float d = length(s.px - pos - axis * k * 2.0) / gs;
      float disc = (1.0 - smoothstep(0.9, 1.0, d)) * (0.35 + 0.65 * d * d);
      vec3 tint = 0.5 + 0.5 * cos(6.2831 * (fi * 0.17 + vec3(0.0, 0.33, 0.67) + tlg_h(0, 3)));
      L += tint * mix(col, vec3(1.0), 0.3) * disc * 0.16;
    }
  }
  float flick = 1.0 - (u_flicker * 0.01) * tlg_noise1(u_tlTime * u_flickerRate, 7);
#ifdef TLG_STANDALONE
  float fade = 1.0;
#else
  float fade = 1.0 - smoothstep(0.55, 1.0, max(abs(v.x), abs(v.y)) / max(tl_px(u_extent), 1.0));
#endif
  return tlg_light(L * (u_intensity * 0.01) * flick * fade);
}`,
});
