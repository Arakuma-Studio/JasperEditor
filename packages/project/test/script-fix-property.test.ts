// Properties of the script-correction model (spec 17 SC-100, fast-check): the parser and aligner never throw on
// arbitrary text and are deterministic; inputs over the SC-015 bounds are refused with E_LIMIT; the banded aligner
// finds the same best path as the dense prototype port; candidates sit between anchors and never delete ASR words or
// touch numbers; psim is symmetric and in [0, 1].
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanupNorm } from '../src/cleanup/lists.ts';
import { ALIGN_DEFAULTS, type AlignStep, alignCore, alignTranscript } from '../src/script-fix/align.ts';
import { findFixCandidates } from '../src/script-fix/candidates.ts';
import { candidateScores, decideFix, replaceWordsEdit } from '../src/script-fix/decide.ts';
import { psim } from '../src/script-fix/phonetic.ts';
import { parseScript } from '../src/script-fix/script.ts';
import { buildScoreWindows, type ScoreWindowResult } from '../src/script-fix/windows.ts';
import { referenceAlign } from './script-fix-reference.ts';

const VOCAB = [
	'hoy',
	'vamos',
	'a',
	'crear',
	'un',
	'juego',
	'de',
	'carreras',
	'carrera',
	'la',
	'el',
	'carretera',
	'serradas',
	'cerradas',
	'Pixelforge',
	'pixel',
	'forge',
	'Glimmerbox',
	'glimmer',
	'box',
	'nova',
	'play',
	'NovaPlay',
	'y',
	'&',
	'24',
	'veinticuatro',
	'una',
	'1',
	'(risas)',
	'INTRO',
	'fin:',
	'bueno',
	'eh',
	'Peeerfecto',
	'física',
	'físicas',
];

const words = (n: number) => fc.array(fc.constantFrom(...VOCAB), { maxLength: n });
const anyText = fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: 'grapheme', maxLength: 200 }));
const lines = (n: number) =>
	fc
		.array(fc.tuple(words(10), fc.constantFrom('', '.', ':', '\n', '\n\n')), { maxLength: n })
		.map((parts) => parts.map(([ws, end]) => ws.join(' ') + end).join(' '));
const timed = (ws: string[]) =>
	ws.map((text, k) => ({ text, start: k * 3_000_000, end: k * 3_000_000 + 2_000_000 }));

/** Each transcript token is covered exactly once, in order, by cells / insertions / off steps. */
function coversInOrder(steps: readonly AlignStep[], T: number, S: number): boolean {
	let next = 0;
	for (const s of steps) {
		if (s.kind === 'cell' || s.kind === 'ins' || s.kind === 'off') {
			if (s.t[0] !== next || s.t[1] < s.t[0]) return false;
			next = s.t[1] + 1;
		}
		if (s.kind === 'cell' || s.kind === 'skip')
			if (s.s[0] < 0 || s.s[1] >= S || s.s[1] < s.s[0]) return false;
	}
	return next === T;
}

describe('script-fix properties (SC-100)', () => {
	it('parseScript never throws, tokens are non-empty and whitespace-free, deterministic', () => {
		fc.assert(
			fc.property(fc.oneof(anyText, lines(12)), fc.constantFrom('es', 'en', 'fr', null), (text, lang) => {
				const a = parseScript(text, { language: lang });
				expect(parseScript(text, { language: lang })).toEqual(a);
				for (const t of a.tokens) {
					expect(t.norm).toMatch(/^[a-z0-9]+$/);
					expect(t.text).not.toMatch(/\s/);
				}
				expect(a.summary.tokens).toBe(a.tokens.length);
			}),
		);
	});

	it('alignTranscript and findFixCandidates never throw on arbitrary text and are deterministic', () => {
		fc.assert(
			fc.property(
				fc.oneof(anyText, lines(8)),
				fc.array(fc.oneof(fc.constantFrom(...VOCAB), fc.string({ maxLength: 12 })), { maxLength: 60 }),
				fc.constantFrom('es', 'en', 'de', null),
				(text, ws, lang) => {
					const script = parseScript(text, { language: lang });
					const w = timed(ws);
					const a = alignTranscript({ words: w, script, language: lang });
					expect(alignTranscript({ words: w, script, language: lang })).toEqual(a);
					expect(a.ok).toBe(true);
					if (!a.ok) return;
					expect(coversInOrder(a.steps, a.tokens.length, script.tokens.length)).toBe(true);
					const c1 = findFixCandidates({
						mediaId: 'm',
						transcriptId: 't',
						words: w,
						script,
						alignment: a,
						language: lang,
					});
					expect(
						findFixCandidates({
							mediaId: 'm',
							transcriptId: 't',
							words: w,
							script,
							alignment: a,
							language: lang,
						}),
					).toEqual(c1);
				},
			),
		);
	});

	it('inputs over the SC-015 bounds are refused with E_LIMIT', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 30 }), (nt, ns) => {
				const script = parseScript(Array.from({ length: ns }, (_, k) => `palabra${k}`).join(' '));
				const w = timed(Array.from({ length: nt }, (_, k) => `palabra${k}`));
				const r = alignTranscript({
					words: w,
					script,
					options: { maxTranscriptWords: 15, maxScriptTokens: 15 },
				});
				if (nt > 15 || ns > 15) expect(r).toMatchObject({ ok: false, code: 'E_LIMIT' });
				else expect(r.ok).toBe(true);
			}),
		);
		expect(ALIGN_DEFAULTS.maxTranscriptWords).toBe(200_000);
		expect(ALIGN_DEFAULTS.maxScriptTokens).toBe(60_000);
	});

	it('the banded aligner finds the dense prototype port’s best path', () => {
		const small = fc.array(fc.constantFrom(...VOCAB), { minLength: 1, maxLength: 28 });
		fc.assert(
			fc.property(small, small, fc.constantFrom('es', 'en', null), (sw, tw, lang) => {
				const script = parseScript(sw.join(' '), { language: lang });
				const tn = tw.map(cleanupNorm).filter(Boolean);
				const sn = script.tokens.map((t) => t.norm);
				const dir = script.tokens.map((t) => t.kind !== 'word');
				if (!tn.length || !sn.length) return;
				const fast = alignCore(tn, sn, dir, script.language, { ...ALIGN_DEFAULTS });
				const ref = referenceAlign(tn, sn, dir, script.language, { ...ALIGN_DEFAULTS });
				expect(fast.ok).toBe(true);
				if (!fast.ok) return;
				expect(fast.score).toBeCloseTo(ref.score, 9);
				expect(fast.steps).toEqual(ref.steps);
			}),
			{ numRuns: 300 },
		);
	});

	it('candidates sit between exact anchors, never delete ASR words, never touch numbers', () => {
		fc.assert(
			fc.property(lines(6), words(50), (text, ws) => {
				const script = parseScript(text, { language: 'es' });
				const w = timed(ws);
				const a = alignTranscript({ words: w, script, language: 'es' });
				if (!a.ok) return;
				const res = findFixCandidates({ mediaId: 'm', transcriptId: 't', words: w, script, alignment: a });
				const exactWord = new Set<number>();
				for (const s of a.steps)
					if (s.kind === 'cell' && s.exact)
						for (let i = s.t[0]; i <= s.t[1]; i++) exactWord.add(a.tokens[i]!.word);
				for (const c of res.candidates) {
					expect(['sub', 'merge', 'del', 'join', 'glossary']).toContain(c.kind);
					expect([...c.asr, ...c.script, ...c.scriptSource].some((x) => /\d/.test(x))).toBe(false);
					expect(c.script.length).toBeGreaterThan(0);
					for (const x of c.script) expect(x).not.toMatch(/\s/);
					if (c.kind === 'del') expect(c.asr).toEqual([]);
					else expect(c.asr.length).toBeGreaterThan(0);
					if (c.kind === 'join' || c.mixed) continue;
					// the nearest aligned words outside the region are exact anchors
					const before = a.tokens.filter((t) => t.word < c.fromWord).pop();
					const after = a.tokens.find((t) => t.word >= c.toWord);
					expect(before && exactWord.has(before.word)).toBe(true);
					expect(after && exactWord.has(after.word)).toBe(true);
					expect(c.toWord - c.fromWord).toBeLessThanOrEqual(ALIGN_DEFAULTS.maxRegionTranscript);
					expect(c.scriptTo! - c.scriptFrom!).toBeLessThanOrEqual(ALIGN_DEFAULTS.maxRegionScript);
				}
			}),
		);
	});

	it('psim is symmetric and in [0, 1]', () => {
		const norm = fc.string({ maxLength: 14 }).map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''));
		fc.assert(
			fc.property(norm, norm, fc.constantFrom('es', 'en', null), (a, b, lang) => {
				const x = psim(a, b, lang);
				expect(x).toBe(psim(b, a, lang));
				expect(x).toBeGreaterThanOrEqual(0);
				expect(x).toBeLessThanOrEqual(1);
				if (a === b) expect(x).toBe(1);
			}),
			{ numRuns: 500 },
		);
	});

	it('fix edits leave the transcript sorted and non-overlapping; new words last ≥ 1 flick when the span allows', () => {
		const NAMES = 'casa perro gato mesa silla libro arbol nube fuego agua tierra viento luna'.split(' ');
		let widened = 0;
		let inGap = 0;
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gap: fc.oneof(
							fc.constant(0),
							fc.integer({ min: 0, max: 60_000_000 }),
							fc.integer({ max: 900_000_000, min: 0 }),
						),
						dur: fc.integer({ min: 1, max: 400_000_000 }),
					}),
					{ minLength: 6, maxLength: 13 },
				),
				fc.integer({ min: 2, max: 12 }),
				fc.constantFrom('del', 'sub', 'end'),
				fc.array(fc.tuple(fc.integer({ min: -1e9, max: 2e10 }), fc.integer({ min: -1e9, max: 2e10 })), {
					minLength: 16,
					maxLength: 16,
				}),
				(layout, at, mode, dtw) => {
					let t = 100_000_000;
					const words = layout.map((x, k) => {
						t += x.gap;
						const w = { text: NAMES[k]!, start: t, end: t + x.dur, confidence: 0.5 };
						t += x.dur;
						return w;
					});
					const p = Math.min(at, words.length - 1);
					const scriptWords = words.map((w) => w.text);
					if (mode === 'del') scriptWords.splice(p, 0, 'zorro');
					else if (mode === 'sub') scriptWords[p] = 'zorra';
					else scriptWords.push('zorro'); // a word the speaker dropped at the very end: no right anchor
					const script = parseScript(scriptWords.join(' '), { language: 'es' });
					if (mode === 'sub') words[p]!.text = 'zorro';
					const a = alignTranscript({ words, script, language: 'es' });
					if (!a.ok) return;
					const { candidates } = findFixCandidates({
						mediaId: 'm',
						transcriptId: 't',
						words,
						script,
						alignment: a,
					});
					const { windows } = buildScoreWindows(words, candidates);
					// fake scores: every candidate reading wins; forced times arbitrary (overlapping, outside, reversed)
					const results: ScoreWindowResult[] = windows.map((w) => ({
						id: w.id,
						readings: w.readings.map((rd) => ({
							id: rd.id,
							logprob: rd.id === 'asr' ? -100 : -1,
							tokens: rd.words.length,
							words: rd.words.map((text, i) => ({
								text,
								tokens: 1,
								logprob: -1,
								probability: 0.5,
								start: dtw[i % dtw.length]![0],
								end: dtw[i % dtw.length]![1],
							})),
						})),
					}));
					const scores = candidateScores(windows, results);
					for (const c of candidates) {
						const d = decideFix(c, scores.get(c.id));
						const edit = replaceWordsEdit(c, d);
						if (!edit) continue;
						// the transcript words the edit names: those overlapping [start, end)
						const hit = words.filter((w) => w.start < edit.end && w.end > edit.start);
						expect(hit.map((w) => w.text)).toEqual(edit.expect);
						const after = [...words.filter((w) => !hit.includes(w)), ...edit.words].sort(
							(x, y) => x.start - y.start || x.end - y.end,
						);
						for (let k = 1; k < after.length; k++)
							expect(after[k]!.start).toBeGreaterThanOrEqual(after[k - 1]!.end);
						const room = edit.end - edit.start >= edit.words.length;
						for (const w of edit.words) {
							expect(w.text).not.toMatch(/\s/);
							expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true);
							expect(w.start).toBeGreaterThanOrEqual(edit.start);
							expect(w.end).toBeLessThanOrEqual(edit.end);
							if (room) expect(w.end - w.start).toBeGreaterThanOrEqual(1);
						}
						if (c.anchor) expect(edit.words.map((w) => w.text)).toContain(c.anchor.text);
						if (c.kind === 'del') {
							if (c.anchor) widened++;
							else inGap++;
						}
					}
				},
			),
			{ numRuns: 300 },
		);
		// both del paths were exercised
		expect(widened).toBeGreaterThan(0);
		expect(inGap).toBeGreaterThan(0);
	});
});
