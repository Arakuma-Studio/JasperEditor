# wp-m2-layer-bake — native export of DOM layers (S11 §6, FIX-002)

Branch `wp/m2-layer-bake` (from `main` a7f1f47, contracts merge 3ece27f). Spec: `docs/specs/11-animation.md` §6 and
§9 FIX-002 (user decision **option A: every text clip is baked**). Contracts: ARCHITECTURE D-22, D-31, §19.6,
§20.5. Remotion pinned at 4.0.499.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| LBK-001 | `apps/engine/src/layer-bake/{layer,extension}.ts`, `routes/layer-bake.ts` | Extension `layer-bake`, `kinds: {'text','shape'}`, `claimsLayer` = `isDomLayer`: kind `text`/`shape`/`motion-graphic` **and** snapshot `engine === 'remotion'` (from `clipEngines`, so `renderer: 'anime'` templates are claimed, fframes templates and adjustment/caption kinds are not). Registered by the route plugin between `mg-bundles` and `tracking` (contracts order). Nothing kind-specific beyond that: text animators, anime templates and real shapes need no change here. |
| LBK-002 | `export/planner.ts` (delimited hunks) | Claimed layers skip the generic checks (blend ≠ normal and reverse still block, S04:RP-005). New optional `NativeExtension.bakes(clip)` → `graphicsGroups` `{id: 'lbN', engine: 'remotion', itemIds: [clipId]}`, segment `mode: 'mixed'`, path **`hybrid`** (also when `native` is forced). fframes checks only for non-anime templates; an unclaimed anime template reports "requires graphics rendering (anime template)". `mgClips`/`collectMgMasters` skip anime templates. Estimate adds the bake frames at 8 fps. `export/service.ts`: `native`/`hybrid` share the native runner; queue stage "Queued (native + baked graphics)". |
| LBK-003 | `layer-bake/service.ts` (`planBake`, `renderBake`), `remotion/service.ts` (`renderAlphaMaster`) | One-clip document per claimed clip over its drawn span `[start − head, start + duration + tail)`; times shifted so the span starts at 0; `layerFilter: [clipId]`, `transparentBackground`, `isPreview: false`; media/fonts as signed absolute URLs (only the fonts/media the clip references). `renderAlphaMaster`: ProRes 4444 `yuva444p10le`, PNG frames, muted, BT.709 lossless remux (`bt709RemuxArgs`), frame-count check, usage log. Override `{space: 'sequence', startFrame: spanStart, includesFades: true}`. |
| LBK-004 | `layer.ts` (`isStaticLayer`), `native.ts` | Static = not an anime template, no text animator, no keyframes anywhere in Motion/opacity/effect params/source (deep scan of every Animatable, so shape props and future fields are covered), no unknown (possibly time-varying) effect; colour effects are excluded because ffmpeg applies them. Static layers: `renderStill` (straight-alpha PNG) of a 1-frame clip without handles/fades → `still.png`; override `still: true`, `includesFades: false`; the builder loops it (`-loop 1 -framerate`) and applies the transition fades. The key ignores position in time and duration. |
| LBK-005 | `layer.ts` (`cropRect`, `contentBleed`), `native.ts`, `service.ts` (`clippedAtBorder`) | Union over the bake's frames of the layer box grown by content bleed (text stroke/shadow/background padding, animator `distance`/`blur`/`scale` params, 3× blur radius; unknown effects → no crop) mapped through the layer map (corner pins included), plus 10 % of the sequence height, clamped, even-aligned; ≥ 85 % of the frame → full frame. Rendered by shifting the Motion position (value and keyframes) by whole pixels and sizing the document to the rect. **Safety net:** after rendering, the alpha of every inner edge of the rect is measured (`alphaextract`, `signalstats`); alpha > 2 on an edge re-renders the full frame. Override `rect`: builder scales to `w×h` and overlays at `x, y`. |
| LBK-010 / FIX-002 | `native.ts` (`colorRunFilters`), `layer-bake/{service,extension}.ts`, `compositions/src/layers/BakedLayer.tsx`, `apps/web/src/layer-bake/*` | Bakes never contain colour effects. **Native:** override `colorRuns: true`; the builder asks the colour extension's `effectFilter` for the clip's runs (`lut3d` + per-frame windows) on the straight-alpha override stream. **Remotion path / stills:** `prepareForRemotion` bakes and writes a graded master (`graded/` = bake + the same `lut3d` filters (+ the fades of a still), straight-alpha PNG frames, see deviations and review fixes); `adaptRemotionDoc` drops colour effects from DOM layers and sets `clip.baked = {url (signed `graded.png`), startFrame, frames, rect}`; the compositions wrapper shows frame n (`&n=`) with `<Img>` in its region. **Preview:** `POST /api/layer-bake/preview` (replaces the 501 stub) → `layer-bake` job → bake (if needed) + graded VP9-alpha preview at half size (BT.709 TV tagged); the web runtime asks 2 s after the layer last changed and the wrapper plays it; until then the layer draws ungraded with the "Grade pending" chip (`GradeChip`). |
| LBK-020 | `layer-bake/key.ts`, `remotion/service.ts` (`bundleId`, `animejsVersion`, `browserIdentity`, `renderGl`) | `sha256(canonicalJson({v, recipe, frame?, clip, span, width, height, fps, fonts: [{family, weight, style, fileSha256}], media: [{mediaId, fingerprint, size, mtime}], bundleId, animejs, remotion, browser, gl, still, rect, graded}))[:40]`. `clip` = the clip as baked (span-relative times, only enabled non-colour effects, text content/style/runs/box, animator params and compressed window frames, shape data, template params) without name/track; the clip id is a constant **except for seed-bearing layers** (text with an animator, anime templates: `hash32(clipId, …)` seeds, S11:ANM-007) — two identical seeded clips never share a bake. Fonts: the faces the clip draws with (style and styled runs; review fix 5), hashed by file content (cached per path+size+mtime). `bundleId` = dev source hash, or the `jasper-bundle.json` stamp of a prebuilt bundle (content hash otherwise). `gl` = the probed `chromiumOptions.gl`. Anime templates add `renderVersion` (registry `MgAnimeTemplateDefinition.renderVersion`; `null` while not installed); their params and `paramKeyframes` are in the snapshot source, hence in `clip`. |
| LBK-021 | `service.ts` (`gc`, `lookup`, `markUsed`), route `GET /mg/layers/:key/:file` | `<appdir>/cache/layers/<key>/{master.mov \| still.png, graded/NNNNNN.png, preview.webm, meta.json}`; graded entries are their own keys (bake key + colour effects + LUT identities + timing). `meta.json` `lastUsedAt` refreshed on use; GC at start and daily removes entries unused for 14 days (and orphan dirs by mtime). Files are served under `/mg/layers/` (signable prefix, Range, immutable). |
| LBK-022 | `service.ts` (`ensureBake`, `ensureGraded`, `ensureEntry`, `submitChild`, runner), `remotion/page-pool.ts` | Job kind `layer-bake`, child of the export/still (`cpuSlots: 0`, `minSlots: 0`, dedupe `layer-bake:<key>:<parentId>`, parent abort cancels the child; queue cancel cascades). Parent stage "Baking graphics i/n", child "Rendering i/N frames". The export's Remotion concurrency (`remotionConcurrency(ctx.slots)` via `NativePrepareContext.concurrency`) is a page budget shared by the bakes running side by side (see "Parallel bakes"; before: one bake at a time with all of it). |
| LBK-023 | `export/service.ts` (`NativePrepareError`, `fallbackToRemotion`) | Any extension `prepare` failure on the native/hybrid path of an `auto` export or still → re-plan with `engine: 'remotion'` (only when that plan succeeds) and render there; result `renderPath: 'remotion'`, `warnings: [{code: 'NATIVE_FALLBACK'}]`, job log line. Forced `native`: fails with the original error (code kept). |
| LBK-024 | `extension.ts` (`blockers`), `planner.ts` | `remotionLocal: 'unavailable'` or binaries refused → "graphics layers need the Remotion renderer to bake (reason)" per DOM layer; `needs-browser-download` is ready with warning `BROWSER_DOWNLOAD`. DOM-layer colour never needs WebGL (dropped from Remotion docs, applied by ffmpeg). |
| LBK-025 | `export/service.ts` (`runStill`), `extension.ts`, `service.ts` (`planBake` frame variant) | `POST /api/stills` (and MCP `render_frame`, which uses it) take the export's path: a cached full master/still is reused; otherwise a static layer bakes its still, a non-static one a one-frame bake keyed by the frame. |
| LBK-026 | `remotion/service.ts` (`recordUsage(kind, purpose)` public), `mg-bundles/service.ts` (2 lines) | Every bake (`media`/`still`, purpose `layer-bake`), every mg pre-render (`mg-prerender`, master/preview and posters) and exports/stills log one line in `<logs>/remotion-usage.jsonl`. |
| LBK-030 | `routes/layer-bake.ts`, `service.ts` (`capability`) | `features.layerBake = {state, reason?, cacheBytes}` (size walked in the background). `features.anime` stays with `routes/anime.ts`. |
| LBK-031 | tests | Builder output (unit) and every ffmpeg command of the e2e run (`-filter_complex` / `-vf`) pass `gplFiltersIn`. Filters used: `lut3d`, `format`, `scale`, `fade`, `overlay`, `setparams`, `alphaextract`, `signalstats`, `metadata`, `crop`. |

## Composition setup failures

The render operation includes `selectComposition` before drawing frames (S04 RR-001). Its SDK failures use the
same engine error mapping as drawing: a timeout returns retryable `RENDER_TIMEOUT` (RR-006), and cancellation
arriving during selection returns `JOB_CANCELLED` (RR-005). Existing typed refusals are preserved. The shared
`RemotionService` composition boundary covers exports, alpha masters and stills; binary, WebGL and bundle
preconditions remain outside the SDK catch. This changes error classification, not render deadlines or recovery.

The cleanup validation run exposed the gap in `layer-bake.e2e.test.ts`: a Fresh-layer bake reported a render
timeout, but the fallback still's composition-selection timeout escaped as `INTERNAL`; RED title selection
timeouts were wrapped as `LAYER_BAKE_FAILED`. Those failures preceded pixel comparisons. The FADE export used
the documented Remotion fallback and failed the test's hybrid-path assertion before fade comparisons.

`apps/engine/test/remotion-retry.test.ts` now injects selection timeout and cancellation faults at the external
SDK boundary and asserts the public service errors. Both regressions failed before the owner fix with an untyped
SDK Error. After the fix, all seven retry-suite cases pass; targeted Biome and diff whitespace checks also pass.
These SDK fault tests do not establish real-browser rendering success or resolve the host's setup timeouts.
Integrated typecheck/gates and browser reruns remain pending. Detailed before-edit evidence and six-bar retention rationale are
in [the cleanup ledger](../test-cleanup/compositions2.md#composition-setup-error-normalization--before-edit-record).

## Contract changes (additive; `Contract-Change:` in the commits)

- `NativeExtension.bakes?(clip): 'remotion' | null`; `NativePrepareContext.purpose?: 'native' | 'remotion'`, `concurrency?`; `LayerOverride.still/rect/colorRuns` are now implemented by the builder.
- `RenderVisualClip.baked?: {url, startFrame, rect?}` (`packages/project/src/render/snapshot.ts`, type only; set by the engine for the Remotion path).
- `@jasper/api`: `LayerBakePreviewRequest` gains `sequenceId` (required) and `envelope`; `LayerBakePreviewResult`; route `layerBakeFiles` (`GET /mg/layers/:key/:file`); `ExportResult.renderPath?` and `warnings?`.
- `RemotionService`: `renderAlphaMaster`, `bundleId`, `animejsVersion`, `browserIdentity`, `renderGl`, public `recordUsage(kind, purpose?)`, `renderStill({purpose})`; exports `ALPHA_MASTER_OPTIONS`, `bt709RemuxArgs`, `BUNDLE_STAMP_FILE`.
- `@jasper/compositions`: `setBakedLayerRuntime`, `withBakedLayer`, `needsBakedPicture`, `hasDomColorEffects`, `isDomLayerClip`; `layerComponentFor` wraps DOM layers that need it (the layer table is unchanged).
- `export/planner.ts` exports `isAnimeTemplate`; `export/native.ts` exports `colorRunFilters`.

## Cross-package edits (minimal, delimited)

- `packages/compositions/src/layers/index.ts`: one import + 3 lines in `layerComponentFor` (+ re-exports). The layer components (`TextLayer`, `ShapeLayer`, `MotionGraphicLayer`) are untouched.
- `apps/web/src/commands/index.ts`: import + `layerBakeCommands` appended to `COMMAND_MODULES` (registers the Program overlay that attaches the runtime).
- `apps/engine/src/mg-bundles/service.ts`: two `recordUsage` lines (LBK-026).
- Tests whose expectation was "text forces Remotion": `apps/engine/test/remotion.e2e.test.ts` (REMOTION_E2E: the text gets `blendMode: 'screen'` to stay on the Remotion path), `apps/engine/test/export.test.ts` (text → `hybrid`; without Remotion → `remotion` + new blocker), `apps/engine/test/warp.test.ts` (corner-pinned text → `hybrid`), `apps/engine/test/color-remotion.test.ts` (the blank text gets `blendMode: 'screen'` to keep the Remotion path that the test is about), `apps/engine/test/anime.test.ts` (the 501 stub test → the route validates), `e2e/smoke.spec.ts` (the "text → Remotion export" step forces `remotion`).

## Deviations

- **Clip id in the key:** constant except for seed-bearing layers (text animators, anime templates), where the clip id itself is kept (equivalent to keying `hash32(clipId)`; the engine never imports `@jasper/motion`).
- **Graded masters are straight-alpha PNG frame sequences (`graded/`), not ProRes 4444** (and, since the review fixes, not PNG-in-MOV either). Remotion's compositor converts YUVA video a few code values off (ProRes 4444 / VP9 alpha, BT.709 TV tagged: grey 54 → 51, (30,160,230) → (24,161,231); the original measurement had TV 62 / full 49) and **drops the alpha of RGBA video** (PNG-in-MOV, qtrle: the layer's region rendered opaque black — invisible over the original e2e's black background). PNG frames shown with `<Img>` are exact: native 54 / Remotion 54 / preview 53, and alpha/fades match native (review fixes). One signed URL per entry (`/mg/layers/<key>/graded.png`), the frame chosen by `&n=` (the signature covers the path). Spec LBK-021 names `graded.mov`.
- **Crop safety net** (not in the spec): a crop that cuts the layer is detected and the layer is re-rendered full frame.
- **Colour order:** colour runs of DOM layers are applied to the finished layer, i.e. after the layer's other effects. Different from the stack order only when a colour effect precedes a pixel-mixing effect (blur): the plan warns `DOM_GRADE_ORDER`.
- **Static stills** key on a one-frame clip (duration and handles dropped): trimming/moving a static title reuses its PNG.

## Licences

No new dependency. FFmpeg filters/encoders used: `prores_ks`, `png`, `libvpx-vp9`, `lut3d`, `alphaextract`, `signalstats`, `metadata`, `scale`, `crop`, `overlay`, `fade`, `setparams` — all in the LGPL build.

## How to test

```bash
pnpm fixtures
pnpm vitest run --project @jasper/engine apps/engine/test/layer-bake.test.ts      # no browser
pnpm vitest run --project @jasper/web apps/web/test/layer-bake-runtime.test.ts
REMOTION_E2E=1 pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts   # ~3–4 min, headless Chrome
REMOTION_E2E=1 pnpm --filter @jasper/engine exec vitest run test/layer-bake-parallel.e2e.test.ts   # parallel = sequential, joins, cancel (~5 min)
pnpm vitest run --project @jasper/engine apps/engine/test/page-pool.test.ts   # pool: budget, progress, abort
```

The e2e suite appends its measurements to `<tmpdir>/layer-bake-e2e.txt`.

`gpu-spans.e2e.test.ts` compares the hybrid export with full-sequence composition
stills built through public `buildRenderSnapshot` and signed media handles. Its
reference setup does not call the export planner or private export methods;
the ten boundary/effect frames, pixel tolerance and repeat-export cache checks
remain unchanged. At integration source `30a8430e`, the rewritten case passed
with all ten RGB comparison shares at 1.0000 within 3/255, no new bake jobs on
repeat export, and byte-identical frame 45 (exit 0). Semantic engine typecheck
also passed. The [cleanup ledger](../test-cleanup/engine2.md#gpu-span-reference-setup-follow-up--before-edit-record)
records the exact source, measured run durations and evidence files separately
from the earlier historical run.

## Results (this box: 12 cores, no GPU, load average 20–45 from other agents)

| Check (S11 §11 test 4) | Result |
|---|---|
| footage + static title + keyframed title + shape + anime template | plan `hybrid`, 4 child bakes: 2 `still.png` (title, shape), 2 masters; all four cropped (e.g. static title 664×236 of 1280×720) |
| output vs full Remotion render (stills of the same composition), 5 frames | 100.00 %, 99.90 %, 99.90 %, 99.90 %, 100.00 % of samples within 3/255 |
| straight alpha: master frame over R/G/B/W vs browser still | 56 656 semi-transparent samples, worst 1/255 |
| re-export / moved title / changed text | 0 / 0 / 1 bakes |
| stills | cached master reused (0 bakes, ≥ 99 % within 3/255 of the export frame); new keyframed title → 1 one-frame bake |
| Lumetri (saturation 0) on a red title | mean glyph colour native 54, Remotion export 54, graded preview 53 (ungraded: 255, 0, 0); native vs Remotion ≥ 99 % within 3/255 |
| failing bake | `auto` → `remotion` + `NATIVE_FALLBACK`; forced native → failed `LAYER_BAKE_FAILED` |
| GPL filter scan, usage log | clean; `layer-bake` lines of kind `media` and `still` |

Observed while measuring (pre-existing, not changed here): Chrome and FFmpeg decode the H.264 test footage differently
(testsrc2: up to ~30 code values), and the Remotion export path's ProRes 4:2:2 intermediate adds chroma ringing
around saturated text edges; that is why parity is measured against Remotion stills over a flat background.

## Verification (2026-10-01, load average 25–130 on 12 cores)

| Command | Result |
|---|---|
| `pnpm typecheck`, `pnpm e2e:typecheck` | ok |
| lint (`biome check apps packages scripts e2e *.json *.ts`, `check-tokens`, `check-anime`) | ok (see the `.claude` note below) |
| `pnpm test` | 1289 passed, 28 skipped, 6 failed — all timing-only under load: `tracking.test.ts` (3: input-seek decoding and 500 ms cancel at the 5 s default timeout; the same three the contracts package reported) passes alone (12/12); `app.test.tsx` + `shell-render.test.tsx` (3, 5 s default timeout at load 133) pass alone (9/9; 4.5–5.2 s per test at load 50–70, all pass at load 33 with the default timeout) |
| `layer-bake.test.ts` / `baked-layer.test.tsx` / `layer-bake-runtime.test.ts` | 22 / 4 / 2 passed |
| `REMOTION_E2E=1 layer-bake.e2e.test.ts` | 7/7 (numbers above) |
| `REMOTION_E2E=1 remotion.e2e.test.ts color-remotion.test.ts`, `remotion-lgpl.e2e.test.ts` | 5/5, 5/5 |
| `MG_E2E=1 mg-bundles.test.ts` | 20/20 |
| Playwright `e2e/layer-bake.spec.ts` (built engine + web, LGPL FFmpeg 7.1 vendor dir, prebuilt stamped bundle) | 3/3 (1.2 min) |
| Playwright `e2e/smoke.spec.ts` | the changed step ("forced Remotion export") and the 7 steps before it pass; the fframes steps need `jasper-mg` (`pnpm mg:build`, not built in this worktree) and fail on that alone ("fframes renderer unavailable") |

## Defects fixed

- **Colour on DOM layers (FIX-002):** dropped silently in the preview and both export paths; worse, a graded text clip made a
  Remotion render fail with `WEBGL_UNAVAILABLE` on engines without WebGL2 although the compositions never grade text.
  Now graded on all three paths, and DOM-layer colour never requires WebGL (tests: e2e grade test, `layer-bake.test.ts` builder test).
- **`prepareExtensions` failures failed `auto` exports** instead of falling back to Remotion (any extension: warp, mg,
  colour). Now LBK-023 (test: "auto fallback" with a failing extension and a stubbed Remotion render).
- **Anime templates were sent to the fframes master provider** (`collectMgMasters`) and labelled as fframes graphics
  groups; with jasper-mg present the export would have tried to render an unknown fframes template. Now baked
  (planner test).
- **mg pre-renders and posters were missing from the Remotion usage log** (S04:LC-004). Logged (LBK-026).
- **`ExportResult` schema lacked `renderPath`** although every export result carries it; added (with `warnings`).

## Review fixes (branch `fix/layer-bake-review`)

| # | Finding | Fix | Tests |
|---|---|---|---|
| 1 | Static graded DOM layers lost their transition fades on the Remotion path and in the Program preview (the still recipe has no fades; `graded.mov` / `preview.webm` were only the bake + colour runs, and the wrapper plays them as they are) | **Found while verifying:** on the Remotion path the alpha of the graded master was ignored altogether (`OffthreadVideo transparent` drops the alpha of PNG-in-MOV: the whole layer region was opaque black), so no fade could show there. The Remotion-path graded master is now a straight-alpha PNG frame sequence shown with `<Img>` (`clip.baked.frames`, route `graded.png?n=`; see deviations; ProRes 4444 / VP9 alpha would honour alpha but decode up to 6/255 off). Then `planGrade` appends `fadeFilters(clip.fades, spanStart)` (+ `setpts`) after the colour runs for still sources — the same alpha ramps the native builder applies to a still override. Masters and single frames already have their fades (and opacity) baked in, so they get none. Every baked picture is now the whole placed layer: native (still override + builder fades, or master with fades), Remotion (`graded/` frames) and preview (`preview.webm`) apply opacity and fades exactly once; `BakedMaster` / `BakedPreview` deliberately do not apply `layer.props.opacity` (documented). The grade key gains the span-relative fades and `graded.v = GRADE_VERSION` (2), so old fade-less graded entries are never reused. | `layer-bake.test.ts` "graded stills get the transition fades…", "graded masters are PNG frame sequences…"; `baked-layer.test.tsx` opacity/fade cases (DOM layer fades itself; preview/master add no CSS opacity; master `<img>` of the current frame); e2e "a graded static title fades through its transition once on every path" (grey background; before the fixes Remotion and the preview stayed at full level mid-ramp, ratio 1.00 vs native 0.50) |
| 2 | Graded previews stored under the identity computed at schedule time while `submit` sent the document of 2 s later | `submit` recomputes the clip's identity in the committed document it sends (same document + revision in the envelope); when it changed, it drops the request and rescans (the new identity is scheduled) | `layer-bake-runtime.test.ts` "a layer edited just before its request fires…" (fake timers; fails on the old code) |
| 3 | Grade key of still-recipe sources missed the real clip timing | Grade material carries `duration`, `headHandle`, `tailHandle` and the fades besides `gradeStart`, `sourceIn`, `speed` (reversed clips map frames through the duration) | unit test: same span, other duration/tail split → other key |
| 4 | GC could delete an entry a running export was about to read | `lookup` / `ensureGraded` await `markUsed` and wait for a removal in progress (then miss); `gc` reads `meta.json` right before the removal with no await between the checks and `rm`; leases: `ensureBake` / `ensureGraded` hold their keys from before the lookup until the parent export/still job finishes (`queue.wait`), the `layer-bake` runner holds its keys for the job | unit test "GC keeps entries held by running jobs…" (lease, awaited `markUsed`, lookup racing a GC pass, `ensureBake` held until the parent finishes) |
| 5 | `clipFonts` keyed every face of a font id, so another weight elsewhere or a sub-range export changed the key | Text: only the face of the style and of every styled run (exact font/weight/style, else the font's first face, as `TextLayer`'s `fontFaceFor` picks); other sources (anime template params): faces of fonts they name by id or family (as `layerFontFaces`) | unit test: faces per style/run; adding a bold title of the same font keeps the regular title's key and its bake document has one face |

Contract change: `RenderVisualClip.baked` gains `frames` (the URL is a PNG frame sequence); route `layerBakeFiles` serves
`graded.png?n=` instead of `graded.mov`.

Verification (2026-10-01): `pnpm lint`, `pnpm typecheck`, `pnpm e2e:typecheck` ok; `pnpm test` 1583 passed, 39 skipped;
`layer-bake.test.ts` 26/26, `baked-layer.test.tsx` 7/7, `layer-bake-runtime.test.ts` 3/3; `REMOTION_E2E=1 layer-bake.e2e.test.ts`
8/8 (134 s). Fade case over grey, frame 15 of a 10-frame fade-in (expected ×0.50): glyph level ratio native 0.500 /
Remotion 0.500 / preview 0.497, graded glyph grey 54.3 / 54.3 / 54.6, background kept in the layer region 100 % / 99.95 % /
99.91 %; native vs Remotion ≥ 99 % within 3/255 mid-fade and at full opacity. Grade test unchanged: 54 / 54 / 53.

Deviation: fix 1 puts the fades into the graded files (engine) rather than applying `layer.props.opacity` in the wrapper —
masters (and single frames) render through `ClipLayer` with opacity and fades, so applying them again in the wrapper would
double them; only the still recipe lacked them.

## Parallel bakes (branch `feat/parallel-bakes`)

Closes the known gap "bakes of one export run one after the other". Before, `prepare` planned and baked one clip
at a time, each bake a child job rendering with the export's whole Remotion concurrency and launching two browsers
of its own (one for `selectComposition`, one for the render); 8 small layers spent most of their time in those
fixed costs (launch, page creation, bundle load, ffmpeg stitch, remux, frame count, crop check), with the pages idle.

**Design (LBK-022, refined).**

| Part | What | Where |
|---|---|---|
| Page budget | The export's Remotion concurrency (`remotionConcurrency(slots)` = min(granted CPU slots, ⌊cores / 2⌋): 6 for a full export on this 12-core box, 2 for a still job) is the number of Remotion pages the export may have rendering at once — shared by its bakes instead of given to each. | `extension.ts` (`budget`) |
| Pool | `runPagePool`: at most `min(budget, 6)` bakes in flight (`MAX_RENDERS_IN_FLIGHT`: each bake has a compositor, an ffmpeg stitcher, remux and checks besides its pages). A bake is granted its pages when it starts (Remotion's concurrency is fixed per render): a still 1; the masters split the budget in proportion to their frames (`pageShares`: `round(budget × frames / Σ master frames)`, at least 1, at most one page per 10 frames — `MIN_FRAMES_PER_PAGE` — and the budget), so a long master takes more pages and a lone master all of them, as before. Largest share first, smaller bakes backfill free pages; a bake starts with at least half the pages it wants (any number when nothing else runs). Σ pages in flight ≤ budget. With `maxInFlight` 1 (sequential) every master wants the whole budget. | `remotion/page-pool.ts` |
| Plan first | All bake (and, on the Remotion path, grade) plans are computed first, in clip order (cheap; the colour extension's `prepare` stays sequential); identical keys are grouped so one render serves every clip that shares it; then the renders run in the pool. | `extension.ts` |
| Job accounting | Child jobs keep `cpuSlots: 0`, `minSlots: 0` (the queue would otherwise count the export's CPU twice, or block the children behind their own parent): the export holds the slots, and its bakes' pages are carved out of its budget, so the children are bounded by the parent's grant instead of each taking the whole concurrency. The child's stage shows its share: "Rendering 12/60 frames (2 pages)". | `service.ts` (`submitChild`) |
| Abort | Cancelling the export aborts the pool: every bake in flight cancels its child job and waits for it to settle (the queue's parent→child cascade does the same); queued bakes never start. The first failing bake aborts the others the same way and `prepare` rejects with its error once all have settled (`auto` exports then fall back to Remotion, LBK-023). Nothing started by the pool outlives `prepare`. | `page-pool.ts`, `service.ts` (`follow`) |
| Dedupe | `LayerBakeService` keeps the entries being rendered (`inflight`, keyed by bake or grade key, registered with no await between the check and the registration). A second `ensureBake` / `ensureGraded` of a key in flight — another export, a still, or another clip — joins that child job (following its progress) instead of rendering it again; if the owning export is cancelled, the joiner renders the key itself; a real failure is the joiner's failure too. A grade job (Remotion path, preview) waits for an in-flight render of its source bake. The queue dedupe key stays `layer-bake:<key>:<parent>`. | `service.ts` (`ensureEntry`) |
| GC leases | Unchanged: `ensureBake` / `ensureGraded` lease their keys before the lookup until the parent job finishes (joiners too), runners for the job. | `service.ts` |
| Progress | Parent stage "Baking graphics i/n · p %": i = bakes finished, n = renders, p = progress weighted by frames + a fixed cost of 30 frames per render, from the child jobs' progress (polled every 250 ms; a joined bake reports its owner's). | `extension.ts`, `page-pool.ts` |
| Browser | One shared render browser per export (`RemotionService.openSharedBrowser`: the probed `gl`; with a full Chrome every page in its own window, `renderPagesInOwnWindows`, so pages of concurrent bakes never hide each other), launched by the first bake that needs it (an all-cached export launches none) and closed when `prepare` ends; passed as `puppeteerInstance` to `selectComposition`, `renderMedia` (masters) and `renderStill`. Without it every bake launches two browsers. Chosen by measurement (below). A crash of the shared browser fails the bakes in flight (then LBK-023 as for any bake failure). | `remotion/service.ts`, `service.ts` (`browserSession`) |
| Knobs | `JASPER_LAYER_BAKE_PARALLEL=<n>` bakes in flight (`1` = the sequential path: one bake at a time with the whole budget, own browsers); `JASPER_LAYER_BAKE_SHARED_BROWSER=0` one browser per bake; `JASPER_LAYER_BAKE_PAGES=<n>` page budget; `JASPER_LAYER_BAKE_PAGES_PER_BROWSER=<n>`. `LayerBakeService.parallelism` (tests). | `service.ts`, `routes/layer-bake.ts` |
| Throughput (export-performance §8) | Superseding the budget, pool and browser rows above where they differ: a native export's bakes get one page per granted CPU slot (`bakePages`), up to 12 bakes in flight, masters share the budget among the renders in flight (`pageShares(…, atOnce)`), a bake releases its pages once its frames are captured (`PageGrant.release`), several shared browsers per export (two pages each, at most 8, `acquireBrowser`), the ProRes stitch with `2 × pages` threads, one decode for the crop check. Measured on the real project: bake 274.7 s → 98.0 s, the same cache entries byte for byte. | `extension.ts`, `service.ts`, `page-pool.ts`, `remotion/service.ts` |
| mg pre-renders | `MgBundleService.ensureMasters` uses the same pool: one pre-render per distinct render key, budget = the export's Remotion concurrency (was a fixed 4 tabs per pre-render, one pre-render after the other), same abort/failure semantics, stage "Rendering compositions i/n · p %". Not in the shared browser: `runPrerender` is also the interactive preview job, owns its browser set-up (bundle serve URL, own-window patch) and an export rarely has more than a few compositions; it is not in the layer-bake pool either (the extensions' `prepare` run one after the other, `mg-bundles` before `layer-bake`, ARCHITECTURE §19.6), so each gets the whole budget in turn. Cross-export joins are not done there (two exports pre-rendering one key at the same time render it twice, as before). | `mg-bundles/service.ts`, `native-ext.ts` |

**Determinism.** A bake's pixels do not depend on the schedule, its page count or the browser it shares: every frame
is fully repainted (`FrameRepaint`, ANM-014) and every page has its own window. Checked through decoded pixels (below).

**Historical measurements** (this box: 12 cores, no GPU, shared with other agents; full Chrome `/usr/bin/google-chrome`, swangle).
The measured export had 90 frames at 1280×720 and eight DOM layers — three static
titles and a static shape (4 `still.png`), a keyframed title (60 frames), two text-animator titles (slide-up 90
frames, pop 45 frames), an anime template (60 frames) — native ProRes 4444, cold layer cache, warm bundle; bake phase
= export start → last bake finished. Page budget 6.

| Run | Load (1 min) | Bake phase | Export |
|---|---|---|---|
| `main` 74b5bcd (before), 4 rounds | 5–14 | 28.8 / 31.1 / 29.8 / 32.8 s | 33.4–35.8 s |
| this branch, sequential mode (`JASPER_LAYER_BAKE_PARALLEL=1`), 3 rounds interleaved with the rows below | 11–15 | 34.0 / 35.1 / 35.3 s (median 35.1) | 37.4–39.4 s |
| parallel, a browser per bake | 11–15 | 13.7 / 17.8 / 15.8 s (median 15.8) | 17.1–21.7 s |
| **parallel, shared browser (default)** | 11–15 | **14.0 / 14.2 / 13.3 s (median 14.0)** | **16.7–17.9 s** |
| parallel, at most 3 bakes in flight, shared browser | 11–15 | 15.2 / 16.8 / 15.7 s | 18.3–20.6 s |

The bake phase is 2.5× shorter (the export 2.2×). Timeline of a parallel run: the four masters start at once
(2 + 1 + 1 + 1 pages) with the first still on the sixth page, the other stills follow on the freed page; sequential:
8.4 + 6.3 + 4.9 + 4.5 s of masters (6 pages each), then 4 × ~2.5 s of stills — mostly start-up (browser launches,
page creation, bundle load, stitching, remux, checks), which parallel bakes overlap. The sequential mode is the
`main` behaviour (its numbers differ by the load only). Under heavier load the equivalence test measured sequential
48–70 s vs parallel 25–35 s (load 24–60).
Shared vs own browsers: equal within the noise (median 14.0 vs 15.8 s, less spread when shared), and 1 browser launch
instead of 16 (every bake launched one for `selectComposition` and one for the render): **shared** is the default.
Earlier variants measured on the same document (load 20–45, noisier): masters wanting ⌈frames / 30⌉ pages (the third
master started with 1 page, the fourth waited) 25–44 s; ⌈frames / 15⌉ (masters nearly one after the other) 27–40 s;
⌈frames / 60⌉ 16–50 s; sequential 40–105 s in the same rounds — the proportional split keeps every master running
from the start. (A pitfall found while
measuring: titles whose text overflows its box are re-rendered full frame by the crop safety net, doubling their
bake; the measured document kept the texts within their boxes.)

**Equivalence** (`layer-bake-parallel.e2e.test.ts`, REMOTION_E2E): the same document baked sequentially and
in parallel on a cold cache produces native composites that decode to identical pixels. The same file checks
that cancelling the export cancels every bake in flight.
Unit tests: `page-pool.test.ts` (budget split, order and backfill, bounded renders in flight, sequential mode,
progress, failure and abort), `layer-bake.test.ts` "parallel bakes" (stubbed renders: Σ pages ≤ budget, one shared
browser closed at the end, stage text, cache hits launch nothing, sequential mode, failure cancels the rest, abort,
cross-parent join and owner cancellation), `mg-bundles.test.ts` "ensureMasters" (distinct keys, budget, abort).

Verification (2026-10-01, load average 9–30 on 12 cores): `pnpm lint`, `pnpm typecheck`, `pnpm e2e:typecheck` ok;
`page-pool.test.ts` 7/7, `layer-bake.test.ts` 31/31, `mg-bundles.test.ts` 15/15 (`MG_E2E=1`: 21/21, real pre-renders
through the pool); `REMOTION_E2E=1 layer-bake.e2e.test.ts` 8/8 (113 s, was 134 s), `layer-bake-parallel.e2e.test.ts`
3/3; `pnpm test` 1650 passed, 45 skipped, 1 failed — `mg-bundles.test.ts` "converts zod 3 schemas…" at its 5 s default
timeout (load 30), passes alone (15/15); Playwright `e2e/layer-bake.spec.ts` (built engine + web, `E2E_SKIP_BUILD=0`) 3/3 (2.1 min).

## Known gaps

- The web preview identity does not include font file contents (font files do not change during a session).
- `pnpm lint` runs `biome check .`, which checks 0 files inside `.claude/worktrees` (ignored by `biome.json` on this base; fixed on `main`); lint was run with explicit paths (`biome check apps packages scripts e2e …`): clean.
- Remotion's `OffthreadVideo` YUV range handling also applies to mg masters on the Remotion path (`MGC-033`); not measured here.
- With only the contracts, shapes are grey placeholder boxes and anime templates placeholder cards; the tests bake those.

## Integration checks after text-anim, anime-templates and shapes are merged

1. With real anime templates installed: `renderVersion` is non-null in the key material of a template bake; bumping it re-bakes.
2. `REMOTION_E2E=1 … layer-bake.e2e.test.ts` and the S11 §11 test 2/3/5 specs: animated titles (e.g. slide-up by word, `order: 'random'`), `title-reveal@1`, real shapes plan `hybrid`; parity vs stills ≤ 3/255 on 99 %.
3. Two identical titles with `order: 'random'` bake separately (key includes the clip id); with `forward` they share.
4. Planner/service merge with anime-templates: they add `TEMPLATE_NOT_INSTALLED` (409) for unknown templates, a native blocker for unclaimed anime clips and the `collectMgMasters` skip. This branch already has the last two (`isAnimeTemplate` early return in `nativeBlockers`, the filter in `collectMgMasters`) and keeps anime clips out of the fframes check and fframes `graphicsGroups`: on merge keep one of each (no duplicate blocker text), and keep the unknown-template refusal ahead of the claimed-layer early return so it also stops `hybrid` plans.
5. Styled `runs` with other fonts: the snapshot collects their faces; the bake document and the key include them (`clipFonts`: the faces of the style and of every styled run; review fix 5).
6. Effects on anime templates (FIX-001 through `LayerBox`) and Lumetri on a template/shape: graded preview + native + Remotion as in the e2e grade test.
7. FIX-003 per-face font readiness: bakes still wait through `delayRender`.
