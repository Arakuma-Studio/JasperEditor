// Shared GLSL: blend modes and premultiplied compositing (wave-1 fx framework). `fx_blendRgb(mode, base, top)` works
// on straight RGB 0..1; `fx_blend(mode, base, top, opacity)` composites premultiplied RGBA (top over base, the
// blend applied where both exist — the W3C compositing model). Mode numbers = indexes of FX_BLEND_MODES, so an enum
// param built with `blendModeParam()` maps straight onto `int u_<name>`.
import type { GlslChunk } from '../shader.ts';

/** Blend mode option values in GLSL index order (`blendModeParam` options). */
export const FX_BLEND_MODES = [
	'normal',
	'add',
	'screen',
	'multiply',
	'overlay',
	'softLight',
	'hardLight',
	'colorDodge',
	'colorBurn',
	'linearBurn',
	'lighten',
	'darken',
	'difference',
	'exclusion',
	'subtract',
	'divide',
] as const;
export const FX_BLEND_MODE_LABELS = [
	'Normal',
	'Add',
	'Screen',
	'Multiply',
	'Overlay',
	'Soft Light',
	'Hard Light',
	'Color Dodge',
	'Color Burn',
	'Linear Burn',
	'Lighten',
	'Darken',
	'Difference',
	'Exclusion',
	'Subtract',
	'Divide',
] as const;

export const GLSL_BLEND: GlslChunk = {
	name: 'fx/blend',
	source: /* glsl */ `
const int FX_BLEND_NORMAL = 0;
const int FX_BLEND_ADD = 1;
const int FX_BLEND_SCREEN = 2;
const int FX_BLEND_MULTIPLY = 3;
const int FX_BLEND_OVERLAY = 4;
const int FX_BLEND_SOFT_LIGHT = 5;
const int FX_BLEND_HARD_LIGHT = 6;
const int FX_BLEND_COLOR_DODGE = 7;
const int FX_BLEND_COLOR_BURN = 8;
const int FX_BLEND_LINEAR_BURN = 9;
const int FX_BLEND_LIGHTEN = 10;
const int FX_BLEND_DARKEN = 11;
const int FX_BLEND_DIFFERENCE = 12;
const int FX_BLEND_EXCLUSION = 13;
const int FX_BLEND_SUBTRACT = 14;
const int FX_BLEND_DIVIDE = 15;
vec3 fx_overlayRgb(vec3 b, vec3 t) { return mix(2.0 * b * t, 1.0 - 2.0 * (1.0 - b) * (1.0 - t), step(0.5, b)); }
vec3 fx_softLightRgb(vec3 b, vec3 t) {
  vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
  return mix(b - (1.0 - 2.0 * t) * b * (1.0 - b), b + (2.0 * t - 1.0) * (d - b), step(0.5, t));
}
vec3 fx_blendRgb(int mode, vec3 b, vec3 t) {
  if (mode == FX_BLEND_ADD) return min(b + t, vec3(1.0));
  if (mode == FX_BLEND_SCREEN) return b + t - b * t;
  if (mode == FX_BLEND_MULTIPLY) return b * t;
  if (mode == FX_BLEND_OVERLAY) return fx_overlayRgb(b, t);
  if (mode == FX_BLEND_SOFT_LIGHT) return fx_softLightRgb(b, t);
  if (mode == FX_BLEND_HARD_LIGHT) return fx_overlayRgb(t, b);
  if (mode == FX_BLEND_COLOR_DODGE) return mix(min(vec3(1.0), b / max(1.0 - t, vec3(1.0e-5))), vec3(1.0), step(1.0, t)) * step(1.0e-5, b);
  if (mode == FX_BLEND_COLOR_BURN) return mix(1.0 - min(vec3(1.0), (1.0 - b) / max(t, vec3(1.0e-5))), vec3(1.0), step(1.0, b));
  if (mode == FX_BLEND_LINEAR_BURN) return max(b + t - 1.0, vec3(0.0));
  if (mode == FX_BLEND_LIGHTEN) return max(b, t);
  if (mode == FX_BLEND_DARKEN) return min(b, t);
  if (mode == FX_BLEND_DIFFERENCE) return abs(b - t);
  if (mode == FX_BLEND_EXCLUSION) return b + t - 2.0 * b * t;
  if (mode == FX_BLEND_SUBTRACT) return max(b - t, vec3(0.0));
  if (mode == FX_BLEND_DIVIDE) return min(vec3(1.0), b / max(t, vec3(1.0e-5)));
  return t;
}
// Premultiplied source-over.
vec4 fx_over(vec4 top, vec4 base) { return top + base * (1.0 - top.a); }
// Premultiplied blend of top over base with a blend mode and an opacity 0..1 (W3C: B(cb, cs) where both exist).
vec4 fx_blend(int mode, vec4 base, vec4 top, float opacity) {
  top *= clamp(opacity, 0.0, 1.0);
  if (mode == FX_BLEND_NORMAL) return fx_over(top, base);
  vec3 cb = base.a > 0.0 ? base.rgb / base.a : vec3(0.0);
  vec3 cs = top.a > 0.0 ? top.rgb / top.a : vec3(0.0);
  vec3 mixed = (1.0 - base.a) * cs + base.a * fx_blendRgb(mode, cb, cs);
  return vec4(top.a * mixed + (1.0 - top.a) * base.rgb, top.a + base.a * (1.0 - top.a));
}
// Additive light (glows, flares, rays): adds premultiplied light, alpha grows with the light's luminance.
vec4 fx_addLight(vec4 base, vec3 light) {
  vec3 rgb = base.rgb + light;
  return vec4(rgb, clamp(max(base.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0));
}
`,
};
