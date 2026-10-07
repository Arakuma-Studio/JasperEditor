// The format registry: names, extensions, sniffing and the reader/writer of every format.

import { exportAaf, importAaf, sniffAaf } from './aaf/index.ts';
import { exportAle, importAle, sniffAle } from './ale.ts';
import { exportEdl, importEdl, looksLikeEdl } from './edl.ts';
import { exportFcp7, importFcp7, sniffFcp7 } from './fcp7.ts';
import { exportFcpxml, importFcpxml, sniffFcpxml } from './fcpxml.ts';
import type { IProject } from './model.ts';
import type { ExportOptions, Format, ImportOptions } from './options.ts';
import { exportOtio, importOtio, sniffOtio } from './otio.ts';
import { decodeUtf8Lossy, encodeUtf8 } from './paths.ts';
import type { Report } from './report.ts';

export type FormatInfo = {
	id: Format;
	/** Display name (menus, reports). */
	name: string;
	/** Default file extension (without the dot). */
	extension: string;
	/** Extensions recognised on import. */
	extensions: readonly string[];
	binary: boolean;
	/** Whether the format holds a timeline (ALE is a clip log). */
	timeline: boolean;
	sniff(bytes: Uint8Array, head: string): boolean;
	read(bytes: Uint8Array, opts: ImportOptions, report: Report): IProject;
	write(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): Uint8Array;
};

/** Text of a document: UTF-8 with or without BOM, else Latin-1 (old EDLs and ALEs). */
export function decodeText(bytes: Uint8Array): string {
	let b = bytes;
	if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
	if (b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), true);
	if (b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), false);
	const s = decodeUtf8Lossy(b);
	if (!s.includes('�')) return s;
	let out = '';
	for (const c of b) out += String.fromCharCode(c);
	return out;
}

function utf16(b: Uint8Array, le: boolean): string {
	let out = '';
	for (let i = 0; i + 1 < b.length; i += 2)
		out += String.fromCharCode(le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
	return out;
}

const text =
	(f: (text: string, opts: ImportOptions, report: Report) => IProject): FormatInfo['read'] =>
	(bytes, opts, report) =>
		f(decodeText(bytes), opts, report);

const textOut =
	(
		f: (p: IProject, sequenceId: string, opts: ExportOptions, report: Report) => string,
	): FormatInfo['write'] =>
	(p, s, o, r) =>
		encodeUtf8(f(p, s, o, r));

export const FORMAT_INFO: Record<Format, FormatInfo | undefined> = {
	otio: {
		id: 'otio',
		name: 'OpenTimelineIO',
		extension: 'otio',
		extensions: ['otio'],
		binary: false,
		timeline: true,
		sniff: (_b, head) => sniffOtio(head),
		read: text(importOtio),
		write: textOut(exportOtio),
	},
	fcp7: {
		id: 'fcp7',
		name: 'Final Cut Pro XML',
		extension: 'xml',
		extensions: ['xml', 'xmeml'],
		binary: false,
		timeline: true,
		sniff: (_b, head) => sniffFcp7(head),
		read: text(importFcp7),
		write: textOut(exportFcp7),
	},
	fcpxml: {
		id: 'fcpxml',
		name: 'FCPXML',
		extension: 'fcpxml',
		extensions: ['fcpxml', 'fcpxmld'],
		binary: false,
		timeline: true,
		sniff: (_b, head) => sniffFcpxml(head),
		read: text(importFcpxml),
		write: textOut(exportFcpxml),
	},
	edl: {
		id: 'edl',
		name: 'CMX 3600 EDL',
		extension: 'edl',
		extensions: ['edl'],
		binary: false,
		timeline: true,
		sniff: (_b, head) => looksLikeEdl(head),
		read: text(importEdl),
		write: textOut(exportEdl),
	},
	aaf: {
		id: 'aaf',
		name: 'AAF',
		extension: 'aaf',
		extensions: ['aaf'],
		binary: true,
		timeline: true,
		sniff: (b) => sniffAaf(b),
		read: (b, o, r) => importAaf(b, o, r),
		write: (p, s, o, r) => exportAaf(p, s, o, r),
	},
	omf: undefined,
	ale: {
		id: 'ale',
		name: 'Avid ALE',
		extension: 'ale',
		extensions: ['ale'],
		binary: false,
		timeline: false,
		sniff: (_b, head) => sniffAle(head),
		read: text(importAle),
		write: textOut(exportAle),
	},
};

export function formatInfo(f: Format): FormatInfo {
	const info = FORMAT_INFO[f];
	if (!info) throw new Error(`format ${f} is not available`);
	return info;
}

/** Format of a file extension (case-insensitive, with or without the dot); `.xml` → FCP7 XML. */
export function formatFromExtension(ext: string): Format | null {
	const e = ext.trim().replace(/^\./, '').toLowerCase();
	for (const f of Object.values(FORMAT_INFO)) if (f?.extensions.includes(e)) return f.id;
	return null;
}

/** Sniff a document's format from its bytes, with the file name as a hint for ambiguous text. */
export function detectFormat(bytes: Uint8Array, fileName?: string | null): Format | null {
	const head = decodeText(bytes.subarray(0, 8192));
	const ext = fileName?.includes('.') && fileName ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
	// Binary containers first, then text sniffers in a fixed order.
	const order: Format[] = ['aaf', 'omf', 'fcp7', 'fcpxml', 'otio', 'ale', 'edl'];
	for (const f of order) {
		const info = FORMAT_INFO[f];
		if (!info) continue;
		try {
			if (info.sniff(bytes, head)) return f;
		} catch {
			// a sniffer never decides on garbage
		}
	}
	const byExt = ext ? formatFromExtension(ext) : null;
	return byExt && FORMAT_INFO[byExt] ? byExt : null;
}
