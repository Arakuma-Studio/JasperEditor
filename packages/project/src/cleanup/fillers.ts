// Default filler lists of `transcript.removeFillers` (spec 14 TC-032), shared by the command and the MCP dry run.
import { DEFAULT_FILLERS, findFillers, type SeqWord } from '../captions/sequence-transcript.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { builtinLists, cleanupLanguageOf } from './lists.ts';
import { readSequenceCleanup } from './schema.ts';

/**
 * Filler hits with the default lists (TC-032): per word, the list of its transcript's language — the sequence's
 * edited list, else the built-in vocalic fillers of Spanish; English and unknown languages keep `DEFAULT_FILLERS`
 * (unchanged for old callers). `language` forces one language for every word.
 */
export function languageFillerHits(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: { cleanup?: unknown },
	words: readonly SeqWord[],
	language: string | undefined,
): Array<[number, number]> {
	const stored = readSequenceCleanup(seq);
	const langOf = (w: SeqWord) => cleanupLanguageOf(language ?? doc.transcripts[w.transcriptId]?.language);
	const groups = new Map<string, number[]>();
	words.forEach((w, i) => {
		const l = langOf(w) ?? 'und';
		const list = groups.get(l);
		if (list) list.push(i);
		else groups.set(l, [i]);
	});
	const hits: Array<[number, number]> = [];
	for (const [l, idx] of groups) {
		const edited = l !== 'und' ? stored.lists?.[l]?.fillers : undefined;
		const list = edited ?? (l === 'es' ? builtinLists('es').fillers : DEFAULT_FILLERS);
		const member = new Set(idx);
		for (const [a, b] of findFillers(words, list)) {
			let ok = true;
			for (let i = a; i < b && ok; i++) ok = member.has(i);
			if (ok) hits.push([a, b]);
		}
	}
	return hits.sort((x, y) => x[0] - y[0]);
}
