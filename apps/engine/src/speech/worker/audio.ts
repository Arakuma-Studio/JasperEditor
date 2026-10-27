// Audio input of a transcription, streamed (spec 16 SG-014): ffmpeg decodes to mono 16 kHz float32 on a pipe and
// each chunk feeds the log-mel front end (`LogMelStream`), the 10 ms level frames (VAD) and — only when speakers
// are labelled — a scratch file of the samples. Recognition then reads 30 s windows of mel frames from memory, or
// from a scratch file once the spectrogram exceeds `MEL_MEMORY_BYTES`, so the memory of a long file is bounded:
// no whole-file sample array, no whole-file spectrogram.
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogMelStream, SAMPLE_RATE, windowFromRaw } from '../core/mel.ts';
import { VAD_FRAME, vadThreshold, voicedMask } from '../core/vad.ts';

/** Whisper pads 30 s of zeros after the audio. */
export const PAD_SAMPLES = 30 * SAMPLE_RATE;
/** Spectrogram bytes kept in memory before it moves to a scratch file (≈ 21 min of 128-band frames). */
export const MEL_MEMORY_BYTES = 64 * 1024 * 1024;

export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

/** Raw (un-normalised) log-mel frames, frame-major, in memory or in a file. */
export class MelFrames {
	private mem: Float32Array;
	private memFrames = 0;
	private fd: number | null = null;
	private file: string | null = null;
	frames = 0;
	max = Number.NEGATIVE_INFINITY;
	private readBuf = new Float32Array(0);

	constructor(
		readonly nMels: number,
		private readonly scratch: () => string,
		private readonly memoryBytes = MEL_MEMORY_BYTES,
	) {
		this.mem = new Float32Array(nMels * 4096);
	}

	append(row: Float32Array): void {
		const n = this.nMels;
		if (this.fd === null && (this.memFrames + 1) * n * 4 > this.memoryBytes) {
			this.file = join(this.scratch(), `mel-${process.pid}-${Date.now()}.f32`);
			this.fd = openSync(this.file, 'w+');
			const bytes = new Uint8Array(this.mem.buffer, 0, this.memFrames * n * 4);
			writeSync(this.fd, bytes, 0, bytes.length, 0);
			this.mem = new Float32Array(0);
		}
		if (this.fd !== null) {
			writeSync(this.fd, new Uint8Array(row.buffer, row.byteOffset, n * 4), 0, n * 4, this.frames * n * 4);
		} else {
			if ((this.memFrames + 1) * n > this.mem.length) {
				const grown = new Float32Array(Math.min(this.mem.length * 2, Math.ceil(this.memoryBytes / 4) + n));
				grown.set(this.mem.subarray(0, this.memFrames * n));
				this.mem = grown;
			}
			this.mem.set(row, this.memFrames * n);
			this.memFrames++;
		}
		this.frames++;
	}

	/** Frames [seek, seek + count) (raw, frame-major). The returned array is reused by the next call. */
	read(seek: number, count: number): Float32Array {
		const n = this.nMels;
		const c = Math.max(0, Math.min(count, this.frames - seek));
		if (this.fd === null) return this.mem.subarray(seek * n, (seek + c) * n);
		if (this.readBuf.length < c * n) this.readBuf = new Float32Array(c * n);
		const view = new Uint8Array(this.readBuf.buffer, 0, c * n * 4);
		let got = 0;
		while (got < view.length) {
			const r = readSync(this.fd, view, got, view.length - got, seek * n * 4 + got);
			if (r <= 0) break;
			got += r;
		}
		return this.readBuf.subarray(0, c * n);
	}

	/** Whisper's normalised window (nMels × nFrames, band-major) of `count` frames from `seek`. */
	window(seek: number, count: number, out: Float32Array, nFrames: number): void {
		windowFromRaw(
			this.read(seek, count),
			Math.min(count, this.frames - seek),
			this.nMels,
			this.max,
			out,
			nFrames,
		);
	}

	get onDisk(): boolean {
		return this.fd !== null;
	}

	dispose(): void {
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
		if (this.file) rmSync(this.file, { force: true });
		this.file = null;
		this.mem = new Float32Array(0);
	}
}

/** Everything recognition and word-bound refinement read from the audio. */
export type SpeechInput = {
	/** Audio length (16 kHz samples). */
	samples: number;
	/** 10 ms frame levels (dBFS). */
	db: Float32Array;
	/** The energy threshold of `db`. */
	threshold: number;
	/** 1 = speech (or breath) per 10 ms frame. */
	mask: Uint8Array;
	/** Log-mel frames of the audio + 30 s of zeros (Whisper framing). */
	mel: MelFrames;
	/** The samples (speaker labelling); throws when they were not kept. */
	audio(): Promise<Float32Array>;
	/**
	 * Samples [start, end) when they were kept (an in-memory clip, or ranges named by `keepRanges` while decoding:
	 * spec 17 SC-030 muted gaps), else null.
	 */
	samplesIn?(start: number, end: number): Float32Array | null;
	dispose(): void;
};

/** Sorted, merged, non-empty sample ranges [a, b). */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
	const sorted = ranges
		.map(([a, b]) => [Math.max(0, Math.floor(a)), Math.floor(b)] as [number, number])
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0]);
	const out: Array<[number, number]> = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

/** Accumulates the input chunk by chunk. */
export class InputBuilder {
	private readonly mel: MelFrames;
	private readonly stream: LogMelStream;
	/** Samples pushed so far. */
	get sampleCount(): number {
		return this.samples;
	}
	private db = new Float32Array(1 << 14);
	private dbFrames = 0;
	private acc = 0;
	private accN = 0;
	private samples = 0;
	private audioFd: number | null = null;
	private audioFile: string | null = null;
	private dir: string | null = null;
	private kept: Float32Array | null = null;
	/** Kept sample ranges (`keepRanges`) and their samples, filled while decoding. */
	private readonly snippets: Array<{ start: number; data: Float32Array }>;
	private snippetAt = 0;

	constructor(
		readonly nMels: number,
		private readonly opts: {
			scratch?: string;
			keepAudio?: boolean;
			memoryBytes?: number;
			keepRanges?: ReadonlyArray<readonly [number, number]>;
		} = {},
	) {
		this.mel = new MelFrames(nMels, () => this.scratchDir(), opts.memoryBytes);
		this.stream = new LogMelStream(nMels, (row) => this.mel.append(row));
		this.snippets = mergeRanges(opts.keepRanges ?? []).map(([a, b]) => ({
			start: a,
			data: new Float32Array(b - a),
		}));
	}

	/** Copies the parts of the chunk [at, at + n) that kept ranges cover. */
	private keepSnippets(chunk: Float32Array, at: number): void {
		const end = at + chunk.length;
		while (this.snippetAt < this.snippets.length) {
			const sn = this.snippets[this.snippetAt]!;
			if (sn.start + sn.data.length <= at) {
				this.snippetAt++;
				continue;
			}
			break;
		}
		for (let k = this.snippetAt; k < this.snippets.length; k++) {
			const sn = this.snippets[k]!;
			if (sn.start >= end) break;
			const a = Math.max(at, sn.start);
			const b = Math.min(end, sn.start + sn.data.length);
			if (b > a) sn.data.set(chunk.subarray(a - at, b - at), a - sn.start);
		}
	}

	private scratchDir(): string {
		if (this.opts.scratch) return this.opts.scratch;
		if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'jasper-speech-'));
		return this.dir;
	}

	push(chunk: Float32Array): void {
		if (!chunk.length) return;
		this.stream.push(chunk);
		if (this.snippets.length) this.keepSnippets(chunk, this.samples);
		for (let i = 0; i < chunk.length; i++) {
			const v = chunk[i];
			this.acc += v * v;
			if (++this.accN === VAD_FRAME) this.flushDb();
		}
		if (this.opts.keepAudio) {
			if (this.audioFd === null) {
				this.audioFile = join(this.scratchDir(), `audio-${process.pid}-${Date.now()}.f32`);
				this.audioFd = openSync(this.audioFile, 'w+');
			}
			const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			writeSync(this.audioFd, bytes, 0, bytes.length, this.samples * 4);
		}
		this.samples += chunk.length;
	}

	private flushDb(): void {
		if (this.dbFrames === this.db.length) {
			const g = new Float32Array(this.db.length * 2);
			g.set(this.db);
			this.db = g;
		}
		this.db[this.dbFrames++] = 10 * Math.log10(this.acc / Math.max(1, this.accN) + 1e-12);
		this.acc = 0;
		this.accN = 0;
	}

	/** Ends the audio (pads Whisper's 30 s) and returns the input. */
	finish(memoryAudio?: Float32Array): SpeechInput {
		if (this.accN > 0) this.flushDb();
		const { max } = this.stream.end(PAD_SAMPLES);
		this.mel.max = max;
		const db = this.db.slice(0, this.dbFrames);
		const threshold = vadThreshold(db);
		const mask = voicedMask(db, threshold);
		const samples = this.samples;
		if (this.audioFd !== null) {
			closeSync(this.audioFd);
			this.audioFd = null;
		}
		this.kept = memoryAudio ?? null;
		const audioFile = this.audioFile;
		const mel = this.mel;
		const dir = this.dir;
		return {
			samples,
			db,
			threshold,
			mask,
			mel,
			samplesIn: (start, end) => {
				if (!(end > start) || start < 0) return null;
				if (this.kept) return end <= this.kept.length ? this.kept.subarray(start, end) : null;
				for (const sn of this.snippets)
					if (start >= sn.start && end <= sn.start + sn.data.length)
						return sn.data.subarray(start - sn.start, end - sn.start);
				return null;
			},
			audio: async () => {
				if (this.kept) return this.kept;
				if (!audioFile) throw new Error('the audio samples were not kept');
				const b = await readFile(audioFile);
				return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
			},
			dispose: () => {
				mel.dispose();
				if (audioFile) rmSync(audioFile, { force: true });
				if (dir) rmSync(dir, { recursive: true, force: true });
			},
		};
	}
}

/** The input of an in-memory clip (tests, the benchmark harness). */
export function inputFromSamples(
	audio: Float32Array,
	nMels: number,
	opts: { memoryBytes?: number } = {},
): SpeechInput {
	const b = new InputBuilder(nMels, opts);
	const CHUNK = 1 << 16;
	for (let i = 0; i < audio.length; i += CHUNK) b.push(audio.subarray(i, Math.min(audio.length, i + CHUNK)));
	return b.finish(audio);
}

/**
 * Decodes the input with ffmpeg to mono 16 kHz float32 and streams it into an `InputBuilder` (`stream` = absolute
 * stream index; default the first audio stream). `onSamples` reports progress.
 */
export async function decodeToInput(
	input: { path: string; stream?: number; ffmpeg: string },
	nMels: number,
	opts: {
		signal?: AbortSignal;
		scratch?: string;
		keepAudio?: boolean;
		/** Sample ranges whose samples the input keeps (`SpeechInput.samplesIn`). */
		keepRanges?: ReadonlyArray<readonly [number, number]>;
		onSamples?(samples: number): void;
		onSpawn?(child: import('node:child_process').ChildProcess): void;
	} = {},
): Promise<SpeechInput> {
	const args = ['-v', 'error', '-nostdin', '-i', input.path];
	args.push('-map', input.stream !== undefined ? `0:${input.stream}` : '0:a:0');
	args.push('-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
	const builder = new InputBuilder(nMels, {
		scratch: opts.scratch,
		keepAudio: opts.keepAudio,
		...(opts.keepRanges ? { keepRanges: opts.keepRanges } : {}),
	});
	await new Promise<void>((resolve, reject) => {
		const child = spawn(input.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		opts.onSpawn?.(child);
		let err = '';
		let carry: Buffer | null = null;
		let failed: unknown = null;
		const onAbort = () => child.kill('SIGKILL');
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (c: Buffer) => {
			if (failed) return;
			try {
				const b: Buffer = carry ? Buffer.concat([carry, c]) : c;
				const whole = b.byteLength - (b.byteLength % 4);
				carry = whole < b.byteLength ? Buffer.from(b.subarray(whole)) : null;
				if (!whole) return;
				// copy into an aligned buffer (Buffer slices may start at any byte offset)
				const f = new Float32Array(whole / 4);
				new Uint8Array(f.buffer).set(b.subarray(0, whole));
				builder.push(f);
				opts.onSamples?.(builder.sampleCount);
			} catch (e) {
				failed = e;
				child.kill('SIGKILL');
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			if (err.length < 4000) err += c.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			opts.signal?.removeEventListener('abort', onAbort);
			if (opts.signal?.aborted) return reject(new CancelledError());
			if (failed) return reject(failed);
			if (code !== 0)
				return reject(new Error(`ffmpeg could not decode the audio: ${err.trim() || `exit ${code}`}`));
			resolve();
		});
	});
	return builder.finish();
}
