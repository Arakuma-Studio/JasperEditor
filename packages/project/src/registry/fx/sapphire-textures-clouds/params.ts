// Family-private param builders of `sapphire-textures-clouds` (Sapphire Render ▸ procedural textures and fractal
// clouds). Sapphire's texture generators share one vocabulary — Frequency / Frequency Rel X / Octaves / Seed, Shift
// (Start/Speed), the Color0→Color1 ramp (Brightness1, Color1, Color0, Offset0) and the tail Bg Brightness,
// Combine, Output Opacity — so the entries build their params from these helpers to keep names, ranges and
// defaults identical across the family. Uniforms follow the framework rule `u_<name>`.
import type { RGBA } from '../../../schema/common.ts';
import type { ParamSpec } from '../../effects.ts';
import { fxParam, sapphireCommonParams, seedParam } from '../params.ts';

/** A spatial frequency (≥ 0.01, keyframable). */
export const sFreq = (name: string, label: string, def: number, softMax = 40, min = 0.01): ParamSpec =>
	fxParam.number(name, label, def, { min, max: 10000, softMax, step: 0.01 });

/** A non-negative amount (brightness, widths…). */
export const sPos = (name: string, label: string, def: number, softMax = 4, max?: number): ParamSpec =>
	fxParam.number(name, label, def, { min: 0, ...(max !== undefined ? { max } : {}), softMax, step: 0.01 });

/** An unbounded value (speeds, phases, offsets). */
export const sAny = (name: string, label: string, def: number, soft = 4): ParamSpec =>
	fxParam.number(name, label, def, { softMin: -soft, softMax: soft, step: 0.01 });

/** A bounded value. */
export const sRange = (name: string, label: string, def: number, min: number, max: number): ParamSpec =>
	fxParam.number(name, label, def, { min, max, step: 0.01 });

/**
 * An integer count (Octaves, Steps, Arms). Keyframable like in Sapphire; the shaders treat fractional values
 * continuously (the last octave fades in), so animated counts never pop.
 */
export const sInt = (name: string, label: string, def: number, min: number, max: number): ParamSpec =>
	fxParam.number(name, label, def, { min, max, step: 1 });

/** An X & Y pair that is not a position (Shift, Shift Speed, Morph, Light Dir…). */
export const sVec = (name: string, label: string, def: [number, number]): ParamSpec =>
	fxParam.vec2(name, label, def, { step: 0.01 });

/** An RGB colour (alpha unused). */
export const sColor = (name: string, label: string, rgb: [number, number, number]): ParamSpec =>
	fxParam.color(name, label, [rgb[0], rgb[1], rgb[2], 1] as RGBA);

/** Sapphire "Seed": a float, mixed into `u_seed` by the framework (any change gives a new pattern). */
export const sSeed = (def: number, name = 'seed', label = 'Seed'): ParamSpec => ({
	...seedParam(def),
	name,
	label,
	range: { min: 0, max: 100000, softMax: 10, step: 0.001 },
});

/** The Color0 → Color1 ramp most textures end with: Brightness1, Color1, Color0, Offset0 (`stc_ramp`). */
export function rampParams(
	color0: [number, number, number] = [0, 0, 0],
	color1: [number, number, number] = [1, 1, 1],
): ParamSpec[] {
	return [
		sPos('brightness1', 'Brightness1', 1),
		sColor('color1', 'Color1', color1),
		sColor('color0', 'Color0', color0),
		sAny('offset0', 'Offset0', 0, 1),
	];
}

/** Combine option values, in GLSL index order (`u_combine`, see `stc_combine`). */
export const STC_COMBINE = ['textureOnly', 'mult', 'add', 'screen', 'difference', 'overlay'] as const;
const COMBINE_LABELS = ['Texture Only', 'Mult', 'Add', 'Screen', 'Difference', 'Overlay'] as const;

/** Output Opacity option values, in GLSL index order (`u_outputOpacity`). */
export const STC_OUTPUT_OPACITY = ['allOpaque', 'copyFromInput'] as const;

/**
 * The tail every entry shares: Bg Brightness, Combine (first option "Texture Only", "Clouds Only" or "Noise Only";
 * `modes` limits the list, S_TextureRidges offers four), Output Opacity, then Show and Mix with Orig.
 */
export function finishParams(
	opts: { only?: 'Texture' | 'Clouds' | 'Noise'; modes?: number } = {},
): ParamSpec[] {
	const only = opts.only ?? 'Texture';
	const n = Math.max(2, Math.min(STC_COMBINE.length, opts.modes ?? STC_COMBINE.length));
	const values = STC_COMBINE.slice(0, n).map((v, i) => (i === 0 ? `${only.toLowerCase()}Only` : v));
	const labels = COMBINE_LABELS.slice(0, n).map((l, i) => (i === 0 ? `${only} Only` : l));
	return [
		sPos('bgBrightness', 'Bg Brightness', 1),
		fxParam.choice('combine', 'Combine', values, labels, values[0]!),
		fxParam.choice(
			'outputOpacity',
			'Output Opacity',
			STC_OUTPUT_OPACITY,
			['All Opaque', 'Copy From Input'],
			'copyFromInput',
		),
		...sapphireCommonParams(),
	];
}
