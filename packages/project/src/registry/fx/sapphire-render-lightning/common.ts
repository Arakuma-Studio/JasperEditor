// Family-private helpers of the Sapphire Render family (lightning, gradients/grid/shape, other render generators):
// Sapphire-style coordinates and units, the "Combine" popups, a per-channel glow chain (multi-pass), spline sampling
// for the spline-driven effects, and small TypeScript param readers. GLSL chunks are named `srt/<name>`.
//
// Units. Points are `fxParam.point` (normalised to the layer box). Sapphire expresses lengths (bolt width, radii,
// glow widths…) in frame units where the frame is 2 units wide (x ∈ [−1, 1]); here one "Sapphire unit" is half the
// layer width (`srt_unit()` canvas px in GLSL, `unitPx(ctx)` in TS). Sapphire's default point positions are
// converted to layer-box coordinates for a 16:9 frame.
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { clamp, booleanParam as flag, numberParam as num } from '../../param-values.ts';
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';

export const vec2v = (v: ParamValue | undefined, d: readonly [number, number]): [number, number] =>
	Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
		? [v[0] as number, v[1] as number]
		: [d[0], d[1]];

/** Canvas pixels per Sapphire unit (half the layer width). */
export const unitPx = (ctx: Pick<FxPlanContext, 'width' | 'pxScale'>) => 0.5 * ctx.width * ctx.pxScale;

/** A plain number with Sapphire-style range (min/max hard limits, soft max for the slider). */
export function n(
	name: string,
	label: string,
	def: number,
	min: number | undefined,
	max: number | undefined,
	opts: { softMax?: number; softMin?: number; step?: number; unit?: ParamSpec['unit'] } = {},
): ParamSpec {
	return fxParam.number(
		name,
		label,
		def,
		{
			...(min !== undefined ? { min } : {}),
			...(max !== undefined ? { max } : {}),
			...(opts.softMin !== undefined ? { softMin: opts.softMin } : {}),
			...(opts.softMax !== undefined ? { softMax: opts.softMax } : {}),
			step: opts.step ?? 0.001,
		},
		opts.unit ? { unit: opts.unit } : undefined,
	);
}

/** An integer-valued number (Sapphire "Integer" params). */
export const int = (name: string, label: string, def: number, min: number, max?: number, softMax?: number) =>
	n(name, label, def, min, max, { step: 1, ...(softMax !== undefined ? { softMax } : {}) });

/** An RGB colour (Sapphire colours have no alpha; the alpha channel is ignored). */
export const rgb = (name: string, label: string, c: readonly [number, number, number]) =>
	fxParam.color(name, label, [c[0], c[1], c[2], 1]);

/** Generic combine operations (GLSL `SRT_*` constants). */
export const SRT_OP = {
	only: 0,
	mult: 1,
	add: 2,
	screen: 3,
	difference: 4,
	overlay: 5,
	over: 6,
	exclusion: 7,
	max: 8,
	transparentShadow: 9,
} as const;
export type SrtOp = keyof typeof SRT_OP;

export type CombineOption = { value: string; label: string; op: SrtOp };

/** A Sapphire "Combine" popup; the shader reads the generic operation from `u_<name>Op` (see `combineUniforms`). */
export function combineParam(
	options: readonly CombineOption[],
	def: string,
	name = 'combine',
	label = 'Combine',
) {
	return fxParam.choice(
		name,
		label,
		options.map((o) => o.value),
		options.map((o) => o.label),
		def,
	);
}

/** `{u_<name>Op: {int}}`: the generic SRT_OP of the selected Combine option. */
export function combineUniforms(
	p: EffectParams,
	options: readonly CombineOption[],
	def: string,
	name = 'combine',
) {
	const v = typeof p[name] === 'string' ? (p[name] as string) : def;
	const o = options.find((x) => x.value === v) ?? options.find((x) => x.value === def)!;
	return { [`u_${name}Op`]: { int: SRT_OP[o.op] } };
}

/** "Light" generators (bolts, beams, glows): Screen / Add / <X> Only. */
export const lightCombine = (only: string): CombineOption[] => [
	{ value: 'screen', label: 'Screen', op: 'screen' },
	{ value: 'add', label: 'Add', op: 'add' },
	{ value: 'only', label: `${only} Only`, op: 'only' },
];

/** Picture generators (gradients, caustics, stars, dust): <X> Only / Mult / Add / Screen / Difference / Overlay. */
export const pictureCombine = (only: string): CombineOption[] => [
	{ value: 'only', label: `${only} Only`, op: 'only' },
	{ value: 'mult', label: 'Mult', op: 'mult' },
	{ value: 'add', label: 'Add', op: 'add' },
	{ value: 'screen', label: 'Screen', op: 'screen' },
	{ value: 'difference', label: 'Difference', op: 'difference' },
	{ value: 'overlay', label: 'Overlay', op: 'overlay' },
];

/** "Output Opacity" popup (All Opaque / Copy From Input) → `u_outputOpacity` (0 = all opaque, 1 = copy). */
export const outputOpacityParam = () =>
	fxParam.choice(
		'outputOpacity',
		'Output Opacity',
		['allOpaque', 'copyFromInput'],
		['All Opaque', 'Copy From Input'],
		'copyFromInput',
	);

export const GLSL_SRT_COMMON: GlslChunk = {
	name: 'srt/common',
	source: /* glsl */ `
const int SRT_ONLY = 0;
const int SRT_MULT = 1;
const int SRT_ADD = 2;
const int SRT_SCREEN = 3;
const int SRT_DIFFERENCE = 4;
const int SRT_OVERLAY = 5;
const int SRT_OVER = 6;
const int SRT_EXCLUSION = 7;
const int SRT_MAX = 8;
const int SRT_TRANSPARENT_SHADOW = 9;
const float SRT_PI = 3.14159265358979;
const float SRT_TAU = 6.28318530717959;
// Canvas px per Sapphire unit (half the layer width).
float srt_unit() { return 0.5 * u_box.z; }
// Layer-normalised point → canvas px; this fragment in canvas px.
vec2 srt_pt(vec2 norm) { return u_box.xy + norm * u_box.zw; }
vec2 srt_here() { return v_uv * u_canvasSize; }
// Sapphire frame coordinates of this fragment: x ∈ [−1, 1] across the layer, y up, same units.
vec2 srt_sapphire(vec2 canvasPx) { vec2 d = (canvasPx - (u_box.xy + 0.5 * u_box.zw)) / srt_unit(); return vec2(d.x, -d.y); }
float srt_max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
vec2 srt_rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
vec3 srt_overlay(vec3 b, vec3 t) { return mix(2.0 * b * t, 1.0 - 2.0 * (1.0 - b) * (1.0 - t), step(0.5, b)); }
vec3 srt_blendOp(int op, vec3 b, vec3 f) {
  if (op == SRT_MULT) return b * f;
  if (op == SRT_ADD) return b + f;
  if (op == SRT_SCREEN) return b + f - b * clamp(f, 0.0, 1.0);
  if (op == SRT_DIFFERENCE) return abs(b - f);
  if (op == SRT_OVERLAY) return srt_overlay(clamp(b, 0.0, 1.0), clamp(f, 0.0, 1.0));
  if (op == SRT_EXCLUSION) return b + f - 2.0 * b * f;
  if (op == SRT_MAX) return max(b, f);
  return f;
}
// Emitted light (bolts, beams, flares) combined with the source (premultiplied in and out). Bg Brightness scales the
// source; Affect Alpha adds the light's brightness to the output alpha.
vec4 srt_light(int op, vec4 src, vec3 light, float bgBright, float affectAlpha) {
  light = max(light, vec3(0.0));
  float a = clamp(max(src.a, affectAlpha * srt_max3(light)), 0.0, 1.0);
  vec3 bg = src.rgb * bgBright;
  vec3 c;
  if (op == SRT_ONLY) c = light;
  else if (op == SRT_ADD) c = bg + light;
  else if (op == SRT_SCREEN) c = bg + light - bg * min(light, vec3(1.0));
  else {
    vec3 b = src.a > 0.0 ? bg / src.a : vec3(0.0);
    c = srt_blendOp(op, b, light) * src.a + light * (1.0 - src.a);
  }
  return vec4(clamp(c, vec3(0.0), vec3(a)), a);
}
// A generated picture fg (straight RGB, coverage fgA) combined with the source. allOpaque: output alpha 1, else the
// source alpha ("Copy From Input"); SRT_OVER composites fg by its coverage over the source.
vec4 srt_picture(int op, vec4 src, vec3 fg, float fgA, float bgBright, bool allOpaque) {
  vec3 b = (src.a > 0.0 ? src.rgb / src.a : vec3(0.0)) * bgBright;
  if (op == SRT_OVER) {
    float sa = allOpaque ? 1.0 : src.a;
    vec4 o = vec4(fg * fgA, fgA) + vec4(b * sa, sa) * (1.0 - fgA);
    return vec4(clamp(o.rgb, vec3(0.0), vec3(o.a)), clamp(o.a, 0.0, 1.0));
  }
  float a = allOpaque ? 1.0 : src.a;
  vec3 r = mix(b, srt_blendOp(op, b, fg), clamp(fgA, 0.0, 1.0));
  return vec4(clamp(r, 0.0, 1.0) * a, a);
}
`,
};

export const GLSL_SRT_BLUR: GlslChunk = {
	name: 'srt/blur',
	deps: [GLSL_BLUR],
	source: /* glsl */ `
// Separable Gaussian with one sigma per colour channel (output pixels; alpha uses the largest). Taps spread out
// beyond 48 per side.
vec4 srt_blur3(sampler2D t, vec2 uv, vec2 dir, vec3 sigma) {
  float sm = max(max(sigma.r, sigma.g), max(sigma.b, 1.0e-3));
  vec4 c0 = texture(t, uv);
  if (sm < 0.3) return c0;
  float radius = ceil(sm * 3.0);
  float stride = max(1.0, radius / 48.0);
  vec3 inv = 1.0 / (2.0 * max(sigma * sigma, vec3(1.0e-4)));
  float inva = 1.0 / (2.0 * sm * sm);
  vec3 acc = c0.rgb, wsum = vec3(1.0);
  float aacc = c0.a, asum = 1.0;
  for (int i = 1; i <= 48; i++) {
    float x = float(i) * stride;
    if (x > radius) break;
    vec2 o = dir * x * u_texel;
    vec4 s = texture(t, uv + o) + texture(t, uv - o);
    vec3 w = exp(-x * x * inv);
    float wa = exp(-x * x * inva);
    acc += s.rgb * w;
    wsum += 2.0 * w;
    aacc += s.a * wa;
    asum += 2.0 * wa;
  }
  return vec4(acc / wsum, aacc / asum);
}
`,
};

/**
 * Downsample chain + per-channel Gaussian glow (multi-pass): `levels` 3×3 tent downsamples of `input` (the first
 * subtracts `u_thr`, a glow threshold), a separable blur at the coarsest level (output `<out>A`, sigma = `sigma`
 * canvas px × `rel` per channel), and a wider blur of that (`<out>B`, total sigma × `wide`). Read the results with
 * `texture(u_<out>A, v_uv)` / `texture(u_<out>B, v_uv)`. Uses `levels + 4` textures.
 */
export function glowPasses(opts: {
	input: string;
	out: string;
	sigma: number;
	rel: readonly [number, number, number];
	wide: number;
	threshold?: number;
	maxLevels?: number;
}): ShaderPass[] {
	const rel = opts.rel.map((r) => Math.max(0, r)) as [number, number, number];
	const sig = Math.max(0.5, opts.sigma);
	const sMax = sig * Math.max(1e-3, ...rel);
	const levels = clamp(Math.floor(Math.log2(Math.max(1, sMax / 3))), 1, opts.maxLevels ?? 4);
	const passes: ShaderPass[] = [];
	for (let k = 0; k < levels; k++) {
		const src = k === 0 ? `u_${opts.input}` : `u_${opts.out}D${k - 1}`;
		passes.push({
			output: `${opts.out}D${k}`,
			include: [GLSL_BLUR],
			scale: 1 / 2 ** (k + 1),
			format: 'rgba16f',
			uniforms: { u_thr: k === 0 ? Math.max(0, opts.threshold ?? 0) : 0 },
			frag: /* glsl */ `
void main() {
  vec2 texel = 1.0 / vec2(textureSize(${src}, 0));
  vec4 c = fx_blur9(${src}, v_uv, texel);
  c.rgb = max(c.rgb - u_thr * c.a, vec3(0.0));
  fragColor = c;
}`,
		});
	}
	const sA = 1 / 2 ** levels;
	const sB = Math.max(1 / 64, sA / 2);
	const wide = Math.max(1.01, opts.wide);
	const extra = Math.sqrt(wide * wide - 1);
	const blur = (input: string, output: string, scale: number, s: number): ShaderPass[] => {
		const sigma3: [number, number, number] = [rel[0] * s * scale, rel[1] * s * scale, rel[2] * s * scale];
		const frag = (tex: string) => `void main() { fragColor = srt_blur3(${tex}, v_uv, u_dir, u_sig3); }`;
		return [
			{
				output: `${output}H`,
				include: [GLSL_SRT_BLUR],
				scale,
				format: 'rgba16f',
				uniforms: { u_dir: [1, 0], u_sig3: sigma3 },
				frag: frag(`u_${input}`),
			},
			{
				output,
				include: [GLSL_SRT_BLUR],
				scale,
				format: 'rgba16f',
				uniforms: { u_dir: [0, 1], u_sig3: sigma3 },
				frag: frag(`u_${output}H`),
			},
		];
	};
	passes.push(...blur(`${opts.out}D${levels - 1}`, `${opts.out}A`, sA, sig));
	passes.push(...blur(`${opts.out}A`, `${opts.out}B`, sB, sig * extra));
	return passes;
}

/** Anisotropic Gaussian (sigma x / y in canvas px) of `input` at `scale`, outputs `<output>H`, `<output>`. */
export function blurXYPasses(opts: {
	input: string;
	output: string;
	sigmaX: number;
	sigmaY: number;
	scale: number;
}): ShaderPass[] {
	const s = opts.scale;
	const sx = Math.max(0, opts.sigmaX) * s;
	const sy = Math.max(0, opts.sigmaY) * s;
	const frag = (tex: string) => `void main() { fragColor = srt_blur3(${tex}, v_uv, u_dir, u_sig3); }`;
	return [
		{
			output: `${opts.output}H`,
			include: [GLSL_SRT_BLUR],
			scale: s,
			format: 'rgba16f',
			uniforms: { u_dir: [1, 0], u_sig3: [sx, sx, sx] },
			frag: frag(`u_${opts.input}`),
		},
		{
			output: opts.output,
			include: [GLSL_SRT_BLUR],
			scale: s,
			format: 'rgba16f',
			uniforms: { u_dir: [0, 1], u_sig3: [sy, sy, sy] },
			frag: frag(`u_${opts.output}H`),
		},
	];
}

/** Samples of a spline uniform (`u_spline`: x, y in layer px and cumulative arc length, per sample). */
const SPLINE_N = 24;

/** The GLSL side of `u_spline` (include only in effects that declare it through `splineUniform`). */
export const GLSL_SRT_SPLINE: GlslChunk = {
	name: 'srt/spline',
	source: /* glsl */ `
const int SRT_SPLINE_N = ${SPLINE_N};
vec2 srt_splineP(int i) { return u_box.xy + vec2(u_spline[i * 3], u_spline[i * 3 + 1]) * u_pxScale; }
float srt_splineS(int i) { return u_spline[i * 3 + 2] * u_pxScale; }
float srt_splineLen() { return max(srt_splineS(SRT_SPLINE_N - 1), 1.0e-3); }
// Position (xy) and unit tangent (zw) at arc length s (canvas px).
vec4 srt_splineFrame(float s) {
  s = clamp(s, 0.0, srt_splineLen());
  vec2 a = srt_splineP(0);
  float sa = 0.0;
  for (int i = 1; i < SRT_SPLINE_N; i++) {
    vec2 b = srt_splineP(i);
    float sb = srt_splineS(i);
    if (s <= sb || i == SRT_SPLINE_N - 1) {
      vec2 e = b - a;
      float l = max(sb - sa, 1.0e-4);
      vec2 d = length(e) > 1.0e-4 ? normalize(e) : vec2(1.0, 0.0);
      return vec4(a + e * clamp((s - sa) / l, 0.0, 1.0), d);
    }
    a = b;
    sa = sb;
  }
  return vec4(a, 1.0, 0.0);
}
// Nearest point of the spline to p: (arc length s, signed distance v; v > 0 left of the tangent).
vec2 srt_splineNearest(vec2 p) {
  float best = 1.0e12, bs = 0.0, bv = 0.0;
  vec2 a = srt_splineP(0);
  float sa = 0.0;
  for (int i = 1; i < SRT_SPLINE_N; i++) {
    vec2 b = srt_splineP(i);
    float sb = srt_splineS(i);
    vec2 e = b - a;
    float l2 = max(dot(e, e), 1.0e-8);
    float u = clamp(dot(p - a, e) / l2, 0.0, 1.0);
    vec2 c = a + e * u;
    float d2 = dot(p - c, p - c);
    if (d2 < best) {
      best = d2;
      bs = mix(sa, sb, u);
      vec2 d = e / sqrt(l2);
      bv = dot(p - c, vec2(-d.y, d.x));
    }
    a = b;
    sa = sb;
  }
  return vec2(bs, bv);
}
`,
};

/**
 * A Catmull-Rom spline through `pts` (layer px) sampled at SPLINE_N points evenly in arc length:
 * `{floats: [x, y, s] × SPLINE_N}` (s = cumulative length, layer px). One point → a degenerate spline.
 */
export function splineUniform(pts: readonly (readonly [number, number])[]): { floats: number[] } {
	const P = pts.length ? pts : [[0, 0] as const];
	const dense: [number, number][] = [];
	if (P.length === 1) dense.push([P[0]![0], P[0]![1]]);
	const per = 32;
	for (let i = 0; i < P.length - 1; i++) {
		const p0 = P[Math.max(0, i - 1)]!;
		const p1 = P[i]!;
		const p2 = P[i + 1]!;
		const p3 = P[Math.min(P.length - 1, i + 2)]!;
		for (let k = 0; k < per; k++) {
			const t = k / per;
			const t2 = t * t;
			const t3 = t2 * t;
			const f = (a: number, b: number, c: number, d: number) =>
				0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
			dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
		}
	}
	if (P.length > 1) dense.push([P[P.length - 1]![0], P[P.length - 1]![1]]);
	const cum = [0];
	for (let i = 1; i < dense.length; i++)
		cum.push(cum[i - 1]! + Math.hypot(dense[i]![0] - dense[i - 1]![0], dense[i]![1] - dense[i - 1]![1]));
	const total = cum[cum.length - 1]!;
	const out: number[] = [];
	let j = 0;
	for (let k = 0; k < SPLINE_N; k++) {
		const s = (total * k) / (SPLINE_N - 1);
		while (j < dense.length - 2 && cum[j + 1]! < s) j++;
		const a = dense[j]!;
		const b = dense[Math.min(dense.length - 1, j + 1)]!;
		const l = cum[Math.min(dense.length - 1, j + 1)]! - cum[j]!;
		const u = l > 1e-9 ? clamp((s - cum[j]!) / l, 0, 1) : 0;
		out.push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, s);
	}
	return { floats: out };
}

/** Start, enabled control points 1–4, End (layer-normalised params) → layer px points for `splineUniform`. */
export function splinePoints(
	p: EffectParams,
	ctx: Pick<FxPlanContext, 'width' | 'height'>,
	names: { start: string; end: string; points: readonly (readonly [string, string])[] },
	defaults: Record<string, readonly [number, number]>,
	enableDefaults: Record<string, boolean>,
): [number, number][] {
	const at = (name: string): [number, number] => {
		const v = vec2v(p[name], defaults[name] ?? [0.5, 0.5]);
		return [v[0] * ctx.width, v[1] * ctx.height];
	};
	const pts: [number, number][] = [at(names.start)];
	for (const [enable, point] of names.points)
		if (flag(p[enable], enableDefaults[enable])) pts.push(at(point));
	pts.push(at(names.end));
	return pts;
}

/**
 * Lean seeded noise for this family: ONE PCG round per lattice point (the library's `fx_hash3` chains three, and
 * its 12-octave fbm loops) — SwiftShader (headless renders without a GPU) JIT-compiles inlined loop bodies, and the
 * library versions inside loops made shaders take minutes to compile there. Integer maths only: exact everywhere.
 * Seeds are `srt_seed(u_seed + k)` (uint).
 */
export const GLSL_SRT_NOISE: GlslChunk = {
	name: 'srt/noise',
	deps: [GLSL_HASH],
	source: /* glsl */ `
uint srt_u(int x) { return uint(x + 1073741824); }
uint srt_seed(float seed) { return fx_pcg(uint(fract(seed) * 16777216.0) + 0x9e3779b9u); }
float srt_h3(ivec3 p, uint s) {
  return float(fx_pcg(srt_u(p.x) * 0x8da6b343u ^ srt_u(p.y) * 0xd8163841u ^ srt_u(p.z) * 0xcb1ab31fu ^ s) >> 8) * (1.0 / 16777216.0);
}
float srt_h2(ivec2 p, uint s) { return srt_h3(ivec3(p, 0), s); }
float srt_h1(int x, uint s) { return srt_h3(ivec3(x, 0, 0), s); }
vec2 srt_h22(ivec2 p, uint s) { return vec2(srt_h3(ivec3(p, 1), s), srt_h3(ivec3(p, 2), s)); }
vec3 srt_h33(ivec3 p, uint s) { uint h = fx_pcg(srt_u(p.x) * 0x8da6b343u ^ srt_u(p.y) * 0xd8163841u ^ srt_u(p.z) * 0xcb1ab31fu ^ s);
  uint h2 = fx_pcg(h); uint h3 = fx_pcg(h2);
  return vec3(float(h >> 8), float(h2 >> 8), float(h3 >> 8)) * (1.0 / 16777216.0); }
// Value noise (−1..1), quintic fade.
float srt_vnoise2(vec2 p, uint s) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = srt_h2(i, s), b = srt_h2(i + ivec2(1, 0), s), c = srt_h2(i + ivec2(0, 1), s), d = srt_h2(i + ivec2(1, 1), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}
// Gradient (Perlin) noise 3D (≈ −1..1): one hash per corner, its bits give the gradient (branch-free: branches
// and integer modulo here made SwiftShader's JIT crawl).
float srt_grad(ivec3 c, vec3 f, uint s) {
  uint h = fx_pcg(srt_u(c.x) * 0x8da6b343u ^ srt_u(c.y) * 0xd8163841u ^ srt_u(c.z) * 0xcb1ab31fu ^ s);
  vec3 g = vec3(uvec3(h, h >> 10u, h >> 20u) & uvec3(1023u)) * (2.0 / 1023.0) - 1.0;
  return dot(g, f) * 1.4;
}
float srt_gnoise3(vec3 p, uint s) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = srt_grad(i, f, s), n100 = srt_grad(i + ivec3(1, 0, 0), f - vec3(1, 0, 0), s);
  float n010 = srt_grad(i + ivec3(0, 1, 0), f - vec3(0, 1, 0), s), n110 = srt_grad(i + ivec3(1, 1, 0), f - vec3(1, 1, 0), s);
  float n001 = srt_grad(i + ivec3(0, 0, 1), f - vec3(0, 0, 1), s), n101 = srt_grad(i + ivec3(1, 0, 1), f - vec3(1, 0, 1), s);
  float n011 = srt_grad(i + ivec3(0, 1, 1), f - vec3(0, 1, 1), s), n111 = srt_grad(i + ivec3(1, 1, 1), f - vec3(1, 1, 1), s);
  return mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y), mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z);
}
// Fractal sum of gradient noise, at most 5 octaves (lacunarity 2), normalised to ≈ −1..1.
float srt_fbm3(vec3 p, int oct, float gain, uint s) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int k = 0; k < 5; k++) {
    if (k >= oct) break;
    sum += amp * srt_gnoise3(p, s + uint(k) * 0x68e31da4u);
    norm += amp;
    amp *= gain;
    p = p * 2.03 + vec3(17.1, 31.7, 7.3);
  }
  return sum / max(norm, 1.0e-4);
}
`,
};

/** Atmosphere noise ("dusty atmosphere"): a multiplier ≥ 0 for glows (amp 0 → 1). */
export const GLSL_SRT_ATMOS: GlslChunk = {
	name: 'srt/atmosphere',
	deps: [GLSL_SRT_NOISE],
	source: /* glsl */ `
float srt_atmosphere(vec2 sap, float amp, float freq, float detail, float speed, float seed) {
  if (amp <= 0.0) return 1.0;
  int oct = 2 + int(clamp(detail, 0.0, 1.0) * 3.0);
  float n = srt_fbm3(vec3(sap * freq, u_time * speed * 0.3), oct, 0.35 + 0.35 * clamp(detail, 0.0, 1.0), srt_seed(seed));
  return max(0.0, 1.0 + amp * n * 2.2);
}
`,
};

export { clamp, flag, num };
