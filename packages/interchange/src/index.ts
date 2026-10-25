// @jasper/interchange — timeline interchange for JasperEditor: Final Cut Pro 7 XML (xmeml), FCPXML, OpenTimelineIO,
// CMX 3600 EDL, AAF (Edit Protocol over MS-CFB), OMF 2.0 (Bento) and Avid ALE, import and export. Pure TypeScript:
// no file-system access (the engine reads and writes files, probes and relinks media, renders pre-renders).
//
//   import: bytes → `readDocument` → IProject (+ report) → (engine resolves media) → `toJasper` → fragment
//           → `project.importTimeline` command (one undoable transaction).
//   export: document → `fromJasper` (pre-rendered clips substituted) → IProject → `writeDocument` → bytes + report.
import type { MediaAsset, ProjectDocument } from '@jasper/project';
import { exportEdlPerTrack } from './edl.ts';
import { detectFormat, FORMAT_INFO, formatInfo } from './formats.ts';
import { type FromJasperOptions, fromJasper } from './jasper-export.ts';
import { type JasperFragment, type ToJasperOptions, toJasper } from './jasper-import.ts';
import type { IProject } from './model.ts';
import type { ExportOptions, Format, ImportOptions } from './options.ts';
import { encodeUtf8 } from './paths.ts';
import { InterchangeError, Report, type ReportEntry } from './report.ts';

export { exportAaf, importAaf, sniffAaf } from './aaf/index.ts';
export * from './ale.ts';
export * from './blend.ts';
export * from './build.ts';
export * from './edl.ts';
export * from './effects.ts';
export * from './essence.ts';
export * from './fcp7.ts';
export * from './fcpxml.ts';
export * from './formats.ts';
export * from './jasper-export.ts';
export * from './jasper-import.ts';
export * from './model.ts';
export { exportOmf, importOmf, sniffOmf } from './omf/index.ts';
export * from './options.ts';
export * from './otio.ts';
export * from './paths.ts';
export * from './premiere-transitions.ts';
export * from './prerender.ts';
export * from './report.ts';
export * from './time.ts';
export * from './wav.ts';

export type ReadResult = { format: Format; project: IProject; report: Report };

/**
 * Read a document. The format is sniffed from the bytes (and `fileName`) unless given. Throws
 * `InterchangeError` when the document cannot be read at all; never anything else.
 */
export function readDocument(
	bytes: Uint8Array,
	opts: ImportOptions & { format?: Format | null; fileName?: string | null } = {},
): ReadResult {
	const format = opts.format ?? detectFormat(bytes, opts.fileName);
	if (!format) throw new InterchangeError('UNSUPPORTED', 'not a timeline document this version can read');
	const info = FORMAT_INFO[format];
	if (!info) throw new InterchangeError('UNSUPPORTED', `${format} documents are not supported`);
	const report = new Report();
	let project: IProject;
	try {
		project = info.read(bytes, opts, report);
	} catch (e) {
		if (e instanceof InterchangeError) throw e;
		throw new InterchangeError('PARSE', `${info.name}: ${(e as Error)?.message ?? String(e)}`);
	}
	if (Object.keys(project.sequences).length === 0 && Object.keys(project.media).length === 0)
		throw new InterchangeError('EMPTY', `the ${info.name} document contains no timeline or clips`);
	return { format, project, report };
}

export type WriteResult = {
	format: Format;
	/** One file, or one per video track for per-track EDLs (`suffix` "V1", "V2", …). */
	files: { suffix: string | null; bytes: Uint8Array }[];
	report: Report;
};

export function writeDocument(
	p: IProject,
	sequenceId: string,
	format: Format,
	opts: ExportOptions & { perTrack?: boolean } = {},
): WriteResult {
	const info = formatInfo(format);
	const report = new Report();
	if (!p.sequences[sequenceId]) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	if (format === 'edl' && opts.perTrack) {
		const lists = exportEdlPerTrack(p, sequenceId, opts, report);
		return { format, files: lists.map((l) => ({ suffix: l.suffix, bytes: encodeUtf8(l.text) })), report };
	}
	const bytes = info.write(p, sequenceId, opts, report);
	return { format, files: [{ suffix: null, bytes }], report };
}

/** Everything an import produces: the fragment (sequences, items, media, …) plus format and warnings. */
export type ImportResult = JasperFragment & { format: Format; warnings: ReportEntry[] };

/**
 * Import a document into a JasperEditor fragment. Without `assets` every file becomes an offline placeholder
 * (listed in `missing`); the engine passes the assets it registered.
 */
export function importTimeline(
	bytes: Uint8Array,
	opts: ImportOptions & { format?: Format | null; fileName?: string | null } & ToJasperOptions = {},
): ImportResult {
	const { format, project, report } = readDocument(bytes, opts);
	const frag = toJasper(project, opts, report);
	return { ...frag, format, warnings: report.entries };
}

export type ExportResult = WriteResult & { warnings: ReportEntry[] };

/** Export a sequence of a JasperEditor document. */
export function exportTimeline(
	doc: ProjectDocument,
	sequenceId: string,
	format: Format,
	opts: ExportOptions & Omit<FromJasperOptions, 'format'> & { perTrack?: boolean } = {},
): ExportResult {
	if (!doc.sequences[sequenceId]) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const report = new Report();
	const ir = fromJasper(doc, sequenceId, { ...opts, format }, report);
	const out = writeDocument(ir, sequenceId, format, opts);
	report.merge(out.report);
	return { ...out, report, warnings: report.entries };
}

export type { MediaAsset };
