// Advanced edit handlers owned by WP-2B (ARCHITECTURE §5.3): roll, slip, slide, speed, duplicate,
// link/unlink, fit to frame, range lift/extract, gap close. WP-00 ships stubs that refuse with
// E_NOT_IMPLEMENTED; replace each stub with the real handler (schemas live in ../schemas/clip.ts).

import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { type HandlerMap, notImplemented } from './util.ts';

const OWNER = 'WP-2B';

/** `clip.trim` with `mode: 'roll'` (S02 §11.4). Called by the core `clip.trim` handler. */
export function rollTrim(_doc: DDoc, _cmd: CommandOf<'clip.trim'>, h: HandlerContext): unknown {
	return h.fail('E_NOT_IMPLEMENTED', `clip.trim mode "roll" is not implemented yet (${OWNER})`);
}

export const clipEditHandlers: HandlerMap = {
	'clip.slip': notImplemented('clip.slip', OWNER),
	'clip.slide': notImplemented('clip.slide', OWNER),
	'clip.setSpeed': notImplemented('clip.setSpeed', OWNER),
	'clip.duplicate': notImplemented('clip.duplicate', OWNER),
	'clip.link': notImplemented('clip.link', OWNER),
	'clip.unlink': notImplemented('clip.unlink', OWNER),
	'clip.fitToFrame': notImplemented('clip.fitToFrame', OWNER),
	'range.lift': notImplemented('range.lift', OWNER),
	'range.extract': notImplemented('range.extract', OWNER),
	'gap.close': notImplemented('gap.close', OWNER),
};
