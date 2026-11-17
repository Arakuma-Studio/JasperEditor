// WP6.5a item 6 (AGENTS §4: an export never silently changes what was asked): the requested container and audio codec
// are written when the codec fits them (H.264 + 24-bit PCM in MOV on the LGPL OpenH264 build), and what cannot be
// written as asked (ProRes in MP4, VP9 in MOV, PCM in MP4, AAC in a ProRes master…) is named in the plan's warnings
// and the job result (OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED), with the real container and audio codec.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ExportSettings, RenderPlan } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	type EncoderInventory,
	fitOutputFormat,
	outputFormatChanges,
	selectVideoEncoder,
} from '../src/tools/encoders.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFPROBE, type TestApp } from './helpers.ts';
import { writeBedFixture } from './sound-bed-fixture.ts';

const LGPL: EncoderInventory = {
	encoders: [
		'aac',
		'libopus',
		'pcm_s16le',
		'pcm_s24le',
		'prores_ks',
		'libopenh264',
		'libvpx-vp9',
		'libsvtav1',
	],
	hwaccels: [],
	license: 'lgpl',
	lgplOnly: true,
	hardware: [],
};
const NO_OPUS: EncoderInventory = { ...LGPL, encoders: LGPL.encoders.filter((e) => e !== 'libopus') };

describe('fitOutputFormat / selectVideoEncoder honour the requested container and audio', () => {
	it('H.264 goes into MOV with PCM when asked (it used to be MP4 + AAC whatever was asked)', () => {
		expect(fitOutputFormat('h264', 'export', true, { container: 'mov', audio: 'pcm' })).toEqual({
			container: 'mov',
			audioEncoder: 'pcm_s16le', // the planner writes 24-bit for an explicit PCM request (audioCodecOf)
		});
		const c = selectVideoEncoder(LGPL, { purpose: 'export', codec: 'h264', container: 'mov', audio: 'pcm' })!;
		expect(c).toMatchObject({ encoder: 'libopenh264', container: 'mov', audioEncoder: 'pcm_s16le' });
		expect(outputFormatChanges(c, { container: 'mov', audio: 'pcm' })).toEqual([]);
		// H.264 + AAC in MOV, HEVC in MOV
		expect(fitOutputFormat('h264', 'export', true, { container: 'mov', audio: 'aac' })).toEqual({
			container: 'mov',
			audioEncoder: 'aac',
		});
		expect(fitOutputFormat('hevc', 'export', true, { container: 'mov' }).container).toBe('mov');
		// Proxy files remain MP4 even when MOV and PCM were requested.
		expect(fitOutputFormat('h264', 'proxy', true, { container: 'mov', audio: 'pcm' })).toEqual({
			container: 'mp4',
			audioEncoder: 'aac',
		});
	});

	it('what does not fit is reported in words, never silently', () => {
		const prores = selectVideoEncoder(LGPL, {
			purpose: 'export',
			codec: 'prores',
			container: 'mp4',
			audio: 'aac',
		})!;
		expect(prores).toMatchObject({ container: 'mov', audioEncoder: 'pcm_s16le' });
		expect(outputFormatChanges(prores, { container: 'mp4', audio: 'aac' })).toMatchObject([
			{
				code: 'OUTPUT_CONTAINER_CHANGED',
				// the values, for editors that say it in their language (final carry-over cleanup, item 6)
				params: {
					requested: 'MP4',
					written: 'MOV',
					why: 'codec',
					codec: 'ProRes',
					accepts: 'H.264, HEVC, AV1, VP9',
				},
			},
			{
				code: 'AUDIO_CODEC_CHANGED',
				params: { requested: 'AAC', written: 'PCM', container: 'MOV', why: 'prores' },
			},
		]);
		const vp9 = selectVideoEncoder(LGPL, {
			purpose: 'export',
			codec: 'vp9',
			container: 'mov',
			audio: 'pcm',
		})!;
		expect(vp9.container).toBe('webm');
		expect(outputFormatChanges(vp9, { container: 'mov', audio: 'pcm' }).map((w) => w.code)).toEqual([
			'OUTPUT_CONTAINER_CHANGED',
			'AUDIO_CODEC_CHANGED',
		]);
		const pcmInMp4 = selectVideoEncoder(LGPL, {
			purpose: 'export',
			codec: 'h264',
			container: 'mp4',
			audio: 'pcm',
		})!;
		expect(pcmInMp4).toMatchObject({ container: 'mp4', audioEncoder: 'aac' });
		expect(outputFormatChanges(pcmInMp4, { container: 'mp4', audio: 'pcm' })).toMatchObject([
			{
				code: 'AUDIO_CODEC_CHANGED',
				params: { requested: 'PCM', written: 'AAC', container: 'MP4', why: 'container' },
			},
		]);
		const webm = selectVideoEncoder(NO_OPUS, {
			purpose: 'export',
			codec: 'vp9',
			container: 'webm',
			audio: 'opus',
		})!;
		expect(webm).toMatchObject({ container: 'mp4', audioEncoder: 'aac' });
		expect(outputFormatChanges(webm, { container: 'webm', audio: 'opus' })[0]).toMatchObject({
			code: 'OUTPUT_CONTAINER_CHANGED',
			params: { requested: 'WEBM', written: 'MP4', why: 'opus' },
		});
	});
});

let app: TestApp;
let dir: string;
let files: ReturnType<typeof writeBedFixture>;

beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-container-'));
	files = writeBedFixture(dir);
}, 120_000);
afterAll(closeApps);

async function doc() {
	const d = new DocBuilder('hd-1080p-30', 600);
	const music = d.addMedia(await register(app, files.music));
	d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 45, track: 'V1', color: [0.2, 0.4, 0.8, 1] },
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' } },
	]);
	return d;
}

function settings(d: DocBuilder, over: Partial<ExportSettings> = {}): ExportSettings {
	return {
		sequenceId: d.seqId,
		destination: { type: 'download' },
		range: { type: 'custom', startFrame: 0, endFrame: 45 },
		container: 'mov',
		video: {
			codec: 'h264',
			width: 320,
			height: 180,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 30 },
			encoderSpeed: 'fast',
		},
		audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
		engine: 'native',
		...over,
	};
}

async function plan(d: DocBuilder, over: Partial<ExportSettings> = {}): Promise<RenderPlan> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d, over) },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as RenderPlan;
}

function probeFile(file: string) {
	const r = spawnSync(TEST_FFPROBE, [
		'-v',
		'error',
		'-show_entries',
		'format=format_name:stream=codec_type,codec_name,sample_fmt,bits_per_raw_sample',
		'-of',
		'json',
		file,
	]);
	return JSON.parse(r.stdout.toString()) as {
		format: { format_name: string };
		streams: { codec_type: string; codec_name: string; bits_per_raw_sample?: string }[];
	};
}

describe('H.264 + PCM in MOV on a real engine (WP6.5a item 6)', { timeout: 300_000 }, () => {
	it('the plan names MOV and PCM and no change; the file is MOV with 24-bit PCM; the result says so', async () => {
		const d = await doc();
		const p = await plan(d);
		const codes = p.warnings.map((w) => w.code);
		expect(codes).not.toContain('OUTPUT_CONTAINER_CHANGED');
		expect(codes).not.toContain('AUDIO_CODEC_CHANGED');
		const encoder = (p as RenderPlan & { encoder?: { container: string; codec: string } }).encoder;
		if (encoder) expect(encoder).toMatchObject({ container: 'mov' });
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d) },
		});
		expect(start.statusCode, start.body).toBe(202);
		const job = (await coreServices(app).queue.wait((start.json() as EngineJob).id)) as EngineJob & {
			result: { container?: string; audioCodec?: string; warnings?: { code: string }[] };
		};
		expect(job.error, JSON.stringify(job.error)).toBeUndefined();
		expect(job.result).toMatchObject({ container: 'mov', audioCodec: 'pcm_s24le' });
		expect((job.result.warnings ?? []).map((w) => w.code)).not.toContain('OUTPUT_CONTAINER_CHANGED');
		const file = (await coreServices(app).exports.outputFile(job.id))!;
		expect(file.endsWith('.mov')).toBe(true);
		const info = probeFile(file);
		expect(info.format.format_name).toContain('mov');
		expect(info.streams.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264');
		expect(info.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('pcm_s24le');
	});

	it('PCM at 32 bits in MOV: the file holds 32-bit float PCM', async () => {
		const d = await doc();
		const s = settings(d, { audio: { codec: 'pcm', bitDepth: 32, sampleRate: 48000, channels: 2 } });
		expect((await plan(d, { audio: s.audio })).audio.codec).toBe('pcm_f32le');
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
		});
		expect(start.statusCode, start.body).toBe(202);
		const job = (await coreServices(app).queue.wait((start.json() as EngineJob).id)) as EngineJob & {
			result: { audioCodec?: string };
		};
		expect(job.error, JSON.stringify(job.error)).toBeUndefined();
		expect(job.result.audioCodec).toBe('pcm_f32le');
		const info = probeFile((await coreServices(app).exports.outputFile(job.id))!);
		expect(info.streams.find((x) => x.codec_type === 'audio')?.codec_name).toBe('pcm_f32le');
	});

	it('PCM asked in MP4: the plan and the job result say the audio is AAC', async () => {
		const d = await doc();
		const p = await plan(d, { container: 'mp4' });
		const w = p.warnings.find((x) => x.code === 'AUDIO_CODEC_CHANGED');
		expect(w?.params).toMatchObject({ requested: 'PCM', written: 'AAC', container: 'MP4', why: 'container' });
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d, { container: 'mp4' }) },
		});
		const job = (await coreServices(app).queue.wait((start.json() as EngineJob).id)) as EngineJob & {
			result: { container?: string; audioCodec?: string; warnings?: { code: string; message: string }[] };
		};
		expect(job.error, JSON.stringify(job.error)).toBeUndefined();
		expect(job.result).toMatchObject({ container: 'mp4', audioCodec: 'aac' });
		expect(job.result.warnings).toContainEqual(
			expect.objectContaining({
				code: 'AUDIO_CODEC_CHANGED',
				params: { requested: 'PCM', written: 'AAC', container: 'MP4', why: 'container' },
			}),
		);
	});
});
