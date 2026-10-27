// spec 13 AS-072: the kernel stream's PNG decode reproduces authored pixels exactly, for the layer bake's own
// PNGs and FFmpeg-encoded RGBA / RGB PNGs using every row filter. Other kinds and sizes fall back to FFmpeg.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { decodePngRgba } from '../src/export/stream/png.ts';
import { encodePng } from '../src/export/synthetic.ts';
import { TEST_FFMPEG } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'jasper-png-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** `px` (RGBA) re-encoded by ffmpeg as `pixFmt` with row prediction `pred`. */
function ffEncode(px: Uint8Array, w: number, h: number, pixFmt: string, pred: string): string {
	const raw = join(dir, `in-${w}x${h}.rgba`);
	const out = join(dir, `out-${w}x${h}-${pixFmt}-${pred}.png`);
	writeFileSync(raw, px);
	const r = spawnSync(TEST_FFMPEG, [
		...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', raw],
		...['-pix_fmt', pixFmt, '-pred', pred, '-frames:v', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

const image = fc
	.record({ w: fc.integer({ min: 1, max: 40 }), h: fc.integer({ min: 1, max: 24 }), seed: fc.integer() })
	.map(({ w, h, seed }) => {
		const px = new Uint8Array(w * h * 4);
		let s = seed | 1;
		for (let i = 0; i < px.length; i++) {
			s ^= s << 13;
			s ^= s >>> 17;
			s ^= s << 5;
			// Smooth regions and noise, so every row filter is chosen somewhere.
			px[i] = i % 7 === 0 ? s & 0xff : (i * 3 + (s & 3)) & 0xff;
		}
		return { w, h, px };
	});

describe('kernel stream PNG decode (AS-072)', () => {
	it('reproduces authored pixels for the bake’s PNGs and every RGBA / RGB row filter', async () => {
		await fc.assert(
			fc.asyncProperty(image, async ({ px, w, h }) => {
				expect(await decodePngRgba(encodePng(px, w, h), w, h)).toEqual(px);
			}),
			{ numRuns: 25 },
		);
		// Lossless external encoder: the expected pixels are the input, with opaque alpha for RGB PNGs.
		const w = 13;
		const h = 7;
		const px = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 37 + (i % 11) * 61) & 255);
		for (const pred of ['none', 'sub', 'up', 'avg', 'paeth', 'mixed'])
			for (const fmt of ['rgba', 'rgb24']) {
				const file = ffEncode(px, w, h, fmt, pred);
				const expected = px.map((value, i) => (fmt === 'rgb24' && i % 4 === 3 ? 255 : value));
				expect(await decodePngRgba(readFileSync(file), w, h), `${fmt} ${pred}`).toEqual(expected);
			}
	}, 120_000);

	it('leaves other sizes, palettes and 16-bit PNGs to ffmpeg; a corrupt file throws', async () => {
		const px = new Uint8Array(8 * 4 * 4).fill(200);
		const own = encodePng(px, 8, 4);
		expect(await decodePngRgba(own, 8, 5)).toBeNull();
		expect(await decodePngRgba(readFileSync(ffEncode(px, 8, 4, 'pal8', 'none')), 8, 4)).toBeNull();
		expect(await decodePngRgba(readFileSync(ffEncode(px, 8, 4, 'rgba64be', 'none')), 8, 4)).toBeNull();
		expect(await decodePngRgba(Buffer.from('not a png at all, just text......'), 8, 4)).toBeNull();
		const broken = Buffer.from(own);
		broken.fill(0x55, 41, 60);
		await expect(decodePngRgba(broken, 8, 4)).rejects.toThrow();
	});
});
