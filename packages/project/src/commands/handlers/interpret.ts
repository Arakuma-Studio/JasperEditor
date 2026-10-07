// Interpret Footage (workstream `imports`, docs/wp-notes/imports.md): `media.interpret` sets the sections of an
// asset's interpretation (absent = unchanged, null = the file's value). The media's length can change (assumed frame
// rate, loop count): clips that would show time past the new end are trimmed to it (Premiere keeps clip instances
// and their In points; we never let a clip show frames that are not there), frame holds past the end move to the last
// frame, and time-remapped clips that would leave the media are refused rather than silently altered.
import type { Draft } from 'immer';
import { interpretationIssues, isEmptyInterpretation, mediaDurationFlicks } from '../../interpret/model.ts';
import { isBoundedContent } from '../../registry/kinds.ts';
import type { MediaAsset, MediaInterpretation } from '../../schema/media.ts';
import type { Clip } from '../../schema/sequence.ts';
import { contentSpanFlicks, flicksPerFrame, type Rational } from '../../time.ts';
import { clipMediaRange, isRemapped, type TimedClip } from '../../time-remap/model.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import { cleanupSequence } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import type { InterpretationPatch } from '../schemas/interpret.ts';
import type { HandlerMap } from './util.ts';

export const INTERPRET_OWNER = 'imports' as const;

const SECTIONS = ['frameRate', 'pixelAspect', 'fieldOrder', 'alpha', 'loop'] as const;

/** The interpretation after a patch (absent = unchanged, null = removed). Pure. */
export function patchInterpretation(
	current: MediaInterpretation | undefined,
	patch: InterpretationPatch,
): MediaInterpretation {
	const next: Record<string, unknown> = { ...(current ?? {}) };
	for (const key of SECTIONS) {
		const v = (patch as Record<string, unknown>)[key];
		if (v === undefined) continue;
		if (v === null) delete next[key];
		else next[key] = JSON.parse(JSON.stringify(v));
	}
	// Normal values are the same as "from file": keep the document small and canonical.
	if (next.loop === 1) delete next.loop;
	const alpha = next.alpha as { mode?: string; invert?: boolean; matte?: unknown } | undefined;
	if (alpha && alpha.mode === 'straight' && !alpha.invert) delete next.alpha;
	else if (alpha && alpha.mode !== 'premultiplied') delete alpha.matte;
	return next as MediaInterpretation;
}

function trimToMedia(
	c: Draft<Clip>,
	mediaDur: number,
	rate: Rational,
	h: HandlerContext,
	trimmed: string[],
): void {
	if (!isBoundedContent(c as Clip)) return;
	const F = flicksPerFrame(rate);
	if (c.frameHold) {
		if (c.frameHold.flicks >= mediaDur) {
			c.frameHold.flicks = Math.max(0, Math.floor(mediaDur - F));
			trimmed.push(c.id);
		}
		return;
	}
	if (isRemapped(c as TimedClip)) {
		const { max } = clipMediaRange(c as TimedClip, rate);
		if (max > mediaDur + 1)
			h.fail(
				'E_OUT_OF_MEDIA',
				`Clip ${c.id} is time-remapped past the new end of its media: change its remap first`,
				{ blocking: [c.id] },
			);
		return;
	}
	const span = contentSpanFlicks(c.duration, rate, c.speed.rate);
	const tol = F * c.speed.rate + 1;
	if (c.sourceIn + span <= mediaDur + tol) return;
	const frames = Math.floor((mediaDur - c.sourceIn) / (F * c.speed.rate) + 1e-6);
	if (frames < 1)
		h.fail(
			'E_OUT_OF_MEDIA',
			`Clip ${c.id} starts after the new end of its media (its In point is past it): trim or remove it first`,
			{ blocking: [c.id] },
		);
	c.duration = frames;
	trimmed.push(c.id);
}

function mediaInterpret(doc: DDoc, cmd: CommandOf<'media.interpret'>, h: HandlerContext): unknown {
	const ids = [...new Set(cmd.mediaIds)];
	const patch = cmd.interpretation as InterpretationPatch;
	const changed = new Map<string, number | null>();
	for (const id of ids) {
		const asset = doc.media[id] as Draft<MediaAsset> | undefined;
		if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${id}`);
		const next = patchInterpretation(asset.interpretation as MediaInterpretation | undefined, patch);
		const issues = interpretationIssues(asset as MediaAsset, next);
		if (issues.length)
			h.fail('E_INVALID_PARAM', `Media ${id}: ${issues.join('; ')}`, { path: ['interpretation'] });
		if (isEmptyInterpretation(next)) delete asset.interpretation;
		else asset.interpretation = next as Draft<MediaInterpretation>;
		changed.set(id, mediaDurationFlicks(asset as MediaAsset));
	}
	const trimmedClipIds: string[] = [];
	for (const seq of Object.values(doc.sequences)) {
		const rate = seq.settings.frameRate as Rational;
		let touched = false;
		for (const c of Object.values(seq.clips)) {
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string' || !changed.has(mediaId)) continue;
			const dur = changed.get(mediaId);
			if (dur === null || dur === undefined) continue;
			const before = trimmedClipIds.length;
			trimToMedia(c, dur, rate, h, trimmedClipIds);
			if (trimmedClipIds.length !== before) touched = true;
		}
		if (touched) cleanupSequence(seq, h);
	}
	if (trimmedClipIds.length)
		h.warn(
			'W_CLIPS_TRIMMED',
			`${trimmedClipIds.length} clip(s) ended past the new media length and now end at it`,
		);
	return { mediaIds: ids, trimmedClipIds };
}

export const interpretHandlers: HandlerMap = {
	'media.interpret': mediaInterpret,
};
