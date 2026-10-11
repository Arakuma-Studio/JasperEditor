// Test-only specs must stay identical to docs/wp-notes/fx-transition-framework.md §2 and §8.
import {
	defineShaderTransition,
	fxParam,
	GLSL_COLOR,
	GLSL_TR_EASE,
	GLSL_TR_WIPE,
	gaussianBlurPasses,
	SAPPHIRE_TRANSITION_SUBBINS,
	type ShaderPass,
	TRANSITION_BINS,
	type TransitionSpec,
} from '@jasper/project';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const TEST_CLOCK_WIPE = defineShaderTransition({
	id: 'test.clock-wipe',
	label: 'Clock Wipe',
	bin: TRANSITION_BINS.wipe,
	description: 'The incoming clip is revealed by a hand sweeping around the center, like a clock.',
	keywords: ['clock', 'radial', 'sweep'],
	params: [fxParam.angle('startAngle', 'Start Angle', -90)],
	options: { border: true, antiAliasing: true, center: true },
	gpu: {
		passes: [
			{
				include: [GLSL_TR_WIPE],
				frag: /* glsl */ `
void main() {
  vec2 c = u_center * u_compSize;
  float aa = tr_aaWidth(u_antiAliasing);
  // Overshoot the sweep a little so the soft edge and the border have left the frame at progress 1.
  float p = tr_progress() * (1.0 + (u_borderWidth + aa) / (6.2832 * tr_coverRadius(c)));
  float d = tr_clockWipe(tr_px(), c, p, u_startAngle);
  fragColor = tr_wipeMix(tr_from(v_uv), tr_to(v_uv), d, 0.0, aa, u_borderWidth, u_borderColor);
}`,
			},
		],
	},
});

/**
 * Guide §8: a two-pass Sapphire-style dissolve that needs both sides (S_DissolveGlow-like): A and B are blurred
 * and brightened towards the middle of the transition, then cross-faded.
 */
const TEST_DISSOLVE_GLOW = defineShaderTransition({
	id: 'test.s.dissolve-glow',
	label: 'S_DissolveGlow (example)',
	bin: TRANSITION_BINS.sapphire,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.dissolves,
	description: 'Dissolves through a glow: both clips bloom towards the middle of the transition.',
	params: [
		fxParam.pixels('glowWidth', 'Glow Width', 30, 200),
		fxParam.number('brightness', 'Brightness', 1.5, { min: 0, max: 10, step: 0.01 }),
	],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				// The cross-faded picture, at half resolution: the glow source.
				output: 'mixed',
				scale: 0.5,
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
void main() {
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), tr_easeInOut(tr_progress()));
}`,
			},
			...gaussianBlurPasses({ input: 'mixed', output: 'glow', sigma: num(p.glowWidth, 30), scale: 0.5 }),
			{
				include: [GLSL_TR_EASE, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), tr_easeInOut(p));
  float k = sin(3.14159265 * p) * u_brightness;   // 0 at both ends: exactly A, then exactly B
  vec4 g = texture(u_glow, v_uv);
  fragColor = vec4(min(base.rgb + g.rgb * k, vec3(base.a + g.a * k)), min(1.0, base.a + g.a * k));
}`,
			},
		],
	},
});

export const TEST_TRANSITIONS: readonly TransitionSpec[] = [TEST_CLOCK_WIPE, TEST_DISSOLVE_GLOW];
