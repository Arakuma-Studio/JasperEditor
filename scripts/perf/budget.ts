// Load-tolerant performance budgets for tests (workstream `previews`, docs/performance.md).
//
// Timing assertions measure the machine as much as the code: on a shared host with dozens of busy processes a 1 s
// budget can take 5 s without any regression. The normal test gate therefore scales every budget by the host's
// current slowdown, measured with a fixed single-threaded workload (`loadFactor`) — the same loop takes ≈ 15 ms on the
// reference machine (12-core x86-64, Node 20, measured best of 7 at load ≈ 9: 15.4–15.9 ms). A real regression (the
// code got N× slower) still fails, because the workload does not get slower with it. `PERF=1` enforces the documented
// budgets exactly (for CI on a quiet machine and `pnpm perf`), and a strict run prints what it measured.
//
// Used by every test with a wall-clock or CPU-time budget (audio effects, the remix analysis, the Lumetri bake, the fx
// compile budget, cancellation latency, the ARCHITECTURE §13 editor budgets).

/** `PERF=1`: enforce the documented budgets without load scaling. */
export const PERF_STRICT = typeof process !== 'undefined' && process.env.PERF === '1';

/** The reference time of `calibrationWork()` on the reference machine (ms). */
export const CALIBRATION_REFERENCE_MS = 15;

/** A fixed CPU workload (FNV-style hashing over 64 Ki words, 160 rounds): ≈ 15 ms on the reference machine. */
export function calibrationWork(): number {
	const a = new Uint32Array(1 << 16);
	let h = 2166136261;
	for (let r = 0; r < 160; r++)
		for (let i = 0; i < a.length; i++) {
			a[i] = (a[i]! + i + r) | 0;
			h = Math.imul(h ^ a[i]!, 16777619);
		}
	return h >>> 0;
}

let cached: number | null = null;

/**
 * The host's slowdown right now (≥ 1): the best of five runs of the calibration workload over its reference time.
 * Measured once per process (and again with `fresh`), so a test file pays ≈ 100 ms once.
 */
export function loadFactor(fresh = false): number {
	if (cached !== null && !fresh) return cached;
	calibrationWork(); // JIT warm-up
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < 5; i++) {
		const t0 = performance.now();
		calibrationWork();
		best = Math.min(best, performance.now() - t0);
	}
	cached = Math.max(1, best / CALIBRATION_REFERENCE_MS);
	return cached;
}

/**
 * The budget to enforce for a documented budget `baseMs`: exactly `baseMs` with `PERF=1`, otherwise `baseMs` × the
 * host's load factor (never less than `baseMs`). `parallel`: the measured code runs on several threads/processes
 * (wall time also waits for the scheduler), so the factor counts double.
 */
export function budgetMs(baseMs: number, opts: { parallel?: boolean } = {}): number {
	if (PERF_STRICT) return baseMs;
	const f = loadFactor();
	return baseMs * (opts.parallel ? f * f : f);
}

/** A one-line report of a measurement against its budget (tests print it; `pnpm perf` collects them). */
export function budgetReport(
	label: string,
	measuredMs: number,
	baseMs: number,
	opts: { parallel?: boolean } = {},
): string {
	const b = budgetMs(baseMs, opts);
	return `[perf] ${label}: ${measuredMs.toFixed(1)} ms (budget ${baseMs} ms${PERF_STRICT ? ', strict' : `, ×${(b / baseMs).toFixed(2)} load → ${b.toFixed(0)} ms`})`;
}
