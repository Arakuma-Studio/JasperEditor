// Caption files: SubRip, WebVTT, Scenarist SCC (CEA-608), MacCaption MCC (CEA-608/708), EBU STL, TTML (IMSC1)
// and DFXP. Readers are forgiving and total (`parseCaptionFile` never throws); writers are strict.
// Ported from FilmCraft `crates/captions` (lib.rs); see licenses/ported/captions.md.
import type { Rational } from '../../time.ts';
import {
	type CaptionDocument,
	CaptionFormatError,
	decodeCaptionText,
	encodeUtf8,
	snapCaptionDocument,
} from './core.ts';
import { parseMcc, writeMcc } from './mcc.ts';
import { parseScc, writeScc } from './scc.ts';
import { parseSrt, parseTimingLine, writeSrt } from './srt.ts';
import { parseStl, sniffStl, writeStl } from './stl.ts';
import { parseTtml, writeTtml } from './ttml.ts';
import { parseVtt, writeVtt } from './vtt.ts';

export * from './cea608.ts';
export * from './core.ts';
export * from './mcc.ts';
export * from './rate.ts';
export * from './scc.ts';
export * from './srt.ts';
export * from './stl.ts';
export * from './ttml.ts';
export * from './vtt.ts';
export * from './xml.ts';

export const CAPTION_FILE_FORMATS = ['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp'] as const;
export type CaptionFileFormat = (typeof CAPTION_FILE_FORMATS)[number];

export const CAPTION_FORMAT_INFO: Record<
	CaptionFileFormat,
	{ name: string; extension: string; binary: boolean; mime: string; trackFormat: CaptionTrackFormat }
> = {
	srt: {
		name: 'SubRip (SRT)',
		extension: 'srt',
		binary: false,
		mime: 'application/x-subrip',
		trackFormat: 'subtitle',
	},
	vtt: { name: 'WebVTT', extension: 'vtt', binary: false, mime: 'text/vtt', trackFormat: 'subtitle' },
	scc: {
		name: 'Scenarist SCC (CEA-608)',
		extension: 'scc',
		binary: false,
		mime: 'text/plain',
		trackFormat: 'cea-608',
	},
	mcc: {
		name: 'MacCaption MCC (CEA-608/708)',
		extension: 'mcc',
		binary: false,
		mime: 'text/plain',
		trackFormat: 'cea-708',
	},
	stl: {
		name: 'EBU STL',
		extension: 'stl',
		binary: true,
		mime: 'application/octet-stream',
		trackFormat: 'teletext',
	},
	ttml: {
		name: 'TTML (IMSC1)',
		extension: 'ttml',
		binary: false,
		mime: 'application/ttml+xml',
		trackFormat: 'subtitle',
	},
	dfxp: {
		name: 'DFXP (TTML1)',
		extension: 'dfxp',
		binary: false,
		mime: 'application/ttaf+xml',
		trackFormat: 'subtitle',
	},
};

/** Caption track standards (Premiere's "Format" of a caption track). */
export const CAPTION_TRACK_FORMATS = ['subtitle', 'cea-608', 'cea-708', 'teletext'] as const;
export type CaptionTrackFormat = (typeof CAPTION_TRACK_FORMATS)[number];

/** A caption file format from a name or extension (`srt`, `.vtt`, `webvtt`, `cea608`, `imsc1`…). */
export function captionFormatFromName(s: string): CaptionFileFormat | null {
	switch (s.replace(/^\./, '').toLowerCase()) {
		case 'srt':
		case 'subrip':
			return 'srt';
		case 'vtt':
		case 'webvtt':
			return 'vtt';
		case 'scc':
		case 'cea608':
		case 'cea-608':
			return 'scc';
		case 'mcc':
		case 'maccaption':
		case 'cea708':
		case 'cea-708':
			return 'mcc';
		case 'stl':
		case 'ebu-stl':
		case 'ebustl':
		case 'ebu':
			return 'stl';
		case 'ttml':
		case 'imsc':
		case 'imsc1':
		case 'xml':
			return 'ttml';
		case 'dfxp':
			return 'dfxp';
	}
	return null;
}

function toBytes(input: Uint8Array | string): Uint8Array {
	return typeof input === 'string' ? encodeUtf8(input) : input;
}

/** Guess a caption format from content (and the file extension as a hint). */
export function detectCaptionFormat(
	input: Uint8Array | string,
	ext?: string | null,
): CaptionFileFormat | null {
	const bytes = toBytes(input);
	if (sniffStl(bytes)) return 'stl';
	const head = decodeCaptionText(bytes.subarray(0, Math.min(bytes.length, 4096)))
		.replace(/^﻿/, '')
		.trimStart();
	if (head.startsWith('WEBVTT')) return 'vtt';
	if (head.startsWith('Scenarist_SCC')) return 'scc';
	if (head.startsWith('File Format=MacCaption_MCC')) return 'mcc';
	const e = ext ? ext.replace(/^\./, '').toLowerCase() : null;
	if (
		head.startsWith('<') &&
		(head.includes('<tt ') || head.includes('<tt>') || head.includes(':tt ')) &&
		(head.includes('ns/ttml') || head.includes('ttaf1'))
	) {
		const legacy = head.includes('ttaf1') || head.includes('dfxp');
		return e === 'dfxp' || (legacy && e !== 'ttml') ? 'dfxp' : 'ttml';
	}
	const hasArrow = head
		.split('\n')
		.slice(0, 40)
		.some((l) => parseTimingLine(l) !== null);
	if (e === 'srt' && (hasArrow || head.length === 0)) return 'srt';
	if (e === 'vtt' && hasArrow) return 'vtt';
	if (e && ['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp', 'xml'].includes(e)) return null;
	return hasArrow ? 'srt' : null;
}

export type CaptionParseResult = { ok: true; doc: CaptionDocument } | { ok: false; error: string };

/** Parse caption bytes (or text). Never throws: malformed input returns `{ok: false, error}`. */
export function parseCaptionFile(input: Uint8Array | string, format: CaptionFileFormat): CaptionParseResult {
	try {
		if (format === 'stl') return { ok: true, doc: parseStl(toBytes(input)) };
		const text = typeof input === 'string' ? decodeCaptionText(input) : decodeCaptionText(input);
		switch (format) {
			case 'srt':
				return { ok: true, doc: parseSrt(text) };
			case 'vtt':
				return { ok: true, doc: parseVtt(text) };
			case 'scc':
				return { ok: true, doc: parseScc(text) };
			case 'mcc':
				return { ok: true, doc: parseMcc(text) };
			case 'ttml':
			case 'dfxp':
				return { ok: true, doc: parseTtml(text) };
		}
		return { ok: false, error: `unknown caption format ${String(format)}` };
	} catch (e) {
		if (e instanceof CaptionFormatError) return { ok: false, error: e.message };
		// Defensive: a reader bug must not escape as an uncaught exception.
		return { ok: false, error: `could not read ${format}: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** Parse with format detection (extension as a hint), optionally snapping to a frame rate. */
export function readCaptionFile(
	input: Uint8Array | string,
	opts: { format?: CaptionFileFormat | null; ext?: string | null; snapRate?: Rational | null } = {},
): { ok: true; doc: CaptionDocument; format: CaptionFileFormat } | { ok: false; error: string } {
	const format = opts.format ?? detectCaptionFormat(input, opts.ext ?? null);
	if (!format)
		return {
			ok: false,
			error: 'not a recognised caption file (SRT, WebVTT, SCC, MCC, EBU STL, TTML or DFXP)',
		};
	const r = parseCaptionFile(input, format);
	if (!r.ok) return r;
	if (opts.snapRate) snapCaptionDocument(r.doc, opts.snapRate);
	return { ok: true, doc: r.doc, format };
}

export type CaptionWriteOptions = {
	/** SCC / MCC: drop-frame timecode (the usual choice for 29.97 fps). Default true. */
	dropFrame?: boolean;
	/** Sequence rate: TTML (IMSC1) writes exact frame times at it; EBU STL picks STL25.01 / STL30.01. */
	rate?: Rational | null;
	/** TTML `xml:lang`. Default `en`. */
	language?: string;
	/** MCC streams (both by default). */
	cea608?: boolean;
	cea708?: boolean;
};

/** Write a caption document. Text formats return a string, EBU STL returns bytes. */
export function writeCaptionFile(
	doc: CaptionDocument,
	format: CaptionFileFormat,
	opts: CaptionWriteOptions = {},
): string | Uint8Array {
	const df = opts.dropFrame ?? true;
	switch (format) {
		case 'srt':
			return writeSrt(doc);
		case 'vtt':
			return writeVtt(doc);
		case 'scc':
			return writeScc(doc, df);
		case 'mcc':
			return writeMcc(doc, df, { cea608: opts.cea608, cea708: opts.cea708 });
		case 'stl':
			return writeStl(doc, opts.rate ?? null);
		case 'ttml':
			return writeTtml(doc, 'imsc1', opts.rate ?? null, opts.language ?? 'en');
		case 'dfxp':
			return writeTtml(doc, 'dfxp', opts.rate ?? null, opts.language ?? 'en');
	}
	throw new CaptionFormatError(`unknown caption format ${String(format)}`);
}

/** Bytes of a written caption file (UTF-8 for text formats). */
export function writeCaptionFileBytes(
	doc: CaptionDocument,
	format: CaptionFileFormat,
	opts: CaptionWriteOptions = {},
): Uint8Array {
	const out = writeCaptionFile(doc, format, opts);
	return typeof out === 'string' ? encodeUtf8(out) : out;
}
