// Sapphire halftones (Stylize): S_HalfTone, S_HalfToneColor, S_HalfToneRings. A rotated screen (frequency = dots
// across the layer width) whose spot function is compared with the (optionally smoothed) source per pixel, so dots
// follow the picture's detail; Smooth Source makes them rounder, Sharpness sets the edge softness (antialiased).
import type { EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import type { GlslChunk } from '../shader.ts';
import { fxParam, mixWithOriginalParam } from '../params.ts';
import { blurPasses, PKE_COMMON, rgbParam, sNum, sUnitsPx, xyParam } from './common.ts';

const bin = SAPPHIRE_BINS.stylize;

/** Screen coordinates and spot functions shared by the three halftones. */
const PKE_SCREEN: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/screen',
	deps: [PKE_COMMON],
	source: /* glsl */ `
// Screen coordinates (cells) of this pixel: frequency cells across the layer width, rotated by angle (degrees,
// clockwise), x divided by relWidth, shifted by shift (layer widths, y up).
vec2 ht_cells(float frequency, float angle, float relWidth, vec2 shift) {
  vec2 c = pke_boxPx() - 0.5 * u_box.zw - vec2(shift.x, -shift.y) * u_box.z;
  float cell = u_box.z / max(frequency, 0.01);
  vec2 q = pke_rot(-angle) * c / cell;
  q.x /= max(relWidth, 0.01);
  return q;
}
// Round-dot spot function: 1 at the dot centres, 0 at the cell corners.
float ht_spot(vec2 q) { return 0.5 + 0.25 * (cos(6.28318530718 * q.x) + cos(6.28318530718 * q.y)); }
// Edge half-width in spot units for a Sapphire Sharpness, never sharper than a pixel.
float ht_width(float sharpness, float spot) {
  return max(0.25 / max(sharpness + 1.0, 0.01), 0.75 * fwidth(spot));
}
// 1 where the level (luma + lighten) is above the spot value, soft over ±width.
float ht_cover(float level, float spot, float w) { return clamp(0.5 + (level - spot) / (2.0 * w), 0.0, 1.0); }
`,
};

const commonDotParams = (prefix: 'Dots' | 'Rings', freq: number, sharpness: number, sharpMin: number) => {
	const p = prefix.toLowerCase();
	return [
		sNum(`${p}Frequency`, `${prefix} Frequency`, freq, { min: 0, softMax: 200, step: 0.1 }),
		fxParam.angle(`${p}Angle`, `${prefix} Angle`, 30),
		sNum(`${p}RelWidth`, `${prefix} Rel Width`, 1, { min: 0.01, softMax: 4, step: 0.01 }),
		sNum(`${p}Sharpness`, `${prefix} Sharpness`, sharpness, { min: sharpMin, softMax: 20, step: 0.01 }),
		sNum(`${p}Lighten`, `${prefix} Lighten`, 0, { softMin: -1, softMax: 1, step: 0.001 }),
	] as ParamSpec[];
};
const smoothSourceParam = () => sNum('smoothSource', 'Smooth Source', 0, { min: 0, softMax: 2 });

export const S_HALF_TONE = defineShaderEffect({
	id: 'jasper.s.half-tone',
	label: 'S_HalfTone',
	category: 'Stylize',
	bin,
	description:
		'A halftone of the clip: a rotated screen of dark dots on a bright background (or bright on dark). Smooth Source makes the dots rounder.',
	keywords: ['halftone', 'dots', 'print', 'newspaper', 'comic', 'sapphire'],
	params: [
		fxParam.choice('dots', 'Dots', ['black', 'white'], ['Black', 'White'], 'black'),
		...commonDotParams('Dots', 50, 4, 0),
		smoothSourceParam(),
		rgbParam('color1', 'Color1', [1, 1, 1]),
		rgbParam('color0', 'Color0', [0, 0, 0]),
		xyParam('dotsShift', 'Dots Shift', [0, 0]),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', sUnitsPx(p.smoothSource, ctx)),
			{
				include: [PKE_SCREEN, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sm = fx_unpremultiply(texture(u_smooth, v_uv));
  float s = ht_spot(ht_cells(u_dotsFrequency, u_dotsAngle, u_dotsRelWidth, u_dotsShift));
  float l = fx_luma(sm.rgb) + u_dotsLighten;
  float w = ht_width(u_dotsSharpness, s);
  // Black: dark dots grow where the picture is dark. White: bright dots grow where it is bright.
  float bright = u_dots == 0 ? ht_cover(l, s, w) : 1.0 - ht_cover(1.0 - l, s, w);
  vec3 c = mix(u_color0.rgb, u_color1.rgb, bright);
  fragColor = fx_mixOriginal(vec4(c * src.a, src.a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_HALF_TONE_COLOR = defineShaderEffect({
	id: 'jasper.s.half-tone-color',
	label: 'S_HalfToneColor',
	category: 'Stylize',
	bin,
	description:
		'A colour halftone: cyan, magenta and yellow dots on white (CMY) or red, green and blue dots on black (RGB), with per-channel screen shifts.',
	keywords: ['halftone', 'cmyk', 'cmy', 'dots', 'print', 'comic', 'pop art', 'sapphire'],
	params: [
		fxParam.choice('dotsColor', 'Dots Color', ['cmy', 'rgb'], ['CMY', 'RGB'], 'cmy'),
		...commonDotParams('Dots', 50, 4, 0),
		smoothSourceParam(),
		sNum('saturation', 'Saturation', 1, { min: -2, max: 10, step: 0.01 }),
		xyParam('dotsShift', 'Dots Shift', [0, 0]),
		xyParam('shiftRed', 'Shift Red', [0, 0.5]),
		xyParam('shiftGreen', 'Shift Green', [0, 0]),
		xyParam('shiftBlue', 'Shift Blue', [0, -0.5]),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', sUnitsPx(p.smoothSource, ctx)),
			{
				include: [PKE_SCREEN, GLSL_COMPOSITE],
				frag: /* glsl */ `
float channel(vec2 q, vec2 shift, float level) {
  // Channel shifts are in dot cells (y up).
  float s = ht_spot(q + vec2(shift.x, -shift.y));
  float w = ht_width(u_dotsSharpness, s);
  return u_dotsColor == 0 ? ht_cover(level, s, w) : 1.0 - ht_cover(1.0 - level, s, w);
}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sm = fx_unpremultiply(texture(u_smooth, v_uv));
  vec3 c = clamp(fx_saturate(sm.rgb, u_saturation), 0.0, 1.0) + u_dotsLighten;
  vec2 q = ht_cells(u_dotsFrequency, u_dotsAngle, u_dotsRelWidth, u_dotsShift);
  vec3 r = vec3(channel(q, u_shiftRed, c.r), channel(q, u_shiftGreen, c.g), channel(q, u_shiftBlue, c.b));
  fragColor = fx_mixOriginal(vec4(r * src.a, src.a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const S_HALF_TONE_RINGS = defineShaderEffect({
	id: 'jasper.s.half-tone-rings',
	label: 'S_HalfToneRings',
	category: 'Stylize',
	bin,
	description:
		'A duotone of the clip drawn with a repeating pattern of concentric rings whose thickness follows the brightness.',
	keywords: ['halftone', 'rings', 'circles', 'duotone', 'op art', 'sapphire'],
	params: [
		fxParam.choice('center', 'Center', ['black', 'white'], ['Black', 'White'], 'black'),
		...commonDotParams('Rings', 20, 2, -1),
		sNum('ringNumber', 'Ring Number', 2, { min: 1, softMax: 10, step: 0.01 }),
		sNum('ringPhase', 'Ring Phase', 0, { softMin: -1, softMax: 1, step: 0.001 }),
		smoothSourceParam(),
		rgbParam('color1', 'Color1', [1, 1, 1]),
		rgbParam('color0', 'Color0', [0, 0, 0]),
		xyParam('ringsShift', 'Rings Shift', [0, 0]),
		mixWithOriginalParam(),
	],
	gpu: {
		timeInvariant: true,
		passes: (p, ctx) => [
			...blurPasses('source', 'smooth', sUnitsPx(p.smoothSource, ctx)),
			{
				include: [PKE_SCREEN, GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 sm = fx_unpremultiply(texture(u_smooth, v_uv));
  vec2 q = ht_cells(u_ringsFrequency, u_ringsAngle, u_ringsRelWidth, u_ringsShift);
  float r = length(fract(q) - 0.5) * 2.0;
  float s = 0.5 + 0.5 * cos(6.28318530718 * (r * u_ringNumber - u_ringPhase));
  float l = fx_luma(sm.rgb) + u_ringsLighten;
  float w = ht_width(u_ringsSharpness, s);
  float bright = u_center == 0 ? ht_cover(l, s, w) : 1.0 - ht_cover(1.0 - l, s, w);
  vec3 c = mix(u_color0.rgb, u_color1.rgb, bright);
  fragColor = fx_mixOriginal(vec4(c * src.a, src.a), src, u_mixWithOriginal);
}`,
			},
		],
	},
});

export const HALFTONE_EFFECTS: readonly EffectSpec[] = [S_HALF_TONE, S_HALF_TONE_COLOR, S_HALF_TONE_RINGS];
