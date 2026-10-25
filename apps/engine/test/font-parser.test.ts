// wp fonts: the font file reader (apps/engine/src/fonts/sfnt.ts) — formats, names, weights and refusals, plus
// property tests: malformed bytes (random, truncated, mutated fonts of every container) are refused with a
// FontParseError, never another exception, and without unbounded work.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FontParseError, parseFont } from '../src/fonts/sfnt.ts';
import { assembleSfnt, makeTestTtc, makeTestTtf, testFontTables, toWoff, toWoff2 } from './font-fixtures.ts';

const req = createRequire(import.meta.url);
const fontsource = (pkg: string, file: string) =>
	readFileSync(join(dirname(req.resolve(`${pkg}/metadata.json`)), 'files', file));

function refusal(bytes: Uint8Array): FontParseError {
	try {
		parseFont(bytes);
	} catch (e) {
		expect(e).toBeInstanceOf(FontParseError);
		return e as FontParseError;
	}
	throw new Error('expected a refusal');
}

describe('font parser: formats and names', () => {
	const ttf = makeTestTtf({ family: 'Pixel12x10', weight: 500, postscriptName: 'Pixel12x10' });

	it('reads a TrueType font: family, subfamily, full and PostScript names, weight, italic', () => {
		const p = parseFont(ttf);
		expect(p.container).toBe('ttf');
		expect(p.faces).toHaveLength(1);
		const { bytes, ...face } = p.faces[0]!;
		expect(bytes).toEqual(ttf);
		expect(face).toEqual({
			family: 'Pixel12x10',
			subfamily: 'Regular',
			fullName: 'Pixel12x10 Regular',
			postscriptName: 'Pixel12x10',
			weight: 500,
			italic: false,
			format: 'ttf',
		});
	});

	it('prefers the typographic family / subfamily (name IDs 16 / 17) and keeps the legacy family as an alias', () => {
		const f = parseFont(
			makeTestTtf({
				family: 'Circular Std Medium',
				subfamily: 'Regular',
				typographicFamily: 'Circular Std',
				typographicSubfamily: 'Medium',
				postscriptName: 'CircularStd-Medium',
				weight: 500,
			}),
		).faces[0]!;
		expect(f.family).toBe('Circular Std');
		expect(f.legacyFamily).toBe('Circular Std Medium');
		expect(f.subfamily).toBe('Medium');
		expect(f.postscriptName).toBe('CircularStd-Medium');
	});

	it('reads italic from OS/2 fsSelection and bold weights', () => {
		const f = parseFont(makeTestTtf({ family: 'X', weight: 700, italic: true })).faces[0]!;
		expect([f.weight, f.italic, f.subfamily]).toEqual([700, true, 'Italic']);
	});

	it('reads WOFF (zlib tables) and WOFF2 (one brotli stream) wrappers of the same font identically', () => {
		for (const [bytes, format] of [
			[toWoff(ttf), 'woff'],
			[toWoff2(ttf), 'woff2'],
		] as const) {
			const p = parseFont(bytes);
			expect(p.container).toBe(format);
			const { bytes: b, ...face } = p.faces[0]!;
			expect(b).toEqual(bytes);
			expect(face).toEqual({
				family: 'Pixel12x10',
				subfamily: 'Regular',
				fullName: 'Pixel12x10 Regular',
				postscriptName: 'Pixel12x10',
				weight: 500,
				italic: false,
				format,
			});
		}
	});

	it('reads real @fontsource files: WOFF2 with transformed glyf/loca, WOFF, and a variable font with axes', () => {
		const w2 = parseFont(fontsource('@fontsource/montserrat', 'montserrat-latin-800-italic.woff2')).faces[0]!;
		expect([w2.weight, w2.italic, w2.format]).toEqual([800, true, 'woff2']);
		expect(w2.family).toContain('Montserrat');
		const w1 = parseFont(fontsource('@fontsource/lato', 'lato-latin-700-normal.woff')).faces[0]!;
		expect([w1.family, w1.weight, w1.italic, w1.format]).toEqual(['Lato', 700, false, 'woff']);
		const v = parseFont(fontsource('@fontsource-variable/inter', 'inter-latin-standard-normal.woff2'))
			.faces[0]!;
		expect(v.family).toBe('Inter');
		expect(v.axes?.wght).toEqual({ min: 100, max: 900, default: 400 });
	});

	it('splits a TrueType collection into standalone faces that parse on their own', () => {
		const a = makeTestTtf({ family: 'Coll', weight: 400 });
		const b = makeTestTtf({ family: 'Coll', weight: 700, subfamily: 'Bold', seed: 2 });
		const p = parseFont(makeTestTtc([a, b]));
		expect(p.container).toBe('ttc');
		expect(p.faces.map((f) => [f.family, f.weight, f.format])).toEqual([
			['Coll', 400, 'ttf'],
			['Coll', 700, 'ttf'],
		]);
		for (const [i, f] of p.faces.entries()) {
			const again = parseFont(f.bytes);
			expect(again.container).toBe('ttf');
			expect(again.faces[0]).toMatchObject({ family: 'Coll', weight: [400, 700][i] });
		}
	});

	it('reads CFF-flavoured OpenType (OTTO) as otf', () => {
		const t = testFontTables({ family: 'Cff Test' });
		delete t.glyf;
		delete t.loca;
		t['CFF '] = new Uint8Array([1, 0, 4, 1]);
		const p = parseFont(assembleSfnt(0x4f54544f, t));
		expect([p.container, p.faces[0]!.format, p.faces[0]!.family]).toEqual(['otf', 'otf', 'Cff Test']);
	});
});

describe('font parser: refusals', () => {
	const ttf = makeTestTtf();

	it('refuses non-font bytes, empty input and PostScript Type 1', () => {
		expect(refusal(new Uint8Array()).code).toBe('FONT_INVALID');
		expect(refusal(new TextEncoder().encode('<html>not a font</html>')).code).toBe('FONT_INVALID');
		expect(refusal(new TextEncoder().encode('typ1xxxxxxxxxxxx')).code).toBe('FONT_UNSUPPORTED');
	});

	it('refuses fonts without names, outlines, a character map or a valid head', () => {
		for (const drop of ['name', 'cmap', 'glyf', 'head']) {
			const t = testFontTables();
			delete t[drop];
			expect(refusal(assembleSfnt(0x00010000, t)).code).toBe('FONT_INVALID');
		}
		const t = testFontTables();
		t.head = t.head!.slice();
		t.head[12] = 0; // magic
		expect(refusal(assembleSfnt(0x00010000, t)).code).toBe('FONT_INVALID');
	});

	it('refuses tables that point outside the file and truncated files', () => {
		expect(refusal(ttf.subarray(0, ttf.length - 100)).code).toBe('FONT_INVALID');
		expect(refusal(ttf.subarray(0, 20)).code).toBe('FONT_INVALID');
	});

	it('refuses unsupported WOFF2 / WOFF collections', () => {
		const w2 = toWoff2(ttf).slice();
		w2.set([0x74, 0x74, 0x63, 0x66], 4); // flavor = ttcf
		expect(refusal(w2).code).toBe('FONT_UNSUPPORTED');
		const w1 = toWoff(ttf).slice();
		w1.set([0x74, 0x74, 0x63, 0x66], 4);
		expect(refusal(w1).code).toBe('FONT_UNSUPPORTED');
	});

	it('refuses files over the size cap before reading them', () => {
		const big = new Uint8Array(64 * 1024 * 1024 + 1);
		big.set(ttf);
		expect(refusal(big).code).toBe('FONT_TOO_LARGE');
	});

	it('refuses surplus WOFF2 payload bytes beyond the table directory lengths', () => {
		const w2 = toWoff2(ttf);
		const v = new DataView(w2.buffer, w2.byteOffset, w2.byteLength);
		const total = v.getUint32(20);
		const head = w2.subarray(0, w2.length - ((total + 3) & ~3));
		// Keep every actual font table valid: only the surplus byte violates WOFF2 §5.
		const tables = brotliDecompressSync(w2.subarray(head.length, head.length + total));
		const payload = brotliCompressSync(Buffer.concat([tables, Buffer.from([0])]));
		const out = new Uint8Array(head.length + payload.length);
		out.set(head);
		out.set(payload, head.length);
		const ov = new DataView(out.buffer);
		ov.setUint32(8, out.length);
		ov.setUint32(20, payload.length);
		expect(refusal(out).code).toBe('FONT_INVALID');
	});

	it('refuses a WOFF table that inflates past its declared length', () => {
		const w = toWoff(ttf).slice();
		const v = new DataView(w.buffer);
		const n = v.getUint16(12);
		let patched = false;
		for (let i = 0; i < n; i++) {
			const at = 44 + i * 20;
			if (String.fromCharCode(...w.subarray(at, at + 4)) !== 'name') continue;
			const comp = v.getUint32(at + 8);
			const orig = v.getUint32(at + 12);
			expect(comp).toBeLessThan(orig); // stored compressed
			v.setUint32(at + 12, Math.max(comp, orig - 8)); // declares less than the stream inflates to
			patched = true;
		}
		expect(patched).toBe(true);
		expect(refusal(w).code).toBe('FONT_INVALID');
	});
});

describe('font parser: property tests (never throws anything but FontParseError, bounded work)', () => {
	const seeds = [makeTestTtf(), toWoff(makeTestTtf()), toWoff2(makeTestTtf()), makeTestTtc([makeTestTtf()])];
	const settle = (bytes: Uint8Array) => {
		try {
			const p = parseFont(bytes);
			expect(p.faces.length).toBeGreaterThan(0);
			for (const f of p.faces) {
				expect(f.family.length).toBeGreaterThan(0);
				expect(f.family.length).toBeLessThanOrEqual(128);
				expect(f.weight).toBeGreaterThanOrEqual(1);
				expect(f.weight).toBeLessThanOrEqual(1000);
			}
		} catch (e) {
			if (!(e instanceof FontParseError)) throw e;
		}
	};

	it('random bytes, with and without a font signature', () => {
		const sigs = ['', '\0\x01\0\0', 'OTTO', 'true', 'ttcf', 'wOFF', 'wOF2'];
		fc.assert(
			fc.property(fc.constantFrom(...sigs), fc.uint8Array({ maxLength: 4096 }), (sig, rest) => {
				const b = new Uint8Array(sig.length + rest.length);
				b.set([...sig].map((c) => c.charCodeAt(0)));
				b.set(rest, sig.length);
				settle(b);
			}),
			{ numRuns: 1500 },
		);
	});

	it('valid fonts of every container with flipped bytes and truncations', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...seeds),
				fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 16 }),
				fc.option(fc.nat(), { nil: undefined }),
				(seed, flips, cut) => {
					const b = seed.slice(0, cut === undefined ? seed.length : cut % (seed.length + 1));
					// headers and directories are where offsets live: bias half the flips into the first 256 bytes
					flips.forEach(([at, v], i) => {
						if (b.length === 0) return;
						const span = i % 2 === 0 ? Math.min(256, b.length) : b.length;
						b[at % span] = v;
					});
					const t0 = performance.now();
					settle(b);
					expect(performance.now() - t0).toBeLessThan(2000);
				},
			),
			{ numRuns: 1500 },
		);
	});

	it('large header fields stay bounded and yield valid faces or typed refusals', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...seeds),
				fc.nat({ max: 60 }),
				fc.constantFrom(0xffff, 0xffffffff, 0x7fffffff),
				(seed, at, v) => {
					const b = seed.slice();
					const dv = new DataView(b.buffer);
					const off = Math.min(at * 2, b.length - 4);
					if (off >= 0) dv.setUint32(off, v >>> 0);
					const before = process.memoryUsage().arrayBuffers;
					settle(b);
					expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(128 * 1024 * 1024 + (1 << 20));
				},
			),
			{ numRuns: 600 },
		);
	});
});
