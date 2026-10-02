# Composition test cleanup audit

Pre-edit inventory: 11 files under `packages/compositions/test`, 3,041 test lines. Validation: `pnpm --filter @jasper/compositions test`, `pnpm --filter @jasper/compositions typecheck`, then root `pnpm lint`, `pnpm typecheck`, `pnpm test` (root agent runs global gates).

Independent owners: `docs/specs/11-animation.md`, `docs/wp-notes/wp-m2-anime-core.md`, `docs/wp-notes/wp-m2-shapes.md`, `docs/wp-notes/wp-m2-layer-bake.md`, `docs/wp-notes/wp-m2-anime-templates.md`, `README.md` sections on colour, animation and layer bake. Stronger coverage: `apps/engine/test/shapes-remotion.e2e.test.ts`, `e2e/shapes.spec.ts`, `e2e/color.spec.ts`, `packages/motion/test/determinism-render.e2e.test.ts`, and engine layer bake e2e. These check rendered pixels or user workflows, while many composition DOM tests check implementation structure.

Initial risks to preserve: font readiness can hang or paint with fallback; baked layers can receive opacity twice; transitions can show incorrect frames or gain; render browser tabs can yield black first frames; CPU LUT can disagree with project reference. Stable seams are the rendered composition, Remotion metadata callback, documented package exports, and render-host adapter. Internal helper identities, exact markup and class/tree shape have no independent contract.

Disposition inventory and post-edit validation follow below.

## Every original test

`REWRITE` means the named test survives with narrower setup/assertions under the same file, sometimes under a clearer name. A parameterized test row covers all of its generated cases. All `DELETE` rows have the same package validation command: `pnpm --filter @jasper/compositions test`; the final lint/typecheck commands are below.

| Original test path and name | Decision | Failure/remaining owner or retained contract |
| --- | --- | --- |
| `packages/compositions/test/anime-contracts.test.tsx` — frame-dependent kinds, animated text and keyframed shapes | DELETE | private memo/font/dispatch inventory; stronger font layer and rendered shape/anime checks |
| `packages/compositions/test/anime-contracts.test.tsx` — layerViewEqual re-renders animated text per frame | DELETE | private memo/font/dispatch inventory; stronger font layer and rendered shape/anime checks |
| `packages/compositions/test/anime-contracts.test.tsx` — useFontsReady: true without a provider, the provider value otherwise | DELETE | private memo/font/dispatch inventory; stronger font layer and rendered shape/anime checks |
| `packages/compositions/test/anime-contracts.test.tsx` — useDocumentFonts reports when the document faces have settled | DELETE | private memo/font/dispatch inventory; stronger font layer and rendered shape/anime checks |
| `packages/compositions/test/anime-contracts.test.tsx` — shapes draw a grey intrinsic box through LayerBox; anime templates draw their implementation | DELETE | private memo/font/dispatch inventory; stronger font layer and rendered shape/anime checks |

| `packages/compositions/test/anime-template-layer.test.tsx` — effects, corner pin and every blend mode (incl. add) apply to anime and fframes templates | DELETE | CSS/HTML tree or timing equality tied to the template implementation; browser render parity is stronger |
| `packages/compositions/test/anime-template-layer.test.tsx` — anime templates clip to their canvas = the layer box, like the hybrid crop (review fix) | DELETE | CSS/HTML tree or timing equality tied to the template implementation; browser render parity is stronger |
| `packages/compositions/test/anime-template-layer.test.tsx` — keeps the fframes twin markup identical and its badge in preview only | DELETE | markup/gallery probe; e2e/anime-templates.spec.ts owns visible preview |
| `packages/compositions/test/anime-template-layer.test.tsx` — evaluates keyframes of colour params per frame with the shared evaluator | DELETE | duplicate of e2e/anime-templates.spec.ts colour-keyframe workflow with independent endpoints |
| `packages/compositions/test/anime-template-layer.test.tsx` — the intro and the outro are identical when the clip is stretched | DELETE | CSS/HTML tree or timing equality tied to the template implementation; browser render parity is stronger |
| `packages/compositions/test/anime-template-layer.test.tsx` — draws nothing before the document fonts have settled (S11:FIX-003) | DELETE | CSS/HTML tree or timing equality tied to the template implementation; browser render parity is stronger |
| `packages/compositions/test/anime-template-layer.test.tsx` — draws the "not installed" card for unknown templates, whatever their stamp (S11:ATP-010) | REWRITE | [Missing template](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/anime-template-layer.test.tsx` — draws anime and fframes templates alone on the canvas | DELETE | CSS/HTML tree or timing equality tied to the template implementation; browser render parity is stronger |

| `packages/compositions/test/audio-layer.test.ts` — evaluates the fades at the real sequence frame, also inside the handles | DELETE | private gain helper and formula derived from audioFadeGain; engine audio-crossfade render owns audible output |
| `packages/compositions/test/audio-layer.test.ts` — keeps the powers summing to 1 across the span | DELETE | private gain helper and formula derived from audioFadeGain; engine audio-crossfade render owns audible output |
| `packages/compositions/test/audio-layer.test.ts` — applies the clip levels in the handles (from the nearest clip frame) | DELETE | private gain helper and formula derived from audioFadeGain; engine audio-crossfade render owns audible output |

| `packages/compositions/test/baked-layer.test.tsx` — layers without colour effects keep their own component | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |
| `packages/compositions/test/baked-layer.test.tsx` — a graded title shows ungraded with "Grade pending" until its graded preview exists, then plays it | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |
| `packages/compositions/test/baked-layer.test.tsx` — the before/after bypass shows the ungraded layer without a chip | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |
| `packages/compositions/test/baked-layer.test.tsx` — renders play the graded master the engine injected, in its region, instead of the DOM layer | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |
| `packages/compositions/test/baked-layer.test.tsx` — the ungraded layer (grade pending) applies its opacity and the fade itself | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |
| `packages/compositions/test/baked-layer.test.tsx` — the graded preview carries opacity and fades in its pixels: no CSS opacity on top | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |
| `packages/compositions/test/baked-layer.test.tsx` — the injected graded master carries them too: no CSS opacity on top | DELETE | helper identity or baked DOM/opacity probe; engine layer-bake.e2e.test.ts owns rendered pixel and fade-once parity |

| `packages/compositions/test/color.test.tsx` — ungraded layers keep every effect as a CSS stage | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — consecutive colour effects fuse into one LUT pass like the engine (effectRuns) | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — a CSS-filter effect before a grade becomes a canvas pass in stack order | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — an effect without a canvas realization before a grade is reported as reordered | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — without WebGL2 the M1 colour effects fall back to CSS and Lumetri is dropped (chip) | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — before/after bypass drops every colour effect (CGU-005) | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — disabled colour effects are ignored | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — lists referenced LUT media | DELETE | internal colour-plan descriptor inspection; e2e/color.spec.ts owns rendered grade pixels |
| `packages/compositions/test/color.test.tsx` — fetches and parses a LUT once per URL (signature ignored) | REWRITE | [LUT cache](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/color.test.tsx` — a failing LUT resolves null (the grade skips it) | REWRITE | [LUT failure](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/color.test.tsx` — bakes once per run key and keeps an LRU of 64 per layer | DELETE | cache object identity/capacity probe, no independently visible output failure |
| `packages/compositions/test/color.test.tsx` — context loss flips the stage status and restores it (CG-045) | DELETE | internal status counter probe, no rendered recovery assertion |
| `packages/compositions/test/color.test.tsx` — equals applyLut of the same table (rounded) on every 8-bit input sampled | REWRITE | [CPU parity](#retained-contracts-and-six-bar-review) |

| `packages/compositions/test/compositions.test.tsx` — computes fps, size and duration from the document | REWRITE | [Sequence metadata](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/compositions.test.tsx` — computes asset metadata for the Source monitor | REWRITE | [Asset metadata](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/compositions.test.tsx` — dispatches layers by kind with offline and unsupported fallbacks | DELETE | component identity inventory; retained offline card and rendered workflows own fallbacks |
| `packages/compositions/test/compositions.test.tsx` — renders the Media Offline card for offline media | REWRITE | [Offline card](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/compositions.test.tsx` — stacks tracks bottom → top and positions layers with the @jasper/project matrix | DELETE | private CSS wrapper/matrix/stage tree or expected values copied from project helper; rendered workflows own behavior |
| `packages/compositions/test/compositions.test.tsx` — orders crop first, then enabled known effects, bypassing unknown ones | DELETE | private CSS wrapper/matrix/stage tree or expected values copied from project helper; rendered workflows own behavior |
| `packages/compositions/test/compositions.test.tsx` — renders crop innermost and the transform/opacity/blend outermost | DELETE | private CSS wrapper/matrix/stage tree or expected values copied from project helper; rendered workflows own behavior |
| `packages/compositions/test/compositions.test.tsx` — keeps static layer props identical across frames and memoizes frame-independent layers | DELETE | referential identity/performance implementation probe, no visible failure |
| `packages/compositions/test/compositions.test.tsx` — builds the text block style: fill, outside stroke, box mode, caps | DELETE | CSS declaration inventory; text animation and browser title render own output |
| `packages/compositions/test/compositions.test.tsx` — draws both clips of a cross dissolve through the span, with complementary ramps | DELETE | CSS opacity/matte tree assertion duplicates rendered Program mix and exported Dip pixel checks in `e2e/transitions.spec.ts` |
| `packages/compositions/test/compositions.test.tsx` — draws a black matte under a dip to black and fades each clip on its own frames | DELETE | CSS opacity/matte tree assertion duplicates rendered Program mix and exported Dip pixel checks in `e2e/transitions.spec.ts` |
| `packages/compositions/test/compositions.test.tsx` — starts the video of an incoming clip inside its head handle | DELETE | private frame-conversion helper shape; retained transition and media-routing seams cover caller output |
| `packages/compositions/test/compositions.test.tsx` — converts sourceIn to trimBefore frames without speed scaling | DELETE | private frame-conversion helper shape; retained transition and media-routing seams cover caller output |
| `packages/compositions/test/compositions.test.tsx` — plays the proxy of an original the browser cannot decode, and renders it off-thread | KEEP | [Media routing](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/compositions.test.tsx` — maps the volume-callback frame to the clip-local frame | DELETE | private gain/frame helper; engine audio-crossfade render owns audible behavior |
| `packages/compositions/test/compositions.test.tsx` — evaluates gainDb + volumeDb keyframes + track + master volume | DELETE | private gain/frame helper; engine audio-crossfade render owns audible behavior |
| `packages/compositions/test/compositions.test.tsx` — keeps identity of unchanged clips across snapshot rebuilds | DELETE | referential identity/performance implementation probe, no visible failure |

| `packages/compositions/test/fonts-ready.test.tsx` — a text layer is not mounted (no fallback-font paint, no measuring) until its face loads | KEEP | [Font layer](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/fonts-ready.test.tsx` — a face that fails to load counts as settled: the text renders with the fallback stack | KEEP | [Font layer](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/fonts-ready.test.tsx` — faces already loaded on the page never hide the layer again (no blink on a new document) | KEEP | [Font layer](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/fonts-ready.test.tsx` — tracks family / weight / style separately and holds one handle until every face settled | KEEP | [Font lifecycle](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/fonts-ready.test.tsx` — unmounting while faces load releases the handle (no stuck render) | KEEP | [Font lifecycle](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/fonts-ready.test.tsx` — useFontsReady accepts family names and face queries | DELETE | provider stub returns the arranged readiness value; font-layer and lifecycle tests own observable waiting |
| `packages/compositions/test/fonts-ready.test.tsx` — text: the face of the style and of each styled run (as TextLayer resolves it) | KEEP | [Font selection](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/fonts-ready.test.tsx` — anime templates: the document fonts their params name; other layers: none | KEEP | [Font selection](#retained-contracts-and-six-bar-review) |

| `packages/compositions/test/motion-graphic-layer.test.tsx` — injects the TS twin SVG for the clip-local frame, sized to the template canvas | DELETE | SVG markup/badge copy inspection; gallery and template browser workflow owns preview |
| `packages/compositions/test/motion-graphic-layer.test.tsx` — shows the render-state badge only in preview | DELETE | SVG markup/badge copy inspection; gallery and template browser workflow owns preview |
| `packages/compositions/test/motion-graphic-layer.test.tsx` — draws a labeled placeholder for unknown templates | DELETE | duplicate missing-template card owned by anime-template-layer.test.tsx |

| `packages/compositions/test/repaint.test.tsx` — forces a layout with display: none, then restores the inline display exactly (${label}) | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |
| `packages/compositions/test/repaint.test.tsx` — every rendered frame; in the Player only while paused | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |
| `packages/compositions/test/repaint.test.tsx` — ${mode}: repaints once per frame change and keeps the root's inline display | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |
| `packages/compositions/test/repaint.test.tsx` — runs after the layers’ layout effects of the same commit | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |
| `packages/compositions/test/repaint.test.tsx` — never repaints during Player playback | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |
| `packages/compositions/test/repaint.test.tsx` — repaints its root on every frame and keeps the root’s display (AbsoluteFill: flex) | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |
| `packages/compositions/test/repaint.test.tsx` — opens every page of a Remotion browser in its own window, other CDP calls untouched | DELETE | mock CDP call-shape assertion duplicates real Chrome first-frame parity in `packages/motion/test/determinism-render.e2e.test.ts` |
| `packages/compositions/test/repaint.test.tsx` — changes nothing without the CDP connection it relies on | DELETE | mocked layout/effect-order implementation probe; motion determinism-render.e2e.test.ts owns pixel parity |

| `packages/compositions/test/shape-layer.test.tsx` — draws a rectangle path from makeRect, centred in the layer box, with the fill colour | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |
| `packages/compositions/test/shape-layer.test.tsx` — draws an ellipse from makeEllipse; the corner radius is clamped to half the shorter side | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |
| `packages/compositions/test/shape-layer.test.tsx` — re-centres makeEllipse's arc (centre (rx + 0.5, ry·√(1 − (0.5/rx)²))) on the box centre | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |
| `packages/compositions/test/shape-layer.test.tsx` — stroke %s: stroke-width %d, geometry offset %s | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |
| `packages/compositions/test/shape-layer.test.tsx` — evaluates keyframed size and colour at the content time (frame-dependent layer) | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |
| `packages/compositions/test/shape-layer.test.tsx` — draws nothing for a zero size, no fill path for "None", no stroke path for width 0 | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |
| `packages/compositions/test/shape-layer.test.tsx` — gives every layer its own clip/mask ids | DELETE | SVG path/geometry/ID assertion; engine analytic pixel test and e2e/shapes.spec.ts own shape output |

| `packages/compositions/test/text-animation.test.tsx` — outside the windows the DOM equals the same text without animation | DELETE | outerHTML equality is a change detector; `e2e/text-animation.spec.ts` observes Program output at the rest frame |
| `packages/compositions/test/text-animation.test.tsx` — a 1-frame clip with In and Out shows the rest state (S11:TXA-004: one frame stays at rest) | REWRITE | [Text rest](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/text-animation.test.tsx` — unknown presets render at rest | REWRITE | [Text rest](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/text-animation.test.tsx` — FIX-003: before the faces are ready the text layer is not mounted, so it is never split or measured | DELETE | duplicate fonts-ready.test.tsx rendered layer gate |
| `packages/compositions/test/text-animation.test.tsx` — hides the unmeasured flow inside a window and measures once the block gets a layout | DELETE | ResizeObserver stub and measurement state; `e2e/text-animation.spec.ts` now compares Program pixels before/after Export hides the editor and saves `program-after-export.png` |
| `packages/compositions/test/text-animation.test.tsx` — splits the text into word units over a hidden copy of the same flow, styled from the seeked values | DELETE | markup/measurement/caret-mask structure or self-comparison; text and motion browser workflows own visible animation |
| `packages/compositions/test/text-animation.test.tsx` — plays Out mirrored to the clip end and clamps in transition handles | DELETE | markup/measurement/caret-mask structure or self-comparison; text and motion browser workflows own visible animation |
| `packages/compositions/test/text-animation.test.tsx` — char units fall back to words for RTL text; caps apply before segmentation | KEEP | [RTL text](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/text-animation.test.tsx` — direction 'auto': overlay pieces keep the base direction of their paragraph (unicode-bidi: plaintext) | DELETE | DOM/CSS direction assertion; `e2e/text-animation.spec.ts` now owns browser RTL punctuation/caret regression |
| `packages/compositions/test/text-animation.test.tsx` — line units animate whole lines (grouped by layout boxes) | DELETE | markup/measurement/caret-mask structure or self-comparison; text and motion browser workflows own visible animation |
| `packages/compositions/test/text-animation.test.tsx` — mask-reveal draws one clipping mask per line; typewriter draws a caret | DELETE | markup/measurement/caret-mask structure or self-comparison; text and motion browser workflows own visible animation |
| `packages/compositions/test/text-animation.test.tsx` — typewriter@2 caret blinks as a function of the frame: solid while typing, blinking when idle, never at rest | REWRITE | [Typewriter](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/text-animation.test.tsx` — typewriter@2 caret in RTL: before the shown word while lit, dark during the idle gap between words | DELETE | happy-dom pixel-coordinate assertion fails geometry bar; RTL paragraph rendering remains covered at stable text seam |
| `packages/compositions/test/text-animation.test.tsx` — styled runs keep their style per unit (units cut at run boundaries) | KEEP | [Styled animation](#retained-contracts-and-six-bar-review) |
| `packages/compositions/test/text-animation.test.tsx` — any frame visit order renders what a fresh mount renders | DELETE | outerHTML determinism snapshot; motion determinism-render.e2e.test.ts owns rendered frame parity |
| `packages/compositions/test/text-animation.test.tsx` — cuts the text at run boundaries (later runs win) and maps run fields to CSS | DELETE | markup/measurement/caret-mask structure or self-comparison; text and motion browser workflows own visible animation |
| `packages/compositions/test/text-animation.test.tsx` — builds a one-clip document per preset and side | DELETE | preview helper/canvas dimensions; e2e/text-animation.spec.ts owns gallery workflow |


Totals: 76 DELETE, 10 REWRITE, 10 KEEP across 96 original test definitions; 20 tests remain.
## Retained contracts and six-bar review

Each row covers every original test tagged with that contract above. The six columns answer the six retention questions in order: independent source; recognizable failure; oracle independent of the implementation; public interface or stable seam; behavior-preserving refactor tolerance; lowest owner without duplicate stronger coverage.

| Contract | 1. Source | 2. Failure | 3. Independent oracle | 4. Seam | 5. Refactor tolerance | 6. Ownership |
| --- | --- | --- | --- | --- | --- | --- |
| LUT cache | S06:LUT-003 signed media assets | A re-signed render URL fetches the same LUT again | Two signed URLs identify one imported media asset; expect one fetch | Exported `loadLutAsset` API | Cache container/parser may change | No browser test checks fetch reuse |
| LUT failure | S06:CG-004 malformed LUT fallback | Invalid imported LUT leaves the render waiting | Deliberately invalid CUBE input must settle to null | Exported loader promise | Parser and error handling may change | No stronger malformed-LUT render case |
| CPU parity | S06:CG-043 software renderer | Wrong colour or changed alpha on CPU hosts | `@jasper/project` LUT reference computes expected RGBA independently | Exported `applyLutRgba8` bytes | CPU interpolation implementation may change | Browser parity depends on host choosing CPU; this is the deterministic lowest seam |
| Missing template | S11:ATP-010 installed-template fallback | Unknown template appears blank or crashes instead of explaining absence | Arbitrary absent template version must show a missing state | Rendered `MotionGraphicLayer` text | Card markup and exact sentence may change | No browser workflow opens a missing template |
| Sequence metadata | Remotion composition metadata, ARCHITECTURE §8 | Wrong fps, canvas, duration, or empty-sequence failure | Supplied snapshot's numeric settings and duration | Remotion `calculateSequenceMetadata` callback | Calculation internals and document builder may change | No other test checks fractional fps or empty duration |
| Asset metadata | Source-monitor Remotion composition, ARCHITECTURE §8 | Source monitor uses wrong fps/dimensions/duration | Ten-second 1920×1080 media at 30 fps gives 300 frames | Remotion `calculateAssetMetadata` callback | Asset helper implementation may change | No stronger Source-monitor metadata calculation |
| Offline card | S03:KND-020 offline-media fallback | Missing media has no identifiable clip in Program | Supplied offline clip's name must be visible | Rendered `SequenceComposition` text | DOM wrappers and copy may change | No stronger offline Program render check |
| Media routing | S04:PX-004 browser decode/proxy policy | ProRes previews cannot play or exports lose alpha | Declared `browserDecodable`/`alpha` flags determine proxy or original | Exported `videoSource` media-routing result | Decoder and URL construction may change with same routing result | Engine tests make proxies but do not choose Program playback route |
| Font layer | S11:FIX-003 per-face readiness | Fallback-font flash, blank forever on 404, or blink when revisiting | Controlled `FontFace` promise and visible title | Rendered `SequenceComposition` | Font-loading implementation may change | No stronger test covers all pending/failure/cached states |
| Font lifecycle | S11:FIX-003 render hold | Headless render hangs or releases early while a face loads | Two controlled weights and Remotion handle count before/after settle/unmount | Exported `useFontsReadyState` hook with Remotion handle | Promise store and effect implementation may change | Render E2E lacks strict lifecycle/unmount case |
| Font selection | S11:FIX-003 styled-run/template faces | A styled run or template paints with fallback weight/family | Supplied text styles and template params name distinct faces | Exported `layerFontFaces` API | Lookup implementation may change | Snapshot tests list fonts, but do not select each layer's required face |
| Text rest | S11:ANM-009/TXA-004 short-clip and unknown-preset fallback | A short/unknown animation hides the title | Supplied clip text remains visible without hidden style | Rendered `SequenceComposition` | Animator internals may change | Browser text workflow does not cover one-frame or unknown-preset fallback |
| RTL text | S11:TXA-010 complex-script segmentation | Arabic is split into unstable individual glyph units | Literal Arabic words must remain intact while caps precede Latin segmentation | Rendered title units in `SequenceComposition` | Segmentation algorithm may change | Browser RTL punctuation test does not assert Arabic unit fallback |
| Typewriter | wp-m2-text-anim `typewriter@1/@2` compatibility and blink schedule | Cursor is missing, blinks while typing, or changes old saved projects | Fixed frame schedule from versioned spec, not runtime output | Rendered title caret at chosen frames | Animation engine and scheduling internals may change | Motion value tests do not prove the layer draws the cursor |
| Styled animation | TXA-010 styled runs in animated text | Emphasis or colour disappears when a word is split | Literal run applies red/bold to first two letters only | Rendered text spans at animation frame | Segmentation internals may change | Browser animation parity does not assert styled-run appearance |

## Production support removed

- Removed the LUT asset reset hook, layer-bake cache reset hook, and colour-status reset method. They had no non-test callers. The cache and status remain operational.
- Made `ellipseOffset` and `audioLayerGain` private to their layer modules. Their only non-test callers are `ShapeGraphic` and `AudioLayer` in the same files.
- Removed package barrel exports for colour-plan descriptors, cache internals, status internals, shape/memo helpers, text-style helpers, and the preview-document helper. They had no non-test imports outside their implementation modules; the private workspace package's rendering exports remain.
- Removed unused test fixtures together with their suites. There were no committed snapshots in `packages/compositions/test`.

## Validation and residual risk

- `pnpm --filter @jasper/compositions test`: **20 passed, 5 files**.
- `pnpm --filter @jasper/compositions typecheck`: **passed**.
- `pnpm exec biome check packages/compositions/src packages/compositions/test`: **passed**.
- `git diff --check -- packages/compositions docs/audits/test-cleanup-compositions.md`: **passed**.
- Root lint/typecheck/test/build gates are run by the coordinating agent. External consumers of this private workspace package are not visible to repository search; removed exports had no in-repo production callers. The remaining RTL tests use DOM/CSS as the lowest deterministic composition seam; a renderer-technology migration would need a pixel-level owner.
