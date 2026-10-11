import type { Draft } from 'immer';
import { MASK_PATH_RANGE } from '../../masks/model.ts';
import { type BezierPath, clonePath, isBezierPath, segmentCount } from '../../path/model.ts';
import type { Mask } from '../../schema/mask.ts';
import type { EffectInstance } from '../../schema/sequence.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';

type DMask = Draft<Mask>;
/** Most vertices a mask path may have (traced shapes stay far below). */
export const MASK_MAX_VERTICES = 20_000;

export type MaskLocation = {
	seq: DSeq;
	clip: DClip;
	/** Effect instance owning the mask, or null for an Opacity mask. */
	fx: Draft<EffectInstance> | null;
	list: DMask[];
	index: number;
	mask: DMask;
};

/** Finds a mask by id anywhere in the document (clip Opacity masks and clip effect masks). */
export function locateMask(doc: DDoc, maskId: string): MaskLocation | null {
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) {
			const c = clip as { masks?: DMask[]; effects?: Draft<EffectInstance>[] };
			const i = c.masks?.findIndex((m) => m.id === maskId) ?? -1;
			if (c.masks && i >= 0) return { seq, clip, fx: null, list: c.masks, index: i, mask: c.masks[i]! };
			for (const fx of c.effects ?? []) {
				const list = fx.masks as DMask[] | undefined;
				const j = list?.findIndex((m) => m.id === maskId) ?? -1;
				if (list && j >= 0) return { seq, clip, fx, list, index: j, mask: list[j]! };
			}
		}
	}
	return null;
}

/** Validates a path value (finite, sane size and range); returns a clean copy. */
export function validateMaskPath(v: unknown, h: HandlerContext, label = 'Mask Path'): BezierPath {
	if (!isBezierPath(v)) return h.fail('E_INVALID_PARAM', `Invalid value for ${label}: not a path`);
	if (v.vertices.length > MASK_MAX_VERTICES)
		h.fail('E_LIMIT', `${label}: at most ${MASK_MAX_VERTICES} vertices (got ${v.vertices.length})`);
	const inRange = (q: readonly number[]) =>
		q.every((x) => x >= MASK_PATH_RANGE.min && x <= MASK_PATH_RANGE.max);
	const handleOk = (q: readonly number[]) =>
		q.every((x) => Math.abs(x) <= MASK_PATH_RANGE.max - MASK_PATH_RANGE.min);
	for (const vx of v.vertices)
		if (!inRange(vx.p) || !handleOk(vx.in) || !handleOk(vx.out))
			h.fail('E_INVALID_PARAM', `${label}: coordinates out of range (normalised layer units)`);
	const out = clonePath(v as BezierPath);
	if (v.feather?.length) {
		const segs = segmentCount(out);
		for (const f of v.feather)
			if (!(f.segment >= 0 && f.segment < segs) || ![f.t, f.radius, f.tension].every(Number.isFinite))
				h.fail('E_INVALID_PARAM', `${label}: a feather point is not on a segment of the path`);
	}
	return out;
}
