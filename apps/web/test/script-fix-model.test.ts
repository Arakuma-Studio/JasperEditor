// The pure part of the Fix Transcript UI (spec 17 scweb, apps/web/src/script-fix/model.ts): blockers, the Script
// drawer's summary, dry-run texts, the confidence label and rule, where a fix is heard, the marked words, the patch
// report, the manual-edit offer and the names carried into a transcription prompt — with fast-check properties for
// what reads untrusted data (marks, meta, results, prompt terms: never throw, bounded, deterministic).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	alignmentShares,
	categoryCountsText,
	confidenceOf,
	editOffer,
	estimateText,
	type FixInputs,
	fixBlocker,
	fixFrame,
	fixInputs,
	fixMarks,
	fixMetaOf,
	groupCountsText,
	MAX_PROMPT_TERMS,
	markedWords,
	patchReportOf,
	patchReportText,
	promptTerms,
	ruleLine,
	scriptSummary,
	scriptSummaryText,
	skipReasonsText,
} from '../src/script-fix/model.ts';
import { fixItems, fixSession, sec } from './script-fix-helpers.ts';

const inputs = (over: Partial<FixInputs> = {}): FixInputs => ({
	transcripts: 1,
	words: 10,
	languages: ['es'],
	script: { name: 'S', text: 'Hola' },
	settings: { sources: ['script', 'glossary'], scope: 'recordings', strictness: 'standard' },
	rejected: 0,
	hasInOut: false,
	...over,
});

describe('when Fix Transcript can run (SC-081)', () => {
	it('names the first thing to do', () => {
		const ok = [{ id: 'm', installed: true }];
		expect(fixBlocker(inputs({ transcripts: 0 }), ['script'], 3, ok)).toMatch(/no transcript/);
		expect(fixBlocker(inputs({ script: null }), ['script', 'glossary'], 0, ok)).toMatch(/Attach the video script/);
		expect(fixBlocker(inputs({ script: null }), ['script'], 4, ok)).toMatch(/No script is attached/);
		expect(fixBlocker(inputs(), ['glossary'], 0, ok)).toMatch(/glossary is empty/);
		expect(fixBlocker(inputs(), ['script'], 0, [{ id: 'm', installed: false }])).toMatch(/No speech model/);
		expect(fixBlocker(inputs(), ['script'], 0, [{ id: 'm', installed: false }], { forRun: false })).toBeNull();
		expect(fixBlocker(inputs(), ['script'], 0, null)).toBeNull();
		expect(fixBlocker(inputs({ script: null }), ['glossary'], 2, ok)).toBeNull();
	});

	it('reads what a sequence has: its media transcripts, script, settings and rejections', () => {
		const f = fixSession();
		const i = fixInputs(f.doc(), f.seq());
		expect(i).toMatchObject({ transcripts: 1, words: 10, languages: ['es'], script: null, rejected: 0 });
		expect(i.settings).toEqual({ strictness: 'standard', sources: ['script', 'glossary'], scope: 'recordings' });
	});
});

describe('texts', () => {
	it('the Script drawer summary (SC-002)', () => {
		const s = scriptSummary('INTRO\nHola Glimmerbox (risas) y más.\nOutro:\nAdiós.', 'es')!;
		expect(scriptSummaryText(s)).toMatch(/sections? · \d+ words read · 1 direction \(1 words\) and 2 headings skipped/);
		expect(scriptSummary('   ', 'es')).toBeNull();
	});

	it('dry-run counts, estimate and skipped subtitles', () => {
		expect(groupCountsText({ keep: 4, fix: 2, pending: 0, maybe: 1 })).toBe(
			'Fixes 2 · Maybe (offered unselected) 1 · Kept as transcribed 4',
		);
		expect(categoryCountsText({ other: 1, proper: 2 })).toBe('Names 2 · Other words 1');
		expect(estimateText({ seconds: 75.4, basis: 'measured' })).toMatch(/≈ 1 min 15 s .*measured/);
		expect(estimateText({ seconds: Number.NaN, basis: 'measured' })).toBeNull();
		expect(skipReasonsText([{ reason: 'edited' }, { reason: 'locked' }, { reason: 'edited' }])).toBe(
			'2 edited by hand, 1 on a locked track',
		);
		const shares = alignmentShares({
			perMedia: [
				{ name: 'a', words: 1, wordsInScope: 1, alignment: { transcriptTokens: 100, alignedShare: 0.9, offScriptShare: 0.1 } },
				{ name: 'b', words: 1, wordsInScope: 1, alignment: { transcriptTokens: 300, alignedShare: 0.5, offScriptShare: 0.3 } },
				{ name: 'c', words: 1, wordsInScope: 1, alignment: null },
			],
		} as never)!;
		expect(shares.aligned).toBeCloseTo(0.6, 6);
		expect(shares.offScript).toBeCloseTo(0.25, 6);
	});

	it('the confidence label from Δ_tok, with its rule', () => {
		expect(confidenceOf(0.2).level).toBe('high');
		expect(confidenceOf(-1.5).level).toBe('medium');
		expect(confidenceOf(-1.51).level).toBe('low');
		expect(confidenceOf(null)).toEqual({ level: 'none', label: 'No audio check' });
		expect(ruleLine({ deltaTok: -0.84, rule: 'spelling' }).rule).toBe(
			'Spelling rule: a name or English word that sounds alike · Δ −0.8 per token',
		);
		expect(ruleLine({ deltaTok: null, rule: 'glossary-spelling' }).rule).toMatch(/glossary/);
		expect(ruleLine({ deltaTok: 1, rule: 'new-rule' }).rule).toBe('new-rule · Δ +1.0 per token');
	});
});

describe('rows and marks (SC-082 / SC-083)', () => {
	it('reads the producer’s meta and finds where the fix is heard in the sequence', () => {
		const f = fixSession();
		const [fix] = fixItems(f.transcriptId, f.mediaId);
		const m = fixMetaOf(fix!.meta)!;
		expect(m).toMatchObject({ asr: ['Glimer', 'box'], script: ['Glimmerbox'], category: 'proper', deltaTok: 2.3 });
		expect(fixFrame(f.seq(), m)).toBe(30);
		expect(fixFrame(f.seq(), { ...m, start: sec(30) })).toBeNull(); // beyond the clip
		expect(fixFrame(f.seq(), { ...m, mediaId: 'other' })).toBeNull();
		expect(fixMetaOf(null)).toBeNull();
		expect(fixMetaOf({ asr: [], script: [] })).toBeNull();
	});

	it('marks the replaced words and, for an insertion, the word after the gap', () => {
		const f = fixSession();
		const items = fixItems(f.transcriptId, f.mediaId);
		const ins = {
			id: 'fix:4',
			meta: { ...(items[0]!.meta as object), asr: [], script: ['muy'] },
			commands: [
				{
					type: 'transcript.replaceWords',
					transcriptId: f.transcriptId,
					edits: [{ start: sec(2.6), end: sec(2.7), expect: [], words: [] }],
				},
			],
		};
		const marks = fixMarks([...items, ins], { 'fix:3': 'rejected' }).get(f.transcriptId)!;
		expect(marks.map((m) => m.itemId)).toEqual(['fix:1', 'fix:2', 'fix:4']);
		const words = f.doc().transcripts[f.transcriptId]!.words;
		const at = markedWords(words, marks);
		expect([...at.entries()].map(([i, m]) => [i, m.itemId])).toEqual([
			[2, 'fix:1'],
			[3, 'fix:1'],
			[5, 'fix:2'],
			[6, 'fix:2'],
			[7, 'fix:4'],
		]);
	});

	it('property: marks of arbitrary items and words never throw and stay in range', () => {
		const word = fc.tuple(fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e5 }));
		fc.assert(
			fc.property(
				fc.array(word, { maxLength: 60 }),
				fc.array(fc.anything(), { maxLength: 20 }),
				fc.array(fc.tuple(fc.integer({ min: -10, max: 1.2e6 }), fc.integer({ min: 0, max: 2e5 }), fc.boolean()), {
					maxLength: 20,
				}),
				(raw, junk, spans) => {
					let t = 0;
					const words = raw.map(([gap, len]) => {
						const start = t + gap;
						t = start + len;
						return { start, end: t };
					});
					const items = [
						...junk.map((j, i) => ({ id: `j${i}`, meta: j, commands: [j] })),
						...spans.map(([s, l, ins], i) => ({
							id: `s${i}`,
							meta: { asr: ins ? [] : ['x'], script: ['y'], start: s, end: s + l },
							commands: [{ type: 'transcript.replaceWords', transcriptId: 't', edits: [{ start: s, end: s + l, expect: ins ? [] : ['x'] }] }],
						})),
					];
					const marks = fixMarks(items as never, {});
					const at = markedWords(words, marks.get('t'));
					for (const i of at.keys()) expect(i >= 0 && i < words.length).toBe(true);
					expect(markedWords(words, marks.get('t'))).toEqual(at);
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe('the patch report (SC-053 / SC-084)', () => {
	it('sums the replaceWords results of a transaction, counting each clip once', () => {
		const r = patchReportOf(
			[
				{ transcriptId: 't', edits: 2, patched: [{ clipId: 'a', sequenceId: 's' }], skipped: [] },
				{
					transcriptId: 't',
					edits: 1,
					patched: [{ clipId: 'a', sequenceId: 's' }],
					skipped: [{ clipId: 'b', sequenceId: 's', kind: 'subtitle', reason: 'edited' }],
				},
				{ settings: {}, rejected: 3 },
				null,
			],
			3,
		);
		expect(r).toEqual({
			fixes: 3,
			edits: 3,
			patched: 1,
			skipped: [{ clipId: 'b', sequenceId: 's', kind: 'subtitle', reason: 'edited' }],
		});
		expect(patchReportText(r)).toBe('3 fixes applied · 1 subtitle not updated: edited by hand');
		expect(patchReportText({ ...r, fixes: 1, skipped: [] })).toBe('1 fix applied');
	});

	it('property: any results array gives a bounded, well-formed report', () => {
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 30 }), fc.integer({ min: -5, max: 500 }), (results, n) => {
				const r = patchReportOf(results, n);
				expect(r.fixes).toBeGreaterThanOrEqual(0);
				expect(r.edits).toBeGreaterThanOrEqual(0);
				expect(typeof patchReportText(r)).toBe('string');
			}),
			{ numRuns: 200 },
		);
	});
});

describe('the manual-edit offer (SC-071)', () => {
	it('offers the other occurrences and Remember; nothing for punctuation-only or empty edits', () => {
		const f = fixSession({
			words: [
				['Glimer', 0.2, 0.6],
				['hoy', 0.7, 0.9],
				['Glimer,', 1.0, 1.4],
				['fin', 1.5, 1.8],
			],
		});
		const o = editOffer(f.doc(), f.seqId, {
			oldWords: ['Glimer'],
			newText: 'Glimmer',
			transcriptId: f.transcriptId,
			start: sec(0.2),
			end: sec(0.6),
			language: 'es-ES',
		})!;
		expect(o).toMatchObject({ from: 'Glimer', to: 'Glimmer', lang: 'es', canRemember: true });
		// the edited span itself is never offered again; the other keeps its own comma
		expect(o.plan.occurrences.map((x) => x.edit.words.map((w) => w.text))).toEqual([['Glimmer,']]);
		const edited = editOffer(f.doc(), f.seqId, {
			oldWords: ['fin'],
			newText: 'fin.',
			transcriptId: f.transcriptId,
			start: sec(1.5),
			end: sec(1.8),
			language: 'es',
		});
		expect(edited).toBeNull();
		expect(
			editOffer(f.doc(), f.seqId, { oldWords: ['fin'], newText: '', transcriptId: f.transcriptId, start: 0, end: 1, language: null }),
		).toBeNull();
	});
});

describe('names carried into the transcription prompt (SC-074)', () => {
	const SCRIPT =
		'Hoy probamos Glimmerbox con el streaming de NovaPlay. Luego Glimmerbox otra vez, y el gameplay de Pixelforge en 2026.';

	it('takes the script’s names and English words in its spelling, most frequent first; numbers never', () => {
		expect(promptTerms(SCRIPT, 'es', 'off')).toEqual([]);
		const terms = promptTerms(SCRIPT, 'es', 'script');
		expect(terms[0]).toBe('Glimmerbox');
		expect(terms).toEqual(expect.arrayContaining(['NovaPlay', 'Pixelforge', 'streaming', 'gameplay']));
		expect(terms).not.toContain('2026');
		expect(terms).not.toContain('Hoy');
		expect(terms).not.toContain('Luego');
	});

	it('adds the glossary’s spellings for the language, ranked with their taught count', () => {
		const terms = promptTerms(SCRIPT, 'es', 'script+glossary', [
			{ to: 'Zyntro', count: 5 },
			{ to: 'Lumenly', lang: 'en', count: 9 },
			{ to: 'glimmerbox', count: 1 },
		]);
		expect(terms[0]).toBe('Zyntro');
		expect(terms).not.toContain('Lumenly');
		expect(terms.filter((x) => x.toLowerCase() === 'glimmerbox')).toEqual(['Glimmerbox']);
	});

	it('property: at most 40 terms of ≤ 64 characters, distinct, deterministic, never throws', () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 2000 }),
				fc.constantFrom('es', 'en', 'de', null),
				fc.array(fc.record({ to: fc.string({ maxLength: 80 }), count: fc.integer({ min: 0, max: 99 }) }), {
					maxLength: 60,
				}),
				(text, lang, glossary) => {
					const a = promptTerms(text, lang, 'script+glossary', glossary);
					expect(a.length).toBeLessThanOrEqual(MAX_PROMPT_TERMS);
					for (const x of a) expect([...x].length).toBeLessThanOrEqual(64);
					expect(new Set(a.map((x) => x.toLowerCase().replace(/\s+/g, ''))).size).toBe(a.length);
					expect(promptTerms(text, lang, 'script+glossary', glossary)).toEqual(a);
				},
			),
			{ numRuns: 150 },
		);
	});
});
