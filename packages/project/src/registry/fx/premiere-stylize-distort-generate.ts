// Effect family "premiere-stylize-distort-generate" (fx catalogue, wave 2). Premiere standard effects: Stylize, Distort, Generate, Transform, Blur & Sharpen (e.g. Sharpen, Drop Shadow, Vignette, Transform, Mosaic, Glow).
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.`; Effects-panel bins: category folders (Stylize, Distort, Generate, Transform, Blur & Sharpen); no bin.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS: readonly EffectSpec[] = [];
