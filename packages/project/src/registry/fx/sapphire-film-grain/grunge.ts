// Sapphire damage looks — S_Grunge (Sapphire Render): scatters "stamps" of grunge textures from up to three
// collections over the picture, concentrated in a soft frame border, with blinking, shake, emboss, blur and 18
// combine modes. Sapphire's stamps are bitmap collections; here each collection is a procedural pattern of the
// same name (a subset of Sapphire's list: the painted/illustrated bitmap collections are not reproduced).
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam } from '../params.ts';
import type { FxUniformValue, ShaderPass } from '../shader.ts';
import {
	check,
	clamp,
	color,
	grp,
	mixParam,
	num,
	rgb,
	sapphireSeed,
	slider,
	smoothNoise1,
} from './common.ts';
import { GLSL_FILM } from './glsl.ts';

/** Procedural stamp collections (Sapphire names, in Sapphire's order; index = GLSL style id). */
export const GRUNGE_STAMPS = [
	['none', 'None'],
	['plaster', 'Plaster'],
	['garageFloor', 'Garage Floor'],
	['speckles', 'Speckles'],
	['paintSpray', 'Paint Spray'],
	['paintSplatters', 'Paint Splatters'],
	['hairlineCracks', 'Hairline Cracks'],
	['tileCracks', 'Tile Cracks'],
	['pavementCracks', 'Pavement Cracks'],
	['hairs', 'Hairs'],
	['scratches', 'Scratches'],
	['frost', 'Frost'],
	['glassCracks', 'Glass Cracks'],
	['clouds', 'Clouds'],
	['smoke', 'Smoke'],
	['splotches', 'Splotches'],
	['corrosion', 'Corrosion'],
	['watercolorDrops', 'Watercolor Drops'],
	['dust', 'Dust'],
	['stains', 'Stains'],
	['flecks', 'Flecks'],
	['circles', 'Circles'],
	['geometricLines', 'Geometric Lines'],
	['moonDust', 'Moon Dust'],
	['sprayPaint', 'Spray Paint'],
	['inkDrops', 'Ink Drops'],
	['largeSponges', 'Large Sponges'],
] as const;
const STAMP_KEYS = GRUNGE_STAMPS.map((s) => s[0]);
const STAMP_LABELS = GRUNGE_STAMPS.map((s) => s[1]);

const GRUNGE_COMBINE = [
	['grungeOnly', 'Grunge Only'],
	['comp', 'Comp'],
	['mult', 'Mult'],
	['add', 'Add'],
	['screen', 'Screen'],
	['difference', 'Difference'],
	['subtract', 'Subtract'],
	['overlay', 'Overlay'],
	['hardLight', 'Hard Light'],
	['softLight', 'Soft Light'],
	['colorDodge', 'Color Dodge'],
	['colorBurn', 'Color Burn'],
	['darken', 'Darken'],
	['lighten', 'Lighten'],
	['exclusion', 'Exclusion'],
	['linearDodge', 'Linear Dodge'],
	['linearBurn', 'Linear Burn'],
	['linearLight', 'Linear Light'],
] as const;

/** GLSL of each stamp collection (statements setting the density `a` and colour mix `m` from d, r, id). */
const STAMP_CODE: Record<number, string> = {
	1: `a = smoothstep(0.35, 0.75, sgg_fbm(d * 3.0, id));`,
	2: `a = smoothstep(0.45, 0.8, sgg_fbm(d * 1.6, id)) * 0.8 + sgg_dots(d, 0.05, 0.25, id) * 0.6;`,
	3: `a = sgg_dots(d, 0.035, 0.45, id);`,
	4: `float k = true ? 0.9 : 0.6; a = sgg_dots(d, 0.025, k * (1.0 - r * r), id) + (1.0 - smoothstep(0.0, 0.7, r)) * 0.25 * k;`,
	5: `float blob = 1.0 - smoothstep(0.45, 0.55, r * (1.0 + 0.5 * (sgg_fbm(d * 2.5, id) - 0.5)));
    a = max(blob, sgg_dots(d, 0.12, 0.35 * smoothstep(0.3, 1.0, r), id ^ 0x77u));`,
	6: `a = sgg_ridge(d, 2.5, 0.6, id) * smoothstep(0.2, 0.6, sgg_n(d * 1.5, id ^ 0x5u));`,
	7: `vec2 g = abs(fract(d * 2.5 + 0.08 * sfd_noise2(d * 6.0, id)) - 0.5);
    a = (1.0 - smoothstep(0.0, 0.025, min(g.x, g.y))) * smoothstep(0.3, 0.6, sgg_n(d * 2.0, id ^ 0x3u));`,
	8: `a = max(sgg_ridge(d, 1.6, 1.2, id), sgg_ridge(d, 4.0, 0.7, id ^ 0x11u) * 0.6);`,
	9: `for (int i = 0; i < 4; i++) {
      vec4 h = sfd_u8(sfd_h(ivec3(i, 0, 5), id));
      float ang = h.x * 6.2831853;
      vec2 n = vec2(-sin(ang), cos(ang));
      float off = (h.y - 0.5) * 1.2;
      float bend = true ? (h.z - 0.5) * 2.0 * dot(d, vec2(cos(ang), sin(ang))) * dot(d, vec2(cos(ang), sin(ang))) : 0.0;
      float dist = abs(dot(d, n) - off - bend);
      a = max(a, 1.0 - smoothstep(0.004, 0.012 + 0.01 * h.w, dist));
    }
    a *= 1.0 - smoothstep(0.7, 1.0, r);`,
	10: `for (int i = 0; i < 4; i++) {
      vec4 h = sfd_u8(sfd_h(ivec3(i, 0, 5), id));
      float ang = h.x * 6.2831853;
      vec2 n = vec2(-sin(ang), cos(ang));
      float off = (h.y - 0.5) * 1.2;
      float bend = false ? (h.z - 0.5) * 2.0 * dot(d, vec2(cos(ang), sin(ang))) * dot(d, vec2(cos(ang), sin(ang))) : 0.0;
      float dist = abs(dot(d, n) - off - bend);
      a = max(a, 1.0 - smoothstep(0.004, 0.012 + 0.01 * h.w, dist));
    }
    a *= 1.0 - smoothstep(0.7, 1.0, r);`,
	11: `a = smoothstep(0.55, 0.85, 1.0 - abs(sfd_noise2(d * 7.0, id))) * sgg_n(d * 2.0, id ^ 0x2u);`,
	12: `float ang = atan(d.y, d.x);
    float k = floor(ang / 6.2831853 * 11.0);
    float w = abs(fract(ang / 6.2831853 * 11.0 + 0.04 * sfd_noise2(d * 8.0, id)) - 0.5);
    float h = sfd_u8(sfd_h(ivec3(int(k), 0, 7), id)).x;
    a = max((1.0 - smoothstep(0.0, 0.012 / max(r, 0.05), w)) * step(r, 0.4 + 0.6 * h), sgg_ridge(d, 3.0, 0.5, id) * step(r, 0.5));`,
	13: `a = smoothstep(0.35, 0.85, sgg_fbm(d * 1.5, id));`,
	14: `a = smoothstep(0.3, 0.9, sgg_fbm(vec2(d.x * 1.2, d.y * 2.4) + sgg_fbm(d * 2.0, id ^ 0x8u), id));`,
	15: `a = smoothstep(0.55, 0.62, sgg_fbm(d * 2.0, id)) * (0.6 + 0.4 * sgg_n(d * 6.0, id));`,
	16: `float f = sgg_fbm(d * 3.0, id); a = smoothstep(0.5, 0.56, f) * (0.5 + smoothstep(0.56, 0.7, f) * 0.5); m = f;`,
	17: `float rr = r * (1.0 + 0.15 * (sgg_n(d * 4.0, id) - 0.5));
    float rim = smoothstep(0.75, 0.9, rr) * (1.0 - smoothstep(0.9, 0.97, rr));
    a = true ? (1.0 - smoothstep(0.9, 0.97, rr)) * 0.35 + rim * 0.65 : 1.0 - smoothstep(0.85, 0.95, rr);`,
	18: `a = sgg_dots(d, true ? 0.06 : 0.03, true ? 0.2 : 0.5, id) + sgg_dots(d, 0.25, 0.08, id ^ 0x4u);`,
	19: `float rr = r * (1.0 + 0.25 * (sgg_fbm(d * 2.0, id) - 0.5));
    a = (1.0 - smoothstep(0.78, 0.86, rr)) * 0.25 + smoothstep(0.72, 0.8, rr) * (1.0 - smoothstep(0.8, 0.88, rr)) * 0.8;`,
	20: `a = smoothstep(0.62, 0.66, sgg_n(d * 9.0, id)) * step(0.4, sgg_n(d * 2.0, id ^ 0x6u));`,
	21: `a = 1.0 - smoothstep(0.0, 0.03, abs(fract(r * 3.0) - 0.5) * 2.0 - 0.9);`,
	22: `vec2 g = abs(fract(fx_rot(0.6) * d * 3.0) - 0.5);
    a = 1.0 - smoothstep(0.0, 0.02, min(g.x, g.y));`,
	23: `a = sgg_dots(d, false ? 0.06 : 0.03, false ? 0.2 : 0.5, id) + sgg_dots(d, 0.25, 0.08, id ^ 0x4u);`,
	24: `float k = false ? 0.9 : 0.6; a = sgg_dots(d, 0.025, k * (1.0 - r * r), id) + (1.0 - smoothstep(0.0, 0.7, r)) * 0.25 * k;`,
	25: `float rr = r * (1.0 + 0.15 * (sgg_n(d * 4.0, id) - 0.5));
    float rim = smoothstep(0.75, 0.9, rr) * (1.0 - smoothstep(0.9, 0.97, rr));
    a = false ? (1.0 - smoothstep(0.9, 0.97, rr)) * 0.35 + rim * 0.65 : 1.0 - smoothstep(0.85, 0.95, rr);`,
	26: `a = smoothstep(0.32, 0.36, fx_cellular(d * 4.0, 1.0, float(id & 65535u) / 65536.0).x) * 0.85;`,
};

// Only the pass's own collection is compiled (one program per collection keeps software GL fast).
const stampGlsl = (style: number) => /* glsl */ `
float sgg_n(vec2 p, uint id) { return sfd_noise2(p, id) * 0.5 + 0.5; }
float sgg_fbm(vec2 p, uint id) { return sgg_n(p, id) * 0.55 + sgg_n(p * 2.07, id ^ 0x68e31da4u) * 0.3 + sgg_n(p * 4.3, id ^ 0x1b56c4e9u) * 0.15; }
// Fine random dots: density 0..1 of dots of the cell size (in d units).
float sgg_dots(vec2 d, float cell, float density, uint id) {
  vec2 q = d / cell;
  vec4 h = sfd_u8(sfd_h(ivec3(ivec2(floor(q)), 0), id));
  float r = length(fract(q) - (0.25 + h.yz * 0.5)) / (0.15 + 0.3 * h.w);
  return step(h.x, density) * (1.0 - smoothstep(0.6, 1.0, r));
}
// Thin ridge lines where a noise field crosses its mid level.
float sgg_ridge(vec2 d, float freq, float width, uint id) {
  float v = sfd_noise2(d * freq, id);
  float g = fwidth(v) + 1.0e-4;
  return 1.0 - smoothstep(width * g * 6.0, width * g * 12.0, abs(v));
}
// A stamp pattern in its local coordinates d (unit disc), returns (density 0..1, colour mix 0..1).
vec2 sgg_pattern(vec2 d, uint id) {
  float r = length(d);
  float a = 0.0, m = sgg_n(d * 3.0, id ^ 0x9u);
  ${STAMP_CODE[style] ?? ''}
  return vec2(clamp(a, 0.0, 1.0), m);
}
`;

/** One stamp collection, composited over the previous collections (`first`: over nothing). */
const grungeLayer = (style: number, first: boolean) => /* glsl */ `${stampGlsl(style)}
// One stamp of cell cc over acc (helper with early returns: loops with 'continue' compile very slowly in
// SwiftShader).
vec4 sgg_stamp(vec2 p, ivec2 cc, uint s, float rad, vec4 acc) {
  uint h1 = sfd_h(ivec3(cc, 1), s);
  vec4 k = sfd_u8(fx_pcg(h1));
  if (k.x >= u_lDens) return acc;
  // blink: stamps come and go (Blink Coherence = how much they blink together)
  if (u_blinkAmount > 0.0) {
    float ph = u_time * u_blinkSpeed + (1.0 - u_blinkCoherence) * k.w * 13.0;
    if (sfd_u8(sfd_h(ivec3(cc, int(floor(ph))), s ^ 0xb1u)).x < u_blinkAmount) return acc;
  }
  vec2 centre = (vec2(cc) + sfd_u16(h1)) * u_lCell;
  float r = rad * max(0.2, 1.0 + u_lVaryS * (k.y * 2.0 - 1.0));
  vec2 d = (p - centre) / r;
  if (dot(d, d) > 1.0) return acc;
  float rot = k.z * 6.2831853;
  d = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * d;
  vec2 pat = sgg_pattern(d, fx_pcg(h1 ^ 0x2545f491u));
  float fade = 1.0 - smoothstep(1.0 - max(u_fadeSoftness, 1.0e-3), 1.0, length(d));
  float op = clamp(u_stampOpacity * u_lOpac * max(0.0, 1.0 + u_lVaryO * (k.w * 2.0 - 1.0)), 0.0, 1.0);
  float a = clamp(pat.x * fade * op, 0.0, 1.0);
  vec3 col = mix(u_lCol1, u_lCol2, pat.y);
  col *= u_stampBrightness * u_lBright * max(0.0, 1.0 + u_lVaryB * (fract(k.w * 7.0) * 2.0 - 1.0));
  return vec4(col * a, a) + acc * (1.0 - a);
}
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx() - (u_stampCenter - 0.5) * box - u_shakePx;
  vec4 acc = ${first ? 'vec4(0.0)' : 'texture(u_prev, v_uv)'};
  uint s = sfg_seedU(u_seed) ^ sfd_uu(int(u_lIndex) * 104729 + 17);
  float rad = max(u_lSize, 1.0);
  ivec2 c = ivec2(floor(p / u_lCell));
  for (int i = 0; i < 9; i++) acc = sgg_stamp(p, c + ivec2(i % 3 - 1, i / 3 - 1), s, rad, acc);
  fragColor = clamp(acc, 0.0, 1.0);
}`;

const grungeFinal = (tex: string) => /* glsl */ `
vec3 sgg_blend(int mode, vec3 b, vec3 t) {
  if (mode == 2) return b * t;
  if (mode == 3 || mode == 15) return b + t;
  if (mode == 4) return fx_blendRgb(FX_BLEND_SCREEN, b, t);
  if (mode == 5) return abs(b - t);
  if (mode == 6) return b - t;
  if (mode == 7) return fx_blendRgb(FX_BLEND_OVERLAY, b, t);
  if (mode == 8) return fx_blendRgb(FX_BLEND_HARD_LIGHT, b, t);
  if (mode == 9) return fx_blendRgb(FX_BLEND_SOFT_LIGHT, b, t);
  if (mode == 10) return fx_blendRgb(FX_BLEND_COLOR_DODGE, b, t);
  if (mode == 11) return fx_blendRgb(FX_BLEND_COLOR_BURN, b, t);
  if (mode == 12) return min(b, t);
  if (mode == 13) return max(b, t);
  if (mode == 14) return b + t - 2.0 * b * t;
  if (mode == 16) return b + t - 1.0;
  if (mode == 17) return b + 2.0 * t - 1.0;
  return t;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 g = texture(${tex}, v_uv);
  vec2 box = sfg_boxPx();
  // frame: grunge gathers towards the border of an ellipse
  vec2 fs = (sfg_sapph(fx_layerPx()) - sfg_sapph(u_frameCenter * box)) / vec2(max(u_frameRadius, 1.0e-3), max(u_frameRadius * u_frameRelHeight, 1.0e-3));
  float fm = smoothstep(1.0 - max(u_frameSoftness, 1.0e-3), 1.0, length(fs));
  if (u_invertFrame) fm = 1.0 - fm;
  g = clamp(g * mix(1.0, fm, clamp(u_frameAmount, 0.0, 1.0)) * (1.0 + u_frameAmount * fm * 0.6), 0.0, 1.0);
  // emboss: light the grunge as a relief (height = its coverage)
  if (u_embossBumpsScale > 0.0) {
    vec2 e = 1.5 / u_canvasSize;
    float hx = texture(${tex}, v_uv + vec2(e.x, 0.0)).a - texture(${tex}, v_uv - vec2(e.x, 0.0)).a;
    float hy = texture(${tex}, v_uv + vec2(0.0, e.y)).a - texture(${tex}, v_uv - vec2(0.0, e.y)).a;
    vec2 l = fx_dir(-u_embossLightAngle);
    float shade = clamp(1.0 + (-hx * l.x - hy * l.y) * u_embossBumpsScale * 6.0 + (u_embossThreshold - 0.5) * 0.2, 0.0, 2.0);
    g.rgb *= shade;
  }
  vec3 b = fx_unpremultiply(src).rgb * u_scaleBackground;
  vec3 t = g.a > 0.0 ? g.rgb / g.a : vec3(0.0);
  vec4 o;
  if (u_combine == 0) o = g;
  else {
    vec3 mixed = u_combine == 1 ? t : sgg_blend(u_combine, clamp(b, 0.0, 1.0), t);
    vec3 rgb = mix(b, mixed, g.a);
    float a = u_useBgAlpha ? src.a : max(src.a, g.a);
    // over a transparent background the grunge shows on its own
    rgb = src.a > 0.0 ? mix(t, rgb, src.a / max(a, 1.0e-4)) : t;
    o = vec4(clamp(rgb, 0.0, 1.0) * a, a);
  }
  fragColor = mix(o, src, clamp(u_mixWithOriginal, 0.0, 1.0));
}`;

function stampParams(
	i: 1 | 2 | 3,
	style: string,
	density: number,
	c1: [number, number, number],
	c2: [number, number, number],
) {
	const n = (s: string) => `stamp${i}${s}`;
	return grp(`Stamp${i}`, [
		fxParam.choice(`stamp${i}`, `Stamp${i}`, STAMP_KEYS, STAMP_LABELS, style),
		slider(n('RelDensity'), `Stamp${i} Rel Density`, density, 0, 10, { softMax: 3 }),
		color(n('Color1'), `Stamp${i} Color1`, c1),
		color(n('Color2'), `Stamp${i} Color2`, c2),
		slider(n('RelBrightness'), `Stamp${i} Rel Brightness`, 1, 0, 10, { softMax: 3 }),
		slider(n('RelOpacity'), `Stamp${i} Rel Opacity`, 1, 0, 10, { softMax: 2 }),
		slider(n('RelSize'), `Stamp${i} Rel Size`, 1, 0, 10, { softMax: 3 }),
		slider(`varyStamp${i}Brightness`, `Vary Stamp${i} Brightness`, 0, 0, 1),
		slider(`varyStamp${i}Opacity`, `Vary Stamp${i} Opacity`, 0.75, 0, 1),
		slider(`varyStamp${i}Size`, `Vary Stamp${i} Size`, 0.5, 0, 1),
	]);
}

const DEFAULT_COLORS: Record<number, [[number, number, number], [number, number, number]]> = {
	1: [
		[0.01, 0.01, 0.01],
		[0.3, 0.3, 0.3],
	],
	2: [
		[0.1, 0, 0],
		[0.2, 0.1, 0.05],
	],
	3: [
		[0, 0, 0],
		[0.25, 0.25, 0.25],
	],
};

/** The style index of stamp collection i (1..3), 0 = None. */
const grungeStyle = (p: EffectParams, i: number) =>
	Math.max(0, STAMP_KEYS.indexOf(String(p[`stamp${i}`]) as (typeof STAMP_KEYS)[number]));

/**
 * Pass uniforms of stamp collection i: stamp radius (layer px), cell size and the occupancy of a cell (one stamp per
 * cell, cells ≥ the stamp radius so a 3×3 neighbourhood finds every stamp covering a pixel), colours, variations.
 */
function grungeLayerUniforms(
	p: EffectParams,
	i: number,
	ctx: { width: number; height: number },
): Record<string, FxUniformValue> {
	const area = Math.max(1, ctx.width) * Math.max(1, ctx.height);
	const radius = Math.max(
		1,
		num(p.stampSize, 1) * num(p[`stamp${i}RelSize`], 1) * 0.05 * Math.max(1, ctx.width),
	);
	const count = Math.max(0, num(p.stampDensity, 500) * num(p[`stamp${i}RelDensity`], 1));
	const cell = Math.max(radius * 1.05, Math.sqrt(area / Math.max(count, 1e-3)));
	const d = DEFAULT_COLORS[i]!;
	return {
		u_lIndex: i,
		u_lSize: radius,
		u_lCell: cell,
		u_lDens: clamp((count * cell ** 2) / area, 0, 1),
		u_lOpac: num(p[`stamp${i}RelOpacity`], 1),
		u_lBright: num(p[`stamp${i}RelBrightness`], 1),
		u_lVaryB: num(p[`varyStamp${i}Brightness`], 0),
		u_lVaryO: num(p[`varyStamp${i}Opacity`], 0.75),
		u_lVaryS: num(p[`varyStamp${i}Size`], 0.5),
		u_lCol1: rgb(p[`stamp${i}Color1`], d[0]),
		u_lCol2: rgb(p[`stamp${i}Color2`], d[1]),
	};
}

const shakeParams: ParamSpec[] = grp('Shake', [
	slider('shakeAmplitude', 'Shake Amplitude', 0, 0, 10, { softMax: 2 }),
	slider('shakeAmplitudeRelX', 'Shake Amplitude Rel X', 1, 0, 10, { softMax: 3 }),
	slider('shakeAmplitudeRelY', 'Shake Amplitude Rel Y', 1, 0, 10, { softMax: 3 }),
	slider('shakeFrequency', 'Shake Frequency', 60, 0, 1000, { softMax: 120 }),
]);

export const S_GRUNGE = defineShaderEffect({
	id: 'jasper.s.grunge',
	label: 'S_Grunge',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.render,
	description:
		'Scatters stamps of grunge (plaster, garage floor, speckles, paint spray, cracks, stains, dust…) from up to three collections over the picture, gathered in a soft frame border, with blinking, shake, emboss, blur and 18 combine modes.',
	keywords: ['grunge', 'dirt', 'texture', 'stains', 'cracks', 'distressed', 'worn', 'overlay'],
	expensive: true,
	params: [
		...grp('Stamps', [
			slider('stampDensity', 'Stamp Density', 500, 0, 10000, { softMax: 2000, step: 1 }),
			slider('stampSize', 'Stamp Size', 1, 0, 20, { softMax: 4 }),
			slider('stampOpacity', 'Stamp Opacity', 0.8, 0, 1),
			slider('stampBrightness', 'Stamp Brightness', 1, 0, 10, { softMax: 3 }),
			fxParam.point('stampCenter', 'Stamp Center', [0.5, 0.5]),
			slider('fadeSoftness', 'Fade Softness', 0.3, 0, 1),
			sapphireSeed('Seed'),
		]),
		...grp('Blink', [
			slider('blinkAmount', 'Blink Amount', 0, 0, 1),
			slider('blinkCoherence', 'Blink Coherence', 0.5, 0, 1),
			slider('blinkSpeed', 'Blink Speed', 6, 0, 100, { softMax: 30 }),
		]),
		...grp('Frame', [
			slider('frameAmount', 'Frame Amount', 0.35, 0, 1),
			slider('frameSoftness', 'Frame Softness', 0.5, 0, 1),
			fxParam.point('frameCenter', 'Frame Center', [0.5, 0.5]),
			slider('frameRadius', 'Frame Radius', 1, 0, 10, { softMax: 3 }),
			slider('frameRelHeight', 'Frame Rel Height', 0.75, 0.1, 10, { softMax: 3 }),
			check('invertFrame', 'Invert Frame', false),
		]),
		...stampParams(1, 'garageFloor', 1, [0.01, 0.01, 0.01], [0.3, 0.3, 0.3]),
		...stampParams(2, 'paintSpray', 0.5, [0.1, 0, 0], [0.2, 0.1, 0.05]),
		...stampParams(3, 'none', 0.5, [0, 0, 0], [0.25, 0.25, 0.25]),
		...grp('Emboss', [
			slider('embossBumpsScale', 'Emboss Bumps Scale', 0.15, 0, 10, { softMax: 2 }),
			fxParam.angle('embossLightAngle', 'Emboss Light Angle', 135),
			slider('embossThreshold', 'Emboss Threshold', 0.5, -0.5, 1.5),
		]),
		...grp('Blur', [
			slider('blurGrunge', 'Blur Grunge', 0, 0, 10, { softMax: 1, step: 0.001 }),
			fxParam.vec2('blurGrungeRel', 'Blur Grunge Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		]),
		...shakeParams,
		fxParam.choice(
			'combine',
			'Combine',
			GRUNGE_COMBINE.map((c) => c[0]),
			GRUNGE_COMBINE.map((c) => c[1]),
			'comp',
		),
		check('useBgAlpha', 'Use Bg Alpha', false),
		slider('scaleBackground', 'Scale Background', 1, 0, 10, { softMax: 2 }),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const t = ctx.frame / Math.max(1, ctx.fps);
			const amp = num(p.shakeAmplitude) * 0.01 * ctx.width;
			const f = num(p.shakeFrequency, 60);
			return {
				u_shakePx: [
					amp * num(p.shakeAmplitudeRelX, 1) * smoothNoise1(ctx.seed, 71, t * f),
					amp * num(p.shakeAmplitudeRelY, 1) * smoothNoise1(ctx.seed, 72, t * f),
				],
			};
		},
		passes: (p, ctx) => {
			const active = [1, 2, 3].filter((i) => grungeStyle(p, i) > 0);
			const layers: ShaderPass[] = active.map((i, k) => ({
				output: k === active.length - 1 ? 'grunge' : `grunge${k}`,
				include: [GLSL_FILM, GLSL_UV],
				frag: grungeLayer(grungeStyle(p, i), k === 0),
				uniforms: grungeLayerUniforms(p, i, ctx),
			}));
			if (layers.length === 0)
				layers.push({ output: 'grunge', frag: 'void main() { fragColor = vec4(0.0); }' });
			const layer = layers;
			const blur = num(p.blurGrunge);
			if (blur <= 0)
				return [...layer, { include: [GLSL_FILM, GLSL_BLEND, GLSL_UV], frag: grungeFinal('u_grunge') }];
			const sigma = blur * 0.02 * ctx.width * ctx.pxScale;
			const rel = Array.isArray(p.blurGrungeRel) ? (p.blurGrungeRel as number[]) : [1, 1];
			const dirPass = (input: string, output: string, dir: [number, number], sg: number): ShaderPass => ({
				output,
				include: [GLSL_BLUR],
				frag: `void main() { fragColor = fx_gaussian1d(u_${input}, v_uv, u_gbDir, u_texel, u_gbSigma); }`,
				uniforms: { u_gbDir: dir, u_gbSigma: Math.max(0, sg) },
			});
			return [
				...layer,
				dirPass('grunge', 'grungeH', [1, 0], sigma * num(rel[0], 1)),
				dirPass('grungeH', 'grungeB', [0, 1], sigma * num(rel[1], 1)),
				{ include: [GLSL_FILM, GLSL_BLEND, GLSL_UV], frag: grungeFinal('u_grungeB') },
			];
		},
	},
});

export const GRUNGE_EFFECTS: readonly EffectSpec[] = [S_GRUNGE];
