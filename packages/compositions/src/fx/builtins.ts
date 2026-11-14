// Inside a layer's fx canvas chain an SVG filter cannot run in stack order (it is a CSS wrapper stage
// drawn after the chain); these GPU realizations run in its place, so an SVG-filter effect placed BEFORE a shader
// effect is drawn before it. Layers without shader effects retain their SVG filters.
// Gaussian Blur (one direction, or Repeat Edge Pixels): separable Gaussian with per-axis sigmas; without Repeat
// Edge the blur spreads into the padding (feGaussianBlur's filter region), with it the picture stays in the layer
// box and edge pixels are repeated (clamped sampling, Premiere's behaviour).
// Crop with Edge Feather (crop-order): CSS has no exact feathered clip (gradient masks are dithered and resampled),
// so a feathered crop runs in the chain as a shader computing `render/crop.ts`'s profile per pixel — the same formula
// as the native export's mask (`apps/engine/src/export/crop.ts`).
import {
	cropFeather,
	cropInsets,
	cropMayFeather,
	type EffectParams,
	type EffectSpec,
	GLSL_BLUR,
	type GpuEffect,
	gaussianBlurRepeatsEdge,
	gaussianBlurSigmas,
	type ResolvedEffect,
	type ShaderPass,
} from '@jasper/project';

const GAUSSIAN_BLUR_GPU: GpuEffect = {
	timeInvariant: true,
	padding: (p) => {
		const s = gaussianBlurSigmas(p);
		return s.repeatEdge ? 0 : Math.ceil(3 * Math.max(s.x, s.y));
	},
	uniforms: (p, ctx) => {
		const s = gaussianBlurSigmas(p);
		return { u_gbSigma: [s.x * ctx.pxScale, s.y * ctx.pxScale], u_gbRepeat: s.repeatEdge };
	},
	passes: (): ShaderPass[] => {
		const frag = (tex: string, axis: 'x' | 'y', final: boolean) => /* glsl */ `
vec4 gb_tap(vec2 uv) {
  if (!u_gbRepeat) return texture(${tex}, uv);
  vec2 lo = (u_box.xy + 0.5) / u_canvasSize, hi = (u_box.xy + u_box.zw - 0.5) / u_canvasSize;
  return texture(${tex}, clamp(uv, lo, hi));
}
void main() {
  float sigma = u_gbSigma.${axis};
  vec2 dir = ${axis === 'x' ? 'vec2(1.0, 0.0)' : 'vec2(0.0, 1.0)'};
  vec4 c;
  if (sigma < 0.05) c = gb_tap(v_uv);
  else {
    float radius = ceil(sigma * 3.0);
    float stride = max(1.0, radius / float(FX_BLUR_MAX_TAPS));
    vec4 sum = gb_tap(v_uv);
    float wsum = 1.0;
    for (int i = 1; i <= FX_BLUR_MAX_TAPS; i++) {
      float x = float(i) * stride;
      if (x > radius) break;
      float w = fx_gaussianWeight(x, sigma);
      vec2 o = dir * u_texel * x;
      sum += (gb_tap(v_uv + o) + gb_tap(v_uv - o)) * w;
      wsum += 2.0 * w;
    }
    c = sum / wsum;
  }
  ${final ? 'fragColor = u_gbRepeat && !fx_inBox(v_uv) ? vec4(0.0) : c;' : 'fragColor = c;'}
}`;
		return [
			{ output: 'gbH', include: [GLSL_BLUR], frag: frag('u_source', 'x', false) },
			{ include: [GLSL_BLUR], frag: frag('u_gbH', 'y', true) },
		];
	},
};

const STAND_INS: Readonly<Record<string, GpuEffect>> = { 'jasper.gaussian-blur': GAUSSIAN_BLUR_GPU };

/**
 * The GPU stand-in of a built-in effect for the fx chain when its preview needs an SVG filter at these params (its
 * `preview.css` returns null) or no SVG filter draws them (`gaussianBlurRepeatsEdge`, also at radius 0 so the layer
 * keeps one path while the radius animates), or null. The returned spec is the built-in with `gpu` added.
 */
export function chainGpuStandIn(spec: EffectSpec, params: EffectParams): EffectSpec | null {
	const gpu = STAND_INS[spec.id];
	if (!gpu || spec.gpu) return null;
	if (spec.preview.css?.(params) !== null && !gaussianBlurRepeatsEdge({ effectId: spec.id, params }))
		return null;
	return { ...spec, gpu };
}

const CROP_ID = 'jasper.crop';
const NO_CHAIN_GEOMETRY: ReadonlySet<string> = new Set([
	CROP_ID,
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
	'jasper.corner-pin',
]);

/**
 * Feathered crop: alpha × the product of the four edge coverages of `render/crop.ts` (`cropEdgeCoverage`: the linear
 * ramp's average over the pixel, so feather 0 is the hard edge's area coverage). Edges and feather in canvas pixels.
 */
const CROP_FEATHER_GPU: GpuEffect = {
	timeInvariant: true,
	uniforms: (p, ctx) => {
		const [l, t, r, b] = cropInsets(p);
		return { u_cfInsets: [l, t, r, b], u_cfFeather: cropFeather(p) * ctx.pxScale };
	},
	passes: [
		{
			frag: /* glsl */ `
float cf_ramp(float t, float f) {
  if (t <= 0.0) return 0.0;
  if (t >= f) return t - 0.5 * f;
  return t * t / (2.0 * f);
}
float cf_edge(float d, float f) {
  return clamp(cf_ramp(d + 0.5, f) - cf_ramp(d - 0.5, f), 0.0, 1.0);
}
void main() {
  vec2 p = v_uv * u_canvasSize;
  float x0 = u_box.x + u_cfInsets.x * u_box.z;
  float y0 = u_box.y + u_cfInsets.y * u_box.w;
  float x1 = u_box.x + (1.0 - u_cfInsets.z) * u_box.z;
  float y1 = u_box.y + (1.0 - u_cfInsets.w) * u_box.w;
  float f = u_cfFeather;
  float c = cf_edge(p.x - x0, f) * cf_edge(x1 - p.x, f) * cf_edge(p.y - y0, f) * cf_edge(y1 - p.y, f);
  fragColor = texture(u_source, v_uv) * c;
}`,
		},
	],
};

/**
 * The chain spec of a crop drawn with its Edge Feather (the registry's Crop with `gpu` added), or null for a hard
 * crop (the 2D `crop` step / the CSS `clip-path`). `mayFeather`: the clip's feather is keyframed or expressed above 0
 * somewhere (`cropMayFeather` on its Animatable), so every frame takes the same path.
 */
export function cropChainSpec(spec: EffectSpec, params: EffectParams, mayFeather = false): EffectSpec | null {
	if (spec.id !== CROP_ID) return null;
	if (!mayFeather && !cropMayFeather(params)) return null;
	return { ...spec, gpu: CROP_FEATHER_GPU };
}

/**
 * Crops of an (enabled, known) stack that need the canvas chain:
 * - a crop with Edge Feather (`feathered`: ids whose clip-level feather may be > 0, else its value here);
 * - a crop placed before an effect that mixes pixels (blur, glow…) which itself precedes a colour effect: the colour
 *   stage (color/chain.ts) would run that effect on the source before its LUT while the crop stays a CSS wrapper drawn
 *   after the chain, i.e. after the effect. In the chain the crop runs at its place.
 * Crops elsewhere stay `clip-path` wrappers at their stack position, which is exact.
 */
export function cropNeedsChain(
	ordered: readonly ResolvedEffect[],
	specOf: (fx: ResolvedEffect) => EffectSpec | undefined,
	feathered?: ReadonlySet<string>,
): Set<string> {
	const out = new Set<string>();
	let lastColor = -1;
	ordered.forEach((fx, i) => {
		if (specOf(fx)?.color) lastColor = i;
	});
	ordered.forEach((fx, i) => {
		if (fx.effectId !== CROP_ID) return;
		if (feathered?.has(fx.id) || cropMayFeather(fx.params)) {
			out.add(fx.id);
			return;
		}
		for (let j = i + 1; j < lastColor; j++) {
			const e = ordered[j]!;
			const spec = specOf(e);
			if (spec && !spec.color && !NO_CHAIN_GEOMETRY.has(e.effectId)) {
				out.add(fx.id);
				return;
			}
		}
	});
	return out;
}
