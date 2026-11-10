// Spans of voice that the transcription left without words (spec 16 SG-011 safety net). Whisper can return nothing
// for a window although it holds clear speech — measured on a 57-minute Spanish file with large-v3-turbo: ≈ 45 s of
// speech after stretches of digital silence came back empty, and decoding those ranges on their own recovered the
// words. After the main pass, the worker decodes such spans again, alone, and merges what they yield.
//
// A span is a run of voiced 10 ms frames (voiced frames closer than `GAP_JOIN_FRAMES` join) lying between two words
// with at least `GAP_MIN_VOICED_FRAMES` voiced frames, padded by `GAP_PAD_FRAMES` of context on each side without
// reaching a word. Retries are bounded: at most `GAP_MAX_SPANS` spans and `GAP_MAX_FRAMES` frames in all, taken in
// time order; spans that do not fit are counted as skipped.
//
// Frames are 10 ms (160 samples at 16 kHz); word times are 16 kHz samples.
import { VAD_FRAME } from './vad.ts';

/** Voiced frames (2 s) a wordless span needs to be decoded again. */
export const GAP_MIN_VOICED_FRAMES = 200;
/** Voiced frames separated by less silence than this (2 s, the hallucination silence threshold) form one span. */
export const GAP_JOIN_FRAMES = 200;
/** Context (0.5 s) kept on each side of a span's voice, within its gap. */
export const GAP_PAD_FRAMES = 50;
/** At most this many spans are decoded again per job. */
export const GAP_MAX_SPANS = 32;
/** At most this many frames (10 min) are decoded again per job. */
export const GAP_MAX_FRAMES = 60_000;

export type GapSpan = { start: number; end: number };

/**
 * The wordless voiced spans of `mask` (frames `[start, end)`), in time order: `spans` to decode again (within the
 * budget) and how many qualifying spans did not fit (`skipped`). `words` must be sorted and non-overlapping.
 */
export function wordlessVoicedSpans(
	words: ReadonlyArray<{ start: number; end: number }>,
	mask: ArrayLike<number>,
	budget: { spans: number; frames: number } = { spans: GAP_MAX_SPANS, frames: GAP_MAX_FRAMES },
): { spans: GapSpan[]; skipped: number } {
	const frames = mask.length;
	const found: GapSpan[] = [];
	for (let i = 0; i <= words.length; i++) {
		const lo = i === 0 ? 0 : Math.min(frames, Math.ceil(words[i - 1]!.end / VAD_FRAME));
		const hi = i === words.length ? frames : Math.max(0, Math.floor(words[i]!.start / VAD_FRAME));
		let f = lo;
		while (f < hi) {
			while (f < hi && !(mask[f]! > 0)) f++;
			if (f >= hi) break;
			const first = f;
			let last = f;
			let voiced = 0;
			let silent = 0;
			for (; f < hi; f++) {
				if (mask[f]! > 0) {
					voiced++;
					last = f;
					silent = 0;
				} else if (++silent >= GAP_JOIN_FRAMES) break;
			}
			if (voiced >= GAP_MIN_VOICED_FRAMES)
				found.push({
					start: Math.max(lo, first - GAP_PAD_FRAMES),
					end: Math.min(hi, last + 1 + GAP_PAD_FRAMES),
				});
		}
	}
	// neighbouring spans of one gap may share padding: keep them apart
	for (let k = 1; k < found.length; k++)
		if (found[k]!.start < found[k - 1]!.end) found[k]!.start = found[k - 1]!.end;
	const spans: GapSpan[] = [];
	let used = 0;
	let skipped = 0;
	for (const s of found) {
		const len = s.end - s.start;
		if (spans.length < budget.spans && used + len <= budget.frames) {
			spans.push(s);
			used += len;
		} else skipped++;
	}
	return { spans, skipped };
}

/**
 * Merges words recovered in spans into the sorted, non-overlapping `words`. Each recovered list is clamped to its
 * range (samples; a span of `wordlessVoicedSpans` lies between two words, so nothing there collides); the result is
 * sorted by start with integer, non-overlapping times, and a word overlapping the one before it is dropped.
 */
export function mergeRecoveredWords<W extends { start: number; end: number }>(
	words: readonly W[],
	recovered: ReadonlyArray<{ start: number; end: number; words: readonly W[] }>,
): W[] {
	const all: W[] = [...words];
	for (const r of recovered) {
		let prev = r.start;
		for (const w of r.words) {
			const start = Math.max(prev, Math.round(w.start));
			if (start >= r.end) break;
			const end = Math.min(r.end, Math.max(start, Math.round(w.end)));
			all.push({ ...w, start, end });
			prev = end;
		}
	}
	all.sort((a, b) => a.start - b.start);
	const out: W[] = [];
	let prevEnd = 0;
	for (const w of all)
		if (w.start >= prevEnd) {
			out.push(w);
			prevEnd = w.end;
		}
	return out;
}
