// Motion-graphic template versions (M2, S11:ATP-009, ARCHITECTURE §20.1): `clip.update {template: {version}}`
// upgrades a clip through the registry's upgrade path. Owner: wp-m2-anime-templates. Contracts: the patch field
// is registered; the handler answers E_NOT_IMPLEMENTED.
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { ClipPatch } from '../schemas/clip.ts';
import { patchFieldNotImplemented } from './util.ts';

export const MG_TEMPLATE_OWNER = 'wp-m2-anime-templates';

/** clip.update `{template: {version}}`. Returns true when it handled the patch. */
export function applyTemplatePatch(
	_doc: DDoc,
	_seq: DSeq,
	_clip: DClip,
	p: Pick<ClipPatch, 'template'>,
	h: HandlerContext,
): boolean {
	if (p.template === undefined) return false;
	return patchFieldNotImplemented(h, 'clip.update', 'template', MG_TEMPLATE_OWNER);
}
