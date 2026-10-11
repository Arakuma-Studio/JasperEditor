// GPU stand-ins of built-in effects whose preview is an SVG filter (fx framework follow-ups, S03:FX-002 order
// preservation). Inside a layer's fx canvas chain an SVG filter cannot run in stack order (it is a CSS wrapper stage
// drawn after the chain); these GPU realizations run in its place, so an SVG-filter effect placed BEFORE a shader
// effect is drawn before it. Only used inside fx chains: layers without shader effects keep the M1/M2 SVG path.
// Gaussian Blur (one direction, or Repeat Edge Pixels): separable Gaussian with per-axis sigmas; without Repeat
// Edge the blur spreads into the padding (feGaussianBlur's filter region), with it the picture stays in the layer
// box and edge pixels are repeated (clamped sampling, Premiere's behaviour).
import {
	type EffectParams,
	type EffectSpec,
	GLSL_BLUR,
	type GpuEffect,
	gaussianBlurSigmas,
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
 * `preview.css` returns null), or null. The returned spec is the built-in with `gpu` added.
 */
export function chainGpuStandIn(spec: EffectSpec, params: EffectParams): EffectSpec | null {
	const gpu = STAND_INS[spec.id];
	if (!gpu || spec.gpu) return null;
	if (spec.preview.css?.(params) !== null) return null;
	return { ...spec, gpu };
}
