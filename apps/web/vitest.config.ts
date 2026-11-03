import { defineProject } from 'vitest/config';
import { loadFactor, PERF_STRICT } from '../../scripts/perf/budget.ts';

// The web tests mount real panels (and, in a few files, the whole editor) in happy-dom with development React. On
// the reference machine the slowest of them take ≈ 1 s; on a shared host with dozens of busy processes the same
// tests have been seen at 4–5 s, and Vitest's default 5 s limit then failed a test that passes alone (seen once each
// in project-windowing, shell-render and speech; docs/performance.md §"Test timeouts").
//
// The limit is therefore scaled with the host's slowdown, measured once per run with the calibration workload the
// performance budgets use (scripts/perf/budget.ts): 5 s × factor² (rendering waits for the scheduler too, so the
// load counts twice, as for `budgetMs(…, {parallel: true})`), never below 15 s and never above 60 s. `PERF=1` keeps
// Vitest's 5 s exactly (quiet CI machines).
//
// What this does not relax: a test that hangs still fails (within a minute at most), `waitFor` and `findBy…` keep
// their own 1 s deadlines, and no assertion changed. It only stops the wall clock of a busy machine from failing
// tests whose work is unchanged.
const TEST_TIMEOUT_BASE_MS = 5_000;
const TEST_TIMEOUT_FLOOR_MS = 15_000;
const TEST_TIMEOUT_CEILING_MS = 60_000;

function webTestTimeoutMs(factor = loadFactor(), strict = PERF_STRICT): number {
	if (strict) return TEST_TIMEOUT_BASE_MS;
	const scaled = Math.round(TEST_TIMEOUT_BASE_MS * factor * factor);
	return Math.min(TEST_TIMEOUT_CEILING_MS, Math.max(TEST_TIMEOUT_FLOOR_MS, scaled));
}

const testTimeout = webTestTimeoutMs();

export default defineProject({
	test: {
		setupFiles: [
			'../../packages/testkit/src/fast-check-setup.ts',
			'../../packages/testkit/src/dom-storage-setup.ts',
		],
		include: ['test/**/*.test.{ts,tsx}'],
		environment: 'happy-dom',
		testTimeout,
		// beforeEach / afterEach mount and unmount the same trees.
		hookTimeout: Math.max(10_000, testTimeout),
	},
});
