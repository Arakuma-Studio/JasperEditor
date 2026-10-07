// Whisper speech recognition on ONNX Runtime (onnxruntime-node, CPU), the same runtime as the processing models.
//
// Models: the onnx-community `whisper-*_timestamped` exports (encoder + merged decoder with a key/value cache and
// the cross-attention weights as outputs), pinned by revision and sha256 in `speech/catalog.json`.
//
// Transcription follows OpenAI Whisper's `transcribe()` (MIT), as FilmCraft does on candle:
//
// 1. The log-mel spectrogram of the whole clip (+ 30 s of zero padding) is computed once (`core/mel.ts`).
//    A window holds the content frames from `seek` (≤ 30 s), zero-padded to 3000 frames, and is encoded.
// 2. Language: unless given, the first window's decoder logits after `<|startoftranscript|>` are compared over
//    the language tokens.
// 3. Decoding with timestamp tokens (`core/decode.ts` filters), conditioned on the previous window's text
//    (`<|startofprev|>`, up to 223 tokens). Temperature fallback (0 → 0.2 → … → 1.0, seeded sampling) when the
//    text compresses more than 2.4× (a loop) or its mean log-probability is below −1; windows whose `<|nospeech|>`
//    probability is above 0.6 while the text is improbable are skipped.
// 4. Long audio — overlap and stitching: the next window starts at the end of the last complete segment, or of
//    its last word when word timing is on, so the unfinished tail of a window is decoded again (overlapping) in
//    the next one and the words of consecutive windows join without gaps or duplicates.
// 5. Word timestamps: the window's text tokens are run once more through the decoder (`<|notimestamps|>`) and the
//    cross-attention of the alignment heads (`generation_config.json`) is normalised, median-filtered and aligned
//    by DTW (`core/align.ts`), then OpenAI's duration heuristics and punctuation merging apply. Word confidence =
//    mean probability of its tokens.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWordTimestamps, alignTokens, type SegmentWords, wordTimings } from '../core/align.ts';
import {
	applyFilters,
	compressionRatio,
	type FilterConfig,
	logSoftmax,
	mulberry32,
	parseSegments,
	pickToken,
	repeating,
	softmaxAt,
} from '../core/decode.ts';
import { HOP, logMel, SAMPLE_RATE } from '../core/mel.ts';
import { type TokenizerJson, WhisperTokenizer } from '../core/tokenizer.ts';
import { endOfVoice, frameDb, vadThreshold } from '../core/vad.ts';

type Ort = typeof import('onnxruntime-node');
type Session = import('onnxruntime-node').InferenceSession;
type Tensor = import('onnxruntime-node').Tensor;

let ortModule: Ort | null = null;
export function loadOrt(): Ort {
	if (!ortModule) ortModule = createRequire(import.meta.url)('onnxruntime-node') as Ort;
	return ortModule;
}

/** Mel frames per window (30 s). */
export const N_FRAMES = 3000;
const N_SAMPLES = N_FRAMES * HOP;
const TEMPERATURES = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const COMPRESSION_RATIO_THRESHOLD = 2.4;
const LOGPROB_THRESHOLD = -1;
const NO_SPEECH_THRESHOLD = 0.6;

type Config = {
	num_mel_bins: number;
	d_model: number;
	decoder_layers: number;
	decoder_attention_heads: number;
	max_target_positions: number;
	vocab_size: number;
};

export type WhisperOptions = {
	/** ISO 639-1 code; null/'auto' = detect from the first window. */
	language?: string | null;
	task?: 'transcribe' | 'translate';
	/** Feed the previous window's text as a prompt (OpenAI default: on). */
	conditionOnPreviousText?: boolean;
	/** Temperature fallback (default on). Off = greedy only (FilmCraft's behaviour). */
	temperatureFallback?: boolean;
	/** 0..1 progress and stage; return false to cancel. */
	onProgress?(fraction: number, stage: string): boolean | undefined;
	signal?: AbortSignal;
};

export type WhisperWord = {
	text: string;
	/** 16 kHz sample indices. */
	start: number;
	end: number;
	probability: number;
};

export type WhisperResult = {
	language: string;
	/** Probability of the detected language (null when it was given). */
	languageProbability: number | null;
	words: WhisperWord[];
	segments: Array<{ start: number; end: number; text: string }>;
};

export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

type DecodeResult = {
	tokens: number[];
	avgLogprob: number;
	noSpeechProb: number;
	temperature: number;
	compressionRatio: number;
};

export class WhisperModel {
	private constructor(
		private readonly ort: Ort,
		private readonly encoder: Session,
		private readonly decoder: Session,
		readonly cfg: Config,
		readonly tok: WhisperTokenizer,
		private readonly alignmentHeads: Array<[number, number]>,
		private readonly filters: Omit<FilterConfig, 'timestamps'>,
		private readonly medianWidth: number,
	) {}

	static async load(dir: string, opts: { threads?: number } = {}): Promise<WhisperModel> {
		const ort = loadOrt();
		const read = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
		const cfg = read('config.json') as Config & { median_filter_width?: number };
		const gen = read('generation_config.json') as {
			alignment_heads?: Array<[number, number]>;
			suppress_tokens?: number[];
			begin_suppress_tokens?: number[];
			max_initial_timestamp_index?: number;
		};
		const tok = new WhisperTokenizer(read('tokenizer.json') as TokenizerJson, cfg.vocab_size >= 51865);
		const heads =
			gen.alignment_heads && gen.alignment_heads.length
				? gen.alignment_heads
				: Array.from({ length: cfg.decoder_layers - Math.floor(cfg.decoder_layers / 2) }, (_, i) =>
						Array.from(
							{ length: cfg.decoder_attention_heads },
							(_, h): [number, number] => [Math.floor(cfg.decoder_layers / 2) + i, h],
						),
					).flat();
		const suppress = [...new Set([...(gen.suppress_tokens ?? []), ...tok.nonTextSpecials()])].sort((a, b) => a - b);
		const so: import('onnxruntime-node').InferenceSession.SessionOptions = {
			executionProviders: ['cpu'],
			graphOptimizationLevel: 'all',
			intraOpNumThreads: Math.max(1, opts.threads ?? 4),
			interOpNumThreads: 1,
			logSeverityLevel: 3,
		};
		const encoder = await ort.InferenceSession.create(join(dir, 'encoder_model.onnx'), so);
		const decoder = await ort.InferenceSession.create(join(dir, 'decoder_model_merged.onnx'), so);
		return new WhisperModel(
			ort,
			encoder,
			decoder,
			cfg,
			tok,
			heads,
			{
				suppress,
				beginSuppress: gen.begin_suppress_tokens ?? [220, tok.eot],
				maxInitialTimestampIndex: gen.max_initial_timestamp_index ?? 50,
			},
			cfg.median_filter_width ?? 7,
		);
	}

	async release(): Promise<void> {
		await this.encoder.release();
		await this.decoder.release();
	}

	get multilingual(): boolean {
		return this.tok.multilingual;
	}

	languages(): string[] {
		return this.tok.languages.map(([c]) => c);
	}

	// ------------------------------------------------------------------ network calls

	private async encode(window: Float32Array): Promise<Tensor> {
		const x = new this.ort.Tensor('float32', window, [1, this.cfg.num_mel_bins, N_FRAMES]);
		const out = await this.encoder.run({ input_features: x });
		return out.last_hidden_state as Tensor;
	}

	private emptyPast(): Record<string, Tensor> {
		const h = this.cfg.decoder_attention_heads;
		const dh = this.cfg.d_model / h;
		const feeds: Record<string, Tensor> = {};
		for (let l = 0; l < this.cfg.decoder_layers; l++)
			for (const kind of ['decoder', 'encoder'])
				for (const kv of ['key', 'value'])
					feeds[`past_key_values.${l}.${kind}.${kv}`] = new this.ort.Tensor('float32', new Float32Array(0), [1, h, 0, dh]);
		return feeds;
	}

	private ids(tokens: readonly number[]): Tensor {
		return new this.ort.Tensor('int64', BigInt64Array.from(tokens.map((t) => BigInt(t))), [1, tokens.length]);
	}

	/** Full (uncached) pass over `tokens`; optionally returns the cross-attention of some layers. */
	private async full(
		tokens: readonly number[],
		xa: Tensor,
		opts: { cache?: boolean; crossLayers?: number[] } = {},
	): Promise<{ logits: Tensor; cache: Record<string, Tensor> | null; cross: Record<number, Tensor> }> {
		const fetches = ['logits'];
		if (opts.cache)
			for (let l = 0; l < this.cfg.decoder_layers; l++)
				for (const kind of ['decoder', 'encoder'])
					for (const kv of ['key', 'value']) fetches.push(`present.${l}.${kind}.${kv}`);
		for (const l of opts.crossLayers ?? []) fetches.push(`cross_attentions.${l}`);
		const out = await this.decoder.run(
			{
				input_ids: this.ids(tokens),
				encoder_hidden_states: xa,
				...this.emptyPast(),
				use_cache_branch: new this.ort.Tensor('bool', [false], [1]),
			},
			fetches,
		);
		let cache: Record<string, Tensor> | null = null;
		if (opts.cache) {
			cache = {};
			for (const k of fetches) if (k.startsWith('present.')) cache[k.replace('present.', 'past_key_values.')] = out[k] as Tensor;
		}
		const cross: Record<number, Tensor> = {};
		for (const l of opts.crossLayers ?? []) cross[l] = out[`cross_attentions.${l}`] as Tensor;
		return { logits: out.logits as Tensor, cache, cross };
	}

	/** One cached step: logits of `token` and the grown self-attention cache. */
	private async step(token: number, xa: Tensor, cache: Record<string, Tensor>): Promise<Float32Array> {
		const fetches = ['logits'];
		for (let l = 0; l < this.cfg.decoder_layers; l++)
			for (const kv of ['key', 'value']) fetches.push(`present.${l}.decoder.${kv}`);
		const out = await this.decoder.run(
			{
				input_ids: this.ids([token]),
				encoder_hidden_states: xa,
				...cache,
				use_cache_branch: new this.ort.Tensor('bool', [true], [1]),
			},
			fetches,
		);
		for (let l = 0; l < this.cfg.decoder_layers; l++)
			for (const kv of ['key', 'value'])
				cache[`past_key_values.${l}.decoder.${kv}`] = out[`present.${l}.decoder.${kv}`] as Tensor;
		return rowOf(out.logits as Tensor, 0);
	}

	// ------------------------------------------------------------------ decoding

	/** Most likely language of a window, with its probability. */
	async detectLanguage(xa: Tensor): Promise<{ language: string; probability: number }> {
		const { logits } = await this.full([this.tok.sot], xa);
		const l = rowOf(logits, 0);
		const langs = this.tok.languages;
		let m = Number.NEGATIVE_INFINITY;
		for (const [, id] of langs) m = Math.max(m, l[id]);
		let s = 0;
		for (const [, id] of langs) s += Math.exp(l[id] - m);
		let best = langs[0];
		for (const x of langs) if (l[x[1]] > l[best[1]]) best = x;
		return { language: best?.[0] ?? 'en', probability: best ? Math.exp(l[best[1]] - m) / s : 1 };
	}

	private sotSequence(language: string, task: 'transcribe' | 'translate'): number[] {
		if (!this.tok.multilingual) return [this.tok.sot];
		const lang = this.tok.languageToken(language) ?? this.tok.languageToken('en') ?? this.tok.sot + 1;
		const t = task === 'translate' && this.tok.translate !== null ? this.tok.translate : this.tok.transcribe;
		return [this.tok.sot, lang, t];
	}

	private async decodeOnce(
		xa: Tensor,
		sotSeq: number[],
		prompt: readonly number[],
		temperature: number,
		seed: number,
	): Promise<DecodeResult> {
		const pre: number[] = [];
		if (prompt.length && this.tok.sotPrev !== null) {
			const maxPrompt = Math.floor(this.cfg.max_target_positions / 2) - 1;
			pre.push(this.tok.sotPrev, ...prompt.slice(-maxPrompt));
		}
		const full = [...pre, ...sotSeq];
		const sotIndex = pre.length;
		const { logits, cache } = await this.full(full, xa, { cache: true });
		const noSpeechProb = this.tok.noSpeech !== null ? softmaxAt(rowOf(logits, sotIndex), this.tok.noSpeech) : 0;
		let cur = rowOf(logits, full.length - 1);
		const seq: number[] = [];
		let sumLogprob = 0;
		const rand = mulberry32(seed);
		const sampleLen = Math.min(224, this.cfg.max_target_positions - full.length - 1);
		const cfg: FilterConfig = { ...this.filters, timestamps: true };
		for (let i = 0; i < sampleLen; i++) {
			applyFilters(cur, seq, this.tok, cfg);
			const lp = logSoftmax(cur);
			const next = pickToken(cur, temperature, rand);
			sumLogprob += lp[next];
			if (next === this.tok.eot) break;
			seq.push(next);
			if (repeating(seq, this.tok.timestampBegin)) break;
			if (i + 1 >= sampleLen) break;
			cur = await this.step(next, xa, cache as Record<string, Tensor>);
		}
		const text = this.tok.decode(seq.filter((t) => t < this.tok.eot));
		return {
			tokens: seq,
			avgLogprob: sumLogprob / (seq.length + 1),
			noSpeechProb,
			temperature,
			compressionRatio: compressionRatio(text),
		};
	}

	private async decodeWithFallback(
		xa: Tensor,
		sotSeq: number[],
		prompt: readonly number[],
		fallback: boolean,
		seed: number,
	): Promise<DecodeResult> {
		let result: DecodeResult | null = null;
		for (const t of fallback ? TEMPERATURES : [0]) {
			result = await this.decodeOnce(xa, sotSeq, prompt, t, seed);
			let needsFallback =
				result.compressionRatio > COMPRESSION_RATIO_THRESHOLD || result.avgLogprob < LOGPROB_THRESHOLD;
			if (result.noSpeechProb > NO_SPEECH_THRESHOLD && result.avgLogprob < LOGPROB_THRESHOLD) needsFallback = false;
			if (!needsFallback) break;
		}
		return result as DecodeResult;
	}

	/** Word timing for the text tokens of one window (seconds from the window start). */
	private async align(
		xa: Tensor,
		sotSeq: number[],
		text: number[],
		segmentFrames: number,
		language: string,
	) {
		const tokens = [...sotSeq, this.tok.noTimestamps, ...text, this.tok.eot];
		const layers = [...new Set(this.alignmentHeads.map(([l]) => l))];
		const { logits, cross } = await this.full(tokens, xa, { crossLayers: layers });
		const attn: Float32Array[] = [];
		let framesAll = 1500;
		for (const [l, h] of this.alignmentHeads) {
			const t = cross[l];
			const [, H, T, F] = t.dims as number[];
			framesAll = F;
			const data = t.data as Float32Array;
			if (h < H) attn.push(data.subarray(h * T * F, (h + 1) * T * F));
		}
		const jump = alignTokens(
			attn,
			tokens.length,
			framesAll,
			Math.floor(segmentFrames / 2),
			sotSeq.length,
			text.length,
			this.medianWidth,
		);
		// token probabilities (text vocabulary only)
		const probs: number[] = [];
		for (let i = 0; i < text.length; i++) {
			const row = rowOf(logits, sotSeq.length + i).subarray(0, this.tok.eot);
			probs.push(softmaxAt(row, text[i]));
		}
		const words = this.tok.splitToWordTokens(text, language);
		return wordTimings(words, jump, probs);
	}

	/** Transcribes mono 16 kHz `audio`. */
	async transcribe(audio: Float32Array, opts: WhisperOptions = {}): Promise<WhisperResult> {
		const nMels = this.cfg.num_mel_bins;
		const task = opts.task === 'translate' && this.tok.multilingual ? 'translate' : 'transcribe';
		const condition = opts.conditionOnPreviousText ?? true;
		const fallback = opts.temperatureFallback ?? true;
		const progress = (f: number, stage: string) => {
			if (opts.signal?.aborted) throw new CancelledError();
			if (opts.onProgress?.(f, stage) === false) throw new CancelledError();
		};
		progress(0, 'Analysing audio');
		const padded = new Float32Array(audio.length + N_SAMPLES);
		padded.set(audio);
		const { frames: totalFrames, data: mel } = logMel(padded, nMels);
		const contentFrames = Math.max(0, totalFrames - N_FRAMES);
		const db = frameDb(audio);
		const voiceThreshold = vadThreshold(db);
		let language = opts.language && opts.language !== 'auto' ? opts.language : null;
		if (language && this.tok.multilingual && this.tok.languageToken(language) === null)
			throw new Error(`The model does not know the language "${language}"`);
		if (!this.tok.multilingual) language = 'en';
		let languageProbability: number | null = null;
		const words: WhisperWord[] = [];
		const segmentsOut: WhisperResult['segments'] = [];
		const allTokens: number[] = [];
		let promptResetSince = 0;
		let lastSpeech = 0;
		let seek = 0;
		let windowIndex = 0;
		while (seek < contentFrames) {
			const frac = seek / Math.max(1, contentFrames);
			progress(frac * 0.97, `Transcribing ${Math.round(frac * 100)}%`);
			const timeOffset = (seek * HOP) / SAMPLE_RATE;
			const segmentFrames = Math.min(N_FRAMES, contentFrames - seek);
			const win = new Float32Array(nMels * N_FRAMES);
			for (let m = 0; m < nMels; m++)
				win.set(mel.subarray(m * totalFrames + seek, m * totalFrames + seek + segmentFrames), m * N_FRAMES);
			const xa = await this.encode(win);
			if (language === null) {
				const d = await this.detectLanguage(xa);
				language = d.language;
				languageProbability = d.probability;
			}
			const sotSeq = this.sotSequence(language, task);
			const prompt = condition ? allTokens.slice(promptResetSince) : [];
			const r = await this.decodeWithFallback(xa, sotSeq, prompt, fallback, 1234 + windowIndex);
			windowIndex++;
			if (r.noSpeechProb > NO_SPEECH_THRESHOLD && r.avgLogprob < LOGPROB_THRESHOLD) {
				seek += segmentFrames;
				continue;
			}
			const parsed = parseSegments(r.tokens, this.tok, segmentFrames);
			let nextSeek = seek + parsed.seekFrames;
			const segs: SegmentWords[] = [];
			for (const s of parsed.segments) {
				const textTokens = s.tokens.filter((t) => t < this.tok.eot);
				if (s.start === s.end || !this.tok.decode(textTokens).trim()) continue;
				segs.push({ start: timeOffset + s.start, end: timeOffset + s.end, textTokens, words: [] });
			}
			const text = segs.flatMap((s) => s.textTokens);
			if (text.length) {
				const alignment = await this.align(xa, sotSeq, text, segmentFrames, language);
				lastSpeech = addWordTimestamps(segs, alignment, timeOffset, lastSpeech);
				if (!parsed.singleTimestampEnding) {
					let lastWordEnd: number | null = null;
					for (const s of segs) for (const w of s.words) lastWordEnd = w.end;
					if (lastWordEnd !== null && lastWordEnd > timeOffset) {
						// resume after the voice that the last word's (often early) end leaves, but not past the
						// window's last complete segment
						const segEnd = Math.round(segs[segs.length - 1].end * 100);
						nextSeek = endOfVoice(db, voiceThreshold, Math.round(lastWordEnd * 100), Math.max(segEnd, Math.round(lastWordEnd * 100)));
					}
				}
				const windowEnd = timeOffset + segmentFrames / 100;
				for (const s of segs) {
					segmentsOut.push({ start: s.start, end: s.end, text: this.tok.decode(s.textTokens).trim() });
					for (const w of s.words) {
						const prevEnd = words.length ? words[words.length - 1].end : 0;
						const a = Math.max(prevEnd, Math.round(Math.min(w.start, windowEnd) * SAMPLE_RATE));
						const b = Math.max(a, Math.round(Math.min(w.end, windowEnd) * SAMPLE_RATE));
						const t = w.word.trim();
						if (t) words.push({ text: t, start: a, end: Math.min(b, audio.length), probability: w.probability });
					}
				}
				for (const s of parsed.segments)
					if (s.start !== s.end && this.tok.decode(s.tokens.filter((t) => t < this.tok.eot)).trim())
						allTokens.push(...s.tokens);
			}
			if (!condition || r.temperature > 0.5) promptResetSince = allTokens.length;
			seek = Math.max(seek + 1, nextSeek);
		}
		progress(0.97, 'Aligning words');
		return { language: language ?? 'en', languageProbability, words, segments: segmentsOut };
	}
}

/** Row `t` of logits shaped [1, T, V] (a copy). */
function rowOf(logits: Tensor, t: number): Float32Array {
	const [, , V] = logits.dims as number[];
	const d = logits.data as Float32Array;
	return d.slice(t * V, (t + 1) * V);
}
