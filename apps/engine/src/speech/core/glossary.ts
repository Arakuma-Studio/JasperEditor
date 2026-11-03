// Spec 17 SC-074 / SC-075 (pure): glossary prompting of transcription and its guard.
//
// - SC-074: the glossary (≤ 40 proper / English terms, chosen by the caller, most frequent first) is written as
//   `" Term1, Term2, Term3."` — the form the scriptfix research measured (`sfgloss_prompts.py`) — and carried into
//   every window's prompt, as openai-whisper's `carry_initial_prompt` carries its initial prompt
//   (`transcribe.py`: `initial_prompt_tokens + all_tokens[nignored:][-remaining_prompt_length:]`). Unlike that
//   option, only the glossary is carried: the verbatim / custom initial prompt keeps OpenAI's default semantics (it
//   starts the running text and conditions until a prompt reset), because carrying the verbatim prompt into every
//   window derailed tiny.en into "Oh, oh, oh…" loops (wp-note speech §11.3). The glossary goes after the part of the
//   initial prompt that is still in the running text, and before the later previous text, all within the
//   223-token prompt cap (n_text_ctx / 2 − 1); the oldest running text is dropped first, never the glossary.
// - SC-075: when a carried term appears ≥ 3 times within 10 s of a window's text, the window is decoded again
//   without the glossary (the research saw a glossary term written 5× over a stretch the unprompted run left
//   empty, FINDINGS §6).
import { cleanupNorm } from '@jasper/project/cleanup-worker';

/** SC-074 caps (also enforced by `TranscribeOptionsSchema`). */
export const GLOSSARY_MAX_TERMS = 40;
export const GLOSSARY_MAX_TERM_CHARS = 64;
/** SC-075: repeats of one carried term within `GUARD_WINDOW_SEC` that trigger the unprompted re-decode. */
export const GUARD_MIN_REPEATS = 3;
export const GUARD_WINDOW_SEC = 10;

/** Trimmed, non-empty, duplicates (same normalised form) removed, order kept, capped. */
export function normalizeGlossary(terms: readonly string[] | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of terms ?? []) {
		if (typeof raw !== 'string') continue;
		const t = raw.replace(/\s+/g, ' ').trim().slice(0, GLOSSARY_MAX_TERM_CHARS).trim();
		const key = termKey(t);
		if (!t || !key || seen.has(key)) continue;
		seen.add(key);
		out.push(t);
		if (out.length >= GLOSSARY_MAX_TERMS) break;
	}
	return out;
}

/** The prompt text of some terms: "Term1, Term2." (research form). */
export function glossaryText(terms: readonly string[]): string {
	return terms.length ? `${terms.join(', ')}.` : '';
}

/**
 * The glossary tokens within `budget` tokens: whole terms in order (most frequent first), each kept when
 * `encode(" " + text)` of the terms so far still fits (a term that does not fit is left out). Returns the terms
 * kept and their tokens.
 */
export function glossaryTokens(
	terms: readonly string[],
	encode: (text: string) => number[],
	budget: number,
): { terms: string[]; tokens: number[] } {
	let kept: string[] = [];
	let tokens: number[] = [];
	if (budget <= 0) return { terms: kept, tokens };
	for (const t of terms) {
		const next = [...kept, t];
		const enc = encode(` ${glossaryText(next)}`);
		if (enc.length > budget) continue;
		kept = next;
		tokens = enc;
	}
	return { terms: kept, tokens };
}

/**
 * The prompt of one window: `running` = the previous text since the last prompt reset, whose first `initialKept`
 * tokens are what remains of the initial (verbatim / custom) prompt; `glossary` is inserted after them. At most
 * `max` tokens; the oldest running tokens are dropped first, the glossary never (it is capped beforehand). Without
 * a glossary this is the last `max` running tokens (the previous behaviour).
 */
export function composePrompt(
	running: readonly number[],
	initialKept: number,
	glossary: readonly number[],
	max: number,
): number[] {
	if (max <= 0) return [];
	if (!glossary.length) return running.slice(Math.max(0, running.length - max));
	const g = glossary.slice(0, max);
	const budget = max - g.length;
	const k = Math.max(0, Math.min(initialKept, running.length));
	const head = running.slice(0, k);
	const rest = running.slice(k);
	const restKept = budget > 0 ? rest.slice(Math.max(0, rest.length - budget)) : [];
	const headBudget = budget - restKept.length;
	const headKept = headBudget > 0 ? head.slice(Math.max(0, head.length - headBudget)) : [];
	return [...headKept, ...g, ...restKept];
}

function termKey(term: string): string {
	return term
		.split(/\s+/)
		.map((w) => cleanupNorm(w))
		.join('');
}

/**
 * SC-075: the first carried term that occurs ≥ `minRepeats` times with starts within `windowSec` seconds in
 * `words` (start in seconds), or null. A term matches 1–6 consecutive words whose normalised concatenation
 * equals the term's ("Nova Play" / "NovaPlay" alike); punctuation-only words are ignored; occurrences do not
 * overlap.
 */
export function repeatedGlossaryTerm(
	words: ReadonlyArray<{ word: string; start: number }>,
	terms: readonly string[],
	minRepeats = GUARD_MIN_REPEATS,
	windowSec = GUARD_WINDOW_SEC,
): string | null {
	const ws = words
		.map((w) => ({ n: cleanupNorm(w.word), start: w.start }))
		.filter((w) => w.n.length > 0 && Number.isFinite(w.start));
	for (const term of terms) {
		const key = termKey(term);
		if (!key) continue;
		const starts: number[] = [];
		for (let i = 0; i < ws.length; i++) {
			let acc = '';
			for (let k = i; k < Math.min(ws.length, i + 6); k++) {
				acc += ws[k]!.n;
				if (acc === key) {
					starts.push(ws[i]!.start);
					i = k;
					break;
				}
				if (acc.length >= key.length || !key.startsWith(acc)) break;
			}
		}
		starts.sort((a, b) => a - b);
		for (let j = 0; j + minRepeats - 1 < starts.length; j++)
			if (starts[j + minRepeats - 1]! - starts[j]! <= windowSec) return term;
	}
	return null;
}
