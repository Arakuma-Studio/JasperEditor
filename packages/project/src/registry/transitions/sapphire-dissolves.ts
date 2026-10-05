// Transition family "sapphire-dissolves" (transition framework, wave 3): Sapphire-style dissolves (S_Dissolve*:
// luma, glow, blur, speckle, …). Ids `jasper.s.<kebab>`; bin TRANSITION_BINS.sapphire, sub-bin
// SAPPHIRE_TRANSITION_SUBBINS.dissolves.
// Owner: the wave-3 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderTransition` (./define.ts). Authoring guide: docs/wp-notes/fx-transition-framework.md.
// Import rule (no cycles): values only from ./define.ts, ./glsl.ts, ./shader.ts and ../fx/*; types from
// ../../transitions.ts and ../effects.ts (`import type`).
import type { TransitionSpec } from '../../transitions.ts';
import { GLSL_COLOR } from '../fx/glsl/color.ts';
import { fxParam } from '../fx/params.ts';
import { gaussianBlurPasses } from '../fx/passes.ts';
import type { ShaderPass } from '../fx/shader.ts';
import { defineShaderTransition, SAPPHIRE_TRANSITION_SUBBINS, TRANSITION_BINS } from './define.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * S_DissolveLuma: the pixels switch from A to B in the order of the brightness of one of the clips (bright first),
 * through a soft band. Needs both sides in one shader: the luma of A decides where B shows.
 */
export const S_DISSOLVE_LUMA = defineShaderTransition({
	id: 'jasper.s.dissolve-luma',
	label: 'S_DissolveLuma',
	bin: TRANSITION_BINS.sapphire,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.dissolves,
	description:
		'Dissolves by brightness: the bright areas of the chosen clip switch first, through a soft band (luma wipe).',
	keywords: ['luma', 'luminance', 'dissolve', 'wipe', 'brightness'],
	params: [
		fxParam.choice('lumaFrom', 'Luma From', ['from', 'to'], ['Outgoing Clip', 'Incoming Clip'], 'from'),
		fxParam.number('width', 'Dissolve Width', 0.25, { min: 0.001, max: 1, step: 0.01 }),
		fxParam.toggle('invert', 'Invert Luma', false),
		fxParam.pixels('blurLuma', 'Blur Luma', 4, 100),
	],
	gpu: {
		passes: (p): ShaderPass[] => {
			const blur = num(p.blurLuma, 4);
			const passes: ShaderPass[] = [
				{
					// The luma map of the chosen side (half resolution is plenty for a soft threshold).
					output: 'luma',
					scale: 0.5,
					include: [GLSL_COLOR],
					frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(u_lumaFrom == 0 ? tr_from(v_uv) : tr_to(v_uv));
  fragColor = vec4(vec3(fx_luma(c.rgb) * c.a), 1.0);
}`,
				},
			];
			if (blur > 0)
				passes.push(...gaussianBlurPasses({ input: 'luma', output: 'lumaBlur', sigma: blur, scale: 0.5 }));
			const map = blur > 0 ? 'u_lumaBlur' : 'u_luma';
			passes.push({
				frag: /* glsl */ `
void main() {
  float l = texture(${map}, v_uv).r;
  if (u_invert) l = 1.0 - l;
  float w = clamp(u_width, 0.001, 1.0);
  // Bright first: a pixel of luma l switches when the moving threshold passes 1 − l; the band is w wide.
  float m = smoothstep(1.0 - l, 1.0 - l + w, tr_progress() * (1.0 + w));
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), m);
}`,
			});
			return passes;
		},
	},
});

export const SAPPHIRE_DISSOLVE_TRANSITIONS: readonly TransitionSpec[] = [S_DISSOLVE_LUMA];
