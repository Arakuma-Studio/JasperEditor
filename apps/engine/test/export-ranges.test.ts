// Multi-range exports (export/ranges.ts; docs/wp-notes/agent-footage-export.md "Several ranges in one file") on a real
// engine, LGPL-only. Reported: a review cut of several ranges needed one export per range and an outside concat. The
// ranges are joined in the order given: every file frame is the Program frame of its sequence frame (SSIM), the sound
// of each range is joined with the 4 ms equal-power join fade (a 440 Hz tone cut at opposite phases would click), the
// verification context records the join as a cut, and the audio-only and GIF deliverables join the same way.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ExportResult, ExportSettings, ExportVerifyResult, RenderPlan } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	TEST_FFPROBE,
	type TestApp,
} from './helpers.ts';

/**
 * How much less like the Program frame a joined file's frame may be than the same frame of a one-range export with the
 * same settings: the joined file has one more generation (a ProRes 4444 intermediate), nothing else.
 */
const SSIM_MARGIN = 0.01;

let app: TestApp;
let work: string;
let d: DocBuilder;

beforeAll(async () => {
	app = await makeApp({ env: { JASPER_FFMPEG_LGPL_ONLY: '1', JASPER_HW_ENCODERS: '0' } });
	work = mkdtempSync(join(tmpdir(), 'jasper-ranges-'));
	// a moving test pattern over a 440 Hz tone: 4 s at 30 fps, 640×360, MPEG-4 Part 2 (LGPL) + PCM
	const clip = join(work, 'pattern.mov');
	const r = spawnSync(TEST_FFMPEG, [
		...['-hide_banner', '-loglevel', 'error', '-y'],
		...['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4'],
		...['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=4'],
		...['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'pcm_s16le', clip],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	d = new DocBuilder('hd-1080p-30', 900);
	d.tx([{ type: 'sequence.updateSettings', settings: { width: 640, height: 360 } }]);
	const media = d.addMedia(await register(app, clip));
	d.tx([{ type: 'clip.place', source: { mediaId: media }, at: 0, tracks: { video: 'V1', audio: ['A1'] } }]);
});
afterAll(closeApps);

/**
 * Sequence frames 46–76, then 0–15: the first range ends at 2.533 s (two thirds into a 440 Hz cycle), the second
 * starts at a zero crossing, so a hard join steps by 0.87 of the tone's amplitude.
 */
const RANGES = [
	{ startFrame: 46, endFrame: 76 },
	{ startFrame: 0, endFrame: 15 },
];

function settings(over: Partial<ExportSettings>): ExportSettings {
	return {
		sequenceId: d.seqId,
		destination: { type: 'download' },
		range: { type: 'ranges', ranges: RANGES },
		container: 'mp4',
		video: {
			codec: 'h264',
			width: 640,
			height: 360,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 18 },
			encoderSpeed: 'fast',
		},
		audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		engine: 'auto',
		...over,
	} as ExportSettings;
}

async function exportFile(s: ExportSettings) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = (await coreServices(app).queue.wait((r.json() as EngineJob).id)) as EngineJob & {
		result: ExportResult;
	};
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	return { job, file: (await coreServices(app).exports.outputFile(job.id))! };
}

async function programStill(frame: number): Promise<string> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame, width: 640 },
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.error, JSON.stringify(job.error)).toBeUndefined();
	return (await coreServices(app).exports.outputFile(job.id))!;
}

function framePng(file: string, index: number): string {
	const out = join(work, `frame-${index}-${Math.random().toString(36).slice(2)}.png`);
	const r = spawnSync(TEST_FFMPEG, [
		...['-hide_banner', '-loglevel', 'error', '-y', '-i', file],
		...['-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-update', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

function ssim(a: string, b: string): number {
	const r = spawnSync(TEST_FFMPEG, [
		...['-hide_banner', '-i', a, '-i', b],
		...['-filter_complex', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]ssim', '-f', 'null', '-'],
	]);
	const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr.toString());
	if (!m) throw new Error(`ssim failed: ${r.stderr.toString().slice(-2000)}`);
	return Number(m[1]);
}

function videoFrames(file: string): number {
	const r = spawnSync(TEST_FFPROBE, [
		...['-v', 'error', '-count_frames', '-select_streams', 'v:0'],
		...['-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file],
	]);
	return Number(r.stdout.toString().trim());
}

/** The first channel of the first audio stream, decoded to float. */
function samples(file: string): Float32Array {
	const r = spawnSync(
		TEST_FFMPEG,
		['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-'],
		{ maxBuffer: 1 << 26 },
	);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
}

describe('several ranges in one file', () => {
	it('joins the ranges in order: Program frames, no click at the join, the join verified as a cut', async () => {
		// ProRes, so the frame comparison measures the render, not a bitrate-driven encoder's rate control
		const prores = settings({ container: 'mov' });
		prores.video = { ...prores.video!, codec: 'prores' };
		const { job, file } = await exportFile(prores);
		expect(job.result).toMatchObject({ frames: 45, durationSec: 1.5 });
		expect(videoFrames(file)).toBe(45);
		// the same settings over the whole sequence: file frame n is sequence frame n
		const whole = await exportFile({ ...prores, range: { type: 'entire' } });
		// file frame → sequence frame: 0 → 46, 29 → 75, 30 → 0, 44 → 14
		for (const [at, frame, other] of [
			[0, 46, 0],
			[29, 75, 14],
			[30, 0, 46],
			[44, 14, 75],
		] as const) {
			const got = framePng(file, at);
			const program = await programStill(frame);
			const right = ssim(got, program);
			const single = ssim(framePng(whole.file, frame), program);
			console.log(
				`file frame ${at} vs Program frame ${frame}: SSIM ${right.toFixed(4)} (one range: ${single.toFixed(4)})`,
			);
			expect(right, `file frame ${at} vs sequence frame ${frame}`).toBeGreaterThanOrEqual(
				single - SSIM_MARGIN,
			);
			expect(ssim(got, await programStill(other))).toBeLessThan(right);
		}
		const v = await app.inject({
			method: 'POST',
			url: `/api/exports/${job.id}/verify`,
			headers: JSON_H,
			payload: {},
		});
		expect(v.statusCode, v.body).toBe(202);
		const done = await coreServices(app).queue.wait((v.json() as EngineJob).id);
		const rows = (done.result as ExportVerifyResult).rows;
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		// the one cut is the join (the clip itself is continuous)
		expect(byId['cut-click']).toMatchObject({
			status: 'pass',
			message: expect.stringMatching(/^1 cut checked/),
		});
		expect(byId.duration!.status).toBe('pass');
		expect(rows.filter((r) => r.status === 'fail')).toEqual([]);
		// the same checks of the unchanged file: the finished verification is returned, not measured again
		const again = await app.inject({
			method: 'POST',
			url: `/api/exports/${job.id}/verify`,
			headers: JSON_H,
			payload: {},
		});
		expect((again.json() as EngineJob).id).toBe(done.id);
	});

	it('an audio-only file joins the mixes with the equal-power join fade', async () => {
		const { job, file } = await exportFile(
			settings({ container: 'wav', video: undefined, audio: undefined }),
		);
		expect(job.result).toMatchObject({ container: 'wav', durationSec: 1.5 });
		const x = samples(file);
		expect(x.length).toBe(72_000);
		// the join at 1 s: a hard cut steps by ≈ 0.87 × the tone's peak; faded, no step is larger than the tone's own
		let peak = 0;
		for (let i = 0; i < 40_000; i++) peak = Math.max(peak, Math.abs(x[i]!));
		const step = (a: number, b: number) => {
			let m = 0;
			for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
			return m;
		};
		expect(step(47_000, 49_000)).toBeLessThanOrEqual(step(10_000, 12_000) * 1.05);
		expect(Math.abs(x[48_000]!)).toBeLessThan(peak * 0.05);
	});

	it('touching ranges are one range: the same file, no join fade or join cut; an overlapping continuation is refused', async () => {
		// reported: 1869–3000, 3000–6000, 6000–8346 got a 4 ms fade at every join and the intermediate encode
		const wav = { container: 'wav', video: undefined, audio: undefined } as const;
		const touching = settings({
			...wav,
			range: {
				type: 'ranges',
				ranges: [
					{ startFrame: 46, endFrame: 60 },
					{ startFrame: 60, endFrame: 76 },
				],
			},
		});
		const plan = async (s: ExportSettings) =>
			app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
			});
		const planned = await plan(touching);
		expect((planned.json() as RenderPlan).warnings.map((w) => w.code)).not.toContain('RANGES_JOINED');
		const joined = await exportFile(touching);
		const one = await exportFile(
			settings({ ...wav, range: { type: 'custom', startFrame: 46, endFrame: 76 } }),
		);
		const a = samples(joined.file);
		const b = samples(one.file);
		expect(a.length).toBe(b.length);
		expect(
			Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
				Buffer.from(b.buffer, b.byteOffset, b.byteLength),
			),
		).toBe(true);
		const ctx = JSON.parse(readFileSync(join(app.appdir, 'renders', joined.job.id, 'verify.json'), 'utf8'));
		expect(ctx).toMatchObject({ version: 1, range: { start: 46, end: 76 }, cuts: [] });
		expect(ctx.pieces).toBeUndefined();
		const stutter = await plan(
			settings({
				...wav,
				range: {
					type: 'ranges',
					ranges: [
						{ startFrame: 46, endFrame: 61 },
						{ startFrame: 60, endFrame: 76 },
					],
				},
			}),
		);
		expect(stutter.statusCode).toBe(400);
		expect(stutter.json()).toMatchObject({
			code: 'VALIDATION_FAILED',
			message: expect.stringMatching(/start it at 61/),
		});
	});

	it('a GIF joins the ranges too; outputs that cannot be joined are refused by name', async () => {
		const { job } = await exportFile(
			settings({ container: 'gif', video: undefined, audio: undefined, gif: { fps: 10, width: 320 } }),
		);
		expect(job.result).toMatchObject({ container: 'gif', gif: { frames: 15 } });
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings({ captions: { embed: true } }),
			},
		});
		expect(r.statusCode).toBe(400);
		expect(r.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/captions/) });
	});
});
