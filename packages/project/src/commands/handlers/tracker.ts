// Tracking commands (M2, S09:TRK-*): tracker.add / update / remove / setSamples / apply.
// Owner: wp-m2-track. Stubs until that work package lands (ARCHITECTURE §19.8).
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'wp-m2-track';

export const trackerHandlers: HandlerMap = {
	'tracker.add': notImplemented('tracker.add', OWNER),
	'tracker.update': notImplemented('tracker.update', OWNER),
	'tracker.remove': notImplemented('tracker.remove', OWNER),
	'tracker.setSamples': notImplemented('tracker.setSamples', OWNER),
	'tracker.apply': notImplemented('tracker.apply', OWNER),
};
