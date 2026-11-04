// The short-LJ transcript-fix fixture shared by real-model correctness tests and the standalone benchmark.
import { mediaRegisterCommand, type RegisteredMedia } from '@jasper/api';
import {
	applyTransaction,
	cleanupNorm,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';

/** Typical recognition confusions of words of the fixture (the same list as speech-score.e2e). */
const CONFUSIONS: Array<[string, string]> = [
	['block', 'black'],
	['prisoners', 'prisons'],
	['slept', 'slapped'],
	['wall', 'war'],
	['egg', 'leg'],
	['carton', 'cartoon'],
	['topic', 'tropic'],
	['yeast', 'east'],
	['stock', 'stack'],
	['forged', 'forget'],
];

export type Word = { text: string; start: number; end: number; confidence: number | null };
function swapWord(text: string, to: string): string {
	return text.replace(/[A-Za-z']+/, (m) =>
		m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
	);
}

/** The transcript with the confusions applied (first occurrence of each), and the corrupted indices. */
export function corrupt(words: Word[]): { words: Word[]; at: Map<number, [string, string]> } {
	const at = new Map<number, [string, string]>();
	const out = words.map((w) => ({ ...w }));
	for (const pair of CONFUSIONS) {
		const i = words.findIndex((w) => cleanupNorm(w.text) === pair[0]);
		if (i < 0) continue;
		at.set(i, pair);
		out[i] = { ...out[i]!, text: swapWord(out[i]!.text, pair[1]) };
	}
	return { words: out, at };
}

/** The script: the words' text, a line per sentence. */
export function scriptOf(words: Word[]): string {
	return words
		.map((w) => w.text)
		.join(' ')
		.replace(/([.!?]) /g, '$1\n');
}

/** The saved-project document used by the real-model test and its whole-job benchmark. */
export function transcriptFixDocument(
	reg: RegisteredMedia,
	words: Word[],
	script: string,
	model: string,
	projectId: string,
): { doc: ProjectDocument; seqId: string } {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Fix e2e', preset: 'hd-1080p-30' });
	doc = { ...doc, projectId };
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = applyTransaction(
		doc,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				mediaRegisterCommand(reg, '$a', '$ai', 'lj'),
				{ type: 'transcript.create', mediaId: '$a', language: 'en', origin: 'whisper-local', words },
				{
					type: 'clip.place',
					source: { mediaId: '$a' },
					at: 0,
					tracks: { audio: 'A1' },
					video: false,
					audio: true,
				},
				{ type: 'cleanup.configure', sequenceId: seqId, script: { name: 'Script', text: script } },
			] as never[],
		},
		{ ids, now: () => '2026-10-27T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	doc = r.document;
	// the model that made the transcript scores it (transcript.create takes no model: set as transcription does)
	doc = {
		...doc,
		transcripts: Object.fromEntries(Object.entries(doc.transcripts).map(([k, t]) => [k, { ...t, model }])),
	};
	return { doc, seqId };
}
