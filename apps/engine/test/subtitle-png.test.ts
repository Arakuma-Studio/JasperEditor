// spec 13 AS-072: the kernel stream's in-process PNG decode (stream/png.ts) gives exactly what ffmpeg's
// `format=rgba` decode gives — for the layer bake's own PNGs (unfiltered rows) and for filtered RGBA / RGB PNGs (all
// five row filters, as Chrome writes them) — and leaves other kinds and other sizes to ffmpeg.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodePngRgba } from '../src/export/stream/png.ts';
import { encodePng } from '../src/export/synthetic.ts';
import { TEST_FFMPEG } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'jasper-png-'));

function ffDecode(file: string): Buffer {
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {
		maxBuffer: 1 << 26,
	});
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return r.stdout;
}

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
	it('equals ffmpeg for the bake’s own PNGs and for filtered RGBA and RGB PNGs', async () => {
		await fc.assert(
			fc.asyncProperty(image, fc.constantFrom('none', 'sub', 'up', 'avg', 'paeth', 'mixed'), async (im, pred) => {
				const own = join(dir, 'own.png');
				writeFileSync(own, encodePng(im.px, im.w, im.h));
				expect(Buffer.from((await decodePngRgba(readFileSync(own), im.w, im.h))!)).toEqual(ffDecode(own));
				for (const fmt of ['rgba', 'rgb24']) {
					const f = ffEncode(im.px, im.w, im.h, fmt, pred);
					const got = await decodePngRgba(readFileSync(f), im.w, im.h);
					expect(got, `${fmt} ${pred}`).not.toBeNull();
					expect(Buffer.from(got!)).toEqual(ffDecode(f));
				}
			}),
			{ numRuns: 25 },
		);
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
