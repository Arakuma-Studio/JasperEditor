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

export const SAPPHIRE_GLOWS_LIGHTING_EFFECTS: readonly EffectSpec[] = [...SGL_GLOW_EFFECTS, ...SGL_BEAM_EFFECTS];
