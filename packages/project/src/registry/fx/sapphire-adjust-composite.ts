// Effect family "sapphire-adjust-composite" (fx catalogue, wave 2): Sapphire-style Adjust effects (channel and colour
// adjustments, tone maps, thresholds, colour-space conversion, gamut checks) and Composite effects (blend/maths/matte/
// depth composites with a second picture).
// Behaviour, parameter names, order, ranges and defaults follow Boris FX's public Sapphire documentation (OFX/AE
// reference pages); the maths is our own. Conventions of this family:
// - Adjust effects work on straight (un-premultiplied) display-referred RGB in 0..1, keep alpha unless the effect is
//   about alpha, and end with Sapphire's Mask block (Mask input + Mask Use / Blur Mask / Invert Mask; white = effect).
//   "Mix With Source" (Sapphire's name) exists only where Sapphire has it and drives the framework's
//   `mixWithOriginal` uniform.
// - Sapphire takes extra pictures (Background, Source B, Matte, Mask, Depth) as layer inputs; here they are `media`
//   params (a project image/video at the layer's clip-local time), mapped onto the layer box by "Input Fit". The
//   effect's own layer is the Foreground / Source A. Mocha blocks, Load/Save Preset buttons and host-only options
//   are not reproduced.
// - Sapphire's relative widths (Blur Mask, Flash Width, Noise Width, …) are fractions of the layer height, blur
//   widths being the reach (≈ 3σ); Shrink/Grow, Edge Softness and Post Blur are layer pixels.
// - All realizations are GPU shaders (not `color` LUT ops): the effects need alpha, masks, Mix With Source and exact
//   thresholds that a fused LUT cannot express.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. Family helpers live in ./sapphire-adjust-composite/.
import type { EffectCategory, EffectParams, EffectSpec, ParamSpec } from '../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from './define.ts';
import { GLSL_BLEND } from './glsl/blend.ts';
import { GLSL_COMPOSITE } from './glsl/composite.ts';
import { GLSL_HASH } from './glsl/hash.ts';
import { fxParam } from './params.ts';
import { gaussianBlurPasses } from './passes.ts';
import {
	bool,
	GLSL_SAC_COMMON,
	inputFitParam,
	maskGlsl,
	maskParams,
	maskPasses,
	mediaSet,
	mixWithSourceParam,
	num,
	relSigma,
	str,
} from './sapphire-adjust-composite/common.ts';
import {
	filterIndex,
	filterParam,
	GLSL_SAC_MATTE,
	matteFilterPasses,
	matteShaped,
	matteShapeExpr,
	matteUniforms,
	noiseParams,
	postBlurParam,
	postBlurSigma,
	shrinkGrowParams,
} from './sapphire-adjust-composite/matte.ts';
import {
	GLSL_SAC_OCIO,
	OCIO_CURVES,
	OCIO_SPACES,
	ocioMatrix,
	ocioSpace,
	toColumnMajor,
} from './sapphire-adjust-composite/ocio.ts';
import type { FxPlanContext, FxUniformValue, GlslChunk, ShaderPass } from './shader.ts';

// ---------------------------------------------------------------- param shorthands

/** A Sapphire "any"-range number: wide hard limits, a practical slider range. */
const anyNum = (name: string, label: string, def: number, softMin: number, softMax: number, step = 0.01) =>
	fxParam.number(name, label, def, { min: -100, max: 100, softMin, softMax, step });
const lights = (name: string, label: string, def = 1) =>
	fxParam.number(name, label, def, { min: 0, max: 100, softMax: 4, step: 0.01 });
const darks = (name: string, label: string) =>
	fxParam.number(name, label, 0, { min: -8, max: 2, softMin: -1, softMax: 1, step: 0.01 });
const saturation = (name: string, label: string, min = -2, max = 8) =>
	fxParam.number(name, label, 1, { min, max, softMin: Math.max(min, 0), softMax: 2, step: 0.01 });
const rgb = (r: number, g: number, b: number): [number, number, number, number] => [r, g, b, 1];

// ---------------------------------------------------------------- Adjust effects: one pointwise pass

type AdjustInit = {
	id: string;
	label: string;
	category?: EffectCategory;
	description: string;
	keywords?: readonly string[];
	/** The effect's own params, in Sapphire's order. */
	params: ParamSpec[];
	/** Sapphire's "Mix With Source" (only where Sapphire has it). */
	mix?: boolean;
	/** Sapphire's Mask block (default true). */
	mask?: boolean;
	/** GLSL defining `vec4 sac_apply(vec4 c)`: straight RGBA (rgb clamped 0..1) in, straight RGBA out. */
	glsl: string;
	include?: GlslChunk[];
	uniforms?: (p: EffectParams, ctx: FxPlanContext) => Record<string, FxUniformValue>;
	/** Passes before the pointwise pass and the texture it reads as input (default `u_source`). */
	pre?: (p: EffectParams, ctx: FxPlanContext) => { passes: ShaderPass[]; input: string };
	timeInvariant?: boolean;
};

function adjustEffect(init: AdjustInit): EffectSpec {
	const withMask = init.mask !== false;
	return defineShaderEffect({
		id: init.id,
		label: init.label,
		category: init.category ?? 'Color Correction',
		bin: SAPPHIRE_BINS.adjust,
		description: init.description,
		keywords: init.keywords,
		params: [...init.params, ...(init.mix ? [mixWithSourceParam()] : []), ...(withMask ? maskParams() : [])],
		gpu: {
			...(init.timeInvariant ? { timeInvariant: true } : {}),
			...(init.uniforms ? { uniforms: init.uniforms } : {}),
			passes: (p, ctx) => {
				const pre = init.pre?.(p, ctx) ?? { passes: [], input: 'u_source' };
				const mask = withMask ? maskPasses(p, ctx) : [];
				return [
					...pre.passes,
					...mask,
					{
						include: [GLSL_SAC_COMMON, GLSL_COMPOSITE, ...(init.include ?? [])],
						frag: /* glsl */ `
${init.glsl}
${withMask ? maskGlsl(p, ctx) : 'float sac_mask() { return 1.0; }'}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 c = fx_unpremultiply(texture(${pre.input}, v_uv));
  c.rgb = clamp(c.rgb, 0.0, 1.0);
  vec4 r = sac_apply(c);
  float a = clamp(r.a, 0.0, 1.0);
  vec4 res = vec4(clamp(r.rgb, 0.0, 1.0) * a, a);
  ${init.mix ? 'res = fx_mixOriginal(res, src, u_mixWithOriginal);' : ''}
  fragColor = mix(src, res, sac_mask());
}`,
					},
				];
			},
		},
	});
}

// ---- S_ChannelSwitcher

const CHANNELS = ['red', 'green', 'blue', 'alpha', 'luma', 'one', 'zero'] as const;
const CHANNEL_LABELS = ['Red', 'Green', 'Blue', 'Alpha', 'Luma', '1', '0'] as const;
const channelFrom = (name: string, label: string, def: (typeof CHANNELS)[number]) =>
	fxParam.choice(name, label, CHANNELS, CHANNEL_LABELS, def);

export const S_CHANNEL_SWITCHER = adjustEffect({
	id: 'jasper.s.channel-switcher',
	label: 'S_ChannelSwitcher',
	description:
		'Routes any source channel (red, green, blue, alpha, luma, 1, 0) to each output channel, then scales the lights ' +
		'and offsets the darks per channel.',
	keywords: ['channel', 'shuffle', 'swap', 'rgba', 'alpha', 'luma'],
	params: [
		channelFrom('redFrom', 'Red <-', 'red'),
		channelFrom('greenFrom', 'Green <-', 'green'),
		channelFrom('blueFrom', 'Blue <-', 'blue'),
		channelFrom('alphaFrom', 'Alpha <-', 'alpha'),
		anyNum('scaleLightsRed', 'Scale Lights Red', 1, 0, 2),
		anyNum('scaleLightsGreen', 'Scale Lights Green', 1, 0, 2),
		anyNum('scaleLightsBlue', 'Scale Lights Blue', 1, 0, 2),
		anyNum('scaleLightsAlpha', 'Scale Lights Alpha', 1, 0, 2),
		anyNum('offsetDarksRed', 'Offset Darks Red', 0, -1, 1),
		anyNum('offsetDarksGreen', 'Offset Darks Green', 0, -1, 1),
		anyNum('offsetDarksBlue', 'Offset Darks Blue', 0, -1, 1),
		anyNum('offsetDarksAlpha', 'Offset Darks Alpha', 0, -1, 1),
		fxParam.toggle('outputPremult', 'Output Premult', false),
	],
	mix: true,
	glsl: /* glsl */ `
float sac_channel(vec4 c, int k) {
  if (k == 0) return c.r;
  if (k == 1) return c.g;
  if (k == 2) return c.b;
  if (k == 3) return c.a;
  if (k == 4) return fx_luma(c.rgb);
  return k == 5 ? 1.0 : 0.0;
}
vec4 sac_apply(vec4 c) {
  vec4 o = vec4(sac_channel(c, u_redFrom), sac_channel(c, u_greenFrom), sac_channel(c, u_blueFrom), sac_channel(c, u_alphaFrom));
  vec4 l = vec4(u_scaleLightsRed, u_scaleLightsGreen, u_scaleLightsBlue, u_scaleLightsAlpha);
  vec4 d = vec4(u_offsetDarksRed, u_offsetDarksGreen, u_offsetDarksBlue, u_offsetDarksAlpha);
  o = o * l + d * (1.0 - clamp(o, 0.0, 1.0));
  if (u_outputPremult) o.rgb *= clamp(o.a, 0.0, 1.0);
  return o;
}`,
});

// ---- S_ClampChroma

export const S_CLAMP_CHROMA = adjustEffect({
	id: 'jasper.s.clamp-chroma',
	label: 'S_ClampChroma',
	description:
		'Limits chroma to a maximum (broadcast-safe colours) without changing luma; can also scale chroma, clamp and ' +
		'scale luma.',
	keywords: ['chroma', 'saturation', 'legal', 'broadcast safe', 'clamp', 'limit'],
	params: [
		fxParam.number('clampChroma', 'Clamp Chroma', 0.5, { min: 0, max: 1, step: 0.001 }),
		fxParam.number('scaleChroma', 'Scale Chroma', 1, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		fxParam.number('clampLuma', 'Clamp Luma', 1, { min: 0, max: 1, step: 0.001 }),
		fxParam.number('scaleLuma', 'Scale Luma', 1, { min: 0, max: 100, softMax: 4, step: 0.01 }),
	],
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  float y = fx_luma(c.rgb);
  vec3 ch = (c.rgb - vec3(y)) * u_scaleChroma;
  float k = max(ch.r, max(ch.g, ch.b)) - min(ch.r, min(ch.g, ch.b));
  if (k > u_clampChroma) ch *= u_clampChroma / max(k, 1.0e-6);
  y = min(y * u_scaleLuma, u_clampLuma);
  return vec4(vec3(y) + ch, c.a);
}`,
});

// ---- S_DuoTone

export const S_DUO_TONE = adjustEffect({
	id: 'jasper.s.duo-tone',
	label: 'S_DuoTone',
	description:
		'Maps the brightness of the source onto a blend between two colours (Color0 in the darks, Color1 in the lights).',
	keywords: ['duotone', 'gradient map', 'two tone', 'tint', 'colorize'],
	params: [
		fxParam.color('color1', 'Color1', rgb(1, 0.9, 0.8)),
		fxParam.color('color0', 'Color0', rgb(0, 0, 0.2)),
		fxParam.toggle('invert', 'Invert', false),
		anyNum('threshold', 'Threshold', 0.5, 0, 1, 0.001),
		fxParam.number('softness', 'Softness', 1, { min: 0.001, max: 100, softMax: 2, step: 0.001 }),
	],
	mix: true,
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  float t = clamp((fx_luma(c.rgb) - u_threshold) / max(u_softness, 0.001) + 0.5, 0.0, 1.0);
  if (u_invert) t = 1.0 - t;
  return vec4(mix(u_color0.rgb, u_color1.rgb, t), c.a);
}`,
});

// ---- S_Gamma

const gammaNum = (name: string, label: string) =>
	fxParam.number(name, label, 1, { min: 0.1, max: 10, softMax: 4, step: 0.001 });

export const S_GAMMA = adjustEffect({
	id: 'jasper.s.gamma',
	label: 'S_Gamma',
	category: 'Adjust',
	description:
		'Gamma correction, overall and per channel (values above 1 brighten the mid-tones); From Gamma divides the gamma ' +
		'(applies the inverse), then lights are scaled and darks offset.',
	keywords: ['gamma', 'midtones', 'levels', 'brightness'],
	params: [
		gammaNum('gamma', 'Gamma'),
		gammaNum('gammaRed', 'Gamma Red'),
		gammaNum('gammaGreen', 'Gamma Green'),
		gammaNum('gammaBlue', 'Gamma Blue'),
		gammaNum('fromGamma', 'From Gamma'),
		gammaNum('fromGammaRed', 'From Gamma Red'),
		gammaNum('fromGammaGreen', 'From Gamma Green'),
		gammaNum('fromGammaBlue', 'From Gamma Blue'),
		lights('scaleLights', 'Scale Lights'),
		lights('scaleLightsRed', 'Scale Lights Red'),
		lights('scaleLightsGreen', 'Scale Lights Green'),
		lights('scaleLightsBlue', 'Scale Lights Blue'),
		darks('offsetDarks', 'Offset Darks'),
		darks('offsetDarksRed', 'Offset Darks Red'),
		darks('offsetDarksGreen', 'Offset Darks Green'),
		darks('offsetDarksBlue', 'Offset Darks Blue'),
	],
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  vec3 g = u_gamma * vec3(u_gammaRed, u_gammaGreen, u_gammaBlue);
  vec3 from = max(u_fromGamma * vec3(u_fromGammaRed, u_fromGammaGreen, u_fromGammaBlue), vec3(0.01));
  g = max(g / from, vec3(0.001));
  vec3 o = pow(max(c.rgb, vec3(0.0)), 1.0 / g);
  o = sac_lightsDarks(o, u_scaleLights * vec3(u_scaleLightsRed, u_scaleLightsGreen, u_scaleLightsBlue),
    vec3(u_offsetDarks) + vec3(u_offsetDarksRed, u_offsetDarksGreen, u_offsetDarksBlue));
  return vec4(o, c.a);
}`,
});

// ---- S_Hotspots

export const S_HOTSPOTS = adjustEffect({
	id: 'jasper.s.hotspots',
	label: 'S_Hotspots',
	category: 'Adjust',
	description:
		'Keeps only the areas brighter than a threshold (any channel above it), in their original colours, black ' +
		'elsewhere; the input can be blurred first. Useful as a glow source.',
	keywords: ['highlights', 'bright', 'threshold', 'glow source', 'isolate'],
	params: [
		fxParam.number('blurInput', 'Blur Input', 0, { min: 0, max: 10, softMax: 0.5, step: 0.001 }),
		fxParam.number('threshold', 'Threshold', 0.7, { min: 0, max: 10, softMax: 1, step: 0.001 }),
		fxParam.color('thresholdAddColor', 'Threshold Add Color', rgb(0, 0, 0)),
		anyNum('saturation', 'Saturation', 1, 0, 2),
		lights('brightness', 'Brightness'),
	],
	pre: (p, ctx) => {
		const sigma = relSigma(num(p, 'blurInput'), ctx);
		if (sigma < 0.05) return { passes: [], input: 'u_source' };
		return { passes: gaussianBlurPasses({ input: 'source', output: 'hotBlur', sigma }), input: 'u_hotBlur' };
	},
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  vec3 over = c.rgb - (vec3(u_threshold) + u_thresholdAddColor.rgb);
  float hot = clamp(max(over.r, max(over.g, over.b)) * 255.0 + 0.5, 0.0, 1.0);
  vec3 o = c.rgb * hot;
  float y = fx_luma(o);
  o = (vec3(y) + (o - vec3(y)) * u_saturation) * u_brightness;
  return vec4(o, c.a);
}`,
});

// ---- S_HueSatBright

export const S_HUE_SAT_BRIGHT = adjustEffect({
	id: 'jasper.s.hue-sat-bright',
	label: 'S_HueSatBright',
	description:
		'Hue shift (in revolutions, optionally preserving luma), saturation (negative inverts the chroma), brightness, ' +
		'per-channel colour scale and dark offset.',
	keywords: ['hue', 'saturation', 'brightness', 'hsb', 'hsv', 'color'],
	params: [
		fxParam.number('hueShift', 'Hue Shift', 0, { min: -1, max: 1, step: 0.001 }),
		fxParam.toggle('preserveLuma', 'Preserve Luma', false),
		saturation('saturation', 'Saturation'),
		lights('brightness', 'Brightness'),
		fxParam.color('scaleColors', 'Scale Colors', rgb(1, 1, 1)),
		darks('offsetDarks', 'Offset Darks'),
	],
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  vec3 o = c.rgb;
  if (u_hueShift != 0.0) {
    float y0 = fx_luma(o);
    o = fx_hueShift(o, u_hueShift);
    if (u_preserveLuma) o += y0 - fx_luma(o);
  }
  float y = fx_luma(o);
  o = vec3(y) + (o - vec3(y)) * u_saturation;
  o *= u_brightness * u_scaleColors.rgb;
  o = sac_lightsDarks(o, vec3(1.0), vec3(u_offsetDarks));
  return vec4(o, c.a);
}`,
});

// ---- S_Invert

export const S_INVERT = adjustEffect({
	id: 'jasper.s.invert',
	label: 'S_Invert',
	category: 'Adjust',
	description:
		'Inverts luma and/or chroma (both = a full negative), single RGB channels and alpha, with lights/darks tinting ' +
		'and saturation of the result.',
	keywords: ['invert', 'negative', 'luma', 'chroma', 'alpha'],
	params: [
		fxParam.toggle('invertLuma', 'Invert Luma', true),
		fxParam.toggle('invertChroma', 'Invert Chroma', true),
		fxParam.toggle('invertRed', 'Invert Red', false),
		fxParam.toggle('invertGreen', 'Invert Green', false),
		fxParam.toggle('invertBlue', 'Invert Blue', false),
		fxParam.toggle('invertAlpha', 'Invert Alpha', false),
		fxParam.toggle('remultByAlpha', 'Remult By Alpha', true),
		lights('scaleLights', 'Scale Lights'),
		fxParam.color('tintLights', 'Tint Lights', rgb(1, 1, 1)),
		fxParam.color('tintDarks', 'Tint Darks', rgb(0, 0, 0)),
		darks('offsetDarks', 'Offset Darks'),
		saturation('saturation', 'Saturation'),
	],
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  // Remult By Alpha: invert the straight colour and re-premultiply; off: invert the premultiplied values.
  vec3 x = u_remultByAlpha ? c.rgb : c.rgb * c.a;
  float y = fx_luma(x);
  vec3 ch = x - vec3(y);
  if (u_invertLuma) y = 1.0 - y;
  if (u_invertChroma) ch = -ch;
  x = vec3(y) + ch;
  if (u_invertRed) x.r = 1.0 - x.r;
  if (u_invertGreen) x.g = 1.0 - x.g;
  if (u_invertBlue) x.b = 1.0 - x.b;
  float a = u_invertAlpha ? 1.0 - c.a : c.a;
  float yy = fx_luma(x);
  x = vec3(yy) + (x - vec3(yy)) * u_saturation;
  x = sac_lightsDarks(x, u_scaleLights * u_tintLights.rgb, u_tintDarks.rgb + vec3(u_offsetDarks));
  if (!u_remultByAlpha) x = a > 0.0 ? clamp(x, vec3(0.0), vec3(a)) / a : vec3(0.0);
  return vec4(x, a);
}`,
});

// ---- S_Monochrome

export const S_MONOCHROME = adjustEffect({
	id: 'jasper.s.monochrome',
	label: 'S_Monochrome',
	description:
		'Black and white from a weighted mix of red, green and blue (weights normalised to sum to 1), with brightness.',
	keywords: ['black and white', 'grayscale', 'greyscale', 'mono', 'desaturate', 'channel mixer'],
	params: [
		fxParam.number('weightRed', 'Weight Red', 0.3, { min: -1, max: 1, step: 0.001 }),
		fxParam.number('weightGreen', 'Weight Green', 0.5, { min: -1, max: 1, step: 0.001 }),
		fxParam.number('weightBlue', 'Weight Blue', 0.2, { min: -1, max: 1, step: 0.001 }),
		lights('brightness', 'Brightness'),
	],
	mix: true,
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  vec3 w = vec3(u_weightRed, u_weightGreen, u_weightBlue);
  float s = w.r + w.g + w.b;
  if (abs(s) > 1.0e-4) w /= s;
  return vec4(vec3(dot(c.rgb, w) * u_brightness), c.a);
}`,
});

// ---- S_OCIOTransform

const OCIO_VALUES = OCIO_SPACES.map((s) => s.value);
const OCIO_LABELS = OCIO_SPACES.map((s) => s.label);

/** The conversion S_OCIOTransform applies for its params: curves (GLSL ids) and the primaries matrix. */
export function ocioTransformOf(p: EffectParams) {
	let from = ocioSpace(str(p, 'from', 'logc3'));
	let to = ocioSpace(str(p, 'to', 'rec709'));
	if (bool(p, 'switchToAndFrom')) [from, to] = [to, from];
	return { from, to, matrix: ocioMatrix(from, to) };
}

export const S_OCIO_TRANSFORM = adjustEffect({
	id: 'jasper.s.ocio-transform',
	label: 'S_OCIOTransform',
	description:
		'Converts between colour spaces (sRGB, Rec.709, Rec.1886, Rec.2020, linear, ACEScg, ACEScct, ACES2065-1, ARRI ' +
		'LogC3, Sony S-Log3, Panasonic V-Log) with the published curves and matrices. Built-in spaces only: custom ' +
		'OpenColorIO configs, looks and display/view tone mapping are not supported.',
	keywords: [
		'ocio',
		'opencolorio',
		'aces',
		'log',
		'logc',
		'slog',
		'vlog',
		'colour space',
		'color space',
		'rec709',
		'linear',
	],
	params: [
		fxParam.choice('from', 'From', OCIO_VALUES, OCIO_LABELS, 'logc3'),
		fxParam.choice('to', 'To', OCIO_VALUES, OCIO_LABELS, 'rec709'),
		fxParam.toggle('switchToAndFrom', 'Switch To And From', false),
	],
	include: [GLSL_SAC_OCIO],
	uniforms: (p) => {
		const t = ocioTransformOf(p);
		return {
			u_ocioMatrix: { mat3: toColumnMajor(t.matrix) },
			u_ocioFrom: { int: OCIO_CURVES.indexOf(t.from.curve) },
			u_ocioTo: { int: OCIO_CURVES.indexOf(t.to.curve) },
		};
	},
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  vec3 lin = u_ocioMatrix * sac_ocioDecode3(u_ocioFrom, c.rgb);
  return vec4(sac_ocioEncode3(u_ocioTo, lin), c.a);
}`,
});

// ---- S_TriTone / S_QuadTone (brightness → colour stops)

/**
 * Colour stops of the Tri/QuadTone tone map, sorted by their "At Bright" position. `soft` is the softness of the
 * segment from a stop to the next (Softness × Softness ij): 1 = a linear blend across the whole segment, smaller
 * values a sharper transition at its middle (0.001 ≈ posterised); values above 1 act as 1.
 */
export function toneStops(p: EffectParams, n: 3 | 4) {
	const defaults = n === 4 ? [0, 0.33, 0.66, 1] : [0, 0.5, 1];
	const softness = Math.max(0.001, num(p, 'softness', 1));
	const stops = Array.from({ length: n }, (_, i) => {
		const col = p[`color${i}`];
		const color: [number, number, number] =
			Array.isArray(col) && col.length >= 3
				? [Number(col[0]) || 0, Number(col[1]) || 0, Number(col[2]) || 0]
				: [defaults[i]!, defaults[i]!, defaults[i]!];
		const seg = i < n - 1 ? Math.max(0.001, num(p, `softness${i}${i + 1}`, 1)) : 1;
		return { pos: num(p, `color${i}AtBright`, defaults[i]!), color, soft: Math.min(1, softness * seg) };
	});
	return stops.sort((a, b) => a.pos - b.pos);
}

function toneUniforms(p: EffectParams, n: 3 | 4): Record<string, FxUniformValue> {
	const s = toneStops(p, n);
	const at = (i: number) => s[Math.min(i, n - 1)]!;
	return {
		u_stopCount: { int: n },
		u_stopPos: { floats: [0, 1, 2, 3].map((i) => at(i).pos) },
		u_segSoft: { floats: [0, 1, 2].map((i) => at(i).soft) },
		u_stopCol0: at(0).color,
		u_stopCol1: at(1).color,
		u_stopCol2: at(2).color,
		u_stopCol3: at(3).color,
	};
}

const TONE_GLSL = /* glsl */ `
vec4 sac_apply(vec4 c) {
  float b = fx_luma(c.rgb);
  vec3 cols[4] = vec3[4](u_stopCol0, u_stopCol1, u_stopCol2, u_stopCol3);
  int n = u_stopCount;
  vec3 o = cols[n - 1];
  if (b <= u_stopPos[0]) o = cols[0];
  else {
    for (int i = 0; i < 3; i++) {
      if (i >= n - 1) break;
      float p0 = u_stopPos[i];
      float p1 = u_stopPos[i + 1];
      if (b <= p1) {
        float t = p1 > p0 ? (b - p0) / (p1 - p0) : 1.0;
        t = clamp((t - 0.5) / max(u_segSoft[i], 0.001) + 0.5, 0.0, 1.0);
        o = mix(cols[i], cols[i + 1], t);
        break;
      }
    }
  }
  return vec4(o, c.a);
}`;

const softnessNum = (name: string, label: string) =>
	fxParam.number(name, label, 1, { min: 0.001, max: 100, softMax: 1, step: 0.001 });
const atBright = (name: string, label: string, def: number) => anyNum(name, label, def, 0, 1, 0.001);

export const S_TRI_TONE = adjustEffect({
	id: 'jasper.s.tri-tone',
	label: 'S_TriTone',
	description: 'Maps the brightness of the source onto three colours placed at given brightness levels.',
	keywords: ['tritone', 'gradient map', 'three tone', 'tint', 'colorize'],
	params: [
		fxParam.color('color2', 'Color2', rgb(1, 1, 1)),
		fxParam.color('color1', 'Color1', rgb(0.5, 0.5, 0.5)),
		fxParam.color('color0', 'Color0', rgb(0, 0, 0)),
		softnessNum('softness', 'Softness'),
		softnessNum('softness12', 'Softness 12'),
		softnessNum('softness01', 'Softness 01'),
		atBright('color2AtBright', 'Color2 At Bright', 1),
		atBright('color1AtBright', 'Color1 At Bright', 0.5),
		atBright('color0AtBright', 'Color0 At Bright', 0),
	],
	mix: true,
	uniforms: (p) => toneUniforms(p, 3),
	glsl: TONE_GLSL,
});

export const S_QUAD_TONE = adjustEffect({
	id: 'jasper.s.quad-tone',
	label: 'S_QuadTone',
	description: 'Maps the brightness of the source onto four colours placed at given brightness levels.',
	keywords: ['quadtone', 'gradient map', 'four tone', 'tint', 'colorize'],
	params: [
		fxParam.color('color3', 'Color3', rgb(1, 1, 1)),
		fxParam.color('color2', 'Color2', rgb(0.66, 0.66, 0.66)),
		fxParam.color('color1', 'Color1', rgb(0.33, 0.33, 0.33)),
		fxParam.color('color0', 'Color0', rgb(0, 0, 0)),
		softnessNum('softness', 'Softness'),
		softnessNum('softness23', 'Softness 23'),
		softnessNum('softness12', 'Softness 12'),
		softnessNum('softness01', 'Softness 01'),
		atBright('color3AtBright', 'Color3 At Bright', 1),
		atBright('color2AtBright', 'Color2 At Bright', 0.66),
		atBright('color1AtBright', 'Color1 At Bright', 0.33),
		atBright('color0AtBright', 'Color0 At Bright', 0),
	],
	mix: true,
	uniforms: (p) => toneUniforms(p, 4),
	glsl: TONE_GLSL,
});

// ---- S_Threshold

export const S_THRESHOLD = adjustEffect({
	id: 'jasper.s.threshold',
	label: 'S_Threshold',
	category: 'Adjust',
	description:
		'Pushes each colour channel to full on or off around a threshold with a softness (per-channel threshold offsets ' +
		'and softness); Saturation is applied to the source first (0 = a black and white threshold).',
	keywords: ['threshold', 'posterize', 'high contrast', 'black and white', 'binarize'],
	params: [
		fxParam.number('threshold', 'Threshold', 0.5, { min: 0, max: 10, softMax: 1, step: 0.001 }),
		fxParam.color('thresholdAddColor', 'Threshold Add Color', rgb(0, 0, 0)),
		fxParam.number('softness', 'Softness', 0.2, { min: 0.001, max: 1, step: 0.001 }),
		fxParam.number('softRelRed', 'Soft Rel Red', 1, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		fxParam.number('softRelGreen', 'Soft Rel Green', 1, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		fxParam.number('softRelBlue', 'Soft Rel Blue', 1, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		anyNum('saturation', 'Saturation', 1, 0, 2),
	],
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  float y = fx_luma(c.rgb);
  vec3 s = vec3(y) + (c.rgb - vec3(y)) * u_saturation;
  vec3 thr = vec3(u_threshold) + u_thresholdAddColor.rgb;
  vec3 soft = max(u_softness * vec3(u_softRelRed, u_softRelGreen, u_softRelBlue), vec3(0.001));
  return vec4(clamp((s - thr) / soft + 0.5, 0.0, 1.0), c.a);
}`,
});

// ---- S_Tint

export const S_TINT = adjustEffect({
	id: 'jasper.s.tint',
	label: 'S_Tint',
	description:
		'Tints the lights (multiply) and the darks (add) towards given colours, after adjusting the source saturation.',
	keywords: ['tint', 'colorize', 'toning', 'sepia', 'lights', 'darks'],
	params: [
		fxParam.color('tintLights', 'Tint Lights', rgb(1, 1, 1)),
		fxParam.color('tintDarks', 'Tint Darks', rgb(0, 0, 0)),
		saturation('sourceSaturation', 'Source Saturation'),
		lights('scaleLights', 'Scale Lights'),
		darks('offsetDarks', 'Offset Darks'),
	],
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  float y = fx_luma(c.rgb);
  vec3 s = vec3(y) + (c.rgb - vec3(y)) * u_sourceSaturation;
  return vec4(sac_lightsDarks(s, u_tintLights.rgb * u_scaleLights, u_tintDarks.rgb + vec3(u_offsetDarks)), c.a);
}`,
});

// ---- S_ShowBadColors

const unit = (name: string, label: string, def: number) =>
	fxParam.number(name, label, def, { min: 0, max: 1, step: 0.001 });

export const S_SHOW_BAD_COLORS = adjustEffect({
	id: 'jasper.s.show-bad-colors',
	label: 'S_ShowBadColors',
	category: 'Utility',
	description:
		'Flags pixels outside channel, luma, chroma or per-channel limits with a solid High/Low colour (high wins), or ' +
		'outputs a matte of them (white = bad).',
	keywords: ['legal', 'broadcast safe', 'gamut', 'out of range', 'clipping', 'qc', 'check'],
	params: [
		unit('min', 'Min', 0),
		unit('max', 'Max', 1),
		unit('minLuma', 'Min Luma', 0),
		unit('maxLuma', 'Max Luma', 1),
		unit('minChroma', 'Min Chroma', 0),
		unit('maxChroma', 'Max Chroma', 1),
		fxParam.color('minRgb', 'Min Rgb', rgb(0, 0, 0)),
		fxParam.color('maxRgb', 'Max Rgb', rgb(1, 1, 1)),
		fxParam.color('highColor', 'High Color', rgb(1, 0, 0)),
		fxParam.color('lowColor', 'Low Color', rgb(0, 0, 1)),
		fxParam.toggle('outputMatte', 'Output Matte', false),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
	],
	mask: false,
	timeInvariant: true,
	glsl: /* glsl */ `
vec4 sac_apply(vec4 c) {
  vec3 v = c.rgb;
  float y = fx_luma(v);
  float k = max(v.r, max(v.g, v.b)) - min(v.r, min(v.g, v.b));
  const float e = 0.5 / 255.0;
  bool high = any(greaterThan(v, vec3(u_max + e))) || y > u_maxLuma + e || k > u_maxChroma + e
    || any(greaterThan(v, u_maxRgb.rgb + e));
  bool low = any(lessThan(v, vec3(u_min - e))) || y < u_minLuma - e || k < u_minChroma - e
    || any(lessThan(v, u_minRgb.rgb - e));
  if (u_outputMatte) {
    float m = (high || low) ? 1.0 : 0.0;
    if (u_invertMatte) m = 1.0 - m;
    return vec4(vec3(m), 1.0);
  }
  if (high) return vec4(u_highColor.rgb, c.a);
  if (low) return vec4(u_lowColor.rgb, c.a);
  return c;
}`,
});

// ---------------------------------------------------------------- Composite effects

const compositeBase = {
	category: 'Utility' as EffectCategory,
	bin: SAPPHIRE_BINS.composite,
};

// ---- S_Layer

const LAYER_MODES = [
	'normal',
	'dissolve',
	'multiply',
	'screen',
	'overlay',
	'softLight',
	'hardLight',
	'colorDodge',
	'colorBurn',
	'darken',
	'lighten',
	'add',
	'subtract',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'chroma',
	'luminance',
	'linearDodge',
	'linearBurn',
	'linearLight',
	'vividLight',
	'pinLight',
] as const;
const LAYER_MODE_LABELS = [
	'Normal',
	'Dissolve',
	'Multiply',
	'Screen',
	'Overlay',
	'Soft Light',
	'Hard Light',
	'Color Dodge',
	'Color Burn',
	'Darken',
	'Lighten',
	'Add',
	'Subtract',
	'Difference',
	'Exclusion',
	'Hue',
	'Saturation',
	'Chroma',
	'Luminance',
	'Linear Dodge',
	'Linear Burn',
	'Linear Light',
	'Vivid Light',
	'Pin Light',
] as const;

/** S_Layer's blend modes on straight colour (b = Background, f = Foreground), Sapphire's menu order. */
export const GLSL_SAC_LAYER_BLEND: GlslChunk = {
	name: 'sapphire-adjust-composite/layer-blend',
	deps: [GLSL_BLEND],
	source: /* glsl */ `
float sac_lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 sac_clipColor(vec3 c) {
  float l = sac_lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = vec3(l) + (c - vec3(l)) * l / max(l - n, 1.0e-6);
  if (x > 1.0) c = vec3(l) + (c - vec3(l)) * (1.0 - l) / max(x - l, 1.0e-6);
  return c;
}
vec3 sac_setLum(vec3 c, float l) { return sac_clipColor(c + vec3(l - sac_lum(c))); }
float sac_satOf(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 sac_setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float d = max(c.r, max(c.g, c.b)) - mn;
  return d > 1.0e-6 ? (c - vec3(mn)) * s / d : vec3(0.0);
}
vec3 sac_layerBlend(int mode, vec3 b, vec3 f) {
  if (mode == 2) return b * f;
  if (mode == 3) return b + f - b * f;
  if (mode == 4) return fx_overlayRgb(b, f);
  if (mode == 5) return fx_softLightRgb(b, f);
  if (mode == 6) return fx_overlayRgb(f, b);
  if (mode == 7) return fx_blendRgb(FX_BLEND_COLOR_DODGE, b, f);
  if (mode == 8) return fx_blendRgb(FX_BLEND_COLOR_BURN, b, f);
  if (mode == 9) return min(b, f);
  if (mode == 10) return max(b, f);
  if (mode == 11) return b + f;
  if (mode == 12) return b - f;
  if (mode == 13) return abs(b - f);
  if (mode == 14) return b + f - 2.0 * b * f;
  if (mode == 15) return sac_setLum(sac_setSat(f, sac_satOf(b)), sac_lum(b));
  if (mode == 16) return sac_setLum(sac_setSat(b, sac_satOf(f)), sac_lum(b));
  if (mode == 17) return sac_setLum(f, sac_lum(b));
  if (mode == 18) return sac_setLum(b, sac_lum(f));
  if (mode == 19) return min(b + f, vec3(1.0));
  if (mode == 20) return b + f - 1.0;
  if (mode == 21) return b + 2.0 * f - 1.0;
  if (mode == 22) {
    vec3 burn = fx_blendRgb(FX_BLEND_COLOR_BURN, b, min(2.0 * f, vec3(1.0)));
    vec3 dodge = fx_blendRgb(FX_BLEND_COLOR_DODGE, b, max(2.0 * f - 1.0, vec3(0.0)));
    return mix(burn, dodge, step(0.5, f));
  }
  if (mode == 23) return mix(min(b, 2.0 * f), max(b, 2.0 * f - 1.0), step(0.5, f));
  return f;
}
// Foreground (straight colour fc, coverage fa) over a premultiplied Background with a blend mode (W3C model).
vec4 sac_comp(int mode, vec4 B, vec3 fc, float fa) {
  vec3 bc = sac_straight(B);
  vec3 mixed = (1.0 - B.a) * fc + B.a * clamp(sac_layerBlend(mode, bc, fc), 0.0, 1.0);
  return vec4(fa * mixed + (1.0 - fa) * B.rgb, fa + B.a * (1.0 - fa));
}
`,
};

const hueShift = (name: string, label: string) => anyNum(name, label, 0, -1, 1, 0.001);
const blurAmount = (name: string, label: string) =>
	fxParam.number(name, label, 0, { min: 0, max: 10, softMax: 0.5, step: 0.001 });

/** A picture as GLSL (premultiplied, on the canvas layout): the layer or a media input. */
const layerPic = 'texture(u_source, v_uv)';
const mediaPic = (name: string) => `sac_media(u_${name}, u_${name}_size, u_inputFit)`;

/**
 * Optional blur of a picture expression: returns the passes (render the picture, blur it) and the expression of the
 * blurred picture, or no passes and the expression itself when the blur is 0.
 */
function blurredPic(expr: string, name: string, sigma: number, include: GlslChunk[]) {
	if (sigma < 0.05) return { passes: [] as ShaderPass[], expr };
	return {
		passes: [
			{ output: `${name}Pic`, include, frag: `void main() { fragColor = ${expr}; }` },
			...gaussianBlurPasses({ input: `${name}Pic`, output: `${name}Soft`, sigma }),
		] as ShaderPass[],
		expr: `texture(u_${name}Soft, v_uv)`,
	};
}

export const S_LAYER = defineShaderEffect({
	...compositeBase,
	id: 'jasper.s.layer',
	label: 'S_Layer',
	description:
		'Composites the layer (Foreground) over a Background picture with 24 blend modes, an optional Matte, and ' +
		'lights/darks/saturation/hue/blur controls for each input and the result. Background and Matte are media inputs.',
	keywords: ['blend', 'composite', 'layer', 'mode', 'multiply', 'screen', 'overlay', 'dissolve', 'matte'],
	params: [
		fxParam.media('background', 'Background'),
		fxParam.media('matte', 'Matte'),
		inputFitParam(),
		fxParam.choice('effect', 'Effect', LAYER_MODES, LAYER_MODE_LABELS, 'normal'),
		fxParam.toggle('swapInputs', 'Swap Inputs', false),
		fxParam.number('fgOpacity', 'Fg Opacity', 1, { min: 0, max: 1, step: 0.001 }),
		anyNum('fgLights', 'Fg Lights', 1, 0, 2),
		anyNum('fgDarks', 'Fg Darks', 0, -1, 1),
		anyNum('fgSaturation', 'Fg Saturation', 1, 0, 2),
		hueShift('fgHueShift', 'Fg Hue Shift'),
		blurAmount('fgBlur', 'Fg Blur'),
		anyNum('bgLights', 'Bg Lights', 1, 0, 2),
		anyNum('bgDarks', 'Bg Darks', 0, -1, 1),
		anyNum('bgSaturation', 'Bg Saturation', 1, 0, 2),
		hueShift('bgHueShift', 'Bg Hue Shift'),
		blurAmount('bgBlur', 'Bg Blur'),
		anyNum('resultLights', 'Result Lights', 1, 0, 2),
		anyNum('resultDarks', 'Result Darks', 0, -1, 1),
		anyNum('resultSaturation', 'Result Saturation', 1, 0, 2),
		hueShift('resultHueShift', 'Result Hue Shift'),
		fxParam.toggle('compPremult', 'Comp Premult', true),
		fxParam.choice(
			'matteUse',
			'Matte Use',
			['luma', 'alpha', 'allOpaque'],
			['Luma', 'Alpha', 'All Opaque'],
			'alpha',
		),
	],
	gpu: {
		passes: (p, ctx) => {
			const swap = bool(p, 'swapInputs');
			const inc = [GLSL_SAC_COMMON];
			const fg = blurredPic(
				swap ? mediaPic('background') : layerPic,
				'fg',
				relSigma(num(p, 'fgBlur'), ctx),
				inc,
			);
			const bg = blurredPic(
				swap ? layerPic : mediaPic('background'),
				'bg',
				relSigma(num(p, 'bgBlur'), ctx),
				inc,
			);
			const matte = mediaSet(p, 'matte');
			return [
				...fg.passes,
				...bg.passes,
				{
					include: [GLSL_SAC_COMMON, GLSL_SAC_LAYER_BLEND, GLSL_HASH],
					frag: /* glsl */ `
vec3 sac_adjust(vec3 c, float l, float d, float s, float h) {
  c = sac_grade(c, l, d, s);
  return h != 0.0 ? fx_hueShift(clamp(c, 0.0, 1.0), h) : c;
}
void main() {
  vec4 F = ${fg.expr};
  vec4 B = ${bg.expr};
  vec3 fc;
  float fa;
  ${
		matte
			? `vec4 M = ${mediaPic('matte')};
  bool hasMatte = u_matte_size.x > 0.0;`
			: 'vec4 M = vec4(0.0);\n  bool hasMatte = false;'
	}
  if (hasMatte) {
    fa = sac_matteOf(M, u_matteUse);
    fc = u_compPremult ? clamp(F.rgb / max(fa, 1.0e-4), 0.0, 1.0) : sac_straight(F);
  } else {
    fc = u_compPremult ? sac_straight(F) : clamp(F.rgb, 0.0, 1.0);
    fa = u_matteUse == 0 ? fx_luma(sac_straight(F)) * F.a : (u_matteUse == 1 ? F.a : 1.0);
  }
  fa *= clamp(u_fgOpacity, 0.0, 1.0);
  fc = clamp(sac_adjust(fc, u_fgLights, u_fgDarks, u_fgSaturation, u_fgHueShift), 0.0, 1.0);
  vec3 bc = clamp(sac_adjust(sac_straight(B), u_bgLights, u_bgDarks, u_bgSaturation, u_bgHueShift), 0.0, 1.0);
  B = vec4(bc * B.a, B.a);
  int mode = u_effect;
  if (mode == 1) {
    fa = float(fx_hash2(ivec2(fx_canvasPx()), u_seed)) < fa ? 1.0 : 0.0;
    mode = 0;
  }
  vec4 r = sac_comp(mode, B, fc, fa);
  vec3 rc = clamp(sac_adjust(sac_straight(r), u_resultLights, u_resultDarks, u_resultSaturation, u_resultHueShift), 0.0, 1.0);
  fragColor = vec4(rc * r.a, r.a);
}`,
				},
			];
		},
	},
});

// ---- S_MathOps

const MATH_OPS = [
	'add',
	'subtract',
	'multiply',
	'divide',
	'screen',
	'average',
	'overlay',
	'minimum',
	'maximum',
	'difference',
	'xor',
	'xorBits',
	'andBits',
	'orBits',
	'mod',
	'round',
	'bounce',
] as const;
const MATH_OP_LABELS = [
	'Add',
	'Subtract',
	'Multiply',
	'Divide',
	'Screen',
	'Average',
	'Overlay',
	'Minimum',
	'Maximum',
	'Difference',
	'Xor',
	'Xor Bits',
	'And Bits',
	'Or Bits',
	'Mod',
	'Round',
	'Bounce',
] as const;

export const GLSL_SAC_MATH: GlslChunk = {
	name: 'sapphire-adjust-composite/math-ops',
	source: /* glsl */ `
float sac_bits(float a, float b, int op) {
  int x = int(clamp(a, 0.0, 1.0) * 255.0 + 0.5);
  int y = int(clamp(b, 0.0, 1.0) * 255.0 + 0.5);
  int r = op == 11 ? (x ^ y) : (op == 12 ? (x & y) : (x | y));
  return float(r) / 255.0;
}
float sac_math1(int op, float a, float b) {
  if (op == 0) return a + b;
  if (op == 1) return a - b;
  if (op == 2) return a * b;
  if (op == 3) return b > 1.0e-5 ? a / b : (a > 0.0 ? 1.0 : 0.0);
  if (op == 4) return a + b - a * b;
  if (op == 5) return 0.5 * (a + b);
  if (op == 6) return b < 0.5 ? 2.0 * a * b : 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
  if (op == 7) return min(a, b);
  if (op == 8) return max(a, b);
  if (op == 9) return abs(a - b);
  if (op == 10) return a + b - 2.0 * a * b;
  if (op >= 11 && op <= 13) return sac_bits(a, b, op);
  if (b <= 1.0e-5) return a;
  if (op == 14) return mod(a, b);
  if (op == 15) return floor(a / b + 0.5) * b;
  float t = mod(a, 2.0 * b);
  return t > b ? 2.0 * b - t : t;
}
vec4 sac_math(int op, vec4 a, vec4 b) {
  return vec4(sac_math1(op, a.r, b.r), sac_math1(op, a.g, b.g), sac_math1(op, a.b, b.b), sac_math1(op, a.a, b.a));
}
`,
};

export const S_MATH_OPS = defineShaderEffect({
	...compositeBase,
	id: 'jasper.s.math-ops',
	label: 'S_MathOps',
	description:
		'Combines the layer (A) and a second picture (B, a media input) per channel with a maths operation (add, ' +
		'subtract, multiply, divide, screen, min/max, difference, bitwise ops, mod, round, …); alpha is processed like ' +
		'any channel unless Opacity is All Opaque.',
	keywords: [
		'math',
		'arithmetic',
		'add',
		'subtract',
		'multiply',
		'difference',
		'xor',
		'composite',
		'channel ops',
	],
	params: [
		fxParam.media('sourceB', 'Source B'),
		inputFitParam(),
		fxParam.choice('operation', 'Operation', MATH_OPS, MATH_OP_LABELS, 'add'),
		fxParam.toggle('swapInputs', 'Swap Inputs', false),
		lights('aLights', 'A Lights'),
		anyNum('aDarks', 'A Darks', 0, -1, 1),
		saturation('aSaturation', 'A Saturation', 0, 100),
		lights('bLights', 'B Lights'),
		anyNum('bDarks', 'B Darks', 0, -1, 1),
		saturation('bSaturation', 'B Saturation', 0, 100),
		lights('destLights', 'Dest Lights'),
		anyNum('destDarks', 'Dest Darks', 0, -1, 1),
		saturation('destSaturation', 'Dest Saturation', 0, 100),
		fxParam.choice('opacity', 'Opacity', ['allOpaque', 'normal'], ['All Opaque', 'Normal'], 'normal'),
		...maskParams(),
	],
	gpu: {
		passes: (p, ctx) => {
			const swap = bool(p, 'swapInputs');
			return [
				...maskPasses(p, ctx),
				{
					include: [GLSL_SAC_COMMON, GLSL_SAC_MATH],
					frag: /* glsl */ `
${maskGlsl(p, ctx)}
vec4 sac_input(vec4 p, float l, float d, float s, bool opaque) {
  vec3 c = opaque ? clamp(p.rgb, 0.0, 1.0) : sac_straight(p);
  float a = opaque ? 1.0 : p.a;
  return vec4(sac_grade(c, l, d, s) * a, a);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  bool opaque = u_opacity == 0;
  vec4 A = sac_input(${swap ? mediaPic('sourceB') : layerPic}, u_aLights, u_aDarks, u_aSaturation, opaque);
  vec4 B = sac_input(${swap ? layerPic : mediaPic('sourceB')}, u_bLights, u_bDarks, u_bSaturation, opaque);
  vec4 r = clamp(sac_math(u_operation, A, B), 0.0, 1.0);
  if (opaque) r.a = 1.0;
  vec3 rc = r.a > 0.0 ? r.rgb / r.a : vec3(0.0);
  float ra = r.a;
  rc = clamp(sac_grade(clamp(rc, 0.0, 1.0), u_destLights, u_destDarks, u_destSaturation), 0.0, 1.0);
  fragColor = mix(src, vec4(rc * ra, ra), sac_mask());
}`,
				},
			];
		},
	},
});

// ---- S_MatteOps / S_MatteOpsComp (matte shaping)

const OUTPUTS = ['matte', 'rgba', 'rgbaPremult', 'mattePremult'] as const;
const OUTPUT_LABELS = ['Matte', 'RGBA', 'RGBA Premult', 'Matte Premult'] as const;

/**
 * The matte passes: `rawExpr` (GLSL matte value of the input) → optional shaping (filter blur + re-threshold with
 * noise) → optional Post Blur. Returns the passes and the GLSL expression of the final matte (before Invert).
 */
function mattePipeline(
	p: EffectParams,
	ctx: FxPlanContext,
	rawExpr: string,
	opts: { relX: boolean; jitter: boolean; filter: 'param' | 'gauss'; include: GlslChunk[] },
) {
	const passes: ShaderPass[] = [];
	const shaped = matteShaped(p, ctx);
	const post = postBlurSigma(p, ctx);
	if (!shaped && post < 0.05) return { passes, expr: rawExpr };
	passes.push({
		output: 'matteSrc',
		include: opts.include,
		frag: `void main() { fragColor = vec4(${rawExpr}); }`,
	});
	let tex = 'matteSrc';
	if (shaped) {
		const filter =
			opts.filter === 'gauss' ? 'gauss' : (['box', 'triangle', 'gauss'] as const)[filterIndex(p)]!;
		passes.push(...matteFilterPasses('matteSrc', 'matteLevel', filter, matteUniforms(p, ctx).u_matteReach));
		const filterId = String(['box', 'triangle', 'gauss'].indexOf(filter));
		passes.push({
			output: 'matteShaped',
			include: [GLSL_SAC_MATTE],
			frag: `void main() { fragColor = vec4(${matteShapeExpr('texture(u_matteLevel, v_uv).r', { ...opts, filter: filterId })}); }`,
		});
		tex = 'matteShaped';
	}
	if (post >= 0.05) {
		passes.push(...gaussianBlurPasses({ input: tex, output: 'mattePost', sigma: post }));
		tex = 'mattePost';
	}
	return { passes, expr: `texture(u_${tex}, v_uv).r` };
}

const matteUseParam = () =>
	fxParam.choice('matteUse', 'Matte Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'alpha');

export const S_MATTE_OPS = defineShaderEffect({
	...compositeBase,
	category: 'Keying',
	id: 'jasper.s.matte-ops',
	label: 'S_MatteOps',
	description:
		'Shrinks or grows the matte (alpha or luma) of the layer with a soft edge, optional edge noise and post blur, and ' +
		'outputs it as a matte or as the layer’s new alpha (e.g. to choke a key).',
	keywords: ['matte', 'choke', 'spread', 'shrink', 'grow', 'erode', 'dilate', 'alpha', 'key'],
	params: [
		...shrinkGrowParams(),
		postBlurParam(),
		filterParam(),
		matteUseParam(),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
		fxParam.choice('output', 'Output', OUTPUTS, OUTPUT_LABELS, 'rgba'),
		...noiseParams({ relX: true, jitter: true }),
	],
	gpu: {
		uniforms: (p, ctx) => matteUniforms(p, ctx),
		passes: (p, ctx) => {
			const m = mattePipeline(p, ctx, 'sac_matteOf(texture(u_source, v_uv), u_matteUse)', {
				relX: true,
				jitter: true,
				filter: 'param',
				include: [GLSL_SAC_COMMON],
			});
			return [
				...m.passes,
				{
					include: [GLSL_SAC_COMMON],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float m = clamp(${m.expr}, 0.0, 1.0);
  if (u_invertMatte) m = 1.0 - m;
  vec3 c = sac_straight(src);
  if (u_output == 0) fragColor = vec4(vec3(m), 1.0);
  else if (u_output == 1) fragColor = vec4(c * m, m);
  else if (u_output == 2) fragColor = vec4(c * m * m, m);
  else fragColor = vec4(m);
}`,
				},
			];
		},
	},
});

export const S_MATTE_OPS_COMP = defineShaderEffect({
	...compositeBase,
	category: 'Keying',
	id: 'jasper.s.matte-ops-comp',
	label: 'S_MatteOpsComp',
	description:
		'Shrinks/grows the Foreground matte (the layer’s alpha or luma, or a separate Matte input) like S_MatteOps, then ' +
		'composites the layer over a Background picture with it. Background and Matte are media inputs.',
	keywords: ['matte', 'choke', 'shrink', 'grow', 'composite', 'key', 'background'],
	params: [
		fxParam.media('background', 'Background'),
		fxParam.media('matte', 'Matte'),
		inputFitParam(),
		...shrinkGrowParams(),
		postBlurParam(),
		filterParam(),
		matteUseParam(),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
		...noiseParams({ relX: true, jitter: true }),
	],
	gpu: {
		uniforms: (p, ctx) => matteUniforms(p, ctx),
		passes: (p, ctx) => {
			const raw = mediaSet(p, 'matte')
				? `(u_matte_size.x > 0.0 ? sac_matteOf(${mediaPic('matte')}, u_matteUse) : sac_matteOf(texture(u_source, v_uv), u_matteUse))`
				: 'sac_matteOf(texture(u_source, v_uv), u_matteUse)';
			const m = mattePipeline(p, ctx, raw, {
				relX: true,
				jitter: true,
				filter: 'param',
				include: [GLSL_SAC_COMMON],
			});
			return [
				...m.passes,
				{
					include: [GLSL_SAC_COMMON, GLSL_BLEND],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float m = clamp(${m.expr}, 0.0, 1.0);
  if (u_invertMatte) m = 1.0 - m;
  vec4 front = vec4(sac_straight(src) * m, m);
  fragColor = fx_over(front, ${mediaPic('background')});
}`,
				},
			];
		},
	},
});

// ---- S_EdgeFlash

export const S_EDGE_FLASH = defineShaderEffect({
	...compositeBase,
	id: 'jasper.s.edge-flash',
	label: 'S_EdgeFlash',
	description:
		'Light wrap: light from the Background flashes onto the edges of the layer (Foreground) and light from the ' +
		'Foreground onto the Background, then the layer is composited over it, as if both were exposed together. ' +
		'Background and Matte are media inputs.',
	keywords: ['light wrap', 'edge', 'flash', 'composite', 'glow', 'integrate', 'spill'],
	params: [
		fxParam.media('background', 'Background'),
		fxParam.media('matte', 'Matte'),
		inputFitParam(),
		fxParam.choice('effect', 'Effect', ['original', 'lightWrap'], ['Original', 'LightWrap'], 'original'),
		fxParam.number('fgFlashAmp', 'Fg Flash Amp', 0.8, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		fxParam.number('bgFlashAmp', 'Bg Flash Amp', 0.8, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		fxParam.number('flashWidth', 'Flash Width', 0.088, { min: 0, max: 10, softMax: 0.5, step: 0.001 }),
		anyNum('fgLights', 'Fg Lights', 1, 0, 2),
		anyNum('fgDarks', 'Fg Darks', 0, -1, 1),
		saturation('fgSaturation', 'Fg Saturation', 0, 100),
		anyNum('bgLights', 'Bg Lights', 1, 0, 2),
		anyNum('bgDarks', 'Bg Darks', 0, -1, 1),
		saturation('bgSaturation', 'Bg Saturation', 0, 100),
		fxParam.choice(
			'output',
			'Output',
			['foreground', 'background', 'comp'],
			['Foreground', 'Background', 'Comp'],
			'comp',
		),
		fxParam.toggle('compPremult', 'Comp Premult', true),
		matteUseParam(),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
		...shrinkGrowParams(),
		postBlurParam(),
		...noiseParams({ relX: false, jitter: false }),
	],
	gpu: {
		uniforms: (p, ctx) => {
			// Post Blur folds into the edge ramp here (a Gaussian of σ on a hard edge ≈ a ramp of 2.5σ), which keeps the
			// effect within the framework's texture budget.
			const u = matteUniforms(p, ctx);
			const post = 2.5 * postBlurSigma(p, ctx);
			return { ...u, u_matteSoft: Math.hypot(u.u_matteSoft, post), u_matteReach: u.u_matteReach + post };
		},
		passes: (p, ctx) => {
			const hasMatte = mediaSet(p, 'matte');
			const shaped = matteShaped(p, ctx) || postBlurSigma(p, ctx) >= 0.05;
			const reach = matteUniforms(p, ctx).u_matteReach + 2.5 * postBlurSigma(p, ctx);
			const sigma = relSigma(num(p, 'flashWidth', 0.088), ctx);
			const scale = sigma > 8 ? 0.5 : 1;
			// The raw (input) matte and the straight Foreground colour (Comp Premult as in S_Layer).
			const common = /* glsl */ `
float sac_rawMatte() {
  ${hasMatte ? `if (u_matte_size.x > 0.0) return sac_matteOf(${mediaPic('matte')}, u_matteUse);` : ''}
  return sac_matteOf(texture(u_source, v_uv), u_matteUse);
}
float sac_fm() {
  float m = ${shaped ? `${matteShapeExpr('texture(u_matteLevel, v_uv).r', { relX: false, jitter: false, filter: '2' })}` : 'sac_rawMatte()'};
  return u_invertMatte ? 1.0 - m : m;
}
vec3 sac_front() {
  vec4 F = texture(u_source, v_uv);
  bool sep = ${hasMatte ? 'u_matte_size.x > 0.0' : 'false'};
  vec3 c = sep ? (u_compPremult ? clamp(F.rgb / max(sac_rawMatte(), 1.0e-4), 0.0, 1.0) : sac_straight(F))
               : (u_compPremult ? sac_straight(F) : clamp(F.rgb, 0.0, 1.0));
  return clamp(sac_grade(c, u_fgLights, u_fgDarks, u_fgSaturation), 0.0, 1.0);
}
vec4 sac_back() {
  vec4 B = ${mediaPic('background')};
  return vec4(clamp(sac_grade(sac_straight(B), u_bgLights, u_bgDarks, u_bgSaturation), 0.0, 1.0) * B.a, B.a);
}`;
			const inc = [GLSL_SAC_COMMON, GLSL_SAC_MATTE];
			const passes: ShaderPass[] = [];
			if (shaped) {
				passes.push({
					output: 'matteSrc',
					include: inc,
					frag: 'void main() { fragColor = vec4(sac_matteOf(texture(u_source, v_uv), u_matteUse)); }',
				});
				if (hasMatte)
					passes[0]!.frag = `void main() { fragColor = vec4(u_matte_size.x > 0.0 ? sac_matteOf(${mediaPic('matte')}, u_matteUse) : sac_matteOf(texture(u_source, v_uv), u_matteUse)); }`;
				passes.push(...matteFilterPasses('matteSrc', 'matteLevel', 'gauss', reach));
			}
			passes.push(
				{
					output: 'fgPic',
					include: inc,
					frag: `${common}\nvoid main() { float m = sac_fm(); fragColor = vec4(sac_front() * m, m); }`,
				},
				...gaussianBlurPasses({ input: 'fgPic', output: 'fgGlow', sigma, scale }),
				{
					output: 'bgPic',
					include: inc,
					frag: `${common}\nvoid main() { float m = sac_fm(); vec4 B = sac_back(); fragColor = vec4(B.rgb * (1.0 - m), 1.0 - m); }`,
				},
				...gaussianBlurPasses({ input: 'bgPic', output: 'bgGlow', sigma, scale }),
				{
					include: [...inc, GLSL_BLEND],
					frag: /* glsl */ `
${common}
void main() {
  float m = sac_fm();
  vec3 fc = sac_front();
  vec4 B = sac_back();
  vec4 fg = texture(u_fgGlow, v_uv);
  vec4 bg = texture(u_bgGlow, v_uv);
  vec3 f2;
  vec4 b2;
  if (u_effect == 0) {
    // Original: additive light (premultiplied blurred light of the other layer).
    f2 = fc + u_bgFlashAmp * bg.rgb;
    b2 = fx_addLight(B, u_fgFlashAmp * fg.rgb);
  } else {
    // LightWrap: the average colour of the other layer nearby, screened in by how much of it is nearby.
    vec3 bgCol = bg.a > 1.0e-4 ? bg.rgb / bg.a : vec3(0.0);
    vec3 fgCol = fg.a > 1.0e-4 ? fg.rgb / fg.a : vec3(0.0);
    vec3 lf = clamp(bgCol * u_bgFlashAmp * bg.a, 0.0, 1.0);
    vec3 lb = clamp(fgCol * u_fgFlashAmp * fg.a, 0.0, 1.0);
    f2 = fc + lf - fc * lf;
    vec3 bc = sac_straight(B);
    b2 = vec4((bc + lb - bc * lb) * B.a, B.a);
  }
  vec4 front = vec4(clamp(f2, 0.0, 1.0) * m, m);
  b2 = clamp(b2, 0.0, 1.0);
  if (u_output == 0) fragColor = front;
  else if (u_output == 1) fragColor = b2;
  else fragColor = fx_over(front, b2);
}`,
				},
			);
			return passes;
		},
	},
});

// ---- S_ZComp

export const S_Z_COMP = defineShaderEffect({
	...compositeBase,
	id: 'jasper.s.z-comp',
	label: 'S_ZComp',
	description:
		'Depth composite: per pixel, the nearer of the layer (A) and a second picture (B) is placed in front, judged by ' +
		'two depth maps (darker = nearer unless Invert Z), with an anti-alias blend over a depth range. Source B and the ' +
		'depth maps are media inputs; without Depth A the layer counts as nearest, without Depth B the picture as farthest.',
	keywords: ['depth', 'z', 'zbuffer', 'composite', 'occlusion', '3d'],
	params: [
		fxParam.media('sourceB', 'Source B'),
		fxParam.media('depthA', 'Depth A'),
		fxParam.media('depthB', 'Depth B'),
		inputFitParam(),
		fxParam.number('antiAlias', 'Anti Alias', 0, { min: 0, max: 1, step: 0.001 }),
		fxParam.toggle('invertZ', 'Invert Z', false),
	],
	gpu: {
		passes: [
			{
				include: [GLSL_SAC_COMMON, GLSL_BLEND],
				frag: /* glsl */ `
float sac_depth(sampler2D t, vec2 size, float missing) {
  if (size.x <= 0.0) return missing;
  float z = fx_luma(sac_straight(sac_media(t, size, u_inputFit)));
  return u_invertZ ? 1.0 - z : z;
}
void main() {
  vec4 A = texture(u_source, v_uv);
  vec4 B = sac_media(u_sourceB, u_sourceB_size, u_inputFit);
  float za = sac_depth(u_depthA, u_depthA_size, 0.0);
  float zb = sac_depth(u_depthB, u_depthB_size, 1.0);
  float w = u_antiAlias > 0.0 ? clamp(0.5 + (zb - za) / u_antiAlias, 0.0, 1.0) : (za <= zb ? 1.0 : 0.0);
  fragColor = mix(fx_over(B, A), fx_over(A, B), w);
}`,
			},
		],
	},
});

export const SAPPHIRE_ADJUST_COMPOSITE_EFFECTS: readonly EffectSpec[] = [
	// Sapphire Adjust
	S_CHANNEL_SWITCHER,
	S_CLAMP_CHROMA,
	S_DUO_TONE,
	S_GAMMA,
	S_HOTSPOTS,
	S_HUE_SAT_BRIGHT,
	S_INVERT,
	S_MONOCHROME,
	S_OCIO_TRANSFORM,
	S_QUAD_TONE,
	S_THRESHOLD,
	S_TINT,
	S_TRI_TONE,
	S_SHOW_BAD_COLORS,
	// Sapphire Composite
	S_EDGE_FLASH,
	S_LAYER,
	S_MATH_OPS,
	S_MATTE_OPS,
	S_MATTE_OPS_COMP,
	S_Z_COMP,
];
