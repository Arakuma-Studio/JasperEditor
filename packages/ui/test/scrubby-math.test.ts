import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatNumber } from '../src/primitives/scrubby-math.ts';

describe('numeric precision bounds', () => {
	it('does not throw for out-of-range or nonfinite precision', () => {
		for (const precision of [101, Number.POSITIVE_INFINITY, Number.NaN])
			expect(() => formatNumber(1.25, precision)).not.toThrow();
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
