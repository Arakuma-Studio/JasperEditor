// Frozen PNG protocol vectors, independently decoded to RGBA with FFmpeg.
// The RGB/RGBA vectors have filters 0, 1, 2, 3, 4 in order and split IDAT chunks.
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { composeGrid, decodePng, encodePng } from '../src/png.ts';

const RGB = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAAFCAIAAADg0arLAAAACklEQVR4nGPgNgitmn+EW57b9AAAABpJREFU8SWfcX5+PtM9MGB2Cnm+fPlyFggPABedEsmvv92MAAAAAElFTkSuQmCC',
	'base64',
);
const RGB_PIXELS = [
	11, 48, 85, 255, 122, 159, 196, 255, 233, 14, 51, 255, 88, 125, 162, 255, 199, 236, 17, 255, 54, 91, 128,
	255, 165, 202, 239, 255, 20, 57, 94, 255, 131, 168, 205, 255, 242, 23, 60, 255,
];

const RGBA = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAAFCAYAAABvsz2cAAAACklEQVR4nGPgNgitmn/kFiy6rAAAACBJREFUJR+jcUTtoilAwKQBBcxhGdW9cffu3WOBCkwBAGGfDxPzrZ5QAAAAAElFTkSuQmCC',
	'base64',
);
const RGBA_PIXELS = [
	11, 48, 85, 122, 159, 196, 233, 14, 51, 88, 125, 162, 199, 236, 17, 54, 91, 128, 165, 202, 239, 20, 57, 94,
	131, 168, 205, 242, 23, 60, 97, 134, 171, 208, 245, 26, 63, 100, 137, 174,
];

const GREY_ALPHA = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAAFCAQAAADFuvUXAAAACklEQVR4nGPgNgitYpx/v3VyJwAAABRJREFUxMuLaQoQMK87kJ/PAmIBAG61CfikVX0eAAAAAElFTkSuQmCC',
	'base64',
);
const GREY_ALPHA_PIXELS = [
	11, 11, 11, 48, 85, 85, 85, 122, 159, 159, 159, 196, 233, 233, 233, 14, 51, 51, 51, 88, 125, 125, 125, 162,
	199, 199, 199, 236, 17, 17, 17, 54, 91, 91, 91, 128, 165, 165, 165, 202,
];

describe('PNG input for render_frames', () => {
	it('decodes RGB and RGBA rows of every filter type', () => {
		for (const [png, pixels] of [
			[RGB, RGB_PIXELS],
			[RGBA, RGBA_PIXELS],
		] as const) {
			const decoded = decodePng(png);
			expect([decoded.width, decoded.height]).toEqual([2, 5]);
			expect([...decoded.data]).toEqual(pixels);
		}
	});

	it('decodes greyscale with alpha and rejects unsupported input', () => {
		expect([...decodePng(GREY_ALPHA).data]).toEqual(GREY_ALPHA_PIXELS);
		expect(() => decodePng(Buffer.from('not a png'))).toThrow();
		const sixteen = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABEAIAAADA54+dAAAAD0lEQVR4nGMQMgmrmLUHAAYnAmsO3tV6AAAAAElFTkSuQmCC',
			'base64',
		);
		expect(() => decodePng(sixteen)).toThrow();
	});
});

function pngChunk(type: string, body: Uint8Array): Buffer {
	const out = Buffer.alloc(body.length + 12);
	out.writeUInt32BE(body.length, 0);
	out.write(type, 4);
	out.set(body, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
	return out;
}

describe('PNG resource limits', () => {
	it('rejects dimensions before allocating the raster', () => {
		const oversized = Buffer.from(RGB);
		oversized.writeUInt32BE(0xffffffff, 16);
		expect(() => decodePng(oversized)).toThrow('pixel limit');
	});

	it('limits inflation to the declared raster size', () => {
		const png = Buffer.concat([
			RGB.subarray(0, 33),
			pngChunk('IDAT', deflateSync(Buffer.alloc(4096))),
			pngChunk('IEND', new Uint8Array()),
		]);
		expect(() => decodePng(png)).toThrow();
	});

	it('requires complete headers, chunks and an end marker', () => {
		for (const length of [12, 30, RGB.length - 1, RGB.length - 12])
			expect(() => decodePng(RGB.subarray(0, length))).toThrow('Truncated PNG');
	});

	it('rejects invalid raster and grid sizes before allocating', () => {
		const image = { width: 1, height: 1, data: new Uint8Array(4) };
		expect(() => encodePng({ ...image, width: 0xffffffff })).toThrow('pixel limit');
		expect(() => encodePng({ ...image, data: new Uint8Array(3) })).toThrow('RGBA data length');
		expect(() => composeGrid([image], Number.NaN)).toThrow('Grid columns');
		expect(() => composeGrid([image], 1, 0xffffffff)).toThrow('pixel limit');
	});
});
