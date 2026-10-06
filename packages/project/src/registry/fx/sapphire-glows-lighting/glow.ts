// Family-private helpers of the Sapphire Glows + Lighting family (fx catalogue, wave 2): the multi-scale glow
// cascade every glow uses, directional/radial light passes, and the shared GLSL chunk `sgl/core`.
//
// The glow cascade. A Sapphire-style glow is not one Gaussian: its long, soft tail comes from summing blurs of
// growing width. `glowCascade` blurs a source texture into `levels` levels whose widths double (the widest = the
// glow width), each level blurring the previous one (variances add, so each pass only adds the missing width) at a
// resolution matched to its width (1/1 … 1/32 of the canvas): wide glows cost about as much as narrow ones and 1080p
// previews stay interactive. Width X / Width Y stretch the kernel per axis. Levels are rgba16f (light > 1 survives).
// The final pass sums the levels with `glowSumGlsl` weights (falloff), see `glowWeights`.
import type { GlslChunk, ShaderPass } from '../shader.ts';

export const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pow2floor = (x: number) => 2 ** Math.floor(Math.log2(Math.max(1, x)));

/** Downscale factor (power of two, 1…32) of a blur level whose total sigma is (sx, sy) canvas px. */
export function levelDownscale(sx: number, sy: number): number {
	const hi = Math.max(sx, sy);
	const lo = Math.min(sx, sy);
	// ≈ 6 level px of sigma along the long axis; never so coarse that the short axis turns blocky, unless the
	// kernel is so elongated that the long axis would need more than ~40 taps per side.
	let d = pow2floor(clamp(hi / 6, 1, 32));
	if (lo * 1.5 < d) d = Math.max(pow2floor(Math.max(1, lo * 1.5)), pow2floor(clamp(hi / 40, 1, 32)));
	return d;
}

/**
 * One separable blur pass (direction `axis`) of the previous pass (`u_prev`, downscale dIn) to an output at
 * downscale dOut. Reading `u_prev` keeps the source identical for every cascade pass: one GL program for all.
 */
function blurPass(
	output: string,
	axis: 0 | 1,
	sigma: number,
	dIn: number,
	dOut: number,
): ShaderPass {
	const sIn = sigma / dIn; // sigma in input texels
	const stepTexels = Math.max(1, (3 * sIn) / 48);
	const ratio = dOut / dIn;
	// Box prefilter across the pass direction when the output is coarser than the input (anti-aliasing), and a
	// minimum Gaussian along it (half an output texel).
	const pn = ratio > 1 ? Math.min(4, Math.ceil(ratio)) : 1;
	const sig = Math.max(sIn, ratio > 1 ? ratio * 0.5 : 0);
	const n = sig < 0.05 ? 0 : Math.min(48, Math.ceil((3 * sig) / stepTexels));
	const dir: [number, number] = axis === 0 ? [1, 0] : [0, 1];
	return {
		output,
		scale: 1 / dOut,
		format: 'rgba16f',
		include: [GLSL_SGL_CORE],
		uniforms: {
			u_bDir: dir,
			u_bStep: stepTexels,
			u_bSig: Math.max(sig / stepTexels, 1e-3),
			u_bN: { int: n },
			u_bPerp: ratio,
			u_bPn: { int: pn },
		},
		frag: /* glsl */ `
void main() {
  vec2 tx = 1.0 / vec2(textureSize(u_prev, 0));
  fragColor = sgl_blurAxis(u_prev, v_uv, u_bDir * tx * u_bStep, u_bSig, u_bN, u_bDir.yx * tx * u_bPerp, u_bPn);
}`,
	};
}

export type GlowCascade = { passes: ShaderPass[]; levels: string[] };

/**
 * Blur `input` (the output of the pass right before the cascade, or `source` when it is first) into `levels` (≤ 5) levels named `<prefix>0…`: level k has sigma
 * (sx, sy) · 2^(k − levels + 1) (canvas px), so the last level has the full sigma. `inputDown` = downscale of the
 * input texture (its pass scale = 1/inputDown).
 */
export function glowCascade(opts: {
	input: string;
	prefix: string;
	sigmaX: number;
	sigmaY: number;
	levels: number;
	inputDown?: number;
}): GlowCascade {
	const L = clamp(Math.round(opts.levels), 1, 5);
	const sx = Math.max(0, opts.sigmaX);
	const sy = Math.max(0, opts.sigmaY);
	const passes: ShaderPass[] = [];
	const levels: string[] = [];
	let prevX = 0;
	let prevY = 0;
	let dPrev = opts.inputDown ?? 1;
	for (let k = 0; k < L; k++) {
		const f = 2 ** (k - L + 1);
		const tx = sx * f;
		const ty = sy * f;
		const ix = Math.sqrt(Math.max(0, tx * tx - prevX * prevX));
		const iy = Math.sqrt(Math.max(0, ty * ty - prevY * prevY));
		const d = Math.max(levelDownscale(tx, ty), k === 0 ? 1 : dPrev);
		const name = `${opts.prefix}${k}`;
		passes.push(blurPass(`${name}h`, 0, ix, dPrev, d));
		passes.push(blurPass(name, 1, iy, d, d));
		levels.push(name);
		prevX = tx;
		prevY = ty;
		dPrev = d;
	}
	return { passes, levels };
}

/**
 * Weights of the cascade levels for one channel. The glow profile is a continuous function of the level (octave)
 * index x: 2^(slope·x), windowed to the levels that exist; `shift` (≤ 0, octaves) moves a narrower channel's
 * profile down (Width Red/Green/Blue below the widest). Normalised (Σ = 1: the light's energy does not change with
 * the width). slope 0 = every octave the same energy (a long soft tail); > 0 favours the wide levels; < 0 the core.
 */
export function levelWeights(levels: number, slope: number, shift = 0): number[] {
	const L = clamp(Math.round(levels), 1, 5);
	const w = Array.from({ length: L }, (_, k) => {
		const x = k - shift; // where level k sits on the channel's own profile (its top = L − 1)
		const window = clamp(L - x, 0, 1) * clamp(x + 1, 0, 1);
		return 2 ** (slope * (x - (L - 1))) * window;
	});
	const s = w.reduce((a, b) => a + b, 0) || 1;
	return w.map((x) => x / s);
}

export type ChannelWeights = {
	u_wr: { floats: number[] };
	u_wg: { floats: number[] };
	u_wb: { floats: number[] };
};

/**
 * Per-channel level weights (`u_wr`, `u_wg`, `u_wb` float arrays) for channel width multipliers `mult` (Sapphire
 * Width Red/Green/Blue): the cascade is built for the widest channel; the others shift their profile down.
 */
export function channelWeights(
	levels: number,
	slope: number,
	mult: readonly [number, number, number],
	gain = 1,
): ChannelWeights {
	const m = mult.map((x) => Math.max(1e-3, x));
	const top = Math.max(...m);
	const [r, g, b] = m.map((x) => levelWeights(levels, slope, Math.log2(x / top)).map((w) => w * gain));
	return { u_wr: { floats: r! }, u_wg: { floats: g! }, u_wb: { floats: b! } };
}

/** GLSL `vec3 <fn>(vec2 uv)` = Σ_k texture(u_<level k>, uv).rgb · (u_wr[k], u_wg[k], u_wb[k]). */
export function glowSumGlsl(fn: string, levels: readonly string[]): string {
	const terms = levels.map((l, k) => `texture(u_${l}, uv).rgb * vec3(u_wr[${k}], u_wg[${k}], u_wb[${k}])`);
	return `vec3 ${fn}(vec2 uv) { return ${terms.join(' + ')}; }\n`;
}

/** GLSL `vec4 <fn>(vec2 uv)` = Σ_k u_<w>[k] · texture(u_<level k>, uv) (one weight list for RGBA). */
export function levelSumGlsl(fn: string, levels: readonly string[], w: string): string {
	const terms = levels.map((l, k) => `texture(u_${l}, uv) * ${w}[${k}]`);
	return `vec4 ${fn}(vec2 uv) { return ${terms.join(' + ')}; }\n`;
}

/** Pass `scale` of a bright-extraction pass that feeds a cascade (box-prefiltered when downscaled). */
export function brightDownscale(sigmaMin: number, levels: number): number {
	const s0 = sigmaMin * 2 ** (1 - clamp(Math.round(levels), 1, 5));
	return pow2floor(clamp(s0 / 4, 1, 8));
}

// ---------------------------------------------------------------- shared GLSL

export const GLSL_SGL_CORE: GlslChunk = {
	name: 'sgl/core',
	source: /* glsl */ `
// One axis of a cascade blur level (glowCascade): 2n+1 Gaussian taps (sigma sig, in taps) along step (uv), a box
// prefilter of pn samples across perp (uv) for anti-aliased downscaling.
vec4 sgl_blurAxis(sampler2D t, vec2 uv, vec2 step, float sig, int n, vec2 perp, int pn) {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -n; i <= n; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / (sig * sig));
    for (int j = 0; j < pn; j++) {
      vec2 o = perp * ((float(j) + 0.5) / float(pn) - 0.5);
      acc += texture(t, uv + step * x + o) * w;
      ws += w;
    }
  }
  return acc / max(ws, 1.0e-6);
}
// Box-filtered read of a texture over a square footprint of d texels of the source (d = 1, 2, 4, 8) — the
// downscaling bright passes.
vec4 sgl_boxRead(sampler2D t, vec2 uv, float d) {
  if (d < 1.5) return texture(t, uv);
  vec2 tx = 1.0 / vec2(textureSize(t, 0));
  int n = int(d * 0.5 + 0.5);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < n; y++) {
    for (int x = 0; x < n; x++) {
      vec2 o = (vec2(float(x), float(y)) * 2.0 + 1.0 - d) * tx;
      acc += texture(t, uv + o);
    }
  }
  return acc / float(n * n);
}
// A loop bound the compiler cannot treat as a constant (n at run time): keeps SwiftShader/ANGLE from unrolling big
// loops, which makes compiling them very slow.
int sgl_dyn(int n) { return n + int(min(0.0, u_resolution.x)); }
// Reflect edge mode: a layer-normalised point mirrored into the box.
vec2 sgl_mirrorNorm(vec2 n) { vec2 m = mod(n, 2.0); return mix(m, 2.0 - m, step(1.0, m)); }
// The effect input at v_uv, box-filtered over d texels (downscaled bright passes); reflect = 1 mirrors the layer
// into the padding (Edge Mode: Reflect) so light near the frame edge does not fade.
vec4 sgl_srcRead(float d, int reflect) {
  vec2 uv = v_uv;
  if (reflect == 1) uv = fx_uvOfLayerNorm(sgl_mirrorNorm(fx_layerNorm()));
  return sgl_boxRead(u_source, uv, d);
}
// Level weight (see levelWeights in glow.ts): level k of L on a profile 2^(slope·x) shifted by shift octaves.
float sgl_levelW(float k, float L, float slope, float shift) {
  float x = k - shift;
  return exp2(slope * (x - (L - 1.0))) * clamp(L - x, 0.0, 1.0) * clamp(x + 1.0, 0.0, 1.0);
}
// Soft threshold of a value (luma or channel): 0 below t, ramping to 1 over softness s.
float sgl_soft(float v, float t, float s) { return clamp((v - t) / max(s, 1.0e-4), 0.0, 1.0); }
// Rainbow spectrum 0..1 (red → yellow → green → cyan → blue → violet), energy-balanced.
vec3 sgl_spectrum(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = clamp(vec3(abs(t * 6.0 - 3.0) - 1.0, 2.0 - abs(t * 6.0 - 2.0), 2.0 - abs(t * 6.0 - 4.0)), 0.0, 1.0);
  c = vec3(c.r, c.g, c.b);
  return c / max(0.6, dot(c, vec3(0.2126, 0.7152, 0.0722)) * 1.4);
}
// Cyclic hue 0..1 → saturated RGB.
vec3 sgl_hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
`,
};
