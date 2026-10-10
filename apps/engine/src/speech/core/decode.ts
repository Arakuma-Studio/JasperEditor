// Whisper decoding rules (pure): logit filters, token selection, quality measures and segment parsing.
// Follows OpenAI Whisper `decoding.py` / `transcribe.py` (MIT): SuppressBlank, SuppressTokens, ApplyTimestampRules
// (pairs, monotonic timestamps, max initial timestamp 1 s, timestamp-vs-text probability rule), the
// temperature-fallback quality checks (gzip compression ratio > 2.4 or mean log-probability < −1) and the segment
// split at consecutive timestamp tokens. FilmCraft (`crates/speech/src/whisper/mod.rs`) implements the same
// filters greedily without fallback; its repetition guard is kept as an extra safety net.
import { deflateSync } from 'node:zlib';
import type { WhisperTokenizer } from './tokenizer.ts';

export const NEG_INF = Number.NEGATIVE_INFINITY;

export function logSoftmax(x: Float32Array): Float32Array {
	let m = NEG_INF;
	for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
	if (!Number.isFinite(m)) return new Float32Array(x.length).fill(NEG_INF);
	let s = 0;
	for (let i = 0; i < x.length; i++) s += Math.exp(x[i] - m);
	const lse = m + Math.log(s);
	const out = new Float32Array(x.length);
	for (let i = 0; i < x.length; i++) out[i] = x[i] - lse;
	return out;
}

export function softmaxAt(x: Float32Array, i: number): number {
	let m = NEG_INF;
	for (let k = 0; k < x.length; k++) if (x[k] > m) m = x[k];
	let s = 0;
	for (let k = 0; k < x.length; k++) s += Math.exp(x[k] - m);
	return i >= 0 && i < x.length ? Math.exp(x[i] - m) / s : 0;
}

export function argmax(x: Float32Array): number {
	let best = 0;
	for (let i = 1; i < x.length; i++) if (x[i] > x[best]) best = i;
	return best;
}

export type FilterConfig = {
	/** Suppressed at every step (non-speech tokens and the non-text specials). */
	suppress: readonly number[];
	/** Suppressed at the first sampled position (space and end-of-text). */
	beginSuppress: readonly number[];
	/** Max initial timestamp index (OpenAI: 1 s = 50); null = none. */
	maxInitialTimestampIndex: number | null;
	/** Timestamps are being predicted (false: `<|notimestamps|>` decoding). */
	timestamps: boolean;
};

/** Applies the logit filters in place for the next token after `seq` (sampled tokens of this window). */
export function applyFilters(
	logits: Float32Array,
	seq: readonly number[],
	tok: WhisperTokenizer,
	cfg: FilterConfig,
): void {
	const tb = tok.timestampBegin;
	if (seq.length === 0) for (const s of cfg.beginSuppress) if (s < logits.length) logits[s] = NEG_INF;
	for (const s of cfg.suppress) if (s < logits.length) logits[s] = NEG_INF;
	if (!cfg.timestamps) {
		for (let i = tb; i < logits.length; i++) logits[i] = NEG_INF;
		return;
	}
	logits[tok.noTimestamps] = NEG_INF;
	const lastTs = seq.length >= 1 && seq[seq.length - 1] >= tb;
	const penultTs = seq.length < 2 || seq[seq.length - 2] >= tb;
	if (lastTs) {
		if (penultTs) for (let i = tb; i < logits.length; i++) logits[i] = NEG_INF;
		else for (let i = 0; i < tok.eot; i++) logits[i] = NEG_INF;
	}
	let lastTimestamp = -1;
	for (let k = seq.length - 1; k >= 0; k--)
		if (seq[k] >= tb) {
			lastTimestamp = seq[k];
			break;
		}
	if (lastTimestamp >= 0) {
		const lim = Math.min(logits.length, lastTs && !penultTs ? lastTimestamp : lastTimestamp + 1);
		for (let i = tb; i < lim; i++) logits[i] = NEG_INF;
	}
	if (seq.length === 0) {
		for (let i = 0; i < tb; i++) logits[i] = NEG_INF;
		if (cfg.maxInitialTimestampIndex !== null)
			for (let i = tb + cfg.maxInitialTimestampIndex + 1; i < logits.length; i++) logits[i] = NEG_INF;
	}
	// sample a timestamp when the timestamps' total probability beats every text token
	const lp = logSoftmax(logits);
	let m = NEG_INF;
	for (let i = tb; i < lp.length; i++) if (lp[i] > m) m = lp[i];
	if (Number.isFinite(m)) {
		let s = 0;
		for (let i = tb; i < lp.length; i++) s += Math.exp(lp[i] - m);
		const tsLogprob = m + Math.log(s);
		let maxText = NEG_INF;
		for (let i = 0; i < tb; i++) if (lp[i] > maxText) maxText = lp[i];
		if (tsLogprob > maxText) for (let i = 0; i < tb; i++) logits[i] = NEG_INF;
	}
}

/** Deterministic PRNG (mulberry32) for temperature sampling. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Picks the next token: argmax at temperature 0, otherwise a sample of softmax(logits / T). */
export function pickToken(logits: Float32Array, temperature: number, rand: () => number): number {
	if (temperature <= 0) return argmax(logits);
	let m = NEG_INF;
	for (let i = 0; i < logits.length; i++) if (logits[i] > m) m = logits[i];
	let s = 0;
	const p = new Float64Array(logits.length);
	for (let i = 0; i < logits.length; i++) {
		const v = Number.isFinite(logits[i]) ? Math.exp((logits[i] - m) / temperature) : 0;
		p[i] = v;
		s += v;
	}
	let r = rand() * s;
	for (let i = 0; i < p.length; i++) {
		r -= p[i];
		if (r <= 0 && p[i] > 0) return i;
	}
	return argmax(logits);
}

/** gzip-style compression ratio of a text (OpenAI: `len(text_bytes) / len(zlib.compress(text_bytes))`). */
export function compressionRatio(text: string): number {
	const b = Buffer.from(text, 'utf8');
	if (!b.length) return 0;
	return b.length / deflateSync(b).length;
}

/** The tail of `seq` (text tokens) repeats a short pattern many times: a decoding loop (FilmCraft's guard). */
export function repeating(seq: readonly number[], timestampBegin: number): boolean {
	const text = seq.filter((t) => t < timestampBegin);
	for (let n = 1; n <= 8; n++) {
		const reps = n === 1 ? 12 : 5;
		if (text.length < n * reps) continue;
		const tail = text.slice(text.length - n * reps);
		let all = true;
		for (let r = 1; r < reps && all; r++)
			for (let k = 0; k < n; k++)
				if (tail[r * n + k] !== tail[k]) {
					all = false;
					break;
				}
		if (all) return true;
	}
	return false;
}

export type ParsedSegment = { start: number; end: number; tokens: number[] };

/**
 * OpenAI's split of one window's tokens into segments (times in seconds from the window start) and how far to
 * seek (mel frames). `segmentFrames` = the window's content frames.
 */
export function parseSegments(
	tokens: readonly number[],
	tok: WhisperTokenizer,
	segmentFrames: number,
): { segments: ParsedSegment[]; seekFrames: number; singleTimestampEnding: boolean } {
	const tb = tok.timestampBegin;
	const precision = 0.02;
	const isTs = tokens.map((t) => t >= tb);
	const singleTimestampEnding = isTs.length >= 2 && !isTs[isTs.length - 2] && isTs[isTs.length - 1];
	const consecutive: number[] = [];
	for (let i = 0; i + 1 < isTs.length; i++) if (isTs[i] && isTs[i + 1]) consecutive.push(i + 1);
	const segments: ParsedSegment[] = [];
	if (consecutive.length) {
		const slices = [...consecutive];
		if (singleTimestampEnding) slices.push(tokens.length);
		let last = 0;
		for (const cur of slices) {
			const sl = tokens.slice(last, cur);
			segments.push({
				start: (sl[0] - tb) * precision,
				end: (sl[sl.length - 1] - tb) * precision,
				tokens: sl,
			});
			last = cur;
		}
		const seekFrames = singleTimestampEnding ? segmentFrames : (tokens[last - 1] - tb) * 2;
		return { segments, seekFrames: Math.max(1, Math.min(segmentFrames, seekFrames)), singleTimestampEnding };
	}
	let duration = segmentFrames / 100;
	const ts = tokens.filter((t) => t >= tb);
	if (ts.length && ts[ts.length - 1] !== tb) duration = (ts[ts.length - 1] - tb) * precision;
	segments.push({ start: 0, end: duration, tokens: [...tokens] });
	return { segments, seekFrames: segmentFrames, singleTimestampEnding };
}
