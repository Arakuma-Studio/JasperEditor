# Codebase simplification audit

Baseline: `eb28696c` on `main`, initially identical to `origin/main`. Fifteen area reviewers used
isolated branches/worktrees, followed by integration and independent reviews. The audit covered
application and package source, tests, scripts, E2E infrastructure, root configuration and the native
renderer. The prohibited reference material was excluded. Our cleanup did not change dependency versions,
project schemas, shipped migrations, golden images or synthesis recipes. Integration retains the incoming
PCM16 WAV hash contract and X fallback-font spacing correction described below.

Deletion evidence combines searches across explicit repository roots, import/export inspection,
registration and namespace-use checks, implementation comparison and existing tests. Explicit roots
matter in ignored `.claude/worktrees`: an empty bare `rg` result there is not evidence of no callers.
These are private workspace packages; undocumented consumers outside this repository cannot be ruled out.

Measured against incoming `3213ec5c`, settled source `db8e5643` changes 145 files under
`apps packages scripts native e2e`: 339 lines added and 1,423 removed, or 1,084 fewer lines.
Rerun with `git diff --shortstat 3213ec5c db8e5643 -- apps packages scripts native e2e`.

## Changes, risk and evidence

### Project model and commands

| Change | Why it was removed or simplified | Risk and verification |
| --- | --- | --- |
| Automation `cutClips`, `adjustmentsIn`, `reactionSourceFlicks`, `styleStageNames`, `projectMediaOfSound`, `slideTrackLabel`, `REACTION_SKIP_CODES`, `MAX_AUTOMATION_SEED` | Definitions had no consumers; live planners use other implementations. | Private unused-export risk. Explicit-root searches plus automation, overlays and style suites. |
| Text-style `styleOverridesOf`, `linkedEffectiveStyle`, `mergeStyleFields` | Uncalled helpers; active commands already implement field merging. | Link/override semantics are covered by existing text-style tests. Updated stale documentation pointers. |
| Geometry/animation `vertexCount`, `apply4`, `framesOf`, graphics `FLICKS`, `documentExpressions`, `effectiveInInterpolation`, `hasKeyframes` | No imported or local callers, including same-name-symbol disambiguation. | Evaluator, expression, vector, graphics and animator tests retained. |
| Registry/schema `GLSL_TR_LIBRARY`, `defaultsOf`, `AXIS_TAG`, `BOTH_SIDED_INTERPOLATIONS` | Unused constants/helpers; active shader chunks and validators remain. | No shader body or persisted representation changed. Project typecheck and affected registry/keyframe suites. |
| Three handler JSON-copy implementations | Duplicate JSON-copy operations now use existing draft-aware `commands/handlers/util.clone`. | Immer/detached-copy risk. Command results, exact undo/redo, sound upgrades/verdicts and acknowledgements tested. |
| Multicam/subclip parent-bin lookup | Identical loops now share `project-items.parentBinOf`. | Bin choice/order risk; multicam and subclip tests pass. |
| Caption name alias, transcript/optional-frame wrappers, camera content-time wrapper, time-remap duration wrapper | Forwarded unchanged arguments to existing helpers. | Defaults, time units and refusal behavior preserved; captions, camera, remap, processed-source and history suites. |
| `remixOutputSeconds`, `soundCheckVerdictMarkerName`, `cueAnchorRefs`, `SUBTITLE_TEMPLATE_PREFIX`, `SOUND_VARIATIONS`, `signalFromRgbaFloat` | No code callers; actual scopes read RGBA8 and live sound/template paths have their own implementations. | Private unused-export risk; music, verdict, anchors, subtitle and scope tests retained. |
| Script-fix `alignTranscripts`, `decideFixes`, `keyDistance` and barrel exports | Unused batch/forwarding wrappers; callers use individual operations/core distance directly. | Script parity, property and golden tests retained. |
| `LibrarySource`, `LibraryTake`, `ReferenceEntryInput` aliases | Unused inferred type aliases. | Validation schemas remain; workspace typechecking checks consumers. |
| Mixer `layoutOfWidth` | Pure forwarding wrapper around `layoutFromChannels`. | Audio mixer tests; identical arguments reach the original implementation. |
| Duplicate Lumetri luma constants, smoothstep and wheel formula | Reused identical existing grade-math definitions. | Compared baseline/current full grades over 898,425 RGB lattice samples exactly; 9,528,128 smoothstep combinations and 43,681 wheel pairs also matched. Existing color tests retain independent formulas and performance budgets. |
| `maskCoverageAt` | Unused brute-force raster duplicate; former differential coverage was already replaced by analytic pixel tests. | Removed private export only; no shader change. |
| Fake per-pixel mask objects and two empty arrays | `maskValue` now accepts only fields it reads and receives already-decoded information. | All arithmetic/packing remains. Eight suites/94 tests passed; exact Float32 equality against baseline for 80 deterministic packs across combine modes, shapes, scales, opacity, inversion, feather and expansion. Combined SHA-256: `bfc38f4ee59d895340736487229d85b4a822e82972a2e7c7d23924eeb1a65e02`. |

### Web UI

| Change | Why it was removed or simplified | Risk and verification |
| --- | --- | --- |
| `missingDocCommand`, `EaseDocCommand`, six `needs` properties | Every named schema/handler is unconditionally present in the static command catalogue, making the capability scaffold unreachable. | Selection, clipboard, locking, read-only checks and model refusals remain. Easing command/panel suites pass; obsolete translation removed through the generator and Spanish catalogue cleanup. |
| `storedSections`, `WORDLESS_KINDS` | No consumers; commands read settings directly and cleanup uses finding word ranges. | Explicit-root searches and web typecheck; cleanup/easing tests retained. |
| Easing active-sequence/current-curve wrappers and label thunk | Single-use forwarding; curve and translated labels still read when invoked. | Synchronous state read timing and action behavior covered by easing suites. |
| `useProjectMedia`, `NO_MEDIA`, `deleteFromLibrary`, `shownProposalCheck`, `ghostItemX`, `isBuiltin`, `interpretSections`, `RotoBrushKind`, `contentsOf`, `keyAt`, `resolvedMediaId`, `commandEnabled`, `warnMediaIds`, `peakSecondsText` | Unused private helpers/types; live selectors, hit testing, import registration and per-clip licence badges remain. | Explicit-root and AST import/export scans; affected UI suites and web typecheck. |
| `playItem` and private `listen` forwarding layer | Sole caller now uses `playWithHear`; exported `trackUserInput` contains the original guarded listener registration. | Original arguments, event handling and trusted-input timing remain; agent-guard/review tests retained. |
| Sound-insert assertions | Truthiness accepted its own clip fallback; JSON substring could match unrelated `sfx` metadata. | Exact audio clip and `essential.type = sfx` assertion replaces both; all seven insertion tests pass. |

### Engine, rendering and MCP

| Change | Why it was removed or simplified | Risk and verification |
| --- | --- | --- |
| Import-route `waitJob` | Duplicated existing `replyWithJob` success, 202 and 422/error-detail behavior. | Imports/jobs integration passes with real FFmpeg. Different MG `INVALID_SPEC → 400` behavior was retained. |
| Internal export modifiers on `fontUsage`, `remoteAssetStatus`, `decodeRgbaFrame`, `describeFolder`, `OpenerCommand`, `ImportsServices`, `UserApprovalOutcome`, `LeaseChange`, `ProjectStoreChange` | Module-local definitions had no external consumers. | Definitions stay local; engine typecheck and route/persistence suites. |
| Recovery `RecoveryCandidate` re-export and `RecoveryWrite` alias | Unconsumed export/forwarding type; signatures use `RecoveryPutRequest` directly. | Recovery schema, journal, atomic writes and leases unchanged; recovery tests retained. |
| `activeWindow`, `bedRequestSequence`, `refineWordBounds`, four unused measurement reexports | No callers, including claimed old benchmark consumers. Live validation/refinement functions remain. | Speech/core/guards/scoring and engine typecheck; no numeric/process guards removed. |
| Two ONNX-loader wrappers and `quoteFilterPath` | Pure forwarding to existing shared implementations. Direct imports also avoid depending on the full color extension. | Lazy loading and filter escaping unchanged; eight actual FFmpeg path-escaping cases pass. |
| Two `MeasureCache.has` checks | Shared LRU helper already handles missing keys. | Explicit miss, stored-null, value, eviction-order and clear checks. |
| Composition `CROP_EFFECT_ID`, `paintsMoreThanFill` | Definitions had no consumers. | No effect routing or paint formula changed; composition suites/typecheck. |
| Duplicate `dbToGain` implementations | Project, composition pipeline and audio graph used the same formula; composition export remains available. | 1,000,011 boundary/random inputs matched exactly; actual Chrome preview-audio oracle coverage. |
| Export `layerSpan` duplication | Warp and retime contained identical bodies; moved to existing `native-ext` module. | Export spans/handles unchanged; warp/retime export suites. |
| `canRunFlow` wrapper | One forwarding call to the same extension check. | Actual SwiftShader retime reference-pixel test. |
| MCP `media.ts` re-export shim and `CurveInput` | Eleven tools now import the same API origin directly; inferred type had no consumers. | MCP/desktop typechecks and tool integration tests. |
| Two MCP pixel-blend implementations | Byte-identical bodies now reuse the already-imported sound-sheet module's function. | Twelve complete image scenarios had identical SHA-256 values, covering sound sheets, timelines and motion strips. |

### Shared packages, audio and motion

| Change | Why it was removed or simplified | Risk and verification |
| --- | --- | --- |
| UI `TreeList`, its two tests, and `ScrollArea` | No application consumers. Actual Project/Media Browser panels own their virtualized rows; the two tests were the only TreeList callers. | Deleted unused implementations and exclusive tests together. Current architecture/widget documentation updated; other UI behavior tests retained. |
| Testkit `readPng` | Only caller composed file reading and PNG decoding; inlined there. | Same decoder/error handling and golden comparison suites. |
| Interchange label catalogue and marker dedupe | Duplicated authoritative label list and identical marker sorting/filtering. | 36 color cases, duplicate-marker documents, and byte-identical 147,456-byte AAF output against baseline. |
| Path/OMF wrappers and format-fuzz availability filters | Wrappers became API-preserving aliases; complete format records always require readers/writers. | Path/header differential checks; all seven formats and exported seeds still fuzzed. |
| Session proposal-selection duplication | Existing `selection.combine` implements identical ordered replace/add/toggle/remove behavior after known-ID filtering. | 40,000 baseline differential cases; selection contract passed before/after, including duplicates and unknown IDs. |
| Duplicate proposal history lookups, two unused internal schema exports, unused hook result binding | One entry lookup provides both ID/label; schemas and hook subscription remain. | Full session suite: 25 files/97 tests; public types/hooks and undo tracking retained. |
| Audio unused `CurveMeter.hops`, `ClickDetector.samples`, synth callback wrapper | Getters had no reads; callback only called an existing envelope. | Affected audio suites and pinned synth bytes on Node 20. |
| Five identical stereo processor test factories | Shared test setup preserves every assertion and mono-specific defaults. | Existing processor/restoration/dynamics suites. |
| Resampler generic Kaiser-beta branches | Private helper only received fixed high/fast attenuation values above 50 dB. | Same formula for both supported specifications; passband, aliasing, phase and dense-ratio tests retained. |
| Unavailable social card scaffold, duplicate ready catalogue, asset guard and availability helper/engine branch | The exhaustive variant map implements all ten variants, and the ready list exactly duplicated the authoritative catalogue without build substitutions or mutation. Both guards were unreachable. | Private unused-export risk. Presets use the original catalogue in the same order; asset declarations, all-variant/theme render tests and generic missing-template export refusal remain covered. Removed assertions covered only obsolete availability scaffolding. |
| `isEmojiPackId`, `SocialTheme`, `SocialUnitProp`, `SocialHeartProp`, duplicate `SOCIAL_ENTRANCE_MS` | No consumers; live tween definitions retain entrance timings. | Motion/template typechecks, timing/schedule tests and anime gate. |
| `clampRating` and isolated test | Test was the only caller; production uses schema/randomization/render validation. | Remaining review tests retained; no rendering/schema change. |

Desktop, native renderer, root configuration and remaining scripts were also inspected; no further
evidence-backed deletion was made. Distinct span-merging semantics, platform fallbacks, parser bounds,
undo/refusal/invariant checks, compatibility APIs, process failure handling and persistence protections
remain. A low line count or a single caller alone was not a reason to delete useful coverage.

## Incoming integration

`origin/main` advanced by 57 commits to `3213ec5c` during verification. Merge `1a0ddf6a` preserves that
performance and test-audit work. Reviewers checked incoming production changes, deleted-test ownership,
independent oracles and integration with the cleanup; the [incoming audit](../test-audit/README.md)
records that work's separate measurements. Its performance figures are not measurements of our cleanup.

The two test conflicts retain the precise audio/SFX assertion and registered-card coverage, while removing
an import whose test was deleted upstream and a check for the deleted unavailable-card scaffold. The incoming
FFT, navigation, grouped-selection and keyed-job indexes remain. The X fallback spacing bugfix keeps its
render-version increment and rendered oracle. Incoming synthesis checks pin the actual versioned PCM16 WAV
cache representation against historical Node 20 output and cross-runtime evidence; raw floating-point hash
portability is no longer claimed. No synthesis recipe or version changed.

The two TreeList `KEEP` records in `docs/test-audit/core_support.json` describe the incoming checkpoint.
This audit supersedes them: the unused component and its exclusive tests were removed together as recorded
above. The `clamps to whole stars 1–5` record in `motion_templates.json` is likewise superseded by removal
of its unused helper and exclusive test. Existing application tree and rating implementations remain covered.

Review also identified incoming coverage gaps in cleanup-list scrolling, absolute-size GPU passes,
voice-analysis wiring and disjunctive source/licence facets. Focused independent witnesses are restored
before the merged gate; their fault-injection evidence is recorded with the integrated results.

| Retained or restored contract | Why it remains necessary | Verification |
| --- | --- | --- |
| Cleanup viewport coverage | Initial-row UI checks and another review virtualizer do not protect this list's scrolling implementation. | Restored 200-case independent overlap property; empty-range mutation failed with seed `20261027`, counterexample `[0, 1]`; all five focused tests passed after restoration. |
| Absolute framebuffer dimensions | The former constant-red lookup painted the same result at the wrong size. | Extra lookup texels now paint blue; independent final pixels on both axes reject separately ignored width and height. Eight focused GL checks passed with the original source restored. |
| Voice data reaches cleanup planning | Job bookkeeping and response/file consistency do not establish that planning consumed the computed voice analysis. | Requested media must have `voice: true` and level edges. Dropping the lookup failed; the affected engine suites passed eight tests after restoration. |
| Disjunctive source/licence facets | Unfiltered counts and type/material cases do not check these dimensions under active filters. | Four authored source/licence combinations have literal result/facet expectations. Both own-filter mutations failed; source restored before the positive engine run. |
| Float16 NaN and overflow | The rewritten session-boundary case had dropped these vectors. | Literal overflow words and semantic NaN exponent/payload checks extend the existing test; NaN-to-infinity and overflow-to-finite mutations fail. The complete 18-case session suite passes after restoration. |

No production mutation is retained. The suspected reverse-text-preset coverage gap was ruled out:
the deleted case requested unsupported text speed, received a clamp warning and never reversed the clip.
Its weak success-only test remains removed; the inaccurate documentation claim was deleted.
The restored viewport property supersedes its incoming `web_1.json` deletion record; the compact facet
witness supersedes the claim in `engine_3.json` that the deleted oracle had no unique filtering protection.

## Verification

Settled source `db8e5643`, including the incoming merge and final readiness cleanup, passes the full unit
gate: **937 files / 9,031 tests**, with **49 files / 282 tests skipped**, zero failures and zero TODOs,
in 2,146.18 seconds. Command: `pnpm test --maxWorkers=2 --testTimeout=60000 --hookTimeout=240000`.
Real Chrome/SwiftShader GL checks execute, including all 393 GPU-host cases. All seven independent
Python interchange-reader checks pass. Interrupted earlier runs are excluded from these counts.

The integrated tree passes `pnpm lint`, `pnpm typecheck`, `pnpm e2e:typecheck`,
`pnpm ffmpeg:check`, `pnpm notices --check`, and `pnpm build`. The workspace build uses
`NODE_OPTIONS=--max-old-space-size=6144`: the host's default Node 20 heap exhausted memory in an earlier
attempt. The completed build retains nonblocking bundle-size and dependency-annotation warnings.
`pnpm --filter @jasper/engine build:remotion` also passes; the regular build does not produce this bundle.

Verification uses Node 20.20.2, pnpm 10.34.5, the manifest-pinned LGPL FFmpeg/ffprobe,
`JASPER_REQUIRE_ORACLES=1`, Chrome 153 with SwiftShader, and at most two Vitest workers.
The native renderer was actually built with Rust 1.96.0; its locked release workspace tests pass
all 13 cases with none ignored. Python OpenTimelineIO, its format plugins and pyaaf2 are installed
for independent interchange-reader checks. No test assertions, performance budgets or golden images
were weakened to accommodate this host.

The settled browser run passes **138 tests**, with **one skip**, in 24.5 minutes:
`E2E_PORT=48279 E2E_SKIP_BUILD=1 pnpm e2e`. All workspace and Remotion outputs were freshly built before
this invocation. The native motion-graphic export executes successfully. The sole skip requires
`E2E_CLAP=1` and a local real-model catalogue. The server log contains a closed Remotion-page error;
the browser continues and every enabled case passes.

The selected optional Remotion run passes **three files / seven tests**, with none skipped, in
483.37 seconds. It checks rendered mask coverage, color processing, social-card still/sequence parity
and full-size canvas fit. Six of these cases were skipped by the default gate; its skip totals above
remain the default-run totals. Command:

`REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/masks-render.e2e.test.ts apps/engine/test/color-remotion.test.ts packages/motion/test/social-comment-render.e2e.test.ts --maxWorkers=1 --testTimeout=60000 --hookTimeout=240000`.

The actual native export frame was visually inspected: the lower-third text and blue accent are
legible over the intentional black interval before footage begins. Program-preview screenshots and
the callout/export frame were also inspected during the UI cleanup. No golden output was blessed.
The shared Linux host has eight logical CPUs and 15 GiB RAM; suite durations are wall times, not a
performance comparison.

The remaining skipped/default-omitted coverage comprises opt-in Remotion/MG rendering and parity matrices,
MCP scenario QA, real model/CUDA/SAM suites, remote SSH integration, PowerShell-dependent opener checks,
benchmarks, and three intentionally skipped random script-fix parity vectors. The complete extended
`FUZZ=1`, strict `PERF=1`, desktop/packaged-app and other-platform matrices were not run. A real Electron
AVC3 playback check passes after the host's GTK dependency was provided; this is not a full desktop smoke run.
These limits do not count as successful tests. No unresolved failure remains in the completed enabled gates.
