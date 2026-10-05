// Effect family "sapphire-render-textures" (fx catalogue, wave 2). Sapphire-style generators: gradients, procedural textures, clouds, lightning, grids (`gpu.kind: 'generator'`).
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.render.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const SAPPHIRE_RENDER_TEXTURES_EFFECTS: readonly EffectSpec[] = [];
