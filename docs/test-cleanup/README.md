# Test suite cleanup: current pass

This pass starts at `8b4c8936` and integrates `origin/main` through `2d364873`
(merge `ac94a7fc`). The implementation measured by the final default run is
`c3268212`. Earlier evidence below the historical divider belongs to an older
cleanup and is not included in this pass's totals.

Status: implementation and workstream validation complete; final integrated
measurement, browser validation and delivery are in progress. Final results replace
this status before delivery.

## Scope and dispositions

All 5,722 original named JavaScript/TypeScript declarations in 843 files were
assigned exactly once: **160 DELETE, 392 REWRITE, 172 OPTIMIZE, 122 CONSOLIDATE,
4,876 KEEP**. The 15 declarations added by incoming remote commits were separately
audited: **6 DELETE, 6 REWRITE, 1 CONSOLIDATE, 2 KEEP**. Categories describe audit
decisions, including surviving consolidation owners; they are not counts of
physical deletions. Parameterized/generated cases are not inflated into named
declarations. Native tests and standalone desktop harnesses are recorded separately
in the tooling ledger; generated fuzz targets are recorded by their area owners.

The final source contains **5,500 named declarations in 831 files**, a net 222
fewer than the starting tree despite incoming tests and the two new real decoder
failure cases (one parameterized declaration). Rebuilt public renderer/indexer
owners and moved assertions are documented with their original declarations.
No quality or coverage percentage is inferred from these counts.

Measured diff at the final implementation commit:

| Basis | Test/support LOC | Production `src` LOC |
| --- | ---: | ---: |
| Starting tree `8b4c8936` | −7,630 | −263 |
| Integrated upstream `2d364873` (cleanup-only diff) | **−8,032** | **−338** |

Test/support includes `test`, `tests`, `e2e`, `.test.*`, `.spec.*`, testkit and
fixture/performance helper directories. Standalone upstream `bench` directories
are separate: their incoming 1,684 lines are unchanged by this cleanup. Audit
reports are also separate; the required test-by-test evidence adds documentation,
not tests. No dependency, lockfile, schema or shipped migration changed.

Each retained ledger row identifies its independent source, observable regression,
independent oracle, stable boundary, refactor tolerance and distinct owner. DELETE
rows identify the failed bar and surviving protection where applicable. Shared
file/family facts apply to the explicitly named rows; historical counts must not
be summed with this pass.

| Area | Current test-by-test evidence |
| --- | --- |
| Project core, loaders, migration and commands | [Core](project-core.md), [complete core inventory](project-core-inventory.md) |
| Project audio, sound checks and styles | [Sound](project-sound.md) |
| Project cues, placement and mixing | [Cues](project-sound-cues.md) |
| Project animation, easing and vector editing | [Animation](project-animation.md) |
| Project effects and transitions | [Effects](project-fx.md) |
| Engine media, jobs, cache, persistence and security | [Media](engine-media.md) |
| Engine export and render fidelity | [Rendering](engine-render.md) |
| Engine audio, planning and measurement workers | [Sound](engine-sound.md) |
| Engine library, indexing, packs and semantic search | [Library](engine-sound-library.md) |
| Engine Sound Check | [Sound Check](engine-sound-check.md) |
| Shared render compositions and browser audio/GL | [Compositions](compositions.md) |
| Audio DSP, effects, synthesis, expressions and motion | [Audio/motion](audio-motion.md) |
| Web core | [Core](web-core.md), [supplement A](web-core-supplement-a.md), [supplement B](web-core-supplement-b.md) |
| Web feature controls | [Features](web-features.md) |
| Web sound workflows | [Sound UI](web-sound.md) |
| Session, API, engine client, configuration, UI and testkit | [Shared](shared-followup.md) |
| MCP/CLI | [MCP](mcp-followup.md) |
| Browser workflows | [General](browser.md), [sound](browser-sound.md) |
| Tooling, desktop and native | [Tooling](tooling-followup.md) |
| Tests arriving during integration | [Incoming remote audit](incoming-remote.md) |

## Cleanup and regression protection

Removed the unused v2 project fixture and its attribution entry, the orphan mask
checksum snapshot, redundant non-gating benchmark tests, duplicate browser
walkthroughs, private collaborator/call-count assertions, source/export inventories,
unused fake-worker interfaces/factories, diagnostic globals/getters, reset hooks,
providers/adapters and constructor clock/limit overrides without production callers.
The area ledgers name the exact removed surfaces and remaining callers. Required
catalogue validation now runs in `pnpm lint`; it was not moved outside the CI gate.
No unused test dependency or runner configuration remained to remove.

Retained important expensive owners include shipped migrations/read-only
compatibility, atomic persistence and crash recovery, authentication/approvals,
actual worker crash/cancel/recovery, documented 20,000-file/50,000-sound bounds,
real model and shipped audio assets, 720p processing conservation, camera ground
truth, all GPU reference vectors/fingerprints, export parity, and critical browser
proposal/review/export/audio workflows. Lower tests cannot establish their wiring,
wire/artifact bytes or process/storage failures. No golden was re-blessed and no
pixel/sample tolerance was widened.

A stronger real-worker test exposed a production defect: a failed FFmpeg decoder
could produce a successful silent measurement. Two real-child regressions failed
before the fix. `PcmStreamReader` now observes process errors/nonzero exit and
propagates `BINARY_MISSING`/`TOOL_FAILED`, while deliberate cancellation remains
quiet. Completed audio/job tests and intended production mutations verify this
failure path. Other production edits remove unused test seams or accurately narrow
a static parameter type; upstream performance changes are preserved.

Three significant false-positive/reliability corrections were verified:

- The cache rename-failure fixture uses a deterministic filesystem fault; chmod
  does not reliably deny a root process. Entry integrity/orphan recovery remain.
- A fresh-frame render fixture was blank because its keys were authored in the
  wrong time coordinates. An independent literal PNG value now catches rendering
  the wrong frame even when the job succeeds; repeated restored artifacts match.
- Lazy engine loading caused a cold first test to exceed its five-second deadline.
  Static app imports were restored and existing cheap fixture utilities separated.
  Cold HTTP bodies passed twice at 624/660 ms; no timeout was raised.

Chrome 156's experimental native inset-canvas clipping affected the original shim
fixture independently of the shim. Event-driven, origin-aligned captures retain
both literal colors and catch a wrong receiver. The actual translated multi-layer
compositor also passed and its PNG was inspected. Shim removal does not reproduce
the older Chrome defect here; that limitation is explicit rather than replaced by
an implementation-option assertion.

## Performance

The complete command wall time fell from **2,111.47 s (35:11.47)** to
**1,929.07 s (32:09.07)**: **182.40 s saved, 8.64% observed improvement**.
Vitest's own durations were 2,109.71 s and 1,927.48 s. The baseline had two
fixture failures; the final command exited zero with no unhandled errors.

| Metric | Baseline | Final | Observed change |
| --- | ---: | ---: | ---: |
| Command wall time | 2,111.47 s | 1,929.07 s | −182.40 s / −8.64% |
| Aggregate child CPU, user + system | 6,730.80 s | 6,224.05 s | −506.75 s / −7.53% |
| Maximum single-process RSS | 1,731,308 KiB | 1,904,152 KiB | **+172,844 KiB / +9.98%** |

Memory did not improve by this measurement. GNU time reports the largest process,
not simultaneous process-tree memory; aggregate peak memory was not measured.
The first post-cleanup attempt took 1,941.89 s but failed on unfinished UI work;
its small subsequent fixture/resolver changes mean the two post runs are not
identical-source repetitions. Scoped alternate runs below provide additional
variance observations. No confidence interval or universal speedup is inferred.

Slowest file spans before/after (JSON end minus start, not whole process startup):

| File | Before | After | Why the remaining cost stays |
| --- | ---: | ---: | --- |
| `apps/engine/test/processing-steps.test.ts` | 201.619 s | 151.132 s | S07 real 720p frame/rate/audio conservation and independent quality thresholds |
| `apps/engine/test/camtrack-solve.test.ts` | 75.135 s | 75.574 s | Distinct camera/lens/motion regimes against synthetic ground truth |
| `apps/engine/test/processing-colour-range.test.ts` | 67.775 s | 36.726 s | True black/white after processing, both declared input ranges |
| `packages/compositions/test/fx-gl.test.ts` | 66.071 s | 65.916 s | Every supported shader's default/perturbed reference pixels |
| `apps/engine/test/sound-check.test.ts` | 59.516 s | 55.086 s | Real finding, repair, remeasurement and delivered-audio contracts |
| `apps/engine/test/sound-check-p6.test.ts` | 48.426 s | 47.267 s | Distinct real-audio Phase 6 findings and safe fixes |
| `apps/engine/test/audio-classify.test.ts` | 46.825 s | 47.963 s | Required ≥90% tuning/held-out accuracy across labelled signals |
| `apps/mcp/test/roto.test.ts` | 45.676 s | 45.869 s | Actual SDK create/propagate/render/export, IoU ≥0.93 and refusals |

The slowest final individual cases were MCP roto (45.869 s), held-out Auto Tag
(44.917 s), camera truth plus track reuse (38.940 s), and required 720p upscale
(37.456 s). The former largest case, all-method flat-patch denoising, fell from
69.966 to 22.260 s with the independently checked patch/margin and quality limits
preserved. Case-body timings and file spans exclude different parts of runner
startup; they must not be added to wall time. Cumulative worker import time remains
1,216.17 s versus 1,302.25 s; file isolation and real application boundaries remain
important costs. The relevant area ledgers justify each retained expensive owner.


The before/after default commands use Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11,
two workers, required FFmpeg/ffprobe oracles, Chrome 156.0.8078.47 and system FFmpeg
6.1.1, with generated fixtures already present and no vendored binary selected.
Machine: Linux x64, eight AMD EPYC-Genoa vCPUs, 15 GiB RAM, no swap. Both complete
measurements exclude concurrent agent suites. They are single whole-suite samples;
filesystem/compiler caches were not forcibly flushed on this shared host.
The host's later TypeScript interception is removed command-locally for final
validation; its preload leaves non-`tsc` programs untouched by source inspection.

Incoming upstream performance changes include resampler coefficient reuse, Find,
selection, sorting, derivative filtering and optional browser runtime loading.
Therefore the overall observed delta includes remote production improvements and
is not a cleanup-only causal estimate. No unmeasured end-to-end CI saving is
claimed. Scoped alternate runs provide narrower cleanup evidence; their shared-host
load/variance and exact commands are recorded in the linked ledgers:

| Scoped workload | Before | After | Measured result |
| --- | ---: | ---: | --- |
| Four export/render hotspots, ABBA mean | 93.264 s | 50.118 s | −46.26% |
| Twelve audio/motion files, ABAB median | 37.399 s | 23.396 s | −37.44% |
| Five web core files, median | 27.186 s | 21.109 s | −22.35% |
| Shared UI/session subset, three-pair median | 14.797 s | 11.028 s | −25.47% |
| Seven changed general browser specs | 163.93 s | 112.41 s | −31.43%; repeat 111.00 s |
| Composition subset, two samples per version | 30.096 s | 30.413 s | **No wall-time improvement** |

These overlapping subsets must not be added together or extrapolated to CI.
Deleting a redundant lag search was justified by the retained full-sample bounds
catching a real one-sample production delay; process variance hid any wall gain.
Worklet capture uses a real flush acknowledgement instead of a 300 ms sleep:
ten captures averaged 340.56→39.01 ms, repeat 31.38 ms, preserving block/sample data.
Pure helper imports avoid repeated engine initialization, batched frame decoding
avoids repeated processes, and smaller media retain the documented spatial/temporal
window and unchanged oracle tolerance. Real worker/resource-limit coverage can cost
more than its former fake; those important contracts remain.

## Validation and limitations

PENDING_FINAL_VALIDATION

Root commands (the full test command records default text, JSON and GNU time):

```sh
pnpm lint
env NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck
env -u NODE_OPTIONS pnpm e2e:typecheck
pnpm notices --check
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm test --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/final.json
```

The integrated focused command also ran eight changed files (62 cases), including
all rewritten incoming unit contracts and real measurement-worker lifecycle tests.
The workstream ledgers record every scoped command, opt-in render/browser suite,
mutation failure, restoration, timing sample and earlier fixture/setup correction.
Raw root evidence is under `/tmp/jasper-test-cleanup/`; test/generated artifacts
remain ignored and are not committed as licensed media or golden replacements.

Baseline: 7,661 passed, two failed, 248 skipped. The complete baseline did not stop
on its failures. Both retained failures (root-permission fixture and native canvas
placement) were investigated and corrected as described above. Baseline TS5115 in
the MCP test helper was independently reproduced and resolved with standard JSON
validation plus an explicit object-root guard. New helper self-tests that merely
pinned its schema implementation were deleted after remote integration.

The first complete integrated attempt ran every default file: 7,380 runtime cases
passed and 232 cases skipped in 1,941.89 s command wall time, but an unhandled
React rejection after `sound-style.test.tsx` teardown made the command fail. Its
request-receipt wait did not await the outstanding plan/dialog operation. This is
not reported as a passing gate or as the final performance sample. The async
fixture correction and final rerun are recorded above; no unhandled-error filter,
retry or disabled case was used.

Root lint initially found a formatting conflict in the merged ELF fixture import;
formatting only that changed import restored the gate. Two existing lint warnings
remain. The repository's actual TypeScript compiler exceeded Node 20's default
heap in the engine check; the four-GiB command passed. The same command-local heap
is used for the web build. CI pins Node 20.19, so its existing Typecheck and Build
steps now carry this verified allowance; the Test step retains its two-worker/default-heap
configuration. No compiler check was suppressed or dependency upgraded.

Node 24 probing found five pre-existing synth byte-pin differences. The independent
sound-design contract explicitly pins bytes for a given Node/V8 and treats runtime
math changes as a release-version decision. Pins, synthesis output and version
were preserved; Node 24 is not claimed green. Rust/cargo is absent from the host's
standard installations, so native Rust execution is unverified. Extended fuzz,
unchanged opt-in rendering and packaged desktop suites are not implicitly covered
by the default gate. Exact supplemental results/skips are listed above when run.

## Git delivery

Branch: `test/contract-cleanup`. Remote `origin/main` was fetched and integrated
without rewriting history; its 15 new declarations received the same audit. The
final delivery message records the pushed commit and verified remote result.
No unrelated working-tree changes were present initially, no shared stash or
force push was used, and only task files are committed.

---

# Historical audit starting at 6c2baa39

This audit starts at `6c2baa39`. It covers the repository's unit, property, protocol,
rendering, browser, desktop, native and tooling tests. Individual dispositions were
recorded before edits. Regex searches identified candidates; decisions followed
inspection of the tests, their production owners, independent requirements and
remaining coverage.

Status: cleanup is implemented and integrated. The complete repository gate
passed; specialized evidence and remaining platform/model limits are recorded below.

## Disposition records

Each record names the original tests, including deleted cases, and explains their
DELETE, REWRITE or KEEP disposition. Retained cases identify the independent
contract, observable failure, oracle, stable seam, refactor tolerance and unique
owner. Parameterized cases sharing one contract are recorded as a family.

| Area | Records |
| --- | --- |
| Project model, editing, effects and transitions | [1](project1.md), [2](project2.md), [3](project3.md), [4](project4.md) |
| Engine, media, persistence and export | [1](engine1.md), [2](engine2.md), [3](engine3.md), [follow-up](engine3-followup.md), [camera metric correction](camera-metric-correction.md), [remote upload regression](engine1-ssh.md), [AVC3 playback](avc3-playback.md), [processing lifecycle](engine1-processing-lifecycle.md) |
| Web editor | [1](web1.md), [2](web2.md), [3](web3.md), [guide-toggle correction](web1-guide-lock.md) |
| Shared rendering | [1](compositions1.md), [2](compositions2.md) |
| Browser workflows | [1](e2e1.md), [2](e2e2.md), [motion-graphics harness repair](mg-bundler-repair.md) |
| MCP and CLI | [MCP](mcp.md), [UI window response regression](mcp-ui-window.md) |
| Audio, motion and motion-graphics templates | [Audio and motion](audio.md) |
| Interchange and expressions | [Formats](formats.md) |
| Session, API, client, configuration, UI and testkit | [Shared packages](shared.md) |
| Tooling, Electron, standalone checks and Rust | [Tooling](tooling.md) |

The review explicitly checks cross-area deletion dependencies: a model test does
not establish UI wiring, a valid rendered frame does not establish an export
refusal, and two areas cannot delete a contract while citing each other's removed
tests. Documented API/configuration values survive even when an inventory-like
assertion initially looks redundant. Visual regressions have an independent
repository requirement in [testing.md](../testing.md).

The independent [cross-review](cross-review.md) records the reconciled inventory
and 15 resolved findings, including retained regressions and false-positive tests.
The final [oracle review](oracle-review.md) records the follow-up source audit,
cross-owner transfers and resolved provenance/counting corrections.
The [GL integration review](gl-review.md) independently checks the later fingerprint
and named shader contracts, including preserved inputs, render order and tolerances.

The inventory covers 4,451 original named TypeScript/JavaScript declarations in
627 assigned paths, plus native/desktop families and 22 executable performance
budget rows. Parameterized families are not inflated into individual runtime cases.
The [counting-basis reconciliation](counting-basis.md) distinguishes named
declarations from dynamic/fuzz families, native tests and supplemental decisions.
The area headings therefore must not be summed into a global disposition total.

At `404b8d81`, the diff from the audit baseline removes a net 26,738 lines from
tests and their support across 494 changed files. Other production files under
`src` are net 747 lines smaller. These are diff measurements, not coverage or
quality percentages. Test/support classification includes `test`, `tests` and
`bench` directories, `.test.`/`.spec.` files, `e2e`, `packages/testkit`,
`scripts/perf` and `scripts/fixtures`; audit documentation is counted separately.

## Removed support and product correction

The area ledgers record removed private exports, duplicate shader/CPU mirrors,
injected clocks and file-system wrappers, cache/invariant inspection hooks,
GL-poison instrumentation, scene-distinctness guards, unused canonicalizers,
local fixtures and gallery-only test entries. Browser helper branches and four
unused audio-fixture recipes were removed after an integrated caller census.
Published documentation pictures still have consumers and retain their provenance.

An additional integrated caller search found no remaining imports of
`scripts/docs/gallery-scenes.mjs`. Its executable recipe remains the reproducible
source of published pictures, but its `sceneA`/`sceneB` test-only exports and the
orphan `gallery-scenes.d.mts` declaration file were removed. The remaining caller
is the same-file CLI entry point; executable statements are unchanged. Validation:
repository lint/typecheck and `node --check scripts/docs/gallery-scenes.mjs`.

The strengthened public audio block contract exposed a real product bug: multiple
processors modified channels beyond their configured count. The original and
expanded mono/stereo cases failed before the owner fix; the expanded case then
passed. Processing loops and stereo branches now respect the configured count,
including the Studio Reverb delay network. The full evidence is in [audio.md](audio.md).

Two further retained failures exposed owner bugs. Remote rsync uploads skipped
symlinked library sources and then failed renaming a missing partial file; uploads
now copy the selected file's referent bytes, matching the SCP path. Composition
selection failures escaped the render service's typed error mapping; SDK setup
failures now preserve timeout and cancellation codes. Three focused regressions
failed before these fixes and passed afterward. They are recorded separately from
the original-test census; no retry or timeout budget was increased.

Browser verification exposed two more public response defects. Web screenshot
metadata predicted rounded dimensions that differed from the encoded PNG; it now
reports the dimensions decoded from the unchanged PNG bytes. The existing browser
case checks those protocol values and the requested panel's public bounds. All
five automation workflows passed with the fix. MCP `ui_state` also overwrote its
promised window dimensions and pixel ratio when attaching the answering session's
identity. A guarded merge preserves both, with relay identity authoritative. One
new SDK regression failed before that fix and passed afterward, bringing the
separately recorded new regression declarations to four.

Integration also corrected two cleanup mistakes: the motion-graphics browser
protocol still needs the bundler's named-global option, and the camera accuracy
oracle must preserve best-fit alignment rather than use endpoint alignment. The
required bundler option is restored; the camera oracle uses an independent
straight-line derivation with the original tolerances and full trajectory span.
Neither correction restores unused production hooks. A later reference-setup
review found one remaining private exporter call in the GPU span test. That
reference now uses the public render-snapshot API and signed media handles;
all ten frames, pixel tolerances, cache assertions and deadlines remain unchanged.
Engine semantic typechecking and the rewritten GPU case passed on `30a8430e`;
all ten comparisons met the original tolerance and repeat export reused the cached
masters. The earlier run is kept as historical evidence in
[engine2.md](engine2.md#gpu-span-reference-setup-follow-up--before-edit-record).

The unused MCP testkit dependency was removed. The lockfile and third-party notices
were regenerated with the owning tools. Lockfile generation also normalized
existing Remotion/webpack peer resolutions; it added no package version.

## Verification

The final sequential gate at `cb9574ce` has passed lint, all workspace semantic
typechecks, browser-test semantic typechecks and the complete default suite.
The suite passed **5,140 cases across 492 files**, with zero failures and
195 explicit opt-in skips (30 files wholly skipped), in 6,116.59 seconds.
It ran with one worker, required oracles and portable PowerShell available,
and exited 0. All 16 processing-step cases passed; the unchanged upscale
acceptance case took 149.55 seconds. The final `pnpm build` also exited 0; all
five sequential stages completed successfully. Only documentation changed after
the recorded source commit. Build output includes third-party annotation and
large-chunk warnings; no warnings were suppressed. Earlier results below remain
separately identified; a later pass does not erase their failures.

Execution evidence is retained under `/tmp/jasper-test-prune2/`: the
`complete-gate-results.json` manifest, per-stage `complete-gate-*.log` files,
`complete-gate-tests.json` and `complete-gate-tests.events.jsonl`. Commands are
`pnpm lint`, `pnpm typecheck`, `pnpm e2e:typecheck`,
`JASPER_REQUIRE_ORACLES=1 pnpm test --maxWorkers=1` and `pnpm build`; the run
also sets `JASPER_PWSH` to the verified portable executable described below.

Other validation and earlier attempts:

- Initial whole-repository run completed: 450 files passed, 39 failed and 30
  opt-in files skipped; 3,928 cases passed, 69 failed and 221 skipped or blocked
  by setup failures. Its six-hour run overlapped later source corrections, so it
  is neither a final-source gate nor an overall pass. Final diagnostics identify
  watchdog/setup failures, already corrected oracle defects, and an unsupported
  monitor-guide assertion subsequently removed as described below.
- The earlier sequential repository gate passed `pnpm lint` (2,473 Biome files,
  tokens, anime, layer/cycle and assets) and all workspace typechecks. Its full
  one-worker test run finished in 13,056 seconds with required oracles and
  PowerShell available: 491 files and 5,139 cases passed, one file/case failed,
  and 30 files/195 cases were explicitly skipped. Exit status was 1, so the
  chained build did not run. The upscale preservation case
  exceeded its unchanged 600-second watchdog. Its output completed about 73 seconds
  later and passed the independently checked frame/rate/codec/color/audio artifact
  assertions; the returned result object was no longer available for inspection.
  S07 explicitly requires the 720p acceptance fixture, so that fixture and deadline
  remain unchanged. A focused rerun with the integrated lifecycle helper passed
  the unchanged upscale case in 33.9 seconds (one selected case; fifteen excluded
  by the filter). Different host conditions preclude a performance comparison;
  this targeted pass does not turn the preceding failed gate into a pass. The
  test's uncancelled abort signal also allowed its work to overlap the following
  case. The integrated lifecycle correction retains that controller and requests
  cancellation before joining the operation at test completion. Its real-process
  probe established cancellation and JavaScript settlement in about 93 ms, but
  failed the stronger isolation criterion: the encoder survived briefly after
  the next test began and wrote another 1,286,423 bytes. No full child-reaping
  guarantee is claimed. The public CLI/job cancellation owner adds termination
  and partial cleanup omitted by that probe; its retained regression passed.
  Every other previously failing default contract, including guide preferences
  and the Lumetri budget, passed in this completed gate.
- Workspace semantic typechecking passed across all packages. The initial run
  exposed two web fixture narrowing errors; the corrected web and testkit checks
  and `pnpm e2e:typecheck` subsequently passed. An integrated `pnpm build` also
  passed; later changed web and MCP packages were rebuilt separately.
- Config/localization focused tests: 2 files, 9 tests passed.
- Public Remotion retry tests: all seven passed in the owning worktree, including
  the two setup-error regressions that first failed against the unfixed owner.
- Real rsync source-link regression: reproduced the missing partial file before
  the fix, then passed with the exact destination bytes and no partial file.
- All camera-solve cases passed in the fresh default gate, including fixed focal
  length, variable zoom and radial distortion. This exercises the corrected
  independent best-fit trajectory metric with the original accuracy tolerances.
- AVC3 browser playback: both Chrome and Electron cases passed after replacing
  callback-count quotas and the mismatched callback/pixel oracle with immutable
  frame snapshots. Every sampled frame still has an exact source-code assertion;
  literal join/seek targets, completion checks and original outer deadlines remain.
  The owner semantic typecheck and independent review passed. Failed and interrupted
  intermediate candidates are disclosed in [avc3-playback.md](avc3-playback.md).
- `cargo test --workspace --manifest-path native/mg/Cargo.toml --locked -j 1`:
  13 tests passed, no failures.
- `pnpm ffmpeg:check`: all inspected FFmpeg artifacts passed LGPL checks.
- `pnpm notices --check`: generated notices are current.
- `pnpm i18n:check`: Spanish covers all 8,615 generated strings.
- `pnpm build` and `pnpm --filter @jasper/engine build:remotion`: passed. Browser
  E2E preparation also completed fresh engine, Remotion, web and MCP builds.
- Final sync/remix/registry recheck: 3 files and 149 tests passed with required
  oracles and two workers. Earlier aggregate audio watchdog failures are not passes;
  this result verifies the final per-contract cases.
- Audio preview/mixer parity: all 60 effect cases and the automation case passed
  in the owning worktree. Each original input, block schedule and sample equality
  assertion is preserved; the cumulative watchdog change is disclosed in
  [compositions2.md](compositions2.md).
- Final GPU recheck: 7 files and 1,071 tests passed with required oracles and two
  workers, including all effect/transition fingerprints and the revised family
  contracts. Golden inputs, pixel tolerances and committed golden records remain
  unchanged; the per-contract reporting change increases the cumulative watchdog
  allowance, as disclosed in the area ledgers.
- Real speech-model validation: all five cases passed together in the integrated
  default run, following an earlier isolated capability recheck. English WER was
  1.92%, multilingual WER 5.77%, and trimmed sequence WER 6.15%; measured
  word-boundary mean/max errors were 18/40 ms.
- Windows opener security oracle: all 21 unchanged cases passed with official
  portable PowerShell 7.6.7, including the 14 previously skipped cases. The archive
  checksum matched both official release metadata and the published hash manifest.
  This exercises PowerShell Core on Linux; actual Windows/Explorer execution is
  not claimed. No runtime was added to the repository or installed globally.
- `pnpm mg:build`: native release build completed. The four native/TypeScript
  parity tests passed; their title-card raster pair was also inspected visually.
  The two native-dependent cases subsequently passed together with a captured
  exit 0 (22.55 seconds of test execution), resolving their earlier parent-runner
  interruption qualification.
  The first companion bundle command terminated with exit 143 before completion;
  no cause is established and no interrupted case counts as a pass. Its completed
  rerun passed 16 cases and failed three: a five-second route watchdog, a hybrid
  export that completed after its wait deadline, and a bundle build timeout. The
  route case subsequently passed in the default run. Both remaining cases then
  passed unchanged in a focused one-worker run: hybrid text export in 499.8 seconds
  and watched-project rebuild in 42.2 seconds.
- Native animated export: all seven cases passed, including the 48-frame
  preview/export comparison (minimum/mean SSIM 0.9935/0.9956), subpixel motion,
  authored crop geometry and audio volume envelopes.
- Linux x64 unpacked application build: passed, including the final LGPL guard
  over ten FFmpeg artifacts. Packaged-like and development desktop smoke checks,
  all four desktop clipboard cases and the native-renderer fallback check passed.
  The first packaged export check reached a retryable browser setup timeout.
  After rebuilding the unpacked application from the then-current root build, the
  unchanged packaged check passed: a 30-frame H.264 export used the packaged LGPL
  binaries without PATH FFmpeg/ffprobe.
- `pnpm perf --sections micro --label test-cleanup-integration`: passed all six
  scripts, including the scale benchmark. AMD Ryzen 7 7700, 16 logical CPUs,
  Node 20.20.2; starting load averages 154.9/147.2/145.5. Reports are in
  `test-results/performance/`; no comparable before/after speedup is claimed.
- Initial browser run: 51 passed, eight failed and four serial dependents did not
  run. The failed traces are preserved. The clipboard's required first-placement
  choice and the motion-graphics bundler namespace are corrected; smoke playback
  now observes progress and an interior pause position, excluding natural-end
  false passes. The second run of eight whole files passed 13 cases, failed six
  and left one serial dependent blocked. Both clipboard cases, both motion-graphics
  browser cases, and the edit/playback/native-export smoke cases now pass. The
  screenshot fix subsequently passed all five automation browser cases, two focused
  unit cases, web/browser semantic checks and a fresh web build. Title creation now
  selects the public Type Tool button. A third run of five whole files recorded
  nine passes and two deadline failures; its outer process returned 143 after
  printing the complete report, with no established signal sender. All three
  smoke workflows passed, including a 329-frame LGPL H.264 Remotion movie whose
  extracted frame visibly contains the title and lower third. Download recovery,
  both interchange workflows, PQ preview and linear-light preview also passed.
  Accessibility was subsequently verified as described below. The full-HD HDR
  export was still advancing when its outer deadline expired and has not reached
  a verified pixel/metadata result. The uniform-color fixture now uses 320×180
  through the public sequence settings command, preserving its 90 frames,
  30000/1001 fps, rendering path, color settings, numeric/tag assertions and
  original deadlines. The complete three-case file then passed in 1.6 minutes;
  HDR export finished in 57.3 seconds with all original pixel/tag assertions.
  The preserved movie is 90 frames of 320×180, 30000/1001 fps, 10-bit PQ ProRes
  with mastering metadata and MaxCLL 203. Its extracted frame and the linear-light
  preview were inspected visually. Full-HD HDR completion and performance remain
  unproven.
- Browser discovery reconciles 74 current cases across 26 files. Accumulated
  evidence now records a pass for all 74 cases, including all three
  color-management cases with the new fixture. These results come from the runs
  described above, not one passing full run at the final HEAD.
- Initial opt-in Remotion run: 109 passed, 24 failed and four setup dependents
  skipped across 19 files. Failures occurred before image comparisons, during
  browser setup/readiness or the resulting layer-bake fallback. The
  one-worker recheck passed all 19 compositor and nine text-animation cases,
  then was interrupted with exit 143 before its final report. Fourteen file
  verdicts recorded 114 case passes, 11 failures and 15 cases blocked by setup;
  four files had no verdict. This interrupted batch is not an overall pass.
  Subsequent focused runs completed the outstanding render and Player checks,
  including GPU span parity/cache reuse, parallel bake parity/cancellation and
  shape raster accuracy. Their artifacts were inspected. The first complete
  motion-determinism run passed five cases and failed selecting the shuffled
  composition before its pixel comparison. A real React/Remotion diagnostic
  reproduced readiness becoming true before all compositions registered. The
  fixture now holds public render readiness until a subsequent React commit;
  every frame, order, comparison and deadline is preserved. The full six-case
  browser rerun passed with captured exit 0 in 177.73 seconds, including the
  shuffled-order comparison. [audio.md](audio.md) records the diagnosis and
  setup-only rewrite. The GPU public-reference rerun and the three previously
  interrupted edit-structure cases passed with captured exit 0. Reconciliation now
  records applicable passing evidence for all 177 cases across all 30 opt-in files;
  this is accumulated case evidence, not one passing 177-case invocation.
- The new MCP window-response regression passed after failing on the original
  response merge. MCP semantic typechecking and the integrated MCP bundle build
  passed. An earlier interrupted typecheck and a corrected test-stub cast are
  recorded separately in [mcp-ui-window.md](mcp-ui-window.md).
- MCP specialized verification passed with captured exit 0: the composition
  import/place/edit/render workflow and all seven scenario-QA cases, including
  export/re-import fidelity and cancellation without a leftover file. Composition
  before/after images and export/re-import frames were inspected. Both commands
  used the existing authenticated harness and unique appdirs/ports.
- All five clip-extension cases passed after explicit setup-failure throws fixed
  TypeScript narrowing and an unsupported tooltip-absence assertion was removed.
- The monitor-guide case now checks only the documented preference commands.
  Its unsupported assumption that locking guides disables Clear was removed;
  a proposed synthetic-drag replacement was rejected because it bypassed CSS hit
  testing. All seven monitor cases and web semantic typechecking passed. Real
  browser guide dragging is outside this case's coverage; see the
  [six-bar correction record](web1-guide-lock.md).
- All twelve accessibility workspace/theme cases passed in one ordered browser
  run (3.3 minutes), with JSON reports and screenshots retained. The same shared
  page/project, twelve states, actions, axe rules and zero-serious/critical
  assertions remain. Parameterizing the former aggregate case increases its
  effective allowance from 180 seconds total to 180 seconds per state, plus
  setup hooks; this is explicitly disclosed in [e2e2.md](e2e2.md). It is not a
  performance improvement claim. The high-contrast Effects artifact was also
  inspected visually.
- A one-worker recheck of 16 previously failing files passed 110 cases and failed
  one grading-scopes case on its unchanged five-second watchdog. That case then
  passed alone in 3.262 seconds. These runs also cleared the CLI cancellation,
  decoding, expression sandbox, LGPL export/proxy and Lumetri budget failures.
  They do not turn the original whole-repository run into a pass. An earlier
  traced attempt was deliberately interrupted after measurement found CPU
  saturation, inherited nice 10 and substantial runnable-wait time. The completed
  rechecks ran untraced at normal priority under the same unprivileged user; only
  each new command's own shell priority changed. No assertion or deadline changed,
  and differing host conditions preclude a single-cause performance comparison.

The existing [baseline CI run](https://github.com/JasperRaccoon/JasperEditor/actions/runs/38635051386)
never started a step: its annotation says an Actions budget prevents further use.
Local verification remains necessary; this infrastructure refusal is not a test pass.

The passing web assertions do not imply clean stderr. The effect-preset file
emits React’s render-time state-update warning for `KeyGlyph` / `SummaryLane2`,
also present in two earlier integrated runs. Both relevant production owners
(`MiniTimeline.tsx` and timeline `canvas.tsx`) are unchanged from `6c2baa39`;
source inspection identifies a possible pre-existing synchronous style-token
invalidation path during rendering. Its exact runtime cause was not instrumented. The initial baseline stopped before this file, so a
direct pre-cleanup runtime reproduction is not claimed. No warning was suppressed
and no unrelated rendering change was introduced.

Validation limits remain explicit: actual Windows/Explorer execution, a real
credentialed SSH host, optional ML rotoscoping models and the extended `FUZZ=1`
campaign have not been exercised. PowerShell Core, real local rsync, the default
fuzz/property suites and available model oracles do not establish those results.

The 195 cases skipped by the default run are fully mapped: 177 Remotion, two
native-parity, six motion-graphics bundle, one MCP composition and seven MCP QA
cases have separate passing evidence (193 total). The remaining two are the
credentialed SSH workflow and SAM model installation/segmentation. There are no
unmapped skips; this accumulated evidence does not imply one combined passing
invocation.

The completed gate and integrated change measurements above supersede pending
validation notes in the earlier area records. Per-area formatting checks and
interrupted attempts remain distinguished from runtime passes. The final fetch
found `origin/main` unchanged at `6c2baa39`, so no incoming tests required another
audit. Source and test files are unchanged from the successful gate.

Independent review reconciled all original declarations and assigned paths,
the four added product regression declarations, contract splits and transfers,
and surviving support callers. The final bounded static review at `404b8d81`
found no unresolved disposition,
coverage, support-caller or accidental production-change issue. The earlier
review missed the private GPU reference call; the follow-up identified it,
reviewed its public-seam rewrite and checked the corresponding runtime evidence.
Guide, accessibility, HDR, processing-lifecycle and motion-readiness corrections
retain their six-bar records and limitations. This static result does not
substitute for the completed runtime gate reported above. The
clipboard workflow now makes the first-visual placement choice required by
CLB-010/SEQ-005/IN-008; its existing placement, media and artifact assertions remain
intact. Both clipboard workflows passed in the second browser run.
