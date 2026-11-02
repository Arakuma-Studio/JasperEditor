// Spec 19 TL-114 without a renderer: the measured trim, the streaming ZIP and what is handed to ffmpeg. Real renders are in
// delivery.e2e.test.ts.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlphaDeliveryRequestSchema, StillRequestSchema } from '@jasper/api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canvasPads, frameFilterArgs } from '../src/export/delivery/alpha.ts';
import { alphaBounds, grownBox, touchesEdge, unionBounds } from '../src/export/delivery/trim.ts';
import { StoredZipWriter, ZipTooLargeError } from '../src/export/delivery/zip-writer.ts';
import { stillEncodeArgs } from '../src/export/still-formats.ts';
import { listZip, readZipEntry } from '../src/imports/zip.ts';
import { assertLgplGraphArgs } from '../src/tools/ffmpeg.ts';
import { DocBuilder, TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'jasper-alpha-'));

describe('trim (TL-114)', () => {
	it('finds the box of what is painted, half-open', () => {
		const px = new Uint8Array(10 * 6 * 4);
		px[(2 * 10 + 3) * 4 + 3] = 1;
		px[(4 * 10 + 7) * 4 + 3] = 200;
		expect(alphaBounds(px, 10, 6)).toEqual({ x0: 3, y0: 2, x1: 8, y1: 5 });
	});

	it('nothing painted is null, not an empty box', () => {
		expect(alphaBounds(new Uint8Array(40), 5, 2)).toBeNull();
		expect(unionBounds(null, null)).toBeNull();
	});

	it('property: the bounds hold every painted pixel and touch each side', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 24 }),
				fc.integer({ min: 1, max: 24 }),
				fc.array(fc.tuple(fc.nat(23), fc.nat(23), fc.integer({ min: 1, max: 255 })), { maxLength: 12 }),
				(w, h, points) => {
					const px = new Uint8Array(w * h * 4);
					const on = points.filter(([x, y]) => x < w && y < h);
					for (const [x, y, a] of on) px[(y * w + x) * 4 + 3] = a;
					const b = alphaBounds(px, w, h);
					if (!on.length) {
						expect(b).toBeNull();
						return;
					}
					expect(b).not.toBeNull();
					expect(b!.x0).toBe(Math.min(...on.map((p) => p[0])));
					expect(b!.y0).toBe(Math.min(...on.map((p) => p[1])));
					expect(b!.x1).toBe(Math.max(...on.map((p) => p[0])) + 1);
					expect(b!.y1).toBe(Math.max(...on.map((p) => p[1])) + 1);
				},
			),
			{ numRuns: 300 },
		);
	});

	it('the union of frames is what a moving title needs', () => {
		expect(unionBounds({ x0: 10, y0: 10, x1: 20, y1: 20 }, { x0: 5, y0: 15, x1: 12, y1: 30 })).toEqual({
			x0: 5,
			y0: 10,
			x1: 20,
			y1: 30,
		});
	});

	it('a margin stays inside the canvas; touching an edge is seen', () => {
		expect(grownBox({ x0: 2, y0: 3, x1: 8, y1: 9 }, 5, 10, 10)).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
		expect(touchesEdge({ x0: 0, y0: 3, x1: 8, y1: 9 }, 10, 10)).toBe(true);
		expect(touchesEdge({ x0: 1, y0: 1, x1: 9, y1: 9 }, 10, 10)).toBe(false);
	});

	it('the canvas grows, within the texture limit', () => {
		expect(canvasPads(1920, 1080)).toEqual([480, 960]);
		expect(canvasPads(16000, 9000)).toEqual([]);
	});
});

describe('stored ZIP (TL-114)', () => {
	it('writes entries a reader takes back byte for byte, in order, atomically', async () => {
		const a = join(dir, 'a.bin');
		const b = join(dir, 'b.bin');
		writeFileSync(a, Buffer.alloc(70_000, 7));
		writeFileSync(b, 'second');
		const dest = join(dir, 'out.zip');
		const z = await StoredZipWriter.create(dest);
		await z.add('a.bin', a);
		await z.add('título.bin', b);
		await z.finish();
		const buf = readFileSync(dest);
		const entries = listZip(buf);
		expect(entries.map((e) => e.name)).toEqual(['a.bin', 'título.bin']);
		expect(readZipEntry(buf, entries[0]!).length).toBe(70_000);
		expect(readZipEntry(buf, entries[1]!).toString()).toBe('second');
		expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});

	it('an aborted archive leaves nothing under the final name', async () => {
		const dest = join(dir, 'gone.zip');
		const z = await StoredZipWriter.create(dest);
		await z.add('a.bin', join(dir, 'a.bin'));
		await z.abort();
		expect(readdirSync(dir)).not.toContain('gone.zip');
		expect(readdirSync(dir).filter((f) => f.startsWith('.gone'))).toEqual([]);
	});

	it('names the limit instead of truncating', () => {
		expect(new ZipTooLargeError('x').name).toBe('ZipTooLargeError');
	});
});

describe('requests (TL-114)', () => {
	const base = { envelope: new DocBuilder().envelope(), sequenceId: 's' };

	it('refuses an empty or endless range and a huge margin', () => {
		const parse = (o: object) => AlphaDeliveryRequestSchema.safeParse({ ...base, ...o }).success;
		expect(parse({ range: { start: 5, end: 5 } })).toBe(false);
		expect(parse({ range: { start: 0, end: 36_001 } })).toBe(false);
		expect(parse({ range: { start: 0, end: 2 }, trim: { marginPx: 5000 } })).toBe(false);
	});

	it('refuses a transparent still in a format without alpha', () => {
		const parse = (format: string) =>
			StillRequestSchema.safeParse({ ...base, frame: 0, alpha: true, format }).success;
		expect(['png', 'tiff', 'tga'].map(parse)).toEqual([true, true, true]);
		expect(['jpeg', 'dpx', 'bmp', 'exr'].map(parse)).toEqual([false, false, false, false]);
	});
});

describe('LGPL (AGENTS §2)', () => {
	it('the crop and display graph passes the guard and names no GPL filter', () => {
		const args = frameFilterArgs('/a', '/b', ['lut3d=/tmp/x.cube', 'crop=10:10:1:2']);
		expect(() => assertLgplGraphArgs(args)).not.toThrow();
		expect(args.join(' ')).not.toMatch(/cropdetect|eq=|boxblur/);
	});

	it('a crop keeps straight alpha: colour under alpha 1 comes back untouched', () => {
		const w = 8;
		const px = Buffer.alloc(w * w * 4);
		for (let i = 0; i < w * w; i++) px.set([91, 173, 37, 1], i * 4);
		const raw = join(dir, 'crop.rgba');
		writeFileSync(raw, px);
		const src = join(dir, 'crop-in');
		spawnSync('mkdir', ['-p', src]);
		const dst = join(dir, 'crop-out');
		spawnSync('mkdir', ['-p', dst]);
		const made = spawnSync(TEST_FFMPEG, [
			'-y',
			'-v',
			'error',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgba',
			'-s',
			`${w}x${w}`,
			'-i',
			raw,
			'-frames:v',
			'1',
			'-c:v',
			'png',
			'-pix_fmt',
			'rgba',
			join(src, '000000.png'),
		]);
		expect(made.status, String(made.stderr)).toBe(0);
		const run = spawnSync(TEST_FFMPEG, ['-y', '-v', 'error', ...frameFilterArgs(src, dst, ['crop=4:4:2:2'])]);
		expect(run.status, String(run.stderr)).toBe(0);
		const back = spawnSync(TEST_FFMPEG, [
			'-v',
			'error',
			'-i',
			join(dst, '000000.png'),
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgba',
			'pipe:1',
		]);
		expect([...back.stdout.subarray(0, 4)]).toEqual([91, 173, 37, 1]);
		const probe = spawnSync(
			TEST_FFPROBE,
			['-v', 'error', '-show_entries', 'stream=pix_fmt,width', '-of', 'csv=p=0', join(dst, '000000.png')],
			{ encoding: 'utf8' },
		);
		expect(probe.stdout.trim()).toBe('4,rgba');
	});

	it('TIFF and Targa keep their alpha pixel format only when asked', () => {
		expect(stillEncodeArgs('tiff', undefined, true)).toContain('rgba');
		expect(stillEncodeArgs('tga', undefined, true)).toContain('bgra');
		expect(stillEncodeArgs('tiff')).toContain('rgb24');
		expect(stillEncodeArgs('tga')).toContain('bgr24');
	});
});
