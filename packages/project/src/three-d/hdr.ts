// Radiance `.hdr` (RGBE) images (spec 19 TL-075): the format of HDR environment panoramas. The file is untrusted, so
// everything the header claims is validated before anything is allocated, and the output size is capped: rows are
// reduced by whole box factors as they decode, so an 8K panorama costs a 4K buffer. Used by the engine's prober, which
// reads the header and decodes once to prove the data, and by the renderer. Format: Ward, "Real Pixels" (Graphics
// Gems II, 1991); the run-length scheme of the `radiance` sources (`freadcolrs`).

/** Thrown for any malformed file, with the reason the import shows. */
export class HdrParseError extends Error {
	override name = 'HdrParseError';
}

/** Longest side accepted. */
export const HDR_MAX_SIDE = 16384;
/** Most pixels accepted (a 16K × 8K panorama). */
export const HDR_MAX_PIXELS = 16384 * 8192;
/** Largest file accepted. */
export const HDR_MAX_BYTES = 1024 * 1024 * 1024;
/** Longest side of a decoded image: 4096 × 2048 is 134 MB of floats, and reflections need no more. */
export const HDR_MAX_OUTPUT_SIDE = 4096;
/** Longest header. */
const MAX_HEADER = 64 * 1024;
const MAX_LINE = 4096;

export type HdrHeader = {
	width: number;
	height: number;
	/** `+X` order flipped horizontally, `+Y` first row at the bottom. */
	flipX: boolean;
	flipY: boolean;
	/** Bytes before the pixel data. */
	dataOffset: number;
	/** Reinhard `EXPOSURE` lines multiplied: scene value = stored value / exposure. */
	exposure: number;
};

export type HdrImage = {
	width: number;
	height: number;
	/** Scene-linear RGBA, top row first, alpha 1. */
	data: Float32Array;
	/** Source size. */
	sourceWidth: number;
	sourceHeight: number;
};

const positive = (v: number) => Number.isFinite(v) && v > 0;

/** Parses and validates the header. Allocates nothing proportional to the claimed size. */
export function parseHdrHeader(bytes: Uint8Array): HdrHeader {
	if (bytes.length > HDR_MAX_BYTES) throw new HdrParseError(`HDR file too large (${bytes.length} bytes)`);
	const n = Math.min(bytes.length, MAX_HEADER);
	let p = 0;
	const line = (): string | null => {
		if (p >= n) return null;
		let end = p;
		while (end < n && bytes[end] !== 0x0a) end++;
		if (end - p > MAX_LINE) throw new HdrParseError('HDR header line too long');
		if (end >= n) throw new HdrParseError('HDR header is not terminated');
		let s = '';
		for (let i = p; i < end; i++) s += String.fromCharCode(bytes[i]!);
		p = end + 1;
		return s.endsWith('\r') ? s.slice(0, -1) : s;
	};
	const magic = line();
	if (magic !== '#?RADIANCE' && magic !== '#?RGBE')
		throw new HdrParseError('Not a Radiance HDR file (missing #?RADIANCE)');
	let format: string | null = null;
	let exposure = 1;
	for (;;) {
		const l = line();
		if (l === null) throw new HdrParseError('HDR header has no end');
		if (l === '') break;
		if (l.startsWith('#')) continue;
		const eq = l.indexOf('=');
		if (eq < 0) continue;
		const key = l.slice(0, eq).trim();
		const value = l.slice(eq + 1).trim();
		if (key === 'FORMAT') format = value;
		else if (key === 'EXPOSURE') {
			const e = Number(value);
			if (!positive(e) || e > 1e6) throw new HdrParseError(`Invalid HDR EXPOSURE ${value.slice(0, 32)}`);
			exposure *= e;
			if (!positive(exposure)) throw new HdrParseError('Invalid HDR EXPOSURE');
		}
	}
	if (format !== null && format !== '32-bit_rle_rgbe')
		throw new HdrParseError(`Unsupported HDR format ${format.slice(0, 32)}: only 32-bit_rle_rgbe`);
	const res = line();
	const m = res?.match(/^([+-])([XY])\s+(\d{1,9})\s+([+-])([XY])\s+(\d{1,9})$/);
	if (!m || m[2] === m[5]) throw new HdrParseError('Invalid HDR resolution line');
	if (m[2] !== 'Y') throw new HdrParseError('Rotated HDR files (+X first) are not supported');
	const height = Number(m[3]);
	const width = Number(m[6]);
	if (width < 1 || height < 1 || width > HDR_MAX_SIDE || height > HDR_MAX_SIDE)
		throw new HdrParseError(`HDR size ${width} × ${height} outside 1…${HDR_MAX_SIDE}`);
	if (width * height > HDR_MAX_PIXELS)
		throw new HdrParseError(`HDR image too large: ${width} × ${height}, at most ${HDR_MAX_PIXELS} pixels`);
	return { width, height, flipX: m[4] === '-', flipY: m[1] === '+', dataOffset: p, exposure };
}

/** Box factor that brings a size under `maxSide`. */
function reductionOf(w: number, h: number, maxSide: number): number {
	let f = 1;
	while (Math.max(w, h) / f > maxSide) f *= 2;
	return f;
}

/** Decodes one scanline of RGBE into `row` (width × 4 bytes), or throws. Returns the next byte offset. */
function readScanline(bytes: Uint8Array, start: number, width: number, row: Uint8Array): number {
	let p = start;
	const end = bytes.length;
	if (end - p < 4) throw new HdrParseError('HDR data ends early');
	const adaptive =
		width >= 8 &&
		width < 0x8000 &&
		bytes[p] === 2 &&
		bytes[p + 1] === 2 &&
		(bytes[p + 2]! & 0x80) === 0 &&
		((bytes[p + 2]! << 8) | bytes[p + 3]!) === width;
	if (adaptive) {
		p += 4;
		for (let c = 0; c < 4; c++) {
			let x = 0;
			while (x < width) {
				if (p >= end) throw new HdrParseError('HDR data ends early');
				const code = bytes[p++]!;
				if (code > 128) {
					const count = code - 128;
					if (x + count > width) throw new HdrParseError('HDR run overruns its scanline');
					if (p >= end) throw new HdrParseError('HDR data ends early');
					const v = bytes[p++]!;
					for (let k = 0; k < count; k++) row[(x++ << 2) + c] = v;
				} else {
					const count = code;
					if (count === 0) throw new HdrParseError('HDR data has an empty run');
					if (x + count > width) throw new HdrParseError('HDR run overruns its scanline');
					if (p + count > end) throw new HdrParseError('HDR data ends early');
					for (let k = 0; k < count; k++) row[(x++ << 2) + c] = bytes[p++]!;
				}
			}
		}
		return p;
	}
	// Flat pixels with the old run encoding: (1, 1, 1, n) repeats the last pixel n << shift times.
	let x = 0;
	let shift = 0;
	while (x < width) {
		if (p + 4 > end) throw new HdrParseError('HDR data ends early');
		const r = bytes[p]!;
		const g = bytes[p + 1]!;
		const b = bytes[p + 2]!;
		const e = bytes[p + 3]!;
		p += 4;
		if (r === 1 && g === 1 && b === 1) {
			if (x === 0) throw new HdrParseError('HDR run at the start of a scanline');
			if (shift > 24) throw new HdrParseError('HDR run too long');
			const count = e * 2 ** shift;
			if (x + count > width) throw new HdrParseError('HDR run overruns its scanline');
			const q = (x - 1) << 2;
			for (let k = 0; k < count; k++) {
				const o = x++ << 2;
				row[o] = row[q]!;
				row[o + 1] = row[q + 1]!;
				row[o + 2] = row[q + 2]!;
				row[o + 3] = row[q + 3]!;
			}
			shift += 8;
		} else {
			const o = x++ << 2;
			row[o] = r;
			row[o + 1] = g;
			row[o + 2] = b;
			row[o + 3] = e;
			shift = 0;
		}
	}
	return p;
}

/** Yield point of the cooperative decode: the callback runs every `HDR_YIELD_ROWS` scanlines. */
export const HDR_YIELD_ROWS = 64;

function* decodeSteps(
	bytes: Uint8Array,
	maxSide: number,
): Generator<void, HdrImage, void> {
	const head = parseHdrHeader(bytes);
	const { width, height } = head;
	const f = reductionOf(width, height, Math.max(1, Math.min(maxSide, HDR_MAX_OUTPUT_SIDE)));
	const w = Math.max(1, Math.ceil(width / f));
	const h = Math.max(1, Math.ceil(height / f));
	const data = new Float32Array(w * h * 4);
	const weight = new Float32Array(w * h);
	const row = new Uint8Array(width * 4);
	let p = head.dataOffset;
	// Stored values / EXPOSURE = scene values; RGBE: value = (byte + 0.5) · 2^(e − 136).
	const unit = 1 / head.exposure;
	const scale = new Float64Array(256);
	for (let e = 1; e < 256; e++) scale[e] = 2 ** (e - 136) * unit;
	for (let j = 0; j < height; j++) {
		p = readScanline(bytes, p, width, row);
		const y = head.flipY ? height - 1 - j : j;
		const oy = Math.floor(y / f);
		for (let i = 0; i < width; i++) {
			const e = row[(i << 2) + 3]!;
			const x = head.flipX ? width - 1 - i : i;
			const o = oy * w + Math.floor(x / f);
			weight[o] = weight[o]! + 1;
			if (e === 0) continue;
			const k = scale[e]!;
			data[o * 4] = data[o * 4]! + (row[i << 2]! + 0.5) * k;
			data[o * 4 + 1] = data[o * 4 + 1]! + (row[(i << 2) + 1]! + 0.5) * k;
			data[o * 4 + 2] = data[o * 4 + 2]! + (row[(i << 2) + 2]! + 0.5) * k;
		}
		if ((j + 1) % HDR_YIELD_ROWS === 0) yield;
	}
	for (let o = 0; o < w * h; o++) {
		const k = 1 / Math.max(1, weight[o]!);
		for (let c = 0; c < 3; c++) {
			const v = data[o * 4 + c]! * k;
			// Hostile exponents overflow a float: clamp, a non-finite texel would poison the prefilter.
			data[o * 4 + c] = Number.isFinite(v) ? Math.min(v, 1e6) : 1e6;
		}
		data[o * 4 + 3] = 1;
	}
	return { width: w, height: h, data, sourceWidth: width, sourceHeight: height };
}

/** Decodes a Radiance file, reduced to at most `maxSide` per side (capped at `HDR_MAX_OUTPUT_SIDE`). */
export function decodeHdr(bytes: Uint8Array, maxSide: number = HDR_MAX_OUTPUT_SIDE): HdrImage {
	const steps = decodeSteps(bytes, maxSide);
	for (;;) {
		const n = steps.next();
		if (n.done) return n.value;
	}
}

/** `decodeHdr`, giving the event loop a turn every `HDR_YIELD_ROWS` rows: a large file never freezes the app. */
export async function decodeHdrAsync(
	bytes: Uint8Array,
	maxSide: number,
	turn: () => Promise<void>,
): Promise<HdrImage> {
	const steps = decodeSteps(bytes, maxSide);
	for (;;) {
		const n = steps.next();
		if (n.done) return n.value;
		await turn();
	}
}

/** Whether `name` is a Radiance file by its extension. */
export function isHdrFile(name: string): boolean {
	return /\.(hdr|rgbe)$/i.test(name);
}
