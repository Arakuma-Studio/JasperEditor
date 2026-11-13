// Stretched words relative to the speaker's own pace (docs/wp-notes/transcript-cleanup.md "Round 12"; speech.md §11.3
// "Hidden takes"). Whisper writes a phrase said twice back to back once and stretches a word over both takes. A fixed
// 1 s missed short words stretched to just under it; a word now also counts as stretched when it lasts
// `STRETCH_RATIO` times what its syllables take at the speaker's median pace, measured from the transcript itself.
// Shared by the Clean Up detector and the speech worker's hidden-take trigger. Pure.
import { cleanupNorm } from './lists.ts';

/** A word longer than this (seconds) is stretched whatever its length in syllables (the original rule). */
export const STRETCH_ABS_S = 1;
/**
 * A shorter word is stretched when it lasts at least this many times its expected duration (syllables × the speaker's
 * median seconds per syllable)… *Measured* on the real-take corpus (11,736 words of one speaker, whisper-large-v3-turbo):
 * at 3× and ≥ 0.6 s, 56 words (0.5 %) qualify — drawn-out "un", "mi", "de", "y" and stretched words of hidden takes
 * (fragment E "mes", "lo", "de") — against 157 at 2× and 305 at 1.5×.
 */
export const STRETCH_RATIO = 3;
/** … and lasts at least this long (seconds): two syllables of a re-said take beyond a normal word. */
export const STRETCH_REL_MIN_S = 0.6;
/** Words measured for the pace: at least two syllables, at most `STRETCH_ABS_S` long; fewer than this → no pace. */
const PACE_MIN_WORDS = 20;

/**
 * Syllables of a word, approximated by its vowel groups after normalisation ("extremadamente" 6, "es" 1, "y" 1; a
 * diphthong counts once, a hiatus such as "día" once too). 0 for a word without letters (a number written in digits).
 */
export function syllableCount(text: string): number {
	const n = cleanupNorm(text).replace(/[^a-zñ]/g, '');
	return n.match(/[aeiouy]+/g)?.length ?? 0;
}

/**
 * The speaker's median seconds per syllable over words of at least two syllables lasting at most `STRETCH_ABS_S`
 * (`seconds` of each word); null with fewer than `PACE_MIN_WORDS` such words.
 */
export function secondsPerSyllable(words: Iterable<{ text: string; seconds: number }>): number | null {
	const per: number[] = [];
	for (const w of words) {
		const n = syllableCount(w.text);
		if (n >= 2 && Number.isFinite(w.seconds) && w.seconds > 0 && w.seconds <= STRETCH_ABS_S)
			per.push(w.seconds / n);
	}
	if (per.length < PACE_MIN_WORDS) return null;
	per.sort((a, b) => a - b);
	return per[Math.floor(per.length / 2)]!;
}

/**
 * Whether a word of `seconds` is stretched: longer than `STRETCH_ABS_S`, or — with the speaker's pace
 * (`secondsPerSyllable`) — at least `STRETCH_REL_MIN_S` long and `STRETCH_RATIO` times its expected duration.
 */
export function stretchedWord(text: string, seconds: number, pace: number | null): boolean {
	if (seconds > STRETCH_ABS_S) return true;
	if (pace === null || !(seconds >= STRETCH_REL_MIN_S)) return false;
	const n = syllableCount(text);
	return n > 0 && seconds >= STRETCH_RATIO * n * pace;
}
