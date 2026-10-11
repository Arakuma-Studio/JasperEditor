#!/usr/bin/env node
// Generates the PWA / favicon PNGs in apps/web/public/icons (S05:PWA-001, R-OMS §3.4/§8.3): an original,
// simple mark (a "J" over a three-segment timeline strip on the Premiere-dark tile). "any" icons are a
// rounded tile with transparent corners; maskable icons are full-bleed with the mark inside the 80 %
// safe zone. Pure Node (zlib PNG encoder, 4×4 supersampling) so it runs anywhere without fonts/ffmpeg.
//   node apps/web/src/pwa/generate-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../public/icons');

// Colors as RGB triples (the token lint forbids hex literals under apps/web/src).
const BG_TOP = [38, 38, 40];
const BG_BOTTOM = [22, 22, 23];
const ACCENT = [80, 150, 255];
const STRIP = [
	[92, 184, 128],
	[232, 178, 76],
	[170, 128, 240],
];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
export function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = Math.min(Math.max(x, x0 + r), x1 - r);
	const cy = Math.min(Math.max(y, y0 + r), y1 - r);
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** The mark in a unit box: returns an RGB triple or null. */
function mark(u, v) {
	// "J": top bar, stem, bottom hook (half annulus) with a rounded terminal.
	const inJ =
		inRoundRect(u, v, 0.36, 0.1, 0.78, 0.21, 0.035) ||
		inRoundRect(u, v, 0.58, 0.1, 0.7, 0.6, 0) ||
		(v >= 0.56 &&
			(() => {
				const d = Math.hypot(u - 0.46, v - 0.56);
				return d <= 0.24 && d >= 0.12;
			})()) ||
		Math.hypot(u - 0.28, v - 0.56) <= 0.06;
	if (inJ) return ACCENT;
	// Timeline strip: three clips.
	const segs = [
		[0.14, 0.4],
		[0.43, 0.63],
		[0.66, 0.86],
	];
	for (let i = 0; i < segs.length; i++)
		if (inRoundRect(u, v, segs[i][0], 0.87, segs[i][1], 0.95, 0.02)) return STRIP[i];
	return null;
}

function bg(v) {
	return BG_TOP.map((c, i) => c + (BG_BOTTOM[i] - c) * v);
}

/**
 * Renders one icon. `maskable`: full-bleed background, mark scaled into the safe zone.
 * Otherwise a rounded tile with transparent corners (and an optional opaque square for Apple).
 */
function render(size, { maskable = false, opaque = false } = {}) {
	const S = 4;
	const px = Buffer.alloc(size * size * 4);
	const markScale = maskable ? 0.56 : 0.7;
	const markOff = (1 - markScale) / 2;
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let sy = 0; sy < S; sy++)
				for (let sx = 0; sx < S; sx++) {
					const fx = (x + (sx + 0.5) / S) / size;
					const fy = (y + (sy + 0.5) / S) / size;
					const inTile = maskable || opaque || inRoundRect(fx, fy, 0.04, 0.04, 0.96, 0.96, 0.2);
					if (!inTile) continue;
					const m = mark((fx - markOff) / markScale, (fy - markOff) / markScale);
					const c = m ?? bg(fy);
					r += c[0];
					g += c[1];
					b += c[2];
					a += 255;
				}
			const n = S * S;
			const i = (y * size + x) * 4;
			// Straight alpha: average color over covered samples.
			const cover = a / 255;
			px[i] = cover ? Math.round(r / cover) : 0;
			px[i + 1] = cover ? Math.round(g / cover) : 0;
			px[i + 2] = cover ? Math.round(b / cover) : 0;
			px[i + 3] = Math.round(a / n);
		}
	return encodePng(size, size, px);
}

export const ICONS = [
	{ file: 'icon-192.png', size: 192 },
	{ file: 'icon-512.png', size: 512 },
	{ file: 'icon-maskable-192.png', size: 192, maskable: true },
	{ file: 'icon-maskable-512.png', size: 512, maskable: true },
	{ file: 'apple-touch-icon.png', size: 180, opaque: true },
	{ file: 'favicon-32.png', size: 32 },
	{ file: 'favicon-16.png', size: 16 },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	mkdirSync(OUT, { recursive: true });
	for (const icon of ICONS) {
		writeFileSync(join(OUT, icon.file), render(icon.size, icon));
		console.log(`icons/${icon.file} ${icon.size}×${icon.size}${icon.maskable ? ' maskable' : ''}`);
	}
}
