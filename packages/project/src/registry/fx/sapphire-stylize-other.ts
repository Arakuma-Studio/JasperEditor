// Effect family "sapphire-stylize-other": the Sapphire Stylize effects that are not paint,
// kaleido, edges or film-grain looks. Video Effects ▸ Sapphire Stylize ▸ S_<Name>, ids `jasper.s.<kebab>`.
// The entries live in ./sapphire-stylize-other/ (family-private modules: shared units/mask/blur helpers in common.ts);
// this file lists them in Effects-panel (alphabetical, as Sapphire) order.
// Parameters follow Boris FX's public Sapphire documentation (names, order, ranges, defaults); Mocha, preset buttons
// and the "Opacity" (premultiplication) popups are omitted — the framework is premultiplied throughout and the
// Mask input is a `media` param. Units: see ./sapphire-stylize-other/common.ts.
// Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { S_COLOR_FUSE } from './sapphire-stylize-other/color-fuse.ts';
import { S_PIXEL_MOSH, S_PIXEL_SORT } from './sapphire-stylize-other/pixel.ts';
import { S_PRISM_LENS } from './sapphire-stylize-other/prism-lens.ts';
import { S_MOSAIC, S_ROMAN_TILE, S_STRIP_SLIDE } from './sapphire-stylize-other/tiles.ts';
import {
	S_BAND_PASS,
	S_DOG_VISION,
	S_PSEUDO_COLOR,
	S_PSYKO_BLOBS,
	S_PSYKO_STRIPES,
	S_SOLARIZE,
	S_ZEBRAFY,
	S_ZEBRAFY_COLOR,
} from './sapphire-stylize-other/tone.ts';
import { S_ZFOG_EXPONENTIAL, S_ZFOG_LINEAR } from './sapphire-stylize-other/zfog.ts';

export const SAPPHIRE_STYLIZE_OTHER_EFFECTS: readonly EffectSpec[] = [
	S_BAND_PASS,
	S_COLOR_FUSE,
	S_DOG_VISION,
	S_MOSAIC,
	S_PIXEL_MOSH,
	S_PIXEL_SORT,
	S_PRISM_LENS,
	S_PSEUDO_COLOR,
	S_PSYKO_BLOBS,
	S_PSYKO_STRIPES,
	S_ROMAN_TILE,
	S_SOLARIZE,
	S_STRIP_SLIDE,
	S_ZEBRAFY,
	S_ZEBRAFY_COLOR,
	S_ZFOG_EXPONENTIAL,
	S_ZFOG_LINEAR,
];
