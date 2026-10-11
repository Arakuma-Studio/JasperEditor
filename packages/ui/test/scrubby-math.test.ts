import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatNumber, roundTo } from '../src/primitives/scrubby-math.ts';

describe('numeric precision bounds', () => {
	it('bounds display precision before calling toFixed', () => {
		expect(formatNumber(1.25, 101)).toBe('1.2500000000');
		expect(formatNumber(1.25, Number.POSITIVE_INFINITY)).toBe('1');
		expect(formatNumber(1.25, Number.NaN)).toBe('1');
		expect(roundTo(1.25, 1.9)).toBe(1.3);
	});

	it('formats finite values with arbitrary precision without throwing', () => {
		fc.assert(
			fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double(), (value, precision) => {
				expect(typeof formatNumber(value, precision)).toBe('string');
			}),
			{ numRuns: 200 },
		);
	});
});
