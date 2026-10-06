// Shared helpers of the "sapphire-paint-kaleido-edges" family (private to the family): Sapphire-style units, the
// family's param builders (Seed, Wrap, Sapphire-style numbers) and GLSL chunks (wrap sampling, Sobel gradients,
// posterize, the Sapphire colour-correct block).
//
// Units (normative for this family). Sapphire parameters are resolution independent; the family maps them as:
// - widths, smoothing amounts and sizes: 1 unit = 1 % of the LAYER WIDTH ("Edge Smooth 0.0224" on a 1920 px layer is a
//   0.43 px blur) — `sUnitsPx` / `pke_unit()`; brushes (S_Brush "Max Size") are 2 % of the layer width per unit;
// - frequencies: repeats across the layer width (`Dots Frequency 50` = 50 dots across);
// - pattern shifts (X & Y): fractions of the layer width;
// - Sapphire direction vectors (Light Dir, Direction) are y-UP like in Sapphire (`[-0.5, 0.361]` = light from the
//   upper left); centres are `point` params normalised to the layer box (the framework's on-canvas handle).
import type { ParamSpec } from '../../effects.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import { gaussianBlurPasses } from '../passes.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';

export const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** One Sapphire size unit in layer pixels (1 % of the layer width). */
export const SAPPHIRE_UNIT = 0.01;

/** A Sapphire width/size value in CANVAS pixels for a layer. */
export function sUnitsPx(v: unknown, ctx: Pick<FxPlanContext, 'width' | 'pxScale'>): number {
	return Math.max(0, num(v)) * ctx.width * SAPPHIRE_UNIT * ctx.pxScale;
}

/**
 * Gaussian blur passes of `sigma` canvas px with an automatic resolution: big radii run on a downscaled copy (the
 * result is resampled bilinearly, invisible for smooth blurs). sigma 0 still yields two cheap copy passes.
 */
export function blurPasses(
	input: string,
	output: string,
	sigma: number,
	format?: 'rgba8' | 'rgba16f',
): ShaderPass[] {
	const scale = sigma > 24 ? 0.25 : sigma > 8 ? 0.5 : 1;
	return gaussianBlurPasses({ input, output, sigma, scale, format });
}

/** A Sapphire-style plain number (keyframable). */
export function sNum(
	name: string,
	label: string,
	def: number,
	range: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number },
	extra?: { animatable?: boolean; unit?: ParamSpec['unit'] },
): ParamSpec {
	return fxParam.number(name, label, def, { step: 0.001, ...range }, extra);
}

/** Sapphire "Wrap" popup: No (transparent), Tile, Reflect → int 0, 1, 2 (`pke_wrap`). */
export function wrapParam(
	name = 'wrap',
	label = 'Wrap',
	def: 'none' | 'tile' | 'reflect' = 'reflect',
): ParamSpec {
	return fxParam.choice(name, label, ['none', 'tile', 'reflect'], ['No', 'Tile', 'Reflect'], def);
}

/** Sapphire "Filter" check-box (supersampled resampling). */
export function filterParam(def = true): ParamSpec {
	return fxParam.toggle('filter', 'Filter', def);
}

/** A colour param from an RGB triple (straight, opaque). */
export function rgbParam(name: string, label: string, rgb: [number, number, number]): ParamSpec {
	return fxParam.color(name, label, [rgb[0], rgb[1], rgb[2], 1]);
}

/** A Sapphire X & Y value that is not a position (shifts in layer widths, direction vectors). */
export function xyParam(name: string, label: string, def: [number, number], step = 0.001): ParamSpec {
	return fxParam.vec2(name, label, def, { softMin: -1, softMax: 1, step });
}

// ---------------------------------------------------------------- GLSL

/**
 * Branch-free integer hashes and value noise (same PCG maths as fx/hash). The library's `fx_u` has a sign branch
 * that, inlined dozens of times in the stroke loops, makes SwiftShader's shader compiler stall for minutes; here
 * lattice coordinates are offset by 2^30 instead (exact for |x| < 2^30, far beyond any canvas).
 */
export const PKE_HASH: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/hash',
	source: /* glsl */ `
uint pke_pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint pke_u(int x) { return uint(x + 1073741824); }
float pke_hash2(ivec2 p, float seed) {
  uint h = pke_pcg(pke_u(p.x) ^ pke_pcg(uint(clamp(seed, 0.0, 1.0) * 4294967040.0)));
  h = pke_pcg(h ^ (pke_u(p.y) * 1664525u));
  return float(h >> 8u) * (1.0 / 16777216.0);
}
vec2 pke_hash22(ivec2 p, float seed) { return vec2(pke_hash2(p, seed), pke_hash2(p + ivec2(7919, 104729), seed)); }
// Value noise, −1..1 (quintic fade).
float pke_noise(vec2 p, float seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = pke_hash2(i, seed), b = pke_hash2(i + ivec2(1, 0), seed);
  float c = pke_hash2(i + ivec2(0, 1), seed), d = pke_hash2(i + ivec2(1, 1), seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}
// Cellular (Worley) F1, F2 in cell units, jitter 1.
vec2 pke_cellular(vec2 p, float seed) {
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 o = ivec2(x, y);
      float d = length(vec2(o) + pke_hash22(c + o, seed) - f);
      f2 = min(f2, max(f1, d));
      f1 = min(f1, d);
    }
  return vec2(f1, f2);
}
`,
};

/** Family basics: units, seeds, wrap sampling, frame coordinates. */
export const PKE_COMMON: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/common',
	deps: [GLSL_COLOR, PKE_HASH],
	source: /* glsl */ `
// One Sapphire size unit (1 % of the layer width) in canvas px.
float pke_unit() { return u_box.z * 0.01; }
// Position inside the layer box in canvas px (0,0 = top-left of the box).
vec2 pke_boxPx() { return v_uv * u_canvasSize - u_box.xy; }
vec2 pke_uvOfBoxPx(vec2 p) { return (p + u_box.xy) / u_canvasSize; }
// u_seed (per clip + instance + Seed param) re-randomised every jitter frames (Sapphire "Jitter Frames"; 0 = never).
float pke_seed(float jitter) {
  if (jitter < 0.5) return u_seed;
  return fract(u_seed + pke_hash2(ivec2(int(floor(u_frame / floor(jitter + 0.5))), 0), 0.6180339));
}
// Wrap one layer-normalised coordinate: 0 = none, 1 = tile, 2 = reflect.
float pke_wrap1(float x, int m) {
  if (m == 1) return fract(x);
  if (m == 2) { float t = mod(x, 2.0); return t > 1.0 ? 2.0 - t : t; }
  return x;
}
// Samples the layer picture at layer-normalised n with per-axis wrap modes (outside + "No" = transparent).
vec4 pke_sampleWrap(sampler2D t, vec2 n, ivec2 m) {
  n = vec2(pke_wrap1(n.x, m.x), pke_wrap1(n.y, m.y));
  if (n.x < 0.0 || n.x > 1.0 || n.y < 0.0 || n.y > 1.0) return vec4(0.0);
  n = clamp(n, vec2(0.5) / u_box.zw, vec2(1.0) - vec2(0.5) / u_box.zw);
  return texture(t, fx_uvOfLayerNorm(n));
}
// Layer-normalised ↔ "frame units": centred on c, 1 unit = the layer height, x right, y down.
float pke_aspect() { return u_box.z / u_box.w; }
vec2 pke_toFrame(vec2 n, vec2 c) { return (n - c) * vec2(pke_aspect(), 1.0); }
vec2 pke_fromFrame(vec2 f, vec2 c) { return c + f / vec2(pke_aspect(), 1.0); }
mat2 pke_rot(float deg) { float a = radians(deg); float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
`,
};

/** Sobel gradients (luma and per channel) with a tap distance in uv. Positive x = right, positive y = DOWN. */
export const PKE_SOBEL: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/sobel',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
// Per-channel Sobel of a premultiplied texture (normalised: a 0→1 step gives 1). d = tap distance in uv.
void pke_sobelRgb(sampler2D t, vec2 uv, vec2 d, out vec3 gx, out vec3 gy) {
  vec3 tl = texture(t, uv + vec2(-d.x, -d.y)).rgb, tc = texture(t, uv + vec2(0.0, -d.y)).rgb, tr = texture(t, uv + vec2(d.x, -d.y)).rgb;
  vec3 ml = texture(t, uv + vec2(-d.x, 0.0)).rgb, mr = texture(t, uv + vec2(d.x, 0.0)).rgb;
  vec3 bl = texture(t, uv + vec2(-d.x, d.y)).rgb, bc = texture(t, uv + vec2(0.0, d.y)).rgb, br = texture(t, uv + vec2(d.x, d.y)).rgb;
  gx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) * 0.25;
  gy = ((bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr)) * 0.25;
}
vec2 pke_sobelLuma(sampler2D t, vec2 uv, vec2 d) {
  vec3 gx, gy;
  pke_sobelRgb(t, uv, d, gx, gy);
  return vec2(fx_luma(gx), fx_luma(gy));
}
// Sobel of one channel (r) of a data texture.
vec2 pke_sobelR(sampler2D t, vec2 uv, vec2 d) {
  vec3 gx, gy;
  pke_sobelRgb(t, uv, d, gx, gy);
  return vec2(gx.r, gy.r);
}
`,
};

/** Sapphire posterize + the "Color Correct" block (Saturation, Scale Lights, Offset Darks, Tint Lights/Darks). */
export const PKE_TONE: GlslChunk = {
	name: 'sapphire-paint-kaleido-edges/tone',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
// Smooth staircase: steps of size st (0 = identity); smoothness 0 = hard steps, 1 = identity; phase shifts edges.
float pke_posterize1(float x, float st, float smoothness, float phase) {
  if (st < 1.0e-3) return x;
  float y = x / st + phase;
  float f = floor(y);
  float fr = y - f;
  float w = clamp(smoothness, 0.0, 1.0);
  float ramp = w > 1.0e-4 ? clamp((fr - 0.5) / w + 0.5, 0.0, 1.0) : step(0.5, fr);
  return (f + ramp - phase) * st;
}
vec3 pke_posterizeRgb(vec3 c, float st, float smoothness, vec3 phase) {
  return vec3(pke_posterize1(c.r, st, smoothness, phase.r), pke_posterize1(c.g, st, smoothness, phase.g),
              pke_posterize1(c.b, st, smoothness, phase.b));
}
// Posterizes the luma only (chroma kept: the colour moves by the luma difference).
vec3 pke_posterizeLuma(vec3 c, float st, float smoothness, float phase) {
  float l = fx_luma(c);
  return c + (pke_posterize1(l, st, smoothness, phase) - l);
}
vec3 pke_colorCorrect(vec3 c, float saturation, float scaleLights, float offsetDarks, vec3 tintLights, vec3 tintDarks) {
  c = fx_saturate(c, saturation);
  c *= scaleLights * tintLights;
  vec3 darkness = clamp(1.0 - c, 0.0, 1.0);
  c += (vec3(offsetDarks) + tintDarks) * darkness;
  return c;
}
`,
};
