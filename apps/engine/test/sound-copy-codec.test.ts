// WP6.5b: the managed copy of a library sound is written in the narrowest PCM WAV that holds the decoder's samples
// exactly (`copyCodecFor`): 16-bit sources stay 16-bit (half the size of the float copies registering wrote before),
// 24-bit ones (WAV or FLAC) 24-bit, float decoders (every lossy codec) float. Each copy decodes to the source's full
// decode bit for bit, and an ffmpeg input seek (what every export path does at a clip's In point) at many In points
// lands on the same samples. FLAC was considered and rejected for the copies (wp-note: browsers decode WAV PCM in
// mediabunny's JS everywhere; FLAC goes through WebCodecs, measured not bit-exact for 16-bit in Google Chrome 150).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyCodecFor, estimateCopyBytes, probeAudioStream, writePaddedSound } from '../src/sounds/pad.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { TEST_FFMPEG, TEST_FFPROBE, tempAppdir } from './helpers.ts';

const SR = 48_000;
const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });

function gen(file: string, codecArgs: string[], seconds = 4): void {
	execFileSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`anoisesrc=d=${seconds}:c=pink:r=${SR}:a=0.4:s=11,aformat=channel_layouts=stereo`,
		...codecArgs,
		file,
	]);
}

function decode(file: string, seekSample?: number, frames?: number): Buffer {
	return execFileSync(
		TEST_FFMPEG,
		[
			'-v',
			'error',
			...(seekSample !== undefined ? ['-ss', (seekSample / SR).toFixed(9)] : []),
			'-i',
			file,
			'-map',
			'0:a:0',
			...(frames !== undefined ? ['-t', (frames / SR).toFixed(9)] : []),
			'-f',
			'f32le',
			'-',
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
}

function codecOf(file: string): string {
	return execFileSync(TEST_FFPROBE, [
		'-v',
		'error',
		'-select_streams',
		'a:0',
		'-show_entries',
		'stream=codec_name',
		'-of',
		'csv=p=0',
		file,
	])
		.toString()
		.trim();
}

describe('copyCodecFor', () => {
	it('picks the narrowest exact PCM from the decoder output', () => {
		expect(copyCodecFor({ sampleFmt: 's16' })).toBe('pcm_s16le');
		expect(copyCodecFor({ sampleFmt: 's16p' })).toBe('pcm_s16le');
		expect(copyCodecFor({ sampleFmt: 'u8' })).toBe('pcm_s16le');
		expect(copyCodecFor({ sampleFmt: 's32', bitsPerRawSample: 24 })).toBe('pcm_s24le');
		expect(copyCodecFor({ sampleFmt: 's32p', bitsPerRawSample: 20 })).toBe('pcm_s24le');
		expect(copyCodecFor({ sampleFmt: 's32', bitsPerRawSample: 32 })).toBe('pcm_s32le');
		expect(copyCodecFor({ sampleFmt: 's32' })).toBe('pcm_s32le');
		expect(copyCodecFor({ sampleFmt: 'fltp' })).toBe('pcm_f32le');
		expect(copyCodecFor({ sampleFmt: 'dbl' })).toBe('pcm_f64le');
		expect(copyCodecFor({ sampleFmt: null })).toBe('pcm_f32le');
		expect(copyCodecFor({ sampleFmt: 'weird' })).toBe('pcm_f32le');
		expect(copyCodecFor({})).toBe('pcm_f32le');
	});

	it('estimates the copy size (header and one spare second included) and never returns NaN', () => {
		expect(estimateCopyBytes(10, SR, 2, 'pcm_s16le')).toBe(11 * SR * 2 * 2 + 4096);
		expect(estimateCopyBytes(10, SR, 2, 'pcm_s24le')).toBe(11 * SR * 2 * 3 + 4096);
		expect(estimateCopyBytes(10, SR, 1, 'pcm_f32le')).toBe(11 * SR * 4 + 4096);
		for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY * 0])
			expect(estimateCopyBytes(bad, SR, 2, 'pcm_f32le')).toBe(0);
		expect(estimateCopyBytes(1, Number.NaN, 2, 'pcm_f32le')).toBe(0);
	});
});

describe('copies are the full decode, seek-exact at any In point', { timeout: 300_000 }, () => {
	const dir = tempAppdir('jasper-copy-codec-');
	const cases: [string, string[], string][] = [
		['s16.wav', ['-c:a', 'pcm_s16le'], 'pcm_s16le'],
		['s24.wav', ['-c:a', 'pcm_s24le'], 'pcm_s24le'],
		['s16.flac', ['-c:a', 'flac', '-sample_fmt', 's16'], 'pcm_s16le'],
		['s24.flac', ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], 'pcm_s24le'],
		['f32.wav', ['-c:a', 'pcm_f32le'], 'pcm_f32le'],
		['vorbis.ogg', ['-c:a', 'libvorbis', '-q:a', '4'], 'pcm_f32le'],
	];
	const vorbis = execFileSync(TEST_FFMPEG, ['-hide_banner', '-encoders']).toString().includes('libvorbis');
	it.each(cases)('%s → %s copy with lead and trailing silence', async (name, args, want) => {
		const src = join(dir, name);
		gen(src, name === 'vorbis.ogg' && !vorbis ? ['-c:a', 'vorbis', '-strict', '-2'] : args);
		const stream = await probeAudioStream(ff, src);
		const outCodec = copyCodecFor(stream);
		expect(outCodec).toBe(want);
		const lead = 2400;
		const trail = 2400;
		const copy = await writePaddedSound(ff, {
			path: src,
			samples: lead,
			trailSamples: trail,
			codec: stream.codec,
			outCodec,
			durationSec: 4,
			tmpDir: join(dir, 'tmp'),
		});
		expect(codecOf(copy)).toBe(want);
		const full = decode(src);
		const whole = decode(copy);
		const ch = 2;
		const b = 4 * ch;
		expect(whole.length).toBe(full.length + (lead + trail) * b);
		expect(whole.subarray(0, lead * b).every((x) => x === 0)).toBe(true);
		expect(whole.subarray(lead * b, lead * b + full.length).equals(full)).toBe(true);
		expect(whole.subarray(lead * b + full.length).every((x) => x === 0)).toBe(true);
		// In points: the edges of the lead, sample 1, block-ish boundaries and a spread over the sound
		const points = [0, 1, lead - 1, lead, lead + 1, 4095, 4096, 4097, 4608, 12_345, 48_000, 96_017];
		for (let k = 0; k < 12; k++) points.push(lead + Math.floor(((k + 0.37) / 12) * (full.length / b - 6000)));
		for (const at of points) {
			const n = 2000;
			const seeked = decode(copy, at, n).subarray(0, n * b);
			expect(seeked.length, `${name} at ${at}`).toBe(n * b);
			expect(seeked.equals(whole.subarray(at * b, (at + n) * b)), `${name} seeked at sample ${at}`).toBe(
				true,
			);
		}
		// 16-bit sources: half the bytes of the float copy registering wrote before
		if (want === 'pcm_s16le') {
			const f32 = await writePaddedSound(ff, {
				path: src,
				samples: lead,
				trailSamples: trail,
				codec: stream.codec,
				tmpDir: join(dir, 'tmp'),
			});
			expect(codecOf(f32)).toBe('pcm_f32le');
			expect(statSync(copy).size).toBeLessThan(statSync(f32).size * 0.51);
		}
		// deterministic: the same source gives the same bytes
		const again = await writePaddedSound(ff, {
			path: src,
			samples: lead,
			trailSamples: trail,
			codec: stream.codec,
			outCodec,
			durationSec: 4,
			tmpDir: join(dir, 'tmp'),
		});
		expect(readFileSync(again).equals(readFileSync(copy))).toBe(true);
	});
});
