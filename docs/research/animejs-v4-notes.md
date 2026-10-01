# anime.js v4 notes (R-ANM)

Verified against `animejs@4.5.0` (npm `latest`, MIT, released 2026-06-22) by reading `dist/modules/**` and by tests
in Node 20 and headless Chrome 150 (2026-10-01). Line references are to `dist/modules/<file>` of that version.
Used by D-31 and spec S11.

## 1. Driving anime.js by an external clock

- `createTimeline({autoplay: false})` never starts the internal loop: `init()` only calls `resume()` when autoplay
  is true (`timer/timer.js:304-321`); children of a timeline get `_autoplay = false` (`timer.js:165`). The loop is
  only woken by `resume()` → `engine.wake()` (`timer.js:342-360`, `engine/engine.js:76-82`). After build + seek,
  `engine.reqId` stays 0.
- `engine.update()` is not an external clock (reads `Date.now`, throttles by wall-clock fps). `engine.*` settings
  (`useDefaultMainLoop`, `timeUnit`, `precision`, `pauseOnDocumentHidden`) are page-global singletons — never write
  them (the Player shares a realm with the editor UI).
- `seek(time, muteCallbacks)` (`timer.js:373-383`) → `tick(...)`. Always mute callbacks. Time unit stays ms.
- Precision: timeline time rounded to 12 decimals; string values rounded to `engine.precision` (4) except at
  progress 0/1; plain-object numbers are not rounded. Seeking ≥ duration writes exact end values; negative clamps.
- The last frame of a clip is `(N−1)/fps`. Never use `loop: Infinity` (duration becomes Infinity).

**Seek is history-dependent.** `render()` is incremental: whether a tween writes depends on its previous
`_currentTime`, the playhead direction and a 200 ms jump threshold (`core/render.js:113-192`). Children above the
playhead are skipped when going backwards. Minimal repro: two sequential `x` tweens with a gap; seek 1000 then 500
→ stale value. A fresh timeline seeked to `t` never writes from-values of tweens that have not started.

300 random timelines, seeked in random order vs a fresh build per frame:

| Strategy | Specs with history-dependent output |
|---|---|
| plain `seek(t)` | 259/300 |
| `seek(end); seek(0)` once at build, then `seek(t)` | 186/300 |
| `seek(0); seek(t)` per frame | 1/300 (0 without loops) |
| **`seek(duration); seek(0); seek(t)` per frame (canonical seek)** | **0/300** |

With deliberately overlapping same-property children the canonical seek still failed 4/300, all involving
`.set()`, child loops or zero-duration timelines → banned (S11:ANM-006). Cost: ~4.3 ms per canonical seek for
282 chars × 4 properties in Chrome (0.12 ms for a plain forward seek).

Build-time captures: implicit from-values (inline style, then `getComputedStyle`), relative values, unit
conversion, function-based values, `revert()` baselines. A later tween on the same property takes its from-value
from the previous sibling's end. → Always explicit `[from, to]`; build on pristine targets.

Composition: `'replace'` keeps a global per-target/per-property sibling list; a second live timeline on the same
target/property truncates the first → one live timeline per (target, property). `'blend'` only applies in
`engine.update()` → unusable with seek-only driving. ≥ 1000 targets switch to `'none'` automatically.

Other hazards: `frameRate` on a child gates rendering by `Date.now()` (values stuck); timelines are thenables
(never `await` or return them from async functions); the transform cache lives on the DOM node until revert.

## 2. Text splitting

`splitText` (`text/split.js`; `text.split` is deprecated) rewrites the target's DOM (`replaceChild`), saves
`innerHTML` for `revert()`, splits lines **always asynchronously** via `document.fonts.ready.then(...)` (even with
fonts loaded), measures lines with `getBoundingClientRect` (affected by ancestor rotation/flip/corner pin), and
re-splits after 150 ms through a `ResizeObserver`. It conflicts with React-owned DOM. → Banned in JasperEditor
(S11:ANM-006); we segment with `Intl.Segmenter` in React and group lines by `offsetTop`.

## 3. SVG

- `morphTo(target, precision = .33)` resamples both shapes with `getTotalLength/getPointAtLength` at build (curves
  become polylines); deterministic afterwards.
- `createDrawable` sets `pathLength = 1000`, writes `stroke-dasharray/dashoffset`; `revert()` does not remove them;
  with `vector-effect: non-scaling-stroke` it reads `getCTM()` every render. Use explicit `draw: ['0 0', '0 1']`.
- `createMotionPath` reads `getTotalLength` and `getCTM()` once at build; deterministic.
- All need real SVG geometry; layout-dependent values are wrong under `display: none` (Remotion premount hides
  with `display: none` in preview unless `hideWhilePremounted='opacity'`).

## 4. Scope, cleanup, StrictMode

`createScope({root})` scopes selectors to the root and registers every timer/animation/splitter created inside
`scope.add`; `scope.revert()` reverts in reverse order (timeline seeks to 0, cancels, restores inline values). Build
in `useLayoutEffect` and revert on cleanup → StrictMode-safe. Minor bug: `Timeline.revert` maps `child =>
child.revert` without calling it (`timeline/timeline.js:324`); harmless because `revertValues` restores values.

## 5. Utilities and easings

| API | Deterministic? |
|---|---|
| `utils.random`, `randomPick`, `shuffle` (default rng) | No (`Math.random`, `utils/random.js:25`) |
| `createSeededRandom(seed)` | Yes (mulberry32); without a seed it uses a global `_seed++` counter → always pass a seed |
| `stagger(v, {seed})` | Yes for `jitter` and `from: 'random'` with a seed; `grid: true` measures the DOM; caches on first call → create inside the build |
| `irregular()` easing | No (`Math.random` at creation) |
| `scrambleText` | No (state advances per render) |
| `cubicBezier`, `steps`, `linear`, named eases | Yes |
| `spring()` | Yes (closed form); its settling duration overrides the tween duration; create one per use |

WAAPI (`animejs/waapi`) runs on the document timeline → banned.

## 6. Packaging and types

- ESM-first, `exports` with `types`/`import`/`require` for `.` and subpaths (`timer`, `animation`, `timeline`,
  `animatable`, `draggable`, `scope`, `engine`, `events`, `layout`, `easings[/…]`, `utils`, `svg`, `text`, `waapi`,
  `adapters[/three]`). Subpaths share module instances with the root; CJS and ESM builds are separate instances.
- `sideEffects` lists only the adapters (which import the optional peer `three` — never import them).
- Import-time effects: `window.AnimeJS.push`, a `visibilitychange` listener, rAF/`setImmediate` lookup (safe in
  Node and happy-dom).
- Types need `skipLibCheck` (mentions `NodeJS` namespace). No default export. Animation params are loosely typed.
- Webpack 5 (`@remotion/bundler` 4.0.499) resolves the ESM build without config changes; Vite likewise.

## 7. Known issues (GitHub)

#1138 `addChild` self-referential sibling links; #1013 `duration: 0` keyframes; #1034 morph is a resample, not a
true morph; #1137 scramble; #1121 WAAPI sync with loops; #1118 spring perceived completion; closed but relevant:
#1008 (no default export), #1028 (thenable from async), #1088 (`.call` past ~8000 ms). Remotion's public anime.js
example targets 4.0.2 and uses v3 API names — do not copy it.
