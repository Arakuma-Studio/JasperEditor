// Effect stack handlers owned by WP-2D (ARCHITECTURE §5.3, S01 §11.3). Stubs until WP-2D fills them.
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'WP-2D';

export const effectHandlers: HandlerMap = {
	'effect.add': notImplemented('effect.add', OWNER),
	'effect.remove': notImplemented('effect.remove', OWNER),
	'effect.reorder': notImplemented('effect.reorder', OWNER),
	'effect.setEnabled': notImplemented('effect.setEnabled', OWNER),
};
