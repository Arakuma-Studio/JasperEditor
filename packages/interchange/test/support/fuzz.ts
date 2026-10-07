// Corruption helpers: truncations, byte mutations and garbage must only ever raise `InterchangeError`.
import fc from 'fast-check';
import { expect } from 'vitest';
import { InterchangeError } from '../../src/report.ts';

export function expectOnlyInterchangeErrors(
	run: (bytes: Uint8Array) => unknown,
	seed: Uint8Array,
	opts: { runs?: number; truncations?: number } = {},
): void {
	const check = (b: Uint8Array) => {
		try {
			run(b);
		} catch (e) {
			if (!(e instanceof InterchangeError))
				throw new Error(`unexpected ${(e as Error)?.name}: ${(e as Error)?.message}\n${(e as Error)?.stack}`);
		}
	};
	const n = opts.truncations ?? 64;
	for (let i = 0; i <= n; i++) check(seed.subarray(0, Math.floor((seed.length * i) / n)));
	fc.assert(
		fc.property(
			fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 24 }),
			(muts) => {
				const b = Uint8Array.from(seed);
				for (const [pos, v] of muts) if (b.length) b[pos % b.length] = v;
				check(b);
			},
		),
		{ numRuns: opts.runs ?? 300 },
	);
	fc.assert(
		fc.property(fc.uint8Array({ maxLength: 2048 }), (b) => check(b)),
		{ numRuns: 100 },
	);
	expect(true).toBe(true);
}

/** Path of the Python with opentimelineio / pyaaf2 (validators), or null. */
export const VENV_PYTHON = '/tmp/interchange-venv/bin/python';
