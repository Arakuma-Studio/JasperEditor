// PNG encoding and decoding for golden frames (no dependency: node:zlib only).
//
// Encoder: 8-bit RGB when the image is fully opaque, else RGBA; per-row adaptive filter (the filter with the
// smallest sum of absolute residuals, the libpng heuristic), maximum deflate level, so goldens stay small.
// Decoder: every critical PNG feature a golden or a browser screenshot can use — colour types 0/2/3/4/6, bit depths
// 1/2/4/8/16 (16-bit is reduced to 8 by taking the high byte), PLTE + tRNS, Adam7 interlacing, multiple IDATs,
// CRC checks. Malformed input throws a `PngError` (never anything else; fuzzed in test/png-fuzz.test.ts).
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { type Rgba8, rgba8 } from './image.ts';

/** A malformed or unsupported PNG. */
export class PngError extends Error {
	override readonly name = 'PngError';
	constructor(
		message: string,
		readonly code: 'signature' | 'chunk' | 'crc' | 'header' | 'data' | 'unsupported' | 'size',
	) {
		super(message);
	}
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest decoded image accepted (pixels): 64 Mpx keeps a corrupt header from allocating gigabytes. */
export const MAX_PNG_PIXELS = 64 * 1024 * 1024;

function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'latin1');
	out.set(data, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

function isOpaque(img: Rgba8): boolean {
	for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
	return true;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encodes RGBA8 as PNG (RGB when fully opaque). */
export function encodePng(img: Rgba8): Buffer {
	const { width: w, height: h } = img;
	if (!(w > 0 && h > 0)) throw new PngError(`cannot encode a ${w}×${h} image`, 'size');
	const opaque = isOpaque(img);
	const bpp = opaque ? 3 : 4;
	const stride = w * bpp;
	const raw = Buffer.alloc(stride);
	const prev = Buffer.alloc(stride);
	const out = Buffer.alloc((stride + 1) * h);
	const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const s = (y * w + x) * 4;
			const d = x * bpp;
			raw[d] = img.data[s]!;
			raw[d + 1] = img.data[s + 1]!;
			raw[d + 2] = img.data[s + 2]!;
			if (!opaque) raw[d + 3] = img.data[s + 3]!;
		}
		let best = 0;
		let bestCost = Number.POSITIVE_INFINITY;
		for (let f = 0; f < 5; f++) {
			const c = cand[f]!;
			let cost = 0;
			for (let i = 0; i < stride; i++) {
				const a = i >= bpp ? raw[i - bpp]! : 0;
				const b = y > 0 ? prev[i]! : 0;
				const cc = i >= bpp && y > 0 ? prev[i - bpp]! : 0;
				const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, cc);
				const v = (raw[i]! - pred) & 0xff;
				c[i] = v;
				cost += v < 128 ? v : 256 - v;
			}
			if (cost < bestCost) {
				bestCost = cost;
				best = f;
			}
		}
		out[y * (stride + 1)] = best;
		cand[best]!.copy(out, y * (stride + 1) + 1);
		raw.copy(prev);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = opaque ? 2 : 6;
	return Buffer.concat([
		Buffer.from(SIGNATURE),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(out, { level: 9, memLevel: 9 })),
		chunk('IEND', new Uint8Array(0)),
	]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = {
	0: [1, 2, 4, 8, 16],
	2: [8, 16],
	3: [1, 2, 4, 8],
	4: [8, 16],
	6: [8, 16],
};
const ADAM7: [number, number, number, number][] = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

/** Decodes a PNG to RGBA8. Throws `PngError` on malformed or unsupported input. */
export function decodePng(bytes: Uint8Array): Rgba8 {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('not a PNG', 'signature');
	let pos = 8;
	let header: { w: number; h: number; depth: number; type: number; interlace: number } | undefined;
	let palette: Uint8Array | undefined;
	let trns: Buffer | undefined;
	const idat: Buffer[] = [];
	let ended = false;
	while (pos < buf.length) {
		if (pos + 12 > buf.length) throw new PngError(`truncated chunk at byte ${pos}`, 'chunk');
		const len = buf.readUInt32BE(pos);
		const type = buf.toString('latin1', pos + 4, pos + 8);
		if (len > 0x7fffffff || pos + 12 + len > buf.length)
			throw new PngError(`chunk ${JSON.stringify(type)} runs past the end`, 'chunk');
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len))
			throw new PngError(`bad CRC in chunk ${JSON.stringify(type)}`, 'crc');
		pos += 12 + len;
		if (!header && type !== 'IHDR') throw new PngError('IHDR must come first', 'header');
		if (type === 'IHDR') {
			if (header) throw new PngError('duplicate IHDR', 'header');
			if (len !== 13) throw new PngError('bad IHDR length', 'header');
			header = {
				w: data.readUInt32BE(0),
				h: data.readUInt32BE(4),
				depth: data[8]!,
				type: data[9]!,
				interlace: data[12]!,
			};
			if (data[10] !== 0 || data[11] !== 0) throw new PngError('unknown compression/filter method', 'header');
			if (!(header.type in CHANNELS)) throw new PngError(`bad colour type ${header.type}`, 'header');
			if (!DEPTHS[header.type]!.includes(header.depth))
				throw new PngError(`bad bit depth ${header.depth} for colour type ${header.type}`, 'header');
			if (header.interlace > 1) throw new PngError(`bad interlace method ${header.interlace}`, 'header');
			if (header.w === 0 || header.h === 0 || header.w > 0x7fffffff || header.h > 0x7fffffff)
				throw new PngError(`bad size ${header.w}×${header.h}`, 'size');
			if (header.w * header.h > MAX_PNG_PIXELS)
				throw new PngError(`${header.w}×${header.h} exceeds ${MAX_PNG_PIXELS} pixels`, 'size');
		} else if (type === 'PLTE') {
			if (len === 0 || len % 3 !== 0 || len > 768) throw new PngError('bad PLTE length', 'chunk');
			palette = data;
		} else if (type === 'tRNS') trns = data;
		else if (type === 'IDAT') idat.push(data);
		else if (type === 'IEND') {
			ended = true;
			break;
		} else if ((type.charCodeAt(0) & 0x20) === 0)
			throw new PngError(`unknown critical chunk ${type}`, 'unsupported');
	}
	if (!header) throw new PngError('no IHDR', 'header');
	if (!ended) throw new PngError('no IEND', 'chunk');
	if (!idat.length) throw new PngError('no IDAT', 'data');
	if (header.type === 3 && !palette) throw new PngError('palette image without PLTE', 'chunk');
	const { w, h, depth, type } = header;
	const channels = CHANNELS[type]!;
	const bitsPP = channels * depth;
	const bpp = Math.max(1, bitsPP >> 3);
	const passes: [number, number, number, number][] = header.interlace ? ADAM7 : [[0, 0, 1, 1]];
	let expected = 0;
	for (const [x0, y0, dx, dy] of passes) {
		const pw = Math.ceil((w - x0) / dx);
		const ph = Math.ceil((h - y0) / dy);
		if (pw > 0 && ph > 0) expected += (Math.ceil((pw * bitsPP) / 8) + 1) * ph;
	}
	let inflated: Buffer;
	try {
		// Bounded: a decompression bomb stops at the size the header implies.
		inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 65_536 });
	} catch (e) {
		throw new PngError(`corrupt image data: ${(e as Error).message}`, 'data');
	}
	const out = rgba8(w, h);
	let offset = 0;
	const maxSample = (1 << depth) - 1;
	for (const [x0, y0, dx, dy] of passes) {
		const pw = Math.ceil((w - x0) / dx);
		const ph = Math.ceil((h - y0) / dy);
		if (pw <= 0 || ph <= 0) continue;
		const stride = Math.ceil((pw * bitsPP) / 8);
		if (offset + (stride + 1) * ph > inflated.length) throw new PngError('image data too short', 'data');
		let prev = Buffer.alloc(stride);
		for (let py = 0; py < ph; py++) {
			const filter = inflated[offset]!;
			const line = Buffer.from(inflated.subarray(offset + 1, offset + 1 + stride));
			offset += stride + 1;
			for (let i = 0; i < stride; i++) {
				const a = i >= bpp ? line[i - bpp]! : 0;
				const b = prev[i]!;
				const c = i >= bpp ? prev[i - bpp]! : 0;
				switch (filter) {
					case 0:
						break;
					case 1:
						line[i] = (line[i]! + a) & 0xff;
						break;
					case 2:
						line[i] = (line[i]! + b) & 0xff;
						break;
					case 3:
						line[i] = (line[i]! + ((a + b) >> 1)) & 0xff;
						break;
					case 4:
						line[i] = (line[i]! + paeth(a, b, c)) & 0xff;
						break;
					default:
						throw new PngError(`bad filter type ${filter}`, 'data');
				}
			}
			prev = line;
			const y = y0 + py * dy;
			for (let px = 0; px < pw; px++) {
				const sample = (ch: number): number => {
					if (depth === 8) return line[px * channels + ch]!;
					if (depth === 16) return line[(px * channels + ch) * 2]!;
					const bit = (px * channels + ch) * depth;
					return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & maxSample;
				};
				const raw16 = (ch: number) =>
					depth === 16 ? line.readUInt16BE((px * channels + ch) * 2) : sample(ch);
				const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / maxSample));
				let r: number;
				let g: number;
				let b: number;
				let al = 255;
				if (type === 3) {
					const idx = sample(0);
					if (idx * 3 + 2 >= palette!.length) throw new PngError(`palette index ${idx} out of range`, 'data');
					r = palette![idx * 3]!;
					g = palette![idx * 3 + 1]!;
					b = palette![idx * 3 + 2]!;
					if (trns && idx < trns.length) al = trns[idx]!;
				} else if (type === 0 || type === 4) {
					r = g = b = scale(sample(0));
					if (type === 4) al = sample(1);
					else if (trns && trns.length >= 2 && raw16(0) === trns.readUInt16BE(0)) al = 0;
				} else {
					r = sample(0);
					g = sample(1);
					b = sample(2);
					if (type === 6) al = sample(3);
					else if (
						trns &&
						trns.length >= 6 &&
						raw16(0) === trns.readUInt16BE(0) &&
						raw16(1) === trns.readUInt16BE(2) &&
						raw16(2) === trns.readUInt16BE(4)
					)
						al = 0;
				}
				const o = (y * w + x0 + px * dx) * 4;
				out.data[o] = r;
				out.data[o + 1] = g;
				out.data[o + 2] = b;
				out.data[o + 3] = al;
			}
		}
	}
	return out;
}
