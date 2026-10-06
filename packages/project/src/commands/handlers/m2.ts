// Declared commands that still return E_NOT_IMPLEMENTED.
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'M2';

export const m2Handlers: HandlerMap = {
	'clip.nest': notImplemented('clip.nest', OWNER),
	'clip.addAdjustment': notImplemented('clip.addAdjustment', OWNER),
	'clip.group': notImplemented('clip.group', OWNER),
	'clip.ungroup': notImplemented('clip.ungroup', OWNER),
	'synthetic.create': notImplemented('synthetic.create', OWNER),
	'synthetic.update': notImplemented('synthetic.update', OWNER),
	'media.removeUnused': notImplemented('media.removeUnused', OWNER),
	'sequence.duplicate': notImplemented('sequence.duplicate', OWNER),
	'sequence.delete': notImplemented('sequence.delete', OWNER),
};
