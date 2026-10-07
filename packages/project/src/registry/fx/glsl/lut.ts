// Shared GLSL: 3D LUTs of `lut` media params (fx framework follow-ups). A `fxParam.lut(...)` param (a `media` param
// with `mediaKinds: ['lut']`) is bound as `uniform highp sampler3D u_<name>` (N³ RGB, half float, .cube order: red
// fastest) with `u_<name>_size` = (N, 1), or (0, 0) when no LUT is bound (none chosen / offline).
// 1D LUTs, shapers (color-mgmt) and custom DOMAIN_MIN/MAX are baked to 33³ by the host first, so the input domain is
// always 0..1. color-mgmt: sampled with tetrahedral interpolation (`texelFetch` of the four corners, the same
// arithmetic as `applyLut`, the colour stage and FFmpeg `lut3d`), not the texture unit's trilinear filtering.
import type { GlslChunk } from '../shader.ts';

export const GLSL_LUT: GlslChunk = {
	name: 'fx/lut',
	source: /* glsl */ `
// The LUT colour of straight RGB c (clamped to 0..1); c itself when no LUT is bound (size.x < 2).
vec3 fx_lut3d(highp sampler3D t, vec2 size, vec3 c) {
  if (size.x < 2.0) return c;
  int n1 = int(size.x + 0.5) - 1;
  vec3 x = clamp(c, 0.0, 1.0) * float(n1);
  ivec3 i0 = min(ivec3(floor(x)), ivec3(n1 - 1));
  vec3 f = x - vec3(i0);
  vec3 c000 = texelFetch(t, i0, 0).rgb;
  vec3 c111 = texelFetch(t, i0 + ivec3(1), 0).rgb;
  ivec3 da; ivec3 db; vec4 w;
  if (f.r > f.g) {
    if (f.g > f.b) { da = ivec3(1, 0, 0); db = ivec3(1, 1, 0); w = vec4(1.0 - f.r, f.r - f.g, f.g - f.b, f.b); }
    else if (f.r > f.b) { da = ivec3(1, 0, 0); db = ivec3(1, 0, 1); w = vec4(1.0 - f.r, f.r - f.b, f.b - f.g, f.g); }
    else { da = ivec3(0, 0, 1); db = ivec3(1, 0, 1); w = vec4(1.0 - f.b, f.b - f.r, f.r - f.g, f.g); }
  } else if (f.b > f.g) { da = ivec3(0, 0, 1); db = ivec3(0, 1, 1); w = vec4(1.0 - f.b, f.b - f.g, f.g - f.r, f.r); }
  else if (f.b > f.r) { da = ivec3(0, 1, 0); db = ivec3(0, 1, 1); w = vec4(1.0 - f.g, f.g - f.b, f.b - f.r, f.r); }
  else { da = ivec3(0, 1, 0); db = ivec3(1, 1, 0); w = vec4(1.0 - f.g, f.g - f.r, f.r - f.b, f.b); }
  return w.x * c000 + w.y * texelFetch(t, i0 + da, 0).rgb + w.z * texelFetch(t, i0 + db, 0).rgb + w.w * c111;
}
// fx_lut3d mixed with the input by amount (0..1).
vec3 fx_lutMix(highp sampler3D t, vec2 size, vec3 c, float amount) {
  return mix(c, fx_lut3d(t, size, c), clamp(amount, 0.0, 1.0));
}
`,
};
