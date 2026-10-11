// Effect family "sapphire-paint-kaleido-edges": Sapphire-style paint and pattern looks —
// AutoPaint and halftone (S_AutoPaint, S_Sketch, S_Etching, S_Brush:Oil/Chalk, S_Crosshatch, S_Cartoon,
// S_CartoonPaint, S_Posterize, S_HalfTone, S_HalfToneColor, S_HalfToneRings), kaleidoscopes (S_Kaleido:*,
// S_KaleidoPolar, S_KaleidoRadial, S_FlysEye*, S_TileScramble), edges (S_EdgeDetect, S_EdgeDetectDouble,
// S_EdgesInDirection, S_EdgeColorize) and emboss (S_Emboss, S_EmbossShiny, S_EmbossDistort, S_EmbossGlass).
// Every entry lives in Video Effects ▸ Sapphire Stylize, like Sapphire in Premiere. Parameter names, order, ranges
// and defaults follow Sapphire's public documentation; the units are described in ./sapphire-paint-kaleido-edges/
// common.ts (sizes in 1 % of the layer width, frequencies across the layer width). The groups live in the family's
// private folder; this file only concatenates them in Effects-panel order.
// Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { EDGES_EFFECTS } from './sapphire-paint-kaleido-edges/edges.ts';
import { EMBOSS_EFFECTS } from './sapphire-paint-kaleido-edges/emboss.ts';
import { HALFTONE_EFFECTS } from './sapphire-paint-kaleido-edges/halftone.ts';
import { KALEIDO_EFFECTS } from './sapphire-paint-kaleido-edges/kaleido.ts';
import { PAINT_EFFECTS } from './sapphire-paint-kaleido-edges/paint.ts';

export const SAPPHIRE_PAINT_KALEIDO_EDGES_EFFECTS: readonly EffectSpec[] = [
	...PAINT_EFFECTS,
	...HALFTONE_EFFECTS,
	...KALEIDO_EFFECTS,
	...EDGES_EFFECTS,
	...EMBOSS_EFFECTS,
];
