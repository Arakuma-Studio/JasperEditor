// Sapphire Emboss (Stylize): S_Emboss, S_EmbossShiny, S_EmbossDistort, S_EmbossGlass. The luminance of the Bumps
// input (default: the source itself) is a relief map: thresholded, scaled and smoothed (Bumps Smooth, Sapphire units),
// lit from Light Dir (a y-up vector; its length lowers the light), optionally with specular highlights, a lens
// distortion through the relief (Distort Amount) and a prismatic split of that distortion (Warp Red → Warp Blue).
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam, mixWithOriginalParam } from '../params.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';
import {
	blurPasses,
	filterParam,
	num,
	PKE_COMMON,
	PKE_SOBEL,
	rgbParam,
	sNum,
	sUnitsPx,
	wrapParam,
	xyParam,
} from './common.ts';

/** Relief depth: surface slope per unit of (bumps luma × Bumps Scale) per pixel. */
export const EMBOSS_DEPTH = 10;

const bin = SAPPHIRE_BINS.stylize;

function bumpParams(smooth: number): ParamSpec[] {
	return [
		fxParam.media('bumps', 'Bumps', ['image', 'video']),
		xyParam('lightDir', 'Light Dir', [-0.5, 0.361]),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		rgbParam('lightColor', 'Light Color', [1, 1, 1]),
		sNum('bumpsScale', 'Bumps Scale', 1, { softMin: -4, softMax: 4, step: 0.01 }),
		sNum('bumpsThreshold', 'Bumps Threshold', 0, { min: 0, softMax: 1 }),
		sNum('bumpsSmooth', 'Bumps Smooth', smooth, { min: 0, softMax: 1 }),
		fxParam.toggle('subpixelSmooth', 'Subpixel Smooth', true),
	];
}

const hilightParams = (brightness: number): ParamSpec[] => [
	sNum('hilightBrightness', 'Hilight Brightness', brightness, { min: 0, max: 1, step: 0.01 }),
	sNum('hilightSize', 'Hilight Size', 0.5, { min: 0.1, softMax: 2, step: 0.01 }),
];

const distortParams = (): ParamSpec[] => [
	sNum('distortAmount', 'Distort Amount', 1, { softMin: -4, softMax: 4, step: 0.01 }),
	filterParam(true),
	wrapParam('wrapX', 'Wrap X', 'reflect'),
	wrapParam('wrapY', 'Wrap Y', 'reflect'),
];

function smoothSigma(p: EffectParams, ctx: Pick<FxPlanContext, 'width' | 'pxScale'>) {
	const s = sUnitsPx(p.bumpsSmooth, ctx);
	return p.subpixelSmooth === false ? Math.round(s) : s;
}

/** Height map (bumps luma − threshold) and its smoothing. Output: `height` (r = height). */
function heightPasses(p: EffectParams, ctx: FxPlanContext): ShaderPass[] {
	return [
		{
			output: 'relief',
			format: 'rgba16f',
			include: [GLSL_COMPOSITE],
			frag: /* glsl */ `
void main() {
  float l;
  if (u_bumps_size.x > 0.0) {
    vec2 n = fx_layerNorm();
    vec4 b = texture(u_bumps, clamp(n, 0.0, 1.0));
    l = fx_luma(b.rgb) * (fx_inBox(v_uv) ? 1.0 : 0.0);
  } else {
    l = fx_luma(texture(u_source, v_uv).rgb);
  }
  fragColor = vec4(max(l - u_bumpsThreshold, 0.0), 0.0, 0.0, 1.0);
}`,
		},
		...blurPasses('relief', 'height', smoothSigma(p, ctx), 'rgba16f'),
	];
}

/** Shared lighting GLSL (needs u_height, u_lightDir, u_bumpsScale; specular when hilight params exist). */
const EMBOSS_LIGHT: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/emboss',
	deps: [PKE_SOBEL, PKE_COMMON],
	source: /* glsl */ `
// Surface slope (screen, y down) of the smoothed relief, in height per pixel × depth.
vec2 emb_slope() { return pke_sobelR(u_height, v_uv, u_texel) * u_bumpsScale * ${EMBOSS_DEPTH.toFixed(1)}; }
vec3 emb_normal(vec2 slope) { return normalize(vec3(-slope, 1.0)); }
vec3 emb_light() { return normalize(vec3(u_lightDir.x, -u_lightDir.y, 1.0)); }
// Lambert shading normalised so a flat surface keeps the picture's brightness.
float emb_diffuse(vec3 n, vec3 l) { return max(dot(n, l), 0.0) / max(l.z, 1.0e-3); }
// Blinn-Phong highlight above the flat-surface level (flat areas stay unlit).
float emb_specular(vec3 n, vec3 l, float size) {
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float e = 8.0 / max(size * size, 0.01);
  float flat0 = pow(h.z, e);
  return max(pow(max(dot(n, h), 0.0), e) - flat0, 0.0) / max(1.0 - flat0, 1.0e-3);
}
`,
};

export const S_EMBOSS = defineShaderEffect({
	id: 'jasper.s.emboss',
	label: 'S_Emboss',
	category: 'Stylize',
	bin,
	description:
		'Embosses the clip using the brightness of the Bumps input (default: the clip itself) as a relief map, lit from Light Dir.',
	keywords: ['emboss', 'relief', 'bump', 'light', 'sapphire'],
	params: [...bumpParams(0), mixWithOriginalParam()],
	gpu: {
		passes: (p, ctx) => [
			...heightPasses(p, ctx),
			{
				include: [EMBOSS_LIGHT, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 n = emb_normal(emb_slope());
  float d = emb_diffuse(n, emb_light());
  vec4 res = vec4(src.rgb * d * u_lightColor.rgb * u_brightness, src.a);
  res.rgb = min(res.rgb, vec3(res.a));
  fragColor = fx_mixOriginal(res, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_EMBOSS_SHINY = defineShaderEffect({
	id: 'jasper.s.emboss-shiny',
	label: 'S_EmbossShiny',
	category: 'Stylize',
	bin,
	description:
		'Embosses the clip with a lighting model that adds specular highlights, for a shiny raised-metal look.',
	keywords: ['emboss', 'shiny', 'specular', 'metal', 'relief', 'sapphire'],
	params: [...bumpParams(0.01), ...hilightParams(0.8), mixWithOriginalParam()],
	gpu: {
		passes: (p, ctx) => [
			...heightPasses(p, ctx),
			{
				include: [EMBOSS_LIGHT, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 n = emb_normal(emb_slope());
  vec3 l = emb_light();
  vec3 light = u_lightColor.rgb * u_brightness;
  vec3 c = src.rgb * emb_diffuse(n, l) * light + emb_specular(n, l, u_hilightSize) * u_hilightBrightness * light * src.a;
  vec4 res = vec4(min(c, vec3(src.a)), src.a);
  fragColor = fx_mixOriginal(res, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

/** GLSL of the warped (lens) lookup through the relief, with optional 4× supersampling (Filter). */
const WARP_GLSL = /* glsl */ `
vec4 emb_warped(vec2 slope, float amount) {
  vec2 offPx = -slope * amount * pke_unit() * 2.0;
  vec2 n = fx_layerNorm() + offPx / u_box.zw;
  ivec2 m = ivec2(u_wrapX, u_wrapY);
  if (!u_filter) return pke_sampleWrap(u_source, n, m);
  vec2 t = 0.35 / u_box.zw;
  return 0.25 * (pke_sampleWrap(u_source, n + vec2(-t.x, -t.y), m) + pke_sampleWrap(u_source, n + vec2(t.x, -t.y), m)
               + pke_sampleWrap(u_source, n + vec2(-t.x, t.y), m) + pke_sampleWrap(u_source, n + vec2(t.x, t.y), m));
}
`;

export const S_EMBOSS_DISTORT = defineShaderEffect({
	id: 'jasper.s.emboss-distort',
	label: 'S_EmbossDistort',
	category: 'Stylize',
	bin,
	description:
		'Embosses the clip and warps it through the relief as through a lens (Distort Amount), with specular highlights.',
	keywords: ['emboss', 'distort', 'lens', 'refraction', 'relief', 'sapphire'],
	params: [...bumpParams(0.1), ...hilightParams(0.5), ...distortParams(), mixWithOriginalParam()],
	gpu: {
		passes: (p, ctx) => [
			...heightPasses(p, ctx),
			{
				include: [EMBOSS_LIGHT, GLSL_COMPOSITE],
				frag: /* glsl */ `
${WARP_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 slope = emb_slope();
  vec4 w = emb_warped(slope, u_distortAmount);
  vec3 n = emb_normal(slope);
  vec3 l = emb_light();
  vec3 light = u_lightColor.rgb * u_brightness;
  vec3 c = w.rgb * emb_diffuse(n, l) * light + emb_specular(n, l, u_hilightSize) * u_hilightBrightness * light * w.a;
  vec4 res = vec4(min(c, vec3(w.a)), w.a);
  fragColor = fx_mixOriginal(res, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

/** Most spectrum samples of S_EmbossGlass (Sapphire allows 100; more look the same). */
export const GLASS_MAX_STEPS = 32;

export const S_EMBOSS_GLASS = defineShaderEffect({
	id: 'jasper.s.emboss-glass',
	label: 'S_EmbossGlass',
	category: 'Stylize',
	bin,
	description:
		'Embosses and warps the clip through the relief like glass, splitting the distortion into a prismatic spectrum (Warp Red → Warp Blue).',
	keywords: ['emboss', 'glass', 'prism', 'chromatic', 'refraction', 'sapphire'],
	expensive: true,
	params: [
		...bumpParams(0.1),
		...hilightParams(0.5),
		...distortParams(),
		sNum('warpRed', 'Warp Red', 0.5, { softMin: -4, softMax: 4, step: 0.01 }),
		sNum('warpBlue', 'Warp Blue', 1, { softMin: -4, softMax: 4, step: 0.01 }),
		fxParam.number('steps', 'Steps', 5, { min: 3, max: 100, softMax: 32, step: 1 }),
		mixWithOriginalParam(),
	],
	gpu: {
		uniforms: (p) => ({ u_stepCount: { int: Math.round(Math.min(GLASS_MAX_STEPS, Math.max(3, num(p.steps, 5)))) } }),
		passes: (p, ctx) => [
			...heightPasses(p, ctx),
			{
				include: [EMBOSS_LIGHT, GLSL_COMPOSITE],
				frag: /* glsl */ `
${WARP_GLSL}
// Spectrum weight of sample t (0 = red end, 1 = blue end).
vec3 spectrum(float t) { return clamp(vec3(1.5 - 3.0 * t, 1.5 - abs(6.0 * t - 3.0), 3.0 * t - 1.5), 0.0, 1.0) + vec3(0.02); }
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 slope = emb_slope();
  vec4 sum = vec4(0.0);
  vec3 wsum = vec3(0.0);
  for (int i = 0; i < ${GLASS_MAX_STEPS}; i++) {
    if (i >= u_stepCount) break;
    float t = float(i) / float(u_stepCount - 1);
    vec3 w = spectrum(t);
    vec4 s = emb_warped(slope, mix(u_warpRed, u_warpBlue, t) * u_distortAmount);
    sum += vec4(s.rgb * w, s.a * (w.r + w.g + w.b) / 3.0);
    wsum += w;
  }
  vec4 g = vec4(sum.rgb / wsum, sum.a / ((wsum.r + wsum.g + wsum.b) / 3.0));
  vec3 n = emb_normal(slope);
  vec3 l = emb_light();
  vec3 light = u_lightColor.rgb * u_brightness;
  vec3 c = g.rgb * emb_diffuse(n, l) * light + emb_specular(n, l, u_hilightSize) * u_hilightBrightness * light * g.a;
  vec4 res = vec4(min(c, vec3(g.a)), g.a);
  fragColor = fx_mixOriginal(res, src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const EMBOSS_EFFECTS: readonly EffectSpec[] = [S_EMBOSS, S_EMBOSS_SHINY, S_EMBOSS_DISTORT, S_EMBOSS_GLASS];
