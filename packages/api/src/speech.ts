// Word times are flicks (705,600,000 per second).
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

/** ONNX Runtime execution providers the speech worker can use (spec 16 SG-001). */
export const SpeechProviderIdSchema = z.enum(['cpu', 'cuda', 'webgpu', 'dml', 'coreml']);
export type SpeechProviderId = z.infer<typeof SpeechProviderIdSchema>;

/** Where a model part runs (SG-030 "Runs on: <device> (<provider>) · N threads"). */
export const SpeechRunsOnSchema = z.object({
	encoder: SpeechProviderIdSchema,
	decoder: SpeechProviderIdSchema,
	/** Human label of the device, e.g. "NVIDIA GeForce RTX 3060 (CUDA)" or "CPU". */
	device: z.string(),
	threads: z.number().int().min(1),
});
export type SpeechRunsOn = z.infer<typeof SpeechRunsOnSchema>;

/** Speed of a model on this computer: minutes of processing per 10 minutes of audio. */
export const SpeechSpeedSchema = z.object({
	minutesPer10Min: z.number().min(0),
	/** `measured` = the last job with this model and device; `estimated` = from the reference table (wp-note). */
	basis: z.enum(['measured', 'estimated']),
	/** Measured: when (ISO 8601). */
	at: z.string().optional(),
	accuracy: z.enum(['standard', 'best']),
});
export type SpeechSpeed = z.infer<typeof SpeechSpeedSchema>;

/** A speech model of the catalogue (`GET /api/speech/models`). */
export const SpeechModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** Millions of parameters. */
	parameters: z.number(),
	/** Recognises 99 languages (detects the language, translates to English); `.en` models are English only. */
	multilingual: z.boolean(),
	/** The engine's default model (follows the recommendation for this computer, SG-021). */
	default: z.boolean(),
	description: z.string(),
	license: z.string(),
	licenseUrl: z.string(),
	attribution: z.string(),
	sourceUrl: z.string(),
	/** Pinned Hugging Face revision of every file. */
	revision: z.string(),
	sizeBytes: z.number().int().min(0),
	installed: z.boolean(),
	/** Bytes still to download (files already present are kept). */
	missingBytes: z.number().int().min(0),
	/** Weight precision; fp16 models are meant for GPUs (2–4× slower on a CPU). */
	precision: z.enum(['fp32', 'fp16']).optional(),
	/** Number of languages (1 for English-only models). */
	languages: z.number().int().min(1).optional(),
	/** "Recommended for this computer" (SG-021). */
	recommended: z.boolean().optional(),
	/** Where it would run with the current Processor setting (SG-030). */
	runsOn: SpeechRunsOnSchema.optional(),
	speed: SpeechSpeedSchema.optional(),
});
export type SpeechModel = z.infer<typeof SpeechModelSchema>;
export const SpeechModelsResponseSchema = z.object({ models: z.array(SpeechModelSchema) });
export const SpeechModelDeleteResponseSchema = z.object({
	modelId: z.string(),
	freedBytes: z.number().int().min(0),
});

/** Options shared by every transcription request. */
export const TranscribeOptionsSchema = z.object({
	/** Catalogue id (default: the catalogue default, `whisper-base`). */
	model: z.string().optional(),
	/** ISO 639-1 code, or `auto` (default) = detect from the first 30 s. English-only models always use `en`. */
	language: z.string().optional(),
	/** `translate` = English text of speech in another language (multilingual models). */
	task: z.enum(['transcribe', 'translate']).optional(),
	/** Label speakers (MFCC clustering). */
	speakerLabels: z.boolean().optional(),
	/** Exactly this many speakers (a hint for speaker labelling). */
	speakerCount: z.number().int().min(1).max(32).optional(),
	/** At most this many speakers (default 6). */
	maxSpeakers: z.number().int().min(1).max(32).optional(),
	/**
	 * Beam search width; overrides `accuracy` (1 = greedy). Default from `accuracy`: standard = greedy with
	 * temperature fallback, best = beam 5.
	 */
	beamSize: z.number().int().min(1).max(10).optional(),
	/** `standard` (greedy, default) or `best` (beam 5, slower) — SG-010. Default: the Transcription preference. */
	accuracy: z.enum(['standard', 'best']).optional(),
	/** Processor: `auto` (default: the Transcription preference), `cpu` or `gpu` (falls back to the CPU with a reason). */
	device: z.enum(['auto', 'cpu', 'gpu']).optional(),
	/**
	 * Verbatim transcription (spec 14 TC-003): prompt the model with the language's filler words so it keeps
	 * "eh", "em", "um"… instead of cleaning them up.
	 */
	verbatim: z.boolean().optional(),
	/** A custom initial prompt (vocabulary, names, style); with `verbatim` it follows the filler prompt. */
	initialPrompt: z.string().max(1000).optional(),
	/** Condition each 30 s window on the previous window's text (default true; OpenAI `condition_on_previous_text`). */
	conditionOnPreviousText: z.boolean().optional(),
	/**
	 * Hidden takes (default true): after recognition, the windows around stretched words (> 1 s over continuous
	 * speech) and short wordless voice (≥ 0.35 s) are decoded again alone — verbatim, without the previous text — and
	 * their words replaced when the re-decode writes more words that re-say the original ones (a restart Whisper wrote
	 * once). `false` turns the pass off. Part of the transcription's dedupe key.
	 */
	redecode: z.boolean().optional(),
	/**
	 * `vad`: decode chunks of 3–10 s split at short pauses (≥ 100 ms), each on its own without the previous text, a
	 * second time with boundaries at other pauses, and merge the passes around the first pass's boundaries — writes
	 * restarts and retakes that 30 s windows write once. About twice the decoding time. Default: 30 s windows.
	 * Part of the transcription's dedupe key.
	 */
	chunking: z.enum(['vad']).optional(),
	/**
	 * Spec 17 SC-074: names and terms (script spelling, most frequent first) carried into every window's prompt after
	 * the verbatim / initial prompt, within the 223-token prompt cap (terms that do not fit are left out). A term
	 * repeated ≥ 3 times within 10 s makes that window decode again without the glossary (SC-075). Part of the
	 * transcription's dedupe key.
	 */
	glossary: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
});
export type TranscribeOptions = z.infer<typeof TranscribeOptionsSchema>;

/** `POST /api/media/:key/transcribe`. */
export const TranscribeMediaRequestSchema = TranscribeOptionsSchema.extend({
	projectId: z.string().optional(),
	/** Absolute ffmpeg stream index of the audio stream (default: the first audio stream). */
	streamIndex: z.number().int().min(0).optional(),
});
export type TranscribeMediaRequest = z.infer<typeof TranscribeMediaRequestSchema>;

/** `POST /api/speech/transcribe-sequence`: transcribe the mixed audio of a sequence (or its In/Out range). */
export const TranscribeSequenceRequestSchema = TranscribeOptionsSchema.extend({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	projectId: z.string().optional(),
	/** `entire` (default) or the sequence In/Out. */
	range: z.enum(['entire', 'in-out']).optional(),
});
export type TranscribeSequenceRequest = z.infer<typeof TranscribeSequenceRequestSchema>;

export const TranscriptResultWordSchema = z.object({
	text: z.string(),
	/** Flicks: media content time (media jobs) or sequence time (sequence jobs). */
	start: z.number().int().min(0),
	end: z.number().int().min(0),
	confidence: z.number().min(0).max(1),
	/** Speaker key (`S1`, `S2`…) when speakers were labelled, else null. */
	speaker: z.string().nullable(),
});
export type TranscriptResultWord = z.infer<typeof TranscriptResultWordSchema>;

export const TranscriptResultSegmentSchema = z.object({
	start: z.number(),
	end: z.number(),
	text: z.string(),
	/** Mean log-probability of the window's tokens. */
	avgLogprob: z.number().optional(),
	/** Probability of `<|nospeech|>` for the window. */
	noSpeechProb: z.number().optional(),
	/** gzip compression ratio of the window's text (> 2.4 = a loop). */
	compressionRatio: z.number().optional(),
	/** Temperature of the decode that was kept. */
	temperature: z.number().optional(),
});

export const SpeechFallbackSchema = z.object({
	/** `session`: a model part could not be created on the GPU; `job`: the GPU failed mid-job and the job ran again on the CPU; `unavailable`: no usable GPU. */
	stage: z.enum(['session', 'job', 'unavailable']),
	part: z.enum(['encoder', 'decoder', 'both']),
	from: SpeechProviderIdSchema,
	to: SpeechProviderIdSchema,
	reason: z.string(),
});
export type SpeechFallback = z.infer<typeof SpeechFallbackSchema>;

export const SpeechDeviceReportSchema = z.object({
	encoder: SpeechProviderIdSchema,
	decoder: SpeechProviderIdSchema,
	/** e.g. "NVIDIA GeForce RTX 3060 (CUDA) encoder · CPU decoder". */
	label: z.string(),
	threads: z.number().int().min(1),
	fallbacks: z.array(SpeechFallbackSchema),
});
export type SpeechDeviceReport = z.infer<typeof SpeechDeviceReportSchema>;

export const SpeechGuardReportSchema = z.object({
	/** 30 s windows skipped because no frame was voiced. */
	skippedWindows: z.number().int().min(0),
	/** Words dropped because they lay in silence (< 20 % voiced frames, or in a pause with no voice nearby). */
	droppedWords: z.number().int().min(0),
	/** Known hallucination phrases removed over non-speech, and runs of ≥ 4 identical tokens. */
	removed: z
		.array(z.object({ text: z.string(), start: z.number(), end: z.number(), reason: z.string() }))
		.max(200),
	/** Speech frames the word bounds were refined against (spec 14 TC-004): the voice analysis, or the energy VAD. */
	frames: z.enum(['voice-analysis', 'energy']).optional(),
	/**
	 * Spec 17 SC-074/SC-075, when a glossary was given: terms carried (those that fit the prompt), their prompt tokens,
	 * windows where a carried term repeated ≥ 3 times within 10 s (decoded again without the glossary) and windows
	 * whose unprompted text was kept because it differed.
	 */
	glossary: z
		.object({
			terms: z.number().int().min(0),
			tokens: z.number().int().min(0),
			events: z.number().int().min(0),
			replaced: z.number().int().min(0),
		})
		.optional(),
	/**
	 * Spans with ≥ 2 s of voice but no word after recognition, decoded again on their own (at most 32 spans and
	 * 10 min per job, in time order): spans decoded, words they yielded (before the silence guards), spans over the
	 * budget, and each decoded span (seconds) with its words. Absent when there was none.
	 */
	recovered: z
		.object({
			spans: z.number().int().min(0),
			words: z.number().int().min(0),
			skipped: z.number().int().min(0),
			ranges: z
				.array(z.object({ start: z.number(), end: z.number(), words: z.number().int().min(0) }))
				.max(32),
		})
		.optional(),
	/** `chunking: "vad"`: chunks of the first and the shifted pass, merge zones, zones that took the shifted words. */
	chunked: z
		.object({
			chunks: z.number().int().min(0),
			shiftedChunks: z.number().int().min(0),
			zones: z.number().int().min(0),
			replaced: z.number().int().min(0),
		})
		.optional(),
	/**
	 * Hidden takes (`redecode`): windows around stretched words and short wordless voice decoded again alone (at most
	 * 96 windows and 10 min per job, in time order): windows decoded, windows whose words were replaced, words that
	 * added, windows over the budget, and each window (seconds) with its word counts before and after. `chunked`:
	 * present when the window's re-decode was rejected and the window was decoded again in VAD chunks (`after` counts
	 * those words), true when they replaced its words. Absent when there was none or the pass was off.
	 */
	redecoded: z
		.object({
			windows: z.number().int().min(0),
			replaced: z.number().int().min(0),
			wordsAdded: z.number().int(),
			skipped: z.number().int().min(0),
			ranges: z
				.array(
					z.object({
						start: z.number(),
						end: z.number(),
						before: z.number().int().min(0),
						after: z.number().int().min(0),
						replaced: z.boolean(),
						chunked: z.boolean().optional(),
					}),
				)
				.max(96),
		})
		.optional(),
});
export type SpeechGuardReport = z.infer<typeof SpeechGuardReportSchema>;

/** `EngineJob.result` of a `transcription` job. */
export const TranscriptionResultSchema = z.object({
	target: z.discriminatedUnion('type', [
		z.object({ type: z.literal('media'), mediaKey: z.string(), streamIndex: z.number().int().nullable() }),
		z.object({
			type: z.literal('sequence'),
			sequenceId: z.string(),
			/** Sequence frames transcribed. */
			range: z.object({ startFrame: z.number().int(), endFrame: z.number().int() }),
			/** `mixFingerprint` of the sequence when it was mixed. */
			mixHash: z.string(),
		}),
	]),
	model: z.string(),
	language: z.string(),
	/** Probability of the detected language (null when the language was given). */
	languageProbability: z.number().nullable(),
	task: z.enum(['transcribe', 'translate']),
	/** Audio length transcribed (flicks). */
	duration: z.number().int().min(0),
	words: z.array(TranscriptResultWordSchema),
	speakers: z.record(z.string(), z.object({ name: z.string() })),
	/** Seconds (media/sequence time) and the decoder's scores per segment (spec 14 TC-003). */
	segments: z.array(TranscriptResultSegmentSchema),
	/** Milliseconds of processing (decode, model load, recognition). */
	timings: z.object({
		decodeMs: z.number(),
		loadMs: z.number(),
		transcribeMs: z.number(),
		/** Recognition time / audio duration. */
		rtf: z.number().optional(),
	}),
	/** Where the model ran and any fallback (SG-003). */
	device: SpeechDeviceReportSchema.optional(),
	/** What the hallucination guard removed (SG-011). */
	guard: SpeechGuardReportSchema.optional(),
	accuracy: z.enum(['standard', 'best']).optional(),
	beamSize: z.number().int().optional(),
});
export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;

/**
 * Spec 17 SC-092: teacher-forced scoring of alternative readings of the same audio (engine-internal,
 * `SpeechService.score`; the `transcript-fix` job uses it). Times are media flicks (the media's content time from 0).
 */
export const SpeechScoreRequestSchema = z.strictObject({
	/** The engine media key (the asset's `engine-store` locator key). */
	mediaId: z.string().min(1).max(256),
	/** ISO 639-1 code of the speech (English-only models: `en`). */
	language: z.string().min(1).max(16),
	/** Catalogue id (default: the engine's default model); use the model that made the transcript. */
	model: z.string().min(1).optional(),
	/** Processor: `auto` (default: the Transcription preference), `cpu` or `gpu` (falls back to the CPU with a reason). */
	device: z.enum(['auto', 'cpu', 'gpu']).optional(),
	/** Absolute ffmpeg stream index (default: the first audio stream, as transcription). */
	streamIndex: z.number().int().min(0).optional(),
	windows: z
		.array(
			z
				.strictObject({
					id: z.string().min(1).max(128),
					/** Flicks; end − start ≤ 30 s (the editor packs windows to ≤ 28 s, SC-030). */
					start: z.number().int().min(0),
					end: z.number().int().min(1),
					readings: z
						.array(
							z.strictObject({
								id: z.string().min(1).max(128),
								/** The reading's words in order (punctuation attached as written). */
								words: z.array(z.string().trim().min(1).max(128)).min(1).max(224),
							}),
						)
						.min(1)
						.max(64),
					/**
					 * Flicks ranges inside the window heard as silence (SC-030: the gaps between the parts of a packed
					 * window, so a reading cannot take speech the transcript does not hold). Optional.
					 */
					mute: z
						.array(z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(1) }))
						.max(64)
						.optional(),
				})
				.refine((w) => w.end > w.start && w.end - w.start <= 30 * 705_600_000, {
					message: 'end must be after start and the window at most 30 s long',
				})
				.refine((w) => (w.mute ?? []).every((m) => m.end > m.start && m.start >= w.start && m.end <= w.end), {
					message: 'a muted range must lie inside its window and have end > start',
					path: ['mute'],
				}),
		)
		.min(1)
		.max(20_000),
});
export type SpeechScoreRequest = z.infer<typeof SpeechScoreRequestSchema>;

export const SpeechScoredWordSchema = z.object({
	text: z.string(),
	/** Tokens of `encode(' ' + text)`. */
	tokens: z.number().int().min(1),
	/** Σ full-vocabulary log-softmax of its tokens (nats). */
	logprob: z.number(),
	/** Mean token probability (the confidence of a fixed word, SC-041). */
	probability: z.number().min(0).max(1),
	/** Flicks (media time): forced cross-attention DTW, refined against the audio (SC-040). */
	start: z.number().int().min(0),
	end: z.number().int().min(0),
});
export type SpeechScoredWord = z.infer<typeof SpeechScoredWordSchema>;

export const SpeechScoreResultSchema = z.object({
	device: SpeechDeviceReportSchema,
	model: z.string(),
	/** The decisive fallback when one happened (also in `device.fallbacks`): job-level first, then session-level. */
	fallback: SpeechFallbackSchema.optional(),
	windows: z.array(
		z.object({
			id: z.string(),
			readings: z.array(
				z.object({
					id: z.string(),
					/** LL: Σ full-vocabulary log-softmax of every text token and `<|endoftext|>` (SC-032). */
					logprob: z.number(),
					/** Tokens scored: text tokens + 1 (end of text). */
					tokens: z.number().int().min(1),
					words: z.array(SpeechScoredWordSchema),
				}),
			),
		}),
	),
	/** Milliseconds (decode, model load, scoring) and the work done (encoder passes = distinct windows). */
	timings: z
		.object({
			decodeMs: z.number(),
			loadMs: z.number(),
			scoreMs: z.number(),
			encoderMs: z.number(),
			decoderMs: z.number(),
			encoderPasses: z.number().int(),
			decoderRuns: z.number().int(),
			readings: z.number().int(),
			/** Seconds of audio in the encoded windows. */
			windowSec: z.number(),
		})
		.optional(),
});
export type SpeechScoreResult = z.infer<typeof SpeechScoreResultSchema>;

/** Engine-side Transcription preferences (`GET/PUT /api/speech/settings`, SG-030). */
export const SpeechSettingsSchema = z.object({
	/** Processor: automatic (GPU when it helps), CPU only, or GPU (falls back to the CPU with the reason). */
	processor: z.enum(['auto', 'cpu', 'gpu']).default('auto'),
	/** Standard = greedy with temperature fallback; Best = beam search 5 (slower). */
	accuracy: z.enum(['standard', 'best']).default('standard'),
	/** Linux: use the downloaded ONNX Runtime CUDA provider (Enable NVIDIA GPU). */
	nvidiaGpu: z.boolean().default(false),
});
export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>;
export const SpeechSettingsPatchSchema = z.strictObject({
	processor: z.enum(['auto', 'cpu', 'gpu']).optional(),
	accuracy: z.enum(['standard', 'best']).optional(),
	nvidiaGpu: z.boolean().optional(),
});

export const SpeechProviderStatusSchema = z.object({
	id: SpeechProviderIdSchema,
	available: z.boolean(),
	/** Why it is not available (or not used). */
	reason: z.string().optional(),
	/** Device name when known (GPU model). */
	device: z.string().optional(),
});
export type SpeechProviderStatus = z.infer<typeof SpeechProviderStatusSchema>;

/** The NVIDIA CUDA provider on Linux x64 (SG-006): downloaded on request, the NVIDIA runtime detected. */
export const SpeechCudaStatusSchema = z.object({
	/** `unsupported`: not Linux x64. */
	state: z.enum(['unsupported', 'not-installed', 'installed', 'damaged']),
	ortVersion: z.string(),
	/** Download size of the provider package. */
	downloadBytes: z.number().int().min(0),
	/** The NVIDIA runtime found on this computer. */
	runtime: z.object({
		ok: z.boolean(),
		/** Missing libraries, e.g. `libcudnn.so.9`. */
		missing: z.array(z.string()),
		driverVersion: z.string().nullable(),
		gpu: z.string().nullable(),
		vramMb: z.number().nullable(),
	}),
	/** What to install when the runtime is missing. */
	guidance: z.string().optional(),
	license: z.string(),
});
export type SpeechCudaStatus = z.infer<typeof SpeechCudaStatusSchema>;

/** Decoder calibration on CUDA + greedy (SG-002): milliseconds per token of each decoder. */
export const SpeechCalibrationSchema = z.object({
	modelId: z.string(),
	provider: SpeechProviderIdSchema,
	cpuMsPerToken: z.number(),
	gpuMsPerToken: z.number(),
	decoder: SpeechProviderIdSchema,
	at: z.string(),
});
export type SpeechCalibration = z.infer<typeof SpeechCalibrationSchema>;

/** The cached provider probe (`GET /api/speech/probe`, `POST` = probe again). */
export const SpeechProbeSchema = z.object({
	platform: z.string(),
	arch: z.string(),
	ortVersion: z.string(),
	providers: z.array(SpeechProviderStatusSchema),
	/** The best providers for each part with the current settings. */
	chosen: z.object({ encoder: SpeechProviderIdSchema, decoder: SpeechProviderIdSchema }),
	/** Threads per session (capped by the performance cores and 8, SG-005). */
	threads: z.number().int().min(1),
	/** The best GPU, when one is usable. */
	gpu: z
		.object({ name: z.string(), provider: SpeechProviderIdSchema, vramMb: z.number().nullable() })
		.nullable(),
	ramBytes: z.number().min(0),
	cores: z.number().int().min(1),
	calibrations: z.array(SpeechCalibrationSchema),
	probedAt: z.string(),
	cuda: SpeechCudaStatusSchema,
	/** The probe could not run (the worker failed); the CPU is assumed. */
	error: z.string().optional(),
});
export type SpeechProbe = z.infer<typeof SpeechProbeSchema>;
