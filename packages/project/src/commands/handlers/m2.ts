// Declared commands that still return E_NOT_IMPLEMENTED.
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'M2';

export const m2Handlers: HandlerMap = {
	'clip.addCaptions': notImplemented('clip.addCaptions', OWNER),
	'transcript.create': notImplemented('transcript.create', OWNER),
	'transcript.editText': notImplemented('transcript.editText', OWNER),
	'transcript.setBreak': notImplemented('transcript.setBreak', OWNER),
};
