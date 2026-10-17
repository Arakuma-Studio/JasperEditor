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

	it('the same global seed generates the same values (a failure replays from the printed seed)', () => {
		const { seed } = fc.readConfigureGlobal();
		const a = fc.sample(fc.array(fc.double()), { numRuns: 20, seed });
		const b = fc.sample(fc.array(fc.double()), { numRuns: 20, seed });
		expect(Object.is(JSON.stringify(a), JSON.stringify(b))).toBe(true);
	});

	it("reads the seed and the path out of fast-check's failure message; the pair replays the counterexample", () => {
		const prop = fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => n % 9973 !== 1234);
		let message = '';
		try {
			fc.assert(prop, { numRuns: 1_000_000, seed: 42 });
		} catch (e) {
			message = (e as Error).message;
		}
		const found = fastCheckFailureOf(message);
		expect(found).toEqual({ seed: 42, path: expect.stringMatching(/^\d+(:\d+)*$/) });
		const replay = fc.check(prop, { seed: found!.seed, path: found!.path, endOnFailure: true });
		expect(replay.failed).toBe(true);
		expect(replay.numRuns).toBe(1);
		expect(fastCheckFailureOf('no property here')).toBeNull();
	});
});
