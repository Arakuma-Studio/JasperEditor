// wp interchange: the timeline formats as the File menus name them (Premiere's File ▸ Export entries) and which
// imported files are timeline documents. The engine reads and writes the documents (@jasper/interchange).
import type { InterchangeFormat } from '@jasper/api';

export type FormatEntry = {
	id: InterchangeFormat;
	/** Menu label (File ▸ Export ▸ …). */
	label: string;
	/** Dialog title. */
	title: string;
	extension: string;
	/** Carries picture (else audio only / a clip log). */
	video: boolean;
};

export const TIMELINE_FORMATS: readonly FormatEntry[] = [
	{ id: 'fcp7', label: 'Final Cut Pro XML…', title: 'Final Cut Pro XML', extension: 'xml', video: true },
	{ id: 'fcpxml', label: 'FCPXML…', title: 'FCPXML', extension: 'fcpxml', video: true },
	{ id: 'otio', label: 'OpenTimelineIO…', title: 'OpenTimelineIO', extension: 'otio', video: true },
	{ id: 'edl', label: 'EDL…', title: 'EDL (CMX 3600)', extension: 'edl', video: true },
	{ id: 'aaf', label: 'AAF…', title: 'AAF', extension: 'aaf', video: true },
	{ id: 'omf', label: 'OMF…', title: 'OMF', extension: 'omf', video: false },
	{ id: 'ale', label: 'Avid ALE…', title: 'Avid ALE', extension: 'ale', video: false },
];

export function formatEntry(id: InterchangeFormat): FormatEntry {
	return TIMELINE_FORMATS.find((f) => f.id === id)!;
}

/** Extensions that are always timeline documents (`.xml` is decided by content: FCP7 XML vs captions/other). */
const TIMELINE_EXT = /\.(fcpxml|fcpxmld|otio|edl|aaf|omf|omfi|ale|xmeml)$/i;

export function isTimelineFileName(name: string): boolean {
	return TIMELINE_EXT.test(name);
}

/** Whether the start of a file is a Final Cut Pro 7 XML (`<xmeml>`) or FCPXML document. */
export function isTimelineXmlHead(head: string): boolean {
	return /<xmeml[\s>]/.test(head) || /<fcpxml[\s>]/.test(head);
}

export async function isTimelineXmlFile(file: File): Promise<boolean> {
	if (!/\.xml$/i.test(file.name)) return false;
	const head = new TextDecoder('utf-8', { fatal: false }).decode(await file.slice(0, 8192).arrayBuffer());
	return isTimelineXmlHead(head);
}

/** The pre-render choices (EffectCraft's `prerender: unsupported | all | none`) with the dialog's wording. */
export const PRERENDER_LABELS: Record<'unsupported' | 'all' | 'none', string> = {
	unsupported: 'Clips the format cannot represent',
	all: 'All video clips',
	none: 'None (report them)',
};

/** Default pre-render mode per format: OTIO keeps everything in its metadata; OMF and ALE carry no picture. */
export function defaultPrerender(id: InterchangeFormat): 'unsupported' | 'all' | 'none' {
	return id === 'otio' || !formatEntry(id).video ? 'none' : 'unsupported';
}
