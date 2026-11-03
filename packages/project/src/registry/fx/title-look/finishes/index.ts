// The finishes of a look (§5.1). Adding one: a file like `flat.ts` and one line here.
import type { TitleFinish } from '../contract.ts';
import { FINISH_BEVEL } from './bevel.ts';
import { FINISH_FLAT } from './flat.ts';
import { FINISH_GLASS } from './glass.ts';
import { FINISH_GLOSS } from './gloss.ts';
import { FINISH_GRADIENT_MAP } from './gradient-map.ts';
import { FINISH_METAL } from './metal.ts';
import { FINISH_PATTERN } from './pattern.ts';
import { FINISH_REFLECTION } from './reflection.ts';
import { FINISH_SATIN } from './satin.ts';

export const TITLE_FINISHES: readonly TitleFinish[] = [
	FINISH_FLAT,
	FINISH_GRADIENT_MAP,
	FINISH_METAL,
	FINISH_GLASS,
	FINISH_PATTERN,
	FINISH_GLOSS,
	FINISH_BEVEL,
	FINISH_REFLECTION,
	FINISH_SATIN,
];
