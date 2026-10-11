// Family-private TypeScript helpers of the Sapphire film / grain / damage family: param readers, Sapphire-style
// param builders (seeds with Sapphire's 0.123 default, grain and vignette groups shared by several effects), the
// grain-hold cadence, and smooth deterministic random signals (flicker, shake, blink) evaluated per frame in
// `gpu.uniforms` hooks — pure functions of (params, frame, seed), never Math.random.
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { booleanParam as bool, clamp, numberParam as num } from '../../param-values.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { fxParam, mixWithOriginalParam, seedParam } from '../params.ts';
import { type FxUniformValue, fxRandom, type ShaderPass } from '../shader.ts';

export const rgb = (v: ParamValue | undefined, d: [number, number, number]): [number, number, number] =>
	Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x))
		? [v[0] as number, v[1] as number, v[2] as number]
		: d;

/** Puts every param of a list into an Effect Controls section (metadata for panels and the agent catalogue). */
export function grp(group: string, params: ParamSpec[]): ParamSpec[] {
	return params.map((p) => ({ ...p, group }));
}

/** A plain Sapphire slider (`number`, keyframable). */
export function slider(
	name: string,
	label: string,
	def: number,
	min?: number,
	max?: number,
	soft?: { softMin?: number; softMax?: number; step?: number },
): ParamSpec {
	return fxParam.number(name, label, def, {
		...(min !== undefined ? { min } : {}),
		...(max !== undefined ? { max } : {}),
		step: soft?.step ?? 0.01,
		...(soft?.softMin !== undefined ? { softMin: soft.softMin } : {}),
		...(soft?.softMax !== undefined ? { softMax: soft.softMax } : {}),
	});
}

export function intSlider(
	name: string,
	label: string,
	def: number,
	min: number,
	max?: number,
	softMax?: number,
) {
	return fxParam.number(name, label, def, {
		min,
		...(max !== undefined ? { max } : {}),
		...(softMax !== undefined ? { softMax } : {}),
		step: 1,
	});
}

/** A colour param (straight RGB(A) 0..1). */
export const color = (name: string, label: string, c: [number, number, number]) =>
	fxParam.color(name, label, [c[0], c[1], c[2], 1]);

export const check = (name: string, label: string, def: boolean) => fxParam.toggle(name, label, def);

/**
 * The Sapphire "Seed" (the framework's `seedParam`, mixed into `u_seed`); `label` follows the effect ("Grain Seed",
 * "Rand Seed", "Random Seed"…).
 */
export function sapphireSeed(label = 'Seed'): ParamSpec {
	return { ...seedParam(), label };
}

/**
 * Sapphire centred coordinates → the framework's layer-normalised point: x −1..1 spans the frame width (centre 0),
 * y is up in the same units (half widths). The default conversion assumes a 16:9 frame.
 */
export function sapphirePoint(x: number, y: number): [number, number] {
	const r = (v: number) => Math.round(v * 10000) / 10000;
	return [r(0.5 + x / 2), r(0.5 - (y * (16 / 9)) / 2)];
}

/** The usual tail: "Mix with Orig" (the framework's substitute for Sapphire's Mask input blending). */
export const mixParam = (label = 'Mix with Orig') => ({ ...mixWithOriginalParam(), label });

export const GRAIN_HOLD = [
	'field',
	'frame',
	'pulldown0',
	'pulldown1',
	'pulldown2',
	'pulldown3',
	'pulldown4',
] as const;

/**
 * The frame index whose grain pattern is shown at `frame`: Field/Frame → a new pattern every frame; "3:2 at k" →
 * 4 film frames over 5 video frames (one pattern held over 3 then 2 fields), phase k.
 */
export function grainFrame(hold: ParamValue | undefined, frame: number): number {
	const i = typeof hold === 'string' ? GRAIN_HOLD.indexOf(hold as (typeof GRAIN_HOLD)[number]) : 1;
	if (i < 2) return Math.floor(frame);
	const k = i - 2;
	return Math.floor(((Math.floor(frame) + k) * 4) / 5);
}

/** Smooth value noise of time t (in "cycles"): −1..1, C1-continuous, deterministic in (seed, channel). */
export function smoothNoise1(seed: number, channel: number, t: number): number {
	const i = Math.floor(t);
	const f = t - i;
	const u = f * f * (3 - 2 * f);
	const a = fxRandom(seed, i * 977 + channel * 7919) * 2 - 1;
	const b = fxRandom(seed, (i + 1) * 977 + channel * 7919) * 2 - 1;
	return a + (b - a) * u;
}

/** Hard per-period random value (0..1) of time t (cycles), e.g. blink on/off states. */
export function stepNoise1(seed: number, channel: number, t: number): number {
	return fxRandom(seed, Math.floor(t) * 1013 + channel * 104729);
}

/** Size of the Sapphire frame unit in layer px: 1.0 = the frame width. */
export const frameWidth = (ctx: { width: number }) => Math.max(1, ctx.width);
/** Layer px per "HD pixel" (1920-wide reference): resolution-independent pixel sizes. */
export const hdPx = (ctx: { width: number }) => Math.max(1, ctx.width) / 1920;

/**
 * Sapphire film-grain group (S_FilmEffect, S_FilmDamage, S_BleachBypass): Grain Amp (+ per channel), Darks/Brights
 * amplitude, optional midtone positions, Grain Blur (+ per channel), Grain Mono. Uniform names `u_grain*`.
 */
export function filmGrainParams(opts: { amp: number; midtones?: boolean; hold?: boolean; group?: string }) {
	const ps: ParamSpec[] = [
		slider('grainAmp', 'Grain Amp', opts.amp, 0, 4, { softMax: 2 }),
		slider('grainAmpRed', 'Grain Amp Red', 0.9, 0, 10, { softMax: 3 }),
		slider('grainAmpGreen', 'Grain Amp Green', 1, 0, 10, { softMax: 3 }),
		slider('grainAmpBlue', 'Grain Amp Blue', 1.6, 0, 10, { softMax: 3 }),
		slider('grainAmpDarks', 'Grain Amp Darks', 0.2, 0, 2),
		slider('grainAmpBrights', 'Grain Amp Brights', 0, 0, 2),
		...(opts.midtones
			? [
					slider('midtonePosRed', 'Midtone Pos Red', 0.5, 0, 1),
					slider('midtonePosGreen', 'Midtone Pos Green', 0.5, 0, 1),
					slider('midtonePosBlue', 'Midtone Pos Blue', 0.5, 0, 1),
				]
			: []),
		slider('grainBlur', 'Grain Blur', 0, 0, 20, { softMax: 4 }),
		slider('grainBlurRed', 'Grain Blur Red', 1, 0, 10, { softMax: 3 }),
		slider('grainBlurGreen', 'Grain Blur Green', 0.9, 0, 10, { softMax: 3 }),
		slider('grainBlurBlue', 'Grain Blur Blue', 1.2, 0, 10, { softMax: 3 }),
		check('grainMono', 'Grain Mono', false),
		...(opts.hold
			? [
					fxParam.choice(
						'grainHold',
						'Grain Hold',
						GRAIN_HOLD,
						[
							'Field',
							'Frame',
							'3:2 Stutter at 0',
							'3:2 Stutter at 1',
							'3:2 Stutter at 2',
							'3:2 Stutter at 3',
							'3:2 Stutter at 4',
						],
						'frame',
					),
				]
			: []),
	];
	return opts.group ? grp(opts.group, ps) : ps;
}

/** Derived uniforms of `filmGrainParams`: grain feature sizes per channel (layer px) and the grain frame. */
export function filmGrainUniforms(
	p: EffectParams,
	ctx: { width: number; frame: number },
): Record<string, FxUniformValue> {
	const blur = Math.max(0, num(p.grainBlur));
	const hd = hdPx(ctx);
	const size = (c: number) => Math.max(0.6, (1 + 2 * blur * Math.max(0, c)) * hd);
	return {
		u_grainSizePx: [
			size(num(p.grainBlurRed, 1)),
			size(num(p.grainBlurGreen, 0.9)),
			size(num(p.grainBlurBlue, 1.2)),
		],
		u_grainFrame: grainFrame(p.grainHold, ctx.frame),
	};
}

/** Sapphire vignette group (Darkness, Radius, Edge Softness, Rel Height). Uniforms `u_vignette*`. */
export function vignetteParams(darkness: number, group?: string) {
	const ps = [
		slider('vignetteDarkness', 'Vignette Darkness', darkness, 0, 1),
		slider('vignetteRadius', 'Vignette Radius', 1, 0, 10, { softMax: 3 }),
		slider('vignetteEdgeSoftness', 'Vignette Edge Softness', 0.5, 0, 10, { softMax: 3 }),
		slider('vignetteRelHeight', 'Vignette Rel Height', 0.75, 0.1, 10, { softMax: 3 }),
	];
	return group ? grp(group, ps) : ps;
}

/** Two passes (H, V) blurring `input` by a per-frame sigma uniform (canvas px), output `output`. */
export function uniformBlurPasses(opts: {
	input: string;
	output: string;
	sigmaUniform: string;
	scale?: number;
}): ShaderPass[] {
	const scale = opts.scale ?? 1;
	const frag = (tex: string, dir: string) => /* glsl */ `
void main() {
  vec2 texel = 1.0 / vec2(textureSize(${tex}, 0));
  fragColor = fx_gaussian1d(${tex}, v_uv, ${dir}, texel, ${opts.sigmaUniform} * ${scale.toFixed(4)});
}`;
	return [
		{
			output: `${opts.output}H`,
			frag: frag(`u_${opts.input}`, 'vec2(1.0, 0.0)'),
			include: [GLSL_BLUR],
			scale,
		},
		{ output: opts.output, frag: frag(`u_${opts.output}H`, 'vec2(0.0, 1.0)'), include: [GLSL_BLUR], scale },
	];
}

export { bool, clamp, num };
