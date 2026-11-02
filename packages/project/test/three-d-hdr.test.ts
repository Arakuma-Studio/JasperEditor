// Spec 19 TL-075: the Radiance reader takes untrusted bytes: a valid file decodes to the values written, anything else
// is a named error, and nothing the header claims is allocated before it is validated.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	decodeHdr,
	decodeHdrAsync,
	HDR_MAX_OUTPUT_SIDE,
	HDR_MAX_PIXELS,
	HdrParseError,
	isHdrFile,
	parseHdrHeader,
} from '../src/index.ts';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function rgbe(r: number, g: number, b: number): [number, number, number, number] {
	const m = Math.max(r, g, b);
	if (m < 1e-32) return [0, 0, 0, 0];
	const e = Math.ceil(Math.log2(m)) + 1;
	const k = 256 / 2 ** e;
	return [Math.floor(r * k), Math.floor(g * k), Math.floor(b * k), e + 128];
}

const header = (w: number, h: number, res = `-Y ${h} +X ${w}`, extra = '') =>
	ascii(`#?RADIANCE\n# made by the test\nFORMAT=32-bit_rle_rgbe\n${extra}\n${res}\n`);

/** A flat (uncompressed) file. */
function flat(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8Array {
	const out = [...header(w, h)];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const [r, g, b] = px(x, y);
			out.push(...rgbe(r, g, b));
		}
	return Uint8Array.from(out);
}

/** An adaptive RLE file: every channel one run, or literals when `literal`. */
function rle(w: number, h: number, c: [number, number, number, number], literal = false): Uint8Array {
	const out = [...header(w, h)];
	for (let y = 0; y < h; y++) {
		out.push(2, 2, w >> 8, w & 255);
		for (let k = 0; k < 4; k++) {
			let left = w;
			while (left > 0) {
				if (literal) {
					const n = Math.min(left, 128);
					out.push(n, ...new Array<number>(n).fill(c[k]!));
					left -= n;
				} else {
					const n = Math.min(left, 127);
					out.push(128 + n, c[k]!);
					left -= n;
				}
			}
		}
	}
	return Uint8Array.from(out);
}

describe('Radiance .hdr reader', () => {
	it('decodes values above 1 into scene-linear floats', () => {
		const img = decodeHdr(flat(2, 2, (x, y) => [12 + x, y * 8 + 4, 16]));
		expect([img.width, img.height]).toEqual([2, 2]);
		expect(img.data[0]).toBeCloseTo(12, 0);
		expect(img.data[2]).toBeCloseTo(16, 0);
		expect(img.data[(1 * 2 + 1) * 4 + 1]).toBeCloseTo(12, 0);
		expect(img.data[3]).toBe(1);
	});

	it('reads adaptive runs and literals to the same pixels', () => {
		const c = rgbe(3, 1.5, 0.75);
		const a = decodeHdr(rle(64, 8, c));
		const b = decodeHdr(rle(64, 8, c, true));
		expect(Array.from(a.data)).toEqual(Array.from(b.data));
		expect(a.data[0]).toBeCloseTo(3, 1);
	});

	it('reads the old run encoding (1, 1, 1, n)', () => {
		const out = [...header(5, 1)];
		out.push(...rgbe(2, 2, 2), 1, 1, 1, 4);
		const img = decodeHdr(Uint8Array.from(out));
		expect(img.data[4 * 4]).toBeCloseTo(2, 1);
	});

	it('honours the orientation and EXPOSURE lines', () => {
		const head = ascii(`#?RGBE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=2\n\n+Y 2 -X 2\n`);
		const body = [...rgbe(1, 0, 0), ...rgbe(2, 0, 0), ...rgbe(4, 0, 0), ...rgbe(8, 0, 0)];
		const img = decodeHdr(Uint8Array.from([...head, ...body]));
		// +Y: first stored row is the bottom one; −X: stored right to left; exposure 2 halves the values.
		expect(img.data[0]).toBeCloseTo(4, 1);
		expect(img.data[4]).toBeCloseTo(2, 1);
		expect(img.data[(2 + 1) * 4]).toBeCloseTo(0.5, 1);
	});

	it('reduces large files as it decodes, so the output never passes the cap', () => {
		const w = HDR_MAX_OUTPUT_SIDE * 2;
		const out = [...header(w, 2)];
		for (let y = 0; y < 2; y++) {
			out.push(2, 2, w >> 8, w & 255);
			for (let k = 0; k < 4; k++) {
				let left = w;
				while (left > 0) {
					const n = Math.min(left, 127);
					out.push(128 + n, rgbe(1, 1, 1)[k]!);
					left -= n;
				}
			}
		}
		const img = decodeHdr(Uint8Array.from(out));
		expect(img.width).toBe(HDR_MAX_OUTPUT_SIDE);
		expect(img.sourceWidth).toBe(w);
		expect(img.data[0]).toBeCloseTo(1, 1);
	});

	it('decodes cooperatively to the same result', async () => {
		const bytes = rle(16, 200, rgbe(1, 2, 4));
		let turns = 0;
		const a = await decodeHdrAsync(bytes, 4096, async () => {
			turns++;
		});
		expect(turns).toBeGreaterThanOrEqual(3);
		expect(Array.from(a.data)).toEqual(Array.from(decodeHdr(bytes).data));
	});

	it.each([
		['no magic', ascii('P6\n1 1\n255\nabc')],
		['no resolution', ascii('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n')],
		['wrong format', ascii('#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n\0\0\0\0')],
		['rotated', ascii('#?RADIANCE\n\n+X 1 -Y 1\n\0\0\0\0')],
		['zero size', ascii('#?RADIANCE\n\n-Y 0 +X 1\n')],
		['header never ends', ascii('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n')],
		['negative exposure', ascii('#?RADIANCE\nEXPOSURE=-1\n\n-Y 1 +X 1\n\0\0\0\0')],
	])('refuses %s', (_n, bytes) => {
		expect(() => decodeHdr(Uint8Array.from(bytes))).toThrow(HdrParseError);
	});

	it('refuses a header that claims more than the cap, before allocating', () => {
		const huge = Uint8Array.from(ascii('#?RADIANCE\n\n-Y 16384 +X 16384\n'));
		expect(() => parseHdrHeader(huge)).toThrow(/too large/);
		expect(16384 * 16384).toBeGreaterThan(HDR_MAX_PIXELS);
		const wide = Uint8Array.from(ascii('#?RADIANCE\n\n-Y 1 +X 999999999\n'));
		expect(() => parseHdrHeader(wide)).toThrow(HdrParseError);
	});

	it('refuses data that ends early or overruns a scanline', () => {
		const good = rle(16, 4, rgbe(1, 1, 1));
		expect(() => decodeHdr(good.slice(0, good.length - 3))).toThrow(HdrParseError);
		const out = [...header(8, 1), 2, 2, 0, 8, 128 + 100, 7];
		expect(() => decodeHdr(Uint8Array.from(out))).toThrow(/overruns/);
	});

	it('clamps hostile exponents: nothing non-finite reaches a texture', () => {
		const img = decodeHdr(Uint8Array.from([...header(1, 1), 255, 255, 255, 255]));
		for (const v of img.data) expect(Number.isFinite(v)).toBe(true);
	});

	it('names files by extension', () => {
		expect(isHdrFile('Studio.HDR')).toBe(true);
		expect(isHdrFile('a.rgbe')).toBe(true);
		expect(isHdrFile('a.exr')).toBe(false);
	});

	it('fuzz: mutated and random files decode or throw HdrParseError, and stay finite', () => {
		const base = rle(16, 8, rgbe(1.5, 0.5, 3));
		const flatBase = flat(9, 3, (x) => [x, 1, 2]);
		const check = (bytes: Uint8Array) => {
			try {
				const img = decodeHdr(bytes);
				expect(img.data.length).toBe(img.width * img.height * 4);
				expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(HDR_MAX_OUTPUT_SIDE);
				for (let i = 0; i < img.data.length; i += 97) expect(Number.isFinite(img.data[i]!)).toBe(true);
			} catch (e) {
				expect(e).toBeInstanceOf(HdrParseError);
			}
		};
		fc.assert(
			fc.property(
				fc.constantFrom(base, flatBase),
				fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 24 }),
				fc.nat(),
				(src, edits, cut) => {
					const b = src.slice(0, src.length - (cut % 8 === 0 ? cut % src.length : 0));
					for (const [at, v] of edits) if (b.length) b[at % b.length] = v;
					check(b);
				},
			),
			{ numRuns: 500 },
		);
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 512 }), (b) => check(b)),
			{ numRuns: 300 },
		);
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				fc.uint8Array({ maxLength: 256 }),
				(h, w, body) => {
					const head = ascii(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
					check(Uint8Array.from([...head, ...body]));
				},
			),
			{ numRuns: 300 },
		);
	});
});
