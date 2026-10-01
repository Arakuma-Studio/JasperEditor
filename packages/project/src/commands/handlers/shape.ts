// Shape clips (M2, S11:SHP-001…003, ARCHITECTURE §20.1): clip.addShape and the `shape` patch of clip.update.
// Owner: wp-m2-shapes. Contracts: the command schema is registered; the handlers answer E_NOT_IMPLEMENTED.
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { ClipPatch } from '../schemas/clip.ts';
import { type HandlerMap, notImplemented, patchFieldNotImplemented } from './util.ts';

export const SHAPE_OWNER = 'wp-m2-shapes';

/** clip.update `{shape}` (merged into the current shape). Returns true when it handled the patch. */
export function applyShapePatch(
	_doc: DDoc,
	_seq: DSeq,
	_clip: DClip,
	p: Pick<ClipPatch, 'shape'>,
	h: HandlerContext,
): boolean {
	if (p.shape === undefined) return false;
	return patchFieldNotImplemented(h, 'clip.update', 'shape', SHAPE_OWNER);
}

export const shapeHandlers: HandlerMap = {
	'clip.addShape': notImplemented('clip.addShape', SHAPE_OWNER),
};
