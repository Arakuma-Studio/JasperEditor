// Motion-compensated frame interpolation for S_Retime and S_RepairFrames (Sapphire uses optical flow). A small,
// deterministic two-level Lucas–Kanade estimator on the GPU: luma pyramids of frames A and B at 1/4 and 1/8 of the
// canvas, a 7×7 LK solve at 1/8, a warped 5×5 refinement at 1/4, a smoothing pass, then the final pass warps A and
// B towards the in-between time t and blends them (optionally with motion blur along the vectors, or shows the
// vectors as colours). Large motions (> ~30 px at the canvas resolution) and occlusions degrade gracefully to a
// cross-fade. Flow is stored as 0.5 + px/256 so it survives 8-bit intermediates.
import { GLSL_BLUR } from '../glsl/blur.ts';
import { GLSL_COLOR } from '../glsl/color.ts';
import { GLSL_MB } from '../glsl/motion-blur.ts';
import { GLSL_UV } from '../glsl/sample.ts';
import type { GlslChunk, ShaderPass } from '../shader.ts';

export const GLSL_FLOW_CODEC: GlslChunk = {
	name: 'sapphire-time-flicker/flow-codec',
	source: /* glsl */ `
vec2 fl_enc(vec2 px) { return clamp(0.5 + px / 256.0, 0.0, 1.0); }
vec2 fl_dec(vec2 e) { return (e - 0.5) * 256.0; }
float fl_luma(vec4 c) { return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); }
// 2×2 Lucas–Kanade solve with Tikhonov regularisation: returns v with (sum g gᵀ + λ) v = −sum g·It.
vec2 fl_solve(float sxx, float sxy, float syy, float sxt, float syt, float lambda) {
  float a = sxx + lambda; float d = syy + lambda;
  float det = a * d - sxy * sxy;
  if (abs(det) < 1.0e-9) return vec2(0.0);
  return -vec2(d * sxt - sxy * syt, a * syt - sxy * sxt) / det;
}
`,
};

/**
 * The flow passes (outputs `flLum4`, `flLum8`, `flFlow8`, `flFlow4`, `flFlow`). `defs` must define
 * `vec4 flowA(vec2 uv)` and `vec4 flowB(vec2 uv)` (premultiplied pictures of the two frames, canvas uv) and
 * `bool flowActive()` (false = nothing to interpolate: the passes write zero flow). `lambda` regularises the solve
 * (higher = smoother, smaller vectors); `smooth` 0..1 blends in a blurred field.
 */
export function flowPasses(
	defs: string,
	include: readonly GlslChunk[],
	lambda: number,
	smooth: number,
): ShaderPass[] {
	const inc = [GLSL_FLOW_CODEC, ...include];
	return [
		{
			output: 'flLum4',
			scale: 0.25,
			format: 'rgba16f',
			include: inc,
			frag: /* glsl */ `${defs}
void main() {
  if (!flowActive()) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 d = 1.5 / u_canvasSize;
  vec4 a = flowA(v_uv + vec2(-d.x, -d.y)) + flowA(v_uv + vec2(d.x, -d.y)) + flowA(v_uv + vec2(-d.x, d.y)) + flowA(v_uv + d);
  vec4 b = flowB(v_uv + vec2(-d.x, -d.y)) + flowB(v_uv + vec2(d.x, -d.y)) + flowB(v_uv + vec2(-d.x, d.y)) + flowB(v_uv + d);
  fragColor = vec4(fl_luma(a) * 0.25, fl_luma(b) * 0.25, 0.0, 1.0);
}`,
		},
		{
			output: 'flLum8',
			scale: 0.125,
			format: 'rgba16f',
			include: [GLSL_BLUR],
			frag: /* glsl */ `
void main() { fragColor = fx_blur9(u_flLum4, v_uv, 1.0 / vec2(textureSize(u_flLum4, 0))); }`,
		},
		{
			output: 'flFlow8',
			scale: 0.125,
			format: 'rgba16f',
			include: inc,
			uniforms: { u_flLambda: lambda },
			frag: /* glsl */ `
float A8(vec2 uv) { return texture(u_flLum8, uv).r; }
float B8(vec2 uv) { return texture(u_flLum8, uv).g; }
void main() {
  vec2 T = 1.0 / vec2(textureSize(u_flLum8, 0));
  float sxx = 0.0, sxy = 0.0, syy = 0.0, sxt = 0.0, syt = 0.0;
  for (int j = -3; j <= 3; j++)
    for (int i = -3; i <= 3; i++) {
      vec2 q = v_uv + vec2(float(i), float(j)) * T;
      float w = exp(-float(i * i + j * j) / 8.0);
      vec2 dx = vec2(T.x, 0.0), dy = vec2(0.0, T.y);
      vec2 g = 0.25 * vec2(A8(q + dx) - A8(q - dx) + B8(q + dx) - B8(q - dx), A8(q + dy) - A8(q - dy) + B8(q + dy) - B8(q - dy));
      float it = B8(q) - A8(q);
      sxx += w * g.x * g.x; sxy += w * g.x * g.y; syy += w * g.y * g.y;
      sxt += w * g.x * it; syt += w * g.y * it;
    }
  vec2 v = fl_solve(sxx, sxy, syy, sxt, syt, u_flLambda);
  float l = length(v);
  if (l > 4.0) v *= 4.0 / l;
  fragColor = vec4(fl_enc(v * u_canvasSize * T), 0.0, 1.0);
}`,
		},
		{
			output: 'flFlow4',
			scale: 0.25,
			format: 'rgba16f',
			include: inc,
			uniforms: { u_flLambda: lambda },
			frag: /* glsl */ `
void main() {
  vec2 T = 1.0 / vec2(textureSize(u_flLum4, 0));
  vec2 v0 = fl_dec(texture(u_flFlow8, v_uv).rg);
  vec2 h = 0.5 * v0 / u_canvasSize;
  float sxx = 0.0, sxy = 0.0, syy = 0.0, sxt = 0.0, syt = 0.0;
  vec2 dx = vec2(T.x, 0.0), dy = vec2(0.0, T.y);
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 q = v_uv + vec2(float(i), float(j)) * T;
      float w = exp(-float(i * i + j * j) / 4.5);
      vec2 qa = q - h, qb = q + h;
      float ga = texture(u_flLum4, qa + dx).r - texture(u_flLum4, qa - dx).r;
      float gb = texture(u_flLum4, qb + dx).g - texture(u_flLum4, qb - dx).g;
      float ha = texture(u_flLum4, qa + dy).r - texture(u_flLum4, qa - dy).r;
      float hb = texture(u_flLum4, qb + dy).g - texture(u_flLum4, qb - dy).g;
      vec2 g = 0.25 * vec2(ga + gb, ha + hb);
      float it = texture(u_flLum4, qb).g - texture(u_flLum4, qa).r;
      sxx += w * g.x * g.x; sxy += w * g.x * g.y; syy += w * g.y * g.y;
      sxt += w * g.x * it; syt += w * g.y * it;
    }
  vec2 dv = fl_solve(sxx, sxy, syy, sxt, syt, u_flLambda);
  float l = length(dv);
  if (l > 2.0) dv *= 2.0 / l;
  fragColor = vec4(fl_enc(v0 + dv * u_canvasSize * T), 0.0, 1.0);
}`,
		},
		{
			output: 'flFlow',
			scale: 0.25,
			format: 'rgba16f',
			include: [GLSL_BLUR],
			uniforms: { u_flSmooth: Math.min(1, Math.max(0, smooth)) },
			frag: /* glsl */ `
void main() {
  vec2 T = 2.0 / vec2(textureSize(u_flFlow4, 0));
  fragColor = mix(texture(u_flFlow4, v_uv), fx_blur9(u_flFlow4, v_uv, T), u_flSmooth);
}`,
		},
	];
}

/**
 * Final-pass helpers (needs the `flowA`/`flowB` defs): `fl_interp(uv, t, blur)` = the in-between picture at time
 * t ∈ [0, 1] with motion blur over `blur` × the vector length; `fl_vectors(uv, scale)` = the flow as colours (hue =
 * direction, saturation = length × scale).
 */
export const GLSL_FLOW_FINAL: GlslChunk = {
	name: 'sapphire-time-flicker/flow-final',
	deps: [GLSL_FLOW_CODEC, GLSL_COLOR, GLSL_UV, GLSL_MB],
	source: /* glsl */ `
vec2 fl_flowUv(vec2 uv) { return fl_dec(texture(u_flFlow, uv).rg) / u_canvasSize; }
vec4 fl_vectors(vec2 uv, float scale) {
  vec2 v = fl_flowUv(uv) * u_canvasSize / u_pxScale;
  float hue = fract(atan(v.y, v.x) / FX_TAU + 1.0);
  return vec4(fx_hsv2rgb(vec3(hue, clamp(length(v) * scale / 8.0, 0.0, 1.0), 1.0)), 1.0);
}
`,
};

/** The body of `fl_interp` (kept next to the defs because it calls flowA/flowB). */
export const FLOW_INTERP_GLSL = /* glsl */ `
vec4 fl_interp(vec2 uv, float t, float blur) {
  vec2 v = fl_flowUv(uv);
  if (blur <= 0.0) return mix(flowA(uv - t * v), flowB(uv + (1.0 - t) * v), t);
  // Motion blur along the flow vector: 7 taps (wave 3) or ≤ 1 px apart for long vectors (adaptive, ≤ 64).
  float ext = blur * length(v * u_canvasSize);
  int n = max(7, fx_mbTapCount(ext, 64));
  float j = n > 7 ? fx_mbJitterFor(ext, n) : 0.0;
  float last = n > 7 ? float(n) : 6.0;
  vec4 s = vec4(0.0);
  for (int k = 0; k < fx_mbDyn(64); k++) {
    if (k >= n) break;
    float o = ((float(k) + j) / last - 0.5) * blur;
    s += mix(flowA(uv - (t + o) * v), flowB(uv + (1.0 - t - o) * v), t);
  }
  return s / float(n);
}
`;
