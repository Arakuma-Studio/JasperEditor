// 8-bit RGBA images (row-major, no padding) and small conversions used by golden tests.

export type Rgba8 = { width: number; height: number; data: Uint8Array };

/** A new transparent-black image, or one wrapping `data` (length checked). */
export function rgba8(width: number, height: number, data?: ArrayLike<number> | Uint8Array): Rgba8 {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0)
		throw new RangeError(`bad image size ${width}×${height}`);
	const n = width * height * 4;
	if (data && data.length !== n)
		throw new RangeError(`pixel buffer has ${data.length} bytes, ${width}×${height} RGBA needs ${n}`);
	const px = data instanceof Uint8Array ? data : data ? Uint8Array.from(data) : new Uint8Array(n);
	return { width, height, data: px };
}

/** Packed RGB24 (e.g. `ffmpeg -pix_fmt rgb24`) → opaque RGBA8. */
export function fromRgb24(width: number, height: number, rgb: Uint8Array): Rgba8 {
	if (rgb.length !== width * height * 3)
		throw new RangeError(
			`RGB buffer has ${rgb.length} bytes, ${width}×${height} needs ${width * height * 3}`,
		);
	const out = rgba8(width, height);
	for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
		out.data[j] = rgb[i]!;
		out.data[j + 1] = rgb[i + 1]!;
		out.data[j + 2] = rgb[i + 2]!;
		out.data[j + 3] = 255;
	}
	return out;
}

/** The RGBA of pixel (x, y). */
export function pixel(img: Rgba8, x: number, y: number): [number, number, number, number] {
	const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
	return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

/** A rectangle of an image (clamped to it). */
export function crop(img: Rgba8, x: number, y: number, w: number, h: number): Rgba8 {
	const x0 = Math.max(0, Math.floor(x));
	const y0 = Math.max(0, Math.floor(y));
	const x1 = Math.min(img.width, Math.floor(x + w));
	const y1 = Math.min(img.height, Math.floor(y + h));
	const out = rgba8(Math.max(0, x1 - x0), Math.max(0, y1 - y0));
	for (let yy = y0; yy < y1; yy++)
		out.data.set(
			img.data.subarray((yy * img.width + x0) * 4, (yy * img.width + x1) * 4),
			(yy - y0) * out.width * 4,
		);
	return out;
}

/** Composites onto an opaque background colour (straight alpha in, opaque out). */
export function flatten(img: Rgba8, bg: [number, number, number] = [0, 0, 0]): Rgba8 {
	const out = rgba8(img.width, img.height);
	for (let i = 0; i < img.data.length; i += 4) {
		const a = img.data[i + 3]! / 255;
		for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(img.data[i + c]! * a + bg[c]! * (1 - a));
		out.data[i + 3] = 255;
	}
	return out;
}

/** Rec. 709 luma per pixel, 0…255. */
export function luma(img: Rgba8): Float64Array {
	const out = new Float64Array(img.width * img.height);
	for (let i = 0, j = 0; j < out.length; i += 4, j++)
		out[j] = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
	return out;
}

/**
 * Mean RGB over an `n`×`n` grid of cells (cell boundaries rounded; every pixel belongs to exactly one cell):
 * `n*n*3` numbers in row-major cell order. A compact, resolution-independent fingerprint of a frame.
 */
export function meanGrid(img: Rgba8, n = 4): number[] {
	const sums = new Float64Array(n * n * 4);
	for (let y = 0; y < img.height; y++) {
		const cy = Math.min(n - 1, Math.floor((y * n) / img.height));
		for (let x = 0; x < img.width; x++) {
			const cx = Math.min(n - 1, Math.floor((x * n) / img.width));
			const i = (y * img.width + x) * 4;
			const c = (cy * n + cx) * 4;
			sums[c] = sums[c]! + img.data[i]!;
			sums[c + 1] = sums[c + 1]! + img.data[i + 1]!;
			sums[c + 2] = sums[c + 2]! + img.data[i + 2]!;
			sums[c + 3] = sums[c + 3]! + 1;
		}
	}
	const out: number[] = [];
	for (let c = 0; c < n * n; c++) {
		const k = Math.max(1, sums[c * 4 + 3]!);
		for (let ch = 0; ch < 3; ch++) out.push(Math.round((sums[c * 4 + ch]! / k) * 10) / 10);
	}
	return out;
}

/** FNV-1a (32-bit) over the pixel bytes: an exact checksum for bit-identical pins. */
export function fnv1a(img: Rgba8 | Uint8Array): number {
	const d = img instanceof Uint8Array ? img : img.data;
	let h = 0x811c9dc5;
	for (let i = 0; i < d.length; i++) {
		h ^= d[i]!;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Simple statistics: luma mean / standard deviation and the number of distinct colours (capped at `cap`). */
export function imageStats(img: Rgba8, cap = 4096): { mean: number; std: number; colours: number } {
	const l = luma(img);
	let sum = 0;
	let sq = 0;
	for (const v of l) {
		sum += v;
		sq += v * v;
	}
	const n = Math.max(1, l.length);
	const mean = sum / n;
	const colours = new Set<number>();
	for (let i = 0; i < img.data.length && colours.size < cap; i += 4)
		colours.add(
			((img.data[i]! << 24) | (img.data[i + 1]! << 16) | (img.data[i + 2]! << 8) | img.data[i + 3]!) >>> 0,
		);
	return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), colours: colours.size };
}
