// Transitions and fades (S01 §13) — milestone M2. Schemas exist; handlers refuse with E_NOT_IMPLEMENTED.
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'M2';

export const transitionHandlers: HandlerMap = {
	'transition.add': notImplemented('transition.add', OWNER),
	'transition.update': notImplemented('transition.update', OWNER),
	'transition.remove': notImplemented('transition.remove', OWNER),
	'transition.applyDefault': notImplemented('transition.applyDefault', OWNER),
};
