// One transcription, in-process: decode → Whisper → word-bound repair (pauses, voice) → VAD tightening → speakers.
// Used by the `jasper-speech` child process (cli.ts) and by tests.
import { spawn } from 'node:child_process';
import { DEFAULT_DIARIZE, diarize } from '../core/diarize.ts';
import { SAMPLE_RATE } from '../core/mel.ts';
import { extendWordsIntoSpeech, frameDb, splitAtPauses, tightenWords } from '../core/vad.ts';
import { CancelledError, WhisperModel, type WhisperResult } from './whisper.ts';

export type SpeechJobSpec = {
	modelDir: string;
	modelId: string;
	/** Audio source: decoded with ffmpeg (`stream` = absolute stream index; default the first audio stream). */
	input: { path: string; stream?: number; ffmpeg: string } | { f32: string };
	language?: string | null;
	task?: 'transcribe' | 'translate';
	speakers?: { enabled: boolean; count?: number; max?: number };
	threads?: number;
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

export type SpeechJobOutput = {
	modelId: string;
	language: string;
	languageProbability: number | null;
	task: 'transcribe' | 'translate';
	samples: number;
	speakers: number;
	words: SpeechJobWord[];
	segments: WhisperResult['segments'];
	timings: { decodeMs: number; loadMs: number; transcribeMs: number };
};

/** Decodes the input to mono 16 kHz float32 with ffmpeg. */
export async function decodeAudio(
	input: { path: string; stream?: number; ffmpeg: string },
	signal?: AbortSignal,
): Promise<Float32Array> {
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
			if (code !== 0) return reject(new Error(`ffmpeg could not decode the audio: ${err.trim() || `exit ${code}`}`));
			const b = Buffer.concat(chunks);
			const n = Math.floor(b.byteLength / 4);
			const out = new Float32Array(n);
			for (let i = 0; i < n; i++) out[i] = b.readFloatLE(i * 4);
			resolve(out);
		});
	});
}

/** Word-bound refinement after alignment (see core/vad.ts): repair at pauses, grow into voice, tighten. */
export function refineWordBounds(audio: Float32Array, words: Array<{ start: number; end: number }>): void {
	const db = frameDb(audio);
	splitAtPauses(audio, words, db);
	extendWordsIntoSpeech(audio, words, db);
	tightenWords(audio, words, db);
	// keep words ordered, non-overlapping and inside the audio
	let prev = 0;
	for (const w of words) {
		w.start = Math.min(audio.length, Math.max(prev, Math.round(w.start)));
		w.end = Math.min(audio.length, Math.max(w.start, Math.round(w.end)));
		prev = w.end;
	}
}

export async function runSpeechJob(
	spec: SpeechJobSpec,
	opts: { onProgress?(fraction: number, stage: string): void; signal?: AbortSignal; audio?: Float32Array } = {},
): Promise<SpeechJobOutput> {
	const t0 = Date.now();
	opts.onProgress?.(0, 'Decoding audio');
	const audio: Float32Array =
		opts.audio ??
		('f32' in spec.input
			? await import('node:fs/promises').then(async (fs) => {
					const b = await fs.readFile((spec.input as { f32: string }).f32);
					return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
				})
			: await decodeAudio(spec.input, opts.signal));
	const t1 = Date.now();
	opts.onProgress?.(0.02, 'Loading the model');
	const model = await WhisperModel.load(spec.modelDir, { threads: spec.threads ?? 4 });
	const t2 = Date.now();
	try {
		const r = await model.transcribe(audio, {
			language: spec.language ?? null,
			task: spec.task ?? 'transcribe',
			signal: opts.signal,
			onProgress: (f, stage) => {
				opts.onProgress?.(0.03 + f * 0.92, stage);
				return true;
			},
		});
		const words = r.words.map((w) => ({ ...w }));
		refineWordBounds(audio, words);
		let labels: number[] | null = null;
		let speakers = 0;
		if (spec.speakers?.enabled && words.length) {
			opts.onProgress?.(0.96, 'Labelling speakers');
			const d = diarize(audio, words, {
				...DEFAULT_DIARIZE,
				maxSpeakers: spec.speakers.max ?? DEFAULT_DIARIZE.maxSpeakers,
				...(spec.speakers.count ? { speakerCount: spec.speakers.count } : {}),
			});
			labels = d.labels;
			speakers = d.speakers;
		}
		opts.onProgress?.(1, 'Done');
		return {
			modelId: spec.modelId,
			language: r.language,
			languageProbability: r.languageProbability,
			task: spec.task === 'translate' && model.multilingual ? 'translate' : 'transcribe',
			samples: audio.length,
			speakers,
			words: words.map((w, i) => ({
				text: w.text,
				start: w.start,
				end: w.end,
				confidence: Math.round(w.probability * 1000) / 1000,
				speaker: labels ? (labels[i] ?? 0) : null,
			})),
			segments: r.segments,
			timings: { decodeMs: t1 - t0, loadMs: t2 - t1, transcribeMs: Date.now() - t2 },
		};
	} finally {
		await model.release();
	}
}
