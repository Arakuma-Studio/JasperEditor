// Effect family "sapphire-stylize-other" (fx catalogue, wave 2). Other Sapphire-style stylize effects (posterize, mosaic, cartoon, TV/scanlines, glitch…).
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.stylize.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const SAPPHIRE_STYLIZE_OTHER_EFFECTS: readonly EffectSpec[] = [];
