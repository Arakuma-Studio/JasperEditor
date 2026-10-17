// Lead silence for registered library sounds (spec 12 §2.3; wp-note "Phase 1 verification"): a sound whose head is
// not quiet would play up to one frame late when its peak falls between frames, because placement can take the
// sub-frame rest out of the In point only where the head is silent. Registering such a sound into a project therefore
// writes a copy with `LIBRARY_LEAD_SILENCE_SEC` (whole samples) of digital silence in front of it, as PCM WAV: the
// decoded samples bit for bit (32-bit float holds every 16/24-bit and float decoder output exactly), so nothing is
// re-encoded lossily. Deterministic (`-bitexact`, no metadata): the same file gives the same bytes, so the media
// registry and the project dedupe repeated registrations by fingerprint. A lossy sound (Vorbis, Opus, MP3, AAC…) is
// written the same way with no silence when its head is already quiet: a seeked decode of a lossy stream is not
// sample-aligned with its full decode (Vorbis: 128 samples), so only PCM keeps an In point after 0 exact. A sound that
// does not end in quiet also gets `LIBRARY_TRAIL_SILENCE_SEC` of silence after it (`trailSamples`): a placed clip is
// whole frames rounded up to the sound's end, and that last frame must be inside the media (wp-note "Fix: SFX tail
// truncation"); the copy is then the decoded samples, then digital silence, bit for bit. Sounds up to
// `LIBRARY_PAD_MAX_SECONDS` (1 h, beds included) are copied: ffmpeg streams the source to the copy file to file (the
// engine never holds the sound in memory), and the copy is written in the narrowest PCM that holds the decoder's
// samples exactly (`copyCodecFor`). Registering checks the copy's size against a cap and the free disk first.
import { mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { LOCAL_PROTOCOLS } from './decode.ts';

const PAD_TIMEOUT_MS = 120_000;
/** Extra time a long sound gets to be written (ffmpeg decodes and writes far faster than real time). */
const PAD_TIMEOUT_MS_PER_SEC = 250;

/** Codecs written as they are (lossless PCM wider than float32 would lose bits); everything else → pcm_f32le. */
const KEEP_CODECS = new Set(['pcm_s32le', 'pcm_f64le']);
/** Codecs a copy may be written in. */
const OUT_CODECS = new Set(['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le']);

/**
 * The PCM codec a managed copy is written in, from the decoder's output (`sample_fmt`, `bits_per_raw_sample`): the
 * narrowest WAV PCM that holds every decoded sample exactly — 16-bit integer for 8/16-bit sources, 24-bit for ≤ 24-bit
 * ones (FLAC 24, `pcm_s24le`), 32-bit integer above, float for float decoders (every lossy codec: Vorbis, Opus, MP3,
 * AAC), double for double. Unknown formats → float (the previous rule). WAV, not FLAC: browsers decode PCM WAV in
 * mediabunny's own JS on every platform, while FLAC goes through the platform's WebCodecs decoder, which Google Chrome
 * 150 measured not bit-exact for 16-bit FLAC (≤ 5.3e-6 off; WP6.5b wp-note).
 */
export function copyCodecFor(stream: {
	sampleFmt?: string | null;
	bitsPerRawSample?: number | null;
}): string {
	const fmt = (stream.sampleFmt ?? '').replace(/p$/, '');
	if (fmt === 'u8' || fmt === 's16') return 'pcm_s16le';
	if (fmt === 's32') {
		const bits = stream.bitsPerRawSample ?? 0;
		return bits > 0 && bits <= 24 ? 'pcm_s24le' : 'pcm_s32le';
	}
	if (fmt === 'dbl' || fmt === 's64') return 'pcm_f64le';
	return 'pcm_f32le';
}

/** Bytes per sample of a PCM copy codec. */
export function pcmBytes(codec: string): number {
	return codec === 'pcm_s16le' ? 2 : codec === 'pcm_s24le' ? 3 : codec === 'pcm_f64le' ? 8 : 4;
}

/** Size of a WAV copy of `seconds` (lead and trail included) at `rate` with `channels` in `codec`, header included. */
export function estimateCopyBytes(seconds: number, rate: number, channels: number, codec: string): number {
	if (!(seconds > 0) || !(rate > 0) || !(channels > 0)) return 0;
	// ffprobe's duration of a lossy stream can be a little short: one extra second covers it
	return Math.ceil((seconds + 1) * rate) * Math.ceil(channels) * pcmBytes(codec) + 4096;
}

/** PCM codecs (`pcm_s16le`, `pcm_f32le`…): seeks are sample-exact, so such a file may be registered as it is. */
export function isPcmCodec(codec: string): boolean {
	return codec.startsWith('pcm_');
}

/** Codec and sample rate of the first audio stream (null fields when ffprobe does not say). */
export async function probeAudioStream(
	ff: Ffmpeg,
	path: string,
	signal?: AbortSignal,
): Promise<AudioStreamInfo> {
	let j: Record<string, unknown>;
	try {
		j = await ff.probeJson(
			[
				...LOCAL_PROTOCOLS,
				'-select_streams',
				'a:0',
				'-show_entries',
				'stream=codec_name,sample_rate,sample_fmt,bits_per_raw_sample,channels',
				path,
			],
			{ signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)].filter((s): s is AbortSignal => !!s)) },
		);
	} catch (e) {
		const err = e as { code?: string; message?: string };
		throw new JobError(
			err.code === 'BINARY_MISSING' ? 'BINARY_MISSING' : 'UNSUPPORTED_MEDIA',
			`Cannot read the sound: ${(err.message ?? 'ffprobe failed').slice(0, 300)}`,
		);
	}
	const s = (
		j.streams as
			| {
					codec_name?: unknown;
					sample_rate?: unknown;
					sample_fmt?: unknown;
					bits_per_raw_sample?: unknown;
					channels?: unknown;
			  }[]
			| undefined
	)?.[0];
	const rate = Number(s?.sample_rate);
	const bits = Number(s?.bits_per_raw_sample);
	const channels = Number(s?.channels);
	return {
		codec: typeof s?.codec_name === 'string' ? s.codec_name.slice(0, 64) : null,
		sampleRate: Number.isFinite(rate) && rate > 0 ? Math.round(rate) : null,
		sampleFmt: typeof s?.sample_fmt === 'string' ? s.sample_fmt.slice(0, 16) : null,
		bitsPerRawSample: Number.isInteger(bits) && bits > 0 && bits <= 64 ? bits : null,
		channels: Number.isInteger(channels) && channels > 0 && channels <= 64 ? channels : null,
	};
}

/** What registering reads of a sound's first audio stream (null fields when ffprobe does not say). */
export type AudioStreamInfo = {
	codec: string | null;
	sampleRate: number | null;
	/** The decoder's output format (`s16`, `s32p`, `fltp`…). */
	sampleFmt?: string | null;
	/** Significant bits of an integer format (24 for 24-bit FLAC / `pcm_s24le`, decoded as s32). */
	bitsPerRawSample?: number | null;
	channels?: number | null;
};

/** The managed file name of a padded sound: the library file's stem, `.wav`. */
export function paddedFileName(libraryFile: string): string {
	const stem = basename(libraryFile, extname(libraryFile))
		.replace(/[^\p{L}\p{N} ._-]/gu, '_')
		.slice(0, 120);
	return `${stem || 'sound'}.wav`;
}

/**
 * Writes `<tmpDir>/<unique>.wav`: `samples` (≥ 0) of silence, then the first audio stream of `path` at its own rate
 * and channel count, then `trailSamples` (≥ 0, default 0) of silence. Returns the temp file (the caller registers or
 * deletes it). `codec` is the source's audio codec.
 */
export async function writePaddedSound(
	ff: Ffmpeg,
	opts: {
		path: string;
		samples: number;
		trailSamples?: number;
		codec: string | null;
		/** The copy's PCM codec (`copyCodecFor`); default: the source's own `pcm_s32le` / `pcm_f64le`, else `pcm_f32le`. */
		outCodec?: string;
		/** The sound's length (seconds): a long one gets more time to be written. */
		durationSec?: number;
		tmpDir: string;
		signal?: AbortSignal;
	},
): Promise<string> {
	if (!Number.isSafeInteger(opts.samples) || opts.samples < 0 || opts.samples > 1_000_000)
		throw new JobError('E_INVALID_PARAM', 'Bad lead-silence length');
	const trail = opts.trailSamples ?? 0;
	if (!Number.isSafeInteger(trail) || trail < 0 || trail > 1_000_000)
		throw new JobError('E_INVALID_PARAM', 'Bad trailing-silence length');
	const filters = [
		...(opts.samples > 0 ? [`adelay=delays=${opts.samples}S:all=1`] : []),
		...(trail > 0 ? [`apad=pad_len=${trail}`] : []),
	];
	await mkdir(opts.tmpDir, { recursive: true });
	const out = join(opts.tmpDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
	const codec =
		opts.outCodec && OUT_CODECS.has(opts.outCodec)
			? opts.outCodec
			: opts.codec && KEEP_CODECS.has(opts.codec)
				? opts.codec
				: 'pcm_f32le';
	const dur = opts.durationSec !== undefined && Number.isFinite(opts.durationSec) ? opts.durationSec : 0;
	const timeoutMs = PAD_TIMEOUT_MS + Math.min(3600, Math.max(0, dur)) * PAD_TIMEOUT_MS_PER_SEC;
	const signal = AbortSignal.any(
		[opts.signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => !!s),
	);
	try {
		await ff.run(
			[
				...LOCAL_PROTOCOLS,
				'-i',
				opts.path,
				'-map',
				'0:a:0',
				'-vn',
				'-sn',
				'-dn',
				...(filters.length ? ['-af', filters.join(',')] : []),
				'-c:a',
				codec,
				'-map_metadata',
				'-1',
				'-fflags',
				'+bitexact',
				'-flags:a',
				'+bitexact',
				'-f',
				'wav',
				out,
			],
			{ signal },
		);
	} catch (e) {
		await rm(out, { force: true });
		const err = e as { code?: string; message?: string };
		throw new JobError(
			err.code === 'BINARY_MISSING' ? 'BINARY_MISSING' : 'UNSUPPORTED_MEDIA',
			`Cannot prepare the sound: ${(err.message ?? 'ffmpeg failed').slice(0, 300)}`,
		);
	}
	return out;
}
