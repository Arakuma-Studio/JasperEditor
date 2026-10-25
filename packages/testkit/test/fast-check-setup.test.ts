// The repository-wide fast-check setup (src/fast-check-setup.ts, loaded by every vitest project): every test runs with
// its own global seed and a failed property's seed + path can be read back from fast-check's message.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fastCheckFailureOf } from '../src/fast-check-setup.ts';

describe('fast-check setup', () => {
	it('gives every test a global seed (FC_SEED pins it)', () => {
		const { seed } = fc.readConfigureGlobal();
		expect(Number.isSafeInteger(seed)).toBe(true);
		if (process.env.FC_SEED) expect(seed).toBe(Number(process.env.FC_SEED));
	});

	it('reads the seed and counterexample path from a fast-check failure', () => {
		let message = '';
		try {
			fc.assert(
				fc.property(fc.constant(0), () => false),
				{ seed: 42, numRuns: 1 },
			);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(fastCheckFailureOf(message)).toEqual({ seed: 42, path: '0' });
		expect(fastCheckFailureOf('no property here')).toBeNull();
	});
});
