// Caption file model shared by every reader/writer: cues in exact flicks, text decoding, clock times.
// Ported from FilmCraft `crates/captions/src/lib.rs` and `crates/project/src/caption.rs` (`plain_text`);
// see licenses/ported/captions.md.
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import { frameDuration, snapNearest } from './rate.ts';

/** One caption cue. Times are flicks (content time of the file: 0 = the file's start). */
export type Cue = {
	start: number;
	end: number;
	/** Text as written: lines separated by `\n`, inline tags (`<i>`, `<b>`, `<u>`) kept. */
	text: string;
	/** WebVTT voice (`<v Name>`), TTML `ttm:agent`. */
	speaker?: string | null;
	/** WebVTT cue identifier / TTML `xml:id`. */
	id?: string | null;
	/** WebVTT cue settings, verbatim (`line:90% align:start`). */
	settings?: string;
};

/** A parsed caption file. */
export type CaptionDocument = {
	cues: Cue[];
	/** WebVTT STYLE / REGION / NOTE blocks, verbatim. */
	blocks: string[];
	/** Non-fatal problems found while reading (skipped cues, bad lines…). */
	warnings: string[];
};

export class CaptionFormatError extends Error {
	constructor(
		message: string,
		readonly line?: number,
	) {
		super(line !== undefined ? `line ${line}: ${message}` : message);
		this.name = 'CaptionFormatError';
	}
}

export const FLICKS_PER_MS = FLICKS_PER_SECOND / 1000;

export function emptyCaptionDocument(): CaptionDocument {
	return { cues: [], blocks: [], warnings: [] };
}

/** Sort by start, drop empty cues and cut overlaps (a cue is cut where the next one starts). */
export function normalizeCaptionDocument(doc: CaptionDocument): CaptionDocument {
	const cues = doc.cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Cue[] = [];
	for (const raw of cues) {
		const c = { ...raw };
		const prev = out[out.length - 1];
		if (prev && c.start < prev.end) {
			if (c.start > prev.start) prev.end = c.start;
			else {
				// same start: keep the first, shift this one after it
				c.start = prev.end;
				if (c.end <= c.start) {
					doc.warnings.push(`dropped overlapping cue "${c.text.split('\n')[0] ?? ''}"`);
					continue;
				}
			}
		}
		out.push(c);
	}
	doc.cues = out;
	return doc;
}

/**
 * Snap cue times to frame boundaries of `rate` (nearest), keeping every cue at least one frame long, then
 * remove overlaps.
 */
export function snapCaptionDocument(doc: CaptionDocument, rate: Rational): CaptionDocument {
	const fd = frameDuration(rate);
	for (const c of doc.cues) {
		c.start = snapNearest(c.start, rate);
		c.end = Math.max(snapNearest(c.end, rate), c.start + fd);
	}
	return normalizeCaptionDocument(doc);
}

const CP1252_HI = [
	'€',
	'\u0081',
	'‚',
	'ƒ',
	'„',
	'…',
	'†',
	'‡',
	'ˆ',
	'‰',
	'Š',
	'‹',
	'Œ',
	'\u008d',
	'Ž',
	'\u008f',
	'\u0090',
	'‘',
	'’',
	'“',
	'”',
	'•',
	'–',
	'—',
	'˜',
	'™',
	'š',
	'›',
	'œ',
	'\u009d',
	'ž',
	'Ÿ',
];

function cp1252(b: number): string {
	return b >= 0x80 && b < 0xa0 ? CP1252_HI[b - 0x80]! : String.fromCharCode(b);
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
function utf8Strict(b: Uint8Array): string | null {
	let out = '';
	let i = 0;
	const parts: string[] = [];
	while (i < b.length) {
		const c = b[i]!;
		let cp: number;
		let n: number;
		if (c < 0x80) {
			cp = c;
			n = 0;
		} else if (c >= 0xc2 && c < 0xe0) {
			cp = c & 0x1f;
			n = 1;
		} else if (c >= 0xe0 && c < 0xf0) {
			cp = c & 0x0f;
			n = 2;
		} else if (c >= 0xf0 && c < 0xf5) {
			cp = c & 0x07;
			n = 3;
		} else return null;
		for (let k = 1; k <= n; k++) {
			const x = b[i + k];
			if (x === undefined || (x & 0xc0) !== 0x80) return null;
			cp = (cp << 6) | (x & 0x3f);
		}
		if (
			(n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) ||
			(n === 3 && (cp < 0x10000 || cp > 0x10ffff))
		)
			return null;
		out += String.fromCodePoint(cp);
		if (out.length > 8192) {
			parts.push(out);
			out = '';
		}
		i += n + 1;
	}
	parts.push(out);
	return parts.join('');
}

/** Lossy UTF-8 decode (invalid sequences become U+FFFD). */
function utf8Lossy(b: Uint8Array): string {
	const strict = utf8Strict(b);
	if (strict !== null) return strict;
	const parts: string[] = [];
	let i = 0;
	while (i < b.length) {
		const c = b[i]!;
		const n =
			c < 0x80 ? 0 : c >= 0xc2 && c < 0xe0 ? 1 : c >= 0xe0 && c < 0xf0 ? 2 : c >= 0xf0 && c < 0xf5 ? 3 : -1;
		if (n < 0) {
			parts.push('�');
			i++;
			continue;
		}
		const seq = utf8Strict(b.subarray(i, i + n + 1));
		if (seq === null || seq.length === 0) {
			parts.push('�');
			i++;
		} else {
			parts.push(seq);
			i += n + 1;
		}
	}
	return parts.join('');
}

function utf16(b: Uint8Array, le: boolean): string {
	const parts: string[] = [];
	let chunk: number[] = [];
	for (let i = 0; i + 1 < b.length; i += 2) {
		chunk.push(le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
		if (chunk.length >= 4096) {
			parts.push(String.fromCharCode(...chunk));
			chunk = [];
		}
	}
	parts.push(String.fromCharCode(...chunk));
	// lone surrogates → U+FFFD (lossy, like String::from_utf16_lossy)
	return parts
		.join('')
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}

/**
 * Decode text bytes: UTF-8 (BOM stripped), UTF-16 with BOM, else Windows-1252. Line endings are normalised to
 * `\n`.
 */
export function decodeCaptionText(bytes: Uint8Array | string): string {
	let s: string;
	if (typeof bytes === 'string') s = bytes;
	else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
		s = utf8Lossy(bytes.subarray(3));
	else if (
		bytes.length >= 2 &&
		((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
	)
		s = utf16(bytes.subarray(2), bytes[0] === 0xff);
	else {
		const strict = utf8Strict(bytes);
		if (strict !== null) s = strict;
		else {
			const parts: string[] = [];
			for (const b of bytes) parts.push(cp1252(b));
			s = parts.join('');
		}
	}
	if (s.startsWith('﻿')) s = s.slice(1);
	return s.includes('\r') ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s;
}

/** UTF-8 encode a string (no BOM). */
export function encodeUtf8(s: string): Uint8Array {
	const out: number[] = [];
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) out.push(cp);
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		else
			out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
	}
	return Uint8Array.from(out);
}

const isDigits = (p: string, max: number) => p.length > 0 && p.length <= max && /^[0-9]+$/.test(p);

/** Parse `[H…:]MM:SS[.,]fff` (the fraction may have 1–9 digits) into flicks; null when malformed. */
export function parseClock(input: string): number | null {
	const s = input.trim();
	const i = s.search(/[,.]/);
	const hms = i >= 0 ? s.slice(0, i) : s;
	const frac = i >= 0 ? s.slice(i + 1) : '';
	const parts = hms.split(':');
	let h = 0;
	let m: number;
	let sec: number;
	if (parts.length === 3) {
		if (!isDigits(parts[0]!, 9) || !isDigits(parts[1]!, 9) || !isDigits(parts[2]!, 9)) return null;
		h = Number(parts[0]);
		m = Number(parts[1]);
		sec = Number(parts[2]);
	} else if (parts.length === 2) {
		if (!isDigits(parts[0]!, 9) || !isDigits(parts[1]!, 9)) return null;
		m = Number(parts[0]);
		sec = Number(parts[1]);
	} else return null;
	if (m >= 60 || sec >= 60 || h > 9999) return null;
	let t = ((h * 60 + m) * 60 + sec) * FLICKS_PER_SECOND;
	if (frac.length > 0) {
		if (frac.length > 9 || !/^[0-9]+$/.test(frac)) return null;
		t += Number((BigInt(frac) * BigInt(FLICKS_PER_SECOND)) / 10n ** BigInt(frac.length));
	}
	return t;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Format flicks as `HH:MM:SS<sep>mmm` (rounded to the nearest millisecond). */
export function formatClock(t: number, sep: ',' | '.'): string {
	const ms = Math.floor((Math.max(0, t) + FLICKS_PER_MS / 2) / FLICKS_PER_MS);
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor(ms / 60_000) % 60;
	const s = Math.floor(ms / 1000) % 60;
	const f = ms % 1000;
	return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(f).padStart(3, '0')}`;
}

const ENTITIES: Array<[string, string]> = [
	['amp;', '&'],
	['lt;', '<'],
	['gt;', '>'],
	['nbsp;', ' '],
	['quot;', '"'],
	['apos;', "'"],
	['lrm;', '‎'],
	['rlm;', '‏'],
];

/**
 * Caption text without markup: tags (`<i>`, `<v Bob>`…) and SSA override blocks (`{\an8}`) removed, the common
 * HTML entities decoded. A `<` with no closing `>` is kept literally.
 */
export function plainCaptionText(s: string): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		const c = s[i]!;
		if (c === '<') {
			const end = s.indexOf('>', i + 1);
			if (end >= 0) {
				i = end + 1;
				continue;
			}
			out += '<';
		} else if (c === '{' && s[i + 1] === '\\') {
			const end = s.indexOf('}', i + 1);
			if (end >= 0) {
				i = end + 1;
				continue;
			}
			out += '{';
		} else if (c === '&') {
			const rest = s.slice(i + 1, i + 9);
			const hit = ENTITIES.find(([n]) => rest.startsWith(n));
			if (hit) {
				out += hit[1];
				i += 1 + hit[0].length;
				continue;
			}
			out += '&';
		} else if (c !== '\r') out += c;
		i++;
	}
	return out;
}
