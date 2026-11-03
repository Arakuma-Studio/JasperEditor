// The fx catalogue and the GPU shader-effect framework (docs/wp-notes/fx-shader-framework.md). Every family
// file exports one `readonly EffectSpec[]`; `FX_EFFECTS` concatenates them in Effects-panel order and is part of
// `defaultEffectRegistry` (registry/effects.ts), hence of the Effects panel, Effect Controls, the agent schema export
// (MCP) and the engine. Adding an effect = adding an entry to its family file; nothing else changes.
// Import rule (no cycles): family files import from `./define.ts`, `./params.ts`, `./passes.ts`, `./shader.ts`,
// `./motion-blur.ts`, `./glsl/*` and only TYPES from `../effects.ts`.
import type { EffectSpec } from '../effects.ts';
import { KEYING_MATTE_EFFECTS } from './keying-matte.ts';
import { OBJECT_MATTE_EFFECTS } from './object-matte.ts';
import { PREMIERE_ADJUST_COLOR_KEYING_EFFECTS } from './premiere-adjust-color-keying.ts';
import { PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS } from './premiere-stylize-distort-generate.ts';
import { SAPPHIRE_ADJUST_COMPOSITE_EFFECTS } from './sapphire-adjust-composite.ts';
import { SAPPHIRE_BLUR_SHARPEN_EFFECTS } from './sapphire-blur-sharpen.ts';
import { SAPPHIRE_DISTORT_WARP_EFFECTS } from './sapphire-distort-warp.ts';
import { SAPPHIRE_FILM_GRAIN_EFFECTS } from './sapphire-film-grain.ts';
import { SAPPHIRE_GLOWS_LIGHTING_EFFECTS } from './sapphire-glows-lighting.ts';
import { SAPPHIRE_PAINT_KALEIDO_EDGES_EFFECTS } from './sapphire-paint-kaleido-edges.ts';
import { SAPPHIRE_RENDER_TEXTURES_EFFECTS } from './sapphire-render-textures.ts';
import { SAPPHIRE_STYLIZE_OTHER_EFFECTS } from './sapphire-stylize-other.ts';
import { SAPPHIRE_TEXTURES_CLOUDS_EFFECTS } from './sapphire-textures-clouds.ts';
import { SAPPHIRE_TIME_FLICKER_EFFECTS } from './sapphire-time-flicker.ts';
import { SIMULATION_WARP_EFFECTS } from './simulation-warp.ts';
import { TEXT_WARP_EFFECTS } from './text-warp.ts';
import { TITLE_LOOK_EFFECT } from './title-look/effect.ts';
import { TITLE_LOOK_EFFECTS } from './title-look/effects/index.ts';
import { TITLE_GENERATOR_EFFECTS } from './title-look/registry.ts';
import { WARP_STABILIZER_EFFECTS } from './warp-stabilizer.ts';

export * from './define.ts';
export * from './glsl/index.ts';
export * from './motion-blur.ts';
export * from './params.ts';
export * from './passes.ts';
export * from './shader.ts';
export * from './simulation-warp/meshes.ts';
export * from './text-warp/mesh.ts';
export * from './text-warp.ts';
export * from './title-look/index.ts';

/** The families, with the id prefix every entry of a family uses (checked by the catalogue test). */
export const FX_FAMILIES: readonly { file: string; idPrefix: string; effects: readonly EffectSpec[] }[] = [
	{
		file: 'premiere-adjust-color-keying',
		idPrefix: 'jasper.',
		effects: PREMIERE_ADJUST_COLOR_KEYING_EFFECTS,
	},
	{
		file: 'premiere-stylize-distort-generate',
		idPrefix: 'jasper.',
		effects: PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS,
	},
	{ file: 'sapphire-glows-lighting', idPrefix: 'jasper.s.', effects: SAPPHIRE_GLOWS_LIGHTING_EFFECTS },
	{
		file: 'sapphire-paint-kaleido-edges',
		idPrefix: 'jasper.s.',
		effects: SAPPHIRE_PAINT_KALEIDO_EDGES_EFFECTS,
	},
	{ file: 'sapphire-film-grain', idPrefix: 'jasper.s.', effects: SAPPHIRE_FILM_GRAIN_EFFECTS },
	{ file: 'sapphire-stylize-other', idPrefix: 'jasper.s.', effects: SAPPHIRE_STYLIZE_OTHER_EFFECTS },
	{ file: 'sapphire-adjust-composite', idPrefix: 'jasper.s.', effects: SAPPHIRE_ADJUST_COMPOSITE_EFFECTS },
	{ file: 'sapphire-blur-sharpen', idPrefix: 'jasper.s.', effects: SAPPHIRE_BLUR_SHARPEN_EFFECTS },
	{ file: 'sapphire-distort-warp', idPrefix: 'jasper.s.', effects: SAPPHIRE_DISTORT_WARP_EFFECTS },
	{ file: 'sapphire-render-textures', idPrefix: 'jasper.s.', effects: SAPPHIRE_RENDER_TEXTURES_EFFECTS },
	{ file: 'sapphire-textures-clouds', idPrefix: 'jasper.s.', effects: SAPPHIRE_TEXTURES_CLOUDS_EFFECTS },
	{ file: 'sapphire-time-flicker', idPrefix: 'jasper.s.', effects: SAPPHIRE_TIME_FLICKER_EFFECTS },
	{ file: 'object-matte', idPrefix: 'jasper.', effects: OBJECT_MATTE_EFFECTS },
	{ file: 'keying-matte', idPrefix: 'jasper.', effects: KEYING_MATTE_EFFECTS },
	{ file: 'simulation-warp', idPrefix: 'jasper.', effects: SIMULATION_WARP_EFFECTS },
	{ file: 'warp-stabilizer', idPrefix: 'jasper.', effects: WARP_STABILIZER_EFFECTS },
	{ file: 'title-look', idPrefix: 'jasper.', effects: [TITLE_LOOK_EFFECT, ...TITLE_GENERATOR_EFFECTS] },
	{ file: 'text-warp', idPrefix: 'jasper.', effects: TEXT_WARP_EFFECTS },
	{ file: 'title-look-effects', idPrefix: 'jasper.', effects: TITLE_LOOK_EFFECTS },
];

/** Every fx-catalogue effect (registered by default). */
export const FX_EFFECTS: readonly EffectSpec[] = FX_FAMILIES.flatMap((f) => f.effects);
