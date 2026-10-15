// PNG avoids chroma subsampling; expected pixels follow independent blend/alpha definitions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blendModeIndex, makeBlendKernel } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blendStackedFrame } from '../src/export/blend/kernel.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

const W = 1920;
const HH = 1080;
let app: TestApp;
let base: Buffer;
let layer: Buffer;
let baseMedia: Awaited<ReturnType<typeof register>>;
let layerMedia: Awaited<ReturnType<typeof register>>;

function pattern(file: string, r: string, g: string, b: string) {
	const res = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${HH}:d=1`],
		...['-vf', `format=rgb24,geq=r='${r}':g='${g}':b='${b}'`, '-frames:v', '1', file],
	]);
	if (res.status !== 0) throw new Error(res.stderr.toString());
}

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	const dir = mkdtempSync(join(tmpdir(), 'jasper-blend-'));
	const baseFile = join(dir, 'base.png');
	const layerFile = join(dir, 'layer.png');
	pattern(baseFile, 'mod(X*7+Y*3,256)', 'mod(X*5+Y*11,256)', 'mod(X*13+Y*2,256)');
	pattern(layerFile, 'mod(X*3+Y*17,256)', 'mod(X*11+Y*5,256)', 'mod(X*2+Y*9,256)');
	baseMedia = await register(app, baseFile);
	layerMedia = await register(app, layerFile);
	base = decode(baseFile);
	layer = decode(layerFile);
}, 180_000);
afterAll(closeApps);

async function still(d: DocBuilder): Promise<{ rgb: Buffer; renderPath: string }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame: 0 },
	});
	expect(r.statusCode).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error).toBeUndefined();
	const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
	const f = join(mkdtempSync(join(tmpdir(), 'jasper-blend-png-')), 'f.png');
	writeFileSync(f, png.rawPayload);
	return { rgb: decode(f), renderPath: (done.result as { renderPath: string }).renderPath };
}

function decode(file: string): Buffer {
	const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
		maxBuffer: 64 << 20,
	});
	expect(raw.status, raw.stderr.toString()).toBe(0);
	expect(raw.stdout.length).toBe(W * HH * 3);
	return raw.stdout;
}

function doc(mode: string): DocBuilder {
	const d = new DocBuilder();
	const a = d.addMedia(baseMedia);
	const b = d.addMedia(layerMedia);
	d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
	const r = d.tx([{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { video: 'V2' }, ref: '$l' }]);
	d.tx([{ type: 'clip.update', clipIds: [r.refs.$l!], patch: { blendMode: mode } }]);
	return d;
}

const STEP = 37;

describe('blend modes on the native export (real ffmpeg + blend kernel)', () => {
	it('two blend layers with a Normal layer between them', async () => {
		const d = doc('multiply');
		const b = d.addMedia(baseMedia);
		const n = d.tx([
			{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { video: 'V3' }, ref: '$n' },
		]).refs.$n!;
		const r = d.tx([
			{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { video: 'V4' }, ref: '$s' },
		]);
		d.tx([
			{ type: 'param.set', target: ['clip', n, 'opacity'], value: 50 },
			{ type: 'clip.update', clipIds: [r.refs.$s!], patch: { blendMode: 'difference' } },
		]);
		const out = await still(d);
		expect(out.renderPath).toBe('native');
		let worst = 0;
		for (let p = 0; p < W * HH; p += STEP * 3) {
			const i = p * 3;
			for (let k = 0; k < 3; k++) {
				const b = base[i + k]! / 255;
				const l = layer[i + k]! / 255;
				// Multiply, source-over at 50%, then Difference: independent blend definitions.
				const mixed = b * l * (127 / 255) + b * (128 / 255);
				const expected = Math.abs(mixed - b) * 255;
				worst = Math.max(worst, Math.abs(expected - out.rgb[i + k]!));
			}
		}
		expect(worst).toBeLessThanOrEqual(3);
	}, 60_000);
});

describe('blend kernel (unit)', () => {
	it('copies the composite on inactive frames and through transparent layer pixels; stencils clear', () => {
		const K = makeBlendKernel();
		const src = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0]);
		const out = new Uint8Array(4);
		blendStackedFrame(K, src, 1, 1, blendModeIndex('multiply'), 0, true, out);
		expect([...out]).toEqual([10, 20, 30, 255]);
		blendStackedFrame(K, src, 1, 1, blendModeIndex('stencil-alpha'), 0, true, out);
		expect([...out]).toEqual([0, 0, 0, 0]);
		blendStackedFrame(K, src, 1, 1, blendModeIndex('stencil-alpha'), 0, false, out);
		expect([...out]).toEqual([10, 20, 30, 255]);
	});
});
