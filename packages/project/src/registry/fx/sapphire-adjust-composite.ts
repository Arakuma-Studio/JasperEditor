// Effect family "sapphire-adjust-composite" (fx catalogue, wave 2). Sapphire-style adjust and composite effects (colour adjustments, gradients over the image, mattes, composites).
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.adjust / SAPPHIRE_BINS.composite.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const SAPPHIRE_ADJUST_COMPOSITE_EFFECTS: readonly EffectSpec[] = [];
