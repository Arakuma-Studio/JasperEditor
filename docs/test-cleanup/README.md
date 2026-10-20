# Test cleanup audit

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
