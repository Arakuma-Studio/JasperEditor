// "Sapphire other stylize" family — S_ColorFuse: up to three LUTs combined (in order, each mixed by its strength),
// applied in a LUT colour space converted from the host colour space and back.
//
// Each LUT slot is a `.cube` LUT asset of the project (a 3D texture, `lutParam`), OR a 2D LUT image — a horizontal
// strip (N² × N, blue = tile) or a square Hald CLUT (L³ × L³, cube size L²), the two common PNG LUT exports — OR a
// built-in look (procedural "LUTs"), in that order of precedence. Transfer curves of the log spaces are approximate.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_LUT } from '../glsl/lut.ts';
import { fxParam, lutParam, sapphireCommonParams } from '../params.ts';
import type { GlslChunk } from '../shader.ts';
import { GLSL_SSO_COMMON, GLSL_SSO_MASK, maskParams, sNum } from './common.ts';

export const COLOR_FUSE_SPACES = [
	'linear',
	'srgb',
	'rec709',
	'rec2020',
	'rec1886',
	'slog1',
	'slog2',
	'slog3',
] as const;
const SPACE_LABELS = ['Linear', 'sRGB', 'Rec. 709', 'Rec. 2020', 'Rec. 1886', 'S-Log1', 'S-Log2', 'S-Log3'];

/** Built-in looks (option values in GLSL index order). */
export const COLOR_FUSE_LOOKS = [
	'none',
	'tealOrange',
	'bleachBypass',
	'crossProcess',
	'warmFilm',
	'coolNight',
	'sepia',
	'faded',
	'matrixGreen',
	'noir',
	'vintage',
] as const;
const LOOK_LABELS = [
	'None',
	'Teal & Orange',
	'Bleach Bypass',
	'Cross Process',
	'Warm Film',
	'Cool Night',
	'Sepia',
	'Faded',
	'Matrix Green',
	'Noir',
	'Vintage',
];

const GLSL_COLOR_FUSE: GlslChunk = {
	name: 'sapphire-stylize-other/color-fuse',
	deps: [GLSL_SSO_COMMON, GLSL_BLEND, GLSL_LUT],
	source: /* glsl */ `

vec3 cf_decode(int s, vec3 v) {
  if (s == 0) return v;
  if (s == 1) return fx_srgbToLinear(v);
  if (s == 2 || s == 3) return mix(v / 4.5, pow((max(v, 0.0) + 0.099) / 1.099, vec3(1.0 / 0.45)), step(vec3(0.081), v));
  if (s == 4) return pow(max(v, 0.0), vec3(2.4));
  if (s == 5) return (pow(vec3(10.0), (v - 0.616596 - 0.03) / 0.432699) - 0.037584);
  if (s == 6) return (pow(vec3(10.0), (v - 0.616596 - 0.03) / 0.432699) - 0.037584) * 219.0 / 155.0;
  // S-Log3
  return mix((v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0),
             pow(vec3(10.0), (v * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01, step(vec3(171.2102946929 / 1023.0), v));
}
vec3 cf_encode(int s, vec3 l) {
  if (s == 0) return l;
  if (s == 1) return fx_linearToSrgb(l);
  if (s == 2 || s == 3) { l = max(l, 0.0); return mix(l * 4.5, 1.099 * pow(l, vec3(0.45)) - 0.099, step(vec3(0.018), l)); }
  if (s == 4) return pow(max(l, 0.0), vec3(1.0 / 2.4));
  if (s == 5) return 0.432699 * log(max(l + 0.037584, 1e-6)) / log(10.0) + 0.616596 + 0.03;
  if (s == 6) return 0.432699 * log(max(l * 155.0 / 219.0 + 0.037584, 1e-6)) / log(10.0) + 0.616596 + 0.03;
  return mix((l * (171.2102946929 - 95.0) / 0.01125 + 95.0) / 1023.0,
             (420.0 + log(max((l + 0.01) / 0.19, 1e-6)) / log(10.0) * 261.5) / 1023.0, step(vec3(0.01125), l));
}
// Rec.709 <-> Rec.2020 primaries (linear light).
vec3 cf_toSpace(int s, vec3 lin709) {
  if (s == 3) lin709 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956) * lin709;
  return cf_encode(s, lin709);
}
vec3 cf_fromSpace(int s, vec3 v) {
  vec3 l = cf_decode(s, v);
  if (s == 3) l = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187) * l;
  return l;
}

vec3 cf_curve(vec3 c, float k) { return mix(c, c * c * (3.0 - 2.0 * c), k); }
vec3 cf_look(int id, vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float l = fx_luma(c);
  if (id == 1) { // teal & orange: teal shadows, orange highlights, a little contrast
    vec3 tone = mix(vec3(0.0, 0.42, 0.52), vec3(1.0, 0.58, 0.28), smoothstep(0.1, 0.8, l));
    c = fx_blendRgb(FX_BLEND_SOFT_LIGHT, cf_curve(c, 0.35), tone);
    return fx_saturate(c, 1.15);
  }
  if (id == 2) { // bleach bypass: luminance overlaid, half the saturation, harder contrast
    vec3 o = fx_blendRgb(FX_BLEND_OVERLAY, c, vec3(l));
    return cf_curve(fx_saturate(o, 0.45), 0.4);
  }
  if (id == 3) { // cross process: crushed red/green curves, lifted flat blue
    return vec3(cf_curve(c.rrr, 0.9).x, cf_curve(c.ggg, 0.5).x * 1.04, c.b * 0.55 + 0.22);
  }
  if (id == 4) { // warm film: lifted blacks, warm balance, soft shoulder
    c = c * vec3(1.06, 1.0, 0.86) + vec3(0.04, 0.03, 0.02);
    return cf_curve(1.0 - exp(-c * 1.6), 0.2) / (1.0 - exp(-1.6));
  }
  if (id == 5) { // cool night: blue tint, darker, desaturated
    return fx_saturate(c, 0.6) * vec3(0.72, 0.85, 1.12) * 0.85;
  }
  if (id == 6) { // sepia
    return vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  }
  if (id == 7) { // faded: lifted blacks, lowered whites, desaturated
    return fx_saturate(c, 0.7) * 0.78 + vec3(0.12, 0.11, 0.13);
  }
  if (id == 8) { // matrix green
    vec3 g = vec3(l * 0.55, l * 1.15, l * 0.5);
    return cf_curve(mix(c, g, 0.75), 0.35);
  }
  if (id == 9) { // noir: high-contrast black and white
    return vec3(cf_curve(vec3(clamp((l - 0.5) * 1.35 + 0.5, 0.0, 1.0)), 0.6).x);
  }
  if (id == 10) { // vintage: faded, magenta-warm highlights, green-ish shadows
    vec3 tone = mix(vec3(0.33, 0.45, 0.35), vec3(1.0, 0.8, 0.72), l);
    return fx_saturate(fx_blendRgb(FX_BLEND_SOFT_LIGHT, c, tone), 0.8) * 0.9 + 0.06;
  }
  return c;
}

vec3 cf_lutImage(sampler2D t, vec2 size, vec3 c) {
  c = clamp(c, 0.0, 1.0);
  if (abs(size.x - size.y * size.y) < 0.5) {
    float n = size.y;
    float bz = c.b * (n - 1.0);
    float b0 = floor(bz), b1 = min(b0 + 1.0, n - 1.0);
    float x = c.r * (n - 1.0) + 0.5, y = c.g * (n - 1.0) + 0.5;
    vec3 s0 = texture(t, vec2((b0 * n + x) / size.x, y / size.y)).rgb;
    vec3 s1 = texture(t, vec2((b1 * n + x) / size.x, y / size.y)).rgb;
    return mix(s0, s1, bz - b0);
  }
  if (abs(size.x - size.y) < 0.5) {
    float level = floor(pow(size.x, 1.0 / 3.0) + 0.5);
    float n = level * level;
    float gz = c.g * (n - 1.0), bz = c.b * (n - 1.0);
    float g0 = floor(gz), g1 = min(g0 + 1.0, n - 1.0), b0 = floor(bz), b1 = min(b0 + 1.0, n - 1.0);
    float r = c.r * (n - 1.0);
    vec3 acc[4];
    for (int k = 0; k < 4; k++) {
      float g = (k & 1) == 0 ? g0 : g1, b = (k & 2) == 0 ? b0 : b1;
      float i = g * n + b * n * n;                  // red runs along x inside one row run
      float row = floor(i / size.x), col = i - row * size.x;
      acc[k] = texture(t, vec2((col + r + 0.5) / size.x, (row + 0.5) / size.y)).rgb;
    }
    return mix(mix(acc[0], acc[1], gz - g0), mix(acc[2], acc[3], gz - g0), bz - b0);
  }
  return c;
}
`,
};

function slot(i: 1 | 2 | 3, look: (typeof COLOR_FUSE_LOOKS)[number], strength: number) {
	return [
		fxParam.choice(`lut${i}`, `Lut${i}`, COLOR_FUSE_LOOKS, LOOK_LABELS, look),
		fxParam.media(`lut${i}Image`, `Lut${i} Image (strip or Hald)`, ['image']),
		lutParam(`lut${i}File`, `Lut${i} File (.cube)`),
		sNum(`lut${i}Strength`, `Lut${i} Strength`, strength, { min: 0, max: 1 }),
	];
}

export const S_COLOR_FUSE: EffectSpec = defineShaderEffect({
	id: 'jasper.s.color-fuse',
	label: 'S_ColorFuse',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.stylize,
	description:
		'Combines up to three LUTs (.cube files, 2D LUT images — N²×N strips or Hald CLUTs — or built-in looks) for stylised looks, each mixed by its strength, in a LUT colour space converted from the host colour space.',
	keywords: ['lut', 'look', 'grade', 'teal orange', 'film look', 'color grading', 'colour grading'],
	params: [
		fxParam.choice('hostColorspace', 'Host Colorspace', COLOR_FUSE_SPACES, SPACE_LABELS, 'srgb'),
		fxParam.choice('lutColorspace', 'Lut Colorspace', COLOR_FUSE_SPACES, SPACE_LABELS, 'srgb'),
		...slot(1, 'tealOrange', 0.5),
		...slot(2, 'none', 1),
		...slot(3, 'none', 1),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_COLOR_FUSE, GLSL_SSO_MASK],
				frag: /* glsl */ `
vec3 cf_apply(vec3 c, int look, sampler2D img, vec2 imgSize, highp sampler3D cube, vec2 cubeSize, float strength) {
  vec3 l = cubeSize.x > 0.0 ? fx_lut3d(cube, cubeSize, c) : imgSize.x > 0.0 ? cf_lutImage(img, imgSize, c) : cf_look(look, c);
  return mix(c, l, clamp(strength, 0.0, 1.0));
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  c = cf_toSpace(u_lutColorspace, cf_fromSpace(u_hostColorspace, c));
  c = cf_apply(c, u_lut1, u_lut1Image, u_lut1Image_size, u_lut1File, u_lut1File_size, u_lut1Strength);
  c = cf_apply(c, u_lut2, u_lut2Image, u_lut2Image_size, u_lut2File, u_lut2File_size, u_lut2Strength);
  c = cf_apply(c, u_lut3, u_lut3Image, u_lut3Image_size, u_lut3File, u_lut3File_size, u_lut3Strength);
  c = cf_toSpace(u_hostColorspace, cf_fromSpace(u_lutColorspace, c));
  fragColor = sso_finish(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, -1.0);
}`,
			},
		],
	},
});
