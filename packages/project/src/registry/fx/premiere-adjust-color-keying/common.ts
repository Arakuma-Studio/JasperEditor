// Shared helpers of the Premiere Adjust/Color/Keying family: param value readers, Premiere-
// style param builders, family GLSL chunks (media layers over the layer box, colour spaces, analysis reductions) and
// pass builders (downscaled frame analysis for Auto Color/Contrast/Levels and Equalize).
// Import rule: values only from the framework (`../define.ts`, `../params.ts`, `../passes.ts`, `../shader.ts`,
// `../glsl/*`); only types from `../../effects.ts`.

import type { ParamSpec } from '../../effects.ts';
import { booleanParam as bool, numberParam as num, stringParam as str } from '../../param-values.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, GlslChunk, ShaderPass } from '../shader.ts';

/** A Premiere-style numeric slider with a hard range and a slider (soft) range. */
export function slider(
	name: string,
	label: string,
	def: number,
	min: number,
	max: number,
	opts: { softMin?: number; softMax?: number; step?: number; unit?: ParamSpec['unit']; group?: string } = {},
): ParamSpec {
	return fxParam.number(
		name,
		label,
		def,
		{
			min,
			max,
			...(opts.softMin !== undefined ? { softMin: opts.softMin } : {}),
			...(opts.softMax !== undefined ? { softMax: opts.softMax } : {}),
			step: opts.step ?? 0.1,
		},
		{
			...(opts.unit ? { unit: opts.unit } : {}),
			...(opts.group ? { group: opts.group } : {}),
			ui: { control: 'slider' },
		},
	);
}

/** "Blend With Original" 0..100 % (`u_<name>`, divide by 100). */
export const blendWithOriginalParam = (name = 'blendWithOriginal', label = 'Blend With Original') =>
	fxParam.percent(name, label, 0);

/** A popup whose option values are the kebab-free camelCase forms of their labels. */
export function popup(
	name: string,
	label: string,
	options: readonly [string, string][],
	def?: string,
	group?: string,
) {
	return fxParam.choice(
		name,
		label,
		options.map((o) => o[0]),
		options.map((o) => o[1]),
		def ?? options[0]![0],
		group ? { group } : undefined,
	);
}

/** "If Layer Sizes Differ" popup (Center / Stretch to Fit): `u_<name>` 0 = centre, 1 = stretch. */
export const layerSizesParam = (def: 'center' | 'stretch' = 'center', name = 'layerSizes') =>
	popup(
		name,
		'If Layer Sizes Differ',
		[
			['center', 'Center'],
			['stretch', 'Stretch to Fit'],
		],
		def,
	);

/**
 * Family GLSL: media layers placed over the layer box (Premiere "If Layer Sizes Differ": centred at native size or
 * stretched), clamped colour helpers, YIQ, and Rec.601/709 luma.
 */
export const GLSL_PACG: GlslChunk = {
	name: 'pacg/common',
	deps: [GLSL_COLOR],
	source: /* glsl */ `
// uv in a media texture for the current pixel: stretched over the layer box, or centred at its native pixel size.
vec2 pacg_mediaUv(vec2 size, bool stretch) {
  vec2 n = fx_layerNorm();
  if (stretch) return n;
  vec2 boxPx = u_box.zw / u_pxScale;
  return (n * boxPx - (boxPx - size) * 0.5) / max(size, vec2(1.0));
}
// The media picture (premultiplied) at the current pixel; transparent outside it or when missing (size 0).
vec4 pacg_media(sampler2D t, vec2 size, bool stretch) {
  if (size.x <= 0.0 || size.y <= 0.0) return vec4(0.0);
  vec2 uv = pacg_mediaUv(size, stretch);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture(t, uv);
}
vec3 pacg_clamp01(vec3 c) { return clamp(c, 0.0, 1.0); }
float pacg_luma601(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// NTSC YIQ (Y 0..1, I ≈ ±0.596, Q ≈ ±0.523).
vec3 pacg_rgb2yiq(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 pacg_yiq2rgb(vec3 y) {
  return vec3(dot(y, vec3(1.0, 0.956, 0.621)), dot(y, vec3(1.0, -0.272, -0.647)), dot(y, vec3(1.0, -1.106, 1.703)));
}
// Straight colour of a premultiplied texel (0 where transparent).
vec3 pacg_straight(vec4 p) { return p.a > 0.0 ? p.rgb / p.a : vec3(0.0); }
`,
};

/** Long side of the analysis thumbnail in pixels (≈ 96 × 54 = 5k samples for a 16:9 layer). */
export const ANALYSIS_SIDE = 96;

/**
 * Pass `thumb`: a box-averaged thumbnail of the layer box (≈ ANALYSIS_SIDE px on the long side) holding the straight
 * colour in rgb and the opaque coverage in a. Later passes loop over it with `texelFetch` (a few thousand texels).
 * Pixels outside the layer box (padding of earlier effects) are ignored.
 */
export function analysisThumbPass(ctx: FxPlanContext, input = 'source'): ShaderPass {
	const side = Math.max(ctx.width, ctx.height) * ctx.pxScale;
	const scale = Math.min(1, Math.max(1e-3, ANALYSIS_SIDE / Math.max(1, side)));
	return {
		output: 'thumb',
		scale,
		filter: 'nearest',
		uniforms: { u_thumbTaps: Math.max(1, Math.min(8, Math.round(1 / scale / 2))) },
		frag: /* glsl */ `
void main() {
  // The footprint of this thumbnail texel on the canvas, sampled on a taps × taps grid (bilinear taps).
  vec2 footprint = u_canvasSize / u_resolution;
  int n = int(u_thumbTaps);
  vec4 sum = vec4(0.0);
  float cnt = 0.0;
  for (int j = 0; j < n; j++) {
    for (int i = 0; i < n; i++) {
      vec2 off = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
      vec2 uv = v_uv + off * footprint / u_canvasSize;
      cnt += 1.0;
      if (!fx_inBox(uv)) continue;
      sum += texture(u_${input}, uv);
    }
  }
  vec4 avg = sum / max(cnt, 1.0);
  fragColor = vec4(avg.a > 0.0 ? avg.rgb / avg.a : vec3(0.0), avg.a);
}`,
	};
}

/** A tiny pass (≈ 1–2 px) for per-frame statistics computed by looping over `u_thumb` (every texel the same). */
export function statsScale(ctx: FxPlanContext): number {
	const side = Math.max(ctx.width, ctx.height) * ctx.pxScale;
	return Math.min(1, Math.max(1e-3, 1 / Math.max(1, side)));
}

export { bool, num, str };
