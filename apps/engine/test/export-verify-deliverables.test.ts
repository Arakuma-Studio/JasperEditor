// Verification of GIF and audio-only exports (spec 18 AF-VER-001 × AF-EXP): real GIF / WAV / FLAC / M4A exports through
// the engine are verified with the checks that fit the file — a GIF has no sound rows and is checked against its GIF
// rate, size and frame count; an audio file has no picture rows and is checked against its codec, rate, channels and
// bit depth, with loudness as for video. A delivery target on them is refused by code (platform presets are video).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob, ExportSettings, ExportVerifyResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
	tempAppdir,
} from './helpers.ts';

let app: TestApp;
let d: DocBuilder;
const dir = tempAppdir('jasper-verify-deliverables-');

function shot(name: string, color: string): string {
	const out = join(dir, name);
	execFileSync(TEST_FFMPEG, [
		...['-v', 'error', '-y'],
		...['-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=2`],
		...['-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*440*t):s=48000:d=2'],
		...['-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', out],
	]);
	return out;
}

beforeAll(async () => {
	app = await makeApp({ env: { JASPER_FFMPEG_LGPL_ONLY: '1', JASPER_HW_ENCODERS: '0' } });
	d = new DocBuilder('hd-1080p-30', 700);
	d.tx([{ type: 'sequence.updateSettings', settings: { width: 640, height: 360 } }]);
	const a = d.addMedia(await register(app, shot('a.mov', '0x707070')));
	const b = d.addMedia(await register(app, shot('b.mov', '0x909090')));
	// a 0–30, b 30–60 (a cut at 1 s; 440 Hz whole cycles: the sound is continuous across it)
	d.tx([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 30,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
		},
	]);
}, 120_000);
afterAll(closeApps);

const settings = (over: Partial<ExportSettings>): ExportSettings => ({
	sequenceId: d.seqId,
	destination: { type: 'download' },
	range: { type: 'entire' },
	container: 'gif',
	engine: 'auto',
	...over,
});

async function exportJob(s: ExportSettings): Promise<string> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	return job.id;
}

async function verify(id: string, body: Record<string, unknown> = {}): Promise<ExportVerifyResult> {
	const r = await app.inject({
		method: 'POST',
		url: `/api/exports/${id}/verify`,
		headers: JSON_H,
		payload: body,
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	return job.result as ExportVerifyResult;
}

const ids = (r: ExportVerifyResult) => r.rows.map((x) => [x.id, x.kind, x.status]);

describe('verify_export on GIF and audio-only exports', () => {
	it('a GIF: picture rows at the GIF rate, size and frame count; no sound rows', {
		timeout: 300_000,
	}, async () => {
		const id = await exportJob(settings({ container: 'gif', gif: { fps: 15, width: 320 } }));
		// the record describes the GIF, not its ProRes intermediate
		const rec = JSON.parse(readFileSync(join(app.appdir, 'renders', id, 'verify.json'), 'utf8'));
		expect(rec).toMatchObject({
			deliverable: 'gif',
			fps: { num: 30, den: 1 },
			expected: {
				container: 'gif',
				video: {
					codec: 'gif',
					width: 320,
					height: 180,
					frameRate: { num: 15, den: 1 },
					frames: 30,
					pixFmt: null,
				},
				audio: null,
			},
			normalize: null,
		});
		const r = await verify(id);
		expect(r.deliverable).toBe('gif');
		expect(ids(r)).toEqual([
			['decode', 'format', 'pass'],
			['streams', 'format', 'pass'],
			['duration', 'format', 'pass'],
			['uncovered-video', 'judgement', 'pass'],
			['cut-black', 'judgement', 'pass'],
			['cut-flash', 'judgement', 'pass'],
		]);
		const streams = r.rows.find((x) => x.id === 'streams')!;
		expect(streams.expected).toBe('gif 320×180 15 fps; no audio');
		const duration = r.rows.find((x) => x.id === 'duration')!;
		expect(duration).toMatchObject({ measured: 30, expected: 30, tolerance: 0 });
		expect(r.rows.find((x) => x.id === 'cut-black')!.message).toMatch(/^1 cut checked/);
		expect(r.verified).toBe(true);
		const fast = await verify(id, { checks: 'fast' });
		expect(ids(fast)).toEqual([
			['streams', 'format', 'pass'],
			['duration', 'format', 'pass'],
			['uncovered-video', 'judgement', 'pass'],
		]);
	});

	it('WAV 16 / 24, FLAC and M4A: sound rows against codec, rate, channels and bit depth; no picture rows', {
		timeout: 600_000,
	}, async () => {
		const audio = (
			over: Partial<NonNullable<ExportSettings['audio']>>,
		): NonNullable<ExportSettings['audio']> => ({
			codec: 'pcm',
			sampleRate: 48000,
			channels: 2,
			normalize: { targetLufs: -20, truePeakDb: -1 },
			...over,
		});
		const cases: { s: Partial<ExportSettings>; expected: string }[] = [
			{
				s: { container: 'wav', audio: audio({ bitDepth: 16 }) },
				expected: 'no video; pcm_s16le 48000 Hz 2 ch 16-bit',
			},
			{ s: { container: 'wav', audio: audio({}) }, expected: 'no video; pcm_s24le 48000 Hz 2 ch 24-bit' },
			{
				s: {
					container: 'flac',
					audio: audio({ codec: 'flac', bitDepth: 16, sampleRate: 44100, channels: 1 }),
				},
				expected: 'no video; flac 44100 Hz 1 ch 16-bit',
			},
			{
				s: { container: 'm4a', audio: audio({ codec: 'aac', bitrateKbps: 192 }) },
				expected: 'no video; aac 48000 Hz 2 ch',
			},
		];
		for (const c of cases) {
			const id = await exportJob(settings(c.s));
			const rec = JSON.parse(readFileSync(join(app.appdir, 'renders', id, 'verify.json'), 'utf8'));
			expect(rec.expected, c.expected).toMatchObject({ container: c.s.container, video: null });
			const r = await verify(id);
			expect(r.deliverable, c.expected).toBe('audio');
			expect(ids(r), c.expected).toEqual([
				['decode', 'format', 'pass'],
				['streams', 'format', 'pass'],
				['duration', 'format', 'pass'],
				['cut-click', 'judgement', 'pass'],
				['loudness', 'judgement', 'pass'],
				['true-peak', 'format', 'pass'],
				['silence', 'judgement', 'pass'],
			]);
			expect(r.rows.find((x) => x.id === 'streams')!.expected).toBe(c.expected);
			expect(r.rows.find((x) => x.id === 'loudness')).toMatchObject({ expected: -20 });
			expect(r.verified, c.expected).toBe(true);
		}
	});

	it('refuses a delivery target on a GIF or an audio file by code', { timeout: 300_000 }, async () => {
		const id = await exportJob(
			settings({ container: 'm4a', audio: { codec: 'aac', sampleRate: 48000, channels: 2 } }),
		);
		const r = await app.inject({
			method: 'POST',
			url: `/api/exports/${id}/verify`,
			headers: JSON_H,
			payload: { target: 'youtube' },
		});
		expect(r.statusCode).toBe(400);
		expect(r.json()).toMatchObject({ code: 'TARGET_NOT_APPLICABLE' });
		expect(r.json().message).toMatch(/M4A/);
		const gif = await exportJob(settings({ container: 'gif', gif: { fps: 10, width: 160 } }));
		const g = await app.inject({
			method: 'POST',
			url: `/api/exports/${gif}/verify`,
			headers: JSON_H,
			payload: { target: 'youtube-shorts', checks: 'fast' },
		});
		expect(g.statusCode).toBe(400);
		expect(g.json()).toMatchObject({ code: 'TARGET_NOT_APPLICABLE' });
	});
});
