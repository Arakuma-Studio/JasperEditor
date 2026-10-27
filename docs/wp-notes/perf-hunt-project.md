# Indexed edit navigation and gap lookup

The critical path is timeline navigation and pointer hit-testing. `goToEdit` in
`apps/web/src/commands/transport.ts` and Comparison View call `nextEditPoint` /
`prevEditPoint`; timeline hit-testing calls `gapAt`. At baseline `eb28696c`, each
navigation collected every targeted clip boundary, allocated a Set and sorted
it. A gap hit allocated every gap on the track before finding the requested one.

These queries now reuse the existing per-track index. `nextEditPoint` finds the
first clip ending after the query, then chooses its start or end. The previous
query finds the last clip starting before the query, then chooses its end or
start. `gapAt` checks the neighbours around the first clip ending after the
query. This follows the same no-overlap contract (INV-003) as `clipAt` and
`clipsInRange`; start and end order agree on a valid track. The source of this
contract is `packages/project/src/invariants.ts` and ARCHITECTURE §13, not a new
assumption about media. Strict previous/next boundaries, targeted tracks,
caption/audio inclusion, the initial gap and absence of an unbounded trailing
gap are preserved. No command, schema, persistence or rendering behavior changes.

## Measurements

Measured on Linux x64, AMD EPYC-Genoa, eight logical CPUs, 16,366,510,080 bytes
RAM, Node v24.22.1 and pnpm 10.34.5. The host was shared with the other performance
workers. Load average at the start was 11.81 / 4.07 / 1.50 and at the end
13.90 / 4.91 / 1.82. The baseline was measured before editing, then the actual
baseline module and changed module were compared alternately in one process,
with identical fixtures and seven samples per variant. Both indexes were warmed
before timing. Every output at the benchmark's seven query positions was
asserted equal before timing.

Median wall milliseconds per query, across three populated video tracks with
20-frame clips and 10-frame gaps (the other tracks remain empty):

| Clips | Query | Baseline | Changed |
|---:|---|---:|---:|
| 100 | Next edit | 0.004406 | 0.000374 |
| 1,000 | Next edit | 0.036478 | 0.000446 |
| 5,000 | Next edit | 0.169507 | 0.000447 |
| 5,000 | Previous edit | 0.182929 | 0.000646 |
| 5,000 | Gap hit | 0.021103 | 0.000075 |
| 50,000 | Next edit | 8.989629 | 0.000591 |
| 50,000 | Previous edit | 8.808290 | 0.000755 |
| 50,000 | Gap hit | 0.399538 | 0.000083 |

The complete wall and CPU samples are in
[`edit-navigation.results.json`](../../packages/project/bench/edit-navigation.results.json).
This is a microbenchmark of warm production calls, including their result
allocations. It does not establish a whole-editor frame-rate improvement. Cold
index construction and edit-time index rebuilding still cost the same as before.
The asymptotic reduction is from collecting/sorting all boundaries to binary
searching each targeted track; gap lookup no longer walks and allocates all gaps.

Reproduce from the repository root:

```sh
git show eb28696c:packages/project/src/derive/index.ts > packages/project/src/derive/index.perf-baseline.ts
pnpm exec tsx packages/project/bench/edit-navigation.ts packages/project/src/derive/index.perf-baseline.ts
rm packages/project/src/derive/index.perf-baseline.ts
```

With no argument, the benchmark measures only the current module. Fixture
construction, initial index creation and equality comparisons are outside the
timing window; each sample runs queries for at least 100 ms.

## Verification

- The new differential tests passed against the original implementation before
  editing and the changed implementation afterwards. They compare against
  independent boundary/gap scans at exact boundaries, fractional positions,
  empty/missing/duplicate targets, empty tracks, nonfinite positions, changed
  document identities, undo-like old-version reuse and repeated Immer draft
  mutations. A fast-check property covers 75 generated non-overlapping projects
  with up to six tracks and 35 clips per track, querying both sides of every cut
  as well as random positions.
- `pnpm exec vitest run packages/project/test/edit-navigation.test.ts
  packages/project/test/derive-draft-index.test.ts
  packages/project/test/perf-budgets.test.ts --maxWorkers=2`: three files / six
  tests passed.
- `pnpm --filter @jasper/project typecheck`: passed.
- Biome check of the implementation, new tests and benchmark: passed.

No shaders, audio processing, media I/O or export algorithms were changed, so no
specialized renderer suite was run for this isolated change. The parent
integration owns the full workspace gate and browser checks.
