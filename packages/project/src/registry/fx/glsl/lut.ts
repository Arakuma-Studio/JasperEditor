// Shared GLSL: 3D LUTs of `lut` media params (fx framework follow-ups). A `fxParam.lut(...)` param (a `media` param
// with `mediaKinds: ['lut']`) is bound as `uniform highp sampler3D u_<name>` (N³ RGB, half float, trilinear, .cube
// order: red fastest) with `u_<name>_size` = (N, 1), or (0, 0) when no LUT is bound (none chosen / offline).
// 1D LUTs and custom DOMAIN_MIN/MAX are baked to 33³ by the host first, so the input domain is always 0..1.
import type { GlslChunk } from '../shader.ts';

export const GLSL_LUT: GlslChunk = {
	name: 'fx/lut',
	source: /* glsl */ `
// The LUT colour of straight RGB c (clamped to 0..1); c itself when no LUT is bound (size.x < 2).
vec3 fx_lut3d(highp sampler3D t, vec2 size, vec3 c) {
  if (size.x < 2.0) return c;
  vec3 uvw = (clamp(c, 0.0, 1.0) * (size.x - 1.0) + 0.5) / size.x;
  return texture(t, uvw).rgb;
}
// fx_lut3d mixed with the input by amount (0..1).
vec3 fx_lutMix(highp sampler3D t, vec2 size, vec3 c, float amount) {
  return mix(c, fx_lut3d(t, size, c), clamp(amount, 0.0, 1.0));
}
`,
};
