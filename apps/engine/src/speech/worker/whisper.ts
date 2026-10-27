// Whisper speech recognition on ONNX Runtime (onnxruntime-node), the same runtime as the processing models.
//
// Models: the onnx-community `whisper-*_timestamped` exports (encoder + merged decoder with a key/value cache and
// the cross-attention weights as outputs), pinned by revision and sha256 in the model catalogue.
//
// Transcription follows OpenAI Whisper's `transcribe()` (MIT), as FilmCraft does on candle:
//
// 1. The log-mel spectrogram of the clip (+ 30 s of zero padding) is computed while the audio streams in
//    (`worker/audio.ts`, spec 16 SG-014). A window holds the content frames from `seek` (≤ 30 s), zero-padded to
//    3000 frames, and is encoded.
// 2. Language: unless given, the first window's decoder logits after `<|startoftranscript|>` are compared over
//    the language tokens.
// 3. Decoding with timestamp tokens (`core/decode.ts` filters), conditioned on an initial prompt (verbatim
//    transcription, spec 14 TC-003; OpenAI semantics: it starts the running text) and the previous windows' text (`<|startofprev|>`, up to 223 tokens). Default
//    greedy (spec 16 SG-010 "Standard"), beam search with 5 beams for "Best". Temperature fallback (0 → 0.2 → … →
//    1.0, seeded sampling) when the text compresses more than 2.4× (a loop) or its mean log-probability is below
//    −1; windows whose `<|nospeech|>` probability is above 0.6 while the text is improbable are skipped.
// 4. Hallucination guards (SG-011): windows without voiced frames are not decoded; the previous-text prompt is
//    reset after ≥ 2 s of silence; runs of ≥ 4 identical tokens are dropped; OpenAI's
//    `hallucination_silence_threshold` heuristic (2 s) removes improbable segments surrounded by silence.
// 5. Long audio — overlap and stitching: the next window starts at the end of the last complete segment, or of
//    its last word when word timing is on, so the unfinished tail of a window is decoded again (overlapping) in
//    the next one and the words of consecutive windows join without gaps or duplicates.
// 6. Word timestamps: the window's text tokens are run once more through the decoder (`<|notimestamps|>`) and the
//    cross-attention of the alignment heads (`generation_config.json`) is normalised, median-filtered and aligned
//    by DTW (`core/align.ts`), then OpenAI's duration heuristics and punctuation merging apply. Word confidence =
//    mean probability of its tokens.
//
// Execution providers (SG-002): the encoder runs on the best GPU provider, the decoder on the CPU unless a
// calibration on the first window shows a GPU decoder faster (greedy only; `worker/sessions.ts`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
	loadOrt as loadSharedOrt,
	type Ort,
	type ProviderId,
	type OrtTensor as Tensor,
} from '../../tools/ort.ts';
import {
	addWordTimestamps,
	alignTokens,
	type SegmentWords,
	type WordTiming,
	wordTimings,
} from '../core/align.ts';
import {
	applyFilters,
	argmax,
	compressionRatio,
	type FilterConfig,
	logSumExp,
	mulberry32,
	parseSegments,
	pickToken,
	repeating,
	softmaxAt,
	topK,
} from '../core/decode.ts';
import { composePrompt, glossaryTokens, normalizeGlossary, repeatedGlossaryTerm } from '../core/glossary.ts';
import { dropRepeatedTokenRuns, silenceThresholdCut } from '../core/hallucination.ts';
import { FRAME_HALF, HOP, MelFrameComputer, SAMPLE_RATE } from '../core/mel.ts';
import { type TokenizerJson, WhisperTokenizer } from '../core/tokenizer.ts';
import { countVoiced, endOfVoice } from '../core/vad.ts';
import { CancelledError, inputFromSamples, type SpeechInput } from './audio.ts';
import { createPartSession, type PartSession, type SessionFallback } from './sessions.ts';

export { CancelledError };

/** Loads onnxruntime-node (from `JASPER_ORT_DIR` when the engine set it). */
export function loadOrt(): Ort {
	return loadSharedOrt();
}

/** Mel frames per window (30 s). */
export const N_FRAMES = 3000;
const TEMPERATURES = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const COMPRESSION_RATIO_THRESHOLD = 2.4;
const LOGPROB_THRESHOLD = -1;
const NO_SPEECH_THRESHOLD = 0.6;
/** SG-011: OpenAI `hallucination_silence_threshold` and the silence that resets the prompt (seconds). */
export const HALLUCINATION_SILENCE = 2;
/** A window with fewer voiced 10 ms frames than this is silence (not decoded). */
export const MIN_VOICED_FRAMES = 3;
/** Decoder steps timed per decoder in the calibration (SG-002, ≈ 1 s on a GPU box). */
const CALIBRATION_STEPS = 24;

type Config = {
	num_mel_bins: number;
	d_model: number;
	decoder_layers: number;
	decoder_attention_heads: number;
	max_target_positions: number;
	vocab_size: number;
};

/** Spec 14 TC-003: language-aware verbatim prompts (filler words in the prompt make Whisper keep them). */
export const VERBATIM_PROMPTS: Record<string, string> = {
	es: 'Eh... em, bueno, o sea, este... mmm, ¿vale? Ah, eh, pues...',
	en: 'Um, uh, so, like, you know... hmm, okay? Ah, er, well...',
};

export type WhisperOptions = {
	/** ISO 639-1 code; null/'auto' = detect from the first window. */
	language?: string | null;
	task?: 'transcribe' | 'translate';
	/** Feed the previous window's text as a prompt (OpenAI default: on). */
	conditionOnPreviousText?: boolean;
	/** Temperature fallback (default on). Off = temperature 0 only (FilmCraft's behaviour). */
	temperatureFallback?: boolean;
	/** Beam search width at temperature 0 (default 1 = greedy, spec 16 SG-010); 5 = "Best". */
	beamSize?: number;
	/** Verbatim prompt of the language (TC-003). */
	verbatim?: boolean;
	/** A custom initial prompt (after the verbatim prompt). */
	initialPrompt?: string;
	/**
	 * Spec 17 SC-074: glossary terms carried into every window's prompt after the initial prompt (`core/glossary.ts`),
	 * with the SC-075 guard (a term repeated ≥ 3 times within 10 s → the window is decoded again without it).
	 */
	glossary?: string[];
	/** OpenAI's hallucination silence threshold (seconds; default 2, 0 = off). */
	hallucinationSilence?: number;
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

export type WhisperSegment = {
	start: number;
	end: number;
	text: string;
	avgLogprob: number;
	noSpeechProb: number;
	compressionRatio: number;
	temperature: number;
};

export type WhisperResult = {
	language: string;
	/** Probability of the detected language (null when it was given). */
	languageProbability: number | null;
	words: WhisperWord[];
	segments: WhisperSegment[];
	guard: {
		skippedWindows: number;
		removed: Array<{ text: string; start: number; end: number; reason: string }>;
		/** SC-074/SC-075: terms carried, their prompt tokens, guard events and windows whose unprompted text was kept. */
		glossary: GlossaryGuard | null;
	};
	/** Where time went (SG-013: JS time per token = jsMs / tokens). */
	profile: { encoderMs: number; decoderMs: number; jsMs: number; decoderRuns: number; windows: number };
};

export type GlossaryGuard = { terms: number; tokens: number; events: number; replaced: number };

/**
 * A request the worker cannot score or transcribe as given (spec 17 SC-032 refusals): not a GPU or runtime failure,
 * so it is never retried on the CPU. `code` is reported to the engine (`SPEECH_*`).
 */
export class SpeechRefusal extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'SpeechRefusal';
	}
}

/** Spec 17 SC-032: one word of a scored reading (samples from the start of the audio). */
export type ScoredWord = {
	text: string;
	tokens: number;
	/** Σ full-vocabulary log-softmax of the word's tokens (nats). */
	logprob: number;
	/** Mean probability of the word's tokens (full vocabulary). */
	probability: number;
	start: number;
	end: number;
};

/** `logprob` = Σ over every text token and `<|endoftext|>`; `tokens` counts them (text tokens + 1). */
export type ScoredReading = { logprob: number; tokens: number; words: ScoredWord[] };

/** Logit + cross-attention values one batched scoring pass may hold (≈ 256 MB of float32). */
const SCORE_BATCH_BUDGET = 64 * 1024 * 1024;

export type DecoderCalibration = {
	provider: ProviderId;
	cpuMsPerToken: number;
	gpuMsPerToken: number;
	decoder: ProviderId;
};

/** SG-002: the GPU decoder is kept only when it is clearly (10 %) faster per token than the CPU decoder. */
export function chooseCalibratedDecoder(
	c: { cpuMsPerToken: number; gpuMsPerToken: number },
	gpu: ProviderId,
): ProviderId {
	return Number.isFinite(c.gpuMsPerToken) && c.gpuMsPerToken > 0 && c.gpuMsPerToken < c.cpuMsPerToken * 0.9
		? gpu
		: 'cpu';
}

export type LoadOptions = {
	threads?: number;
	encoder?: ProviderId;
	decoder?: ProviderId;
	/** A GPU decoder to time against the CPU decoder on the first window (greedy only). */
	calibrate?: ProviderId | null;
	/** Injected ONNX Runtime (tests use a fake binding). */
	ort?: Pick<Ort, 'InferenceSession' | 'Tensor'>;
	encoderFile?: string;
	decoderFile?: string;
};

type DecodeResult = {
	tokens: number[];
	avgLogprob: number;
	noSpeechProb: number;
	temperature: number;
	compressionRatio: number;
};

export class WhisperModel {
	readonly fallbacks: Array<SessionFallback & { part: 'encoder' | 'decoder' }> = [];
	calibration: DecoderCalibration | null = null;
	private gpuDecoder: PartSession | null = null;
	private profile = { encoderMs: 0, decoderMs: 0, decoderRuns: 0 };
	private melFrames: MelFrameComputer | null = null;

	private constructor(
		private readonly ort: Pick<Ort, 'InferenceSession' | 'Tensor'>,
		private encoder: PartSession,
		private decoder: PartSession,
		readonly cfg: Config,
		readonly tok: WhisperTokenizer,
		private readonly alignmentHeads: Array<[number, number]>,
		private readonly filters: Omit<FilterConfig, 'timestamps'>,
		private readonly medianWidth: number,
		private readonly cpuDecoder: PartSession | null,
	) {}

	static readConfig(dir: string): Config & { median_filter_width?: number } {
		return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
	}

	static async load(dir: string, opts: LoadOptions = {}): Promise<WhisperModel> {
		const ort = opts.ort ?? loadOrt();
		const read = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
		const cfg = read('config.json') as Config & { median_filter_width?: number };
		const gen = read('generation_config.json') as {
			alignment_heads?: Array<[number, number]>;
			suppress_tokens?: number[];
			begin_suppress_tokens?: number[];
			max_initial_timestamp_index?: number;
		};
		const tok = new WhisperTokenizer(read('tokenizer.json') as TokenizerJson, cfg.vocab_size >= 51865);
		const heads = gen.alignment_heads?.length
			? gen.alignment_heads
			: Array.from({ length: cfg.decoder_layers - Math.floor(cfg.decoder_layers / 2) }, (_, i) =>
					Array.from({ length: cfg.decoder_attention_heads }, (_, h): [number, number] => [
						Math.floor(cfg.decoder_layers / 2) + i,
						h,
					]),
				).flat();
		const suppress = [...new Set([...(gen.suppress_tokens ?? []), ...tok.nonTextSpecials()])].sort(
			(a, b) => a - b,
		);
		const threads = Math.max(1, opts.threads ?? 4);
		const encPath = join(dir, opts.encoderFile ?? 'encoder_model.onnx');
		const decPath = join(dir, opts.decoderFile ?? 'decoder_model_merged.onnx');
		const encoder = await createPartSession(ort, encPath, { provider: opts.encoder ?? 'cpu', threads });
		const fallbacks: WhisperModel['fallbacks'] = [];
		if (encoder.fallback) fallbacks.push({ ...encoder.fallback, part: 'encoder' });
		let decoder: PartSession;
		let gpuDecoder: PartSession | null = null;
		let cpuDecoder: PartSession | null = null;
		try {
			const wanted = opts.decoder ?? 'cpu';
			const calibrate = opts.calibrate && opts.calibrate !== 'cpu' ? opts.calibrate : null;
			if (wanted === 'webgpu' || calibrate === 'webgpu') {
				// device-resident WebGPU decoding needs the CPU decoder for its uncached passes
				cpuDecoder = await createPartSession(ort, decPath, { provider: 'cpu', threads });
			}
			if (calibrate) {
				decoder = cpuDecoder ?? (await createPartSession(ort, decPath, { provider: 'cpu', threads }));
				cpuDecoder = decoder;
				gpuDecoder = await createPartSession(ort, decPath, {
					provider: calibrate,
					threads,
					deviceResident: calibrate === 'webgpu',
					...(cpuDecoder ? { plain: cpuDecoder } : {}),
				});
				if (gpuDecoder.fallback) {
					fallbacks.push({ ...gpuDecoder.fallback, part: 'decoder' });
					await gpuDecoder.release();
					gpuDecoder = null;
				}
			} else if (wanted !== 'cpu') {
				decoder = await createPartSession(ort, decPath, {
					provider: wanted,
					threads,
					deviceResident: wanted === 'webgpu',
					...(cpuDecoder ? { plain: cpuDecoder } : {}),
				});
				if (decoder.fallback) fallbacks.push({ ...decoder.fallback, part: 'decoder' });
			} else decoder = await createPartSession(ort, decPath, { provider: 'cpu', threads });
		} catch (e) {
			await encoder.release();
			await cpuDecoder?.release();
			throw e;
		}
		const m = new WhisperModel(
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
			cpuDecoder && cpuDecoder !== decoder ? cpuDecoder : null,
		);
		m.fallbacks.push(...fallbacks);
		m.gpuDecoder = gpuDecoder;
		return m;
	}

	/** Providers that really run each part. */
	get providers(): { encoder: ProviderId; decoder: ProviderId } {
		return { encoder: this.encoder.provider, decoder: this.decoder.provider };
	}

	async release(): Promise<void> {
		await this.encoder.release();
		await this.decoder.release();
		if (this.gpuDecoder && this.gpuDecoder !== this.decoder) await this.gpuDecoder.release();
		if (this.cpuDecoder && this.cpuDecoder !== this.decoder) await this.cpuDecoder.release();
		this.gpuDecoder = null;
	}

	get multilingual(): boolean {
		return this.tok.multilingual;
	}

	languages(): string[] {
		return this.tok.languages.map(([c]) => c);
	}

	private async timed<T>(part: 'encoder' | 'decoder', fn: () => Promise<T>): Promise<T> {
		const t = performance.now();
		try {
			return await fn();
		} finally {
			const dt = performance.now() - t;
			if (part === 'encoder') this.profile.encoderMs += dt;
			else {
				this.profile.decoderMs += dt;
				this.profile.decoderRuns++;
			}
		}
	}

	private async encode(window: Float32Array): Promise<Tensor> {
		const x = new this.ort.Tensor('float32', window, [1, this.cfg.num_mel_bins, N_FRAMES]);
		const out = await this.timed('encoder', () => this.encoder.run({ input_features: x }));
		return out.last_hidden_state as Tensor;
	}

	private emptyPast(batch = 1): Record<string, Tensor> {
		const h = this.cfg.decoder_attention_heads;
		const dh = this.cfg.d_model / h;
		const feeds: Record<string, Tensor> = {};
		for (let l = 0; l < this.cfg.decoder_layers; l++)
			for (const kind of ['decoder', 'encoder'])
				for (const kv of ['key', 'value'])
					feeds[`past_key_values.${l}.${kind}.${kv}`] = new this.ort.Tensor('float32', new Float32Array(0), [
						batch,
						h,
						0,
						dh,
					]);
		return feeds;
	}

	private ids(tokens: readonly number[]): Tensor {
		return new this.ort.Tensor('int64', BigInt64Array.from(tokens.map((t) => BigInt(t))), [1, tokens.length]);
	}

	/** Full (uncached) pass over `tokens`; optionally returns the cross-attention of some layers. */
	private async full(
		tokens: readonly number[],
		xa: Tensor,
		opts: { cache?: boolean; crossLayers?: number[]; decoder?: PartSession } = {},
	): Promise<{ logits: Tensor; cache: Record<string, Tensor> | null; cross: Record<number, Tensor> }> {
		const dec = opts.decoder ?? this.decoder;
		const fetches = ['logits'];
		if (opts.cache)
			for (let l = 0; l < this.cfg.decoder_layers; l++)
				for (const kind of ['decoder', 'encoder'])
					for (const kv of ['key', 'value']) fetches.push(`present.${l}.${kind}.${kv}`);
		for (const l of opts.crossLayers ?? []) fetches.push(`cross_attentions.${l}`);
		const out = await this.timed('decoder', () =>
			dec.run(
				{
					input_ids: this.ids(tokens),
					encoder_hidden_states: xa,
					...this.emptyPast(),
					use_cache_branch: new this.ort.Tensor('bool', [false], [1]),
				},
				fetches,
			),
		);
		let cache: Record<string, Tensor> | null = null;
		if (opts.cache) {
			cache = {};
			for (const k of fetches)
				if (k.startsWith('present.')) cache[k.replace('present.', 'past_key_values.')] = out[k] as Tensor;
		}
		const cross: Record<number, Tensor> = {};
		for (const l of opts.crossLayers ?? []) cross[l] = out[`cross_attentions.${l}`] as Tensor;
		return { logits: out.logits as Tensor, cache, cross };
	}

	/** One cached step: logits of `token` and the grown self-attention cache. */
	private async step(
		token: number,
		cache: Record<string, Tensor>,
		dec: PartSession = this.decoder,
	): Promise<Float32Array> {
		const fetches = ['logits'];
		for (let l = 0; l < this.cfg.decoder_layers; l++)
			for (const kv of ['key', 'value']) fetches.push(`present.${l}.decoder.${kv}`);
		const out = await this.timed('decoder', () =>
			dec.run(
				{
					input_ids: this.ids([token]),
					encoder_hidden_states: this.stepXa(1),
					...cache,
					use_cache_branch: new this.ort.Tensor('bool', [true], [1]),
				},
				fetches,
			),
		);
		for (let l = 0; l < this.cfg.decoder_layers; l++)
			for (const kv of ['key', 'value']) {
				const k = `past_key_values.${l}.decoder.${kv}`;
				const old = cache[k];
				cache[k] = out[`present.${l}.decoder.${kv}`] as Tensor;
				if (dec.deviceResident && old && old !== cache[k] && old.location === 'gpu-buffer') old.dispose();
			}
		return rowOf(out.logits as Tensor, 0);
	}

	private stepXaCache = new Map<number, Tensor>();
	/**
	 * `encoder_hidden_states` of a cached step: the merged decoder's cache branch reads the cross-attention keys and
	 * values from the cache and ignores this input, so a [B, 1, d_model] placeholder replaces the window's encoder
	 * output (the same tokens and times on the LJ fixture with tiny and turbo; ≈ 10 % less decoder time per step on
	 * the CPU, and no 7.7 MB host→device copy per step on a GPU decoder).
	 */
	private stepXa(batch: number): Tensor {
		let t = this.stepXaCache.get(batch);
		if (!t) {
			const d = this.cfg.d_model;
			t = new this.ort.Tensor('float32', new Float32Array(batch * d), [batch, 1, d]);
			this.stepXaCache.set(batch, t);
		}
		return t;
	}

	/** Frees device-resident cache tensors (no-op on the CPU). */
	private disposeCache(cache: Record<string, Tensor> | null, dec: PartSession = this.decoder): void {
		if (!cache || !dec.deviceResident) return;
		for (const t of Object.values(cache)) if (t.location === 'gpu-buffer') t.dispose();
	}

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

	/** Most tokens of a prompt (OpenAI: n_text_ctx // 2 − 1). */
	private get maxPrompt(): number {
		return Math.floor(this.cfg.max_target_positions / 2) - 1;
	}

	private prefix(prompt: readonly number[]): number[] {
		if (!prompt.length || this.tok.sotPrev === null) return [];
		return [this.tok.sotPrev, ...prompt.slice(-this.maxPrompt)];
	}

	/**
	 * SG-002 calibration: times greedy steps of the CPU decoder and the GPU decoder on this window and keeps the
	 * faster one (the other session is released).
	 */
	private async calibrate(xa: Tensor, sotSeq: number[]): Promise<void> {
		const gpu = this.gpuDecoder;
		if (!gpu) return;
		const time = async (dec: PartSession): Promise<number> => {
			const { logits, cache } = await this.full(sotSeq, xa, { cache: true, decoder: dec });
			let next = argmax(rowOf(logits, sotSeq.length - 1).subarray(0, this.tok.eot));
			const times: number[] = [];
			try {
				for (let i = 0; i < CALIBRATION_STEPS; i++) {
					const t = performance.now();
					const row = await this.step(next, cache as Record<string, Tensor>, dec);
					times.push(performance.now() - t);
					next = argmax(row.subarray(0, this.tok.eot));
				}
			} finally {
				this.disposeCache(cache, dec);
			}
			const tail = times.slice(4).sort((a, b) => a - b);
			return tail[Math.floor(tail.length / 2)] ?? Number.POSITIVE_INFINITY;
		};
		let gpuMs = Number.POSITIVE_INFINITY;
		let gpuError: string | null = null;
		const cpuMs = await time(this.decoder);
		try {
			gpuMs = await time(gpu);
		} catch (e) {
			gpuError = e instanceof Error ? e.message : String(e);
		}
		const decoder = gpuError
			? 'cpu'
			: chooseCalibratedDecoder({ cpuMsPerToken: cpuMs, gpuMsPerToken: gpuMs }, gpu.provider);
		this.calibration = {
			provider: gpu.provider,
			cpuMsPerToken: Math.round(cpuMs * 100) / 100,
			gpuMsPerToken: Number.isFinite(gpuMs) ? Math.round(gpuMs * 100) / 100 : -1,
			decoder,
		};
		if (gpuError)
			this.fallbacks.push({ part: 'decoder', from: gpu.provider, reason: `calibration failed: ${gpuError}` });
		if (decoder !== 'cpu') {
			// the CPU decoder stays for the uncached passes of a device-resident decoder
			if (!gpu.deviceResident) await this.decoder.release();
			this.decoder = gpu;
		} else await gpu.release();
		this.gpuDecoder = null;
	}

	private async decodeOnce(
		xa: Tensor,
		sotSeq: number[],
		prompt: readonly number[],
		temperature: number,
		seed: number,
	): Promise<DecodeResult> {
		const pre = this.prefix(prompt);
		const full = [...pre, ...sotSeq];
		const sotIndex = pre.length;
		const { logits, cache } = await this.full(full, xa, { cache: true });
		try {
			const noSpeechProb =
				this.tok.noSpeech !== null ? softmaxAt(rowOf(logits, sotIndex), this.tok.noSpeech) : 0;
			let cur = rowOf(logits, full.length - 1);
			const seq: number[] = [];
			let sumLogprob = 0;
			const rand = mulberry32(seed);
			const sampleLen = Math.min(224, this.cfg.max_target_positions - full.length - 1);
			const cfg: FilterConfig = { ...this.filters, timestamps: true };
			for (let i = 0; i < sampleLen; i++) {
				applyFilters(cur, seq, this.tok, cfg);
				const next = pickToken(cur, temperature, rand);
				// log-probability of the chosen token without normalising the whole vocabulary into an array (SG-013)
				sumLogprob += cur[next] - logSumExp(cur);
				if (next === this.tok.eot) break;
				seq.push(next);
				if (repeating(seq, this.tok.timestampBegin)) break;
				if (i + 1 >= sampleLen) break;
				cur = await this.step(next, cache as Record<string, Tensor>);
			}
			const text = this.tok.decode(seq.filter((t) => t < this.tok.eot));
			return {
				tokens: seq,
				avgLogprob: sumLogprob / (seq.length + 1),
				noSpeechProb,
				temperature,
				compressionRatio: compressionRatio(text),
			};
		} finally {
			this.disposeCache(cache);
		}
	}

	/** `t` repeated `b` times along the batch dimension (dims[0] must be 1). */
	private repeatBatch(t: Tensor, b: number): Tensor {
		const dims = t.dims as number[];
		if (b === 1) return t;
		const src = t.data as Float32Array;
		const out = new Float32Array(src.length * b);
		for (let i = 0; i < b; i++) out.set(src, i * src.length);
		return new this.ort.Tensor('float32', out, [b, ...dims.slice(1)]);
	}

	/** Rows `idx` of a [B, …] tensor. */
	private gatherBatch(t: Tensor, idx: readonly number[]): Tensor {
		const dims = t.dims as number[];
		const src = t.data as Float32Array;
		const row = src.length / dims[0];
		// the identity gather (every beam kept in order) needs no copy
		if (idx.length === dims[0] && idx.every((r, i) => r === i)) return t;
		const out = new Float32Array(row * idx.length);
		idx.forEach((r, i) => {
			out.set(src.subarray(r * row, (r + 1) * row), i * row);
		});
		return new this.ort.Tensor('float32', out, [idx.length, ...dims.slice(1)]);
	}

	/**
	 * Beam search at temperature 0 (OpenAI `BeamSearchDecoder` with patience 1 and `MaximumLikelihoodRanker`
	 * without length penalty: the finished sequence with the best sum of log-probabilities / length). The
	 * timestamp rules apply per beam. All beams run in one batched decoder call per step.
	 */
	private async decodeBeam(
		xa: Tensor,
		sotSeq: number[],
		prompt: readonly number[],
		beamSize: number,
	): Promise<DecodeResult> {
		if (this.decoder.deviceResident) throw new Error('beam search needs a CPU-resident decoder cache');
		const pre = this.prefix(prompt);
		const full = [...pre, ...sotSeq];
		const { logits, cache: c0 } = await this.full(full, xa, { cache: true });
		const noSpeechProb =
			this.tok.noSpeech !== null ? softmaxAt(rowOf(logits, pre.length), this.tok.noSpeech) : 0;
		let cache = c0 as Record<string, Tensor>;
		let rows = [rowOf(logits, full.length - 1)];
		let beams: Array<{ seq: number[]; score: number }> = [{ seq: [], score: 0 }];
		const finished = new Map<string, { seq: number[]; score: number }>();
		const sampleLen = Math.min(224, this.cfg.max_target_positions - full.length - 1);
		const cfg: FilterConfig = { ...this.filters, timestamps: true };
		const encKeys = Object.keys(cache).filter((k) => k.includes('.encoder.'));
		const encBatch = new Map<number, Record<string, Tensor>>();
		const encFor = (b: number) => {
			let e = encBatch.get(b);
			if (!e) {
				e = {};
				for (const k of encKeys) e[k] = this.repeatBatch(c0![k] as Tensor, b);
				encBatch.set(b, e);
			}
			return e;
		};
		for (let i = 0; i < sampleLen; i++) {
			const candidates: Array<{ src: number; seq: number[]; score: number }> = [];
			beams.forEach((beam, b) => {
				const row = rows[b];
				applyFilters(row, beam.seq, this.tok, cfg);
				const lse = logSumExp(row);
				// top beamSize + 1 tokens of this beam: one pass, no sort of the vocabulary (SG-013)
				for (const t of topK(row, beamSize + 1))
					candidates.push({ src: b, seq: [...beam.seq, t], score: beam.score + (row[t] - lse) });
			});
			candidates.sort((a, b) => b.score - a.score);
			const next: typeof candidates = [];
			for (const c of candidates) {
				if (c.seq[c.seq.length - 1] === this.tok.eot) {
					const seq = c.seq.slice(0, -1);
					const key = seq.join(',');
					if (finished.size < beamSize && !finished.has(key)) finished.set(key, { seq, score: c.score });
				} else next.push(c);
				if (next.length >= beamSize) break;
			}
			if (finished.size >= beamSize || !next.length || i + 1 >= sampleLen) {
				if (!finished.size) for (const c of next.slice(0, beamSize)) finished.set(c.seq.join(','), c);
				break;
			}
			// loops: a beam that keeps repeating itself is finished as it is
			const live = next.filter((c) => {
				if (!repeating(c.seq, this.tok.timestampBegin)) return true;
				if (finished.size < beamSize) finished.set(c.seq.join(','), { seq: c.seq, score: c.score });
				return false;
			});
			if (!live.length || finished.size >= beamSize) break;
			const B = live.length;
			const idx = live.map((c) => c.src);
			const feeds: Record<string, Tensor> = { ...encFor(B) };
			for (const k of Object.keys(cache))
				if (k.includes('.decoder.')) feeds[k] = this.gatherBatch(cache[k] as Tensor, idx);
			const fetches = ['logits'];
			for (let l = 0; l < this.cfg.decoder_layers; l++)
				for (const kv of ['key', 'value']) fetches.push(`present.${l}.decoder.${kv}`);
			const out = await this.timed('decoder', () =>
				this.decoder.run(
					{
						input_ids: new this.ort.Tensor(
							'int64',
							BigInt64Array.from(live.map((c) => BigInt(c.seq[c.seq.length - 1]))),
							[B, 1],
						),
						encoder_hidden_states: this.stepXa(B),
						...feeds,
						use_cache_branch: new this.ort.Tensor('bool', [true], [1]),
					},
					fetches,
				),
			);
			cache = { ...feeds };
			for (let l = 0; l < this.cfg.decoder_layers; l++)
				for (const kv of ['key', 'value'])
					cache[`past_key_values.${l}.decoder.${kv}`] = out[`present.${l}.decoder.${kv}`] as Tensor;
			const lg = out.logits as Tensor;
			const V = (lg.dims as number[])[2];
			const data = lg.data as Float32Array;
			rows = live.map((_, b) => data.slice(b * V, (b + 1) * V));
			beams = live.map((c) => ({ seq: c.seq, score: c.score }));
		}
		let best: { seq: number[]; score: number } | null = null;
		for (const f of finished.values())
			if (!best || f.score / Math.max(1, f.seq.length) > best.score / Math.max(1, best.seq.length)) best = f;
		const seq = best?.seq ?? [];
		const text = this.tok.decode(seq.filter((t) => t < this.tok.eot));
		return {
			tokens: seq,
			avgLogprob: (best?.score ?? 0) / (seq.length + 1),
			noSpeechProb,
			temperature: 0,
			compressionRatio: compressionRatio(text),
		};
	}

	private async decodeWithFallback(
		xa: Tensor,
		sotSeq: number[],
		prompt: readonly number[],
		fallback: boolean,
		seed: number,
		beamSize = 1,
	): Promise<DecodeResult> {
		const tried: DecodeResult[] = [];
		for (const t of fallback ? TEMPERATURES : [0]) {
			const result =
				t === 0 && beamSize > 1
					? await this.decodeBeam(xa, sotSeq, prompt, beamSize)
					: await this.decodeOnce(xa, sotSeq, prompt, t, seed);
			tried.push(result);
			let needsFallback =
				result.compressionRatio > COMPRESSION_RATIO_THRESHOLD || result.avgLogprob < LOGPROB_THRESHOLD;
			if (result.noSpeechProb > NO_SPEECH_THRESHOLD && result.avgLogprob < LOGPROB_THRESHOLD)
				needsFallback = false;
			if (!needsFallback) return result;
		}
		// Every temperature failed the quality checks. OpenAI keeps the last (temperature 1.0) sample, which is often
		// noise; like faster-whisper, keep the most likely result among those that are not loops (else the most likely).
		const notLoops = tried.filter((r) => r.compressionRatio <= COMPRESSION_RATIO_THRESHOLD);
		const pool = notLoops.length ? notLoops : tried;
		return pool.reduce((best, r) => (r.avgLogprob > best.avgLogprob ? r : best));
	}

	/**
	 * One decode result of a window → its segments (absolute times from `timeOffset`), the kept tokens of each, the
	 * removed repeated-token runs (window-relative times) and the word alignment; `parsed` null = a no-speech window.
	 */
	private async analyseWindow(
		r: DecodeResult,
		xa: Tensor,
		sotSeq: number[],
		segmentFrames: number,
		language: string,
		timeOffset = 0,
	): Promise<{
		parsed: ReturnType<typeof parseSegments> | null;
		segs: SegmentWords[];
		segTokens: Map<SegmentWords, number[]>;
		removedRuns: Array<{ text: string; start: number; end: number; reason: string }>;
		alignment: WordTiming[] | null;
		text: string;
	}> {
		const segs: SegmentWords[] = [];
		const segTokens = new Map<SegmentWords, number[]>();
		const removedRuns: Array<{ text: string; start: number; end: number; reason: string }> = [];
		if (r.noSpeechProb > NO_SPEECH_THRESHOLD && r.avgLogprob < LOGPROB_THRESHOLD)
			return { parsed: null, segs, segTokens, removedRuns, alignment: null, text: '' };
		const parsed = parseSegments(r.tokens, this.tok, segmentFrames);
		for (const s of parsed.segments) {
			// TC-003: runs of ≥ 4 identical text tokens are a loop, not speech
			const cleaned = dropRepeatedTokenRuns(s.tokens, this.tok.eot);
			for (const run of cleaned.removed)
				removedRuns.push({
					text: this.tok.decode(run).trim(),
					start: s.start,
					end: s.end,
					reason: 'repeated-tokens',
				});
			const textTokens = cleaned.tokens.filter((t) => t < this.tok.eot);
			if (s.start === s.end || !this.tok.decode(textTokens).trim()) continue;
			const seg: SegmentWords = {
				start: timeOffset + s.start,
				end: timeOffset + s.end,
				textTokens,
				words: [],
			};
			segs.push(seg);
			segTokens.set(seg, cleaned.tokens);
		}
		const text = segs.flatMap((s) => s.textTokens);
		const alignment = text.length ? await this.align(xa, sotSeq, text, segmentFrames, language) : null;
		return { parsed, segs, segTokens, removedRuns, alignment, text: this.tok.decode(text).trim() };
	}

	/** Word timing for the text tokens of one window (seconds from the window start). */
	private async align(xa: Tensor, sotSeq: number[], text: number[], segmentFrames: number, language: string) {
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

	// ------------------------------------------------------------ spec 17 SC-032: teacher-forced scoring

	/** Encoder and decoder time so far (scoring jobs report it). */
	get timing(): { encoderMs: number; decoderMs: number; decoderRuns: number } {
		return {
			encoderMs: Math.round(this.profile.encoderMs),
			decoderMs: Math.round(this.profile.decoderMs),
			decoderRuns: this.profile.decoderRuns,
		};
	}

	/**
	 * Tokens of one reading: `encode(' ' + word)` per word, concatenated (= GPT-2 pre-tokenisation of the words joined
	 * by spaces, so token spans map to words; not `splitToWordTokens`, which splits punctuation off). Refused when the
	 * tokenizer cannot encode.
	 */
	readingTokens(words: readonly string[]): number[][] {
		if (!this.tok.canEncode)
			throw new SpeechRefusal(
				'SPEECH_TOKENIZER_CANNOT_ENCODE',
				"The speech model's tokenizer cannot encode text (tokenizer.json has no BPE merges)",
			);
		return words.map((w) => {
			const ids = this.tok.encode(` ${w.trim()}`);
			if (!ids.length)
				throw new SpeechRefusal(
					'SPEECH_TOKENIZER_CANNOT_ENCODE',
					`The word "${w.slice(0, 64)}" encodes to no tokens`,
				);
			return ids;
		});
	}

	/** The start-of-transcript sequence of a scored reading (`transcribe`, no timestamps follow). */
	scoreSot(language: string): number[] {
		if (this.tok.multilingual) {
			if (this.tok.languageToken(language) === null)
				throw new SpeechRefusal(
					'SPEECH_LANGUAGE_UNKNOWN',
					`The model does not know the language "${language}"`,
				);
		} else if (language !== 'en')
			throw new SpeechRefusal(
				'SPEECH_LANGUAGE_UNSUPPORTED',
				`The model is English-only and cannot score "${language}" speech`,
			);
		return this.sotSequence(language, 'transcribe');
	}

	/**
	 * The encoder output of samples [start, end) of the input: ≤ 30 s from the mel frame of `start`, zero-padded to
	 * 30 s like a transcription window (the whole file's normalisation, as transcription).
	 */
	async encodeRange(
		input: SpeechInput,
		start: number,
		end: number,
		/** Sample ranges [start, end) heard as silence (spec 17 SC-030: the gaps of a packed window). */
		mute: ReadonlyArray<{ start: number; end: number }> = [],
	): Promise<{ xa: Tensor; frame0: number; frames: number }> {
		const content = Math.max(0, input.mel.frames - N_FRAMES);
		const frame0 = Math.max(0, Math.floor(start / HOP));
		// a 30 s window that does not start on a frame boundary touches 3001 frames: its last partial frame is left out
		const wanted = Math.min(N_FRAMES, Math.ceil(end / HOP) - frame0);
		if (end - start > N_FRAMES * HOP)
			throw new SpeechRefusal(
				'SPEECH_WINDOW_TOO_LONG',
				`A scoring window is at most 30 s (got ${(end - start) / SAMPLE_RATE} s)`,
			);
		const frames = Math.min(wanted, content - frame0);
		if (!(frames > 0))
			throw new SpeechRefusal(
				'SPEECH_WINDOW_OUT_OF_RANGE',
				`The window ${(start / SAMPLE_RATE).toFixed(2)}–${(end / SAMPLE_RATE).toFixed(2)} s lies outside the audio`,
			);
		const win = new Float32Array(this.cfg.num_mel_bins * N_FRAMES);
		input.mel.window(frame0, frames, win, N_FRAMES);
		if (mute.length) this.muteWindow(input, frame0, frames, win, mute);
		return { xa: await this.encode(win), frame0, frames };
	}

	/**
	 * SC-030 muted gaps: the window's frames computed as if the samples of `mute` were zero (the frames stay where
	 * they are, so times stay absolute). Frames whose 25 ms window lies inside a muted range are digital silence;
	 * frames straddling a range edge are recomputed from the kept samples around the edge (`samplesIn`); the rest
	 * are the streamed frames. Normalised with the whole file's maximum like every window.
	 */
	private muteWindow(
		input: SpeechInput,
		frame0: number,
		frames: number,
		win: Float32Array,
		mute: ReadonlyArray<{ start: number; end: number }>,
	): void {
		const nMels = this.cfg.num_mel_bins;
		const floor = input.mel.max - 8;
		const norm = (v: number) => ((v > floor ? v : floor) + 4) / 4;
		const row = new Float32Array(nMels);
		this.melFrames ??= new MelFrameComputer(nMels);
		for (let f = frame0; f < frame0 + frames; f++) {
			const a = f * HOP - FRAME_HALF;
			const b = f * HOP + FRAME_HALF;
			const hits = mute.filter((m) => m.start < b && m.end > a && m.end > m.start);
			if (!hits.length) continue;
			const col = f - frame0;
			if (hits.some((m) => m.start <= a && m.end >= b && a >= 0)) {
				// all-zero samples: log10(max(0, 1e-10)) = −10, as the stream computes for silence
				const v = norm(-10);
				for (let m = 0; m < nMels; m++) win[m * N_FRAMES + col] = v;
				continue;
			}
			// the samples this frame reads: [a, b), reflected at 0 (index −i reads sample i), zeros after the audio
			const from = Math.max(0, a);
			const to = Math.min(input.samples, Math.max(b, a < 0 ? -a + 1 : 0));
			const got = to > from ? (input.samplesIn?.(from, to) ?? null) : new Float32Array(0);
			if (got === null) throw new Error('scoring: the samples around a muted range were not kept');
			const sampleAt = (i: number) => {
				const j = i < 0 ? -i : i;
				if (j >= input.samples || j < from || j >= to) return 0;
				for (const m of mute) if (j >= m.start && j < m.end) return 0;
				return got[j - from]!;
			};
			this.melFrames.frame(f, sampleAt, row);
			for (let m = 0; m < nMels; m++) win[m * N_FRAMES + col] = norm(row[m]!);
		}
	}

	/**
	 * SC-032: scores readings of one encoded window. Each reading is `[sot, lang, transcribe, notimestamps] +
	 * Σ encode(' ' + word) + [eot]` (English-only models: `[sot, notimestamps] + …`), run through ONE uncached decoder
	 * pass (no prompt, no autoregressive loop; readings batched, right-padded with eot — the decoder is causal, so
	 * padding never changes earlier rows). LL = Σ full-vocabulary log-softmax of every text token and eot. The same
	 * pass's cross-attention gives forced DTW word times (the alignment heads, z-score, median filter and DTW of
	 * `align`, SC-040). Times are samples of the input, inside the window.
	 */
	async scoreReadings(
		enc: { xa: Tensor; frame0: number; frames: number },
		readings: ReadonlyArray<readonly string[]>,
		opts: { language: string; batch?: number; signal?: AbortSignal },
	): Promise<ScoredReading[]> {
		const sotSeq = this.scoreSot(opts.language);
		const prefix = [...sotSeq, this.tok.noTimestamps];
		const max = this.cfg.max_target_positions;
		const seqs = readings.map((words) => {
			const wt = this.readingTokens(words);
			const tokens = [...prefix, ...wt.flat(), this.tok.eot];
			if (tokens.length > max)
				throw new SpeechRefusal(
					'SPEECH_READING_TOO_LONG',
					`A reading of ${words.length} words has ${tokens.length} tokens; the model reads at most ${max}`,
				);
			return { words, wt, tokens };
		});
		const layers = [...new Set(this.alignmentHeads.map(([l]) => l))];
		const perReading = (t: number) =>
			t * this.cfg.vocab_size + layers.length * this.cfg.decoder_attention_heads * t * 1500;
		const maxBatch = Math.max(1, Math.min(32, Math.floor(opts.batch ?? 8)));
		const out: ScoredReading[] = [];
		let i = 0;
		while (i < seqs.length) {
			if (opts.signal?.aborted) throw new CancelledError();
			let b = 1;
			let t = seqs[i]!.tokens.length;
			while (b < maxBatch && i + b < seqs.length) {
				const t2 = Math.max(t, seqs[i + b]!.tokens.length);
				if ((b + 1) * perReading(t2) > SCORE_BATCH_BUDGET) break;
				t = t2;
				b++;
			}
			out.push(...(await this.scoreBatch(seqs.slice(i, i + b), enc, sotSeq.length, layers)));
			i += b;
		}
		return out;
	}

	private async scoreBatch(
		group: ReadonlyArray<{ words: readonly string[]; wt: number[][]; tokens: number[] }>,
		enc: { xa: Tensor; frame0: number; frames: number },
		sotLen: number,
		layers: number[],
	): Promise<ScoredReading[]> {
		const B = group.length;
		const T = Math.max(...group.map((g) => g.tokens.length));
		const ids = new BigInt64Array(B * T).fill(BigInt(this.tok.eot));
		group.forEach((g, b) => {
			for (let t = 0; t < g.tokens.length; t++) ids[b * T + t] = BigInt(g.tokens[t]!);
		});
		const res = await this.timed('decoder', () =>
			this.decoder.run(
				{
					input_ids: new this.ort.Tensor('int64', ids, [B, T]),
					encoder_hidden_states: this.repeatBatch(enc.xa, B),
					...this.emptyPast(B),
					use_cache_branch: new this.ort.Tensor('bool', [false], [1]),
				},
				['logits', ...layers.map((l) => `cross_attentions.${l}`)],
			),
		);
		const logits = res.logits as Tensor;
		const V = (logits.dims as number[])[2] as number;
		const L = logits.data as Float32Array;
		const textStart = sotLen + 1;
		const base = enc.frame0 * HOP;
		const limit = base + enc.frames * HOP;
		return group.map((g, b) => {
			const n = g.tokens.length;
			// lp[k]: log p(token textStart + k | everything before it), over the full vocabulary; the last one is eot
			const lp: number[] = [];
			for (let p = textStart; p < n; p++) {
				const off = (b * T + p - 1) * V;
				const v = L[off + g.tokens[p]!]! - logSumExp(L, off, off + V);
				// a GPU (fp16) overflow, not a property of the reading: fail so the job reruns on the CPU
				if (!Number.isFinite(v)) throw new Error('the decoder returned non-finite scores');
				lp.push(v);
			}
			const attn: Float32Array[] = [];
			let framesAll = 1500;
			for (const [l, h] of this.alignmentHeads) {
				const t = res[`cross_attentions.${l}`] as Tensor;
				const [, H, Tt, F] = t.dims as number[];
				framesAll = F as number;
				if (h < (H as number))
					attn.push(
						(t.data as Float32Array).subarray(
							(b * (H as number) + h) * (Tt as number) * framesAll,
							(b * (H as number) + h + 1) * (Tt as number) * framesAll,
						),
					);
			}
			const textLen = n - textStart - 1;
			const jump = alignTokens(
				attn,
				n,
				framesAll,
				Math.floor(enc.frames / 2),
				sotLen,
				textLen,
				this.medianWidth,
			);
			const timings = wordTimings(
				g.wt.map((tokens, k) => ({ word: g.words[k] ?? '', tokens })),
				jump,
				[],
			);
			let k = 0;
			const words = g.wt.map((tokens, w): ScoredWord => {
				let sum = 0;
				let prob = 0;
				for (let j = 0; j < tokens.length; j++) {
					sum += lp[k]!;
					prob += Math.exp(lp[k]!);
					k++;
				}
				const tm = timings[w]!;
				const start = Math.min(limit, Math.max(base, base + Math.round(tm.start * SAMPLE_RATE)));
				const end = Math.min(limit, Math.max(start, base + Math.round(tm.end * SAMPLE_RATE)));
				return {
					text: (g.words[w] ?? '').trim(),
					tokens: tokens.length,
					logprob: sum,
					probability: prob / tokens.length,
					start,
					end,
				};
			});
			let total = 0;
			for (const x of lp) total += x;
			return { logprob: total, tokens: lp.length, words };
		});
	}

	/** The initial prompt tokens (verbatim prompt of the language + custom prompt), OpenAI `" " + prompt.strip()`. */
	initialPromptTokens(language: string, opts: Pick<WhisperOptions, 'verbatim' | 'initialPrompt'>): number[] {
		const parts: string[] = [];
		if (opts.verbatim) parts.push(VERBATIM_PROMPTS[language] ?? VERBATIM_PROMPTS.en);
		if (opts.initialPrompt?.trim()) parts.push(opts.initialPrompt.trim());
		if (!parts.length || !this.tok.canEncode) return [];
		return this.tok.encode(` ${parts.join(' ')}`).slice(0, this.maxPrompt);
	}

	/** Transcribes mono 16 kHz audio (an in-memory clip or a streamed input). */
	async transcribe(source: Float32Array | SpeechInput, opts: WhisperOptions = {}): Promise<WhisperResult> {
		const owned = source instanceof Float32Array;
		const input = owned ? inputFromSamples(source, this.cfg.num_mel_bins) : source;
		try {
			return await this.transcribeInput(input, opts);
		} finally {
			if (owned) input.dispose();
		}
	}

	private async transcribeInput(input: SpeechInput, opts: WhisperOptions): Promise<WhisperResult> {
		const t0 = performance.now();
		this.profile = { encoderMs: 0, decoderMs: 0, decoderRuns: 0 };
		const nMels = this.cfg.num_mel_bins;
		if (input.mel.nMels !== nMels)
			throw new Error(`the input has ${input.mel.nMels} mel bands, the model ${nMels}`);
		const task = opts.task === 'translate' && this.tok.multilingual ? 'translate' : 'transcribe';
		const condition = opts.conditionOnPreviousText ?? true;
		const fallback = opts.temperatureFallback ?? true;
		const beamSize = Math.max(1, Math.min(10, opts.beamSize ?? 1));
		const silenceThreshold = opts.hallucinationSilence ?? HALLUCINATION_SILENCE;
		const progress = (f: number, stage: string) => {
			if (opts.signal?.aborted) throw new CancelledError();
			if (opts.onProgress?.(f, stage) === false) throw new CancelledError();
		};
		progress(0, 'Analysing audio');
		const contentFrames = Math.max(0, input.mel.frames - N_FRAMES);
		const contentEnd = contentFrames / 100;
		const mask = input.mask;
		const db = input.db;
		let language = opts.language && opts.language !== 'auto' ? opts.language : null;
		if (language && this.tok.multilingual && this.tok.languageToken(language) === null)
			throw new Error(`The model does not know the language "${language}"`);
		if (!this.tok.multilingual) language = 'en';
		let languageProbability: number | null = null;
		const words: WhisperWord[] = [];
		const segmentsOut: WhisperSegment[] = [];
		const removed: WhisperResult['guard']['removed'] = [];
		let skippedWindows = 0;
		const allTokens: number[] = [];
		let initial: number[] | null = null;
		let gloss: { terms: string[]; tokens: number[] } | null = null;
		let glossGuard: GlossaryGuard | null = null;
		let promptResetSince = 0;
		let lastSpeech = 0;
		let seek = 0;
		let windowIndex = 0;
		let windows = 0;
		const win = new Float32Array(nMels * N_FRAMES);
		while (seek < contentFrames) {
			const frac = seek / Math.max(1, contentFrames);
			progress(frac * 0.97, `Transcribing ${Math.round(frac * 100)}%`);
			const timeOffset = (seek * HOP) / SAMPLE_RATE;
			const segmentFrames = Math.min(N_FRAMES, contentFrames - seek);
			// SG-011: a window without voice is not decoded (Whisper invents text over silence)
			if (countVoiced(mask, seek, seek + segmentFrames) < MIN_VOICED_FRAMES) {
				skippedWindows++;
				promptResetSince = allTokens.length;
				seek += segmentFrames;
				continue;
			}
			// SG-011: the previous text is not carried over a silence of ≥ 2 s
			let firstVoiced = seek;
			while (firstVoiced < seek + segmentFrames && !(mask[firstVoiced] > 0)) firstVoiced++;
			let silenceStart = firstVoiced;
			while (silenceStart > 0 && !(mask[silenceStart - 1] > 0)) silenceStart--;
			if (firstVoiced - silenceStart >= HALLUCINATION_SILENCE * 100) promptResetSince = allTokens.length;
			input.mel.window(seek, segmentFrames, win, N_FRAMES);
			const xa = await this.encode(win);
			windows++;
			if (language === null) {
				const d = await this.detectLanguage(xa);
				language = d.language;
				languageProbability = d.probability;
			}
			const sotSeq = this.sotSequence(language, task);
			if (this.gpuDecoder && beamSize === 1) await this.calibrate(xa, sotSeq);
			if (initial === null) {
				// OpenAI `initial_prompt`: the first tokens of the running text, so it conditions the first window
				// and keeps conditioning through the previous text until a prompt reset (temperature > 0.5, a silence
				// of ≥ 2 s, or conditionOnPreviousText off)
				initial = this.initialPromptTokens(language, opts);
				allTokens.push(...initial);
			}
			if (gloss === null) {
				// SC-074: the glossary fits after the initial prompt within the prompt cap
				const terms = normalizeGlossary(opts.glossary);
				gloss =
					terms.length && this.tok.canEncode
						? glossaryTokens(terms, (t) => this.tok.encode(t), this.maxPrompt - initial.length)
						: { terms: [], tokens: [] };
				if (opts.glossary?.length)
					glossGuard = { terms: gloss.terms.length, tokens: gloss.tokens.length, events: 0, replaced: 0 };
			}
			const running = allTokens.slice(promptResetSince);
			const initialKept = Math.max(0, initial.length - promptResetSince);
			const plainPrompt = composePrompt(running, initialKept, [], this.maxPrompt);
			const prompt = gloss.tokens.length
				? composePrompt(running, initialKept, gloss.tokens, this.maxPrompt)
				: plainPrompt;
			const seed = 1234 + windowIndex;
			let r = await this.decodeWithFallback(xa, sotSeq, prompt, fallback, seed, beamSize);
			windowIndex++;
			let a = await this.analyseWindow(r, xa, sotSeq, segmentFrames, language, timeOffset);
			if (gloss.tokens.length && a.alignment && glossGuard) {
				// SC-075: a carried term repeated ≥ 3 times within 10 s → decode the window without the glossary and
				// keep that text when it differs
				const term = repeatedGlossaryTerm(
					a.alignment.map((w) => ({ word: w.word, start: timeOffset + w.start })),
					gloss.terms,
				);
				if (term) {
					glossGuard.events++;
					const r2 = await this.decodeWithFallback(xa, sotSeq, plainPrompt, fallback, seed, beamSize);
					const a2 = await this.analyseWindow(r2, xa, sotSeq, segmentFrames, language, timeOffset);
					if (a2.text !== a.text) {
						r = r2;
						a = a2;
						glossGuard.replaced++;
					}
				}
			}
			if (!a.parsed) {
				seek += segmentFrames;
				continue;
			}
			removed.push(
				...a.removedRuns.map((x) => ({ ...x, start: timeOffset + x.start, end: timeOffset + x.end })),
			);
			const { parsed, segs, segTokens } = a;
			let nextSeek = seek + parsed.seekFrames;
			const text = segs.flatMap((s) => s.textTokens);
			let kept = segs;
			if (text.length && a.alignment) {
				const alignment = a.alignment;
				const lastBefore = lastSpeech;
				lastSpeech = addWordTimestamps(segs, alignment, timeOffset, lastSpeech);
				const windowEnd = timeOffset + segmentFrames / 100;
				if (!parsed.singleTimestampEnding) {
					let lastWordEnd: number | null = null;
					for (const s of segs) for (const w of s.words) lastWordEnd = w.end;
					if (lastWordEnd !== null && lastWordEnd > timeOffset) {
						// resume after the voice that the last word's (often early) end leaves, but not past the
						// window's last complete segment
						const segEnd = Math.round(segs[segs.length - 1].end * 100);
						nextSeek = endOfVoice(
							db,
							input.threshold,
							Math.round(lastWordEnd * 100),
							Math.max(segEnd, Math.round(lastWordEnd * 100)),
						);
					}
				}
				if (silenceThreshold > 0) {
					// SG-011: OpenAI's hallucination silence threshold
					const cut = silenceThresholdCut(segs, {
						threshold: silenceThreshold,
						windowStart: timeOffset,
						windowEnd,
						contentEnd,
						lastSpeech: lastBefore,
						singleTimestampEnding: parsed.singleTimestampEnding,
						seek: nextSeek / 100,
					});
					if (cut.skipTo !== null) {
						// a likely hallucination after a long leading silence: decode again from where it starts
						seek = Math.max(seek + 1, Math.round(cut.skipTo * 100));
						lastSpeech = lastBefore;
						continue;
					}
					for (const s of segs.slice(cut.keep))
						removed.push({
							text: this.tok.decode(s.textTokens).trim(),
							start: s.start,
							end: s.end,
							reason: 'silence-threshold',
						});
					kept = segs.slice(0, cut.keep);
					if (cut.keep < segs.length) nextSeek = Math.round(cut.seek * 100);
					// with the custom seek of a cut, the last speech is the last kept segment
					lastSpeech = kept.length
						? (kept[kept.length - 1].words.at(-1)?.end ?? kept[kept.length - 1].end)
						: lastBefore;
				}
				for (const s of kept) {
					segmentsOut.push({
						start: s.start,
						end: s.end,
						text: this.tok.decode(s.textTokens).trim(),
						avgLogprob: round4(r.avgLogprob),
						noSpeechProb: round4(r.noSpeechProb),
						compressionRatio: round4(r.compressionRatio),
						temperature: r.temperature,
					});
					for (const w of s.words) {
						const prevEnd = words.length ? words[words.length - 1].end : 0;
						const a = Math.max(prevEnd, Math.round(Math.min(w.start, windowEnd) * SAMPLE_RATE));
						const b = Math.max(a, Math.round(Math.min(w.end, windowEnd) * SAMPLE_RATE));
						const t = w.word.trim();
						if (t)
							words.push({ text: t, start: a, end: Math.min(b, input.samples), probability: w.probability });
					}
					allTokens.push(...(segTokens.get(s) ?? s.textTokens));
				}
			}
			if (!condition || r.temperature > 0.5) promptResetSince = allTokens.length;
			seek = Math.max(seek + 1, nextSeek);
		}
		progress(0.97, 'Aligning words');
		const totalMs = performance.now() - t0;
		return {
			language: language ?? 'en',
			languageProbability,
			words,
			segments: segmentsOut,
			guard: { skippedWindows, removed, glossary: glossGuard },
			profile: {
				encoderMs: Math.round(this.profile.encoderMs),
				decoderMs: Math.round(this.profile.decoderMs),
				jsMs: Math.round(Math.max(0, totalMs - this.profile.encoderMs - this.profile.decoderMs)),
				decoderRuns: this.profile.decoderRuns,
				windows,
			},
		};
	}
}

function round4(x: number): number {
	return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : 0;
}

/** Row `t` of logits shaped [1, T, V] (a copy). */
function rowOf(logits: Tensor, t: number): Float32Array {
	const [, , V] = logits.dims as number[];
	const d = logits.data as Float32Array;
	return d.slice(t * V, (t + 1) * V);
}
