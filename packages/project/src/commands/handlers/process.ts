// Processed media (M2, S07:PRC-060…066): media.derive (register a processed version of a media asset and
// optionally swap clips to it) and clip.replaceSource (swap a clip between versions).
// Owner: wp-m2-process. Stubs until that work package lands (ARCHITECTURE §19.8).
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'wp-m2-process';

export const processHandlers: HandlerMap = {
	'media.derive': notImplemented('media.derive', OWNER),
	'clip.replaceSource': notImplemented('clip.replaceSource', OWNER),
};
