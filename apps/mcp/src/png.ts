// Minimal PNG codec and grid composition for render_frames' contact sheet (S11:ANA-004), on node:zlib only:
// decodes 8-bit non-interlaced greyscale/RGB(A) PNGs (every filter type) to RGBA, encodes RGB with filter 0.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** An 8-bit RGBA raster, rows top to bottom. */
type RgbaImage = { width: number; height: number; data: Uint8Array };

// Contact sheets are at most 2048 px per side; leave room for larger source stills.
const MAX_PIXELS = 16_777_216;

function pixelCount(width: number, height: number): number {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
		throw new Error('Image dimensions must be positive integers');
	const pixels = width * height;
	if (pixels > MAX_PIXELS) throw new Error(`Image exceeds the ${MAX_PIXELS}-pixel limit`);
	return pixels;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Samples per pixel by colour type (greyscale, RGB, greyscale + alpha, RGBA; no palette). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Uint8Array): RgbaImage {
	const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
	if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG image');
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Buffer[] = [];
	let ended = false;
	for (let o = 8; o < buf.length; ) {
		if (buf.length - o < 12) throw new Error('Truncated PNG chunk');
		const len = buf.readUInt32BE(o);
		if (len > buf.length - o - 12) throw new Error('Truncated PNG chunk');
		const type = buf.toString('latin1', o + 4, o + 8);
		if (o === 8 && type !== 'IHDR') throw new Error('PNG must start with IHDR');
		const body = buf.subarray(o + 8, o + 8 + len);
		if (type === 'IHDR') {
			if (o !== 8 || len !== 13) throw new Error('Invalid PNG header');
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			pixelCount(width, height);
			channels = CHANNELS[body[9]!] ?? 0;
			if (body[8] !== 8 || !channels || body[10] !== 0 || body[11] !== 0 || body[12] !== 0)
				throw new Error(
					`Unsupported PNG (bit depth ${body[8]}, colour type ${body[9]}, interlace ${body[12]}): only 8-bit non-interlaced greyscale/RGB/RGBA`,
				);
		} else if (type === 'IDAT') idat.push(body);
		else if (type === 'IEND') {
			if (len !== 0) throw new Error('Invalid PNG end chunk');
			ended = true;
			break;
		}
		o += 12 + len;
	}
	if (!ended || !width || !height || !idat.length) throw new Error('Truncated PNG');
	const stride = width * channels;
	const expectedBytes = (stride + 1) * height;
	const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedBytes });
	if (raw.length !== expectedBytes) throw new Error('Invalid PNG data length');
	const px = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		if (filter > 4) throw new Error(`Invalid PNG filter type ${filter}`);
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			// a = left, b = up, c = up-left (the reconstructed bytes; 0 outside the image).
			const a = x >= channels ? px[row + x - channels]! : 0;
			const b = y > 0 ? px[row - stride + x]! : 0;
			const c = x >= channels && y > 0 ? px[row - stride + x - channels]! : 0;
			let p = 0;
			if (filter === 1) p = a;
			else if (filter === 2) p = b;
			else if (filter === 3) p = (a + b) >> 1;
			else if (filter === 4) p = paeth(a, b, c);
			px[row + x] = (raw[src + x]! + p) & 0xff;
		}
	}
	const data = new Uint8Array(pixelCount(width, height) * 4);
	for (let i = 0, j = 0; i < data.length; i += 4, j += channels) {
		const grey = channels < 3;
		data[i] = px[j]!;
		data[i + 1] = px[grey ? j : j + 1]!;
		data[i + 2] = px[grey ? j : j + 2]!;
		data[i + 3] = channels === 2 ? px[j + 1]! : channels === 4 ? px[j + 3]! : 255;
	}
	return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + body.length);
	out.writeUInt32BE(body.length, 0);
	out.write(type, 4, 'latin1');
	out.set(body, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
	return out;
}

/** Encodes an RGBA raster as an opaque 8-bit RGB PNG (alpha dropped; filter 0 on every row). */
export function encodePng(img: RgbaImage): Buffer {
	const { width, height, data } = img;
	if (data.length !== pixelCount(width, height) * 4) throw new Error('Invalid RGBA data length');
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const stride = width * 3 + 1;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 4;
			const d = y * stride + 1 + x * 3;
			raw[d] = data[s]!;
			raw[d + 1] = data[s + 1]!;
			raw[d + 2] = data[s + 2]!;
		}
	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', new Uint8Array(0)),
	]);
}

/**
 * Lays images out left to right, top to bottom in `columns` columns of cells as large as the largest image,
 * `gap` pixels apart and around, on an opaque `background` (images are composited over it by their alpha).
 */
export function composeGrid(
	images: readonly RgbaImage[],
	columns: number,
	gap = 4,
	background: readonly [number, number, number] = [32, 32, 32],
): RgbaImage & { cellWidth: number; cellHeight: number; rows: number } {
	if (!Number.isSafeInteger(columns) || columns < 1 || !Number.isSafeInteger(gap) || gap < 0)
		throw new Error('Grid columns must be positive and gap non-negative integers');
	for (const img of images)
		if (img.data.length !== pixelCount(img.width, img.height) * 4)
			throw new Error('Invalid RGBA data length');
	const cols = Math.max(1, Math.min(columns, images.length));
	const rows = Math.max(1, Math.ceil(images.length / cols));
	const cellWidth = Math.max(1, ...images.map((i) => i.width));
	const cellHeight = Math.max(1, ...images.map((i) => i.height));
	const width = cols * cellWidth + (cols + 1) * gap;
	const height = rows * cellHeight + (rows + 1) * gap;
	const data = new Uint8Array(pixelCount(width, height) * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = background[0];
		data[i + 1] = background[1];
		data[i + 2] = background[2];
		data[i + 3] = 255;
	}
	images.forEach((img, n) => {
		const x0 = gap + (n % cols) * (cellWidth + gap);
		const y0 = gap + Math.floor(n / cols) * (cellHeight + gap);
		for (let y = 0; y < img.height; y++)
			for (let x = 0; x < img.width; x++) {
				const s = (y * img.width + x) * 4;
				const d = ((y0 + y) * width + x0 + x) * 4;
				const a = img.data[s + 3]! / 255;
				for (let c = 0; c < 3; c++) data[d + c] = Math.round(img.data[s + c]! * a + data[d + c]! * (1 - a));
			}
	});
	return { width, height, data, cellWidth, cellHeight, rows };
}
