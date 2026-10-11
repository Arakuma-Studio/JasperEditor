// Sapphire Blur+Sharpen — convolution with a kernel picture: S_Convolve, S_ConvolveComp (front/back with a matte),
// S_ZConvolve (kernel size by depth). The Kernel is a `media` param (1 kernel pixel = 1 layer pixel × Kernel Size,
// as Sapphire); without one a small disc (diameter 0.088 Sapphire units, a RackDefocus-like default) is used.
// Pipeline: the kernel's crop rectangle (Kernel Crop1/2, Sapphire kernel coords: x −1…1 over the kernel width, y in
// the same unit, down) is resampled (3×3 supersampled, Kernel Threshold, colour or luma) onto a ~64-texel grid;
// a tiny stats pass finds its bounding box and luma centroid (Autocenter); the gather lays a 16×16 grid over the
// bounding box and reads the prepared source on the pyramid level matching the grid spacing — so even kernels of
// hundreds of pixels stay smooth and real-time. Autoscale modes normalise like Sapphire (Max Channel, Luma, Indep
// Channels, Count Nonzero, Kernel Size).
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, FxUniformValue, GlslChunk, ShaderPass } from '../shader.ts';
import {
	bool,
	choiceIndex,
	clamp,
	definesChunk,
	GLSL_SBS_COMMON,
	levelFor,
	num,
	SBS_EDGE_MODES,
	SbsPlan,
	sColor,
	sEdgeMode,
	sMix,
	sNum,
	sSoftBorders,
	unitLayerPx,
	vec2,
} from './common.ts';
import {
	GLSL_SBS_DEPTH,
	zBufferParam,
	zFocusParams,
	zLayerParams,
	zLayers,
	zRelParams,
	zTypeParam,
	zUseParam,
} from './depth.ts';

const GRID = 16;
const KERNEL_TEXELS = 64;
/** Default disc kernel radius in Sapphire units (half the layer width). */
const DEFAULT_DISC = 0.044;

const AUTOSCALE = ['maxChannel', 'luma', 'indepChannels', 'countNonzero', 'kernelSize'] as const;
const COMBINE = ['convolveOnly', 'screen', 'add', 'difference'] as const;

const kernelParam = () => fxParam.media('kernel', 'Kernel', ['image', 'video']);
const kernelCenterParams = (): ParamSpec[] => [
	fxParam.vec2('kernelCenter', 'Kernel Center', [0, 0], { softMin: -1, softMax: 1, step: 0.001 }),
	fxParam.toggle('autocenter', 'Autocenter', true),
];
const kernelTailParams = (clampLabel = 'Clamp Below Thresh'): ParamSpec[] => [
	sNum('kernelThreshold', 'Kernel Threshold', 0.001, { min: 0, softMax: 0.5, step: 0.001 }),
	fxParam.toggle('clampBelowThresh', clampLabel, true),
	fxParam.vec2('kernelCrop1', 'Kernel Crop1', [-0.997, -0.747], { softMin: -1, softMax: 1, step: 0.001 }),
	fxParam.vec2('kernelCrop2', 'Kernel Crop2', [0.997, 0.747], { softMin: -1, softMax: 1, step: 0.001 }),
	fxParam.choice(
		'autoscaleMode',
		'Autoscale Mode',
		AUTOSCALE,
		['Max Channel', 'Luma', 'Indep Channels', 'Count Nonzero', 'Kernel Size'],
		'maxChannel',
	),
];
const combineParam = (labels = ['Convolve Only', 'Screen', 'Add', 'Difference']) =>
	fxParam.choice('combine', 'Combine', COMBINE, labels, 'convolveOnly');
const edgeXY = (): ParamSpec[] => [
	sEdgeMode('transparent', 'edgeModeX', 'Edge Mode X'),
	sEdgeMode('transparent', 'edgeModeY', 'Edge Mode Y'),
];

/** Per-axis edge modes (Edge Mode X & Y) and the kernel grid / stats / gather. */
const GLSL_SBS_KERNEL: GlslChunk = {
	name: 'sapphire-blur-sharpen/kernel',
	deps: [GLSL_SBS_COMMON],
	source: /* glsl */ `
float sbs_axis(float v, int mode, out bool outside) {
  outside = false;
  if (mode == SBS_EDGE_REPEAT) return clamp(v, 0.0, 1.0);
  if (mode == SBS_EDGE_REFLECT) { float m = mod(v, 2.0); return m > 1.0 ? 2.0 - m : m; }
  if (mode == SBS_EDGE_TRANSPARENT) outside = v < 0.0 || v > 1.0;
  return v;
}
// t sampled at canvas uv with per-axis edge modes at the layer box (NONE = soft borders, as is).
vec4 sbs_texXY(sampler2D t, vec2 uv, ivec2 mode) {
  if (mode.x == SBS_EDGE_NONE) return texture(t, uv);
  vec2 n = sbs_layerNorm(uv);
  bool ox, oy;
  n.x = sbs_axis(n.x, mode.x, ox);
  n.y = sbs_axis(n.y, mode.y, oy);
  if (ox || oy) return vec4(0.0);
  return texture(t, sbs_uvOfNorm(n));
}
// Kernel picture value at Sapphire kernel coords c (x −1…1 over its width, y in the same unit, down).
vec4 sbs_kernelAt(vec2 c) {
  vec2 ks = u_kernel_size.x > 0.0 ? u_kernel_size : u_box.zw / u_pxScale;
  vec2 n = vec2(c.x * 0.5 + 0.5, c.y * 0.5 * ks.x / ks.y + 0.5);
  if (u_kernel_size.x <= 0.0) {
    float r = length((n - 0.5) * vec2(ks.x / ks.y, 1.0)) * 2.0 * ks.y / ks.x;
    float d = 1.0 - smoothstep(${DEFAULT_DISC} - 0.002, ${DEFAULT_DISC} + 0.002, r);
    return vec4(d, d, d, 1.0);
  }
  if (any(lessThan(n, vec2(0.0))) || any(greaterThan(n, vec2(1.0)))) return vec4(0.0);
  return fx_unpremultiply(texture(u_kernel, n));
}
// Kernel grid: the crop rectangle resampled (3×3 supersampled), thresholded, luma or colour.
// Kernel weight over a cell of size \`cell\` centred at g (crop-normalised 0…1): 2×2 supersampled, luma or colour,
// Kernel Threshold (clamped below, or subtracted when Clamp Below Thresh is off).
vec3 sbs_kernelW(vec2 g, vec2 cell) {
  vec3 s = vec3(0.0);
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      vec2 q = g + (vec2(float(i), float(j)) - 0.5) * cell * 0.5;
      vec3 k = sbs_kernelAt(mix(u_kCrop.xy, u_kCrop.zw, q)).rgb;
      s += u_useColorKernel ? k : vec3(fx_luma(k));
    }
  s *= 0.25;
  return u_clampBelowThresh ? s * step(vec3(u_kernelThreshold), s) : s - u_kernelThreshold;
}
// Coarse kernel grid: rgb = the kernel box-filtered over the texel (4×4 samples), a = max |luma| (bounding box).
vec4 sbs_kernelGrid() {
  vec2 tx = 1.0 / u_resolution;
  vec3 a = sbs_kernelW(v_uv - tx * 0.25, tx * 0.5), b = sbs_kernelW(v_uv + tx * 0.25, tx * 0.5);
  vec3 c = sbs_kernelW(v_uv + vec2(tx.x, -tx.y) * 0.25, tx * 0.5), d = sbs_kernelW(v_uv + vec2(-tx.x, tx.y) * 0.25, tx * 0.5);
  float m = max(max(abs(fx_luma(a)), abs(fx_luma(b))), max(abs(fx_luma(c)), abs(fx_luma(d))));
  return vec4((a + b + c + d) * 0.25, m);
}
// Stats texel 0: bounding box (texel indices min x/y, max x/y) of non-zero kernel texels; texel 1: luma centroid.
vec4 sbs_kernelStats(sampler2D k) {
  ivec2 ks = textureSize(k, 0);
  vec2 lo = vec2(1.0e6), hi = vec2(-1.0e6);
  vec3 cen = vec3(0.0);
  for (int y = 0; y < ${KERNEL_TEXELS * 2}; y++) {
    if (y >= ks.y) break;
    for (int x = 0; x < ${KERNEL_TEXELS * 2}; x++) {
      if (x >= ks.x) break;
      vec4 kv = texelFetch(k, ivec2(x, y), 0);
      float l = fx_luma(kv.rgb);
      if (kv.a > 1.0e-5) {
        vec2 p = vec2(float(x), float(y));
        lo = min(lo, p);
        hi = max(hi, p);
        cen += vec3((p + 0.5) * l, l);
      }
    }
  }
  if (floor(v_uv.x * u_resolution.x) < 0.5) return vec4(lo, hi);
  return vec4(abs(cen.z) > 1.0e-6 ? cen.xy / cen.z : vec2(ks) * 0.5, cen.z, 1.0);
}
// Show Kernel: the kernel grid drawn at its actual size around the layer centre.
vec3 sbs_kernelView(sampler2D kern, vec2 kscale) {
  vec2 ks = vec2(textureSize(kern, 0));
  vec2 kernelPx = u_kernel_size.x > 0.0 ? u_kernel_size : u_box.zw / u_pxScale;
  vec2 cropPx = (u_kCrop.zw - u_kCrop.xy) * 0.5 * kernelPx.x;
  vec2 pxPerUnit = max(cropPx * kscale * u_pxScale, vec2(1.0e-6));
  vec2 d = v_uv * u_canvasSize - (u_box.xy + 0.5 * u_box.zw);
  vec2 g = d / pxPerUnit + 0.5;
  if (any(lessThan(g, vec2(0.0))) || any(greaterThan(g, vec2(1.0)))) return vec3(0.0);
  return max(sbs_kernelW(g, 1.0 / pxPerUnit), 0.0);
}
`,
};

/** The gather (needs `vec4 sbs_kSrc(int level, vec2 uv)` generated per effect and, with SBS_SLICE, sbs_sliceW). */
const GLSL_SBS_KERNEL_GATHER: GlslChunk = {
	name: 'sapphire-blur-sharpen/kernel-gather',
	deps: [GLSL_SBS_KERNEL],
	source: /* glsl */ `
// Convolution of the prepared source at uv with the kernel grid scaled by kscale (vec2): out(x) = Σ src(x − k) w(k).
vec4 sbs_kernelGather(sampler2D kern, sampler2D kstat, vec2 uv, vec2 kscale, int maxLevel) {
  ivec2 ksz = textureSize(kern, 0);
  vec2 ks = vec2(ksz);
  vec4 bb = texelFetch(kstat, ivec2(0, 0), 0);
  vec4 ce = texelFetch(kstat, ivec2(1, 0), 0);
  if (bb.z < bb.x || max(kscale.x, kscale.y) <= 0.0) return sbs_kSrc(0, uv);
  vec2 kernelPx = u_kernel_size.x > 0.0 ? u_kernel_size : u_box.zw / u_pxScale;
  // Canvas px per crop-normalised unit; the grid covers the kernel's bounding box (+1 coarse texel).
  vec2 cropPx = (u_kCrop.zw - u_kCrop.xy) * 0.5 * kernelPx.x;
  vec2 pxPerUnit = cropPx * kscale * u_pxScale;
  vec2 center = u_autocenter ? ce.xy / ks : (u_kernelCenter - u_kCrop.xy) / (u_kCrop.zw - u_kCrop.xy);
  vec2 lo = clamp((bb.xy - 1.0) / ks, 0.0, 1.0), hi = clamp((bb.zw + 2.0) / ks, 0.0, 1.0);
  vec2 stepT = (hi - lo) / float(${GRID});
  float cellTexels = max(stepT.x * ks.x, stepT.y * ks.y);
  float spacing = max(stepT.x * pxPerUnit.x, stepT.y * pxPerUnit.y);
  // The source level whose texels are at least the grid spacing (no gaps between the stamped copies).
  int lvl = int(clamp(ceil(log2(max(spacing, 1.0)) - 0.25), 0.0, float(maxLevel)));
  vec4 sum = vec4(0.0);
  vec3 wsum = vec3(0.0);
  float lsum = 0.0, nz = 0.0;
  for (int j = 0; j < ${GRID}; j++)
    for (int i = 0; i < ${GRID}; i++) {
      vec2 g = lo + (vec2(float(i), float(j)) + 0.5) * stepT;
      // Cells wider than a coarse texel read the box-filtered grid (thin rays are not missed), else the picture.
      vec3 w = cellTexels > 1.5 ? texture(kern, g).rgb : sbs_kernelW(g, stepT);
      float wl = fx_luma(w);
      if (abs(wl) < 1.0e-6 && abs(w.r) + abs(w.g) + abs(w.b) < 1.0e-6) continue;
      vec2 off = (g - center) * pxPerUnit / u_canvasSize;
      vec4 c = sbs_kSrc(lvl, uv - off);
#ifdef SBS_SLICE
      c *= sbs_sliceW(uv - off);
#endif
      sum += vec4(c.rgb * w, c.a * wl);
      wsum += w;
      lsum += wl;
      nz += 1.0;
    }
  vec4 n;
  if (u_autoscaleMode == 1) n = vec4(lsum);
  else if (u_autoscaleMode == 2) n = vec4(wsum, lsum);
  else if (u_autoscaleMode == 3) n = vec4(nz);
  else if (u_autoscaleMode == 4) n = vec4(float(${GRID * GRID}) / max((hi.x - lo.x) * (hi.y - lo.y), 1.0e-6));
  else n = vec4(max(max(wsum.r, wsum.g), wsum.b), max(max(wsum.r, wsum.g), wsum.b), max(max(wsum.r, wsum.g), wsum.b), lsum);
  n = mix(n, vec4(1.0e-6), vec4(lessThan(abs(n), vec4(1.0e-6))));
  vec4 r = sum / n;
  r.a = sum.a / (abs(lsum) > 1.0e-6 ? lsum : 1.0e-6);
  return r;
}
`,
};

function kernelUniforms(p: EffectParams): Record<string, FxUniformValue> {
	const c1 = vec2(p.kernelCrop1, [-0.997, -0.747]);
	const c2 = vec2(p.kernelCrop2, [0.997, 0.747]);
	return {
		u_kCrop: [
			Math.min(c1[0], c2[0]),
			Math.min(c1[1], c2[1]),
			Math.max(c1[0], c2[0]) + 1e-4,
			Math.max(c1[1], c2[1]) + 1e-4,
		],
	};
}

/** The edge modes (soft borders → NONE on both axes). */
const edgeXYOf = (p: EffectParams): [number, number] =>
	bool(p.softBorders)
		? [3, 3]
		: [
				choiceIndex(p.edgeModeX, SBS_EDGE_MODES, 'transparent'),
				choiceIndex(p.edgeModeY, SBS_EDGE_MODES, 'transparent'),
			];

/** Kernel grid + stats passes; returns their output names. */
function kernelPasses(plan: SbsPlan, ctx: FxPlanContext) {
	const cw = Math.max(1, ctx.width * ctx.pxScale);
	const ch = Math.max(1, ctx.height * ctx.pxScale);
	plan.pass({
		output: 'kern',
		include: [GLSL_SBS_KERNEL],
		format: 'rgba16f',
		filter: 'linear',
		scale: clamp(KERNEL_TEXELS / Math.max(cw, ch), 1e-3, 1),
		frag: 'void main() { fragColor = sbs_kernelGrid(); }',
	});
	plan.pass({
		output: 'kstat',
		include: [GLSL_SBS_KERNEL],
		format: 'rgba16f',
		filter: 'nearest',
		scale: clamp(2.5 / Math.min(cw, ch), 1e-3, 1),
		frag: 'void main() { fragColor = sbs_kernelStats(u_kern); }',
	});
}

/** Highest pyramid level a kernel of `sizeMul` can need (spacing of the 16×16 grid over the whole crop). */
function kernelMaxLevel(p: EffectParams, ctx: FxPlanContext, sizeMul: number): number {
	const c1 = vec2(p.kernelCrop1, [-0.997, -0.747]);
	const c2 = vec2(p.kernelCrop2, [0.997, 0.747]);
	// Kernel px unknown here (media size): bound by the layer size (a kernel the size of the layer).
	const crop = Math.max(Math.abs(c2[0] - c1[0]), Math.abs(c2[1] - c1[1])) * unitLayerPx(ctx) * ctx.pxScale;
	return Math.min(3, levelFor((crop * Math.max(0, sizeMul)) / GRID, 1, 3));
}

/** `vec4 sbs_kSrc(int level, vec2 uv)` over the pyramid of `input` (levels 0…k). */
function kSrcGlsl(names: string[]): string {
	const branches = names
		.map((n, i) =>
			i === names.length - 1
				? `  return sbs_texXY(u_${n}, uv, ivec2(u_kEdge));`
				: `  if (lvl <= ${i}) return sbs_texXY(u_${n}, uv, ivec2(u_kEdge));`,
		)
		.join('\n');
	return `vec4 sbs_kSrc(int lvl, vec2 uv) {\n${branches}\n}\n`;
}

function pyramidNames(plan: SbsPlan, input: string, k: number): string[] {
	const out = [input];
	for (let i = 1; i <= k; i++) out.push(plan.level(input, i));
	return out;
}

/** A gather pass: convolution of `src` (pyramid names) with the kernel scaled by `kscale`. */
function kernelGatherPass(
	plan: SbsPlan,
	o: { output: string; src: string[]; kscale: [number, number]; slice?: [number, number] | null },
): string {
	plan.pass({
		output: o.output,
		include: [
			definesChunk(o.slice ? '#define SBS_SLICE 1\n' : ''),
			...(o.slice ? [GLSL_SBS_DEPTH] : []),
			GLSL_SBS_KERNEL,
			{
				name: `sapphire-blur-sharpen/ksrc-${o.src.join('-')}`,
				source: kSrcGlsl(o.src),
				deps: [GLSL_SBS_KERNEL],
			},
			GLSL_SBS_KERNEL_GATHER,
		],
		format: 'rgba16f',
		uniforms: { u_kScale: o.kscale, u_slice: o.slice ?? [0, 1] },
		frag: `void main() { fragColor = sbs_kernelGather(u_kern, u_kstat, v_uv, u_kScale, ${o.src.length - 1}); }`,
		scale: 0.5,
	});
	return o.output;
}

/** Prepare a picture for convolution: edge modes, boost, threshold (+ add colour), gamma (premultiplied HDR). */
function convPrep(output: string, read: string, thresholdUniform = 'u_threshold'): ShaderPass {
	return {
		output,
		include: [GLSL_SBS_KERNEL],
		format: 'rgba16f',
		frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(${read});
  vec3 rgb = sbs_boost(c.rgb, u_boostHighlights, u_cHiThr);
  rgb *= step(vec3(${thresholdUniform}) + u_thresholdAddColor.rgb, rgb + 1.0e-6);
  rgb = sbs_gammaIn(rgb, u_useGamma);
  fragColor = vec4(rgb * c.a, c.a);
}`,
	};
}

const COMBINE_GLSL = /* glsl */ `
vec4 sbs_combine(vec4 conv, vec4 src, int mode) {
  if (mode == 1) return conv + src - conv * src;
  if (mode == 2) return vec4(min(conv.rgb + src.rgb, vec3(max(conv.a, src.a))), max(conv.a, src.a));
  if (mode == 3) return vec4(abs(conv.rgb - src.rgb), max(conv.a, src.a));
  return conv;
}
vec4 sbs_convOut(vec4 g, float brightness) {
  vec4 s = fx_unpremultiply(g);
  vec3 c = sbs_gammaOut(s.rgb, u_useGamma) * brightness;
  float a = clamp(s.a, 0.0, 1.0);
  return vec4(max(c, 0.0) * a, a);
}
`;

const highlightParams = (thrLabel = 'Hilight Threshold'): ParamSpec[] => [
	sNum('useGamma', 'Use Gamma', 1, { min: 0.1, softMax: 4, step: 0.01 }),
	sNum('boostHighlights', 'Boost Highlights', 0, { min: 0, softMax: 4, step: 0.01 }),
	sNum('hilightThreshold', thrLabel, 0.9, { min: 0, softMax: 1, step: 0.01 }),
];

export const S_CONVOLVE = defineShaderEffect({
	id: 'jasper.s.convolve',
	label: 'S_Convolve',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Convolves the clip with a kernel picture: a copy of the kernel is stamped over every bright spot (disc → defocus, starburst → glare). Combine with the source for glows.',
	keywords: ['convolve', 'convolution', 'kernel', 'custom bokeh', 'glare', 'filter', 'sapphire'],
	expensive: true,
	params: [
		kernelParam(),
		sNum('kernelSize', 'Kernel Size', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('kernelRelWidth', 'Kernel Rel Width', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('kernelRelHeight', 'Kernel Rel Height', 1, { min: 0, softMax: 4, step: 0.01 }),
		...kernelCenterParams(),
		fxParam.toggle('useColorKernel', 'Use Color Kernel', false),
		fxParam.toggle('showKernel', 'Show Kernel', false),
		...highlightParams(),
		sNum('brightness', 'Brightness', 1, { min: 0, max: 100000, softMax: 4, step: 0.01 }),
		sNum('chromaDistort', 'Chroma Distort', 0, { softMin: -2, softMax: 2, step: 0.01 }),
		sNum('threshold', 'Threshold', 0, { min: 0, softMax: 1, step: 0.01 }),
		sColor('thresholdAddColor', 'Threshold Add Color', [0, 0, 0]),
		combineParam(),
		sMix(),
		...edgeXY(),
		...kernelTailParams(),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) =>
			bool(p.softBorders)
				? Math.min(1, Math.abs(num(p.kernelSize, 1))) *
					unitLayerPx(ctx) *
					Math.max(num(p.kernelRelWidth, 1), num(p.kernelRelHeight, 1)) *
					0.5
				: 0,
		uniforms: (p) => {
			const e = edgeXYOf(p);
			return {
				...kernelUniforms(p),
				u_kEdge: e,
				u_cHiThr: num(p.hilightThreshold, 0.9),
				u_sbsEdge: { int: e[0] },
			};
		},
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const size = Math.max(0, num(p.kernelSize, 1));
			const ks: [number, number] = [size * num(p.kernelRelWidth, 1), size * num(p.kernelRelHeight, 1)];
			kernelPasses(plan, ctx);
			plan.pass(convPrep('prep', 'sbs_chromaTex(u_source, v_uv, u_chromaDistort, int(u_kEdge.x))'));
			const src = pyramidNames(plan, 'prep', kernelMaxLevel(p, ctx, Math.max(...ks)));
			kernelGatherPass(plan, { output: 'conv', src, kscale: ks });
			plan.pass({
				include: [GLSL_SBS_KERNEL, GLSL_COMPOSITE],
				uniforms: { u_kScale: ks },
				frag: /* glsl */ `${COMBINE_GLSL}
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 r = sbs_combine(sbs_convOut(texture(u_conv, v_uv), u_brightness), src, u_combine);
  if (u_showKernel) r = vec4(min(r.rgb + sbs_kernelView(u_kern, u_kScale), vec3(1.0)), max(r.a, 0.0));
  if (!sbs_keep(v_uv, u_sbsEdge)) r = vec4(0.0);
  fragColor = fx_mixOriginal(r, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

const MATTE_USE = ['luma', 'alpha'] as const;

export const S_CONVOLVE_COMP = defineShaderEffect({
	id: 'jasper.s.convolve-comp',
	label: 'S_ConvolveComp',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Convolves the clip (front) and a background with a kernel picture at independent sizes and composites them with a matte — defocus or glare either plane.',
	keywords: ['convolve', 'composite', 'kernel', 'defocus', 'background', 'matte', 'sapphire'],
	expensive: true,
	params: [
		fxParam.media('background', 'Background', ['image', 'video']),
		fxParam.media('matte', 'Matte', ['image', 'video']),
		kernelParam(),
		sNum('sizeFront', 'Size Front', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sizeBack', 'Size Back', 0, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sizeRelX', 'Size Rel X', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sizeRelY', 'Size Rel Y', 1, { min: 0, softMax: 4, step: 0.01 }),
		...kernelCenterParams(),
		fxParam.toggle('useColorKernel', 'Use Color Kernel', false),
		fxParam.toggle('showKernel', 'Show Kernel', false),
		sNum('useGamma', 'Use Gamma', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('matteGamma', 'Matte Gamma', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('boostHighlights', 'Boost Highlights', 0, { min: 0, softMax: 4, step: 0.01 }),
		sNum('hilightThreshold', 'Hilight Threshold', 0.9, { min: 0, softMax: 1, step: 0.01 }),
		fxParam.toggle('compPremult', 'Comp Premult', true),
		sNum('frontBrightness', 'Front Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		fxParam.number(
			'frontOpacity',
			'Front Opacity',
			1,
			{ min: 0, max: 1, step: 0.01 },
			{ ui: { control: 'slider' } },
		),
		sNum('frontThreshold', 'Front Threshold', 0, { min: 0, softMax: 1, step: 0.01 }),
		sColor('thresholdAddColor', 'Threshold Add Color', [0, 0, 0]),
		sNum('backBrightness', 'Back Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		combineParam(),
		...edgeXY(),
		...kernelTailParams(),
		fxParam.choice('matteUse', 'Matte Use', MATTE_USE, ['Luma', 'Alpha'], 'alpha'),
		fxParam.toggle('invertMatte', 'Invert Matte', false),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => {
			const e = edgeXYOf(p);
			return {
				...kernelUniforms(p),
				u_kEdge: e,
				u_cHiThr: num(p.hilightThreshold, 0.9),
				u_sbsEdge: { int: e[0] },
			};
		},
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const rx = num(p.sizeRelX, 1);
			const ry = num(p.sizeRelY, 1);
			const sf = Math.max(0, num(p.sizeFront, 1));
			const sb = Math.max(0, num(p.sizeBack));
			kernelPasses(plan, ctx);
			// Front: the clip premultiplied by the matte (matte media, else its own alpha), matte gamma on alpha.
			plan.pass({
				output: 'fg',
				include: [GLSL_SBS_KERNEL],
				format: 'rgba16f',
				frag: /* glsl */ `
void main() {
  vec4 s = sbs_texXY(u_source, v_uv, ivec2(u_kEdge));
  float m = s.a;
  if (u_matte_size.x > 0.0) {
    vec2 n = sbs_layerNorm(v_uv);
    vec4 mm = sbs_outside(n) ? vec4(0.0) : texture(u_matte, n);
    m = u_matteUse == 1 ? mm.a : fx_luma(fx_unpremultiply(mm).rgb) * mm.a;
  }
  if (u_invertMatte) m = 1.0 - m;
  vec3 c = u_compPremult ? fx_unpremultiply(s).rgb : s.rgb;
  c = sbs_boost(c, u_boostHighlights, u_cHiThr);
  c *= step(vec3(u_frontThreshold) + u_thresholdAddColor.rgb, c + 1.0e-6);
  c = sbs_gammaIn(c, u_useGamma);
  float a = pow(clamp(m, 0.0, 1.0), u_matteGamma);
  fragColor = vec4(c * a, a);
}`,
			});
			plan.pass({
				output: 'bg',
				include: [GLSL_SBS_KERNEL],
				format: 'rgba16f',
				frag: /* glsl */ `
void main() {
  vec2 n = sbs_layerNorm(v_uv);
  vec4 b = u_background_size.x > 0.0 ? texture(u_background, clamp(n, 0.0, 1.0)) : vec4(0.0);
  vec4 s = fx_unpremultiply(b);
  fragColor = vec4(sbs_gammaIn(sbs_boost(s.rgb, u_boostHighlights, u_cHiThr), u_useGamma) * s.a, s.a);
}`,
			});
			// Texture budget (3 media + 6 fixed outputs): at most 3 pyramid levels shared by front and back.
			const fgK = Math.min(kernelMaxLevel(p, ctx, sf * Math.max(rx, ry)), sb > 0 ? 2 : 3);
			const fgSrc = pyramidNames(plan, 'fg', fgK);
			kernelGatherPass(plan, { output: 'fgc', src: fgSrc, kscale: [sf * rx, sf * ry] });
			let bgc = 'bg';
			if (sb > 0) {
				const bgSrc = pyramidNames(
					plan,
					'bg',
					Math.min(kernelMaxLevel(p, ctx, sb * Math.max(rx, ry)), 3 - fgK),
				);
				bgc = kernelGatherPass(plan, { output: 'bgc', src: bgSrc, kscale: [sb * rx, sb * ry] });
			}
			plan.pass({
				include: [GLSL_SBS_KERNEL, GLSL_COMPOSITE],
				uniforms: { u_kScale: [sf * rx, sf * ry] },
				frag: /* glsl */ `${COMBINE_GLSL}
void main() {
  vec4 f = sbs_convOut(texture(u_fgc, v_uv), u_frontBrightness);
  vec4 fs = fx_unpremultiply(texture(u_fg, v_uv));
  vec4 fSharp = vec4(sbs_gammaOut(fs.rgb, u_useGamma) * fs.a, fs.a);
  vec4 b = sbs_convOut(texture(u_${bgc}, v_uv), u_backBrightness);
  f *= u_frontOpacity;
  vec4 r;
  if (u_combine == 0) r = f + b * (1.0 - f.a);
  else {
    vec4 base = fSharp * u_frontOpacity + b * (1.0 - fSharp.a * u_frontOpacity);
    r = sbs_combine(f, base, u_combine);
  }
  if (u_showKernel) r = vec4(min(r.rgb + sbs_kernelView(u_kern, u_kScale), vec3(1.0)), max(r.a, 0.0));
  if (!sbs_keep(v_uv, u_sbsEdge)) r = vec4(0.0);
  fragColor = r;
}`,
			});
			return plan.passes;
		},
	},
});

const ZCONV_SHOW = ['result', 'kernel', 'inFocusZone'] as const;

export const S_Z_CONVOLVE = defineShaderEffect({
	id: 'jasper.s.z-convolve',
	label: 'S_ZConvolve',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Convolves the clip with a kernel picture whose size follows a depth map (ZBuffer): custom-shaped depth of field, in depth layers.',
	keywords: ['z convolve', 'depth of field', 'kernel', 'zbuffer', 'custom bokeh', 'sapphire'],
	expensive: true,
	params: [
		kernelParam(),
		zBufferParam(),
		...zFocusParams(),
		sNum('size', 'Size', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sizeRelX', 'Size Rel X', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('sizeRelY', 'Size Rel Y', 1, { min: 0, softMax: 4, step: 0.01 }),
		zTypeParam(),
		fxParam.choice('show', 'Show', ZCONV_SHOW, ['Result', 'Kernel', 'In Focus Zone'], 'result'),
		...zLayerParams(),
		...kernelCenterParams(),
		...highlightParams('Highlight Threshold'),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4, step: 0.01 }),
		sNum('threshold', 'Threshold', 0, { min: 0, softMax: 1, step: 0.01 }),
		sColor('thresholdAddColor', 'Threshold Add Color', [0, 0, 0]),
		combineParam(),
		sMix(),
		...edgeXY(),
		...zRelParams('Size'),
		...kernelTailParams('Clamp Below Threshold'),
		zUseParam(),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => {
			const e = edgeXYOf(p);
			return {
				...kernelUniforms(p),
				u_kEdge: e,
				u_cHiThr: num(p.hilightThreshold, 0.9),
				u_sbsEdge: { int: e[0] },
				u_useColorKernel: false,
			};
		},
		passes: (p, ctx) => {
			const plan = new SbsPlan(ctx);
			const size = Math.max(0, num(p.size, 1));
			const ks: [number, number] = [size * num(p.sizeRelX, 1), size * num(p.sizeRelY, 1)];
			kernelPasses(plan, ctx);
			plan.pass(convPrep('prep', 'sbs_texXY(u_source, v_uv, ivec2(u_kEdge))'));
			const src = pyramidNames(plan, 'prep', kernelMaxLevel(p, ctx, Math.max(...ks)));
			// Budget: 2 media + kern + kstat + the prep pyramid; the rest for the layers.
			const layered = zLayers(
				p,
				'prep',
				({ output, scale01, slice }) =>
					kernelGatherPass(plan, { output, src, kscale: [ks[0] * scale01, ks[1] * scale01], slice }),
				12 - 2 - 2 - src.length,
			);
			plan.pass({
				include: [GLSL_SBS_DEPTH, GLSL_SBS_KERNEL, GLSL_COMPOSITE],
				uniforms: { ...layered.uniforms, u_kScale: ks },
				frag: /* glsl */ `${COMBINE_GLSL}
${layered.glsl}
void main() {
  vec4 src = texture(u_source, v_uv);
  float z = sbs_depth(v_uv);
  if (u_show == 2) { fragColor = sbs_focusZone(src, sbs_zAmount(z)); return; }
  if (u_show == 1) { fragColor = vec4(sbs_kernelView(u_kern, u_kScale), 1.0); return; }
  vec4 r = sbs_combine(sbs_convOut(sbs_zLayered(v_uv), u_brightness), src, u_combine);
  if (!sbs_keep(v_uv, u_sbsEdge)) r = vec4(0.0);
  fragColor = fx_mixOriginal(r, src, u_mixWithOriginal);
}`,
			});
			return plan.passes;
		},
	},
});

export const SBS_CONVOLVE: readonly EffectSpec[] = [S_CONVOLVE, S_CONVOLVE_COMP, S_Z_CONVOLVE];
