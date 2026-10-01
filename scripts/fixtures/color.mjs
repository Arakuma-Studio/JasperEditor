// Colour-grading fixtures (wp-m2-color, S06 §9 tests 2–4), loaded by scripts/make-fixtures.mjs:
//   chart.png            1920×1080 test chart: grey/RGB/CMY ramps, a hue × saturation field, a 24-patch
//                        colour checker (approximate sRGB values), skin tones (light → deep) and a black-to-white
//                        step wedge. Written by a tiny PNG encoder (no ffmpeg), untagged sRGB, deterministic.
//   look-33.cube         vendor-style 33³ creative look (TITLE, comments, DOMAIN_MIN/MAX, blank lines).
//   tone-1d.cube         1D S-curve (LUT_1D_SIZE 1024).
//   broken-count.cube    too few table entries (fails at the last line).
//   broken-number.cube   an invalid number on line 7.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 1920;
const H = 1080;

// ---------------------------------------------------------------- PNG encoder (RGB 8-bit)
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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
export function encodePng(width, height, rgb) {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 3 + 1)] = 0; // filter: none
		rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

// ---------------------------------------------------------------- chart
const clamp8 = (x) => Math.max(0, Math.min(255, Math.round(x)));
function hsv(h, s, v) {
	const i = Math.floor(h * 6) % 6;
	const f = h * 6 - Math.floor(h * 6);
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	return [
		[v, t, p],
		[q, v, p],
		[p, v, t],
		[p, q, v],
		[t, p, v],
		[v, p, q],
	][i];
}
/** Approximate sRGB values of a classic 24-patch colour checker (public reference data, rounded). */
const CHECKER = [
	[115, 82, 68],
	[194, 150, 130],
	[98, 122, 157],
	[87, 108, 67],
	[133, 128, 177],
	[103, 189, 170],
	[214, 126, 44],
	[80, 91, 166],
	[193, 90, 99],
	[94, 60, 108],
	[157, 188, 64],
	[224, 163, 46],
	[56, 61, 150],
	[70, 148, 73],
	[175, 54, 60],
	[231, 199, 31],
	[187, 86, 149],
	[8, 133, 161],
	[243, 243, 242],
	[200, 200, 200],
	[160, 160, 160],
	[122, 122, 121],
	[85, 85, 85],
	[52, 52, 52],
];
/** Skin tones from light to deep (sRGB). */
const SKIN = [
	[255, 224, 196],
	[241, 194, 167],
	[224, 172, 138],
	[198, 134, 101],
	[160, 106, 74],
	[125, 81, 56],
	[92, 58, 40],
	[60, 38, 28],
];

export function makeChart() {
	const px = Buffer.alloc(W * H * 3);
	const set = (x, y, c) => {
		const o = (y * W + x) * 3;
		px[o] = clamp8(c[0]);
		px[o + 1] = clamp8(c[1]);
		px[o + 2] = clamp8(c[2]);
	};
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const u = x / (W - 1);
			let c;
			if (y < 420) {
				// Seven 60 px ramps: grey, R, G, B, C, M, Y (0 → 255 left to right).
				const k = Math.floor(y / 60);
				const v = u * 255;
				c = [
					[v, v, v],
					[v, 0, 0],
					[0, v, 0],
					[0, 0, v],
					[0, v, v],
					[v, 0, v],
					[v, v, 0],
				][k];
			} else if (y < 620) {
				// Hue × saturation field (value 0.9); bottom half a hue × value field (saturation 0.8).
				const t = (y - 420) / 199;
				c =
					t < 0.5
						? hsv(u, t * 2, 0.9).map((a) => a * 255)
						: hsv(u, 0.8, 1 - (t - 0.5) * 1.6).map((a) => a * 255);
			} else if (y < 900) {
				// Colour checker (12 × 2 patches, 160 × 140 px) with a dark gap.
				const col = Math.floor(x / 160);
				const row = Math.floor((y - 620) / 140);
				const inX = x % 160;
				const inY = (y - 620) % 140;
				c = inX < 6 || inY < 6 ? [20, 20, 20] : CHECKER[row * 12 + col];
			} else if (y < 1000) {
				// Skin tones: 8 patches of 240 px.
				c = SKIN[Math.min(7, Math.floor(x / 240))];
			} else {
				// 32-step wedge.
				const v = Math.floor(u * 32) * (255 / 31);
				c = [v, v, v];
			}
			set(x, y, c);
		}
	}
	return encodePng(W, H, px);
}

// ---------------------------------------------------------------- .cube files
const f6 = (x) => (Math.round(x * 1e6) / 1e6).toFixed(6);
/** A teal/orange-ish look: warm highlights, cool shadows, a gentle S-curve and a saturation lift. */
export function lookFn(r, g, b) {
	const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const s = (x) => x - 0.08 * Math.sin(2 * Math.PI * x); // monotone S-curve (slope ≥ 0.5)
	let R = r + 0.06 * y - 0.03 * (1 - y);
	let G = g + 0.01 * y;
	let B = b - 0.05 * y + 0.05 * (1 - y);
	const yy = 0.2126 * R + 0.7152 * G + 0.0722 * B;
	R = yy + (R - yy) * 1.15;
	G = yy + (G - yy) * 1.15;
	B = yy + (B - yy) * 1.15;
	return [s(Math.max(0, Math.min(1, R))), s(Math.max(0, Math.min(1, G))), s(Math.max(0, Math.min(1, B)))];
}
export function makeLook33() {
	const n = 33;
	const lines = [
		'# Created by a colour-grading suite (vendor-style header)',
		'# Look: "Warm Teal" — JasperEditor test fixture',
		'TITLE "Warm Teal 33"',
		'',
		'LUT_3D_SIZE 33',
		'DOMAIN_MIN 0.0 0.0 0.0',
		'DOMAIN_MAX 1.0 1.0 1.0',
		'',
	];
	for (let b = 0; b < n; b++)
		for (let g = 0; g < n; g++)
			for (let r = 0; r < n; r++) {
				const [R, G, B] = lookFn(r / (n - 1), g / (n - 1), b / (n - 1));
				lines.push(`${f6(R)} ${f6(G)} ${f6(B)}`);
			}
	return `${lines.join('\r\n')}\r\n`;
}
export function makeTone1d() {
	const n = 1024;
	const lines = ['TITLE "S-curve 1D"', '# 1D per-channel tone curve', `LUT_1D_SIZE ${n}`];
	for (let i = 0; i < n; i++) {
		const x = i / (n - 1);
		const y = x * x * (3 - 2 * x) * 0.6 + x * 0.4;
		lines.push(`${f6(y)} ${f6(y)} ${f6(y)}`);
	}
	return `${lines.join('\n')}\n`;
}
export function makeBrokenCount() {
	const lines = ['TITLE "Broken"', 'LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0'];
	return `${lines.join('\n')}\n`;
}
export function makeBrokenNumber() {
	return [
		'# broken',
		'LUT_3D_SIZE 2',
		'0 0 0',
		'1 0 0',
		'0 1 0',
		'1 1 0',
		'0 0 x1',
		'1 0 1',
		'0 1 1',
		'1 1 1',
		'',
	].join('\n');
}

export async function fixtures() {
	const text = (name, make) => ({ name, recipe: `${name}:v1`, make: (out) => writeFileSync(out, make()) });
	return [
		{ name: 'chart.png', recipe: 'chart.png:v1', make: (out) => writeFileSync(out, makeChart()) },
		text('look-33.cube', makeLook33),
		text('tone-1d.cube', makeTone1d),
		text('broken-count.cube', makeBrokenCount),
		text('broken-number.cube', makeBrokenNumber),
	];
}
