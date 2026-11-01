// spec 18 AF-OPS-001: derivation ops on the engine (conform-cfr, reverse, denoise-audio, extract-audio,
// time-stretch, range) on lavfi-generated media, checked with ffprobe and decoded samples. LGPL-only mode.
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeriveResult, EngineJob, RegisteredMedia } from '@jasper/api';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	atempoFactors,
	concatArgs,
	concatList,
	type DeriveSource,
	denoiseAudioFilter,
	planDerive,
	REVERSE_MAX_SEGMENT_SEC,
	reverseSegmentFrames,
} from '../src/processing/derive-plan.ts';
import { assertLgplFilters } from '../src/processing/proc/filters.ts';
import {
	closeApps,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	TEST_FFPROBE,
	type TestApp,
	until,
} from './helpers.ts';

const H = { host: '127.0.0.1:47900' };
let app: TestApp;
let dir: string;
const media: Record<string, string> = {};

function ff(args: string[]): void {
	const r = spawnSync(TEST_FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr}`);
}

function probe(file: string, entries: string, select?: string): Record<string, string>[] {
	const r = spawnSync(
		TEST_FFPROBE,
		[
			'-v',
			'error',
			...(select ? ['-select_streams', select] : []),
			'-count_frames',
			'-show_entries',
			entries,
			'-of',
			'json',
			file,
		],
		{ encoding: 'utf8' },
	);
	if (r.status !== 0) throw new Error(r.stderr);
	const j = JSON.parse(r.stdout) as { streams?: Record<string, string>[] };
	return j.streams ?? [];
}

/** Mean luma (0…255) of every frame. */
function lumas(file: string): number[] {
	const r = spawnSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-i',
		file,
		'-map',
		'0:v:0',
		'-vf',
		'format=gray,scale=1:1:flags=area',
		'-f',
		'rawvideo',
		'-',
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return [...r.stdout];
}

/** Decoded samples of an audio stream as mono float32 (first channel). */
function samples(file: string, map = '0:a:0'): Float32Array {
	const r = spawnSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-map', map, '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-'],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	const b = r.stdout;
	return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

const rms = (a: Float32Array, from = 0, to = a.length) => {
	let s = 0;
	for (let i = from; i < to; i++) s += a[i]! * a[i]!;
	return Math.sqrt(s / Math.max(1, to - from));
};
const zeroCrossingsPerSec = (a: Float32Array, rate: number, from: number, to: number) => {
	let n = 0;
	for (let i = from + 1; i < to; i++) if (a[i - 1]! < 0 !== a[i]! < 0) n++;
	return n / 2 / ((to - from) / rate);
};

async function waitJob(id: string, timeoutMs = 240_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		100,
	);
}

async function derive(key: string, recipe: unknown) {
	return app.inject({
		method: 'POST',
		url: `/api/media/${key}/derive`,
		headers: JSON_H,
		payload: { projectId: 'prj_0000000000000001', recipe },
	});
}

async function deriveOk(key: string, recipe: unknown): Promise<{ result: DeriveResult; file: string }> {
	const r = await derive(key, recipe);
	expect(r.statusCode, r.body).toBe(202);
	const job = await waitJob((r.json() as EngineJob).id);
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	expect(job.kind).toBe('derive');
	const result = job.result as DeriveResult;
	const index = JSON.parse(readFileSync(join(app.appdir, 'engine', 'media-index.json'), 'utf8'));
	const rec = index.items[result.registered.mediaKey] as { storage: { path: string }; derivedFrom: unknown };
	expect(rec.derivedFrom).toMatchObject({ mediaKey: key, recipeHash: result.recipeHash });
	return { result, file: rec.storage.path };
}

const keys: Record<string, RegisteredMedia> = {};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-derive-'));
	// 4 s, 25 fps, 64×48, frame n has luma 16 + 2n; audio 0: stereo 48 kHz rising 440 Hz; audio 1: mono 44.1 kHz.
	media.cfr = join(dir, 'cfr.mov');
	ff([
		...['-f', 'lavfi', '-i', "color=c=black:s=64x48:r=25:d=4,format=gray,geq=lum='16+2*N',format=yuv420p"],
		...['-f', 'lavfi', '-i', "aevalsrc='0.9*(t/4)*sin(2*PI*440*t)|0.9*(t/4)*sin(2*PI*440*t)':s=48000:d=4"],
		...['-f', 'lavfi', '-i', 'sine=f=1000:r=44100:d=4'],
		...['-map', '0', '-map', '1', '-map', '2', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-f', 'mov', media.cfr],
	]);
	// variable frame rate: frames 0,1,2,5,6,7,… of a 30 fps count
	media.vfr = join(dir, 'vfr.mkv');
	ff([
		...[
			'-f',
			'lavfi',
			'-i',
			"color=c=black:s=64x48:r=30:d=4,format=gray,geq=lum='16+N',format=yuv420p,select='lt(mod(n\\,5)\\,3)'",
		],
		...['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=4'],
		...['-fps_mode', 'vfr', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', media.vfr],
	]);
	// audio only: 3 s mono 440 Hz rising, 48 kHz
	media.tone = join(dir, 'tone.wav');
	ff([
		'-f',
		'lavfi',
		'-i',
		"aevalsrc='0.9*(t/3)*sin(2*PI*440*t)':s=48000:d=3",
		'-c:a',
		'pcm_s16le',
		media.tone,
	]);
	// hiss (white noise, RMS ≈ −45 dBFS) throughout; a 440 Hz tone (RMS 0.21) from 1.5 s
	media.noisy = join(dir, 'noisy.wav');
	ff([
		...['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)*gte(t\\,1.5)':s=48000:d=3"],
		...['-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.01:d=3:c=white:s=7'],
		...['-filter_complex', '[0][1]amix=inputs=2:normalize=0', '-c:a', 'pcm_s24le', media.noisy],
	]);
	// video without audio
	media.silent = join(dir, 'silent.mkv');
	ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x48:r=25:d=1', '-c:v', 'ffv1', media.silent]);
	// a longer, larger video for cancellation (60 s 640×360)
	media.long = join(dir, 'long.mkv');
	ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=60', '-c:v', 'ffv1', '-level', '1', media.long]);
	app = await makeApp({ totalSlots: 4, env: { JASPER_FFMPEG_LGPL_ONLY: '1' } });
	for (const [k, p] of Object.entries(media)) keys[k] = await register(app, p);
}, 180_000);

afterAll(async () => {
	await closeApps();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('derivation plans (pure)', { timeout: 120_000 }, () => {
	it('chains atempo within 0.5…2 per instance and keeps the product', () => {
		for (const r of [0.25, 0.3, 0.5, 0.8, 1.5, 2, 3, 4]) {
			const f = atempoFactors(r);
			for (const x of f) expect(x >= 0.5 - 1e-9 && x <= 2 + 1e-9).toBe(true);
			expect(f.reduce((a, b) => a * b, 1)).toBeCloseTo(r, 9);
		}
		expect(atempoFactors(0.25)).toEqual([0.5, 0.5]);
		expect(atempoFactors(3)).toEqual([2, 1.5]);
	});

	it('maps denoise strength 0…1 to afftdn noise reduction 6…36 dB and floor −50…−30 dB', () => {
		expect(denoiseAudioFilter(0)).toBe('afftdn=nr=6:nf=-50:tn=0');
		expect(denoiseAudioFilter(0.5)).toBe('afftdn=nr=21:nf=-40:tn=0');
		expect(denoiseAudioFilter(1)).toBe('afftdn=nr=36:nf=-30:tn=0');
	});

	it('caps reverse segments by memory (≤ 512 MB of frames) and by 10 s', () => {
		expect(reverseSegmentFrames({ width: 64, height: 48, bitDepth: 8 }, 25)).toBe(
			REVERSE_MAX_SEGMENT_SEC * 25,
		);
		// 1080p 8-bit: 8.3 MB per frame → 64 frames; 4K 10-bit: 66 MB → 8 frames
		expect(reverseSegmentFrames({ width: 1920, height: 1080, bitDepth: 8 }, 30)).toBe(64);
		expect(reverseSegmentFrames({ width: 3840, height: 2160, bitDepth: 10 }, 30)).toBe(8);
	});

	it('every planned filter graph is LGPL and every input is local-only', () => {
		const src: DeriveSource = {
			path: '/m/in.mov',
			kind: 'video',
			video: {
				index: 0,
				type: 'video',
				codec: 'h264',
				width: 1920,
				height: 1080,
				pixelAspect: { num: 1, den: 1 },
				frameRate: { num: 30000, den: 1001 },
				pixelFormat: 'yuv420p',
				bitDepth: 8,
				color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
				browserDecodable: true,
			},
			audio: [
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			durationSec: 120,
			hasAlpha: false,
			variableFrameRate: false,
			inColor: ':in_color_matrix=bt709:in_range=tv',
			start: { format: 0, streams: { 0: 0, 1: 0 } },
		};
		const recipes = [
			{ op: 'conform-cfr', frameRate: { num: 25, den: 1 } },
			{ op: 'reverse' },
			{ op: 'denoise-audio', strength: 0.3 },
			{ op: 'extract-audio', streamIndex: 1, format: 'flac' },
			{ op: 'time-stretch', rate: 0.3, preservePitch: true },
			{ op: 'time-stretch', rate: 3, preservePitch: false },
			{ op: 'range', inFlicks: 10 * FLICKS_PER_SECOND, outFlicks: 20 * FLICKS_PER_SECOND },
		] as const;
		for (const recipe of recipes) {
			const plan = planDerive(src, recipe, '/out/x', '/scratch');
			for (const p of plan.passes) {
				const iIdx = p.args.indexOf('-i');
				expect(p.args.slice(0, 2)).toEqual(['-protocol_whitelist', 'file,crypto,data']);
				expect(iIdx).toBeGreaterThan(1);
				for (const flag of ['-vf', '-af', '-filter_complex']) {
					const at = p.args.indexOf(flag);
					if (at >= 0) expect(() => assertLgplFilters(p.args[at + 1]!)).not.toThrow();
				}
			}
		}
		// 120 s of 1080p at 29.97 reverse in segments of ≤ 64 frames, last segment first
		const rev = planDerive(src, { op: 'reverse' }, '/out/x', '/scratch');
		expect(rev.passes.length).toBe(Math.ceil(Math.round(120 * (30000 / 1001)) / 64));
		expect(rev.concat![0]).toBe(rev.passes[0]!.out);
		expect(rev.passes[0]!.out > rev.passes.at(-1)!.out).toBe(true);
		expect(concatArgs('/s/l.txt', rev.output).slice(0, 2)).toEqual([
			'-protocol_whitelist',
			'file,crypto,data',
		]);
		expect(concatList(["/a/it's.mov"])).toBe("file '/a/it'\\''s.mov'\n");
	});

	it('segmented reverse (forced small segments) mirrors frames and samples exactly', () => {
		const out = join(dir, 'plan-rev');
		mkdirSync(out, { recursive: true });
		const reg = keys.cfr!;
		const src: DeriveSource = {
			path: media.cfr!,
			kind: 'video',
			video: reg.probe.streams.find((s) => s.type === 'video') as never,
			audio: reg.probe.streams.filter((s) => s.type === 'audio') as never,
			durationSec: 4,
			hasAlpha: false,
			variableFrameRate: false,
			inColor: ':in_color_matrix=bt709:in_range=tv',
			start: { format: 0, streams: {} },
		};
		const plan = planDerive(src, { op: 'reverse' }, join(out, 'rev.mov'), out, { reverseSegmentFrames: 15 });
		expect(plan.passes.length).toBe(7); // 100 frames / 15
		for (const p of plan.passes) ff([...p.args, p.out]);
		writeFileSync(join(out, 'list.txt'), concatList(plan.concat!));
		ff([...concatArgs(join(out, 'list.txt'), plan.output), join(out, 'rev.mov')]);
		const a = lumas(media.cfr!);
		const b = lumas(join(out, 'rev.mov'));
		expect(b.length).toBe(100);
		expect(b).toEqual([...a].reverse());
		const sa = samples(media.cfr!);
		const sb = samples(join(out, 'rev.mov'));
		expect(sb.length).toBe(sa.length);
		let maxErr = 0;
		for (let i = 0; i < sa.length; i++) maxErr = Math.max(maxErr, Math.abs(sb[i]! - sa[sa.length - 1 - i]!));
		expect(maxErr).toBeLessThan(1e-4);
	}, 120_000);
});

describe('derive jobs (AF-OPS-001)', { timeout: 240_000 }, () => {
	it('conform-cfr makes a variable-rate video constant-rate with the audio kept', async () => {
		const { result, file } = await deriveOk(keys.vfr!.mediaKey, {
			op: 'conform-cfr',
			frameRate: { num: 25, den: 1 },
		});
		expect(result.registered.probe.variableFrameRate).toBe(false);
		const [v] = probe(file, 'stream=codec_name,r_frame_rate,avg_frame_rate,nb_read_frames', 'v:0');
		expect(v).toMatchObject({ codec_name: 'prores', r_frame_rate: '25/1', avg_frame_rate: '25/1' });
		expect(Math.abs(Number(v!.nb_read_frames) - 100)).toBeLessThanOrEqual(2);
		// every frame lasts exactly 1/25 s
		const pk = spawnSync(
			TEST_FFPROBE,
			['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
			{ encoding: 'utf8' },
		);
		const pts = pk.stdout.trim().split('\n').map(Number);
		for (let i = 1; i < pts.length; i++) expect(pts[i]! - pts[i - 1]!).toBeCloseTo(0.04, 5);
		const [a] = probe(file, 'stream=codec_name,duration', 'a:0');
		expect(a!.codec_name).toBe('pcm_s24le');
		expect(Math.abs(Number(a!.duration) - 4)).toBeLessThan(0.05);
		expect(result.registered.originalName).toBe('vfr [Conformed 25 fps].mov');
	});

	it('reverse: the first output frame is the last input frame; audio reversed; reused on a second run', async () => {
		const { result, file } = await deriveOk(keys.cfr!.mediaKey, { op: 'reverse' });
		const a = lumas(media.cfr!);
		const b = lumas(file);
		expect(b.length).toBe(a.length);
		expect(b[0]).toBe(a.at(-1));
		expect(b.at(-1)).toBe(a[0]);
		expect(b).toEqual([...a].reverse());
		const s = samples(file);
		expect(rms(s, 0, 4800)).toBeGreaterThan(rms(s, s.length - 4800) * 5); // the rising ramp now falls
		// both audio streams are carried
		expect(probe(file, 'stream=codec_name', 'a').map((x) => x.codec_name)).toEqual([
			'pcm_s24le',
			'pcm_s24le',
		]);
		expect(result.reused).toBe(false);
		const again = await deriveOk(keys.cfr!.mediaKey, { op: 'reverse' });
		expect(again.result.reused).toBe(true);
		expect(again.result.registered.mediaKey).toBe(result.registered.mediaKey);
		expect(again.result.recipeHash).toBe(result.recipeHash);
	});

	it('reverse of an audio file', async () => {
		const { file } = await deriveOk(keys.tone!.mediaKey, { op: 'reverse' });
		const sa = samples(media.tone!);
		const sb = samples(file);
		expect(sb.length).toBe(sa.length);
		expect(sb[100]).toBeCloseTo(sa[sa.length - 101]!, 4);
		expect(file.endsWith('.wav')).toBe(true);
	});

	it('denoise-audio writes a 24-bit WAV with the noise reduced', async () => {
		const { result, file } = await deriveOk(keys.noisy!.mediaKey, { op: 'denoise-audio', strength: 0.5 });
		const [a] = probe(file, 'stream=codec_name,sample_rate,duration');
		expect(a).toMatchObject({ codec_name: 'pcm_s24le', sample_rate: '48000' });
		expect(Math.abs(Number(a!.duration) - 3)).toBeLessThan(0.02);
		const before = samples(media.noisy!);
		const after = samples(file);
		// the hiss alone drops by more than 15 dB; the tone (with hiss) keeps its level within 1 %
		expect(rms(after, 12000, 60000)).toBeLessThan(rms(before, 12000, 60000) * 10 ** (-15 / 20));
		expect(rms(after, 96000, 140000)).toBeCloseTo(rms(before, 96000, 140000), 2);
		expect(result.notes[0]).toContain('afftdn=nr=21:nf=-40:tn=0');
	});

	it('extract-audio writes the chosen stream as FLAC or 24-bit WAV', async () => {
		const flac = await deriveOk(keys.cfr!.mediaKey, { op: 'extract-audio', streamIndex: 2, format: 'flac' });
		expect(probe(flac.file, 'stream=codec_name,sample_rate,channels')).toEqual([
			{ codec_name: 'flac', sample_rate: '44100', channels: 1 } as never,
		]);
		expect(flac.result.registered.originalName).toBe('cfr [Audio stream 2].flac');
		const wav = await deriveOk(keys.cfr!.mediaKey, { op: 'extract-audio', streamIndex: 1, format: 'wav' });
		expect(probe(wav.file, 'stream=codec_name,sample_rate,channels')).toEqual([
			{ codec_name: 'pcm_s24le', sample_rate: '48000', channels: 2 } as never,
		]);
	});

	it('time-stretch 2× keeping pitch halves the duration (picture and sound) at the same frequency', async () => {
		const { file } = await deriveOk(keys.cfr!.mediaKey, { op: 'time-stretch', rate: 2, preservePitch: true });
		const [v] = probe(file, 'stream=r_frame_rate,nb_read_frames', 'v:0');
		expect(v!.r_frame_rate).toBe('25/1');
		expect(Math.abs(Number(v!.nb_read_frames) - 50)).toBeLessThanOrEqual(1);
		const [a] = probe(file, 'stream=duration', 'a:0');
		expect(Math.abs(Number(a!.duration) - 2)).toBeLessThan(0.01);
		const s = samples(file, '0:a:1');
		expect(zeroCrossingsPerSec(s, 44100, 4410, 70560)).toBeGreaterThan(990);
		expect(zeroCrossingsPerSec(s, 44100, 4410, 70560)).toBeLessThan(1010);
		// the picture plays twice as fast: output frame k shows source frame 2k
		const l = lumas(file);
		const src = lumas(media.cfr!);
		expect(Math.abs(l[10]! - src[20]!)).toBeLessThanOrEqual(1);
	});

	it('time-stretch 0.5× without pitch resamples: twice as long, an octave down', async () => {
		const { file } = await deriveOk(keys.tone!.mediaKey, {
			op: 'time-stretch',
			rate: 0.5,
			preservePitch: false,
		});
		const [a] = probe(file, 'stream=duration,sample_rate');
		expect(a!.sample_rate).toBe('48000');
		expect(Math.abs(Number(a!.duration) - 6)).toBeLessThan(0.01);
		const s = samples(file);
		const zc = zeroCrossingsPerSec(s, 48000, 48000, 240000);
		expect(zc).toBeGreaterThan(215);
		expect(zc).toBeLessThan(225);
	});

	it('time-stretch 0.25× keeping pitch (atempo chain)', async () => {
		const { file } = await deriveOk(keys.tone!.mediaKey, {
			op: 'time-stretch',
			rate: 0.25,
			preservePitch: true,
		});
		const [a] = probe(file, 'stream=duration');
		expect(Math.abs(Number(a!.duration) - 12)).toBeLessThan(0.01);
		const zc = zeroCrossingsPerSec(samples(file), 48000, 96000, 480000);
		expect(Math.abs(zc - 440)).toBeLessThan(10);
	});

	it('range trims exactly the frames starting in [in, out) and records them', async () => {
		const { result, file } = await deriveOk(keys.cfr!.mediaKey, {
			op: 'range',
			inFlicks: FLICKS_PER_SECOND,
			outFlicks: 2 * FLICKS_PER_SECOND,
		});
		expect(result.range).toEqual({ startFrame: 25, endFrame: 50 });
		const l = lumas(file);
		const src = lumas(media.cfr!);
		expect(l).toEqual(src.slice(25, 50));
		const [a] = probe(file, 'stream=duration', 'a:0');
		expect(Math.abs(Number(a!.duration) - 1)).toBeLessThan(0.001);
		const sa = samples(media.cfr!);
		const sb = samples(file);
		expect(sb.length).toBe(48000);
		expect(sb[10]).toBeCloseTo(sa[48010]!, 4);
	});

	it('range of an audio file is sample-exact', async () => {
		const { result, file } = await deriveOk(keys.tone!.mediaKey, {
			op: 'range',
			inFlicks: FLICKS_PER_SECOND / 2,
			outFlicks: 2 * FLICKS_PER_SECOND,
		});
		expect(result.range).toBeUndefined();
		const sb = samples(file);
		expect(sb.length).toBe(72000);
		expect(sb[0]).toBeCloseTo(samples(media.tone!)[24000]!, 4);
	});

	it('refuses with coded errors', async () => {
		const code = async (key: string, recipe: unknown) => {
			const r = await derive(key, recipe);
			return `${r.statusCode} ${(r.json() as { code?: string; error?: { code: string } }).error?.code ?? (r.json() as { code?: string }).code}`;
		};
		expect(await code(keys.silent!.mediaKey, { op: 'denoise-audio', strength: 0.5 })).toBe('422 NO_AUDIO');
		expect(await code(keys.cfr!.mediaKey, { op: 'extract-audio', streamIndex: 0, format: 'wav' })).toBe(
			'422 NO_AUDIO',
		);
		expect(await code(keys.cfr!.mediaKey, { op: 'time-stretch', rate: 8, preservePitch: true })).toBe(
			'422 UNSUPPORTED_RATE',
		);
		expect(await code(keys.cfr!.mediaKey, { op: 'conform-cfr', frameRate: { num: 1000, den: 1 } })).toBe(
			'422 UNSUPPORTED_RATE',
		);
		expect(
			await code(keys.cfr!.mediaKey, { op: 'range', inFlicks: 0, outFlicks: 5 * FLICKS_PER_SECOND }),
		).toBe('422 OUT_OF_RANGE');
		expect(
			await code(keys.cfr!.mediaKey, {
				op: 'range',
				inFlicks: FLICKS_PER_SECOND,
				outFlicks: FLICKS_PER_SECOND,
			}),
		).toBe('422 EMPTY_RANGE');
		expect(await code(keys.tone!.mediaKey, { op: 'conform-cfr', frameRate: { num: 25, den: 1 } })).toBe(
			'422 UNSUPPORTED_MEDIA',
		);
		// unknown keys and ops are validation errors
		expect((await derive(keys.cfr!.mediaKey, { op: 'reverse', extra: 1 })).statusCode).toBe(400);
		expect(
			(await derive(keys.cfr!.mediaKey, { op: 'stabilize', smoothing: 1, crop: 'keep' })).statusCode,
		).toBe(400);
		// offline media
		const copy = join(dir, 'gone.wav');
		ff(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=1', '-c:a', 'pcm_s16le', copy]);
		const gone = await register(app, copy);
		rmSync(copy);
		expect(await code(gone.mediaKey, { op: 'reverse' })).toBe('422 MEDIA_OFFLINE');
	});

	it('a cancelled job leaves no partial output', async () => {
		const r = await derive(keys.long!.mediaKey, { op: 'reverse' });
		expect(r.statusCode).toBe(202);
		const id = (r.json() as EngineJob).id;
		await until(
			async () => {
				const j = (
					await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })
				).json() as EngineJob;
				return j.state === 'running' ? j : null;
			},
			60_000,
			20,
		);
		await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H });
		const done = await waitJob(id);
		expect(done.state).toBe('cancelled');
		const processed = join(app.appdir, 'media', 'processed');
		const leftovers: string[] = [];
		const walk = (d: string) => {
			if (!existsSync(d)) return;
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(d, e.name));
				else if (e.name.startsWith('.partial-')) leftovers.push(join(d, e.name));
			}
		};
		walk(processed);
		expect(leftovers).toEqual([]);
		expect(existsSync(join(app.appdir, 'tmp', id))).toBe(false);
	});
});
