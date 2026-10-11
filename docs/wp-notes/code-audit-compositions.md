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
| Internal types | Effect, media, typography, animation, and worklet code repeatedly discarded types already present in project/DOM/library declarations. | Use the existing resolved-effect fields, media handles, text animator/path types, `Animatable<number>`, `GlslChunk`, shape blend type, and meter reading contract. Media parameter lookup uses the shared `mediaParamId` reader from the registry audit. Remove redundant `never` casts. The sandbox port exposes only the message data it consumes, typed as untrusted. |
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
when a rendering capability is unavailable. GPU shader text, effect ordering, timeline timing, and
project persistence/schema are unchanged.

The source-dimension helper now handles every native `CanvasImageSource` variant in one place, including
SVG animated dimensions. The Lottie source loader rejects malformed JSON using the same limits and
error code as project import. Its thumbnail path no longer reports an empty or incomplete SVG as success.

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
- No new visual assets, dependencies, migrations or altered golden images are part of this change.

Focused commands:

```sh
pnpm exec vitest run packages/compositions/test/lottie-assets.test.ts packages/compositions/test/imports-layers.test.tsx packages/compositions/test/mg-host-remote.test.ts packages/compositions/test/compositor.test.tsx packages/compositions/test/fx-plan.test.ts packages/compositions/test/fx-layers.test.tsx packages/compositions/test/audio-fx-preview.test.ts packages/compositions/test/color.test.tsx packages/compositions/test/color-mgmt.test.tsx packages/compositions/test/compositions.test.tsx --maxWorkers=1
pnpm exec vitest run packages/compositions/test/audio-fx-preview.test.ts packages/compositions/test/capture-safe-canvas.test.ts packages/compositions/test/serial-audio-context.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
```
