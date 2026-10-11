// Effect family "sapphire-render-textures": Sapphire Render generators — lightning (S_Zap,
// S_UltraZap, S_ZapTo, S_ZapFrom), gradients/grid/shape and the other render effects (aurora, laser beam, moon, muzzle
// flash, night sky, caustics, dust, sparkles). Entries live in ./sapphire-render-lightning/ (family-private helpers
// and GLSL); ids start with `jasper.s.`; Effects-panel bin: SAPPHIRE_BINS.render.
// Authoring guide: docs/wp-notes/fx-shader-framework.md. The catalogue test checks every entry (validateGpuEffect).
import type { EffectSpec } from '../effects.ts';
import { SAPPHIRE_GRADIENT_SHAPE_EFFECTS } from './sapphire-render-lightning/gradients.ts';
import { SAPPHIRE_LIGHTNING_EFFECTS } from './sapphire-render-lightning/lightning.ts';
import { SAPPHIRE_RENDER_LIGHT_EFFECTS } from './sapphire-render-lightning/render-light.ts';
import { SAPPHIRE_RENDER_SKY_EFFECTS } from './sapphire-render-lightning/render-sky.ts';

export const SAPPHIRE_RENDER_TEXTURES_EFFECTS: readonly EffectSpec[] = [
	...SAPPHIRE_LIGHTNING_EFFECTS,
	...SAPPHIRE_GRADIENT_SHAPE_EFFECTS,
	...SAPPHIRE_RENDER_LIGHT_EFFECTS,
	...SAPPHIRE_RENDER_SKY_EFFECTS,
];
