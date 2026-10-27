# Codebase simplification audit

Baseline: `eb28696c` on `main`, initially identical to `origin/main`. Fifteen area reviewers used
isolated branches/worktrees, followed by integration and two independent reviews. The audit covered
application and package source, tests, scripts, E2E infrastructure, root configuration and the native
renderer. The prohibited reference material was excluded. Dependency versions, project schemas,
shipped migrations, golden images and synthesis hashes were not changed.

Deletion evidence combines searches across explicit repository roots, import/export inspection,
registration and namespace-use checks, implementation comparison and existing tests. Explicit roots
matter in ignored `.claude/worktrees`: an empty bare `rg` result there is not evidence of no callers.
These are private workspace packages; undocumented consumers outside this repository cannot be ruled out.

## Changes, risk and evidence

### Project model and commands

| Change | Why it was removed or simplified | Risk and verification |
| --- | --- | --- |
| Automation `cutClips`, `adjustmentsIn`, `reactionSourceFlicks`, `styleStageNames`, `projectMediaOfSound`, `slideTrackLabel`, `REACTION_SKIP_CODES`, `MAX_AUTOMATION_SEED` | Definitions had no consumers; live planners use other implementations. | Private unused-export risk. Explicit-root searches plus automation, overlays and style suites. |
| Text-style `styleOverridesOf`, `linkedEffectiveStyle`, `mergeStyleFields` | Uncalled helpers; active commands already implement field merging. | Link/override semantics are covered by existing text-style tests. Updated stale documentation pointers. |
| Geometry/animation `vertexCount`, `apply4`, `framesOf`, graphics `FLICKS`, `documentExpressions`, `effectiveInInterpolation`, `hasKeyframes` | No imported or local callers, including same-name-symbol disambiguation. | Evaluator, expression, vector, graphics and animator tests retained. |
| Registry/schema `GLSL_TR_LIBRARY`, `defaultsOf`, `AXIS_TAG`, `BOTH_SIDED_INTERPOLATIONS` | Unused constants/helpers; active shader chunks and validators remain. | No shader body or persisted representation changed. Project typecheck and affected registry/keyframe suites. |
| Three handler JSON-copy implementations | Exact duplication of existing `commands/handlers/util.clone`. | Immer/detached-copy risk. Command results, exact undo/redo, sound upgrades/verdicts and acknowledgements tested. |
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
| Unavailable social card scaffold/private flag/helper | No imports; exhaustive variant map has real implementations for every variant. Test fallback branch was unreachable. | Every variant/theme still rendered by the test; engine-facing availability contract retained. |
| `isEmojiPackId`, `SocialTheme`, `SocialUnitProp`, `SocialHeartProp`, duplicate `SOCIAL_ENTRANCE_MS` | No consumers; live tween definitions retain entrance timings. | Motion/template typechecks, timing/schedule tests and anime gate. |
| `clampRating` and isolated test | Test was the only caller; production uses schema/randomization/render validation. | Remaining review tests retained; no rendering/schema change. |

Desktop, native renderer, root configuration and remaining scripts were also inspected; no further
evidence-backed deletion was made. Distinct span-merging semantics, platform fallbacks, parser bounds,
undo/refusal/invariant checks, compatibility APIs, process failure handling and persistence protections
remain. A low line count or a single caller alone was not a reason to delete useful coverage.

## Verification

Integration verification results and limitations are recorded here after the settled-tree gate.
