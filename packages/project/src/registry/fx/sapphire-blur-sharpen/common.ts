// Shared core of the Sapphire Blur+Sharpen family: Sapphire units, the common params
// (Edge Mode, Soft Borders, Filter, Mix With Source), edge-mode sampling at the layer-box borders, separable
// box/triangle/gaussian blurs with automatic downscaling (a 3×3-prefiltered pyramid) and a tiny pass-graph builder
// so every effect of the family plans its passes the same way.
//
// Units. Sapphire sizes are resolution independent: positions use "screen coordinates" where the frame spans −1…1
// horizontally (y down, aspect-scaled vertically), so ONE Sapphire unit = half the layer width. Every size param
// of this family is expressed in that unit (`unitPx(ctx)` canvas px); each effect documents its own scale factor
// (e.g. S_Blur: σ = Blur Amount × U / 24) so the Sapphire defaults give the same look at any resolution.
import type { ParamValue } from '../../../schema/common.ts';
import type { EffectParams, ParamSpec } from '../../effects.ts';
import { booleanParam as bool, clamp, numberParam as num } from '../../param-values.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_SAMPLE } from '../glsl/sample.ts';
import { fxParam, mixWithOriginalParam } from '../params.ts';
import type { FxPlanContext, FxUniformValue, GlslChunk, ShaderPass } from '../shader.ts';

export const vec2 = (v: ParamValue | undefined, d: readonly [number, number]): [number, number] =>
	Array.isArray(v) && v.length === 2 ? [num(v[0], d[0]), num(v[1], d[1])] : [d[0], d[1]];
export const rgba = (
	v: ParamValue | undefined,
	d: readonly [number, number, number, number],
): [number, number, number, number] =>
	Array.isArray(v) && v.length === 4
		? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2]), num(v[3], d[3])]
		: [d[0], d[1], d[2], d[3]];
/** Index of an enum param value among `options` (unknown → index of `def`). */
export const choiceIndex = (v: ParamValue | undefined, options: readonly string[], def: string): number => {
	const i = typeof v === 'string' ? options.indexOf(v) : -1;
	return i >= 0 ? i : Math.max(0, options.indexOf(def));
};

/** Canvas pixels per Sapphire unit (half the layer width). */
export const unitPx = (ctx: Pick<FxPlanContext, 'width' | 'pxScale'>) => (ctx.width * ctx.pxScale) / 2;
/** Layer pixels per Sapphire unit (paddings are in layer pixels). */
export const unitLayerPx = (ctx: Pick<FxPlanContext, 'width'>) => ctx.width / 2;

/** A Sapphire numeric param: `min`/`max` hard limits (null = unbounded), `softMax` the slider end. */
export function sNum(
	name: string,
	label: string,
	def: number,
	opts: NonNullable<ParamSpec['range']> & { int?: boolean } = {},
): ParamSpec {
	const range: NonNullable<ParamSpec['range']> = { step: opts.step ?? (opts.int ? 1 : 0.001) };
	if (opts.min !== undefined) range.min = opts.min;
	if (opts.max !== undefined) range.max = opts.max;
	if (opts.softMin !== undefined) range.softMin = opts.softMin;
	if (opts.softMax !== undefined) range.softMax = opts.softMax;
	return fxParam.number(name, label, def, range);
}
/** A Sapphire size (≥ 0, in Sapphire units). */
export const sSize = (name: string, label: string, def: number, softMax = 1) =>
	sNum(name, label, def, { min: 0, softMax });
/** 0…1 slider. */
export const sUnit = (name: string, label: string, def: number) =>
	fxParam.number(name, label, def, { min: 0, max: 1, step: 0.001 }, { ui: { control: 'slider' } });
/** Sapphire "Mix With Source" (the framework's u_mixWithOriginal, 0…1). */
export const sMix = (): ParamSpec => ({ ...mixWithOriginalParam(), label: 'Mix With Source' });
/** A Sapphire colour without alpha (alpha stays 1). */
export const sColor = (name: string, label: string, rgb: readonly [number, number, number]) =>
	fxParam.color(name, label, [rgb[0], rgb[1], rgb[2], 1]);

export const SBS_EDGE_MODES = ['transparent', 'repeat', 'reflect'] as const;
/** Sapphire "Edge Mode" (Transparent, Repeat = extend the last pixel, Reflect). */
export const sEdgeMode = (
	def: (typeof SBS_EDGE_MODES)[number] = 'reflect',
	name = 'edgeMode',
	label = 'Edge Mode',
) => fxParam.choice(name, label, SBS_EDGE_MODES, ['Transparent', 'Repeat', 'Reflect'], def);
/** Sapphire "Soft Borders": transparent borders are added, the result may extend past the layer box. */
export const sSoftBorders = () => fxParam.toggle('softBorders', 'Soft Borders', false);

export const SBS_FILTERS = ['box', 'triangle', 'gauss'] as const;
export const sFilter = (def: (typeof SBS_FILTERS)[number] = 'gauss') =>
	fxParam.choice('filter', 'Filter', SBS_FILTERS, ['Box', 'Triangle', 'Gauss'], def);
export const filterIndex = (p: EffectParams, def: (typeof SBS_FILTERS)[number] = 'gauss') =>
	choiceIndex(p.filter, SBS_FILTERS, def);

/** Wrap popups of the motion blurs ("No", "Tile", "Reflect"). */
export const SBS_WRAPS = ['no', 'tile', 'reflect'] as const;
export const sWrap = (name: string, label: string, def: (typeof SBS_WRAPS)[number] = 'no') =>
	fxParam.choice(name, label, SBS_WRAPS, ['No', 'Tile', 'Reflect'], def);

/**
 * GLSL edge mode of an effect instance (`SBS_EDGE_*`): Soft Borders → NONE (sample the padded canvas as is, the
 * result is not clipped); otherwise the Edge Mode param (or `fixed` when the effect has none). The result of a
 * non-soft-border effect is clipped to the layer box ("the result will retain an edge at the borders").
 */
export function edgeOf(p: EffectParams, fixed?: number): number {
	if (bool(p.softBorders)) return SBS_EDGE_NONE;
	if (fixed !== undefined) return fixed;
	return choiceIndex(p.edgeMode, SBS_EDGE_MODES, 'reflect');
}
export const SBS_EDGE_TRANSPARENT = 0;
export const SBS_EDGE_REPEAT = 1;
export const SBS_EDGE_REFLECT = 2;
export const SBS_EDGE_NONE = 3;

/**
 * `sapphire-blur-sharpen/common`: layer-box addressing with edge modes (`sbs_tex`), 1D box/triangle/gaussian
 * kernels (`sbs_blur1d`), YIQ conversion, the Sapphire tone tails (`sbs_offsetDarks`), highlight boost + "Use Gamma"
 * pre/post maps for defocus-style effects.
 */
export const GLSL_SBS_COMMON: GlslChunk = {
	name: 'sapphire-blur-sharpen/common',
	deps: [GLSL_SAMPLE, GLSL_COLOR],
	source: /* glsl */ `
const int SBS_EDGE_TRANSPARENT = 0;
const int SBS_EDGE_REPEAT = 1;
const int SBS_EDGE_REFLECT = 2;
const int SBS_EDGE_NONE = 3;
vec2 sbs_layerNorm(vec2 uv) { return (uv * u_canvasSize - u_box.xy) / u_box.zw; }
vec2 sbs_uvOfNorm(vec2 n) { return (n * u_box.zw + u_box.xy) / u_canvasSize; }
bool sbs_outside(vec2 n) { return n.x < 0.0 || n.y < 0.0 || n.x > 1.0 || n.y > 1.0; }
// Reads t (any pass size; canvas uv) with an edge mode applied at the LAYER BOX borders.
vec4 sbs_tex(sampler2D t, vec2 uv, int mode) {
  if (mode == SBS_EDGE_NONE) return texture(t, uv);
  vec2 n = sbs_layerNorm(uv);
  if (mode == SBS_EDGE_TRANSPARENT) return sbs_outside(n) ? vec4(0.0) : texture(t, uv);
  if (mode == SBS_EDGE_REPEAT) {
    vec2 inset = 0.5 * u_canvasSize / (vec2(textureSize(t, 0)) * u_box.zw);
    n = clamp(n, inset, vec2(1.0) - inset);
  } else {
    n = fx_mirrorUv(n);
  }
  return texture(t, sbs_uvOfNorm(n));
}
// Is uv inside the layer box (soft-bordered results are not clipped).
bool sbs_keep(vec2 uv, int mode) { return mode == SBS_EDGE_NONE || !sbs_outside(sbs_layerNorm(uv)); }
// 1D kernels by their gaussian-equivalent sigma: 0 box (half width σ√3), 1 triangle (σ√6), 2 gauss (3σ reach).
float sbs_reach(float sigma, int filt) { return filt == 0 ? sigma * 1.7320508 : filt == 1 ? sigma * 2.4494897 : sigma * 3.0; }
float sbs_kernel(float x, float sigma, int filt, float stride) {
  if (filt == 0) return clamp((sigma * 1.7320508 - x) / stride + 0.5, 0.0, 1.0);
  if (filt == 1) return max(0.0, 1.0 - x / (sigma * 2.4494897));
  return exp(-0.5 * x * x / (sigma * sigma));
}
// 1D blur along dir (unit vector), sigma in texels of t, at most 48 taps per side (stride grows beyond).
vec4 sbs_blur1d(sampler2D t, vec2 uv, vec2 dir, float sigma, int filt, int mode) {
  if (sigma < 0.15) return sbs_tex(t, uv, mode);
  vec2 texel = 1.0 / vec2(textureSize(t, 0));
  float reach = sbs_reach(sigma, filt);
  float n = min(ceil(reach), 48.0);
  float stride = max(reach / n, 1.0e-3);
  float w0 = sbs_kernel(0.0, sigma, filt, stride);
  vec4 sum = sbs_tex(t, uv, mode) * w0;
  float wsum = w0;
  for (int i = 1; i <= 48; i++) {
    float x = float(i) * stride;
    if (float(i) > n) break;
    float w = sbs_kernel(x, sigma, filt, stride);
    vec2 o = dir * texel * x;
    sum += (sbs_tex(t, uv + o, mode) + sbs_tex(t, uv - o, mode)) * w;
    wsum += 2.0 * w;
  }
  return sum / max(wsum, 1.0e-6);
}
// Per-channel 1D blur: one tap position set (from the largest sigma), a kernel per channel.
vec4 sbs_blur1d4(sampler2D t, vec2 uv, vec2 dir, vec4 sigma, int filt, int mode) {
  float smax = max(max(sigma.r, sigma.g), max(sigma.b, sigma.a));
  if (smax < 0.15) return sbs_tex(t, uv, mode);
  vec2 texel = 1.0 / vec2(textureSize(t, 0));
  float reach = sbs_reach(smax, filt);
  float n = min(ceil(reach), 48.0);
  float stride = max(reach / n, 1.0e-3);
  vec4 s = max(sigma, vec4(1.0e-3));
  vec4 w0 = vec4(1.0);
  vec4 sum = sbs_tex(t, uv, mode);
  vec4 wsum = w0;
  for (int i = 1; i <= 48; i++) {
    float x = float(i) * stride;
    if (float(i) > n) break;
    vec4 w = vec4(sbs_kernel(x, s.r, filt, stride), sbs_kernel(x, s.g, filt, stride), sbs_kernel(x, s.b, filt, stride), sbs_kernel(x, s.a, filt, stride));
    w *= step(vec4(0.15), sigma);
    vec2 o = dir * texel * x;
    sum += (sbs_tex(t, uv + o, mode) + sbs_tex(t, uv - o, mode)) * w;
    wsum += 2.0 * w;
  }
  return sum / max(wsum, vec4(1.0e-6));
}
// YIQ (NTSC): I = orange–cyan (the skin-tone line), Q = purple–green.
vec3 sbs_rgb2yiq(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.595716, -0.274453, -0.321263)), dot(c, vec3(0.211456, -0.522591, 0.311135)));
}
vec3 sbs_yiq2rgb(vec3 y) {
  return vec3(dot(y, vec3(1.0, 0.9563, 0.6210)), dot(y, vec3(1.0, -0.2721, -0.6474)), dot(y, vec3(1.0, -1.1070, 1.7046)));
}
// Sapphire "Offset Darks": adds a grey value weighted towards the darks (negative = more contrast).
vec3 sbs_offsetDarks(vec3 c, float off) { return c + off * clamp(1.0 - c, 0.0, 1.0); }
// Defocus pre/post maps (straight colour): "Boost Highlights" above "Hilight Threshold", then "Use Gamma".
vec3 sbs_boost(vec3 c, float boost, float thr) {
  float l = fx_luma(c);
  float h = clamp((l - thr) / max(1.0 - thr, 0.05), 0.0, 1.0);
  return c * (1.0 + 4.0 * boost * h * h);
}
vec3 sbs_gammaIn(vec3 c, float g) { return pow(max(c, vec3(0.0)), vec3(max(g, 0.1))); }
vec3 sbs_gammaOut(vec3 c, float g) { return pow(max(c, vec3(0.0)), vec3(1.0 / max(g, 0.1))); }
// Radial chromatic aberration ("Chroma Distort"): red and blue sampled at scaled radii around the layer centre.
vec4 sbs_chromaTex(sampler2D t, vec2 uv, float amount, int mode) {
  if (abs(amount) < 1.0e-4) return sbs_tex(t, uv, mode);
  vec2 n = sbs_layerNorm(uv) - 0.5;
  float k = amount * 0.02;
  vec4 g = sbs_tex(t, uv, mode);
  vec4 r = sbs_tex(t, sbs_uvOfNorm(0.5 + n * (1.0 - k)), mode);
  vec4 b = sbs_tex(t, sbs_uvOfNorm(0.5 + n * (1.0 + k)), mode);
  return vec4(r.r, g.g, b.b, g.a);
}
`,
};

export type SbsFormat = 'rgba8' | 'rgba16f';

/**
 * Collects the passes of one effect instance. `level(input, k)` returns the texture of `input` at 1/2^k size (a 3×3
 * tent pyramid built on demand, each level once); `blur2d` plans a separable blur with automatic downscaling;
 * `pass` appends anything else. Outputs must be unique; the last pass appended is the effect result.
 */
export class SbsPlan {
	readonly passes: ShaderPass[] = [];
	private readonly pyramids = new Map<string, number>();
	private seq = 0;

	constructor(readonly ctx: FxPlanContext) {}

	/** A fresh output name with a prefix (letters/digits only). */
	name(prefix: string): string {
		return `${prefix}${this.seq++}`;
	}

	pass(p: ShaderPass): string {
		this.passes.push(p);
		return p.output ?? `pass${this.passes.length - 1}`;
	}

	/**
	 * `input` at 1/2^k of the canvas (k ≤ base: `input` itself, which is at 1/2^base). Pyramid levels are named
	 * `<input>L<k>`.
	 */
	level(input: string, k: number, format: SbsFormat = 'rgba16f', base = 0): string {
		if (k <= base) return input;
		const built = Math.max(base, this.pyramids.get(input) ?? 0);
		for (let i = built + 1; i <= k; i++) {
			const src = i === base + 1 ? input : `${input}L${i - 1}`;
			this.passes.push({
				output: `${input}L${i}`,
				include: [GLSL_SBS_PYRAMID],
				frag: `void main() { fragColor = sbs_down(u_${src}, v_uv); }`,
				scale: 1 / 2 ** i,
				format,
			});
		}
		this.pyramids.set(input, Math.max(built, k));
		return `${input}L${k}`;
	}

	/**
	 * A separable 2D blur of `input` by gaussian-equivalent sigmas (CANVAS px) per axis with a box/triangle/gauss
	 * kernel. Large sigmas are blurred on a downscaled pyramid level (σ ≤ 12 texels on the shorter axis, ≤ 256 with a
	 * prefiltered 2-pass comb on the longer one). Returns the output name; `edge` is the GLSL edge mode.
	 */
	blur2d(o: {
		input: string;
		output: string;
		sigmaX: number;
		sigmaY: number;
		filter?: number;
		edge?: number;
		format?: SbsFormat;
		/** Per-channel sigma multipliers (rgba) for channel blurs. */
		channels?: readonly [number, number, number, number];
		maxLevel?: number;
		/** The input is already at 1/2^inputLevel of the canvas. */
		inputLevel?: number;
		/** false: one (strided) pass per axis even for long blurs (saves intermediates; fine on prefiltered levels). */
		comb?: boolean;
	}): { output: string; scale: number } {
		const filter = o.filter ?? 2;
		const edge = o.edge ?? SBS_EDGE_NONE;
		const format = o.format ?? 'rgba16f';
		const sx = Math.max(0, o.sigmaX);
		const sy = Math.max(0, o.sigmaY);
		const smin = Math.min(sx || sy, sy || sx);
		const smax = Math.max(sx, sy);
		let k = 0;
		const maxLevel = o.maxLevel ?? 5;
		while (k < maxLevel && (smin / 2 ** k > 12 || smax / 2 ** k > 256)) k++;
		k = Math.max(k, o.inputLevel ?? 0);
		const scale = 1 / 2 ** k;
		let tex = this.level(o.input, k, format, o.inputLevel ?? 0);
		const axes: [number, [number, number]][] = [
			[sx * scale, [1, 0]],
			[sy * scale, [0, 1]],
		];
		const ch = o.channels;
		let a = 0;
		for (const [sigma, dir] of axes) {
			const last = a === 1;
			const steps = o.comb === false ? [{ sigma, prefilter: false }] : combSteps(sigma);
			for (const [i, step] of steps.entries()) {
				const isFinal = last && i === steps.length - 1;
				const out = isFinal ? o.output : this.name(`${o.output}b`);
				this.passes.push(blurPass(tex, out, dir, step, filter, edge, scale, format, ch));
				tex = out;
			}
			a++;
		}
		if (tex !== o.output) {
			// Both axes were empty: copy so the output name exists.
			this.passes.push({
				output: o.output,
				include: [GLSL_SBS_COMMON],
				frag: `void main() { fragColor = sbs_tex(u_${tex}, v_uv, ${edge}); }`,
				scale,
				format,
			});
		}
		return { output: o.output, scale };
	}
}

/** 1 or 2 steps (sigma, stride hint) so a long 1D blur stays smooth with ≤ 48 taps per side. */
function combSteps(sigma: number): { sigma: number; prefilter: boolean }[] {
	if (sigma <= 16) return [{ sigma, prefilter: false }];
	const a = Math.min(16, Math.max(2, sigma / 16));
	return [
		{ sigma: a, prefilter: true },
		{ sigma: Math.sqrt(Math.max(0, sigma * sigma - a * a)), prefilter: false },
	];
}

function blurPass(
	input: string,
	output: string,
	dir: [number, number],
	step: { sigma: number; prefilter: boolean },
	filter: number,
	edge: number,
	scale: number,
	format: SbsFormat,
	channels?: readonly [number, number, number, number],
): ShaderPass {
	const filt = step.prefilter ? 2 : filter;
	const uniforms: Record<string, FxUniformValue> = {
		u_bDir: dir,
		u_bFilt: { int: filt },
		u_bEdge: { int: edge },
	};
	if (channels) {
		uniforms.u_bSigma4 = channels.map((c) => c * step.sigma) as [number, number, number, number];
		if (step.prefilter) uniforms.u_bSigma4 = [step.sigma, step.sigma, step.sigma, step.sigma];
		return {
			output,
			include: [GLSL_SBS_COMMON],
			frag: `void main() { fragColor = sbs_blur1d4(u_${input}, v_uv, u_bDir, u_bSigma4, u_bFilt, u_bEdge); }`,
			scale,
			format,
			uniforms,
		};
	}
	uniforms.u_bSigma = step.sigma;
	return {
		output,
		include: [GLSL_SBS_COMMON],
		frag: `void main() { fragColor = sbs_blur1d(u_${input}, v_uv, u_bDir, u_bSigma, u_bFilt, u_bEdge); }`,
		scale,
		format,
		uniforms,
	};
}

/** 3×3 tent downsample (pyramid levels). */
export const GLSL_SBS_PYRAMID: GlslChunk = {
	name: 'sapphire-blur-sharpen/pyramid',
	source: /* glsl */ `
vec4 sbs_down(sampler2D t, vec2 uv) {
  vec2 texel = 1.0 / vec2(textureSize(t, 0));
  vec4 s = texture(t, uv) * 4.0;
  s += (texture(t, uv + vec2(texel.x, 0.0)) + texture(t, uv - vec2(texel.x, 0.0))
     + texture(t, uv + vec2(0.0, texel.y)) + texture(t, uv - vec2(0.0, texel.y))) * 2.0;
  s += texture(t, uv + texel) + texture(t, uv - texel)
     + texture(t, uv + vec2(texel.x, -texel.y)) + texture(t, uv + vec2(-texel.x, texel.y));
  return s / 16.0;
}
`,
};

/** Pyramid level k so that a radius of `r` canvas px is ≤ `target` texels (power-of-two scales, ≤ maxLevel). */
export function levelFor(r: number, target: number, maxLevel = 6): number {
	let k = 0;
	while (k < maxLevel && r / 2 ** k > target) k++;
	return k;
}

/** The common tail of a pass-function: Sapphire size → canvas px for this instance. */
export const px = (ctx: FxPlanContext, sapphireSize: number, factor = 1) =>
	Math.max(0, sapphireSize) * factor * unitPx(ctx);

/**
 * A chunk of `#define` lines that must precede the library chunks testing them (`include: [definesChunk(…), …]`).
 * Named by content so equal define sets dedupe and programs cache per variant.
 */
export function definesChunk(defines: string, deps: readonly GlslChunk[] = []): GlslChunk {
	let h = 0x811c9dc5;
	for (let i = 0; i < defines.length; i++) h = Math.imul(h ^ defines.charCodeAt(i), 0x01000193);
	const name = `sapphire-blur-sharpen/defines-${(h >>> 0).toString(16)}${deps.map((d) => `+${d.name}`).join('')}`;
	return { name, source: defines, deps };
}

export { bool, clamp, num };
