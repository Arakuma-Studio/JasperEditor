// Reusable pass builders of the fx framework (wave 1): separable Gaussian blurs (optionally downscaled) and bloom
// pyramids, so blur/glow/defocus families do not each re-derive the pass plumbing. They return plain `ShaderPass`
// objects to splice into a `GpuEffect.passes` function; authors still own the passes that read the results.
import { GLSL_BLUR } from './glsl/blur.ts';
import type { ShaderPass } from './shader.ts';

/**
 * A blur sigma: CANVAS pixels known when planning, or `{uniform: 'u_x'}` — a GLSL float expression (usually a
 * uniform of `gpu.uniforms`, e.g. `'u_blurPx'` or `'u_sigmas.y'`) evaluated per frame: animated radii then reuse
 * the same programs and plans instead of re-planning on every value.
 */
export type FxBlurSigma = number | { uniform: string };

/**
 * Two passes (horizontal, then vertical) blurring the texture `input` (`'source'`, `'prev'` or a pass output) with a
 * Gaussian of `sigma` CANVAS pixels (`sigmaY` for the vertical pass, default `sigma`); the result is the output
 * named `output`. `scale` < 1 blurs at a reduced resolution (cheap large radii; the sigma is converted). `sigma` 0
 * still yields the passes (a copy).
 */
export function gaussianBlurPasses(opts: {
	input: string;
	output: string;
	sigma: FxBlurSigma;
	sigmaY?: FxBlurSigma;
	scale?: number;
	format?: 'rgba8' | 'rgba16f';
}): ShaderPass[] {
	const scale = Math.min(1, Math.max(1e-3, opts.scale ?? 1));
	const tex = (name: string) => `u_${name}`;
	const frag = (inputTex: string, sigmaExpr = 'u_blurSigma') => `
void main() {
  vec2 texel = 1.0 / vec2(textureSize(${inputTex}, 0));
  fragColor = fx_gaussian1d(${inputTex}, v_uv, u_blurDir, texel, ${sigmaExpr} * (vec2(textureSize(${inputTex}, 0)).x / u_resolution.x));
}`;
	const pass = (inputTex: string, output: string, dir: [number, number], s: FxBlurSigma): ShaderPass =>
		typeof s === 'number'
			? {
					output,
					frag: frag(inputTex),
					include: [GLSL_BLUR],
					scale,
					format: opts.format,
					uniforms: { u_blurDir: dir, u_blurSigma: Math.max(0, s) * scale },
				}
			: {
					output,
					frag: frag(inputTex, `max(0.0, ${s.uniform}) * ${scale.toFixed(6)}`),
					include: [GLSL_BLUR],
					scale,
					format: opts.format,
					uniforms: { u_blurDir: dir },
				};
	return [
		pass(tex(opts.input), `${opts.output}H`, [1, 0], opts.sigma),
		pass(tex(`${opts.output}H`), opts.output, [0, 1], opts.sigmaY ?? opts.sigma),
	];
}

/**
 * A bloom pyramid: `levels` successive half-resolution 3×3 downsamples of `input` (outputs `<prefix>0` at 1/2 size,
 * `<prefix>1` at 1/4, …). Glow shaders sum the levels (each read with `texture(u_<prefix>k, v_uv)`) for a wide, soft
 * falloff at a fraction of the cost of one big blur.
 */
export function bloomPyramidPasses(opts: {
	input: string;
	prefix: string;
	levels: number;
	format?: 'rgba8' | 'rgba16f';
}): ShaderPass[] {
	const out: ShaderPass[] = [];
	const n = Math.max(1, Math.min(8, Math.floor(opts.levels)));
	for (let k = 0; k < n; k++) {
		const src = k === 0 ? `u_${opts.input}` : `u_${opts.prefix}${k - 1}`;
		out.push({
			output: `${opts.prefix}${k}`,
			frag: `
void main() {
  vec2 texel = 1.0 / vec2(textureSize(${src}, 0));
  fragColor = fx_blur9(${src}, v_uv, texel);
}`,
			include: [GLSL_BLUR],
			scale: 1 / 2 ** (k + 1),
			format: opts.format,
		});
	}
	return out;
}
