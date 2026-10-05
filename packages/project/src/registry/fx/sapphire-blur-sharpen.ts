// Effect family "sapphire-blur-sharpen" (fx catalogue, wave 2). Sapphire-style blurs and sharpening: blurs, directional/zoom/radial blurs, defocus/bokeh, sharpen.
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.blurSharpen.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const SAPPHIRE_BLUR_SHARPEN_EFFECTS: readonly EffectSpec[] = [];
