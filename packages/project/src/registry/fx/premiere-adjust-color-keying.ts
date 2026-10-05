// Effect family "premiere-adjust-color-keying" (fx catalogue, wave 2). Premiere standard effects: Adjust, Color Correction and Keying (e.g. Invert, Tint, Levels-style adjustments, Color Key, Ultra Key).
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.`; Effects-panel bins: category folders (Adjust, Color Correction, Keying); no bin.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const PREMIERE_ADJUST_COLOR_KEYING_EFFECTS: readonly EffectSpec[] = [];
