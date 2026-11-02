// Spec 19 TL-111 and TL-093: vertical writing, styled runs and their persistence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyRunPatch,
	clearRuns,
	normalizeTextRuns,
	remapParagraphs,
	remapTextRuns,
	repairTextWriting,
	type TextRun,
	tateChuYokoRanges,
	textEditSpan,
	textWritingIssues,
} from '../src/index.ts';

const vertical = (text: string, tateChuYoko?: boolean) => ({
	text,
	writingMode: 'vertical' as const,
	...(tateChuYoko === undefined ? {} : { tateChuYoko }),
});
const shown = (text: string) => tateChuYokoRanges(vertical(text)).map((r) => text.slice(r.from, r.to));

describe('tate-chu-yoko ranges (TL-111)', () => {
	it('sets 1 to 3 half-width characters among full-width ones upright', () => {
		expect(shown('12月3日')).toEqual(['12', '3']);
		expect(shown('第100回')).toEqual(['100']);
		expect(shown('OK')).toEqual(['OK']);
		expect(shown('やった!?')).toEqual(['!?']);
	});

	it('leaves longer runs and Latin phrases on their side', () => {
		expect(shown('2026年')).toEqual([]);
		expect(shown('GO TO IT')).toEqual([]);
		expect(shown('A B')).toEqual([]);
	});

	it('treats a line break as a paragraph edge', () => {
		expect(shown('12\n34\nABCD')).toEqual(['12', '34']);
	});

	it('is off for horizontal text and on request', () => {
		expect(tateChuYokoRanges({ text: '12月' })).toEqual([]);
		expect(tateChuYokoRanges({ text: '12月', writingMode: 'horizontal' })).toEqual([]);
		expect(tateChuYokoRanges(vertical('12月', false))).toEqual([]);
	});

	it('gives sorted, disjoint, in-range ranges of at most 3 (fuzz)', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), (text) => {
				let last = 0;
				for (const r of tateChuYokoRanges(vertical(text))) {
					expect(r.from).toBeGreaterThanOrEqual(last);
					expect(r.to).toBeLessThanOrEqual(text.length);
					expect(r.to - r.from).toBeGreaterThan(0);
					expect(r.to - r.from).toBeLessThanOrEqual(3);
					last = r.to;
				}
			}),
		);
	});
});

describe('writing fields are read leniently', () => {
	it('reports and removes unreadable values, and leaves good ones', () => {
		const bad = { writingMode: 'sideways', tateChuYoko: 'yes', runs: [{ finish: 3 }] };
		expect(textWritingIssues(bad)).toHaveLength(3);
		expect(repairTextWriting(bad)).toHaveLength(3);
		expect(bad).toEqual({ runs: [{}] });
		expect(repairTextWriting(bad)).toEqual([]);
		const good = { writingMode: 'vertical', tateChuYoko: false, runs: [{ finish: 'metal' }] };
		expect(textWritingIssues(good)).toEqual([]);
		expect(repairTextWriting(good)).toEqual([]);
	});

	it('survives anything (fuzz)', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const before = JSON.stringify(v);
				const copy = before === undefined ? v : JSON.parse(before);
				repairTextWriting(copy);
				expect(textWritingIssues(copy)).toEqual([]);
			}),
		);
	});
});

const run = (from: number, to: number, style: TextRun['style'], finish?: string): TextRun => ({
	from,
	to,
	style,
	...(finish ? { finish } : {}),
});
const BOLD = { weight: 700 };
const RED = { fill: [1, 0, 0, 1] as [number, number, number, number] };

describe('styled runs (TL-093)', () => {
	it('flattens overlaps, later wins, and joins equal neighbours', () => {
		expect(
			normalizeTextRuns('abcdef', [run(0, 4, { weight: 700 }), run(2, 6, { weight: 300 }), run(5, 90, {})]),
		).toEqual([run(0, 2, { weight: 700 }), run(2, 6, { weight: 300 })]);
		expect(normalizeTextRuns('abcdef', [run(0, 2, BOLD), run(2, 4, BOLD)])).toEqual([run(0, 4, BOLD)]);
	});

	it('removes overrides equal to the base style', () => {
		expect(normalizeTextRuns('abc', [run(0, 3, { weight: 400, italic: true })], { weight: 400 })).toEqual([
			run(0, 3, { italic: true }),
		]);
		expect(normalizeTextRuns('abc', [run(0, 3, { weight: 400 })], { weight: 400 })).toEqual([]);
	});

	it('applies a patch over part of a run without losing the rest of it', () => {
		const out = applyRunPatch('abcdefgh', [run(1, 6, BOLD)], 3, 7, { style: RED });
		expect(out).toEqual([run(1, 3, BOLD), run(3, 6, { ...RED, ...BOLD }), run(6, 7, RED)]);
	});

	it('sets and clears a per-letter finish on the same runs', () => {
		const a = applyRunPatch('title', undefined, 0, 1, { finish: 'metal' });
		expect(a).toEqual([run(0, 1, {}, 'metal')]);
		const b = applyRunPatch('title', a, 0, 3, { style: BOLD });
		expect(b).toEqual([run(0, 1, BOLD, 'metal'), run(1, 3, BOLD)]);
		expect(applyRunPatch('title', b, 0, 5, { finish: null })[0]).toEqual(run(0, 3, BOLD));
	});

	it('clears a range', () => {
		expect(clearRuns('abcdefgh', [run(0, 8, BOLD)], 2, 4)).toEqual([run(0, 2, BOLD), run(4, 8, BOLD)]);
	});

	it('finds the span of an edit', () => {
		expect(textEditSpan('hello', 'help')).toEqual({ at: 3, oldEnd: 5, newEnd: 4 });
		expect(textEditSpan('aaa', 'aaaa')).toEqual({ at: 3, oldEnd: 3, newEnd: 4 });
	});

	it('carries runs over typing like a word processor', () => {
		const runs = [run(2, 5, BOLD)];
		// Before the run: it moves.
		expect(remapTextRuns('abcdefg', 'xabcdefg', runs)).toEqual([run(3, 6, BOLD)]);
		// Inside and right after: it grows.
		expect(remapTextRuns('abcdefg', 'abcXdefg', runs)).toEqual([run(2, 6, BOLD)]);
		expect(remapTextRuns('abcdefg', 'abcdeXfg', runs)).toEqual([run(2, 6, BOLD)]);
		// After it: nothing.
		expect(remapTextRuns('abcdefg', 'abcdefgX', runs)).toEqual(runs);
		// At the start of the text, before a run that starts there: it grows.
		expect(remapTextRuns('abc', 'Xabc', [run(0, 2, BOLD)])).toEqual([run(0, 3, BOLD)]);
		// Replacing the run's letters keeps its style on the new ones; deleting them drops it.
		expect(remapTextRuns('abcdefg', 'abXfg', runs)).toEqual([run(2, 3, BOLD)]);
		expect(remapTextRuns('abcdefg', 'abfg', runs)).toEqual([]);
	});

	it('keeps runs valid across any edit (fuzz)', () => {
		const text = fc.string({ maxLength: 24 });
		fc.assert(
			fc.property(
				text,
				text,
				fc.array(fc.tuple(fc.nat(30), fc.nat(30)), { maxLength: 5 }),
				(prev, next, spans) => {
					const runs = normalizeTextRuns(
						prev,
						spans.map(([a, b]) => run(Math.min(a, b), Math.max(a, b), BOLD)),
					);
					for (const r of remapTextRuns(prev, next, runs)) {
						expect(r.from).toBeGreaterThanOrEqual(0);
						expect(r.to).toBeGreaterThan(r.from);
						expect(r.to).toBeLessThanOrEqual(next.length);
					}
				},
			),
		);
	});

	it('keeps paragraph overrides with their text', () => {
		const p = [{ index: 2, style: { align: 'right' as const } }];
		expect(remapParagraphs('a\nb\nc', 'a\nx\nb\nc', p)).toEqual([{ index: 3, style: { align: 'right' } }]);
		expect(remapParagraphs('a\nb\nc', 'a\nbc', p)).toEqual([]);
		expect(remapParagraphs('a\nb\nc', 'ax\nb\nc', p)).toEqual(p);
	});
});

describe('schema v12 fixture', () => {
	it('carries the text fields', () => {
		const raw = readFileSync(join(__dirname, 'fixtures', 'schema-v12.jasper'), 'utf8');
		expect(raw).toContain('"writingMode": "vertical"');
		expect(raw).toContain('"tateChuYoko": false');
		expect(raw).toContain('"finish": "flat"');
	});
});
