// Binary formats of the roto matte store: 8-bit grey PNG (the matte frames the renderer loads) and the compact
// segmentation record (`.seg`: binary matte, Refine Edge band and colour models — what propagation continues
// from). Node built-ins only (zlib).
import { deflateSync, inflateSync } from 'node:zlib';
import type { Gmm } from './gmm.ts';
import type { FrameSeg } from './segment.ts';

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes an 8-bit grey image as PNG (filter Up per row: mattes compress to a few KB). */
export function encodeGreyPng(data: Uint8Array, w: number, h: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // greyscale
	const raw = new Uint8Array((w + 1) * h);
	for (let y = 0; y < h; y++) {
		const o = y * (w + 1);
		raw[o] = y === 0 ? 0 : 2; // None for the first row, Up after
		for (let x = 0; x < w; x++) {
			const v = data[y * w + x]!;
			raw[o + 1 + x] = y === 0 ? v : (v - data[(y - 1) * w + x]!) & 0xff;
		}
	}
	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 6 })),
		chunk('IEND', new Uint8Array(0)),
	]);
}

/** Decodes an 8-bit grey PNG written by `encodeGreyPng` (any filter type; greyscale 8-bit only). */
export function decodeGreyPng(buf: Uint8Array): { data: Uint8Array; width: number; height: number } {
	const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	if (!b.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
	let off = 8;
	let w = 0;
	let h = 0;
	const idat: Buffer[] = [];
	while (off + 8 <= b.length) {
		const len = b.readUInt32BE(off);
		const type = b.toString('ascii', off + 4, off + 8);
		const data = b.subarray(off + 8, off + 8 + len);
		if (type === 'IHDR') {
			w = data.readUInt32BE(0);
			h = data.readUInt32BE(4);
			if (data[8] !== 8 || data[9] !== 0 || data[12] !== 0) throw new Error('only 8-bit grey PNGs');
		} else if (type === 'IDAT') idat.push(data);
		else if (type === 'IEND') break;
		off += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (w + 1)]!;
		const row = raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1));
		for (let x = 0; x < w; x++) {
			const a = x > 0 ? out[y * w + x - 1]! : 0;
			const up = y > 0 ? out[(y - 1) * w + x]! : 0;
			const c = x > 0 && y > 0 ? out[(y - 1) * w + x - 1]! : 0;
			let v = row[x]!;
			if (f === 1) v += a;
			else if (f === 2) v += up;
			else if (f === 3) v += (a + up) >> 1;
			else if (f === 4) {
				const p = a + up - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
			}
			out[y * w + x] = v & 0xff;
		}
	}
	return { data: out, width: w, height: h };
}

function rle(plane: Uint8Array, out: number[]): void {
	let i = 0;
	while (i < plane.length) {
		const v = plane[i]!;
		let n = 1;
		while (i + n < plane.length && plane[i + n] === v && n < 0xffff) n++;
		out.push(n & 0xff, n >> 8, v);
		i += n;
	}
}

/** `JRSG` · w · h (u32 LE) · models JSON (length-prefixed) · matte RLE · band RLE (u16 run, byte), deflated. */
export function encodeSeg(s: FrameSeg): Buffer {
	const models = Buffer.from(JSON.stringify({ fg: s.fg, bg: s.bg }));
	const body: number[] = [];
	rle(s.matte, body);
	rle(s.refine, body);
	const head = Buffer.alloc(16);
	head.write('JRSG', 0, 'ascii');
	head.writeUInt32LE(s.w, 4);
	head.writeUInt32LE(s.h, 8);
	head.writeUInt32LE(models.length, 12);
	return deflateSync(Buffer.concat([head, models, Buffer.from(body)]));
}

export function decodeSeg(buf: Uint8Array): FrameSeg | null {
	let b: Buffer;
	try {
		b = inflateSync(buf);
	} catch {
		return null;
	}
	if (b.length < 16 || b.toString('ascii', 0, 4) !== 'JRSG') return null;
	const w = b.readUInt32LE(4);
	const h = b.readUInt32LE(8);
	const ml = b.readUInt32LE(12);
	let models: { fg: Gmm; bg: Gmm };
	try {
		models = JSON.parse(b.toString('utf8', 16, 16 + ml));
	} catch {
		return null;
	}
	let off = 16 + ml;
	const plane = (): Uint8Array | null => {
		const out = new Uint8Array(w * h);
		let k = 0;
		while (k < out.length) {
			if (off + 3 > b.length) return null;
			const n = b[off]! | (b[off + 1]! << 8);
			out.fill(b[off + 2]!, k, Math.min(out.length, k + n));
			k += n;
			off += 3;
		}
		return k === out.length ? out : null;
	};
	const matte = plane();
	const refine = plane();
	if (!matte || !refine) return null;
	return { w, h, matte, refine, fg: models.fg, bg: models.bg };
}
