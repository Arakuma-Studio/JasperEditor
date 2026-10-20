// Expected frame codes come from the fixture schedule and the requested editing operations.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	if (!existsSync(fixture('vfr-code.mp4')) || !existsSync(fixture('gray-ramp.mkv')))
		spawnSync(process.execPath, [fixture('../../scripts/make-fixtures.mjs')], { stdio: 'inherit' });
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

const settings = (seqId: string, engine = 'native') => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 16 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine,
});

async function plan(d: DocBuilder) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, 'auto') },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as { path: string; blockers: { reason: string }[]; warnings: { code: string }[] };
}

async function exportDoc(d: DocBuilder): Promise<string> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	expect((done.result as { renderPath: string }).renderPath).toBe('native');
	return (await coreServices(app).exports.outputFile(start.json().id))!;
}

/** The 6-bit frame code of frame-code.mp4 / vfr-code.mp4 at an output frame (`offset` = where the picture sits). */
function frameCode(file: string, frame: number, offset: [number, number] = [0, 0]): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=420:1:${40 + offset[0]}:${70 + offset[1]}`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	let code = 0;
	for (let b = 0; b < 6; b++) if (r.stdout[(30 + 70 * b) * 3]! > 127) code |= 1 << b;
	return code;
}

function luma(file: string, frame: number): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=gray,crop=1:1:960:540`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	return r.stdout[0]!;
}

function placeCode(d: DocBuilder, media: string, inF: number, outF: number, audio = false): string {
	const r = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: media },
			at: 0,
			sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
			matchSequence: 'keep',
			...(audio ? {} : { audio: false }),
		},
	]);
	return (r.results[0] as { clipIds: string[] }).clipIds[0]!;
}

describe('native retime', () => {
	it('reverse speed plays the clip backwards on the native path', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const v = placeCode(d, d.addMedia(coded), 10, 40);
		d.tx([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]);
		const p = await plan(d);
		expect(p.path).toBe('native');
		expect(p.blockers).toEqual([]);
		const file = await exportDoc(d);
		for (const f of [0, 1, 15, 29]) expect(frameCode(file, f)).toBe(39 - f);
	}, 180_000);

	it('a time remap preserves independently specified slow, freeze and reverse frame choices', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const v = placeCode(d, d.addMedia(coded), 0, 40);
		d.tx([
			{ type: 'timeRemap.addKeyframe', clipId: v, at: 10 },
			{ type: 'timeRemap.setSpeed', clipId: v, at: 0, speedPercent: 50, ripple: true },
		]);
		d.tx([{ type: 'timeRemap.addFreeze', clipId: v, at: 30, duration: 6, ripple: true }]);
		d.tx([{ type: 'timeRemap.addReverse', clipId: v, at: 45, duration: 8, ripple: true }]);
		const p = await plan(d);
		expect(p.path).toBe('native');
		const file = await exportDoc(d);
		// 0..20 advances by half a source frame; 30..36 holds source 20.
		// At 45, source 29 reverses for eight frames, then returns forward.
		const expected = [
			[0, 0],
			[3, 1],
			[18, 9],
			[21, 11],
			[27, 17],
			[30, 20],
			[33, 20],
			[36, 20],
			[42, 26],
			[45, 29],
			[48, 26],
			[51, 23],
			[54, 22],
			[60, 28],
			[63, 31],
			[69, 37],
		] as const;
		for (const [frame, source] of expected) expect(frameCode(file, frame), `frame ${frame}`).toBe(source);
	}, 240_000);

	it('maps variable-frame-rate media by their timestamps (no VFR conform warning)', async () => {
		const vfr = await register(app, fixture('vfr-code.mp4'));
		expect(vfr.probe.variableFrameRate).toBe(true);
		const d = new DocBuilder();
		const m = d.addMedia(vfr);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				audio: false,
			},
		]);
		const p = await plan(d);
		expect(p.warnings.map((w) => w.code)).not.toContain('VFR_SOURCE');
		const file = await exportDoc(d);
		// scripts/fixtures/time.mjs authors PTS n/30 + 0.01*(n mod 3).
		// At output f/30, only multiples of three have arrived on their nominal frame.
		for (let f = 0; f < 60; f++) {
			const source = f % 3 === 0 ? f : f - 1;
			// The 640×360 picture sits unscaled in the middle of the 1080p frame.
			expect(frameCode(file, f, [640, 360]), `frame ${f}`).toBe(source);
		}
	}, 180_000);

	it('Frame Blending mixes neighbouring frames at 50 %; Optical Flow renders natively', async () => {
		const ramp = await register(app, fixture('gray-ramp.mkv'));
		const d = new DocBuilder();
		const m = d.addMedia(ramp);
		const r = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 16 } },
				matchSequence: 'keep',
			},
		]);
		const v = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		d.tx([
			{ type: 'clip.setSpeed', clipIds: [v], rate: 0.5, ripple: true },
			{ type: 'clip.setTimeInterpolation', clipIds: [v], mode: 'frame-blending' },
		]);
		const file = await exportDoc(d);
		// Output frame 2k shows source k (grey 8k), 2k + 1 the mix of k and k + 1 (8k + 4); limited-range H.264 ±3.
		// The ramp's grey 8·n is a limited-range Y value: displayed (full range) as (8n − 16)·255/219.
		const shown = (y: number) => Math.max(0, ((y - 16) * 255) / 219);
		if (process.env.TIME_DEBUG)
			console.info(JSON.stringify(Array.from({ length: 24 }, (_, f) => luma(file, f))));
		for (const k of [2, 5, 9]) {
			expect(Math.abs(luma(file, 2 * k) - shown(8 * k))).toBeLessThanOrEqual(3);
			expect(Math.abs(luma(file, 2 * k + 1) - shown(8 * k + 4))).toBeLessThanOrEqual(3);
		}
		d.tx([{ type: 'clip.setTimeInterpolation', clipIds: [v], mode: 'optical-flow' }]);
		const flow = await exportDoc(d);
		// Uniform frames: the flow is zero and the interpolation is the same mix.
		expect(Math.abs(luma(flow, 11) - shown(44))).toBeLessThanOrEqual(3);
	}, 240_000);
});

describe('Scene Edit Detection job', () => {
	it('finds the hard cuts of scenes.mp4 and none at the flash, the dissolve or the fast pan', async () => {
		const m = await register(app, fixture('scenes.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: '/api/scenes/detect?wait=1',
			headers: JSON_H,
			payload: { mediaKey: m.mediaKey, startSec: 0, endSec: 228 / 30, sensitivity: 50, minShotFrames: 2 },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = r.json().result as { cuts: number[]; frames: number; scores: number[] };
		expect(res.frames).toBe(228);
		const frames = res.cuts.map((t) => Math.round(t * 30));
		expect(frames).toEqual([45, 75, 120, 198]);
		const sub = await app.inject({
			method: 'POST',
			url: '/api/scenes/detect?wait=1',
			headers: JSON_H,
			payload: { mediaKey: m.mediaKey, startSec: 2, endSec: 4.5, sensitivity: 50, minShotFrames: 2 },
		});
		expect(sub.statusCode, sub.body).toBe(200);
		expect((sub.json().result as { cuts: number[] }).cuts.map((t) => Math.round(t * 30))).toEqual([75, 120]);
	}, 180_000);
});
