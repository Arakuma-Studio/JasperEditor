// Shared pieces of Premiere's "modern" transitions (Premiere 25.5 / 26: the GPU transitions that came from Film
// Impact — Animation, Grunge & Distort, Lights & Blurs, Transformers and the new Dissolve / Slide / Wipe entries).
// Family-private helpers of premiere-transitions.ts.
import { GLSL_NOISE } from '../../fx/glsl/noise.ts';
import { gaussianBlurPasses } from '../../fx/passes.ts';
import type { GlslChunk, ShaderPass } from '../../fx/shader.ts';
import { TRANSITION_BINS } from '../define.ts';
import { GLSL_TRANSITION, GLSL_TR_EASE } from '../glsl.ts';

/**
 * Premiere 26's transition folders. Animation, Grunge & Distort, Lights & Blurs and Transformers have no
 * `TRANSITION_BINS` entry yet (the framework's list), so they sit in the nearest existing folder until it gets them:
 * Animation → Slide (moves), Grunge & Distort → Dissolve, Lights & Blurs → Zoom (Premiere 26 moved Cross Zoom
 * there), Transformers → 3D Motion. Change these four lines when the bins exist.
 */
export const MODERN_BINS = {
	animation: TRANSITION_BINS.slide,
	grungeDistort: TRANSITION_BINS.dissolve,
	lightsBlurs: TRANSITION_BINS.zoom,
	transformers: TRANSITION_BINS.motion3d,
} as const;

/** Keywords naming Premiere 26's folder of a modern transition (search finds them by folder name). */
export const FOLDER_KEYWORDS = {
	animation: ['animation', 'motion'],
	grungeDistort: ['grunge', 'distort', 'grunge & distort'],
	lightsBlurs: ['lights', 'blurs', 'lights & blurs', 'light'],
	transformers: ['transformers', '3d'],
} as const;

/**
 * `premiere/modern`: bumps, switches, 2D transforms of a side and directional blurs. A "side" is 0 = A (u_from),
 * 1 = B (u_to).
 */
export const GLSL_PR_MODERN: GlslChunk = {
	name: 'premiere/modern',
	deps: [GLSL_TRANSITION, GLSL_TR_EASE],
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
// A side read along a straight motion blur: taps from uv − delta/2 to uv + delta/2 (uv units).
vec4 pm_streak(int side, vec2 uv, vec2 delta) {
  if (dot(delta, delta) < 1e-10) return pm_side(side, uv);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 16; i++) s += pm_side(side, uv + delta * ((float(i) + 0.5) / 16.0 - 0.5));
  return s / 16.0;
}
// Zoom blur of a side towards c: taps from uv to c + (uv − c)(1 − amount).
vec4 pm_zoomBlur(int side, vec2 uv, vec2 c, float amount) {
  if (amount < 1e-4) return pm_side(side, uv);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 16; i++) s += pm_side(side, c + (uv - c) * (1.0 - amount * float(i) / 15.0));
  return s / 16.0;
}
// Spin blur of a side around c over ang radians.
vec4 pm_spinBlur(int side, vec2 uv, vec2 c, float ang) {
  if (abs(ang) < 1e-4) return pm_side(side, uv);
  vec2 asp = vec2(tr_aspect(), 1.0);
  vec2 q = (uv - c) * asp;
  vec4 s = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float a = ang * ((float(i) + 0.5) / 16.0 - 0.5);
    float co = cos(a), si = sin(a);
    s += pm_side(side, vec2(co * q.x - si * q.y, si * q.x + co * q.y) / asp + c);
  }
  return s / 16.0;
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
export function blurLevelPasses(input: string, prefix: string, sigma: number): ShaderPass[] {
	const s = Math.max(0.5, sigma);
	return [
		...gaussianBlurPasses({ input, output: `${prefix}1`, sigma: s, scale: 0.5 }),
		...gaussianBlurPasses({ input: `${prefix}1`, output: `${prefix}2`, sigma: s * Math.sqrt(3), scale: 0.25 }),
		...gaussianBlurPasses({ input: `${prefix}2`, output: `${prefix}3`, sigma: s * Math.sqrt(12), scale: 0.125 }),
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
    s += a * fx_valueNoise(p, fract(seed + float(k) * 0.1031));
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
