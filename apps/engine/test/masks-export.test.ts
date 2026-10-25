// Independent geometric regions and literal pixels verify native masked output.
import { spawnSync } from 'node:child_process';
import { ellipsePath, flicksPerFrame, rectPath } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, ensureFixtures, JSON_H, makeApp, type TestApp } from './helpers.ts';

const FWD_ENV: Record<string, string> = {};
for (const k of ['JASPER_FFMPEG', 'JASPER_FFPROBE']) if (process.env[k]) FWD_ENV[k] = process.env[k]!;
const W = 1920;
const H = 1080;
const PLATE = 20;

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ env: FWD_ENV });
}, 180_000);
afterAll(closeApps);

const settings = (seqId: string, frames: number) => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: frames },
	container: 'mov',
	engine: 'auto',
	video: {
		codec: 'prores',
		proresProfile: '4444',
		width: W,
		height: H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
});

function fixture(frames: number) {
	const d = new DocBuilder();
	d.tx([
		{
			type: 'clip.addSolid',
			at: 0,
			duration: frames,
			track: 'V1',
			color: [PLATE / 255, PLATE / 255, PLATE / 255, 1],
		},
	]);
	const s = d.tx([
		{ type: 'clip.addSolid', at: 0, duration: frames, track: 'V2', color: [1, 1, 1, 1], ref: '$s' },
	]).refs.$s!;
	return { d, s };
}

function decodeAll(file: string): Buffer[] {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		{
			maxBuffer: 1 << 30,
		},
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const size = W * H * 3;
	return Array.from({ length: r.stdout.length / size }, (_, i) =>
		r.stdout.subarray(i * size, (i + 1) * size),
	);
}

async function exportFrames(d: DocBuilder, frames: number) {
	const st = settings(d.seqId, frames);
	const planned = await coreServices(app).exports.plan({
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: st as never,
	});
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: st },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return { planned, out: (await coreServices(app).exports.outputFile(done.id))! };
}

describe('mask export routing', () => {
	it('Opacity masks of media layers are native; effect masks need the layer bake (never silently dropped)', async () => {
		const { d, s } = fixture(10);
		d.tx([{ type: 'mask.add', clipId: s, shape: 'ellipse' }]);
		let planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, 10) as never,
		});
		expect(planned.plan.path).toBe('native');
		const fx = d.tx([
			{ type: 'effect.add', target: { clipId: s }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
		]).refs.$fx!;
		d.tx([{ type: 'mask.add', effectId: fx, shape: 'polygon' }]);
		planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, 10) as never,
		});
		expect(['hybrid', 'remotion']).toContain(planned.plan.path);
		if (planned.plan.path === 'remotion')
			expect(planned.plan.blockers.some((b) => b.itemId === s)).toBe(true);
	}, 120_000);
});

describe('native export of Opacity masks (stream kernel)', () => {
	it('stacked rectangular masks apply opacity and subtract the second region', async () => {
		const { d, s } = fixture(2);
		const r = d.tx([
			{ type: 'mask.add', clipId: s, shape: 'polygon', feather: 0, ref: '$a' },
			{ type: 'mask.add', clipId: s, shape: 'polygon', ref: '$b' },
		]).refs;
		d.tx([
			{ type: 'mask.update', maskId: r.$b, mode: 'subtract' },
			{ type: 'param.set', target: ['mask', r.$b!, 'path'], value: rectPath(0.45, 0.2, 0.7, 0.55) },
			{ type: 'param.set', target: ['mask', r.$b!, 'feather'], value: 0 },
			{ type: 'param.set', target: ['mask', r.$a!, 'path'], value: rectPath(0.2, 0.2, 0.8, 0.8) },
			{ type: 'param.set', target: ['mask', r.$a!, 'opacity'], value: 90 },
		]);
		const { planned, out } = await exportFrames(d, 2);
		expect(planned.plan.path).toBe('native');
		const img = decodeAll(out)[0]!;
		// Sample well inside the specified rectangles, away from raster/codec edge tolerance.
		for (const [x, y, expected] of [
			[0.1, 0.5, PLATE],
			[0.9, 0.5, PLATE],
			[0.5, 0.1, PLATE],
			[0.5, 0.9, PLATE],
			[0.3, 0.3, PLATE + (255 - PLATE) * 0.9],
			[0.5, 0.7, PLATE + (255 - PLATE) * 0.9],
			[0.55, 0.3, PLATE],
		] as const) {
			const at = 3 * (Math.round(y * H) * W + Math.round(x * W));
			for (let ch = 0; ch < 3; ch++) expect(Math.abs(img[at + ch]! - expected)).toBeLessThanOrEqual(3);
		}
	}, 300_000);

	it('keyframed mask endpoints follow the specified path under 50% Motion scale', async () => {
		const { d, s } = fixture(12);
		const F = flicksPerFrame({ num: 30, den: 1 });
		const m = d.tx([{ type: 'mask.add', clipId: s, shape: 'ellipse', feather: 0, ref: '$m' }]).refs.$m!;
		d.tx([
			{ type: 'param.set', target: ['clip', s, 'transform', 'scale'], value: 50 },
			{
				type: 'mask.setPathKeys',
				maskId: m,
				keys: [
					{ at: { flicks: 0 }, path: ellipsePath([0.3, 0.5], [0.1, 0.2]) },
					{ at: { flicks: 11 * F }, path: ellipsePath([0.7, 0.4], [0.15, 0.1]) },
				],
			},
		]);
		const { planned, out } = await exportFrames(d, 12);
		expect(planned.plan.path).toBe('native');
		const imgs = decodeAll(out);
		for (const [f, cx, cy] of [
			[0, 0.3, 0.5],
			[11, 0.7, 0.4],
		] as const) {
			// At 50% centred scale: sequence position = quarter-frame offset + half layer position.
			const sx = (0.25 + cx * 0.5) * W;
			const sy = (0.25 + cy * 0.5) * H;
			const img = imgs[f]!;
			const at = (x: number, y: number) => img[3 * (Math.round(y) * W + Math.round(x))]!;
			expect(at(sx, sy), `frame ${f} centre`).toBeGreaterThan(240);
			// A point inside the scaled layer but outside both specified ellipses.
			expect(Math.abs(at(0.265 * W, 0.725 * H) - PLATE), `frame ${f} outside`).toBeLessThanOrEqual(3);
		}
	}, 300_000);
});
