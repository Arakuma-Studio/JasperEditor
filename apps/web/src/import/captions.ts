// wp captions: caption files among imported files (File ▸ Import, drops) go onto a new caption track of the open
// sequence (FilmCraft / Premiere behaviour) instead of being uploaded as media. Cue times snap to the sequence frames.
import type { EngineClient } from '@jasper/engine-client';
import {
	decodeCaptionText,
	detectCaptionFormat,
	type Sequence,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { bytesToBase64 } from '../panels/text/state.ts';
import type { ImportFailure } from './prompts.ts';

const CAPTION_EXT = /\.(srt|vtt|scc|mcc|stl|ttml|dfxp)$/i;

/** Whether a file name is a caption file by extension (`.xml` is checked by content, `captionXml`). */
export function isCaptionFileName(name: string): boolean {
	return CAPTION_EXT.test(name);
}

/** An `.xml` file that is TTML / DFXP. */
export async function isCaptionXml(file: File): Promise<boolean> {
	if (!/\.xml$/i.test(file.name)) return false;
	const head = decodeCaptionText(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
	return detectCaptionFormat(head, 'xml') !== null;
}

/** Applies `caption.import` for each file; returns failures (no open sequence, unreadable files). */
export async function importCaptionFiles(
	session: EditorSession,
	engine: EngineClient,
	input: { files: File[]; paths: string[] },
): Promise<{ trackIds: string[]; failed: ImportFailure[] }> {
	const failed: ImportFailure[] = [];
	const trackIds: string[] = [];
	const names = [...input.files.map((f) => f.name), ...input.paths.map((p) => p.replace(/^.*[\\/]/, ''))];
	const seqId = session.getState().activeSequenceId;
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) {
		for (const name of names)
			failed.push({ name, code: 'E_NO_SEQUENCE', message: 'Open a sequence to import captions into it' });
		return { trackIds, failed };
	}
	const sources: Array<{ name: string; read: () => Promise<Uint8Array> }> = [
		...input.files.map((f) => ({ name: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) })),
		...input.paths.map((p) => ({
			name: p.replace(/^.*[\\/]/, ''),
			read: async () => {
				const r = await engine.readCaptionFile({ path: p });
				return Uint8Array.from(atob(r.contentBase64), (c) => c.charCodeAt(0));
			},
		})),
	];
	for (const s of sources) {
		let bytes: Uint8Array;
		try {
			bytes = await s.read();
		} catch (e) {
			failed.push({ name: s.name, code: 'E_READ', message: e instanceof Error ? e.message : String(e) });
			continue;
		}
		const r: TransactionResult = session.apply({
			label: 'Import Captions',
			origin: 'user',
			sequenceId: seq.id,
			commands: [
				{ type: 'caption.import', contentBase64: bytesToBase64(bytes), fileName: s.name },
			] as never[],
		});
		if (r.ok) trackIds.push((r.results[0] as { trackId: string }).trackId);
		else
			failed.push({
				name: s.name,
				code: r.errors[0]?.code ?? 'E_INVALID_PARAM',
				message: r.errors[0]?.message ?? 'Not a caption file',
			});
	}
	return { trackIds, failed };
}
