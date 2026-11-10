// Transcript words: joining (S01:AST-032), tokenizing caption text into timed words, normalisation for search,
// well-formed transcripts (sorted, non-overlapping) and the word-range text edit (S01 `transcript.editText`).
import type { Transcript, TranscriptWord } from '../schema/media.ts';
import { plainCaptionText } from './formats/core.ts';

export type WordBreak = TranscriptWord['breakBefore'];

/** Punctuation that attaches to the previous word (no space before it, S01:AST-032). */
const ATTACHING = /^[,.;:!?%)\]}…»”’]/u;

/** Whether `next` is joined to the previous word without a space (S01:AST-032). */
export function attachesToPrevious(next: string): boolean {
	return ATTACHING.test(plainCaptionText(next));
}

/**
 * A word for search and filler matching: markup removed, punctuation trimmed from both ends, lower case
 * (FilmCraft `normalize_word`).
 */
export function normalizeWord(s: string): string {
	return plainCaptionText(s)
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
		.toLowerCase();
}

/** Tokens of a text, each with the break before it (`line` for a new line inside the text). */
export function tokenizeText(text: string): Array<{ text: string; breakBefore: WordBreak }> {
	const out: Array<{ text: string; breakBefore: WordBreak }> = [];
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	let first = true;
	for (const line of lines) {
		let lineStart = true;
		for (const tok of line.split(/\s+/)) {
			if (!tok) continue;
			out.push({ text: tok, breakBefore: first ? 'none' : lineStart ? 'line' : 'none' });
			first = false;
			lineStart = false;
		}
	}
	return out;
}

/** Character weight of a word for proportional timing (at least 1). */
function weight(t: string): number {
	return Math.max(1, [...plainCaptionText(t)].length);
}

/**
 * Spread tokens over `[start, end)` (flicks) in proportion to their character counts (S01 `transcript.editText`,
 * S04:TR-060). Integer bounds; every word is at least 1 flick long when the span allows it.
 */
export function spreadTokens(
	tokens: ReadonlyArray<{ text: string; breakBefore: WordBreak }>,
	start: number,
	end: number,
	extra: { speaker?: string | null; confidence?: number | null } = {},
): TranscriptWord[] {
	if (!tokens.length) return [];
	const span = Math.max(tokens.length, end - start);
	const total = tokens.reduce((a, t) => a + weight(t.text), 0);
	let acc = 0;
	return tokens.map((t, i) => {
		const a = start + Math.round((span * acc) / total);
		acc += weight(t.text);
		const b = i === tokens.length - 1 ? start + span : start + Math.round((span * acc) / total);
		return {
			text: t.text,
			start: a,
			end: Math.max(a + 1, b),
			confidence: extra.confidence ?? null,
			speaker: extra.speaker ?? null,
			breakBefore: t.breakBefore,
		};
	});
}

/**
 * Normalises raw word input: trims text, folds tokens without a leading space into the previous word when the
 * source uses the leading-space convention (`@remotion/captions`, Whisper tokens; S01:AST-032), clamps times to
 * non-negative integers, sorts by start and cuts overlaps (a word ends where the next starts).
 */
export function normalizeWords(
	input: ReadonlyArray<Partial<TranscriptWord> & { text: string }>,
): TranscriptWord[] {
	const leadingSpaceConvention = input.filter((w) => /^\s/.test(w.text)).length > input.length / 2;
	const merged: TranscriptWord[] = [];
	for (const raw of input) {
		const start = Math.max(0, Math.round(Number(raw.start ?? 0)));
		const end = Math.max(start, Math.round(Number(raw.end ?? start)));
		const text = String(raw.text ?? '');
		const w: TranscriptWord = {
			text: text.trim(),
			start,
			end,
			confidence:
				typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
					? Math.min(1, Math.max(0, raw.confidence))
					: null,
			speaker: typeof raw.speaker === 'string' && raw.speaker ? raw.speaker : null,
			breakBefore: raw.breakBefore === 'line' || raw.breakBefore === 'segment' ? raw.breakBefore : 'none',
		};
		const prev = merged[merged.length - 1];
		if (leadingSpaceConvention && prev && !/^\s/.test(text) && w.text && !w.breakBefore.startsWith('s')) {
			prev.text += w.text;
			prev.end = Math.max(prev.end, w.end);
			if (w.confidence !== null)
				prev.confidence = prev.confidence === null ? w.confidence : Math.min(prev.confidence, w.confidence);
			continue;
		}
		if (!w.text) continue;
		merged.push(w);
	}
	merged.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 0; i + 1 < merged.length; i++) {
		const a = merged[i]!;
		const b = merged[i + 1]!;
		if (a.end > b.start) a.end = Math.max(a.start, b.start);
	}
	return merged;
}

/** Sorted, non-overlapping words with non-negative integer times (an invariant of transcripts). */
export function wordsWellFormed(words: readonly TranscriptWord[]): string | null {
	let prevEnd = 0;
	let prevStart = -1;
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (!Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.end < w.start)
			return `word ${i} has invalid times`;
		if (w.start < prevStart || w.start < prevEnd) return `word ${i} overlaps the previous word`;
		prevStart = w.start;
		prevEnd = w.end;
	}
	return null;
}

/**
 * Replaces words `from..=to` by the tokens of `text`, spread over the replaced range's timing in proportion to
 * their character counts (S01 `transcript.editText`). The first new word keeps the first replaced word's break
 * and speaker. Empty text deletes the words.
 */
export function replaceWordRange(t: Transcript, from: number, to: number, text: string): TranscriptWord[] {
	const words = t.words;
	const a = words[from]!;
	const b = words[to]!;
	const tokens = tokenizeText(text);
	if (tokens.length) tokens[0]!.breakBefore = a.breakBefore;
	const fresh = spreadTokens(tokens, a.start, b.end, { speaker: a.speaker });
	// A range shorter than one unit per token (Whisper's zero-length words) cannot push into the next word.
	const limit = words[to + 1]?.start ?? Number.POSITIVE_INFINITY;
	for (const w of fresh) {
		w.start = Math.min(w.start, limit);
		w.end = Math.min(w.end, limit);
	}
	// Unchanged words keep their confidence; new words have none.
	const keep = new Map<string, number | null>();
	for (let i = from; i <= to; i++) keep.set(words[i]!.text, words[i]!.confidence);
	for (const w of fresh) if (keep.has(w.text)) w.confidence = keep.get(w.text)!;
	return [...words.slice(0, from), ...fresh, ...words.slice(to + 1)];
}

/** A word longer than this (seconds) inside speech is stretched over more than it says. */
export const STRETCHED_WORD_S = 1;
/** A neighbour this close (seconds) puts a word inside speech. */
const CONTINUOUS_GAP_S = 1.5;

/**
 * Hidden takes (docs/wp-notes/speech.md §11.3 "Hidden takes"; docs/wp-notes/captions.md): the words (flicks) longer
 * than 1 s inside speech — a neighbour within 1.5 s on at least one side. Speech to text writes a phrase said twice back
 * to back once and stretches its words over both takes, so subtitles timed from them run ahead of the audio. Normal
 * words last 0.2–0.4 s. Whisper usually leaves a gap on one side of the stretched word (measured with large-v3-turbo:
 * "tener" 2.11 s 0.51 s after "quise", "pones" 6.27 s 1.6 s after "los", both touching the next word), so both sides
 * close was too strict. A word with no neighbour within 1.5 s on either side (said alone between pauses) is not
 * flagged. Returns `{start, end}` of each, in order.
 */
export function stretchedWords(
	words: ReadonlyArray<{ start: number; end: number }>,
	flicksPerSecond: number,
): Array<{ start: number; end: number }> {
	const out: Array<{ start: number; end: number }> = [];
	const gap = CONTINUOUS_GAP_S * flicksPerSecond;
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (w.end - w.start <= STRETCHED_WORD_S * flicksPerSecond) continue;
		const prev = words[i - 1];
		const next = words[i + 1];
		if ((prev && w.start - prev.end <= gap) || (next && next.start - w.end <= gap))
			out.push({ start: w.start, end: w.end });
	}
	return out;
}

/** The warning for stretched words (sequence flicks), or null when there are none. */
export function stretchedWordsWarning(
	words: ReadonlyArray<{ start: number; end: number }>,
	flicksPerSecond: number,
): string | null {
	const hits = stretchedWords(words, flicksPerSecond);
	if (!hits.length) return null;
	const at = (f: number) => {
		const s = f / flicksPerSecond;
		const m = Math.floor(s / 60);
		const r = s - m * 60;
		return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
	};
	const list = hits
		.slice(0, 8)
		.map((w) => `${at(w.start)}–${at(w.end)}`)
		.join(', ');
	return `${hits.length} word(s) last over 1 s inside continuous speech (${list}${hits.length > 8 ? ', …' : ''}): speech to text probably wrote a phrase said twice only once, so these captions run ahead of the audio. Transcribe again with chunking "vad", then rebuild the captions.`;
}
