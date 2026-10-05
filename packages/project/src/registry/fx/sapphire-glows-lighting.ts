// Effect family "sapphire-glows-lighting" (fx catalogue, wave 2). Sapphire-style glows and lighting: glows, lens flares, rays, glints, light leaks.
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.glows / SAPPHIRE_BINS.lighting.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
//
// Clean-room implementations after Boris FX's public Sapphire documentation (parameter names, order, defaults and
// behaviour); all maths and shaders are our own. Family-private helpers live in ./sapphire-glows-lighting/:
//   glow.ts      multi-scale glow cascade (wide glows at 1/2…1/32 resolution), per-channel level weights, sgl/core
//   distance.ts  jump-flood distance field (distance-based glows)
//   streak.ts    two-stage comb filters for long thin streaks / glints and radial rays
//   flare.ts     lens-flare element model + built-in lenses
//   track.ts     deterministic bright-spot tracker (reduction passes) for S_LensFlareAutoTrack
//   common.ts    Sapphire units/points, the shared light-effect tail params and their finishing GLSL
// Sapphire places every one of these in its "Sapphire Lighting" submenu (Premiere and AE); `SGL_BIN` below.
// Sapphire units: widths/sizes are fractions of the layer width ×10 (`unitPx`); points are layer-normalised.
import type { EffectParams, EffectSpec, ParamSpec } from '../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from './define.ts';
import { GLSL_COLOR } from './glsl/color.ts';
import { GLSL_HASH } from './glsl/hash.ts';
import { GLSL_NOISE } from './glsl/noise.ts';
import { fxParam } from './params.ts';
import type { FxPlanContext, ShaderPass } from './shader.ts';
import {
	atmosphereParams,
	COMBINE_GLOW,
	combineChoice,
	combineMode,
	GLSL_SGL_FINISH,
	lightTail,
	sapphirePoint,
	showChoice,
	slider,
	unitPx,
} from './sapphire-glows-lighting/common.ts';
import { GLSL_SGL_DISTANCE, jfaPasses } from './sapphire-glows-lighting/distance.ts';
import {
	brightDownscale,
	channelWeights,
	clamp,
	GLSL_SGL_CORE,
	glowCascade,
	glowSumGlsl,
	levelSumGlsl,
	levelWeights,
	num,
} from './sapphire-glows-lighting/glow.ts';
import { rayPasses, rayUniforms } from './sapphire-glows-lighting/streak.ts';
import { FLARE_LENSES, flareChunk, lensOf } from './sapphire-glows-lighting/flare.ts';
import { trackPasses } from './sapphire-glows-lighting/track.ts';

/** Every effect of the family is in Sapphire's "Sapphire Lighting" submenu (Boris FX docs, Premiere and AE). */
const SGL_BIN = SAPPHIRE_BINS.lighting;

/** Cascade levels of the glows (octaves of width below the widest). */
const LEVELS = 5;
/** Gaussian sigma of the widest glow level per Sapphire width unit (calibrated by eye against Sapphire's look). */
const K_GLOW = 0.8;
/** Base glow profile: energy per octave grows slightly with width (a bright core plus a long visible tail). */
const GLOW_SLOPE = 0.7;
/** Overall glow gain (Brightness 1 ≈ Sapphire's). */
const GLOW_GAIN = 1.3;

const vec3Of = (v: unknown, d: [number, number, number]): [number, number, number] =>
	Array.isArray(v) && v.length >= 3 ? [num(v[0]), num(v[1]), num(v[2])] : d;
const white: [number, number, number, number] = [1, 1, 1, 1];
const black: [number, number, number, number] = [0, 0, 0, 1];

/** Sigma (canvas px) of a Sapphire glow width. */
const glowSigma = (width: unknown, ctx: FxPlanContext) => Math.max(0, num(width)) * K_GLOW * unitPx(ctx.width) * ctx.pxScale;

/** Expand Borders (Sapphire, default off there): here default ON, since editor layers are often tighter than the
 * frame (titles, shapes) and a glow clipped at the layer box looks broken. Off = clip to the box (Edge Mode). */
const expandBorders = () => fxParam.toggle('expandBorders', 'Expand Borders', true);

/** `u_mode` (SGL_COMBINE index) + per-channel cascade weights. */
function glowUniforms(
	p: EffectParams,
	mult: [number, number, number],
	slope = GLOW_SLOPE,
	labels: readonly string[] = COMBINE_GLOW,
	def = 'Screen',
	levels = LEVELS,
) {
	return { u_mode: combineMode(p.combine, labels, def), ...channelWeights(levels, slope, mult, GLOW_GAIN) };
}

const rgbMult = (p: EffectParams, r = 'widthRed', g = 'widthGreen', b = 'widthBlue'): [number, number, number] => [
	Math.max(0, num(p[r], 1)),
	Math.max(0, num(p[g], 1)),
	Math.max(0, num(p[b], 1)),
];

/**
 * A glow: `bright` pass (effect-specific GLSL writing the light source, premultiplied, at 1/dB resolution; it may
 * use `u_dB` and `sgl_srcRead`) → cascade (`g0…g4`) → the effect's final pass. sigma = widest level (canvas px).
 */
function glowPasses(
	brightFrag: string,
	sigma: number,
	wx: number,
	wy: number,
	finalPass: (levels: string[]) => ShaderPass,
	brightInclude: ShaderPass['include'] = [],
	extra: ShaderPass[] = [],
	levels = LEVELS,
): ShaderPass[] {
	const sx = sigma * Math.max(0, wx);
	const sy = sigma * Math.max(0, wy);
	const dB = brightDownscale(Math.min(sx, sy) || Math.max(sx, sy), levels);
	const c = glowCascade({ input: 'bright', prefix: 'g', sigmaX: sx, sigmaY: sy, levels, inputDown: dB });
	return [
		{
			output: 'bright',
			scale: 1 / dB,
			format: 'rgba16f',
			include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, ...(brightInclude ?? [])],
			uniforms: { u_dB: dB },
			frag: brightFrag,
		},
		...c.passes,
		...extra,
		finalPass(c.levels),
	];
}

/** Padding of a glow: ~3 sigma of its widest channel/axis (layer px). */
const glowPadding = (p: EffectParams, ctx: FxPlanContext, width: unknown, mult = 1) =>
	3 * num(width) * K_GLOW * unitPx(ctx.width) * Math.max(num(p.widthX, 1), num(p.widthY, 1)) * mult;

/** The usual Sapphire threshold source (bright pass body): `fromAlpha`, `threshold`, `thresholdAddColor`. */
const THRESHOLD_SOURCE = /* glsl */ `
vec4 sgl_thresholdSource(vec4 s) {
  vec3 c = mix(s.rgb, vec3(s.a), clamp(u_fromAlpha, 0.0, 1.0));
  return vec4(sgl_threshold(c, u_threshold, u_thresholdAddColor.rgb), s.a);
}`;

const BRIGHT_STANDARD = /* glsl */ `${THRESHOLD_SOURCE}
void main() {
  vec4 s = sgl_srcRead(u_dB, u_expandBorders ? 0 : u_edgeMode);
  vec4 b = sgl_thresholdSource(s);
  fragColor = vec4(b.rgb, sgl_maxc(b.rgb));
}`;

/** The finishing lines of a glow's final pass: `light` (vec3) → Sapphire tail → fragColor. */
const FINISH_STANDARD = /* glsl */ `
  if (!u_expandBorders && !fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, u_mode, u_affectAlpha, u_underSource, u_lightBackground, u_sourceOpacity, u_bgBrightness);`;

/** Show: Threshold — the threshold image at full resolution (over black). */
const SHOW_THRESHOLD = /* glsl */ `
  if (u_show == 1) { vec4 tb = sgl_thresholdSource(texture(u_source, v_uv)); fragColor = vec4(min(tb.rgb, 1.0), 1.0); return; }`;

const ATMOSPHERE = /* glsl */ `
  light *= sgl_atmosphere(fx_layerNorm(), u_box.w / u_box.z, u_atmosphereAmp, u_atmosphereFreq, u_atmosphereDetail, u_atmosphereSeed, u_time * u_atmosphereSpeed);`;

const glowColorParams = (brightness: number, label = 'Brightness') => [
	slider('brightness', label, brightness, { softMax: 8 }),
	fxParam.color('color', 'Color', white),
];
const thresholdParams = (def: number) => [
	slider('threshold', 'Threshold', def, { softMax: 1 }),
	fxParam.color('thresholdAddColor', 'Threshold Add Color', black),
];
const widthXY = () => [slider('widthX', 'Width X', 1, { softMax: 4 }), slider('widthY', 'Width Y', 1, { softMax: 4 })];
const widthRGB = (r = 1, g = 1.2, b = 1.4) => [
	slider('widthRed', 'Width Red', r, { softMax: 4 }),
	slider('widthGreen', 'Width Green', g, { softMax: 4 }),
	slider('widthBlue', 'Width Blue', b, { softMax: 4 }),
];
const glowTail = (what = 'Glow', o: { lightBackground?: boolean } = { lightBackground: true }) => [
	combineChoice(COMBINE_GLOW, 'Screen'),
	...lightTail(what, o),
];

// ================================================================ Glows

export const S_GLOW = defineShaderEffect({
	id: 'jasper.s.glow',
	label: 'S_Glow',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Glow from the pixels brighter than Threshold: a soft multi-scale light with colour falloff (Width Red/Green/Blue) and horizontal/vertical stretch (Width X/Y).',
	keywords: ['bloom', 'light', 'halo', 'diffusion', 'sapphire'],
	params: [
		...glowColorParams(2),
		...thresholdParams(0.5),
		slider('glowWidth', 'Glow Width', 0.4, { softMax: 2 }),
		...widthXY(),
		...widthRGB(),
		showChoice(),
		combineChoice(COMBINE_GLOW, 'Screen'),
		fxParam.choice('edgeMode', 'Edge Mode', ['transparent', 'reflect'], ['Transparent', 'Reflect'], 'reflect'),
		...lightTail('Glow', { lightBackground: true }),
		expandBorders(),
		...atmosphereParams(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, p.glowWidth, Math.max(...rgbMult(p))),
		uniforms: (p) => glowUniforms(p, rgbMult(p)),
		passes: (p, ctx) =>
			glowPasses(
				BRIGHT_STANDARD,
				glowSigma(p.glowWidth, ctx) * Math.max(...rgbMult(p)),
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `${THRESHOLD_SOURCE}
${glowSumGlsl('glowAt', levels)}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  vec3 light = glowAt(v_uv) * u_color.rgb * u_brightness;
  ${ATMOSPHERE}
  ${FINISH_STANDARD}
}`,
				}),
			),
	},
});

export const S_GLOW_NOISE = defineShaderEffect({
	id: 'jasper.s.glow-noise',
	label: 'S_GlowNoise',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'S_Glow attenuated by a solid noise texture: patchy, shimmering light (the noise jitters every N frames or slides).',
	keywords: ['bloom', 'noise', 'shimmer', 'sapphire'],
	params: [
		...glowColorParams(2),
		...thresholdParams(0.5),
		slider('glowWidth', 'Glow Width', 0.4, { softMax: 2 }),
		...widthXY(),
		...widthRGB(),
		slider('noiseAmplitude', 'Noise Amplitude', 1, { softMax: 2 }),
		slider('noiseFrequency', 'Noise Frequency', 40, { min: 0.1, softMax: 200 }),
		slider('noiseFreqRelY', 'Noise Freq Rel Y', 1, { min: 0.02, softMax: 4 }),
		fxParam.number('noiseOctaves', 'Noise Octaves', 1, { min: 1, max: 10, step: 1 }),
		slider('noiseSeed', 'Noise Seed', 0.123, { softMax: 1 }),
		fxParam.vec2('noiseShift', 'Noise Shift', [0, 0], { step: 0.001 }),
		fxParam.vec2('spreadSpeed', 'Spread Speed', [0.1, 0], { step: 0.001 }),
		fxParam.number('jitterFrames', 'Jitter Frames', 1, { min: 0, softMax: 30, step: 1 }),
		showChoice(),
		combineChoice(COMBINE_GLOW, 'Screen'),
		fxParam.choice('edgeMode', 'Edge Mode', ['transparent', 'reflect'], ['Transparent', 'Reflect'], 'reflect'),
		...lightTail('Glow', { lightBackground: true }),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, p.glowWidth, Math.max(...rgbMult(p))),
		uniforms: (p) => glowUniforms(p, rgbMult(p)),
		passes: (p, ctx) =>
			glowPasses(
				BRIGHT_STANDARD,
				glowSigma(p.glowWidth, ctx) * Math.max(...rgbMult(p)),
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_NOISE],
					frag: /* glsl */ `${THRESHOLD_SOURCE}
${glowSumGlsl('glowAt', levels)}
float solidNoise(vec2 q, float seed) {
  int oct = int(clamp(u_noiseOctaves, 1.0, 10.0));
  return fx_noise01(fx_fbm(q, oct, 2.0, 0.5, fract(seed)) * 1.4);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  vec3 light = glowAt(v_uv) * u_color.rgb * u_brightness;
  // Noise space: frame widths (y up like Sapphire's screen space), Frequency cycles per frame width.
  vec2 n = fx_layerNorm();
  vec2 q = vec2(n.x, -n.y * u_box.w / u_box.z) - u_noiseShift;
  q *= vec2(u_noiseFrequency, u_noiseFrequency * u_noiseFreqRelY) * 0.25;
  float nz;
  if (u_jitterFrames >= 1.0) {
    nz = solidNoise(q, u_noiseSeed + floor(u_frame / floor(u_jitterFrames)) * 0.618034);
  } else {
    vec2 sp = u_spreadSpeed * u_noiseFrequency * 0.25 * u_time;
    nz = 0.5 * (solidNoise(q + sp, u_noiseSeed) + solidNoise(q - sp, u_noiseSeed + 0.37));
  }
  light *= max(0.0, 1.0 + u_noiseAmplitude * (nz * 1.6 - 1.0));
  ${FINISH_STANDARD}
}`,
				}),
			),
	},
});

export const S_GLOW_EDGES = defineShaderEffect({
	id: 'jasper.s.glow-edges',
	label: 'S_GlowEdges',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Glow from the extracted edges of the image: thin objects glow as much as large ones; the glow colour comes from Color, not the source.',
	keywords: ['edges', 'outline', 'neon', 'sapphire'],
	params: [
		slider('brightness', 'Glow Brightness', 2, { softMax: 8 }),
		fxParam.color('color', 'Color', white),
		slider('glowWidth', 'Glow Width', 0.224, { softMax: 2 }),
		...widthXY(),
		...widthRGB(),
		slider('edgesSmooth', 'Edges Smooth', 0, { softMax: 1 }),
		slider('edgesBrightness', 'Edges Brightness', 1, { softMax: 4 }),
		slider('edgesThreshold', 'Edges Threshold', 0.5, { softMax: 1 }),
		showChoice(['Result', 'Edges']),
		...glowTail(),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, p.glowWidth, Math.max(...rgbMult(p))),
		uniforms: (p, ctx) => ({
			...glowUniforms(p, rgbMult(p)),
			// Edge detector footprint (canvas px): 1 px, widened by Edges Smooth.
			u_edgeR: (1 + num(p.edgesSmooth) * unitPx(ctx.width) * 0.25) * ctx.pxScale,
		}),
		passes: (p, ctx) =>
			glowPasses(
				/* glsl */ `${EDGES_GLSL}
void main() {
  float e = edgesAt(v_uv, u_edgeR * max(1.0, u_dB * 0.5));
  fragColor = vec4(vec3(e), e);
}`,
				glowSigma(p.glowWidth, ctx) * Math.max(...rgbMult(p)),
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `${EDGES_GLSL}
${glowSumGlsl('glowAt', levels)}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_show == 1) { fragColor = vec4(vec3(min(edgesAt(v_uv, u_edgeR), 1.0)), 1.0); return; }
  vec3 light = glowAt(v_uv) * u_color.rgb * u_brightness;
  ${FINISH_STANDARD}
}`,
				}),
				[],
			),
	},
});

/** Edge extraction (luminance + alpha gradient, Sobel at radius r canvas px) → 0..Edges Brightness. */
const EDGES_GLSL = /* glsl */ `
vec4 sgl_layerRead(vec2 uv) {
  // Mirrored at the layer box (no false edge at the frame border).
  vec2 n = sgl_mirrorNorm((uv * u_canvasSize - u_box.xy) / u_box.zw);
  return texture(u_source, fx_uvOfLayerNorm(n));
}
float edgeLuma(vec2 uv) { vec4 s = sgl_layerRead(uv); return fx_luma(s.rgb) * 0.7 + s.a * 0.3; }
float edgesAt(vec2 uv, float r) {
  vec2 o = r / u_canvasSize;
  float tl = edgeLuma(uv + vec2(-o.x, -o.y)), t = edgeLuma(uv + vec2(0.0, -o.y)), tr = edgeLuma(uv + vec2(o.x, -o.y));
  float l = edgeLuma(uv + vec2(-o.x, 0.0)), rr = edgeLuma(uv + vec2(o.x, 0.0));
  float bl = edgeLuma(uv + vec2(-o.x, o.y)), b = edgeLuma(uv + vec2(0.0, o.y)), br = edgeLuma(uv + vec2(o.x, o.y));
  float gx = (tr + 2.0 * rr + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  float g = length(vec2(gx, gy)) * 0.5;
  float thr = clamp(u_edgesThreshold, 0.0, 1.0) * 0.35;
  return smoothstep(thr * 0.5, thr + 0.05, g) * min(g * 2.0, 1.0) * u_edgesBrightness;
}`;

export const S_GLOW_DARKS = defineShaderEffect({
	id: 'jasper.s.glow-darks',
	label: 'S_GlowDarks',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'The areas darker than Threshold are blurred and combined back in: dark, smoky shadows that bleed into the light parts.',
	keywords: ['dark glow', 'shadow', 'smoke', 'sapphire'],
	params: [
		slider('darkness', 'Darkness', 0.5, { softMax: 4 }),
		slider('threshold', 'Threshold', 0.5, { softMax: 1 }),
		fxParam.number('glowSaturation', 'Glow Saturation', 1, { min: -2, max: 8, step: 0.01 }),
		slider('glowWidth', 'Glow Width', 1, { softMax: 4 }),
		...widthXY(),
		slider('fromAlpha', 'Glow From Alpha', 0, { max: 1, softMax: 1 }),
		slider('underSource', 'Glow Under Source', 0, { max: 1, softMax: 1 }),
		slider('sourceOpacity', 'Source Opacity', 1, { max: 1, softMax: 1 }),
		slider('bgBrightness', 'Bg Brightness', 1, { softMax: 2 }),
		showChoice(),
		expandBorders(),
		...atmosphereParams(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, p.glowWidth),
		uniforms: (p) => glowUniforms(p, [1, 1, 1]),
		passes: (p, ctx) =>
			glowPasses(
				/* glsl */ `${DARKS_SOURCE}
void main() {
  fragColor = darkSource(sgl_srcRead(u_dB, u_expandBorders ? 0 : 1));
}`,
				glowSigma(p.glowWidth, ctx),
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `${DARKS_SOURCE}
${levelSumGlsl('darkAt', levels, 'u_wr')}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_show == 1) { fragColor = vec4(vec3(1.0 - darkSource(src).a), 1.0); return; }
  vec4 dk = darkAt(v_uv);
  vec3 light = vec3(dk.a);
  ${ATMOSPHERE}
  // The blurred dark colours darken the image (a "glow" of shadow): min() with the base, by their coverage.
  vec3 dc = fx_saturate(dk.rgb / max(dk.a, 1.0e-4), u_glowSaturation);
  float cov = clamp((1.0 - exp(-light.r * 3.0)) * u_darkness * 2.0, 0.0, 1.0);
  vec4 base = src * clamp(u_sourceOpacity, 0.0, 1.0);
  base.rgb *= u_bgBrightness;
  vec4 res = vec4(mix(base.rgb, min(base.rgb, max(dc, 0.0) * base.a), cov), base.a);
  res = mix(res, src, clamp(u_underSource, 0.0, 1.0) * src.a);
  if (!u_expandBorders && !fx_inBox(v_uv)) res = base;
  fragColor = res;
}`,
				}),
			),
	},
});

/** S_GlowDarks source: the colour of the areas darker than Threshold, premultiplied by how much darker (0..1). */
const DARKS_SOURCE = /* glsl */ `
vec4 darkSource(vec4 s) {
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  float l = mix(fx_luma(c), s.a, clamp(u_fromAlpha, 0.0, 1.0));
  float t = max(u_threshold, 1.0e-3);
  float m = clamp((t - l) / t * 2.0, 0.0, 1.0) * s.a;
  return vec4(c * m, m);
}`;

export const S_GLOW_ORTHICON = defineShaderEffect({
	id: 'jasper.s.glow-orthicon',
	label: 'S_GlowOrthicon',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Darkens the image around bright areas — the dark halo of image-orthicon tube cameras — sparing a protect zone right next to the brights.',
	keywords: ['orthicon', 'dark halo', 'vintage tv', 'sapphire'],
	params: [
		slider('darkness', 'Darkness', 1, { softMax: 4 }),
		fxParam.color('color', 'Color', black),
		...thresholdParams(0.7),
		slider('darksWidth', 'Darks Width', 0.224, { softMax: 2 }),
		slider('protectWidth', 'Protect Width', 0.1, { softMax: 2 }),
		slider('protectAmount', 'Protect Amount', 1, { softMax: 2 }),
		...widthXY(),
		slider('fromAlpha', 'Glow From Alpha', 0, { max: 1, softMax: 1 }),
		slider('underSource', 'Glow Under Source', 0, { max: 1, softMax: 1 }),
		slider('sourceOpacity', 'Source Opacity', 1, { max: 1, softMax: 1 }),
		slider('bgBrightness', 'Bg Brightness', 1, { softMax: 2 }),
		showChoice(),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, Math.max(num(p.darksWidth), num(p.protectWidth))),
		uniforms: (p) => {
			// Two profiles over one cascade: the darks (wide) and the protect zone (narrow).
			const dw = Math.max(1e-3, num(p.darksWidth));
			const pw = Math.max(1e-3, num(p.protectWidth));
			const top = Math.max(dw, pw);
			return {
				u_wd: { floats: levelWeights(LEVELS, 0, Math.log2(dw / top)) },
				u_wp: { floats: levelWeights(LEVELS, -0.6, Math.log2(pw / top)) },
			};
		},
		passes: (p, ctx) =>
			glowPasses(
				BRIGHT_STANDARD.replace('u_expandBorders ? 0 : u_edgeMode', 'u_expandBorders ? 0 : 1'),
				glowSigma(Math.max(num(p.darksWidth), num(p.protectWidth)), ctx),
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `${THRESHOLD_SOURCE}
${levelSumGlsl('darksAt', levels, 'u_wd')}
${levelSumGlsl('protectAt', levels, 'u_wp')}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  float d = darksAt(v_uv).a;
  float pr = protectAt(v_uv).a;
  float own = sgl_maxc(sgl_thresholdSource(src).rgb);
  float dark = (1.0 - exp(-d * 24.0)) * clamp(1.0 - u_protectAmount * (1.0 - exp(-pr * 14.0)), 0.0, 1.0);
  dark *= 1.0 - clamp(own * 2.0, 0.0, 1.0);
  dark = clamp(dark * u_darkness, 0.0, 1.0);
  vec4 base = src * clamp(u_sourceOpacity, 0.0, 1.0);
  base.rgb *= u_bgBrightness;
  vec4 res = vec4(mix(base.rgb, u_color.rgb * base.a, dark), base.a);
  res = mix(res, src, clamp(u_underSource, 0.0, 1.0) * own);
  if (!u_expandBorders && !fx_inBox(v_uv)) res = base;
  fragColor = res;
}`,
				}),
			),
	},
});

// ---------------------------------------------------------------- distance-based glows

/** Reach (canvas px) a distance glow needs for a falloff length `len` (canvas px). */
const distReach = (len: number) => Math.max(4, len * 5);

/** The distance-glow passes: threshold seeds → JFA → final (which reads `u_<field>`). */
function distancePasses(reachPx: number, final: (field: string, down: number) => ShaderPass): ShaderPass[] {
	const j = jfaPasses(
		'sgl_maxc(sgl_thresholdSource(s).rgb) * 2.0',
		reachPx,
		[GLSL_SGL_FINISH, { name: 'sgl/thresholdSource', source: THRESHOLD_SOURCE, deps: [GLSL_SGL_FINISH] }],
	);
	return [...j.passes, final(j.field, j.down)];
}

/** GLSL of a distance glow's final pass prologue: `d` (layer px), `dir` (unit, from the seed), `seedCol`. */
const DIST_PROLOGUE = (field: string, down: number) => /* glsl */ `
  vec3 ns = sgl_nearestSeed(u_${field}, v_uv);
  if (ns.z < 0.5) { fragColor = sgl_finishLight(src, vec3(0.0), u_mode, u_affectAlpha, u_underSource, u_lightBackground, u_sourceOpacity, u_bgBrightness); return; }
  vec2 dv = (v_uv - ns.xy) * u_canvasSize;
  float own = sgl_maxc(sgl_thresholdSource(src).rgb);
  float d = max(0.0, length(dv) - ${(down * 0.5).toFixed(2)}) / u_pxScale;
  if (own > 0.25) d = 0.0;
  vec2 dir = length(dv) > 1.0e-3 ? normalize(dv) : vec2(1.0, 0.0);
  vec4 sc = texture(u_source, ns.xy);
  vec3 seedCol = sgl_thresholdSource(sc).rgb;
  seedCol = seedCol / max(sgl_maxc(seedCol), 1.0e-3);`;

const DIST_INCLUDE = [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_SGL_DISTANCE];

export const S_GLOW_DIST = defineShaderEffect({
	id: 'jasper.s.glow-dist',
	label: 'S_GlowDist',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Glow by distance from the edges of the areas brighter than Threshold: an equally bright glow into the darker side of every edge, however thin the bright shape.',
	keywords: ['distance glow', 'outline', 'neon', 'sapphire'],
	params: [
		...glowColorParams(0.8),
		...thresholdParams(0.5),
		slider('glowWidth', 'Glow Width', 0.1, { softMax: 1 }),
		...widthRGB(),
		showChoice(),
		...glowTail(),
	],
	gpu: {
		padding: (p, ctx) => distReach(num(p.glowWidth) * unitPx(ctx.width) * Math.max(...rgbMult(p))),
		uniforms: (p, ctx) => ({
			u_mode: combineMode(p.combine, COMBINE_GLOW, 'Screen'),
			u_len: Math.max(1e-3, num(p.glowWidth) * unitPx(ctx.width)),
		}),
		passes: (p, ctx) =>
			distancePasses(distReach(num(p.glowWidth) * unitPx(ctx.width) * Math.max(...rgbMult(p)) * ctx.pxScale), (f, down) => ({
				include: DIST_INCLUDE,
				frag: /* glsl */ `${THRESHOLD_SOURCE}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  ${DIST_PROLOGUE(f, down)}
  vec3 len = u_len * max(vec3(u_widthRed, u_widthGreen, u_widthBlue), vec3(1.0e-3));
  vec3 g = exp(-d / len);
  vec3 light = g * seedCol * u_color.rgb * u_brightness;
  fragColor = sgl_finishLight(src, light, u_mode, u_affectAlpha, u_underSource, u_lightBackground, u_sourceOpacity, u_bgBrightness);
}`,
			})),
	},
});

const cyclesParams = (freq: number, fr: [number, number, number], ph: [number, number, number]) => [
	slider('frequency', 'Frequency', freq, { softMax: 50 }),
	slider('frequencyRed', 'Frequency Red', fr[0], { softMax: 4 }),
	slider('frequencyGreen', 'Frequency Green', fr[1], { softMax: 4 }),
	slider('frequencyBlue', 'Frequency Blue', fr[2], { softMax: 4 }),
	fxParam.number('phase', 'Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
	fxParam.number('phaseSpeed', 'Phase Speed', 1, { softMin: -4, softMax: 4, step: 0.01 }),
	fxParam.number('phaseRed', 'Phase Red', ph[0], { softMin: -1, softMax: 1, step: 0.001 }),
	fxParam.number('phaseGreen', 'Phase Green', ph[1], { softMin: -1, softMax: 1, step: 0.001 }),
	fxParam.number('phaseBlue', 'Phase Blue', ph[2], { softMin: -1, softMax: 1, step: 0.001 }),
];

/** Spectral cycling colour of a distance (cycles = frequency × channel frequency, in Sapphire width units). */
const CYCLE_GLSL = /* glsl */ `
vec3 cycleColor(float cyc) {
  vec3 f = vec3(u_frequencyRed, u_frequencyGreen, u_frequencyBlue);
  vec3 ph = vec3(u_phaseRed, u_phaseGreen, u_phaseBlue) + u_phase + u_phaseSpeed * u_time * 0.25;
  return 0.5 + 0.5 * cos(6.28318530718 * (cyc * f + ph));
}`;

export const S_GLOW_RAINBOW = defineShaderEffect({
	id: 'jasper.s.glow-rainbow',
	label: 'S_GlowRainbow',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'A distance-from-edge glow coloured by a cycling spectrum: rainbow bands follow the shape of the bright areas and can animate outwards.',
	keywords: ['rainbow', 'spectrum', 'psychedelic', 'sapphire'],
	params: [
		...glowColorParams(0.8),
		fxParam.number('glowSaturation', 'Glow Saturation', 1, { min: -2, max: 8, step: 0.01 }),
		...thresholdParams(0.5),
		slider('glowWidth', 'Glow Width', 0.42, { softMax: 2 }),
		...cyclesParams(12, [1, 0.9, 0.8], [0, 0, 0]),
		showChoice(),
		...glowTail(),
	],
	gpu: {
		padding: (p, ctx) => distReach(num(p.glowWidth) * unitPx(ctx.width)),
		uniforms: (p, ctx) => ({
			u_mode: combineMode(p.combine, COMBINE_GLOW, 'Screen'),
			u_len: Math.max(1e-3, num(p.glowWidth) * unitPx(ctx.width)),
			u_unit: unitPx(ctx.width),
		}),
		passes: (p, ctx) =>
			distancePasses(distReach(num(p.glowWidth) * unitPx(ctx.width) * ctx.pxScale), (f, down) => ({
				include: DIST_INCLUDE,
				frag: /* glsl */ `${THRESHOLD_SOURCE}
${CYCLE_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  ${DIST_PROLOGUE(f, down)}
  float g = exp(-d / u_len);
  vec3 col = cycleColor(-d / u_unit * u_frequency * 0.5);
  col = fx_saturate(col, u_glowSaturation);
  vec3 light = g * col * u_color.rgb * u_brightness * 1.5;
  fragColor = sgl_finishLight(src, light, u_mode, u_affectAlpha, u_underSource, u_lightBackground, u_sourceOpacity, u_bgBrightness);
}`,
			})),
	},
});

export const S_GLOW_RINGS = defineShaderEffect({
	id: 'jasper.s.glow-rings',
	label: 'S_GlowRings',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Coloured concentric rings around the bright areas: one ring per colour channel at Width Red/Green/Blue, with adjustable band thickness.',
	keywords: ['rings', 'halo', 'outline', 'sapphire'],
	params: [
		...glowColorParams(1),
		...thresholdParams(0),
		slider('glowWidth', 'Glow Width', 0.4, { softMax: 2 }),
		...widthXY(),
		...widthRGB(0.5, 0.75, 1),
		slider('thicknessRed', 'Thickness Red', 0.5, { max: 1, softMax: 1 }),
		slider('thicknessGreen', 'Thickness Green', 0.5, { max: 1, softMax: 1 }),
		slider('thicknessBlue', 'Thickness Blue', 0.5, { max: 1, softMax: 1 }),
		showChoice(),
		...glowTail(),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) =>
			1.6 * num(p.glowWidth) * unitPx(ctx.width) * Math.max(...rgbMult(p)) * Math.max(num(p.widthX, 1), num(p.widthY, 1)),
		uniforms: (p, ctx) => ({
			u_mode: combineMode(p.combine, COMBINE_GLOW, 'Screen'),
			u_len: Math.max(1e-3, num(p.glowWidth) * unitPx(ctx.width)),
		}),
		passes: (p, ctx) =>
			distancePasses(
				1.6 * num(p.glowWidth) * unitPx(ctx.width) * Math.max(...rgbMult(p)) * Math.max(num(p.widthX, 1), num(p.widthY, 1)) * ctx.pxScale,
				(f, down) => ({
					include: DIST_INCLUDE,
					frag: /* glsl */ `${THRESHOLD_SOURCE}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  ${DIST_PROLOGUE(f, down)}
  // Anisotropic distance (Width X / Width Y stretch the rings).
  float da = length(dv / max(vec2(u_widthX, u_widthY), vec2(1.0e-3))) / u_pxScale;
  if (own > 0.25) da = 0.0;
  vec3 r = u_len * vec3(u_widthRed, u_widthGreen, u_widthBlue);
  vec3 th = max(vec3(u_thicknessRed, u_thicknessGreen, u_thicknessBlue), 0.02) * r * 0.5;
  vec3 x = (vec3(da) - r) / th;
  vec3 ring = exp(-x * x * 2.0) * step(0.0, r);
  vec3 light = ring * mix(vec3(1.0), seedCol, 0.5) * u_color.rgb * u_brightness;
  if (!u_expandBorders && !fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, u_mode, u_affectAlpha, u_underSource, u_lightBackground, u_sourceOpacity, u_bgBrightness);
}`,
				}),
			),
	},
});

export const S_GLOW_AURA = defineShaderEffect({
	id: 'jasper.s.glow-aura',
	label: 'S_GlowAura',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'A coloured aura: lines radiating from the bright areas along the glow gradient, cycling through a spectrum with distance (Twist spirals them; Phase Speed animates).',
	keywords: ['aura', 'energy', 'spectrum', 'sapphire'],
	params: [
		...glowColorParams(0.8),
		slider('outerBrightness', 'Outer Brightness', 1, { softMax: 4 }),
		fxParam.number('glowSaturation', 'Glow Saturation', 1, { softMin: -2, softMax: 8, step: 0.01 }),
		...thresholdParams(0),
		slider('glowWidth', 'Glow Width', 0.4, { softMax: 2 }),
		...cyclesParams(8, [1, 1, 1], [0.2, 0.1, 0]),
		fxParam.number('twist', 'Twist', 1, { softMin: -8, softMax: 8, step: 0.01 }),
		showChoice(),
		...glowTail(),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, p.glowWidth),
		uniforms: (p) => glowUniforms(p, [1, 1, 1], 1.2),
		passes: (p, ctx) =>
			glowPasses(
				BRIGHT_STANDARD.replace('u_expandBorders ? 0 : u_edgeMode', 'u_expandBorders ? 0 : 1'),
				glowSigma(p.glowWidth, ctx),
				1,
				1,
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_NOISE],
					frag: /* glsl */ `${THRESHOLD_SOURCE}
${CYCLE_GLSL}
${glowSumGlsl('glowAt', levels)}
float gl(vec2 uv) { return fx_luma(glowAt(uv)); }
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  vec2 e = 3.0 * u_pxScale / u_canvasSize;
  float g = gl(v_uv);
  vec2 grad = vec2(gl(v_uv + vec2(e.x, 0.0)) - gl(v_uv - vec2(e.x, 0.0)), gl(v_uv + vec2(0.0, e.y)) - gl(v_uv - vec2(0.0, e.y)));
  float ang = atan(-grad.y, -grad.x);
  // Distance proxy: how many e-foldings the glow has fallen from full light.
  float s = -log(clamp(g, 1.0e-4, 1.0));
  float lines = 0.45 + 0.55 * fx_noise01(fx_simplex(vec2(ang * 7.0 + u_twist * s * 1.5, s * 0.25 - u_time * 0.15), 0.37) * 1.4);
  vec3 col = cycleColor(s * u_frequency * 0.12 + u_twist * ang / 6.28318530718);
  col = fx_saturate(col, u_glowSaturation) * lines;
  float amp = g * mix(1.0, u_outerBrightness, clamp(s * 0.3, 0.0, 1.0)) * (1.0 + 2.0 * clamp(s * 0.5, 0.0, 1.0));
  vec3 light = clamp(amp, 0.0, 4.0) * col * u_color.rgb * u_brightness;
  ${FINISH_STANDARD}
}`,
				}),
			),
	},
});

// ---------------------------------------------------------------- S_UltraGlow, S_ZGlow

const EDGE_COMBINE = ['Screen', 'Add', 'Edges Only'] as const;

export const S_ULTRA_GLOW = defineShaderEffect({
	id: 'jasper.s.ultra-glow',
	label: 'S_UltraGlow',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'A high-end glow: primary glow with Falloff and Bias, a wide stretched After Glow, horizontal/vertical streak trails, optional edge detection and atmosphere.',
	keywords: ['bloom', 'glow', 'streaks', 'after glow', 'sapphire'],
	expensive: true,
	params: [
		...glowColorParams(1.8),
		...thresholdParams(0.4),
		slider('glowWidth', 'Glow Width', 0.371, { softMax: 2 }),
		fxParam.number('glowFalloff', 'Glow Falloff', 0.35, { min: -2, max: 2, step: 0.01 }),
		fxParam.number('glowBias', 'Glow Bias', 0, { min: -3, max: 3, step: 0.01 }),
		...widthXY(),
		...widthRGB(1, 1, 1),
		showChoice(),
		slider('afterGlowWidth', 'After Glow Width', 0.808, { softMax: 4 }),
		fxParam.color('afterGlowColor', 'After Glow Color', white),
		slider('afterGlowStretchX', 'After Glow Stretch X', 0.3, { softMax: 2 }),
		slider('afterGlowStretchY', 'After Glow Stretch Y', 0.1, { softMax: 2 }),
		slider('horizontalStreaks', 'Horizontal Streaks', 0.25, { softMax: 2 }),
		slider('verticalStreaks', 'Vertical Streaks', 0.25, { softMax: 2 }),
		fxParam.toggle('edgeDetect', 'Edge Detect', false),
		combineChoice(EDGE_COMBINE, 'Screen'),
		slider('edgeSmooth', 'Edge Smooth', 0, { softMax: 1 }),
		fxParam.choice('edgeMode', 'Edge Mode', ['transparent', 'reflect'], ['Transparent', 'Reflect'], 'reflect'),
		fxParam.toggle('edgeFill', 'Edge Fill', true),
		slider('edgeThin', 'Edge Thin', 0, { max: 1, softMax: 1 }),
		fxParam.toggle('atmosphere', 'Atmosphere', false),
		slider('atmosphereAmp', 'Atmosphere Amp', 1, { softMax: 2 }),
		slider('atmosphereFreq', 'Atmosphere Freq', 11.6, { min: 0.1, softMax: 40 }),
		slider('atmosphereDetail', 'Atmosphere Detail', 0.506, { max: 1, softMax: 1 }),
		fxParam.number('atmosphereSpeed', 'Atmosphere Speed', 1, { softMin: -4, softMax: 4, step: 0.01 }),
		slider('atmosphereLights', 'Atmosphere Lights', 0.5, { softMax: 2 }),
		slider('atmosphereDarks', 'Atmosphere Darks', 0, { softMax: 2 }),
		slider('atmosphereSeed', 'Atmosphere Seed', 0.123, { softMax: 1 }),
		...glowTail(),
		fxParam.toggle('expandBorders', 'Expand Borders', true),
	].map((ps) => (ps.name === 'combine' && ps.options?.includes('edgesonly') ? { ...ps, name: 'edgeCombine', label: 'Edge Combine' } : ps)),
	gpu: {
		padding: (p, ctx) =>
			Math.max(
				glowPadding(p, ctx, p.glowWidth),
				3 * num(p.afterGlowWidth) * K_GLOW * unitPx(ctx.width) * (1 + 2 * Math.max(num(p.afterGlowStretchX), num(p.afterGlowStretchY))),
				4 * num(p.glowWidth) * K_GLOW * unitPx(ctx.width) * 2,
			),
		uniforms: (p) => ({
			...glowUniforms(p, rgbMult(p), GLOW_SLOPE + num(p.glowFalloff, 0.35) * 0.8, COMBINE_GLOW, 'Screen', 4),
			u_edgeModeC: { int: ['screen', 'add', 'edgesonly'].indexOf(String(p.edgeCombine)) },
		}),
		passes: (p, ctx) => {
			const sigma = glowSigma(p.glowWidth, ctx) * Math.max(...rgbMult(p));
			const sx = sigma * num(p.widthX, 1);
			const sy = sigma * num(p.widthY, 1);
			const aSig = glowSigma(p.afterGlowWidth, ctx);
			const ax = aSig * (1 + 2 * num(p.afterGlowStretchX));
			const ay = aSig * (1 + 2 * num(p.afterGlowStretchY));
			const aDown = clamp(2 ** Math.round(Math.log2(Math.max(1, Math.max(ax, ay) / 4))), 4, 64);
			const streak = sigma * 4;
			const sDown = clamp(2 ** Math.round(Math.log2(Math.max(1, sigma / 32))), 1, 8);
			return glowPasses(
				/* glsl */ `${THRESHOLD_SOURCE}
${ULTRA_EDGES}
void main() {
  vec4 s = sgl_srcRead(u_dB, u_expandBorders ? 0 : u_edgeMode);
  vec4 b = sgl_thresholdSource(s);
  if (u_edgeDetect) {
    float e = ultraEdges(v_uv, max(1.0, u_dB));
    vec3 ec = vec3(e) * max(s.rgb, vec3(0.25));
    b.rgb = u_edgeModeC == 2 ? ec : u_edgeModeC == 1 ? b.rgb + ec : b.rgb + ec - b.rgb * min(ec, 1.0);
  }
  // Glow Bias grows (> 0) or shrinks (< 0) the soft outskirts of the threshold result.
  b.rgb = pow(max(b.rgb, 0.0), vec3(exp2(-u_glowBias)));
  fragColor = vec4(b.rgb, sgl_maxc(b.rgb));
}`,
				sigma,
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_NOISE],
					frag: /* glsl */ `${THRESHOLD_SOURCE}
${glowSumGlsl('glowAt', levels)}
void main() {
  vec4 src = texture(u_source, v_uv);
  ${SHOW_THRESHOLD}
  vec3 glow = glowAt(v_uv);
  vec3 light = glow * u_color.rgb * u_brightness;
  light += texture(u_after, v_uv).rgb * u_afterGlowColor.rgb * u_brightness * 0.25;
  light += texture(u_streakH, v_uv).rgb * u_horizontalStreaks * u_color.rgb * u_brightness * 0.6;
  light += texture(u_streakV, v_uv).rgb * u_verticalStreaks * u_color.rgb * u_brightness * 0.6;
  if (u_atmosphere) {
    vec2 n = fx_layerNorm();
    float a = fx_fbm3(vec3(n.x * u_atmosphereFreq, n.y * u_atmosphereFreq * u_box.w / u_box.z, u_time * u_atmosphereSpeed * 0.25),
                      1 + int(u_atmosphereDetail * 6.0), 2.0, 0.5, fract(u_atmosphereSeed));
    float m = 1.0 + u_atmosphereAmp * (max(a, 0.0) * u_atmosphereLights * 2.0 - max(-a, 0.0) * u_atmosphereDarks * 2.0);
    light *= max(m, 0.0);
  }
  ${FINISH_STANDARD}
}`,
				}),
				[],
				[
					// After Glow: a wide, stretched glow of the primary glow's widest level (one 2D pass at low resolution).
					{
						output: 'after',
						scale: 1 / aDown,
						format: 'rgba16f',
						uniforms: { u_aSig: [ax / aDown, ay / aDown] },
						frag: /* glsl */ `
void main() {
  vec2 tx = 1.0 / u_resolution;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int y = -6; y <= 6; y++)
    for (int x = -6; x <= 6; x++) {
      vec2 o = vec2(float(x), float(y)) / 6.0 * 2.5 * u_aSig;
      float w = exp(-0.5 * dot(o / max(u_aSig, vec2(1.0e-3)), o / max(u_aSig, vec2(1.0e-3))));
      acc += texture(u_g3, v_uv + o * tx) * w;
      ws += w;
    }
  fragColor = acc / ws;
}`,
					},
					streakPass('streakH', 'g0', [1, 0], streak / sDown, sDown),
					streakPass('streakV', 'g0', [0, 1], streak / sDown, sDown),
				],
				4,
			);
		},
	},
});

/** A long thin exponential streak along `dir` from cascade level `input` (UltraGlow trails). */
function streakPass(output: string, input: string, dir: [number, number], len: number, down: number): ShaderPass {
	return {
		output,
		scale: 1 / down,
		format: 'rgba16f',
		uniforms: { u_sDir: dir, u_sLen: len },
		frag: /* glsl */ `
void main() {
  vec2 tx = 1.0 / u_resolution;
  vec4 acc = texture(u_${input}, v_uv) * 0.5;
  for (int i = 1; i <= 40; i++) {
    float k = float(i) / 40.0;
    float w = exp(-4.0 * k);
    vec2 o = u_sDir * tx * u_sLen * k;
    acc += (texture(u_${input}, v_uv + o) + texture(u_${input}, v_uv - o)) * w;
  }
  fragColor = acc / 12.0;
}`,
	};
}

const ULTRA_EDGES = /* glsl */ `
float ultraEdges(vec2 uv, float r) {
  vec2 o = (r * (1.0 + u_edgeSmooth * 6.0)) / u_canvasSize;
  vec2 n0 = (uv * u_canvasSize - u_box.xy) / u_box.zw;
  vec2 on = o * u_canvasSize / u_box.zw;
  float c = fx_luma(texture(u_source, fx_uvOfLayerNorm(sgl_mirrorNorm(n0))).rgb);
  float gx = fx_luma(texture(u_source, fx_uvOfLayerNorm(sgl_mirrorNorm(n0 + vec2(on.x, 0.0)))).rgb)
           - fx_luma(texture(u_source, fx_uvOfLayerNorm(sgl_mirrorNorm(n0 - vec2(on.x, 0.0)))).rgb);
  float gy = fx_luma(texture(u_source, fx_uvOfLayerNorm(sgl_mirrorNorm(n0 + vec2(0.0, on.y)))).rgb)
           - fx_luma(texture(u_source, fx_uvOfLayerNorm(sgl_mirrorNorm(n0 - vec2(0.0, on.y)))).rgb);
  float e = clamp(length(vec2(gx, gy)) * 2.0, 0.0, 1.0);
  e = smoothstep(u_edgeThin * 0.8, 1.0, e);
  return u_edgeFill ? max(e, c * 0.5) : e;
}`;

export const S_ZGLOW = defineShaderEffect({
	id: 'jasper.s.zglow',
	label: 'S_ZGlow',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'A glow whose width, brightness and colour depend on depth: pick a Z Buffer (depth map) clip; near areas glow with the Near settings, far areas with the Far settings.',
	keywords: ['depth', 'z buffer', 'bloom', 'atmospheric', 'sapphire'],
	expensive: true,
	params: [
		...glowColorParams(2),
		slider('widthNear', 'Width Near', 0.0336, { softMax: 1 }),
		slider('widthFar', 'Width Far', 0.4, { softMax: 2 }),
		...thresholdParams(0.5),
		fxParam.media('zBuffer', 'Z Buffer', ['image', 'video']),
		fxParam.choice('zBufferType', 'Z Buffer Type', ['blackIsNear', 'whiteIsNear'], ['Black is Near', 'White is Near'], 'whiteIsNear'),
		slider('zMin', 'Z Min', 0, { max: 1, softMax: 1 }),
		slider('zMax', 'Z Max', 1, { max: 1, softMax: 1 }),
		fxParam.number('layers', 'Layers', 5, { min: 2, max: 50, step: 1 }, { animatable: false }),
		slider('brightnessNear', 'Brightness Near', 1, { softMax: 4 }),
		fxParam.color('colorNear', 'Color Near', white),
		slider('widthRedNear', 'Width Red Near', 1, { softMax: 4 }),
		slider('widthGreenNear', 'Width Green Near', 1, { softMax: 4 }),
		slider('widthBlueNear', 'Width Blue Near', 1, { softMax: 4 }),
		slider('brightnessFar', 'Brightness Far', 1, { softMax: 4 }),
		fxParam.color('colorFar', 'Color Far', white),
		slider('widthRedFar', 'Width Red Far', 1, { softMax: 4 }),
		slider('widthGreenFar', 'Width Green Far', 1, { softMax: 4 }),
		slider('widthBlueFar', 'Width Blue Far', 1, { softMax: 4 }),
		...widthXY(),
		...widthRGB(),
		slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }),
		slider('sourceOpacity', 'Source Opacity', 1, { max: 1, softMax: 1 }),
		fxParam.choice('zbufferUse', 'Zbuffer Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'luma'),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) => glowPadding(p, ctx, zWidest(p)),
		passes: (p, ctx) =>
			glowPasses(
				/* glsl */ `${ZDEPTH_GLSL}
void main() {
  vec4 s = sgl_srcRead(u_dB, u_expandBorders ? 0 : 1);
  vec3 b = sgl_threshold(s.rgb, u_threshold, u_thresholdAddColor.rgb);
  float z = depthAt(fx_layerNorm());
  // alpha carries luminance × depth: the cascade averages the depth of the light reaching each pixel.
  fragColor = vec4(b, fx_luma(b) * z);
}`,
				glowSigma(zWidest(p), ctx),
				num(p.widthX, 1),
				num(p.widthY, 1),
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					uniforms: { u_zTop: Math.log2(Math.max(1e-4, zWidest(p))) },
					frag: /* glsl */ `${ZDEPTH_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 L[${levels.length}];
  ${levels.map((l, k) => `L[${k}] = texture(u_${l}, v_uv);`).join('\n  ')}
  float lum = 0.0, lz = 0.0;
  for (int k = 0; k < ${levels.length}; k++) { lum += fx_luma(L[k].rgb); lz += L[k].a; }
  float z = lum > 1.0e-5 ? clamp(lz / lum, 0.0, 1.0) : 0.5;
  float nl = max(2.0, floor(u_layers + 0.5));
  z = floor(z * (nl - 1.0) + 0.5) / (nl - 1.0);
  vec3 mult = mix(vec3(u_widthRedNear, u_widthGreenNear, u_widthBlueNear), vec3(u_widthRedFar, u_widthGreenFar, u_widthBlueFar), z)
            * vec3(u_widthRed, u_widthGreen, u_widthBlue) * mix(u_widthNear, u_widthFar, z);
  vec3 shift = log2(max(mult, vec3(1.0e-4))) - u_zTop;
  vec3 acc = vec3(0.0), ws = vec3(0.0);
  float Lf = float(${levels.length});
  for (int k = 0; k < ${levels.length}; k++) {
    vec3 w = vec3(sgl_levelW(float(k), Lf, ${GLOW_SLOPE.toFixed(3)}, shift.r), sgl_levelW(float(k), Lf, ${GLOW_SLOPE.toFixed(3)}, shift.g), sgl_levelW(float(k), Lf, ${GLOW_SLOPE.toFixed(3)}, shift.b));
    acc += L[k].rgb * w;
    ws += w;
  }
  vec3 glow = acc / max(ws, vec3(1.0e-5)) * ${GLOW_GAIN.toFixed(3)};
  vec3 tint = mix(u_colorNear.rgb * u_brightnessNear, u_colorFar.rgb * u_brightnessFar, z);
  vec3 light = glow * tint * u_color.rgb * u_brightness;
  if (!u_expandBorders && !fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, 2, u_affectAlpha, 0.0, 0.0, u_sourceOpacity, 1.0);
}`,
				}),
			),
	},
});

const zWidest = (p: EffectParams) =>
	Math.max(num(p.widthNear), num(p.widthFar)) *
	Math.max(...rgbMult(p)) *
	Math.max(
		1,
		...rgbMult(p, 'widthRedNear', 'widthGreenNear', 'widthBlueNear'),
		...rgbMult(p, 'widthRedFar', 'widthGreenFar', 'widthBlueFar'),
	);

/** Depth 0 (near) … 1 (far) from the Z Buffer clip (none: 0.5). */
const ZDEPTH_GLSL = /* glsl */ `
float depthAt(vec2 n) {
  if (u_zBuffer_size.x <= 0.0) return 0.5;
  vec4 z = texture(u_zBuffer, clamp(n, 0.0, 1.0));
  float v = u_zbufferUse == 1 ? z.a : fx_luma(z.a > 0.0 ? z.rgb / z.a : vec3(0.0));
  if (u_zBufferType == 1) v = 1.0 - v;
  return clamp((v - u_zMin) / max(u_zMax - u_zMin, 1.0e-4), 0.0, 1.0);
}`;

export const SGL_GLOW_EFFECTS: readonly EffectSpec[] = [
	S_GLOW,
	S_GLOW_AURA,
	S_GLOW_DARKS,
	S_GLOW_DIST,
	S_GLOW_EDGES,
	S_GLOW_NOISE,
	S_GLOW_ORTHICON,
	S_GLOW_RAINBOW,
	S_GLOW_RINGS,
	S_ULTRA_GLOW,
	S_ZGLOW,
];

// ================================================================ Light beams

const RES_OPTIONS = ['full', 'half', 'quarter'];
const resChoice = (name: string, label: string) =>
	fxParam.choice(name, label, RES_OPTIONS, ['Full', 'Half', 'Quarter'], 'full');
const resScale = (v: unknown) => [1, 0.5, 0.25][Math.max(0, RES_OPTIONS.indexOf(String(v)))] ?? 1;

/** How far rays reach outside the layer (layer px): a pixel at radius r extends to r / (1 − length). */
function rayPadding(p: EffectParams, ctx: FxPlanContext): number {
	const len = num(p.raysLength, 0.25) * Math.max(...rgbMult(p, 'lengthRed', 'lengthGreen', 'lengthBlue'));
	const c = Array.isArray(p.center) ? p.center.map((x) => num(x, 0.5)) : [0.5, 0.5];
	const r = Math.hypot(Math.max(c[0]!, 1 - c[0]!) * ctx.width, Math.max(c[1]!, 1 - c[1]!) * ctx.height);
	const reach = len > 0 ? (r * Math.min(len, 0.98)) / (1 - Math.min(len, 0.98)) : 0;
	return Math.min(reach, Math.max(ctx.width, ctx.height) * 0.5) + num(p.blurRays) * unitPx(ctx.width) * 3;
}

const rayParams = (brightness: number): ParamSpec[] => [
	fxParam.point('center', 'Center', [0.5, 0.5]),
	fxParam.number('raysLength', 'Rays Length', 0.25, { min: -5, max: 3, step: 0.001 }),
	slider('lengthRed', 'Length Red', 1, { softMax: 2 }),
	slider('lengthGreen', 'Length Green', 1, { softMax: 2 }),
	slider('lengthBlue', 'Length Blue', 1, { softMax: 2 }),
	slider('reverseRays', 'Reverse Rays', 0, { softMax: 1 }),
	slider('raysBrightness', 'Rays Brightness', brightness, { softMax: 10 }),
];

const shimmerParams = (): ParamSpec[] => [
	slider('shimmerAmp', 'Shimmer Amp', 0.5, { softMax: 2 }),
	slider('shimmerFreq', 'Shimmer Freq', 40, { softMax: 200 }),
	slider('shimmerSeed', 'Shimmer Seed', 0.123, { softMax: 1 }),
	fxParam.vec2('shimmerShift', 'Shimmer Shift', [0, 0], { step: 0.001 }),
	fxParam.vec2('shimmerSpeed', 'Shimmer Speed', [0, 0], { step: 0.001 }),
	slider('atmosphereAmp', 'Atmosphere Amp', 0, { softMax: 2 }),
	slider('atmosphereFreq', 'Atmosphere Freq', 1, { min: 0.1, max: 20, softMax: 20 }),
	slider('atmosphereDetail', 'Atmosphere Detail', 0.6, { max: 1, softMax: 1 }),
	fxParam.number('atmosphereSpeed', 'Atmosphere Speed', 1, { softMin: -2, softMax: 2, step: 0.01 }),
];

/** Shimmer: noise modulating the ray source (smeared into streaky beams by the radial passes). */
const SHIMMER_GLSL = /* glsl */ `
float shimmer() {
  vec2 n = fx_layerNorm();
  vec2 q = vec2(n.x, n.y * u_box.w / u_box.z) * u_shimmerFreq * 0.5 + u_shimmerShift * u_shimmerFreq + u_shimmerSpeed * u_shimmerFreq * u_time;
  float sh = fx_noise01(fx_simplex(q, fract(u_shimmerSeed)) * 1.3);
  return max(0.0, 1.0 + u_shimmerAmp * (sh * 2.0 - 1.0));
}`;

const RAY_ATMOSPHERE = /* glsl */ `
  light *= sgl_atmosphere(fx_layerNorm(), u_box.w / u_box.z, u_atmosphereAmp, u_atmosphereFreq, u_atmosphereDetail, 0.123, u_time * u_atmosphereSpeed);`;

/** Ray passes: source (`raySrc`, at the Rays Res) → 3 radial passes (r1…r3) → optional Blur Rays (rb0). */
function rayPipeline(p: EffectParams, ctx: FxPlanContext, sourceFrag: string, final: (rays: string) => ShaderPass): ShaderPass[] {
	const scale = resScale(p.raysRes);
	const blur = num(p.blurRays) * unitPx(ctx.width) * ctx.pxScale * 0.5;
	const rel = Array.isArray(p.blurRaysRel) ? p.blurRaysRel.map((x) => Math.max(0, num(x, 1))) : [1, 1];
	const b = blur > 0.25 ? glowCascade({ input: 'r3', prefix: 'rb', sigmaX: blur * rel[0]!, sigmaY: blur * rel[1]!, levels: 1, inputDown: 1 / scale }) : null;
	return [
		{
			output: 'raySrc',
			scale,
			format: 'rgba16f',
			include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_NOISE],
			uniforms: { u_rd: 1 / scale },
			frag: sourceFrag,
		},
		...rayPasses('raySrc', 'r', scale),
		...(b?.passes ?? []),
		final(b ? 'rb0' : 'r3'),
	];
}

const rayUniformsOf = (p: EffectParams) =>
	rayUniforms(
		num(p.raysLength, 0.25),
		rgbMult(p, 'lengthRed', 'lengthGreen', 'lengthBlue'),
		num(p.reverseRays),
		num(p.biasOuterBright),
	);

export const S_RAYS = defineShaderEffect({
	id: 'jasper.s.rays',
	label: 'S_Rays',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Light beams cast radially from Center out of the pixels brighter than Threshold (god rays). Rays Length 1 = endless rays; negative lengths beam inwards. Dark Rays mode casts shadows instead.',
	keywords: ['god rays', 'light rays', 'volumetric', 'beams', 'sapphire'],
	expensive: true,
	params: [
		fxParam.choice('mode', 'Mode', ['lightRays', 'darkRays'], ['Light Rays', 'Dark Rays'], 'lightRays'),
		...rayParams(3),
		slider('raysDarkness', 'Rays Darkness', 3, { softMax: 10 }),
		slider('blurRays', 'Blur Rays', 0, { softMax: 1 }),
		fxParam.vec2('blurRaysRel', 'Blur Rays Rel', [1, 1], { min: 0, step: 0.01 }),
		fxParam.color('raysColor', 'Rays Color', white),
		fxParam.color('darkRaysColor', 'Dark Rays Color', black),
		slider('biasOuterBright', 'Bias Outer Bright', 0, { max: 1, softMax: 1 }),
		resChoice('raysRes', 'Rays Res'),
		...thresholdParams(0.5),
		...shimmerParams(),
		...lightTail('Rays'),
		slider('useSourceChroma', 'Use Source Chroma', 1, { max: 1, softMax: 1 }),
	],
	gpu: {
		padding: rayPadding,
		uniforms: (p) => rayUniformsOf(p),
		passes: (p, ctx) =>
			rayPipeline(
				p,
				ctx,
				/* glsl */ `${THRESHOLD_SOURCE}
${SHIMMER_GLSL}
void main() {
  vec4 s = sgl_boxRead(u_source, v_uv, u_rd);
  vec3 b;
  if (u_mode == 1) {
    vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
    b = sgl_threshold(1.0 - mix(c, vec3(1.0), clamp(u_fromAlpha, 0.0, 1.0)), 1.0 - u_threshold, u_thresholdAddColor.rgb) * s.a;
  } else {
    b = sgl_thresholdSource(s).rgb;
  }
  b = mix(vec3(fx_luma(b)), b, clamp(u_useSourceChroma, 0.0, 1.0)) * shimmer();
  fragColor = vec4(b, sgl_maxc(b));
}`,
				(rays) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 r = texture(u_${rays}, v_uv);
  if (u_mode == 1) {
    float dk = 1.0 - exp(-sgl_maxc(r.rgb) * u_raysDarkness * 0.6);
    vec4 base = src * clamp(u_sourceOpacity, 0.0, 1.0);
    base.rgb *= u_bgBrightness;
    vec4 res = vec4(mix(base.rgb, u_darkRaysColor.rgb * base.a, dk), base.a);
    fragColor = mix(res, src, clamp(u_underSource, 0.0, 1.0) * step(0.5, src.a));
    return;
  }
  vec3 light = r.rgb * u_raysColor.rgb * u_raysBrightness;
  ${RAY_ATMOSPHERE}
  fragColor = sgl_finishLight(src, light, 2, u_affectAlpha, u_underSource, 0.0, u_sourceOpacity, u_bgBrightness);
}`,
				}),
			),
	},
});

export const S_EDGE_RAYS = defineShaderEffect({
	id: 'jasper.s.edge-rays',
	label: 'S_EdgeRays',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Light beams cast radially from Center out of the extracted edges of the image (no threshold): outlines and text throw rays.',
	keywords: ['edge rays', 'god rays', 'beams', 'outline', 'sapphire'],
	expensive: true,
	params: [
		...rayParams(2),
		slider('blurRays', 'Blur Rays', 0, { softMax: 1 }),
		fxParam.vec2('blurRaysRel', 'Blur Rays Rel', [1, 1], { min: 0, step: 0.01 }),
		fxParam.color('raysColor', 'Rays Color', white),
		fxParam.toggle('enableDarkRays', 'Enable Dark Rays', false),
		slider('biasOuterBright', 'Bias Outer Bright', 0, { max: 1, softMax: 1 }),
		resChoice('raysRes', 'Rays Res'),
		showChoice(['Result', 'Edges', 'Rays']),
		slider('edgeThickness', 'Edge Thickness', 0.022, { softMax: 0.2 }),
		slider('edgeBrightness', 'Edge Brightness', 1, { softMax: 4 }),
		...shimmerParams(),
		...lightTail('Rays'),
	],
	gpu: {
		padding: rayPadding,
		uniforms: (p, ctx) => ({
			...rayUniformsOf(p),
			u_edgeR: Math.max(0.5, num(p.edgeThickness, 0.022) * unitPx(ctx.width) * 0.5) * ctx.pxScale,
		}),
		passes: (p, ctx) =>
			rayPipeline(
				p,
				ctx,
				/* glsl */ `${EDGE_RAY_GLSL}
${SHIMMER_GLSL}
void main() {
  vec3 e = edgeLight(v_uv, max(u_edgeR, u_rd * 0.5));
  e *= shimmer();
  fragColor = vec4(e, sgl_maxc(e));
}`,
				(rays) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `${EDGE_RAY_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  if (u_show == 1) { fragColor = vec4(min(edgeLight(v_uv, u_edgeR), 1.0), 1.0); return; }
  vec4 r = texture(u_${rays}, v_uv);
  vec3 light = r.rgb * u_raysColor.rgb * u_raysBrightness;
  ${RAY_ATMOSPHERE}
  if (u_show == 2) { fragColor = vec4(min(light, 1.0), 1.0); return; }
  if (u_enableDarkRays) src.rgb *= 1.0 - clamp(fx_luma(r.rgb) * u_raysBrightness * 0.5, 0.0, 0.8);
  fragColor = sgl_finishLight(src, light, 2, u_affectAlpha, u_underSource, 0.0, u_sourceOpacity, u_bgBrightness);
}`,
				}),
			),
	},
});

/** Edges (Sobel of luminance + alpha at radius r canvas px, mirrored at the layer box) × the source colour. */
const EDGE_RAY_GLSL = /* glsl */ `
vec4 sgl_layerRead(vec2 uv) {
  vec2 n = sgl_mirrorNorm((uv * u_canvasSize - u_box.xy) / u_box.zw);
  return texture(u_source, fx_uvOfLayerNorm(n));
}
float eL(vec2 uv) { vec4 s = sgl_layerRead(uv); return fx_luma(s.rgb) * 0.7 + s.a * 0.3; }
vec3 edgeLight(vec2 uv, float r) {
  vec2 o = r / u_canvasSize;
  float gx = eL(uv + vec2(o.x, 0.0)) - eL(uv - vec2(o.x, 0.0));
  float gy = eL(uv + vec2(0.0, o.y)) - eL(uv - vec2(0.0, o.y));
  float e = clamp(length(vec2(gx, gy)) * 2.0, 0.0, 1.0);
  vec4 s = sgl_layerRead(uv);
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(1.0);
  return e * mix(vec3(1.0), c, 0.6) * u_edgeBrightness;
}`;

export const S_STREAKS = defineShaderEffect({
	id: 'jasper.s.streaks',
	label: 'S_Streaks',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Smears the bright parts into streaks between two transforms (From and To: zoom by Z Dist, rotate and shift about Center) — zoom, spin and motion streaks, not time based.',
	keywords: ['streaks', 'zoom streaks', 'motion', 'light trails', 'sapphire'],
	expensive: true,
	params: [
		fxParam.point('center', 'Center', [0.5, 0.5]),
		slider('fromZDist', 'From Z Dist', 1, { min: 0.001, softMax: 4 }),
		fxParam.angle('fromRotate', 'From Rotate', 0),
		fxParam.vec2('fromShift', 'From Shift', [0, 0], { step: 0.001 }),
		slider('toZDist', 'To Z Dist', 0.8, { min: 0.001, softMax: 4 }),
		fxParam.angle('toRotate', 'To Rotate', 0),
		fxParam.vec2('toShift', 'To Shift', [0, 0], { step: 0.001 }),
		slider('exposureBias', 'Exposure Bias', 0, { max: 1, softMax: 1 }),
		slider('streaksBrightness', 'Streaks Brightness', 1, { softMax: 8 }),
		...thresholdParams(0.5),
		slider('mixSourceDarks', 'Mix Source Darks', 1, { max: 1, softMax: 1 }),
		slider('mixSourceBrights', 'Mix Source Brights', 0, { max: 1, softMax: 1 }),
		slider('resultBrightness', 'Result Brightness', 1, { softMax: 4 }),
		combineChoice(['Add', 'Screen'], 'Add'),
		fxParam.choice('wrap', 'Wrap', ['no', 'tile', 'reflect'], ['No', 'Tile', 'Reflect'], 'no'),
		resChoice('streaksRes', 'Streaks Res'),
		slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }),
	],
	gpu: {
		padding: (p, ctx) => {
			const s = Math.max(1 / Math.max(0.001, num(p.fromZDist, 1)), 1 / Math.max(0.001, num(p.toZDist, 0.8)));
			const sh = (v: unknown) => (Array.isArray(v) ? Math.hypot(num(v[0]), num(v[1])) : 0) * ctx.width;
			return Math.min(Math.max(ctx.width, ctx.height), Math.max(0, s - 1) * 0.6 * Math.max(ctx.width, ctx.height) + Math.max(sh(p.fromShift), sh(p.toShift)));
		},
		uniforms: (p, ctx) => {
			// Similarity transforms (complex a = scale·e^{iθ}, shift b in layer px, y down) of From and To.
			const ln = (z: unknown, d: number) => Math.log(1 / Math.max(0.001, num(z, d)));
			const sh = (v: unknown): [number, number] =>
				Array.isArray(v) ? [num(v[0]) * ctx.width, -num(v[1]) * ctx.width] : [0, 0];
			return {
				u_mode: combineMode(p.combine, ['Add', 'Screen'], 'Add'),
				u_fromA: [ln(p.fromZDist, 1), (num(p.fromRotate) * Math.PI) / 180],
				u_toA: [ln(p.toZDist, 0.8), (num(p.toRotate) * Math.PI) / 180],
				u_fromB: sh(p.fromShift),
				u_toB: sh(p.toShift),
				u_ek: (0.5 - clamp(num(p.exposureBias), 0, 1)) * 6,
			};
		},
		passes: (p) => {
			const scale = resScale(p.streaksRes);
			return [
				{
					output: 'sb',
					scale,
					format: 'rgba16f',
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH],
					uniforms: { u_rd: 1 / scale },
					frag: /* glsl */ `
void main() {
  vec4 s = sgl_boxRead(u_source, v_uv, u_rd);
  vec3 b = sgl_threshold(s.rgb, u_threshold, u_thresholdAddColor.rgb);
  fragColor = vec4(b, sgl_maxc(b));
}`,
				},
				{
					output: 'st',
					scale,
					format: 'rgba16f',
					include: [GLSL_SGL_CORE],
					frag: /* glsl */ `
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cexpLog(vec2 l) { return exp(l.x) * vec2(cos(l.y), sin(l.y)); }
vec4 readB(vec2 lpx) {
  vec2 n = lpx / (u_box.zw / u_pxScale);
  if (u_wrap == 1) n = fract(n);
  else if (u_wrap == 2) n = sgl_mirrorNorm(n);
  else if (any(lessThan(n, vec2(-0.02))) || any(greaterThan(n, vec2(1.02)))) return vec4(0.0);
  return texture(u_sb, fx_uvOfLayerNorm(n));
}
void main() {
  vec2 c = u_center * u_box.zw / u_pxScale;
  vec2 p = fx_layerPx() - c;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 64; i++) {
    float t = (float(i) + 0.5) / 64.0;
    vec2 la = mix(u_fromA, u_toA, t);
    vec2 b = mix(u_fromB, u_toB, t);
    // inverse similarity: q = (p − b) / a
    vec2 a = cexpLog(la);
    vec2 q = cmul(p - b, vec2(a.x, -a.y)) / max(dot(a, a), 1.0e-8);
    float w = exp(-u_ek * t);
    acc += readB(q + c) * w;
    ws += w;
  }
  fragColor = acc / ws;
}`,
				},
				{
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 st = texture(u_st, v_uv).rgb * u_streaksBrightness * 2.0;
  float bright = clamp(sgl_maxc(sgl_threshold(src.rgb, u_threshold, u_thresholdAddColor.rgb)) * 2.0, 0.0, 1.0);
  vec4 base = src * mix(u_mixSourceDarks, u_mixSourceBrights, bright);
  vec3 rgb = sgl_combineRgb(u_mode, base.rgb, st) * u_resultBrightness;
  float a = max(base.a, clamp(sgl_maxc(st) * u_affectAlpha, 0.0, 1.0));
  rgb = clamp(rgb, 0.0, 1.0);
  fragColor = vec4(rgb, clamp(max(a, sgl_maxc(rgb)), 0.0, 1.0));
}`,
				},
			];
		},
	},
});

export const SGL_BEAM_EFFECTS: readonly EffectSpec[] = [S_RAYS, S_EDGE_RAYS, S_STREAKS];

// ================================================================ Lens flares

const lensChoice = () =>
	fxParam.choice(
		'lens',
		'Lens',
		FLARE_LENSES.map((l) => l.value),
		FLARE_LENSES.map((l) => l.label),
		FLARE_LENSES[0]!.value,
	);

const FLARE_COMBINE = ['Screen', 'Add', 'Flare Only'] as const;

/** The flare controls shared by S_LensFlare and S_LensFlareAutoTrack (Sapphire order, after the hotspot/pivot). */
const flareLookParams = (): ParamSpec[] => [
	slider('brightness', 'Brightness', 1, { softMax: 4 }),
	fxParam.color('color', 'Color', white),
	slider('gamma', 'Gamma', 1, { min: 0.1, softMax: 4 }),
	fxParam.number('saturation', 'Saturation', 1, { min: -2, max: 8, step: 0.01 }),
	fxParam.number('hueShift', 'Hue Shift', 0, { softMin: -1, softMax: 1, step: 0.001 }),
	slider('hotspotBright', 'Hotspot Bright', 1, { softMax: 4 }),
	fxParam.color('hotspotColor', 'Hotspot Color', white),
	slider('raysBrightness', 'Rays Brightness', 1, { softMax: 4 }),
	slider('raysNumScale', 'Rays Num Scale', 1, { min: 0.05, softMax: 4 }),
	slider('raysLength', 'Rays Length', 1, { softMax: 4 }),
	slider('raysThickness', 'Rays Thickness', 1, { min: 0.05, softMax: 4 }),
	slider('otherBrightness', 'Other Brightness', 1, { softMax: 4 }),
	fxParam.color('otherColor', 'Other Color', white),
	slider('otherWidth', 'Other Width', 1, { softMax: 4 }),
	...atmosphereParams(),
	slider('flickerAmp', 'Flicker Amp', 0, { softMax: 1 }),
	slider('flickerSpeed', 'Flicker Speed', 1, { softMax: 10 }),
	slider('flickerRandomness', 'Flicker Randomness', 0.6, { max: 1, softMax: 1 }),
	slider('blurFlare', 'Blur Flare', 0, { softMax: 1 }),
	slider('bgBrightness', 'Bg Brightness', 1, { softMax: 2 }),
	combineChoice(FLARE_COMBINE, 'Screen'),
	slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }),
	// Edge Triggers: the flare grows/brightens as its hotspot nears the frame edges or the pivot.
	slider('edgeWidth', 'Edge Width', 0.3, { max: 1, softMax: 1 }, { group: 'triggers' }),
	slider('edgeFalloff', 'Edge Falloff', 2, { min: 0.01, softMax: 8 }, { group: 'triggers' }),
	fxParam.number('shiftOut', 'Shift Out', 0, { softMin: -1, softMax: 1, step: 0.001 }, { group: 'triggers' }),
	fxParam.toggle('oneWay', 'One Way', false, { group: 'triggers' }),
	slider('edgeScaleBrightness', 'Edge Scale Brightness', 1.5, { softMax: 4 }, { group: 'triggers' }),
	slider('edgeScaleWidths', 'Edge Scale Widths', 1.2, { softMax: 4 }, { group: 'triggers' }),
	slider('centerRadius', 'Center Radius', 0.3, { softMax: 1 }, { group: 'triggers' }),
	slider('centerFalloff', 'Center Falloff', 1, { min: 0.01, softMax: 8 }, { group: 'triggers' }),
	slider('centerScaleBrightness', 'Center Scale Brightness', 1.5, { softMax: 4 }, { group: 'triggers' }),
	slider('centerScaleWidths', 'Center Scale Widths', 1.2, { softMax: 4 }, { group: 'triggers' }),
	// Occlusion: an optional clip (e.g. a matte of the foreground) hides the flare when it covers the hotspot.
	fxParam.media('occlusion', 'Occlusion', ['image', 'video'], { group: 'occlusion' }),
	slider('occlusionSoftness', 'Occlusion Softness', 0.0224, { softMax: 0.5 }, { group: 'occlusion' }),
	fxParam.choice('occlusionFrom', 'Occlusion From', ['none', 'luma', 'alpha'], ['None', 'Luma', 'Alpha'], 'alpha', {
		group: 'occlusion',
	}),
	fxParam.toggle('invertOcclusion', 'Invert Occlusion', false, { group: 'occlusion' }),
	fxParam.toggle('useColor', 'Use Color', true, { group: 'occlusion' }),
	slider('occlusionScaleBrightness', 'Occlusion Scale Brightness', 1, { softMax: 4 }, { group: 'occlusion' }),
	slider('occlusionScaleWidths', 'Occlusion Scale Widths', 1, { softMax: 4 }, { group: 'occlusion' }),
];

/**
 * GLSL of a flare final pass: `vec3 flareFrom(vec2 px, vec2 lightUv, vec2 pivotUv, vec3 tint)` = one whole flare
 * with every look control, edge/centre triggers and occlusion applied (needs the lens chunk).
 */
const FLARE_GLSL = /* glsl */ `
vec3 flareFrom(vec2 px, vec2 lightUv, vec2 pivotUv, vec3 extraTint) {
  vec2 hn = (lightUv * u_canvasSize - u_box.xy) / u_box.zw;
  vec2 pn = (pivotUv * u_canvasSize - u_box.xy) / u_box.zw;
  float ar = u_box.w / u_box.z;
  // Edge and centre triggers.
  vec2 e2 = abs(hn * 2.0 - 1.0);
  if (u_oneWay) e2 = max(hn * 2.0 - 1.0, 0.0);
  float re = max(e2.x, e2.y) + u_shiftOut;
  float ez = pow(clamp((re - (1.0 - u_edgeWidth)) / max(u_edgeWidth, 1.0e-3), 0.0, 1.0), max(u_edgeFalloff, 0.01));
  float dc = length((hn - pn) * vec2(1.0, ar));
  float cz = pow(clamp(1.0 - dc / max(u_centerRadius, 1.0e-3), 0.0, 1.0), max(u_centerFalloff, 0.01));
  float bM = mix(1.0, u_edgeScaleBrightness, ez) * mix(1.0, u_centerScaleBrightness, cz);
  float wM = mix(1.0, u_edgeScaleWidths, ez) * mix(1.0, u_centerScaleWidths, cz);
  // Occlusion by the Occlusion clip at the hotspot (soft: 9 taps over Occlusion Softness).
  vec3 occTint = vec3(1.0);
  if (u_occlusion_size.x > 0.0 && u_occlusionFrom != 0) {
    vec2 rad = vec2(1.0, 1.0 / ar) * max(u_occlusionSoftness, 1.0e-4) * 0.1;
    float occ = 0.0;
    vec3 oc = vec3(0.0);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec4 t = texture(u_occlusion, clamp(hn + vec2(float(x), float(y)) * rad, 0.0, 1.0));
        float v = u_occlusionFrom == 2 ? t.a : fx_luma(t.rgb);
        occ += v;
        oc += t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
      }
    occ /= 9.0;
    if (u_invertOcclusion) occ = 1.0 - occ;
    float vis = 1.0 - clamp(occ, 0.0, 1.0);
    bM *= vis * mix(u_occlusionScaleBrightness, 1.0, vis);
    wM *= mix(u_occlusionScaleWidths, 1.0, vis);
    if (u_useColor) occTint = mix(vec3(1.0), oc / 9.0, clamp(occ, 0.0, 1.0) * (1.0 - step(0.999, occ)));
  }
  vec3 cls[3];
  cls[0] = vec3(u_hotspotBright, 1.0, 0.0);
  cls[1] = vec3(u_raysBrightness, 1.0, 0.0);
  cls[2] = vec3(u_otherBrightness, u_otherWidth, 0.0);
  vec3 tint[3];
  tint[0] = u_hotspotColor.rgb;
  tint[1] = vec3(1.0);
  tint[2] = u_otherColor.rgb;
  vec4 rays = vec4(u_raysNumScale, u_raysLength, u_raysThickness, radians(u_raysRotate));
  float unit = length(u_box.zw);
  vec3 f = sgl_flare(px, lightUv * u_canvasSize, pivotUv * u_canvasSize, unit, u_scaleWidths * wM, u_relHeights,
                     cls, tint, rays, u_blurFlare);
  f *= u_color.rgb * u_brightness * bM * occTint * extraTint;
  // Flicker: a smooth wobble, more random with Flicker Randomness.
  if (u_flickerAmp > 0.0) {
    float t = u_time * u_flickerSpeed;
    float fl = mix(sin(t * 6.2831853 * 1.3), fx_valueNoise(vec2(t * 4.0, 0.5), 0.71), clamp(u_flickerRandomness, 0.0, 1.0));
    f *= max(0.0, 1.0 + u_flickerAmp * fl);
  }
  f *= sgl_atmosphere(fx_layerNorm(), ar, u_atmosphereAmp, u_atmosphereFreq, u_atmosphereDetail, u_atmosphereSeed, u_time * u_atmosphereSpeed);
  // Colour: Gamma, Saturation, Hue Shift (revolutions).
  f = pow(max(f, 0.0), vec3(1.0 / max(u_gamma, 0.1)));
  f = fx_saturate(f, u_saturation);
  if (u_hueShift != 0.0) f = fx_hueShift(f, u_hueShift);
  return max(f, 0.0);
}`;

const flareFinish = (light: string) => /* glsl */ `
  fragColor = sgl_finishLight(src, ${light}, u_mode, u_affectAlpha, 0.0, 0.0, 1.0, u_bgBrightness);`;

export const S_LENS_FLARE = defineShaderEffect({
	id: 'jasper.s.lens-flare',
	label: 'S_LensFlare',
	category: 'Generate',
	bin: SGL_BIN,
	description:
		'A lens flare: hotspot glow, rays and a chain of ghosts, rings and hoops laid out on the line from the Hotspot through the Pivot. Built-in lenses (zoom, primes, anamorphic streaks, rays only, hexagonal irises…); edge/centre triggers and an optional occlusion clip.',
	keywords: ['flare', 'lens flare', 'anamorphic', 'sun', 'ghosts', 'sapphire'],
	params: [
		lensChoice(),
		slider('scaleWidths', 'Scale Widths', 1.15, { softMax: 4 }),
		slider('relHeights', 'Rel Heights', 1, { min: 0.01, softMax: 4 }),
		fxParam.angle('raysRotate', 'Rays Rotate', 0),
		fxParam.point('hotspot', 'Hotspot', sapphirePoint(-0.444, 0.176)),
		fxParam.point('pivot', 'Pivot', [0.5, 0.5]),
		...flareLookParams(),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({ u_mode: combineMode(p.combine, FLARE_COMBINE, 'Screen') }),
		passes: (p) => [
			{
				include: [flareChunk(lensOf(p.lens)), GLSL_SGL_FINISH, GLSL_COLOR],
				frag: /* glsl */ `${FLARE_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 light = flareFrom(fx_canvasPx(), fx_uvOfLayerNorm(u_hotspot), fx_uvOfLayerNorm(u_pivot), vec3(1.0));
  if (!fx_inBox(v_uv)) light = vec3(0.0);
  ${flareFinish('light')}
}`,
			},
		],
	},
});

export const S_LENS_FLARE_AUTO_TRACK = defineShaderEffect({
	id: 'jasper.s.lens-flare-auto-track',
	label: 'S_LensFlareAutoTrack',
	category: 'Generate',
	bin: SGL_BIN,
	description:
		'S_LensFlare whose hotspots follow the brightest areas of the clip automatically (up to 3, found on the GPU every frame from a blurred copy of the image; deterministic, no tracking pass needed).',
	keywords: ['flare', 'lens flare', 'auto track', 'tracking', 'sapphire'],
	expensive: true,
	params: [
		lensChoice(),
		slider('scaleWidths', 'Scale Widths', 1.15, { softMax: 4 }),
		slider('relHeights', 'Rel Heights', 1, { min: 0.01, softMax: 4 }),
		fxParam.angle('raysRotate', 'Rays Rotate', 0),
		fxParam.number('maxHotspots', 'Max Hotspots', 1, { min: 1, max: 3, step: 1 }, { animatable: false }),
		slider('hotspotThreshold', 'Hotspot Threshold', 0.6, { max: 1, softMax: 1 }),
		fxParam.toggle('trackColor', 'Track Color', false),
		fxParam.vec2('hotspotShift', 'Hotspot Shift', [0, 0], { step: 0.001 }),
		fxParam.point('pivot', 'Pivot', [0.5, 0.5]),
		slider('blurForAuto', 'Blur For Auto', 0.056, { softMax: 0.5 }),
		...flareLookParams(),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({
			u_mode: combineMode(p.combine, FLARE_COMBINE, 'Screen'),
			u_trackBlur: num(p.blurForAuto, 0.056) * unitPx(ctx.width) * ctx.pxScale,
			u_shiftPx: Array.isArray(p.hotspotShift)
				? [num(p.hotspotShift[0]) * ctx.width * ctx.pxScale, -num(p.hotspotShift[1]) * ctx.width * ctx.pxScale]
				: [0, 0],
		}),
		passes: (p) => {
			const n = Math.max(1, Math.min(3, Math.round(num(p.maxHotspots, 1))));
			return [
				...trackPasses(n),
				{
					include: [flareChunk(lensOf(p.lens)), GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `${FLARE_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 light = vec3(0.0);
  ${Array.from(
		{ length: n },
		(_, k) => /* glsl */ `{
    vec4 h = texelFetch(u_tD${k}, ivec2(0), 0);
    if (h.z > 0.0) {
      vec2 luv = h.xy + u_shiftPx / u_canvasSize;
      vec3 tint = vec3(h.z);
      if (u_trackColor) { vec4 c = texture(u_source, h.xy); vec3 cc = c.a > 0.0 ? c.rgb / c.a : vec3(1.0); tint *= cc / max(sgl_maxc(cc), 1.0e-3); }
      light += flareFrom(fx_canvasPx(), luv, fx_uvOfLayerNorm(u_pivot), tint);
    }
  }`,
	).join('\n  ')}
  if (!fx_inBox(v_uv)) light = vec3(0.0);
  ${flareFinish('light')}
}`,
				},
			];
		},
	},
});

/** One S_LightLeak element's params (Sapphire "ElementN" group). */
function leakElementParams(
	n: number,
	d: {
		on: boolean;
		size: number;
		relH: number;
		bright: number;
		center: [number, number];
		outer: [number, number, number];
		mid: [number, number, number];
		inner: [number, number, number];
		amp: number;
		freq: number;
		boil: number;
	},
): ParamSpec[] {
	const g = { group: `element${n}` };
	const rgba = (c: [number, number, number]): [number, number, number, number] => [...c, 1];
	return [
		fxParam.toggle(`element${n}Enable`, `Element${n} Enable`, d.on, g),
		slider(`size${n}`, `Size${n}`, d.size, { softMax: 8 }, g),
		slider(`relHeight${n}`, `Rel Height${n}`, d.relH, { min: 0.01, softMax: 8 }, g),
		slider(`brightness${n}`, `Brightness${n}`, d.bright, { softMax: 4 }, g),
		slider(`speed${n}`, `Speed${n}`, 1, { min: -10, softMin: -4, softMax: 4 }, g),
		fxParam.angle(`angle${n}`, `Angle${n}`, 175, g),
		fxParam.point(`center${n}`, `Center${n}`, sapphirePoint(d.center[0], d.center[1]), g),
		fxParam.color(`outerColor${n}`, `Outer Color${n}`, rgba(d.outer), g),
		fxParam.color(`midColor${n}`, `Mid Color${n}`, rgba(d.mid), g),
		fxParam.color(`centerColor${n}`, `Center Color${n}`, rgba(d.inner), g),
		slider(`midpoint${n}`, `Midpoint${n}`, 0.5, { max: 1, softMax: 1 }, g),
		slider(`softness${n}`, `Softness${n}`, 0.4, { max: 1, softMax: 1 }, g),
		slider(`noiseAmp${n}`, `Noise Amp${n}`, d.amp, { softMax: 4 }, g),
		slider(`noiseFreq${n}`, `Noise Freq${n}`, d.freq, { softMax: 10 }, g),
		slider(`noiseFreqRelY${n}`, `Noise Freq Rel Y${n}`, 1, { min: 0.02, softMax: 4 }, g),
		slider(`noiseDetail${n}`, `Noise Detail${n}`, 0, { max: 1, softMax: 1 }, g),
		slider(`noiseBoilSpeed${n}`, `Noise Boil Speed${n}`, d.boil, { softMax: 4 }, g),
	];
}

const LEAK_COMBINE = ['Screen', 'Add', 'Leaks Only'] as const;

/** GLSL of leak element n (uses its params): premultiplied-free RGB light at layer-normalised point. */
const leakElementGlsl = (n: number) => /* glsl */ `
vec3 leak${n}(vec2 nrm, float ar, float t) {
  if (!u_element${n}Enable) return vec3(0.0);
  float a = radians(u_angle${n});
  vec2 dir = vec2(cos(a), -sin(a) / ar);
  vec2 c = u_center${n} + u_shift * vec2(1.0, 1.0 / ar) + dir * u_speed * u_speed${n} * t * 0.05;
  c += u_randomMotion * 0.1 * vec2(fx_simplex(vec2(t * u_randomFrequency * 0.25, ${n}.5), u_seed), fx_simplex(vec2(${n}.5, t * u_randomFrequency * 0.25), u_seed)) * vec2(1.0, 1.0 / ar);
  vec2 d = (nrm - c) * vec2(1.0, ar);
  vec2 rad = vec2(1.0, max(u_relHeight${n}, 0.01)) * max(u_size${n}, 1.0e-3) * 0.25;
  vec2 q = d / rad;
  // Noise distortion of the blob (boiling with time).
  int oct = 1 + int(u_noiseDetail${n} * 5.0);
  vec2 f = vec2(u_noiseFreq${n}, u_noiseFreq${n} * u_noiseFreqRelY${n});
  vec2 w = vec2(fx_fbm3(vec3(q * f * 0.5, t * u_noiseBoilSpeed${n} * 0.3), oct, 2.0, 0.5, fract(u_seed + ${n}.0 * 0.17)),
                fx_fbm3(vec3(q * f * 0.5 + 17.3, t * u_noiseBoilSpeed${n} * 0.3), oct, 2.0, 0.5, fract(u_seed + ${n}.0 * 0.31)));
  q += w * u_noiseAmp${n} * 0.35;
  float r = length(q);
  float m = clamp(u_midpoint${n}, 0.01, 0.99);
  vec3 col = r < m ? mix(u_centerColor${n}.rgb, u_midColor${n}.rgb, r / m) : mix(u_midColor${n}.rgb, u_outerColor${n}.rgb, clamp((r - m) / (1.0 - m), 0.0, 1.0));
  float soft = max(u_softness${n}, 0.01);
  float k = 1.0 - smoothstep(1.0 - soft, 1.0 + soft * 0.5, r);
  return col * k * u_brightness${n};
}`;

export const S_LIGHT_LEAK = defineShaderEffect({
	id: 'jasper.s.light-leak',
	label: 'S_LightLeak',
	category: 'Generate',
	bin: SGL_BIN,
	description:
		'Film light leaks: up to three soft gradient blobs of light, distorted by boiling noise, drifting across the frame (each passes its Center at the middle of the clip), with flicker and a glow on the result.',
	keywords: ['light leak', 'film burn', 'leak', 'vintage', 'sapphire'],
	expensive: true,
	params: [
		slider('scaleLights', 'Scale Lights', 1, { softMax: 4 }),
		fxParam.number('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2, step: 0.01 }),
		fxParam.color('color', 'Color', white),
		fxParam.number('hueShift', 'Hue Shift', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		fxParam.number('saturation', 'Saturation', 1, { min: -2, max: 8, step: 0.01 }),
		slider('gamma', 'Gamma', 1, { min: 0.1, softMax: 4 }),
		fxParam.number('speed', 'Speed', 1, { softMin: -4, softMax: 4, step: 0.01 }),
		fxParam.vec2('shift', 'Shift', [0, 0], { step: 0.001 }),
		slider('flickerAmp', 'Flicker Amp', 0.2, { softMax: 1 }),
		slider('flickerFreq', 'Flicker Freq', 4, { softMax: 20 }),
		slider('randomMotion', 'Random Motion', 0, { softMax: 4 }),
		slider('randomFrequency', 'Random Frequency', 4, { softMax: 20 }),
		slider('seed', 'Seed', 0.123, { softMax: 1 }),
		slider('bgBrightness', 'Bg Brightness', 1, { softMax: 2 }),
		combineChoice(LEAK_COMBINE, 'Screen'),
		slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }),
		slider('glowBrightness', 'Glow Brightness', 1, { softMax: 4 }),
		slider('glowWidth', 'Glow Width', 0.4, { softMax: 2 }),
		slider('glowThreshold', 'Glow Threshold', 0.8, { max: 1, softMax: 1 }),
		...leakElementParams(1, { on: true, size: 2, relH: 2, bright: 0.2, center: [0, 0], outer: [1, 1, 0.15], mid: [1, 0.7, 0.3], inner: [1, 0.1, 0], amp: 2, freq: 1.5, boil: 1 }),
		...leakElementParams(2, { on: false, size: 2, relH: 2, bright: 1, center: [-0.5, -0.5], outer: [0.25, 0.15, 0.1], mid: [0.7, 0.12, 0.22], inner: [1, 1, 1], amp: 1, freq: 3, boil: 0 }),
		...leakElementParams(3, { on: false, size: 0.25, relH: 1, bright: 1, center: [0.5, 0.5], outer: [0.2, 0.2, 0], mid: [0.55, 0.4, 0], inner: [1, 0.7, 0], amp: 0.5, freq: 1, boil: 0 }),
	],
	gpu: {
		uniforms: (p, ctx) => ({
			u_mode: combineMode(p.combine, LEAK_COMBINE, 'Screen'),
			// seconds from the middle of the clip: each element passes its Center at the clip's midpoint
			u_tMid: (ctx.frame - (ctx.duration - 1) / 2) / ctx.fps,
			...channelWeights(4, GLOW_SLOPE, [1, 1, 1], GLOW_GAIN),
		}),
		passes: (p, ctx) => [
			{
				output: 'leak',
				format: 'rgba16f',
				include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_NOISE],
				frag: /* glsl */ `
${leakElementGlsl(1)}
${leakElementGlsl(2)}
${leakElementGlsl(3)}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 n = fx_layerNorm();
  float ar = u_box.w / u_box.z;
  float t = u_tMid;
  vec3 l = leak1(n, ar, t) + leak2(n, ar, t) + leak3(n, ar, t);
  l = max(l * u_scaleLights + u_offsetDarks * 0.05, 0.0) * u_color.rgb;
  float fl = fx_valueNoise(vec2(u_time * u_flickerFreq, 3.7), u_seed);
  l *= max(0.0, 1.0 + u_flickerAmp * fl);
  l = pow(l, vec3(1.0 / max(u_gamma, 0.1)));
  l = fx_saturate(l, u_saturation);
  if (u_hueShift != 0.0) l = fx_hueShift(l, u_hueShift);
  if (!fx_inBox(v_uv)) l = vec3(0.0);
  fragColor = sgl_finishLight(src, l, u_mode, u_affectAlpha, 0.0, 0.0, 1.0, u_bgBrightness);
}`,
			},
			...glowPasses(
				/* glsl */ `
void main() {
  vec4 c = texture(u_leak, v_uv);
  vec3 b = sgl_threshold(c.rgb, u_glowThreshold, vec3(0.0));
  fragColor = vec4(b, sgl_maxc(b));
}`,
				glowSigma(p.glowWidth, ctx),
				1,
				1,
				(levels) => ({
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `
${glowSumGlsl('glowAt', levels)}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 c = texture(u_leak, v_uv);
  vec3 light = glowAt(v_uv) * u_glowBrightness;
  vec4 res = vec4(c.rgb + light, max(c.a, clamp(sgl_maxc(light) * u_affectAlpha, 0.0, 1.0)));
  res.rgb = clamp(res.rgb, 0.0, 1.0);
  res.a = clamp(max(res.a, sgl_maxc(res.rgb)), 0.0, 1.0);
  fragColor = fx_inBox(v_uv) || u_mode == 5 ? res : src;
}`,
				}),
				[],
				[],
				4,
			),
		],
	},
});

export const SGL_FLARE_EFFECTS: readonly EffectSpec[] = [S_LENS_FLARE, S_LENS_FLARE_AUTO_TRACK, S_LIGHT_LEAK];

// ================================================================ Glints and glares

/** Glint directions (screen degrees, y down): X, Y, Diag1, Diag2 (Swap Diagonals exchanges the diagonals). */
const GLINT_DIRS = [0, 90, -45, 45];

const glintCommon = (): ParamSpec[] => [
	slider('brightness', 'Brightness', 1, { softMax: 8 }),
	fxParam.number('hueShift', 'Hue Shift', 0, { min: -1, max: 1, step: 0.001 }),
	fxParam.color('scaleColors', 'Scale Colors', white),
	slider('brightnessX', 'Brightness X', 1, { softMax: 4 }),
	slider('brightnessY', 'Brightness Y', 1, { softMax: 4 }),
	slider('brightnessDiag1', 'Brightness Diag1', 1, { softMax: 4 }),
	slider('brightnessDiag2', 'Brightness Diag2', 1, { softMax: 4 }),
	...thresholdParams(0.7),
	slider('thresholdBlur', 'Threshold Blur', 0.0896, { softMax: 0.5 }),
	slider('size', 'Size', 2, { softMax: 8 }),
	slider('sizeX', 'Size X', 1, { softMax: 4 }),
	slider('sizeY', 'Size Y', 1, { softMax: 4 }),
	slider('sizeDiag1', 'Size Diag1', 0.75, { softMax: 4 }),
	slider('sizeDiag2', 'Size Diag2', 0.75, { softMax: 4 }),
];

const glintTail = (): ParamSpec[] => [
	slider('blurGlint', 'Blur Glint', 0, { softMax: 0.5 }),
	...lightTail('Glint'),
	expandBorders(),
	fxParam.toggle('swapDiagonals', 'Swap Diagonals', false),
];

/** Per-direction ray lengths (canvas px) and brightness, after Swap Diagonals. */
function glintDirs(p: EffectParams, ctx: FxPlanContext, chanMax: number) {
	const swap = p.swapDiagonals === true;
	const sizes = [num(p.sizeX, 1), num(p.sizeY, 1), num(p.sizeDiag1, 0.75), num(p.sizeDiag2, 0.75)];
	const bright = [num(p.brightnessX, 1), num(p.brightnessY, 1), num(p.brightnessDiag1, 1), num(p.brightnessDiag2, 1)];
	if (swap) {
		[sizes[2], sizes[3]] = [sizes[3]!, sizes[2]!];
		[bright[2], bright[3]] = [bright[3]!, bright[2]!];
	}
	const len = sizes.map((s) => Math.max(0, s) * Math.max(0, num(p.size, 2)) * unitPx(ctx.width) * ctx.pxScale * chanMax);
	return { len, bright };
}

const glintPadding = (p: EffectParams, ctx: FxPlanContext, chanMax: number) =>
	Math.max(...glintDirs(p, { ...ctx, pxScale: 1 }, chanMax).len) * 1.05;

/**
 * Glint passes: thresholded, blurred highlights at half resolution (`gb`) → per direction a dense two-sided smear
 * over 1/16 of the ray (`gs0…gs3`) → one pass summing 16 coarse taps per direction and side with the ray falloff
 * (`gl`, per-channel profiles from `profile` GLSL: `vec3 rayW(float k)`, k = 0…1 along the ray) → final.
 */
function glintPasses(p: EffectParams, ctx: FxPlanContext, chanMax: number, profile: string, final: ShaderPass): ShaderPass[] {
	const { len } = glintDirs(p, ctx, chanMax);
	const blur = num(p.thresholdBlur, 0.0896) * unitPx(ctx.width) * ctx.pxScale * 0.5;
	const perp = num(p.blurGlint) * unitPx(ctx.width) * ctx.pxScale * 0.5;
	const passes: ShaderPass[] = [
		{
			output: 'gb',
			scale: 0.5,
			format: 'rgba16f',
			include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
			uniforms: { u_tb: Math.max(1, blur) },
			frag: /* glsl */ `${THRESHOLD_SOURCE}
void main() {
  vec2 o = u_tb / u_canvasSize;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int y = -2; y <= 2; y++)
    for (int x = -2; x <= 2; x++) {
      vec2 q = vec2(float(x), float(y)) * 0.5;
      float w = exp(-dot(q, q) * 1.2);
      acc += sgl_thresholdSource(sgl_boxRead(u_source, v_uv + q * o, 2.0)) * w;
      ws += w;
    }
  vec3 b = acc.rgb / ws;
  fragColor = vec4(b, sgl_maxc(b));
}`,
		},
	];
	GLINT_DIRS.forEach((deg, i) => {
		const a = (deg * Math.PI) / 180;
		const span = len[i]! / 16;
		passes.push({
			output: `gs${i}`,
			scale: 0.5,
			format: 'rgba16f',
			uniforms: { u_gd: [Math.cos(a) * span, Math.sin(a) * span], u_gp: [-Math.sin(a) * perp, Math.cos(a) * perp] },
			frag: /* glsl */ `
void main() {
  vec2 d = u_gd / u_canvasSize;
  vec2 pp = u_gp / u_canvasSize;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float k = (float(i) + 0.5) / 8.0;
    acc += texture(u_gb, v_uv + d * k) + texture(u_gb, v_uv - d * k);
  }
  acc /= 16.0;
  if (dot(pp, pp) > 0.0) acc = acc * 0.5 + 0.25 * (texture(u_gb, v_uv + pp) + texture(u_gb, v_uv - pp));
  fragColor = acc;
}`,
		});
	});
	const dirs = GLINT_DIRS.map((deg, i) => {
		const a = (deg * Math.PI) / 180;
		return [Math.cos(a) * len[i]!, Math.sin(a) * len[i]!] as [number, number];
	});
	passes.push({
		output: 'gl',
		scale: 0.5,
		format: 'rgba16f',
		uniforms: { u_g0: dirs[0]!, u_g1: dirs[1]!, u_g2: dirs[2]!, u_g3: dirs[3]! },
		frag: /* glsl */ `${profile}
vec3 ray(sampler2D t, vec2 dirPx, float bright) {
  vec2 d = dirPx / u_canvasSize;
  if (dot(dirPx, dirPx) < 1.0e-4 || bright <= 0.0) return vec3(0.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float k = (float(i) + 0.5) / 16.0;
    vec3 w = rayW(k);
    acc += (texture(t, v_uv + d * k).rgb + texture(t, v_uv - d * k).rgb) * w;
  }
  return acc * bright * (16.0 / 16.0);
}
void main() {
  vec3 g = ray(u_gs0, u_g0, u_bX) + ray(u_gs1, u_g1, u_bY) + ray(u_gs2, u_g2, u_bD1) + ray(u_gs3, u_g3, u_bD2);
  fragColor = vec4(g, sgl_maxc(g));
}`,
		include: [GLSL_SGL_FINISH],
	});
	passes.push(final);
	return passes;
}

const glintUniforms = (p: EffectParams, ctx: FxPlanContext) => {
	const { bright } = glintDirs(p, ctx, 1);
	return { u_bX: bright[0]!, u_bY: bright[1]!, u_bD1: bright[2]!, u_bD2: bright[3]! };
};

const GLINT_FINAL: ShaderPass = {
	include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
	frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 light = texture(u_gl, v_uv).rgb * u_scaleColors.rgb * u_brightness * 3.0;
  if (u_hueShift != 0.0) light = fx_hueShift(max(light, 0.0), u_hueShift);
  if (!u_expandBorders && !fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, 2, u_affectAlpha, u_underSource, 0.0, u_sourceOpacity, u_bgBrightness);
}`,
};

export const S_GLINT = defineShaderEffect({
	id: 'jasper.s.glint',
	label: 'S_Glint',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Star glints on the highlights brighter than Threshold: rays in four directions (X, Y and two diagonals) with their own brightness and size; Size Red/Green/Blue give colour along the rays.',
	keywords: ['glint', 'star', 'sparkle', 'twinkle', 'cross filter', 'sapphire'],
	expensive: true,
	params: [
		...glintCommon(),
		slider('sizeRed', 'Size Red', 0.5, { softMax: 4 }),
		slider('sizeGreen', 'Size Green', 1, { softMax: 4 }),
		slider('sizeBlue', 'Size Blue', 1.5, { softMax: 4 }),
		...glintTail(),
	],
	gpu: {
		padding: (p, ctx) => glintPadding(p, ctx, Math.max(...rgbMult(p, 'sizeRed', 'sizeGreen', 'sizeBlue'))),
		uniforms: (p, ctx) => {
			const m = rgbMult(p, 'sizeRed', 'sizeGreen', 'sizeBlue');
			const top = Math.max(1e-3, ...m);
			return { ...glintUniforms(p, ctx), u_chan: m.map((x) => Math.max(1e-3, x / top)) as [number, number, number] };
		},
		passes: (p, ctx) =>
			glintPasses(
				p,
				ctx,
				Math.max(...rgbMult(p, 'sizeRed', 'sizeGreen', 'sizeBlue')),
				/* glsl */ `
// Each channel's ray ends at its own length (Size Red/Green/Blue relative to the longest).
vec3 rayW(float k) { vec3 x = clamp(1.0 - k / u_chan, 0.0, 1.0); return x * x * x; }`,
				GLINT_FINAL,
			),
	},
});

export const S_GLINT_RAINBOW = defineShaderEffect({
	id: 'jasper.s.glint-rainbow',
	label: 'S_GlintRainbow',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Star glints whose rays run through a spectrum: red shifted outwards, blue inwards (Shift Red / Shift Blue), the whole spectrum pushed out by Shift Out.',
	keywords: ['glint', 'rainbow', 'star', 'sparkle', 'prism', 'sapphire'],
	expensive: true,
	params: [
		...glintCommon().map((ps) => (ps.name === 'hueShift' ? { ...ps, range: { softMin: -1, softMax: 1, step: 0.001 } } : ps)),
		fxParam.number('shiftOut', 'Shift Out', 1, { softMin: -2, softMax: 4, step: 0.001 }),
		fxParam.number('shiftRed', 'Shift Red', 0.3, { softMin: -2, softMax: 2, step: 0.001 }),
		fxParam.number('shiftBlue', 'Shift Blue', -0.3, { softMin: -2, softMax: 2, step: 0.001 }),
		...glintTail(),
	],
	gpu: {
		padding: (p, ctx) => glintPadding(p, ctx, 1),
		uniforms: (p, ctx) => {
			// Centre of each channel's band along the ray (0…1): Shift Out moves the spectrum, Shift Red/Blue split it.
			const so = num(p.shiftOut, 1);
			const at = (s: number) => clamp(0.18 * (so + s), 0, 0.95);
			return {
				...glintUniforms(p, ctx),
				u_band: [at(num(p.shiftRed, 0.3)), at((num(p.shiftRed, 0.3) + num(p.shiftBlue, -0.3)) / 2), at(num(p.shiftBlue, -0.3))],
			};
		},
		passes: (p, ctx) =>
			glintPasses(
				p,
				ctx,
				1,
				/* glsl */ `
// A spectral band per channel along the ray plus a white core near the highlight.
vec3 rayW(float k) {
  vec3 x = (vec3(k) - u_band) / 0.16;
  float core = pow(max(1.0 - k * 2.5, 0.0), 3.0) * 0.4;
  return exp(-x * x) * (1.0 - k) * 1.3 + core;
}`,
				GLINT_FINAL,
			),
	},
});

const GLARE_STYLES = [
	'rainbow_rays',
	'rainbow_rays2',
	'rays_60',
	'rays_20',
	'rainbow2_only',
	'rainbow_double',
	'round_coin',
] as const;

export const S_GLARE = defineShaderEffect({
	id: 'jasper.s.glare',
	label: 'S_Glare',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Glare at the highlights: rainbow halos and/or clusters of fine rays (Style), like light scattering in the eye or on a dirty lens. Convolve uses a finer hotspot grid for smoother results.',
	keywords: ['glare', 'rainbow', 'rays', 'halo', 'sparkle', 'sapphire'],
	expensive: true,
	params: [
		fxParam.choice('style', 'Style', GLARE_STYLES.map((s) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())), GLARE_STYLES, 'rainbowRays'),
		fxParam.toggle('convolve', 'Convolve', false),
		slider('brightness', 'Brightness', 1, { softMax: 8 }),
		fxParam.color('scaleColors', 'Scale Colors', white),
		fxParam.number('saturation', 'Saturation', 1, { min: -2, max: 8, step: 0.01 }),
		fxParam.number('hueShift', 'Hue Shift', 0, { min: -1, max: 1, step: 0.001 }),
		...thresholdParams(0.8),
		slider('thresholdBlur', 'Threshold Blur', 0.0896, { softMax: 0.5 }),
		slider('size', 'Size', 0.8, { softMax: 4 }),
		slider('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4 }),
		fxParam.angle('rotate', 'Rotate', 0),
		slider('raysNumScale', 'Rays Num Scale', 1, { min: 0.05, softMax: 4 }),
		slider('raysLength', 'Rays Length', 1, { softMax: 4 }),
		slider('raysThickness', 'Rays Thickness', 1, { min: 0.05, softMax: 4 }),
		slider('blurGlare', 'Blur Glare', 0, { softMax: 1 }),
		resChoice('glareRes', 'Glare Res'),
		...lightTail('Glare'),
		expandBorders(),
	],
	gpu: {
		padding: (p, ctx) => num(p.size, 0.8) * unitPx(ctx.width) * Math.max(1, num(p.raysLength, 1)) * Math.max(1, num(p.relHeight, 1)),
		uniforms: (p, ctx) => ({
			u_reach: num(p.size, 0.8) * unitPx(ctx.width) * ctx.pxScale,
		}),
		passes: (p, ctx) => {
			// Hotspot grid: cells small enough that the glare reach spans ≤ 6 cells (or 3 with Convolve off and big glares).
			const reach = num(p.size, 0.8) * unitPx(ctx.width) * ctx.pxScale * Math.max(1, num(p.raysLength, 1)) * Math.max(1, num(p.relHeight, 1));
			const cell = clamp(2 ** Math.ceil(Math.log2(Math.max(8, reach / (p.convolve === true ? 6 : 4)))), 8, 256);
			const res = resScale(p.glareRes);
			const blur = num(p.thresholdBlur, 0.0896) * unitPx(ctx.width) * ctx.pxScale * 0.5;
			const passes: ShaderPass[] = [
				{
					output: 'hb',
					scale: 0.25,
					format: 'rgba16f',
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					uniforms: { u_tb: Math.max(2, blur) },
					frag: /* glsl */ `${THRESHOLD_SOURCE}
void main() {
  vec2 o = u_tb / u_canvasSize;
  vec4 acc = vec4(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) acc += sgl_thresholdSource(sgl_boxRead(u_source, v_uv + vec2(float(x), float(y)) * o * 0.5, 4.0));
  vec3 b = acc.rgb / 9.0;
  if (!fx_inBox(v_uv)) b = vec3(0.0);
  fragColor = vec4(b, sgl_maxc(b));
}`,
				},
				{
					// Per cell: energy-weighted centroid (uv), energy; colour in a second texture.
					output: 'hp',
					scale: 1 / cell,
					format: 'rgba16f',
					filter: 'nearest',
					include: [GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  ivec2 si = textureSize(u_hb, 0);
  ivec2 o = ivec2(v_uv * u_resolution);
  ivec2 a = o * si / ivec2(u_resolution);
  ivec2 b = max(a + 1, (o + 1) * si / ivec2(u_resolution));
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 64; y++) {
    if (a.y + y >= b.y) break;
    for (int x = 0; x < 64; x++) {
      if (a.x + x >= b.x) break;
      ivec2 q = a + ivec2(x, y);
      float e = fx_luma(texelFetch(u_hb, min(q, si - 1), 0).rgb);
      acc += vec3((vec2(q) + 0.5) / vec2(si) * e, e);
    }
  }
  float n = float((b.x - a.x) * (b.y - a.y));
  fragColor = acc.z > 1.0e-5 ? vec4(acc.xy / acc.z, acc.z / n, 1.0) : vec4(0.0);
}`,
				},
				{
					output: 'hc',
					scale: 1 / cell,
					format: 'rgba16f',
					filter: 'nearest',
					frag: /* glsl */ `
void main() {
  ivec2 si = textureSize(u_hb, 0);
  ivec2 o = ivec2(v_uv * u_resolution);
  ivec2 a = o * si / ivec2(u_resolution);
  ivec2 b = max(a + 1, (o + 1) * si / ivec2(u_resolution));
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 64; y++) {
    if (a.y + y >= b.y) break;
    for (int x = 0; x < 64; x++) {
      if (a.x + x >= b.x) break;
      acc += texelFetch(u_hb, min(a + ivec2(x, y), si - 1), 0).rgb;
    }
  }
  float m = max(acc.r, max(acc.g, acc.b));
  fragColor = vec4(m > 0.0 ? acc / m : vec3(0.0), 1.0);
}`,
				},
				{
					output: 'gl',
					scale: res,
					format: 'rgba16f',
					include: [GLSL_SGL_CORE, GLSL_COLOR],
					uniforms: { u_cellArea: cell * cell },
					frag: /* glsl */ `${GLARE_KERNEL}
void main() {
  ivec2 gs = textureSize(u_hp, 0);
  vec2 px = fx_canvasPx();
  ivec2 me = ivec2(v_uv * vec2(gs));
  vec2 cellPx = u_canvasSize / vec2(gs);
  ivec2 rc = ivec2(ceil(u_reach * max(u_raysLength, 1.0) * max(u_relHeight, 1.0) / cellPx)) + 1;
  rc = min(rc, ivec2(7));
  vec3 acc = vec3(0.0);
  for (int y = -7; y <= 7; y++) {
    if (abs(y) > rc.y) continue;
    for (int x = -7; x <= 7; x++) {
      if (abs(x) > rc.x) continue;
      ivec2 q = me + ivec2(x, y);
      if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, gs))) continue;
      vec4 h = texelFetch(u_hp, q, 0);
      if (h.z <= 1.0e-4) continue;
      vec3 col = texelFetch(u_hc, q, 0).rgb;
      vec2 d = px - h.xy * u_canvasSize;
      // Hotspot strength grows with its energy (bright texels of the cell), compressed so small lights still glare.
      acc += glare(d, float(q.x * 7919 + q.y * 104729)) * col * sqrt(h.z * u_cellArea / 16.0) * 0.3;
    }
  }
  fragColor = vec4(acc, sgl_maxc(acc));
}`,
				},
				{
					include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 light = texture(u_gl, v_uv).rgb;
  if (u_blurGlare > 0.0) {
    vec2 o = u_blurGlare * 0.02 * u_box.z / u_canvasSize;
    light = (light * 2.0 + texture(u_gl, v_uv + vec2(o.x, 0.0)).rgb + texture(u_gl, v_uv - vec2(o.x, 0.0)).rgb
           + texture(u_gl, v_uv + vec2(0.0, o.y)).rgb + texture(u_gl, v_uv - vec2(0.0, o.y)).rgb) / 6.0;
  }
  light *= u_scaleColors.rgb * u_brightness;
  light = fx_saturate(max(light, 0.0), u_saturation);
  if (u_hueShift != 0.0) light = fx_hueShift(light, u_hueShift);
  if (!u_expandBorders && !fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, 2, u_affectAlpha, u_underSource, 0.0, u_sourceOpacity, u_bgBrightness);
}`,
				},
			];
			return passes;
		},
	},
});

/** S_Glare kernels (`vec3 glare(vec2 d, float salt)`, d in canvas px from the hotspot) per Style. */
const GLARE_KERNEL = /* glsl */ `
float gHash(float x) {
  uint h = uint(int(mod(x, 65536.0))) * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return float((h >> 22u) ^ h) / 4294967295.0;
}
float gRays(vec2 d, float r, float n, float s) {
  float ang = atan(d.y, d.x) - radians(u_rotate);
  float t = ang / 6.28318530718 * n;
  float i = floor(t + 0.5);
  float m = (t - i) / n * 6.28318530718;
  float len = s * u_raysLength * (0.45 + 0.55 * gHash(mod(i, n) + 17.0));
  float th = max(0.6, s * 0.006 * u_raysThickness) * (1.0 + r / max(len, 1.0));
  float l = clamp(1.0 - r / max(len, 1.0), 0.0, 1.0);
  return exp(-abs(sin(m)) * r / th) * l * l * (0.6 + 0.4 * gHash(mod(i, n) + 91.0));
}
vec3 gBow(float r, float rad, float w) {
  float t = (r - rad) / max(w, 1.0);
  return sgl_spectrum(clamp(0.5 - t * 0.35, 0.0, 1.0)) * exp(-t * t * 0.5);
}
vec3 glare(vec2 d, float salt) {
  d.y /= max(u_relHeight, 0.01);
  float r = length(d);
  float s = max(u_reach, 1.0);
  float core = exp(-r / (s * 0.04)) * 1.5;
  float nScale = max(u_raysNumScale, 0.05);
  if (u_style == 0) return vec3(core + gRays(d, r, floor(24.0 * nScale), s)) + gBow(r, s * 0.45, s * 0.05) * 0.6;
  if (u_style == 1) return vec3(core + gRays(d, r, floor(24.0 * nScale), s)) + gBow(r, s * 0.75, s * 0.08) * 0.6;
  if (u_style == 2) return vec3(core + gRays(d, r, floor(60.0 * nScale), s));
  if (u_style == 3) return vec3(core + gRays(d, r, floor(20.0 * nScale), s));
  if (u_style == 4) return vec3(core * 0.6) + gBow(r, s * 0.75, s * 0.08);
  if (u_style == 5) return vec3(core * 0.6) + gBow(r, s * 0.45, s * 0.05) + gBow(r, s * 0.8, s * 0.07) * 0.7;
  return vec3(1.0 - smoothstep(s * 0.28, s * 0.3, r)) * 0.5 + core * 0.3;
}`;

export const SGL_GLINT_EFFECTS: readonly EffectSpec[] = [S_GLINT, S_GLINT_RAINBOW, S_GLARE];

// ================================================================ Other lighting

const BOKEH_SHAPES = ['circle', '3', '4', '5', '6', '7', '8', '9', '10'];
const BOKEH_COMBINE = ['Screen', 'Add', 'Lights Only'] as const;

/** Sapphire vec2 offsets are in frame widths with y up → layer-normalised offsets (x, y down). */
const SAPPHIRE_OFFSET_GLSL = /* glsl */ `
vec2 sOff(vec2 v) { return vec2(v.x, -v.y * u_box.z / u_box.w); }`;

export const S_BOKEH_LIGHTS = defineShaderEffect({
	id: 'jasper.s.bokeh-lights',
	label: 'S_BokehLights',
	category: 'Generate',
	bin: SGL_BIN,
	description:
		'Out-of-focus lights: random iris-shaped bokeh discs that drift, breathe in size and flicker, optionally coloured from the image; lens dust texture and chromatic fringes.',
	keywords: ['bokeh', 'defocus', 'lights', 'particles', 'sapphire'],
	expensive: true,
	params: [
		slider('brightness', 'Brightness', 0.5, { softMax: 4 }),
		fxParam.color('color', 'Color', [1, 1, 0.3, 1]),
		slider('varyHue', 'Vary Hue', 0, { max: 1, softMax: 1 }),
		slider('varySaturation', 'Vary Saturation', 0, { max: 1, softMax: 1 }),
		slider('varyBrightness', 'Vary Brightness', 1, { max: 1, softMax: 1 }),
		slider('size', 'Size', 0.3, { softMax: 2 }),
		slider('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4 }),
		slider('varySize', 'Vary Size', 0.2, { max: 1, softMax: 1 }),
		slider('softness', 'Softness', 0.01, { min: 0.001, softMax: 1 }),
		fxParam.number('lights', 'Lights', 30, { min: 0, max: 400, softMax: 200, step: 1 }),
		slider('driftSpeed', 'Drift Speed', 0.2, { softMax: 4 }),
		slider('driftDistance', 'Drift Distance', 0.5, { softMax: 4 }),
		slider('driftSizeSpeed', 'Drift Size Speed', 0.1, { softMax: 4 }),
		slider('driftSizeDistance', 'Drift Size Distance', 0.3, { max: 1, softMax: 1 }),
		slider('driftSmoothness', 'Drift Smoothness', 0.65, { max: 1, softMax: 1 }),
		fxParam.vec2('shiftSpeed', 'Shift Speed', [0, 0], { step: 0.001 }),
		fxParam.vec2('shiftStart', 'Shift Start', [0, 0], { step: 0.001 }),
		slider('useSourceColor', 'Use Source Color', 0.25, { max: 1, softMax: 1 }),
		slider('smoothSourceColor', 'Smooth Source Color', 0.4, { max: 1, softMax: 1 }),
		fxParam.choice('shape', 'Shape', BOKEH_SHAPES, ['Circle', '3 sides', '4 sides', '5 sides', '6 sides', '7 sides', '8 sides', '9 sides', '10 sides'], '7'),
		fxParam.number('roundness', 'Roundness', 0.3, { softMin: -1, softMax: 2, step: 0.01 }),
		fxParam.angle('rotate', 'Rotate', 0),
		fxParam.number('bokeh', 'Bokeh', 0.5, { softMin: -1, softMax: 2, step: 0.01 }),
		slider('lensNoise', 'Lens Noise', 0.5, { max: 1, softMax: 1 }),
		slider('noiseFreq', 'Noise Freq', 20, { softMax: 100 }),
		slider('noiseFreqRelX', 'Noise Freq Rel X', 1, { min: 0.02, softMax: 4 }),
		slider('chromaDistort', 'Chroma Distort', 0.05, { softMax: 0.5 }),
		slider('colorFringing', 'Color Fringing', 0, { softMax: 1 }),
		slider('flickerAmp', 'Flicker Amp', 0.2, { softMax: 1 }),
		slider('flickerSpeed', 'Flicker Speed', 0.5, { softMax: 4 }),
		slider('flickerRandomness', 'Flicker Randomness', 0.7, { max: 1, softMax: 1 }),
		slider('seed', 'Seed', 0.123, { softMax: 1 }),
		combineChoice(BOKEH_COMBINE, 'Screen'),
		slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p) => ({
			u_mode: combineMode(p.combine, BOKEH_COMBINE, 'Screen'),
			u_sides: Math.max(0, Number(String(p.shape)) || 0),
		}),
		passes: [
			{
				output: 'bsrc',
				scale: 1 / 16,
				include: [GLSL_SGL_CORE],
				frag: /* glsl */ `
void main() { fragColor = sgl_boxRead(u_source, v_uv, 16.0); }`,
			},
			{
				include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_NOISE, GLSL_HASH],
				frag: /* glsl */ `${SAPPHIRE_OFFSET_GLSL}
float bHash(int i, int k) { return fx_hash2(ivec2(i, k), u_seed); }
// Smooth drift: noise blended between one smooth octave and a rougher sum by Drift Smoothness.
vec2 drift(float t, int i) {
  float fi = float(i) * 3.17;
  vec2 a = vec2(fx_simplex(vec2(t, fi), 0.13), fx_simplex(vec2(fi, t), 0.29));
  vec2 b = vec2(fx_simplex(vec2(t * 3.0, fi + 7.0), 0.41), fx_simplex(vec2(fi + 7.0, t * 3.0), 0.53));
  return mix(a * 0.6 + b * 0.4, a, clamp(u_driftSmoothness, 0.0, 1.0));
}
float shapeDist(vec2 q) {
  float r = length(q);
  if (u_sides < 3.0) return r;
  float a = atan(q.y, q.x) - radians(u_rotate);
  float seg = 6.28318530718 / u_sides;
  float poly = r * cos(floor(0.5 + a / seg) * seg - a) / cos(seg * 0.5);
  return mix(poly, r, u_roundness);
}
// Disc profile (0..): soft edge (Softness), brighter rim with Bokeh > 0, a ring with Bokeh < 0.
float disc(float x, float soft) {
  float inside = 1.0 - smoothstep(1.0 - soft, 1.0 + soft * 0.25, x);
  float rim = pow(clamp(x, 0.0, 1.0), 6.0);
  float prof = u_bokeh >= 0.0 ? 1.0 + u_bokeh * rim * 1.5 : mix(1.0, rim * 2.0, clamp(-u_bokeh, 0.0, 1.0));
  return inside * prof;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 n = fx_layerNorm();
  float ar = u_box.w / u_box.z;
  float t = u_time;
  float lensDust = 1.0 - u_lensNoise * 0.5 * fx_noise01(fx_fbm(vec2(n.x * u_noiseFreq * u_noiseFreqRelX, n.y * ar * u_noiseFreq) * 0.5, 3, 2.0, 0.5, fract(u_seed + 0.5)));
  vec3 acc = vec3(0.0);
  int count = int(clamp(u_lights, 0.0, 400.0));
  vec2 shift = sOff(u_shiftStart + u_shiftSpeed * t);
  for (int i = 0; i < 400; i++) {
    if (i >= count) break;
    vec2 base = vec2(bHash(i, 1), bHash(i, 2)) * 1.2 - 0.1;
    vec2 pos = base + shift + drift(t * u_driftSpeed * 0.5 + bHash(i, 3) * 10.0, i) * u_driftDistance * 0.1 * vec2(1.0, 1.0 / ar);
    float rad = u_size * 0.025 * (1.0 + u_varySize * (bHash(i, 4) * 2.0 - 1.0));
    rad *= 1.0 + u_driftSizeDistance * fx_simplex(vec2(t * u_driftSizeSpeed + bHash(i, 5) * 10.0, float(i)), 0.71);
    rad = max(rad, 1.0e-4);
    vec2 d = (n - pos) * vec2(1.0, ar);
    d.y /= max(u_relHeight, 0.01);
    if (dot(d, d) > rad * rad * 2.0) continue;
    float soft = clamp(u_softness * 2.0, 0.002, 1.0);
    vec3 shape;
    float cd = u_chromaDistort;
    shape.r = disc(shapeDist(d / (rad * (1.0 + cd * 0.5))), soft);
    shape.g = disc(shapeDist(d / rad), soft);
    shape.b = disc(shapeDist(d / (rad * (1.0 - cd * 0.5))), soft);
    shape += u_colorFringing * shape.g * pow(clamp(length(d) / rad, 0.0, 1.0), 4.0) * vec3(0.4, -0.1, 0.6);
    // Colour: base colour varied per light, mixed with the (smoothed) image colour under it.
    vec3 hsv = fx_rgb2hsv(u_color.rgb);
    hsv.x = fract(hsv.x + u_varyHue * (bHash(i, 6) - 0.5));
    hsv.y = clamp(hsv.y * (1.0 - u_varySaturation * bHash(i, 7)), 0.0, 1.0);
    vec3 col = fx_hsv2rgb(hsv) * (1.0 - u_varyBrightness * 0.8 * bHash(i, 8));
    vec4 sc = mix(texture(u_source, fx_uvOfLayerNorm(pos)), texture(u_bsrc, fx_uvOfLayerNorm(pos)), u_smoothSourceColor);
    vec3 scol = sc.a > 0.0 ? sc.rgb / sc.a : vec3(0.0);
    col = mix(col, scol * 1.5, clamp(u_useSourceColor, 0.0, 1.0));
    float ft = t * u_flickerSpeed * 2.0 + bHash(i, 9) * 20.0;
    float fl = mix(sin(ft * 3.14159), fx_simplex(vec2(ft, float(i) * 0.7), 0.97), u_flickerRandomness);
    acc += max(shape, 0.0) * col * max(0.0, 1.0 + u_flickerAmp * fl);
  }
  vec3 light = acc * lensDust * u_brightness * 2.0;
  if (!fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, u_mode, u_affectAlpha, 0.0, 0.0, 1.0, 1.0);
}`,
			},
		],
	},
});

export const S_DROP_SHADOW = defineShaderEffect({
	id: 'jasper.s.drop-shadow',
	label: 'S_DropShadow',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'A soft shadow made from the layer’s alpha, shifted and blurred, drawn under the layer (outside its box too).',
	keywords: ['drop shadow', 'shadow', 'depth', 'sapphire'],
	params: [
		fxParam.color('shadowColor', 'Shadow Color', black),
		slider('shadowOpacity', 'Shadow Opacity', 1, { max: 1, softMax: 1 }),
		slider('shadowBlur', 'Shadow Blur', 0.1, { softMax: 1 }),
		fxParam.vec2('shift', 'Shift', [0.042, -0.042], { step: 0.001 }),
		slider('fgOpacity', 'Fg Opacity', 1, { max: 1, softMax: 1 }),
		fxParam.toggle('expandBorders', 'Expand Borders', true),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			const s = Array.isArray(p.shift) ? p.shift : [0.042, -0.042];
			const sigma = num(p.shadowBlur, 0.1) * unitPx(ctx.width) * 0.5;
			return {
				left: Math.max(0, -num(s[0]) * ctx.width) + 3 * sigma,
				right: Math.max(0, num(s[0]) * ctx.width) + 3 * sigma,
				top: Math.max(0, num(s[1]) * ctx.width) + 3 * sigma,
				bottom: Math.max(0, -num(s[1]) * ctx.width) + 3 * sigma,
			};
		},
		uniforms: (p, ctx) => {
			const s = Array.isArray(p.shift) ? p.shift : [0.042, -0.042];
			return { u_shiftPx: [num(s[0]) * ctx.width * ctx.pxScale, -num(s[1]) * ctx.width * ctx.pxScale] };
		},
		passes: (p, ctx) => {
			const sigma = num(p.shadowBlur, 0.1) * unitPx(ctx.width) * ctx.pxScale * 0.5;
			const dB = brightDownscale(sigma, 1);
			const c = glowCascade({ input: 'sa', prefix: 'sh', sigmaX: sigma, sigmaY: sigma, levels: 1, inputDown: dB });
			return [
				{
					output: 'sa',
					scale: 1 / dB,
					format: 'rgba16f',
					include: [GLSL_SGL_CORE],
					uniforms: { u_dB: dB },
					frag: /* glsl */ `
void main() {
  float a = sgl_boxRead(u_source, v_uv - u_shiftPx / u_canvasSize, u_dB).a;
  fragColor = vec4(a);
}`,
				},
				...c.passes,
				{
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv) * clamp(u_fgOpacity, 0.0, 1.0);
  float a = texture(u_sh0, v_uv).a * u_shadowOpacity * u_shadowColor.a;
  if (!u_expandBorders && !fx_inBox(v_uv)) a = 0.0;
  vec4 shadow = vec4(u_shadowColor.rgb * a, a);
  fragColor = src + shadow * (1.0 - src.a);
}`,
				},
			];
		},
	},
});

const FLASH_STYLES = ['star4', 'star6', 'starburst', 'round', 'rainbowGlare', 'cross'];
const FLASH_COMBINE = ['Screen', 'Add', 'Flashes Only'] as const;

export const S_FLASHBULBS = defineShaderEffect({
	id: 'jasper.s.flashbulbs',
	label: 'S_Flashbulbs',
	category: 'Generate',
	bin: SGL_BIN,
	description:
		'Random camera flashes going off, like photographers in a crowd: glare-shaped bursts at random places and frames, held for Hold Frames and then decaying.',
	keywords: ['flash', 'paparazzi', 'camera flash', 'strobe', 'sapphire'],
	params: [
		fxParam.choice('flashStyle', 'Flash Style', FLASH_STYLES, ['Star 4', 'Star 6', 'Starburst', 'Round', 'Rainbow Glare', 'Cross'], 'star4'),
		slider('brightness', 'Brightness', 5, { softMax: 20 }),
		slider('varyBrightness', 'Vary Brightness', 0.2, { max: 1, softMax: 1 }),
		fxParam.number('flashes', 'Flashes', 2, { min: 0, max: 16, step: 1 }),
		slider('flashRandomness', 'Flash Randomness', 0.5, { max: 1, softMax: 1 }),
		slider('flashSize', 'Flash Size', 1, { softMax: 4 }),
		fxParam.vec2('flashSizeRel', 'Flash Size Rel', [1, 1], { min: 0, step: 0.01 }),
		slider('flashGamma', 'Flash Gamma', 1, { min: 0.1, softMax: 4 }),
		fxParam.number('holdFrames', 'Hold Frames', 1, { min: 1, max: 8, step: 1 }),
		slider('flashDecayRate', 'Flash Decay Rate', 0.1, { max: 1, softMax: 1 }),
		slider('bgBrightness', 'Bg Brightness', 1, { softMax: 2 }),
		combineChoice(FLASH_COMBINE, 'Add'),
		slider('seed', 'Seed', 0.1, { softMax: 1 }),
		slider('affectAlpha', 'Affect Alpha', 1, { softMax: 2 }),
		fxParam.toggle('flipVertically', 'Flip Vertically', false),
	],
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => ({
			u_mode: combineMode(p.combine, FLASH_COMBINE, 'Add'),
			u_unitPx: unitPx(ctx.width) * ctx.pxScale,
		}),
		passes: [
			{
				include: [GLSL_SGL_CORE, GLSL_SGL_FINISH, GLSL_COLOR, GLSL_HASH],
				frag: /* glsl */ `
float fh(int f, int j, int k) { return fx_hash3(ivec3(f, j, k), u_seed); }
float flashShape(vec2 d, float s) {
  float r = length(d);
  float core = exp(-r / (s * 0.06)) * 2.0 + exp(-r / (s * 0.25)) * 0.35;
  float ang = atan(d.y, d.x);
  if (u_flashStyle == 3) return core;
  if (u_flashStyle == 4) {
    float t = (r - s * 0.5) / (s * 0.06);
    return core + exp(-t * t * 0.5) * 0.25;
  }
  float n = u_flashStyle == 0 ? 4.0 : u_flashStyle == 1 ? 6.0 : u_flashStyle == 5 ? 4.0 : 24.0;
  float seg = 6.28318530718 / n;
  float off = u_flashStyle == 5 ? 0.0 : 0.785398;
  float m = mod(ang + off + seg * 0.5, seg) - seg * 0.5;
  float len = u_flashStyle == 5 ? s * 1.6 : s;
  float th = s * (u_flashStyle == 2 ? 0.006 : 0.012) * (1.0 + r / len);
  float l = clamp(1.0 - r / len, 0.0, 1.0);
  return core + exp(-abs(sin(m)) * r / th) * l * l;
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 lp = fx_layerPx() * u_pxScale;
  vec2 boxPx = u_box.zw;
  int frame = int(floor(u_frame + 0.5));
  int hold = int(clamp(u_holdFrames, 1.0, 8.0));
  vec3 acc = vec3(0.0);
  float rate = clamp(u_flashes, 0.0, 16.0) / 16.0;
  for (int age = 0; age < 11; age++) {
    if (age >= hold + 3) break;
    int f = frame - age;
    float amp = age < hold ? 1.0 : pow(clamp(u_flashDecayRate, 0.0, 1.0), float(age - hold + 1));
    if (amp < 0.002) continue;
    // Per-frame rate varies with Flash Randomness.
    float r = rate * (1.0 + u_flashRandomness * (fh(f, 99, 0) * 2.0 - 1.0));
    for (int j = 0; j < 16; j++) {
      if (fh(f, j, 1) >= r) continue;
      vec2 pos = vec2(fh(f, j, 2), fh(f, j, 3)) * boxPx;
      float s = u_flashSize * u_unitPx * 1.2 * (0.6 + 0.8 * fh(f, j, 4));
      vec2 d = (lp - pos) / max(u_flashSizeRel, vec2(0.01));
      if (u_flipVertically) d.y = -d.y;
      if (length(d) > s * 2.0) continue;
      float b = (1.0 - u_varyBrightness * fh(f, j, 5)) * amp;
      acc += vec3(pow(max(flashShape(d, s), 0.0), u_flashGamma)) * b * mix(vec3(1.0), vec3(0.9, 0.95, 1.0), fh(f, j, 6));
    }
  }
  vec3 light = acc * u_brightness * 0.2;
  if (!fx_inBox(v_uv)) light = vec3(0.0);
  fragColor = sgl_finishLight(src, light, u_mode, u_affectAlpha, 0.0, 0.0, 1.0, u_bgBrightness);
}`,
			},
		],
	},
});

const CHANNELS = ['red', 'green', 'blue'];
const channelChoice = (name: string, label: string, def: string) =>
	fxParam.choice(name, label, CHANNELS, ['Red', 'Green', 'Blue'], def);

/** One S_Light3D light (Sapphire "LightN" group). */
function light3dParams(n: number, on: boolean, dir: [number, number]): ParamSpec[] {
	const g = { group: `light${n}` };
	return [
		fxParam.toggle(`light${n}Enable`, `Light${n} Enable`, on, g),
		fxParam.vec2(`light${n}Dir`, `Light${n} Dir`, dir, { step: 0.001 }, g),
		slider(`light${n}Z`, `Light${n} Z`, 0.5, { softMax: 4 }, g),
		slider(`diffuseBright${n}`, `Diffuse Bright ${n}`, 0.5, { softMax: 4 }, g),
		slider(`hilightBright${n}`, `Hilight Bright ${n}`, 1, { softMax: 4 }, g),
		slider(`hilightSize${n}`, `Hilight Size ${n}`, 1, { min: 0.01, softMax: 4 }, g),
		fxParam.color(`light${n}Color`, `Light${n} Color`, white, g),
	];
}

const light3dGlsl = (n: number) => /* glsl */ `
  if (u_light${n}Enable) {
    vec3 L = normalize(vec3(u_light${n}Dir.x, -u_light${n}Dir.y, max(u_light${n}Z, 0.0)));
    float nd = max(dot(nrm, L), 0.0);
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float sz = max(u_hilightSize * u_hilightSize${n}, 0.01);
    float sp = pow(max(dot(nrm, H), 0.0), 12.0 / (sz * sz)) * step(0.0, nd);
    diffuse += nd * u_diffuseBright * u_diffuseBright${n} * 2.0 * u_light${n}Color.rgb;
    spec += sp * u_hilightBright * u_hilightBright${n} * u_light${n}Color.rgb;
  }`;

export const S_LIGHT_3D = defineShaderEffect({
	id: 'jasper.s.light-3d',
	label: 'S_Light3D',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'Relights the image as a 3D surface with up to four lights (ambient + diffuse + specular highlights), using a Normals clip — or, without one, normals derived from the image’s own luminance (embossed relief).',
	keywords: ['relight', 'normal map', '3d light', 'emboss', 'bump', 'sapphire'],
	params: [
		slider('brightness', 'Brightness', 1, { softMax: 4 }),
		slider('ambientBright', 'Ambient Bright', 0.2, { softMax: 2 }),
		slider('diffuseBright', 'Diffuse Bright', 0.5, { min: 0.1, softMax: 4 }),
		slider('hilightBright', 'Hilight Bright', 0.8, { softMax: 4 }),
		slider('hilightSize', 'Hilight Size', 0.5, { min: 0.1, softMax: 4 }),
		...light3dParams(1, true, [-0.806, 0.608]),
		...light3dParams(2, false, [0.806, 0.608]),
		...light3dParams(3, false, [-0.806, -0.627]),
		...light3dParams(4, false, [0.806, -0.627]),
		fxParam.media('normals', 'Normals', ['image', 'video']),
		fxParam.number('normalOffset', 'Normal Offset', -0.5, { softMin: -1, softMax: 1, step: 0.001 }),
		channelChoice('normalX', 'Normal X <-', 'red'),
		channelChoice('normalY', 'Normal Y <-', 'green'),
		channelChoice('normalZ', 'Normal Z <-', 'blue'),
		fxParam.toggle('invertX', 'Invert X', false),
		fxParam.toggle('invertY', 'Invert Y', false),
		fxParam.toggle('invertZ', 'Invert Z', false),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
float chan(vec3 c, int i) { return i == 0 ? c.r : i == 1 ? c.g : c.b; }
float lumAt(vec2 uv) { return fx_luma(texture(u_source, clamp(uv, vec2(0.0), vec2(1.0))).rgb); }
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 nrm;
  if (u_normals_size.x > 0.0) {
    vec4 t = texture(u_normals, clamp(fx_layerNorm(), 0.0, 1.0));
    vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.5, 0.5, 1.0);
    nrm = vec3(chan(c, u_normalX), chan(c, u_normalY), chan(c, u_normalZ)) + u_normalOffset;
    // Normal maps are y-up; the image is y-down.
    nrm.y = -nrm.y;
  } else {
    // No Normals clip: an embossed relief from the image's luminance.
    vec2 e = 1.5 * u_pxScale / u_canvasSize;
    float gx = lumAt(v_uv + vec2(e.x, 0.0)) - lumAt(v_uv - vec2(e.x, 0.0));
    float gy = lumAt(v_uv + vec2(0.0, e.y)) - lumAt(v_uv - vec2(0.0, e.y));
    nrm = vec3(-gx * 3.0, -gy * 3.0, 0.5);
  }
  if (u_invertX) nrm.x = -nrm.x;
  if (u_invertY) nrm.y = -nrm.y;
  if (u_invertZ) nrm.z = -nrm.z;
  nrm = normalize(nrm + vec3(0.0, 0.0, 1.0e-4));
  vec3 diffuse = vec3(0.0), spec = vec3(0.0);
  ${[1, 2, 3, 4].map(light3dGlsl).join('')}
  vec3 rgb = (src.rgb * (u_ambientBright + diffuse) + spec * src.a) * u_brightness;
  rgb = clamp(rgb, 0.0, src.a);
  fragColor = vec4(rgb, src.a);
}`,
			},
		],
	},
});

const SPOT_COMBINE = ['Lights Only', 'Mult', 'Add', 'Screen', 'Overlay'] as const;

/** One S_SpotLight light. */
function spotParams(n: number, d: { on: boolean; pos: [number, number]; aim: [number, number] }): ParamSpec[] {
	const g = { group: `light${n}` };
	return [
		fxParam.toggle(`light${n}Enable`, `Light${n} Enable`, d.on, g),
		fxParam.number(`light${n}Bright`, `Light${n} Bright`, 0.8, { softMin: -2, softMax: 4, step: 0.001 }, g),
		fxParam.color(`light${n}Color`, `Light${n} Color`, white, g),
		fxParam.point(`light${n}`, `Light${n}`, sapphirePoint(d.pos[0], d.pos[1]), g),
		slider(`light${n}Z`, `Light${n} Z`, 0.5, { min: 0.028, softMax: 4 }, g),
		fxParam.point(`aim${n}`, `Aim${n}`, sapphirePoint(d.aim[0], d.aim[1]), g),
		fxParam.number(`spreadAngle${n}`, `Spread Angle${n}`, 45, { min: 0, max: 360, step: 0.1 }, { ...g, }),
		slider(`softness${n}`, `Softness${n}`, 0.3, { min: 0.01, max: 1, softMax: 1 }, g),
		slider(`falloffPower${n}`, `Falloff Power${n}`, 0, { softMax: 4 }, g),
	];
}

const spotGlsl = (n: number) => /* glsl */ `
  if (u_light${n}Enable) {
    // 3D in layer widths: the image plane is z = 0, the light hangs at Z above it, aimed at a point on the plane.
    vec3 L = vec3((u_light${n} + sh) * vec2(1.0, ar), u_light${n}Z);
    vec3 A = vec3((u_aim${n} + sh + ash) * vec2(1.0, ar), 0.0);
    vec3 P = vec3(n * vec2(1.0, ar), 0.0);
    vec3 axis = normalize(A - L);
    vec3 v = P - L;
    float cosT = dot(normalize(v), axis);
    float half_ = radians(clamp(u_spreadAngle${n}, 0.0, 359.0)) * 0.5;
    float soft = clamp(u_softness${n}, 0.01, 1.0);
    float cone = smoothstep(cos(min(half_ * (1.0 + soft), 3.1)), cos(half_ * (1.0 - soft)), cosT);
    float fall = pow(length(A - L) / max(length(v), 1.0e-4), u_falloffPower${n});
    light += cone * fall * u_light${n}Bright * u_light${n}Color.rgb;
  }`;

export const S_SPOT_LIGHT = defineShaderEffect({
	id: 'jasper.s.spot-light',
	label: 'S_SpotLight',
	category: 'Stylize',
	bin: SGL_BIN,
	description:
		'One or two 3D spotlight cones falling on the image plane (position, height, aim, spread, soft penumbra, distance falloff) plus ambient light.',
	keywords: ['spotlight', 'spot light', 'light cone', 'vignette', 'sapphire'],
	params: [
		...spotParams(1, { on: true, pos: [-0.5, 0.361], aim: [-0.167, 0] }),
		...spotParams(2, { on: false, pos: [0.5, 0.361], aim: [0.167, 0] }),
		slider('ambientBright', 'Ambient Bright', 0.2, { softMax: 2 }),
		fxParam.color('ambientColor', 'Ambient Color', white),
		slider('allLightsBright', 'All Lights Bright', 1, { softMax: 4 }),
		fxParam.color('allLightsColor', 'All Lights Color', white),
		fxParam.vec2('allAimsShift', 'All Aims Shift', [0, 0], { step: 0.001 }),
		fxParam.vec2('allShift', 'All Shift', [0, 0], { step: 0.001 }),
		combineChoice(SPOT_COMBINE, 'Mult'),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => ({ u_mode: combineMode(p.combine, SPOT_COMBINE, 'Mult') }),
		passes: [
			{
				include: [GLSL_SGL_FINISH],
				frag: /* glsl */ `${SAPPHIRE_OFFSET_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 n = fx_layerNorm();
  float ar = u_box.w / u_box.z;
  vec2 sh = sOff(u_allShift);
  vec2 ash = sOff(u_allAimsShift);
  vec3 light = vec3(0.0);
  ${spotGlsl(1)}
  ${spotGlsl(2)}
  light = light * u_allLightsBright * u_allLightsColor.rgb + u_ambientBright * u_ambientColor.rgb;
  light = max(light, 0.0);
  vec3 rgb = sgl_combineRgb(u_mode, src.rgb, light * (u_mode == 5 ? 1.0 : 1.0));
  if (u_mode == 5) { fragColor = vec4(min(light, 1.0) * src.a, src.a); return; }
  rgb = clamp(rgb, 0.0, 1.0);
  float a = u_mode == 0 ? src.a : clamp(max(src.a, sgl_maxc(rgb)), 0.0, 1.0);
  fragColor = vec4(min(rgb, vec3(a)), a);
}`,
			},
		],
	},
});

export const SGL_OTHER_EFFECTS: readonly EffectSpec[] = [
	S_BOKEH_LIGHTS,
	S_DROP_SHADOW,
	S_FLASHBULBS,
	S_LIGHT_3D,
	S_SPOT_LIGHT,
];

export const SAPPHIRE_GLOWS_LIGHTING_EFFECTS: readonly EffectSpec[] = [
	...SGL_GLOW_EFFECTS,
	...SGL_BEAM_EFFECTS,
	...SGL_FLARE_EFFECTS,
	...SGL_GLINT_EFFECTS,
	...SGL_OTHER_EFFECTS,
];
