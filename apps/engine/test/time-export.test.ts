// Workstream `time` on the native export path (docs/wp-notes/time.md): reverse, Time Remapping (speed segments,
// freeze, palindrome reverse, ramps), Frame Blending, Optical Flow and variable-frame-rate media through the `retime`
// extension — checked frame by frame on the exported files (real ffmpeg) against the shared model
// (`clipMediaTimeAt` + `pickFrames`, the preview's frame choice).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
	clipMediaTimeAt,
	cutAccuracy,
	FLICKS_PER_SECOND,
	frameIndexAt,
	RATES,
	type VideoClip,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeFrameTimes } from '../src/export/retime/frames.ts';
import { pairRuns, planRetime } from '../src/export/retime/plan.ts';
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

const R = RATES.r30;
const clipOf = (d: DocBuilder, id: string) => d.doc.sequences[d.seqId]!.clips[id] as VideoClip;

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

describe('retime plan (pure)', () => {
	it('pairs consecutive frames that share their source frames', () => {
		const runs = pairRuns([
			{ frame: 0, seconds: 0, a: 0, b: 1, w: 0.25 },
			{ frame: 1, seconds: 0, a: 0, b: 1, w: 0.75 },
			{ frame: 2, seconds: 0, a: 1, b: 1, w: 0 },
		]);
		expect(runs).toEqual([
			{ a: 0, b: 1, from: 0, to: 2 },
			{ a: 1, b: 1, from: 2, to: 3 },
		]);
	});

	it('reads real frame timestamps of VFR media', async () => {
		const t = await probeFrameTimes(coreServices(app).ffmpeg, fixture('vfr-code.mp4'));
		expect(t).toHaveLength(64);
		expect(t.slice(0, 4).map((x) => Math.round(x * 1e4) / 1e4)).toEqual([0, 0.0433, 0.0867, 0.1]);
	});
});

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

	it('a time remap (50 % segment, freeze, palindrome reverse) shows the model’s frames', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const v = placeCode(d, d.addMedia(coded), 0, 40);
		d.tx([
			{ type: 'timeRemap.addKeyframe', clipId: v, at: 10 },
			{ type: 'timeRemap.setSpeed', clipId: v, at: 0, speedPercent: 50, ripple: true },
		]);
		d.tx([{ type: 'timeRemap.addFreeze', clipId: v, at: 30, duration: 6, ripple: true }]);
		d.tx([{ type: 'timeRemap.addReverse', clipId: v, at: 45, duration: 8, ripple: true }]);
		const c = clipOf(d, v);
		const p = await plan(d);
		expect(p.path).toBe('native');
		const file = await exportDoc(d);
		const cfr = { kind: 'cfr', rate: R, count: 64 } as const;
		for (let f = 0; f < c.duration; f += 3) {
			const want = frameIndexAt(cfr, clipMediaTimeAt(c, f, R) / FLICKS_PER_SECOND);
			expect(frameCode(file, f), `frame ${f}`).toBe(want);
		}
	}, 240_000);

	it('maps variable-frame-rate media by their timestamps (no VFR conform warning)', async () => {
		const vfr = await register(app, fixture('vfr-code.mp4'));
		expect(vfr.probe.variableFrameRate).toBe(true);
		const d = new DocBuilder();
		const m = d.addMedia(vfr);
		const r = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				audio: false,
			},
		]);
		const v = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		const p = await plan(d);
		expect(p.warnings.map((w) => w.code)).not.toContain('VFR_SOURCE');
		const file = await exportDoc(d);
		const times = await probeFrameTimes(coreServices(app).ffmpeg, fixture('vfr-code.mp4'));
		const list = { kind: 'list', times } as const;
		const c = clipOf(d, v);
		let differsFromCfr = 0;
		if (process.env.TIME_DEBUG)
			console.info(
				JSON.stringify(
					Array.from({ length: 20 }, (_, f) => [
						frameCode(file, f, [640, 360]),
						frameIndexAt(list, clipMediaTimeAt(c, f, R) / FLICKS_PER_SECOND),
					]),
				),
			);
		for (let f = 0; f < 60; f += 1) {
			const want = frameIndexAt(list, clipMediaTimeAt(c, f, R) / FLICKS_PER_SECOND);
			// The 640×360 picture sits unscaled in the middle of the 1080p frame.
			expect(frameCode(file, f, [640, 360]), `frame ${f}`).toBe(want);
			if (want !== f) differsFromCfr++;
		}
		// Conforming (one source frame per output frame) would have shown the wrong frame on most of these.
		expect(differsFromCfr).toBeGreaterThan(20);
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

	it('plans each output frame from the shared model', () => {
		const d = new DocBuilder();
		void d;
		const c = {
			clipId: 'c',
			kind: 'video',
			start: 0,
			duration: 4,
			sourceIn: 0,
			speed: { rate: 0.5, reverse: false, maintainPitch: false },
			retime: { interpolation: 'frame-blending', mediaRate: R, vfr: false },
		} as unknown as Parameters<typeof planRetime>[0];
		const p = planRetime(c, 0, 4, R, { kind: 'cfr', rate: R, count: 10 });
		expect(p.frames.map((f) => [f.a, f.b, Math.round(f.w * 1e9) / 1e9])).toEqual([
			[0, 0, 0],
			[0, 1, 0.5],
			[1, 1, 0],
			[1, 2, 0.5],
		]);
	});
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
		const truth = [45, 75, 120, 198];
		const acc = cutAccuracy(frames, truth);
		if (process.env.SCENE_REPORT) console.info(JSON.stringify({ frames, ...acc }));
		expect(acc.recall).toBe(1);
		expect(acc.precision).toBe(1);
		// A sub-range starts at its own first frame.
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
