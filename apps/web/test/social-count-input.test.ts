// WP7a: the count field parser of the social-comment controls ("1,234", "12.3K", "3.4M" → integers).
import { formatCount, SOCIAL_COUNT_MAX, SOCIAL_VARIANTS } from '@jasper/mg-templates';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCountInput } from '../src/social-comments/count-input.ts';

const ok = (s: string) => parseCountInput(s);

describe('parseCountInput', () => {
	it('reads plain, grouped and abbreviated counts', () => {
		const cases: [string, number][] = [
			['0', 0],
			['1393', 1393],
			[' 1393 ', 1393],
			['+42', 42],
			['1,234', 1234],
			['1.234', 1234],
			['1,234,567', 1_234_567],
			['1.234.567', 1_234_567],
			['1 234 567', 1_234_567],
			['1 234', 1234],
			["1'234", 1234],
			['1_000', 1000],
			['1,234.5K', 1_234_500],
			['1.234,5K', 1_234_500],
			['12.3K', 12_300],
			['12,3k', 12_300],
			['1.5M', 1_500_000],
			['3.4m', 3_400_000],
			['2B', 2_000_000_000],
			['1.2345K', 1235],
			['.5K', 500],
			['１２３', 123],
			['１．５Ｋ', 1500],
			['-0', 0],
			['1000B', 1e12],
			['1,000B', 1e12],
			['1,500K', 1_500_000],
			['1.234K', 1234],
		];
		for (const [input, value] of cases) expect(ok(input), input).toEqual({ ok: true, value });
		// the card's own text at the cap ("1,000B") reads back exactly
		for (const v of SOCIAL_VARIANTS)
			expect(ok(formatCount(v, SOCIAL_COUNT_MAX))).toEqual({ ok: true, value: SOCIAL_COUNT_MAX });
	});

	it('explains what is wrong', () => {
		expect(ok('')).toEqual({ ok: false, error: 'empty' });
		expect(ok('   ')).toEqual({ ok: false, error: 'empty' });
		expect(ok('abc')).toEqual({ ok: false, error: 'invalid' });
		expect(ok('1.2.3')).toEqual({ ok: false, error: 'invalid' });
		expect(ok('12,34,5')).toEqual({ ok: false, error: 'invalid' });
		expect(ok('1,23')).toEqual({ ok: false, error: 'fraction' });
		expect(ok('12.5')).toEqual({ ok: false, error: 'fraction' });
		expect(ok('1K2')).toEqual({ ok: false, error: 'invalid' });
		expect(ok('1KK')).toEqual({ ok: false, error: 'invalid' });
		expect(ok('-5')).toEqual({ ok: false, error: 'negative' });
		expect(ok('−1.2K')).toEqual({ ok: false, error: 'negative' });
		expect(ok('1001B')).toEqual({ ok: false, error: 'too-large' });
		expect(ok('9'.repeat(30))).toEqual({ ok: false, error: 'too-large' });
		expect(ok('1'.repeat(65))).toEqual({ ok: false, error: 'invalid' });
		expect(parseCountInput(12 as unknown)).toEqual({ ok: false, error: 'invalid' });
		expect(parseCountInput('10001', 10_000)).toEqual({ ok: false, error: 'too-large' });
	});

	it('never throws and only returns whole numbers within the cap (fuzz)', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 80 }), (s) => {
				const r = parseCountInput(s);
				if (r.ok) {
					expect(Number.isSafeInteger(r.value)).toBe(true);
					expect(r.value).toBeGreaterThanOrEqual(0);
					expect(r.value).toBeLessThanOrEqual(SOCIAL_COUNT_MAX);
				}
			}),
			{ numRuns: 2000 },
		);
	});

	it('round-trips every count written plainly or comma-grouped', () => {
		const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		fc.assert(
			fc.property(fc.integer({ min: 0, max: SOCIAL_COUNT_MAX }), (n) => {
				expect(ok(String(n))).toEqual({ ok: true, value: n });
				expect(ok(grouped(n))).toEqual({ ok: true, value: n });
			}),
			{ numRuns: 1000 },
		);
	});

	it('reads back what the card shows, within the truncation of the abbreviation', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...SOCIAL_VARIANTS),
				fc.integer({ min: 0, max: SOCIAL_COUNT_MAX }),
				(v, n) => {
					const shown = formatCount(v, n);
					const r = ok(shown);
					expect(r.ok, shown).toBe(true);
					if (!r.ok) return;
					expect(r.value).toBeLessThanOrEqual(n);
					// one decimal of the unit at most is dropped (K: < 100, M: < 100,000, B: < 1e8)
					const unit = n >= 1e9 ? 1e9 : n >= 1e6 ? 1e6 : 1e3;
					expect(n - r.value).toBeLessThan(unit);
				},
			),
			{ numRuns: 1000 },
		);
	});
});
