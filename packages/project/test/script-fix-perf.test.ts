// Spec 17 SC-015 budget in the test gate (load-tolerant, scripts/perf/budget.ts): a 2 h synthetic transcript
// (20,000 words) against a 6,000-token script aligns, and yields its candidates, within 5 s on the reference machine.
// Memory and exact timings: packages/project/bench/script-fix.ts (docs/wp-notes/script-correction.md "Model").
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport } from '../../../scripts/perf/budget.ts';
import { alignTranscript } from '../src/script-fix/align.ts';
import { findFixCandidates } from '../src/script-fix/candidates.ts';
import { parseScript } from '../src/script-fix/script.ts';
import { synthScriptFix } from './script-fix-synth.ts';

describe('script-fix performance (SC-015)', () => {
	it('2 h transcript × 6,000-token script within the 5 s budget', () => {
		const { scriptText, words } = synthScriptFix();
		const script = parseScript(scriptText, { language: 'es' });
		expect(script.tokens.length).toBeGreaterThanOrEqual(6000);
		expect(words.length).toBe(20_000);
		const t0 = performance.now();
		const a = alignTranscript({ words, script, language: 'es', mediaId: 'm', transcriptId: 't' });
		if (!a.ok) throw new Error(a.message);
		const res = findFixCandidates({ mediaId: 'm', transcriptId: 't', words, script, alignment: a });
		const ms = performance.now() - t0;
		const budget = budgetMs(5000);
		console.log(budgetReport('script-fix 2 h', ms, 5000));
		expect(a.report.cappedRows).toBe(0);
		expect(a.report.alignedShare).toBeGreaterThan(0.6);
		expect(res.candidates.length).toBeGreaterThan(50);
		expect(ms).toBeLessThan(budget);
	});

	it('degenerate input (one word repeated) stays bounded: capped rows, no refusal', () => {
		const script = parseScript(Array.from({ length: 3000 }, () => 'la').join(' '), { language: 'es' });
		const words = Array.from({ length: 6000 }, (_, k) => ({
			text: 'la',
			start: k * 1000,
			end: k * 1000 + 900,
		}));
		const t0 = performance.now();
		const a = alignTranscript({ words, script, language: 'es' });
		const ms = performance.now() - t0;
		console.log(budgetReport('script-fix degenerate 6,000 × 3,000', ms, 5000));
		expect(a.ok).toBe(true);
		if (!a.ok) return;
		expect(a.report.cappedRows).toBeGreaterThan(0);
		expect(a.report.storedCells).toBeLessThanOrEqual(6000 * 1024);
		expect(ms).toBeLessThan(budgetMs(5000));
	});
});
