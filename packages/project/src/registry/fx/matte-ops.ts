// Shared matte operations of the matte / keying families: matte sampling over the layer
// box, fractional grey-scale morphology (choke / spread), Gaussian softening and contrast, as GLSL and as pass
// builders (ping-pong passes on one output name). Imported by object-matte.ts and keying-matte.ts.
import { GLSL_BLUR } from './glsl/blur.ts';
import type { GlslChunk, ShaderPass } from './shader.ts';

/** Shared GLSL: matte sampling over the layer box, fractional morphology. */
export const GLSL_OBJECT_MATTE: GlslChunk = {
	name: 'roto/matte',
	source: /* glsl */ `
// The matte value of a bound matte texture at layer-normalised n (0 outside the layer box or without a picture).
float om_sample(sampler2D t, vec2 size, vec2 n) {
  if (size.x < 1.0 || any(lessThan(n, vec2(0.0))) || any(greaterThan(n, vec2(1.0)))) return 0.0;
  return texture(t, n).r;
}
// Grey-scale erosion (dilate = false) or dilation along dir over a fractional radius (texture px), red channel.
float om_morph1d(sampler2D t, vec2 uv, vec2 dir, vec2 texel, float radius, bool dilate) {
  float v = texture(t, uv).r;
  int n = int(ceil(radius));
  for (int i = 1; i <= 128; i++) {
    if (i > n) break;
    float w = clamp(radius - float(i - 1), 0.0, 1.0);
    float a = texture(t, uv + dir * texel * float(i)).r;
    float b = texture(t, uv - dir * texel * float(i)).r;
    float m = dilate ? max(a, b) : min(a, b);
    v = dilate ? max(v, mix(v, m, w)) : min(v, mix(v, m, w));
  }
  return v;
}
// Contrast (0..100 %) around ½ (Refine Edge's Contrast).
float om_contrast(float a, float pc) {
  if (pc <= 0.0) return a;
  return clamp(0.5 + (a - 0.5) / (1.0 - 0.99 * clamp(pc / 100.0, 0.0, 1.0)), 0.0, 1.0);
}
`,
};

/** Morphology (H then V, ping-pong on `name`) by `radiusPx` canvas px: > 0 grows, < 0 shrinks. */
export function morphPasses(name: string, radiusPx: number): ShaderPass[] {
	if (Math.abs(radiusPx) < 0.05) return [];
	const r = Math.min(128, Math.abs(radiusPx));
	const frag = /* glsl */ `
void main() {
  float m = om_morph1d(u_${name}, v_uv, u_omDir, u_texel, u_omRadius, u_omDilate);
  fragColor = vec4(m, m, m, 1.0);
}`;
	return [0, 1].map((axis) => ({
		output: name,
		update: true,
		include: [GLSL_OBJECT_MATTE],
		frag,
		uniforms: { u_omDir: axis === 0 ? [1, 0] : [0, 1], u_omRadius: r, u_omDilate: radiusPx > 0 },
	}));
}

/** Gaussian blur (H then V, ping-pong on `name`, at `scale` of the canvas like its first write) with sigma in px of
 * that texture. */
export function blurPasses(name: string, sigma: number, scale = 1): ShaderPass[] {
	if (sigma < 0.05) return [];
	const frag = /* glsl */ `
void main() { fragColor = fx_gaussian1d(u_${name}, v_uv, u_omDir, u_texel, u_omSigma); }`;
	return [0, 1].map((axis) => ({
		output: name,
		update: true,
		include: [GLSL_BLUR],
		frag,
		uniforms: { u_omDir: axis === 0 ? [1, 0] : [0, 1], u_omSigma: sigma },
		...(scale < 1 ? { scale } : {}),
	}));
}
