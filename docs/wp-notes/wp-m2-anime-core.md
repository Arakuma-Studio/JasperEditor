# wp-m2-anime-core — anime.js runtime, determinism, fonts, notices (S11, wave 1)

Branch `wp/m2-anime-core` (from `main` a7f1f47 = the merged `wp-m2-anime-contracts`). Spec:
`docs/specs/11-animation.md` (ANM-*, FIX-003, FIX-010). Contracts: ARCHITECTURE D-31, §20.2/§20.4/§20.5/§20.8.
Research: `docs/research/animejs-v4-notes.md` (R-ANM). anime.js pinned at **4.5.0**.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| ANM-001/022 | `scripts/check-anime.mjs` | Only `packages/motion/src` imports `animejs`; only `packages/compositions/src` (and motion) imports `@jasper/motion`. Import parsing is now multi-line and alias-aware; template-literal contents (source held as data, e.g. the scaffold) are not imports. |
| ANM-002/003 | `packages/motion/src/runtime/timeline.ts` | `createPausedTimeline` forces `autoplay: false` and drops `frameRate`/`loop`/`loopDelay`/`alternate` (runtime guard next to the lint); `seekCanonical` never visits an infinite duration; non-finite ms → 0. The lint bans a plain `.seek(` outside the runtime, timers, rAF, `Date.now`, `new Date`, `performance.now`. |
| ANM-004 | `runtime/hooks.ts` (`useAnimeValues`, `valuesAt`) | Builds in `useMemo` keyed by `buildKey`, seeks during render, returns frozen copies **rounded to 1e-6** (see Defects); per-(build, ms) cache (600 entries) so revisits, StrictMode double renders and Player re-renders of a frame never seek again. Safe under StrictMode / concurrent rendering (pure build, copies taken right after their own seek). |
| ANM-005 | `runtime/hooks.ts` (`useAnimeDom`) | `createScope({root})` in a layout effect, reverted on cleanup; additionally removes the attributes a build added outside its tweens (`createDrawable`'s `pathLength`, `stroke-dasharray`…) so StrictMode re-mounts and rebuilds start from pristine targets; re-seek after every rebuild. |
| ANM-006/012 | `scripts/check-anime.mjs` (+ `.d.mts`, tests), `biome.json` | Full ANM-006 list: module bans (`waapi`, `events`, `draggable`, `layout`, `timer`, `animation`, `animatable`, `text`, `easings/irregular`, `adapters`; `scope`/`engine` outside the runtime), banned imported names whatever the alias, runtime-only names (`createTimeline`, `createScope`, `engine`, `createSeededRandom`), namespace imports outside the runtime, `animate()`/`el.animate()`, `.play/.resume/.restart()`, `.reverse/.set/.call()` **on timelines only** (chain analysis keeps `Map.set`, `fn.call`, `array.reverse` legal), `autoplay: true`, unseeded utils, `irregular`, `scrambleText`, `splitText`, `frameRate`, `composition: 'blend'`, `loop:`, `engine.*` writes and `engine.update()`, `stagger(…)` with `from: 'random'`/`jitter` and no `seed`. `anime-allow: <reason>` on the line or the line above. Biome: one override for motion outside the runtime, one for the runtime, mirroring every import ban (tested against biome.json). |
| ANM-007 | `runtime/random.ts`, lint | `seededRandom(hash32(clipId, purpose))`; unseeded stagger randomness rejected by the lint and `Math.random` by the determinism harness at run time. |
| ANM-008/009 | `packages/motion/test/determinism-harness.tsx` | Builds may not share targets; `in` ends and `out` starts exactly at `REST_UNIT_VALUES` in what React renders. |
| ANM-010 | `runtime/text.ts`, `packages/compositions/src/fonts.ts` | `groupLines` sums `offsetTop` along the offset-parent chain (units inside positioned per-line wrappers compare in one space; transforms ignored). Fonts: FIX-003. |
| ANM-011 | `packages/motion/package.json`, `test/runtime.test.tsx`, `apps/engine/test/anime.test.ts` | Exact pin tested in motion and the engine (`ANIMEJS_PINNED_VERSION`). |
| ANM-013 | `packages/motion/test/determinism.test.tsx`, `determinism-harness.tsx`, `determinism-fixtures.tsx` | Reusable harness iterating `TEXT_ANIMATION_IMPLS` (param variants from each preset schema's enums, both sides, 1/5/7/37 units, 30 and 24 fps) and `ANIME_TEMPLATE_IMPLS` (catalogue defaults, intro + hold + outro, canonical DOM): in order, reversed, 12 shuffles and 3 revisit sequences (fast-check, fixed seeds 1/4242/90210) vs a fresh build / fresh mount per frame, the `useAnimeValues` path, StrictMode, build contract (one target per unit, exactly the UnitValues keys, finite, timeline ≤ `durationMs`), no wall clock / `Math.random`. Proven on fixture implementations, including five broken ones it must reject. |
| ANM-014 | `packages/motion/test/determinism-render.e2e.test.ts`, `determinism-render/` (`entry.tsx`, `player.tsx`, `doc.ts`, `order.ts`) | `REMOTION_E2E=1`. Fixture scene (animated title in/out with a seeded order and blur, anime template with a real `createDrawable` SVG leaf, animated shape) and the real `SequenceComposition` with the parity document (every installed text animator in/out, every installed anime template, keyframed Motion/opacity and a keyframed shape). `renderStill` per frame = `renderFrames` c1 = c4 = one page visiting frames **reversed** and **shuffled** (`<Freeze>` compositions): byte-identical PNGs; `renderMedia` ProRes 4444 c1 vs c4 decode to identical pixels; `@remotion/player` frame vs `renderStill` ≤ 3/255 on ≥ 99.5 % (with a control proving the comparison has teeth). |
| ANM-015 | same e2e (`bench` in the Player page, Chrome 150) | 200 units, 300 first-visit frames: 4-property preset **median 0.2 ms, p95 0.4 ms**; 8-property fixture median 0.4 ms, p95 0.6 ms; cached revisits median 0 ms. Asserted: median ≤ 2 ms. Static clips keep returning identical resolved objects (`layerPropsAt`, existing compositions tests). |
| ANM-016 | `apps/engine/src/mg-bundles/template/files.ts`, `apps/engine/test/anime-scaffold.test.ts` | `AnimeTitle` composition (schema, manifest entry, `animejs` 4.5.0), `src/anime/title-timeline.ts` (paused timeline over plain objects, canonical seek), graphemes via `Intl.Segmenter`, README section. Tested: lint-clean under the runtime rules, the scaffolded project bundles with esbuild, the example timeline is order-independent with the pinned anime.js. |
| ANM-020/021 | `packages/motion/src/runtime/**` | API of §20.2 unchanged; hardening only (see Contract changes). |
| ANM-023 | `apps/web/vite.config.ts` (`vendorChunk`), lint | `animejs` → `vendor-anime`; motion value imports use subpaths except the runtime index (`animejs-root-import`). |
| FIX-003 | `packages/compositions/src/fonts.ts`, `SequenceComposition.tsx` (2 hunks), `test/fonts-ready.test.tsx` | `useFontsReadyState(fonts)` tracks every face (family/weight/style; failed loads settle → fallback). One `delayRender` handle (via `useDelayRender`) created in a layout effect — never in a state initializer — and released by the commit that first renders every face as settled, i.e. the one that mounts the gated layers. `ClipLayer` renders nothing until the faces of its layer (`layerFontFaces`: text style + styled runs; anime-template params naming a document font) have settled: no split/measure/build and no fallback-font paint in the Player. Faces already settled on the page never hide a layer again (no blink on a new document). Component test with a deferred `FontFace`. |
| FIX-010 | `scripts/third-party-notices.mjs` (+ test), `THIRD_PARTY_NOTICES.md`, `package.json` (`pnpm notices`), `apps/web/vite.config.ts`, `apps/web/src/shell/licenses.tsx`, `apps/desktop/scripts/package.mjs` | Production closure of `apps/web` + `packages/compositions` through workspace packages (deps + required peers; optional deps skipped → platform-independent), 98 packages with licence and licence/notice texts; Remotion packages without a declared licence get the Remotion License text. `pnpm notices --check` (also a test). Vite serves/emits `/THIRD_PARTY_NOTICES.md`; Help ▸ About links it and shows it on demand; packaging fails on stale notices, checks the web build has them and copies them next to the engine. |
| Acceptance 8 | `apps/engine/src/anime/index.ts`, `apps/engine/test/anime.test.ts`, `e2e/anime-core.spec.ts` | `/api/licenses` lists anime.js (MIT, text). Packaged-like verified for real: `dist/engine.mjs` + `dist/third-party/` copied outside the repo answered with the committed text and version 4.5.0; unit test for the same path (`animeLicense(null)`). The engine-less About names anime.js (MIT). |

## Contract changes (additive)

- `FontsReadyState.isLoaded(family, weight?, style?)` (was `(family)`); `useFontsReady` accepts family names or
  `{family, weight?, style?}` queries. New exports in `@jasper/compositions`: `useFontsReadyState`,
  `useLayerFontsReady`, `layerFontFaces`, `fontFaceFor`, `FontFaceQuery`. `useDocumentFonts` keeps its boolean.
- `useAnimeValues` returns values rounded to 1e-6 (`-0` → `0`); `valuesAt` and `roundValue` exported from
  `runtime/hooks.ts` (not from the package index).
- `createPausedTimeline` drops `frameRate`, `loop`, `loopDelay`, `alternate`.
- `animeLicense(installed?)` (engine, internal).
- `@jasper/motion` devDependency `@remotion/player` 4.0.499 (Player parity page); lockfile: 3 added lines.

## Licences

- `animejs` 4.5.0 — MIT: `/api/licenses` (engine), engine-less About, `THIRD_PARTY_NOTICES.md`.
- `THIRD_PARTY_NOTICES.md` covers the whole shipped JavaScript closure (MIT, ISC, 0BSD, BSD, OFL-1.1 for Source
  Sans 3, MPL-2.0 for `mediabunny`, the Remotion License for `remotion`/`@remotion/*`).

## How to test

- `pnpm lint && pnpm typecheck && pnpm e2e:typecheck && pnpm test`.
- Focused: `pnpm vitest run packages/motion packages/compositions/test/fonts-ready.test.tsx scripts/check-anime.test.mjs scripts/third-party-notices.test.mjs apps/engine/test/anime.test.ts apps/engine/test/anime-scaffold.test.ts apps/web/test/third-party-notices.test.tsx apps/web/test/vite-chunks.test.ts`.
- Parity + cost: `REMOTION_E2E=1 pnpm vitest run packages/motion/test/determinism-render.e2e.test.ts`
  (Chrome: `/usr/bin/google-chrome` or `JASPER_BROWSER_EXECUTABLE`; ~5–7 min on a loaded box). Results
  (`anm-015.json`, `player-*.json`) are written to a temp dir `jasper-anm014-*`.
- Playwright: `E2E_SKIP_LGPL=1 E2E_PORT=<free port> pnpm e2e e2e/anime-core.spec.ts`.
- `pnpm notices --check`.

## Defects fixed

- **Float noise in the value engine** (found by the determinism suite on the parity scene): anime.js does not
  round plain-object numbers, so units at rest rendered `opacity: 1.0000000000000002`, `translate(-2.7e-15px)`
  (not exactly the un-animated layer, ANM-009) and tiny values were stringified in exponent notation, which
  happy-dom's CSS parser rejects (a value then "stuck" from the previous frame: order-dependent DOM). Values are
  rounded to 1e-6 (`runtime.test.tsx`, `determinism.test.tsx`).
- **Leaked `delayRender` handle**: `useDocumentFonts` created a handle in a `useState` initializer, which
  StrictMode / concurrent rendering may run twice — the extra handle was never continued and a render waited for
  the 30 s timeout; the handle was also released before the layers mounted with their fonts
  (`fonts-ready.test.tsx`).
- **Fallback-font paint and measurement**: text mounted (and would split/measure) before its face loaded.
- `resolveEase('steps', {steps: NaN})` returned `steps(NaN)`; now 8 steps.
- `groupLines` compared `offsetTop` values relative to different offset parents when units sit in positioned
  wrappers (per-line masks).
- `segmentText` without `Intl.Segmenter` split combining marks, emoji modifier/ZWJ sequences and flags.
- `needsShaping` missed RTL scripts outside the listed ones (Adlam, Hanifi Rohingya, historic RTL), bidi controls,
  ZWNJ/ZWJ joiners and several Brahmic/South-East Asian scripts.
- `motion/test/runtime.test.tsx` asserted the implementation tables are empty and `apps/engine/test/anime.test.ts`
  that `features.anime` counts are 0 — both would have failed as soon as text-anim / anime-templates merge.
- The lint missed aliased/multi-line imports, namespace imports, `el.animate()`, `engine.update()`, `new Date`,
  timers, plain seeks, unseeded staggers, the `timer`/`animation`/`animatable`/`text`/`irregular`/`adapters`
  modules and `engine` outside the runtime; and it flagged every `.set(`/`.call(`/`.reverse(` (Map, Function,
  Array) in files using anime.js.

## Cross-package edits

- `packages/compositions/src/SequenceComposition.tsx`: two hunks — the provider value comes from
  `useFontsReadyState(doc.fonts)`, and `ClipLayer` returns null until `useLayerFontsReady(clip, doc.fonts)`.
- `apps/web/src/shell/licenses.tsx`: anime.js in the engine-less notice + the third-party notices section.
- `apps/web/vite.config.ts`: `vendorChunk` (manualChunks moved into a named, tested function; `vendor-anime`) and
  the notices plugin.
- `apps/desktop/scripts/package.mjs`: notices `--check`, presence in the web build, copy next to the engine.
- `apps/engine/src/mg-bundles/template/files.ts`: the anime example (files appended; the LowerThird example and
  manifest entry unchanged).
- `package.json`: `notices` script. `biome.json`: the motion overrides. `README.md`: one subsection.
- `packages/motion/package.json` + `pnpm-lock.yaml`: devDependency `@remotion/player` 4.0.499.

## Known gaps / for the integrator

- After merging packages that add dependencies to the web app or compositions closure, run `pnpm notices` and
  commit `THIRD_PARTY_NOTICES.md` (the test `scripts/third-party-notices.test.mjs` fails until then).
- On this branch the implementation tables are empty, so the determinism suite and the parity document exercise
  fixture implementations, Motion keyframes and the contracts' shape placeholder; text-anim's presets and
  anime-templates' templates join both automatically when merged (the parity document adds one text clip per
  preset and one clip per anime template). Re-run `REMOTION_E2E=1` parity after the merge.
- The determinism harness requires text implementations to end `in` / start `out` exactly at
  `REST_UNIT_VALUES` (after rounding) and timelines no longer than `durationMs` (the §20.2 build contract).
- Anime templates' font faces are found from params naming a document font (id or family); templates that pick
  fonts otherwise should call `useFontsReady` themselves (anime-templates).
- `apps/desktop/scripts/package.mjs` changes were not run end to end (packaging fetches the LGPL FFmpeg); the
  web build emitting `THIRD_PARTY_NOTICES.md` and the packaged-like `/api/licenses` were verified separately.
