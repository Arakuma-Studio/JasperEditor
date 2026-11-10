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

/** What word-bound functions need of the audio: its length in samples (a Float32Array works). */
export type AudioLength = { readonly length: number };

/**
 * Speech evidence per 10 ms frame (spec 14 TC-004): `speech[f]` = 1 when the frame is speech or breath. From the
 * voice-analysis job's frame classes (TC-001) when available, else from the energy threshold (`voicedMask`).
 */
export type SpeechMask = ArrayLike<number>;

/** The energy-threshold mask: frames at or above `vadThreshold`. */
export function voicedMask(db: ArrayLike<number>, threshold = vadThreshold(db)): Uint8Array {
	const m = new Uint8Array(db.length);
	for (let f = 0; f < db.length; f++) m[f] = db[f] >= threshold ? 1 : 0;
	return m;
}

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
export function tightenWords(
	audio: AudioLength,
	words: TimedWord[],
	db = frameDb(audio as Float32Array),
	mask: SpeechMask = voicedMask(db),
): void {
	if (!db.length) return;
	const on = (f: number) => mask[f] > 0;
	for (const w of words) {
		const a = Math.max(0, Math.floor(w.start / VAD_FRAME));
		const b = Math.min(db.length, Math.max(0, Math.ceil(w.end / VAD_FRAME)));
		if (b <= a + MIN_WORD_FRAMES) continue;
		let s = a;
		while (s + MIN_WORD_FRAMES < b && !on(s)) s++;
		let e = b;
		while (e > s + MIN_WORD_FRAMES && !on(e - 1)) e--;
		// nothing voiced at all: leave the word alone
		let voiced = false;
		for (let f = s; f < e; f++)
			if (on(f)) {
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
	audio: AudioLength,
	words: TimedWord[],
	db = frameDb(audio as Float32Array),
	maxFrames = 25,
	mask: SpeechMask = voicedMask(db),
): void {
	if (!db.length) return;
	const on = (f: number) => mask[f] > 0;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const prevEnd = i > 0 ? words[i - 1].end : 0;
		const nextStart = i + 1 < words.length ? words[i + 1].start : audio.length;
		// end: frames from the word's end onward
		let e = Math.ceil(w.end / VAD_FRAME);
		const eLimit = Math.min(db.length, Math.floor(nextStart / VAD_FRAME), e + maxFrames);
		if (e > 0 && on(e - 1)) while (e < eLimit && on(e)) e++;
		if (e * VAD_FRAME > w.end) w.end = Math.min(nextStart, e * VAD_FRAME);
		// start: frames before the word's start
		let s = Math.floor(w.start / VAD_FRAME);
		const sLimit = Math.max(0, Math.ceil(prevEnd / VAD_FRAME), s - maxFrames);
		if (s < db.length && on(s)) while (s > sLimit && on(s - 1)) s--;
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
 * A word with no voiced frame at all (placed inside a pause) moves onto a voiced run that no word covers only when
 * that run is closer than a pause (`SPLIT_PAUSE_FRAMES`) — alignment jitter. It never moves across a silence into
 * speech (spec 16 SG-011: hallucinated text in silence was moved onto real speech that way); such words are
 * returned (indices, ascending) for the caller to drop.
 */
export function splitAtPauses(
	audio: AudioLength,
	words: TimedWord[],
	db = frameDb(audio as Float32Array),
	mask: SpeechMask = voicedMask(db),
): number[] {
	const orphans: number[] = [];
	if (!db.length) return orphans;
	const voiced = (f: number) => f >= 0 && f < db.length && mask[f] > 0;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const a0 = Math.max(0, Math.floor(w.start / VAD_FRAME));
		const b0 = Math.min(db.length, Math.max(a0 + 1, Math.ceil(w.end / VAD_FRAME)));
		let any = false;
		for (let f = a0; f < b0 && !any; f++) any = voiced(f);
		if (!any) {
			const lo = Math.max(i > 0 ? Math.ceil(words[i - 1].end / VAD_FRAME) : 0, a0 - SPLIT_PAUSE_FRAMES);
			const hi = Math.min(
				i + 1 < words.length ? Math.floor(words[i + 1].start / VAD_FRAME) : db.length,
				b0 + SPLIT_PAUSE_FRAMES,
			);
			// nearest unassigned voiced run closer than a pause: backwards first (alignment drifts late), then forwards
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
			} else orphans.push(i);
			continue;
		}
		const a = Math.max(0, Math.floor(w.start / VAD_FRAME));
		const b = Math.min(db.length, Math.ceil(w.end / VAD_FRAME));
		// longest silent run inside [a, b)
		let best = { s: -1, e: -1 };
		let runStart = -1;
		for (let f = a; f <= b; f++) {
			const silent = f < b && !voiced(f);
			if (silent && runStart < 0) runStart = f;
			if (!silent && runStart >= 0) {
				if (f - runStart > best.e - best.s) best = { s: runStart, e: f };
				runStart = -1;
			}
		}
		if (best.e - best.s < SPLIT_PAUSE_FRAMES || best.s <= a || best.e >= b) continue;
		let before = 0;
		let after = 0;
		for (let f = a; f < best.s; f++) if (voiced(f)) before++;
		for (let f = best.e; f < b; f++) if (voiced(f)) after++;
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
	return orphans;
}

/** Share of a word's 10 ms frames that are speech (or breath) in `mask`; a zero-length word reads its one frame. */
export function voicedFraction(w: TimedWord, mask: SpeechMask): number {
	const n = mask.length;
	if (!n) return 0;
	const a = Math.min(n - 1, Math.max(0, Math.floor(w.start / VAD_FRAME)));
	const b = Math.min(n, Math.max(a + 1, Math.ceil(w.end / VAD_FRAME)));
	let v = 0;
	for (let f = a; f < b; f++) if (mask[f] > 0) v++;
	return v / (b - a);
}

/** Spec 14 TC-003: minimum share of speech/breath frames a word keeps (below it the word lies in silence). */
export const MIN_VOICED_FRACTION = 0.2;

/** Indices (ascending) of words whose frames are less than `minFraction` speech — words lying in silence. */
export function unvoicedWords(
	words: readonly TimedWord[],
	mask: SpeechMask,
	minFraction = MIN_VOICED_FRACTION,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < words.length; i++) if (voicedFraction(words[i], mask) < minFraction) out.push(i);
	return out;
}

/** Voiced frames of `mask` in [from, to) (10 ms frames). */
export function countVoiced(mask: SpeechMask, from: number, to: number): number {
	let v = 0;
	for (let f = Math.max(0, from); f < Math.min(mask.length, to); f++) if (mask[f] > 0) v++;
	return v;
}

/**
 * The first voiced frame of `mask` in [from, limit) that follows at least `minSilence` unvoiced frames (counted from
 * `from`), or null: voice after a long silence that resuming decoding at `limit` would skip.
 */
export function voiceAfterSilence(
	mask: SpeechMask,
	from: number,
	limit: number,
	minSilence: number,
): number | null {
	let silent = 0;
	for (let f = Math.max(0, from); f < Math.min(limit, mask.length); f++) {
		if (!(mask[f] > 0)) silent++;
		else if (silent >= minSilence) return f;
		else silent = 0;
	}
	return null;
}
