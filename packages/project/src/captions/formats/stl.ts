// EBU STL (`.stl`): the EBU subtitling data exchange format, EBU Tech 3264-E (1991). Ported from FilmCraft
// `crates/captions/src/stl.rs`; see licenses/ported/captions.md.
//
// A 1024-byte General Subtitle Information (GSI) block of ASCII fields followed by 128-byte Text and Timing
// Information (TTI) blocks: subtitle number, extension block number (`0xFF` = last block of the subtitle),
// in / out timecodes (binary h, m, s, f), vertical position, justification, comment flag and a 112-byte text
// field (`0x8A` = new line, `0x8F` = unused; `0x80`/`0x81` italics on/off, `0x82`/`0x83` underline on/off;
// `0x00`–`0x1F` teletext control codes skipped on read).
// - `STL25.01` is 25 fps; `STL30.01` is read and written as 29.97 fps with non-drop labels. Timecodes are made
//   relative to the start-of-programme timecode (TCP).
// - Text: character code table `00` (Latin, ISO/IEC 6937): ASCII, the 0xA0–0xFF specials and accented letters as
//   a non-spacing diacritic (0xC1–0xCF) followed by the base letter. Unrepresentable characters are written `?`.
// - Long subtitles continue in extension blocks; user-data (`EBN 0xFE`) and comment blocks are skipped.
import type { Rational } from '../../time.ts';
import { type CaptionDocument, CaptionFormatError, emptyCaptionDocument } from './core.ts';
import {
	fieldsToFrameCount,
	frameAt,
	framesToFields,
	RATE_25,
	RATE_29_97,
	RATE_30,
	rateEquals,
	snapNearest,
	tickOf,
} from './rate.ts';

const GSI = 1024;
const TTI = 128;
const TF = 112;

function ascii(b: Uint8Array, from: number, to: number): string {
	let s = '';
	for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]!);
	return s;
}

function rateOf(dfc: string): Rational | null {
	if (dfc === 'STL25.01') return RATE_25;
	if (dfc === 'STL30.01') return RATE_29_97;
	return null;
}

/** Whether bytes look like an EBU STL file. */
export function sniffStl(bytes: Uint8Array): boolean {
	return bytes.length >= GSI && rateOf(ascii(bytes, 3, 11)) !== null;
}

// ------------------------------------------------------------------------------------------- ISO/IEC 6937

const SPECIALS: Array<[number, string]> = [
	[0xa0, ' '],
	[0xa1, '¡'],
	[0xa2, '¢'],
	[0xa3, '£'],
	[0xa4, '$'],
	[0xa5, '¥'],
	[0xa6, '#'],
	[0xa7, '§'],
	[0xa8, '¤'],
	[0xa9, '‘'],
	[0xaa, '“'],
	[0xab, '«'],
	[0xac, '←'],
	[0xad, '↑'],
	[0xae, '→'],
	[0xaf, '↓'],
	[0xb0, '°'],
	[0xb1, '±'],
	[0xb2, '²'],
	[0xb3, '³'],
	[0xb4, '×'],
	[0xb5, 'µ'],
	[0xb6, '¶'],
	[0xb7, '·'],
	[0xb8, '÷'],
	[0xb9, '’'],
	[0xba, '”'],
	[0xbb, '»'],
	[0xbc, '¼'],
	[0xbd, '½'],
	[0xbe, '¾'],
	[0xbf, '¿'],
	[0xd0, '―'],
	[0xd1, '¹'],
	[0xd2, '®'],
	[0xd3, '©'],
	[0xd4, '™'],
	[0xd5, '♪'],
	[0xd6, '¬'],
	[0xd7, '¦'],
	[0xdc, '⅛'],
	[0xdd, '⅜'],
	[0xde, '⅝'],
	[0xdf, '⅞'],
	[0xe0, 'Ω'],
	[0xe1, 'Æ'],
	[0xe2, 'Đ'],
	[0xe3, 'ª'],
	[0xe4, 'Ħ'],
	[0xe6, 'Ĳ'],
	[0xe7, 'Ŀ'],
	[0xe8, 'Ł'],
	[0xe9, 'Ø'],
	[0xea, 'Œ'],
	[0xeb, 'º'],
	[0xec, 'Þ'],
	[0xed, 'Ŧ'],
	[0xee, 'Ŋ'],
	[0xef, 'ŉ'],
	[0xf0, 'ĸ'],
	[0xf1, 'æ'],
	[0xf2, 'đ'],
	[0xf3, 'ð'],
	[0xf4, 'ħ'],
	[0xf5, 'ı'],
	[0xf6, 'ĳ'],
	[0xf7, 'ŀ'],
	[0xf8, 'ł'],
	[0xf9, 'ø'],
	[0xfa, 'œ'],
	[0xfb, 'ß'],
	[0xfc, 'þ'],
	[0xfd, 'ŧ'],
	[0xfe, 'ŋ'],
];

/** Non-spacing diacritics 0xC1–0xCF: (code, base letters, composed letters). */
const DIACRITICS: Array<[number, string, string]> = [
	[0xc1, 'AEIOUaeiou', 'ÀÈÌÒÙàèìòù'],
	[0xc2, 'ACEILNORSUYZacegilnorsuyz', 'ÁĆÉÍĹŃÓŔŚÚÝŹáćéģíĺńóŕśúýź'],
	[0xc3, 'ACEGHIJOSUWYaceghijosuwy', 'ÂĈÊĜĤÎĴÔŜÛŴŶâĉêĝĥîĵôŝûŵŷ'],
	[0xc4, 'AINOUainou', 'ÃĨÑÕŨãĩñõũ'],
	[0xc5, 'AEIOUaeiou', 'ĀĒĪŌŪāēīōū'],
	[0xc6, 'AGUagu', 'ĂĞŬăğŭ'],
	[0xc7, 'CEGIZcegz', 'ĊĖĠİŻċėġż'],
	[0xc8, 'AEIOUYaeiouy', 'ÄËÏÖÜŸäëïöüÿ'],
	[0xca, 'AUau', 'ÅŮåů'],
	[0xcb, 'CGKLNRSTcklnrst', 'ÇĢĶĻŅŖŞŢçķļņŗşţ'],
	[0xcd, 'OUou', 'ŐŰőű'],
	[0xce, 'AEIUaeiu', 'ĄĘĮŲąęįų'],
	[0xcf, 'CDELNRSTZcdelnrstz', 'ČĎĚĽŇŘŠŤŽčďěľňřšťž'],
];

function compose(d: number, base: number): string | null {
	const row = DIACRITICS.find((x) => x[0] === d);
	if (!row) return null;
	const i = row[1].indexOf(String.fromCharCode(base));
	if (i < 0) return null;
	return [...row[2]][i] ?? null;
}

/** ISO 6937 bytes for a character (null = not representable). */
export function encode6937(c: string): number[] | null {
	const cp = c.codePointAt(0)!;
	if (cp >= 0x20 && cp <= 0x7e && c.length === 1) return [cp];
	const sp = SPECIALS.find((x) => x[1] === c && x[0] !== 0xa4 && x[0] !== 0xa6);
	if (sp) return [sp[0]];
	for (const [d, bases, comp] of DIACRITICS) {
		const i = [...comp].indexOf(c);
		if (i >= 0) return [d, bases.charCodeAt(i)];
	}
	return null;
}

type TfState = { out: string; italic: boolean; underline: boolean };

/** Decode a text field into caption text with `<i>` / `<u>` tags. */
function decodeTf(tf: ArrayLike<number>, st: TfState): void {
	let i = 0;
	while (i < tf.length) {
		const b = tf[i]!;
		i++;
		if (b === 0x8f) continue;
		if (b === 0x8a) {
			// a line break; repeated 0x8A (double-height rows) count once
			if (!st.out.endsWith('\n') || st.out.length === 0) st.out += '\n';
		} else if (b === 0x80) {
			if (!st.italic) {
				st.out += '<i>';
				st.italic = true;
			}
		} else if (b === 0x81) {
			if (st.italic) {
				st.out += '</i>';
				st.italic = false;
			}
		} else if (b === 0x82) {
			if (!st.underline) {
				st.out += '<u>';
				st.underline = true;
			}
		} else if (b === 0x83) {
			if (st.underline) {
				st.out += '</u>';
				st.underline = false;
			}
		} else if (b <= 0x1f || (b >= 0x7f && b <= 0x9f)) {
			/* control codes */
		} else if (b >= 0x20 && b <= 0x7e) st.out += String.fromCharCode(b);
		else if (b >= 0xc1 && b <= 0xcf) {
			const base = tf[i];
			if (base !== undefined) {
				const c = compose(b, base);
				if (c !== null) {
					st.out += c;
					i++;
				}
			}
		} else {
			const sp = SPECIALS.find((x) => x[0] === b);
			if (sp) st.out += sp[1];
		}
	}
}

/** Caption text → text-field bytes (`<i>`, `<u>` become control codes; other tags dropped). */
function encodeText(text: string): number[] {
	const out: number[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = String.fromCodePoint(text.codePointAt(i)!);
		if (ch === '<') {
			const end = text.indexOf('>', i);
			if (end >= 0) {
				const tag = text
					.slice(i + 1, end)
					.trim()
					.toLowerCase();
				if (tag === 'i') out.push(0x80);
				else if (tag === '/i') out.push(0x81);
				else if (tag === 'u') out.push(0x82);
				else if (tag === '/u') out.push(0x83);
				i = end + 1;
				continue;
			}
		}
		if (ch === '\n') out.push(0x8a);
		else out.push(...(encode6937(ch) ?? [0x3f]));
		i += ch.length;
	}
	return out;
}

// ------------------------------------------------------------------------------------------- reader

export function parseStl(bytes: Uint8Array): CaptionDocument {
	if (!sniffStl(bytes)) throw new CaptionFormatError('not an EBU STL file');
	const rate = rateOf(ascii(bytes, 3, 11))!;
	// start of programme (HHMMSSFF, ASCII)
	const tcp = ascii(bytes, 256, 264).trim();
	const start = /^[0-9]{8}$/.test(tcp)
		? fieldsToFrameCount(
				Number(tcp.slice(0, 2)),
				Number(tcp.slice(2, 4)),
				Number(tcp.slice(4, 6)),
				Number(tcp.slice(6, 8)),
				rate,
				false,
			)
		: 0;
	const doc = emptyCaptionDocument();
	type Cur = { sn: number; tin: number; tout: number; st: TfState };
	let cur: Cur | null = null;
	const finish = (c: Cur | null) => {
		if (!c) return;
		let text = c.st.out;
		if (c.st.italic) text += '</i>';
		if (c.st.underline) text += '</u>';
		text = text
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.join('\n');
		if (c.tout > c.tin && text)
			doc.cues.push({
				start: tickOf(Math.max(0, c.tin - start), rate),
				end: tickOf(Math.max(0, c.tout - start), rate),
				text,
			});
	};
	const tc = (o: number) =>
		fieldsToFrameCount(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!, rate, false);
	for (let o = GSI; o + TTI <= bytes.length; o += TTI) {
		const sn = bytes[o + 1]! | (bytes[o + 2]! << 8);
		const ebn = bytes[o + 3]!;
		const cf = bytes[o + 15]!;
		if (ebn === 0xfe || cf !== 0) continue; // user data / comment
		const tin = tc(o + 5);
		const tout = tc(o + 9);
		if (!cur || cur.sn !== sn) {
			finish(cur);
			cur = { sn, tin, tout, st: { out: '', italic: false, underline: false } };
		}
		decodeTf(bytes.subarray(o + 16, o + 16 + TF), cur.st);
		if (ebn === 0xff) {
			finish(cur);
			cur = null;
		}
	}
	finish(cur);
	if (bytes.length > GSI && (bytes.length - GSI) % TTI !== 0)
		doc.warnings.push('trailing bytes after the last TTI block');
	return doc;
}

// ------------------------------------------------------------------------------------------- writer

function put(buf: Uint8Array, at: number, len: number, s: string): void {
	for (let i = 0; i < len; i++) buf[at + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0x20;
}

/** Split text-field bytes into ≤ 112-byte chunks without splitting a diacritic from its letter. */
function splitTf(text: number[]): number[][] {
	const out: number[][] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + TF, text.length);
		if (end < text.length && text[end - 1]! >= 0xc1 && text[end - 1]! <= 0xcf) end--;
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

/** STL rate for a sequence rate: 29.97 / 30 → `STL30.01` (29.97), everything else → `STL25.01`. */
export function stlRateFor(rate: Rational | null | undefined): Rational {
	return rate && (rateEquals(rate, RATE_29_97) || rateEquals(rate, RATE_30)) ? RATE_29_97 : RATE_25;
}

/** Write `doc` (25 fps → `STL25.01`; 29.97 / 30 → `STL30.01`; others are written at 25). */
export function writeStl(doc: CaptionDocument, seqRate?: Rational | null): Uint8Array {
	const rate = stlRateFor(seqRate);
	const dfc = rateEquals(rate, RATE_29_97) ? 'STL30.01' : 'STL25.01';
	const ttis: Uint8Array[] = [];
	let nSubs = 0;
	let firstIn: number | null = null;
	for (const c of doc.cues) {
		if (!(c.end > c.start)) continue;
		const sn = nSubs & 0xffff;
		nSubs = (nSubs + 1) & 0xffff;
		const tin = frameAt(snapNearest(c.start, rate), rate);
		const tout = Math.max(frameAt(snapNearest(c.end, rate), rate), tin + 1);
		if (firstIn === null) firstIn = tin;
		const text = encodeText(c.text);
		const chunks = text.length === 0 ? [[]] : splitTf(text);
		const lines = Math.min(11, Math.max(1, c.text.split('\n').length));
		chunks.forEach((chunk, k) => {
			const b = new Uint8Array(TTI);
			b[0] = 0;
			b[1] = sn & 0xff;
			b[2] = sn >> 8;
			b[3] = k + 1 === chunks.length ? 0xff : Math.min(k, 0xfd);
			b[4] = 0;
			for (const [at, f] of [
				[5, tin],
				[9, tout],
			] as const) {
				const [h, m, s, fr] = framesToFields(f, rate, false);
				b.set([Math.min(255, h), m, s, fr], at);
			}
			b[13] = 22 - 2 * (lines - 1);
			b[14] = 2; // centred
			b[15] = 0;
			b.fill(0x8f, 16);
			b.set(chunk, 16);
			ttis.push(b);
		});
	}
	const gsi = new Uint8Array(GSI).fill(0x20);
	put(gsi, 0, 3, '850');
	put(gsi, 3, 8, dfc);
	put(gsi, 11, 1, '0');
	put(gsi, 12, 2, '00');
	put(gsi, 14, 2, '09');
	put(gsi, 16, 32, 'JasperEditor');
	put(gsi, 224, 6, '000101');
	put(gsi, 230, 6, '000101');
	put(gsi, 236, 2, '00');
	put(gsi, 238, 5, String(Math.min(ttis.length, 99_999)).padStart(5, '0'));
	put(gsi, 243, 5, String(nSubs).padStart(5, '0'));
	put(gsi, 248, 3, '001');
	put(gsi, 251, 2, '40');
	put(gsi, 253, 2, '23');
	put(gsi, 255, 1, '1');
	put(gsi, 256, 8, '00000000');
	const [h, m, s, f] = framesToFields(firstIn ?? 0, rate, false);
	const p2 = (n: number) => String(n).padStart(2, '0');
	put(gsi, 264, 8, `${p2(h)}${p2(m)}${p2(s)}${p2(f)}`);
	put(gsi, 272, 1, '1');
	put(gsi, 273, 1, '1');
	const out = new Uint8Array(GSI + ttis.length * TTI);
	out.set(gsi, 0);
	ttis.forEach((t, i) => out.set(t, GSI + i * TTI));
	return out;
}
