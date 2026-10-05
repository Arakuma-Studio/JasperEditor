// Effect family "sapphire-film-grain" (fx catalogue, wave 2): Sapphire-style film looks, grain and damage.
// Film and grain: S_FilmEffect, S_FilmDamage, S_FilmBurn, S_Vignette, S_BleachBypass, S_Grain, S_GrainStatic,
// S_UltraGrain, S_Diffuse, S_VintageColor2Strip, S_VintageColor3Strip. Damage looks: S_VHSDamage, S_DigitalDamage,
// S_JpegDamage, S_TVDamage, S_Grunge (Sapphire Render), S_ScanLines, S_ScanLinesMono.
// The entries live in ./sapphire-film-grain/ (family-private modules: shared GLSL, param builders, effects); this
// file only lists them in Effects-panel order. Parameter names, order and defaults follow Boris FX's public Sapphire
// reference; Sapphire's Mask input is replaced by "Mix with Orig". Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { DIGITAL_EFFECTS } from './sapphire-film-grain/digital.ts';
import { FILM_EFFECTS } from './sapphire-film-grain/film.ts';
import { LOOKS_EFFECTS } from './sapphire-film-grain/looks.ts';
import { VIDEO_EFFECTS } from './sapphire-film-grain/video.ts';

export const SAPPHIRE_FILM_GRAIN_EFFECTS: readonly EffectSpec[] = [...FILM_EFFECTS, ...LOOKS_EFFECTS, ...VIDEO_EFFECTS, ...DIGITAL_EFFECTS];
