// Keyframe handlers owned by WP-2D (ARCHITECTURE §5.3, S01 §12). Stubs until WP-2D fills them.
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'WP-2D';

export const keyframeHandlers: HandlerMap = {
	'keyframe.add': notImplemented('keyframe.add', OWNER),
	'keyframe.update': notImplemented('keyframe.update', OWNER),
	'keyframe.remove': notImplemented('keyframe.remove', OWNER),
	'keyframe.move': notImplemented('keyframe.move', OWNER),
	'keyframe.setInterpolation': notImplemented('keyframe.setInterpolation', OWNER),
	'keyframes.prune': notImplemented('keyframes.prune', OWNER),
};
