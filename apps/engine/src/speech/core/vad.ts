// Energy-based tightening of word bounds. Ported from FilmCraft `crates/speech/src/vad.rs` (MIT OR Apache-2.0).
//
// Attention alignment places every word boundary on the next word's start, so silence between words is absorbed
// into the word before it (and leading silence into the first word). Pause detection and text-based editing need
// the silences, so each word's start and end move inward past 10 ms frames whose level is below a threshold set
// between the clip's noise floor (10th percentile of the levels of frames above −100 dBFS) and its speech level
// (95th percentile): 30 % of the way up, and at least 6 dB above the floor. A word keeps at least 60 ms.
//
// Times are 16 kHz sample indices.
import { levelStats, speechThresholdDb } from '@jasper/audio-dsp';
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

/**
 * The speech/silence threshold in dBFS: the floor/speech-level rule shared with the voice analysis (spec 14 TC-002,
 * `levelStats` / `speechThresholdDb` of @jasper/audio-dsp); −60 when every frame is digital silence.
 */
export function vadThreshold(db: ArrayLike<number>): number {
	const s = levelStats(db);
	return s ? speechThresholdDb(s.floorDb, s.speechDb) : -60;
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

/**
 * Grows word bounds outward into voiced frames that border a pause (JasperEditor addition): attention alignment
 * tends to end the last word before a pause early and start the first word after it late, by up to a couple of
 * hundred milliseconds. A bound moves at most `maxFrames` (default 25 = 250 ms), never into a neighbouring word,
 * and only through frames above the speech threshold. In place; run before `tightenWords`.
 */
export function extendWordsIntoSpeech(
	audio: Float32Array,
	words: TimedWord[],
	db = frameDb(audio),
	maxFrames = 25,
): void {
	if (!db.length) return;
	const th = vadThreshold(db);
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const prevEnd = i > 0 ? words[i - 1].end : 0;
		const nextStart = i + 1 < words.length ? words[i + 1].start : audio.length;
		// end: frames from the word's end onward
		let e = Math.ceil(w.end / VAD_FRAME);
		const eLimit = Math.min(db.length, Math.floor(nextStart / VAD_FRAME), e + maxFrames);
		if (e > 0 && db[e - 1] >= th) while (e < eLimit && db[e] >= th) e++;
		if (e * VAD_FRAME > w.end) w.end = Math.min(nextStart, e * VAD_FRAME);
		// start: frames before the word's start
		let s = Math.floor(w.start / VAD_FRAME);
		const sLimit = Math.max(0, Math.ceil(prevEnd / VAD_FRAME), s - maxFrames);
		if (s < db.length && db[s] >= th) while (s > sLimit && db[s - 1] >= th) s--;
		if (s * VAD_FRAME < w.start) w.start = Math.max(prevEnd, s * VAD_FRAME);
	}
}

/**
 * The first unvoiced 10 ms frame at or after `frame`, but not past `limit` (both in frames): where to resume
 * decoding after a window whose last word was timed to end early.
 */
export function endOfVoice(db: ArrayLike<number>, threshold: number, frame: number, limit: number): number {
	let f = Math.max(0, frame);
	const lim = Math.min(limit, db.length);
	while (f < lim && db[f] >= threshold) f++;
	return f;
}

/** Shortest pause (10 ms frames) inside a word that `splitAtPauses` treats as a boundary between two words. */
export const SPLIT_PAUSE_FRAMES = 20;

/**
 * Repairs words that straddle a pause (JasperEditor addition): when a word contains a silent run of at least
 * 200 ms, its voice lies on one side of the pause and the few voiced frames on the other side belong to the
 * neighbouring word (the alignment put the boundary in the wrong place). The word keeps the side with more voiced
 * frames; the other side is handed to the adjacent neighbour when there is one. In place; run before
 * `tightenWords`.
 *
 * A word with no voiced frame at all (placed inside a pause) moves onto the nearest voiced run that no word
 * covers, between it and its neighbours (within 1.5 s): typically the tail of a sentence the alignment left
 * unassigned.
 */
export function splitAtPauses(audio: Float32Array, words: TimedWord[], db = frameDb(audio)): void {
	if (!db.length) return;
	const th = vadThreshold(db);
	const voiced = (f: number) => f >= 0 && f < db.length && db[f] >= th;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const a0 = Math.max(0, Math.floor(w.start / VAD_FRAME));
		const b0 = Math.min(db.length, Math.max(a0 + 1, Math.ceil(w.end / VAD_FRAME)));
		let any = false;
		for (let f = a0; f < b0 && !any; f++) any = voiced(f);
		if (!any) {
			const lo = Math.max(i > 0 ? Math.ceil(words[i - 1].end / VAD_FRAME) : 0, a0 - 150);
			const hi = Math.min(
				i + 1 < words.length ? Math.floor(words[i + 1].start / VAD_FRAME) : db.length,
				b0 + 150,
			);
			// nearest unassigned voiced run: backwards first (alignment drifts late), then forwards
			let run: [number, number] | null = null;
			for (let f = a0 - 1; f >= lo; f--)
				if (voiced(f)) {
					let s0 = f;
					while (s0 > lo && voiced(s0 - 1)) s0--;
					run = [s0, f + 1];
					break;
				}
			if (!run)
				for (let f = b0; f < hi; f++)
					if (voiced(f)) {
						let e0 = f + 1;
						while (e0 < hi && voiced(e0)) e0++;
						run = [f, e0];
						break;
					}
			if (run) {
				w.start = run[0] * VAD_FRAME;
				w.end = run[1] * VAD_FRAME;
			}
			continue;
		}
		const a = Math.max(0, Math.floor(w.start / VAD_FRAME));
		const b = Math.min(db.length, Math.ceil(w.end / VAD_FRAME));
		// longest silent run inside [a, b)
		let best = { s: -1, e: -1 };
		let runStart = -1;
		for (let f = a; f <= b; f++) {
			const silent = f < b && db[f] < th;
			if (silent && runStart < 0) runStart = f;
			if (!silent && runStart >= 0) {
				if (f - runStart > best.e - best.s) best = { s: runStart, e: f };
				runStart = -1;
			}
		}
		if (best.e - best.s < SPLIT_PAUSE_FRAMES || best.s <= a || best.e >= b) continue;
		let before = 0;
		let after = 0;
		for (let f = a; f < best.s; f++) if (db[f] >= th) before++;
		for (let f = best.e; f < b; f++) if (db[f] >= th) after++;
		if (before < after) {
			const prev = words[i - 1];
			if (prev && prev.end >= w.start - VAD_FRAME) prev.end = Math.max(prev.end, best.s * VAD_FRAME);
			w.start = best.e * VAD_FRAME;
		} else {
			const next = words[i + 1];
			if (next && next.start <= w.end + VAD_FRAME) next.start = Math.min(next.start, best.e * VAD_FRAME);
			w.end = best.s * VAD_FRAME;
		}
	}
}
