# Grouped timeline selection performance

The critical path is `EditorSession.select('timeline', ids)` →
`expandClipSelection`. A marquee or Select All operation can include every clip
in a group. The previous expansion visits that group's entire member array for
each selected member, although the output `Set` already contains those IDs after
the first visit. A 5,000-member group therefore performs 25 million insertions.
This is an observation of repository code, with no external algorithm or asset.

Expansion now visits each link/group member array once per call. It retains the
input order, adds links before groups, keeps first-insertion order, and expands
only the explicitly selected clips. The state is local to the call, so document
edits and subsequent selections cannot observe stale membership. Array identity
also keeps distinct groups with identical IDs in different sequences independent.
The sequence lookup is unchanged. There is no schema, persistence, API or editing
behavior change.

## Measurement

Baseline: `eb28696c`, unmodified `packages/session/src/selection.ts`. Before editing
production code, the new benchmark measured 309.46 ms for all 5,000 members of one
group and 12.66 ms for all 1,000 members of one group. The table below is the
subsequent paired comparison of actual baseline and current modules in one
process, alternating their order each round.

Machine: Linux x64, AMD EPYC-Genoa, eight logical CPUs, Node 24.22.1, pnpm 10.34.5.
Paired run start load: 5.35 / 1.90 / 0.71; other agents were building and testing on
the same host. Initial baseline run load: 4.49 / 1.37 / 0.50. Values are medians
of seven rounds after warm-up, in milliseconds per production expansion call.
Projects are invariant-checked before timing; baseline/current output arrays are
compared exactly, and every timed batch checks its result count.

| Workload | Before wall / CPU | After wall / CPU |
|---|---:|---:|
| All 5,000 clips in one group | 340.503 / 320.986 | 1.439 / 1.441 |
| All 1,000 clips in one group | 12.368 / 12.356 | 0.088 / 0.088 |
| All 5,000 clips in groups of 10 | 0.950 / 0.950 | 0.680 / 0.681 |
| All 5,000 ungrouped clips | 0.454 / 0.455 | 0.450 / 0.451 |
| One member of a 5,000-clip group | 0.301 / 0.301 | 0.331 / 0.326 |
| One ungrouped clip | 0.0002 / 0.0002 | 0.0012 / 0.0015 |

The bulk group case improves by approximately 237× in this workload. The single
clip controls retain submillisecond timings and show small setup/noise costs; this
does not claim a whole-editor speedup. Large multi-sequence selections still
probe sequences for each selected ID. A call retains at most one reference per
encountered link/group member array, released when the call returns; no cache
survives selection changes.

Reproduce from the repository root:

```bash
mkdir -p test-results/performance
git show eb28696c:packages/session/src/selection.ts > test-results/performance/selection-baseline.ts
pnpm exec tsx packages/session/bench/grouped-selection.ts test-results/performance/selection-baseline.ts
```

The benchmark prints machine/load metadata, every wall/CPU sample and medians.
It does not write generated results into tracked files.

## Verification

- `pnpm exec vitest run packages/session/test/selection.test.ts packages/session/test/session.test.ts packages/session/test/integrity-property.test.ts --maxWorkers=2`: 3 files / 22 tests passed.
- `pnpm exec vitest run packages/session/test --maxWorkers=2`: all 25 files / 98 tests passed.
- `pnpm --filter @jasper/session typecheck`: passed.
- `pnpm exec biome check packages/session/src/selection.ts packages/session/test/selection.test.ts packages/session/bench/grouped-selection.ts`: passed.

Selection coverage includes shared links/groups, duplicate inputs, insertion
order, independently disabled link/group selection, no recursive expansion of
implicitly added members, multiple sequences, and membership changes between calls. The session and property suites cover normal document
editing and undo/redo integrity. This change does not alter rendering or export.
