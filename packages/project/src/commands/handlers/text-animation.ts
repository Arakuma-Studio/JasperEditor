// Text animators on text clips (M2, S11:TXA-005/006, ARCHITECTURE §20.1): `clip.addText {textAnimation}` and the
// `textAnimation` patch of clip.update. Owner: wp-m2-text-anim. Contracts: the schemas are registered; the
// handlers answer E_NOT_IMPLEMENTED for these fields.
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { ClipPatch, TextAnimationInput } from '../schemas/clip.ts';
import { patchFieldNotImplemented } from './util.ts';

export const TEXT_ANIMATION_OWNER = 'wp-m2-text-anim';

/** clip.addText `textAnimation`: writes the animators of the new clip (called after its layout). */
export function applyInitialTextAnimation(
	_doc: DDoc,
	_seq: DSeq,
	_clip: DClip,
	input: TextAnimationInput | undefined,
	h: HandlerContext,
): void {
	if (input === undefined) return;
	patchFieldNotImplemented(h, 'clip.addText', 'textAnimation', TEXT_ANIMATION_OWNER);
}

/** clip.update `{textAnimation}`. Returns true when it handled the patch. */
export function applyTextAnimationPatch(
	_doc: DDoc,
	_seq: DSeq,
	_clip: DClip,
	p: Pick<ClipPatch, 'textAnimation'>,
	h: HandlerContext,
): boolean {
	if (p.textAnimation === undefined) return false;
	return patchFieldNotImplemented(h, 'clip.update', 'textAnimation', TEXT_ANIMATION_OWNER);
}
