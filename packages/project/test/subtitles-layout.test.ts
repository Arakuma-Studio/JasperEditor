// Spec 13 AS-002 / AS-010 / AS-013: subtitle layout — rules, text transforms, Spanish line breaks and the cut-aware
// algorithm (unit tests on hand-built words and cuts, plus fast-check properties).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	breakLines,
	type CutEvent,
	DEFAULT_CUT_AWARE,
	FLICKS_PER_SECOND,
	GENERIC_SUBTITLE_TEXT,
	type LayoutWord,
	layoutSubtitles,
	PIXEL_POP_RULES,
	type Rational,
	resolveCutAware,
	resolveSubtitleRules,
	resolveSubtitleText,
	transformWords,
	weakWordsFor,
	workCaptionText,
} from '../src/index.ts';

const R60: Rational = { num: 60, den: 1 };
const RATES: [string, Rational][] = [
	['23.976', { num: 24000, den: 1001 }],
	['25', { num: 25, den: 1 }],
	['29.97', { num: 30000, den: 1001 }],
	['59.94', { num: 60000, den: 1001 }],
	['60', { num: 60, den: 1 }],
];
const Fof = (r: Rational) => Math.round((FLICKS_PER_SECOND * r.den) / r.num);

/** Words from `[text, startFrame, endFrame]` at `rate` (exact frame boundaries). */
function words(list: Array<[string, number, number, string?]>, rate: Rational = R60): LayoutWord[] {
	const F = Fof(rate);
	return list.map(([text, a, b, speaker]) => ({ text, start: a * F, end: b * F, speaker: speaker ?? null }));
}

function lay(
	ws: LayoutWord[],
	opts: {
		rules?: Parameters<typeof resolveSubtitleRules>[0];
		base?: Parameters<typeof resolveSubtitleRules>[1];
		cuts?: CutEvent[] | null;
		rate?: Rational;
		text?: Parameters<typeof resolveSubtitleText>[0];
		cutAware?: Parameters<typeof resolveCutAware>[0];
		language?: string;
		limit?: { start: number; end: number };
	} = {},
) {
	return layoutSubtitles({
		words: ws,
		rules: resolveSubtitleRules(opts.rules, opts.base),
		text: resolveSubtitleText(opts.text),
		language: opts.language ?? 'en',
		rate: opts.rate ?? R60,
		cuts: opts.cuts === undefined ? null : opts.cuts,
		cutAware: resolveCutAware(opts.cutAware),
		...(opts.limit ? { limit: opts.limit } : {}),
	});
}
const spans = (r: ReturnType<typeof lay>) => r.captions.map((c) => [c.start, c.end, workCaptionText(c)]);

describe('rules (AS-002)', () => {
	it('fills lines up to the character limit, two lines by default', () => {
		const r = lay(
			words([
				['one', 0, 10],
				['two', 10, 20],
				['three', 20, 30],
			]),
			{ rules: { maxChars: 8, lines: 2 } },
		);
		expect(spans(r)).toEqual([[0, 60, 'one two\nthree']]);
	});
	it('maximum words per subtitle and the minimum duration into the silence after it', () => {
		const r = lay(
			words([
				['a', 0, 5],
				['b', 5, 10],
				['c', 10, 15],
				['d', 15, 20],
			]),
			{ rules: { maxWords: 3, minSeconds: 0.1 } },
		);
		expect(spans(r)).toEqual([
			[0, 15, 'a b c'],
			[15, 21, 'd'],
		]);
	});
	it('breaks at a pause, at a speaker change and after the maximum duration', () => {
		const r = lay(
			words([
				['hello', 0, 30],
				['there', 120, 150],
				['friend', 150, 180, 'B'],
			]),
			{ rules: { breakPauseSeconds: 1, minSeconds: 0.1 } },
		);
		expect(r.captions.map(workCaptionText)).toEqual(['hello', 'there', 'friend']);
		const long = lay(
			words(Array.from({ length: 12 }, (_, i) => [`w${i}`, i * 60, i * 60 + 50] as [string, number, number])),
			{ rules: { maxSeconds: 2, maxChars: 72, lines: 3, minSeconds: 0.1 } },
		);
		for (const c of long.captions)
			expect(c.words[c.words.length - 1]!.end - c.words[0]!.start).toBeLessThanOrEqual(2 * FLICKS_PER_SECOND);
	});
	it('punctuation: never / once half full / always (commas too)', () => {
		const ws = words([
			['Hi,', 0, 10],
			['you', 10, 20],
			['there.', 20, 30],
			['Next', 30, 40],
		]);
		expect(lay(ws, { rules: { punctuation: 'never', maxChars: 42, minSeconds: 0.1 } }).captions).toHaveLength(
			1,
		);
		expect(
			lay(ws, { rules: { punctuation: 'half', maxChars: 10, lines: 1, minSeconds: 0.1 } }).captions.map(
				workCaptionText,
			),
		).toEqual(['Hi, you', 'there.', 'Next']);
		expect(
			lay(ws, { rules: { punctuation: 'always', minSeconds: 0.1 } }).captions.map(workCaptionText),
		).toEqual(['Hi,', 'you there.', 'Next']);
	});
	it('a gap between subtitles and a hold until the next one (up to X s)', () => {
		const ws = words([
			['a', 0, 10],
			['b', 40, 50],
			['c', 200, 210],
		]);
		const r = lay(ws, { rules: { breakPauseSeconds: 0.3, minSeconds: 0.1, holdSeconds: 0.5, gapFrames: 2 } });
		expect(spans(r)).toEqual([
			[0, 38, 'a'],
			[40, 80, 'b'],
			[200, 240, 'c'],
		]);
	});
	it('the Pixel Pop defaults make 1–3 word, one-line subtitles of at most 13 characters', () => {
		const text = 'Hoy hice el juego de Doors en 24 horas y con RTX y puedes ir a descargarlo ya mismo!'.split(
			' ',
		);
		const ws = words(text.map((t, i) => [t, i * 12, i * 12 + 10] as [string, number, number]));
		const r = lay(ws, { base: PIXEL_POP_RULES, language: 'es' });
		for (const c of r.captions) {
			expect(c.words.length).toBeLessThanOrEqual(3);
			expect(workCaptionText(c)).not.toContain('\n');
			if (c.words.length > 1) expect([...workCaptionText(c)].length).toBeLessThanOrEqual(13);
		}
	});
});

describe('text transforms (AS-002) and line breaking (AS-042)', () => {
	it('case, glyph replacement (only missing glyphs), profanity', () => {
		const t = (opts: Partial<typeof GENERIC_SUBTITLE_TEXT>, list: string[]) =>
			transformWords(list, { ...GENERIC_SUBTITLE_TEXT, ...opts }, 'es');
		expect(t({ case: 'upper' }, ['ñandú', 'hola'])).toEqual(['ÑANDÚ', 'HOLA']);
		expect(t({ case: 'sentence' }, ['HOLA.', 'QUÉ', 'TAL?', 'bien'])).toEqual([
			'Hola.',
			'Qué',
			'tal?',
			'Bien',
		]);
		expect(t({ replaceGlyphs: true }, ['“Hola…”', '—sí'])).toEqual(['"Hola..."', '-sí']);
		expect(t({ replaceGlyphs: true, missingGlyphs: '…' }, ['“Hola…”'])).toEqual(['“Hola...”']);
		expect(t({ profanity: { words: ['mierda'], mask: 'first-letter' } }, ['¡Mierda!', 'bien'])).toEqual([
			'¡M*****!',
			'bien',
		]);
	});
	it('strips trailing punctuation per subtitle', () => {
		const r = lay(
			words([
				['Hola,', 0, 10],
				['amigos!', 10, 20],
			]),
			{ text: { stripTrailingPunctuation: true }, rules: { punctuation: 'never' } },
		);
		expect(workCaptionText(r.captions[0]!)).toBe('Hola, amigos');
	});
	it('Spanish: a line or a one-line subtitle does not end on an article or preposition when avoidable', () => {
		const weak = weakWordsFor('es-AR');
		expect(breakLines(['Hice', 'el', 'juego', 'de', 'Doors'], 16, 2, weak)).toEqual([3]);
		expect(breakLines(['Hice', 'el', 'juego', 'de', 'Doors'], 16, 2, null)).toEqual([4]);
		const r = lay(
			words(
				['Hice', 'el', 'juego', 'de', 'Doors', 'en', '24', 'horas'].map(
					(t, i) => [t, i * 10, i * 10 + 9] as [string, number, number],
				),
			),
			{ base: PIXEL_POP_RULES, language: 'es' },
		);
		for (const c of r.captions.slice(0, -1))
			expect(['de', 'el', 'en']).not.toContain(c.words[c.words.length - 1]!.text);
	});
});

describe('cut awareness (AS-010 / AS-013)', () => {
	const ca = { lookBackSeconds: 0.5, lookAheadSeconds: 0.05 };
	it('splits a subtitle with words on both sides of a cut', () => {
		const r = lay(
			words([
				['one', 0, 20],
				['two', 20, 40],
				['three', 45, 70],
			]),
			{
				cuts: [{ frame: 42 }],
				rules: { minSeconds: 0.1 },
				cutAware: ca,
			},
		);
		expect(spans(r)).toEqual([
			[0, 42, 'one two'],
			[42, 70, 'three'],
		]);
		expect(r.stats.splitAtCuts).toBe(1);
		expect(r.stats.crossing).toBe(0);
	});
	it('moves the start to a cut when all words come after it (the 27-frame case) and ends on a cut', () => {
		const r = lay(
			words([
				['hello', 30, 50],
				['world', 50, 70],
			]),
			{
				cuts: [{ frame: 33 }],
				rules: { minSeconds: 0.1, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		expect(r.captions[0]!.start).toBe(33);
		const e = lay(words([['hold', 0, 20]]), {
			cuts: [{ frame: 25 }],
			rules: { minSeconds: 1, holdSeconds: 2 },
			cutAware: ca,
		});
		expect(spans(e)).toEqual([[0, 25, 'hold']]);
	});
	it('a word straddling a cut goes to the side holding most of it; several cuts in one word', () => {
		const r = lay(
			words([
				['a', 0, 10],
				['bbbbbb', 10, 30],
			]),
			{ cuts: [{ frame: 13 }], rules: { minSeconds: 0.1 }, cutAware: ca },
		);
		expect(spans(r)).toEqual([
			[0, 13, 'a'],
			[13, 30, 'bbbbbb'],
		]);
		const m = lay(words([['long', 0, 60]]), {
			cuts: [{ frame: 10 }, { frame: 20 }, { frame: 50 }],
			rules: { minSeconds: 0.1 },
			cutAware: ca,
		});
		expect(spans(m)).toEqual([[20, 50, 'long']]);
	});
	it('starts on a cut up to the look-back before it (the previous subtitle ends there)', () => {
		const r = lay(
			words([
				['a', 0, 18],
				['b', 40, 60],
			]),
			{
				cuts: [{ frame: 30 }],
				rules: { minSeconds: 0.1, holdSeconds: 2, breakPauseSeconds: 0.2 },
				cutAware: ca,
			},
		);
		expect(spans(r)).toEqual([
			[0, 30, 'a'],
			[30, 180, 'b'],
		]);
		expect(r.stats.snappedToCuts).toBe(1);
		// beyond the look-back: no snap
		const far = lay(
			words([
				['a', 0, 5],
				['b', 70, 80],
			]),
			{ cuts: [{ frame: 30 }], rules: { minSeconds: 0.1 }, cutAware: ca },
		);
		expect(far.captions[1]!.start).toBe(70);
	});
	it('look ahead: a start just before a cut moves to the cut', () => {
		const r = lay(
			words([
				['a', 100, 101],
				['b', 101, 140],
			]),
			{ cuts: [{ frame: 102 }], rules: { minSeconds: 0.1 }, cutAware: ca },
		);
		expect(r.captions[0]!.start).toBe(102);
		expect(r.captions).toHaveLength(1);
	});
	it('a cut on the first or the last frame of a subtitle', () => {
		const first = lay(words([['x', 30, 60]]), {
			cuts: [{ frame: 30 }],
			rules: { minSeconds: 0.1 },
			cutAware: ca,
		});
		expect(spans(first)).toEqual([[30, 60, 'x']]);
		const last = lay(words([['x', 30, 58]]), {
			cuts: [{ frame: 59 }],
			rules: { minSeconds: 0.1 },
			cutAware: ca,
		});
		expect(last.captions[0]!.end).toBeLessThanOrEqual(59);
	});
	it('a piece made too short is extended away from its cut, else kept and reported', () => {
		const r = lay(
			words([
				['a', 0, 30],
				['b', 30, 34],
			]),
			{
				cuts: [{ frame: 31 }],
				rules: { minSeconds: 0.2, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		const b = r.captions.find((c) => workCaptionText(c) === 'b')!;
		expect(b.start).toBe(31);
		expect(b.end).toBe(43);
		const boxed = lay(
			words([
				['a', 0, 30],
				['b', 30, 34],
				['c', 36, 60],
			]),
			{
				cuts: [{ frame: 31 }, { frame: 35 }],
				rules: { minSeconds: 0.05, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		expect(boxed.stats.crossing).toBe(0);
	});
	it('cut zones: a subtitle started before a transition may run through it; montages merge', () => {
		const through = lay(
			words([
				['long', 0, 50],
				['talk', 50, 100],
			]),
			{
				cuts: [{ frame: 60, zone: { start: 45, end: 75 } }],
				rules: { minSeconds: 0.1, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		expect(spans(through)).toEqual([[0, 100, 'long talk']]);
		const inside = lay(
			words([
				['a', 0, 48],
				['b', 52, 100],
			]),
			{
				cuts: [{ frame: 60, zone: { start: 45, end: 75 } }],
				rules: { minSeconds: 0.1, breakPauseSeconds: 0.05 },
				cutAware: ca,
			},
		);
		expect(inside.captions[1]!.start).toBe(60);
		const montage = lay(
			words([
				['x', 0, 30],
				['y', 30, 60],
			]),
			{
				cuts: [{ frame: 20 }, { frame: 24 }, { frame: 28 }],
				rules: { minSeconds: 0.2, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		expect(montage.stats.merged).toBe(2);
		expect(montage.captions.length).toBeLessThanOrEqual(2);
	});
	it('a piece that starts on (or inside) a zone after a split does not run through it (fast-check seed 428871206)', () => {
		// one word over frames 0–8; a hard cut at 1; a transition [1, 13) with its edit point at 7. The word goes to
		// the piece after the hard cut, which starts with the transition, not before it: it ends on the edit point.
		const rate = { num: 24000, den: 1001 };
		const r = lay(words([['w0', 0, 8]], rate), {
			rate,
			cuts: [{ frame: 1 }, { frame: 7, zone: { start: 1, end: 13 } }],
			rules: { minSeconds: 0.1 },
			cutAware: ca,
		});
		expect(r.captions.map((c) => [c.start, c.end])).toEqual([[1, 7]]);
		expect(r.stats.crossing).toBe(0);
		// a hard cut inside a zone, after its start: the piece after it starts inside the transition
		const inside = lay(
			words([
				['aa', 0, 6],
				['bb', 30, 50],
			]),
			{
				cuts: [{ frame: 20 }, { frame: 40, zone: { start: 10, end: 60 } }],
				rules: { minSeconds: 0.1, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		for (const c of inside.captions) expect(c.start >= 40 || c.end <= 40 || c.start < 10).toBe(true);
		expect(inside.stats.crossing).toBe(0);
	});
	it('transitions shorter than 3 frames are hard cuts', () => {
		const r = lay(
			words([
				['long', 0, 50],
				['talk', 50, 100],
			]),
			{
				cuts: [{ frame: 60, zone: { start: 59, end: 61 } }],
				rules: { minSeconds: 0.1, breakPauseSeconds: 5 },
				cutAware: ca,
			},
		);
		expect(r.captions.map((c) => c.start)).toEqual([0, 60]);
	});
	it('speaker change at a cut; a cut during a pause', () => {
		const r = lay(
			words([
				['a', 0, 20, 'A'],
				['b', 20, 40, 'B'],
			]),
			{ cuts: [{ frame: 20 }], rules: { minSeconds: 0.1 }, cutAware: ca },
		);
		expect(spans(r)).toEqual([
			[0, 20, 'a'],
			[20, 40, 'b'],
		]);
		const p = lay(
			words([
				['a', 0, 20],
				['b', 70, 90],
			]),
			{
				cuts: [{ frame: 50 }],
				rules: { minSeconds: 0.1, holdSeconds: 2, breakPauseSeconds: 0.3 },
				cutAware: ca,
			},
		);
		expect(spans(p)).toEqual([
			[0, 50, 'a'],
			[50, 210, 'b'],
		]);
	});
	it('cut awareness off keeps the speech timing', () => {
		const r = lay(words([['hello', 30, 50]]), {
			cuts: [{ frame: 33 }],
			rules: { minSeconds: 0.1 },
			cutAware: false,
		});
		expect(r.captions[0]!.start).toBe(30);
	});
	for (const [label, rate] of RATES)
		it(`frame-exact at ${label} fps`, () => {
			const ws = words(
				[
					['uno', 0, 20],
					['dos', 20, 40],
					['tres', 45, 70],
				],
				rate,
			);
			const r = lay(ws, { cuts: [{ frame: 42 }], rules: { minSeconds: 0.1 }, cutAware: ca, rate });
			expect(r.captions.map((c) => [c.start, c.end])).toEqual([
				[0, 42],
				[42, 70],
			]);
		});
});

describe('properties', () => {
	const arb = fc.record({
		gaps: fc.array(fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 40 })), {
			minLength: 1,
			maxLength: 60,
		}),
		cuts: fc.array(fc.integer({ min: 1, max: 3000 }), { maxLength: 30 }),
		zones: fc.array(fc.boolean(), { maxLength: 30 }),
		maxWords: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
		hold: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
		gap: fc.integer({ min: 0, max: 4 }),
		min: fc.double({ min: 0.1, max: 1.5, noNaN: true }),
		rate: fc.constantFrom(...RATES.map((r) => r[1])),
	});
	it('subtitles are sorted, non-overlapping, at least one frame, never cross a hard cut, hold their words', () => {
		fc.assert(
			fc.property(arb, (p) => {
				let t = 0;
				const list: Array<[string, number, number]> = [];
				p.gaps.forEach(([g, d], i) => {
					t += g;
					list.push([`w${i}`, t, t + d]);
					t += d;
				});
				const cuts = [...new Set(p.cuts)].map((frame, i) => ({
					frame,
					...(p.zones[i] ? { zone: { start: frame - 6, end: frame + 6 } } : {}),
				}));
				const r = lay(words(list, p.rate), {
					cuts,
					rate: p.rate,
					rules: { maxWords: p.maxWords, holdSeconds: p.hold, gapFrames: p.gap, minSeconds: p.min },
					cutAware: DEFAULT_CUT_AWARE,
				});
				let prev = Number.NEGATIVE_INFINITY;
				const F = Fof(p.rate);
				for (const c of r.captions) {
					expect(c.end).toBeGreaterThan(c.start);
					expect(c.start).toBeGreaterThanOrEqual(prev);
					prev = c.end;
					for (const w of c.words) {
						expect(w.start).toBeGreaterThanOrEqual(c.start * F - 1);
						expect(w.end).toBeLessThanOrEqual(c.end * F + 1);
						expect(w.end).toBeGreaterThanOrEqual(w.start);
					}
					// no subtitle runs across a hard cut (cuts closer than the minimum duration are merged into zones)
					for (const cut of r.events)
						if (!cut.zone) expect(cut.frame <= c.start || cut.frame >= c.end).toBe(true);
						// a zone's edit point is crossed only by a subtitle that started before the zone
						else if (cut.frame > c.start && cut.frame < c.end) expect(c.start).toBeLessThan(cut.zone.start);
				}
				expect(r.stats.crossing).toBe(0);
				// every word is shown exactly once
				const shown = r.captions.flatMap((c) => c.words.map((w) => w.text));
				expect(new Set(shown).size).toBe(shown.length);
			}),
			{ numRuns: 200 },
		);
	});
});
