// Energy-based tightening of word bounds. Ported from FilmCraft `crates/speech/src/vad.rs` (MIT OR Apache-2.0).
//
// Attention alignment places every word boundary on the next word's start, so silence between words is absorbed
// into the word before it (and leading silence into the first word). Pause detection and text-based editing need
// the silences, so each word's start and end move inward past 10 ms frames whose level is below a threshold set
// between the clip's noise floor (10th percentile of the levels of frames above −100 dBFS) and its speech level
// (95th percentile): 30 % of the way up, and at least 6 dB above the floor. A word keeps at least 60 ms.
//
// Times are 16 kHz sample indices.
import { SAMPLE_RATE } from './mel.ts';

export const VAD_FRAME = SAMPLE_RATE / 100;
export const MIN_WORD_FRAMES = 6;

export type TimedWord = { start: number; end: number };

/** Frame levels in dBFS (10 ms RMS). */
export function frameDb(audio: Float32Array): Float32Array {
	const n = Math.ceil(audio.length / VAD_FRAME);
	const out = new Float32Array(n);
	for (let f = 0; f < n; f++) {
		const a = f * VAD_FRAME;
		const b = Math.min(audio.length, a + VAD_FRAME);
		let e = 0;
		for (let i = a; i < b; i++) e += audio[i] * audio[i];
		e /= Math.max(1, b - a);
		out[f] = 10 * Math.log10(e + 1e-12);
	}
	return out;
}

/** The speech/silence threshold in dBFS. */
export function vadThreshold(db: ArrayLike<number>): number {
	// digital silence (< −100 dBFS) would drag the floor far below the recording's own noise
	const s: number[] = [];
	for (let i = 0; i < db.length; i++) if (db[i] > -100) s.push(db[i]);
	if (!s.length) return -60;
	s.sort((a, b) => a - b);
	const q = (p: number) => s[Math.floor((s.length - 1) * p)];
	const floor = q(0.1);
	const speech = q(0.95);
	return Math.max(floor + 0.3 * (speech - floor), floor + 6);
}

/** Moves word bounds (16 kHz samples) inward past silent frames (see the module docs). In place. */
export function tightenWords(audio: Float32Array, words: TimedWord[], db = frameDb(audio)): void {
	if (!db.length) return;
	const th = vadThreshold(db);
	for (const w of words) {
		const a = Math.max(0, Math.floor(w.start / VAD_FRAME));
		const b = Math.min(db.length, Math.max(0, Math.ceil(w.end / VAD_FRAME)));
		if (b <= a + MIN_WORD_FRAMES) continue;
		let s = a;
		while (s + MIN_WORD_FRAMES < b && db[s] < th) s++;
		let e = b;
		while (e > s + MIN_WORD_FRAMES && db[e - 1] < th) e--;
		// nothing voiced at all: leave the word alone
		let voiced = false;
		for (let f = s; f < e; f++)
			if (db[f] >= th) {
				voiced = true;
				break;
			}
		if (!voiced) continue;
		if (s > a) w.start = s * VAD_FRAME;
		if (e < b) w.end = Math.max(w.start, e * VAD_FRAME);
	}
}
