// wp interchange: File ▸ Import of timeline documents (FCP7 XML, FCPXML, OTIO, EDL, AAF, OMF, ALE). The engine reads
// the document, registers the media it finds and returns a fragment; one `project.importTimeline` transaction adds
// it (one undo step). Media it could not find comes in as offline placeholders, which Link Media relinks.
import type { InterchangeImportResponse, InterchangeMissing, InterchangeReportEntry } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import type { ImportFailure } from '../import/prompts.ts';
import { bytesToBase64 } from '../panels/text/state.ts';

export type TimelineImportReport = {
	/** The document's file name. */
	name: string;
	format: InterchangeImportResponse['format'];
	warnings: InterchangeReportEntry[];
	missing: InterchangeMissing[];
	extracted: InterchangeImportResponse['extracted'];
	sequenceIds: string[];
	binId: string | null;
};

const base = (p: string) => p.replace(/^.*[\\/]/, '');

/** Imports each document into `binId` (null = root); returns the reports and the failures. */
export async function importTimelineFiles(
	session: EditorSession,
	engine: EngineClient,
	input: { files: File[]; paths: string[] },
	binId: string | null,
): Promise<{ reports: TimelineImportReport[]; failed: ImportFailure[] }> {
	const reports: TimelineImportReport[] = [];
	const failed: ImportFailure[] = [];
	const sources: { name: string; request: () => Promise<InterchangeImportResponse> }[] = [
		...input.files.map((f) => ({
			name: f.name,
			request: async () =>
				engine.importTimeline({
					projectId: session.projectId,
					file: { name: f.name, contentBase64: bytesToBase64(new Uint8Array(await f.arrayBuffer())) },
				}),
		})),
		...input.paths.map((p) => ({
			name: base(p),
			request: () => engine.importTimeline({ projectId: session.projectId, path: p }),
		})),
	];
	for (const s of sources) {
		let res: InterchangeImportResponse;
		try {
			res = await s.request();
		} catch (e) {
			failed.push({
				name: s.name,
				code: e instanceof EngineError ? e.code : 'E_READ',
				message: e instanceof Error ? e.message : String(e),
			});
			continue;
		}
		const r = session.apply({
			label: `Import ${s.name}`,
			origin: 'user',
			...(session.getState().activeSequenceId ? { sequenceId: session.getState().activeSequenceId! } : {}),
			commands: [
				{ type: 'project.importTimeline', fragment: res.fragment, ...(binId ? { binId } : {}) } as never,
			],
		});
		if (!r.ok) {
			failed.push({
				name: s.name,
				code: r.errors[0]?.code ?? 'E_INVALID_PARAM',
				message: r.errors[0]?.message ?? 'The timeline could not be added',
			});
			continue;
		}
		const out = r.results[0] as { topSequenceIds: string[]; binId: string | null };
		reports.push({
			name: s.name,
			format: res.format,
			warnings: res.warnings,
			missing: res.missing,
			extracted: res.extracted,
			sequenceIds: out.topSequenceIds,
			binId: out.binId,
		});
	}
	return { reports, failed };
}
