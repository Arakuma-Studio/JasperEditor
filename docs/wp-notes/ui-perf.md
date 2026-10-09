# ui-perf: the editor UI at scale

Workstream `ui-perf` of the parity program (BASE port 49580). perf-core made the model fast (a command in 1.7–2.8 ms,
a 50-clip gesture update in 3.6–6.5 ms on 1 000 clips), yet a 30-step drag of 11 clips on a 1 000-clip sequence took
6.8–10.7 s of wall time in headless Chrome: the cost was in the UI. This workstream profiled the built app at scale,
fixed the hot spots without behaviour changes, moved autosave serialisation off the critical path, made the first
edit after opening incremental and added `pnpm perf --sections ui` and `e2e/ui-perf.spec.ts`.
Measured results: [docs/performance.md](../performance.md) §5. Nothing was ported (no `licenses/ported` record).

## 1. How it was measured

- **Scenarios** (`scripts/perf/ui-scenarios.ts`): generated projects (`scripts/perf/ui-fixtures.ts`, built through the
  command system: `timeline:1000` / `timeline:5000` colour mattes on four tracks — the perf-core layout —,
  `keyframes:200` one clip with nine animated parameters of 200 keys each, `items:2000` 2 000 media items and ten bins,
  `scale` the golden-fuzz 200-sequence project) uploaded to the built engine and opened in headless Chrome. Gestures
  are scripted like a user's: the perf-core drag (zoom out, Shift-click the visible V1 clips, 30 pointer moves 16 ms
  apart), a trim, a playhead scrub, selection clicks, wheel scrolling and Alt-wheel zooming (one wheel event per
  frame), the Project panel's list scrolled 60 px per frame, an Effect Controls scrub.
- **Metrics** come from a Chrome trace (CDP `Tracing`) between two `console.timeStamp` marks: the renderer main
  thread's top-level tasks and its `BeginMainThreadFrame`s; the work of a frame is the main-thread time between its
  begin and the next one. Reported: frames, frame rate, p50 / p95 / mean work per frame, busy fraction, wall time.
- **Attribution**: `scripts/perf/ui-profile.ts <fixture> <scenario>` adds a V8 CPU profile of the scenario's window
  mapped through the build's source maps (self and inclusive time per function and file) and can save the trace and
  `.cpuprofile` for DevTools. Component render counts came from a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` on an
  unminified build (fibers whose props or state changed per commit).
- **Before/after**: `scripts/perf/ui-compare.ts <webA> <webB>` serves two web builds from the built engine and runs
  every scenario alternately on both, so they share the host load.

## 2. Where the time went (profiled)

On the drag (1 000 clips, before): 83 % of a 3.8 s window busy, mean 27 ms of main-thread work per frame,
p95 94 ms; JavaScript, not layout or paint (`FunctionCall` / `FireAnimationFrame` ≈ 2.5 s, layout + paint +
layerization ≈ 0.25 s). Per gesture frame:

| Where | Why |
|---|---|
| Program monitor | rebuilt the render snapshot of the whole sequence (1 000 clips), structural sharing over it, and re-rendered the Remotion Player — whose composition renders a `<Sequence>` per clip, all 1 000, for every frame and every document change |
| `documentHasActiveExpressions` | cached per `sequences` map, which a gesture replaces every frame: a walk of every animatable property of the document per frame (≈ 7 ms) |
| Background panels | dockview keeps hidden tabs mounted (React portals): Effect Controls, Text / Transcript, Effects, Lumetri… re-rendered on every gesture frame |
| Properties panel | rows of the dragged clips; `locateExpressionTarget` and `paramPathToExpressionRef` scanned every clip of every sequence per row |
| Timeline chrome | track headers (≈ 20 Radix tooltip buttons) and the toolbar re-rendered with every transient sequence; the ruler redrew its ticks (forced style recalculation through `getComputedStyle` per tile) |

Scroll and zoom on 5 000 clips: every visible clip view re-rendered per scroll frame (its x changed), the ruler tiles
redrew with three `getComputedStyle` calls each (286 ms of `getPropertyValue` in 3 s), track headers re-rendered (the
view record changes with the scroll), and each clip view's badge subscription started a 1 s timer, re-created on
mount. Project panel with 2 000 items: one table row per item (layerization 1.4 s of a 3 s scroll), and opening the
project resolved every medium with one store update each while title selectors scanned every item per update
(quadratic: 30–48 s to open). Effect Controls with 1 800 keys: every key an inline `<svg>` (a compositor transform
node each), all lanes re-rendered at every playhead step.

## 3. What changed

| Change | Where | Behaviour |
|---|---|---|
| **Gesture frames for the Program monitor.** The drawn document reaches costly views through `gestureFrames(store)`: outside gestures and at commit / cancel / undo in the same notification as the session store; during a gesture each transient document is published from its own task (after the frame that produced it is painted) and no more often than the views can afford — after a publish whose renders cost `c` ms (moving average, measured to the end of React's flush), the next waits `5 × c` (≤ 250 ms). Cheap views get every frame; a 1 000-clip monitor ≈ 10–20 per second | `packages/session/src/gesture-frames.ts`, `useGestureFrameDocument`, `ProgramMonitor.tsx` | the monitor's picture during a heavy gesture updates at a lower rate; the last frame of a gesture and every commit are shown at once (explicitly allowed by the scope: "throttle it, or show a gesture preview") |
| **Clip windowing in compositions.** `FrameWindow` mounts only the clips whose Sequence span (premount included) meets a page-aligned window around the current frame (pages of 60 frames, one page before, two after) | `packages/compositions/src/frame-window.tsx`, `SequenceComposition.tsx` (video, flat, matte, audio clips) | none: a Sequence outside its span renders nothing either way (property test) — also removes 1 000 Sequence re-renders per played frame |
| **Background panels frozen.** `FreezeStoreUpdates`: inside a frozen subtree `useStoreSelector` keeps returning the value it last rendered; dock panels in a background tab (not keep-alive) are frozen and read the current state when shown | `packages/session/src/react/index.ts`, `shell/dock/DockHost.tsx` | none visible (their DOM is detached); effects stay mounted |
| **Expression lookups memoised** per clip and per sequence object; owner index (effect / mask / puppet pin → holder) per sequence; `locateExpressionTarget` walks only the owner | `packages/project/src/expressions.ts` | none (property test against the old scans) |
| **Track headers / toolbar memoised.** Header rows skip renders unless their track, row, the view's targeting / source patching / keyframe display or their callbacks change; the context menu reads the clips from the session | `TrackHeaders.tsx`, `Chrome.tsx`, `TimelinePanel.tsx` | none |
| **Clip scroll layer.** The track area draws at a scroll offset snapped to device pixels; clips sit in content pixels on a layer moved by it, and a clip view re-renders for a scroll only when its sticky name, its visible canvas tiles or its decorations depend on it | `TrackArea.tsx`, `ClipView.tsx` | clip edges land on the same device pixels as before relative to each other; the whole track area may shift by < 1 device pixel against the unsnapped scroll offset (the ruler and playhead are unaffected) |
| **Canvas tile caching.** Filmstrip / waveform tiles are drawn in clip-local coordinates on tile-aligned canvases (≤ 512 px, as before), so a scroll redraws only tiles that come into view; the ruler's ticks likewise in content coordinates on a translated strip | `ClipView.tsx`, `Ruler.tsx`, `canvas.tsx` | ruler ticks may sit ≤ 1 px from where per-frame rounding put them |
| **Design tokens cached** for canvas drawing (one `getComputedStyle` per token until the root's theme attributes or the style sheets change) | `canvas.tsx` (`cssVar`, `designTokens`), `LevelMeter.tsx` | none |
| **One badge subscription** for all clip views (ref-counted, providers re-attached when the registry changes) | `extensions/react.ts` | none |
| **Project panel windowing** from 200 items: only the rows (list) or grid rows (icons) in view plus a screen of overscan are rendered between spacers; Reveal in Project scrolls a row that is not rendered into view first | `panels/project/virtual.ts`, `ProjectPanel.tsx` | none below 200 items; above, rows out of view are not in the DOM (agents' `ui_*` tools find items in view; MCP item tools are unaffected) |
| **Media runtime sweeps batched** (opening a project resolves every medium in one store update); title / tab / properties selectors look sequence names up in an index per `items` record | `import/media-runtime.ts`, `session.setMediaRuntimes`, `TitleBar.tsx`, `Chrome.tsx`, `PropertiesPanel.tsx` | none |
| **Effect Controls**: key lanes and summary lanes memoised (stable handlers); key glyphs drawn as cached SVG background images (no compositor node per key); playheads on their own compositor layer | `MiniTimeline.tsx`, `EffectControlsPanel.tsx`, `Playhead.tsx` | none |
| **Render-bar segments** memoised per committed document (the render bar and the monitor's previews asked for them separately after every commit) | `timeline/model/renderbar.ts` | none |
| **Autosave and journal serialisation incremental.** `stringifyJson` = `JSON.stringify` with the text of deeply frozen objects cached by identity (Immer freezes every document a transaction produces, untouched subtrees included); the top four levels (envelope, document, its records, a sequence) and deeper containers with ≥ 64 entries are composed from their entries' cached text with rope concatenation, the rest serialised natively per object; the autosaver warms the cache in idle slices after each edit (`jsonWarmUnits`: one unit per sequence, medium, item); the engine client sends pre-serialised bodies (`JsonText`) | `packages/project/src/json-cache.ts`, `persistence/{engine,autosave}.ts`, `engine-client` | byte-identical files (property test); journal semantics, atomicity and file format unchanged |
| **Idle invariant verification.** After a project opens (or a document is replaced), the session runs the full invariant check in `requestIdleCallback` and records the document as verified, so the first edit takes the incremental check | `invariants-incremental.ts` (`verifyDocument`), `session.ts` | none (the result is exactly the full check's) |

### Decisions

- **Why a throttle, not a worker, for the Program monitor.** Building the render snapshot needs the document; sending
  it to a worker costs a structured clone of the same size, and the Player must render on the main thread anyway. An
  adaptive duty cycle keeps cheap monitors at full rate and bounds expensive ones at 20 % of the main thread.
- **Why incremental serialisation, not a worker, for autosave.** A worker needs the document posted to it: a structured
  clone of 8 MB costs about what `JSON.stringify` does. Documents are immutable and frozen, so the text of an
  unchanged subtree is reusable: after a one-clip edit the 8 MB scale project serialises in 0.5–5 ms instead of
  ≈ 90–120 ms. The first save of a session has nothing cached and costs ≈ 2× `JSON.stringify` (checking that every
  object is deeply frozen), so the autosaver warms the cache when the browser is idle after an edit, a few
  milliseconds at a time; the save then takes ≈ 2 ms. Only deeply frozen objects are cached: anything that can still
  change is serialised afresh (tested), so a stale file cannot be written.
- **Render snapshots of all 200 sequences.** Profiling the editor opening the 200-sequence scale project showed that
  it builds the snapshot of the shown sequence only (Program monitor) — the ≈ 470 ms of the scale benchmark is the
  benchmark building every snapshot on purpose. Exports and previews build their own sequence's. The one place that
  builds every sequence's snapshot is the engine's cache sweep (`cache/project-refs.ts`: preview hashes of every
  sequence, for garbage collection), which runs at start-up, hourly and after render jobs, cached per saved revision;
  it is not on any interactive path and is left as it is.
- **Gesture-frame throttle scope.** Only the Program monitor uses it. The panel driving a gesture (timeline, a property
  scrub in Properties / Effect Controls) and inspectors that show values at the playhead stay live; their re-renders
  are made cheap instead (memoisation, freezing what nobody sees).

## 4. Usage

```bash
pnpm build
pnpm perf --sections ui                       # every UI scenario, budgets scaled by load (PERF=1: exact)
pnpm perf --sections ui --ui drag,scroll      # a subset
PERF_PORT=49580 pnpm exec tsx scripts/perf/ui-profile.ts timeline:1000 drag --save /tmp/p   # trace + CPU profile
pnpm exec tsx scripts/perf/ui-compare.ts /tmp/web-before apps/web/dist --rounds 3             # before/after
pnpm exec tsx packages/project/bench/json-cache.ts                                           # autosave serialisation
E2E_PORT=49580 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/ui-perf.spec.ts
```

The editor's `perf` UI action and MCP `perf_stats` report `gestureFrames` (published / skipped gesture frames and the
cost of one) next to the invariant counters.

## 5. Verified behaviour (tests)

- `packages/session/test/ui-perf.test.tsx`: gesture frames — cheap views get every frame (each from its own task),
  costly ones at most one per `5 × cost`, the latest transient always wins, commit / cancel / undo arrive in the same
  notification with no timer left; `FreezeStoreUpdates` keeps the last value while frozen and catches up when shown;
  idle verification makes the first edit incremental (and is a no-op without `requestIdleCallback`); autosave PUTs
  exactly `JSON.stringify(envelope)` after edits.
- `packages/project/test/json-cache.test.ts`: `stringifyJson` equals `JSON.stringify` on arbitrary JSON (frozen or
  not, cold and cached), large composed containers with every special value (`undefined`, functions, symbols, `NaN`,
  `-0`, `toJSON`, boxed primitives, U+2028), cycles and `BigInt` throw, objects that can still change are never cached,
  Immer edit chains, the project envelope after real edits.
- `packages/project/test/expressions-memo.test.ts`: the memoised flags, owner index and owner-scoped location equal the
  whole-document scans over random edit chains.
- `apps/web/test/project-windowing.test.tsx`: every row below the threshold, a window above it.
- `packages/compositions/test/frame-window.test.ts`: every item whose span holds the frame (premount included) is
  mounted, for the whole page.
- `e2e/ui-perf.spec.ts` (built app): the drag commits and moves every picked clip, with the per-frame budget (best of
  two runs) and a wall-time guard (`PERF=1`: the documented 1.5 s; otherwise the blank-page floor measured in the test
  plus 1 s scaled by load — the old build exceeded the floor by 2–7 s); scroll and zoom of 5 000 clips with clips drawn where the model puts them (≤ 1 px) and the frame-rate
  floor; the 2 000-item Project panel renders fewer than 400 rows, reaches its last item and scrolls above the floor;
  Effect Controls with 1 800 keys scrubs within budget. Screenshots `test-results/ui-perf-*.png`.

## 6. Comparison with the references

| | EffectCraft (`docs/architecture.md` §7, `crates/ui-egui/src/frames.rs`) | FilmCraft (`crates/ui-egui`) | Here |
|---|---|---|---|
| Timeline at scale | virtualised: draws (and registers automation ids for) the rows in view | egui immediate mode | DOM: visible clips ± 50 % overscan (TL-151) on a scroll layer; re-renders only what a change touches |
| Viewer during gestures | frames render on a thread pool from `Arc<Project>` snapshots into a RAM cache; the UI never waits | renders in the UI loop | the Remotion Player must run on the UI thread: adaptive gesture-frame throttle, composition mounts only clips near the frame |
| Autosave | snapshot (`Arc` clone) serialised on a background thread | — | incremental serialisation on the UI thread: ≈ 0.5 ms after a one-clip edit of an 8 MB project, byte-identical file |
| Large bins | Project panel virtualised, reveals a selected item | media browser `ScrollArea` drawing every row | list and icon grid windowed from 200 items, Reveal in Project scrolls first |

Equal to EffectCraft on lists and the cost autosave puts on the UI thread, better than FilmCraft on bins; the viewer is a
different trade-off (EffectCraft renders off-thread; here the throttle bounds the monitor's share of the UI thread).

## 7. Limits

- **Drag wall time: target missed.** The scripted 30-step drag takes 2.0–2.1 s (before: 3.3–8.1 s) against the 1.5 s
  target; the same script on a blank page takes 1.0–1.35 s on this host (30 pointer moves 16 ms apart through CDP, each
  acknowledged after the renderer's frame), so ≈ 0.6–0.9 s is the page's: about one extra frame per step for the
  gesture update (≈ 4 ms, perf-core), the timeline's render and the Program monitor's gesture frames. The per-frame
  budget (mean < 16 ms) is met (11.5–12.4 ms).
- **Host.** Every number of §5 comes from a shared 12-core host at load average 20–60 (other agents' builds); the
  e2e spec scales its budgets by the measured load factor squared (the browser is another process).
- **Zoom** re-renders every visible clip (its position and width change); scrolling does not.
- **Gesture frames** of a heavy Program monitor are 25–40 ms tasks; they are spaced (≤ 20 % of the main thread) but
  each one still makes one long frame.
- **Program monitor overlays** (transform handles, masks, tracking) follow a gesture at full rate while the picture
  under them may lag by one throttled gesture frame on a heavy sequence; both agree again at the commit.
- **Reveal in Project** on a windowed bin scrolls the item's row into view first; it is exercised by the code path
  only (the e2e spec scrolls to the last item; no test reveals one).
- **Effect Controls** with 1 800 keys still repaints the value column and the Program monitor per scrub step.
- **Project panel windowing** takes rows out of view out of the DOM from 200 items: UI automation finds items in view.
- **Not changed:** project loading (parse, zod, repair: ≈ 1.4 s for the 8 MB scale project; the loader's own invariant
  check runs on the critical path as before, the session's idle verification is extra) and the engine's cache sweep.
