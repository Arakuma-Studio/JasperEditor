// Font file reader for the user font library (wp fonts, docs/wp-notes/fonts.md): validates TrueType / OpenType
// (sfnt), font collections (TTC), WOFF 1.0 and WOFF 2.0 bytes and reads the naming and weight / style of each face
// from the `name`, `OS/2`, `head` and `fvar` tables. Untrusted input: every offset and count is bounds-checked, every
// allocation is capped (tables, decompressed WOFF / WOFF2 streams, strings, faces), and every failure is a
// `FontParseError` with a stable code — the reader never throws anything else on malformed bytes.
//
// Formats (references in the work note):
//   sfnt     OpenType spec "Font file" (table directory), `name`, `OS/2`, `head`, `fvar`
//   TTC      OpenType spec "Font collections" (`ttcf` header): each face is rebuilt as a standalone sfnt so browsers
//            (which load one face per file) and the library store one file per face
//   WOFF 1   W3C WOFF File Format 1.0: per-table zlib streams (stored when compLength = origLength)
//   WOFF 2   W3C WOFF File Format 2.0: one brotli stream of every table; glyf / loca / hmtx may be transformed, the
//            `name`, `OS/2`, `head` and `fvar` tables never are, so they are read straight from the stream
import { brotliDecompressSync, inflateSync } from 'node:zlib';

export type FontFileFormat = 'ttf' | 'otf' | 'woff' | 'woff2';
export type FontContainer = FontFileFormat | 'ttc';

export type FontAxis = { min: number; max: number; default: number };

export type ParsedFace = {
	/** Typographic family (name ID 16) when present, else the family (ID 1). */
	family: string;
	/** The legacy family (name ID 1) when it differs from `family`, e.g. "Montserrat Light" (matched as an alias). */
	legacyFamily?: string;
	/** Typographic subfamily (ID 17) when present, else the subfamily (ID 2), e.g. "Bold Italic". */
	subfamily: string;
	/** Full font name (ID 4). */
	fullName: string;
	/** PostScript name (ID 6), the name Premiere and other apps store in projects (e.g. "CircularStd-Medium"). */
	postscriptName: string;
	/** OS/2 usWeightClass (1…1000), else 700 / 400 from `head.macStyle`. */
	weight: number;
	italic: boolean;
	/** Variation axes (`fvar`), when the face is a variable font. */
	axes?: Record<string, FontAxis>;
};

export type ParsedFont = {
	container: FontContainer;
	faces: ParsedFaceFile[];
};

/** A face and the bytes of the file that renders it (a TTC face is extracted as its own sfnt). */
export type ParsedFaceFile = ParsedFace & { format: FontFileFormat; bytes: Uint8Array };

export type FontParseErrorCode = 'FONT_INVALID' | 'FONT_UNSUPPORTED' | 'FONT_TOO_LARGE';

export class FontParseError extends Error {
	constructor(
		readonly code: FontParseErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'FontParseError';
	}
}

/** Caps (allocation bounds for untrusted input). */
export const FONT_LIMITS = {
	/** Largest font file accepted (bytes). CJK OpenType families are ≈ 16–25 MB; collections up to ≈ 40 MB. */
	maxFileBytes: 64 * 1024 * 1024,
	/** Largest decompressed WOFF / WOFF2 payload (bytes). */
	maxDecompressedBytes: 128 * 1024 * 1024,
	/** Tables per face (real fonts have < 40). */
	maxTables: 256,
	/** Faces per collection. */
	maxFaces: 64,
	/** Characters kept per name string. */
	maxNameChars: 128,
	/** Variation axes per face. */
	maxAxes: 64,
} as const;

const invalid = (m: string) => new FontParseError('FONT_INVALID', m);

const SFNT_TRUETYPE = 0x00010000;
const tag = (s: string) =>
	(s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);
const TAG_OTTO = tag('OTTO') >>> 0;
const TAG_TRUE = tag('true') >>> 0;
const TAG_TYP1 = tag('typ1') >>> 0;
const TAG_TTCF = tag('ttcf') >>> 0;
const TAG_WOFF = tag('wOFF') >>> 0;
const TAG_WOF2 = tag('wOF2') >>> 0;

/** Bounds-checked big-endian reads over a byte range. */
class Reader {
	readonly view: DataView;
	constructor(readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	get length(): number {
		return this.bytes.byteLength;
	}
	private need(off: number, n: number, what: string): void {
		if (!Number.isInteger(off) || off < 0 || off + n > this.bytes.byteLength)
			throw invalid(`${what} is outside the file`);
	}
	u8(off: number, what = 'A field'): number {
		this.need(off, 1, what);
		return this.view.getUint8(off);
	}
	u16(off: number, what = 'A field'): number {
		this.need(off, 2, what);
		return this.view.getUint16(off);
	}
	i16(off: number, what = 'A field'): number {
		this.need(off, 2, what);
		return this.view.getInt16(off);
	}
	u32(off: number, what = 'A field'): number {
		this.need(off, 4, what);
		return this.view.getUint32(off);
	}
	fixed(off: number, what = 'A field'): number {
		this.need(off, 4, what);
		return this.view.getInt32(off) / 65536;
	}
	slice(off: number, len: number, what: string): Uint8Array {
		this.need(off, len, what);
		return this.bytes.subarray(off, off + len);
	}
}

type TableRecord = { tag: number; checksum: number; offset: number; length: number };

const tagName = (t: number) =>
	String.fromCharCode((t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);

/** The table directory of the sfnt at `base`; every table must lie inside the file. */
function tableDirectory(r: Reader, base: number): { flavor: number; tables: TableRecord[] } {
	const flavor = r.u32(base, 'The font header');
	if (flavor === TAG_TYP1)
		throw new FontParseError('FONT_UNSUPPORTED', 'PostScript Type 1 fonts are not supported');
	if (flavor !== SFNT_TRUETYPE && flavor !== TAG_OTTO && flavor !== TAG_TRUE)
		throw invalid('Not a TrueType or OpenType font');
	const numTables = r.u16(base + 4, 'The font header');
	if (numTables === 0 || numTables > FONT_LIMITS.maxTables) throw invalid(`Bad table count ${numTables}`);
	const tables: TableRecord[] = [];
	for (let i = 0; i < numTables; i++) {
		const at = base + 12 + i * 16;
		const t: TableRecord = {
			tag: r.u32(at, 'The table directory'),
			checksum: r.u32(at + 4, 'The table directory'),
			offset: r.u32(at + 8, 'The table directory'),
			length: r.u32(at + 12, 'The table directory'),
		};
		if (t.offset + t.length > r.length) throw invalid(`Table ${tagName(t.tag)} is outside the file`);
		tables.push(t);
	}
	return { flavor, tables };
}

/** Table bytes by tag (first occurrence). */
type Tables = Map<number, Uint8Array>;

// Mac OS Roman, 0x80–0xFF (name records of platform 1 / encoding 0).
const MAC_ROMAN =
	'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g;

function clean(s: string): string {
	return s.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, FONT_LIMITS.maxNameChars);
}

function decodeName(bytes: Uint8Array, platform: number, encoding: number): string | null {
	if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) {
		// UTF-16BE; an odd trailing byte is ignored. Capped before decoding.
		const n = Math.min(bytes.length >> 1, FONT_LIMITS.maxNameChars * 2);
		let s = '';
		for (let i = 0; i < n; i++) s += String.fromCharCode((bytes[2 * i]! << 8) | bytes[2 * i + 1]!);
		return s;
	}
	if (platform === 1 && encoding === 0) {
		let s = '';
		const n = Math.min(bytes.length, FONT_LIMITS.maxNameChars * 2);
		for (let i = 0; i < n; i++) {
			const b = bytes[i]!;
			s += b < 0x80 ? String.fromCharCode(b) : MAC_ROMAN[b - 0x80]!;
		}
		return s;
	}
	return null;
}

/** Name strings by name ID, preferring Windows English (US), then any Windows, Unicode, Mac Roman. */
function readNames(name: Uint8Array): Map<number, string> {
	const r = new Reader(name);
	const count = r.u16(2, 'The name table');
	const storage = r.u16(4, 'The name table');
	const rank = (p: number, e: number, l: number) =>
		p === 3 && l === 0x0409 ? 0 : p === 3 ? 1 : p === 0 ? 2 : p === 1 && e === 0 && l === 0 ? 3 : 4;
	const best = new Map<number, { rank: number; value: string }>();
	const n = Math.min(count, Math.floor((r.length - 6) / 12));
	for (let i = 0; i < n; i++) {
		const at = 6 + i * 12;
		const platform = r.u16(at);
		const encoding = r.u16(at + 2);
		const language = r.u16(at + 4);
		const id = r.u16(at + 6);
		if (id !== 1 && id !== 2 && id !== 4 && id !== 6 && id !== 16 && id !== 17) continue;
		const rk = rank(platform, encoding, language);
		const prev = best.get(id);
		if (rk >= 4 || (prev && prev.rank <= rk)) continue;
		const length = r.u16(at + 8);
		const offset = storage + r.u16(at + 10);
		if (offset + length > r.length) continue; // a broken record is skipped, not fatal
		const value = decodeName(r.slice(offset, length, 'A name string'), platform, encoding);
		const v = value === null ? '' : clean(value);
		if (v) best.set(id, { rank: rk, value: v });
	}
	return new Map([...best].map(([k, v]) => [k, v.value]));
}

/** PostScript names are printable ASCII without `[](){}<>/%` (OpenType `name` ID 6). */
function postscriptSafe(s: string): string {
	return s.replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, '').slice(0, 63);
}

function readAxes(fvar: Uint8Array): Record<string, FontAxis> | undefined {
	const r = new Reader(fvar);
	const axesOffset = r.u16(4, 'The fvar table');
	const axisCount = r.u16(8, 'The fvar table');
	const axisSize = r.u16(10, 'The fvar table');
	if (axisCount === 0 || axisSize < 20) return undefined;
	const out: Record<string, FontAxis> = {};
	for (let i = 0; i < Math.min(axisCount, FONT_LIMITS.maxAxes); i++) {
		const at = axesOffset + i * axisSize;
		if (at + 20 > r.length) break;
		const t = tagName(r.u32(at)).replace(/[^\x21-\x7e]/g, '');
		const min = r.fixed(at + 4);
		const def = r.fixed(at + 8);
		const max = r.fixed(at + 12);
		if (!t || !(min <= def && def <= max)) continue;
		out[t] = { min, max, default: def };
	}
	return Object.keys(out).length ? out : undefined;
}

/** Reads one face from its tables (`format` = how the face's own file is stored). */
function faceFromTables(tables: Tables, cff: boolean): ParsedFace {
	const name = tables.get(tag('name'));
	const head = tables.get(tag('head'));
	if (!name) throw invalid('The font has no name table');
	if (!head || head.length < 54) throw invalid('The font has no valid head table');
	const hr = new Reader(head);
	if (hr.u32(12) !== 0x5f0f3cf5) throw invalid('The head table is damaged (bad magic number)');
	const upem = hr.u16(18);
	if (upem < 16 || upem > 16384) throw invalid(`Bad unitsPerEm ${upem}`);
	if (!tables.has(tag('cmap'))) throw invalid('The font has no character map (cmap table)');
	const outlines = cff
		? tables.has(tag('CFF ')) || tables.has(tag('CFF2'))
		: tables.has(tag('glyf')) && tables.has(tag('loca'));
	const bitmaps = ['CBDT', 'sbix', 'SVG ', 'EBDT'].some((t) => tables.has(tag(t)));
	if (!outlines && !bitmaps) throw invalid('The font has no glyph outlines');
	const names = readNames(name);
	const family = names.get(16) ?? names.get(1) ?? '';
	if (!family) throw invalid('The font has no family name');
	const subfamily = names.get(17) ?? names.get(2) ?? 'Regular';
	const macStyle = hr.u16(44);
	let weight = macStyle & 1 ? 700 : 400;
	let italic = (macStyle & 2) !== 0;
	const os2 = tables.get(tag('OS/2'));
	if (os2 && os2.length >= 64) {
		const or = new Reader(os2);
		const wc = or.u16(4);
		// Some older fonts use the 1…9 scale.
		if (wc >= 1 && wc <= 9) weight = wc * 100;
		else if (wc >= 1 && wc <= 1000) weight = wc;
		const fsSelection = or.u16(62);
		italic = (fsSelection & 0x1) !== 0 || (fsSelection & 0x200) !== 0;
	}
	const fullName = names.get(4) ?? `${family} ${subfamily}`.trim();
	const ps = postscriptSafe(names.get(6) ?? '') || postscriptSafe(`${family}-${subfamily}`);
	const fvar = tables.get(tag('fvar'));
	const axes = fvar ? readAxes(fvar) : undefined;
	const legacy = names.get(1);
	return {
		family,
		...(legacy && legacy !== family ? { legacyFamily: legacy } : {}),
		subfamily,
		fullName: clean(fullName),
		postscriptName: ps,
		weight,
		italic,
		...(axes ? { axes } : {}),
	};
}

function sfntTables(r: Reader, dir: TableRecord[], want: readonly string[]): Tables {
	const out: Tables = new Map();
	for (const t of want) {
		const rec = dir.find((d) => d.tag >>> 0 === tag(t) >>> 0);
		if (rec) out.set(tag(t), r.slice(rec.offset, rec.length, `Table ${t}`));
	}
	// presence-only tables (glyph data) are mapped to empty views
	for (const rec of dir) if (!out.has(rec.tag | 0)) out.set(rec.tag | 0, new Uint8Array(0));
	return out;
}

const READ_TABLES = ['name', 'head', 'OS/2', 'fvar', 'cmap'] as const;

function parseSfnt(bytes: Uint8Array, base = 0): ParsedFace & { cff: boolean; dir: TableRecord[] } {
	const r = new Reader(bytes);
	const { flavor, tables } = tableDirectory(r, base);
	const cff = flavor === TAG_OTTO;
	return { ...faceFromTables(sfntTables(r, tables, READ_TABLES), cff), cff, dir: tables };
}

/** A standalone sfnt holding the tables of one collection face (table data copied, 4-byte aligned). */
function extractFace(r: Reader, flavor: number, dir: TableRecord[]): Uint8Array {
	const sorted = [...dir].sort((a, b) => (a.tag >>> 0) - (b.tag >>> 0));
	const headerLen = 12 + 16 * sorted.length;
	let total = headerLen;
	for (const t of sorted) total += (t.length + 3) & ~3;
	if (total > FONT_LIMITS.maxFileBytes)
		throw new FontParseError('FONT_TOO_LARGE', 'A collection face is too large');
	const out = new Uint8Array(total);
	const v = new DataView(out.buffer);
	const n = sorted.length;
	const entrySelector = Math.floor(Math.log2(n));
	const searchRange = 2 ** entrySelector * 16;
	v.setUint32(0, flavor);
	v.setUint16(4, n);
	v.setUint16(6, searchRange);
	v.setUint16(8, entrySelector);
	v.setUint16(10, n * 16 - searchRange);
	let off = headerLen;
	sorted.forEach((t, i) => {
		v.setUint32(12 + i * 16, t.tag >>> 0);
		v.setUint32(16 + i * 16, t.checksum >>> 0);
		v.setUint32(20 + i * 16, off);
		v.setUint32(24 + i * 16, t.length);
		out.set(r.slice(t.offset, t.length, `Table ${tagName(t.tag)}`), off);
		off += (t.length + 3) & ~3;
	});
	return out;
}

function parseCollection(bytes: Uint8Array): ParsedFont {
	const r = new Reader(bytes);
	const major = r.u16(4, 'The collection header');
	if (major !== 1 && major !== 2) throw invalid(`Unknown font collection version ${major}`);
	const numFonts = r.u32(8, 'The collection header');
	if (numFonts === 0) throw invalid('The collection holds no fonts');
	if (numFonts > FONT_LIMITS.maxFaces)
		throw new FontParseError(
			'FONT_TOO_LARGE',
			`The collection holds ${numFonts} fonts (at most ${FONT_LIMITS.maxFaces})`,
		);
	const faces: ParsedFaceFile[] = [];
	for (let i = 0; i < numFonts; i++) {
		const base = r.u32(12 + i * 4, 'The collection header');
		const p = parseSfnt(bytes, base);
		const { cff, dir, ...face } = p;
		const flavor = r.u32(base);
		faces.push({ ...face, format: cff ? 'otf' : 'ttf', bytes: extractFace(r, flavor, dir) });
	}
	return { container: 'ttc', faces };
}

function inflateTable(data: Uint8Array, origLength: number): Uint8Array {
	try {
		const out = inflateSync(data, { maxOutputLength: Math.max(1, origLength) });
		if (out.length !== origLength) throw invalid('A WOFF table does not decompress to its declared size');
		return out;
	} catch (e) {
		if (e instanceof FontParseError) throw e;
		throw invalid('A WOFF table is not valid zlib data');
	}
}

function parseWoff(bytes: Uint8Array): ParsedFont {
	const r = new Reader(bytes);
	const flavor = r.u32(4, 'The WOFF header');
	if (flavor === TAG_TTCF)
		throw new FontParseError('FONT_UNSUPPORTED', 'WOFF font collections are not supported');
	if (flavor !== SFNT_TRUETYPE && flavor !== TAG_OTTO && flavor !== TAG_TRUE)
		throw invalid('Unknown WOFF flavor');
	if (r.u32(8, 'The WOFF header') !== r.length)
		throw invalid('The WOFF length field does not match the file');
	const numTables = r.u16(12, 'The WOFF header');
	if (numTables === 0 || numTables > FONT_LIMITS.maxTables) throw invalid(`Bad table count ${numTables}`);
	const tables: Tables = new Map();
	let budget = FONT_LIMITS.maxDecompressedBytes;
	for (let i = 0; i < numTables; i++) {
		const at = 44 + i * 20;
		const t = r.u32(at, 'The WOFF table directory') | 0;
		const offset = r.u32(at + 4, 'The WOFF table directory');
		const compLength = r.u32(at + 8, 'The WOFF table directory');
		const origLength = r.u32(at + 12, 'The WOFF table directory');
		if (compLength > origLength) throw invalid(`WOFF table ${tagName(t)} is larger compressed than plain`);
		const data = r.slice(offset, compLength, `WOFF table ${tagName(t)}`);
		if (!READ_TABLES.some((x) => tag(x) === t)) {
			tables.set(t, new Uint8Array(0));
			continue;
		}
		budget -= origLength;
		if (budget < 0) throw new FontParseError('FONT_TOO_LARGE', 'The WOFF tables are too large');
		tables.set(t, compLength === origLength ? data : inflateTable(data, origLength));
	}
	return {
		container: 'woff',
		faces: [{ ...faceFromTables(tables, flavor === TAG_OTTO), format: 'woff', bytes }],
	};
}

// WOFF 2.0 §5.1 known table tags (flags & 63 = index; 63 = an explicit tag follows).
const WOFF2_TAGS = [
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
	'prep',
	'CFF ',
	'VORG',
	'EBDT',
	'EBLC',
	'gasp',
	'hdmx',
	'kern',
	'LTSH',
	'PCLT',
	'VDMX',
	'vhea',
	'vmtx',
	'BASE',
	'GDEF',
	'GPOS',
	'GSUB',
	'EBSC',
	'JSTF',
	'MATH',
	'CBDT',
	'CBLC',
	'COLR',
	'CPAL',
	'SVG ',
	'sbix',
	'acnt',
	'avar',
	'bdat',
	'bloc',
	'bsln',
	'cvar',
	'fdsc',
	'feat',
	'fmtx',
	'fvar',
	'gvar',
	'hsty',
	'just',
	'lcar',
	'mort',
	'morx',
	'opbd',
	'prop',
	'trak',
	'Zapf',
	'Silf',
	'Glat',
	'Gloc',
	'Feat',
	'Sill',
] as const;

/** UIntBase128 (WOFF 2.0 §4.1): at most 5 bytes, no leading zeros, fits in 32 bits. */
function base128(r: Reader, off: number): { value: number; next: number } {
	let value = 0;
	for (let i = 0; i < 5; i++) {
		const b = r.u8(off + i, 'The WOFF2 table directory');
		if (i === 0 && b === 0x80) throw invalid('Bad UIntBase128 (leading zero)');
		if (value & 0xfe000000) throw invalid('Bad UIntBase128 (overflow)');
		value = ((value << 7) | (b & 0x7f)) >>> 0;
		if ((b & 0x80) === 0) return { value, next: off + i + 1 };
	}
	throw invalid('Bad UIntBase128 (too long)');
}

function parseWoff2(bytes: Uint8Array): ParsedFont {
	const r = new Reader(bytes);
	const flavor = r.u32(4, 'The WOFF2 header');
	if (flavor === TAG_TTCF)
		throw new FontParseError('FONT_UNSUPPORTED', 'WOFF2 font collections are not supported');
	if (flavor !== SFNT_TRUETYPE && flavor !== TAG_OTTO && flavor !== TAG_TRUE)
		throw invalid('Unknown WOFF2 flavor');
	if (r.u32(8, 'The WOFF2 header') !== r.length)
		throw invalid('The WOFF2 length field does not match the file');
	const numTables = r.u16(12, 'The WOFF2 header');
	if (numTables === 0 || numTables > FONT_LIMITS.maxTables) throw invalid(`Bad table count ${numTables}`);
	const totalCompressed = r.u32(20, 'The WOFF2 header');
	let off = 48;
	const entries: { tag: number; length: number }[] = [];
	let total = 0;
	for (let i = 0; i < numTables; i++) {
		const flags = r.u8(off++, 'The WOFF2 table directory');
		let t: number;
		if ((flags & 63) === 63) {
			t = r.u32(off, 'The WOFF2 table directory') | 0;
			off += 4;
		} else t = tag(WOFF2_TAGS[flags & 63]!);
		const orig = base128(r, off);
		off = orig.next;
		const version = (flags >> 6) & 3;
		const isGlyfLoca = t === tag('glyf') || t === tag('loca');
		let length = orig.value;
		if (isGlyfLoca ? version === 0 : version !== 0) {
			const tl = base128(r, off);
			off = tl.next;
			length = tl.value;
		}
		total += length;
		if (total > FONT_LIMITS.maxDecompressedBytes)
			throw new FontParseError('FONT_TOO_LARGE', 'The WOFF2 tables are too large');
		entries.push({ tag: t, length });
	}
	const compressed = r.slice(off, totalCompressed, 'The WOFF2 compressed stream');
	let stream: Uint8Array;
	try {
		stream = brotliDecompressSync(compressed, { maxOutputLength: Math.max(1, total) });
	} catch {
		throw invalid('The WOFF2 stream is not valid brotli data, or larger than its table directory declares');
	}
	if (stream.length !== total) throw invalid('The WOFF2 stream does not match its table directory');
	const tables: Tables = new Map();
	let at = 0;
	for (const e of entries) {
		const keep = READ_TABLES.some((x) => tag(x) === e.tag);
		tables.set(e.tag, keep ? stream.subarray(at, at + e.length) : new Uint8Array(0));
		at += e.length;
	}
	return {
		container: 'woff2',
		faces: [{ ...faceFromTables(tables, flavor === TAG_OTTO), format: 'woff2', bytes }],
	};
}

/** The container format from the first four bytes, or null. */
export function sniffFontContainer(bytes: Uint8Array): FontContainer | null {
	if (bytes.length < 4) return null;
	const sig = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
	if (sig === SFNT_TRUETYPE || sig === TAG_TRUE) return 'ttf';
	if (sig === TAG_OTTO) return 'otf';
	if (sig === TAG_TTCF) return 'ttc';
	if (sig === TAG_WOFF) return 'woff';
	if (sig === TAG_WOF2) return 'woff2';
	return null;
}

/**
 * Validates font bytes and reads every face. Throws `FontParseError` (and nothing else) on malformed, unsupported or
 * oversized input.
 */
export function parseFont(bytes: Uint8Array): ParsedFont {
	if (bytes.length > FONT_LIMITS.maxFileBytes)
		throw new FontParseError(
			'FONT_TOO_LARGE',
			`The font file is ${bytes.length} bytes (at most ${FONT_LIMITS.maxFileBytes})`,
		);
	const container = sniffFontContainer(bytes);
	try {
		switch (container) {
			case 'ttf':
			case 'otf': {
				const { cff, dir: _dir, ...face } = parseSfnt(bytes);
				return { container, faces: [{ ...face, format: cff ? 'otf' : 'ttf', bytes }] };
			}
			case 'ttc':
				return parseCollection(bytes);
			case 'woff':
				return parseWoff(bytes);
			case 'woff2':
				return parseWoff2(bytes);
			default:
				if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) === TAG_TYP1)
					throw new FontParseError('FONT_UNSUPPORTED', 'PostScript Type 1 fonts are not supported');
				throw invalid('Not a font file (TrueType, OpenType, TTC, WOFF or WOFF2)');
		}
	} catch (e) {
		if (e instanceof FontParseError) throw e;
		// RangeError & co. from a corner the checks above missed: still a refusal, never a crash.
		throw invalid(`The font file is damaged (${(e as Error)?.message ?? 'unreadable'})`);
	}
}
