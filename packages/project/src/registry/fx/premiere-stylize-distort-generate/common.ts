// Shared helpers of the "premiere-stylize-distort-generate" family (wave 2): param coercion, the Premiere/After
// Effects "Blending Mode" popup of the generators (None … Luminosity, Stencil/Silhouette Alpha), "Blend With
// Original", "Random Seed", and the GLSL that goes with them. Family-private: other families use the framework's
// `blendModeParam()` / `sapphireCommonParams()` instead.
import type { ParamValue } from '../../../schema/common.ts';
import type { ParamSpec } from '../../effects.ts';
import { GLSL_BLEND } from '../glsl/blend.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import type { GlslChunk } from '../shader.ts';

/** A finite number param value (or the default). */
export const num = (v: ParamValue | undefined, d = 0): number =>
	typeof v === 'number' && Number.isFinite(v) ? v : d;

/** A boolean param value (or the default). */
export const bool = (v: ParamValue | undefined, d = false): boolean => (typeof v === 'boolean' ? v : d);

/** An enum param value (or the default). */
export const str = (v: ParamValue | undefined, d: string): string => (typeof v === 'string' ? v : d);

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * The Blending Mode popup of the After Effects-derived generators (Circle, Checkerboard, Grid, 4-Color Gradient…), in
 * GLSL index order of `psdg_blend`. `none` = the generated picture alone (the layer is replaced).
 */
export const PSDG_BLEND_MODES = [
	'none',
	'normal',
	'add',
	'multiply',
	'screen',
	'overlay',
	'softLight',
	'hardLight',
	'colorDodge',
	'colorBurn',
	'darken',
	'lighten',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity',
	'stencilAlpha',
	'silhouetteAlpha',
] as const;
export const PSDG_BLEND_MODE_LABELS = [
	'None',
	'Normal',
	'Add',
	'Multiply',
	'Screen',
	'Overlay',
	'Soft Light',
	'Hard Light',
	'Color Dodge',
	'Color Burn',
	'Darken',
	'Lighten',
	'Difference',
	'Exclusion',
	'Hue',
	'Saturation',
	'Color',
	'Luminosity',
	'Stencil Alpha',
	'Silhouette Alpha',
] as const;
export type PsdgBlendMode = (typeof PSDG_BLEND_MODES)[number];

/**
 * "Blending Mode" popup (`u_<name>` int → `psdg_blend(u_<name>, original, generated, opacity)`). `count` limits the
 * list (most generators stop at Luminosity = 18 modes; Circle/Checkerboard/Grid add the stencil modes).
 */
export function psdgBlendModeParam(
	def: PsdgBlendMode = 'none',
	opts: { name?: string; label?: string; stencil?: boolean } = {},
): ParamSpec {
	const n = opts.stencil ? PSDG_BLEND_MODES.length : PSDG_BLEND_MODES.length - 2;
	return fxParam.choice(
		opts.name ?? 'blendingMode',
		opts.label ?? 'Blending Mode',
		PSDG_BLEND_MODES.slice(0, n),
		PSDG_BLEND_MODE_LABELS.slice(0, n),
		def,
	);
}

/** "Blend With Original" 0..100 % (`u_blendWithOriginal`; GLSL `psdg_blendOriginal(result, original)`). */
export function blendWithOriginalParam(def = 0): ParamSpec {
	return fxParam.percent('blendWithOriginal', 'Blend With Original', def);
}

/** "Random Seed" — named `seed` so the framework mixes it into `u_seed`. */
export function randomSeedParam(def = 0, label = 'Random Seed'): ParamSpec {
	return {
		name: 'seed',
		label,
		type: 'number',
		default: def,
		range: { min: 0, max: 10000, softMax: 1000, step: 1 },
		animatable: true,
	};
}

/** "Transition Completion" 0..100 % of the effect versions of the transitions (keyframable). */
export function transitionCompletionParam(def = 0): ParamSpec {
	return fxParam.percent('completion', 'Transition Completion', def);
}

/**
 * Premiere generators' blending (premultiplied in and out):
 * - `psdg_blend(mode, base, top, opacity)`: `top` (the generated picture) blended over `base` (the layer) with the
 *   AE/Premiere modes of PSDG_BLEND_MODES; mode 0 (None) = `top` alone at `opacity` over transparency; stencil alpha
 *   keeps the base where top is opaque; silhouette alpha cuts it out.
 * - `psdg_blendOriginal(result, original)`: Blend With Original (uses `u_blendWithOriginal` when declared — the
 *   function takes the percentage explicitly so the chunk does not depend on a param).
 * - `psdg_setLum` / `psdg_setSat`: the W3C non-separable modes (hue, saturation, color, luminosity).
 */
export const GLSL_PSDG_BLEND: GlslChunk = {
	name: 'psdg/blend',
	deps: [GLSL_BLEND, GLSL_COLOR],
	source: /* glsl */ `
float psdg_lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 psdg_clipColor(vec3 c) {
  float l = psdg_lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1.0e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1.0e-6);
  return c;
}
vec3 psdg_setLum(vec3 c, float l) { return psdg_clipColor(c + (l - psdg_lum(c))); }
float psdg_sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 psdg_setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  if (d <= 1.0e-6) return vec3(0.0);
  return (c - mn) * s / d;
}
// Straight-colour blend function of the AE/Premiere generator modes (1..17); 0/18/19 handled by psdg_blend.
vec3 psdg_blendRgb(int mode, vec3 b, vec3 t) {
  if (mode == 2) return fx_blendRgb(FX_BLEND_ADD, b, t);
  if (mode == 3) return fx_blendRgb(FX_BLEND_MULTIPLY, b, t);
  if (mode == 4) return fx_blendRgb(FX_BLEND_SCREEN, b, t);
  if (mode == 5) return fx_blendRgb(FX_BLEND_OVERLAY, b, t);
  if (mode == 6) return fx_blendRgb(FX_BLEND_SOFT_LIGHT, b, t);
  if (mode == 7) return fx_blendRgb(FX_BLEND_HARD_LIGHT, b, t);
  if (mode == 8) return fx_blendRgb(FX_BLEND_COLOR_DODGE, b, t);
  if (mode == 9) return fx_blendRgb(FX_BLEND_COLOR_BURN, b, t);
  if (mode == 10) return fx_blendRgb(FX_BLEND_DARKEN, b, t);
  if (mode == 11) return fx_blendRgb(FX_BLEND_LIGHTEN, b, t);
  if (mode == 12) return fx_blendRgb(FX_BLEND_DIFFERENCE, b, t);
  if (mode == 13) return fx_blendRgb(FX_BLEND_EXCLUSION, b, t);
  if (mode == 14) return psdg_setLum(psdg_setSat(t, psdg_sat(b)), psdg_lum(b));
  if (mode == 15) return psdg_setLum(psdg_setSat(b, psdg_sat(t)), psdg_lum(b));
  if (mode == 16) return psdg_setLum(t, psdg_lum(b));
  if (mode == 17) return psdg_setLum(b, psdg_lum(t));
  return t;
}
vec4 psdg_blend(int mode, vec4 base, vec4 top, float opacity) {
  opacity = clamp(opacity, 0.0, 1.0);
  if (mode == 0) return top * opacity;
  if (mode == 18) return base * mix(1.0, top.a, opacity);
  if (mode == 19) return base * mix(1.0, 1.0 - top.a, opacity);
  top *= opacity;
  if (mode == 1) return fx_over(top, base);
  vec3 cb = base.a > 0.0 ? base.rgb / base.a : vec3(0.0);
  vec3 cs = top.a > 0.0 ? top.rgb / top.a : vec3(0.0);
  vec3 mixed = (1.0 - base.a) * cs + base.a * clamp(psdg_blendRgb(mode, cb, cs), 0.0, 1.0);
  return vec4(top.a * mixed + (1.0 - top.a) * base.rgb, top.a + base.a * (1.0 - top.a));
}
// Blend With Original (percent 0..100).
vec4 psdg_blendOriginal(vec4 result, vec4 original, float percent) {
  return mix(result, original, clamp(percent / 100.0, 0.0, 1.0));
}
`,
};
