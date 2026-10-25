// Test fonts generated in memory (no font binaries in the repository): a minimal but complete TrueType font
// (head, hhea, maxp, OS/2, hmtx, cmap format 4, name, post, glyf, loca) whose printable-ASCII glyphs are blocky
// 3×5 cell patterns derived from the character code — unmistakably different from any bundled family, so a render
// in it can be told from the fallback by its pixels. Plus WOFF (zlib) and WOFF2 (brotli, null-transformed glyf /
// loca) wrappers and a TTC builder, for the parser, the store, the routes and the render tests.
import { brotliCompressSync, deflateSync } from 'node:zlib';

export type TestFontOptions = {
	family?: string;
	subfamily?: string;
	/** Typographic family / subfamily (name IDs 16 / 17), when given. */
	typographicFamily?: string;
	typographicSubfamily?: string;
	fullName?: string;
	postscriptName?: string;
	weight?: number;
	italic?: boolean;
	/** Changes the glyph patterns (two fonts with different seeds draw differently). */
	seed?: number;
	/** Extra (unread) table bytes, to vary the file size. */
	padBytes?: number;
	/** Custom glyph outlines: rectangles `[x0, y0, x1, y1]` in font units (1000 / em) per character code. */
	glyphRects?: (code: number) => [number, number, number, number][];
};

const UPEM = 1000;
const FIRST = 32;
const LAST = 126;

class Buf {
	private parts: number[] = [];
	u8(v: number) {
		this.parts.push(v & 255);
		return this;
	}
	u16(v: number) {
		return this.u8(v >> 8).u8(v);
	}
	i16(v: number) {
		return this.u16(v < 0 ? v + 65536 : v);
	}
	u32(v: number) {
		return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
	}
	bytes(b: Uint8Array | number[]) {
		for (const x of b) this.parts.push(x & 255);
		return this;
	}
	zeros(n: number) {
		for (let i = 0; i < n; i++) this.parts.push(0);
		return this;
	}
	get length() {
		return this.parts.length;
	}
	done(): Uint8Array {
		return Uint8Array.from(this.parts);
	}
}

function tagBytes(t: string): number[] {
	return [...t].map((c) => c.charCodeAt(0));
}

function checksum(b: Uint8Array): number {
	let sum = 0;
	const padded = new Uint8Array((b.length + 3) & ~3);
	padded.set(b);
	const v = new DataView(padded.buffer);
	for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
	return sum;
}

/** Cells (col 0..2, row 0..4) inked for a character. */
function cells(code: number, seed: number): [number, number][] {
	let h = (code * 2654435761 + seed * 40503) >>> 0;
	const out: [number, number][] = [];
	for (let i = 0; i < 15; i++) {
		h = (h * 1103515245 + 12345) >>> 0;
		if ((h >>> 16) & 1 || i === 7) out.push([i % 3, Math.floor(i / 3)]);
	}
	return out;
}

const CELL = 160;
const ADVANCE = 600;

function glyph(
	code: number | null,
	seed: number,
	custom?: (code: number) => [number, number, number, number][],
): Uint8Array {
	// .notdef: one hollow-less box; space: empty
	const rects: [number, number, number, number][] =
		code === null
			? [[50, 0, 450, 700]]
			: custom
				? custom(code)
				: code === 32
					? []
					: cells(code, seed).map(([cx, cy]) => [
							60 + cx * CELL,
							cy * CELL,
							60 + cx * CELL + CELL,
							cy * CELL + CELL,
						]);
	if (rects.length === 0) return new Uint8Array(0);
	const b = new Buf();
	const xMin = Math.min(...rects.map((r) => r[0]));
	const yMin = Math.min(...rects.map((r) => r[1]));
	const xMax = Math.max(...rects.map((r) => r[2]));
	const yMax = Math.max(...rects.map((r) => r[3]));
	b.i16(rects.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
	for (let i = 0; i < rects.length; i++) b.u16(i * 4 + 3);
	b.u16(0); // instructions
	const pts: [number, number][] = [];
	// clockwise: (x0,y0) → (x0,y1) → (x1,y1) → (x1,y0)
	for (const [x0, y0, x1, y1] of rects) pts.push([x0, y0], [x0, y1], [x1, y1], [x1, y0]);
	for (let i = 0; i < pts.length; i++) b.u8(0x01);
	let px = 0;
	for (const [x] of pts) {
		b.i16(x - px);
		px = x;
	}
	let py = 0;
	for (const [, y] of pts) {
		b.i16(y - py);
		py = y;
	}
	while (b.length % 4) b.u8(0);
	return b.done();
}

function utf16(s: string): number[] {
	const out: number[] = [];
	for (const ch of s) {
		const c = ch.charCodeAt(0);
		out.push(c >> 8, c & 255);
	}
	return out;
}

function nameTable(names: [number, string][]): Uint8Array {
	const sorted = [...names].sort((a, b) => a[0] - b[0]);
	const storage: number[] = [];
	const b = new Buf();
	b.u16(0)
		.u16(sorted.length)
		.u16(6 + sorted.length * 12);
	for (const [id, s] of sorted) {
		const bytes = utf16(s);
		b.u16(3).u16(1).u16(0x0409).u16(id).u16(bytes.length).u16(storage.length);
		storage.push(...bytes);
	}
	b.bytes(storage);
	return b.done();
}

/** Assembles an sfnt from tables (tag → bytes), with checksums and head.checkSumAdjustment. */
export function assembleSfnt(flavor: number, tables: Record<string, Uint8Array>): Uint8Array {
	const tags = Object.keys(tables).sort();
	const n = tags.length;
	const entrySelector = Math.floor(Math.log2(n));
	const searchRange = 2 ** entrySelector * 16;
	const header = new Buf()
		.u32(flavor)
		.u16(n)
		.u16(searchRange)
		.u16(entrySelector)
		.u16(n * 16 - searchRange);
	let offset = 12 + 16 * n;
	const dir = new Buf();
	const data = new Buf();
	for (const t of tags) {
		const tb = tables[t]!;
		dir.bytes(tagBytes(t)).u32(checksum(tb)).u32(offset).u32(tb.length);
		data.bytes(tb);
		while (data.length % 4) data.u8(0);
		offset += (tb.length + 3) & ~3;
	}
	const out = new Buf().bytes(header.done()).bytes(dir.done()).bytes(data.done()).done();
	const headIdx = tags.indexOf('head');
	if (headIdx >= 0) {
		const v = new DataView(out.buffer);
		const headOff = v.getUint32(12 + headIdx * 16 + 8);
		v.setUint32(headOff + 8, (0xb1b0afba - checksum(out)) >>> 0);
	}
	return out;
}

/** The tables of a generated TrueType font. */
export function testFontTables(o: TestFontOptions = {}): Record<string, Uint8Array> {
	const family = o.family ?? 'Jasper Test Pixel';
	const subfamily = o.subfamily ?? (o.italic ? 'Italic' : 'Regular');
	const weight = o.weight ?? 400;
	const italic = o.italic ?? false;
	const seed = o.seed ?? 1;
	const fullName = o.fullName ?? `${family} ${subfamily}`;
	const ps = o.postscriptName ?? `${family}-${subfamily}`.replace(/\s+/g, '');
	const glyphs = [glyph(null, seed)];
	for (let c = FIRST; c <= LAST; c++) glyphs.push(glyph(c, seed, o.glyphRects));
	const contours = glyphs.map((g) => (g.length ? new DataView(g.buffer).getInt16(0) : 0));
	const maxContours = Math.max(16, ...contours);
	const numGlyphs = glyphs.length;
	const loca = new Buf();
	const glyf = new Buf();
	for (const g of glyphs) {
		loca.u32(glyf.length);
		glyf.bytes(g);
	}
	loca.u32(glyf.length);
	const macStyle = (weight >= 700 ? 1 : 0) | (italic ? 2 : 0);
	const head = new Buf()
		.u32(0x00010000)
		.u32(0x00010000)
		.u32(0)
		.u32(0x5f0f3cf5)
		.u16(0x000b)
		.u16(UPEM)
		.zeros(16)
		.i16(0)
		.i16(0)
		.i16(ADVANCE)
		.i16(800)
		.u16(macStyle)
		.u16(8)
		.i16(2)
		.i16(1)
		.i16(0)
		.done();
	const hhea = new Buf()
		.u32(0x00010000)
		.i16(800)
		.i16(-200)
		.i16(0)
		.u16(ADVANCE)
		.i16(0)
		.i16(0)
		.i16(ADVANCE)
		.i16(1)
		.i16(0)
		.i16(0)
		.zeros(8)
		.i16(0)
		.u16(numGlyphs)
		.done();
	const maxp = new Buf()
		.u32(0x00010000)
		.u16(numGlyphs)
		.u16(maxContours * 4)
		.u16(maxContours)
		.u16(0)
		.u16(0)
		.u16(2)
		.zeros(16)
		.done();
	const fsSelection = (italic ? 0x1 : 0) | (weight >= 700 ? 0x20 : 0) | (!italic && weight < 700 ? 0x40 : 0);
	const os2 = new Buf()
		.u16(4)
		.i16(ADVANCE)
		.u16(weight)
		.u16(5)
		.u16(0)
		.zeros(16)
		.i16(50)
		.i16(300)
		.i16(0)
		.zeros(10)
		.u32(1)
		.zeros(12)
		.bytes(tagBytes('JSPR'))
		.u16(fsSelection)
		.u16(FIRST)
		.u16(LAST)
		.i16(800)
		.i16(-200)
		.i16(0)
		.u16(800)
		.u16(200)
		.u32(1)
		.u32(0)
		.i16(480)
		.i16(800)
		.u16(0)
		.u16(32)
		.u16(1)
		.done();
	const hmtx = new Buf();
	for (let i = 0; i < numGlyphs; i++) hmtx.u16(ADVANCE).i16(i === 1 ? 0 : 50);
	// cmap: format 4, 32..126 → glyphs 1..95 (idDelta), plus the 0xFFFF end segment
	const segs = [
		{ start: FIRST, end: LAST, delta: 1 - FIRST },
		{ start: 0xffff, end: 0xffff, delta: 1 },
	];
	const segX2 = segs.length * 2;
	const es = Math.floor(Math.log2(segs.length));
	const sr = 2 ** es * 2;
	const sub = new Buf()
		.u16(4)
		.u16(16 + segs.length * 8)
		.u16(0)
		.u16(segX2)
		.u16(sr)
		.u16(es)
		.u16(segX2 - sr);
	for (const s of segs) sub.u16(s.end);
	sub.u16(0);
	for (const s of segs) sub.u16(s.start);
	for (const s of segs) sub.i16(s.delta);
	for (const _ of segs) sub.u16(0);
	const cmap = new Buf().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.done()).done();
	const names: [number, string][] = [
		[1, family],
		[2, subfamily],
		[3, `${ps};test`],
		[4, fullName],
		[5, 'Version 1.000'],
		[6, ps],
	];
	if (o.typographicFamily) names.push([16, o.typographicFamily]);
	if (o.typographicSubfamily) names.push([17, o.typographicSubfamily]);
	const post = new Buf()
		.u32(0x00030000)
		.u32(italic ? (-12 * 65536) >>> 0 : 0)
		.i16(-100)
		.i16(50)
		.u32(0)
		.zeros(16)
		.done();
	const tables: Record<string, Uint8Array> = {
		head,
		hhea,
		maxp,
		'OS/2': os2,
		hmtx: hmtx.done(),
		cmap,
		name: nameTable(names),
		post,
		glyf: glyf.done(),
		loca: loca.done(),
	};
	if (o.padBytes) tables.zzzz = new Uint8Array(o.padBytes);
	return tables;
}

/** A complete TrueType font file. */
export function makeTestTtf(o: TestFontOptions = {}): Uint8Array {
	return assembleSfnt(0x00010000, testFontTables(o));
}

/** WOFF 1.0 wrapper of an sfnt (tables zlib-compressed when that is smaller). */
export function toWoff(sfnt: Uint8Array): Uint8Array {
	const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
	const flavor = v.getUint32(0);
	const n = v.getUint16(4);
	const recs = [];
	for (let i = 0; i < n; i++) {
		const at = 12 + i * 16;
		recs.push({
			tag: sfnt.subarray(at, at + 4),
			checksum: v.getUint32(at + 4),
			data: sfnt.subarray(v.getUint32(at + 8), v.getUint32(at + 8) + v.getUint32(at + 12)),
		});
	}
	let offset = 44 + 20 * n;
	const dir = new Buf();
	const body = new Buf();
	for (const r of recs) {
		const z = deflateSync(r.data);
		const comp = z.length < r.data.length ? z : r.data;
		dir.bytes(r.tag).u32(offset).u32(comp.length).u32(r.data.length).u32(r.checksum);
		body.bytes(comp);
		while (body.length % 4) body.u8(0);
		offset += (comp.length + 3) & ~3;
	}
	const total = 44 + 20 * n + body.length;
	return new Buf()
		.bytes(tagBytes('wOFF'))
		.u32(flavor)
		.u32(total)
		.u16(n)
		.u16(0)
		.u32(sfnt.length)
		.u16(1)
		.u16(0)
		.zeros(20)
		.bytes(dir.done())
		.bytes(body.done())
		.done();
}

const WOFF2_KNOWN = [
	'cmap',
	'head',
	'hhea',
	'hmtx',
	'maxp',
	'name',
	'OS/2',
	'post',
	'cvt ',
	'fpgm',
	'glyf',
	'loca',
];

function base128(v: number): number[] {
	const out: number[] = [];
	do {
		out.unshift(v & 0x7f);
		v >>>= 7;
	} while (v > 0);
	for (let i = 0; i < out.length - 1; i++) out[i]! |= 0x80;
	return out;
}

/** WOFF 2.0 wrapper: every table untransformed (glyf / loca with the null transform), one brotli stream. */
export function toWoff2(sfnt: Uint8Array): Uint8Array {
	const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
	const flavor = v.getUint32(0);
	const n = v.getUint16(4);
	const dir = new Buf();
	const chunks: Uint8Array[] = [];
	const recs: { t: string; data: Uint8Array }[] = [];
	for (let i = 0; i < n; i++) {
		const at = 12 + i * 16;
		const t = String.fromCharCode(...sfnt.subarray(at, at + 4));
		recs.push({ t, data: sfnt.subarray(v.getUint32(at + 8), v.getUint32(at + 8) + v.getUint32(at + 12)) });
	}
	// WOFF 2.0 §5.3: loca follows glyf in the table directory
	const loca = recs.find((r) => r.t === 'loca');
	const ordered = recs.filter((r) => r !== loca).flatMap((r) => (r.t === 'glyf' && loca ? [r, loca] : [r]));
	for (const { t, data } of ordered) {
		const known = WOFF2_KNOWN.indexOf(t);
		const nullT = t === 'glyf' || t === 'loca' ? 3 << 6 : 0;
		if (known >= 0) dir.u8(nullT | known);
		else dir.u8(63).bytes(tagBytes(t));
		dir.bytes(base128(data.length));
		chunks.push(data);
	}
	const raw = Buffer.concat(chunks);
	const compressed = brotliCompressSync(raw);
	const dirBytes = dir.done();
	const body = new Buf().bytes(compressed);
	while (body.length % 4) body.u8(0);
	const total = 48 + dirBytes.length + body.length;
	return new Buf()
		.bytes(tagBytes('wOF2'))
		.u32(flavor)
		.u32(total)
		.u16(n)
		.u16(0)
		.u32(sfnt.length)
		.u32(compressed.length)
		.u16(1)
		.u16(0)
		.zeros(20)
		.bytes(dirBytes)
		.bytes(body.done())
		.done();
}

/** A TrueType collection of the given fonts (tables not shared). */
export function makeTestTtc(fonts: Uint8Array[]): Uint8Array {
	const headerLen = 12 + 4 * fonts.length;
	const offsets: number[] = [];
	let at = headerLen;
	for (const f of fonts) {
		offsets.push(at);
		at += (f.length + 3) & ~3;
	}
	const b = new Buf().bytes(tagBytes('ttcf')).u16(1).u16(0).u32(fonts.length);
	for (const o of offsets) b.u32(o);
	const out = new Uint8Array(at);
	out.set(b.done(), 0);
	fonts.forEach((f, i) => {
		// rebase the face's table offsets onto the collection
		const copy = f.slice();
		const v = new DataView(copy.buffer);
		const n = v.getUint16(4);
		for (let k = 0; k < n; k++) v.setUint32(12 + k * 16 + 8, v.getUint32(12 + k * 16 + 8) + offsets[i]!);
		out.set(copy, offsets[i]!);
	});
	return out;
}
