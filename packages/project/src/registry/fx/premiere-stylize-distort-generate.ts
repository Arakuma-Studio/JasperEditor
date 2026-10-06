// Effect family "premiere-stylize-distort-generate" (fx catalogue, wave 2): Premiere Pro's standard Video Effects of
// the Distort, Generate, Noise & Grain, Stylize, Time, Video and Transition bins, plus a standalone Vignette (the
// Lumetri vignette) and a modern Glow. Ids `jasper.<kebab>`; Effects-panel folders = categories (no bin).
// The entries live in one file per Premiere bin under ./premiere-stylize-distort-generate/ (family-private helpers
// and GLSL in common.ts); this file is the family's single export.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';
import { PSDG_DISTORT_EFFECTS } from './premiere-stylize-distort-generate/distort.ts';
import { PSDG_GENERATE_EFFECTS } from './premiere-stylize-distort-generate/generate.ts';
import { PSDG_GENERATE_RENDER_EFFECTS } from './premiere-stylize-distort-generate/generate-render.ts';
import { PSDG_LIGHT_EFFECTS } from './premiere-stylize-distort-generate/light.ts';
import { PSDG_NOISE_GRAIN_EFFECTS } from './premiere-stylize-distort-generate/noise-grain.ts';
import { PSDG_STYLIZE_EFFECTS } from './premiere-stylize-distort-generate/stylize.ts';
import { PSDG_STYLIZE_2_EFFECTS } from './premiere-stylize-distort-generate/stylize-2.ts';
import { PSDG_TIME_EFFECTS } from './premiere-stylize-distort-generate/time.ts';
import { PSDG_TRANSITION_EFFECTS } from './premiere-stylize-distort-generate/transition.ts';
import { PSDG_VIDEO_EFFECTS } from './premiere-stylize-distort-generate/video.ts';

export const PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS: readonly EffectSpec[] = [
	...PSDG_DISTORT_EFFECTS,
	...PSDG_GENERATE_EFFECTS,
	...PSDG_GENERATE_RENDER_EFFECTS,
	...PSDG_NOISE_GRAIN_EFFECTS,
	...PSDG_STYLIZE_EFFECTS,
	...PSDG_STYLIZE_2_EFFECTS,
	...PSDG_TIME_EFFECTS,
	...PSDG_VIDEO_EFFECTS,
	...PSDG_TRANSITION_EFFECTS,
	...PSDG_LIGHT_EFFECTS,
];
