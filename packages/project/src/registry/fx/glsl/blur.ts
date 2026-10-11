// Shared GLSL: blur kernels. Separable Gaussian and box blurs along one direction (run them as
// two passes, see `gaussianBlurPasses` in fx/passes.ts), a small 9-tap blur, and a radial (zoom) blur. Sigmas and
// radii are in pixels of the texture being read (multiply layer-pixel params by u_pxScale, and by the pass `scale`
// on downscaled passes). Textures are premultiplied, so blurring them does not darken edges.
import type { GlslChunk } from '../shader.ts';

/** Most taps per side of `fx_gaussian1d` / `fx_box1d` (bigger radii are sampled sparser: downscale instead). */
export const FX_BLUR_MAX_TAPS = 64;

export const GLSL_BLUR: GlslChunk = {
	name: 'fx/blur',
	source: /* glsl */ `
const int FX_BLUR_MAX_TAPS = 64;
float fx_gaussianWeight(float x, float sigma) { return exp(-0.5 * x * x / (sigma * sigma)); }
// 1D Gaussian along dir (a unit vector, e.g. vec2(1,0)) with sigma in texture pixels of t; texel = 1 / size of t.
// Uses linear filtering to read two texels per tap; beyond FX_BLUR_MAX_TAPS the taps spread out.
vec4 fx_gaussian1d(sampler2D t, vec2 uv, vec2 dir, vec2 texel, float sigma) {
  if (sigma < 0.05) return texture(t, uv);
  float radius = ceil(sigma * 3.0);
  float stride = max(1.0, radius / float(FX_BLUR_MAX_TAPS));
  vec4 sum = texture(t, uv);
  float wsum = 1.0;
  for (int i = 1; i <= FX_BLUR_MAX_TAPS; i++) {
    float x = float(i) * stride;
    if (x > radius) break;
    float w = fx_gaussianWeight(x, sigma);
    vec2 o = dir * texel * x;
    sum += (texture(t, uv + o) + texture(t, uv - o)) * w;
    wsum += 2.0 * w;
  }
  return sum / wsum;
}
// 1D box blur of radius r texture pixels.
vec4 fx_box1d(sampler2D t, vec2 uv, vec2 dir, vec2 texel, float r) {
  if (r < 0.5) return texture(t, uv);
  float stride = max(1.0, r / float(FX_BLUR_MAX_TAPS));
  vec4 sum = texture(t, uv);
  float n = 1.0;
  for (int i = 1; i <= FX_BLUR_MAX_TAPS; i++) {
    float x = float(i) * stride;
    if (x > r) break;
    vec2 o = dir * texel * x;
    sum += texture(t, uv + o) + texture(t, uv - o);
    n += 2.0;
  }
  return sum / n;
}
// 3×3 tent blur (cheap softening, mip-style downsampling for bloom pyramids).
vec4 fx_blur9(sampler2D t, vec2 uv, vec2 texel) {
  vec4 s = texture(t, uv) * 4.0;
  s += (texture(t, uv + vec2(texel.x, 0.0)) + texture(t, uv - vec2(texel.x, 0.0))
     + texture(t, uv + vec2(0.0, texel.y)) + texture(t, uv - vec2(0.0, texel.y))) * 2.0;
  s += texture(t, uv + texel) + texture(t, uv - texel)
     + texture(t, uv + vec2(texel.x, -texel.y)) + texture(t, uv + vec2(-texel.x, texel.y));
  return s / 16.0;
}
// Radial (zoom) blur towards center (uv): amount = fraction of the distance to sample over, samples ≤ 64.
vec4 fx_zoomBlur(sampler2D t, vec2 uv, vec2 center, float amount, int samples) {
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= samples) break;
    float k = float(i) / float(max(1, samples - 1));
    sum += texture(t, mix(uv, center, k * amount));
    n += 1.0;
  }
  return sum / max(n, 1.0);
}
`,
};
