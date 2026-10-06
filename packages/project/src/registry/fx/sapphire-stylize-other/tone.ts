// "Sapphire other stylize" family — tone/colour effects: S_BandPass, S_DogVision, S_PseudoColor, S_PsykoBlobs,
// S_PsykoStripes, S_Solarize, S_Zebrafy, S_ZebrafyColor. Parameter names, order, ranges and defaults follow Boris FX's
// public Sapphire documentation (After Effects/Premiere host); Mocha/preset/Opacity-handling params are omitted (the
// framework works in premultiplied alpha; masks come from the Mask input). Clean-room implementations.
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import { fxParam, sapphireCommonParams, seedParam, showParam } from '../params.ts';
import {
	blurPasses,
	GLSL_SSO_COMMON,
	GLSL_SSO_MASK,
	GLSL_SSO_MASK_ONLY,
	GLSL_SSO_PSYKO,
	maskParams,
	num,
	psykoColorParams,
	sapphireBlurPx,
	sNum,
} from './common.ts';

const BIN = SAPPHIRE_BINS.stylize;

// ---------------------------------------------------------------- S_BandPass

export const S_BAND_PASS: EffectSpec = defineShaderEffect({
	id: 'jasper.s.band-pass',
	label: 'S_BandPass',
	category: 'Stylize',
	bin: BIN,
	description:
		'X-ray-like band-pass filter: the difference of two blurs of different widths, scaled and offset by a grey value. Blur widths: 1.0 = a sigma of 3 % of the layer width.',
	keywords: ['x-ray', 'xray', 'band pass', 'difference of gaussians', 'edges', 'emboss'],
	params: [
		sNum('blurAmount1', 'Blur Amount1', 0.112, { min: 0, softMax: 1 }),
		sNum('blurAmount2', 'Blur Amount2', 0.224, { min: 0, softMax: 1 }),
		fxParam.vec2('blurRel', 'Blur Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		sNum('brightness', 'Brightness', 3, { softMin: 0, softMax: 10 }),
		sNum('saturation', 'Saturation', 1, { softMin: -2, softMax: 8 }),
		sNum('offsetDarks', 'Offset Darks', 0.5, { softMin: -1, softMax: 2 }),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => {
			const rel = Array.isArray(p.blurRel) ? (p.blurRel as number[]) : [1, 1];
			const b1 = sapphireBlurPx(p.blurAmount1, ctx);
			const b2 = sapphireBlurPx(p.blurAmount2, ctx);
			return [
				...blurPasses({
					input: 'source',
					output: 'low1',
					sigmaX: b1 * num(rel[0], 1),
					sigmaY: b1 * num(rel[1], 1),
				}),
				...blurPasses({
					input: 'source',
					output: 'low2',
					sigmaX: b2 * num(rel[0], 1),
					sigmaY: b2 * num(rel[1], 1),
				}),
				{
					include: [GLSL_SSO_COMMON, GLSL_SSO_MASK],
					frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 d = (texture(u_low1, v_uv).rgb - texture(u_low2, v_uv).rgb) * u_brightness;
  d = fx_saturate(d, u_saturation);
  vec3 c = clamp(sso_offsetDarks(d, u_offsetDarks), 0.0, 1.0);
  fragColor = sso_finish(vec4(c * src.a, src.a), src, -1.0);
}`,
				},
			];
		},
	},
});

// ---------------------------------------------------------------- S_DogVision

export const S_DOG_VISION: EffectSpec = defineShaderEffect({
	id: 'jasper.s.dog-vision',
	label: 'S_DogVision',
	category: 'Stylize',
	bin: BIN,
	description:
		'Two-colour-channel (dichromatic) version of the picture, as a dog might see it: yellow-blue, cyan-red or magenta-green.',
	keywords: ['dichromat', 'color blind', 'colour blind', 'two color', 'duotone', 'animal vision'],
	params: [
		fxParam.choice(
			'channels',
			'Channels',
			['yellowBlue', 'cyanRed', 'magentaGreen'],
			['Yellow-Blue', 'Cyan-Red', 'Magenta-Green'],
			'yellowBlue',
		),
		fxParam.angle('rotateChannels', 'Rotate Channels', 0),
		sNum('blurChannel1', 'Blur Channel1', 0, { min: 0, softMax: 1 }),
		sNum('blurChannel2', 'Blur Channel2', 0, { min: 0, softMax: 1 }),
		sNum('mixOriginal', 'Mix Original', 0, { softMin: -1, softMax: 1 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { min: -8, max: 2, softMin: -1, softMax: 1 }),
		sNum('saturation', 'Saturation', 1, { min: -2, max: 8, softMax: 4 }),
		sNum('weightSourceR', 'Weight Source R', 1, { softMin: 0, softMax: 2 }),
		sNum('weightSourceG', 'Weight Source G', 1, { softMin: 0, softMax: 2 }),
		sNum('weightSourceB', 'Weight Source B', 1, { softMin: 0, softMax: 2 }),
		showParam(),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			{
				// Channel 1 (the warm/primary pair member) in r, channel 2 in g; straight values × alpha.
				output: 'chans',
				format: 'rgba16f',
				frag: /* glsl */ `
void main() {
  vec4 s = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(s).rgb * vec3(u_weightSourceR, u_weightSourceG, u_weightSourceB);
  vec2 ch = u_channels == 0 ? vec2((c.r + c.g) * 0.5, c.b)
          : u_channels == 1 ? vec2((c.g + c.b) * 0.5, c.r)
          : vec2((c.r + c.b) * 0.5, c.g);
  fragColor = vec4(ch * s.a, 0.0, s.a);
}`,
			},
			...blurPasses({
				input: 'chans',
				output: 'ch1',
				sigmaX: sapphireBlurPx(p.blurChannel1, ctx),
				format: 'rgba16f',
			}),
			...blurPasses({
				input: 'chans',
				output: 'ch2',
				sigmaX: sapphireBlurPx(p.blurChannel2, ctx),
				format: 'rgba16f',
			}),
			{
				include: [GLSL_SSO_COMMON, GLSL_SSO_MASK_ONLY],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 a = texture(u_ch1, v_uv), b = texture(u_ch2, v_uv);
  float ch1 = a.a > 0.0 ? a.r / a.a : 0.0;
  float ch2 = b.a > 0.0 ? b.g / b.a : 0.0;
  vec3 col1 = u_channels == 0 ? vec3(1.0, 1.0, 0.0) : u_channels == 1 ? vec3(0.0, 1.0, 1.0) : vec3(1.0, 0.0, 1.0);
  vec3 col2 = u_channels == 0 ? vec3(0.0, 0.0, 1.0) : u_channels == 1 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  float turns = u_rotateChannels / 360.0;
  if (turns != 0.0) { col1 = fx_hueShift(col1, turns); col2 = fx_hueShift(col2, turns); }
  vec3 dog = ch1 * col1 + ch2 * col2;
  dog = fx_saturate(dog, u_saturation) * u_brightness;
  dog = sso_offsetDarks(dog, u_offsetDarks);
  vec3 c = clamp(mix(dog, fx_unpremultiply(src).rgb, u_mixOriginal), 0.0, 1.0);
  float m = sso_mask();
  fragColor = fx_finish(mix(src, vec4(c * src.a, src.a), m), src, m, 0.0, u_show);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_PseudoColor

export const S_PSEUDO_COLOR: EffectSpec = defineShaderEffect({
	id: 'jasper.s.pseudo-color',
	label: 'S_PseudoColor',
	category: 'Stylize',
	bin: BIN,
	description:
		'Colourises the picture: the hue cycles through the spectrum with the brightness of the source.',
	keywords: ['false color', 'false colour', 'thermal', 'heat map', 'colorize', 'rainbow'],
	params: [
		sNum('frequency', 'Frequency', 2, { min: 0, softMax: 10 }),
		sNum('hueShift', 'Hue Shift', 0, { min: -1, max: 1 }),
		sNum('saturation', 'Saturation', 1, { min: -2, max: 8, softMax: 4 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('scaleBySource', 'Scale By Source', 1, { min: 0, max: 1 }),
		sNum('scaleBySrcAmp', 'Scale By Src Amp', 1, { min: 0, softMax: 4 }),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_SSO_COMMON, GLSL_SSO_MASK],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float l = fx_luma(fx_unpremultiply(src).rgb);
  vec3 c = fx_hsv2rgb(vec3(fract(l * u_frequency + u_hueShift), 1.0, 1.0));
  c = fx_saturate(c, u_saturation) * u_brightness * sso_scaleBySource(l, u_scaleBySource, u_scaleBySrcAmp);
  fragColor = sso_finish(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, -1.0);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_PsykoBlobs / S_PsykoStripes

const psykoFinal = (pattern: string) => /* glsl */ `
float sso_pattern() {
${pattern}
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sb = fx_unpremultiply(texture(u_srcBlur, v_uv));
  float l = fx_luma(sb.rgb);
  vec3 c = sso_psykoColor(sso_pattern() + l * u_sourceScale, fx_luma(fx_unpremultiply(src).rgb));
  fragColor = sso_finish(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, -1.0);
}`;

export const S_PSYKO_BLOBS: EffectSpec = defineShaderEffect({
	id: 'jasper.s.psyko-blobs',
	label: 'S_PsykoBlobs',
	category: 'Stylize',
	bin: BIN,
	description:
		'Combines the picture with a field of noise "blobs" and colourises the sum with cycling per-channel palettes; Phase Speed animates the colours (boiling).',
	keywords: ['psychedelic', 'trippy', 'blobs', 'lava lamp', 'colorize', 'noise'],
	params: [
		sNum('noiseFreq', 'Noise Freq', 4, { min: 0.01, softMax: 20 }),
		sNum('noiseFreqRelx', 'Noise Freq Relx', 1, { min: 0.01, softMax: 4 }),
		fxParam.number('noiseOctaves', 'Noise Octaves', 1, { min: 1, max: 10, step: 1 }),
		{ ...seedParam(), label: 'Noise Seed' },
		fxParam.vec2('noiseShift', 'Noise Shift', [0, 0], { softMin: -2, softMax: 2, step: 0.001 }),
		sNum('sourceBlur', 'Source Blur', 0.088, { min: 0, softMax: 1 }),
		sNum('sourceScale', 'Source Scale', 1, { min: 0, softMax: 4 }),
		...psykoColorParams(4),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		passes: (p, ctx) => [
			...blurPasses({ input: 'source', output: 'srcBlur', sigmaX: sapphireBlurPx(p.sourceBlur, ctx) }),
			{
				include: [GLSL_SSO_PSYKO, GLSL_SSO_MASK, GLSL_NOISE],
				frag: psykoFinal(/* glsl */ `
  vec2 q = (sso_boxPx() - u_box.zw * 0.5) / sso_unit();       // Sapphire units, centred
  q = q * u_noiseFreq * vec2(u_noiseFreqRelx, 1.0) * 0.5 + u_noiseShift * u_noiseFreq;
  return fx_noise01(fx_fbm(q, int(clamp(u_noiseOctaves, 1.0, 10.0)), 2.0, 0.5, u_seed));`),
			},
		],
	},
});

export const S_PSYKO_STRIPES: EffectSpec = defineShaderEffect({
	id: 'jasper.s.psyko-stripes',
	label: 'S_PsykoStripes',
	category: 'Stylize',
	bin: BIN,
	description:
		'Combines the picture with a stripe ramp and colourises the sum with cycling per-channel palettes; Phase Speed animates the colours. Stripe Dir is in degrees from vertical.',
	keywords: ['psychedelic', 'trippy', 'stripes', 'colorize', 'rainbow'],
	params: [
		fxParam.angle('stripeDir', 'Stripe Dir', 45),
		sNum('stripeMag', 'Stripe Mag', 0.5, { min: 0, softMax: 4 }),
		sNum('sourceBlur', 'Source Blur', 0.088, { min: 0, softMax: 1 }),
		sNum('sourceScale', 'Source Scale', 1, { min: 0, softMax: 4 }),
		...psykoColorParams(3),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		passes: (p, ctx) => [
			...blurPasses({ input: 'source', output: 'srcBlur', sigmaX: sapphireBlurPx(p.sourceBlur, ctx) }),
			{
				include: [GLSL_SSO_PSYKO, GLSL_SSO_MASK, GLSL_UV],
				frag: psykoFinal(/* glsl */ `
  vec2 q = (sso_boxPx() - u_box.zw * 0.5) / sso_unit();
  // Stripes run at Stripe Dir from vertical; the ramp climbs across them.
  float a = fx_deg(u_stripeDir);
  return dot(q, vec2(cos(a), sin(a))) * u_stripeMag;`),
			},
		],
	},
});

// ---------------------------------------------------------------- S_Solarize

export const S_SOLARIZE: EffectSpec = defineShaderEffect({
	id: 'jasper.s.solarize',
	label: 'S_Solarize',
	category: 'Stylize',
	bin: BIN,
	description:
		'Inverts the colours brighter than the Threshold (a darkroom "solarization"), then rescales them.',
	keywords: ['sabattier', 'invert', 'darkroom', 'posterize', 'psychedelic'],
	params: [
		sNum('threshold', 'Threshold', 0.5, { min: 0, softMax: 1 }),
		sNum('saturation', 'Saturation', 1, { softMin: -2, softMax: 4 }),
		fxParam.toggle('invert', 'Invert', false),
		sNum('brightness', 'Brightness', 2, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1 }),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_SSO_COMMON, GLSL_SSO_MASK],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = fx_unpremultiply(src).rgb;
  c = mix(c, 1.0 - c, step(vec3(u_threshold), c));
  c = fx_saturate(c, u_saturation);
  if (u_invert) c = 1.0 - c;
  c = sso_offsetDarks(c * u_brightness, u_offsetDarks);
  fragColor = sso_finish(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, -1.0);
}`,
			},
		],
	},
});

// ---------------------------------------------------------------- S_Zebrafy / S_ZebrafyColor

const zebraFinal = (body: string) => /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  float l = fx_luma(fx_unpremultiply(texture(u_srcBlur, v_uv)).rgb);
  float ph = u_phaseStart + u_phaseSpeed * u_time;
${body}
  c = max(c * u_brightness * u_color.rgb + u_offset, 0.0) * sso_scaleBySource(fx_luma(fx_unpremultiply(src).rgb), u_scaleBySource, u_scaleBySrcAmp);
  fragColor = sso_finish(vec4(clamp(c, 0.0, 1.0) * src.a, src.a), src, -1.0);
}`;

const zebraTail = () => [
	sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
	fxParam.color('color', 'Color', [1, 1, 1, 1]),
	sNum('offset', 'Offset', 0, { min: -8, max: 2, softMin: -1, softMax: 1 }),
];

export const S_ZEBRAFY: EffectSpec = defineShaderEffect({
	id: 'jasper.s.zebrafy',
	label: 'S_Zebrafy',
	category: 'Stylize',
	bin: BIN,
	description:
		'Modulates the brightness of the picture with a sinusoid: black-and-white contour stripes with a solarized look. Phase Speed animates the stripes.',
	keywords: ['zebra', 'contour', 'stripes', 'solarize', 'isolines', 'psychedelic'],
	params: [
		sNum('sourceBlur', 'Source Blur', 0.088, { min: 0, softMax: 1 }),
		sNum('frequency', 'Frequency', 4, { min: 0.01, softMax: 20 }),
		sNum('phaseStart', 'Phase Start', 0, { softMin: -2, softMax: 2 }),
		sNum('phaseSpeed', 'Phase Speed', 0, { softMin: -4, softMax: 4 }),
		...zebraTail(),
		sNum('scaleBySource', 'Scale By Source', 0, { min: 0, max: 1 }),
		sNum('scaleBySrcAmp', 'Scale By Src Amp', 1, { min: 0, softMax: 4 }),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		passes: (p, ctx) => [
			...blurPasses({ input: 'source', output: 'srcBlur', sigmaX: sapphireBlurPx(p.sourceBlur, ctx) }),
			{
				include: [GLSL_SSO_COMMON, GLSL_SSO_MASK],
				frag: zebraFinal(/* glsl */ `
  vec3 c = vec3(0.5 - 0.5 * cos(6.28318530718 * (l * u_frequency + ph)));`),
			},
		],
	},
});

export const S_ZEBRAFY_COLOR: EffectSpec = defineShaderEffect({
	id: 'jasper.s.zebrafy-color',
	label: 'S_ZebrafyColor',
	category: 'Stylize',
	bin: BIN,
	description:
		'Modulates the brightness of the picture with a sinusoid per colour channel (different frequencies and phases): colour contour stripes.',
	keywords: ['zebra', 'contour', 'stripes', 'rainbow', 'isolines', 'psychedelic'],
	params: [
		sNum('sourceBlur', 'Source Blur', 0.088, { min: 0, softMax: 1 }),
		sNum('frequency', 'Frequency', 3, { min: 0.01, softMax: 20 }),
		sNum('freqRed', 'Freq Red', 1, { min: 0, softMax: 4 }),
		sNum('freqGreen', 'Freq Green', 1.1, { min: 0, softMax: 4 }),
		sNum('freqBlue', 'Freq Blue', 1.2, { min: 0, softMax: 4 }),
		sNum('phaseStart', 'Phase Start', 0, { softMin: -2, softMax: 2 }),
		sNum('phaseRed', 'Phase Red', 0, { softMin: -1, softMax: 1 }),
		sNum('phaseGreen', 'Phase Green', 0, { softMin: -1, softMax: 1 }),
		sNum('phaseBlue', 'Phase Blue', 0, { softMin: -1, softMax: 1 }),
		sNum('phaseSpeed', 'Phase Speed', 0, { softMin: -4, softMax: 4 }),
		...zebraTail(),
		sNum('saturation', 'Saturation', 1, { min: 0, max: 10, softMax: 4 }),
		sNum('scaleBySource', 'Scale By Source', 0, { min: 0, max: 1 }),
		sNum('scaleBySrcAmp', 'Scale By Src Amp', 1, { min: 0, softMax: 4 }),
		...sapphireCommonParams(),
		...maskParams(),
	],
	gpu: {
		passes: (p, ctx) => [
			...blurPasses({ input: 'source', output: 'srcBlur', sigmaX: sapphireBlurPx(p.sourceBlur, ctx) }),
			{
				include: [GLSL_SSO_COMMON, GLSL_SSO_MASK, GLSL_COLOR],
				frag: zebraFinal(/* glsl */ `
  vec3 f = vec3(u_freqRed, u_freqGreen, u_freqBlue) * u_frequency;
  vec3 c = 0.5 - 0.5 * cos(6.28318530718 * (l * f + ph + vec3(u_phaseRed, u_phaseGreen, u_phaseBlue)));
  c = fx_saturate(c, u_saturation);`),
			},
		],
	},
});
