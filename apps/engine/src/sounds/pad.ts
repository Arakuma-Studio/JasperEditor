// Lead silence for registered library sounds (spec 12 §2.3; wp-note "Phase 1 verification"): a sound whose head is
// not quiet would play up to one frame late when its peak falls between frames, because placement can take the
// sub-frame rest out of the In point only where the head is silent. Registering such a sound into a project therefore
// writes a copy with `LIBRARY_LEAD_SILENCE_SEC` (whole samples) of digital silence in front of it, as PCM WAV: the
// decoded samples bit for bit (32-bit float holds every 16/24-bit and float decoder output exactly), so nothing is
// re-encoded lossily. Deterministic (`-bitexact`, no metadata): the same file gives the same bytes, so the media
// registry and the project dedupe repeated registrations by fingerprint.
import { mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { LOCAL_PROTOCOLS } from './decode.ts';

const PAD_TIMEOUT_MS = 120_000;

/** Codecs written as they are (lossless PCM wider than float32 would lose bits); everything else → pcm_f32le. */
const KEEP_CODECS = new Set(['pcm_s32le', 'pcm_f64le']);

/** Codec and sample rate of the first audio stream (null fields when ffprobe does not say). */
export async function probeAudioStream(
	ff: Ffmpeg,
	path: string,
	signal?: AbortSignal,
): Promise<{ codec: string | null; sampleRate: number | null }> {
	let j: Record<string, unknown>;
	try {
		j = await ff.probeJson(
			[...LOCAL_PROTOCOLS, '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate', path],
			{ signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)].filter((s): s is AbortSignal => !!s)) },
		);
	} catch (e) {
		const err = e as { code?: string; message?: string };
		throw new JobError(
			err.code === 'BINARY_MISSING' ? 'BINARY_MISSING' : 'UNSUPPORTED_MEDIA',
			`Cannot read the sound: ${(err.message ?? 'ffprobe failed').slice(0, 300)}`,
		);
	}
	const s = (j.streams as { codec_name?: unknown; sample_rate?: unknown }[] | undefined)?.[0];
	const rate = Number(s?.sample_rate);
	return {
		codec: typeof s?.codec_name === 'string' ? s.codec_name.slice(0, 64) : null,
		sampleRate: Number.isFinite(rate) && rate > 0 ? Math.round(rate) : null,
	};
}

/** The managed file name of a padded sound: the library file's stem, `.wav`. */
export function paddedFileName(libraryFile: string): string {
	const stem = basename(libraryFile, extname(libraryFile))
		.replace(/[^\p{L}\p{N} ._-]/gu, '_')
		.slice(0, 120);
	return `${stem || 'sound'}.wav`;
}

/**
 * Writes `<tmpDir>/<unique>.wav`: `samples` of silence, then the first audio stream of `path` at its own rate and
 * channel count. Returns the temp file (the caller registers or deletes it). `codec` is the source's audio codec.
 */
export async function writePaddedSound(
	ff: Ffmpeg,
	opts: { path: string; samples: number; codec: string | null; tmpDir: string; signal?: AbortSignal },
): Promise<string> {
	if (!Number.isSafeInteger(opts.samples) || opts.samples <= 0 || opts.samples > 1_000_000)
		throw new JobError('E_INVALID_PARAM', 'Bad lead-silence length');
	await mkdir(opts.tmpDir, { recursive: true });
	const out = join(opts.tmpDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
	const codec = opts.codec && KEEP_CODECS.has(opts.codec) ? opts.codec : 'pcm_f32le';
	const signal = AbortSignal.any(
		[opts.signal, AbortSignal.timeout(PAD_TIMEOUT_MS)].filter((s): s is AbortSignal => !!s),
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
				'-af',
				`adelay=delays=${opts.samples}S:all=1`,
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
