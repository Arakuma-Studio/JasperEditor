import { crc32, deflateSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.ts';
import { decodePng } from '../src/png.ts';

function chunk(type: string, body: Buffer): Buffer {
	const out = Buffer.alloc(12 + body.length);
	out.writeUInt32BE(body.length, 0);
	out.write(type, 4);
	body.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
	return out;
}

function png(width: number, height: number, data: Buffer): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(data)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

describe('PNG allocation limits', () => {
	it('refuses oversized dimensions before expanding the compressed data', () => {
		expect(() => decodePng(png(0xffffffff, 0xffffffff, Buffer.from([0])))).toThrowError(
			expect.objectContaining({ code: 'E_LIMIT', hint: expect.stringContaining('smaller') }),
		);
	});

	it('allows an 8K source header through the dimension guard', () => {
		expect(() => decodePng(png(7680, 4320, Buffer.alloc(1)))).toThrowError(
			expect.objectContaining({ code: 'E_INVALID_PARAM', message: 'Invalid PNG data length' }),
		);
	});

	it('refuses compressed data that expands beyond its declared scanlines', () => {
		// A one-pixel RGBA PNG needs only five bytes, but this IDAT expands to a megabyte.
		const bomb = png(1, 1, Buffer.alloc(1024 * 1024));
		expect(bomb.byteLength).toBeLessThan(2048);
		expect(() => decodePng(bomb)).toThrowError(ToolError);
	});

	it('bounds inflation for varied dimensions and rejects oversized hostile dimensions', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 32 }),
				fc.integer({ min: 1, max: 32 }),
				fc.integer({ min: 8193, max: 0xffffffff }),
				(width, height, huge) => {
					const bytes = (width * 4 + 1) * height;
					const image = decodePng(png(width, height, Buffer.alloc(bytes)));
					expect([image.width, image.height, image.data.length]).toEqual([width, height, width * height * 4]);
					expect(() => decodePng(png(width, height, Buffer.alloc(bytes + 1)))).toThrowError(ToolError);
					expect(() => decodePng(png(huge, huge, Buffer.alloc(1)))).toThrowError(ToolError);
				},
			),
			{ seed: 20261011, numRuns: 50 },
		);
	});
});
