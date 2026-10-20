// Edit points (spec 12 §2.2): a cut between two different sources on a video track. Through edits (the same source
// continuing, `isThroughEdit`) and edits covered by a transition are not cuts. In dialogue-dominant ranges plain
// cuts get no sound (spec 12 §1 "Less is more").
import { clipEnd, isThroughEdit } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import { dialogueFrameRanges, type VoiceActivity } from './dialogue.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate, clipName, contentClipsOnTrack, label } from './util.ts';

export { DIALOGUE_BRIDGE_SEC, DIALOGUE_PAD_SEC } from './dialogue.ts';

/** A shot shorter than this (montage) makes the cut less likely to want a sound. */
const SHORT_SHOT_SEC = 1;

/**
 * Frame ranges `[start, end)` where dialogue is heard (`dialogueSpans`: transcript words, else the voice activity of
 * Essential Sound dialogue clips the engine measured, else their whole spans). Sorted, disjoint.
 */
export function dialogueRanges(ctx: CueContext): Array<[number, number]> {
	return dialogueFrameRanges(ctx.doc, ctx.seq, { voice: ctx.voice ?? null });
}

/** `dialogueRanges` of a whole sequence (placement warnings, the cue route, the plan): never throws ([] on damaged data). */
export function sequenceDialogueRanges(
	doc: ProjectDocument,
	seq: Sequence,
	opts: { voice?: VoiceActivity | null } = {},
): Array<[number, number]> {
	return dialogueFrameRanges(doc, seq, opts);
}

export function inRanges(ranges: ReadonlyArray<[number, number]>, f: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = ranges[mid]!;
		if (f < r[0]) hi = mid - 1;
		else if (f >= r[1]) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Transition ids keyed `outgoing>incoming` (an edit under a transition is the transition's event). */
function transitionPairs(ctx: CueContext): Set<string> {
	const s = new Set<string>();
	for (const t of Object.values(ctx.seq.transitions ?? {}))
		if (t?.outgoingClipId && t.incomingClipId) s.add(`${t.outgoingClipId}>${t.incomingClipId}`);
	return s;
}

export function deriveEditCues(
	ctx: CueContext,
	opts: { respectDialogue: boolean; dialogue?: ReadonlyArray<[number, number]> },
): { cues: CueCandidate[]; suppressed: number } {
	const cues: CueCandidate[] = [];
	let suppressed = 0;
	const covered = transitionPairs(ctx);
	const dialogue = opts.respectDialogue ? (opts.dialogue ?? dialogueRanges(ctx)) : [];
	for (const { track } of ctx.videoTracks) {
		const list = contentClipsOnTrack(ctx, track.id);
		for (let i = 1; i < list.length; i++) {
			const a = list[i - 1]!;
			const b = list[i]!;
			if (clipEnd(a) !== b.start) continue;
			if (b.start < ctx.range.start || b.start >= ctx.range.end) continue;
			if (covered.has(`${a.id}>${b.id}`)) continue;
			if (isThroughEdit(a, b, ctx.rate)) continue;
			if (inRanges(dialogue, b.start)) {
				suppressed++;
				continue;
			}
			cues.push(cutCue(ctx, track.id, a, b));
		}
	}
	return { cues, suppressed };
}

function cutCue(ctx: CueContext, trackId: string, a: Clip, b: Clip): CueCandidate {
	const short = Math.min(a.duration, b.duration) < SHORT_SHOT_SEC * ctx.fps;
	return candidate('edits', {
		key: `edit:${trackId}:${a.id}>${b.id}`,
		frame: b.start,
		kind: 'cut',
		weight: 'support',
		types: ['hit', 'thump', 'transition', 'glitch', 'click'],
		align: 'peak',
		anchor: { type: 'edit', trackId, outgoingClipId: a.id, incomingClipId: b.id },
		confidence: short ? 0.35 : 0.5,
		reason: `Cut on ${label(ctx, trackId)}: ${clipName(a)} → ${clipName(b)}${short ? ' (short shot)' : ''}`,
		size: 1,
	});
}
