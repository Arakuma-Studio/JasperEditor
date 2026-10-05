// Effect family "sapphire-time-flicker" (fx catalogue, wave 2). Sapphire-style time effects (freeze frame, retime, reverse, jitter frames, random edits, trails, time average, echo, time displace, feedback) and flicker, using `gpu.time` hooks.
// Owner: the wave-2 agent of this family; this is the ONLY file it edits (plus its tests). Entries are built with
// `defineShaderEffect` (../fx/define.ts); ids start with `jasper.s.`; Effects-panel bins: SAPPHIRE_BINS.time.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';

export const SAPPHIRE_TIME_FLICKER_EFFECTS: readonly EffectSpec[] = [];
