// WP7a: editing social-comment text without seeing the markup — marks survive typing, deleting, pasting and IME
// input; selection state for the mark buttons; grapheme counting.
import { applyMark, parseMarks, type SocialMarkKind, stripMarks } from '@jasper/mg-templates';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	countGraphemes,
	decodeMarkup,
	encodeMarks,
	replaceVisible,
	selectionHas,
	selectionMarks,
} from '../src/social-comments/marks-edit.ts';

/** Inserts `text` at `at` of the visible text (what the textarea reports after typing). */
const type = (markup: string, at: number, text: string) => {
	const v = stripMarks(markup);
	return replaceVisible(markup, v.slice(0, at) + text + v.slice(at));
};
const del = (markup: string, from: number, to: number) => {
	const v = stripMarks(markup);
	return replaceVisible(markup, v.slice(0, from) + v.slice(to));
};

describe('replaceVisible', () => {
	it('keeps marks when typing elsewhere (tokcomment wiped them)', () => {
		const m = 'This is ==so good== ||spoiler|| ok';
		expect(type(m, 0, 'Wow! ')).toBe('Wow! This is ==so good== ||spoiler|| ok');
		expect(type(m, stripMarks(m).length, ' 🔥')).toBe('This is ==so good== ||spoiler|| ok 🔥');
		expect(del(m, 0, 5)).toBe('is ==so good== ||spoiler|| ok');
	});

	it('extends the mark of the word being typed into', () => {
		const m = 'a ==word== b';
		expect(type(m, 6, 's')).toBe('a ==words== b'); // at the end of the word
		expect(type(m, 2, 'X')).toBe('a ==Xword== b'); // at its start
		expect(type(m, 4, 'Z')).toBe('a ==woZrd== b'); // inside
	});

	it('does not extend a mark across a typed space, but keeps a space typed inside a marked phrase', () => {
		expect(type('==hello== x', 5, ' ')).toBe('==hello==  x');
		expect(type('==hello== x', 5, ' there')).toBe('==hello== there x');
		expect(type('==hello world==', 5, ' big')).toBe('==hello big world==');
		expect(type('==ab==', 1, ' ')).toBe('==a b==');
	});

	it('typing over a selected marked word keeps its mark', () => {
		const v = stripMarks('a ||secret|| b');
		expect(replaceVisible('a ||secret|| b', `${v.slice(0, 2)}hidden${v.slice(8)}`)).toBe('a ||hidden|| b');
	});

	it('trims whitespace left at the edge of a mark after a deletion', () => {
		expect(del('==hello world== x', 5, 11)).toBe('==hello== x');
	});

	it('places an edit in repeated text where the caret is', () => {
		// "aa" + blurred "a": deleting the FIRST "a" (caret 0 afterwards) keeps the blur on the last one
		expect(replaceVisible('aa||a||', 'aa', 0)).toBe('a||a||');
		// without the caret the diff cannot tell which "a" went
		expect(stripMarks(replaceVisible('aa||a||', 'aa'))).toBe('aa');
		// typing "a" before a highlighted "a"
		expect(replaceVisible('x ==a==', 'x aa', 3)).toBe('x ==aa==');
		// an "a" typed after the highlighted "a" joins it, not the plain "a" further on
		expect(replaceVisible('==a== a', 'aa a', 2)).toBe('==aa== a');
		expect(replaceVisible('==a== a', 'a aa', 4)).toBe('==a== aa');
	});

	it('handles emoji and surrogate pairs without splitting them', () => {
		const m = 'hi ==😀😃== yo';
		const v = stripMarks(m);
		// replace 😃 by 😄 (shares the high surrogate with 😃)
		const next = v.replace('😃', '😄');
		expect(replaceVisible(m, next)).toBe('hi ==😀😄== yo');
		expect(type(m, 7, '👍🏽')).toBe('hi ==😀😃👍🏽== yo');
	});

	it('leaves the markup untouched when the visible text is the same, and accepts any value', () => {
		const m = 'a \\== literal ==b==';
		expect(replaceVisible(m, stripMarks(m))).toBe(m);
		expect(replaceVisible(42 as unknown as string, 'x')).toBe('x');
		expect(replaceVisible(null, '')).toBe('');
	});

	it('always produces markup whose visible text is the target (fuzz)', () => {
		const piece = fc.oneof(
			fc.string({ maxLength: 6 }),
			fc.constantFrom('==', '||', '~~', '\\', ' ', '\n', '😀', '👍🏽', '🇪🇸', '@user', '#tag'),
		);
		const markupArb = fc.array(piece, { maxLength: 12 }).map((xs) => xs.join(''));
		fc.assert(
			fc.property(markupArb, markupArb, (m, target) => {
				const out = replaceVisible(m, target);
				expect(stripMarks(out)).toBe(target);
			}),
			{ numRuns: 1500 },
		);
	});

	it('preserves the marks of every character outside the edit (fuzz)', () => {
		const spanArb = fc.array(
			fc.record({
				text: fc.stringMatching(/^[a-z ]{1,6}$/),
				mark: fc.constantFrom<SocialMarkKind>('none', 'highlight', 'blur', 'remove'),
			}),
			{ maxLength: 8 },
		);
		fc.assert(
			fc.property(spanArb, fc.nat(), fc.nat(), fc.stringMatching(/^[a-z]{0,4}$/), (spans, a, b, ins) => {
				const visible = spans.map((s) => s.text).join('');
				const marks = spans.flatMap((s) => Array.from(s.text, () => s.mark));
				const m = encodeMarks(visible, marks);
				const before = decodeMarkup(m);
				const n = before.visible.length;
				const from = Math.min(a % (n + 1), b % (n + 1));
				const to = Math.max(a % (n + 1), b % (n + 1));
				const next = before.visible.slice(0, from) + ins + before.visible.slice(to);
				// the editor passes the caret after the edit, which anchors it in repeated text
				const after = decodeMarkup(replaceVisible(m, next, from + ins.length));
				// non-space characters well before and after the edit keep their mark
				for (let k = 0; k < from - 1; k++)
					if (before.visible[k] !== ' ' && before.visible[k + 1] !== ' ')
						expect(after.marks[k]).toBe(before.marks[k]);
				const tail = n - to;
				for (let k = 1; k < tail; k++)
					if (before.visible[n - k] !== ' ')
						expect(after.marks[after.visible.length - k]).toBe(before.marks[n - k]);
			}),
			{ numRuns: 1500 },
		);
	});
});

describe('selectionMarks', () => {
	it('grows the selection to whole words like applyMark and reports their marks', () => {
		const m = 'one ==two== three';
		expect(selectionMarks(m, 5, 6)).toMatchObject({ range: { start: 4, end: 7 } });
		expect([...selectionMarks(m, 5, 6).marks]).toEqual(['highlight']);
		expect(selectionHas(selectionMarks(m, 5, 6), 'highlight')).toBe(true);
		expect(selectionHas(selectionMarks(m, 0, 9), 'highlight')).toBe(false);
		expect([...selectionMarks(m, 0, 9).marks].sort()).toEqual(['highlight', 'none']);
		expect(selectionMarks(m, 3, 4).range).toBeNull(); // only a space
		expect(selectionMarks('', 0, 0).range).toBeNull();
		expect(selectionMarks(m, 99, -5).range).toEqual({ start: 0, end: 13 });
		expect(selectionMarks(m, Number.NaN, 2).range).toEqual({ start: 0, end: 3 });
	});

	it('matches the range applyMark changes', () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[a-z =|~]{0,20}$/), fc.nat(25), fc.nat(25), (m, s, e) => {
				const info = selectionMarks(m, s, e);
				const out = applyMark(m, { start: s, end: e }, 'blur');
				if (!info.range) expect(out).toBe(m);
				else {
					const spans = parseMarks(out);
					const marks = spans.flatMap((sp) => Array.from(sp.text, () => sp.mark));
					const v = stripMarks(out);
					for (let k = info.range.start; k < info.range.end; k++)
						if (v[k] !== ' ') expect(marks[k]).toBe('blur');
				}
			}),
			{ numRuns: 800 },
		);
	});
});

describe('countGraphemes', () => {
	it('counts what people see, not UTF-16 units', () => {
		expect(countGraphemes('')).toBe(0);
		expect(countGraphemes('hola')).toBe(4);
		expect(countGraphemes('😊')).toBe(1);
		expect(countGraphemes('👍🏽')).toBe(1);
		expect(countGraphemes('🇪🇸')).toBe(1);
		expect(countGraphemes('👨‍👩‍👧')).toBe(1);
		expect(countGraphemes('é')).toBe(1); // e + combining acute
		expect(countGraphemes('Write any comment and see what happens 😊')).toBe(40);
	});
});
