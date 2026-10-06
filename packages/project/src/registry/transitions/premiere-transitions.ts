// Transition family "premiere-transitions" (transition framework, wave 3): Premiere's standard video transitions —
// 3D Motion, Dissolve, Iris, Page Peel, Slide, Wipe, Zoom bins (TRANSITION_BINS). Ids `jasper.<kebab>`. The built-in
// Cross Dissolve and Dip to Black (native ffmpeg path) live in ../../transitions.ts and are not duplicated here.
// Owner: the wave-3 agent of this family; this file plus its private helpers in ./premiere/ (one module per bin)
// and its tests. Entries are built with `defineShaderTransition` (./define.ts). Authoring guide: docs/wp-notes/fx-transition-framework.md. The transition
// catalogue test checks every entry (validateGpuTransition) and the GL test compiles and runs each one.
// Import rule (no cycles): values only from ./define.ts, ./glsl.ts, ./shader.ts and ../fx/*; types from
// ../../transitions.ts and ../effects.ts (`import type`).
import type { TransitionSpec } from '../../transitions.ts';
import type { EffectParams } from '../effects.ts';
import { fxParam } from '../fx/params.ts';
import { defineShaderTransition, TRANSITION_BINS } from './define.ts';
import { GLSL_TR_EASE, GLSL_TR_WIPE } from './glsl.ts';
import { PREMIERE_DISSOLVES } from './premiere/dissolve.ts';
import { PREMIERE_IRISES } from './premiere/iris.ts';
import { MODERN_ANIMATION } from './premiere/modern-animation.ts';
import { MODERN_DISSOLVES } from './premiere/modern-dissolve.ts';
import { MODERN_GRUNGE } from './premiere/modern-grunge.ts';
import { MODERN_LIGHTS } from './premiere/modern-lights.ts';
import { MODERN_SLIDES } from './premiere/modern-slide.ts';
import { MODERN_TRANSFORMERS } from './premiere/modern-transformers.ts';
import { MODERN_WIPES } from './premiere/modern-wipe.ts';
import { PREMIERE_3D_MOTION } from './premiere/motion3d.ts';
import { PREMIERE_PAGE_PEELS } from './premiere/page.ts';
import { PREMIERE_SLIDES } from './premiere/slide.ts';
import { PREMIERE_VR } from './premiere/vr.ts';
import { PREMIERE_WIPES } from './premiere/wipe.ts';

/** Premiere's edge selectors of the slide family (the direction the incoming clip travels). */
const PUSH_DIRECTIONS = ['westToEast', 'eastToWest', 'northToSouth', 'southToNorth'] as const;
const PUSH_DIRECTION_LABELS = ['West to East', 'East to West', 'North to South', 'South to North'] as const;
const PUSH_VECTORS: Record<string, [number, number]> = {
	westToEast: [1, 0],
	eastToWest: [-1, 0],
	northToSouth: [0, 1],
	southToNorth: [0, -1],
};
const pushDir = (p: EffectParams): [number, number] => PUSH_VECTORS[String(p.direction)] ?? [1, 0];

/** Slide ▸ Push: the incoming clip pushes the outgoing clip out of the frame. */
export const PUSH = defineShaderTransition({
	id: 'jasper.push',
	label: 'Push',
	bin: TRANSITION_BINS.slide,
	description:
		'The incoming clip slides in from one edge and pushes the outgoing clip out of the opposite edge.',
	keywords: ['slide', 'push', 'move'],
	params: [fxParam.choice('direction', 'Direction', PUSH_DIRECTIONS, PUSH_DIRECTION_LABELS, 'westToEast')],
	options: { border: true, antiAliasing: true },
	gpu: {
		uniforms: (p) => ({ u_pushDir: pushDir(p) }),
		passes: [
			{
				include: [GLSL_TR_WIPE],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec2 d = u_pushDir;
  // Both pictures move along d by p frames; B follows one frame behind A.
  vec4 a = tr_from(v_uv - d * p);
  vec4 b = tr_to(v_uv - d * (p - 1.0));
  // Signed distance (px) from the seam into B, along the motion (B occupies t < p).
  float t = dot(v_uv - 0.5, d) + 0.5;
  float ext = abs(dot(u_compSize, d));
  float aa = tr_aaWidth(u_antiAliasing);
  fragColor = tr_wipeMix(a, b, (p - t) * ext, 0.0, aa, u_borderWidth, u_borderColor);
}`,
			},
		],
	},
});

/** Zoom ▸ Cross Zoom: zooms into the outgoing clip, then out of the incoming clip, with a zoom blur. */
export const CROSS_ZOOM = defineShaderTransition({
	id: 'jasper.cross-zoom',
	label: 'Cross Zoom',
	bin: TRANSITION_BINS.zoom,
	description: 'Zooms into the outgoing clip and out of the incoming clip, with a zoom blur at the switch.',
	keywords: ['zoom', 'blur', 'punch'],
	params: [
		fxParam.number('zoom', 'Zoom', 4, { min: 1, max: 20, softMax: 10, step: 0.1 }),
		fxParam.percent('blur', 'Blur', 60),
	],
	options: { center: true },
	gpu: {
		passes: [
			{
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
const int TR_CZ_TAPS = 24;
// Zoom-blurred samples of a side: taps from uv towards the centre c.
vec4 czFrom(vec2 uv, vec2 c, float blur) {
  vec4 s = vec4(0.0);
  for (int i = 0; i < TR_CZ_TAPS; i++) s += tr_from(c + (uv - c) * (1.0 - blur * float(i) / float(TR_CZ_TAPS - 1)));
  return s / float(TR_CZ_TAPS);
}
vec4 czTo(vec2 uv, vec2 c, float blur) {
  vec4 s = vec4(0.0);
  for (int i = 0; i < TR_CZ_TAPS; i++) s += tr_to(c + (uv - c) * (1.0 - blur * float(i) / float(TR_CZ_TAPS - 1)));
  return s / float(TR_CZ_TAPS);
}
void main() {
  float p = tr_progress();
  vec2 c = u_center;
  float z = max(u_zoom, 1.0);
  // A: 1 → z over the first half (accelerating); B: z → 1 over the second half (decelerating).
  float za = mix(1.0, z, tr_easeIn(tr_phase(p, 0.0, 0.5)));
  float zb = mix(z, 1.0, tr_easeOut(tr_phase(p, 0.5, 1.0)));
  // The blur follows the zoom speed: strongest at the switch.
  float blur = (u_blur / 100.0) * 0.35 * sin(3.14159265 * p);
  vec4 a = czFrom(c + (v_uv - c) / za, c, blur);
  vec4 b = czTo(c + (v_uv - c) / zb, c, blur);
  fragColor = mix(a, b, smoothstep(0.42, 0.58, p));
}`,
			},
		],
	},
});

/** Iris ▸ Iris Round: the incoming clip appears in a growing circle. */
export const IRIS_ROUND = defineShaderTransition({
	id: 'jasper.iris-round',
	label: 'Iris Round',
	bin: TRANSITION_BINS.iris,
	description: 'The incoming clip is revealed through a circle that opens from the center point.',
	keywords: ['iris', 'circle', 'round', 'reveal'],
	options: { border: true, antiAliasing: true, center: true },
	gpu: {
		passes: [
			{
				include: [GLSL_TR_WIPE],
				frag: /* glsl */ `
void main() {
  vec2 px = tr_px();
  vec2 c = u_center * u_compSize;
  float aa = tr_aaWidth(u_antiAliasing);
  float r = tr_irisRadius(c, tr_progress(), u_borderWidth + aa);
  fragColor = tr_wipeMix(tr_from(v_uv), tr_to(v_uv), tr_circle(px, c, r), 0.0, aa, u_borderWidth, u_borderColor);
}`,
			},
		],
	},
});

/**
 * Premiere's video transitions, bin by bin (TRANSITION_BINS order), alphabetical inside a bin: the classic standard
 * transitions (./premiere/{motion3d,dissolve,iris,page,slide,wipe}.ts and Push / Cross Zoom / Iris Round above) and
 * the modern ones Premiere 25.5 / 26 added from Film Impact (./premiere/modern-*.ts) and the Immersive Video (VR)
 * ones (./premiere/vr.ts). Folders the framework has no bin for yet sit in MODERN_BINS (see there).
 */
export const PREMIERE_TRANSITIONS: readonly TransitionSpec[] = byBinAndLabel([
	PUSH,
	CROSS_ZOOM,
	IRIS_ROUND,
	...PREMIERE_3D_MOTION,
	...PREMIERE_DISSOLVES,
	...PREMIERE_IRISES,
	...PREMIERE_PAGE_PEELS,
	...PREMIERE_SLIDES,
	...PREMIERE_WIPES,
	...MODERN_DISSOLVES,
	...MODERN_SLIDES,
	...MODERN_WIPES,
	...MODERN_ANIMATION,
	...MODERN_GRUNGE,
	...MODERN_LIGHTS,
	...MODERN_TRANSFORMERS,
	...PREMIERE_VR,
]);

function byBinAndLabel(list: readonly TransitionSpec[]): TransitionSpec[] {
	const order: string[] = Object.values(TRANSITION_BINS);
	return [...list].sort(
		(a, b) => order.indexOf(a.bin) - order.indexOf(b.bin) || a.label.localeCompare(b.label, 'en'),
	);
}
