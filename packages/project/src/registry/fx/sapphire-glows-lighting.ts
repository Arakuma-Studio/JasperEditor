// Effect family "sapphire-glows-lighting" (fx catalogue, wave 2). Sapphire-style glows and lighting: glows, lens flares, rays, glints, light leaks.
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.glows / SAPPHIRE_BINS.lighting.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const SAPPHIRE_GLOWS_LIGHTING_EFFECTS: readonly EffectSpec[] = [];
