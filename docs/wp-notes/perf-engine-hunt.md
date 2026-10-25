# Engine performance hunt: media status job snapshots

The critical engine paths inspected were project listing/opening, media registration and its derivative queue,
media-status batches during project open, sound-library search, and cache usage/garbage collection. Existing
sound search already ranks and counts facets in one pass; cache reference classification already has an index.
The best safe cut was in `DerivativeService.status`, which cloned and sorted every active job for every medium,
then searched that snapshot for at most six derivative dedupe keys.

Candidates, ranked by expected impact before measurement:

| Opportunity | Expected effect | Decision |
| --- | --- | --- |
| Filter derivative status job snapshots before cloning/sorting | High during imports and project opens with a large queued derivative backlog | Implemented and measured below |
| Avoid whole-project reads/parses in `ProjectStoreFs.list` | Potentially high for many large saved projects | Deferred: a cache must retain detection of externally changed project files |
| Parallelize the six readiness checks per medium | Lower status latency on a slow filesystem | Deferred: batch route already has 16 workers; increased filesystem pressure needs separate evidence |
| Compute newest Remotion bundle once per cache classification | Removes repeated full entry scans when many bundles accumulate | Deferred: infrequent path, small expected benefit |
| Avoid synchronous queue journal writes | Reduces blocking during job progress/state changes | Deferred: durability and recovery contracts make this a higher-risk change |

`JobQueue.list` now accepts an internal `dedupeKeys` filter. The derivative service supplies its six keys, so
unrelated jobs are rejected before `structuredClone` and sort. The existing snapshot timing, newest-first ordering,
equal-timestamp order, external-source handling, readiness precedence, failure lookup, and full list API remain the
same. Filtering by fingerprint-derived keys also retains sharing when different media records refer to identical
bytes. No HTTP schema, persistence format, render output, queue scheduling or durability behavior changed.

## Reproduce the measurements

```sh
pnpm exec tsx apps/engine/bench/media-status.ts
pnpm exec tsx apps/engine/bench/media-status.ts --settled
```

The benchmark loads the original derivative-service source directly from commit `8b4c8936` into a temporary sibling
module (removed in `finally`), and alternates that implementation with the current service. Both use the same real
queue and records. Each pass invokes the complete `DerivativeService.status` method, including six actual
filesystem existence checks per medium, with 16 workers as in the batch HTTP route. The queued case has six jobs per
medium and missing artifacts. The settled comparison has no active jobs and the same missing artifacts. These are
synthetic status workloads; the benchmark does not invoke registration, auto-regeneration, FFmpeg, HTTP, or the UI.
It asserts deep equality of the full returned statuses before timing. There are two warmup rounds and seven
measured rounds, reversing order on alternate rounds. Both versions share the current queue implementation; its
unfiltered path is the original implementation with one inactive optional-filter check added.

Measured on this shared Linux x64 host: AMD EPYC-Genoa Processor, 8 logical CPUs, Node v22.23.4, pnpm 10.34.5.
Other agents' tests/builds were running. Load averages at the start were 13.04 / 5.37 / 2.09 for the queued run and
12.27 / 8.94 / 4.04 for the settled run. Raw wall and process-CPU samples, scenario loads and machine metadata are
in [`media-status.results.json`](../../apps/engine/bench/media-status.results.json).

| Media / active jobs | Original median wall | Filtered median wall | Original median CPU | Filtered median CPU |
| --- | ---: | ---: | ---: | ---: |
| 50 / 300 | 86.33 ms | 20.33 ms | 76.30 ms | 16.80 ms |
| 500 / 3,000 | 7,173.32 ms | 202.03 ms | 7,562.54 ms | 202.89 ms |
| 50 / 0 | 14.13 ms | 10.02 ms | 11.58 ms | 15.80 ms |
| 500 / 0 | 115.37 ms | 107.55 ms | 109.67 ms | 101.05 ms |

The measured 500-medium queued workload takes 35.5 times less wall time and 37.3 times less process CPU. The settled
samples are noisy, and no settled-workload speedup is claimed. The queue still scans its entries per status; this
change removes unnecessary cloning/sorting rather than promising constant-time lookup. End-to-end project-open
speedup remains unmeasured and depends on how many jobs are active.

## Verification

- `pnpm exec vitest run apps/engine/test/jobs.test.ts apps/engine/test/polish-media-status.test.ts --maxWorkers=2`:
  2 files, 19 tests passed, including real fixture generation and HTTP status batches.
- The new queue regression checks selected/missing/empty dedupe-key sets, terminal-state filtering, external-source
  collisions and equal timestamps, detached returned jobs, and unchanged list ordering. It fails on the original
  queue implementation and passes on the changed one (the focused run intentionally selects that single test).
- `pnpm --filter @jasper/engine typecheck`: passed.
- `pnpm exec biome check apps/engine/src/jobs/queue.ts apps/engine/src/derivatives/service.ts apps/engine/test/jobs.test.ts apps/engine/bench/media-status.ts`:
  passed.

Full integration checks and browser integration are run by the coordinating agent after merging the performance
workstreams. No UI or rendering implementation was changed by this engine patch.
