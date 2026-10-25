// One transcription, in-process: decode (streamed) → Whisper → word-bound repair (pauses, voice) → hallucination
// guards → VAD tightening → speakers. Used by the `jasper-speech` child process (cli.ts) and by tests.
//
// Execution providers (spec 16 SG-002/SG-003): the job spec says which provider each model part uses (the engine
// chose it from the cached probe). A part whose GPU session cannot be created runs on the CPU (recorded); when the
// GPU fails during recognition the job runs once more entirely on the CPU, and fails with the original error when
// that fails too.
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { decodeVoiceAnalysis, VOICE_ANALYSIS_VERSION, VOICE_CLASSES } from '@jasper/project';
import type { ProviderId } from '../../tools/ort.ts';
import { DEFAULT_DIARIZE, diarize } from '../core/diarize.ts';
import { knownPhraseRuns, phraseOverNonSpeech } from '../core/hallucination.ts';
import { SAMPLE_RATE } from '../core/mel.ts';
import {
	extendWordsIntoSpeech,
	frameDb,
	type SpeechMask,
	splitAtPauses,
	tightenWords,
	unvoicedWords,
	VAD_FRAME,
	vadThreshold,
	voicedFraction,
	voicedMask,
} from '../core/vad.ts';
import { CancelledError, decodeToInput, inputFromSamples, type SpeechInput } from './audio.ts';
import { type LoadOptions, WhisperModel, type WhisperResult, type WhisperSegment } from './whisper.ts';

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
	calibration: { provider: ProviderId; cpuMsPerToken: number; gpuMsPerToken: number; decoder: ProviderId } | null;
	guard: {
		skippedWindows: number;
		droppedWords: number;
		removed: Array<{ text: string; start: number; end: number; reason: string }>;
		/** Which speech frames refined the word bounds (TC-004). */
		frames: 'voice-analysis' | 'energy';
	};
	profile: WhisperResult['profile'];
};

/**
 * TC-004: speech/breath frames of the voice analysis as a mask over our 10 ms frames (frame k = samples
 * [160 k, 160 (k + 1)) in both), or null when the file is missing, invalid or of another decode length.
 */
export async function voiceAnalysisMask(
	va: NonNullable<SpeechJobSpec['voiceAnalysis']>,
	frames: number,
): Promise<Uint8Array | null> {
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
	const mask = new Uint8Array(frames);
	const cls = r.analysis.classes;
	for (let f = 0; f < frames && f < cls.length; f++) mask[f] = cls[f] !== VOICE_CLASSES.silence ? 1 : 0;
	return mask;
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
		const child = spawn(input.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

/** What word-bound refinement reads of the audio. */
export type FrameSource = { samples: number; db: Float32Array; mask: SpeechMask };

type RefinableWord = { start: number; end: number; text?: string };

/**
 * Word-bound refinement after alignment (spec 14 TC-004, spec 16 SG-011; see core/vad.ts): repair at pauses
 * (never moving a word across a silence), grow into voice, drop words lying in silence (< 20 % speech frames) and
 * known hallucination phrases over non-speech, tighten over silence. Returns the kept words (a new array; the kept
 * word objects are the same) and what was removed.
 */
export function refineWords<W extends RefinableWord>(
	src: FrameSource,
	words: W[],
): { words: W[]; dropped: number; removed: Array<{ text: string; start: number; end: number; reason: string }> } {
	const { samples, db, mask } = src;
	const len = { length: samples };
	const orphans = new Set(splitAtPauses(len, words, db, mask));
	extendWordsIntoSpeech(len, words, db, 25, mask);
	const drop = new Set<number>([...orphans, ...unvoicedWords(words, mask)]);
	const removed: Array<{ text: string; start: number; end: number; reason: string }> = [];
	// known hallucination phrases over non-speech (TC-003), judged over the whole phrase
	for (const [a, b] of knownPhraseRuns(words.map((w) => ({ text: w.text ?? '' })))) {
		const span = words.slice(a, b);
		let voiced = 0;
		let total = 0;
		for (const w of span) {
			const frames = Math.max(1, Math.ceil((w.end - w.start) / VAD_FRAME));
			voiced += voicedFraction(w, mask) * frames;
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

/** Word-bound refinement of an in-memory clip, in place (the benchmark harness and older callers). */
export function refineWordBounds(audio: Float32Array, words: Array<{ start: number; end: number; text?: string }>): void {
	const db = frameDb(audio);
	const kept = refineWords({ samples: audio.length, db, mask: voicedMask(db, vadThreshold(db)) }, words).words;
	words.splice(0, words.length, ...kept);
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
};

const isGpu = (p: ProviderId) => p !== 'cpu';

export async function runSpeechJob(spec: SpeechJobSpec, opts: RunOptions = {}): Promise<SpeechJobOutput> {
	const t0 = Date.now();
	opts.onProgress?.(0, 'Decoding audio');
	const cfg = WhisperModel.readConfig(spec.modelDir);
	const keepAudio = !!spec.speakers?.enabled;
	let input: SpeechInput;
	if (opts.audio) input = inputFromSamples(opts.audio, cfg.num_mel_bins);
	else if ('f32' in spec.input) {
		const b = await readFile(spec.input.f32);
		input = inputFromSamples(
			new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
			cfg.num_mel_bins,
		);
	} else {
		const expected = (spec.durationSec ?? 0) * SAMPLE_RATE;
		input = await decodeToInput(spec.input, cfg.num_mel_bins, {
			signal: opts.signal,
			...(spec.scratch ? { scratch: spec.scratch } : {}),
			keepAudio,
			...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
			onSamples: (n) => {
				if (expected > 0) opts.onProgress?.(Math.min(0.02, (0.02 * n) / expected), 'Decoding audio');
			},
		});
	}
	try {
		return await recognise(spec, input, opts, t0);
	} finally {
		input.dispose();
	}
}

async function recognise(
	spec: SpeechJobSpec,
	input: SpeechInput,
	opts: RunOptions,
	t0: number,
): Promise<SpeechJobOutput> {
	const t1 = Date.now();
	const threads = Math.max(1, spec.threads ?? 4);
	const plan: SpeechDevicePlan = spec.device ?? { encoder: 'cpu', decoder: 'cpu' };
	const fallbacks: SpeechFallbackOut[] = [];
	let loadMs = 0;
	const attempt = async (p: SpeechDevicePlan, n: number) => {
		const tl = Date.now();
		opts.onProgress?.(0.02, 'Loading the model');
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
			const r = await model.transcribe(input, {
				language: spec.language ?? null,
				task: spec.task ?? 'transcribe',
				beamSize: spec.beamSize ?? 1,
				...(spec.verbatim ? { verbatim: true } : {}),
				...(spec.initialPrompt ? { initialPrompt: spec.initialPrompt } : {}),
				...(spec.conditionOnPreviousText === false ? { conditionOnPreviousText: false } : {}),
				signal: opts.signal,
				onProgress: (f, stage) => {
					opts.onProgress?.(0.03 + f * 0.92, stage);
					return true;
				},
			});
			return { r, model: { providers: model.providers, multilingual: model.multilingual, calibration: model.calibration } };
		} finally {
			await model.release();
		}
	};
	let result: Awaited<ReturnType<typeof attempt>>;
	try {
		result = await attempt(plan, 1);
	} catch (e) {
		if (e instanceof CancelledError || opts.signal?.aborted) throw e;
		const used = [plan.encoder, plan.decoder, plan.calibrate ?? 'cpu'].filter(isGpu);
		if (!used.length) throw e;
		// SG-003: a GPU error mid-job → the job once more on the CPU, else the original error
		const reason = e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e);
		const gpu = used[0] as ProviderId;
		try {
			result = await attempt({ encoder: 'cpu', decoder: 'cpu' }, 2);
		} catch (e2) {
			if (e2 instanceof CancelledError || opts.signal?.aborted) throw e2;
			throw e;
		}
		fallbacks.push({ stage: 'job', part: 'both', from: gpu, to: 'cpu', reason });
	}
	const { r, model } = result;
	const vaMask = spec.voiceAnalysis ? await voiceAnalysisMask(spec.voiceAnalysis, input.db.length) : null;
	const refined = refineWords(
		vaMask ? { samples: input.samples, db: input.db, mask: vaMask } : input,
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
		},
		profile: r.profile,
	};
}

