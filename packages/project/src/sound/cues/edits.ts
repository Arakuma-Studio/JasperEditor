// Edit points (spec 12 §2.2): a cut between two different sources on a video track. Through edits (the same source
// continuing, `isThroughEdit`) and edits covered by a transition are not cuts. In dialogue-dominant ranges plain
// cuts get no sound (spec 12 §1 "Less is more").
import { sequenceWords } from '../../captions/sequence-transcript.ts';
import { clipEnd, isThroughEdit, sequenceDuration } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate, clipName, contentClipsOnTrack, label, makeContext } from './util.ts';

/** Seconds of speech padding around transcript words, and the pause that still counts as one dialogue stretch. */
export const DIALOGUE_PAD_SEC = 0.25;
export const DIALOGUE_BRIDGE_SEC = 0.75;
/** A shot shorter than this (montage) makes the cut less likely to want a sound. */
const SHORT_SHOT_SEC = 1;

/**
 * Frame ranges `[start, end)` where dialogue is heard: transcript words of the sequence (padded and bridged), plus
 * the spans of Essential Sound `dialogue` clips whose media has no transcript words. Sorted, disjoint.
 */
export function dialogueRanges(ctx: CueContext): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const pad = Math.round(DIALOGUE_PAD_SEC * ctx.fps);
	let words: { start: number; end: number; clipId: string }[] = [];
	try {
		words = sequenceWords(ctx.doc, ctx.seq);
	} catch {
		words = [];
	}
	const transcribed = new Set(words.map((w) => w.clipId));
	for (const w of words) {
		if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
		out.push([Math.floor(w.start / ctx.F) - pad, Math.ceil(w.end / ctx.F) + pad]);
	}
	const audioIds = new Set(
		(Array.isArray(ctx.seq.audioTracks) ? ctx.seq.audioTracks : [])
			.filter((t) => t && !t.mute)
			.map((t) => t.id),
	);
	for (const c of Object.values(ctx.seq.clips)) {
		if (c?.kind !== 'audio' || c.enabled === false || !audioIds.has(c.trackId)) continue;
		const ess = (c as { essential?: { type?: unknown } }).essential;
		if (!ess || typeof ess !== 'object' || ess.type !== 'dialogue') continue;
		if (transcribed.has(c.id)) continue;
		out.push([c.start, clipEnd(c)]);
	}
	out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const bridge = Math.round(DIALOGUE_BRIDGE_SEC * ctx.fps);
	const merged: Array<[number, number]> = [];
	for (const r of out) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1] + bridge) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}
	return merged;
}

/** `dialogueRanges` of a whole sequence (placement warnings, the cue route): never throws ([] on damaged data). */
export function sequenceDialogueRanges(doc: ProjectDocument, seq: Sequence): Array<[number, number]> {
	try {
		const end = Math.max(0, Math.round(sequenceDuration(seq)));
		return dialogueRanges(makeContext(doc, seq, end, { start: 0, end }, () => {}));
	} catch {
		return [];
	}
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
	opts: { respectDialogue: boolean },
): { cues: CueCandidate[]; suppressed: number } {
	const cues: CueCandidate[] = [];
	let suppressed = 0;
	const covered = transitionPairs(ctx);
	const dialogue = opts.respectDialogue ? dialogueRanges(ctx) : [];
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
