// Motion-graphics composition clips (M2, S08:MGC-030…): clip.addComposition places a composition of an
// `mg-bundle` asset; its props are edited with clip.update `{props}` / param.set `props.<name>`.
// Owner: wp-m2-mg. Stub until that work package lands (ARCHITECTURE §19.8).
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'wp-m2-mg';

export const compositionHandlers: HandlerMap = {
	'clip.addComposition': notImplemented('clip.addComposition', OWNER),
};
