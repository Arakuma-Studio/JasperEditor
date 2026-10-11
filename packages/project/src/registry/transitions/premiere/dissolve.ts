// Premiere ▸ Video Transitions ▸ Dissolve (part of the premiere-transitions family). Cross Dissolve and Dip to Black
// are the native built-ins (../../../transitions.ts) and are not duplicated here.
import type { TransitionSpec } from '../../../transitions.ts';
import { GLSL_COLOR } from '../../fx/glsl/color.ts';
import { defineShaderTransition, TRANSITION_BINS } from '../define.ts';
import { MORPH_CUT } from './morph-cut.ts';

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
		'A non-additive mix: wherever the incoming clip is brighter it shows, based on luminance, so its highlights appear first and the frame never brightens.',
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

export const PREMIERE_DISSOLVES: readonly TransitionSpec[] = [
	ADDITIVE_DISSOLVE,
	DIP_TO_WHITE,
	FILM_DISSOLVE,
	MORPH_CUT,
	NON_ADDITIVE_DISSOLVE,
];
