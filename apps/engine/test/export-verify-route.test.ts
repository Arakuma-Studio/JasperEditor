// The export-verify job through the engine's routes (spec 18 AF-VER-001): an export records its verification context
// (the cut list with intended black), POST /api/exports/:jobId/verify verifies it, refusals are coded. The clips are
// 640×360 in a 1080p sequence (a picture covering 11 % of the frame still makes cuts for verification).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportVerifyResult } from '@jasper/api';
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
const dir = tempAppdir('jasper-verify-route-');
beforeAll(async () => {
	app = await makeApp({ env: { JASPER_FFMPEG_LGPL_ONLY: '1', JASPER_HW_ENCODERS: '0' } });
}, 120_000);
afterAll(closeApps);

function shot(name: string, color: string, hz: number): string {
	const out = join(dir, name);
	execFileSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`color=c=${color}:s=640x360:r=30:d=2`,
		'-f',
		'lavfi',
		'-i',
		`aevalsrc=0.1*sin(2*PI*${hz}*t)|0.1*sin(2*PI*${hz}*t):s=48000:d=2`,
		'-c:v',
		'mpeg4',
		'-q:v',
		'3',
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		out,
	]);
	return out;
}

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 28 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

describe('POST /api/exports/:jobId/verify', () => {
	it('records the cut list at export and verifies the file', { timeout: 300_000 }, async () => {
		const a = await register(app, shot('a.mp4', '0x707070', 440));
		const b = await register(app, shot('b.mp4', '0x909090', 440));
		const d = new DocBuilder();
		const ma = d.addMedia(a);
		const mb = d.addMedia(b);
		// a at 0–45, b at 45–90 (a cut), a 15-frame gap, a at 105–150 (cut to and from black)
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: ma },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 45 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: mb },
				at: 45,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 45 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: ma },
				at: 105,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 45 } },
			},
		]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(start.statusCode).toBe(202);
		const exportJob = await coreServices(app).queue.wait(start.json().id);
		expect(exportJob.state).toBe('succeeded');
		const ctx = JSON.parse(
			readFileSync(join(app.appdir, 'renders', exportJob.id, 'verify.json'), 'utf8'),
		) as { cuts: { frame: number; blackBefore: boolean; blackAfter: boolean }[] };
		expect(ctx.cuts).toEqual([
			{ frame: 45, kind: 'cut', blackBefore: false, blackAfter: false, effect: false },
			{ frame: 90, kind: 'cut', blackBefore: false, blackAfter: true, effect: false },
			{ frame: 105, kind: 'cut', blackBefore: true, blackAfter: false, effect: false },
		]);

		const v = await app.inject({
			method: 'POST',
			url: `/api/exports/${exportJob.id}/verify`,
			headers: JSON_H,
			payload: { target: 'youtube' },
		});
		expect(v.statusCode).toBe(202);
		expect(v.json()).toMatchObject({ kind: 'export-verify', parentId: exportJob.id });
		const done = await coreServices(app).queue.wait(v.json().id);
		expect(done.error).toBeUndefined();
		const r = done.result as ExportVerifyResult;
		expect(r).toMatchObject({
			exportId: exportJob.id,
			checks: 'full',
			target: 'youtube',
			range: { start: 0, end: 150 },
		});
		// the mix was not normalised: −21 LUFS against YouTube's −14 is the one finding (a judgement for the user)
		expect(r.rows.filter((x) => x.status === 'fail').map((x) => [x.id, x.kind])).toEqual([
			['loudness', 'judgement'],
		]);
		expect(r.rows.find((x) => x.id === 'target-loudness')).toMatchObject({ status: 'warn', expected: -14 });
		expect(r.rows.find((x) => x.id === 'cut-black')!.message).toMatch(/^3 cuts checked/);
		expect(r.rows.find((x) => x.id === 'av-skew')!.status).toBe('pass');
		expect(r.verified).toBe(false);

		const fast = await app.inject({
			method: 'POST',
			url: `/api/exports/${exportJob.id}/verify`,
			headers: JSON_H,
			payload: { checks: 'fast' },
		});
		const fastDone = await coreServices(app).queue.wait(fast.json().id);
		expect((fastDone.result as ExportVerifyResult).rows.map((x) => x.id)).toEqual([
			'streams',
			'duration',
			'av-skew',
		]);
	});

	it('refuses unknown jobs, other kinds and bad bodies', { timeout: 60_000 }, async () => {
		const unknown = await app.inject({
			method: 'POST',
			url: '/api/exports/job_0000000000000000/verify',
			headers: JSON_H,
			payload: {},
		});
		expect(unknown.statusCode).toBe(404);
		expect(unknown.json().code).toBe('NOT_FOUND');
		const bad = await app.inject({
			method: 'POST',
			url: '/api/exports/job_0000000000000000/verify',
			headers: JSON_H,
			payload: { target: 'myspace' },
		});
		expect(bad.statusCode).toBe(400);
		const extra = await app.inject({
			method: 'POST',
			url: '/api/exports/job_0000000000000000/verify',
			headers: JSON_H,
			payload: { checks: 'fast', bogus: 1 },
		});
		expect(extra.statusCode).toBe(400);
	});
});
