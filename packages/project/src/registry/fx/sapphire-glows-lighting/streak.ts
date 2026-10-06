// Family-private light-beam helpers of the Sapphire Glows + Lighting family.
//
// Radial rays (S_Rays, S_EdgeRays): every pixel averages the ray source along the line towards the rays' Center —
// sample positions c + (p − c)·e^λ, λ from λ0 (Reverse Rays) to Λ = ln(1 − Rays Length). Three passes of 12 taps
// compose (radial scalings about one centre multiply, so their logs add) into 12³ evenly spread samples: long,
// continuous rays at a fixed cost. Weights e^(−k·λ/Λ) (Bias Outer Bright) compose the same way. Per-channel lengths
// (Length Red/Green/Blue) sample each channel at its own λ.
//
// Linear streaks (S_Glint, S_GlintRainbow): two-stage comb filters along a direction: stage 1 smears over a short
// span with dense taps; stage 2 samples stage 1 at the span's spacing with a falloff, reaching span × taps.
import type { GlslChunk, ShaderPass } from '../shader.ts';
import { GLSL_SGL_CORE } from './glow.ts';

export const RAY_TAPS = 12;

/**
 * The three radial passes of the pass right before them (they read `u_prev`, so all three share one program) (outputs `<prefix>1…3`, the last is the ray picture), at `scale`. Uniforms
 * the shader reads (effect-level, see `rayUniforms`): u_center (the effect's Center point param), u_rl0 (vec3 λ0 per channel),
 * u_rlen (vec3 Λ − λ0 per channel), u_rk (falloff), u_rsplit (bool: per-channel lengths differ).
 */
export function rayPasses(prefix: string, scale: number): ShaderPass[] {
	const n = RAY_TAPS;
	return [1, 2, 3].map((j) => {
		// pass 1 spans 1/n² of the range (and starts at λ0), pass 2 1/n, pass 3 all of it.
		const span = 1 / n ** (3 - j);
		return {
			output: `${prefix}${j}`,
			scale,
			format: 'rgba16f' as const,
			include: [GLSL_SGL_RAYS],
			uniforms: { u_rspan: span, u_rstart: j === 1 ? 1 : 0 },
			frag: /* glsl */ `
void main() { fragColor = sgl_rayPass(u_prev, v_uv, u_rspan, u_rstart); }`,
		};
	});
}

export const GLSL_SGL_RAYS: GlslChunk = {
	name: 'sgl/rays',
	deps: [GLSL_SGL_CORE],
	source: /* glsl */ `
// One radial comb pass: 12 taps at λ = start·λ0 + (i/12)·span·len (per channel when split), weights e^(−k·λ/len).
vec4 sgl_rayPass(sampler2D t, vec2 uv, float span, float start) {
  vec2 c = fx_uvOfLayerNorm(u_center);
  vec2 d = uv - c;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < sgl_dyn(12); i++) {
    float f = float(i) / 12.0 * span;
    float w = exp(-u_rk * f);
    if (u_rsplit) {
      vec3 lam = start * u_rl0 + f * u_rlen;
      vec4 r = texture(t, c + d * exp(lam.r));
      vec4 g = texture(t, c + d * exp(lam.g));
      vec4 b = texture(t, c + d * exp(lam.b));
      acc += vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a))) * w;
    } else {
      acc += texture(t, c + d * exp(start * u_rl0.g + f * u_rlen.g)) * w;
    }
    ws += w;
  }
  return acc / ws;
}
`,
};

/**
 * Uniforms of the radial passes. `length` = Sapphire Rays Length (1 = infinite, < 0 inwards), `rgb` = Length
 * Red/Green/Blue, `reverse` = Reverse Rays, `bias` = Bias Outer Bright (0 fade out, 0.5 even, 1 brightest at the end).
 */
export function rayUniforms(
	length: number,
	rgb: readonly [number, number, number],
	reverse: number,
	bias: number,
) {
	const lam = (l: number) => Math.log(Math.max(0.02, 1 - Math.min(0.98, l)));
	const ends = rgb.map((m) => lam(length * m));
	const starts = rgb.map((m) => -lam(Math.max(0, reverse) * length * m));
	const split = rgb[0] !== rgb[1] || rgb[1] !== rgb[2];
	return {
		u_rl0: starts as [number, number, number],
		u_rlen: ends.map((e, i) => e - starts[i]!) as [number, number, number],
		u_rk: (0.5 - Math.min(1, Math.max(0, bias))) * 8,
		u_rsplit: split,
	};
}
