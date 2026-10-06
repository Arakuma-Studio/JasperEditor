// Shared pieces of Premiere's "modern" transitions (Premiere 25.5 / 26: the GPU transitions that came from Film
// Impact — Animation, Grunge & Distort, Lights & Blurs, Transformers and the new Dissolve / Slide / Wipe entries).
// Family-private helpers of premiere-transitions.ts.
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { GLSL_MB } from '../../fx/glsl/motion-blur.ts';
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { gaussianBlurPasses } from '../../fx/passes.ts';
import type { GlslChunk, ShaderPass } from '../../fx/shader.ts';
import { TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_EASE, GLSL_TRANSITION } from '../glsl.ts';

/** Premiere 26's transition folders (Animation, Grunge & Distort, Lights & Blurs, Transformers, Immersive Video). */
export const MODERN_BINS = {
	animation: TRANSITION_BINS.animation,
	grungeDistort: TRANSITION_BINS.grungeDistort,
	lightsBlurs: TRANSITION_BINS.lightsBlurs,
	transformers: TRANSITION_BINS.transformers,
	/** Immersive Video (the VR transitions, ./vr.ts). */
	immersive: TRANSITION_BINS.immersive,
} as const;

/** Keywords naming Premiere 26's folder of a modern transition (search finds them by folder name). */
export const FOLDER_KEYWORDS = {
	animation: ['animation', 'motion'],
	grungeDistort: ['grunge', 'distort', 'grunge & distort'],
	lightsBlurs: ['lights', 'blurs', 'lights & blurs', 'light'],
	transformers: ['transformers', '3d'],
} as const;

/**
 * `premiere/modern`: bumps, switches, 2D transforms of a side, directional / zoom / spin blurs and the motion-blur
 * shutter of the moving transitions. A "side" is 0 = A (u_from), 1 = B (u_to). The blurs take the framework's
 * adaptive tap counts (`GLSL_MB`, wave 5): at least their wave-3 count (same taps, so short blurs are unchanged), up
 * to 64 taps ≤ 1 px apart for long ones, jittered per pixel beyond.
 */
export const GLSL_PR_MODERN: GlslChunk = {
	name: 'premiere/modern',
	deps: [GLSL_TRANSITION, GLSL_TR_EASE, GLSL_HASH, GLSL_MB],
	source: /* glsl */ `
const float PM_PI = 3.14159265358979;
// 0 at both ends, 1 in the middle.
float pm_bump(float p) { return sin(PM_PI * clamp(p, 0.0, 1.0)); }
// A sharper bump (an exposure peak at the cut).
float pm_peak(float p, float k) { return pow(pm_bump(p), k); }
// The cross-over from A to B around the middle, w = half width of the blend (0 = a cut).
float pm_switch(float p, float w) { return w <= 0.0 ? step(0.5, p) : smoothstep(0.5 - w, 0.5 + w, p); }
vec4 pm_side(int side, vec2 uv) { return side == 0 ? tr_from(uv) : tr_to(uv); }
// Edge-extended read (no transparency pulled in at the frame edge; transparent when the side is absent).
vec4 pm_sideClamped(int side, vec2 uv) {
  vec2 c = clamp(uv, 0.0, 1.0);
  return side == 0 ? texture(u_from, c) : texture(u_to, c);
}
// Mirrored read (a picture repeated as mirror images beyond its edges).
vec4 pm_sideMirrored(int side, vec2 uv) {
  vec2 m = abs(mod(uv + 1.0, 2.0) - 1.0);
  return side == 0 ? texture(u_from, m) : texture(u_to, m);
}
// Frame uv ↔ "motion axes" of an edge-selector direction (unit, axis-aligned): x along the motion (content moves
// towards +x), y across it.
vec2 pm_toAxes(vec2 uv, vec2 dir) {
  vec2 q = abs(dir.y) > 0.5 ? uv.yx : uv;
  if (dir.x + dir.y < 0.0) q.x = 1.0 - q.x;
  return q;
}
vec2 pm_fromAxes(vec2 q, vec2 dir) {
  if (dir.x + dir.y < 0.0) q.x = 1.0 - q.x;
  return abs(dir.y) > 0.5 ? q.yx : q;
}
// Frame size in motion axes (px).
vec2 pm_axesSize(vec2 dir) { return abs(dir.y) > 0.5 ? u_compSize.yx : u_compSize; }
// Frame uv of the point that a transform (scale s about the centre c, rotation a radians, then translation t, all in
// frame-height units so rotations stay round) brings to uv. Inverse mapping: where to read.
vec2 pm_inverse(vec2 uv, vec2 c, float s, float a, vec2 t) {
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 q = (uv - c) * asp - t;
  float co = cos(a), si = sin(a);
  q = vec2(co * q.x + si * q.y, -si * q.x + co * q.y) / max(s, 1e-4);
  return q / asp + c;
}
// Taps of a blur whose longest path is extentPx: the wave-3 count minN, more (≤ 1 px apart, ≤ 64) when longer.
int pm_taps(float extentPx, int minN) { return max(minN, fx_mbTapCount(extentPx, 64)); }
// A side read along a straight motion blur: taps from uv − delta/2 to uv + delta/2 (uv units).
vec4 pm_streak(int side, vec2 uv, vec2 delta) {
  if (dot(delta, delta) < 1e-10) return pm_side(side, uv);
  float ext = length(delta * u_compSize);
  int n = pm_taps(ext, 16);
  float j = n > 16 ? fx_mbJitterFor(ext, n) : 0.5;
  vec4 s = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    s += pm_side(side, uv + delta * (fx_mbTapAt(i, n, j) - 0.5));
  }
  return s / float(n);
}
// A long straight blur (32+ taps, jittered per pixel against banding).
vec4 pm_streakLong(int side, vec2 uv, vec2 delta) {
  if (dot(delta, delta) < 1e-10) return pm_side(side, uv);
  float ext = length(delta * u_compSize);
  int n = pm_taps(ext, 32);
  float j = n > 32 ? fx_mbJitter() : fx_hash2(ivec2(floor(v_uv * u_compSize)), 0.37);
  vec4 s = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    s += pm_sideClamped(side, uv + delta * ((float(i) + j) / float(n) - 0.5));
  }
  return s / float(n);
}
// Zoom blur of a side towards c: taps from uv to c + (uv − c)(1 − amount).
vec4 pm_zoomBlur(int side, vec2 uv, vec2 c, float amount) {
  if (amount < 1e-4) return pm_side(side, uv);
  float ext = amount * length((uv - c) * u_compSize);
  int n = pm_taps(ext, 16);
  float j = n > 16 ? fx_mbJitterFor(ext, n) : 0.0;
  float last = n > 16 ? float(n) : float(n - 1);
  vec4 s = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    s += pm_side(side, c + (uv - c) * (1.0 - amount * (float(i) + j) / last));
  }
  return s / float(n);
}
// Spin blur of a side around c over ang radians.
vec4 pm_spinBlur(int side, vec2 uv, vec2 c, float ang) {
  if (abs(ang) < 1e-4) return pm_side(side, uv);
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 q = (uv - c) * asp;
  float ext = abs(ang) * length(q) * u_compSize.y;
  int n = pm_taps(ext, 16);
  float j = n > 16 ? fx_mbJitterFor(ext, n) : 0.5;
  vec4 s = vec4(0.0);
  for (int i = 0; i < fx_mbDyn(64); i++) {
    if (i >= n) break;
    float a = ang * (fx_mbTapAt(i, n, j) - 0.5);
    float co = cos(a), si = sin(a);
    s += pm_side(side, vec2(co * q.x - si * q.y, si * q.x + co * q.y) / asp + c);
  }
  return s / float(n);
}
// The motion-blur shutter of the moving transitions: half width (progress) of a shutter of blur% × frames, one frame
// being 1 / max(duration, 2) of progress (the wave-3 scale), shrunk at the ends (exactly A at 0, B at 1).
float pm_shutter(float p, float blurPercent, float frames) {
  return fx_mbShutter(p, (blurPercent / 100.0) * frames, 1.0 / max(u_duration, 2.0));
}
// Screen blend of a light (straight colour) onto a premultiplied picture; light alone where the picture is empty.
vec4 pm_addLight(vec4 base, vec3 light) {
  vec3 l = clamp(light, 0.0, 1.0);
  float m = max(l.r, max(l.g, l.b));
  return vec4(base.rgb + l * (1.0 - base.rgb), base.a + m * (1.0 - base.a));
}
`,
};

/**
 * A variable blur of a picture: three Gaussian levels of `input` (sigma, 2·sigma, 4·sigma canvas px at ½, ¼ and ⅛
 * size) as outputs `<prefix>1..3`; `pm_blurLevels(sharp, b1, b2, b3, amount)` (GLSL, in the returned chunk) reads a
 * blur of 0..1 × 4·sigma by blending them.
 */
export function blurLevelPasses(
	input: string,
	prefix: string,
	sigma: number,
	format?: 'rgba8' | 'rgba16f',
): ShaderPass[] {
	const s = Math.max(0.5, sigma);
	return [
		...gaussianBlurPasses({ input, output: `${prefix}1`, sigma: s, scale: 0.5, format }),
		...gaussianBlurPasses({
			input: `${prefix}1`,
			output: `${prefix}2`,
			sigma: s * Math.sqrt(3),
			scale: 0.25,
			format,
		}),
		...gaussianBlurPasses({
			input: `${prefix}2`,
			output: `${prefix}3`,
			sigma: s * Math.sqrt(12),
			scale: 0.125,
			format,
		}),
	];
}

/** `premiere/noise`: a cheap 4-octave value-noise fbm (0..1) for burns, grunge and leaks. */
export const GLSL_PR_NOISE: GlslChunk = {
	name: 'premiere/noise',
	deps: [GLSL_NOISE],
	source: /* glsl */ `
float pm_fbm(vec2 p, float seed) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) {
    s += a * (0.5 + 0.5 * fx_valueNoise(p, fract(seed + float(k) * 0.1031)));
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s / 0.9375;
}
`,
};

export const GLSL_PR_BLUR_LEVELS: GlslChunk = {
	name: 'premiere/blur-levels',
	source: /* glsl */ `
// amount 0..1: sharp → level 1 → level 2 → level 3 (piecewise linear in thirds).
vec4 pm_blurLevels(vec4 sharp, vec4 b1, vec4 b2, vec4 b3, float amount) {
  float t = clamp(amount, 0.0, 1.0) * 3.0;
  if (t < 1.0) return mix(sharp, b1, t);
  if (t < 2.0) return mix(b1, b2, t - 1.0);
  return mix(b2, b3, t - 2.0);
}
`,
};
