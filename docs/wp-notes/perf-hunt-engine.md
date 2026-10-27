# Engine keyed-job lookups

The current media status path asks `JobQueue.list` for the six or seven derivative
keys of each medium. The previous filtering optimization avoided cloning unrelated
jobs, but each call still materialized and scanned the entire queue. Opening 500
media with 3,000 queued derivatives therefore traversed 1.5 million job entries.

The queue now maintains an index from dedupe key to retained job IDs. Keyed list
calls visit only matching internal jobs. Unfiltered listing, filters, detached
returned jobs and external scheduler sources keep their previous behavior. The
index retains finished jobs until the normal queue prune removes them; retries
and journal replay can have several retained jobs under the same key, and all
remain visible. A separate stable insertion ordinal preserves timestamp ties
when journal replay replaces an existing entry. Scheduler sequence numbers are
unchanged. No API, schema, persistence format or rendering behavior changed.

## Measurement

Measured against `eb28696c` on Linux x64, AMD EPYC-Genoa, eight logical CPUs,
Node v24.22.1 and pnpm 10.34.5. Both tools import the actual git baseline source
into a temporary sibling module and delete it afterward. They alternate
baseline/current measurements on identical inputs for nine rounds, discard two
warm-up rounds and report the median of seven samples. This is a shared host;
other agents were active. One-minute load was 12.8–14.1 for the paired queue
benchmark and 6.9 for derivative status. Raw samples, CPU timings and load averages
are in `apps/engine/bench/job-lookups.results.json`.

Before editing production code, the queue benchmark ran against the unchanged
current implementation: 500 keyed lookups measured 91.96 / 89.59 ms for the two
identical implementations, and 2,000 measured 972.38 / 987.32 ms. The paired
measurements below compare original/current code in the same process after the
change, reducing differences from host load and process warm-up.

| Workload | Before median | After median |
|---|---:|---:|
| 50 keyed lookups / 300 queued jobs | 1.72 ms | 0.93 ms |
| 500 keyed lookups / 3,000 queued jobs | 84.93 ms | 9.89 ms |
| 2,000 keyed lookups / 12,000 queued jobs | 1,047.79 ms | 40.72 ms |
| Actual derivative status, 50 media / 300 jobs, concurrency 16 | 7.67 ms | 7.22 ms |
| Actual derivative status, 500 media / 3,000 jobs, concurrency 16 | 138.33 ms | 69.38 ms |

The last workload's CPU median was 168.82 → 101.14 ms. Its statuses are deeply
equal, including job IDs; the same live queue is read through the actual baseline
and current `list` methods, while the production derivative service and real
filesystem checks remain identical. The queue microbenchmark compares two actual
queue instances and asserts ordered equal results after removing random job IDs.

Reproduce from the repository root:

```sh
pnpm exec tsx apps/engine/bench/job-lookups.ts --baseline eb28696c
pnpm exec tsx apps/engine/bench/media-status.ts --queue-baseline eb28696c
```

These are operation timings, not a claim of end-to-end project-open speed. The
index adds O(retained keyed jobs) memory and constant map/set work when registering
or pruning jobs. External scheduler jobs still use their existing list API and
are scanned. No persistent cache or filesystem-readiness check is skipped.

## Verification

- `pnpm exec vitest run apps/engine/test/jobs.test.ts --maxWorkers=2`: 19 passed.
  Coverage includes reversed requested-key order, timestamp ties, all ordinary
  filters, cancellation/retry history, duplicate-key journal recovery, journal
  replacement, pruning and existing external-source/detached-result checks.
- `pnpm exec vitest run apps/engine/test/polish-media-status.test.ts apps/engine/test/media.test.ts --maxWorkers=2`: 12 passed; FFmpeg/ffprobe were present and no tests skipped.
- `pnpm --filter @jasper/engine typecheck`: passed.
- Biome checks for changed engine source, tests and benchmarks: passed.

The parent integration run records the complete workspace and browser checks.
