import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rng } from '../src/fuzz.ts';
import {
	assertDistinctScenes,
	checkGolden,
	decodePng,
	diffImage,
	diffImages,
	encodePng,
	expectFingerprints,
	expectPins,
	GoldenMismatch,
	MAX_GOLDEN_BYTES,
	meanGrid,
	PngError,
	type Rgba8,
	rgba8,
	Tolerance,
	writePng,
} from '../src/index.ts';

function ramp(w: number, h: number, alpha = 255): Rgba8 {
	const img = rgba8(w, h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			img.data.set([Math.floor((x * 255) / w), Math.floor((y * 255) / h), 77, alpha], i);
		}
	return img;
}

let dir: string;
const env = { ...process.env };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'testkit-golden-'));
	process.env.JASPER_TEST_RESULTS = join(dir, 'results');
	delete process.env.JASPER_BLESS;
});
afterEach(() => {
	process.env = { ...env };
	rmSync(dir, { recursive: true, force: true });
});

describe('PNG codec', () => {
	it('round-trips opaque (RGB) and translucent (RGBA) images', () => {
		for (const a of [255, 128]) {
			const img = ramp(37, 21, a);
			const png = encodePng(img);
			expect(png[25]).toBe(a === 255 ? 2 : 6); // IHDR colour type
			expect(decodePng(png)).toEqual(img);
		}
	});

	it('rejects malformed input with PngError', () => {
		const png = encodePng(ramp(8, 8));
		expect(() => decodePng(new Uint8Array(0))).toThrow(PngError);
		expect(() => decodePng(png.subarray(0, 20))).toThrow(PngError);
		const bad = Buffer.from(png);
		bad[40] = bad[40]! ^ 0xff; // inside IDAT → CRC mismatch
		expect(() => decodePng(bad)).toThrow(PngError);
	});
});

describe('difference metrics', () => {
	it('PSNR, max, p99, mean and differing pixels', () => {
		const a = ramp(10, 10);
		expect(diffImages(a, a).psnr).toBe(Number.POSITIVE_INFINITY);
		const b = rgba8(10, 10, Uint8Array.from(a.data));
		b.data[0] = b.data[0]! + 10;
		const d = diffImages(a, b);
		expect([d.maxAbs, d.p99, d.differing]).toEqual([10, 0, 1]);
		expect(d.meanAbs).toBeCloseTo(10 / 400, 12);
		expect(d.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / (100 / 400)), 9);
		expect(Tolerance.accepts(Tolerance.RENDER, d)).toBe(true);
		expect(Tolerance.accepts(Tolerance.EXACT, d)).toBe(false);
		expect(() => diffImages(a, ramp(10, 11))).toThrow(RangeError);
	});

	it('the diff image amplifies differences ×8 and shows alpha differences', () => {
		const a = ramp(4, 1);
		const b = rgba8(4, 1, Uint8Array.from(a.data));
		b.data[0] = b.data[0]! + 3;
		b.data[7] = 250;
		const d = diffImage(a, b);
		expect(Array.from(d.data.subarray(0, 4))).toEqual([24, 0, 0, 255]);
		expect(Array.from(d.data.subarray(4, 8))).toEqual([40, 40, 40, 255]);
	});

	it('computes the mean RGB of each grid cell', () => {
		const img = rgba8(4, 4);
		for (let i = 0; i < 16; i++) img.data.set([i < 8 ? 255 : 0, 0, 0, 255], i * 4);
		expect(meanGrid(img, 2)).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
	});
});

describe('golden files', () => {
	it('accepts within tolerance, reports and writes actual/expected/diff otherwise', () => {
		const path = join(dir, 'ramp.png');
		const img = ramp(32, 16);
		writePng(path, img);
		expect(checkGolden(path, img, Tolerance.EXACT).psnr).toBe(Number.POSITIVE_INFINITY);
		const near = rgba8(32, 16, Uint8Array.from(img.data));
		near.data[5] = near.data[5]! + 1;
		expect(() => checkGolden(path, near, Tolerance.RENDER)).not.toThrow();
		const far = rgba8(32, 16, Uint8Array.from(img.data));
		for (let i = 0; i < far.data.length; i += 4) far.data[i] = 255 - far.data[i]!;
		expect(() => checkGolden(path, far, Tolerance.RENDER)).toThrow(/PSNR .*tolerance: PSNR ≥ 45/);
		for (const k of ['actual', 'expected', 'diff'])
			expect(existsSync(join(dir, 'results', 'golden-failures', `ramp.${k}.png`))).toBe(true);
		expect(() => checkGolden(join(dir, 'missing.png'), img, Tolerance.RENDER)).toThrow(/JASPER_BLESS/);
		expect(() => checkGolden(path, ramp(16, 16), Tolerance.RENDER)).toThrow(/size 16×16/);
	});

	it('JASPER_BLESS=1 writes references and enforces the size cap', () => {
		process.env.JASPER_BLESS = '1';
		const path = join(dir, 'sub', 'new.png');
		checkGolden(path, ramp(20, 10), Tolerance.RENDER);
		expect(decodePng(readFileSync(path))).toEqual(ramp(20, 10));
		const noise = rgba8(200, 200);
		const rng = new Rng(1);
		for (let i = 0; i < noise.data.length; i++) noise.data[i] = rng.next() & 0xff;
		expect(() => checkGolden(join(dir, 'noise.png'), noise, Tolerance.RENDER)).toThrow(
			new RegExp(`${MAX_GOLDEN_BYTES}-byte golden limit`),
		);
		expect(existsSync(join(dir, 'noise.png'))).toBe(false);
	});

	it('the scene guard rejects blank and duplicated scenes', () => {
		const a = ramp(32, 18);
		const b = ramp(32, 18, 200);
		expect(() =>
			assertDistinctScenes({
				a,
				b: rgba8(
					32,
					18,
					b.data.map((v, i) => (i % 4 === 1 ? 255 - v : v)),
				),
			}),
		).not.toThrow();
		const flat = rgba8(32, 18, new Uint8Array(32 * 18 * 4).fill(90));
		expect(() => assertDistinctScenes({ a, flat })).toThrow(/flat: blank/);
		expect(() => assertDistinctScenes({ a, copy: rgba8(32, 18, Uint8Array.from(a.data)) })).toThrow(
			/a ≈ copy/,
		);
	});
});

describe('fingerprints and pins', () => {
	it('compare within ±tolerance, report missing and stale cases, bless on demand', () => {
		const file = join(dir, 'fp.json');
		const grid = Array.from({ length: 48 }, (_, i) => i);
		expect(() => expectFingerprints(file, { x: grid })).toThrow(/not in .*JASPER_BLESS/);
		process.env.JASPER_BLESS = '1';
		expectFingerprints(file, { x: grid, y: grid });
		delete process.env.JASPER_BLESS;
		expectFingerprints(file, { x: grid.map((v) => v + 3.9) });
		expect(() => expectFingerprints(file, { x: grid.map((v, i) => (i === 7 ? v + 5 : v)) })).toThrow(
			/cell 2 channel G off by 5/,
		);
		expect(() => expectFingerprints(file, { x: grid }, 4, { complete: true })).toThrow(/y: stale entry/);
		expect(() => expectFingerprints(file, { x: [...grid.slice(0, 47), Number.NaN] })).toThrow(
			/off by Infinity/,
		);
	});

	it('pins are exact', () => {
		const file = join(dir, 'pins.json');
		writeFileSync(file, JSON.stringify({ a: 1, b: 'x' }));
		expectPins(file, { a: 1, b: 'x' });
		expect(() => expectPins(file, { a: 2 })).toThrow(GoldenMismatch);
	});
});
