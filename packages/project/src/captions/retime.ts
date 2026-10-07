// Re-tokenising edited caption text while keeping the times of unchanged words (S03:CAP-022): an LCS alignment
// of old words and new tokens; matched words keep their timing, changed spans share the time of the words they
// replace in proportion to character counts.
import type { TranscriptWord } from '../schema/media.ts';
import { spreadTokens, tokenizeText, type WordBreak } from './words.ts';

type Tok = { text: string; breakBefore: WordBreak };

/** LCS pairs (indices into `a` and `b`) of equal strings. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
	const n = a.length;
	const m = b.length;
	// Large edits fall back to "nothing matches" (bounded memory).
	if (n * m > 4_000_000) return [];
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	const out: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push([i, j]);
			i++;
			j++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
		else j++;
	}
	return out;
}

/**
 * New words for `text` replacing `old` (sorted words), keeping matched words' times. `span` bounds the result
 * when `old` is empty (or for leading/trailing insertions). The first word's break is `firstBreak`.
 */
export function retimeText(
	old: readonly TranscriptWord[],
	text: string | readonly Tok[],
	span: { start: number; end: number },
	firstBreak: WordBreak = 'none',
	speaker: string | null = null,
): TranscriptWord[] {
	const toks: Tok[] = typeof text === 'string' ? tokenizeText(text) : text.map((t) => ({ ...t }));
	if (!toks.length) return [];
	toks[0]!.breakBefore = firstBreak;
	if (!old.length) return spreadTokens(toks, span.start, span.end, { speaker });
	const pairs = lcsPairs(
		old.map((w) => w.text),
		toks.map((t) => t.text),
	);
	const out: TranscriptWord[] = [];
	// Anchors: (oldIndex, newIndex) plus virtual ends.
	const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [old.length, toks.length]];
	for (let k = 0; k + 1 < anchors.length; k++) {
		const [oi, ni] = anchors[k]!;
		const [oj, nj] = anchors[k + 1]!;
		if (oi >= 0 && ni >= 0) {
			const w = old[oi]!;
			const nb = toks[ni]!.breakBefore;
			// a page break inside the caption survives a text edit that keeps the word
			out.push({ ...w, breakBefore: w.breakBefore === 'segment' && nb === 'none' ? 'segment' : nb });
		}
		const newRun = toks.slice(ni + 1, nj);
		if (!newRun.length) continue;
		const replaced = old.slice(oi + 1, oj);
		const prevEnd = oi >= 0 ? old[oi]!.end : span.start;
		const nextStart = oj < old.length ? old[oj]!.start : span.end;
		let a = replaced.length ? replaced[0]!.start : prevEnd;
		let b = replaced.length ? replaced[replaced.length - 1]!.end : nextStart;
		if (b - a < newRun.length) {
			// a pure insertion with no room: share the previous word's time with it
			const prev = out[out.length - 1];
			if (prev && prev.end - prev.start >= 2) {
				const runs = spreadTokens(
					[{ text: prev.text, breakBefore: prev.breakBefore }, ...newRun],
					prev.start,
					Math.max(b, prev.end),
					{
						speaker: prev.speaker,
					},
				);
				out[out.length - 1] = { ...prev, end: runs[0]!.end };
				out.push(...runs.slice(1));
				continue;
			}
			a = Math.min(a, prevEnd);
			b = Math.max(a + newRun.length, nextStart);
		}
		out.push(...spreadTokens(newRun, a, b, { speaker: replaced[0]?.speaker ?? speaker }));
	}
	if (out.length) out[0]!.breakBefore = firstBreak;
	// Keep the list well formed even after the fallbacks above.
	for (let i = 0; i + 1 < out.length; i++) {
		if (out[i + 1]!.start < out[i]!.start) out[i + 1]!.start = out[i]!.start;
		if (out[i]!.end > out[i + 1]!.start) out[i]!.end = Math.max(out[i]!.start, out[i + 1]!.start);
		if (out[i + 1]!.end < out[i + 1]!.start) out[i + 1]!.end = out[i + 1]!.start;
	}
	return out;
}

/**
 * Tokens of caption text as the Captions panel edits it: a new line is a line break, a blank line starts a new
 * page (`breakBefore: 'segment'`).
 */
export function tokenizeCaptionText(text: string): Tok[] {
	const out: Tok[] = [];
	const pages = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
	for (const page of pages) {
		const toks = tokenizeText(page);
		if (!toks.length) continue;
		if (out.length) toks[0]!.breakBefore = 'segment';
		out.push(...toks);
	}
	return out;
}

/** `retimeText` for caption text (pages at blank lines). */
export function retimeCaptionText(
	old: readonly TranscriptWord[],
	text: string,
	span: { start: number; end: number },
	firstBreak: WordBreak = 'none',
	speaker: string | null = null,
): TranscriptWord[] {
	return retimeText(old, tokenizeCaptionText(text), span, firstBreak, speaker);
}
