// The export-verify job through the engine's routes (spec 18 AF-VER-001): an export records its verification context
// (the cut list with intended black), POST /api/exports/:jobId/verify verifies it, refusals are coded. The clips are
// 640×360 in a 1080p sequence (a picture covering 11 % of the frame still makes cuts for verification).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportVerifyResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildVerifyContext } from '../src/export/verify-context.ts';
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
		// the 15-frame gap is silent too: listed as a warning (it may be meant), not a failure
		expect(r.rows.filter((x) => x.id === 'uncovered-video')).toMatchObject([
			{ status: 'warn', measured: 15, at: { frame: 90 } },
		]);
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
			'uncovered-video',
		]);
	});

	it('a picture lifted alone leaves black under its sound: the plan warns and verify.json records it', async () => {
		const a = await register(app, shot('hole.mp4', '0x707070', 440));
		const d = new DocBuilder();
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: d.addMedia(a) },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 45 } },
			},
		]);
		const v1 = d.doc.sequences[d.seqId]!.videoTracks[0]!.id;
		d.tx([{ type: 'range.lift', from: 20, to: 27, tracks: [v1] }]);
		const plan = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(plan.statusCode, plan.body).toBe(200);
		const w = (plan.json() as { warnings: { code: string; message: string }[] }).warnings;
		expect(w.find((x) => x.code === 'UNCOVERED_VIDEO')?.message).toMatch(/^7 frames .*frames 20–27/);
		const ctx = buildVerifyContext({
			document: d.doc,
			sequenceId: d.seqId,
			range: { start: 0, end: 45 },
			output: {
				width: 1920,
				height: 1080,
				fps: { num: 30, den: 1 },
				audioChannels: 2,
				audioSampleRate: 48000,
				normalize: null,
				encoder: { container: 'mp4', codec: 'h264' },
			},
			pixFmt: 'yuv420p',
			audioEncoder: 'aac',
		});
		expect(ctx.uncovered).toEqual([{ start: 20, end: 27, audible: true }]);
	});

	it('hidden video tracks: the plan warns VIDEO_TRACKS_HIDDEN (never refuses) and verify.json names them', async () => {
		// reported: a Shift+click on a track eye hid every video track; every export was black, nothing said why
		const a = await register(app, shot('hidden.mp4', '0x707070', 440));
		const d = new DocBuilder();
		const m = d.addMedia(a);
		const place = (at: number, track: string, frames: number) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at,
			video: true,
			audio: track === 'V1',
			tracks: { video: track },
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: frames } },
		});
		d.tx([place(0, 'V1', 45), place(0, 'V2', 9)]);
		const [v1, v2] = d.doc.sequences[d.seqId]!.videoTracks.map((t) => t.id);
		const hide = (trackId: string, off: boolean) =>
			d.tx([{ type: 'track.update', trackId, patch: { output: !off } }]);
		const hiddenWarning = async () => {
			const plan = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
			});
			expect(plan.statusCode, plan.body).toBe(200);
			const w = (plan.json() as { warnings: { code: string; message: string }[] }).warnings;
			return w.find((x) => x.code === 'VIDEO_TRACKS_HIDDEN')?.message;
		};
		hide(v1!, true);
		hide(v2!, true);
		expect(await hiddenWarning()).toMatch(
			/^Every video track with clips in the range has its output \(the track eye\) off \(V1, V2\)/,
		);
		// V2 shows frames 0–9; hidden V1 would cover the 36 black frames after them (80 % of the range)
		hide(v2!, false);
		expect(await hiddenWarning()).toMatch(
			/^Video track V1 has output off: its clips would cover 36 frames \(80%/,
		);
		const ctx = buildVerifyContext({
			document: d.doc,
			sequenceId: d.seqId,
			range: { start: 0, end: 45 },
			output: {
				width: 1920,
				height: 1080,
				fps: { num: 30, den: 1 },
				audioChannels: 2,
				audioSampleRate: 48000,
				normalize: null,
				encoder: { container: 'mp4', codec: 'h264' },
			},
			pixFmt: 'yuv420p',
			audioEncoder: 'aac',
		});
		expect(ctx.uncovered).toEqual([{ start: 9, end: 45, audible: true, hidden: ['V1'] }]);
		// V1 shown again covers everything: nothing to say
		hide(v1!, false);
		expect(await hiddenWarning()).toBeUndefined();
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
