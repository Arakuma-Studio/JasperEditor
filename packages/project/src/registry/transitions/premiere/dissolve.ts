// Premiere ▸ Video Transitions ▸ Dissolve (part of the premiere-transitions family). Cross Dissolve and Dip to Black
// are the native built-ins (../../../transitions.ts) and are not duplicated here.
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { gaussianBlurPasses } from '../../fx/passes.ts';
import type { ShaderPass } from '../../fx/shader.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { GLSL_TR_EASE } from '../glsl.ts';

const bin = TRANSITION_BINS.dissolve;

/** Dissolve ▸ Additive Dissolve: B is added onto A, then A is taken away — the frame brightens mid-way. */
export const ADDITIVE_DISSOLVE = defineShaderTransition({
	id: 'jasper.additive-dissolve',
	label: 'Additive Dissolve',
	bin,
	description:
		'Adds the incoming clip onto the outgoing clip, then subtracts the outgoing clip: a dissolve that brightens mid-way.',
	keywords: ['additive', 'add', 'dissolve', 'bright', 'fade'],
	gpu: {
		passes: [
			{
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  // B rises to full over the first half while A stays; A falls over the second half while B stays.
  vec4 a = tr_from(v_uv) * min(1.0, 2.0 * (1.0 - p));
  vec4 b = tr_to(v_uv) * min(1.0, 2.0 * p);
  vec4 s = a + b;
  float alpha = min(1.0, s.a);
  fragColor = vec4(min(s.rgb, vec3(alpha)), alpha);
}`,
			},
		],
	},
});

/** Dissolve ▸ Dip to White: A fades to white, then white fades to B. */
export const DIP_TO_WHITE = defineShaderTransition({
	id: 'jasper.dip-to-white',
	label: 'Dip to White',
	bin,
	description: 'The outgoing clip fades to white, then the incoming clip fades in from white.',
	keywords: ['dip', 'white', 'flash', 'fade'],
	gpu: {
		passes: [
			{
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 white = vec4(1.0);
  fragColor = p < 0.5 ? mix(tr_from(v_uv), white, 2.0 * p) : mix(white, tr_to(v_uv), 2.0 * p - 1.0);
}`,
			},
		],
	},
});

/** Dissolve ▸ Film Dissolve: a cross dissolve in linear light (gamma 1.0), as film exposures mix. */
export const FILM_DISSOLVE = defineShaderTransition({
	id: 'jasper.film-dissolve',
	label: 'Film Dissolve',
	bin,
	description:
		'A cross dissolve blended in linear color space (gamma 1.0), the way two film exposures mix: brighter, more natural.',
	keywords: ['film', 'linear', 'dissolve', 'cross', 'fade', 'gamma'],
	gpu: {
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
// Premultiplied sRGB → premultiplied linear light, and back.
vec4 fdToLinear(vec4 c) { vec4 s = fx_unpremultiply(c); return vec4(fx_srgbToLinear(s.rgb) * s.a, s.a); }
vec4 fdToSrgb(vec4 c) { vec4 s = fx_unpremultiply(c); return vec4(fx_linearToSrgb(s.rgb) * s.a, s.a); }
void main() {
  float p = tr_progress();
  fragColor = fdToSrgb(mix(fdToLinear(tr_from(v_uv)), fdToLinear(tr_to(v_uv)), p));
}`,
			},
		],
	},
});

/** Dissolve ▸ Non-Additive Dissolve: the brighter of the (faded) two clips shows — B's highlights appear first. */
export const NON_ADDITIVE_DISSOLVE = defineShaderTransition({
	id: 'jasper.non-additive-dissolve',
	label: 'Non-Additive Dissolve',
	bin,
	description:
		"A non-additive mix: wherever the incoming clip is brighter it shows, based on luminance, so its highlights appear first and the frame never brightens.",
	keywords: ['non-additive', 'nam', 'luminance', 'dissolve', 'lighten'],
	gpu: {
		passes: [
			{
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  // Both sides fade like an additive dissolve, but only the brighter one is shown (no sum): a non-additive mix.
  vec4 a = tr_from(v_uv) * min(1.0, 2.0 * (1.0 - p));
  vec4 b = tr_to(v_uv) * min(1.0, 2.0 * p);
  float la = fx_luma(a.rgb);
  float lb = fx_luma(b.rgb);
  // A soft choice (a few luma levels) so the switch has no hard, aliased contours.
  float k = smoothstep(-0.03, 0.03, lb - la);
  // Colour of the brighter side, coverage of both (a fading opaque clip darkens, it does not turn transparent).
  fragColor = vec4(mix(a.rgb, b.rgb, k), max(a.a, b.a));
}`,
			},
		],
	},
});

/**
 * Dissolve ▸ Morph Cut. Premiere tracks faces and interpolates optical flow between the two shots of a jump cut. No
 * analysis pass exists here, so the stage estimates a coarse flow from A to B itself (block matching on 1/8-size
 * luminance, smoothed) and morphs: A warped forward along the flow, B warped backward, cross-faded — a warp-dissolve
 * that hides small jumps of a talking head on a static background. Large changes fall back to a plain dissolve.
 */
export const MORPH_CUT = defineShaderTransition({
	id: 'jasper.morph-cut',
	label: 'Morph Cut',
	bin,
	description:
		'Smooths a jump cut between two similar shots (a talking head): estimates the motion between the clips and morphs one into the other.',
	keywords: ['morph', 'jump cut', 'interview', 'optical flow', 'smooth', 'warp'],
	options: { reverse: false },
	gpu: {
		passes: (): ShaderPass[] => [
			{
				// Luminance of both sides at 1/8 size, box-filtered (r = A, g = B, b = coverage of A, a = 1).
				output: 'mcLuma',
				scale: 0.125,
				include: [GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  vec2 st = 1.0 / u_resolution / 4.0;
  float la = 0.0, lb = 0.0;
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      vec2 uv = v_uv + (vec2(float(i), float(j)) - 1.5) * st;
      la += fx_luma(tr_from(uv).rgb);
      lb += fx_luma(tr_to(uv).rgb);
    }
  fragColor = vec4(la / 16.0, lb / 16.0, 0.0, 1.0);
}`,
			},
			{
				// Symmetric block matching: the displacement f (texels, |f| <= 6) with A(x − f/2) ≈ B(x + f/2), 3×3 taps 1.5
				// texels apart (a 4×4-texel patch),
				// a small penalty for long vectors and a confidence (how much better than no motion).
				output: 'mcFlow',
				scale: 0.125,
				format: 'rgba16f',
				filter: 'linear',
				frag: /* glsl */ `
const int MC_R = 6;
float mcCost(vec2 uv, vec2 f, vec2 tx) {
  float c = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j)) * 1.5 * tx;
      float a = texture(u_mcLuma, uv + o - 0.5 * f * tx).r;
      float b = texture(u_mcLuma, uv + o + 0.5 * f * tx).g;
      c += abs(a - b);
    }
  return c / 9.0;
}
void main() {
  vec2 tx = u_texel;
  float zero = mcCost(v_uv, vec2(0.0), tx);
  float best = zero;
  vec2 bf = vec2(0.0);
  for (int y = -MC_R; y <= MC_R; y++)
    for (int x = -MC_R; x <= MC_R; x++) {
      vec2 f = vec2(float(x), float(y));
      float c = mcCost(v_uv, f, tx) + 0.004 * length(f);
      if (c < best) { best = c; bf = f; }
    }
  // Confidence: the patch has structure (flat areas say nothing about motion) and the match explains the change.
  float contrast = 0.0;
  float c0 = texture(u_mcLuma, v_uv).r;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) contrast += abs(texture(u_mcLuma, v_uv + vec2(float(i), float(j)) * 1.5 * tx).r - c0);
  float conf = clamp(contrast / 9.0 * 12.0, 0.0, 1.0) * clamp(1.0 - best * 6.0, 0.0, 1.0);
  // Flow in frame uv units, weighted by confidence (the blur then averages vectors by confidence).
  vec2 fu = bf * tx;
  fragColor = vec4(fu * conf, conf, 1.0);
}`,
			},
			...gaussianBlurPasses({ input: 'mcFlow', output: 'mcSmooth', sigma: 24, scale: 0.125, format: 'rgba16f' }),
			{
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 fl = texture(u_mcSmooth, v_uv);
  vec2 f = fl.b > 1e-3 ? fl.rg / fl.b : vec2(0.0);
  f *= clamp(fl.b * 2.0, 0.0, 1.0);
  // At time p the pixel came from A at x − p·f and goes to B at x + (1 − p)·f.
  vec4 a = tr_from(v_uv - p * f);
  vec4 b = tr_to(v_uv + (1.0 - p) * f);
  fragColor = mix(a, b, tr_smoother(p));
}`,
			},
		],
	},
});

export const PREMIERE_DISSOLVES: readonly TransitionSpec[] = [
	ADDITIVE_DISSOLVE,
	DIP_TO_WHITE,
	FILM_DISSOLVE,
	MORPH_CUT,
	NON_ADDITIVE_DISSOLVE,
];
