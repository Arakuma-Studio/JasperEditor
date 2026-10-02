// The render_frames contact-sheet decoder must accept standard PNG scanline filters and colour types
// produced by encoders outside this repository.
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/png.ts';

/** A PNG of raw 8-bit samples with the given filter type per row (cycled), as encoders other than ours write. */
function filteredPng(
	width: number,
	height: number,
	channels: number,
	samples: Uint8Array,
	filters: number[],
) {
	const stride = width * channels;
	const raw = Buffer.alloc((stride + 1) * height);
	const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : samples[y * stride + x]!);
	for (let y = 0; y < height; y++) {
		const f = filters[y % filters.length]!;
		raw[y * (stride + 1)] = f;
		for (let x = 0; x < stride; x++) {
			const a = at(x - channels, y);
			const b = at(x, y - 1);
			const c = at(x - channels, y - 1);
			const p = a + b - c;
			const pr =
				Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
					? a
					: Math.abs(p - b) <= Math.abs(p - c)
						? b
						: c;
			const pred = [0, a, b, (a + b) >> 1, pr][f]!;
			raw[y * (stride + 1) + 1 + x] = (at(x, y) - pred) & 0xff;
		}
	}
	const chunk = (type: string, body: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length);
		const data = Buffer.concat([Buffer.from(type, 'latin1'), body]);
		const check = Buffer.alloc(4);
		check.writeUInt32BE(crc32(data));
		return Buffer.concat([len, data, check]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]!;
	const idat = deflateSync(raw);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		// Split IDAT, as large encoders do.
		chunk('IDAT', idat.subarray(0, 10)),
		chunk('IDAT', idat.subarray(10)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function noise(n: number, seed = 1): Uint8Array {
	const out = new Uint8Array(n);
	let s = seed;
	for (let i = 0; i < n; i++) out[i] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
	return out;
}

describe('PNG input for render_frames', () => {
	it('decodes RGB and RGBA rows of every filter type', () => {
		const rgb = noise(7 * 5 * 3);
		const a = decodePng(filteredPng(7, 5, 3, rgb, [0, 1, 2, 3, 4]));
		expect([a.width, a.height]).toEqual([7, 5]);
		for (let i = 0; i < 35; i++) {
			expect([...a.data.subarray(i * 4, i * 4 + 4)]).toEqual([...rgb.subarray(i * 3, i * 3 + 3), 255]);
		}
		const rgba = noise(6 * 4 * 4, 9);
		expect([...decodePng(filteredPng(6, 4, 4, rgba, [4, 3, 2, 1])).data]).toEqual([...rgba]);
	});

	it('decodes greyscale (with alpha) to RGBA and rejects what it does not support', () => {
		const g = decodePng(filteredPng(2, 1, 2, Uint8Array.from([10, 200, 30, 40]), [1]));
		expect([...g.data]).toEqual([10, 10, 10, 200, 30, 30, 30, 40]);
		expect(() => decodePng(Buffer.from('not a png'))).toThrow(/Not a PNG/);
		const sixteen = filteredPng(1, 1, 3, Uint8Array.from([1, 2, 3]), [0]);
		sixteen[8 + 8 + 8] = 16; // IHDR bit depth
		sixteen.writeUInt32BE(crc32(sixteen.subarray(12, 29)), 29);
		expect(() => decodePng(sixteen)).toThrow(/only 8-bit/);
	});
});
