# Model performance audit: timeline Find

The shared model's Find implementation serves Edit → Find / Find Next / Find All in the web/desktop editor
(`apps/web/src/gaps/FindDialog.tsx`) and the MCP `find` tool (`apps/mcp/src/tools/gaps.ts`). Each Find Next repeats
the search. Source-name and Any Field searches previously enumerated every project item and searched that array
again for every clip. A 5,000-clip sequence with 2,000 project media items spent over one second in this synchronous
function on the measured host.

## Candidates inspected

These were expectations from code inspection before measurement, not measured product-wide impact estimates:

1. Timeline source-name searches: quadratic item enumeration per clip, potentially seconds of UI blocking on large
   projects; a local source-name index has low risk. Selected and measured below.
2. Find criteria preparation: the same active-criteria array was filtered and allocated for each item, clip and
   marker; small linear allocation reduction. Prepared once per search alongside the source-name fix.
3. Audio solo routing: each solo/safe seed walks the routing graph separately; possible quadratic work with many
   soloed strips, but ordinary mixers have few seeds and this is snapshot construction rather than a playback tick.
   Left unchanged without workload evidence.
4. Snapshot media descriptor lookups: repeated small stream/locator scans; most lists contain only a few entries,
   while snapshot track grouping already addresses the larger scaling problem. Left unchanged.
5. Scene effect/parameter resolution: allocations in animated layer evaluation; static props already use an
   immutable-clip cache and scene clip lookups use binary search. Left unchanged without a new profile showing a
   worthwhile remaining bottleneck.

## Implementation and behavior

`packages/project/src/find/index.ts` now builds maps of the first project item name for each media/sequence source
once per search, on the first source lookup that needs them. Duplicate source items retain the first-item behavior,
including an empty first name. Media still matches its original filename even without a project item. Source-less
clips, clip-name-only, text-only and marker-only searches do not build the maps. Maps are local to a search so
mutable documents, renamed/deleted items and subsequent searches always see current names.

The source lookup work becomes O(items + clips), with the existing hit sorting unchanged. Index construction is
included in every measured search; there is no cross-search cache. Temporary map storage is O(items) and is
released after the call. Active criteria are prepared once for both project and timeline searches. Hit order,
operators, case matching, all/any semantics, marker handling and Find Next behavior are unchanged. No command,
document schema, persistence contract, rendering path or API changed.

## Measurements

The rerunnable benchmark is `packages/project/bench/timeline-find.ts`. It constructs ordinary video clips and
project media items outside the timed region, checks byte-identical JSON hits for the original and current
implementations, then alternates their sample order in one process. Seven samples per variant each run for at
least 100 ms; expensive baseline searches therefore have one iteration per sample. Fixtures return every clip,
so hit construction and sorting are included. Clip-name search is the control without source lookup.

Machine: AMD EPYC-Genoa, 8 logical CPUs, 16,366,510,080 bytes RAM, Node 22.23.4, shared Linux host. Load average
was 15.41 / 8.07 / 3.31 at start and 15.46 / 8.81 / 3.73 at end. Both variants ran under the same load; process CPU
medians accompany wall medians. Raw samples and output digests are in
[`timeline-find.results.json`](../../packages/project/bench/timeline-find.results.json).

| Clips / media items | Query | Wall ms before → after | CPU ms before → after |
|---|---|---|---|
| 100 / 100 | Source Name | 1.138 → 0.089 | 1.138 → 0.089 |
| 1,000 / 1,000 | Source Name | 114.568 → 1.038 | 113.819 → 1.037 |
| 5,000 / 2,000 | Source Name | 1,165.560 → 6.717 | 1,166.329 → 6.221 |
| 5,000 / 2,000 | Any Field | 1,171.809 → 8.766 | 1,170.285 → 8.799 |
| 5,000 / 2,000 | Clip Name (control) | 4.581 → 4.418 | 4.601 → 4.449 |

Reproduce from the repository root:

```sh
git show 8b4c8936:packages/project/src/find/index.ts > packages/project/src/find/index.perf-baseline.ts
pnpm exec tsx packages/project/bench/timeline-find.ts packages/project/src/find/index.perf-baseline.ts
rm packages/project/src/find/index.perf-baseline.ts
```

The adjacent baseline file preserves the original module's relative imports. Passing no argument measures only
the current implementation. These are isolated function measurements, not whole-editor latency or FPS claims.
For a single source lookup, building the complete maps can cost more than an early linear match; the measured
workload is repeated source lookup in medium/large sequences.

## Validation

- `pnpm exec vitest run packages/project/test/gaps-find.test.ts apps/web/test/gaps-ui5-tracks.test.tsx --maxWorkers=2`:
  12 tests passed, including duplicate media/nested-sequence item precedence, empty first names, original filename
  fallback, in-place rename/deletion across searches, source criteria combinations and the existing arbitrary-query
  property test. Existing web tests exercise Find Next, Find All and the Find dialog.
- `pnpm --filter @jasper/project typecheck`: passed.
- Targeted Biome checks and `git diff --check`: passed.
- Full workspace lint/typecheck/tests/build and integration verification are owned by the integrating agent.

No external behavior/formula was researched or ported. Complexity expectations above are code-derived; the table
contains measured values only. No browser UI, preview/export frame, GL or native-render behavior changed.
