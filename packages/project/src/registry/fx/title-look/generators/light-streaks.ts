// Light Streaks (TL-061): white-cored lines of light with a coloured edge, after Pachislop's lines/lightStreaks.ts:
// anamorphic streaks through the origin, a bundle of beams fanning out of it, or arrow-tapered spears. Each streak is one
// instanced quad shaded analytically; its position along the flight line is a wrapped closed form of time. The halo is
// analytic too (Pachislop blurs a second picture of the edges): it stays exact at every size, and light adds.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

const MAX_STREAKS = 200;

/** Vertices of a quad as `-1..1` corners from `gl_VertexID`. */
export const GLSL_TLG_QUAD = {
	name: 'title-look/generator-quad',
	source: /* glsl */ `
vec2 tlg_corner(int v) {
  int k = v % 6;
  if (k == 0) return vec2(-1.0, -1.0);
  if (k == 1 || k == 4) return vec2(1.0, -1.0);
  if (k == 2 || k == 3) return vec2(-1.0, 1.0);
  return vec2(1.0, 1.0);
}
`,
};

function reachOf(p: LayerParams): number {
	const L = Math.max(1, num(p.length));
	const pad = num(p.halo) + num(p.chroma) + num(p.thickness) + 4;
	return (p.mode === 'anamorphic' ? 0.7 * L : 1.6 * L) + pad;
}

export const GENERATOR_LIGHT_STREAKS = defineGenerator({
	id: 'lightStreaks',
	label: 'Light Streaks',
	description: 'White-cored lines of light flying past: anamorphic streaks, a bundle of beams, or spears.',
	keywords: ['streak', 'anamorphic', 'beam', 'light', 'whoosh'],
	params: [
		lp.choice(
			'mode',
			'Mode',
			['anamorphic', 'bundle', 'spears'],
			['Anamorphic', 'Bundle', 'Spears'],
			'anamorphic',
		),
		lp.point('center', 'Origin', [0.5, 0.5]),
		lp.angle('angle', 'Angle', 0),
		lp.number('spread', 'Spread', 3, { min: 0, max: 360, step: 0.1 }, { unit: 'deg' }),
		lp.number('count', 'Count', 6, { min: 1, max: MAX_STREAKS, softMax: 60, step: 1 }),
		lp.distance('length', 'Length', 320, { min: 1, softMax: 1500 }),
		lp.percent('lengthRandom', 'Length Random', 55),
		lp.distance('thickness', 'Thickness', 8, { min: 0.25, softMax: 80 }),
		lp.percent('thicknessRandom', 'Thickness Random', 60),
		lp.percent('taperHead', 'Taper Head', 100),
		lp.percent('taperTail', 'Taper Tail', 100),
		lp.number('flight', 'Flight Speed', 0.4, { min: -10, max: 10, softMin: 0, softMax: 3, step: 0.01 }),
		lp.color('coreColor', 'Core Colour', hex('#ffffff')),
		lp.color('edgeColor', 'Edge Colour', hex('#3d8bff')),
		lp.percent('coreWidth', 'Core Width', 25),
		lp.number('brightness', 'Brightness', 250, { min: 0, max: 400, step: 1 }, { unit: '%' }),
		lp.distance('halo', 'Halo', 40, { softMax: 200 }),
		lp.distance('chroma', 'Chromatic Split', 0, { softMax: 20 }),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG, GLSL_TLG_QUAD],
	front: true,
	color: { role: 'glow', mode: 'light' },
	presets: [
		{ id: 'anamorphic', label: 'Anamorphic', params: {} },
		{
			id: 'bundle',
			label: 'Light Bundle',
			params: {
				mode: 'bundle',
				center: [0.1, 0.1],
				angle: 25,
				spread: 30,
				count: 28,
				length: 300,
				lengthRandom: 50,
				thickness: 6,
				taperHead: 20,
				edgeColor: hex('#ff9a2e'),
				halo: 30,
			},
		},
		{
			id: 'spears',
			label: 'Spears',
			params: {
				mode: 'spears',
				center: [0.15, 0.5],
				spread: 8,
				count: 14,
				length: 220,
				lengthRandom: 50,
				thickness: 6,
				thicknessRandom: 50,
				taperTail: 60,
				flight: 1.2,
				edgeColor: hex('#ffb347'),
				brightness: 180,
			},
		},
		{
			id: 'cyan',
			label: 'Cyan Streak',
			params: {
				spread: 0,
				count: 3,
				length: 400,
				thickness: 6,
				edgeColor: hex('#00e1ff'),
				coreWidth: 20,
				brightness: 300,
				halo: 60,
				chroma: 1.5,
			},
		},
	],
	reach: reachOf,
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.flight) !== 0,
	summary: (p) => `${String(p.mode)}, ${Math.round(num(p.count))} streaks, ${pct(p.length)}`,
	prepass: (p, c) => [
		c.pass({
			output: 'tlGenA',
			format: 'rgba16f',
			draw: {
				vertices: 6,
				instances: Math.round(Math.min(MAX_STREAKS, Math.max(1, num(p.count)))),
				blend: 'add',
				vert: /* glsl */ `
flat out vec4 v_st;  // half thickness, length, intensity, flight fade (px)
out vec2 v_q;        // px across the axis, 0..1 tail to head
void main() {
  tlg_begin();
  int i = gl_InstanceID;
  float L = max(tl_px(u_length), 1.0);
  float T = max(tl_px(u_thickness), 0.1);
  float h1 = tlg_h(i, 1), h2 = tlg_h(i, 2), h3 = tlg_h(i, 3), h4 = tlg_h(i, 4), h5 = tlg_h(i, 5), h6 = tlg_h(i, 6);
  bool hero = u_mode == 0 && i == 0;
  float len = hero ? L : L * (1.0 - u_lengthRandom * 0.01 * h1);
  float thick = hero ? T : T * (1.0 - u_thicknessRandom * 0.01 * h2);
  float a = radians(u_angle) + (hero ? 0.0 : (h3 - 0.5) * radians(clamp(u_spread, 0.0, 360.0)));
  vec2 dir = vec2(cos(a), sin(a));
  float along, side = 0.0, intensity, fade = 1.0;
  float span = 0.9 * L;
  float phase = u_tlTime * u_flight * (0.7 + 0.6 * h6) + h4;
  if (u_mode == 0) {
    // Stacked tight around the hero, slightly shifted along, gliding to and fro as the lens moves.
    along = hero ? 0.0 : (h5 - 0.5) * 0.3 * len + sin(phase * FX_TAU) * 0.08 * L;
    side = hero ? 0.0 : (h4 - 0.5) * T * 4.0;
    intensity = hero ? 1.0 : 0.3 + 0.5 * h6;
  } else {
    // Bundle and spears fly out along their line, wrapping unseen: a streak fades in and out of its flight.
    float f = fract(phase);
    fade = smoothstep(0.0, 0.15, f) * (1.0 - smoothstep(0.75, 1.0, f));
    if (u_mode == 2) {
      along = span * f + 0.5 * len;
      side = (h5 - 0.5) * T * 4.0;
      intensity = 0.55 + 0.45 * h6;
    } else {
      along = 0.15 * L * h4 + span * 0.5 * f + 0.5 * len;
      intensity = 0.45 + 0.55 * h6;
    }
  }
  vec2 c = fx_canvasPxOfLayerNorm(u_center) + dir * along + vec2(-dir.y, dir.x) * side;
  float halo = tl_px(u_halo);
  float halfH = max(0.5 * thick, 0.5) + tl_px(u_chroma) + 3.0 * halo + 2.0;
  vec2 q = tlg_corner(gl_VertexID);
  float x = q.x * (0.5 * len + 1.0 + 1.5 * halo);
  v_st = vec4(0.5 * thick, len, intensity, fade);
  v_q = vec2(q.y * halfH, x / len + 0.5);
  fx_emit(c + dir * x + vec2(-dir.y, dir.x) * q.y * halfH);
}`,
			},
			frag: /* glsl */ `
flat in vec4 v_st;
in vec2 v_q;
float tlg_taper(float t, float tail, float head) {
  float w = 1.0;
  if (tail > 0.0) w = min(w, t / tail);
  if (head > 0.0) w = min(w, (1.0 - t) / head);
  return clamp(w, 0.0, 1.0);
}
vec3 tlg_at(float x, float hw, float halo, float k) {
  float q = clamp(1.0 - x * x / (hw * hw), 0.0, 1.0);
  float cw = hw * u_coreWidth * 0.01;
  float core = clamp(max(cw, 0.5) - x + 0.5, 0.0, 1.0) * min(1.0, 2.0 * cw);
  vec3 edge = tlg_rgb(u_edgeColor);
  float bloom = halo > 0.0 ? (0.5 * exp(-x / (0.25 * halo)) + 0.25 * exp(-x / halo)) : 0.0;
  return edge * (q * q + bloom) * k + tlg_rgb(u_coreColor) * 2.0 * core * k;
}
void main() {
  float s = v_q.y;
  float tail = u_taperTail * 0.01, head = u_taperHead * 0.01;
  float sum = tail + head;
  if (sum > 1.0) { tail /= sum; head /= sum; }
  float L = v_st.y;
  float tp = tlg_taper(clamp(s, 0.0, 1.0), tail, head);
  float hw0 = v_st.x * tp;
  float hw = max(hw0, 0.5);
  float halo = tl_px(u_halo) * sqrt(tp);
  float ends = clamp(s * L + 0.5, 0.0, 1.0) * clamp((1.0 - s) * L + 0.5, 0.0, 1.0);
  float k = v_st.z * v_st.w * (u_brightness * 0.01) * min(1.0, 2.0 * hw0) * sqrt(tp) * ends;
  float y = v_q.x;
  float split = tl_px(u_chroma);
  vec3 light = vec3(tlg_at(abs(y - split), hw, halo, k).r, tlg_at(abs(y), hw, halo, k).g, tlg_at(abs(y + split), hw, halo, k).b);
  fragColor = vec4(light, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));
}`,
		}),
	],
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) { return tlg_light(texture(u_tlGenA, s.uv).rgb); }`,
});
