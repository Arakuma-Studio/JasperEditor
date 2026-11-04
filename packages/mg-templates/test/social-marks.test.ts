// Word-mark markup (design 2026-10-25 §7.5) and comment tokenization: examples plus fast-check properties.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { threadCpuMs } from '../../../scripts/perf/cpu.ts';
import {
	applyMark,
	type MarkSpan,
	parseMarks,
	SOCIAL_MARKS,
	SOCIAL_VARIANTS,
	type SocialMarkKind,
	serializeMarks,
	stripMarks,
	tokenizeComment,
} from '../src/index.ts';

const KINDS: SocialMarkKind[] = ['none', ...SOCIAL_MARKS];

/** Strings rich in marker characters, escapes, whitespace and hard Unicode (emoji, ZWJ, RTL, surrogates). */
const markupChar = fc.constantFrom(
	'=',
	'|',
	'~',
	'\\',
	'a',
	'b',
	' ',
	'\n',
	'😊',
	'👩‍👩‍👧',
	'\u200d',
	'ש',
	'م',
	'\u202e',
	'\uD83D',
	'@',
	'#',
	'.',
);
const markup = fc.oneof(
	fc.string({ unit: markupChar, maxLength: 60 }),
	fc.string({ unit: 'binary', maxLength: 60 }),
);
const spanArb = fc.record({
	text: fc.string({ unit: markupChar, minLength: 1, maxLength: 12 }),
	mark: fc.constantFrom(...KINDS),
});

/** Merge adjacent same-mark spans, drop empty ones (parseMarks' normal form). */
function normalize(spans: MarkSpan[]): MarkSpan[] {
	const out: MarkSpan[] = [];
	for (const s of spans) {
		if (!s.text) continue;
		const last = out[out.length - 1];
		if (last && last.mark === s.mark) last.text += s.text;
		else out.push({ ...s });
	}
	return out;
}

/** Per-code-unit marks of markup. */
function marksOf(markupText: string): SocialMarkKind[] {
	return parseMarks(markupText).flatMap((s) => Array.from({ length: s.text.length }, () => s.mark));
}

describe('parseMarks', () => {
	it.each([
		['plain text', [{ text: 'plain text', mark: 'none' }]],
		['', []],
		[
			'Write ==any comment== and ||see|| ~~what~~ happens',
			[
				{ text: 'Write ', mark: 'none' },
				{ text: 'any comment', mark: 'highlight' },
				{ text: ' and ', mark: 'none' },
				{ text: 'see', mark: 'blur' },
				{ text: ' ', mark: 'none' },
				{ text: 'what', mark: 'remove' },
				{ text: ' happens', mark: 'none' },
			],
		],
		// unbalanced markers render literally
		['a == b', [{ text: 'a == b', mark: 'none' }]],
		['==open', [{ text: '==open', mark: 'none' }]],
		['x || y ~~', [{ text: 'x || y ~~', mark: 'none' }]],
		['====', [{ text: '====', mark: 'none' }]],
		['=', [{ text: '=', mark: 'none' }]],
		// escapes
		['\\==not\\==', [{ text: '==not==', mark: 'none' }]],
		['==a\\==b==', [{ text: 'a==b', mark: 'highlight' }]],
		['C:\\path \\\\ x', [{ text: 'C:\\path \\ x', mark: 'none' }]],
		['trailing \\', [{ text: 'trailing \\', mark: 'none' }]],
		// no nesting: other markers inside a mark are literal; overlap resolves to the first opener
		['==a ||b|| c==', [{ text: 'a ||b|| c', mark: 'highlight' }]],
		[
			'==a ||b== c||',
			[
				{ text: 'a ||b', mark: 'highlight' },
				{ text: ' c||', mark: 'none' },
			],
		],
		// adjacent marks of the same kind merge
		['==a====b==', [{ text: 'ab', mark: 'highlight' }]],
		[
			'===a===',
			[
				{ text: '=a', mark: 'highlight' },
				{ text: '=', mark: 'none' },
			],
		],
	] as [string, MarkSpan[]][])('%j', (input, expected) => {
		expect(parseMarks(input)).toEqual(expected);
		expect(stripMarks(input)).toBe(expected.map((s) => s.text).join(''));
	});

	it('returns normalised spans and never throws on arbitrary Unicode (property)', () => {
		fc.assert(
			fc.property(markup, (t) => {
				const spans = parseMarks(t);
				for (let i = 0; i < spans.length; i++) {
					expect(spans[i]!.text.length).toBeGreaterThan(0);
					if (i > 0) expect(spans[i]!.mark).not.toBe(spans[i - 1]!.mark);
				}
				expect(stripMarks(t)).toBe(spans.map((s) => s.text).join(''));
				expect(stripMarks(t).length).toBeLessThanOrEqual(t.length);
			}),
		);
	});

	it('tolerates non-string input', () => {
		expect(parseMarks(undefined as unknown as string)).toEqual([]);
		expect(stripMarks(42 as unknown as string)).toBe('');
	});

	it('parses adversarial input in linear time', () => {
		const inputs = [
			'=|~\\'.repeat(50_000),
			'=='.repeat(100_000),
			`==${'a|'.repeat(100_000)}`,
			'\\'.repeat(200_000),
		];
		const t0 = threadCpuMs();
		for (const s of inputs) parseMarks(s);
		expect(threadCpuMs() - t0).toBeLessThan(2000);
	});
});

describe('serializeMarks', () => {
	it('round-trips any spans (property)', () => {
		fc.assert(
			fc.property(fc.array(spanArb, { maxLength: 8 }), (spans) => {
				expect(parseMarks(serializeMarks(spans))).toEqual(normalize(spans));
			}),
		);
	});

	it('is idempotent on parsed markup (property)', () => {
		fc.assert(
			fc.property(markup, (t) => {
				const once = serializeMarks(parseMarks(t));
				expect(parseMarks(once)).toEqual(parseMarks(t));
				expect(serializeMarks(parseMarks(once))).toBe(once);
			}),
		);
	});

	it('escapes only where a marker would pair', () => {
		expect(serializeMarks([{ text: 'a = b | c ~ d', mark: 'none' }])).toBe('a = b | c ~ d');
		expect(serializeMarks([{ text: 'a == b', mark: 'none' }])).toBe('a \\== b');
		expect(serializeMarks([{ text: 'x=', mark: 'highlight' }])).toBe('==x\\===');
		expect(
			serializeMarks([
				{ text: 'a=', mark: 'none' },
				{ text: 'b', mark: 'highlight' },
			]),
		).toBe('a\\===b==');
		expect(serializeMarks([{ text: 'C:\\path', mark: 'none' }])).toBe('C:\\path');
	});
});

describe('applyMark', () => {
	const text = 'Write any comment and see what happens 😊';
	it('marks whole words, like tokcomment', () => {
		expect(applyMark(text, { start: 10, end: 17 }, 'highlight')).toBe(
			'Write any ==comment== and see what happens 😊',
		);
		// a range inside a word grows to the word; a caret marks the word under it
		expect(applyMark(text, { start: 12, end: 13 }, 'blur')).toBe(
			'Write any ||comment|| and see what happens 😊',
		);
		expect(applyMark(text, { start: 12, end: 12 }, 'remove')).toBe(
			'Write any ~~comment~~ and see what happens 😊',
		);
		// a range across words marks them all as one run
		expect(applyMark(text, { start: 7, end: 12 }, 'highlight')).toBe(
			'Write ==any comment== and see what happens 😊',
		);
		// reversed ranges are accepted
		expect(applyMark(text, { start: 12, end: 7 }, 'highlight')).toBe(
			'Write ==any comment== and see what happens 😊',
		);
		// emoji are words too
		expect(applyMark(text, { start: 40, end: 41 }, 'blur')).toBe(
			'Write any comment and see what happens ||😊||',
		);
	});

	it('merges adjacent words with the same mark into one run', () => {
		const once = applyMark(text, { start: 6, end: 9 }, 'highlight');
		expect(once).toBe('Write ==any== comment and see what happens 😊');
		expect(applyMark(once, { start: 10, end: 17 }, 'highlight')).toBe(
			'Write ==any comment== and see what happens 😊',
		);
	});

	it('replaces a different mark and splits merged runs', () => {
		const marked = 'Write ==any comment== and see';
		expect(applyMark(marked, { start: 6, end: 6 }, 'blur')).toBe('Write ||any|| ==comment== and see');
		expect(applyMark(marked, { start: 10, end: 10 }, null)).toBe('Write ==any== comment and see');
		expect(applyMark(marked, { start: 0, end: 29 }, null)).toBe('Write any comment and see');
		// a word partly marked becomes wholly marked
		expect(applyMark('he==llo== there', { start: 0, end: 1 }, 'highlight')).toBe('==hello== there');
	});

	it('changes nothing for whitespace-only ranges, empty text or unchanged marks', () => {
		expect(applyMark(text, { start: 5, end: 6 }, 'highlight')).toBe(text);
		expect(applyMark('', { start: 0, end: 0 }, 'highlight')).toBe('');
		expect(applyMark('a  b', { start: 2, end: 2 }, 'highlight')).toBe('a  b');
		// an unrelated literal "==" keeps its original markup when nothing changes
		expect(applyMark('a == b', { start: 0, end: 1 }, null)).toBe('a == b');
		expect(applyMark(text, { start: Number.NaN, end: 1e9 }, null)).toBe(text);
	});

	it('preserves the visible text, is idempotent and marks the touched words (property)', () => {
		fc.assert(
			fc.property(
				markup,
				fc.nat({ max: 80 }),
				fc.nat({ max: 80 }),
				fc.constantFrom(...SOCIAL_MARKS, null),
				(t, a, b, mark) => {
					const out = applyMark(t, { start: a, end: b }, mark);
					expect(stripMarks(out)).toBe(stripMarks(t));
					expect(applyMark(out, { start: a, end: b }, mark)).toBe(out);
					const visible = stripMarks(t);
					const lo = Math.min(a, b, visible.length);
					const hi = Math.min(Math.max(a, b), visible.length);
					const marks = marksOf(out);
					const expected = mark ?? 'none';
					// every non-space code unit inside the range carries the mark
					for (let k = lo; k < hi; k++) if (!/\s/u.test(visible[k]!)) expect(marks[k]).toBe(expected);
				},
			),
		);
	});
});

describe('tokenizeComment', () => {
	it('finds mentions and hashtags per platform', () => {
		const spans = tokenizeComment('Write any comment @friend and see what happens #fyp 😊', 'instagram-post');
		expect(spans.filter((s) => s.role !== 'plain').map((s) => [s.text, s.role])).toEqual([
			['@friend', 'mention'],
			['#fyp', 'hashtag'],
		]);
	});

	it('keeps e-mails, trailing full stops, digit-only tags and over-long names plain', () => {
		const roles = (t: string, v = 'tiktok-comment' as const) =>
			tokenizeComment(t, v)
				.filter((s) => s.role !== 'plain')
				.map((s) => s.text);
		expect(roles('mail me at luna@example.com')).toEqual([]);
		expect(roles('thanks @luna.makes.')).toEqual(['@luna.makes']);
		expect(roles('#1 fan #fyp2024 #2024')).toEqual(['#fyp2024']);
		expect(roles('a#b c&#39; #ok')).toEqual(['#ok']);
		expect(roles('(@luna) "#café"')).toEqual(['@luna', '#café']);
		// X handles: letters, digits and "_", at most 15 characters; no "."
		expect(
			tokenizeComment('@abcdefghijklmnop @jake_rides22 @a.b', 'x-post').filter((s) => s.role === 'mention'),
		).toEqual([
			{ text: '@jake_rides22', mark: 'none', role: 'mention' },
			{ text: '@a', mark: 'none', role: 'mention' },
		]);
		// YouTube handles may contain "-" and non-Latin letters
		expect(roles('@María-José hi', 'youtube-comment' as never)).toEqual(['@María-José']);
	});

	it('combines marks and roles', () => {
		expect(tokenizeComment('so ==@luna said== #wow', 'x-post')).toEqual([
			{ text: 'so ', mark: 'none', role: 'plain' },
			{ text: '@luna', mark: 'highlight', role: 'mention' },
			{ text: ' said', mark: 'highlight', role: 'plain' },
			{ text: ' ', mark: 'none', role: 'plain' },
			{ text: '#wow', mark: 'none', role: 'hashtag' },
		]);
	});

	it('covers the visible text exactly and never throws (property)', () => {
		fc.assert(
			fc.property(markup, fc.constantFrom(...SOCIAL_VARIANTS), (t, v) => {
				const spans = tokenizeComment(t, v);
				expect(spans.map((s) => s.text).join('')).toBe(stripMarks(t));
				for (let i = 1; i < spans.length; i++) {
					const [p, s] = [spans[i - 1]!, spans[i]!];
					expect(p.mark === s.mark && p.role === s.role).toBe(false);
				}
			}),
		);
	});
});
