// Spec 13 AS-006 / AS-020: per-transaction upkeep of subtitle text clips, whatever command changed them (Properties,
// the Program monitor, clip.update, param.set, paste, trims, razor cuts, ripples):
// - a text edit re-times the unchanged words (LCS) when the command did not set the words itself, and locks the
//   subtitle (`caption.locked`: edited by hand, kept by `captions.regenerate`);
// - the template's animation keys follow the clip's In (trims and razor cuts move the In: `reanchorTemplateKeys`);
// - the group's highlight (Source Text keys / runs) is rebuilt from the words when the text, style or words changed;
// - a subtitle pasted into a sequence without its group gets the group (copied from the sequence it came from when
//   the document has it, else with the default rules).
// Only clips the transaction changed are looked at (tx-delta.ts); the first transaction after a load scans all.
import { type Draft, isDraft, original } from 'immer';
import { latest } from '../../commands/draft-read.ts';
import { txDelta } from '../../commands/tx-delta.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import {
	applyHighlight,
	clipContentSpan,
	isTemplateEffect,
	reanchorTemplateKeys,
	retimeCaptionWords,
} from './clips.ts';
import {
	type CaptionGroup,
	captionGroupOf,
	captionOf,
	defaultCaptionGroup,
	type TextClipCaption,
} from './model.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;

const sameWords = (a: TextClipCaption | null, b: TextClipCaption | null) =>
	!!a && !!b && JSON.stringify(a.words) === JSON.stringify(b.words);

/** Upkeep of one changed subtitle clip (`before` = its version at the start of the transaction). */
function upkeep(
	doc: Draft<ProjectDocument>,
	sid: string,
	before: Clip | undefined,
	after: Clip,
	newKeyId: () => string,
): void {
	const cap = captionOf(after);
	if (!cap) return;
	const seqNow = latest(latest(doc.sequences)[sid]!) as Sequence;
	const rate = seqNow.settings.frameRate;
	let group = captionGroupOf(seqNow, cap.groupId);
	if (!group) {
		// pasted without its group: copy it from another sequence of the document, else default rules
		let copy: CaptionGroup | null = null;
		for (const s of Object.values(latest(doc.sequences)))
			if (s.id !== sid) copy ??= captionGroupOf(latest(s) as Sequence, cap.groupId);
		group = copy ? (JSON.parse(JSON.stringify(copy)) as CaptionGroup) : defaultCaptionGroup(cap.groupId);
		group.trackId = after.trackId;
		const seq = doc.sequences[sid]! as { captionGroups?: Record<string, CaptionGroup> };
		seq.captionGroups ??= {};
		seq.captionGroups[group.id] = group;
	}
	const prev = before && before.kind === 'text' ? before : null;
	const prevCap = prev ? captionOf(prev) : null;
	const textChanged = !!prev && prev.content.text !== (after as TextClip).content.text;
	const needsRetime = textChanged && sameWords(prevCap, cap);
	const moved =
		cap.anchorIn !== undefined &&
		cap.anchorIn !== after.sourceIn &&
		(after as TextClip).effects.some((fx) => isTemplateEffect(fx as { subtitleTemplate?: unknown }));
	const contentChanged = !prev || prev.content !== (after as TextClip).content || !sameWords(prevCap, cap);
	const hl = group.highlight && group.highlight.mode !== 'none' ? group.highlight : null;
	const hadHighlight =
		!!(after as { sourceTextKeyframes?: unknown[] }).sourceTextKeyframes?.length ||
		!!(after as TextClip).content.runs?.some((r) => (r as { tag?: string }).tag);
	if (!needsRetime && !moved && !(contentChanged && (hl || hadHighlight))) return;
	const clip = doc.sequences[sid]!.clips[after.id] as Draft<TextClip>;
	if (needsRetime) {
		const words = retimeCaptionWords(
			prevCap!.words,
			(latest(clip) as TextClip).content.text,
			clipContentSpan(latest(clip) as TextClip, rate),
		);
		(clip as { caption: TextClipCaption }).caption = {
			...(latest(clip.caption) as TextClipCaption),
			words,
			locked: true,
		};
	}
	if (moved) reanchorTemplateKeys(clip as TextClip);
	if (contentChanged || needsRetime) applyHighlight(clip as TextClip, hl ?? undefined, newKeyId);
}

/** Runs the upkeep on every subtitle clip the transaction changed (see the file comment). */
export function normalizeSubtitleClips(doc: Draft<ProjectDocument>, newKeyId: () => string): void {
	const delta = txDelta(doc as ProjectDocument);
	if (delta) {
		for (const { sid, before, after } of delta.clips) {
			if (after?.kind !== 'text') continue;
			if ((after as { caption?: unknown }).caption === undefined) continue;
			upkeep(doc, sid, before, after, newKeyId);
		}
		return;
	}
	// no normalized base (the first transaction after a load): compare every clip with the transaction's base
	const base = (isDraft(doc) ? original(doc) : doc) as ProjectDocument;
	const seqs = latest(doc.sequences) as Record<string, Sequence>;
	for (const sid of Object.keys(seqs)) {
		const seq = latest(seqs[sid]!) as Sequence;
		const was = base.sequences[sid];
		if (was === seq) continue;
		const clips = latest(seq.clips) as Record<string, Clip>;
		for (const id of Object.keys(clips)) {
			const now = latest(clips[id]!) as Clip;
			const before = was?.clips[id];
			if (before === now || now.kind !== 'text' || (now as { caption?: unknown }).caption === undefined)
				continue;
			upkeep(doc, sid, before, now, newKeyId);
		}
	}
}
