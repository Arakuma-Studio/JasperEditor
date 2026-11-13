// Hallucination guards (spec 16 SG-011, spec 14 TC-003). Whisper invents text over silence and noise — "Gracias
// por ver el vídeo", "Subtítulos realizados por la comunidad de Amara.org", "Thanks for watching!", loops of one
// token — and the previous-text prompt carries it into the next window. The guards here are pure:
//
// - `dropRepeatedTokenRuns`: runs of ≥ 4 identical text tokens are removed (TC-003).
// - `wordAnomalyScore` / `isSegmentAnomaly` / `silenceThresholdCut`: OpenAI Whisper's
//   `hallucination_silence_threshold` heuristic (`transcribe.py`, MIT, v20231117+): a segment of improbable,
//   too-short or too-long words surrounded by ≥ `threshold` seconds of silence (or more anomalies) is dropped
//   with everything after it in the window, and decoding resumes at its start. OpenAI judges "silence" by the word
//   times alone (a window edge counts as silence); JasperEditor adds the audio: a segment over voiced audio is never
//   dropped, and a voiced lead-in is never skipped (`voicedShare`; dense speech, see `SILENCE_MAX_VOICED`).
// - `knownPhraseRuns`: phrases Whisper is known to produce over non-speech; the caller drops them when they sit
//   over non-speech (`phraseOverNonSpeech`).
import { APPEND_PUNCTUATIONS, PREPEND_PUNCTUATIONS } from './tokenizer.ts';

/** TC-003: shortest run of one repeated text token that is removed. */
export const MIN_REPEAT_RUN = 4;

/**
 * Removes runs of ≥ `minRun` identical consecutive text tokens (ids below `textLimit`, the end-of-text id).
 * Returns the kept tokens and the removed runs.
 */
export function dropRepeatedTokenRuns(
	tokens: readonly number[],
	textLimit: number,
	minRun = MIN_REPEAT_RUN,
): { tokens: number[]; removed: number[][] } {
	const out: number[] = [];
	const removed: number[][] = [];
	let i = 0;
	while (i < tokens.length) {
		let j = i + 1;
		if (tokens[i] < textLimit) while (j < tokens.length && tokens[j] === tokens[i]) j++;
		if (tokens[i] < textLimit && j - i >= minRun) removed.push(tokens.slice(i, j));
		else for (let k = i; k < j; k++) out.push(tokens[k]);
		i = j;
	}
	return { tokens: out, removed };
}

/** OpenAI's punctuation set for the anomaly score (prepend + append punctuations). */
const PUNCTUATION = new Set([...PREPEND_PUNCTUATIONS, ...APPEND_PUNCTUATIONS]);

export type ScoredWord = { word: string; start: number; end: number; probability: number };
export type ScoredSegment = { start: number; end: number; words: ScoredWord[] };

/** OpenAI `word_anomaly_score`: improbable (< 0.15), very short (< 0.133 s) or very long (> 2 s) words. */
export function wordAnomalyScore(w: ScoredWord): number {
	const duration = w.end - w.start;
	let score = 0;
	if (w.probability < 0.15) score += 1;
	if (duration < 0.133) score += (0.133 - duration) * 15;
	if (duration > 2) score += duration - 2;
	return score;
}

/** OpenAI `is_segment_anomaly` over the first 8 non-punctuation words. */
export function isSegmentAnomaly(seg: ScoredSegment | null | undefined): boolean {
	if (!seg?.words.length) return false;
	const words = seg.words.filter((w) => !PUNCTUATION.has(w.word.trim())).slice(0, 8);
	const score = words.reduce((s, w) => s + wordAnomalyScore(w), 0);
	return score >= 3 || score + 0.01 >= words.length;
}

/**
 * A stretch of audio is silence for the silence-threshold rule only when less than this share of its 10 ms frames
 * is voiced (the energy VAD, whose threshold sits between the file's measured noise floor and speech level). Reported
 * on a loudness-normalised mixdown of a 57-minute Spanish talking head (large-v3-turbo): fast speech with many short
 * function words scores as an anomaly (OpenAI: words under 0.133 s), a window edge counts as silence, and the rule
 * removed 166 spoken words, whole sentences among them.
 */
export const SILENCE_MAX_VOICED = 0.5;

/**
 * OpenAI's `hallucination_silence_threshold` step for one window (times in seconds): returns how many segments to
 * keep and where to seek next (seconds), or `skipTo` when the first segment is an anomaly after a long leading
 * silence (the window is then decoded again from there). `lastSpeech` = end of the last kept speech before this
 * window; `windowEnd` = end of the window's content; `contentEnd` = end of the audio.
 */
export function silenceThresholdCut(
	segments: readonly ScoredSegment[],
	opts: {
		threshold: number;
		windowStart: number;
		windowEnd: number;
		contentEnd: number;
		lastSpeech: number;
		singleTimestampEnding: boolean;
		/** The seek OpenAI's word-timestamp rule chose (seconds). */
		seek: number;
		/**
		 * Share of voiced 10 ms frames in [start, end) (seconds). A segment over voice (≥ `SILENCE_MAX_VOICED`) is never
		 * dropped, and a lead-in that is voice is never skipped. Absent: OpenAI's rule on word times alone.
		 */
		voicedShare?: (start: number, end: number) => number;
	},
): { keep: number; seek: number; skipTo: number | null } {
	const { threshold, windowStart, windowEnd } = opts;
	const voiced = (start: number, end: number) =>
		!!opts.voicedShare && end > start && opts.voicedShare(start, end) >= SILENCE_MAX_VOICED;
	const overVoice = (seg: ScoredSegment) => voiced(seg.words[0]!.start, seg.words[seg.words.length - 1]!.end);
	let seek = opts.seek;
	const withWords = segments.filter((s) => s.words.length);
	const lastWordEnd = withWords.length ? withWords[withWords.length - 1].words.at(-1)?.end : undefined;
	if (!opts.singleTimestampEnding && lastWordEnd !== undefined && lastWordEnd > windowStart) {
		const remaining = windowEnd - lastWordEnd;
		seek = remaining > threshold ? lastWordEnd : windowEnd;
	}
	const first = withWords[0];
	if (first && isSegmentAnomaly(first)) {
		const gap = first.start - windowStart;
		if (gap > threshold && !overVoice(first) && !voiced(windowStart, first.start))
			return { keep: 0, seek: windowStart + gap, skipTo: windowStart + gap };
	}
	let halLastEnd = opts.lastSpeech;
	for (let si = 0; si < segments.length; si++) {
		const seg = segments[si];
		if (!seg.words.length) continue;
		if (isSegmentAnomaly(seg)) {
			const next = segments.slice(si + 1).find((s) => s.words.length) ?? null;
			const halNextStart = next ? next.words[0].start : windowEnd;
			const silenceBefore =
				seg.start - halLastEnd > threshold || seg.start < threshold || seg.start - windowStart < 2;
			const silenceAfter =
				halNextStart - seg.end > threshold || isSegmentAnomaly(next) || windowEnd - seg.end < 2;
			if (silenceBefore && silenceAfter && !overVoice(seg)) {
				let s = Math.max(windowStart + 1, seg.start);
				if (opts.contentEnd - seg.end < threshold) s = opts.contentEnd;
				return { keep: si, seek: s, skipTo: null };
			}
		}
		halLastEnd = seg.end;
	}
	return { keep: segments.length, seek, skipTo: null };
}

/**
 * Phrases Whisper is known to produce over silence, music and noise (subtitle credits and video outros from its
 * training data). Spanish entries were measured on the user's voice-overs (spec 16 §0, private research) or are
 * listed by spec 14 TC-003; English ones are the widely reported equivalents (assumption: common reports, not
 * measured here).
 */
export const KNOWN_HALLUCINATIONS: readonly string[] = [
	'Subtítulos realizados por la comunidad de Amara.org',
	'Subtítulos por la comunidad de Amara.org',
	'Gracias por ver el video',
	'Gracias por ver el vídeo',
	'Gracias por ver',
	'Gracias.',
	'CC por Antarctica Films Argentina',
	'www.mooji.org',
	'Suscríbete al canal',
	'Thanks for watching!',
	'Thank you for watching.',
	'Thank you.',
	'Please subscribe to my channel.',
	'Subtitles by the Amara.org community',
];

/** Lower case, no accents, no punctuation, single spaces. */
export function normalizePhrase(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const PHRASES = [...new Set(KNOWN_HALLUCINATIONS.map(normalizePhrase))]
	.map((p) => p.split(' ').filter(Boolean))
	.filter((p) => p.length)
	.sort((a, b) => b.length - a.length);

/** A word ending a sentence ("vídeo.", "watching!"). */
const ENDS_SENTENCE = /[.!?…。！？]["'”)\]]*$/u;

/**
 * Word ranges `[i0, i1)` whose normalised text is a whole known phrase (longest match first, non-overlapping), as a
 * sentence of its own: the word before it ends a sentence (or there is none) and its last word ends one (or is the
 * last word) — so "Gracias a todos" is never taken for "Gracias.". Words that normalise to nothing (punctuation)
 * inside a run are part of it.
 */
export function knownPhraseRuns(words: readonly { text: string }[]): Array<[number, number]> {
	const norm = words.map((w) => normalizePhrase(w.text));
	const out: Array<[number, number]> = [];
	let i = 0;
	while (i < words.length) {
		let matched = 0;
		for (const p of PHRASES) {
			let k = 0;
			let j = i;
			while (j < words.length && k < p.length) {
				if (!norm[j]) {
					j++;
					continue;
				}
				// a word may hold several phrase words ("Amara.org" → "amaraorg") or one
				const joined = norm[j].split(' ');
				let ok = true;
				for (const part of joined) {
					if (p[k] !== part) {
						ok = false;
						break;
					}
					k++;
				}
				if (!ok) break;
				j++;
			}
			const startsSentence = i === 0 || ENDS_SENTENCE.test(words[i - 1]?.text.trim() ?? '');
			const endsSentence = j === words.length || ENDS_SENTENCE.test(words[j - 1]?.text.trim() ?? '');
			if (k === p.length && j > i && startsSentence && endsSentence) {
				matched = j - i;
				break;
			}
		}
		if (matched) {
			out.push([i, i + matched]);
			i += matched;
		} else i++;
	}
	return out;
}

/**
 * Whether a known phrase sits over non-speech: less than half of its frames are speech/breath (TC-003). With the
 * energy mask (no voice analysis yet) music and noise count as speech, so an outro over music is kept — the
 * voice-analysis frame classes (TC-001) tell them apart. A spoken "Gracias." over speech is always kept.
 */
export function phraseOverNonSpeech(voicedFraction: number): boolean {
	return voicedFraction < 0.5;
}
