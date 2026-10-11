// Sapphire film family — the film simulations: S_FilmEffect (negative + print stock emulation, glow, grain,
// vignette), S_FilmDamage (grain, colour, stains, dust, hairs, scratches, shake, flicker, defocus, vignette) and
// S_FilmBurn (light-leak flashes over the picture, sprocket edges, scratches, hairs, stains, dust, grain).
// Parameter names, order and defaults follow Boris FX's public Sapphire reference (Mocha/Mask params omitted;
// "Mix with Orig" stands in for the Mask input). Per-frame randomness: u_frame + u_seed (GLSL) and the smooth
// deterministic signals of common.ts (TS uniforms) — never Math.random.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_MB } from '../glsl/motion-blur.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam } from '../params.ts';
import { bloomPyramidPasses } from '../passes.ts';
import type { FxFrameContext, FxUniformValue, ShaderPass } from '../shader.ts';
import {
	bool,
	check,
	color,
	filmGrainParams,
	filmGrainUniforms,
	grp,
	hdPx,
	intSlider,
	mixParam,
	num,
	sapphirePoint,
	sapphireSeed,
	slider,
	smoothNoise1,
	stepNoise1,
	uniformBlurPasses,
	vignetteParams,
} from './common.ts';
import { GLSL_COMBINE, GLSL_DIRT, GLSL_FILM } from './glsl.ts';
import { E_GREY, filmStockUniforms, NEG_RANGE, NEG_STOCKS, PRINT_STOCKS } from './stocks.ts';

const STYLIZE = SAPPHIRE_BINS.stylize;
const PYRAMID = 6;

/** GLSL: Gaussian-like blur of the source at any sigma (canvas px) from a bloom pyramid `u_gl0…u_gl5`. */
const PYRAMID_SAMPLE = /* glsl */ `
vec4 sfe_level(int k, vec2 uv) {
  if (k <= 0) return texture(u_gl0, uv);
  if (k == 1) return texture(u_gl1, uv);
  if (k == 2) return texture(u_gl2, uv);
  if (k == 3) return texture(u_gl3, uv);
  if (k == 4) return texture(u_gl4, uv);
  return texture(u_gl5, uv);
}
vec4 sfe_blurAt(float sigma, vec2 uv) {
  float f = clamp(log2(max(sigma, 0.35) / 1.4), -1.0, 5.0);
  if (f < 0.0) return mix(texture(u_source, uv), sfe_level(0, uv), f + 1.0);
  int k = int(floor(f));
  return mix(sfe_level(k, uv), sfe_level(min(k + 1, 5), uv), fract(f));
}
`;

const DUST_UNIFORMS = (density: number, w: number, h: number) => {
	const n = Math.max(0, density);
	const cells = Math.max(1, n * 2);
	return { cell: Math.sqrt((Math.max(1, w) * Math.max(1, h)) / cells), prob: n / cells };
};

const NEG_KEYS = Object.keys(NEG_STOCKS);
const PRINT_KEYS = Object.keys(PRINT_STOCKS);

const filmEffectFrag = (pyramid: boolean) => /* glsl */ `${pyramid ? PYRAMID_SAMPLE : ''}
float sfe_sig(float x) { return 1.0 / (1.0 + exp(-x)); }
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c0 = fx_unpremultiply(src).rgb;
  vec3 c = c0;
  ${
		pyramid
			? `if (u_blurInputPx > 0.0) c = fx_unpremultiply(sfe_blurAt(u_blurInputPx, v_uv)).rgb;
  vec3 wide = vec3(sfe_blurAt(u_glowSigma.r, v_uv).r, sfe_blurAt(u_glowSigma.g, v_uv).g, sfe_blurAt(u_glowSigma.b, v_uv).b);
  vec3 wideS = src.a > 0.0 ? wide / src.a : wide;
  c = mix(c, wideS, clamp(u_glowSoftFocus, 0.0, 1.0)) + wide * u_glowBrightness;`
			: ''
	}
  // exposure through the negative (log10 exposure, saturation in log space)
  vec3 lin = pow(max(c, vec3(0.0)), vec3(u_inputGamma)) * u_negBias * exp2(u_negExposure);
  vec3 E = log(max(lin, vec3(1.0e-5))) / log(10.0);
  float Em = dot(E, vec3(0.2126, 0.7152, 0.0722));
  E = Em + u_negSat * u_printSat * (E - Em);
  vec3 g = u_negGamma;
  vec3 Dn = ${NEG_RANGE.toFixed(4)} * vec3(sfe_sig(4.0 * g.r * (E.r - (${E_GREY.toFixed(6)})) / ${NEG_RANGE.toFixed(4)}),
    sfe_sig(4.0 * g.g * (E.g - (${E_GREY.toFixed(6)})) / ${NEG_RANGE.toFixed(4)}),
    sfe_sig(4.0 * g.b * (E.b - (${E_GREY.toFixed(6)})) / ${NEG_RANGE.toFixed(4)}));
  vec3 film;
  if (u_printNone) {
    // the negative itself: orange-masked densities seen in transmission
    film = pow(pow(vec3(10.0), -(Dn * 0.5 + vec3(0.05, 0.25, 0.5))), vec3(1.0 / u_outputGamma));
  } else {
    vec3 Ep = -Dn + u_printOffset;
    vec3 gp = u_printGamma;
    float R = u_printRange;
    vec3 Dp = R * vec3(sfe_sig(4.0 * gp.r * Ep.r / R), sfe_sig(4.0 * gp.g * Ep.g / R), sfe_sig(4.0 * gp.b * Ep.b / R));
    vec3 T = pow(vec3(10.0), -Dp) * u_outScale * u_printTint;
    film = pow(max(T, vec3(0.0)), vec3(1.0 / u_outputGamma));
  }
  vec3 o = mix(c, film, u_scaleCC);
  o = sfg_lights(o, u_scaleBrights, u_offsetDarks);
  if (u_grainAmp > 0.0) {
    vec3 n = sfg_grainNoise(fx_layerPx(), u_grainSizePx, u_grainMono, sfg_frameSeed(u_seed, u_grainFrame, 1.0));
    vec3 amp = u_grainAmp * vec3(u_grainAmpRed, u_grainAmpGreen, u_grainAmpBlue)
      * sfg_grainCurve(o, u_grainAmpDarks, 1.0, u_grainAmpBrights, vec3(u_midtonePosRed, u_midtonePosGreen, u_midtonePosBlue));
    o += n * amp * 0.035;
  }
  o *= sfg_filmVignette(fx_layerPx(), u_vignetteDarkness, u_vignetteRadius, u_vignetteEdgeSoftness, u_vignetteRelHeight);
  fragColor = sfg_out(o, src, u_mixWithOriginal);
}`;

export const S_FILM_EFFECT = defineShaderEffect({
	id: 'jasper.s.film-effect',
	label: 'S_FilmEffect',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Makes video look shot on a chosen negative stock and printed on a chosen print stock (characteristic curves, printer lights), with glow / soft focus, film grain and a vignette.',
	keywords: ['film look', 'film stock', 'kodak', 'print', 'negative', 'grain', 'glow', 'cinematic'],
	expensive: true,
	params: [
		fxParam.choice(
			'negFilm',
			'Neg Film',
			NEG_KEYS,
			NEG_KEYS.map((k) => NEG_STOCKS[k]!.label),
			'k5245',
		),
		fxParam.choice(
			'printFilm',
			'Print Film',
			PRINT_KEYS,
			PRINT_KEYS.map((k) => PRINT_STOCKS[k]!.label),
			'k2383',
		),
		slider('blurInput', 'Blur Input', 0, 0, 100, { softMax: 4 }),
		...grp('Color Correct Parameters', [
			slider('scaleCC', 'Scale CC', 1, 0, 5),
			slider('inputGamma', 'Input Gamma', 2.2, 0.1, 10, { softMax: 4 }),
			slider('outputGamma', 'Output Gamma', 2.2, 0.1, 10, { softMax: 4 }),
			slider('negExposure', 'Neg Exposure', 0, undefined, undefined, { softMin: -4, softMax: 4 }),
			slider('printExposure', 'Print Exposure', 0, undefined, undefined, { softMin: -4, softMax: 4 }),
			slider('printLightsRed', 'Print Lights Red', 25, 0, 50, { step: 0.1 }),
			slider('printLightsGreen', 'Print Lights Green', 25, 0, 50, { step: 0.1 }),
			slider('printLightsBlue', 'Print Lights Blue', 25, 0, 50, { step: 0.1 }),
			slider('scaleBrights', 'Scale Brights', 1, 0, 10, { softMax: 3 }),
			slider('offsetDarks', 'Offset Darks', 0, -8, 2),
		]),
		...grp('Glow Parameters', [
			slider('glowBrightness', 'Glow Brightness', 0, 0, 10, { softMax: 2 }),
			slider('glowSoftFocus', 'Glow Soft Focus', 0, 0, 1),
			slider('glowWidth', 'Glow Width', 0.224, 0, 10, { softMax: 1, step: 0.001 }),
			slider('glowWidthRed', 'Glow Width Red', 1, 0, 10, { softMax: 3 }),
			slider('glowWidthGreen', 'Glow Width Green', 1, 0, 10, { softMax: 3 }),
			slider('glowWidthBlue', 'Glow Width Blue', 1, 0, 10, { softMax: 3 }),
		]),
		...filmGrainParams({ amp: 1, midtones: true, hold: true, group: 'Grain Parameters' }),
		{ ...sapphireSeed('Grain Seed'), group: 'Grain Parameters' },
		...vignetteParams(0, 'Vignette Parameters'),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const sigma = num(p.glowWidth, 0.224) * 0.1 * ctx.width * ctx.pxScale;
			return {
				...filmStockUniforms(p),
				...filmGrainUniforms(p, ctx),
				u_glowSigma: [
					sigma * Math.max(0, num(p.glowWidthRed, 1)),
					sigma * Math.max(0, num(p.glowWidthGreen, 1)),
					sigma * Math.max(0, num(p.glowWidthBlue, 1)),
				],
				u_blurInputPx: Math.max(0, num(p.blurInput)) * hdPx(ctx) * ctx.pxScale,
			};
		},
		passes: (p) => {
			const pyramid = num(p.glowBrightness) > 0 || num(p.glowSoftFocus) > 0 || num(p.blurInput) > 0;
			const final: ShaderPass = { include: [GLSL_FILM], frag: filmEffectFrag(pyramid) };
			return pyramid
				? [...bloomPyramidPasses({ input: 'source', prefix: 'gl', levels: PYRAMID }), final]
				: [final];
		},
	},
});

/** Per-frame signals of S_FilmDamage (pure functions of params, frame, fps, seed). */
export function filmDamageSignals(
	p: EffectParams,
	ctx: Pick<FxFrameContext, 'frame' | 'fps' | 'seed' | 'height'>,
) {
	const fps = Math.max(1, ctx.fps);
	const t = ctx.frame / fps;
	// flicker: random (smooth at Flicker Rand Freq) + wave
	const flick =
		num(p.flicker, 0.2) *
		(num(p.flickerRandAmp, 1) * 0.5 * smoothNoise1(ctx.seed, 11, t * num(p.flickerRandFreq, 10)) +
			num(p.flickerWaveAmp) * 0.5 * Math.sin(2 * Math.PI * num(p.flickerWaveFreq, 5) * t));
	// defocus: same structure, ≥ 0
	const defocus = Math.max(
		0,
		num(p.defocus) *
			(1 +
				num(p.defocusRandAmp, 1) * 0.5 * smoothNoise1(ctx.seed, 12, t * num(p.defocusRandFreq, 10)) +
				num(p.defocusWaveAmp) * 0.5 * Math.sin(2 * Math.PI * num(p.defocusWaveFreq, 5) * t)),
	);
	// shake (vertical gate slip): jumps (held random levels), small random jitter, a smooth wander; on part of the time
	const shakeAt = (f: number) => {
		const tt = f / fps + num(p.shakeTimeOffset);
		const freq = Math.max(0.01, num(p.shakeFrequency, 1));
		const on = stepNoise1(ctx.seed, 13, tt * freq * 0.5) < num(p.shakeAlways, 0.5) ? 1 : 0;
		const jump = (stepNoise1(ctx.seed, 14, tt * freq) * 2 - 1) * num(p.shakeJumpiness, 1);
		const jitter = (stepNoise1(ctx.seed, 15, f) * 2 - 1) * num(p.shakeRandom, 0.1);
		const wander = smoothNoise1(ctx.seed, 16, tt * freq) * 0.5;
		return on * num(p.shakeAmplitude) * 0.1 * (jump + jitter + wander) || 0; // no −0
	};
	const shake = shakeAt(ctx.frame);
	return { flicker: 1 + flick, defocus, shake, shakeVel: shake - shakeAt(ctx.frame - 1) };
}

/** Dirt layer A of S_FilmDamage: (black scratches, white scratches, hairs, 0). */
const FILM_DAMAGE_DIRT_A = /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float hd = box.x / 1920.0;
  float hc = sfd_hairs(p, box, u_hairs, u_hairPersistence, u_hairWiggleAmp, u_hairWiggleFreq,
                       u_hairSize * 0.06 * box.x, max(0.8, 1.6 * hd * u_hairSize), u_varyHairSize, u_frame, u_fps, fract(u_seed + 0.27));
  float share = max(u_blackScratches + u_whiteScratches, 1.0e-4);
  float sw = max(0.6, u_scratchWidth * 8.0 * hd);
  float bsc = sfd_scratches(p, box, u_scratches * u_blackScratches / share, u_blackScratchLength, sw, u_varyScratchesWidth,
    u_scratchesTaper, u_scratchRoughness * 1.5 * hd, u_scratchRoughFreq, u_gaps, u_gapsFreq, u_scratchAreaCenter,
    u_scratchAreaWidth, u_weaveAmount * 0.005 * box.x, u_weaveFrequency, u_frame, fract(u_seed + 0.41));
  float wsc = sfd_scratches(p, box, u_scratches * u_whiteScratches / share, u_whiteScratchLength, sw, u_varyScratchesWidth,
    u_scratchesTaper, u_scratchRoughness * 1.5 * hd, u_scratchRoughFreq, u_gaps, u_gapsFreq, u_scratchAreaCenter,
    u_scratchAreaWidth, u_weaveAmount * 0.005 * box.x, u_weaveFrequency, u_frame, fract(u_seed + 0.59));
  fragColor = vec4(bsc, wsc, hc, 0.0);
}`;

/** Dirt layer B of S_FilmDamage: (stain coverage, stain random, dust coverage, dust random). */
const FILM_DAMAGE_DIRT_B = /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float fr = floor(u_frame);
  vec2 st = sfd_stains(p, box, u_stainCount, u_stainSize * 0.08 * box.x, u_varyStainSize, fr, fract(u_seed + 0.11));
  vec2 du = sfd_dust(p, u_dustCellPx, u_dustProb, u_dustSize * 0.002 * box.x, u_varyDustSize, fract(u_seed + fr * 0.6180339));
  fragColor = vec4(st, du);
}`;

const filmDamageFrag = (defocus: boolean) => /* glsl */ `
vec4 sfdm_sample(vec2 n) {
  return texture(${defocus ? 'u_dfc' : 'u_source'}, fx_uvOfLayerNorm(n));
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  vec2 n = fx_layerNorm();
  // shake: the picture slips vertically; the next/previous frame shows across a black inter-frame bar
  float period = 1.0 + max(u_interframeBorderHeight, 0.0) * 0.1;
  vec4 s = vec4(0.0);
  float wsum = 0.0;
  // Shake Motion Blur: a smear along the slip, 5 taps or ≤ 1 px apart when longer (adaptive, ≤ 64).
  float span = u_shakeVel * u_shakeMotionBlur * 4.0;
  float ext = abs(span) * box.y * u_pxScale;
  int mbN = max(5, fx_mbTapCount(ext, 64));
  float mbJ = mbN > 5 ? fx_mbJitterFor(ext, mbN) : 0.0;
  float last = mbN > 5 ? float(mbN) : 4.0;
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= mbN) break;
    float k = ((float(i) + mbJ) / last - 0.5) * span;
    float y = mod(n.y + u_shakeY + k, period);
    vec4 t = y > 1.0 ? vec4(0.0, 0.0, 0.0, src.a) : sfdm_sample(vec2(n.x, y));
    s += t;
    wsum += 1.0;
  }
  s /= wsum;
  float a = src.a;
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  if (s.a <= 0.0 && a > 0.0) c = vec3(0.0);
  // colour correct
  c = mix(vec3(fx_luma(c)), c, u_saturation);
  c = sfg_lights(c, u_scaleLights, u_offsetDarks);
  c = c * u_tintLights.rgb + u_tintDarks.rgb * (1.0 - clamp(c, 0.0, 1.0));
  c *= u_flickerGain;
  vec4 dA = texture(u_dirtA, v_uv);   // black scratches, white scratches, hairs
  vec4 dB = texture(u_dirtB, v_uv);   // stain coverage, stain random, dust coverage, dust random
  if (dB.x > 0.0) {
    float r = dB.y;
    vec3 sc = mix(u_stainColor1.rgb, u_stainColor2.rgb, fract(r * 7.31));
    sc *= 1.0 + u_varyStainBrightness * (fract(r * 3.7) * 2.0 - 1.0);
    float op = u_stainOpacity * max(0.0, 1.0 + u_varyStainOpacity * (fract(r * 5.3) * 2.0 - 1.0));
    bool neg = fract(r * 11.9) * (u_stainPrint + u_stainNegative) < u_stainNegative;
    c = mix(c, neg ? 1.0 - sc : sc, clamp(dB.x * op, 0.0, 1.0));
  }
  if (dB.z > 0.0) {
    float r = dB.w;
    vec3 dc = mix(u_dustColor1.rgb, u_dustColor2.rgb, fract(r * 7.31));
    dc *= 1.0 + u_varyDustBrightness * (fract(r * 3.7) * 2.0 - 1.0);
    float op = u_dustOpacity * max(0.0, 1.0 + u_varyDustOpacity * (fract(r * 5.3) * 2.0 - 1.0));
    bool neg = fract(r * 11.9) * (u_dustOnPrint + u_dustOnNegative) < u_dustOnNegative;
    c = mix(c, neg ? 1.0 - dc : dc, clamp(dB.z * op, 0.0, 1.0));
  }
  c = mix(c, u_hairColor.rgb, clamp(dA.z * u_hairOpacity, 0.0, 1.0));
  c = mix(c, vec3(0.02), clamp(dA.x * u_scratchOpacity, 0.0, 1.0));
  c = mix(c, vec3(0.97), clamp(dA.y * u_scratchOpacity, 0.0, 1.0));
  // grain
  if (u_grainAmp > 0.0) {
    vec3 gn = sfg_grainNoise(p, u_grainSizePx, u_grainMono, sfg_frameSeed(u_seed, u_grainFrame, 1.0));
    vec3 amp = u_grainAmp * vec3(u_grainAmpRed, u_grainAmpGreen, u_grainAmpBlue)
      * sfg_grainCurve(c, u_grainAmpDarks, 1.0, u_grainAmpBrights, vec3(0.5));
    c += gn * amp * 0.035;
  }
  c *= sfg_filmVignette(p, u_vignetteDarkness, u_vignetteRadius, u_vignetteEdgeSoftness, u_vignetteRelHeight);
  fragColor = sfg_out(c, src, u_mixWithOriginal);
}`;

export const S_FILM_DAMAGE = defineShaderEffect({
	id: 'jasper.s.film-damage',
	label: 'S_FilmDamage',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Old, damaged film: grain, faded colour, stains, dust, hairs, black and white scratches, gate shake with the inter-frame bar, flicker, defocus breathing and a vignette — every element animated per frame.',
	keywords: ['film damage', 'old film', 'scratches', 'dust', 'hair', 'flicker', 'gate weave', 'vintage'],
	expensive: true,
	params: [
		...filmGrainParams({ amp: 0.1, hold: true, group: 'Grain Parameters' }),
		...grp('Color Correct Parameters', [
			slider('saturation', 'Saturation', 1, undefined, undefined, { softMin: -1, softMax: 3 }),
			slider('scaleLights', 'Scale Lights', 1, 0, 10, { softMax: 3 }),
			slider('offsetDarks', 'Offset Darks', 0, undefined, undefined, { softMin: -8, softMax: 2 }),
			color('tintLights', 'Tint Lights', [1, 1, 1]),
			color('tintDarks', 'Tint Darks', [0, 0, 0]),
		]),
		...grp('Stains Parameters', [
			slider('stainDensity', 'Stain Density', 0.2, 0, 4),
			slider('varyStainDensity', 'Vary Stain Density', 0.2, 0, 1),
			slider('stainPrint', 'Stain Print', 1, 0, 1),
			slider('stainNegative', 'Stain Negative', 0, 0, 1),
			slider('stainSize', 'Stain Size', 1, 0, 20, { softMax: 4 }),
			slider('varyStainSize', 'Vary Stain Size', 0.5, 0, 1),
			slider('stainOpacity', 'Stain Opacity', 0.5, 0, 1),
			slider('varyStainOpacity', 'Vary Stain Opacity', 0.5, 0, 1),
			slider('varyStainBrightness', 'Vary Stain Brightness', 0, 0, 1),
			color('stainColor1', 'Stain Color1', [0, 0, 0]),
			color('stainColor2', 'Stain Color2', [0.25, 0.125, 0]),
		]),
		...grp('Dust Parameters', [
			slider('dustDensity', 'Dust Density', 30, 0, 2000, { softMax: 300, step: 1 }),
			slider('varyDustDensity', 'Vary Dust Density', 0.2, 0, 1),
			slider('dustOnPrint', 'Dust On Print', 1, 0, 1),
			slider('dustOnNegative', 'Dust On Negative', 0, 0, 1),
			slider('dustSize', 'Dust Size', 1, 0, 20, { softMax: 4 }),
			slider('varyDustSize', 'Vary Dust Size', 0.5, 0, 1),
			slider('dustOpacity', 'Dust Opacity', 0.8, 0, 1),
			slider('varyDustOpacity', 'Vary Dust Opacity', 0.5, 0, 1),
			slider('varyDustBrightness', 'Vary Dust Brightness', 0, 0, 1),
			color('dustColor1', 'Dust Color1', [0, 0, 0]),
			color('dustColor2', 'Dust Color2', [0, 0, 0]),
		]),
		...grp('Hairs Parameters', [
			slider('hairs', 'Hairs', 2, 0, 6),
			slider('hairPersistence', 'Hair Persistence', 3, 0.1, 100, { softMax: 20 }),
			slider('hairWiggleAmp', 'Hair Wiggle Amp', 0.1, 0, 10, { softMax: 1 }),
			slider('hairWiggleFreq', 'Hair Wiggle Freq', 1, 0, 100, { softMax: 10 }),
			slider('hairOpacity', 'Hair Opacity', 1, 0, 1),
			slider('hairSize', 'Hair Size', 1, 0, 20, { softMax: 4 }),
			slider('varyHairSize', 'Vary Hair Size', 1, 0, 2),
			color('hairColor', 'Hair Color', [0, 0, 0]),
		]),
		...grp('Scratches Parameters', [
			intSlider('scratches', 'Scratches', 5, 0, 10),
			slider('blackScratches', 'Black Scratches', 1, 0, 1),
			slider('whiteScratches', 'White Scratches', 0.1, 0, 1),
			slider('blackScratchLength', 'Black Scratch Length', 10, 1, 1000, { softMax: 60, step: 1 }),
			slider('whiteScratchLength', 'White Scratch Length', 2, 1, 1000, { softMax: 60, step: 1 }),
			slider('scratchWidth', 'Scratch Width', 0.15, 0, 10, { softMax: 2 }),
			slider('varyScratchesWidth', 'Vary Scratches Width', 1, 0, 1),
			slider('scratchesTaper', 'Scratches Taper', 0.1, 0, 1),
			slider('scratchOpacity', 'Scratch Opacity', 1, 0, 1),
			slider('scratchRoughness', 'Scratch Roughness', 1, 0, 20, { softMax: 5 }),
			slider('scratchRoughFreq', 'Scratch Rough Freq', 150, 0.01, 2000, { softMax: 500, step: 1 }),
			slider('gaps', 'Gaps', 0.28, 0, 1),
			slider('gapsFreq', 'Gaps Freq', 120, 0, 2000, { softMax: 500, step: 1 }),
			slider('scratchAreaCenter', 'Scratch Area Center', 0, undefined, undefined, {
				softMin: -1,
				softMax: 1,
			}),
			slider('scratchAreaWidth', 'Scratch Area Width', 1, 0, 4, { softMax: 2 }),
			slider('weaveAmount', 'Weave Amount', 1, 0, 50, { softMax: 5 }),
			slider('weaveFrequency', 'Weave Frequency', 0.1, 0.01, 10, { softMax: 1 }),
		]),
		...grp('Shake Parameters', [
			slider('shakeAmplitude', 'Shake Amplitude', 0, 0, 10, { softMax: 2 }),
			slider('shakeFrequency', 'Shake Frequency', 1, 0, 100, { softMax: 10 }),
			slider('shakeJumpiness', 'Shake Jumpiness', 1, 0, 10, { softMax: 3 }),
			slider('shakeRandom', 'Shake Random', 0.1, 0, 10, { softMax: 2 }),
			slider('shakeAlways', 'Shake Always', 0.5, 0, 1),
			slider('interframeBorderHeight', 'Interframe Border Height', 0.1, 0, 10, { softMax: 2 }),
			slider('shakeTimeOffset', 'Shake Time Offset', 0, undefined, undefined, { softMin: -10, softMax: 10 }),
			slider('shakeMotionBlur', 'Shake Motion Blur', 0.1, 0, 10, { softMax: 2 }),
		]),
		...grp('Flicker Parameters', [
			slider('flicker', 'Flicker', 0.2, 0, 10, { softMax: 2 }),
			slider('flickerRandAmp', 'Flicker Rand Amp', 1, 0, 10, { softMax: 3 }),
			slider('flickerRandFreq', 'Flicker Rand Freq', 10, 0, 100, { softMax: 30 }),
			slider('flickerWaveAmp', 'Flicker Wave Amp', 0, 0, 10, { softMax: 3 }),
			slider('flickerWaveFreq', 'Flicker Wave Freq', 5, 0, 100, { softMax: 30 }),
		]),
		...grp('Defocus Parameters', [
			slider('defocus', 'Defocus', 0, 0, 100, { softMax: 5 }),
			slider('defocusRandAmp', 'Defocus Rand Amp', 1, 0, 10, { softMax: 3 }),
			slider('defocusRandFreq', 'Defocus Rand Freq', 10, 0, 100, { softMax: 30 }),
			slider('defocusWaveAmp', 'Defocus Wave Amp', 0, 0, 10, { softMax: 3 }),
			slider('defocusWaveFreq', 'Defocus Wave Freq', 5, 0, 100, { softMax: 30 }),
		]),
		...vignetteParams(0.1, 'Vignette Parameters'),
		sapphireSeed('Seed'),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const sig = filmDamageSignals(p, ctx);
			// dust and stain counts vary per frame
			const vd = num(p.varyDustDensity, 0.2);
			const dustN =
				num(p.dustDensity, 30) * Math.max(0, 1 + vd * (stepNoise1(ctx.seed, 21, ctx.frame) * 2 - 1));
			const dust = DUST_UNIFORMS(dustN, ctx.width, ctx.height);
			const vs = num(p.varyStainDensity, 0.2);
			const stains =
				num(p.stainDensity, 0.2) * Math.max(0, 1 + vs * (stepNoise1(ctx.seed, 22, ctx.frame) * 2 - 1));
			return {
				...filmGrainUniforms(p, ctx),
				u_flickerGain: sig.flicker,
				u_defocusSigma: sig.defocus * 0.003 * ctx.width * ctx.pxScale,
				u_shakeY: sig.shake,
				u_shakeVel: sig.shakeVel,
				u_dustCellPx: dust.cell,
				u_dustProb: dust.prob,
				u_stainCount: Math.min(4, stains),
			};
		},
		passes: (p) => {
			const defocus = num(p.defocus) > 0;
			const dirt: ShaderPass[] = [
				{ output: 'dirtA', include: [GLSL_DIRT], frag: FILM_DAMAGE_DIRT_A, filter: 'nearest' },
				{ output: 'dirtB', include: [GLSL_DIRT], frag: FILM_DAMAGE_DIRT_B, filter: 'nearest' },
			];
			const final: ShaderPass = { include: [GLSL_FILM, GLSL_MB], frag: filmDamageFrag(defocus) };
			return [
				...(defocus
					? uniformBlurPasses({ input: 'source', output: 'dfc', sigmaUniform: 'u_defocusSigma' })
					: []),
				...dirt,
				final,
			];
		},
	},
});

type FlashDefaults = {
	size: number;
	stretch: number;
	rotation: number;
	brightness: number;
	center: [number, number];
	outer: [number, number, number];
	inner: [number, number, number];
	midpoint: number;
	softness: number;
	shape: 'circle' | 'polygon';
	sides: number;
	noiseAmp: number;
	noiseFreq: number;
	noiseFreqRelY: number;
	flickerAmp: number;
	flickerFreq: number;
	motionStyle: 'linear' | 'wave';
	motionAmount: number;
	motionAngle: number;
	motionFreq: number;
	motionDelay: number;
};

const FLASHES: FlashDefaults[] = [
	{
		size: 1.5,
		stretch: 1.7,
		rotation: 28,
		brightness: 1.1,
		center: [-2.25, 0],
		outer: [1, 0.337, 0.106],
		inner: [0.216, 0.251, 1],
		midpoint: 0.65,
		softness: 1.75,
		shape: 'circle',
		sides: 6,
		noiseAmp: 0,
		noiseFreq: 1,
		noiseFreqRelY: 1,
		flickerAmp: 0,
		flickerFreq: 5,
		motionStyle: 'linear',
		motionAmount: 5,
		motionAngle: 0,
		motionFreq: 0.5,
		motionDelay: 0,
	},
	{
		size: 1.16,
		stretch: 1,
		rotation: 0,
		brightness: 1.9,
		center: [-0.5, 0],
		outer: [0.275, 0.333, 0.965],
		inner: [0.4, 0, 0.6],
		midpoint: 0.5,
		softness: 2,
		shape: 'circle',
		sides: 5,
		noiseAmp: 0,
		noiseFreq: 1,
		noiseFreqRelY: 1,
		flickerAmp: 0,
		flickerFreq: 5,
		motionStyle: 'wave',
		motionAmount: 1.7,
		motionAngle: 0,
		motionFreq: 0.5,
		motionDelay: 0,
	},
	{
		size: 1.42,
		stretch: 5,
		rotation: 112,
		brightness: 0.5,
		center: [0, -2.34],
		outer: [0.765, 0.286, 0.196],
		inner: [0.8, 0.769, 0.984],
		midpoint: 1,
		softness: 0.21,
		shape: 'polygon',
		sides: 8,
		noiseAmp: 1.74,
		noiseFreq: 0,
		noiseFreqRelY: 1,
		flickerAmp: 0,
		flickerFreq: 5,
		motionStyle: 'linear',
		motionAmount: 3.6,
		motionAngle: 90,
		motionFreq: 1,
		motionDelay: 0.4,
	},
];

function flashParams(i: number, d: FlashDefaults): ParamSpec[] {
	const n = (s: string) => `${s}${i}`;
	return grp(`Flash ${i}`, [
		slider(n('size'), `Size${i}`, d.size, 0, 20, { softMax: 5 }),
		slider(n('stretch'), `Stretch${i}`, d.stretch, 0, 50, { softMax: 8 }),
		fxParam.angle(n('rotation'), `Rotation${i}`, d.rotation),
		slider(n('brightness'), `Brightness${i}`, d.brightness, undefined, undefined, { softMin: 0, softMax: 4 }),
		fxParam.point(n('center'), `Center${i}`, sapphirePoint(d.center[0], d.center[1])),
		color(n('outerColor'), `Outer Color${i}`, d.outer),
		color(n('innerColor'), `Inner Color${i}`, d.inner),
		slider(n('midpoint'), `Midpoint${i}`, d.midpoint, 0, 1),
		slider(n('softness'), `Softness${i}`, d.softness, 0, 20, { softMax: 5 }),
		fxParam.choice(n('shape'), `Shape${i}`, ['circle', 'polygon'], ['Circle', 'Polygon'], d.shape),
		intSlider(n('numSides'), `Num Sides${i}`, d.sides, 3, 16),
		slider(n('noiseAmp'), `Noise Amp${i}`, d.noiseAmp, 0, 20, { softMax: 4 }),
		slider(n('noiseFreq'), `Noise Freq${i}`, d.noiseFreq, 0, 100, { softMax: 10 }),
		slider(n('noiseFreqRelY'), `Noise Freq Rel Y${i}`, d.noiseFreqRelY, 0, 100, { softMax: 4 }),
		slider(n('flickerAmp'), `Flicker Amp${i}`, d.flickerAmp, 0, 10, { softMax: 2 }),
		slider(n('flickerFreq'), `Flicker Freq${i}`, d.flickerFreq, 0, 100, { softMax: 30 }),
		fxParam.choice(
			n('motionStyle'),
			`Motion Style${i}`,
			['linear', 'wave'],
			['Linear (constant)', 'Wave (variable)'],
			d.motionStyle,
		),
		slider(n('motionAmount'), `Motion Amount${i}`, d.motionAmount, 0, 100, { softMax: 10 }),
		fxParam.angle(n('motionAngle'), `Motion Angle${i}`, d.motionAngle),
		slider(n('motionFreq'), `Motion Freq${i}`, d.motionFreq, 0, 100, { softMax: 4 }),
		slider(n('motionDelay'), `Motion Delay${i}`, d.motionDelay, 0, 100, { softMax: 4 }),
	]);
}

/** Per-frame flash motion (Sapphire units, y up) and flicker gain of flash i (1-based). */
export function flashMotion(p: EffectParams, i: number, ctx: { frame: number; fps: number; seed: number }) {
	const t = ctx.frame / Math.max(1, ctx.fps);
	const ph = num(p[`motionFreq${i}`], 0.5) * (t - num(p[`motionDelay${i}`]));
	const wave =
		p[`motionStyle${i}`] === 'wave'
			? Math.sin(2 * Math.PI * ph)
			: 1 - 4 * Math.abs(ph - Math.floor(ph + 0.5)); // triangle (constant speed), −1..1
	const amt = num(p[`motionAmount${i}`]) * 0.1 * wave;
	const a = (num(p[`motionAngle${i}`]) * Math.PI) / 180;
	const flicker =
		1 + num(p[`flickerAmp${i}`]) * smoothNoise1(ctx.seed, 30 + i, t * num(p[`flickerFreq${i}`], 5));
	return { move: [amt * Math.cos(a), amt * Math.sin(a)] as [number, number], flicker: Math.max(0, flicker) };
}

const FLASH_GLSL = /* glsl */ `
// Light of one flash at Sapphire position s (y up): shape distance r (0 centre, 1 edge), inner→outer colour.
vec3 sfb_flash(vec2 s, vec2 centre, float size, float stretch, float rotDeg, float bright, vec3 outer, vec3 inner,
               float midpoint, float softness, int shape, float sides, float nAmp, float nFreq, float nRelY, float t, float seed) {
  vec2 d = s - centre;
  d = fx_rot(fx_deg(rotDeg)) * d;
  d.x /= max(stretch, 1.0e-3);
  float r;
  if (shape == 1) {
    float n = max(sides, 3.0);
    float a = atan(d.y, d.x);
    float seg = 6.2831853 / n;
    float m = mod(a, seg) - seg * 0.5;
    r = length(d) * cos(m) / cos(seg * 0.5);
  } else r = length(d);
  r /= max(size, 1.0e-3);
  if (nAmp > 0.0) {
    vec2 q = d * vec2(1.0, max(nRelY, 0.0)) * (nFreq + 0.5) * 2.0 + t * 0.3;
    uint id = sfg_seedU(seed);
    r *= 1.0 + 0.25 * nAmp * (sfd_noise2(q, id) * 0.65 + sfd_noise2(q * 2.1, id ^ 0x85ebca6bu) * 0.35);
  }
  float fall = pow(clamp(1.0 - r, 0.0, 1.0), max(softness, 0.05));
  vec3 col = mix(inner, outer, smoothstep(0.0, 1.0, clamp(r / max(midpoint, 0.02), 0.0, 1.0)));
  return col * fall * bright;
}
// Sprocket holes along both sides (style 0: 6 holes, 1: 10 holes, 2: one tall hole per side).
// Returns (outline coverage, hole coverage).
vec2 sfb_edges(vec2 s, vec2 centre, float size, int style, float aspect) {
  vec2 d = (s - centre) / max(size, 1.0e-3);
  float holes = style == 0 ? 6.0 : style == 1 ? 10.0 : 1.0;
  float h = aspect * 2.0;                             // frame height in Sapphire units (≈ 1.125 at 16:9)
  float pitch = h / holes;
  float x = abs(d.x) - 0.93;                          // hole column near each side
  float y = mod(d.y + h * 0.5, pitch) - pitch * 0.5;
  vec2 half_ = vec2(0.035, style == 2 ? h * 0.4 : pitch * 0.32);
  vec2 q = abs(vec2(x, y)) - half_ + 0.012;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.012;
  float px = 2.0 / 1920.0;
  float hole = 1.0 - smoothstep(-px, px, sd);
  float outline = (1.0 - smoothstep(px, px * 3.0, abs(sd))) * (1.0 - hole * 0.5);
  return vec2(outline, hole);
}
`;

/** Dirt layer A of S_FilmBurn: (scratches 1, scratches 2, hairs, 0). */
const FILM_BURN_DIRT_A = /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float hd = box.x / 1920.0;
  float s1 = 0.0, s2 = 0.0, hc = 0.0;
  if (u_scratches) {
    float sw = max(0.6, u_scratchesWidth * 40.0 * hd);
    s1 = sfd_scratches(p, box, u_scratches1Amount * 4.0, u_scratches1Length, sw, u_varyScratchesWidth, 0.0,
      u_scratchesRoughness * 3.0 * hd, u_scratchesRoughFreq, u_gaps, u_gapsFrequency, u_scratchesAreaCenter,
      u_scratchesAreaWidth, u_weaveAmount * box.x * 0.05, u_weaveFrequency, u_frame, fract(u_seed + 0.41));
    s2 = sfd_scratches(p, box, u_scratches2Amount * 4.0, u_scratches2Length, sw, u_varyScratchesWidth, 0.0,
      u_scratchesRoughness * 3.0 * hd, u_scratchesRoughFreq, u_gaps, u_gapsFrequency, u_scratchesAreaCenter,
      u_scratchesAreaWidth, u_weaveAmount * box.x * 0.05, u_weaveFrequency, u_frame, fract(u_seed + 0.53));
  }
  if (u_hairsAndStains)
    hc = sfd_hairs(p, box, u_hairsAmount, u_hairsPersistence, u_hairsWiggleAmp, u_hairsWiggleFreq,
      u_hairsSize * 0.07 * box.x, max(0.8, 1.4 * hd * u_hairsSize), u_varyHairsSize, u_frame, u_fps, fract(u_seed + 0.27));
  fragColor = vec4(s1, s2, hc, 0.0);
}`;

/** Dirt layer B of S_FilmBurn: (stain coverage, stain random, dust coverage, dust random). */
const FILM_BURN_DIRT_B = /* glsl */ `
void main() {
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  float fr = floor(u_frame);
  vec2 st = u_hairsAndStains ? sfd_stains(p, box, u_stainsDensity, u_stainsSize * 0.12 * box.x, u_varyStainsSize, fr, fract(u_seed + 0.11)) : vec2(0.0);
  vec2 du = sfd_dust(p, u_dustCellPx, u_dustProb, u_dustSize * 0.006 * box.x, u_varyDustSize, fract(u_seed + fr * 0.6180339));
  fragColor = vec4(st, du);
}`;

const FILM_BURN_FRAG = /* glsl */ `${FLASH_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  vec2 box = sfg_boxPx();
  vec2 p = fx_layerPx();
  vec2 s = sfg_sapph(p);
  float t = u_frame / max(u_fps, 1.0);
  float fr = floor(u_frame);
  float hd = box.x / 1920.0;
  // flashes
  vec3 light = vec3(0.0);
  if (u_flash1) light += sfb_flash(s, sfg_sapph(u_center1 * box) + u_move1, u_size1, u_stretch1, u_rotation1, u_brightness1 * u_flicker1,
    u_outerColor1.rgb, u_innerColor1.rgb, u_midpoint1, u_softness1, u_shape1, u_numSides1, u_noiseAmp1, u_noiseFreq1, u_noiseFreqRelY1, t, u_seed);
  if (u_flash2) light += sfb_flash(s, sfg_sapph(u_center2 * box) + u_move2, u_size2, u_stretch2, u_rotation2, u_brightness2 * u_flicker2,
    u_outerColor2.rgb, u_innerColor2.rgb, u_midpoint2, u_softness2, u_shape2, u_numSides2, u_noiseAmp2, u_noiseFreq2, u_noiseFreqRelY2, t, fract(u_seed + 0.3));
  if (u_flash3) light += sfb_flash(s, sfg_sapph(u_center3 * box) + u_move3, u_size3, u_stretch3, u_rotation3, u_brightness3 * u_flicker3,
    u_outerColor3.rgb, u_innerColor3.rgb, u_midpoint3, u_softness3, u_shape3, u_numSides3, u_noiseAmp3, u_noiseFreq3, u_noiseFreqRelY3, t, fract(u_seed + 0.6));
  if (u_flashesCombine == 0) c = mix(c, light, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));
  else if (u_flashesCombine == 1) c = c + light;
  else if (u_flashesCombine == 2) c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(light, 0.0, 1.0));
  else if (u_flashesCombine == 3) c = c * light;
  else c = fx_blendRgb(FX_BLEND_OVERLAY, clamp(c, 0.0, 1.0), clamp(light, 0.0, 1.0));
  // edges (sprocket holes)
  if (u_edges) {
    vec2 e = sfb_edges(s, sfg_sapph(u_edgesCenter * box) + u_edgesJitter, u_edgesSize, u_edgesStyle, box.y / box.x * 0.5);
    c = mix(c, u_edgesCenterColor.rgb, e.y);
    c = mix(c, u_edgesOutlineColor.rgb, e.x);
  }
  vec4 dA = texture(u_dirtA, v_uv);   // scratches 1, scratches 2, hairs
  vec4 dB = texture(u_dirtB, v_uv);   // stain coverage, stain random, dust coverage, dust random
  if (u_scratches) {
    c = sfd_combine(u_scratchesCombine, c, u_scratches1Color.rgb, dA.x * u_scratchesOpacity);
    c = sfd_combine(u_scratchesCombine, c, u_scratches2Color.rgb, dA.y * u_scratchesOpacity);
  }
  if (u_hairsAndStains) {
    c = sfd_combine(u_hairsCombine, c, u_hairsColor.rgb, dA.z * u_hairsOpacity);
    c = sfd_combine(u_stainsCombine, c, mix(u_stainsColor1.rgb, u_stainsColor2.rgb, fract(dB.y * 7.31)), dB.x * u_stainsOpacity);
  }
  if (u_dust) c = sfd_combine(u_dustCombine, c, mix(u_dustColor1.rgb, u_dustColor2.rgb, fract(dB.w * 7.31)), dB.z * u_dustOpacity);
  if (u_grain && u_grainAmp > 0.0) {
    vec3 gn = sfg_grainNoise(p, vec3(u_grainPx), u_grainMono, sfg_frameSeed(u_seed, u_frame, 1.0));
    c += gn * u_grainAmp * sfg_grainCurve(c, u_grainAmpDarks, u_grainAmpMids, u_grainAmpBrights, vec3(0.5)) * 0.03;
  }
  fragColor = sfg_out(c, src, u_mixWithOriginal);
}`;

const ELEMENT_COMBINE = ['normal', 'add', 'screen', 'mult', 'overlay', 'stencilLuma'] as const;
const ELEMENT_COMBINE_LABELS = ['Normal', 'Add', 'Screen', 'Mult', 'Overlay', 'Stencil Luma'];
const combine = (name: string, label: string, def: (typeof ELEMENT_COMBINE)[number]) =>
	fxParam.choice(name, label, ELEMENT_COMBINE, ELEMENT_COMBINE_LABELS, def);

export const S_FILM_BURN = defineShaderEffect({
	id: 'jasper.s.film-burn',
	label: 'S_FilmBurn',
	category: 'Stylize',
	bin: STYLIZE,
	description:
		'Film running slowly through the gate: up to three drifting, coloured light-leak flashes bleed over the picture, with optional sprocket edges, scratches, hairs, stains, dust and grain.',
	keywords: ['film burn', 'light leak', 'flash', 'film', 'transition', 'sprocket', 'vintage'],
	expensive: true,
	params: [
		check('flash1', 'Flash1', true),
		check('flash2', 'Flash2', true),
		check('flash3', 'Flash3', true),
		check('edges', 'Edges', false),
		check('scratches', 'Scratches', true),
		check('hairsAndStains', 'Hairs And Stains', true),
		check('dust', 'Dust', true),
		check('grain', 'Grain', true),
		...FLASHES.flatMap((d, i) => flashParams(i + 1, d)),
		fxParam.choice(
			'flashesCombine',
			'Flashes Combine',
			['normal', 'add', 'screen', 'mult', 'overlay'],
			['Normal', 'Add', 'Screen', 'Mult', 'Overlay'],
			'add',
		),
		...grp('Edges', [
			fxParam.choice(
				'edgesStyle',
				'Edges Style',
				['sprocketsA', 'sprocketsB', 'single'],
				['Sprockets Vertical A', 'Sprockets Vertical B', 'Single Vertical Sprocket'],
				'sprocketsB',
			),
			fxParam.point('edgesCenter', 'Edges Center', [0.5, 0.5]),
			slider('edgesSize', 'Edges Size', 1.13, 0, 10, { softMax: 3 }),
			fxParam.vec2('varyEdgesPos', 'Vary Edges Pos', [0, 0.01], { softMin: -0.2, softMax: 0.2, step: 0.001 }),
			color('edgesOutlineColor', 'Edges Outline Color', [1, 1, 1]),
			color('edgesCenterColor', 'Edges Center Color', [0, 0, 0]),
		]),
		...grp('Scratches', [
			slider('scratches1Amount', 'Scratches1 Amount', 0.5, 0, 4),
			slider('scratches2Amount', 'Scratches2 Amount', 0.5, 0, 4),
			slider('scratches1Length', 'Scratches1 Length', 3, 0, 1000, { softMax: 30 }),
			slider('scratches2Length', 'Scratches2 Length', 9, 0, 1000, { softMax: 30 }),
			slider('scratchesWidth', 'Scratches Width', 0.03, 0, 1, { softMax: 0.2, step: 0.001 }),
			slider('varyScratchesWidth', 'Vary Scratches Width', 1, 0, 1),
			slider('scratchesOpacity', 'Scratches Opacity', 1, 0, 1),
			slider('scratchesRoughness', 'Scratches Roughness', 0.5, 0, 20, { softMax: 4 }),
			slider('scratchesRoughFreq', 'Scratches Rough Freq', 150, 0.01, 2000, { softMax: 500, step: 1 }),
			slider('gaps', 'Gaps', 0.11, 0, 1),
			slider('gapsFrequency', 'Gaps Frequency', 150, 0, 2000, { softMax: 500, step: 1 }),
			slider('scratchesAreaCenter', 'Scratches Area Center', 0, undefined, undefined, {
				softMin: -1,
				softMax: 1,
			}),
			slider('scratchesAreaWidth', 'Scratches Area Width', 1.15, 0, 4, { softMax: 2 }),
			slider('weaveAmount', 'Weave Amount', 0, 0, 1, { softMax: 0.2, step: 0.001 }),
			slider('weaveFrequency', 'Weave Frequency', 0.01, 0.01, 10, { softMax: 1 }),
			color('scratches1Color', 'Scratches1 Color', [0, 0, 0]),
			color('scratches2Color', 'Scratches2 Color', [0.231, 0.231, 0.231]),
			combine('scratchesCombine', 'Scratches Combine', 'normal'),
		]),
		...grp('Hairs', [
			slider('hairsAmount', 'Hairs Amount', 1.5, 0, 6),
			slider('hairsPersistence', 'Hairs Persistence', 4.5, 0.1, 100, { softMax: 20 }),
			slider('hairsWiggleAmp', 'Hairs Wiggle Amp', 0, 0, 10, { softMax: 1 }),
			slider('hairsWiggleFreq', 'Hairs Wiggle Freq', 1, 0, 100, { softMax: 10 }),
			slider('hairsSize', 'Hairs Size', 1, 0, 20, { softMax: 4 }),
			slider('varyHairsSize', 'Vary Hairs Size', 1, 0, 2),
			slider('hairsOpacity', 'Hairs Opacity', 0.3, 0, 1),
			color('hairsColor', 'Hairs Color', [0, 0, 0]),
			combine('hairsCombine', 'Hairs Combine', 'normal'),
		]),
		...grp('Stains', [
			slider('stainsDensity', 'Stains Density', 0.5, 0, 4),
			slider('stainsSize', 'Stains Size', 0.5, 0, 20, { softMax: 3 }),
			slider('varyStainsSize', 'Vary Stains Size', 0, 0, 1),
			slider('stainsOpacity', 'Stains Opacity', 0.5, 0, 1),
			color('stainsColor1', 'Stains Color1', [0, 0, 0]),
			color('stainsColor2', 'Stains Color2', [0.0824, 0.0941, 0.0941]),
			combine('stainsCombine', 'Stains Combine', 'overlay'),
		]),
		...grp('Dust', [
			slider('dustDensity', 'Dust Density', 140, 0, 4000, { softMax: 600, step: 1 }),
			slider('dustSize', 'Dust Size', 0.3, 0, 20, { softMax: 3 }),
			slider('varyDustSize', 'Vary Dust Size', 0.2, 0, 1),
			slider('dustOpacity', 'Dust Opacity', 0.5, 0, 1),
			color('dustColor1', 'Dust Color1', [1, 0.996, 0.996]),
			color('dustColor2', 'Dust Color2', [0.541, 0.541, 0.541]),
			combine('dustCombine', 'Dust Combine', 'normal'),
		]),
		...grp('Grain', [
			slider('grainAmp', 'Grain Amp', 1, 0, 2),
			slider('grainSize', 'Grain Size', 1, 0.001, 20, { softMax: 4 }),
			slider('grainBlur', 'Grain Blur', 0.00208, 0, 1, { softMax: 0.02, step: 0.0001 }),
			slider('grainAmpDarks', 'Grain Amp Darks', 2, 0, 2),
			slider('grainAmpMids', 'Grain Amp Mids', 1, 0, 2),
			slider('grainAmpBrights', 'Grain Amp Brights', 0.5, 0, 2),
			check('grainMono', 'Grain Mono', false),
		]),
		sapphireSeed('Seed'),
		mixParam(),
	],
	gpu: {
		uniforms: (p, ctx) => {
			const out: Record<string, FxUniformValue> = {};
			for (const i of [1, 2, 3]) {
				const m = flashMotion(p, i, ctx);
				out[`u_move${i}`] = m.move;
				out[`u_flicker${i}`] = m.flicker;
			}
			const dust = DUST_UNIFORMS(num(p.dustDensity, 140), ctx.width, ctx.height);
			const vary = Array.isArray(p.varyEdgesPos) ? (p.varyEdgesPos as number[]) : [0, 0.01];
			out.u_edgesJitter = [
				num(vary[0]) * (stepNoise1(ctx.seed, 41, ctx.frame) * 2 - 1),
				num(vary[1]) * (stepNoise1(ctx.seed, 42, ctx.frame) * 2 - 1),
			];
			out.u_dustCellPx = dust.cell;
			out.u_dustProb = bool(p.dust, true) ? dust.prob : 0;
			out.u_grainPx = Math.max(
				0.6,
				num(p.grainSize, 1) * hdPx(ctx) * (1 + Math.max(0, num(p.grainBlur, 0.00208)) * 1920 * 0.35),
			);
			return out;
		},
		passes: [
			{ output: 'dirtA', include: [GLSL_DIRT], frag: FILM_BURN_DIRT_A, filter: 'nearest' },
			{ output: 'dirtB', include: [GLSL_DIRT], frag: FILM_BURN_DIRT_B, filter: 'nearest' },
			{ include: [GLSL_COMBINE, GLSL_UV], frag: FILM_BURN_FRAG },
		],
	},
});

export const FILM_EFFECTS: readonly EffectSpec[] = [S_FILM_EFFECT, S_FILM_DAMAGE, S_FILM_BURN];
