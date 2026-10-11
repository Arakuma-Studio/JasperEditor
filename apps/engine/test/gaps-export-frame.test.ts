import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eotf, jpegQscale, stillCurveFor } from '../src/export/still-formats.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	H,
	JSON_H,
	makeApp,
	TEST_FFMPEG,
	TEST_FFPROBE,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
const FFMPEG = TEST_FFMPEG;
const FFPROBE = TEST_FFPROBE;
const out = mkdtempSync(join(tmpdir(), 'jasper-export-frame-'));

beforeAll(async () => {
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

function doc(): DocBuilder {
	const d = new DocBuilder('hd-720p-30');
	d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0.5, 0.5, 0.5, 1] }]);
	return d;
}

async function still(payload: Record<string, unknown>) {
	const r = await app.inject({ method: 'POST', url: '/api/stills', headers: JSON_H, payload });
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return {
		id: r.json().id as string,
		result: done.result as { url: string; path?: string; format?: string },
	};
}

function codecOf(file: string): string {
	const r = spawnSync(FFPROBE, [
		'-v',
		'error',
		'-show_entries',
		'stream=codec_name,pix_fmt,width,height',
		'-of',
		'csv=p=0',
		file,
	]);
	return r.stdout.toString().trim();
}

describe('Export Frame formats', () => {
	it('maps quality and curves', () => {
		expect(jpegQscale(100)).toBe(2);
		expect(jpegQscale(1)).toBe(31);
		expect(stillCurveFor('rec709')).toBe('bt1886');
		expect(stillCurveFor('srgb')).toBe('srgb');
		expect(stillCurveFor('rec2100-pq')).toBe('bt1886');
		expect(eotf('srgb', 0.5)).toBeCloseTo(0.214, 3);
		expect(eotf('bt1886', 0.5)).toBeCloseTo(0.5 ** 2.4, 6);
	});

	it.each([
		['jpeg', 'jpg', /^mjpeg,1280,720,yuvj444p/],
		['tiff', 'tif', /^tiff,1280,720,rgb24/],
		['dpx', 'dpx', /^dpx,1280,720,gbrp10le/],
		['bmp', 'bmp', /^bmp,1280,720,bgr24/],
		['tga', 'tga', /^targa,1280,720,bgr24/],
		['png', 'png', /^png,1280,720,rgb/],
	])(
		'%s to a folder',
		async (format, ext, codec) => {
			const d = doc();
			const { id, result } = await still({
				envelope: d.envelope(),
				sequenceId: d.seqId,
				frame: 5,
				format,
				destination: { folder: out, name: `frame-${format}` },
			});
			expect(result.format).toBe(format);
			expect(result.path).toBe(join(out, `frame-${format}.${ext}`));
			expect(codecOf(result.path!)).toMatch(codec);
			const served = await app.inject({ method: 'GET', url: `/renders/${id}/output`, headers: H });
			expect(served.statusCode).toBe(200);
		},
		120_000,
	);

	it('never overwrites: a second frame with the same name gets " (2)"', async () => {
		const d = doc();
		const a = await still({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 0,
			destination: { folder: out, name: 'dup' },
		});
		const b = await still({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 0,
			destination: { folder: out, name: 'dup' },
		});
		expect(a.result.path).toBe(join(out, 'dup.png'));
		expect(b.result.path).toBe(join(out, 'dup (2).png'));
		expect(existsSync(b.result.path!)).toBe(true);
	}, 120_000);

	it('OpenEXR holds linear light: gray 0.5 → its BT.1886 EOTF (half float)', async () => {
		const d = doc();
		const { result } = await still({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 3,
			format: 'exr',
			destination: { folder: out, name: 'linear' },
		});
		expect(codecOf(result.path!)).toMatch(/^exr,/);
		const raw = spawnSync(
			FFMPEG,
			['-v', 'error', '-i', result.path!, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-'],
			{
				maxBuffer: 1 << 26,
			},
		).stdout;
		const g = raw.readFloatLE(0);
		// The solid renders as 128/255 (± 1 code value of the display transform): linear (v)^2.4.
		const lo = (127 / 255) ** 2.4;
		const hi = (129 / 255) ** 2.4;
		expect(g).toBeGreaterThan(lo - 0.002);
		expect(g).toBeLessThan(hi + 0.002);
	}, 120_000);

	it('refuses a relative folder and a name that is a path', async () => {
		const d = doc();
		const rel = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				frame: 0,
				destination: { folder: 'rel', name: 'x' },
			},
		});
		expect(rel.statusCode).toBe(400);
		const bad = await app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				frame: 0,
				destination: { folder: out, name: '../x' },
			},
		});
		expect(bad.statusCode).toBe(400);
	});
});
