// One transcription, in-process: decode (streamed) → Whisper → wordless voiced spans decoded again → windows around
// stretched words, short wordless voice and garbled words decoded again (hidden takes) → word-bound repair (pauses, voice) →
// hallucination guards → VAD tightening → speakers. Used by the `jasper-speech` child process (cli.ts) and by tests.
//
// Execution providers (spec 16 SG-002/SG-003): the job spec says which provider each model part uses (the engine
// chose it from the cached probe). A part whose GPU session cannot be created runs on the CPU (recorded); when the
// GPU fails during recognition the job runs once more entirely on the CPU, and fails with the original error when
// that fails too.
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { decodeVoiceAnalysis, VOICE_ANALYSIS_VERSION, VOICE_CLASSES } from '@jasper/project/cleanup-worker';
import { CUDA_STATUS, type ProviderId, shortReason } from '../../tools/ort.ts';
import { restrictInputs } from '../../tools/protocols.ts';
import { type Chunk, mergeZones, shiftedChunks, vadChunks } from '../core/chunks.ts';
import { DEFAULT_DIARIZE, diarize } from '../core/diarize.ts';
import {
	GAP_MAX_SPANS,
	isStretchedWord,
	mergeRecoveredWords,
	REDECODE_CHUNKED_MAX_FRAMES,
	REDECODE_EDGE_GUARD_FRAMES,
	redecodeAccepted,
	replaceRegion,
	replaceWindowWords,
	suspectWindows,
	wordlessVoicedSpans,
} from '../core/gaps.ts';
import { knownPhraseRuns, phraseOverNonSpeech } from '../core/hallucination.ts';
import { SAMPLE_RATE } from '../core/mel.ts';
import {
	amidVoice,
	extendWordsIntoSpeech,
	MIN_VOICED_FRACTION,
	type SpeechMask,
	splitAtPauses,
	tightenWords,
	unvoicedWords,
	VAD_FRAME,
	voicedFraction,
} from '../core/vad.ts';
import { CancelledError, decodeToInput, inputFromSamples, type SpeechInput } from './audio.ts';
import {
	type GlossaryGuard,
	type LoadOptions,
	SpeechRefusal,
	WhisperModel,
	type WhisperOptions,
	type WhisperResult,
	type WhisperSegment,
	type WhisperWord,
} from './whisper.ts';

export type SpeechDevicePlan = {
	encoder: ProviderId;
	decoder: ProviderId;
	/** GPU decoder to calibrate against the CPU decoder on the first window (greedy). */
	calibrate?: ProviderId | null;
};

export type SpeechJobSpec = {
	modelDir: string;
	modelId: string;
	/** Audio source: decoded with ffmpeg (`stream` = absolute stream index; default the first audio stream). */
	input: { path: string; stream?: number; ffmpeg: string } | { f32: string };
	language?: string | null;
	task?: 'transcribe' | 'translate';
	speakers?: { enabled: boolean; count?: number; max?: number };
	/** Beam search width (default 1 = greedy, SG-010). */
	beamSize?: number;
	threads?: number;
	/** Providers per part (default CPU). */
	device?: SpeechDevicePlan;
	/** Model files (default `encoder_model.onnx` / `decoder_model_merged.onnx`). */
	files?: { encoder?: string; decoder?: string };
	verbatim?: boolean;
	initialPrompt?: string;
	conditionOnPreviousText?: boolean;
	/**
	 * Decode the windows around stretched words, short wordless voice and garbled words again, alone (hidden takes,
	 * `core/gaps.ts`; default true).
	 */
	redecode?: boolean;
	/**
	 * `vad`: decode chunks of 3–10 s split at pauses, each on its own without the previous text, twice with shifted
	 * boundaries, merged (`core/chunks.ts`). Default: Whisper's 30 s windows.
	 */
	chunking?: 'vad';
	/** Spec 17 SC-074: glossary terms carried into every window's prompt (≤ 40, each ≤ 64 characters). */
	glossary?: string[];
	/** Where long-file spectrograms and kept samples go (default: a temporary directory). */
	scratch?: string;
	/** Audio duration hint (seconds) for decode progress. */
	durationSec?: number;
	/**
	 * Spec 14 TC-004: the media stream's voice analysis (TC-001 frame classes) to refine word bounds against, when it
	 * exists by the end of recognition (the engine starts the analysis next to the transcription).
	 */
	voiceAnalysis?: { path: string; fingerprint: string; stream: number };
};

export type SpeechJobWord = {
	text: string;
	/** 16 kHz samples from the start of the decoded audio. */
	start: number;
	end: number;
	confidence: number;
	/** 0-based speaker label (speaker labelling on), else null. */
	speaker: number | null;
};

export type SpeechFallbackOut = {
	stage: 'session' | 'job';
	part: 'encoder' | 'decoder' | 'both';
	from: ProviderId;
	to: ProviderId;
	reason: string;
};

export type SpeechJobOutput = {
	modelId: string;
	language: string;
	languageProbability: number | null;
	task: 'transcribe' | 'translate';
	samples: number;
	speakers: number;
	words: SpeechJobWord[];
	segments: WhisperSegment[];
	timings: { decodeMs: number; loadMs: number; transcribeMs: number };
	device: { encoder: ProviderId; decoder: ProviderId; threads: number; fallbacks: SpeechFallbackOut[] };
	calibration: {
		provider: ProviderId;
		cpuMsPerToken: number;
		gpuMsPerToken: number;
		decoder: ProviderId;
	} | null;
	guard: {
		skippedWindows: number;
		droppedWords: number;
		removed: Array<{ text: string; start: number; end: number; reason: string }>;
		/** Which speech frames refined the word bounds (TC-004). */
		frames: 'voice-analysis' | 'energy';
		/** SC-074/SC-075 (only when a glossary was given). */
		glossary?: GlossaryGuard;
		/** Wordless voiced spans decoded again (`core/gaps.ts`; only when there were any). */
		recovered?: RecoveredReport;
		/** Windows around stretched words and short wordless voice decoded again (only when there were any). */
		redecoded?: RedecodedReport;
		/** `chunking: "vad"`: chunks of each pass and the merge zones where the shifted pass's words were taken. */
		chunked?: ChunkedReport;
	};
	profile: WhisperResult['profile'];
};

/**
 * The wordless-span pass: spans decoded again, words they yielded (before word-bound refinement), spans over the
 * budget, and each decoded span (seconds from the start of the decoded audio).
 */
export type RecoveredReport = {
	spans: number;
	words: number;
	skipped: number;
	ranges: Array<{ start: number; end: number; words: number }>;
};

/**
 * The hidden-take pass (`core/gaps.ts`): windows decoded again, how many replaced their words, words that added,
 * windows over the budget, and each decoded window (seconds from the start of the decoded audio) with its word counts
 * before and after and whether its words were replaced (the ranges downstream marks as decoded again).
 */
export type RedecodedReport = {
	windows: number;
	replaced: number;
	wordsAdded: number;
	skipped: number;
	/**
	 * `chunked`: present when the window's re-decode was rejected and the window was decoded again in VAD chunks
	 * (`after` then counts those words); true when they replaced the window's words.
	 */
	ranges: Array<{
		start: number;
		end: number;
		before: number;
		after: number;
		replaced: boolean;
		chunked?: boolean;
	}>;
};

/** The VAD-chunked passes: chunks of the first and shifted pass, merge zones, zones that took the shifted words. */
export type ChunkedReport = { chunks: number; shiftedChunks: number; zones: number; replaced: number };

/**
 * TC-004: the voice analysis' frame classes as masks over our 10 ms frames (frame k = samples [160 k, 160 (k + 1))
 * in both): `speech` (bounds snap to it) and `presence` (speech or breath: what keeps a word), or null when the
 * file is missing, invalid or of another decode length.
 */
export async function voiceAnalysisMask(
	va: NonNullable<SpeechJobSpec['voiceAnalysis']>,
	frames: number,
): Promise<{ speech: Uint8Array; presence: Uint8Array } | null> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(va.path));
	} catch {
		return null;
	}
	const r = decodeVoiceAnalysis(bytes, {
		fingerprint: va.fingerprint,
		stream: va.stream,
		analysisVersion: VOICE_ANALYSIS_VERSION,
	});
	if (!r.ok || Math.abs(r.analysis.frameCount - frames) > 2) return null;
	const speech = new Uint8Array(frames);
	const presence = new Uint8Array(frames);
	const cls = r.analysis.classes;
	for (let f = 0; f < frames && f < cls.length; f++) {
		speech[f] = cls[f] === VOICE_CLASSES.speech ? 1 : 0;
		presence[f] = cls[f] !== VOICE_CLASSES.silence ? 1 : 0;
	}
	return { speech, presence };
}

/** Decodes the input to mono 16 kHz float32 with ffmpeg (whole clip in memory; tests and tools). */
export async function decodeAudio(
	input: { path: string; stream?: number; ffmpeg: string },
	signal?: AbortSignal,
): Promise<Float32Array> {
	const { spawn } = await import('node:child_process');
	const args = ['-v', 'error', '-nostdin', '-i', input.path];
	args.push('-map', input.stream !== undefined ? `0:${input.stream}` : '0:a:0');
	args.push('-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
	return new Promise((resolve, reject) => {
		const child = spawn(input.ffmpeg, restrictInputs(args), { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks: Buffer[] = [];
		let err = '';
		const onAbort = () => child.kill('SIGKILL');
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (c: Buffer) => chunks.push(c));
		child.stderr.on('data', (c: Buffer) => {
			if (err.length < 4000) err += c.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			signal?.removeEventListener('abort', onAbort);
			if (signal?.aborted) return reject(new CancelledError());
			if (code !== 0)
				return reject(new Error(`ffmpeg could not decode the audio: ${err.trim() || `exit ${code}`}`));
			const b = Buffer.concat(chunks);
			const n = Math.floor(b.byteLength / 4);
			const out = new Float32Array(n);
			for (let i = 0; i < n; i++) out[i] = b.readFloatLE(i * 4);
			resolve(out);
		});
	});
}

/**
 * What word-bound refinement reads of the audio: `mask` = speech frames (bounds snap to them), `presence` = speech
 * or breath frames (a word with less than 20 % of them lies in silence; default `mask`).
 */
export type FrameSource = { samples: number; db: Float32Array; mask: SpeechMask; presence?: SpeechMask };

type RefinableWord = { start: number; end: number; text?: string };

/**
 * Word-bound refinement after alignment (spec 14 TC-004, spec 16 SG-011; see core/vad.ts): repair at pauses
 * (never moving a word across a silence), grow into voice, drop words lying in silence (< 20 % speech frames without
 * their silent edges; never a word inside running speech, `amidVoice`) and known hallucination phrases over
 * non-speech, tighten over silence. Returns the kept words (a new array; the kept word objects are the same) and what
 * was removed (words in silence as runs, reason `silence`).
 */
export function refineWords<W extends RefinableWord>(
	src: FrameSource,
	words: W[],
	/**
	 * Keep every word (spec 17 scoring: one timed word per scored word): bounds are repaired, grown and tightened,
	 * but words lying in silence and known phrases are not dropped.
	 */
	opts: { keepAll?: boolean } = {},
): {
	words: W[];
	dropped: number;
	removed: Array<{ text: string; start: number; end: number; reason: string }>;
} {
	const { samples, db, mask } = src;
	const presence = src.presence ?? mask;
	const len = { length: samples };
	const orphans = new Set(splitAtPauses(len, words, db, mask));
	extendWordsIntoSpeech(len, words, db, 25, mask);
	// words in silence — never a word inside running speech (`amidVoice`: a short word timed onto a dip)
	const silent = opts.keepAll
		? []
		: [...new Set([...orphans, ...unvoicedWords(words, presence)])]
				.filter((i) => !amidVoice(words[i]!, presence))
				.sort((a, b) => a - b);
	const drop = new Set<number>(silent);
	const removed: Array<{ text: string; start: number; end: number; reason: string }> = [];
	// what the silence guard removed, as runs of consecutive words
	for (let k = 0; k < silent.length; ) {
		let e = k + 1;
		while (e < silent.length && silent[e] === silent[e - 1]! + 1) e++;
		const run = silent.slice(k, e).map((i) => words[i]!);
		removed.push({
			text: run.map((w) => w.text ?? '').join(' '),
			start: run[0]!.start / SAMPLE_RATE,
			end: run[run.length - 1]!.end / SAMPLE_RATE,
			reason: 'silence',
		});
		k = e;
	}
	// known hallucination phrases over non-speech (TC-003), judged over the whole phrase
	const phrases = opts.keepAll ? [] : knownPhraseRuns(words.map((w) => ({ text: w.text ?? '' })));
	for (const [a, b] of phrases) {
		const span = words.slice(a, b);
		let voiced = 0;
		let total = 0;
		for (const w of span) {
			const frames = Math.max(1, Math.ceil((w.end - w.start) / VAD_FRAME));
			voiced += voicedFraction(w, presence) * frames;
			total += frames;
		}
		if (phraseOverNonSpeech(total ? voiced / total : 0)) {
			for (let i = a; i < b; i++) drop.add(i);
			removed.push({
				text: span.map((w) => w.text ?? '').join(' '),
				start: span[0]!.start / SAMPLE_RATE,
				end: span[span.length - 1]!.end / SAMPLE_RATE,
				reason: 'known-phrase',
			});
		}
	}
	const kept = words.filter((_, i) => !drop.has(i));
	tightenWords(len, kept, db, mask);
	// keep words ordered, non-overlapping and inside the audio
	let prev = 0;
	for (const w of kept) {
		w.start = Math.min(samples, Math.max(prev, Math.round(w.start)));
		w.end = Math.min(samples, Math.max(w.start, Math.round(w.end)));
		prev = w.end;
	}
	return { words: kept, dropped: drop.size, removed };
}

export type RunOptions = {
	onProgress?(fraction: number, stage: string): void;
	/** The providers that really run (after session fallbacks), once per attempt. */
	onDevice?(d: { encoder: ProviderId; decoder: ProviderId; attempt: number }): void;
	onSpawn?(child: ChildProcess): void;
	signal?: AbortSignal;
	audio?: Float32Array;
	/** Injected ONNX Runtime (tests). */
	ort?: LoadOptions['ort'];
	/** Diagnostic lines for the job log (the worker writes them to stderr, which the engine logs). */
	onLog?(line: string): void;
};

const isGpu = (p: ProviderId) => p !== 'cpu';

/** What loading a model needs (transcription and scoring specs). */
type ModelSpec = {
	modelDir: string;
	threads?: number;
	device?: SpeechDevicePlan;
	files?: { encoder?: string; decoder?: string };
};

/**
 * Loads the model on the planned providers and runs `use` (spec 16 SG-003): session fallbacks are recorded; a GPU
 * error during `use` runs it once more with a CPU-only model, and when that fails too the original error is thrown.
 * Cancellation and refusals (`SpeechRefusal`) are never retried. The model is released after each attempt.
 */
export async function withDeviceFallback<T>(
	spec: ModelSpec,
	opts: Pick<RunOptions, 'onProgress' | 'onDevice' | 'signal' | 'ort' | 'onLog'>,
	use: (model: WhisperModel) => Promise<T>,
	progressAt = 0.02,
): Promise<{
	value: T;
	providers: { encoder: ProviderId; decoder: ProviderId };
	multilingual: boolean;
	calibration: WhisperModel['calibration'];
	fallbacks: SpeechFallbackOut[];
	loadMs: number;
	threads: number;
}> {
	const threads = Math.max(1, spec.threads ?? 4);
	const plan: SpeechDevicePlan = spec.device ?? { encoder: 'cpu', decoder: 'cpu' };
	const fallbacks: SpeechFallbackOut[] = [];
	let loadMs = 0;
	const attempt = async (p: SpeechDevicePlan, n: number) => {
		const tl = Date.now();
		opts.onProgress?.(progressAt, 'Loading the model');
		const model = await WhisperModel.load(spec.modelDir, {
			threads,
			encoder: p.encoder,
			decoder: p.decoder,
			calibrate: p.calibrate ?? null,
			...(opts.ort ? { ort: opts.ort } : {}),
			...(spec.files?.encoder ? { encoderFile: spec.files.encoder } : {}),
			...(spec.files?.decoder ? { decoderFile: spec.files.decoder } : {}),
		});
		loadMs += Date.now() - tl;
		try {
			for (const f of model.fallbacks)
				fallbacks.push({ stage: 'session', part: f.part, from: f.from, to: 'cpu', reason: f.reason });
			opts.onDevice?.({ ...model.providers, attempt: n });
			const value = await use(model);
			return {
				value,
				providers: model.providers,
				multilingual: model.multilingual,
				calibration: model.calibration,
			};
		} finally {
			await model.release();
		}
	};
	let result: Awaited<ReturnType<typeof attempt>>;
	const retryable = (e: unknown) =>
		!(e instanceof CancelledError || e instanceof SpeechRefusal || opts.signal?.aborted);
	const used = [plan.encoder, plan.decoder, plan.calibrate ?? 'cpu'].filter(isGpu);
	const full = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 8000);
	let n = 1;
	try {
		result = await attempt(plan, n);
	} catch (e) {
		if (!retryable(e) || !used.length) throw e;
		opts.onLog?.(`GPU attempt ${n} failed: ${full(e)}`);
		let failure: unknown = e;
		// a CUDA library failure (cuDNN, cuBLAS… — seen under GPU contention) may be transient: once more on the GPU
		let done = false;
		if (used.includes('cuda') && CUDA_STATUS.test(e instanceof Error ? e.message : String(e))) {
			n++;
			opts.onLog?.('CUDA library failure: running once more on the GPU');
			try {
				result = await attempt(plan, n);
				done = true;
			} catch (e2) {
				if (!retryable(e2)) throw e2;
				opts.onLog?.(`GPU attempt ${n} failed: ${full(e2)}`);
				failure = e2;
			}
		}
		if (!done) {
			// SG-003: a GPU error mid-job → the job once more on the CPU, else the original error
			const reason = shortReason(failure);
			const gpu = used[0] as ProviderId;
			opts.onLog?.(`running again on the CPU (${reason})`);
			try {
				result = await attempt({ encoder: 'cpu', decoder: 'cpu' }, n + 1);
			} catch (e3) {
				if (e3 instanceof CancelledError || opts.signal?.aborted) throw e3;
				throw e;
			}
			fallbacks.push({ stage: 'job', part: 'both', from: gpu, to: 'cpu', reason });
		}
	}
	return { ...result!, fallbacks, loadMs, threads };
}

/**
 * The job's audio as a streamed input (decoded once per job): in-memory samples (tests), a raw f32 file, or
 * ffmpeg. Decode progress goes to 0…`span` of the job.
 */
export async function openInput(
	spec: { input: SpeechJobSpec['input']; scratch?: string; durationSec?: number },
	nMels: number,
	opts: Pick<RunOptions, 'audio' | 'signal' | 'onSpawn' | 'onProgress'>,
	keepAudio = false,
	span = 0.02,
	/** Sample ranges to keep (`SpeechInput.samplesIn`; scoring's muted gaps). */
	keepRanges?: ReadonlyArray<readonly [number, number]>,
): Promise<SpeechInput> {
	if (opts.audio) return inputFromSamples(opts.audio, nMels);
	if ('f32' in spec.input) {
		const b = await readFile(spec.input.f32);
		return inputFromSamples(
			new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
			nMels,
		);
	}
	const expected = (spec.durationSec ?? 0) * SAMPLE_RATE;
	return decodeToInput(spec.input, nMels, {
		signal: opts.signal,
		...(spec.scratch ? { scratch: spec.scratch } : {}),
		keepAudio,
		...(keepRanges?.length ? { keepRanges } : {}),
		...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
		onSamples: (n) => {
			if (expected > 0) opts.onProgress?.(Math.min(span, (span * n) / expected), 'Decoding audio');
		},
	});
}

export async function runSpeechJob(spec: SpeechJobSpec, opts: RunOptions = {}): Promise<SpeechJobOutput> {
	const t0 = Date.now();
	opts.onProgress?.(0, 'Decoding audio');
	const cfg = WhisperModel.readConfig(spec.modelDir);
	const input = await openInput(spec, cfg.num_mel_bins, opts, !!spec.speakers?.enabled);
	try {
		return await recognise(spec, input, opts, t0);
	} finally {
		input.dispose();
	}
}

/** What extra decodes add to a result beside words: segments, removed text, time spent, glossary events. */
class ExtraDecodes {
	readonly segments: WhisperSegment[];
	readonly removed: WhisperResult['guard']['removed'];
	readonly profile: WhisperResult['profile'];
	readonly glossary: GlossaryGuard | null;
	constructor(r: WhisperResult) {
		this.segments = [...r.segments];
		this.removed = [...r.guard.removed];
		this.profile = { ...r.profile };
		this.glossary = r.guard.glossary ? { ...r.guard.glossary } : null;
	}
	add(got: WhisperResult): void {
		this.removed.push(...got.guard.removed);
		this.profile.encoderMs += got.profile.encoderMs;
		this.profile.decoderMs += got.profile.decoderMs;
		this.profile.jsMs += got.profile.jsMs;
		this.profile.decoderRuns += got.profile.decoderRuns;
		this.profile.windows += got.profile.windows;
		if (this.glossary && got.guard.glossary) {
			this.glossary.events += got.guard.glossary.events;
			this.glossary.replaced += got.guard.glossary.replaced;
		}
	}
	result(r: WhisperResult, words: WhisperWord[]): WhisperResult {
		this.segments.sort((a, b) => a.start - b.start);
		return {
			...r,
			words,
			segments: this.segments,
			guard: { ...r.guard, removed: this.removed, glossary: this.glossary },
			profile: this.profile,
		};
	}
}

/**
 * SG-011 safety net (`core/gaps.ts`): decodes again, each on its own, the spans of `mask` that hold ≥ 2 s of voice
 * but no word of `r`, within the retry budget, and merges what they yield into `r` (words and segments in time
 * order, never over an existing word). A decoder failure is thrown (the job fails or runs again on the CPU).
 */
async function recoverWordlessSpans(
	model: Pick<WhisperModel, 'transcribe'>,
	input: SpeechInput,
	r: WhisperResult,
	mask: SpeechMask,
	opts: WhisperOptions,
): Promise<{ result: WhisperResult; report: RecoveredReport | null }> {
	const { spans, skipped } = wordlessVoicedSpans(r.words, mask);
	if (!spans.length && !skipped) return { result: r, report: null };
	const report: RecoveredReport = { spans: spans.length, words: 0, skipped, ranges: [] };
	const recovered: Array<{ start: number; end: number; words: WhisperWord[] }> = [];
	const extra = new ExtraDecodes(r);
	for (const span of spans) {
		const got = await model.transcribe(input, {
			...opts,
			language: r.language,
			span: { start: span.start, end: span.end },
		});
		const start = span.start * VAD_FRAME;
		const end = Math.min(input.samples, span.end * VAD_FRAME);
		const words = got.words.filter((w) => Math.round(w.start) < end);
		recovered.push({ start, end, words });
		report.words += words.length;
		report.ranges.push({ start: start / SAMPLE_RATE, end: end / SAMPLE_RATE, words: words.length });
		extra.segments.push(...got.segments);
		extra.add(got);
	}
	return { result: extra.result(r, mergeRecoveredWords(r.words, recovered)), report };
}

/**
 * After the hidden-take pass: inside the windows whose words it replaced (`windows`, samples), voice without words
 * (≥ 2 s, `wordlessVoicedSpans`) — and inside every window it decoded (`visited`), words still stretched over voice
 * (`isStretchedWord`) — are decoded again alone, with 0.5 s of context: a re-decode can skip a take and time a
 * neighbour over it (run 4, fragment E: no words for the take at 38.14–42.15), and a rejected window that is one VAD
 * chunk gets no chunked fallback (run 5, fragment H: "rápida" stretched over 2.2 s of speech in both modes). A
 * stretch's words replace it when `redecodeAccepted` takes them; a wordless span takes the words decoded there. At most
 * `GAP_MAX_SPANS` decodes. A decoder failure is thrown.
 */
async function recoverReplaced(
	model: Pick<WhisperModel, 'transcribe'>,
	input: SpeechInput,
	r: WhisperResult,
	mask: SpeechMask,
	opts: WhisperOptions,
	windows: ReadonlyArray<{ start: number; end: number }>,
	visited: ReadonlyArray<{ start: number; end: number }> = windows,
): Promise<{ result: WhisperResult; report: RecoveredReport | null }> {
	const over = (ws: typeof windows, a: number, b: number) => ws.some((w) => a < w.end && b > w.start);
	const pad = REDECODE_EDGE_GUARD_FRAMES;
	// `quiet`: a stretch in a window whose words were not replaced — reported only when its decode places words
	const targets: Array<{ span: Chunk; region: { start: number; end: number }; quiet?: boolean }> = [];
	for (const sp of wordlessVoicedSpans(r.words, mask).spans)
		if (over(windows, sp.start * VAD_FRAME, sp.end * VAD_FRAME))
			targets.push({ span: sp, region: { start: sp.start * VAD_FRAME, end: sp.end * VAD_FRAME } });
	for (const w of r.words)
		if (over(visited, w.start, w.end) && isStretchedWord(w, mask))
			targets.push({
				span: {
					start: Math.max(0, Math.floor(w.start / VAD_FRAME) - pad),
					end: Math.min(mask.length, Math.ceil(w.end / VAD_FRAME) + pad),
				},
				region: { start: w.start, end: w.end },
				quiet: !over(windows, w.start, w.end),
			});
	if (!targets.length) return { result: r, report: null };
	targets.sort((a, b) => a.region.start - b.region.start);
	const report: RecoveredReport = { spans: 0, words: 0, skipped: 0, ranges: [] };
	const extra = new ExtraDecodes(r);
	let words = r.words;
	const mid = (x: { start: number; end: number }) => (x.start + x.end) / 2;
	for (const [k, t] of targets.entries()) {
		if (k >= GAP_MAX_SPANS) {
			report.skipped++;
			continue;
		}
		const got = await model.transcribe(input, { ...opts, language: r.language, span: t.span });
		extra.add(got);
		const inside = (w: { start: number; end: number }) => mid(w) >= t.region.start && mid(w) < t.region.end;
		const before = words.filter(inside);
		const after = got.words.filter(inside);
		const placed = before.length
			? redecodeAccepted(before, after, mask, MIN_VOICED_FRACTION)
			: after.length
				? after
				: null;
		if (t.quiet && !placed) continue;
		report.spans++;
		report.ranges.push({
			start: t.region.start / SAMPLE_RATE,
			end: t.region.end / SAMPLE_RATE,
			words: placed ? placed.length : 0,
		});
		if (!placed) continue;
		words = replaceWindowWords(words, t.region.start, t.region.end, placed);
		report.words += placed.length - before.length;
		extra.segments.push(
			...got.segments.filter((sg) => inside({ start: sg.start * SAMPLE_RATE, end: sg.end * SAMPLE_RATE })),
		);
	}
	return { result: extra.result(r, words), report: report.spans || report.skipped ? report : null };
}

/** Both safety-net passes in one report (null when neither decoded anything). */
function mergeRecovered(a: RecoveredReport | null, b: RecoveredReport | null): RecoveredReport | null {
	if (!a || !b) return a ?? b;
	return {
		spans: a.spans + b.spans,
		words: a.words + b.words,
		skipped: a.skipped + b.skipped,
		// the job result lists at most `GAP_MAX_SPANS` ranges (each pass decodes at most that many)
		ranges: [...a.ranges, ...b.ranges].sort((x, y) => x.start - y.start).slice(0, GAP_MAX_SPANS),
	};
}

/**
 * Hidden takes (`core/gaps.ts`, docs/wp-notes/speech.md §11.3 "Hidden takes"): decodes again, each alone, the windows around
 * stretched words, short wordless voice, garbled words (another writing system than `r.language`) and words holding
 * a dip and a new onset (a restart inside the word) of `r` —
 * verbatim, without the previous text — and replaces a window's words when the re-decode holds more words consistent
 * with the audio and re-says the original ones (`redecodeAccepted`; original words it wrote nothing over stay, garbage
 * never does); the window's segments are replaced with it. A
 * rejected window over several of the whole file's VAD chunks is decoded once more the `chunking: "vad"` way over
 * those chunks (both passes, merged, the job's options; within `REDECODE_CHUNKED_MAX_FRAMES` of audio per job),
 * judged by the same rule. A decoder failure is thrown.
 */
async function redecodeSuspects(
	model: Pick<WhisperModel, 'transcribe'>,
	input: SpeechInput,
	r: WhisperResult,
	mask: SpeechMask,
	opts: WhisperOptions,
): Promise<{ result: WhisperResult; report: RedecodedReport | null }> {
	// a restart inside a word is a dip in the frame levels (the energy VAD's 10 ms RMS)
	const { windows, skipped } = suspectWindows(r.words, mask, r.language, input.db);
	if (!windows.length && !skipped) return { result: r, report: null };
	const report: RedecodedReport = {
		windows: windows.length,
		replaced: 0,
		wordsAdded: 0,
		skipped,
		ranges: [],
	};
	const extra = new ExtraDecodes(r);
	let words = r.words;
	let chunkedFrames = 0;
	const mid = (x: { start: number; end: number }) => (x.start + x.end) / 2;
	const redecodeOpts: WhisperOptions = {
		...opts,
		language: r.language,
		verbatim: true,
		conditionOnPreviousText: false,
	};
	// the fallback decodes what `chunking: "vad"` decodes there: its chunks of the whole file (energy VAD), with the
	// job's options — fragment E: chunks planned inside the window on the voice analysis, decoded verbatim, wrote 31
	// words where the whole-file chunking wrote 80
	let fileChunks: Chunk[] | null = null;
	for (const win of windows) {
		let got = await model.transcribe(input, { ...redecodeOpts, span: { start: win.start, end: win.end } });
		extra.add(got);
		const { start, end } = replaceRegion(words, win, input.samples);
		const inside = (w: { start: number; end: number }) => mid(w) >= start && mid(w) < end;
		const before = words.filter(inside);
		let after = got.words.filter(inside);
		let placed = redecodeAccepted(before, after, mask, MIN_VOICED_FRACTION, r.language);
		let chunked: boolean | undefined;
		if (!placed) {
			fileChunks ??= vadChunks(input.mask);
			const over = fileChunks.filter((c) => c.end > win.start && c.start < win.end);
			const range = over.length ? { start: over[0]!.start, end: over[over.length - 1]!.end } : null;
			// both passes decode the range once each
			const cost = range ? 2 * (range.end - range.start) : 0;
			if (range && over.length > 1 && chunkedFrames + cost <= REDECODE_CHUNKED_MAX_FRAMES) {
				chunkedFrames += cost;
				const c = await transcribeChunked(
					model,
					input,
					input.mask,
					{ ...opts, language: r.language, conditionOnPreviousText: false },
					() => {},
					range,
				);
				got = c.result;
				extra.add(got);
				after = got.words.filter(inside);
				placed = redecodeAccepted(before, after, mask, MIN_VOICED_FRACTION, r.language);
				chunked = !!placed;
			}
		}
		const replaced = !!placed;
		if (placed) {
			words = replaceWindowWords(words, start, end, placed);
			const segIn = (sg: WhisperSegment) => {
				const m = ((sg.start + sg.end) / 2) * SAMPLE_RATE;
				return m >= start && m < end;
			};
			const keptSegs = extra.segments.filter((sg) => !segIn(sg));
			extra.segments.length = 0;
			extra.segments.push(...keptSegs, ...got.segments.filter(segIn));
			report.replaced++;
			report.wordsAdded += placed.length - before.length;
			after = placed;
		}
		report.ranges.push({
			start: start / SAMPLE_RATE,
			end: end / SAMPLE_RATE,
			before: before.length,
			after: after.length,
			replaced,
			...(chunked !== undefined ? { chunked } : {}),
		});
	}
	return { result: extra.result(r, words), report };
}

/**
 * `chunking: "vad"` (`core/chunks.ts`): decodes the chunks of `mask` (within `range`, frames; default all) each alone
 * without the previous text (the language detected on the first chunk when not given), then the shifted chunks, and
 * takes the shifted pass's words in each merge zone where it has at least as many (with its segments there).
 * Progress `onProgress(0…1)`.
 */
async function transcribeChunked(
	model: Pick<WhisperModel, 'transcribe'>,
	input: SpeechInput,
	mask: SpeechMask,
	opts: WhisperOptions,
	onProgress: (f: number) => void,
	range?: Chunk,
): Promise<{ result: WhisperResult; report: ChunkedReport }> {
	const first = vadChunks(mask, range);
	const shifted = shiftedChunks(mask, first, range);
	const total = first.length + shifted.length;
	let language = opts.language ?? null;
	const results: WhisperResult[] = [];
	const pass = async (chunks: readonly Chunk[]) => {
		const words: WhisperWord[] = [];
		const segments: WhisperSegment[] = [];
		for (const c of chunks) {
			const got = await model.transcribe(input, {
				...opts,
				language,
				conditionOnPreviousText: false,
				span: { start: c.start, end: c.end },
			});
			language = got.language;
			results.push(got);
			words.push(...got.words);
			segments.push(...got.segments);
			onProgress(results.length / Math.max(1, total));
		}
		return { words, segments };
	};
	const a = await pass(first);
	const b = await pass(shifted);
	const report: ChunkedReport = {
		chunks: first.length,
		shiftedChunks: shifted.length,
		zones: 0,
		replaced: 0,
	};
	let words = a.words;
	let segments = a.segments;
	for (const z of mergeZones(first, shifted)) {
		report.zones++;
		const start = z.start * VAD_FRAME;
		const end = Math.min(input.samples, z.end * VAD_FRAME);
		const inZone = (x: { start: number; end: number }) =>
			(x.start + x.end) / 2 >= start && (x.start + x.end) / 2 < end;
		const fromA = words.filter(inZone).length;
		const fromB = b.words.filter(inZone);
		if (!fromB.length || fromB.length < fromA) continue;
		words = replaceWindowWords(words, start, end, fromB);
		const segIn = (sg: WhisperSegment) =>
			inZone({ start: sg.start * SAMPLE_RATE, end: sg.end * SAMPLE_RATE });
		segments = [...segments.filter((sg) => !segIn(sg)), ...b.segments.filter(segIn)];
		report.replaced++;
	}
	// the first chunk's language and its probability; time, removed text and guards of every chunk
	const r: WhisperResult = {
		language: results[0]?.language ?? language ?? 'en',
		languageProbability: results[0]?.languageProbability ?? null,
		words: [],
		segments: [],
		guard: {
			skippedWindows: results.reduce((n, x) => n + x.guard.skippedWindows, 0),
			removed: [],
			glossary: results[0]?.guard.glossary ? { ...results[0].guard.glossary, events: 0, replaced: 0 } : null,
		},
		profile: { encoderMs: 0, decoderMs: 0, jsMs: 0, decoderRuns: 0, windows: 0 },
	};
	const acc = new ExtraDecodes(r);
	for (const x of results) acc.add(x);
	acc.segments.push(...segments);
	return { result: acc.result(r, words), report };
}

async function recognise(
	spec: SpeechJobSpec,
	input: SpeechInput,
	opts: RunOptions,
	t0: number,
): Promise<SpeechJobOutput> {
	const t1 = Date.now();
	const options: WhisperOptions = {
		language: spec.language ?? null,
		task: spec.task ?? 'transcribe',
		beamSize: spec.beamSize ?? 1,
		...(spec.verbatim ? { verbatim: true } : {}),
		...(spec.initialPrompt ? { initialPrompt: spec.initialPrompt } : {}),
		...(spec.glossary?.length ? { glossary: spec.glossary } : {}),
		...(spec.conditionOnPreviousText === false ? { conditionOnPreviousText: false } : {}),
		signal: opts.signal,
	};
	const ran = await withDeviceFallback(spec, opts, async (model) => {
		let chunked: ChunkedReport | null = null;
		let first: WhisperResult;
		if (spec.chunking === 'vad') {
			// chunks split at the energy VAD's pauses (the voice analysis may not exist yet)
			const c = await transcribeChunked(model, input, input.mask, options, (f) =>
				opts.onProgress?.(0.03 + f * 0.92, `Transcribing ${Math.round(f * 100)}%`),
			);
			first = c.result;
			chunked = c.report;
		} else
			first = await model.transcribe(input, {
				...options,
				onProgress: (f, stage) => {
					opts.onProgress?.(0.03 + f * 0.92, stage);
					return true;
				},
			});
		const va = spec.voiceAnalysis ? await voiceAnalysisMask(spec.voiceAnalysis, input.db.length) : null;
		opts.onProgress?.(0.95, 'Checking for missed speech');
		// the voice analysis' speech class tells voice from music and noise; else the energy VAD
		const mask = va?.speech ?? input.mask;
		const again = await recoverWordlessSpans(model, input, first, mask, options);
		if (spec.redecode === false) return { ...again, redecoded: null, chunked, va };
		opts.onProgress?.(0.955, 'Checking for hidden takes');
		const hidden = await redecodeSuspects(model, input, again.result, mask, options);
		// a replaced window can leave voice without words where the original had a stretched word over it (run 4,
		// fragment E: the take at 38.14–42.15), and any window a word still stretched over voice: those are decoded
		// alone too, like the first safety net
		const ranges = (hidden.report?.ranges ?? []).map((x) => ({
			start: x.start * SAMPLE_RATE,
			end: x.end * SAMPLE_RATE,
			replaced: x.replaced,
		}));
		const after = ranges.length
			? await recoverReplaced(
					model,
					input,
					hidden.result,
					mask,
					options,
					ranges.filter((x) => x.replaced),
					ranges,
				)
			: { result: hidden.result, report: null };
		return {
			result: after.result,
			report: mergeRecovered(again.report, after.report),
			redecoded: hidden.report,
			chunked,
			va,
		};
	});
	const { result: r, report: recovered, redecoded, chunked, va: vaMask } = ran.value;
	const { threads, fallbacks, loadMs } = ran;
	const model = { providers: ran.providers, multilingual: ran.multilingual, calibration: ran.calibration };
	const refined = refineWords(
		// bounds snap to the energy VAD (measured on the LJ fixture: boundary error max 40 ms vs 280 ms with the
		// voice analysis' speech class, and diarisation unchanged); what keeps a word is speech or breath in the voice
		// analysis, which tells noise and music from voice
		vaMask ? { samples: input.samples, db: input.db, mask: input.mask, presence: vaMask.presence } : input,
		r.words.map((w) => ({ ...w })),
	);
	const words = refined.words;
	let labels: number[] | null = null;
	let speakers = 0;
	if (spec.speakers?.enabled && words.length) {
		opts.onProgress?.(0.96, 'Labelling speakers');
		const d = diarize(await input.audio(), words, {
			...DEFAULT_DIARIZE,
			maxSpeakers: spec.speakers.max ?? DEFAULT_DIARIZE.maxSpeakers,
			...(spec.speakers.count ? { speakerCount: spec.speakers.count } : {}),
		});
		labels = d.labels;
		speakers = d.speakers;
	}
	opts.onProgress?.(1, 'Done');
	const removed = [...r.guard.removed, ...refined.removed].slice(0, 200);
	return {
		modelId: spec.modelId,
		language: r.language,
		languageProbability: r.languageProbability,
		task: spec.task === 'translate' && model.multilingual ? 'translate' : 'transcribe',
		samples: input.samples,
		speakers,
		words: words.map((w, i) => ({
			text: w.text,
			start: w.start,
			end: w.end,
			confidence: Math.round(w.probability * 1000) / 1000,
			speaker: labels ? (labels[i] ?? 0) : null,
		})),
		segments: r.segments,
		timings: { decodeMs: t1 - t0, loadMs, transcribeMs: Date.now() - t1 - loadMs },
		device: { ...model.providers, threads, fallbacks },
		calibration: model.calibration,
		guard: {
			skippedWindows: r.guard.skippedWindows,
			droppedWords: refined.dropped,
			removed,
			frames: vaMask ? 'voice-analysis' : 'energy',
			...(r.guard.glossary ? { glossary: r.guard.glossary } : {}),
			...(recovered ? { recovered } : {}),
			...(redecoded ? { redecoded } : {}),
			...(chunked ? { chunked } : {}),
		},
		profile: r.profile,
	};
}
