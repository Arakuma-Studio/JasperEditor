import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { RegisteredMedia } from '@jasper/api';
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
	tempAppdir,
} from './helpers.ts';

let app: TestApp;
let coded: RegisteredMedia;
let red: RegisteredMedia;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	const dir = tempAppdir('jasper-mc-');
	const redPath = join(dir, 'red.mp4');
	const r = spawnSync(
		'ffmpeg',
		[
			...['-hide_banner', '-loglevel', 'error'],
			...['-f', 'lavfi', '-i', 'color=c=0xff0000:size=1920x1080:rate=30:duration=4'],
			...['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4'],
			...['-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'aac', '-shortest', '-y', redPath],
		],
		{ stdio: 'inherit' },
	);
	if (r.status !== 0) throw new Error('ffmpeg failed');
	coded = await register(app, fixture('frame-code.mp4'));
	red = await register(app, redPath);
}, 180_000);
afterAll(closeApps);

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
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

async function exportDoc(d: DocBuilder): Promise<{ file: string; path: string }> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(start.json().id))!,
		path: (done.result as { renderPath: string }).renderPath,
	};
}

function pixel(file: string, frame: number, x: number, y: number): [number, number, number] {
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-i', file],
		...['-vf', `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`],
		...['-frames:v', '1', '-f', 'rawvideo', '-'],
	]);
	return [r.stdout[0]!, r.stdout[1]!, r.stdout[2]!];
}

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

function maxVolume(file: string, from: number, to: number): number {
	const r = spawnSync('ffmpeg', [
		...['-v', 'info', '-ss', String(from), '-to', String(to), '-i', file],
		...['-af', 'volumedetect', '-vn', '-f', 'null', '-'],
	]);
	const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
	return m ? (m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1])) : Number.NaN;
}

const near = (a: number, b: number, tol = 12) => Math.abs(a - b) <= tol;

function build(): { d: DocBuilder; video: string; audio: string } {
	const d = new DocBuilder();
	const reg = (m: RegisteredMedia) => {
		const { mediaKey: _k, browserPlayable: _b, ...asset } = m;
		return (
			d.tx([{ type: 'media.register', asset: { ...asset, derivation: null } }]).results[0] as {
				itemId: string;
			}
		).itemId;
	};
	const a = reg(coded);
	const b = reg(red);
	// The "clap" is at frame 10 of camera A and frame 0 of camera B: B starts 10 frames into A.
	d.tx([{ type: 'item.setMarks', itemId: a, in: { sourceFrames: 10 }, out: null }]);
	const mc = d.tx([{ type: 'multicam.create', itemIds: [a, b], method: 'in', audio: 'switch' }])
		.results[0] as {
		sequenceId: string;
	};
	const placed = d.tx([{ type: 'clip.place', source: { sequenceId: mc.sequenceId }, at: 0 }]).results[0] as {
		clipIds: string[];
	};
	return { d, video: placed.clipIds[0]!, audio: placed.clipIds[1]! };
}

describe('multi-camera clips (native export)', () => {
	it('renders the angle each part shows, synced, with the clip’s opacity; audio switches with the angle', async () => {
		const { d, video } = build();
		d.tx([
			{ type: 'multicam.switchAngle', range: { from: 20, to: 40 }, angle: 2 },
			{ type: 'param.set', target: ['clip', video, 'opacity'], value: 100 },
		]);
		const { file, path } = await exportDoc(d);
		expect(path).toBe('native');
		expect(frameCode(file, 5)).toBe(5);
		expect(frameCode(file, 19)).toBe(19);
		const p = pixel(file, 30, 960, 540);
		expect(near(p[0], 255) && p[1] < 40 && p[2] < 40, `red at 30: ${p}`).toBe(true);
		expect(frameCode(file, 45)).toBe(45);
		// camera B's 1 kHz tone plays only while B is shown (frames 20–40 = 0.67–1.33 s)
		expect(maxVolume(file, 0.8, 1.2)).toBeGreaterThan(-30);
	}, 180_000);

	it('the multi-camera clip’s own opacity and Flatten give the same frames', async () => {
		const { d, video } = build();
		d.tx([
			{ type: 'multicam.switchAngle', clipIds: [video], angle: 2 },
			{ type: 'param.set', target: ['clip', video, 'opacity'], value: 50 },
		]);
		const nested = await exportDoc(d);
		const a = pixel(nested.file, 30, 960, 540);
		expect(near(a[0], 128, 16) && a[1] < 24 && a[2] < 24, `half red: ${a}`).toBe(true);
		d.tx([{ type: 'multicam.flatten', clipIds: [video] }]);
		const flat = await exportDoc(d);
		expect(flat.path).toBe('native');
		const b = pixel(flat.file, 30, 960, 540);
		for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThanOrEqual(4);
	}, 180_000);
});
