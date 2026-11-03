// Shockwave (TL-061): concentric rings of light, after Pachislop's rings/shockwave.ts, driven by one Progress param.
// Pachislop draws a still, so its noise coordinates use the current radius; animated, that makes the texture swim as the
// ring grows. Here the texture reads a frozen Texture Radius: fibres and gaps keep their angle and scale with the ring.
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, type LayerParams, lp } from '../contract.ts';
import { GLSL_TLG, hex, num, pct, variationParam } from './shared.ts';

/** Most rings drawn (the shader loop's bound). */
const MAX_RINGS = 8;
const PROFILES = ['hard', 'soft', 'sine', 'double', 'fibrous'];

function reachOf(p: LayerParams): number {
	const R = Math.max(1, num(p.radius));
	const h = Math.max(0.25, num(p.ringWidth) / 2);
	const fibrous = p.profile === 'fibrous';
	const soft = Math.max(0, num(p.softOut)) * (fibrous ? 1.7 : 1);
	const smear = num(p.smear) > 0 ? 0.35 * R + h : 0;
	return R + Math.max((fibrous ? 1.5 : 1) * h + soft, smear) + Math.abs(num(p.split)) + 3;
}

export const GENERATOR_SHOCKWAVE = defineGenerator({
	id: 'shockwave',
	label: 'Shockwave',
	description: 'An expanding ring of light with one Progress control: hard, soft, ripple, double or fibrous.',
	keywords: ['ring', 'impact', 'blast', 'ripple', 'pulse'],
	params: [
		lp.point('center', 'Centre', [0.5, 0.5]),
		lp.number(
			'ringProgress',
			'Progress',
			70,
			{ min: 0, max: 100, step: 0.1 },
			{ unit: '%', ui: { control: 'slider' } },
		),
		lp.number('cycle', 'Loop Every', 0, { min: 0, max: 60, softMax: 5, step: 0.01 }, { unit: 's' }),
		lp.distance('radius', 'Radius', 190, { min: 1, softMax: 800 }),
		lp.distance('textureRadius', 'Texture Radius', 190, { min: 1, softMax: 800 }),
		lp.number('rings', 'Rings', 2, { min: 1, max: MAX_RINGS, step: 1 }),
		lp.distance('spacing', 'Ring Spacing', 30, { softMax: 200 }),
		lp.distance('ringWidth', 'Width', 12, { min: 0.5, softMax: 150 }),
		lp.choice(
			'profile',
			'Profile',
			PROFILES,
			['Hard', 'Soft', 'Sine Ripple', 'Double Rim', 'Fibrous'],
			'soft',
		),
		lp.distance('softIn', 'Inner Softness', 15, { softMax: 200 }),
		lp.distance('softOut', 'Outer Softness', 3, { softMax: 200 }),
		lp.percent('squash', 'Squash', 100, { range: { min: 5 } }),
		lp.angle('tilt', 'Tilt', 0),
		lp.percent('breakup', 'Breakup', 25),
		lp.distance('breakupScale', 'Breakup Scale', 20, { min: 1, softMax: 200 }),
		lp.percent('smear', 'Radial Smear', 0),
		lp.distance('split', 'Chromatic Split', 0, { softMax: 30 }),
		lp.number('flash', 'Core Flash', 15, { min: 0, max: 200, step: 1 }, { unit: '%' }),
		lp.color('innerColor', 'Inner Colour', hex('#ffffff')),
		lp.color('outerColor', 'Outer Colour', hex('#d8ecff')),
		variationParam(),
	],
	include: [GLSL_UV, GLSL_TLG],
	color: { role: 'glow', mode: 'light' },
	presets: [
		{
			id: 'white',
			label: 'White Shockwave',
			params: { spacing: 23, ringWidth: 7, softIn: 25, softOut: 1, breakup: 6, split: 2, flash: 0 },
		},
		{
			id: 'red',
			label: 'Red Blast',
			params: {
				rings: 1,
				ringWidth: 25,
				profile: 'fibrous',
				softIn: 20,
				softOut: 7,
				breakup: 20,
				breakupScale: 25,
				smear: 60,
				flash: 80,
				innerColor: hex('#fff4f0'),
				outerColor: hex('#ff1830'),
			},
		},
		{
			id: 'pulse',
			label: 'Looping Pulse',
			params: {
				cycle: 1.6,
				radius: 210,
				rings: 3,
				spacing: 27,
				ringWidth: 3.5,
				profile: 'hard',
				softIn: 5,
				softOut: 5,
				breakup: 0,
				flash: 0,
				innerColor: hex('#ff6ec8'),
				outerColor: hex('#ff1e5a'),
			},
		},
		{
			id: 'ground',
			label: 'Ground Shockwave',
			params: {
				radius: 260,
				spacing: 45,
				ringWidth: 18,
				profile: 'fibrous',
				softIn: 25,
				softOut: 5,
				squash: 28,
				tilt: 6,
				smear: 50,
				innerColor: hex('#fff2d0'),
				outerColor: hex('#ff8a30'),
			},
		},
	],
	reach: reachOf,
	fieldReach: () => ({ outside: 1 }),
	timeDependent: (p) => num(p.cycle) > 0,
	summary: (p) => `${String(p.profile)}, ${pct(p.radius)}`,
	glsl: /* glsl */ `
const float TLG_PI = 3.14159265;
float tlg_profile(float u) {
  if (u_profile == 1) return 1.0 - 0.6 * u * u;
  if (u_profile == 2) return (0.55 + 0.45 * cos(2.0 * TLG_PI * u)) * (1.0 - 0.25 * u * u);
  if (u_profile == 3) return smoothstep(0.35, 0.65, abs(u));
  return 1.0;
}
// One band at signed distance d (> 0 outward), half widths and soft tails either side.
float tlg_band(float d, float hIn, float hOut, float sIn, float sOut, float aa) {
  bool inner = d < 0.0;
  float u = d / (inner ? hIn : hOut);
  float e = abs(d) - (inner ? hIn : hOut);
  float soft = inner ? sIn : sOut;
  float cov = clamp(0.5 - e / aa, 0.0, 1.0);
  float tail = e <= 0.0 ? 1.0 : (soft > 0.0 ? pow(max(1.0 - e / soft, 0.0), 3.0) : 0.0);
  return tlg_profile(clamp(u, -1.0, 1.0)) * max(cov, tail);
}
vec4 tl_generate(TlSurface s) {
  tlg_begin();
  float progress = clamp(u_ringProgress * 0.01, 0.0, 1.0);
  if (u_cycle > 0.0) progress = fract(progress + u_tlTime / u_cycle);
  // The ring leaves fast and slows, and is gone when Progress ends.
  float eased = 1.0 - (1.0 - progress) * (1.0 - progress);
  float gone = 1.0 - smoothstep(0.75, 1.0, progress);
  float R = tl_px(u_radius) * eased;
  float R0 = max(tl_px(u_textureRadius), 1.0);
  float half0 = max(tl_px(u_ringWidth) * 0.5, 0.5);
  float softIn = tl_px(u_softIn), softOut = tl_px(u_softOut);
  float spacing = tl_px(u_spacing);
  // Pachislop's 2 + 0.12 × width was in comp px: here every part of it is in the unit, so the fibres are the same at any size.
  float fibre = tl_px(1.0) + 0.12 * tl_px(u_ringWidth);
  float breakScale = max(tl_px(u_breakupScale), 1.0);
  vec2 p = s.px - fx_uvOfLayerNorm(u_center) * u_canvasSize;
  vec2 axis = fx_dir(u_tilt);
  vec2 q = vec2(axis.x * p.x + axis.y * p.y, -axis.y * p.x + axis.x * p.y);
  q.y /= clamp(u_squash * 0.01, 0.05, 1.0);
  float r = length(q);
  vec2 dir = r > 1.0e-4 ? q / r : vec2(1.0, 0.0);
  float aa = max(fwidth(r), 1.0e-4);
  float split = tl_px(u_split);
  vec3 rc = r - vec3(split, 0.0, -split);
  vec3 rings = vec3(0.0);
  int count = int(clamp(floor(u_rings + 0.5), 1.0, ${MAX_RINGS}.0));
  for (int i = 0; i < count; i++) {
    float Ri = R - float(i) * spacing;
    if (Ri <= 0.0) break;
    float hIn = half0, hOut = half0, sIn = softIn, sOut = softOut;
    float gain = pow(0.72, float(i));
    if (u_profile == 4) {
      // Fibres: noise on a circle of the frozen radius, so they keep their angle as the ring grows.
      vec2 fq = dir * ((R0 - float(i) * spacing) / fibre) + vec2(float(i) * 13.1);
      float f1 = tlg_vnoise(fq), f2 = tlg_vnoise(fq * 1.7 + 41.0), f3 = tlg_vnoise(fq * 3.1 + 77.0);
      hIn *= 0.35 + 1.3 * f1;
      hOut *= 0.5 + f2;
      sIn *= 0.3 + 1.4 * f1;
      sOut *= 0.3 + 1.4 * f2;
      gain *= 0.4 + 0.6 * f3;
    }
    vec3 d = rc - Ri;
    rings += gain * vec3(tlg_band(d.r, hIn, hOut, sIn, sOut, aa),
                         tlg_band(d.g, hIn, hOut, sIn, sOut, aa),
                         tlg_band(d.b, hIn, hOut, sIn, sOut, aa));
  }
  float brk = u_breakup * 0.01;
  if (brk > 0.0) {
    // Gaps across the rings, on the frozen circle plus a little that travels with the ring.
    float n = 0.7 * tlg_fbm(dir * (R0 / breakScale)) + 0.3 * tlg_vnoise(q / max(R, 1.0) * R0 / (0.5 * breakScale) + 19.0);
    float c = mix(0.18, 0.72, brk);
    rings *= smoothstep(c - 0.12, c + 0.12, n);
  }
  vec3 inner = tlg_rgb(u_innerColor), outer = tlg_rgb(u_outerColor);
  float innermost = max(0.0, R - float(count - 1) * spacing - half0 - softIn);
  vec3 t = smoothstep(vec3(innermost), vec3(max(innermost + 1.0, R)), rc);
  vec3 light = rings * mix(inner, outer, t);
  float smear = u_smear * 0.01;
  if (smear > 0.0) {
    // Streaks of the ring colour thrown inward from the leading ring and outward past it, each to its own length.
    vec2 sq = dir * (R0 / max(1.5 * fibre, 1.0)) + 211.0;
    float n = 0.6 * tlg_vnoise(sq) + 0.4 * tlg_vnoise(sq * 2.3 + 5.0);
    n = n * n * n * 2.5;
    float reach = (0.1 + 0.25 * tlg_vnoise(sq * 0.7 + 63.0)) * R + half0;
    float din = R - r;
    float fall = din > 0.0 ? exp(-din / max(0.22 * R, 1.0)) : pow(1.0 - smoothstep(0.0, reach, -din), 2.0);
    fall *= smoothstep(0.0, 0.3 * R + 1.0, r);
    light += smear * 0.6 * n * fall * outer;
  }
  float rr = r / max(R, 1.0);
  light += (u_flash * 0.01) * (1.0 - progress) * (exp(-40.0 * rr * rr) + 0.1 * exp(-6.0 * rr * rr)) * inner;
  return tlg_light(light * gone);
}`,
});
