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
| Initial JavaScript, gzip | 2,775,279 bytes | 2,630,046 bytes | [Bundle](perf-hunt-bundle.md) |
| Construct a 1,048,576-point FFT plan | 24.752 ms | 10.293 ms | [Audio](perf-hunt-audio.md) |
| Synchronize a 30-second 8 kHz audio pair | 241.889 ms | 203.612 ms | [Audio](perf-hunt-audio.md) |

Selection output order, job status objects, navigation results and complex
forward/inverse FFT bytes match their respective baselines. Pointer behavior is
covered across playhead changes, edits, undo/redo, markers and tool switches.
Cold index/target building retains its original work. The queue index adds
O(retained keyed jobs) memory, and external schedulers still scan. FFT transforms
with a reused plan remain approximately unchanged. No API or quality tradeoff
is introduced.

The bundle measurement isolates the expression-loading change from the other
workers' small source changes. It removes 145,233 gzip bytes (5.23%) from the
initial static graph; it does not claim a measured end-to-end startup time gain.
The expression controls load asynchronously on first use, with a visible local
failure state and reload action. The service worker warms their source after
window load for offline availability, so total background transfer is roughly
unchanged. The editor body and expression semantics are preserved.

Additional paired runs on CI's Node 20.19.6 also matched outputs exactly:
5,000-clip next-edit navigation measured 0.149613 → 0.000478 ms and Razor
hover 3.023164 → 0.003031 ms (warm indexes/targets). The same EPYC host had
load near 5.9 for navigation and 4.82 → 6.66 for the pointer run. The standalone
benchmarks and original Node 24 results remain in their linked evidence notes.

## Integrated checks

The initial host uses Node 24.22.1. Its first full-suite attempt found five
pre-existing synth-byte pin failures and was stopped: the exact same received
hashes reproduce with the original FFT, and synthesis does not call FFT. No
goldens or tolerances were changed. Node 20.19.6, matching the repository CI's
`20.19` runtime, passes all 42 synth tests unchanged. The complete gate is run
with that runtime, FFmpeg/ffprobe required and Chrome 153 available. The
privilege mask removes root's DAC override capabilities so permission tests
exercise their intended denial paths.

The first CI-runtime attempt also exposed a missing host library when the
default Electron H.264 playback regression started: `libgtk-3.so.0`. Installing
the GTK runtime made both Chrome/Electron playback cases pass unchanged
(2 tests). That interrupted run is not reported as a passing full suite; the
complete gate was restarted after provisioning the dependency.

The run emitted a nonfatal `MaxListenersExceededWarning` for eleven abort
listeners on an `AbortSignal`. It was not suppressed; listener registration
code is unchanged by this investigation.

- Production engine, web and Remotion builds and E2E typecheck passed.
  The web build needs `NODE_OPTIONS=--max-old-space-size=5120` on this host;
  2 GiB and 3 GiB baseline attempts exhausted the V8 heap.
- Final full workspace tests on Node 20.19.6: 942 files passed / 52 skipped;
  9,382 tests passed / 300 skipped, zero failures (2,222.66 seconds). The run
  required FFmpeg/ffprobe oracles, enabled Chrome/GL tests and retained the
  root permission mask. Lint and every workspace typecheck passed before it.
  The complete workspace production build then passed with the 5 GiB heap,
  completing the four-stage shared-host verification gate. Build warnings about
  third-party annotations, existing mixed static/dynamic imports and large
  chunks remain; they are not performance measurements or suppressed failures.
- `pnpm perf --sections micro --label second-hunt-integrated` passed on
  Node 20.19.6, including all eleven budgets on the 200-sequence / 5,000-clip
  project (load factor 1). Generated historical result files were restored;
  this run's report remains under ignored `test-results/performance/`.
- `pnpm e2e performance-editing.spec.ts bundle-loading.spec.ts expressions.spec.ts
  pwa.spec.ts smoke.spec.ts audio-mix.spec.ts`: 12 passed, one skipped
  (2.1 minutes). It used Node 24.22.1, Chrome 153, port 49631,
  harness-provided authentication and `E2E_SKIP_BUILD=1` after the current
  engine/web/Remotion/MCP outputs were built; fixture/model preparation and the
  LGPL binary guard still ran.
- Browser coverage includes actual Razor previews/cuts after edits, undo/redo,
  next/previous edit shortcuts, marker snapping, expression typing/errors/undo,
  chunk failure and saved-document reload recovery, first expression-field use
  offline, audio meters, voice-over, native export and Remotion title export.
  Editor screenshots and extracted native/Remotion frames were inspected.
- Independent read-only reviews found no correctness issues in the queue index,
  immutable pointer cache, indexed navigation, FFT recurrence or lazy module
  boundary. Emitted-module analysis found no static import cycles and confirmed
  the expression runtime's complete offline dependency closure.

`pnpm mg:build` skips because cargo is unavailable, so the native Rust motion
graphic E2E case was not tested. The full Playwright catalogue, desktop/packaged
suites and opt-in extended fuzz/Remotion suites were not run. No shaders,
decoders, document formats or export algorithms changed.
