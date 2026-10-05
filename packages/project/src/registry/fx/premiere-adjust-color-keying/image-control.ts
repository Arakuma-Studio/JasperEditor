// Premiere Pro "Image Control" video effects (fx family premiere-adjust-color-keying): Color Balance (RGB), Color
// Pass, Color Replace, Gamma Correction. (Black & White already exists as jasper.black-white.)
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import { GLSL_PACG, slider } from './common.ts';
import { GLSL_PACG_MATCH } from './color-correction.ts';

export const COLOR_BALANCE_RGB = defineShaderEffect({
	id: 'jasper.color-balance-rgb',
	label: 'Color Balance (RGB)',
	category: 'Image Control',
	description: 'Scales the red, green and blue channels (100 = unchanged).',
	keywords: ['rgb', 'gain', 'white balance', 'color cast'],
	params: [
		slider('red', 'Red', 100, 0, 200, { step: 1 }),
		slider('green', 'Green', 100, 0, 200, { step: 1 }),
		slider('blue', 'Blue', 100, 0, 200, { step: 1 }),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src) * vec3(u_red, u_green, u_blue) / 100.0;
  fragColor = fx_premultiply(vec4(clamp(c, 0.0, 1.0), src.a));
}`,
			},
		],
	},
});

export const COLOR_PASS = defineShaderEffect({
	id: 'jasper.color-pass',
	label: 'Color Pass',
	category: 'Image Control',
	description: 'Keeps one colour and turns everything else grey (or, reversed, greys out only that colour).',
	keywords: ['leave color', 'selective color', 'isolate color', 'desaturate'],
	params: [
		slider('similarity', 'Similarity', 10, 0, 100, { step: 0.1 }),
		fxParam.toggle('reverse', 'Reverse', false),
		fxParam.color('color', 'Color', [0.85, 0.15, 0.15, 1]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG_MATCH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float s = u_similarity / 100.0;
  float keep = pacg_matchMask(pacg_colorDistance(c, u_color.rgb, 0), s * 0.6, s * 0.4 + 0.01);
  if (u_reverse) keep = 1.0 - keep;
  fragColor = fx_premultiply(vec4(mix(vec3(fx_luma(c)), c, keep), src.a));
}`,
			},
		],
	},
});

export const COLOR_REPLACE = defineShaderEffect({
	id: 'jasper.color-replace',
	label: 'Color Replace',
	category: 'Image Control',
	description:
		'Replaces the colours similar to Target Color with Replace Color (keeping their shading, or as a solid colour).',
	keywords: ['recolor', 'swap color', 'change color'],
	params: [
		slider('similarity', 'Similarity', 10, 0, 100, { step: 0.1 }),
		fxParam.toggle('solidColors', 'Solid Colors', false),
		fxParam.color('targetColor', 'Target Color', [0.85, 0.15, 0.15, 1]),
		fxParam.color('replaceColor', 'Replace Color', [0.15, 0.35, 0.9, 1]),
	],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG_MATCH],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pacg_straight(src);
  float s = u_similarity / 100.0;
  float m = pacg_matchMask(pacg_colorDistance(c, u_targetColor.rgb, 0), s * 0.6, s * 0.4 + 0.01);
  vec3 rep;
  if (u_solidColors) rep = u_replaceColor.rgb;
  else {
    // Keep the pixel's lightness relative to the target: hue and saturation of the replacement.
    vec3 hp = fx_rgb2hsl(c), ht = fx_rgb2hsl(u_targetColor.rgb), hr = fx_rgb2hsl(u_replaceColor.rgb);
    rep = fx_hsl2rgb(vec3(hr.x, clamp(hr.y + hp.y - ht.y, 0.0, 1.0), clamp(hr.z + hp.z - ht.z, 0.0, 1.0)));
  }
  fragColor = fx_premultiply(vec4(mix(c, rep, m), src.a));
}`,
			},
		],
	},
});

export const GAMMA_CORRECTION = defineShaderEffect({
	id: 'jasper.gamma-correction',
	label: 'Gamma Correction',
	category: 'Image Control',
	description: 'Lightens or darkens the midtones without changing black and white (gamma = value / 10; 10 = unchanged).',
	keywords: ['gamma', 'midtones', 'brightness'],
	params: [slider('gamma', 'Gamma', 10, 1, 28, { step: 0.1 })],
	gpu: {
		timeInvariant: true,
		passes: [
			{
				include: [GLSL_PACG],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = pow(pacg_straight(src), vec3(max(u_gamma, 0.1) / 10.0));
  fragColor = fx_premultiply(vec4(c, src.a));
}`,
			},
		],
	},
});

export const IMAGE_CONTROL_EFFECTS: readonly EffectSpec[] = [
	COLOR_BALANCE_RGB,
	COLOR_PASS,
	COLOR_REPLACE,
	GAMMA_CORRECTION,
];
