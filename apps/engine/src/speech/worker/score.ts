// Spec 17 SC-032 / SC-035 / SC-036 / SC-040: one scoring job, in-process (`jasper-speech score`, cli.ts, and tests).
//
// The media is decoded once (streamed log-mel + 10 ms levels, like transcription) and the model loaded once; each
// distinct window range is encoded once (windows with the same range — several candidates' readings of the same
// audio — share one encoder pass: they are processed together and the encoder output is reused), then every reading
// of the window is scored by one teacher-forced decoder pass (`WhisperModel.scoreReadings`, batched). Word times come
// from the same pass's cross-attention DTW, then the transcription's word-bound refinement against the audio
// (`refineWords`, keeping every word). The device plan, session fallbacks and the GPU → CPU retry are those of
// transcription (`withDeviceFallback`); cancellation is checked between windows and batches.
import { z } from 'zod';
import type { ProviderId } from '../../tools/ort.ts';
import { FRAME_HALF, SAMPLE_RATE } from '../core/mel.ts';
import { CancelledError, type SpeechInput } from './audio.ts';
import {
	type FrameSource,
	openInput,
	type RunOptions,
	refineWords,
	type SpeechFallbackOut,
	voiceAnalysisMask,
	withDeviceFallback,
} from './run.ts';
import { type ScoredReading, SpeechRefusal, WhisperModel } from './whisper.ts';

/** Caps of one job (the engine validates the same; the worker re-checks its input file). */
export const SCORE_LIMITS = {
	windows: 20_000,
	readingsPerWindow: 64,
	wordsPerReading: 224,
	wordChars: 128,
	idChars: 128,
	/** Longest window (samples): 30 s, Whisper's input. */
	windowSamples: 30 * SAMPLE_RATE,
	/** Muted ranges per window (SC-030: the gaps of a packed window). */
	muteRanges: 64,
} as const;

const ProviderSchema = z.enum(['cpu', 'cuda', 'webgpu', 'dml', 'coreml']);

export const ScoreJobSpecSchema = z.object({
	modelDir: z.string().min(1),
	modelId: z.string().min(1),
	input: z.union([
		z.object({
			path: z.string().min(1),
			stream: z.number().int().min(0).optional(),
			ffmpeg: z.string().min(1),
		}),
		z.object({ f32: z.string() }),
	]),
	language: z.string().min(1).max(16),
	threads: z.number().int().min(1).max(256).optional(),
	device: z
		.object({
			encoder: ProviderSchema,
			decoder: ProviderSchema,
			calibrate: ProviderSchema.nullable().optional(),
		})
		.optional(),
	files: z.object({ encoder: z.string().optional(), decoder: z.string().optional() }).optional(),
	scratch: z.string().optional(),
	durationSec: z.number().min(0).optional(),
	voiceAnalysis: z.object({ path: z.string(), fingerprint: z.string(), stream: z.number().int() }).optional(),
	/** Readings per decoder pass (default 8; capped by memory). */
	batch: z.number().int().min(1).max(32).optional(),
	windows: z
		.array(
			z
				.object({
					id: z.string().min(1).max(SCORE_LIMITS.idChars),
					/** 16 kHz samples from the start of the decoded audio; end − start ≤ 30 s. */
					start: z.number().int().min(0),
					end: z.number().int().min(1),
					readings: z
						.array(
							z.object({
								id: z.string().min(1).max(SCORE_LIMITS.idChars),
								words: z
									.array(z.string().trim().min(1).max(SCORE_LIMITS.wordChars))
									.min(1)
									.max(SCORE_LIMITS.wordsPerReading),
							}),
						)
						.min(1)
						.max(SCORE_LIMITS.readingsPerWindow),
					/**
					 * SC-030: sample ranges inside the window heard as silence (the gaps between the parts of a packed
					 * window, so a reading cannot take speech the transcript does not hold).
					 */
					mute: z
						.array(z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }))
						.max(SCORE_LIMITS.muteRanges)
						.optional(),
				})
				.refine((w) => w.end > w.start && w.end - w.start <= SCORE_LIMITS.windowSamples, {
					message: 'a window must have end > start and last at most 30 s',
				})
				.refine((w) => (w.mute ?? []).every((m) => m.end > m.start && m.start >= w.start && m.end <= w.end), {
					message: 'a muted range must lie inside its window and have end > start',
				}),
		)
		.min(1)
		.max(SCORE_LIMITS.windows),
});
export type ScoreJobSpec = z.infer<typeof ScoreJobSpecSchema>;

export type ScoreJobOutput = {
	modelId: string;
	language: string;
	/** Audio length (16 kHz samples). */
	samples: number;
	/** In the order of the spec; word times in samples, refined against the audio. */
	windows: Array<{ id: string; readings: Array<{ id: string } & ScoredReading> }>;
	timings: { decodeMs: number; loadMs: number; scoreMs: number };
	device: {
		encoder: ProviderId;
		decoder: ProviderId;
		threads: number;
		fallbacks: SpeechFallbackOut[];
	};
	/** Encoder passes (= distinct window ranges), readings and decoder passes; where time went. */
	profile: {
		encoderPasses: number;
		readings: number;
		decoderRuns: number;
		encoderMs: number;
		decoderMs: number;
		/** Speech seconds covered by the encoded windows. */
		windowSec: number;
	};
	guard: { frames: 'voice-analysis' | 'energy' };
};

/** Validates the spec (a refusal names the first problem). */
export function parseScoreSpec(raw: unknown): ScoreJobSpec {
	const r = ScoreJobSpecSchema.safeParse(raw);
	if (!r.success) {
		const i = r.error.issues[0];
		throw new SpeechRefusal(
			'INVALID_SPEC',
			`Invalid scoring spec: ${i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'invalid'}`,
		);
	}
	return r.data;
}

/** The samples kept while decoding: ± two frame windows around every edge of a muted range (`muteWindow`). */
function muteEdges(spec: ScoreJobSpec): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const r = 2 * FRAME_HALF;
	for (const w of spec.windows)
		for (const m of w.mute ?? []) for (const x of [m.start, m.end]) out.push([Math.max(0, x - r), x + r]);
	return out;
}

export async function runScoreJob(raw: unknown, opts: RunOptions = {}): Promise<ScoreJobOutput> {
	const spec = parseScoreSpec(raw);
	const t0 = Date.now();
	opts.onProgress?.(0, 'Decoding audio');
	const cfg = WhisperModel.readConfig(spec.modelDir);
	const input = await openInput(spec, cfg.num_mel_bins, opts, false, 0.05, muteEdges(spec));
	try {
		return await score(spec, input, opts, t0);
	} finally {
		input.dispose();
	}
}

async function score(
	spec: ScoreJobSpec,
	input: SpeechInput,
	opts: RunOptions,
	t0: number,
): Promise<ScoreJobOutput> {
	const t1 = Date.now();
	if (opts.signal?.aborted) throw new CancelledError();
	// one encoder pass per distinct range: windows sharing a range are processed together
	const key = (w: ScoreJobSpec['windows'][number]) =>
		`${Math.floor(w.start / 160)}:${Math.ceil(Math.min(w.end, input.samples) / 160)}:${(w.mute ?? [])
			.map((m) => `${m.start}-${m.end}`)
			.join(',')}`;
	const order = spec.windows
		.map((_, i) => i)
		.sort((a, b) => {
			const wa = spec.windows[a]!;
			const wb = spec.windows[b]!;
			return wa.start - wb.start || wa.end - wb.end || a - b;
		});
	const totalReadings = spec.windows.reduce((s, w) => s + w.readings.length, 0);
	let profile: ScoreJobOutput['profile'] = {
		encoderPasses: 0,
		readings: 0,
		decoderRuns: 0,
		encoderMs: 0,
		decoderMs: 0,
		windowSec: 0,
	};
	const ran = await withDeviceFallback(
		// scoring runs no greedy steps: no decoder calibration (the plan's decoder stays)
		{ ...spec, ...(spec.device ? { device: { ...spec.device, calibrate: null } } : {}) },
		opts,
		async (model) => {
			const results: Array<Array<{ id: string } & ScoredReading>> = new Array(spec.windows.length);
			type Encoded = { key: string; enc: Awaited<ReturnType<WhisperModel['encodeRange']>> };
			let cached = null as Encoded | null;
			let encoderPasses = 0;
			let windowSec = 0;
			let done = 0;
			for (const i of order) {
				if (opts.signal?.aborted) throw new CancelledError();
				const w = spec.windows[i]!;
				if (w.start >= input.samples)
					throw new SpeechRefusal(
						'SPEECH_WINDOW_OUT_OF_RANGE',
						`Window ${w.id} starts after the end of the audio (${(input.samples / SAMPLE_RATE).toFixed(2)} s)`,
					);
				const end = Math.min(w.end, input.samples);
				const k = key(w);
				if (cached?.key !== k) {
					cached = { key: k, enc: await model.encodeRange(input, w.start, end, w.mute ?? []) };
					encoderPasses++;
					windowSec += cached.enc.frames / 100;
				}
				const scored = await model.scoreReadings(
					cached.enc,
					w.readings.map((r) => r.words),
					{ language: spec.language, ...(spec.batch ? { batch: spec.batch } : {}), signal: opts.signal },
				);
				results[i] = scored.map((s, j) => ({ id: w.readings[j]!.id, ...s }));
				done += w.readings.length;
				opts.onProgress?.(
					0.05 + (0.9 * done) / Math.max(1, totalReadings),
					`Scoring ${done}/${totalReadings}`,
				);
			}
			profile = { ...profile, encoderPasses, windowSec: Math.round(windowSec * 100) / 100, ...model.timing };
			return results;
		},
		0.05,
	);
	// SC-040: forced DTW times → the transcription's word-bound refinement (every word kept)
	const vaMask = spec.voiceAnalysis ? await voiceAnalysisMask(spec.voiceAnalysis, input.db.length) : null;
	const frames: FrameSource = vaMask
		? { samples: input.samples, db: input.db, mask: input.mask, presence: vaMask.presence }
		: input;
	const windows = spec.windows.map((w, i) => ({
		id: w.id,
		readings: (ran.value[i] ?? []).map((r) => {
			const words = r.words.map((x) => ({ ...x }));
			refineWords(frames, words, { keepAll: true });
			return { ...r, words };
		}),
	}));
	profile.readings = totalReadings;
	opts.onProgress?.(1, 'Done');
	return {
		modelId: spec.modelId,
		language: spec.language,
		samples: input.samples,
		windows,
		timings: { decodeMs: t1 - t0, loadMs: ran.loadMs, scoreMs: Date.now() - t1 - ran.loadMs },
		device: { ...ran.providers, threads: ran.threads, fallbacks: ran.fallbacks },
		profile,
		guard: { frames: vaMask ? 'voice-analysis' : 'energy' },
	};
}
