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

function png(width: number, height: number, data: Buffer, colorType = 6): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = colorType;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(data)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

describe('PNG dimensions and scanline validation', () => {
	it('refuses oversized dimensions before expanding the compressed data', () => {
		expect(() => decodePng(png(0xffffffff, 0xffffffff, Buffer.from([0])))).toThrowError(
			expect.objectContaining({ code: 'E_LIMIT', hint: expect.stringContaining('smaller') }),
		);
	});

	it('decodes an 8K source image', () => {
		// Grayscale scanlines: one filter byte, then 7680 opaque black pixels per row.
		const image = decodePng(png(7680, 4320, Buffer.alloc(7681 * 4320), 0));
		expect([image.width, image.height, image.data.length]).toEqual([7680, 4320, 132_710_400]);
		expect([...image.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
		expect([...image.data.subarray(-4)]).toEqual([0, 0, 0, 255]);
	});

	it('validates dimensions and scanline lengths across varied PNG inputs', () => {
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
