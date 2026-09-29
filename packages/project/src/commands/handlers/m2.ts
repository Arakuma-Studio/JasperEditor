// Commands scheduled for milestone M2 (ARCHITECTURE §5.3): schemas are defined so agents see them,
// handlers refuse with E_NOT_IMPLEMENTED until their milestone.
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'M2';

export const m2Handlers: HandlerMap = {
	'clip.nest': notImplemented('clip.nest', OWNER),
	'clip.addCaptions': notImplemented('clip.addCaptions', OWNER),
	'clip.addComposition': notImplemented('clip.addComposition', OWNER),
	'clip.addAdjustment': notImplemented('clip.addAdjustment', OWNER),
	'clip.replaceSource': notImplemented('clip.replaceSource', OWNER),
	'clip.group': notImplemented('clip.group', OWNER),
	'clip.ungroup': notImplemented('clip.ungroup', OWNER),
	'transcript.create': notImplemented('transcript.create', OWNER),
	'transcript.editText': notImplemented('transcript.editText', OWNER),
	'transcript.setBreak': notImplemented('transcript.setBreak', OWNER),
	'synthetic.create': notImplemented('synthetic.create', OWNER),
	'synthetic.update': notImplemented('synthetic.update', OWNER),
	'media.derive': notImplemented('media.derive', OWNER),
	'media.removeUnused': notImplemented('media.removeUnused', OWNER),
	'sequence.duplicate': notImplemented('sequence.duplicate', OWNER),
	'sequence.delete': notImplemented('sequence.delete', OWNER),
};
