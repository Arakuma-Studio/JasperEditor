// Family-private directional-light helpers of the Sapphire Glows + Lighting family: long thin light streaks
// (glints, streaks) and radial rays, built as two-stage comb filters so long rays stay continuous (no beads) at a
// fixed tap count: stage 1 smears the source over a short span with dense taps; stage 2 (usually inside the final
// pass) samples stage 1 at the span's spacing with an exponential falloff, reaching span × taps.
import type { GlslChunk } from '../shader.ts';

/** Taps per side of the dense first stage (its span = TAPS × the second stage's spacing / TAPS). */
export const STREAK_TAPS = 16;

export const GLSL_SGL_STREAK: GlslChunk = {
	name: 'sgl/streak',
	source: /* glsl */ `
// Stage 1: mean of t over [0, span] (one-sided, dir) or [-span, span] (two-sided), in uv; 16 taps per side.
vec4 sgl_streak1(sampler2D t, vec2 uv, vec2 dirUv, float twoSided) {
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int i = 0; i < 16; i++) {
    float k = (float(i) + 0.5) / 16.0;
    acc += texture(t, uv - dirUv * k);
    n += 1.0;
    if (twoSided > 0.5) { acc += texture(t, uv + dirUv * k); n += 1.0; }
  }
  return acc / n;
}
// Stage 2: exponential-falloff sum of stage-1 texture t along dirUv (= the full ray length in uv), 16 taps per
// side; falloff = how many e-foldings over the ray (≈ 3–6); spectral = 1 tints each tap by its distance (rainbow).
vec3 sgl_spectrumAt(float t);
vec4 sgl_streak2(sampler2D t, vec2 uv, vec2 dirUv, float twoSided, float falloff, float spectral) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float k = (float(i) + 0.5) / 16.0;
    float w = exp(-falloff * k);
    vec4 tint = spectral > 0.5 ? vec4(sgl_spectrumAt(k), 1.0) : vec4(1.0);
    acc += texture(t, uv - dirUv * k) * w * tint;
    if (twoSided > 0.5) acc += texture(t, uv + dirUv * k) * w * tint;
  }
  return acc / 16.0;
}
// Radial (zoom) smear towards centre c (uv): samples between uv and mix(uv, c, len), decaying with distance.
vec4 sgl_radial(sampler2D t, vec2 uv, vec2 c, float len, float decay, int taps) {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= taps) break;
    float k = float(i) / float(taps);
    float w = exp(-decay * k);
    acc += texture(t, mix(uv, c, k * len)) * w;
    ws += w;
  }
  return acc / max(ws, 1.0e-6);
}
vec3 sgl_spectrumAt(float t) {
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(abs(t * 6.0 - 3.0) - 1.0, 2.0 - abs(t * 6.0 - 2.0), 2.0 - abs(t * 6.0 - 4.0)), 0.0, 1.0) * 1.6;
}
`,
};
