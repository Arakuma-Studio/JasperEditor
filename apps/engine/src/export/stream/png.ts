// spec 13 AS-072 — in-process decode of a kernel stream member's still. A stream decodes each member's picture once;
// with one ffmpeg process per picture, the spawns alone (a fork of the engine each) held the event loop for ≈ 9 ms
// apiece — 1 000 subtitles stalled the stream feeding the composite for seconds. The stills are PNGs (the layer bake's
// own encoder, or Chrome's), so the stream decodes 8-bit RGBA / RGB PNGs itself (the inflate in the libuv pool) and
// keeps ffmpeg for anything else (palette, 16-bit, interlaced, transparency chunks) and for scaled mip levels.
import { promisify } from 'node:util';
import { inflate } from 'node:zlib';

const inflateAsync = promisify(inflate);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The straight RGBA pixels of a PNG whose size is `w × h` (what ffmpeg's `format=rgba` gives), or null when the file
 * is another size or a kind this decoder leaves to ffmpeg. Throws only on a corrupt file.
 */
export async function decodePngRgba(buf: Buffer, w: number, h: number): Promise<Uint8Array | null> {
	if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
	let off = 8;
	let channels = 0;
	const idat: Buffer[] = [];
	let sawHeader = false;
	while (off + 12 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString('latin1', off + 4, off + 8);
		if (off + 12 + len > buf.length) throw new Error('PNG chunk past the end of the file');
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === 'IHDR') {
			if (len < 13) throw new Error('PNG header too short');
			if (data.readUInt32BE(0) !== w || data.readUInt32BE(4) !== h) return null;
			// 8-bit, colour type 6 (RGBA) or 2 (RGB), no interlace.
			if (data[8] !== 8 || data[12] !== 0) return null;
			if (data[9] === 6) channels = 4;
			else if (data[9] === 2) channels = 3;
			else return null;
			sawHeader = true;
		} else if (type === 'tRNS' || type === 'PLTE') return null;
		else if (type === 'IDAT') idat.push(data);
		else if (type === 'IEND') break;
		off += 12 + len;
	}
	if (!sawHeader || idat.length === 0) return null;
	const stride = w * channels;
	const expected = (stride + 1) * h;
	const raw = await inflateAsync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
	if (raw.length !== expected) throw new Error(`PNG data is ${raw.length} bytes, expected ${expected}`);
	const out = new Uint8Array(w * h * 4);
	let prev = new Uint8Array(stride);
	let cur = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const base = y * (stride + 1);
		const f = raw[base]!;
		// Unfiltered rows (the layer bake's encoder writes only these) are copied as they are.
		if (f === 0) cur.set(raw.subarray(base + 1, base + 1 + stride));
		else
			for (let i = 0; i < stride; i++) {
				const x = raw[base + 1 + i]!;
				const a = i >= channels ? cur[i - channels]! : 0;
				const b = prev[i]!;
				let v: number;
				if (f === 0) v = x;
				else if (f === 1) v = x + a;
				else if (f === 2) v = x + b;
				else if (f === 3) v = x + ((a + b) >> 1);
				else if (f === 4) {
					const c = i >= channels ? prev[i - channels]! : 0;
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
				} else throw new Error(`PNG row filter ${f}`);
				cur[i] = v & 0xff;
			}
		const o = y * w * 4;
		if (channels === 4) out.set(cur, o);
		else
			for (let x = 0; x < w; x++) {
				out[o + x * 4] = cur[x * 3]!;
				out[o + x * 4 + 1] = cur[x * 3 + 1]!;
				out[o + x * 4 + 2] = cur[x * 3 + 2]!;
				out[o + x * 4 + 3] = 255;
			}
		const t = prev;
		prev = cur;
		cur = t;
	}
	return out;
}
