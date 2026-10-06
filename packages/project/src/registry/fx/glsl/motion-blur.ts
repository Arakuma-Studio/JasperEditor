// Shared GLSL of the adaptive shutter motion blur (wave 5, docs/wp-notes/fx-shader-framework.md §19). Two chunks:
//
// - `GLSL_MB` (fx/mb): building blocks every moving effect or transition can use without any uniform of its own —
//   the tap count of an on-screen smear (`fx_mbTapCount`: ≤ FX_MB_SPACING px apart, capped), the deterministic
//   per-pixel stratified jitter (`fx_mbJitter`: an R2 low-discrepancy lattice over the pass pixels + `u_seed`, a
//   blue-noise-like pattern that is the same on every render and independent of the frame), the tap times
//   (`fx_mbTapAt`), the opaque loop bound (`fx_mbDyn`) that keeps SwiftShader from unrolling the tap loops, and the
//   progress-space shutter of transitions (`fx_mbShutter`).
// - `GLSL_MB_POSES` (fx/mb-poses): reads the shutter planned in TypeScript by `planMotionBlur` (../motion-blur.ts):
//   `u_mbPlan` (taps, keys, stride, flags), `u_mbKeys` (the key poses at exact sub-frame times, linearly
//   interpolated here) and `u_mbWarp` (the time warp that spreads the taps over both time and path length).
//   Spread `mbUniforms(plan)` into `gpu.uniforms` to declare them.
import type { GlslChunk } from '../shader.ts';
import { GLSL_HASH } from './hash.ts';

/** Most taps per pixel of the default ("Auto") quality. */
export const FX_MB_MAX_TAPS = 64;
/** Most taps per pixel of any quality (the loop bound of the shaders). */
export const FX_MB_TAP_LIMIT = 96;
/** Default distance between taps along the smear (pass px). 1 px = a partition of unity for bilinear taps. */
export const FX_MB_SPACING = 1;
/** Entries of the time-warp table `u_mbWarp` (8 vec4). */
export const FX_MB_WARP_SIZE = 32;

export const GLSL_MB: GlslChunk = {
	name: 'fx/mb',
	deps: [GLSL_HASH],
	source: /* glsl */ `
const int FX_MB_TAP_LIMIT = ${FX_MB_TAP_LIMIT};
const float FX_MB_SPACING = ${FX_MB_SPACING.toFixed(1)};
// An opaque copy of n (the compiler cannot prove it constant, so loops bounded by it are not unrolled: SwiftShader
// compile time stays flat however many taps a loop may take).
int fx_mbDyn(int n) { return n + int(min(0.0, u_resolution.x)); }
// Taps for an on-screen smear of extentPx pass pixels: at most FX_MB_SPACING px apart, 1..maxN.
int fx_mbTapCount(float extentPx, int maxN) {
  return int(clamp(ceil(max(extentPx, 0.0) / FX_MB_SPACING), 1.0, float(clamp(maxN, 1, FX_MB_TAP_LIMIT))));
}
// Per-pixel stratified jitter 0..1: the R2 sequence (plastic-number lattice) over the pass pixels, offset by u_seed.
// Neighbouring pixels get far-apart offsets (blue-noise-like grain instead of banding); integer maths, so every GPU
// and SwiftShader agree, and it does not change with the frame (renders are reproducible in any frame order).
float fx_mbJitter() {
  uvec2 q = uvec2(max(floor(v_uv * u_resolution), vec2(0.0)));
  uint h = q.x * 3242174889u + q.y * 2447445414u + fx_pcg(fx_seedBits(u_seed) ^ 0x5bd1e995u);
  return float(h >> 8u) * (1.0 / 16777216.0);
}
// Normalised time 0..1 of tap i of n, stratified with the pixel's jitter j (0.5 = centred in its stratum).
float fx_mbTapAt(int i, int n, float j) { return (float(i) + j) / float(n); }
// The jitter to use for n taps over extentPx: centred strata while the taps are dense enough, else fx_mbJitter().
float fx_mbJitterFor(float extentPx, int n) { return extentPx / float(n) > FX_MB_SPACING * 1.01 ? fx_mbJitter() : 0.5; }
// Transitions: half width (progress units) of a shutter of 'frames' frames at 'step' progress per frame around p,
// shrunk at the ends so that progress 0 and 1 sample only themselves (exactly A, exactly B).
float fx_mbShutter(float p, float frames, float step) {
  return max(0.0, min(0.5 * max(frames, 0.0) * step, min(p, 1.0 - p)));
}
`,
};

export const GLSL_MB_POSES: GlslChunk = {
	name: 'fx/mb-poses',
	deps: [GLSL_MB],
	source: /* glsl */ `
// The planned shutter (planMotionBlur): u_mbPlan = (taps, keys, vec4s per pose, flags: 1 jitter, 2 time warp).
int fx_mbTaps() { return max(u_mbPlan.x, 1); }
bool fx_mbOn() { return u_mbPlan.x > 1; }
float fx_mbPlanJitter() { return (u_mbPlan.w & 1) != 0 ? fx_mbJitter() : 0.5; }
// Shutter time s (0..1 over the interval) and box-shutter weight of tap i of n: through the time warp, which places
// taps by time AND path length (fast bursts inside the shutter stay continuous); the weight (ds/da) brings the
// exposure back to the time a pose was held.
vec2 fx_mbTap(int i, int n, float j) {
  float a = fx_mbTapAt(i, n, j);
  if ((u_mbPlan.w & 2) == 0) return vec2(a, 1.0);
  float x = clamp(a, 0.0, 1.0) * ${(FX_MB_WARP_SIZE - 1).toFixed(1)};
  int m = min(int(x), ${FX_MB_WARP_SIZE - 2});
  float t0 = u_mbWarp[m >> 2][m & 3];
  int m1 = m + 1;
  float t1 = u_mbWarp[m1 >> 2][m1 & 3];
  return vec2(mix(t0, t1, x - float(m)), max(t1 - t0, 0.0) * ${(FX_MB_WARP_SIZE - 1).toFixed(1)});
}
// Part 'part' (0 .. stride−1) of the pose at shutter time s: linear between the key poses at exact sub-frame times
// (32 keys = 31 segments per shutter: well under a pixel from curved / rotating paths, and half the cost of a spline
// in software GL).
vec4 fx_mbPose(int part, float s) {
  int K = max(u_mbPlan.y, 2);
  int S = max(u_mbPlan.z, 1);
  float u = clamp(s, 0.0, 1.0) * float(K - 1);
  int k = min(int(u), K - 2);
  return mix(u_mbKeys[k * S + part], u_mbKeys[(k + 1) * S + part], u - float(k));
}
`,
};
