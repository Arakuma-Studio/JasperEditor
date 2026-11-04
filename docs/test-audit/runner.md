# Worker pool investigation

The model project uses Vitest's `threads` pool on Linux when its per-thread CPU
clock is readable; other hosts retain `forks`. Test cases, worker counts, isolation
and CI gates are unchanged. Two existing CPU benchmarks share a test-only clock so
concurrent workers are not charged to one another. No production code or dependency
changed. Disabling isolation, dropping setup and raising concurrency were excluded.

## Measurement

The comparison uses the unchanged `eb28696c` checkout, Node 20.19.0, pnpm 10.34.5,
Vitest 4.1.11, two workers, `JASPER_REQUIRE_ORACLES=1` and `FC_SEED=20261027`.
Four runs alternate forks, threads, threads, forks. `--no-cache` prevents prior run
timings from changing file scheduling; dependency installation is outside the timed
commands. OS caches are not dropped. Other agent work continued on the shared host, so small timing differences are
noise. Machine: AMD EPYC-Genoa/KVM, 8 vCPUs, 15.2 GiB RAM, Linux 6.8.0-138.

The exact 14-file sample is:

```text
packages/project/test/edit-structure.test.ts
packages/project/test/keyframes.test.ts
packages/project/test/document.test.ts
packages/project/test/clipboard.test.ts
packages/project/test/time.test.ts
packages/session/test/view.test.ts
packages/session/test/react.test.tsx
packages/session/test/selection.test.ts
packages/session/test/session.test.ts
apps/web/test/effect-presets.test.tsx
apps/web/test/program-math.test.ts
apps/web/test/export-format.test.ts
apps/web/test/edit-ux-trim-mode.test.ts
apps/web/test/thin-line-hit.test.ts
```

Reproduce each run with those paths in place of `<files>`:

```sh
FC_SEED=20261027 JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run <files> \
  --pool=forks --maxWorkers=2 --no-cache --reporter=default --reporter=json \
  --outputFile=/tmp/runner-forks.json
# Repeat with --pool=threads; keep every other option unchanged.
```

The raw local reports and `/usr/bin/time -v` measurements are under
`/tmp/jasper-test-audit/runner-{forks,threads}-{1,2}.{json,time,log}`.

## Sample result

Every run passed the same 144 cases in all 14 files. `/usr/bin/time -v` wall times:

| Pool | First run | Second run | Mean |
| --- | ---: | ---: | ---: |
| forks | 33.56 s | 35.08 s | 34.32 s |
| threads | 27.89 s | 32.51 s | 30.20 s |

The sample mean fell by 4.12 s (12.0%). This is a sample result, not a measured
whole-suite or CI improvement. Thread-run variation was substantial; the host's
one-minute load average fell from 8.34 to 3.83 during the sequence. Mean user CPU
was 52.69 s for forks and 50.53 s for threads. The actual assertions took only
2.69–3.00 s per run in aggregate; importing the test modules dominated this sample.
The `/usr/bin/time` maximum-RSS numbers are not directly comparable: a fork run
reports the largest individual process whereas a threaded run includes multiple
workers in one process.

## Complete model package

Both complete runs used the same two-worker command above with
`--project @jasper/project`, the same fixed fast-check seed and all original
238 files. Before: original forks. After: threads with the shared CPU clock.
Every case's name and status matched: **2,854 passed, 3 existing skips**. The skips
are the existing optional script-fix prototype parity rows.

| Measurement | Forks | Threads |
| --- | ---: | ---: |
| Vitest wall | 273.22 s | 212.62 s |
| `/usr/bin/time` wall | 274.30 s | 213.68 s |
| User CPU | 556.18 s | 520.44 s |
| System CPU | 73.40 s | 60.45 s |

Observed wall reduction: 60.62 s (22.1%); total CPU reduction: 48.69 s (7.7%).
The before run's load average rose from 9.27 to 12.62; the after run's rose from
1.70 to 3.56. These measurements therefore do **not** establish a 22.1% causal
pool improvement or a CI improvement. The alternating sample and lower CPU cost
support the scoped adoption; the coordinator measures the complete integrated
suite separately under comparable idle conditions.

The full raw reports are `runner-project-{forks,threads}.{json,time,log}` under
`/tmp/jasper-test-audit/`. One old-harness threads leg was interrupted with
SIGINT (exit 130) after a queued-shell edit raced its start; artifacts are retained
as `runner-project-threads-aborted.*`. It is not a completed validation or a
performance result. Another complete intermediate threads run failed the color
CPU assertion because `process.cpuUsage` aggregated both workers: 34.05 ms CPU
for 15.81 ms wall. Its report is `runner-project-threads-color-before.*`.
The corrected executing-thread sampler measured 18.00 ms CPU / 17.95 ms wall.
No limit, sample count, query, grade parameter or meaningful assertion was removed.

## CPU contracts and fallback

[Linux man-pages](https://man7.org/linux/man-pages/man5/proc_thread-self.5.html)
defines `thread-self` as the accessing thread. The
[kernel scheduler documentation](https://www.kernel.org/doc/html/latest/scheduler/sched-stats.html)
defines the first `schedstat` field as cumulative CPU runtime in nanoseconds.
The harness inference is that this path measures the executing JavaScript worker,
where the old process-PID path always selected the process's main thread.

`scripts/perf/cpu.ts` supplies the shared clock for CPU budgets and the project configuration.
Workers throw if a valid positive per-thread counter is unavailable. Forks retain
the existing process-CPU fallback. The default pool checks Linux plus the readable
counter; a simulated unavailable clock selected forks and passed the existing
rank CPU contract without a new production flag or injection hook.

The two authoritative `OPTIMIZE` rows in [runner.json](runner.json) supersede
`KEEP` rows for those exact test names in `project_1.json` and `project_3.json`.
The 50 ms / seven-run full-ranking contract and 30 ms / twelve-sample color bake
failure limit remain unchanged. Ranking full candidate objects is distinct from
engine paged ranking/facets; the color grade is distinct from the later extended
grade's budget. Mathematical correctness remains with their literal behavioral
owners; these cases uniquely measure public-operation cost.

## Worker cap and validation

Inspection of installed Vitest 4.1.11's
`dist/chunks/cli-api.CnMVyzaz.js` confirms `createPool` creates one `Pool`.
`executeTests` submits both pool types through that instance; `Pool.schedule`
checks its shared `activeTasks.length` against `maxWorkers` before `getPoolRunner`
selects a fork or thread. Thus root `--maxWorkers=2` still means at most two
active test files in total, including mixed project/engine pools. Worker process
termination may overlap after a file finishes, as before this change.

Executed checks, all on Node 20.19.0:

- Four 14-file forks/threads sample runs: all 144 cases passed each time.
- Complete original forks and corrected threads project suites: both 238 files,
  2,854 passed / the same 3 existing skips; exact case/status map equality checked.
- `pnpm --filter @jasper/project typecheck`.
- `pnpm exec vitest run packages/project/test/sound-rank-scale.test.ts
  packages/project/test/color.test.ts --maxWorkers=2`: default conditional pool,
  25 passed after every temporary mutation was restored.
- Missing-clock mutation under explicit threads: exactly one intended refusal.
- 64× correct-result ranking work: exactly one failure at the unchanged 50 ms limit.
- 8× correct-result bake work: exactly one failure at the unchanged color CPU limit.
- Forced clock absence: configuration selected forks and the rank CPU test passed
  using its existing fallback; restored configuration selected threads.
- Focused Biome check of all four TypeScript files and the two-row ledger;
  `git diff --check`.

Mutation and configuration probe commands/results are preserved in
`runner-mutations.json` and `runner-final-checks.json` under the same local report
folder. No mutation remains. No new permanent test was added. Full integrated
lint/typecheck/tests/build and browser gates belong to the coordinator.
