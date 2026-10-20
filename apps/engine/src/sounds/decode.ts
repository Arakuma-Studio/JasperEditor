// Decoding a library sound for analysis (spec 12 §2.1; wp-note "WP1.2"): ffprobe for the file's format, then ffmpeg to
// planar float PCM of its first SOUND_ANALYSIS_SECONDS, at its own rate up to 48 kHz and with at most 6 channels
// (more are folded to stereo). Bounded: 30 s × 48 kHz × 6 ch × 4 B ≈ 35 MB at most; the index decodes files of up to
// 120 s whole for their takes (P6-E9), within 120 s of 48 kHz stereo ≈ 46 MB. FFmpeg may read the named file
// (and data it embeds) only, nothing it points at over the network (the Media Browser's rule, D-47).
import type { ChildProcess } from 'node:child_process';
import { SOUND_ANALYSIS_SECONDS, SOUND_TAKES_MAX_FILE_SECONDS } from '@jasper/api';
import { JobError } from '../jobs/types.ts';
import { mapProbe } from '../media/probe.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

export const LOCAL_PROTOCOLS = ['-protocol_whitelist', 'file,crypto,data'] as const;
/** Highest analysis rate; descriptors are perceptual (≤ 20 kHz), so higher rates are resampled. */
export const MAX_ANALYSIS_RATE = 48_000;
export const MAX_ANALYSIS_CHANNELS = 6;
const PROBE_TIMEOUT_MS = 20_000;
const DECODE_TIMEOUT_MS = 120_000;

export type SoundFormat = { durationSec: number; sampleRate: number; channels: number; container: string };
export type DecodedSound = {
	format: SoundFormat;
	/** Planar samples at `rate`: at most SOUND_ANALYSIS_SECONDS long (or the seconds asked for). */
	channels: Float32Array[];
	rate: number;
};

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
	return AbortSignal.any(signals.filter((s): s is AbortSignal => !!s));
}

/** ffprobe summary of an audio file; `UNSUPPORTED_MEDIA` when it has no audio stream. */
export async function probeSound(ff: Ffmpeg, path: string, signal?: AbortSignal): Promise<SoundFormat> {
	let r: ReturnType<typeof mapProbe>;
	try {
		r = mapProbe(
			await ff.probeJson([...LOCAL_PROTOCOLS, '-show_format', '-show_streams', path], {
				signal: anySignal([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
			}),
		);
	} catch (e) {
		if (signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const err = e as { code?: string; message?: string };
		throw new JobError(
			err.code === 'BINARY_MISSING' ? 'BINARY_MISSING' : 'UNSUPPORTED_MEDIA',
			`Cannot read this file: ${(err.message ?? 'ffprobe failed').slice(0, 300)}`,
		);
	}
	const a = r.probe.streams.find((s) => s.type === 'audio');
	if (a?.type !== 'audio') throw new JobError('UNSUPPORTED_MEDIA', 'The file has no audio stream');
	const durationSec = r.durationSec !== null && Number.isFinite(r.durationSec) ? r.durationSec : 0;
	return {
		durationSec: Math.max(0, Math.round(durationSec * 10_000) / 10_000),
		sampleRate: Number.isFinite(a.sampleRate) ? Math.max(0, Math.round(a.sampleRate)) : 0,
		channels: Number.isFinite(a.channels) ? Math.max(0, Math.round(a.channels)) : 0,
		container: String(r.container).slice(0, 100),
	};
}

/** Rate and channel count the analysis decodes at. */
export function analysisLayout(format: SoundFormat): { rate: number; channels: number } {
	const rate =
		format.sampleRate >= 1000 && format.sampleRate <= MAX_ANALYSIS_RATE
			? format.sampleRate
			: MAX_ANALYSIS_RATE;
	const channels =
		format.channels >= 1 && format.channels <= MAX_ANALYSIS_CHANNELS
			? format.channels
			: format.channels > 0
				? 2
				: 1;
	return { rate, channels };
}

/** Collects interleaved f32le from a child into planar channels (at most `maxFrames`). */
export function readPlanar(
	child: ChildProcess,
	channels: number,
	maxFrames: number,
	signal: AbortSignal,
): Promise<Float32Array[]> {
	return new Promise((resolve, reject) => {
		const frameBytes = 4 * channels;
		const cap = maxFrames * frameBytes;
		const chunks: Buffer[] = [];
		let have = 0;
		let stderr = '';
		child.stdout!.on('data', (c: Buffer) => {
			if (have >= cap) return;
			const take = c.length > cap - have ? c.subarray(0, cap - have) : c;
			chunks.push(take);
			have += take.length;
		});
		child.stderr?.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-4000);
		});
		child.on('error', (e) => reject(new JobError('BINARY_MISSING', `Cannot run ffmpeg: ${e.message}`)));
		child.on('close', (code) => {
			if (signal.aborted) return reject(new JobError('JOB_CANCELLED', 'Cancelled'));
			if (code !== 0)
				return reject(
					new JobError('UNSUPPORTED_MEDIA', `ffmpeg could not decode the file: ${stderr.trim().slice(-300)}`),
				);
			const buf = Buffer.concat(chunks, have);
			const frames = Math.floor(buf.length / frameBytes);
			const out = Array.from({ length: channels }, () => new Float32Array(frames));
			const dv = new DataView(buf.buffer, buf.byteOffset, frames * frameBytes);
			for (let i = 0; i < frames; i++)
				for (let ch = 0; ch < channels; ch++) out[ch]![i] = dv.getFloat32((i * channels + ch) * 4, true);
			resolve(out);
		});
	});
}

/**
 * Samples (frames × channels) a decode for takes may hold: 120 s of 48 kHz stereo (≈ 46 MB of float). A file with more
 * channels is decoded over a correspondingly shorter stretch.
 */
export const TAKE_DECODE_SAMPLE_BUDGET = SOUND_TAKES_MAX_FILE_SECONDS * MAX_ANALYSIS_RATE * 2;

/**
 * Seconds a library index decodes of a file: the whole file when it is at most SOUND_TAKES_MAX_FILE_SECONDS long (its
 * takes are searched over all of it, P6-E9; within TAKE_DECODE_SAMPLE_BUDGET), else SOUND_ANALYSIS_SECONDS.
 */
export function indexDecodeSeconds(format: SoundFormat): number {
	if (!(format.durationSec > 0) || format.durationSec > SOUND_TAKES_MAX_FILE_SECONDS)
		return SOUND_ANALYSIS_SECONDS;
	const { rate, channels } = analysisLayout(format);
	const budgetSec = Math.floor(TAKE_DECODE_SAMPLE_BUDGET / (rate * channels));
	return Math.max(SOUND_ANALYSIS_SECONDS, Math.min(SOUND_TAKES_MAX_FILE_SECONDS, budgetSec));
}

/**
 * Probes and decodes the first SOUND_ANALYSIS_SECONDS of an audio file (`seconds` overrides that: a number, or
 * `'index'` for {@link indexDecodeSeconds}).
 */
export async function decodeSound(
	ff: Ffmpeg,
	path: string,
	opts: { signal?: AbortSignal; onSpawn?: (child: ChildProcess) => void; seconds?: number | 'index' } = {},
): Promise<DecodedSound> {
	const format = await probeSound(ff, path, opts.signal);
	const { rate, channels } = analysisLayout(format);
	const seconds =
		opts.seconds === 'index'
			? indexDecodeSeconds(format)
			: typeof opts.seconds === 'number' && opts.seconds > 0
				? Math.min(SOUND_TAKES_MAX_FILE_SECONDS, opts.seconds)
				: SOUND_ANALYSIS_SECONDS;
	const signal = anySignal([opts.signal, AbortSignal.timeout(DECODE_TIMEOUT_MS)]);
	let child: ChildProcess;
	try {
		child = ff.spawnRaw(
			[
				...LOCAL_PROTOCOLS,
				'-t',
				String(seconds),
				'-i',
				path,
				'-map',
				'0:a:0',
				'-vn',
				'-ac',
				String(channels),
				'-ar',
				String(rate),
				'-f',
				'f32le',
				'pipe:1',
			],
			{ signal },
		);
	} catch (e) {
		throw new JobError('BINARY_MISSING', `Cannot run ffmpeg: ${(e as Error).message}`);
	}
	opts.onSpawn?.(child);
	const planar = await readPlanar(child, channels, Math.ceil(rate * seconds), signal);
	if (opts.signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
	return { format, channels: planar, rate };
}
