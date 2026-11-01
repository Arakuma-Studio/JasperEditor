// Spec 18 AF-DIG-001: transcript words grouped into phrases (docs/wp-notes/agent-footage-digest.md). A phrase ends
// at a gap ≥ 0.5 s between words, a speaker change, a caption break (`breakBefore` line / segment) or when it would
// grow past 12 s. The 0.5 s split is adapted from browser-use/video-use (MIT; licenses/ported/video-use.md). Words
// with nonfinite, negative or reversed times, or no text, are skipped; words are clamped to the bounds. Pure.
import { FLICKS_PER_SECOND } from '../time.ts';

/** A gap of at least this long between two words splits a phrase (seconds; video-use's phrase split). */
export const PHRASE_GAP_S = 0.5;
/** A phrase never grows past this length (seconds). */
export const PHRASE_MAX_S = 12;
/** Words below this confidence are marked `~` in the digest. */
export const DIGEST_LOW_CONFIDENCE = 0.6;

/** The fields of a transcript word the phrasing reads (any value is tolerated). */
export type PhraseWordIn = {
	text: unknown;
	start: unknown;
	end: unknown;
	confidence?: unknown;
	speaker?: unknown;
	breakBefore?: unknown;
};

export type PhraseWord = {
	/** The word's text on one line (whitespace runs become one space). */
	text: string;
	/** Flicks, inside the bounds. */
	start: number;
	end: number;
	/** 0…1, or null when unknown. */
	confidence: number | null;
	/** Index in the input word list. */
	index: number;
};

export type FootagePhrase = {
	/** Flicks: the first word's start and the latest word end (inside the bounds). */
	start: number;
	end: number;
	/** The speaker key of its words (as in the transcript), or null. */
	speaker: string | null;
	words: PhraseWord[];
};

/** One line of text: control characters and whitespace runs become one space. */
export function oneLine(s: string): string {
	return s.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Phrases of `words` (any order) inside `[0, bounds.end]` (flicks; `end` null = unbounded). Words starting at or
 * after a positive `end` are dropped and the rest are clamped to it.
 */
export function footagePhrases(
	words: readonly PhraseWordIn[],
	bounds: { end: number | null },
	opts: { gapS?: number; maxS?: number } = {},
): FootagePhrase[] {
	const limit = finite(bounds.end) && bounds.end > 0 ? bounds.end : null;
	const gap = Math.round((opts.gapS ?? PHRASE_GAP_S) * FLICKS_PER_SECOND);
	const maxLen = Math.round((opts.maxS ?? PHRASE_MAX_S) * FLICKS_PER_SECOND);
	type Cand = PhraseWord & { speaker: string | null; brk: boolean };
	const cands: Cand[] = [];
	const list = Array.isArray(words) ? words : [];
	for (let i = 0; i < list.length; i++) {
		const w = list[i] as PhraseWordIn | null | undefined;
		if (!w || typeof w !== 'object') continue;
		const { start, end } = w;
		if (!finite(start) || !finite(end) || start < 0 || end < start) continue;
		if (limit !== null && start >= limit) continue;
		const text = typeof w.text === 'string' ? oneLine(w.text) : '';
		if (!text) continue;
		const c = w.confidence;
		cands.push({
			text,
			start,
			end: limit !== null ? Math.min(end, limit) : end,
			confidence: finite(c) ? Math.min(1, Math.max(0, c)) : null,
			index: i,
			speaker: typeof w.speaker === 'string' ? w.speaker : null,
			brk: w.breakBefore === 'line' || w.breakBefore === 'segment',
		});
	}
	cands.sort((a, b) => a.start - b.start || a.index - b.index);
	const out: FootagePhrase[] = [];
	let cur: FootagePhrase | null = null;
	for (const c of cands) {
		const split =
			!cur ||
			c.start - cur.end >= gap ||
			c.speaker !== cur.speaker ||
			c.brk ||
			Math.max(cur.end, c.end) - cur.start > maxLen;
		if (split) {
			cur = { start: c.start, end: c.end, speaker: c.speaker, words: [] };
			out.push(cur);
		}
		const p = cur as FootagePhrase;
		p.end = Math.max(p.end, c.end);
		p.words.push({ text: c.text, start: c.start, end: c.end, confidence: c.confidence, index: c.index });
	}
	return out;
}

/** Mean confidence of a phrase's words that have one (3 decimals), or null. */
export function meanConfidence(p: Pick<FootagePhrase, 'words'>): number | null {
	let sum = 0;
	let n = 0;
	for (const w of p.words)
		if (w.confidence !== null) {
			sum += w.confidence;
			n++;
		}
	return n ? Math.round((sum / n) * 1000) / 1000 : null;
}
