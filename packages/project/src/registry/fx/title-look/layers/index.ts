// The layer types of a look (§5.1). Adding one: a file like `rim.ts` and one line here.
import type { TitleLayerInit } from '../contract.ts';
import { CONTOUR_LINES_LAYER } from './contour-lines.ts';
import { DEEP_GLOW_LAYER } from './deep-glow.ts';
import { EXTRUDE_LAYER } from './extrude.ts';
import { FACE_LAYER } from './face.ts';
import { GLOSS_LAYER } from './gloss.ts';
import { GLOW_LAYER } from './glow.ts';
import { GRADIENT_OVERLAY_LAYER } from './gradient-overlay.ts';
import { INNER_GLOW_LAYER } from './inner-glow.ts';
import { INNER_SHADOW_LAYER } from './inner-shadow.ts';
import { INLINE_LAYER } from './inline.ts';
import { PLATE_LAYER } from './plate.ts';
import { REFLECTION_LAYER } from './reflection.ts';
import { RIM_LAYER } from './rim.ts';
import { SHADOW_LAYER } from './shadow.ts';
import { SHEEN_LAYER } from './sheen.ts';
import { TEXTURE_LAYER } from './texture.ts';

export const TITLE_LAYER_INITS: readonly TitleLayerInit[] = [
	FACE_LAYER,
	RIM_LAYER,
	SHADOW_LAYER,
	GLOW_LAYER,
	INNER_SHADOW_LAYER,
	INNER_GLOW_LAYER,
	DEEP_GLOW_LAYER,
	REFLECTION_LAYER,
	CONTOUR_LINES_LAYER,
	EXTRUDE_LAYER,
	GRADIENT_OVERLAY_LAYER,
	INLINE_LAYER,
	PLATE_LAYER,
	SHEEN_LAYER,
	GLOSS_LAYER,
	TEXTURE_LAYER,
];
