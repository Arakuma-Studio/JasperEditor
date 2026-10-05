// Matte shaping of S_MatteOps / S_MatteOpsComp / S_EdgeFlash (fx family sapphire-adjust-composite): Shrink-/Grow+,
// Edge Softness, Filter (Box / Triangle / Gauss), edge noise (Noise Amplitude, Noise Width, Frequency, Octaves, Seed,
// Noise Shift, Jitter Frames) and Post Blur.
// Method (for the anti-aliased hard-edged mattes Sapphire assumes): the matte is blurred with the chosen filter of
// reach R; at a straight edge the blurred level L is the filter's survival function of the signed distance d to the
// edge, so inverting it recovers d (|d| < R) per pixel. The new matte is a ramp of `softness` px around the moved edge:
// m = clamp((grow + noise − d) / softness + ½, 0, 1). R covers |grow| + noise + softness, so pixels further away are
// fully in or out. With Shrink/Grow 0 and no noise the matte is passed through untouched (identity at defaults).
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_NOISE } from '../glsl/noise.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';
import { num, relSigma, str } from './common.ts';

export const MATTE_FILTERS = ['box', 'triangle', 'gauss'] as const;
export type MatteFilter = (typeof MATTE_FILTERS)[number];

/** Shrink-/Grow+ and Edge Softness (pixels). */
export function shrinkGrowParams(): ParamSpec[] {
	return [
		fxParam.number('shrinkGrow', 'Shrink- Grow+', 0, {
			min: -500,
			max: 500,
			softMin: -50,
			softMax: 50,
			step: 0.1,
		}),
		fxParam.number('edgeSoftness', 'Edge Softness', 1, { min: 0.01, max: 500, softMax: 50, step: 0.01 }),
	];
}

export function postBlurParam(): ParamSpec {
	return fxParam.number('postBlur', 'Post Blur', 0, { min: 0, max: 500, softMax: 50, step: 0.1 });
}

export function filterParam(): ParamSpec {
	return fxParam.choice('filter', 'Filter', MATTE_FILTERS, ['Box', 'Triangle', 'Gauss'], 'triangle');
}

/** The edge-noise block. `relX` adds Frequency Rel X, `jitter` adds Jitter Frames (S_MatteOps family). */
export function noiseParams(opts: { relX: boolean; jitter: boolean }): ParamSpec[] {
	return [
		fxParam.number('noiseAmplitude', 'Noise Amplitude', 0, { min: 0, max: 10, softMax: 2, step: 0.01 }),
		fxParam.number('noiseWidth', 'Noise Width', 0.0224, { min: 0, max: 1, softMax: 0.2, step: 0.0001 }),
		fxParam.number('frequency', 'Frequency', 100, { min: 0.1, max: 1000, softMax: 300, step: 0.1 }),
		...(opts.relX
			? [
					fxParam.number('frequencyRelX', 'Frequency Rel X', 1, {
						min: 0.01,
						max: 100,
						softMax: 4,
						step: 0.01,
					}),
				]
			: []),
		fxParam.number('octaves', 'Octaves', 1, { min: 1, max: 10, step: 1 }, { animatable: false }),
		fxParam.number(
			'seed',
			'Seed',
			0.23,
			{ min: 0, max: 1000, softMax: 1, step: 0.01 },
			{ animatable: false },
		),
		fxParam.vec2('noiseShift', 'Noise Shift', [0, 0], { softMin: -1, softMax: 1, step: 0.001 }),
		...(opts.jitter
			? [
					fxParam.number(
						'jitterFrames',
						'Jitter Frames',
						1,
						{ min: 0, max: 1000, step: 1 },
						{ animatable: false },
					),
				]
			: []),
	];
}

/** Edge-noise displacement amplitude in canvas px (Noise Amplitude × Noise Width, relative to the layer height). */
export function noiseReachPx(p: EffectParams, ctx: Pick<FxPlanContext, 'height' | 'pxScale'>): number {
	return (
		Math.max(0, num(p, 'noiseAmplitude')) *
		Math.max(0, num(p, 'noiseWidth', 0.0224)) *
		ctx.height *
		ctx.pxScale
	);
}

/** True when the matte must be re-shaped (else it passes through; Post Blur still applies). */
export function matteShaped(p: EffectParams, ctx: Pick<FxPlanContext, 'height' | 'pxScale'>): boolean {
	return num(p, 'shrinkGrow') !== 0 || noiseReachPx(p, ctx) > 0;
}

/** Reach R (canvas px) of the shaping filter. */
export function matteReachPx(p: EffectParams, ctx: Pick<FxPlanContext, 'height' | 'pxScale'>): number {
	const soft = Math.max(0.01, num(p, 'edgeSoftness', 1));
	return (Math.abs(num(p, 'shrinkGrow')) + soft) * ctx.pxScale + noiseReachPx(p, ctx) + 2;
}

/** TS reference of the GLSL inverse survival functions: blurred level L (0..1) → signed distance (outside > 0). */
export function matteDistance(filter: MatteFilter, level: number, reach: number): number {
	const L = Math.min(1, Math.max(0, level));
	if (filter === 'box') return reach * (1 - 2 * L);
	if (filter === 'triangle')
		return L <= 0.5 ? reach * (1 - Math.sqrt(2 * L)) : -reach * (1 - Math.sqrt(2 * (1 - L)));
	// Gauss: σ = R / 2.5, d = σ·√2·erfc⁻¹(2L) = −σ·√2·erf⁻¹(2L − 1)
	const sigma = reach / 2.5;
	return -sigma * Math.SQRT2 * erfinv(Math.min(0.9999, Math.max(-0.9999, 2 * L - 1)));
}

/** Giles' single-precision erf⁻¹ approximation (also in the GLSL). */
export function erfinv(x: number): number {
	let w = -Math.log((1 - x) * (1 + x));
	if (w < 5) {
		w -= 2.5;
		let p = 2.81022636e-8;
		p = 3.43273939e-7 + p * w;
		p = -3.5233877e-6 + p * w;
		p = -4.39150654e-6 + p * w;
		p = 0.00021858087 + p * w;
		p = -0.00125372503 + p * w;
		p = -0.00417768164 + p * w;
		p = 0.246640727 + p * w;
		p = 1.50140941 + p * w;
		return p * x;
	}
	w = Math.sqrt(w) - 3;
	let p = -0.000200214257;
	p = 0.000100950558 + p * w;
	p = 0.00134934322 + p * w;
	p = -0.00367342844 + p * w;
	p = 0.00573950773 + p * w;
	p = -0.0076224613 + p * w;
	p = 0.00943887047 + p * w;
	p = 1.00167406 + p * w;
	p = 2.83297682 + p * w;
	return p * x;
}

export const GLSL_SAC_MATTE: GlslChunk = {
	name: 'sapphire-adjust-composite/matte',
	deps: [GLSL_NOISE],
	source: /* glsl */ `
float sac_erfinv(float x) {
  float w = -log((1.0 - x) * (1.0 + x));
  float p;
  if (w < 5.0) {
    w -= 2.5;
    p = 2.81022636e-8;
    p = 3.43273939e-7 + p * w; p = -3.5233877e-6 + p * w; p = -4.39150654e-6 + p * w;
    p = 0.00021858087 + p * w; p = -0.00125372503 + p * w; p = -0.00417768164 + p * w;
    p = 0.246640727 + p * w; p = 1.50140941 + p * w;
  } else {
    w = sqrt(w) - 3.0;
    p = -0.000200214257;
    p = 0.000100950558 + p * w; p = 0.00134934322 + p * w; p = -0.00367342844 + p * w;
    p = 0.00573950773 + p * w; p = -0.0076224613 + p * w; p = 0.00943887047 + p * w;
    p = 1.00167406 + p * w; p = 2.83297682 + p * w;
  }
  return p * x;
}
// Blurred level → signed distance to the edge (outside > 0), filter 0 box, 1 triangle, 2 gauss, reach R px.
float sac_matteDistance(int kind, float level, float reach) {
  float L = clamp(level, 0.0, 1.0);
  if (kind == 0) return reach * (1.0 - 2.0 * L);
  if (kind == 1) return L <= 0.5 ? reach * (1.0 - sqrt(2.0 * L)) : -reach * (1.0 - sqrt(2.0 * (1.0 - L)));
  return -(reach / 2.5) * 1.41421356 * sac_erfinv(clamp(2.0 * L - 1.0, -0.9999, 0.9999));
}
// The re-shaped matte: grow (px, + = bigger) + noise displacement, a ramp of softness px.
float sac_matteShape(int kind, float level, float reach, float grow, float softness) {
  float d = sac_matteDistance(kind, level, reach);
  return clamp((grow - d) / max(softness, 0.01) + 0.5, 0.0, 1.0);
}
// Edge noise in −1..1 at layer px p: frequency cycles per layer height, shift in layer heights, a new pattern every
// jitter frames (0 = static).
float sac_edgeNoise(vec2 p, float height, float frequency, float relX, int octaves, vec2 shift, float jitter, float seed) {
  float slice = jitter > 0.0 ? floor(u_frame / jitter) : 0.0;
  vec2 q = (p / max(height, 1.0) + shift) * frequency * vec2(relX, 1.0);
  return fx_fbm(q, octaves, 2.0, 0.5, fract(seed + slice * 0.6180339887));
}
`,
};

const blurFrag = (tex: string, kind: 'box' | 'gauss') => /* glsl */ `
void main() {
  vec2 texel = 1.0 / vec2(textureSize(${tex}, 0));
  fragColor = ${kind === 'box' ? 'fx_box1d' : 'fx_gaussian1d'}(${tex}, v_uv, u_blurDir, texel, u_blurR);
}`;

/** Separable box blur of half-width `r` canvas px (H then V), half-float. */
function boxPasses(input: string, output: string, r: number): ShaderPass[] {
	return [
		{
			output: `${output}H`,
			frag: blurFrag(`u_${input}`, 'box'),
			include: [GLSL_BLUR],
			format: 'rgba16f',
			uniforms: { u_blurDir: [1, 0], u_blurR: r },
		},
		{
			output,
			frag: blurFrag(`u_${output}H`, 'box'),
			include: [GLSL_BLUR],
			format: 'rgba16f',
			uniforms: { u_blurDir: [0, 1], u_blurR: r },
		},
	];
}

/**
 * Passes blurring the matte texture `input` (matte in .r) with the shaping filter; the level is readable as
 * `u_<output>`. Box: one box of reach R; Triangle: two boxes of R/2 (their convolution reaches R); Gauss: σ = R/2.5.
 */
export function matteFilterPasses(
	input: string,
	output: string,
	filter: MatteFilter,
	reach: number,
): ShaderPass[] {
	if (filter === 'box') return boxPasses(input, output, reach);
	if (filter === 'triangle')
		return [...boxPasses(input, `${output}A`, reach / 2), ...boxPasses(`${output}A`, output, reach / 2)];
	return gaussianBlurPasses({ input, output, sigma: reach / 2.5, format: 'rgba16f' });
}

export const filterIndex = (p: EffectParams): number =>
	Math.max(0, MATTE_FILTERS.indexOf(str(p, 'filter', 'triangle') as MatteFilter));

/** Per-frame uniforms of the shaping (reach and grow in canvas px, noise reach). */
export function matteUniforms(p: EffectParams, ctx: Pick<FxPlanContext, 'height' | 'pxScale'>) {
	return {
		u_matteReach: matteReachPx(p, ctx),
		u_matteGrow: num(p, 'shrinkGrow') * ctx.pxScale,
		u_matteSoft: Math.max(0.01, num(p, 'edgeSoftness', 1)) * ctx.pxScale,
		u_noiseReach: noiseReachPx(p, ctx),
		u_layerHeight: ctx.height,
	};
}

/** GLSL expression of the shaped matte for a blurred level `level` (uses the uniforms above + noise params). */
export function matteShapeExpr(
	level: string,
	opts: { relX: boolean; jitter: boolean; filter: string },
): string {
	const relX = opts.relX ? 'u_frequencyRelX' : '1.0';
	const jitter = opts.jitter ? 'u_jitterFrames' : '0.0';
	return `sac_matteShape(${opts.filter}, ${level}, u_matteReach, u_matteGrow + (u_noiseReach > 0.0 ? u_noiseReach * sac_edgeNoise(fx_layerPx(), u_layerHeight, u_frequency, ${relX}, int(u_octaves), u_noiseShift, ${jitter}, u_seed) : 0.0), u_matteSoft)`;
}

/** Post Blur σ in canvas px (pixels, like Shrink/Grow). */
export const postBlurSigma = (p: EffectParams, ctx: Pick<FxPlanContext, 'pxScale'>) =>
	Math.max(0, num(p, 'postBlur')) * ctx.pxScale;

export { relSigma };
