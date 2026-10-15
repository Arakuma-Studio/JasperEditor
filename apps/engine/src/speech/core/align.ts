// Word timing from cross-attention: token-to-audio alignment by dynamic time warping over the averaged,
// normalised attention of the model's alignment heads, then word timings with OpenAI Whisper's heuristics.
//
// - `medianFilter`, `dtw` and the attention normalisation are ported from FilmCraft
//   `crates/speech/src/whisper/align.rs` (MIT OR Apache-2.0), which follows OpenAI's `timing.find_alignment`.
// - `wordTimings`, `mergePunctuations` and `adjustSegmentWords` port OpenAI Whisper `timing.py`
//   (`find_alignment` word boundaries, `merge_punctuations`, `add_word_timestamps`; MIT) — FilmCraft has none of
//   the duration heuristics, which keep the first word after a pause and words before sentence ends from
//   swallowing silence.
import { APPEND_PUNCTUATIONS, PREPEND_PUNCTUATIONS } from './tokenizer.ts';

/** Median filter with reflect padding (numpy "reflect"). */
function medianFilter(x: ArrayLike<number>, width: number): Float32Array {
	const n = x.length;
	const out = new Float32Array(n);
	if (n === 0) return out;
	if (width <= 1) {
		for (let i = 0; i < n; i++) out[i] = x[i];
		return out;
	}
	const half = Math.floor(width / 2);
	const at = (i: number): number => {
		if (n === 1) return x[0];
		const p = 2 * (n - 1);
		let j = ((i % p) + p) % p;
		if (j >= n) j = p - j;
		return x[j];
	};
	const buf = new Float64Array(width);
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < width; k++) buf[k] = at(i + k - half);
		buf.sort();
		out[i] = buf[half];
	}
	return out;
}

/**
 * Dynamic time warping through `cost` (`n × m`, row-major) with monotonic steps (diagonal, down, right).
 * Returns the path from (0, 0) to (n − 1, m − 1) as [row, column] pairs.
 */
function dtw(cost: Float32Array, n: number, m: number): Array<[number, number]> {
	const W = m + 1;
	const acc = new Float64Array((n + 1) * W).fill(Number.POSITIVE_INFINITY);
	const trace = new Uint8Array((n + 1) * W);
	acc[0] = 0;
	for (let j = 1; j <= m; j++) {
		for (let i = 1; i <= n; i++) {
			const c0 = acc[(i - 1) * W + j - 1];
			const c1 = acc[(i - 1) * W + j];
			const c2 = acc[i * W + j - 1];
			let c: number;
			let t: number;
			if (c0 < c1 && c0 < c2) {
				c = c0;
				t = 0;
			} else if (c1 < c0 && c1 < c2) {
				c = c1;
				t = 1;
			} else {
				c = c2;
				t = 2;
			}
			acc[i * W + j] = cost[(i - 1) * m + (j - 1)] + c;
			trace[i * W + j] = t;
		}
	}
	for (let j = 0; j <= m; j++) trace[j] = 2;
	for (let i = 0; i <= n; i++) trace[i * W] = 1;
	let i = n;
	let j = m;
	const path: Array<[number, number]> = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0) path.push([i - 1, j - 1]);
		const t = trace[i * W + j];
		if (t === 0) {
			i--;
			j--;
		} else if (t === 1) i--;
		else j--;
	}
	return path.reverse();
}

/**
 * The alignment cost path for one window. `attn[h]` is the cross-attention (probabilities over all encoder
 * frames, `tokens × framesAll` row-major) of alignment head h for the full token sequence
 * `[...sotSequence, noTimestamps, ...text, eot]`. Only the first `frames` audio frames (20 ms each) count.
 * Returns, for every text token i, the attention frame where its row is first reached (`jump[i]`), plus
 * `jump[text]` = the frame where the end-of-text row starts.
 */
export function alignTokens(
	attn: readonly Float32Array[],
	tokens: number,
	framesAll: number,
	frames: number,
	firstRow: number,
	textLength: number,
	medianWidth = 7,
): number[] {
	const f = Math.max(1, Math.min(frames, framesAll));
	const rows = textLength + 1;
	const matrix = new Float32Array(rows * f);
	const h = attn.length;
	for (const head of attn) {
		// renormalise over the kept frames (= softmax of the logits restricted to them, as OpenAI does)
		const w = new Float32Array(tokens * f);
		for (let t = 0; t < tokens; t++) {
			let s = 0;
			for (let j = 0; j < f; j++) s += head[t * framesAll + j];
			const inv = s > 0 ? 1 / s : 0;
			for (let j = 0; j < f; j++) w[t * f + j] = head[t * framesAll + j] * inv;
		}
		// standardise over tokens for every frame
		for (let j = 0; j < f; j++) {
			let mean = 0;
			for (let t = 0; t < tokens; t++) mean += w[t * f + j];
			mean /= tokens;
			let vr = 0;
			for (let t = 0; t < tokens; t++) vr += (w[t * f + j] - mean) ** 2;
			const sd = Math.max(1e-8, Math.sqrt(vr / tokens));
			for (let t = 0; t < tokens; t++) w[t * f + j] = (w[t * f + j] - mean) / sd;
		}
		for (let r = 0; r < rows; r++) {
			const row = medianFilter(w.subarray((firstRow + r) * f, (firstRow + r + 1) * f), medianWidth);
			for (let j = 0; j < f; j++) matrix[r * f + j] += row[j] / h;
		}
	}
	for (let i = 0; i < matrix.length; i++) matrix[i] = -matrix[i];
	const path = dtw(matrix, rows, f);
	const jump = new Array<number>(rows).fill(-1);
	for (const [i, j] of path) if (jump[i] < 0) jump[i] = j;
	return jump.map((j) => Math.min(Math.max(0, j), f));
}

export type WordTiming = {
	word: string;
	tokens: number[];
	/** Seconds from the window start. */
	start: number;
	end: number;
	probability: number;
};

/** Attention frames per second (Whisper: 1500 frames per 30 s). */
export const TOKENS_PER_SECOND = 50;

/** OpenAI `find_alignment`'s word boundaries: word i spans the jumps of its first token to the next word's. */
export function wordTimings(
	words: ReadonlyArray<{ word: string; tokens: number[] }>,
	jump: readonly number[],
	tokenProbs: readonly number[],
): WordTiming[] {
	const out: WordTiming[] = [];
	let b = 0;
	for (const w of words) {
		const e = b + w.tokens.length;
		let p = 0;
		for (let i = b; i < e; i++) p += tokenProbs[i] ?? 0;
		out.push({
			word: w.word,
			tokens: [...w.tokens],
			start: (jump[b] ?? 0) / TOKENS_PER_SECOND,
			end: (jump[e] ?? jump[jump.length - 1] ?? 0) / TOKENS_PER_SECOND,
			probability: w.tokens.length ? p / w.tokens.length : 0,
		});
		b = e;
	}
	return out;
}

/** OpenAI `merge_punctuations`: opening punctuation joins the next word, closing punctuation the previous one. */
export function mergePunctuations(
	alignment: WordTiming[],
	prepended = PREPEND_PUNCTUATIONS,
	appended = APPEND_PUNCTUATIONS,
): void {
	// merge prepended punctuations
	let i = alignment.length - 2;
	let j = alignment.length - 1;
	while (i >= 0) {
		const previous = alignment[i];
		const following = alignment[j];
		if (previous.word.startsWith(' ') && prepended.includes(previous.word.trim())) {
			following.word = previous.word + following.word;
			following.tokens = [...previous.tokens, ...following.tokens];
			previous.word = '';
			previous.tokens = [];
		} else j = i;
		i--;
	}
	// merge appended punctuations
	i = 0;
	j = 1;
	while (j < alignment.length) {
		const previous = alignment[i];
		const following = alignment[j];
		if (!previous.word.endsWith(' ') && appended.includes(following.word)) {
			previous.word = previous.word + following.word;
			previous.tokens = [...previous.tokens, ...following.tokens];
			following.word = '';
			following.tokens = [];
		} else i = j;
		j++;
	}
}

export type SegmentWords = {
	/** Seconds (absolute). */
	start: number;
	end: number;
	textTokens: number[];
	words: Array<{ word: string; start: number; end: number; probability: number }>;
};

/**
 * OpenAI `add_word_timestamps` for the segments of one window: median-duration capping at sentence ends, punctuation
 * merging, distribution of the words over the segments, and the first/last-word corrections against the
 * segment timestamps. `alignment` is the window's word timing (seconds from the window start = `offset`).
 * Returns the last speech time (for the next window).
 */
export function addWordTimestamps(
	segments: SegmentWords[],
	alignment: WordTiming[],
	offset: number,
	lastSpeechTimestamp: number,
): number {
	if (!segments.length) return lastSpeechTimestamp;
	const durations = alignment.map((t) => t.end - t.start).filter((d) => d !== 0);
	const sorted = [...durations].sort((a, b) => a - b);
	let median = 0;
	if (sorted.length) {
		const m = sorted.length >> 1;
		median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
	}
	median = Math.min(0.7, median);
	const maxDuration = median * 2;
	// truncate long words at sentence boundaries
	if (durations.length) {
		const sentenceEnd = '.。!！?？';
		for (let i = 1; i < alignment.length; i++) {
			const a = alignment[i];
			if (a.end - a.start > maxDuration) {
				if (a.word.length > 0 && sentenceEnd.includes(a.word)) a.end = a.start + maxDuration;
				else if (alignment[i - 1].word.length > 0 && sentenceEnd.includes(alignment[i - 1].word))
					a.start = a.end - maxDuration;
			}
		}
	}
	mergePunctuations(alignment);
	const round2 = (x: number) => Math.round(x * 100) / 100;
	let wi = 0;
	let last = lastSpeechTimestamp;
	for (const segment of segments) {
		let saved = 0;
		const words: SegmentWords['words'] = [];
		while (wi < alignment.length && saved < segment.textTokens.length) {
			const t = alignment[wi];
			if (t.word)
				words.push({
					word: t.word,
					start: round2(offset + t.start),
					end: round2(offset + t.end),
					probability: t.probability,
				});
			saved += t.tokens.length;
			wi++;
		}
		if (words.length) {
			// the first and second word after a pause are not longer than twice the median word duration
			if (
				words[0].end - last > median * 4 &&
				(words[0].end - words[0].start > maxDuration ||
					(words.length > 1 && words[1].end - words[0].start > maxDuration * 2))
			) {
				if (words.length > 1 && words[1].end - words[1].start > maxDuration) {
					const boundary = Math.max(words[1].end / 2, words[1].end - maxDuration);
					words[0].end = boundary;
					words[1].start = boundary;
				}
				words[0].start = Math.max(0, words[0].end - maxDuration);
			}
			// prefer the segment-level start timestamp if the first word is too long
			if (segment.start < words[0].end && segment.start - 0.5 > words[0].start)
				words[0].start = Math.max(0, Math.min(words[0].end - median, segment.start));
			else segment.start = words[0].start;
			// prefer the segment-level end timestamp if the last word is too long
			const lw = words[words.length - 1];
			if (segment.end > lw.start && segment.end + 0.5 < lw.end)
				lw.end = Math.max(lw.start + median, segment.end);
			else segment.end = lw.end;
			last = segment.end;
		}
		segment.words = words;
	}
	return last;
}
