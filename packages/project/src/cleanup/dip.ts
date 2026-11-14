// A restart hidden inside one transcribed word (docs/wp-notes/transcript-cleanup.md "Round 13"; speech.md §11.3
// "Hidden takes"). "y es extra… ¡extremadamente!" was written by large-v3-turbo as one "extremadamente" of 0.95 s,
// as long as the same speaker's clean "extremadamente" (0.88–0.92 s): duration cannot tell them apart. The level can:
// the abandoned "extra-" (−15 to −24 dBFS) breaks off into 20 ms at −41 dBFS, then the whole word starts loud 30 ms
// later. A word holding such a dip is a trace for the speech worker's re-decode and, when it stays one word, a review
// finding in Clean Up. Shared by both. Pure.
//
// A dip alone is common: consonant closures inside clean words dip as deep (*measured*, word times of whisper-tiny /
// tiny.en, refined): 506 of 3,119 words (16 %) of three LibriVox Spanish readings and 552 of 1,727 (32 %) of the LJ
// fixture repeated 11 times trip depth, length and onset alone. What a closure lacks is what a restart adds to a word:
// the fragment broken off at full voice before the dip, and the whole word after it. With those conditions 8 of the
// 3,119 Spanish words (0.26 %; 11 with the voice analysis' 25 ms level) and one LJ word ("tablespoonful", every repeat)
// still trip: closures after a loud nasal or /s/ ("compañero", "respondió", "tempestades").
//
// Levels are dBFS per 10 ms frame (the speech worker's frame RMS, or the voice analysis' level plane); frame bounds are
// half-open. Off by default (`RESTART_DIP_DEFAULT`, round 15): on real audio it missed the reported restart and
// tripped only on closures.
import { syllableCount } from './stretch.ts';

/**
 * Whether the restart dip runs by default — the speech worker's fourth hidden-take trace and Clean Up's review finding
 * (`restartDip` on `DetectInput`, `AnalyzeSequenceInput` and the speech job's `RunOptions` override it). Off since round
 * 15 (docs/wp-notes/transcript-cleanup.md "Round 15"; *measured* on the reporter's real 57-minute source with
 * large-v3-turbo): the reported "extremadamente" does not trip it — its fragment's last 30 ms lie at −27…−28 dBFS,
 * more than `DIP_BREAK_DB` under the word's median (−15.8) — while every one of the 7 review findings it raised there
 * was a stop closure ("des-[k]ansa", "dis-[t]into" twice, "ex-[p]ortarlo", "en-[t]eros") or a silent stretch inside
 * "¡Suscríbete"; loosening the break to 13 dB catches the word at the cost of 30 trips. The level alone cannot tell a
 * closure from a restart: it needs a better signal (a plosive-burst / spectral-onset detector, or a second voicing
 * onset) before it is turned back on.
 */
export const RESTART_DIP_DEFAULT = false;

/** 10 ms frames per second. */
const FRAMES_PER_SECOND = 100;
/** The dip lies strictly inside the word: not within this many frames (60 ms) of either edge (loose word bounds). */
export const DIP_EDGE_FRAMES = 6;
/** The dip's frames lie at least this far (dB) under the word's median level (the reported dip: ≈ 22 dB). */
export const DIP_DEPTH_DB = 15;
/** … for at least this many frames in a row (20 ms, what the reported dip lasts in the voice analysis' level). */
export const DIP_MIN_FRAMES = 2;
/** A new onset follows: within `DIP_ONSET_FRAMES` (40 ms) of the dip the level rises at least this far over its floor. */
export const DIP_ONSET_DB = 10;
export const DIP_ONSET_FRAMES = 4;
/**
 * The fragment breaks off at full voice: within `DIP_BREAK_FRAMES` (30 ms) before the dip a frame lies within this
 * many dB of the word's median. A closure after a fricative is reached from the fricative's lower level (measured: the
 * condition takes the Spanish false trips from 21 to 8 of 3,119 words); the reported fragment stays at −15 to −24 dBFS.
 */
export const DIP_BREAK_DB = 6;
export const DIP_BREAK_FRAMES = 3;
/** The fragment before the dip lasts at least this long (seconds: a syllable; the reported one 0.29 s of the word). */
export const DIP_HEAD_S = 0.15;
/**
 * After the dip there is time for the whole word: at least this share of what its syllables take at the speaker's
 * pace (the reported word: 0.68 s after the dip, 0.94 of its six syllables at 0.12 s). A closure inside a clean word
 * leaves only the rest of the word after it.
 */
export const DIP_TAIL_RATIO = 0.75;
/** A word of fewer syllables leaves no room to tell the whole word from its rest (`DIP_TAIL_RATIO`). */
export const DIP_MIN_SYLLABLES = 3;

/** A dip inside a word: frames `[start, end)` under the depth, `end` = the first frame of the new onset's rise. */
export type WordDip = { start: number; end: number };

/**
 * The first restart-shaped dip inside the word `text` of frames `[a, b)` (see the module docs), or null: a run of at
 * least `DIP_MIN_FRAMES` frames at least `DIP_DEPTH_DB` under the word's median level, none within `DIP_EDGE_FRAMES` of
 * the word's edges, after at least `DIP_HEAD_S` of the word and right after a frame within `DIP_BREAK_DB` of its median
 * (within `DIP_BREAK_FRAMES`), followed within `DIP_ONSET_FRAMES` by a frame `DIP_ONSET_DB` over the dip's quietest
 * one, with time after it for `DIP_TAIL_RATIO` of the word's `DIP_MIN_SYLLABLES` or more syllables at the speaker's
 * `pace` (seconds per syllable, `secondsPerSyllable`; null: no dip). `level(f)` is frame f's dBFS.
 */
export function wordDip(
	level: (f: number) => number,
	a: number,
	b: number,
	text: string,
	pace: number | null,
): WordDip | null {
	const n = b - a;
	const syllables = syllableCount(text);
	if (pace === null || !(pace > 0) || syllables < DIP_MIN_SYLLABLES) return null;
	if (!(n >= 2 * DIP_EDGE_FRAMES + DIP_MIN_FRAMES)) return null;
	const xs: number[] = [];
	for (let f = a; f < b; f++) {
		const x = level(f);
		if (!Number.isFinite(x)) return null;
		xs.push(x);
	}
	xs.sort((x, y) => x - y);
	const median = xs[(n - 1) >> 1]!;
	const deep = median - DIP_DEPTH_DB;
	const head = Math.max(a + DIP_EDGE_FRAMES, a + Math.ceil(DIP_HEAD_S * FRAMES_PER_SECOND - 1e-9));
	const tail = DIP_TAIL_RATIO * syllables * pace * FRAMES_PER_SECOND;
	for (let f = a; f < b; ) {
		if (level(f) > deep) {
			f++;
			continue;
		}
		let g = f;
		let floor = Number.POSITIVE_INFINITY;
		for (; g < b && level(g) <= deep; g++) floor = Math.min(floor, level(g));
		let broke = false;
		for (let k = Math.max(a, f - DIP_BREAK_FRAMES); k < f; k++)
			if (level(k) >= median - DIP_BREAK_DB) broke = true;
		let onset = false;
		for (let k = g; k < Math.min(b, g + DIP_ONSET_FRAMES); k++)
			if (level(k) >= floor + DIP_ONSET_DB) onset = true;
		if (
			g - f >= DIP_MIN_FRAMES &&
			f >= head &&
			g <= b - DIP_EDGE_FRAMES &&
			b - g >= tail - 1e-9 &&
			broke &&
			onset
		)
			return { start: f, end: g };
		f = g;
	}
	return null;
}
