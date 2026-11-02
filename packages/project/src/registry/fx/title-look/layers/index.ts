// The layer types of a look (§5.1). Adding one: a file like `rim.ts` and one line here.
import type { TitleLayerInit } from '../contract.ts';
import { FACE_LAYER } from './face.ts';
import { GLOSS_LAYER } from './gloss.ts';
import { GLOW_LAYER } from './glow.ts';
import { INLINE_LAYER } from './inline.ts';
import { PLATE_LAYER } from './plate.ts';
import { RIM_LAYER } from './rim.ts';
import { SHADOW_LAYER } from './shadow.ts';
import { SHEEN_LAYER } from './sheen.ts';
import { TEXTURE_LAYER } from './texture.ts';

export const TITLE_LAYER_INITS: readonly TitleLayerInit[] = [
	FACE_LAYER,
	RIM_LAYER,
	SHADOW_LAYER,
	GLOW_LAYER,
	INLINE_LAYER,
	PLATE_LAYER,
	SHEEN_LAYER,
	GLOSS_LAYER,
	TEXTURE_LAYER,
];
