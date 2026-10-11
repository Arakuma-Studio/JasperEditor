// edit-structure on the native export path (docs/wp-notes/edit-structure.md): nested sequences drawn in the same
// filtergraph (frame mapping incl. speed, Motion of the nest clip, nested audio), adjustment layers (effects on the
// composite with opacity and crop), frame holds, freeze-frame transition handles, Bars and Tone (picture and the
// −20 dBFS tone) and the counting leader — checked frame by frame on the exported files (real ffmpeg).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
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
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine,
});

async function exportDoc(d: DocBuilder, expectPath = 'native'): Promise<string> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	expect((done.result as { renderPath: string }).renderPath).toBe(expectPath);
	return (await coreServices(app).exports.outputFile(start.json().id))!;
}

function pixel(file: string, frame: number, x: number, y: number): [number, number, number] {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	return [r.stdout[0]!, r.stdout[1]!, r.stdout[2]!];
}

/** The 6-bit frame number burnt into frame-code.mp4 (see export.test.ts). */
function frameCode(file: string, frame: number): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=420:1:40:70`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	let code = 0;
	for (let b = 0; b < 6; b++) if (r.stdout[(30 + 70 * b) * 3]! > 127) code |= 1 << b;
	return code;
}

/** Peak level (dBFS) of the audio of `file` between `from` and `to` seconds. */
function maxVolume(file: string, from = 0, to = 100): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'info', '-ss', String(from), '-to', String(to), '-i', file],
		...['-af', 'volumedetect', '-vn', '-f', 'null', '-'],
	]);
	const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
	return m ? (m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1])) : Number.NaN;
}

const near = (a: number, b: number, tol = 10) => Math.abs(a - b) <= tol;

describe('nested sequences (native)', () => {
	it('draws the nested frames in place, at speed, with the nest clip Motion, and mixes nested audio', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const clipA = await register(app, fixture('clip-a.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		const a = d.addMedia(clipA);
		const inner = d.tx([{ type: 'sequence.create', name: 'Inner', ref: '$s' }]).refs.$s!;
		d.tx([
			{
				type: 'clip.place',
				sequenceId: inner,
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 60 } },
				matchSequence: 'keep',
			},
			{
				type: 'clip.place',
				sequenceId: inner,
				source: { mediaId: a },
				at: 0,
				video: false,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			},
		]);
		// Nest 1 at 10: nested frames 5… (a 5-frame trim of its head); nest 2 at 50 at 2× speed.
		const r = d.tx([
			{
				type: 'clip.place',
				source: { sequenceId: inner },
				at: 10,
				sourceRange: { in: { flicks: 5 * 23520000 }, out: { flicks: 35 * 23520000 } },
				ref: '$n1',
			},
		]);
		const n1 = r.refs.$n1!;
		const r2 = d.tx([
			{ type: 'clip.place', source: { sequenceId: inner }, at: 50, video: true, audio: false, ref: '$n2' },
		]);
		d.tx([{ type: 'clip.setSpeed', clipIds: [r2.refs.$n2!], rate: 2, ripple: false }]);
		const file = await exportDoc(d);
		expect(frameCode(file, 10)).toBe(5);
		expect(frameCode(file, 20)).toBe(15);
		expect(frameCode(file, 39)).toBe(34);
		expect(frameCode(file, 50)).toBe(0);
		expect(frameCode(file, 55)).toBe(10);
		expect(frameCode(file, 60)).toBe(20);
		// The nested audio plays only under nest 1 (frames 10–40); nest 2 has no audio clip.
		expect(maxVolume(file, 0.4, 1.3)).toBeGreaterThan(-30);
		expect(maxVolume(file, 1.4, 1.6)).toBeLessThan(-60);
		// Motion of the nest clip: half size → outside the scaled picture is the background.
		d.tx([{ type: 'param.set', target: ['clip', n1, 'transform', 'scale'], value: 50 }]);
		const scaled = await exportDoc(d);
		expect(pixel(scaled, 20, 100, 100)).toEqual([0, 0, 0]);
		const inside = pixel(scaled, 20, 960, 540);
		expect(inside.some((v) => v > 20)).toBe(true);
	}, 240_000);
});

describe('adjustment layers (native)', () => {
	it('runs the effects on the composite below, with opacity and crop', async () => {
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0.5, 0, 1] },
			{ type: 'clip.addAdjustment', at: 10, duration: 20, track: 'V2', ref: '$a' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.crop', params: { left: 50 } },
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 50 },
		]);
		const file = await exportDoc(d);
		// Before the adjustment: orange everywhere.
		expect(near(pixel(file, 5, 1500, 540)[2], 0, 12)).toBe(true);
		// Left half (cropped away): still orange; right half: halfway to grey.
		const left = pixel(file, 20, 400, 540);
		const right = pixel(file, 20, 1500, 540);
		expect(near(left[0], 255, 12) && near(left[1], 128, 14) && near(left[2], 0, 12)).toBe(true);
		expect(right[0]).toBeLessThan(245);
		expect(right[2]).toBeGreaterThan(30);
	}, 180_000);
});

describe('masked adjustment layers', () => {
	it('an adjustment layer with an Opacity mask routes the export through Remotion (never unmasked natively)', async () => {
		const d = new DocBuilder();
		const r = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0.5, 0, 1] },
			{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V2', ref: '$a' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' },
			{ type: 'mask.add', clipId: '$a', shape: 'ellipse' },
		]);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, 'auto') as never,
		});
		expect(planned.plan.path).toBe('remotion');
		expect(planned.plan.blockers.some((b) => b.itemId === r.refs.$a)).toBe(true);
	}, 120_000);
});

describe('frame holds and freeze-frame handles (native)', () => {
	it('holds one frame and repeats edge frames in a transition', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		const place = (at: number, inF: number, outF: number, ref: string) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at,
			sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
			matchSequence: 'keep',
			ref,
		});
		d.tx([place(0, 0, 30, '$a')]);
		d.tx([
			{
				type: 'clip.addFrameHold',
				at: 10,
				clipIds: [d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'video')],
			},
		]);
		const held = await exportDoc(d);
		expect(frameCode(held, 5)).toBe(5);
		expect(frameCode(held, 10)).toBe(10);
		expect(frameCode(held, 25)).toBe(10);
		// Freeze-frame handles: A ends at the media's last frame (63), B starts at its first (0).
		const e = new DocBuilder();
		const m2 = e.addMedia(coded);
		const p2 = (at: number, inF: number, outF: number, ref: string) => ({
			type: 'clip.place',
			source: { mediaId: m2 },
			at,
			sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
			matchSequence: 'keep',
			ref,
		});
		e.tx([
			p2(0, 34, 64, '$a'),
			p2(30, 0, 30, '$b'),
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 30,
				effectId: 'jasper.cross-dissolve',
				duration: 10,
				handles: 'freeze',
			},
		]);
		const file = await exportDoc(e);
		// Frames 25…34 are the span; before the cut B's head handle repeats its first frame (code 0) under A,
		// after the cut A's tail repeats its last frame (63). No black frames anywhere.
		for (const f of [24, 26, 29, 30, 33, 35]) {
			const p = pixel(file, f, 1000, 600);
			expect(p[2], `frame ${f}`).toBeGreaterThan(90);
		}
		expect(frameCode(file, 36)).toBe(6);
	}, 180_000);
});

describe('synthetic sources (native)', () => {
	it('exports Bars and Tone (SMPTE bars, 1 kHz at −20 dBFS) and the counting leader', async () => {
		const d = new DocBuilder();
		const r = d.tx([
			{ type: 'synthetic.create', kind: 'bars-and-tone', ref: '$b' },
			{ type: 'synthetic.create', kind: 'counting-leader', ref: '$l' },
		]);
		d.tx([
			{ type: 'clip.place', source: { syntheticId: r.refs.$b }, at: 0 },
			{ type: 'clip.place', source: { syntheticId: r.refs.$l }, at: 30 },
		]);
		const file = await exportDoc(d);
		const at = (x: number, y: number) => pixel(file, 10, x, y);
		expect(at(100, 100).every((v) => near(v, 102, 6))).toBe(true); // 40 % grey
		expect(at(300, 100).every((v) => near(v, 191, 6))).toBe(true); // 75 % white
		expect(at(1850, 100).every((v) => near(v, 102, 6))).toBe(true); // right side panel
		expect(near(at(1550, 100)[2], 191, 6) && at(1550, 100)[0] < 12).toBe(true); // 75 % blue bar
		expect(near(maxVolume(file, 0.1, 0.9), -20, 0.6)).toBe(true);
		// Leader at content 2.5 s (frame 30 + 75): the swept quadrant shows the wipe colour, the rest the background.
		const swept = pixel(file, 105, 1700, 150);
		const rest = pixel(file, 105, 200, 950);
		expect(near(swept[0], 140, 8)).toBe(true);
		expect(near(rest[0], 199, 8)).toBe(true);
		// The two-pop: one frame of tone at content 8 s (frame 30 + 240), silence around it.
		expect(near(maxVolume(file, 9, 9.034), -20, 1.5)).toBe(true);
		expect(maxVolume(file, 8.5, 8.95)).toBeLessThan(-60);
	}, 600_000);
});

describe('stills (render_frame) of nests and held frames', () => {
	it('renders a still of a nested frame natively', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		const inner = d.tx([{ type: 'sequence.create', name: 'Inner', ref: '$s' }]).refs.$s!;
		d.tx([
			{
				type: 'clip.place',
				sequenceId: inner,
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 60 } },
				matchSequence: 'keep',
			},
		]);
		d.tx([{ type: 'clip.place', source: { sequenceId: inner }, at: 0, video: true, audio: false }]);
		const r = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 37 },
		});
		expect(r.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error ?? null)).toBe('succeeded');
		expect(done.result).toMatchObject({ renderPath: 'native' });
		const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
		const f = join(mkdtempSync(join(tmpdir(), 'jasper-es-')), 'f.png');
		writeFileSync(f, png.rawPayload);
		expect(frameCode(f, 0)).toBe(37);
	}, 120_000);
});
