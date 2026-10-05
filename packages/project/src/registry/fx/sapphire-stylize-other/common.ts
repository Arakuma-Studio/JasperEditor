// Shared helpers of the "Sapphire other stylize" family (fx catalogue, wave 2): Sapphire's units and coordinates,
// the Mask input (Mask / Mask Use / Invert Mask), separable blurs with per-axis widths, and the GLSL the family's
// effects share. Family-private: only `../sapphire-stylize-other.ts` and its sibling modules import this.
//
// Units (normative for the family, documented in the effect descriptions where it matters):
// - Sapphire positions are frame coordinates with x −1…1 across the width (0 = centre) and y up in the same unit.
//   Our point params are layer-normalised ([0,0] top-left, [1,1] bottom-right); `sapphirePoint` converts Sapphire's
//   documented defaults (for a 16:9 frame).
// - Sapphire sizes/distances/radii keep Sapphire's numbers: 1.0 = half the layer width (`sso_unit()` in GLSL).
// - Sapphire blur widths keep Sapphire's numbers: 1.0 = a Gaussian sigma of a tenth of the layer width
//   (`sapphireBlurPx`), so the documented defaults (0.088, 0.112…) give the documented look at any resolution.
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';

export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** A Sapphire frame position (x −1…1 across the width, y up) → a layer-normalised point (16:9 frame). */
export function sapphirePoint(x: number, y: number, aspect = 16 / 9): [number, number] {
	return [round3(0.5 + x / 2), round3(0.5 - (y * aspect) / 2)];
}

/** A Sapphire blur width → Gaussian sigma in canvas px (1.0 = a tenth of the layer width). */
export function sapphireBlurPx(v: unknown, ctx: Pick<FxPlanContext, 'width' | 'pxScale'>): number {
	return Math.max(0, num(v)) * ctx.width * 0.1 * ctx.pxScale;
}

/** A Sapphire-style plain number (no unit): `soft*` bounds are the slider range, `min`/`max` hard limits. */
export function sNum(
	name: string,
	label: string,
	def: number,
	r: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number } = {},
): ParamSpec {
	return fxParam.number(name, label, def, { step: 0.001, ...r });
}

/** An integer-valued Sapphire number (counts, sides, block sizes). */
export function sInt(name: string, label: string, def: number, min: number, max: number, softMax?: number) {
	return fxParam.number(name, label, def, { min, max, step: 1, ...(softMax ? { softMax } : {}) });
}

// ---------------------------------------------------------------- Mask input

/**
 * Sapphire's Mask input: a picture (image/video of the project, stretched over the layer box) restricting where
 * the effect applies (white = full effect), read by luminance or alpha, optionally inverted. No mask = everywhere.
 */
export function maskParams(): ParamSpec[] {
	return [
		fxParam.media('mask', 'Mask'),
		fxParam.choice('maskUse', 'Mask Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'luma'),
		fxParam.toggle('invertMask', 'Invert Mask', false),
	];
}

/** GLSL of the Mask input (needs `maskParams()`): `sso_mask()` (0..1, 1 without a mask). */
export const GLSL_SSO_MASK_ONLY: GlslChunk = {
	name: 'sapphire-stylize-other/mask-only',
	deps: [GLSL_COMPOSITE],
	source: /* glsl */ `
float sso_mask() {
  if (u_mask_size.x <= 0.0) return 1.0;
  vec4 m = texture(u_mask, clamp(fx_layerNorm(), vec2(0.0), vec2(1.0)));
  float v = u_maskUse == 1 ? m.a : fx_luma(fx_unpremultiply(m).rgb) * m.a;
  return u_invertMask ? 1.0 - v : v;
}
`,
};

/**
 * `sso_mask()` plus `sso_finish(result, original, matte)`: the result restricted to the mask, then Show (Result /
 * Matte) and Mix with Orig. Needs `maskParams()` and `sapphireCommonParams()`. matte < 0 = show the mask.
 */
export const GLSL_SSO_MASK: GlslChunk = {
	name: 'sapphire-stylize-other/mask',
	deps: [GLSL_SSO_MASK_ONLY],
	source: /* glsl */ `
vec4 sso_finish(vec4 result, vec4 original, float matte) {
  float m = sso_mask();
  return fx_finish(mix(original, result, m), original, matte < 0.0 ? m : matte, u_mixWithOriginal, u_show);
}
`,
};

// ---------------------------------------------------------------- shared GLSL

/** Coordinates in canvas px relative to the layer box, Sapphire's unit, and the tone helpers of the family. */
export const GLSL_SSO_COMMON: GlslChunk = {
	name: 'sapphire-stylize-other/common',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
// Canvas px relative to the layer box's top-left (y down).
vec2 sso_boxPx() { return v_uv * u_canvasSize - u_box.xy; }
vec2 sso_uvOfBoxPx(vec2 p) { return (p + u_box.xy) / u_canvasSize; }
// Sapphire's distance unit in canvas px: half the layer width.
float sso_unit() { return u_box.z * 0.5; }
// Sapphire "Offset Darks": adds a grey value to the darker regions (none at white; negative = more contrast).
vec3 sso_offsetDarks(vec3 c, float o) { return c + o * (1.0 - clamp(c, 0.0, 1.0)); }
// Sapphire "Scale By Source" / "Scale By Src Amp": darkens the result where the source is dark.
float sso_scaleBySource(float luma, float amount, float amp) { return mix(1.0, min(luma * amp, 1.0), clamp(amount, 0.0, 1.0)); }
`,
};

/** The colourisation of S_PsykoBlobs / S_PsykoStripes (per-channel cosine palettes, Sapphire's colour params). */
export const GLSL_SSO_PSYKO: GlslChunk = {
	name: 'sapphire-stylize-other/psyko',
	deps: [GLSL_SSO_COMMON],
	source: /* glsl */ `
vec3 sso_psykoColor(float v, float srcLuma) {
  float ph = u_phaseStart + u_phaseSpeed * u_time;
  vec3 f = vec3(u_freqRed, u_freqGreen, u_freqBlue) * u_freqColors;
  vec3 c = 0.5 - 0.5 * cos(6.28318530718 * (v * f + ph + vec3(u_phaseRed, u_phaseGreen, u_phaseBlue)));
  c = fx_saturate(c, u_saturation) * u_brightness * u_color.rgb + u_offset;
  return max(c, 0.0) * sso_scaleBySource(srcLuma, u_scaleBySource, u_scaleBySrcAmp);
}
`,
};

/** The "Psyko" colour params in Sapphire's order (Freq Colors … Scale By Src Amp). */
export function psykoColorParams(freqColors: number): ParamSpec[] {
	return [
		sNum('freqColors', 'Freq Colors', freqColors, { min: 0, softMax: 20 }),
		sNum('freqRed', 'Freq Red', 1, { min: 0, softMax: 4 }),
		sNum('freqGreen', 'Freq Green', 1.1, { min: 0, softMax: 4 }),
		sNum('freqBlue', 'Freq Blue', 1.2, { min: 0, softMax: 4 }),
		sNum('phaseStart', 'Phase Start', 0.5, { softMin: -2, softMax: 2 }),
		sNum('phaseSpeed', 'Phase Speed', 1, { softMin: -4, softMax: 4 }),
		sNum('phaseRed', 'Phase Red', 0, { softMin: -1, softMax: 1 }),
		sNum('phaseGreen', 'Phase Green', 0, { softMin: -1, softMax: 1 }),
		sNum('phaseBlue', 'Phase Blue', 0, { softMin: -1, softMax: 1 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		fxParam.color('color', 'Color', [1, 1, 1, 1]),
		sNum('offset', 'Offset', 0, { min: -8, max: 2, softMin: -1, softMax: 1 }),
		sNum('saturation', 'Saturation', 1, { min: 0, max: 10, softMax: 4 }),
		sNum('scaleBySource', 'Scale By Source', 0, { min: 0, max: 1 }),
		sNum('scaleBySrcAmp', 'Scale By Src Amp', 1, { min: 0, softMax: 4 }),
	];
}

// ---------------------------------------------------------------- blurs

/**
 * Two passes (horizontal, vertical) Gaussian-blurring the texture `input` (`'source'` or an output name) into
 * `output`, with separate sigmas per axis in CANVAS px. Large sigmas run at ½ or ¼ resolution (the sigma is
 * converted); a ~0 blur still yields the two passes (copies), so later passes can always read `u_<output>`.
 */
export function blurPasses(o: {
	input: string;
	output: string;
	sigmaX: number;
	sigmaY?: number;
	format?: 'rgba8' | 'rgba16f';
	/** Smallest resolution scale allowed (default ¼). */
	minScale?: number;
}): ShaderPass[] {
	const sx = Math.max(0, num(o.sigmaX));
	const sy = Math.max(0, num(o.sigmaY ?? o.sigmaX));
	const s = Math.max(sx, sy);
	const scale = Math.max(o.minScale ?? 0.25, s > 48 ? 0.25 : s > 12 ? 0.5 : 1);
	const frag = (tex: string) => /* glsl */ `
void main() {
  vec2 size = vec2(textureSize(${tex}, 0));
  float sigma = u_blurSigma * dot(u_blurDir, size / u_resolution);
  fragColor = fx_gaussian1d(${tex}, v_uv, u_blurDir, 1.0 / size, sigma);
}`;
	return [
		{
			output: `${o.output}H`,
			frag: frag(`u_${o.input}`),
			include: [GLSL_BLUR],
			scale,
			format: o.format,
			uniforms: { u_blurDir: [1, 0], u_blurSigma: sx * scale },
		},
		{
			output: o.output,
			frag: frag(`u_${o.output}H`),
			include: [GLSL_BLUR],
			scale,
			format: o.format,
			uniforms: { u_blurDir: [0, 1], u_blurSigma: sy * scale },
		},
	];
}

/** Default values of a param list (tests, previews). */
export function defaultsOf(params: readonly ParamSpec[]): EffectParams {
	return Object.fromEntries(params.map((p) => [p.name, p.default])) as EffectParams;
}
