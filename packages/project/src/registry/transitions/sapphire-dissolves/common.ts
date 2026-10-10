// Family-private helpers of the Sapphire-style dissolves (../sapphire-dissolves.ts): the dissolve timing every
// S_Dissolve* shares (Dissolve Speed, Slow In / Slow Out, Shift Peak, Mix with Dissolve), Sapphire units, Wrap
// popups, and the GLSL the family's shaders share (wrapped side taps, light compositing, separable blurs with
// per-channel widths and Box / Triangle / Gauss kernels, a two-scale glow, bicubic upsampling).
//
// Timing (normative for the family; pure TS so the progress contract is checked without a GPU — `dissolveTiming`):
// - q = Slow In / Slow Out ease of the transition progress (a cubic Hermite with end slopes 1 − Slow In and
//   1 − Slow Out: 0 = linear, 1 = smoothstep-like start / end);
// - t = q re-timed so the PEAK of the transition (Shift Peak, 0 = the middle) lands on t = 0.5;
// - env = the effect envelope (glows, rays, flashes, shakes…): 0 at both ends, 1 at the peak (raised cosine of t);
// - mix = the A → B ratio: a linear ramp of width 1 / Dissolve Speed centred on the peak (Speed 1 = the whole span).
// At progress 0 env = mix = 0 (exactly A), at 1 env = 0 and mix = 1 (exactly B), whatever the parameters.
//
// Sapphire units (as documented by Boris FX, re-expressed in frame terms):
// - positions are Sapphire centred coordinates (x −1…1 over the frame width, y up, same unit); point params are
//   frame-normalised ([0,0] top-left), `sapphirePoint` converts Sapphire defaults (16:9);
// - sizes / lengths / radii: 1.0 = half the frame width (`sd_unit()` px);
// - blur widths (Blur Amount, Smooth Pattern, Threshold Blur…): 1.0 = a Gaussian σ of 3 % of the frame width
//   (the convention of the Sapphire stylize family, `SAPPHIRE_BLUR_UNIT`);
// - glow widths: 1.0 = a wide-component σ of 10 % of the frame width (`SAPPHIRE_GLOW_UNIT`).
import type { RGBA } from '../../../schema/common.ts';
import type { TransitionSpec } from '../../../transitions.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { GLSL_HASH } from '../../fx/glsl/hash.ts';
import { fxParam } from '../../fx/params.ts';
import type { FxUniformValue, GlslChunk, ShaderPass } from '../../fx/shader.ts';
import {
	defineShaderTransition,
	SAPPHIRE_TRANSITION_SUBBINS,
	type ShaderTransitionInit,
	TRANSITION_BINS,
} from '../define.ts';
import { GLSL_TR_EASE } from '../glsl.ts';
import type { TrFrameContext } from '../shader.ts';

export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const rgb = (v: unknown, d: [number, number, number] = [1, 1, 1]): [number, number, number] =>
	Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x))
		? [v[0] as number, v[1] as number, v[2] as number]
		: d;
export const vec2 = (v: unknown, d: [number, number]): [number, number] =>
	Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
		? [Number.isFinite(v[0]) ? v[0] : d[0], Number.isFinite(v[1]) ? v[1] : d[1]]
		: d;

/** σ (fraction of the frame width) of a Sapphire blur width of 1.0. */
export const SAPPHIRE_BLUR_UNIT = 0.03;
/** σ (fraction of the frame width) of the wide component of a Sapphire glow width of 1.0. */
export const SAPPHIRE_GLOW_UNIT = 0.1;

/** Sapphire blur width → Gaussian σ in frame px. */
export const blurPx = (v: unknown, width: number): number => Math.max(0, num(v)) * SAPPHIRE_BLUR_UNIT * width;

/**
 * Sapphire centred coordinates → the framework's frame-normalised point: x −1..1 spans the width (centre 0), y is up
 * in the same unit (half widths). The default conversion assumes a 16:9 frame.
 */
export function sapphirePoint(x: number, y: number, aspect = 16 / 9): [number, number] {
	const r = (v: number) => Math.round(v * 10000) / 10000;
	return [r(0.5 + x / 2), r(0.5 - (y * aspect) / 2)];
}

// ---------------------------------------------------------------- params

/** A plain Sapphire slider (`number`, keyframable). */
export function slider(
	name: string,
	label: string,
	def: number,
	range: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number } = {},
	group?: string,
): ParamSpec {
	return fxParam.number(name, label, def, { step: 0.01, ...range }, group ? { group } : undefined);
}

/** An integer slider. */
export function intSlider(
	name: string,
	label: string,
	def: number,
	min: number,
	max?: number,
	group?: string,
) {
	return slider(name, label, def, { min, ...(max !== undefined ? { max } : {}), step: 1 }, group);
}

/** A Sapphire RGB colour (straight, alpha 1). */
export const color = (name: string, label: string, c: [number, number, number], group?: string): ParamSpec =>
	fxParam.color(name, label, [c[0], c[1], c[2], 1] as RGBA, group ? { group } : undefined);

export const check = (name: string, label: string, def: boolean, group?: string): ParamSpec =>
	fxParam.toggle(name, label, def, group ? { group } : undefined);

/** Puts params into an Effect Controls section. */
export const grp = (group: string, params: ParamSpec[]): ParamSpec[] => params.map((p) => ({ ...p, group }));

/** A Sapphire "Seed" (the framework's numeric `seed` param: mixed into `u_seed`, so shaders use `u_seed`). */
export function seed(label = 'Seed'): ParamSpec {
	return {
		name: 'seed',
		label,
		type: 'number',
		default: 0,
		range: { min: 0, max: 100000, softMax: 1000, step: 1 },
		animatable: false,
	};
}

export const WRAP_OPTIONS = ['no', 'tile', 'reflect'] as const;
export const WRAP_LABELS = ['No', 'Tile', 'Reflect'] as const;
/** Sapphire's "Wrap X & Y" popups (`u_wrapX`, `u_wrapY` ints: 0 No = transparent, 1 Tile, 2 Reflect). */
export function wrapParams(def: (typeof WRAP_OPTIONS)[number] = 'reflect'): ParamSpec[] {
	return [
		fxParam.choice('wrapX', 'Wrap X', WRAP_OPTIONS, WRAP_LABELS, def),
		fxParam.choice('wrapY', 'Wrap Y', WRAP_OPTIONS, WRAP_LABELS, def),
	];
}

export type TimingOptions = {
	/** Dissolve Speed default (omit: no Dissolve Speed param, the mix follows the eased progress). */
	speed?: number;
	/** Slow In / Slow Out defaults (omit: no ease params). */
	slow?: [number, number];
	/** Mix with Dissolve (blend of the result with a plain cross dissolve). Default true. */
	mix?: boolean;
};

const TIMING = 'Dissolve';

/** The family's timing params: Dissolve Speed, Slow In, Slow Out, Shift Peak, Mix with Dissolve (as requested). */
export function timingParams(o: TimingOptions): ParamSpec[] {
	const out: ParamSpec[] = [];
	if (o.speed !== undefined)
		out.push(
			slider('dissolveSpeed', 'Dissolve Speed', o.speed, { min: 1, max: 100, softMax: 20, step: 0.1 }),
		);
	if (o.slow) {
		out.push(slider('slowIn', 'Slow In', o.slow[0], { min: 0, max: 1 }));
		out.push(slider('slowOut', 'Slow Out', o.slow[1], { min: 0, max: 1 }));
	}
	out.push(slider('shiftPeak', 'Shift Peak', 0, { min: -0.45, max: 0.45 }));
	if (o.mix !== false) out.push(slider('mixWithDissolve', 'Mix with Dissolve', 0, { min: 0, max: 1 }));
	return out.map((p) => ({ ...p, group: TIMING }));
}

// ---------------------------------------------------------------- timing maths (pure)

/** Slow In / Slow Out: cubic Hermite from 0 to 1 with end slopes 1 − slowIn and 1 − slowOut (monotone). */
export function slowCurve(p: number, slowIn: number, slowOut: number): number {
	const t = clamp(p, 0, 1);
	const m0 = 1 - clamp(slowIn, 0, 1);
	const m1 = 1 - clamp(slowOut, 0, 1);
	const t2 = t * t;
	const t3 = t2 * t;
	return clamp((t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) + (t3 - t2) * m1, 0, 1);
}

/** Re-times q so the peak (0.5 + Shift Peak) lands on 0.5 (piecewise linear, 0 → 0 and 1 → 1). */
export function peakTime(q: number, shiftPeak: number): number {
	const c = clamp(0.5 + shiftPeak, 0.05, 0.95);
	const x = clamp(q, 0, 1);
	return x <= c ? (0.5 * x) / c : 0.5 + (0.5 * (x - c)) / (1 - c);
}

/** The effect envelope: 0 at t = 0 and 1, 1 at the peak t = 0.5 (raised cosine). */
export const envelope = (t: number): number => 0.5 - 0.5 * Math.cos(2 * Math.PI * clamp(t, 0, 1));

/** The A → B ratio: a ramp of width 1 / speed centred on the peak (speed ≤ 1: the whole span, = t). */
export const dissolveMix = (t: number, speed: number): number =>
	clamp((clamp(t, 0, 1) - 0.5) * Math.max(1, speed) + 0.5, 0, 1);

export type DissolveTiming = { q: number; t: number; env: number; mix: number };

/** Every timing value of the family at transition progress `progress` (see the header). */
export function dissolveTiming(p: EffectParams, progress: number): DissolveTiming {
	const q = slowCurve(progress, num(p.slowIn, 0), num(p.slowOut, 0));
	const t = peakTime(q, num(p.shiftPeak, 0));
	const env = envelope(t);
	const mix = dissolveMix(t, num(p.dissolveSpeed, 1));
	return { q, t, env, mix };
}

/** The timing uniforms: `u_sdT` (re-timed eased progress), `u_sdEnv`, `u_sdMix`. */
export function timingUniforms(p: EffectParams, ctx: Pick<TrFrameContext, 'progress'>) {
	const d = dissolveTiming(p, ctx.progress);
	return { u_sdT: d.t, u_sdEnv: d.env, u_sdMix: d.mix } satisfies Record<string, FxUniformValue>;
}

// ---------------------------------------------------------------- GLSL

/** Sapphire coordinates, wrapped side taps, light compositing (`sd_*`). */
export const GLSL_SD: GlslChunk = {
	name: 'sapphire-dissolves/common',
	deps: [GLSL_TR_EASE, GLSL_COLOR],
	source: /* glsl */ `
// Sapphire's size unit: half the frame width, in px.
float sd_unit() { return 0.5 * u_compSize.x; }
// Wrap one coordinate: 0 No (unchanged: outside stays outside), 1 Tile, 2 Reflect.
float sd_wrap1(float x, int m) {
  if (m == 1) return fract(x);
  if (m == 2) return 1.0 - abs(1.0 - mod(x, 2.0));
  return x;
}
vec2 sd_wrapUv(vec2 uv, ivec2 wrap) { return vec2(sd_wrap1(uv.x, wrap.x), sd_wrap1(uv.y, wrap.y)); }
// A side at uv with Sapphire's Wrap modes (No = transparent beyond the frame).
vec4 sd_fromW(vec2 uv, ivec2 wrap) { return tr_from(sd_wrapUv(uv, wrap)); }
vec4 sd_toW(vec2 uv, ivec2 wrap) { return tr_to(sd_wrapUv(uv, wrap)); }
// The plain cross dissolve at this pixel (u_sdMix).
vec4 sd_dissolve() { return mix(tr_from(v_uv), tr_to(v_uv), u_sdMix); }
float sd_maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
// Light added to / screened over a premultiplied picture; Affect Alpha lets the light make transparent areas opaque.
vec4 sd_lightOver(vec4 base, vec3 light, float affectAlpha, bool screen) {
  light = max(light, vec3(0.0));
  float a = clamp(max(base.a, sd_maxc(light) * affectAlpha), 0.0, 1.0);
  vec3 rgb = screen ? base.rgb + min(light, vec3(1.0)) * (1.0 - min(base.rgb, vec3(1.0))) : base.rgb + light;
  return vec4(min(rgb, vec3(a)), a);
}
// Soft threshold of a straight colour: the part brighter than thr (per channel, keeps the colour), 0 below.
vec3 sd_threshold(vec3 c, float thr) {
  float l = max(fx_luma(c), sd_maxc(c) * 0.5);
  float k = smoothstep(thr, thr + 0.1 + 0.2 * thr, l);
  return c * k * clamp((l - thr) / max(1.0 - thr, 0.05) + 0.25, 0.0, 1.0);
}
// Cubic B-spline sample from 4 bilinear taps (smooth upsampling of small blurred textures).
vec4 sd_bicubic(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  vec2 i = floor(p);
  vec2 w0 = (1.0 / 6.0) * (1.0 - f) * (1.0 - f) * (1.0 - f);
  vec2 w1 = (1.0 / 6.0) * (3.0 * f * f * f - 6.0 * f * f + 4.0);
  vec2 w2 = (1.0 / 6.0) * (-3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0);
  vec2 w3 = (1.0 / 6.0) * f * f * f;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size, h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * texture(t, vec2(h0.x, h0.y)) + g1.x * texture(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, vec2(h1.x, h1.y)));
}
`,
};

/** Separable 1D blur with per-channel σ and a kernel shape (`sd_blur1`). */
export const GLSL_SD_BLUR: GlslChunk = {
	name: 'sapphire-dissolves/blur',
	source: /* glsl */ `
// Kernel weight at distance x (texels) for σ s: 0 Box (half width s·√3), 1 Triangle (s·√6), 2 Gauss.
float sd_kw(float x, float s, int kernel) {
  if (s < 1e-3) return x < 0.5 ? 1.0 : 0.0;
  if (kernel == 0) return clamp(s * 1.7320508 - x + 0.5, 0.0, 1.0);
  if (kernel == 1) return max(0.0, 1.0 - x / (s * 2.4494897));
  return exp(-0.5 * x * x / (s * s));
}
// 1D blur of t along step (one texel along the direction) with σ per channel (texels; alpha follows green).
// Up to 48 taps per side; wider kernels spread their taps (blur at a lower resolution instead).
vec4 sd_blur1(sampler2D t, vec2 uv, vec2 stepUv, vec3 sigma, int kernel) {
  float smax = max(sigma.r, max(sigma.g, sigma.b));
  if (smax < 0.05) return texture(t, uv);
  float radius = ceil(smax * (kernel == 2 ? 3.0 : kernel == 1 ? 2.45 : 1.74) + 0.5);
  float stride = max(1.0, radius / 48.0);
  vec4 c0 = texture(t, uv);
  vec4 sum = c0;
  vec4 wsum = vec4(1.0);
  for (int i = 1; i <= 48; i++) {
    float x = float(i) * stride;
    if (x > radius) break;
    vec3 w = vec3(sd_kw(x, sigma.r, kernel), sd_kw(x, sigma.g, kernel), sd_kw(x, sigma.b, kernel));
    vec4 w4 = vec4(w, w.g);
    vec4 s = texture(t, uv + stepUv * x) + texture(t, uv - stepUv * x);
    sum += s * w4;
    wsum += 2.0 * w4;
  }
  return sum / wsum;
}
`,
};

export type BlurPassOptions = {
	/** Input texture name (a pass output, `from`, `to`). */
	input: string;
	/** Output name; the horizontal pass writes `<output>H`. */
	output: string;
	/** Resolution of both passes relative to the frame (0, 1]. */
	scale: number;
	/** GLSL vec2 expression: σ in FRAME px (x, y) — usually a `gpu.uniforms` value, so it can change per frame. */
	sigma: string;
	/** GLSL vec3 expression: per-channel σ multipliers (default vec3(1.0)). */
	rgb?: string;
	/** GLSL int expression: 0 Box, 1 Triangle, 2 Gauss (default 2). */
	kernel?: string;
	format?: 'rgba8' | 'rgba16f';
};

/**
 * Two passes (horizontal, then vertical) blurring `input` with a σ given per frame by a uniform expression (unlike
 * `gaussianBlurPasses`, whose σ is baked at plan time): the σ of dissolves ramps with the progress.
 */
export function blurPasses(o: BlurPassOptions): ShaderPass[] {
	// σ is converted to texels of the texture read. The horizontal pass reads a (usually bigger) input: it also
	// averages the rows the output pixel covers, so a downscaled blur does not alias vertically.
	const pass = (inputTex: string, dir: 'x' | 'y'): string => /* glsl */ `
void main() {
  vec2 isz = vec2(textureSize(${inputTex}, 0));
  vec2 sg = (${o.sigma}) * isz / u_compSize;
  vec2 texel = 1.0 / isz;
  vec3 s3 = sg.${dir} * (${o.rgb ?? 'vec3(1.0)'});
  ${dir === 'x' ? 's3 = max(s3, vec3(0.45 * (isz.x / u_resolution.x - 1.0)));' : ''}
  vec2 stp = vec2(${dir === 'x' ? 'texel.x, 0.0' : '0.0, texel.y'});
  int n = ${dir === 'x' ? 'int(clamp(ceil(isz.y / u_resolution.y - 0.01), 1.0, 8.0))' : '1'};
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= n) break;
    float oy = ((float(j) + 0.5) / float(n) - 0.5) / u_resolution.y;
    acc += sd_blur1(${inputTex}, v_uv + vec2(0.0, oy), stp, s3, ${o.kernel ?? '2'});
  }
  fragColor = acc / float(n);
}`;
	return [
		{
			output: `${o.output}H`,
			scale: o.scale,
			format: o.format,
			include: [GLSL_SD_BLUR],
			frag: pass(`u_${o.input}`, 'x'),
		},
		{
			output: o.output,
			scale: o.scale,
			format: o.format,
			include: [GLSL_SD_BLUR],
			frag: pass(`u_${o.output}H`, 'y'),
		},
	];
}

/**
 * A Sapphire-style glow of the light picture `input`: a near component (σ/5 at half resolution) and a wide one
 * (σ at quarter resolution), outputs `<prefix>Near` and `<prefix>Far` (4 passes, rgba16f: dim tails do not band).
 * `sigma` (vec2, frame px of the wide component) and `rgb` (per-channel width multipliers) are GLSL expressions.
 * Read them with `sd_glow(u_<prefix>Near, u_<prefix>Far, falloff)`.
 */
export function glowPasses(o: { input: string; prefix: string; sigma: string; rgb?: string }): ShaderPass[] {
	return [
		...blurPasses({
			input: o.input,
			output: `${o.prefix}Near`,
			scale: 0.5,
			sigma: `(${o.sigma}) * 0.2`,
			rgb: o.rgb,
			format: 'rgba16f',
		}),
		...blurPasses({
			input: o.input,
			output: `${o.prefix}Far`,
			scale: 0.25,
			sigma: o.sigma,
			rgb: o.rgb,
			format: 'rgba16f',
		}),
	];
}

/**
 * Cheap seeded value noise and fractal sums with a DYNAMIC octave loop (`sd_*`). SwiftShader (the software GL of
 * renders and tests) compiles every inlined copy of an unrolled noise loop, so the family avoids the library's
 * constant-bound 12-octave loops in big shaders: one call site, a uniform-driven loop, 4 / 8 hashes per octave.
 */
export const GLSL_SD_NOISE: GlslChunk = {
	name: 'sapphire-dissolves/noise',
	deps: [GLSL_HASH],
	source: /* glsl */ `
// Branch-free lattice hashes (one PCG round; |coordinates| < 2^30): the library's sign-branching int → uint
// conversion, inlined dozens of times, makes SwiftShader's compiler crawl.
uint sd_seedU(float seed) { return fx_pcg(uint(clamp(seed, 0.0, 1.0) * 4294967040.0)); }
float sd_h3(ivec3 p, uint s) {
  uint h = fx_pcg((uint(p.x + 1073741824) * 73856093u) ^ (uint(p.y + 1073741824) * 19349663u) ^ (uint(p.z + 1073741824) * 83492791u) ^ s);
  return float(h >> 8u) * (1.0 / 16777216.0);
}
float sd_h2(ivec2 p, uint s) { return sd_h3(ivec3(p, 0), s); }
float sd_vnoise(vec2 p, float seed) {
  uint s = sd_seedU(seed);
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = sd_h2(i, s), b = sd_h2(i + ivec2(1, 0), s);
  float c = sd_h2(i + ivec2(0, 1), s), d = sd_h2(i + ivec2(1, 1), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}
float sd_vnoise3(vec3 p, float seed) {
  uint s = sd_seedU(seed);
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n0 = mix(mix(sd_h3(i, s), sd_h3(i + ivec3(1, 0, 0), s), f.x),
                 mix(sd_h3(i + ivec3(0, 1, 0), s), sd_h3(i + ivec3(1, 1, 0), s), f.x), f.y);
  float n1 = mix(mix(sd_h3(i + ivec3(0, 0, 1), s), sd_h3(i + ivec3(1, 0, 1), s), f.x),
                 mix(sd_h3(i + ivec3(0, 1, 1), s), sd_h3(i + ivec3(1, 1, 1), s), f.x), f.y);
  return mix(n0, n1, f.z) * 2.0 - 1.0;
}
// Fractal sums (≈ −1..1), octaves ≥ 1 (dynamic loop: not unrolled).
float sd_fbm(vec2 p, int octaves, float gain, float seed) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < octaves; k++) {
    sum += amp * sd_vnoise(p, fract(seed + float(k) * 0.1031));
    norm += amp;
    p = p * 2.03 + vec2(17.1, 3.7);
    amp *= gain;
  }
  return sum / max(norm, 1e-4);
}
float sd_fbm3(vec3 p, int octaves, float gain, float seed) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < octaves; k++) {
    sum += amp * sd_vnoise3(p, fract(seed + float(k) * 0.1031));
    norm += amp;
    p = p * 2.03 + vec3(17.1, 3.7, 9.3);
    amp *= gain;
  }
  return sum / max(norm, 1e-4);
}
`,
};

/** Combines a near and a far glow texture (falloff −1…1: more near … more far). */
export const GLSL_SD_GLOW: GlslChunk = {
	name: 'sapphire-dissolves/glow',
	deps: [GLSL_SD],
	source: /* glsl */ `
vec3 sd_glow(sampler2D nearT, sampler2D farT, float falloff) {
  float wf = clamp(0.5 + 0.5 * falloff, 0.0, 1.0);
  return mix(sd_bicubic(nearT, v_uv).rgb, sd_bicubic(farT, v_uv).rgb, wf) * 2.0;
}
`,
};

// ---------------------------------------------------------------- spec builder

export type DissolveInit = Omit<ShaderTransitionInit, 'bin' | 'subBin'> & {
	/** The timing params this dissolve has (false: none — the timing uniforms still follow the plain progress). */
	timing: TimingOptions | false;
};

/**
 * A Sapphire Transitions ▸ Dissolves entry: the timing params first (Dissolve group), then the dissolve's own params;
 * `gpu.uniforms` always provides the timing uniforms (`u_sdT`, `u_sdEnv`, `u_sdMix`) before the entry's own.
 */
export function defineDissolve(init: DissolveInit): TransitionSpec {
	const { timing, gpu, params, ...rest } = init;
	const own = gpu.uniforms;
	return defineShaderTransition({
		...rest,
		bin: TRANSITION_BINS.sapphire,
		subBin: SAPPHIRE_TRANSITION_SUBBINS.dissolves,
		params: [...(timing ? timingParams(timing) : []), ...(params ?? [])],
		gpu: {
			...gpu,
			uniforms: (p, ctx) => ({ ...timingUniforms(p, ctx), ...(own?.(p, ctx) ?? {}) }),
		},
	});
}
