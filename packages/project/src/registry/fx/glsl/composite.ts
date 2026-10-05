// Shared GLSL: finishing helpers for Sapphire-style effects (wave-1 fx framework): "Mix with Original", "Show"
// (result / matte), mattes from luminance or colour distance (keying), and the alpha helpers. Pair them with the
// TypeScript param helpers `mixWithOriginalParam()` / `showParam()` (fx/params.ts), whose uniforms are
// `u_mixWithOriginal` (float 0..1) and `u_show` (int: 0 = result, 1 = matte, 2+ = effect-specific).
import type { GlslChunk } from '../shader.ts';
import { GLSL_COLOR } from './color.ts';

export const GLSL_COMPOSITE: GlslChunk = {
	name: 'fx/composite',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
const int FX_SHOW_RESULT = 0;
const int FX_SHOW_MATTE = 1;
// Linear mix of the effect result with the effect input (both premultiplied).
vec4 fx_mixOriginal(vec4 result, vec4 original, float mixWithOriginal) { return mix(result, original, clamp(mixWithOriginal, 0.0, 1.0)); }
// A matte as an opaque greyscale picture (Show: Matte).
vec4 fx_matteView(float matte) { return vec4(vec3(clamp(matte, 0.0, 1.0)), 1.0); }
// The usual tail of an effect: Show (result or its matte), then Mix with Original.
vec4 fx_finish(vec4 result, vec4 original, float matte, float mixWithOriginal, int show) {
  if (show == FX_SHOW_MATTE) return fx_matteView(matte);
  return fx_mixOriginal(result, original, mixWithOriginal);
}
// Soft threshold of luminance (glow sources): 0 below threshold, 1 above threshold + softness.
float fx_lumaMatte(vec3 straightRgb, float threshold, float softness) {
  return smoothstep(threshold, threshold + max(softness, 1.0e-4), fx_luma(straightRgb));
}
// Keying matte: 0 at the key colour, 1 away from it (tolerance and softness 0..1, distance in RGB).
float fx_colorDistanceMatte(vec3 straightRgb, vec3 key, float tolerance, float softness) {
  float d = distance(straightRgb, key) / 1.7320508;
  return smoothstep(tolerance, tolerance + max(softness, 1.0e-4), d);
}
// Multiplies a premultiplied colour by a matte (alpha and colour together).
vec4 fx_applyMatte(vec4 premultiplied, float matte) { return premultiplied * clamp(matte, 0.0, 1.0); }
// Replaces alpha keeping the straight colour (premultiplied in and out).
vec4 fx_setAlpha(vec4 premultiplied, float alpha) {
  vec3 c = premultiplied.a > 0.0 ? premultiplied.rgb / premultiplied.a : vec3(0.0);
  float a = clamp(alpha, 0.0, 1.0);
  return vec4(c * a, a);
}
`,
};
