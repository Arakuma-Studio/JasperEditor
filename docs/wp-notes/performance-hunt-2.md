# Second performance investigation

Baseline: `eb28696c`. This investigation builds on the earlier
[performance hunt](performance-hunt.md); its historical results are not reused
as measurements of this checkout.

The critical paths are project opening (JavaScript loading, validation, media
status and mounting), interactive editing (selection, snapping, navigation and
document updates), preview/audio processing, and background engine jobs/export.
Existing standalone benchmarks, production bundle measurements, browser
integration tests and the workspace verification gate provide the tools.

## Ranked candidates from inspection

These are expected effects, pending paired measurements on identical inputs.

1. **Grouped selection:** expanding each already selected group member repeats
   the same member traversal. Visit each member list once per expansion to
   remove quadratic work during large selections.
2. **Media job lookup:** status lookups filter a whole job history per medium.
   Index deduplication keys so only matching jobs need inspection, retaining
   queue lifecycle and ordering behavior.
3. **Timeline razor hover:** pointer moves repeatedly collect and sort unchanged
   snapping targets. Reuse targets while their inputs remain unchanged.
4. **Edit-point navigation:** previous/next cut navigation repeatedly allocates
   and sorts all clip boundaries. Reuse existing immutable timeline indexes.
5. **Expression editor loading:** CodeMirror enters the initial application
   graph even before editing an expression. Defer its runtime until used,
   retaining error recovery and offline availability.

A sixth investigation measures FFT plan construction for large audio analysis
buffers. It will be retained only if paired measurements show an improvement
without changing arithmetic or output samples.

Each worker uses its own branch/worktree and records the affected production
operation, baseline comparison, machine/load, correctness checks and limits in
its evidence note. Only measured improvements are integrated. No schema,
persistence format, editing API, media quality or authentication changes are
intended.

## Measured results

Function comparisons alternate actual baseline and current implementations on
the same inputs in one process. Machine: Linux x64, AMD EPYC-Genoa, eight logical
CPUs, Node 24.22.1, pnpm 10.34.5. Other agents ran builds/tests concurrently;
the linked notes record load, raw samples, controls and reproduction commands.
These measurements describe the named workloads, not overall editor speed.

| Production operation | Before | After | Evidence |
|---|---:|---:|---|
| Expand selection of 5,000 clips in one group | 340.503 ms | 1.439 ms | [Selection](perf-hunt-session.md) |
| Media status, 500 media / 3,000 active jobs | 138.33 ms | 69.38 ms | [Engine](perf-hunt-engine.md) |
| Razor hover, 5,000 clips, warm snap targets | 1.486 ms | 0.0023 ms | [Timeline](perf-hunt-timeline.md) |
| Next edit, 5,000 clips, warm track indexes | 0.1695 ms | 0.000447 ms | [Navigation](perf-hunt-project.md) |
| Construct a 1,048,576-point FFT plan | 24.752 ms | 10.293 ms | [Audio](perf-hunt-audio.md) |
| Synchronize a 30-second 8 kHz audio pair | 241.889 ms | 203.612 ms | [Audio](perf-hunt-audio.md) |

Selection output order, job status objects, navigation results and complex
forward/inverse FFT bytes match their respective baselines. Pointer behavior is
covered across playhead changes, edits, undo/redo, markers and tool switches.
Cold index/target building retains its original work. The queue index adds
O(retained keyed jobs) memory, and external schedulers still scan. FFT transforms
with a reused plan remain approximately unchanged. No API or quality tradeoff
is introduced.
