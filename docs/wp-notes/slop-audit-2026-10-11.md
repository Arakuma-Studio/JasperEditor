# Codebase simplification audit — 11 October 2026

This continues the [previous audit](../slop-audit.md), starting from `12049d8e` after the parity-program merge.
Fifteen scope owners reviewed the application, packages, native renderer, scripts and tests; independent reviewers
checked model/web and shared/native/rendering diffs and test quality. The changes remove unused code, duplicate work and unnecessary wrappers.
Malformed-input defects discovered during the review receive explicit behavior fixes and regression tests.

During verification, `origin/main` advanced from `12049d8e` to `e60dc734` (146 commits, 1,886 changed files).
Scope owners and independent reviewers audited that incoming work, resolved overlapping changes and preserved its
safety improvements. Merge `b3d3b467` integrates both histories; subsequent fixes address demonstrated boundary
failures and weak properties. The pre-merge results remain separately labeled below. Merged verification is complete, with timing failures and their isolated follow-ups reported explicitly below.

## Method and limits

Removal decisions combine repository-wide references, package entrypoints, dynamic registration and caller/body
inspection. Declaration-only searches were followed by checks for namespace imports, serialized worker functions,
shader generation and published contracts. Private package exports can still have undocumented external consumers;
none were found in the repository. A low reference count alone does not establish that a helper is unused.

The ledger groups related edits and records their rationale, residual risk and evidence. “Retained coverage” names
existing checks, not an execution result by itself. Scope checks are partial; merged execution results and limits appear below.
This is structural review and targeted verification, not proof that every line is correct or every simplification found.

## Demonstrated malformed-input defects

| Change | Evidence, risk and retained safeguards |
| --- | --- |
| MCP PNG decoder bounds | Before the fix, a 1,096-byte PNG declaring 1×1 RGBA inflated to 1,048,576 bytes and was accepted, although the declared scanline needs five bytes. All three new regression/property tests failed before the fix. Limit dimensions to 64×1024×1024 pixels and inflation to declared scanline bytes; return actionable `E_LIMIT` / `E_INVALID_PARAM` errors. This intentionally rejects oversized/malformed inputs; normal images, sim-warp's decode fallback and MCP error conversion remain. The focused post-fix run passed all three PNG cases. |
| API event schema lookup | `parseEvent` looked up inherited Object members as schemas. The new property test failed before the fix on `["constructor", null]` with `schema.safeParse is not a function` (seed 24301, path `1:0`). Own-key membership now makes unknown event names return null as already specified. Known event payload validation remains unchanged. The property covers inherited/unknown names and arbitrary JSON; the focused post-fix run passed all three API cases. |

## Project model and commands

The core cleanup removes 55 unused exported runtime declarations and one newly orphaned private helper. Each
exported name occurred only at its definition in source/docs scans and a second exact-word repository search.
Bodies had no registration side effects; explicit i18n/benchmark namespace consumers do not use these names.
The main risk is an unknown consumer of a private-package export, addressed by workspace typechecking and build.
Independent review repeated the reference checks and read all changed core diffs.

Paths below are relative to `packages/project/src`; grouped paths share the listed directory.

| Area | Removed declarations |
| --- | --- |
| `audio/strip.ts`; `blend-modes.ts` | `MAX_INSERTS`, `sequenceSampleRate`, `stripTrack`; `HARD_MIX_THRESHOLD` |
| `captions/model.ts`, `words.ts` | `DEFAULT_CAPTION_SECONDS`, `TITLE_SAFE_MARGIN`, `joinWords` |
| `color/cms/{matrix,spaces,transfer,transform}.ts` | `toColumnMajor3`, `COLOR_SPACE_IDS`, `nitsFromPq`, `isLogCurve`, `workingLinearCurve` |
| `color/{looks,model,scopes}.ts` | `CREATIVE_LOOK_IDS`, `isPlainRec709`, `hlsPoint`; its private-only `hueSat` callee |
| `color/ocio/{cdl,config}.ts` | `IDENTITY_CDL`, `xyzD65ToGamut` |
| `effect-presets/schema.ts`; `expressions.ts` | `EffectPresetLibrarySchema`, `EffectPresetBundleSchema`; `expressionSupportInstalled` |
| `interpret/model.ts`; `lottie/export.ts`; `multicam/model.ts` | `fileSecondsOf`; `LOTTIE_BLEND_MODES`; `angleOfVideoTrack`, `angleOfAudioTrack` |
| `path/model.ts`; `render/previews.ts` | `isCornerVertex`, `cubicDerivative`, `pathControlBounds`; `videoSegmentHash` |
| `roto/index.ts`; `schema/sequence.ts`; `structure/nest.ts` | `ROTO_OBJECT_CONTROL`, `FACE_DEFAULT_MODEL`, `rotoHasPrompt`; `isVectorShape`; `nestedFrameOfContent` |
| `text-animators/{evaluate,place,selectors}.ts` | `isIdentityCharXf`, `isKnownSelectorKind`, `identity4`, `DEFAULT_RANGE` |
| `three-d/math.ts`, `scene.ts` | `mat4Transpose`, `mat4FromAffine3`, `cameraDepth`, `pixelRay`, `planeNormal`, `invertWorld`, `layerCentre3D` |
| `three-d/tools.ts` | `isOrthoView`, `viewCamState`, `rigOfView`, `rigForward` |
| `time-remap/{model,ops,sampling}.ts` | `MIN_REMAP_SPEED`, `REVERSE_SEGMENT_SPEED`, `holdFrom`, `cfrFrameCount` |
| `vector/{boolean,geom,values}.ts` | `normalizeFill`, `emptyPath`, `emptyBezierPath` |

Active preset validation still uses `parsePresetFile`, `parseEffectPreset` and `EffectPresetFolderSchema`.
No shipped migration, project schema, repair rule, rendering algorithm or hostile-input guard changes here.

| Additional change | Why, risk and evidence |
| --- | --- |
| Core boolean and test cleanup | Replace a boolean `condition ? true : false` with the already-boolean condition. Delete the unrelated `FLICKS_PER_SECOND > 0` assertion from time-remap tests; concrete frame/weight assertions and time conversion tests remain. Expression-only/test-only risk; direct comparison establishes equivalence. |
| Preview cache test correction | The assertion claiming picture hashes ignore audio compared the same post-edit document twice. Capture hashes before the volume edit and compare afterward. No production change; this now detects audio edits incorrectly invalidating video previews. Existing audio-segment assertions remain. |
| Retired command stub machinery | Delete uncalled `notImplemented`, `isNotImplementedHandler` and their never-populated WeakSet plus its self-test. Keep every published command's `implemented: true` value, error-code vocabulary and schemas; `buildCatalog` still rejects missing handlers. Searches and independent review found no stub callers. |
| Dead command helpers | Delete `maskPropLabel`, `clipContentSpan`, `isAxisTag` and unused imports. Claimed test/MCP consumers do not exist; handler modules are not exported package entrypoints. Low risk; actual mask/time/text-animator commands and coverage remain. |
| Default font and bin removal | Captions reuse the byte-identical `clip-core.ensureDefaultFont`; multicam reuses `project.detachItem`, whose root/bin splice order is equivalent. Both module dependencies already existed. Low risk; ID allocation, first-match removal and mutation order remain; caption/text/multicam/project tests cover them. |
| Caption fixture test | Delete `videoAsset helper exists` and its sole import. It only asserted that a fixture factory returns a truthy object, exercising no caption behavior. Real command, repair and fuzz coverage remains. |

## Effect and transition registry

| Change | Why, risk and evidence |
| --- | --- |
| Unused registry APIs | Remove `warpPlanAt`, `seedOf`, `SimCache.clear`, `AUDIO_EFFECT_PREFIX`, `lumetriSpatialActiveAt`, `colorOutputFn`, `isAudioKind`. Reference searches found no callers; simulation instances use `run`, and active rendering uses the original planners/conversions. Low risk; registered effects, IDs, parameters, caches and clip/track capability checks remain. |
| Identity wrappers | Replace `controlOf(def.ui)` with `def.ui`; use `uniformDeclaration` directly instead of a second alias at three calls. Same values/function references; shader formulas and generated declarations are unchanged. |
| Repeated family validation | Remove duplicate validator calls from 11 effect and two transition family suites. Exhaustive `FX_FAMILIES` / `TRANSITION_FAMILIES` loops validate the same registered arrays. No test case removed; exact membership, defaults, malformed-spec, planner, numerical and independent GL tests remain. Independent review checked the catalogue-to-array relationship. |

## Engine and MCP

| Change | Why, risk and evidence |
| --- | --- |
| Camera/roto/speech dead helpers | Remove camera `defaultBaOpts`, `applySim`, `eulerXyz`, `_internal`; roto `EMPTY_GMM`, `luma8`, `DEFAULT_EDGE_OPTS`; uncalled `WhisperTokenizer.isTimestamp`. Make `tokenBytes` and 15 module-only audio/camera/roto/speech declarations private. Whole-repository scans and package-entry review found no external consumers. Low runtime risk; solver, segmentation, decoding and meaningful tests remain. |
| File hashing and audio scaffolding | Speech model checksums reuse existing streaming `sha256File`; both implementations hash complete files to hex and reject read errors. Download-progress hashing remains separate. Replace single-element allocation/destructuring around `frameToSample` with direct assignment. Low risk; checksum/corruption and audio-mix tests retain coverage. |
| PowerShell availability reporting | Move the unchanged diagnostic into `afterAll`, deleting `expect(true).toBe(true)` and its fake passing test. Platform skip visibility, parser/property tests and real hostile-path PowerShell execution remain. Test-only risk; independently identified and checked. |
| Export service/audio planner | Delete uncalled `ExportService.containerOf`; remove `audioOutputOf`'s unused encoder argument and `condition ? null : null` caller expression. Simplify default channels to six for 5.1, two otherwise, preserving explicit settings. Privatize planner-only helpers. Low risk; sample rates, normalization and unsupported-effect errors remain; audio export tests cover behavior. |
| Caption/retime adapters | Call the same `writeCaptionFile(doc, 'vtt')` directly instead of `vttFor`; inline sole-use video-track flattening and reference `retimeClaims` directly. Arguments/order, top-level-only traversal, claims, cache keys and worker ownership are unchanged. Low risk; caption export and frame-by-frame retime suites remain. |
| MCP sequence lookup | Eight tool/loader sites use one `requireSequence` instead of identical lookup/error blocks. Preserve fallback-first selection, code/message/hint and call order. Sites with different error behavior remain separate. Low risk; default-sequence, domain, README/catalog and bundle suites cover the interface. |
| MCP transaction and clip lookup | Five identical transact → requireOk → txBody → jsonResult helpers become `applyCommands`; time-remap lookup uses existing `findClip`. Preserve labels, sequence handling, approvals/progress and results. Custom summaries/errors remain distinct. Low risk; domain command integration tests retained. |
| MCP private scaffolding | Remove unconsumed reporter clock/interval options and `dispose`; retain default clock, 100 ms throttling and finally-driven reporter cleanup. Narrow local exports, remove strict-validation aliases and an unreachable missing-name closure branch in `agentHeaders`. Caller inspection proves unused alternatives; URI encoding, empty-name behavior and cancellation remain. |

## Audio, motion and compositions

| Change | Why, risk and evidence |
| --- | --- |
| Audio numerical forwarding | Replace three biquad forwarding functions with named reexports. Alias identical `dbToGain`/`flush`, reuse `linDb` and periodic `hann`. Executed body comparisons found identical arithmetic. Low module-plumbing risk; worklet-safe layering, parameter sanitization, denormal handling and independent DSP oracles remain. |
| Audio dead APIs | Remove uncalled `hasProcessor`, `fftCurveDb`, `remEuclid`, audio-fx `gainToDb`, `ParamValues.has`, `EffectChain.size`, `DelayLine.maxDelay`, `C.neg`/`C.exp`. Full reference searches found no consumers; live FFT response still uses `curveSorted`/`FftFilter.responseDb`. Private-package import risk requires integration types/build. |
| Remix fixture/dead renderer | Move byte-identical `testMusic` to test support for its two test callers; update ported-code mapping/work-note references. Delete unused `renderRemix`, `planJoints` and their self-test. Actual plan → grouped clips/constant-power transitions → mixer path remains. Preserve beat/target/intro/outro/refusal and actual export tests; regenerate notices. |
| Audio test duplication | Delete a reexported smoother's duplicate test and two weaker coefficient assertions already covered more strictly in audio-dsp. No tolerance weakened; latency, block-size invariance, true-peak, limiter and ffmpeg/DFT/ITU/RBJ oracles remain. |
| Motion local details | Remove unused template barrel exports; privatize local builders/constants/geometry/input types. Sole production consumer uses unchanged `ANIME_TEMPLATE_IMPLS`. Mutate the newly allocated `staggerRanks` array directly instead of cloning it immediately. Low risk; runtime/render determinism coverage remains. |
| Compositions audio graph | Remove uncalled `hasPreviewInsert`, `_mul`, `MixGraph.stripMatrix`. Replace identity `layoutOf` with `layoutFromChannels`; merge private `loadWorklet` into public `mixWorkletReady`. Shared WeakMap/Promise and rejection-to-false semantics remain. Low risk; registration, metering, scheduling and disposal unchanged. |
| Compositions unused aliases | Remove definition-only `useBlendGpu`, `blendHtmlInCanvas`, `layerHasMasks`, `colorAssetLoaded`. Active compositor/mask/asset loading APIs already serve all consumers. Low risk after full reference scans; no executed guard or rendering formula removed. |
| Sandbox literal | Remove `String.raw` from a shim containing neither backslashes nor interpolation; editing-time assertion checked equal literal bytes. Storage failure handling is unchanged; accessible/inaccessible-storage tests remain. |
| Browser bundle setup | Seven test/development launchers reuse existing `bundleForBrowser` instead of copied esbuild setup. Preserve entry paths, IIFE/ES2022/browser settings, production NODE_ENV, cache and SwiftShader flags. Risk is bootstrap/bundling drift; all five distinct entry bundles matched the previous options byte for byte. Pixel assertions and per-test browser cleanup remain. |
| Browser-backed count test | Delete a catalogue-count assertion from the GL suite. The project suite already checks exact IDs/labels, registry/bin wiring and validity. Every per-effect GL execution/pixel test remains. Independent review confirmed the duplicate catalogue coverage. |

## Web runtime and panels

| Change | Why, risk and evidence |
| --- | --- |
| Retired single-scope protocol | Delete unused `createScopeComputer`, legacy maths and its worker-union branch; current ScopesPanel uses only `createScopesComputer`/`kinds`/`ScopesResult`. Collapse the now-single worker factory. Preserve transfer buffers, callback delivery, termination and main-thread fallback. Risk is internal worker/bundle compatibility; current project scope maths and web color-grade/readback tests remain. Six tests solely exercising retired maths were removed. |
| Expression loading | Delete unused `useBoundDocument`, `expressionEngineError` and write-only error state; inline two forwarding hooks/helpers at their only caller. Preserve async rejection handling, pending reset, subscriptions and lazy loading. Low risk; actual binders and expression UI tests remain. |
| Other unused web helpers | Delete `existingVoiceover`, `interpretationSummary`, `isRecordingMulticam`, `vectorItemIds`, `clipContentAt`, `bandEligible`, `currentLanguage`, `catalogSize`. Exact references and registration review found only definitions. Keep live recording, timing, color, vector and i18n paths; types/domain suites verify consumers. |
| One-use web adapters | Inline `envelopeOf` and `toImportLayers` with identical arguments; change identity Promise fulfillment plus rejection handler to `.catch`. Preserve clone behavior, early-request identity/age/consume-once rules and fallback. Low risk; audio/import and early-project-loading tests remain. |
| Desktop menu receiver | Remove preload `onMenuCommand`, web bridge declaration and EditorShell listener together. Repository search found no sender of `jasper:menu-command`; desktop uses the rendered menubar. Update bridge documentation. Low integration risk if both sides land together; real clipboard, controls, keymap and menu dispatch remain. |
| Mixer/transcript plumbing | Delete unused `graphOn` prop and its parent's redundant graph subscription; each ClipStrip still owns its metering subscription. Remove unread session/sequence props from ImportTranscript; same media/apply callback remains. Low risk; audio panel and speech tests unchanged. |
| Panel internals/comments | Delete uncalled `secondsOf` and import; privatize eight other-panel declarations and 35 timeline/monitor declarations after dynamic/lazy-consumer review. Remove dead trim constants and `captionAreaHeight`; preferences and rendered lane height remain authoritative. Inline identical roving command object. Explain the inspector's mixed-value ScrubbyNumber contract instead of promising an obsolete swap. Import/type risk only; gesture, trim, loading and UI coverage retained. |
| Web test cleanup | Replace historical command-existence list with existing exhaustive menus/keymap checks plus every current panel opener. Delete React-only Suspense starvation demonstration; retain Jasper panel loading under the same updates and failure/retry/cache tests. Low test-only risk; independent model/web review checked coverage and subscriptions. |

## Interchange, expressions and shared packages

| Change | Why, risk and evidence |
| --- | --- |
| Interchange dead exports | Remove `build.isAnimated`, `Builder.findMedia`, `findInBins`, `nestedSequences`, `effects.isAudioTransition`, `Report.hasWarnings`, `comp.transitionOpKind`/`transitionFromOp`, unused time constants/conversions/edit-unit aliases. Whole-repository scans found no consumers. Low private-package risk; active format-specific rounding, parser budgets and typed errors remain. |
| Interchange duplicate helpers | Use registry transition lookup directly; replace six binary-format forwarding lambdas with the same functions; reuse `build.anim` in three exporters and `xml.path` for FCP7. Preserve receiver-independent calls, argument order and non-null traversal. Correct Builder.finish's stale comment and remove arithmetic `+ 0`. Format round-trip/hostile tests retain coverage. |
| Expression API/kind mapping | Remove unused `boundStatus`, `canHaveExpression`, world evaluate/isAnimated reexports. Share identical kind switches through typed `propKind`, retaining layer-control handling; remove obsolete casts. Risk is mapping regression; scalar/vector/color/3D/puppet/binding tests remain. |
| Expression value scaffolding | Remove duplicate document/snapshot sequence access, quote wrapper, empty-prefix branches, `Wire = unknown`, array-only `dims`, String-only `jsNumber` and repeated nullish guard. Preserve non-finite/arity/type errors. Move test-only `rewriteForTest` into its sole test; retain cases and expected text. |
| Misnamed OTIO undo test | Delete duplicate round trip that never undid anything; retain its sequence-count assertion in the stronger exact round-trip case. Web interchange still imports, relinks and undoes both. No assertion lost; independent review identified and owner verified it. |
| Shared unused UI/testkit exports | Delete definition-only `LinearProgress` and `fromRgb24`; namespace/dynamic searches found no users. Existing progress displays and RGBA/golden/oracle/fuzz helpers remain. Low private-package import risk. |
| Shared menu/type simplification | Reuse deferred `LazyItems` for Menubar, retaining `() => m.items()` receiver binding and mount timing. Remove unnecessary client/dialog casts with no runtime-value change. Risk is eager resolution/receiver/type mismatch; existing lazy-menu/client/UI tests retain coverage and workspace typechecking passed. |

## Desktop, native and tooling

| Change | Why, risk and evidence |
| --- | --- |
| Shared open-file policy | Desktop reuses config's identical extension predicate, retaining absolute-path/NUL/length guards. Add workspace dependency/importer entry and update security documentation. Differential comparison matched baseline on 921 path/type cases; desktop build bundles config without a runtime package import. Delete copied-array parity test, retain real allow/deny behavior tests. Risk is policy/packaging drift; desktop tests/types/build completed. |
| Native wrapper/dependency | Inline one-use `schema_json` envelope with unchanged `catalog()`, privatize local Rust `char_em` / TS `COUNTER_LIMIT`, remove CLI's unused direct serde edge and lock entry. No new dependency version. Low compile/schema-output risk; changed-file rustfmt, native compilation and enabled parity tests passed. Independent Rust/TS render implementations stay separate. |
| Performance scaffolding | Delete uncalled `checkUiBudgets` (active driver already enforces emitted budgets) and unread profiler Map/void expression. Original/current summaries matched exactly on a nested/idle profile. Remove one discarded read-only E2E sequence query. No budget, scenario, user action or assertion changed. |
| Asset recognizer | Remove redundant Set around fixed extensions and impossible attribution-suffix match. Old/new predicates agreed on 3,252 tracked/extension/case/sidecar paths. License allowlist, provenance/index validation, ignores and generated-media ban remain. Existing asset tests and repository asset checks passed. |
| Script visibility/comments | Privatize unconsumed checker tables, fixture/calibration builders and profiling credentials/mapping helpers; retain all imported/dynamic fixture APIs. Correct document-versus-envelope comment. Risk is missed script import; source/body and entrypoint review plus script/E2E types/build checks address it. |

## Retained safeguards and independent review

No cleanup removes atomic persistence/recovery, leases/approvals, parser budgets, numerical input checks, recursion
or allocation caps, process cancellation, checksums, source provenance or LGPL restrictions. Dynamic command/panel
registrations, worker serialization, WASM ABI, render fallbacks and exported wire contracts were reviewed separately.
Independent mathematical/pixel/native oracles remain independent. The initial cleanup retained FFT/Biquad layouts, worker pools, Rust/TS renderers and inspector/UI controls where
ownership, timing or commit differences mattered. The incoming audit subsequently consolidates the shared FFT and
worker scheduler; its numerical, process-failure and cancellation checks remain.

The independent test scan parsed 594 JS/TS test sources: 4,302 named it/test callback candidates, not a runtime test
count. It screened self-comparisons, short/assertion-free bodies, duplicates and skip/TODO patterns. Five findings
appear above. Seeded determinism, cached-reference checks, shared assertion helpers and opt-in diagnostics remain.
Independent reviews found no blocking regression in twelve owners' final diffs; an orphan comment was fixed.
Neither static review establishes that the full suites pass.

## Historical validation — pre-merge source `4f2104e9`

Scope validation was centralized after concurrent jobs saturated the shared host. Canceled compilers/test runners
are not passes. Committed timeouts, performance thresholds, fuzz properties, pixel tolerances and security assertions
were retained. The initial diagnostic suite used longer generic runner timeouts; this was rejected by the web
configuration guard. The merged full gate uses repository timeout settings. Focused historical timeout overrides
are shown explicitly below.

| Check | Result |
| --- | --- |
| Frozen dependency install | PASS: `pnpm install --offline --frozen-lockfile --ignore-scripts`. |
| Lint | PASS: `pnpm lint` (Biome checked 2,475 files; design-token, anime, dependency-layer and asset checks passed). Three formatting/import-order findings were fixed before the successful run. |
| Source notices and LGPL binaries | PASS: `pnpm notices --check` (150 packages, 31 ported-code records) and `pnpm ffmpeg:check`. Notices were regenerated for the moved music fixture's source mapping. |
| Workspace types | PASS: `pnpm --workspace-concurrency=1 -r --if-present typecheck`, all 18 package tasks. |
| Application builds | PASS: `pnpm --workspace-concurrency=1 -r --if-present build` (desktop, MCP, engine and web), plus `pnpm --filter @jasper/engine build:remotion`. |
| API/PNG regressions | PASS: both files, all six cases: `pnpm exec vitest run packages/api/test/api.test.ts apps/mcp/test/png-limits.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000`. Pre-fix failures are recorded above. |
| Native workspace | PASS: `cargo test --locked --manifest-path native/mg/Cargo.toml --workspace -j 1` (8 tests). Cargo rebuilt the CLI used by the following parity check. |
| Native schema/SVG parity | PASS: `MG_PARITY=1 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" pnpm exec vitest run packages/mg-templates/test/parity.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000` (4 tests). |
| Desktop/template scope checks | PASS: six files, 37 tests; two native parity cases were skipped in that initial scope run and exercised by the enabled integration run above. Desktop types/build and all 921 policy comparisons passed. |
| Equivalence probes | Identical audio helper bodies and moved music fixture; matching profiler output and 3,252 asset-recognition cases. All five distinct browser entries match byte for byte under the old bundler options and the shared helper: Player, PACG, PSDG compilation/preview and Sapphire glows/lighting. |
| E2E prerequisites | PASS: `E2E_SKIP_BUILD=1 node scripts/e2e-prepare.mjs`; generated fixtures are current and the LGPL bundle is up to date. |
| Full JavaScript suite | The complete diagnostic serial run finished with 5,041 passed, 3 failed and 383 skipped cases across 541 files (6,551 seconds). Two failures were audio timing checks; the third correctly rejected the command-line 600-second timeout above the web project's 60-second ceiling. The earlier two-worker run was interrupted with SIGINT (exit 130); neither run is a passing gate. A final serial gate using repository timeout settings was pending at this checkpoint; merged results are recorded below. |
| Failure follow-up | PASS: all 28 tests in `packages/audio-dsp/test/sync.test.ts`, `packages/audio-fx/test/restoration.test.ts` and `apps/web/test/test-timeout.test.ts`, run alone with `--maxWorkers=1` and no timeout override (20.21 seconds). The microphone case fell from 77.7 seconds to 5.118 seconds under its unchanged 60-second limit. DeReverb measured 571.1 ms versus its unchanged 1,250 ms base / 1,582 ms calibrated budget (previously 4,327.9 ms versus 3,572.2 ms). Independent review verified the timed synchronization, spectral, STFT and FFT code is byte-identical to the base. No source or assertions were changed to obtain this result. |
| E2E types | PASS: `pnpm e2e:typecheck`. |
| Packaged-style Electron smoke | PASS in isolation: `JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" node e2e/desktop-smoke.mjs packaged-like` (24 seconds). Verified startup, editor authentication, HttpOnly cookies and bridge refusal on an untrusted page; inspected the Home screenshot with its connected-engine status. The initial run exceeded the unchanged 30-second engine-start limit while typechecking was active; it is not counted as a pass. |
| Built browser workflows | PASS: 69 tests in 12 specs, 10.2 minutes, using the built engine/web app, current native renderer and vendored LGPL FFmpeg. Specs: `smoke`, `agent`, `agent-ui`, `color-grade`, `audio-mix`, `audio-fx`, `interchange`, `imports`, `expressions`, `polish`, `edit-ux`, `ui-audit`. Covered editing/undo, approvals, all-workspace automation IDs, imports, expressions, scopes, audio meters/remix/voice-over, native motion graphics, and native/hybrid/Remotion exports. No timeout or assertion overrides. Inspected the four-scope screenshot, audio workspace, Color workspace and a frame extracted from the graded export with vendored FFmpeg. |
| Enabled Player suites | PASS: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor-player.e2e.test.ts packages/compositions/test/fx-player.e2e.test.ts packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1` (15 tests, 53.13 seconds). Actual nested/HDR compositing, decoded video, GPU effects, scrubbing transitions and HTML-in-Canvas fallback retain their pixel assertions. |
| Development Electron smoke | PASS: `DESKTOP_SMOKE_PORT=53400 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" node e2e/desktop-smoke.mjs dev`; startup/authentication and untrusted-page bridge refusal completed in 6 seconds. |
| Desktop clipboard | PASS: `E2E_SKIP_BUILD=1 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" node e2e/desktop-clipboard.mjs` (4 tests, 11.9 seconds). Two isolated desktop apps and an external helper under Xvfb verified timeline copy/paste plus external text, images and files through keyboard and menu actions. |

The initial parallel scope runs also included canceled work and timing failures; those partial runs are not used as
integration passes. Measured host samples included load averages of 95.8 and 113.4 on 12 CPUs; audit processes inherit
niceness 10. No unrelated process was stopped or reprioritized. At that pre-merge checkpoint, final tests, remote review and push verification were still pending; the subsequent
sections record the incoming review and merged results. No exhaustive-correctness percentage is asserted.

## Incoming merge review and follow-up

The incoming range `12049d8e..e60dc734` contains 146 commits and 1,886 changed files. Scope owners reviewed the changed runtime contracts, callers and assertions; an independent test review screened all 585 changed test/spec paths, including 27 new files. Merge `b3d3b467` combines that history with this audit. Subsequent focused fixes are listed below; **the earlier validation table applies to `4f2104e9`, not this merged source**.

Incoming no-explicit-`any` enforcement, runtime dependency-cycle checks, shared wire schemas, recovery warnings, atomic-file protections, bounded worker pools and LGPL fixture-encoder selection were retained. New helpers serving actual independent consumers and independent mathematical/pixel oracles were retained. Owner conflict resolutions received source/diff, conflict-marker and whitespace checks; those are not execution passes. The independent checkpoint at `6386ad7c` mapped all 245 changed paths to owners, inspected every source hunk in the 23-path follow-up delta, and found no dangling imports, new stubs or test suppressions.

### Demonstrated input/error-boundary fixes

| Change | Why and risk | Verification on the merged candidate or an isolated follow-up |
| --- | --- | --- |
| Testkit oracle discovery (`525d4404`) | Restore skipping unusable PATH candidates. `throwIfNoEntry: false` suppresses missing entries but still throws on a symlink loop before a usable tool. Low risk: restore search behavior while preserving explicit-override errors. | A looped first candidate failed with `ELOOP` before the fix; all four discovery tests passed afterward. |
| Desktop clipboard (`34eae10b`) | Restore per-entry read isolation for Jasper payloads and file lists. An advertised item can reject `getType()` or `text()`; its failure must not hide a later readable item. Preserve format filtering, size/origin checks and overall read-failure handling. | Four bad-first/good-second IPC cases (two handlers × two rejection points) all failed before and passed after. |
| Shader validator diagnostics (`491420a4`) | Guard formatting at all four effect/transition hook catch sites. A null-prototype object or throwing coercion otherwise escapes the error boundary. Normal Error/scalar messages remain; only unformattable values get a fixed diagnostic. | Existing table extended with hostile objects and independently exercised validators: 8 failures/20 passes before; all 28 passed after. Literal expected messages avoid mirroring production coercion. |
| Tracking keyframe counts (`e0fd8757`) | Loose schemas deliberately preserve extension fields. Restore array guards for enumerated transform/opacity/effect animations and null transform containers; malformed extensions previously crashed or counted string characters. Preserve valid extension animations and aggregate counts. | Four schema-parsed malformed-extension cases failed before (three throws, one wrong result). A follow-up (`eca50150`) reproduced six more cases through `openSimplifyClips`: malformed effect lists/params or template-keyframe extensions. Narrow array/null guards preserve valid effect/template extensions. All 17 focused tests passed after both fixes, including preview/apply/undo/cancel; Biome and whitespace checks passed. |
| Program transform selection and timeline rendering (`48a90b6c`) | Use existing kind capabilities for Motion selection, retaining caption exclusion; restore null-safe effects access in ClipView. Property presence alone cannot validate arbitrary extensions on camera/audio/unknown clips. Supported transforms and valid effect arrays keep their behavior. | All five parsed-clip regressions failed before. After: 21 tests passed across clip extensions, Program layer menus and Program monitor, including mixed-selection nudge/undo and actual ClipView mounts. Focused Biome and whitespace checks passed. |
| Malformed saved view version (`cb1ed9b2`) | Fractional on-disk view versions blocked a healthy project before session repair. Pass the opaque saved view through GET to the existing session validator; retain strict PUT, envelope/revision validation and reset warnings. This repairs a preexisting boundary mismatch without writing either file. | The public open regression failed before with `INVALID_RESPONSE` for version 1.5. After: 63 focused tests passed across projects, recovery, jobs, engine-client and session views. Structured invalid-version properties preserve document/revision and both original files; invalid PUT still returns 400. Independent caller review found no bypass of session validation. |

### Additional cleanup and stronger tests

| Change | Why, risk and retained coverage | Evidence / execution status |
| --- | --- | --- |
| MCP sequence selection | Incoming `pickSequence` now supplies the same typed error itself, making our intermediate `requireSequence` redundant. Keep direct calls and the independent transaction/clip-lookup consolidation. | Owner compared merged error code/message/hint and callers. Merged MCP domain, stdio and tool tests passed in the full run. |
| MCP PNG merge | Combine incoming complete chunk/header/IEND/exact-length validation with our bounded inflation and actionable typed errors. Decode retains the 64M-pixel source-image ceiling; encoder/grid retain 16M. Avoid silently rejecting valid 8K source stills. | Retain concrete parser/grid tests and valid-header bounds properties; add an 8K-header/short-data case requiring a data-length failure without a large raster allocation. All four bounds cases, including this new case and structured inflation coverage, passed in the merged full run. |
| MCP test scaffolding | Remove unstructured random-byte PNG fuzz that almost always stops at the signature check; preserve structured properties and concrete safety cases. Make local `JsonObjectSchema` private. Keep exact fake-timer progress assertions and clear fake timers instead of reviving unused production `dispose`. | Usage/coverage review and static merge checks passed. Exact progress timestamps/values, cancellation and real request cleanup passed in the merged full run. |
| API inherited-event properties (`4c1c8d3b`) | Consolidate overlapping regressions under the unknown-name/null property, explicitly including constructor, __proto__, toString and hasOwnProperty; keep broader arbitrary-JSON/no-throw coverage and incoming origin validation. Test-only risk. | All four API tests passed. Explicit examples guarantee these inherited names are exercised independently of the random seed. |
| Shared FFT duplicate (`61409744`) | After incoming consolidation, FX's 64-point DFT test and DSP's retained case exercise the same class through a reexport/wrapper with identical input/oracle loops. Remove the FX copy, unused import and stale suite comment. | Static normalized comparison proved duplication. DSP's stronger existing tolerances, 64-point independent DFT and new complex-input property remain unchanged. Production code untouched; retained DSP oracle and complex-input property passed in the merged full run. |
| Image-sequence coverage property (`d8001385`) | Replace an inequality satisfied by empty output with canonical input/output identity coverage, plus output provenance. Allow actual basename normalization and duplicate-frame collapse; keep grouping/gap assertions independent. | Original property survived an empty-output production mutant; corrected property rejected it immediately and shrank to `[""]`. Mutation restored; all 14 focused tests passed. |
| Persisted envelope/recovery/job fuzz (`cb1ed9b2`) | Replace ignored-field randomness with invalid consumed fields starting from valid records: envelope revisions/schema/document/author/format, recovery metadata counters/IDs/changes, and job kind/state/resources/origin/requeue state. Retain typed refusals and original bytes. Test-only change. | Included in the 63 passing focused tests. Recovery metadata is restored and rediscovered; a valid neighboring job must actually execute, while malformed records never run. |
| Retained worker fault-injection narrowing (`6386ad7c`) | The identical branches are required to narrow distinct private class members. Restored them after combined typechecking rejected direct access; added a brief explanation. No cast, suppression or wrapper introduced. | The proposed direct access failed with TS7053. Final typechecking and worker-failure execution are included below. |
| AAF importer regression | Add the public `InterchangeError` requirement alongside the existing message and low-level `CfbError` checks; the old test would accept an internal error escaping the boundary. Production unchanged. | The strengthened typed-error regression passed in the merged full run. |
| Unused exports and 3D scaffolding | Privatize tooling `parseImports`/`sourceFiles`, remove obsolete template-upgrade reexports, make local `has3d` private, collapse `d.kind === 'axis' ? d.g : d.g`, and drop duplicate Scene3D host-prop typing. | Incoming-tree usage searches establish no outside consumers; expression/type changes preserve behavior. Static conflict/whitespace checks and merged type verification passed. |
| Orphan/inaccurate comments | Delete the flat compositor's detached descriptor JSDoc and empty FCPXML parentheses; correct UI perf documentation to median phases plus best media-open time. | Documentation-only; compare comments with their actual targets/output fields. No numerical change. |

### Merge adaptations and validation boundary

The shared font/bin-removal helpers now live in incoming `clip-common.ts` and `project-items.ts`, preserving deduplication without restoring handler dependencies removed upstream. The three unused roto declarations remain deleted from the new `roto/model.ts` location. Native schema output remains inlined through incoming fallible `write_output`; shared desktop bridge types retain folder picking and nullable refusal results. Incoming typed contracts, moved image/Lottie loaders, GLSL blend-chunk split and meaningful regression tests remain intact. The two small preload cancellation/rejection checks were reviewed and retained: main-process tests do not exercise bridge propagation, and the success/channel case would miss a future catch/default that hides these outcomes.

This supersedes the earlier ledger's descriptions of `clip-core.ensureDefaultFont`, `project.detachItem`, MCP `requireSequence` and the old roto implementation location. The incoming shared FFT replaces the formerly separate implementations; the earlier identical-FFT-body timing analysis is historical evidence only. Likewise, testkit's declared esbuild now resolves to 0.25.12 instead of the earlier tsx-resolved 0.28.2: the old five-entry byte-equivalence and enabled Player results cannot certify merged bundling.

The incoming lint gate forbids explicit `any` and includes the TypeScript-resolved runtime cycle scan through the existing layer check; no duplicate scan was added. Its independent reachability property and 20,000-node nonrecursive case remain. Manifest/lock changes declaring existing direct dependencies were retained together. The integrator reports that frozen offline installation passed on the merged tree. Completed notices/licensing, source/E2E type and build checks are recorded below; execution results and their isolated follow-ups are recorded explicitly.

Incoming functional-test deadlines changed: native export 120→600 seconds, Zod subprocess conversion 15→120 seconds, and whole-repository layer scan 60→120 seconds. Their upstream notes record actual completed runtimes exceeding or approaching the old limits; output/security/pixel assertions and documented performance budgets are unchanged. These changes are disclosed rather than described as unchanged deadlines.

## Merged validation — runtime `6386ad7c`, color test `2ea03bd6`

The focused results above validate their isolated fixes. These results apply to the merged runtime at `6386ad7c`;
its worker-narrowing correction changes only a test and comment. The subsequent color test commit `2ea03bd6`
is validated separately below and does not alter application code or invalidate the application builds.

| Check | Merged result |
| --- | --- |
| Frozen dependency install | PASS: `pnpm install --offline --frozen-lockfile --ignore-scripts`. All package manifests also parsed with duplicate-key rejection. |
| Lint | PASS: `pnpm lint`; Biome checked 2,551 files, followed by token, anime, runtime dependency-cycle/layer and asset checks. |
| Notices and LGPL artifacts | PASS: `pnpm notices --check` (150 packages, 31 ported-code records) and `pnpm ffmpeg:check`. |
| Application and Remotion builds | PASS: `pnpm --workspace-concurrency=1 -r --if-present build`, plus `pnpm --filter @jasper/engine build:remotion`. Web transformed 3,630 modules; Remotion bundled and copied fonts. |
| Browser prerequisites | PASS: `pnpm e2e:typecheck` and `E2E_SKIP_BUILD=1 node scripts/e2e-prepare.mjs`. |
| Native workspace and CLI | PASS: `cargo test --locked --manifest-path native/mg/Cargo.toml --workspace -j 1` (14 tests) and `cargo build --locked --manifest-path native/mg/Cargo.toml -p jasper-mg-cli -j 1`. |
| Workspace types | PASS across all 18 package tasks: `pnpm --workspace-concurrency=1 -r --if-present typecheck`, followed by successful reruns of the seven packages affected while the initial check was running. The initial engine check found TS7053 in the proposed test simplification; restoring required narrowing resolved it without casts or weaker checks. |
| Full JavaScript suite and isolated follow-up | Completed: 5,316 passed, 3 failed, 383 explicit skips across 569 files (7,481.57 seconds). All 39 tests in the three failing files then passed alone (61.02 seconds) with unchanged repository deadlines and budgets; details below. |
| Built browser workflows | Initial merged run: 68 passed, one color-export timeout, no skips/flaky cases, across the same 69 tests/12 specs (37.9 minutes). The isolated unchanged color suite repeated seven passes/one export timeout. The final color-fixture verification is described below. |
| Enabled native parity | PASS: `MG_PARITY=1 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" pnpm exec vitest run packages/mg-templates/test/parity.test.ts --maxWorkers=1` (4 tests, 6.61 seconds), with repository deadlines. |
| Enabled Player suites | PASS: `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/compositor-player.e2e.test.ts packages/compositions/test/fx-player.e2e.test.ts packages/compositions/test/transition-player.e2e.test.ts --maxWorkers=1` (15 tests across 3 files, 53.51 seconds), with repository deadlines and pixel assertions. This validates the merged bundler setup. |
| Packaged-style Electron smoke | PASS: `JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" node e2e/desktop-smoke.mjs packaged-like` (24 seconds). Startup, authentication and bridge refusal on an untrusted page passed; the resulting Home screenshot was inspected. |
| Desktop clipboard | PASS: `E2E_SKIP_BUILD=1 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" node e2e/desktop-clipboard.mjs` (4 tests, 2.3 minutes). Two isolated apps and an external helper exercised timeline data, text, images and files through keyboard/menu actions. |
| Development Electron smoke | PASS in isolation: `DESKTOP_SMOKE_PORT=53440 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" node e2e/desktop-smoke.mjs dev`. Warmed 1,208 modules in 90 seconds; launch/authentication/untrusted-page checks took 39 seconds. Earlier attempt exited 143 during startup for an unestablished reason; a retry overlapping clipboard validation was deliberately canceled. Neither is counted as a pass. |

### Merged timing failures and resolution

The full command was `JASPER_REQUIRE_ORACLES=1 FX_COMPILE_WORKERS=1 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" pnpm test --maxWorkers=1 --retry=1 --reporter=verbose --reporter=json --outputFile=/tmp/slop-merged-tests.json`. The full invocation exited 1, not a clean pass. Its failures were two performance assertions and an unchanged binary-rewrite test exceeding its five-second deadline. The repository layer scan passed on its permitted retry (213.6 seconds across both attempts). No functional assertion failed elsewhere.

The follow-up command was `JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run packages/project/test/perf-budgets.test.ts packages/project/test/lumetri-grade.test.ts scripts/ffmpeg/lib.test.mjs --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=/tmp/slop-merged-retry.json`. All 39 tests passed without retries, source changes or timeout overrides.

| Check | Full-run measurements | Isolated result | Source comparison / limits |
| --- | --- | --- | --- |
| 1,000-clip render bar | 1,980.1 ms and 1,185.9 ms versus 754.59 ms calibrated budget | 96.3 ms, below both the 120 ms base and 155 ms calibrated budget | AST comparison: benchmark, Harness, snapshot, all 33 retained preview function bodies and moved canonical serializer unchanged from the original base. |
| Full 33³ Lumetri bake | 134.24 ms and 76.06 ms versus 43.03 ms calibrated budget | 71.99 ms; existing load-adjusted assertion passed (30 ms base, calibration factor not logged by this test) | Pixel math, LUT loops, inputs/defaults and calibration unchanged; only a once-per-bake equivalent nullish fallback changed. No claim that this run met the unscaled base. |
| FFmpeg RPATH rewrite | Both attempts exceeded 5,000 ms; 13,019 ms total | 4,302 ms, below the same 5,000 ms deadline | Test and runtime body unchanged apart from comments. Independent readelf assertion and byte-for-byte preservation after refusal remain. |

During the failures, measured host load reached 73 on a 12-CPU allocation, with CPU scheduling pressure around 66–70%. Nearby unchanged tests slowed roughly 13×. These measurements, source comparisons and successful isolated reruns support contention as the cause; they do not establish a controlled before/after speedup. Budgets, pixel tolerances and fuzz properties were not relaxed. The default suite's 383 skips are explicit platform/opt-in cases; separately enabled application suites are reported in the merged-results table rather than counting skipped work as passed.


### Color export fixture and omission check

The original merged browser run completed 68 of 69 cases; the color-export case exceeded its unchanged 180-second outer deadline while its bake was advancing. A fresh isolated run repeated seven UI passes and the same export timeout. No pixel assertion failed in either run. The render loops, concurrency, shader and bake cache inputs were reviewed; that review did not establish a production performance fix.

The color test measures the fixed spatial vignette at frame 10, but formerly baked clip A's entire unasserted tail. The final test now trims only A's video OUT point to 30 frames **after** the seven UI cases, with linked/group edits disabled. It verifies A's start and grade remain intact and all other clips are unchanged. Clip B and A's linked audio are unchanged, preserving the original sequence duration. This intentionally reduces long-span graded-video endurance coverage; no later graded frame or performance budget was asserted by this test. Full-timeline exports remain covered in the smoke suite, and layer-bake tests retain master/still, frame-parity, cache and cancellation checks.

The test keeps its full export, 1920×1080 resolution, frame-10 sampling, 0.6 luma-ratio threshold and original deadlines; the sampled regions were corrected after the omission experiment below. New assertions require the original full sequence frame count and duration, H.264 at `30000/1001`, and a successful child bake with `still: false, frames: 30`. This explicitly proves a moving-video master executed. A single-frame export shortcut was rejected because it would instead take the still-render path.

With a fresh engine/appdir and the unmodified export bundle, all eight cases passed in 138.31 seconds; the export case took about 72 seconds. The output contained 478 frames at 1920×1080, `30000/1001`, lasting 15.949267 seconds. Measured corner/center luma was 4.84668 / 122.21729 (ratio 0.03966). The exported frame and final Color-workspace screenshot were visually inspected. Focused Biome checks passed after this test-only change; final `pnpm lint` (2,551 files plus all repository checks) and `pnpm e2e:typecheck` also passed on `2ea03bd6`. The first export-only mutation run exited 143 before an image assertion, for an unestablished reason; its remaining engine was stopped and the exact original bundle restored. This interrupted run is not a valid mutation result. The retry completed with all eight cases passing, exposing a weak oracle: the missing vignette brightened the red corner from 4.84668 to 44.90869, but the mixed-color center remained 122.21777, so the faulty export still met the old 0.6 threshold (ratio 0.36745).

The precise mutation changed only `u_lmVigAmount: s.vignette.amount` to zero in the generated export bundle. The web preview, planner and spatial stage remained intact; fresh cache metadata confirmed the 30-frame master and `vignetteAmount: -4` project state. The original bundle SHA-256 was `e255fa3ce62c7a1643e59eed75d58ff2592a2f60a897307e162b0fda5ba8bccf`; the mutant was `e75b0fd650d4458ca3765f09c62aef33355b971d0b57d649353dba9f1ec27a9a`. The experiment verified exact restoration after each completed run.

Replaced the cross-hue comparison with two regions wholly inside the same green bar: edge `{x:0.2,y:0,w:0.08,h:0.08}` and interior `{x:0.2,y:0.45,w:0.08,h:0.1}`. Both avoid the fixture's moving marks and timecode; independent measurement of the source gave identical mean luma 150.03125. Retained the same strict 0.6 threshold and two decodes, without another helper, golden or arbitrary brightness floor. An all-black image fails because `0 < 0` is false. On the already-exported files, the corrected ratio is 0.121016 with the vignette and 1.000720 without it. The fresh-engine mutant run then passed all seven UI cases and the export/job/metadata/master checks, but failed exactly at the corrected pixel assertion: received 173.6875, required `< 104.1375`. This is the expected negative result, not a timeout or renderer error. The bundle was restored to its exact original hash. The first restored run passed seven UI cases and completed its master bake, but reached the unchanged 180-second deadline during encoding before the image assertion (host CPU scheduling pressure measured 71–77%). This is a recorded timing failure, not a positive confirmation. The subsequent isolated run passed all eight cases with unchanged deadlines and fixture; its total duration was 127.46 seconds (67.10 seconds for export). No source or bundle change occurred between these restored attempts.


The final color confirmation used `E2E_SKIP_BUILD=1 E2E_PORT=52396 JASPER_MG="$PWD/native/mg/target/debug/jasper-mg" pnpm exec playwright test e2e/color-grade.spec.ts --reporter=list,json`, with a fresh temporary appdir. The mutant run used the same spec/options on its own port/appdir, with the one generated uniform assignment changed; no mutated artifact is tracked or shipped. Independent review approved the fixture/path preservation and same-color oracle. The final exported frame and workspace screenshot were inspected.

Verification covered the Linux environment and the explicitly enabled native/Player/Electron paths listed above. Platform-only and other opt-in skips remain identified, and the full Vitest invocation's timing failures remain visible rather than being relabeled as a clean aggregate pass. No runtime deadline, performance budget or pixel tolerance was relaxed to obtain the final results.
