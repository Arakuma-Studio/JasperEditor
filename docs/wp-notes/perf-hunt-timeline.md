# Timeline pointer snapping performance

## Hot path and change

The TimelineController rebuilt and sorted every snap target on each Razor hover and
Shift-snapped ruler scrub. On a sequence with 5,000 clips, each move allocated at
least 10,000 clip-edge targets even when no document data changed. This repeated
work preceded the existing binary-search snap lookup.

The controller now retains one sorted target list, keyed by the immutable sequence
reference and the requested playhead. Razor snapping requests the actual playhead;
ruler scrubbing requests `null`, because the playhead must not attract itself.
Document edits, undo/redo and playhead movement select a new key. Ordinary Razor
snapping being disabled still takes its existing playhead-only path. Excluded-clip
lists collected at gesture start are unchanged.

The cache retains at most one sequence and target array per Timeline panel, replacing
them on a cache miss. It introduces no schema, command, export, persistence or
snapping-priority change. The first query after a changed key still performs the
original collection and sort. The measured benefit applies to consecutive pointer
moves with unchanged targets; changing the playhead between every Razor hover does
not benefit.

This follows the immutable-state and pointer-gesture contracts in
[ARCHITECTURE D-04 and §13](../ARCHITECTURE.md#13-performance-strategy). The behavior
is established by the production target collection and controller tests; no external
behavior or performance formula is assumed.

## Measured evidence

Measured on Linux 6.8.0-138-generic, AMD EPYC-Genoa, 8 virtual CPUs, Node v24.22.1,
pnpm 10.34.5. Other agents were benchmarking on the host: load averages (1/5/15 min)
were 8.86/3.13/1.16 at the start and 11.81/4.07/1.50 at the end. Baseline was
`eb28696c`'s controller, compared with the changed controller in one process, alternating
implementation order per batch. Both used the same real EditorSession, generated
solid clips, geometry and pointer positions. Setup and 100 warm-up calls were outside
timings; results are medians of nine batches of 300 operations.

| Sequence | Operation | Before, µs/op | After, µs/op |
|---|---|---:|---:|
| 1,000 clips | Razor hover | 179.689 | 2.650 |
| 1,000 clips | Shift-snapped ruler scrub | 173.017 | 1.069 |
| 5,000 clips | Razor hover | 1,486.337 | 2.299 |
| 5,000 clips | Shift-snapped ruler scrub | 1,417.159 | 1.164 |

Each baseline/current pair produced identical output checksums: 659040 for Razor
hover and 659000 for ruler scrubbing at either size. A separate pre-edit run of the
same benchmark measured 201.986/194.953 µs at 1,000 clips and
1,478.797/1,522.279 µs at 5,000 clips (hover/scrub); load changed from
6.36/2.17/0.80 to 8.77/2.91/1.07. The alternating run is the comparison above.

These are controller-call measurements, not a claim about total browser frame time,
playback rate or rendering speed. The helper computes geometry during each call and
publishes UI/transport state as in the existing controller tests.

Reproduce current-only timings:

```sh
pnpm exec tsx apps/web/bench/timeline-pointer.ts
```

Reproduce the alternating comparison from the repository root (the temporary module
must stay beside the controller so its relative imports resolve):

```sh
git show eb28696c:apps/web/src/panels/timeline/state/controller.ts > apps/web/src/panels/timeline/state/controller.perf-baseline.ts
pnpm exec tsx apps/web/bench/timeline-pointer.ts apps/web/src/panels/timeline/state/controller.perf-baseline.ts
rm apps/web/src/panels/timeline/state/controller.perf-baseline.ts
```

## Validation

`pnpm exec vitest run apps/web/test/timeline-pointer.test.ts
apps/web/test/timeline-gestures.test.ts apps/web/test/timeline-model.test.ts
apps/web/test/sound-cue-seam-model.test.ts --maxWorkers=2`: 4 files, 53 tests passed.
New cases exercise public controller behavior across playhead moves, snapping toggles,
clip edits, undo/redo, marker additions, ruler/Razor switching and the cut matching the
frame displayed by the Razor. Existing cases cover linked Razor cuts and cue targets.

`pnpm --filter @jasper/web typecheck` passed. Browser checks
should hover the Razor, move the playhead and cut, then Shift-scrub near clip edges
and markers. The integrated verification and visual exercise are owned by the parent
investigation; this focused benchmark does not assert end-to-end browser performance.
