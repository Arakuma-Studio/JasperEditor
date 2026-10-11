# Compositions code-quality audit

Scope: `packages/compositions`, including its rendering layers, effect and colour stages, audio worklets,
retiming, sandboxed composition host, package declarations and tests. The audit used `AGENTS.md`,
`CLAUDE.md`, `docs/ARCHITECTURE.md` (rendering boundaries and exact export),
`docs/wp-notes/fx-transition-framework.md`, `docs/wp-notes/imports.md`, the relevant gaps/parity entries,
and the package's existing tests.

## Critical assessment and decisions

| Area | Assessment | Implemented recommendation |
| --- | --- | --- |
| Shared rendering logic | Three independently maintained adapters marked Remotion descriptors as memoized. Canvas-source dimensions were also extracted twice. | One typed `memoizeEffects` adapter and one `sourceSize` implementation serve all consumers. Neither changes effect order, effect parameters, cache keys, or shader algorithms. |
| Layer dependencies | CPU pixel loading imported the `FxPicture` React component, which depended on stage types that in turn imported pixel loading. This was a source-level cycle with a type-only edge, not an observed runtime initialization failure. | Image fetching and cache ownership live in `fx/images.ts`. Components and pixel loading depend on this module. Public exports remain available through the package barrel. |
| Lottie integration | Layers and thumbnails repeated permissive player interfaces and dynamic import adapters. Fetched JSON was asserted to be a record without using the project's existing validator. Thumbnail timeout and missing SVG both looked like success; cleanup could skip destroying the player on failure. | Shared lazy loading uses the installed package's `LottiePlayer` and `AnimationItem` types. Sources use `parseLottie` and `LottieDoc`; embedded images use `lottieImageAssets`. Thumbnail timeout/missing output reject with `LOTTIE_RENDER_FAILED`, and the player/host/listeners are released. Failed document reads remain retryable. |
| PDF integration | Hand-written page/document types erased viewport and render-parameter checks; a cast to `never` hid the imported library shape. | Use `PDFDocumentProxy` and the actual `pdfjs-dist` module type. Load the worker for its existing registration side effect instead of assigning its namespace through an untyped global. |
| Internal types | Effect, media, typography, animation, and worklet code repeatedly discarded types already present in project/DOM/library declarations. | Use the existing resolved-effect fields, media handles, text animator/path types, `Animatable<number>`, `GlslChunk`, shape blend type, and meter reading contract. Media parameter lookup uses the shared `mediaParamId` reader from the registry audit. Remove redundant `never` casts. The sandbox port retains the native `MessageEvent` callback contract, with its payload typed as untrusted; test ports emit actual message events. |
| Shader boundaries | Classic 3D selected the layer-blending portion of a shared shader by searching for a section comment. Removing that comment exposed effect-only uniforms to the 3D compiler. | Export a self-contained `GLSL_LAYER_BLEND` chunk. The effect blend chunk depends on it, and Classic 3D includes it directly without parsing comments. |
| Dead and historical code | An unused matrix multiplication helper and unused image-cache failure field remained. Section dividers and workstream labels added reading cost; browser workaround comments recounted investigations. | Delete the unused code and obvious section labels. Keep concise comments about browser limitations, sequencing, coordinate spaces, cache invariants, and deterministic capture. |
| Error handling and compatibility | Most catches protect genuine browser, media, network, shader, or sandbox boundaries. Several superficially empty catches maintain independent request queues or release resources without hiding the caller's rejected promise. Capability fallbacks are part of the supported preview contract. | Keep these boundaries and documented capability behavior. Remove the thumbnail's false-success fallback rather than allowing failed renders to produce a blank success artifact. |

## Type and dependency research

The installed dependencies are the authority for the adapters:

- Remotion 4.0.499 `dist/cjs/effects/effect-types.d.ts`: `EffectDescriptor`,
  `EffectDefinitionAndStack`, and effect `setup`/`apply` state ownership. Its heterogeneous effect
  descriptors deliberately erase their state to `unknown`; the mask state cache retains that boundary
  instead of inventing a state type.
- lottie-web 5.13.0 `index.d.ts` and `build/player/lottie_svg.d.ts`: SVG player module default export,
  `AnimationItem`, event names, renderer options, and listener removal.
- pdfjs-dist 4.10.38 `types/src/pdf.d.ts`, `types/src/display/api.d.ts`, and the installed worker module:
  the worker itself initializes `globalThis.pdfjsWorker`; the main module reads `WorkerMessageHandler`
  there. No worker implementation was copied into the repository.
- TypeScript's DOM declarations: `CanvasImageSource` discriminates video, image, video-frame,
  canvas/bitmap, and SVG-image dimensions; canvas context options have established browser types.
- Project `render/scene.ts`, `render/snapshot.ts`, `schema/common.ts`, `schema/sequence.ts`,
  `lottie/parse.ts`, and `registry/fx/shader.ts`: resolved parameters, media handles, Lottie validation,
  typography, animation and shader structures already belong to the model package.

`unknown` remains where the type really is open: untrusted sandbox replies before sanitization,
JSON inspection, arbitrary schema-defined motion-graphics parameters, private CDP capability probing,
generic equality/fingerprinting, and Remotion's heterogeneous effect state. `Extract<..., {key: unknown}>`
filters a discriminated source union without weakening the resulting source type. Replacing these with
unvalidated concrete types would conceal uncertainty instead of removing it.

## Safety and fidelity

The image loader's caching, cross-origin settings, retry behavior and render holds are preserved.
Required WebGL/HTML-in-Canvas capability handling, missing-font handling, signed media URL handling,
sandbox isolation, and audio resume/suspend ordering are preserved. Export cancellation remains explicit
when a rendering capability is unavailable. GLSL formulas and constants, effect ordering, timeline timing,
and project persistence/schema are preserved. The integration fixes below correct two shader-generation
regressions introduced during the audit.

The source-dimension helper now handles every native `CanvasImageSource` variant in one place, including
SVG animated dimensions. The Lottie source loader rejects malformed JSON using the same limits and
error code as project import. Its thumbnail path no longer reports an empty or incomplete SVG as success.

## Integration corrections

The full rendering suite exposed two audit regressions:

- Classic 3D's `blendSource()` depended on the literal `// ---- effect blends` separator in
  `GLSL_BLEND`. Removing the apparent section comment made all seven rendering cases compile the
  effect helpers too, producing undeclared `v_uv`, `u_canvasSize`, and `u_seed` errors. Commit
  `207f41c2` (integrated as `54c35224`) replaces this source-text dependency with explicit shader chunks.
  The original chunk had no dependencies; the new layer chunk is self-contained. A measured comparison
  confirmed that concatenating the new layer and effect source segments exactly reproduces all 11,420
  characters of the previous blend source. No formula, constant, tolerance, assertion, or golden changed.
- The initial 971-program software-GL sweep also found malformed Premiere edge-wipe shaders: two
  interpolation expressions in `defineEdgeWipe` had lost their braces during a scalar-reader edit.
  Commit `6ede1994` restores the expressions. The registry's two-case regression checks generated
  distance bodies and border expressions with borders enabled and disabled; both cases failed before
  the repair. See [the registry assessment](code-audit-project-registry.md) for its broader diff review.

A separate callback-variance correction uses `MessageEvent<unknown>` for `MgHostPort.onmessage`,
matching native `MessagePort` callbacks while keeping hostile reply data untrusted. Positive effect,
media, animation, and shader fixtures now use the existing project types instead of fabricated
`never`/`unknown` shapes.

The final GPU-helper type review found result dictionaries and browser globals still declared as
`any`. PSDG and simulation test results now derive from their browser entry APIs via `ReturnType`.
Compile/preview tooling shares producer-checked `Window` declarations, eliminating duplicate reply
interfaces and return casts. Paint/kaleidoscope helpers use `EffectParams` and direct typed browser
calls; this avoids asserting a common signature over methods with different arguments and results.

The comment-only followup covered composition, motion-template, and motion tests. Across all 151
TypeScript/TSX files, the comment-free TypeScript printer output and all 1,331 raw template chunks were
identical before and after; compiler/linter/environment directives were preserved and syntax diagnostics
remained empty. This proof applies to that comment-only commit, before subsequent behavioral/type fixes.

## Validation

- `pnpm exec biome check packages/compositions/src packages/compositions/test/lottie-assets.test.ts`
  and `git diff --check` are the formatting/static checks.
- Added `lottie-assets.test.ts`: shared validated loading, failed-read retry, property-based rejection of
  non-object JSON, successful thumbnail lifecycle, missing output, and stalled-renderer cleanup.
- Initial focused run: 9 of 10 suites passed, 63 of 64 tests passed. The only failure was the existing
  all-audio-effects parity test exceeding the 5-second default timeout under host load (9.8 seconds);
  the rerun with a 120-second timeout passed. All six new Lottie tests passed.
- Follow-up run: 3 suites and 5 tests passed (`audio-fx-preview`, `capture-safe-canvas`, and
  `serial-audio-context`). The latter two exercise the browser shims in real Chromium. Across the two
  runs, all 67 distinct tests in 12 suites passed; one audio test required the larger timeout.
- Adoption of the shared `mediaParamId` helper depends on the registry and project-model audit commits;
  the integrated barrel export and final rendering suites are verified by the integrator.
- A measured relative-import graph scan of 101 source files and 339 edges, including type imports,
  reports zero multi-file strongly connected components. The component/pixel/stage cycle is removed. Package layering remains subject to the repository's integration gate.
- The initial package typecheck was stopped at the integrator's request to relieve shared CPU contention.
  Final serialized typechecking belongs to the integration gate; a cancelled run is not a passing check.
- Classic 3D regression: the unchanged `three-d-gl.test.ts -t flat --maxWorkers=1 --reporter=verbose`
  failed with the missing effect uniforms before `207f41c2`. After the fix, all 8 tests in the full file
  passed in 95.01 seconds: WebGL availability, flat, intersecting, orbit, orthographic, lit, Dissolve,
  and depth-of-field scenes. The existing CPU/GPU pixel comparisons provide the regression coverage.
- The registry reviewer verified the Premiere interpolation repair: `transition-edge-wipe.test.ts`
  and `transition-premiere.test.ts` passed all 14 tests across 2 files. The filtered Iris software-GL
  compile gate passed 1 test (24.36 seconds of testing; 106.08 seconds total).
- Biome and `git diff --check` passed for the shader fix and the comment/type followups. No additional
  package typecheck was run by this reviewer; integration owns the final check.
- The complete, unfiltered software-GL compile sweep passed with `FX_COMPILE_WORKERS=1` and the
  existing budget configuration unchanged: 1 test passed, 1,675.81 seconds of testing and 1,830.52
  seconds total. The current collector produces **983 unique programs**, covering 1,834 pass users,
  including 20 programs with custom vertex shaders and 17 library stress cases. This count was measured
  separately at integration revision `c27afbff` by extracting `collectPrograms`, `defaults`, and
  `LIBRARY_STRESS` unchanged, resolving their current imports, and evaluating with an empty filter;
  the count-only run imported no browser, test runner, or budget calibration. The earlier 971-program
  count predates the Premiere interpolation repair. Successful-test stdout was hidden in the full
  run, so per-program timing details are unavailable; the retained summary is
  `/tmp/jasper-audit-shader-budget-final.log`.
- The final GPU-helper cleanup touched 10 TypeScript files: 7 retain byte-identical emitted JavaScript;
  2 differ only in redundant expression parentheses after type erasure. The remaining file replaces
  dynamic browser dispatch with direct calls. A mocked bridge comparison verified six calls across
  all four used methods, preserving names, arguments, ordering and optional defaults. All 10 files
  parse without diagnostics and have zero explicit `any` AST nodes. Biome and whitespace checks pass;
  no GPU suite or package typecheck was repeated for this followup.
- Final integration exposed a readonly mismatch between the preview CLI's Playwright argument tuple
  and `preview-entry.ts`'s render parameter. The renderer only reads the caller's job array, so its
  parameter now accepts `readonly PreviewJob[]`. Focused semantic checks of the two preview files
  against their actual dependencies reproduced the original TS2345 diagnostic and then reported zero
  diagnostics after the change. The renderer's emitted JavaScript is byte-identical; Biome and
  whitespace checks pass. This followup ran no browser tests or full package typecheck.
- No new visual assets, dependencies, migrations or altered golden images are part of this change.

Validation commands:

```sh
pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts packages/compositions/test/imports-layers.test.tsx packages/compositions/test/mg-host-remote.test.ts packages/compositions/test/compositor.test.tsx packages/compositions/test/fx-plan.test.ts packages/compositions/test/fx-layers.test.tsx packages/compositions/test/audio-fx-preview.test.ts packages/compositions/test/color.test.tsx packages/compositions/test/color-mgmt.test.tsx packages/compositions/test/compositions.test.tsx --maxWorkers=1
pnpm exec vitest run packages/compositions/test/audio-fx-preview.test.ts packages/compositions/test/capture-safe-canvas.test.ts packages/compositions/test/serial-audio-context.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
pnpm exec vitest run packages/compositions/test/three-d-gl.test.ts --maxWorkers=1 --reporter=verbose
pnpm exec vitest run packages/project/test/transition-edge-wipe.test.ts packages/project/test/transition-premiere.test.ts --maxWorkers=1
FX_COMPILE_FILTER=jasper.iris FX_COMPILE_WORKERS=1 pnpm exec vitest run packages/compositions/test/fx-compile-budget.test.ts --maxWorkers=1
FX_COMPILE_FILTER='' FX_COMPILE_WORKERS=1 pnpm exec vitest run packages/compositions/test/fx-compile-budget.test.ts --maxWorkers=1
```
