// Run: pnpm exec tsx packages/project/bench/script-fix.ts > packages/project/bench/script-fix.results.json
// Script-guided transcript correction, the pure model (spec 17 SC-015; docs/wp-notes/script-correction.md "Model"):
// a 2 h synthetic transcript (20,000 words, retakes, chatter, misrecognitions) against a 6,000-token script —
// parseScript, alignTranscript, findFixCandidates, buildScoreWindows. Targets: ≤ 5 s and ≤ 300 MB extra memory.
// Memory = growth of the process's peak resident set (maxRSS) over the first run, after the inputs are built.
// Then 5 timed runs; medians. Input construction is not timed.
import { cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { alignTranscript } from '../src/script-fix/align.ts';
import { findFixCandidates } from '../src/script-fix/candidates.ts';
import { parseScript } from '../src/script-fix/script.ts';
import { buildScoreWindows } from '../src/script-fix/windows.ts';
import { synthScriptFix } from '../test/script-fix-synth.ts';

const loadAtStart = loadavg().map((x) => Math.round(x * 100) / 100);
const { scriptText, words } = synthScriptFix();
const gc = (globalThis as { gc?: () => void }).gc;

function once() {
	const t0 = performance.now();
	const script = parseScript(scriptText, { language: 'es' });
	const t1 = performance.now();
	const a = alignTranscript({ words, script, language: 'es', mediaId: 'm', transcriptId: 't' });
	if (!a.ok) throw new Error(a.message);
	const t2 = performance.now();
	const c = findFixCandidates({ mediaId: 'm', transcriptId: 't', words, script, alignment: a });
	const t3 = performance.now();
	const w = buildScoreWindows(words, c.candidates);
	const t4 = performance.now();
	return { script, a, c, w, ms: { parse: t1 - t0, align: t2 - t1, candidates: t3 - t2, windows: t4 - t3, total: t4 - t0 } };
}

gc?.();
const rssBefore = process.resourceUsage().maxRSS * 1024;
const first = once();
const rssAfter = process.resourceUsage().maxRSS * 1024;
const runs = Array.from({ length: 5 }, () => once().ms);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const r = first.a.report;
console.log(
	JSON.stringify(
		{
			machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version },
			loadAtStart,
			loadAtEnd: loadavg().map((x) => Math.round(x * 100) / 100),
			input: {
				transcriptWords: words.length,
				scriptTokens: first.script.tokens.length,
				audioMinutes: Math.round((words[words.length - 1]!.end / 705_600_000 / 60) * 10) / 10,
			},
			alignment: {
				alignedShare: Math.round(r.alignedShare * 1000) / 1000,
				offScriptShare: Math.round(r.offScriptShare * 1000) / 1000,
				retakeJumps: r.retakeJumps,
				mergeCells: r.mergeCells,
				storedCells: r.storedCells,
				cappedRows: r.cappedRows,
				candidates: first.c.candidates.length,
				windows: first.w.windows.length,
			},
			targetMs: 5000,
			medianMs: Object.fromEntries(
				(['parse', 'align', 'candidates', 'windows', 'total'] as const).map((k) => [k, Math.round(median(runs.map((x) => x[k])))]),
			),
			samplesTotalMs: runs.map((x) => Math.round(x.total)),
			targetExtraMemoryBytes: 300 * 1024 * 1024,
			extraPeakRssBytes: rssAfter - rssBefore,
		},
		null,
		2,
	),
);
