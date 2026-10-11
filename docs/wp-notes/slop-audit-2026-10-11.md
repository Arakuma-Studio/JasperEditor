# Codebase simplification audit — 11 October 2026

This continues the [previous audit](../slop-audit.md), starting from `12049d8e` after the parity-program merge.
Fifteen scope owners reviewed the application, packages, native renderer, scripts and tests; independent reviewers
checked model/web diffs and test quality. The changes remove unused code, duplicate work and unnecessary wrappers.
Two malformed-input defects discovered during the review receive explicit behavior fixes and regression tests.

## Method and limits

Removal decisions combine repository-wide references, package entrypoints, dynamic registration and caller/body
inspection. Declaration-only searches were followed by checks for namespace imports, serialized worker functions,
shader generation and published contracts. Private package exports can still have undocumented external consumers;
none were found in the repository. A low reference count alone does not establish that a helper is unused.

The ledger groups related edits and records their rationale, residual risk and evidence. “Retained coverage” names
existing checks to run, not a passing result. Scope checks are partial; the combined integration gate is in progress.
This is structural review and targeted verification, not proof that every line is correct or every simplification found.

## Demonstrated malformed-input defects

| Change | Evidence, risk and retained safeguards |
| --- | --- |
| MCP PNG decoder bounds | Before the fix, a 1,096-byte PNG declaring 1×1 RGBA inflated to 1,048,576 bytes and was accepted, although the declared scanline needs five bytes. All three new regression/property tests failed before the fix. Limit dimensions to 64×1024×1024 pixels and inflation to declared scanline bytes; return actionable `E_LIMIT` / `E_INVALID_PARAM` errors. This intentionally rejects oversized/malformed inputs; normal images, sim-warp's decode fallback and MCP error conversion remain. Post-fix verification belongs to the integration gate. |
| API event schema lookup | `parseEvent` looked up inherited Object members as schemas. The new property test failed before the fix on `["constructor", null]` with `schema.safeParse is not a function` (seed 24301, path `1:0`). Own-key membership now makes unknown event names return null as already specified. Known event payload validation remains unchanged. The property covers inherited/unknown names and arbitrary JSON; post-fix verification remains required. |

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
| Browser bundle setup | Seven test/development launchers reuse existing `bundleForBrowser` instead of copied esbuild setup. Preserve entry paths, IIFE/ES2022/browser settings, production NODE_ENV, cache and SwiftShader flags. Risk is bootstrap/bundling drift; output-equivalence and affected Player/GL checks remain for integration. Pixel assertions and per-test browser cleanup remain. |
| Browser-backed count test | Delete a test that launched Chromium only to assert 25 imported family IDs. The project suite checks exact IDs/labels, registry/bin wiring and validity. Every per-effect GL execution/pixel test remains. Independently verified; removes one unnecessary browser startup. |

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
| Shared menu/type simplification | Reuse deferred `LazyItems` for Menubar, retaining `() => m.items()` receiver binding and mount timing. Remove unnecessary client/dialog casts with no runtime-value change. Risk is eager resolution/receiver/type mismatch; existing lazy-menu/client/UI tests and workspace typecheck must verify. |

## Desktop, native and tooling

| Change | Why, risk and evidence |
| --- | --- |
| Shared open-file policy | Desktop reuses config's identical extension predicate, retaining absolute-path/NUL/length guards. Add workspace dependency/importer entry and update security documentation. Differential comparison matched baseline on 921 path/type cases; desktop build bundles config without a runtime package import. Delete copied-array parity test, retain real allow/deny behavior tests. Risk is policy/packaging drift; desktop tests/types/build completed. |
| Native wrapper/dependency | Inline one-use `schema_json` envelope with unchanged `catalog()`, privatize local Rust `char_em` / TS `COUNTER_LIMIT`, remove CLI's unused direct serde edge and lock entry. No new dependency version. Low compile/schema-output risk; changed-file rustfmt passes, native compilation/parity remain required. Independent Rust/TS render implementations stay separate. |
| Performance scaffolding | Delete uncalled `checkUiBudgets` (active driver already enforces emitted budgets) and unread profiler Map/void expression. Original/current summaries matched exactly on a nested/idle profile. Remove one discarded read-only E2E sequence query. No budget, scenario, user action or assertion changed. |
| Asset recognizer | Remove redundant Set around fixed extensions and impossible attribution-suffix match. Old/new predicates agreed on 3,252 tracked/extension/case/sidecar paths. License allowlist, provenance/index validation, ignores and generated-media ban remain. Existing asset tests passed; repository gate still required. |
| Script visibility/comments | Privatize unconsumed checker tables, fixture/calibration builders and profiling credentials/mapping helpers; retain all imported/dynamic fixture APIs. Correct document-versus-envelope comment. Risk is missed script import; source/body and entrypoint review plus script/E2E types/build checks address it. |

## Retained safeguards and independent review

No cleanup removes atomic persistence/recovery, leases/approvals, parser budgets, numerical input checks, recursion
or allocation caps, process cancellation, checksums, source provenance or LGPL restrictions. Dynamic command/panel
registrations, worker serialization, WASM ABI, render fallbacks and exported wire contracts were reviewed separately.
Independent mathematical/pixel/native oracles remain independent. Similar FFT/Biquad layouts, worker pools, Rust/TS
renderers and inspector/UI controls retain meaningful ownership, timing or commit differences and were not merged.

The independent test scan parsed 594 JS/TS test sources: 4,302 named it/test callback candidates, not a runtime test
count. It screened self-comparisons, short/assertion-free bodies, duplicates and skip/TODO patterns. Five findings
appear above. Seeded determinism, cached-reference checks, shared assertion helpers and opt-in diagnostics remain.
Independent model/web review found no blocking regression in six owners' final diffs; an orphan comment was fixed.
Neither static review establishes that the full suites pass.

## Validation status — integration in progress

Scope validation was centralized after concurrent jobs saturated the shared host. Canceled compilers/test runners
are not passes. No timeout, performance threshold, fuzz property, pixel tolerance or security assertion was weakened.
The integrator owns final combined results, follow-ups, remote merge review and push verification.

| Evidence available from scope work | Status / remaining work |
| --- | --- |
| Caller/body/dynamic-entry review, scoped formatting and whitespace checks | Completed across owners; some checks preceded final small edits. Run final combined lint, attribution/notices and whitespace checks. |
| Desktop/template suite and desktop types/build | Six files: 37 tests passed, two native parity cases skipped. Desktop typecheck/main/preload build passed; 921 policy comparisons matched. Native/template full types and enabled parity remain. |
| Arithmetic/fixture/tooling equivalence probes | Identical audio helper bodies and moved music fixture; matching profiler output and 3,252 asset-recognition cases. Browser bundle byte-equivalence probe was planned but not completed by its owner. |
| New API and PNG regression tests | Pre-fix failures recorded above. Post-fix runs were stopped before results; combined gate must establish green results. |
| Script suite | 49 passed, one prerequisite skip, three timeouts (notices freshness/license closure and repository layer scan); retry incomplete. Preserve original limits and rerun. |
| Audio and scope timing tests | Unchanged loudness case exceeded its 60-second timeout; project scope suite reported 15 behavioral passes and one performance failure under contention. These are unresolved until rerun, not passing claims. |
| Expressions partial runs | Engine 27/28 and bind 9/10 cases reported before termination; no final failure detail. Resource/timing behavior needs serial rerun; do not assume the cause. |
| Workspace/integration gate | Full lint, types, tests, build, E2E types and relevant browser/GL/native checks are in progress. Regenerate notices for the moved ported-code mapping. Final outcomes belong here after completion. |

No exhaustive-correctness percentage or final test count is asserted by this note.
