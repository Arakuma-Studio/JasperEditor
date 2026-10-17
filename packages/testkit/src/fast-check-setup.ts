// Vitest setup file of every project (`setupFiles` in each `vitest.config.ts`): makes every fast-check property in the
// repository reproducible from its failure report alone (wp-note sound-design WP6.5b: a `mergeDips` property failed
// once and its seed was lost, ~130k reruns did not find it again).
//
// - Each test gets its own seed, set as fast-check's global seed before the test runs (`FC_SEED=<n>` pins it; a
//   property that passes its own `seed` keeps it). Several `fc.assert` calls in one test share that seed.
// - `FC_PATH=<path>` replays one counterexample (with `FC_SEED`, and `-t <test name>` so only that test runs);
//   `FC_NUM_RUNS=<n>` sets the runs of every property that does not set its own (`numRuns` given in a test wins).
// - When a test fails, the seed, the counterexample path fast-check printed (if the failure came from a property) and
//   the command that replays it are printed to stderr and written to `test-results/fast-check-failures/` (gitignored;
//   `$JASPER_TEST_RESULTS` moves it). This also covers a test that failed for another reason (a timeout while
//   shrinking, an assertion after the property): the seed is the test's, so the run can be repeated.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { beforeEach } from 'vitest';
import { repoRoot, testResultsDir } from './env.ts';

const base = fc.readConfigureGlobal();

/** A fresh 32-bit seed (fast-check's own default: time ^ random). */
const freshSeed = () => (Date.now() ^ Math.floor(Math.random() * 0x1_0000_0000)) | 0;

const intEnv = (name: string): number | undefined => {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const n = Number(raw);
	if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
	return n;
};

/** fast-check's `{ seed: <n>, path: "<p>" … }` line of a failed property, when the error carries one. */
export function fastCheckFailureOf(message: string): { seed: number; path: string } | null {
	const m = /seed:\s*(-?\d+),\s*path:\s*"([^"]*)"/.exec(message);
	return m ? { seed: Number(m[1]), path: m[2]! } : null;
}

beforeEach((ctx) => {
	const seed = intEnv('FC_SEED') ?? freshSeed();
	const path = process.env.FC_PATH?.trim();
	const numRuns = intEnv('FC_NUM_RUNS');
	fc.configureGlobal({
		...base,
		seed,
		...(path ? { path, endOnFailure: true } : {}),
		...(numRuns !== undefined ? { numRuns } : {}),
	});
	ctx.onTestFailed(({ task }) => {
		const errors = task.result?.errors ?? [];
		const text = errors.map((e) => `${e?.message ?? ''}\n${e?.stack ?? ''}`).join('\n');
		const found = fastCheckFailureOf(text);
		const file = task.file?.filepath ? relative(repoRoot(), task.file.filepath) : '(unknown file)';
		const name = task.fullName ?? task.name;
		const replay = found
			? `FC_SEED=${found.seed} FC_PATH=${found.path} pnpm vitest run ${file} -t ${JSON.stringify(task.name)}`
			: `FC_SEED=${seed} pnpm vitest run ${file} -t ${JSON.stringify(task.name)}`;
		const record = {
			file,
			test: name,
			at: new Date().toISOString(),
			testSeed: seed,
			property: found,
			replay,
			error: (errors[0]?.message ?? '').slice(0, 4000),
		};
		process.stderr.write(
			`\n[fast-check] ${file} > ${task.name} failed; test seed ${seed}${found ? `, property seed ${found.seed} path "${found.path}"` : ''}\n[fast-check] replay: ${replay}\n`,
		);
		try {
			const dir = testResultsDir('fast-check-failures');
			mkdirSync(dir, { recursive: true });
			const slug = `${file}-${name}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160);
			writeFileSync(join(dir, `${slug}-${Date.now()}.json`), `${JSON.stringify(record, null, '\t')}\n`);
		} catch {
			// reporting must never fail the run; the stderr line above already has the seed
		}
	});
});
