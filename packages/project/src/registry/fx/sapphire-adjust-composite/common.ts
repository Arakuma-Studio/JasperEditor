// Family-private helpers of `sapphire-adjust-composite`: param readers, Sapphire's relative
// width convention, the Sapphire mask block (Mask input + Mask Use / Blur Mask / Invert Mask), picture inputs mapped
// onto the layer box (Input Fit) and the shared GLSL (lights/darks/saturation grading, media sampling, matte reads).
// Import rule: values only from the framework modules (../shader.ts, ../params.ts, ../passes.ts, ../glsl/*), types
// from ../../effects.ts.

import type { EffectParams, ParamSpec } from '../../effects.ts';
import { mediaParamId } from '../../param-values.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam, mixWithOriginalParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';

export const num = (p: EffectParams, k: string, d = 0): number => {
	const v = p[k];
	return typeof v === 'number' && Number.isFinite(v) ? v : d;
};
export const bool = (p: EffectParams, k: string, d = false): boolean => {
	const v = p[k];
	return typeof v === 'boolean' ? v : d;
};
export const str = (p: EffectParams, k: string, d: string): string => {
	const v = p[k];
	return typeof v === 'string' ? v : d;
};
/** True when a `media` param names a media item (offline media still reads as size 0 in GLSL). */
export const mediaSet = (p: EffectParams, k: string): boolean => {
	return !!mediaParamId(p[k]);
};

/**
 * Sapphire expresses blur/flash/noise widths relative to the frame. Here 1.0 = the layer height, and a blur width is
 * the blur's reach (≈ 3σ): σ (canvas px) = width · layerHeight · pxScale / 3.
 */
export function relSigma(width: number, ctx: Pick<FxPlanContext, 'height' | 'pxScale'>): number {
	return (Math.max(0, width) * ctx.height * ctx.pxScale) / 3;
}

/** "Mix With Source" (Sapphire's name on the adjust effects) on the framework's `mixWithOriginal` uniform. */
export function mixWithSourceParam(): ParamSpec {
	return { ...mixWithOriginalParam(), label: 'Mix With Source' };
}

/** How picture inputs (Background, Source B, mattes, depth maps) are mapped onto the layer box. */
export function inputFitParam(): ParamSpec {
	return fxParam.choice(
		'inputFit',
		'Input Fit',
		['stretch', 'fit', 'fill'],
		['Stretch to Layer', 'Fit (Letterbox)', 'Fill (Crop)'],
		'stretch',
	);
}

export const GLSL_SAC_COMMON: GlslChunk = {
	name: 'sapphire-adjust-composite/common',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
// Sapphire grading controls on straight colour: Lights scales, Darks adds grey weighted towards the darks
// (negative Darks deepens them = more contrast), Saturation scales the chroma around Rec.709 luma (0 = mono).
vec3 sac_lightsDarks(vec3 c, vec3 lights, vec3 darks) { return c * lights + darks * (1.0 - clamp(c, 0.0, 1.0)); }
vec3 sac_grade(vec3 c, float lights, float darks, float sat) {
  c = sac_lightsDarks(c, vec3(lights), vec3(darks));
  float y = fx_luma(c);
  return vec3(y) + (c - vec3(y)) * sat;
}
// A picture input (premultiplied) on the layer box. fit: 0 stretch, 1 fit (letterbox), 2 fill (crop).
// Outside the picture, and when the input is missing (size 0): transparent.
vec4 sac_media(sampler2D t, vec2 size, int fit) {
  if (size.x <= 0.0 || size.y <= 0.0) return vec4(0.0);
  vec2 n = fx_layerNorm();
  if (fit != 0) {
    float boxAspect = u_box.z / max(u_box.w, 1.0);
    float picAspect = size.x / size.y;
    vec2 s = vec2(1.0);
    if ((fit == 1) == (picAspect > boxAspect)) s.y = boxAspect / picAspect; else s.x = picAspect / boxAspect;
    n = (n - 0.5) / s + 0.5;
  }
  if (any(lessThan(n, vec2(0.0))) || any(greaterThan(n, vec2(1.0)))) return vec4(0.0);
  return texture(t, n);
}
// A matte value from a premultiplied picture: use 0 = luma (of the premultiplied colour), 1 = alpha, 2 = opaque (1).
float sac_matteOf(vec4 p, int use) {
  if (use == 0) return clamp(fx_luma(p.rgb), 0.0, 1.0);
  if (use == 1) return p.a;
  return 1.0;
}
// Straight colour of a premultiplied picture, clamped to 0..1.
vec3 sac_straight(vec4 p) { return p.a > 0.0 ? clamp(p.rgb / p.a, 0.0, 1.0) : vec3(0.0); }
`,
};

/**
 * Sapphire's optional Mask input and its trailing controls (Mask Use, Blur Mask, Invert Mask). White mask areas show
 * the effect, black areas the source. The mask picture is a `media` param stretched over the layer box.
 */
export function maskParams(): ParamSpec[] {
	return [
		fxParam.media('mask', 'Mask'),
		fxParam.choice('maskUse', 'Mask Use', ['luma', 'alpha'], ['Luma', 'Alpha'], 'luma'),
		fxParam.number('blurMask', 'Blur Mask', 0.05, { min: 0, max: 10, softMax: 1, step: 0.001 }),
		fxParam.toggle('invertMask', 'Invert Mask', false),
	];
}

/** Passes preparing the (blurred) mask, readable as `u_maskSoft` (or `u_maskRaw` without blur); [] without a mask. */
export function maskPasses(p: EffectParams, ctx: FxPlanContext): ShaderPass[] {
	if (!mediaSet(p, 'mask')) return [];
	const raw: ShaderPass = {
		output: 'maskRaw',
		include: [GLSL_SAC_COMMON],
		frag: /* glsl */ `
void main() {
  float m = u_mask_size.x > 0.0 ? sac_matteOf(sac_media(u_mask, u_mask_size, 0), u_maskUse) : 1.0;
  fragColor = vec4(m);
}`,
	};
	const sigma = relSigma(num(p, 'blurMask', 0.05), ctx);
	if (sigma < 0.05) return [raw];
	return [raw, ...gaussianBlurPasses({ input: 'maskRaw', output: 'maskSoft', sigma })];
}

/** GLSL defining `float sac_mask()` (1 = full effect) for the final pass, matching `maskPasses`. */
export function maskGlsl(p: EffectParams, ctx: FxPlanContext): string {
	if (!mediaSet(p, 'mask')) return 'float sac_mask() { return 1.0; }';
	const tex = relSigma(num(p, 'blurMask', 0.05), ctx) < 0.05 ? 'u_maskRaw' : 'u_maskSoft';
	return /* glsl */ `
float sac_mask() {
  float m = clamp(texture(${tex}, v_uv).r, 0.0, 1.0);
  return u_invertMask ? 1.0 - m : m;
}`;
}
