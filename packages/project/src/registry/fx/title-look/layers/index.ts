// The layer types of a look (§5.1). Adding one: a file like `rim.ts` and one line here.
import type { TitleLayerInit } from '../contract.ts';
import { FACE_LAYER } from './face.ts';
import { GLOW_LAYER } from './glow.ts';
import { RIM_LAYER } from './rim.ts';
import { SHADOW_LAYER } from './shadow.ts';

export const TITLE_LAYER_INITS: readonly TitleLayerInit[] = [FACE_LAYER, RIM_LAYER, SHADOW_LAYER, GLOW_LAYER];
