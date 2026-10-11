// Corruption helpers: truncations, byte mutations and garbage must only ever raise `InterchangeError`.
// Runs on the shared fuzz harness (@jasper/testkit, docs/testing.md §Fuzzing): every truncation point (`truncations`
// evenly spaced cuts), seeded xorshift byte mutations, and fast-check arbitrary bytes (`runs` each, ×20
// with FUZZ=1); failing inputs are saved under test-results/fuzz-failures/.
import { assertFuzzSync, bytesTarget } from '@jasper/testkit/fuzz';
import { InterchangeError } from '../../src/report.ts';

export function expectOnlyInterchangeErrors(
	run: (bytes: Uint8Array) => unknown,
	seed: Uint8Array,
	opts: { runs?: number; truncations?: number; name?: string } = {},
): void {
	// Include a finer truncation grid than the harness's 32 cuts per seed.
	const n = opts.truncations ?? 64;
	const cuts = Array.from({ length: n + 1 }, (_, i) => seed.subarray(0, Math.floor((seed.length * i) / n)));
	assertFuzzSync(
		bytesTarget(opts.name ?? 'interchange import', [seed, ...cuts], run, InterchangeError, {
			iterations: opts.runs ?? 300,
			properties: 100,
		}),
	);
}

/** Optional local environment for independent OpenTimelineIO/pyaaf2 validation. */
export const VENV_PYTHON = '/tmp/interchange-venv/bin/python';
