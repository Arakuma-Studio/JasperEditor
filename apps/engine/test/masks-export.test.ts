// wp masks: export routing (never a silent drop) and the native kernel's Opacity masks against the coverage
// definition (the preview's GL rasteriser computes the same numbers, packages/compositions/test/masks-gl.test.ts).
// Real ffmpeg (the engine's build), ProRes 4444.
import { spawnSync } from 'node:child_process';
import {
	ellipsePath,
	flicksPerFrame,
	maskExportRoute,
	rasterizeMasks,
	rectPath,
	resolveSceneAt,
} from '@jasper/project';
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

/** A dark plate (V1) and a white solid (V2) with masks; returns the builder and the solid's id. */
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
		const clip = planned.snapshot.videoTracks[1]!.clips[0]!;
		expect(maskExportRoute(clip)).toBe('stream');
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
		expect(maskExportRoute(planned.snapshot.videoTracks[1]!.clips[0]!)).toBe('bake');
		// Either the layer bake renders the layer (hybrid) or the export takes the Remotion path with a blocker.
		if (planned.plan.path === 'native') throw new Error('a masked effect must not export natively');
		if (planned.plan.path === 'remotion')
			expect(planned.plan.blockers.some((b) => b.itemId === s)).toBe(true);
	}, 120_000);
});

describe('native export of Opacity masks (stream kernel)', () => {
	it('static stacked masks: every pixel equals plate + (white − plate) × coverage (≤ 3/255)', async () => {
		const { d, s } = fixture(2);
		const r = d.tx([
			{ type: 'mask.add', clipId: s, shape: 'ellipse', feather: 40, ref: '$a' },
			{ type: 'mask.add', clipId: s, shape: 'polygon', ref: '$b' },
		]).refs;
		d.tx([
			{ type: 'mask.update', maskId: r.$b, mode: 'subtract' },
			{ type: 'param.set', target: ['mask', r.$b!, 'path'], value: rectPath(0.45, 0.2, 0.7, 0.55) },
			{ type: 'param.set', target: ['mask', r.$b!, 'feather'], value: 0 },
			{ type: 'param.set', target: ['mask', r.$a!, 'expansion'], value: 25 },
			{ type: 'param.set', target: ['mask', r.$a!, 'opacity'], value: 90 },
		]);
		const { planned, out } = await exportFrames(d, 2);
		expect(planned.plan.path).toBe('native');
		const layer = resolveSceneAt(planned.snapshot, 0).find((l) => l.clip.clipId === s)!;
		const cov = rasterizeMasks(layer.props.masks, W, H, (q) => [q[0] * W, q[1] * H], 1)!;
		const img = decodeAll(out)[0]!;
		let worst = 0;
		let inside = 0;
		for (let i = 0; i < W * H; i++) {
			const want = PLATE + (255 - PLATE) * cov[i]!;
			worst = Math.max(worst, Math.abs(img[3 * i]! - want));
			if (cov[i]! > 0.8) inside++;
		}
		expect(inside).toBeGreaterThan(10_000);
		expect(worst).toBeLessThanOrEqual(3);
	}, 300_000);

	it('keyframed Mask Path and Motion: frames follow the evaluated mask through the layer map', async () => {
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
		for (const f of [0, 5, 11]) {
			const layer = resolveSceneAt(planned.snapshot, f).find((l) => l.clip.clipId === s)!;
			const mm = layer.props.matrix;
			const [cx, cy] = layer.props.masks[0]!.path.vertices.reduce(
				(a, v) => [a[0] + v.p[0] / 4, a[1] + v.p[1] / 4],
				[0, 0],
			);
			// Mask centre in sequence px through the layer map (layer px = normalised × box).
			const lx = cx * W;
			const ly = cy * H;
			const sx = mm.a * lx + mm.c * ly + mm.e;
			const sy = mm.b * lx + mm.d * ly + mm.f;
			const img = imgs[f]!;
			const at = (x: number, y: number) => img[3 * (Math.round(y) * W + Math.round(x))]!;
			expect(at(sx, sy), `frame ${f} centre`).toBeGreaterThan(240);
			// A corner of the half-size layer, outside every key's ellipse: the plate.
			const ox = mm.a * (0.03 * W) + mm.c * (0.95 * H) + mm.e;
			const oy = mm.b * (0.03 * W) + mm.d * (0.95 * H) + mm.f;
			expect(Math.abs(at(ox, oy) - PLATE), `frame ${f} outside`).toBeLessThanOrEqual(3);
		}
	}, 300_000);
});
