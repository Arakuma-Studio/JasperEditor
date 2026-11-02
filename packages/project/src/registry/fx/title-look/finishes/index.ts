// The finishes of a look (§5.1). Adding one: a file like `flat.ts` and one line here.
import type { TitleFinish } from '../contract.ts';
import { FINISH_FLAT } from './flat.ts';

export const TITLE_FINISHES: readonly TitleFinish[] = [FINISH_FLAT];
