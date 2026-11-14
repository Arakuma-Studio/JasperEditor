// Rebuild from script on a saved project, offline (docs/wp-notes/script-correction.md "Rebuild from script"): the
// re-transcription of each kept span is stood in for by the words of a transcript (another saved revision, or the
// project's own), the spans rebuilt and written with `transcript.replaceWords`, and the sequence words compared with
// the attached script's spoken words in order (longest common subsequence): matched with the same text (case and
// punctuation included) and normalised (lower case, accents and punctuation removed). Also prints the same figures for
// the project as saved and for the stand-in's own sequence.
//
//   pnpm exec tsx packages/project/bench/rebuild-reference.ts <project.jasper> [heard.jasper] [transcriptId] [--keep]
import { readFileSync } from 'node:fs';
import { createCounterIdSource } from '../src/ids.ts';
import { applyTransaction, defaultRegistries, type ProjectDocument, sequenceWords } from '../src/index.ts';
import { heardInSpans, keptSpans, parseScript, rebuildEdits, rebuildSpans } from '../src/script-fix/index.ts';

const args = process.argv.slice(2).filter((a) => a !== '--keep');
const keep = process.argv.includes('--keep');
const [projectPath, heardPath = projectPath, heardTranscript] = args;
if (!projectPath) {
	console.error('usage: rebuild-reference.ts <project.jasper> [heard.jasper] [transcriptId] [--keep]');
	process.exit(2);
}
const load = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { document: ProjectDocument }).document;
const doc = load(projectPath);
const src = load(heardPath!);
const seq = Object.values(doc.sequences)[0]!;
const text = (seq as { cleanup?: { script?: { text?: string } } }).cleanup?.script?.text ?? '';
const script = parseScript(text, { language: 'es' });
const scriptWords = script.tokens.filter((t) => t.kind === 'word').map((t) => t.text);

const norm = (t: string) =>
	t
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Mn}/gu, '')
		.replace(/[^a-z0-9]/g, '');

/** Script words matched in order (LCS over normalised words) and how many of those have the same text. */
function measure(words: readonly string[]) {
	const a = scriptWords.map(norm);
	const b = words.map(norm);
	const n = a.length;
	const m = b.length;
	const dp = new Uint16Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			dp[i * (m + 1) + j] =
				a[i] === b[j]
					? dp[(i + 1) * (m + 1) + j + 1]! + 1
					: Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
	let exact = 0;
	for (let i = 0, j = 0; i < n && j < m; ) {
		if (a[i] === b[j] && dp[i * (m + 1) + j] === dp[(i + 1) * (m + 1) + j + 1]! + 1) {
			if (scriptWords[i] === words[j]) exact++;
			i++;
			j++;
		} else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++;
		else j++;
	}
	return { sequenceWords: words.length, matched: dp[0]!, exact };
}

const seqText = (d: ProjectDocument) => sequenceWords(d, Object.values(d.sequences)[0]!).map((w) => w.text);
console.log(`script: ${scriptWords.length} spoken words`);
console.log('as saved:', measure(seqText(doc)));
if (heardPath !== projectPath) console.log('stand-in as saved:', measure(seqText(src)));

const t0 = performance.now();
const spans = keptSpans(doc, seq);
const byMedia = new Map<string, typeof spans>();
for (const s of spans) byMedia.set(s.mediaId, [...(byMedia.get(s.mediaId) ?? []), s]);
const commands: unknown[] = [];
const counts: Record<string, number> = {};
let unwritable = 0;
for (const list of byMedia.values()) {
	const heardWords = src.transcripts[heardTranscript ?? list[0]!.transcriptId]?.words ?? [];
	const heard = heardInSpans(heardWords, list);
	const old = doc.transcripts[list[0]!.transcriptId]!.words;
	const rebuilt = rebuildSpans({
		spans: heard,
		previous: list.map((s) => old.filter((w) => w.start < s.end && w.end > s.start)),
		script,
		language: 'es',
		keepOffScript: keep,
	});
	list.forEach((s, i) => {
		for (const [k, v] of Object.entries(rebuilt[i]!.counts)) counts[k] = (counts[k] ?? 0) + v;
		const edits = heard[i]!.length ? rebuildEdits(old, s, rebuilt[i]!.words) : [];
		if (edits === null) unwritable++;
		else if (edits.length)
			commands.push({ type: 'transcript.replaceWords', transcriptId: s.transcriptId, edits });
	});
}
const ms = Math.round(performance.now() - t0);
const r = applyTransaction(
	doc,
	{ label: 'rebuild', origin: 'user', sequenceId: seq.id, commands },
	{
		ids: createCounterIdSource(1),
		now: () => new Date().toISOString(),
		revision: 0,
		registries: defaultRegistries(),
	},
);
if (!r.result.ok) {
	console.error('the rebuild was refused:', JSON.stringify(r.result.errors).slice(0, 2000));
	process.exit(1);
}
console.log({ spans: spans.length, changedSpans: commands.length, unwritable, counts, ms });
console.log('rebuilt:', measure(seqText(r.document)));
