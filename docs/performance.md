# Performance: budgets, instrumentation, benchmarks

Owner: workstream `previews` (design notes in [`wp-notes/previews.md`](wp-notes/previews.md) §7); the editing-core
budgets (§13 command and gesture) are workstream `perf-core` ([`wp-notes/perf-core.md`](wp-notes/perf-core.md)); the editor UI at
scale (§5) is workstream `ui-perf` ([`wp-notes/ui-perf.md`](wp-notes/ui-perf.md)); project open (§6) is workstream
`polish` ([`wp-notes/polish.md`](wp-notes/polish.md) §5). The strategy is
[ARCHITECTURE §13](ARCHITECTURE.md#13-performance-strategy); this page lists the budgets, how each one is enforced,
how to measure, and historical measured results. The tables in §§4–6 record the stated builds and host loads;
they are not validation of the current checkout.

The [performance investigation](wp-notes/performance-hunt.md) records measured cuts to
Find, Project sorting, bulk selection, resampling, media-status lookup and initial
JavaScript loading, with baseline comparisons, rerunnable tools and integration checks.

The [second investigation](wp-notes/performance-hunt-2.md) covers grouped
selection, indexed media-job lookup and edit navigation, pointer snapping,
expression-editor loading and FFT plan construction, with new paired baselines.

## 1. Budgets

| Budget | Value | Source | Checked by |
|---|---|---|---|
| One command + reindex on a 1 000-clip sequence | < 4 ms | §13, S01:SES-011 | `packages/session/test/perf-budgets.test.ts` (× load × 1.5 in the gate, exact with `PERF=1`) |
| 50-clip gesture update + reindex | < 8 ms | §13, S02:TL-160 | same file (× load × 1.5 in the gate, exact with `PERF=1`) |
| `resolveSceneAt` with 50 layers | < 1 ms | §13, S03:NFR-002 | `packages/project/test/perf-budgets.test.ts` |
| Render bar (segments, hashes, cost) of 1 000 clips | < 120 ms | previews | `packages/project/test/perf-budgets.test.ts` |
| Program monitor, one 1080p H.264 clip | ≥ 90 % of the sequence rate | previews | `pnpm perf` (editor) |
| Program monitor, a GPU-effect stack from its render previews | ≥ 90 % of the sequence rate | previews | `pnpm perf` (editor) |
| Player stalls recovered by the watchdog during playback | 0 | previews | `pnpm perf` (editor) |
| Native H.264 export of 1080p30 | ≥ real time (30 fps) | previews | `pnpm perf` (export) |
| Smart-rendered H.264 export of an untouched clip | ≥ 4 × real time | previews | `pnpm perf` (export) |
| 30-step drag of 11 clips on a 1 000-clip sequence: mean main-thread work per frame | < 16 ms (p50 / p95 reported) | ui-perf | `pnpm perf` (ui; scaled by load² unless `PERF=1`, because the browser is another process) |
| The same drag, scripted (30 moves 16 ms apart), wall time | < 1.5 s | ui-perf | same |
| Scrolling / zooming a 5 000-clip timeline | ≥ 50 fps | ui-perf | same |
| Project panel with 2 000 items, scrolling | ≥ 50 fps | ui-perf | same |
| Opening a 2 000-item project: editor interactive and every medium resolved | < 2 s | polish | `pnpm perf --sections ui --ui open` (scaled by load² unless `PERF=1`) |
| Autosave of the 8 MB scale project after a one-clip edit (serialisation on the UI thread) | — (measured: ≈ 0.5 ms) | ui-perf | `packages/project/bench/json-cache.ts` |
| Lumetri bake, colour scopes, shader compilation and tracking cancellation | limits documented by each owner | their specs and wp-notes | `packages/project/test/{color,lumetri-grade,scopes}.test.ts`, `packages/compositions/test/fx-compile-budget.test.ts`, `apps/engine/test/tracking.test.ts`, through `budgetMs` |

The performance runner records budget misses in its report and exits nonzero for them with `PERF=1`. Retained
unit timing tests fail against their load-scaled limits in the normal test gate.

## 2. Load-tolerant enforcement

Timing assertions measure the machine as much as the code. On the shared development host (12 cores, often load
average 8–40 from parallel agents) fixed budgets failed without any regression. `scripts/perf/budget.ts`:

- `loadFactor()` — best of five runs of a fixed single-threaded workload over its reference time (15 ms on the
  reference machine, measured best of 7 at load ≈ 9: 15.4–15.9 ms); ≥ 1.
- `budgetMs(base, {parallel})` — in the normal gate: `base × loadFactor` (`× loadFactor²` for code that waits for
  other threads or processes); with `PERF=1`: exactly `base`.
- `budgetReport(name, measured, base)` — the line each budget test prints.

A real regression still fails: the calibration workload does not get slower when the code does. No budget was
raised: at load factor 1 the enforced budget is the documented one.

### Test timeouts of the web project (workstream `hardening`)

Historical profiling during hardening: three web tests were each seen once failing with Vitest's default 5 s
limit on a loaded host and passing alone:
`project-windowing`, `shell-render`, `speech`. They were profiled (`node --cpu-prof` over the Vitest run, and
`process.cpuUsage()` per phase; times below were **measured** on the shared host at load average 20–25, so compare
them with each other, not with a quiet machine):

| Test | Where the time went | Change | Effect |
|---|---|---|---|
| `project-windowing` › "renders a window of a large bin" | `useRowWindow` started with windowing off: the first render mounted all 600 rows (nine columns each), the effect then trimmed them to 80 | The first render is already windowed (`apps/web/src/panels/project/virtual.ts`) | 2 059 ms → 296 ms. Also in the app: opening a 2 000-item project no longer mounts and paints every row once |
| `shell-render` › header test | Five full mounts or re-layouts of the editor (≈ 900 ms for the first, 100–700 ms each after); no single hot spot. `ContextMenu` / `DropdownMenu` resolved and built their whole menu on every render of their owner although closed (357 ms of 5.6 s in the profile, two rounds) | Menu items are resolved when the menu opens (`packages/ui/src/menu/Menu.tsx`, as the menubar already did) | ≈ 6 % of the test; every panel with a context menu renders cheaper in the app |
| `speech` › dialog test | A Radix select renders its items also while closed; the 101-entry language list was rebuilt on every render of the dialog. Role queries over the open list are the rest | `Select` keeps its items while `options` is the same array; the dialog's language list is one array | 1 272 → 1 187 ms of CPU for the test in its third round (≈ 7 %) |

The profiles attributed the remaining time to full editor renders, a 101-option list and accessibility-tree
queries in happy-dom with development React. The current web project's limit is scaled with the host
(`apps/web/vitest.config.ts`): `5 s × loadFactor²`, at least 15 s, at most 60 s; `PERF=1` keeps 5 s. A hung test
still fails within a minute; `waitFor` / `findBy…` keep their own 1 s deadlines.
`apps/web/test/test-timeout.test.ts` pins the scaling.

Also moved to the load-scaled budget: the colour-scope timing test (`packages/project/test/scopes.test.ts`, 60 ms per
scope at 1080p; it measured 63 ms on the loaded host with no code change). `PERF=1` enforces 60 ms exactly.

## 3. Measuring

```bash
pnpm build                                   # the editor and export sections use the built stack
pnpm perf                                    # micro, editor, export, ui; report in test-results/performance/<label>.{json,md}
pnpm perf --sections editor --label my-run   # one section; --seconds N per playback scenario (default 6)
PERF=1 pnpm perf                             # fail on any documented budget, no load scaling
PERF=1 pnpm vitest run packages/project/test/perf-budgets.test.ts packages/session/test/perf-budgets.test.ts
```

The editor and export sections start `e2e/serve.mjs` on `PERF_PORT` (default 49465) with a throwaway appdir and stop
it afterwards (or use `BASE_URL` of a running stack).

- **micro**: the existing synthetic benches (`packages/project/bench/*`, `packages/session/bench/*`,
  `apps/web/bench/*`, `apps/engine/bench/*`).
- **editor** (headless Chrome with HTML-in-Canvas, the real app): per scenario, frames shown / dropped and fps from
  `PlaybackDriver.stats`, the UI frame rate (requestAnimationFrame count), watchdog kicks, the render bar. Scenarios:
  one 1080p H.264 clip; a 3-layer stack (scaled, translucent); a GL blend scope over video and the same stack with an
  adjustment layer (Invert) over it, which the flat compositor draws (compositor; measurements in
  `wp-notes/compositor.md` §6); Gaussian Blur + Black & White live; the same after Render Effects In to Out
  (`/api/previews/render`), from the previews.
- **export**: 300 frames of 1080p30 through `/api/exports`: native H.264, native ProRes 422 HQ, smart-rendered H.264
  (copy path), and a preview render of the same range.

- **ui** (headless Chrome, the real app, `scripts/perf/ui-run.ts`): generated projects (1 000 / 5 000 colour mattes,
  one clip with 200 keyframes per parameter, 2 000 media items) and scripted gestures — the perf-core drag, a trim,
  a playhead scrub, selection clicks, wheel scroll and zoom, Effect Controls scrub, Project panel scroll — measured from a Chrome
  trace: frames, fps, main-thread work per frame (p50 / p95 / mean), busy fraction, wall time. `--ui drag,scroll`
  runs a subset. `scripts/perf/ui-profile.ts <fixture> <scenario>` adds a source-mapped CPU profile;
  `scripts/perf/ui-compare.ts <webA> <webB>` runs two builds alternately for before/after at the same load.

Live counters: `GET /api/perf` (engine CPU, memory, event-loop delay p50/p99, jobs, render throughput), the editor's
`perf` UI action (playback counters, UI fps, render bar summary), MCP `perf_stats` (both).

## 4. Historical results

Machine: AMD EPYC (12 cores, KVM), Node 20.20.2, CPU-only (SwiftShader WebGL, software video decode in headless
Chrome), shared with other agents. Before/after numbers are from the same build.

**`pnpm perf --label previews-2026-10-08`** (measured 2026-10-08, load average 6.9 / 8.2 / 8.1, load factor 1.31;
`test-results/performance/previews-2026-10-08.md`):

| Measurement | Result | Budget (enforced at this load) |
|---|---|---|
| One 1080p H.264 clip, Program monitor | 21.5 fps (130 shown, 36 dropped), UI 26.7 fps | 27 (20.6) — ok |
| 3-layer stack | 4.2 fps, UI 22.3 fps, 1 watchdog kick | — |
| GPU effects live | 5.0 fps, UI 25.4 fps | — |
| Render Effects In to Out of the 10 s clip (300 frames; GPU effects render through headless Chrome) | 175 s (≈ 1.7 fps) | — |
| GPU effects from previews | 15.9 fps (96 shown, 47 dropped), UI 23.6 fps | 27 (20.6) — **missed** |
| Watchdog kicks over all scenarios | 1 (the 3-layer stack) | 0 — **missed** (see below) |
| Native H.264 export, 300 frames | 38.1 fps | 30 (22.9) — ok |
| Native ProRes 422 HQ export | 16.8 fps | — |
| Smart-rendered H.264 export (copy) | 142.7 fps | 120 (91.7) — ok |
| Preview render of the 300 frames (no effects, I-frame H.264) | 5.8 s | — |

An earlier run at load factor 1.25 (export only) measured 58.1 fps native H.264, 21.8 fps ProRes, 167.7 fps smart
render; one at 1.31 measured 16 fps for the single clip and 18.7 fps from previews. Playback numbers on this host
vary by ±30 % between runs.

Reading the playback numbers: this host decodes and composites in software, so the Program monitor's ceiling is far
below a desktop GPU's. The previews still turn a 5 fps effect stack into 16–19 fps, close to what the same machine
reaches for one plain clip (16–21.5 fps). The one watchdog kick happened in the 3-layer scenario at ≈ 4 fps: frames
more than 600 ms apart looked like a stall. Fixed after this run: the watchdog window now grows with the play's
measured frame interval (4 ×, at most 2.5 s; `apps/web/test/transport.test.ts`), so a slow render is no longer
"recovered". A rerun with the adaptive window on a much busier host (load factor 1.90, 2026-10-08,
`previews-2026-10-08-watchdog`: single clip 6.2 fps, 3-layer stack 1.3 fps, GPU effects 2.7 fps live and 4.6 fps from
previews, preview render 333 s) still kicked once in the 3-layer stack at 1.3 fps: there the first frame after play
or a single frame took longer than the window. So the counter is reliable as a stall signal only when the machine
renders at a few fps or more; at ≈ 1 fps a kick costs one extra seek. The historical AudioContext-race checks
(wp-note §5) measured 0 true stalls in 40 seek-and-play cycles and in the then-current E2E spec's 12 cycles.

**ARCHITECTURE §13** (`pnpm vitest run packages/project/test/perf-budgets.test.ts packages/session/test/perf-budgets.test.ts --reporter=verbose`, same host, load factor 1.24–1.26, 2026-10-08):

| Budget | Measured | Status |
|---|---|---|
| `resolveSceneAt`, 50 layers | < 0.05 ms | met |
| Render bar, 1 000 clips | 90 ms (52 ms at lower load) | met |
| Command + reindex, 1 000 clips | 31.9 ms (budget 4 ms) | missed then; **met by perf-core**, below |
| 50-clip gesture update | 135.8 ms (budget 8 ms) | missed then; **met by perf-core**, below |

**perf-core, 2026-10-08** (same host, `PERF=1 pnpm vitest run packages/session/test/perf-budgets.test.ts
packages/project/test/perf-budgets.test.ts --maxWorkers=2 --reporter=verbose`, three runs at load average 10–13,
load factor 1.5; the tests now include the per-track reindex in both budgets):

| Budget | Before (same build without perf-core, load ≈ 18) | After | Status |
|---|---|---|---|
| Command + reindex, 1 000 clips | 31.1 ms | 1.7 / 1.9 / 2.8 ms | met |
| 50-clip gesture update + reindex | 144.2 ms | 3.6 / 4.6 / 6.5 ms | met |
| 50-clip gesture commit (invariants included; `packages/session/bench/editing-core.ts`) | 181 ms | 7.5 ms | — |
| Timeline pointer move of a 50-clip drag incl. the panel's derivations (`apps/web/bench/timeline-gesture.ts`) | — | best 2.8 ms, median 7.2 ms | — |

At load average 25–45 single strict runs measured up to 10 ms (command) and 57 ms (gesture): those are the host,
not the code (the normal gate scales by the measured load factor, which stays honest). Scale benchmark
(`packages/session/bench/scale.ts`, 200 sequences / 5 000 clips, load factor 1.29–2.0): small edit 76 ms
(golden-fuzz) → 2.3–4.6 ms, 300-clip edit across sequences 355 → 95 ms, whole-document invariant check 25–40 ms
(only on unverified documents now). How: incremental invariants, delta-scoped normalizers, proxy-free draft
reads, a per-track index derived from the previous version — [`wp-notes/perf-core.md`](wp-notes/perf-core.md).

## 5. Editor UI at scale (ui-perf)

Workstream `ui-perf` ([`wp-notes/ui-perf.md`](wp-notes/ui-perf.md)): where the time went and what changed. Measured with
`pnpm exec tsx scripts/perf/ui-compare.ts <before> <after> --rounds 2` (2026-10-09, same host as §4, load average
20–30 during the run, other agents building): the web build of `integrate/parity` at `ea17f67d` (before) and of this
workstream (after), served by the same built engine, every scenario run alternately on both. Two runs per build;
work per frame from the Chrome trace (main-thread time between frame begins).

| Scenario | Before (two runs) | After (two runs) | Budget |
|---|---|---|---|
| 30-step drag of 11 clips on 1 000: mean work per frame | 49.7 / 22.7 ms (p95 234 / 71) | 11.5 / 12.4 ms (p95 32 / 28) | < 16 ms — **met** |
| the same drag: wall time | 8.05 / 3.32 s | 2.10 / 2.01 s | < 1.5 s — **missed** (floor of the scripted drag on this host: 1.0–1.35 s on a blank page) |
| trim on 1 000: mean / p95 | 27.9 / 133, 13.9 / 54 ms | 9.4 / 24, 14.8 / 45 ms | — |
| playhead scrub on 1 000: mean / p95 | 16.6 / 64, 10.5 / 31 ms | 8.1 / 16, 11.2 / 25 ms | — |
| selection clicks on 1 000: mean / p95 | 48.3 / 156, 29.2 / 90 ms | 11.0 / 26, 15.4 / 38 ms | — |
| scrolling 5 000 clips | 46.8 / 24.7 fps | 59.7 / 56.4 fps | ≥ 50 fps — **met** |
| zooming 5 000 clips | 58.6 / 31.6 fps (mean work 15.7 / 30.7 ms) | 56.7 / 56.9 fps (15.9 / 16.2 ms) | ≥ 50 fps — **met** |
| Project panel, 2 000 items, scrolling | 55.3 / 50.2 fps (mean 12.1 / 15.4 ms) | 60.2 / 58.5 fps (5.2 / 6.5 ms) | ≥ 50 fps — **met** |
| Effect Controls, 1 800 keyframes, scrub | 30.8 / 24.0 fps (mean 28.3 / 38.2 ms) | 33.1 / 54.5 fps (25.3 / 12.6 ms) | — |
| Opening the 1 000-clip project (to an interactive timeline) | 4.4 / 2.7 s | 2.7 / 2.8 s | — |

At load ≈ 20 single runs of the after-build measured scrolling at 55 fps and zooming at 52 fps; at load 40–60 every
number above degraded 2–3× for both builds. The current UI benchmark reports budgets scaled by the measured load
factor squared unless `PERF=1`.

Profiles of the drag before the work (`scripts/perf/ui-profile.ts timeline:1000 drag`, load ≈ 19): 83 % of the window
busy, of which ≈ 90 % JavaScript — the Program monitor rebuilding the 1 000-clip render snapshot and re-rendering
1 000 Remotion Sequences per gesture frame, a whole-document expression walk per frame, hidden panels and the Properties
panel's whole-document expression scans, timeline headers and toolbar. After: the Program monitor draws ≈ 15–20 of the
≈ 35 gesture frames (≈ 12–35 ms each depending on load, `gestureFrames` in the editor's `perf` action), the rest is
the gesture update itself (≈ 4 ms, perf-core) and the timeline's render.

**Autosave serialisation** (`pnpm exec tsx packages/project/bench/json-cache.ts`, scale project, 8.2 MB, same day):
`JSON.stringify` 88–118 ms per save before; after, a save following a one-clip edit takes 0.5–5 ms, and the first save
of a session (nothing cached yet) 1.9 ms after the autosaver's idle warm-up (1 063 units, the longest 28 ms) or
≈ 225–265 ms without it (the deep-frozen check of every object; once per session).

**First edit after opening, historical profile**: idle verification of the opened document took ≈ 340 ms on the
5 000-clip scale project at load ≈ 40. The first edit then used the incremental check. The retained session timing
budgets measure edit latency; `ui-perf.test.tsx` checks gesture cancellation, undo and displayed state during
freeze/thaw, without asserting invariant-cache counters.

## 6. Opening a large project (polish)

Workstream `polish` ([`wp-notes/polish.md`](wp-notes/polish.md) §5). §5 above still listed the 2 000-item project as
slow to open (8–14 s). Measured with `pnpm exec tsx scripts/perf/open-phases.ts items:2000 --runs 6` on the same
shared 12-core host (2026-10-09, other agents building; headless Chrome, a fresh browser context and so a cold HTTP
cache per run): milliseconds from navigation start to `shell` (the timeline is on screen, the agent bridge is up)
and `media` (every medium has left "resolving"), the requests by kind, and the renderer main thread's time by kind
of work from a Chrome trace. `--warm` shares one context (no difference on loopback); `--compare key=value`
alternates runs with and without a `localStorage` switch.

| Step | Load average (factor) | Open to `media` | What it removed |
|---|---|---|---|
| before (`integrate/parity` 065af535; `ui-profile.ts items:2000 open`, CPU profiler attached) | ≈ 12 | 10.9 s | — |
| media statuses in batches, one store update per answer | 19–23 | 4.7 – 5.9 s | 2 000 requests; `setMediaRuntimes` 1.4 s and a forced layout per answer 1.1 s of CPU |
| the bin windowed from its first render | 13–18 | 2.45 – 3.0 s | style + layout of 2 000 rows: 1.0 → 0.2 s |
| editor chunks preloaded, project fetched before the bundle boots (`/editor-boot.js`) | 14 (≈ 1.4) | 2.0 – 2.2 s | three round trips for 30 chunks; the project answer arrives at ≈ 0.35 s instead of ≈ 1.0 s |
| final build, three sessions | 17–19 (1.3–1.8) | median 2.7 s, best 2.2 s | |
| a 10-item project, same sessions | 17–19 (1.3–1.8) | median 2.3 s, best 1.9 s | (the editor's own start) |

Main thread while opening the 2 000-item project (final build, one typical run at load ≈ 18): scripting 1.0 s (of
which ≈ 0.45 s evaluating the bundle and ≈ 0.17 s validating the 2.1 MB project), style 0.08 s, layout 0.07 s,
painting 0.07 s, garbage collection 0.1 s, other 0.6 s; longest task ≈ 0.4 s. Requests: 43 assets, 1 project,
1 lease, 2 media status batches.

**Budget: < 2 s — not demonstrated by these historical measurements.** At load factor 1.3–1.8 the open took
2.0–2.9 s. One run met its scaled limit: 3 188 ms against 3 600 ms at factor 1.34. The current `pnpm perf` UI
section reports against 2 000 ms × load²; `PERF=1` enforces 2 000 ms exactly. The measured editor startup for any
project was ≈ 2.3 s: downloading and evaluating ≈ 9 MB of JavaScript and the first render of the visible panels.

Tried and dropped: mounting background-tab panels in idle periods after the shell is up — alternating runs showed
no gain (median 2.85 s deferred against 2.64 s eager at load ≈ 18), so the panels mount with the shell as before.

## 7. Title Looks (spec 19 TL-037)

Per-frame cost of a look, measured with a read-back as the sync point (`gl.finish` does not wait on ANGLE: without the
read-back the work lands in the next call, and a first attempt reported a false 94 ms). Rerun:
`TL_PERF=1 pnpm exec vitest run packages/compositions/test/title-look-gl.test.ts --reporter=verbose -t "per-frame cost"`.

Machine: shared 8-vCPU AMD EPYC-Rome VM, 15 GB, no GPU. Chrome 156.0.8078.79 with ANGLE over SwiftShader (Vulkan, Subzero).
Load average 0.5–6 during the runs (other agents' work); figures are the median of 7 warm frames, 2026-11-02. They bound a
software renderer and say nothing about a real GPU, which nothing here has measured.

The look: shadow (blur), glow (soft), three rims, face; text 200 px.

| Program resolution | Box | Canvas | Passes | Six layers, median | Min – max |
|---|---|---|---|---|---|
| Full | title-sized, 1200 × 280 | 1360 × 440 | 23 | **1 303 ms** | 1 293 – 1 495 ms |
| 1/2 | title-sized | 680 × 220 | 22 | 587 ms | 501 – 621 ms |
| 1/4 | title-sized | 340 × 110 | 21 | 115 ms | 111 – 193 ms |
| Full | frame-sized, 1920 × 1080 (worst case) | 2080 × 1240 | 23 | **5 796 ms** | 5 477 – 6 580 ms |
| 1/2 | frame-sized | 1040 × 620 | 22 | 1 985 ms | 1 894 – 2 095 ms |
| 1/4 | frame-sized | 520 × 310 | 21 | 512 ms | 501 – 688 ms |

Field and a flat face alone, frame-sized box, 9 passes: 2 010 ms full, 522 ms at 1/2, 196 ms at 1/4. A first draw adds
≈ 100–600 ms of shader compilation at most (one program per layer type, paint kind and finish, shared by every look).

Where a frame goes at full size, frame-sized box (per-pass profile, each pass timed with its own read-back):

| Passes | Time | Note |
|---|---|---|
| Seed + 7 flood steps (`rgba32f`) | ≈ 3 000 ms | The largest cost: proportional to the canvas area, and ≈ log₂ of the reach |
| Field (`rgba16f`) | 104 ms | |
| Shadow mask + blur at 1/2 | 777 ms | |
| Glow mask + blur at 1/8 | 20 ms | |
| Six composite passes | ≈ 1 300 ms | ≈ 200–300 ms each |
| Output | 106 ms | |

One change came out of this table: blurs read a full-resolution mask through mips, and the shadow's horizontal pass alone took
7.1 s of a 14.0 s frame. The mask now renders directly at the blur's own reduced size (sigma ≈ 2–4 texels): the frame went
from 13 989 ms to 5 796 ms under the same conditions, with SSIM against the other resolutions unchanged to the fourth decimal.

**Reading it.** A frame is proportional to the canvas area, so the box matters more than the layer count: a title-sized box
costs a fifth of a frame-sized one. On a software renderer a look does not play in real time at Full; Program stays responsive
through `fxPreviewScale`, and a still look with unchanged input and params is not redrawn at all (0 GL draws across seeks,
`title-look.e2e.test.ts`). Export of a static title bakes one frame. Animated text or params redraw the whole stack every
frame, field included: on this host ≈ 1.3 s per 1080p frame for a title-sized box, so one minute of animated title takes
≈ 39 minutes on the CPU. The field could be kept across frames when only layer params change (static text with a keyed rim);
that is not done yet.

### Generators (spec 19 §7)

A generator layer under a face, text 200 px, canvas = box 1200 × 280 plus the layer's own reach, `contentSeconds` 0.5 (moving
params of each generator's sheet), median of 3 warm frames and one frame at `fxPreviewScale` 1/2. Same machine and browser as
above, 2026-11-03 04:25 UTC, load average ≈ 2–10 (other agents' work, inside one of the host's three heavy-job slots). Rerun:
`TL_PERF=1 pnpm exec vitest run packages/compositions/test/title-look-generators-gl.test.ts --disable-console-intercept -t "per-frame cost of each"`.

| Generator | Canvas | Passes | Full | 1/2 |
|---|---|---|---|---|
| Fire | 1412 × 732 | 17 | 1 800 ms | 582 ms |
| Smoke | 1528 × 927 | 17 | 2 092 ms | 522 ms |
| Corona | 1464 × 544 | 16 | 1 188 ms | 477 ms |
| Sunburst | 2248 × 1328 | 15 | 2 907 ms | 1 083 ms |
| Magic Circle | 2206 × 1286 | 10 | 6 716 ms | 1 891 ms |
| Lens Flare | 2248 × 1328 | 15 | 3 812 ms | 1 208 ms |
| Backlight | 1752 × 832 | 18 | 1 886 ms | 791 ms |
| Light Streaks | 2248 × 1328 | 11 | 3 192 ms | 1 002 ms |
| Shockwave | 2016 × 1096 | 10 | 3 794 ms | 1 135 ms |
| Particles | 1808 × 888 | 19 | 1 983 ms | 585 ms |
| Glints | 1356 × 436 | 24 | 919 ms | 481 ms |
| Ink Splatter | 1894 × 974 | 21 | 2 983 ms | 888 ms |
| Brush Swirl | 2694 × 1774 | 12 | 4 923 ms | 1 696 ms |
| Speed Lines | 2168 × 1248 | 19 | 3 507 ms | 1 100 ms |
| Lightning | 2070 × 1150 | 19 | 3 194 ms | 1 098 ms |
| Pattern | 1688 × 768 | 10 | 1 984 ms | 664 ms |
| Face only (reference) | (not reported) | | 303 ms | |

**Reading it.** The canvas dominates again: a generator that reaches far (Sunburst, Lens Flare, Light Streaks, Brush Swirl at their
extents) grows the look's canvas, and with it the shape field every layer pays for. Magic Circle is the costliest per pixel (six
rows of distance fields, a polygon loop per row). Soft generators (Fire, Smoke, Corona) draw at half size by design (`lowRes`).
Every generator is time dependent, so an animated look with one redraws every frame: on this host a title-sized look with a
generator is 1–7 s per 1080p frame. Nothing was measured on a GPU.
