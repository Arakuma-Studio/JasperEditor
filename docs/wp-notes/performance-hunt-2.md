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
