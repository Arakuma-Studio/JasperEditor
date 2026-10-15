# Test cleanup audit

This audit starts at `6c2baa39`. It covers the repository's unit, property, protocol,
rendering, browser, desktop, native and tooling tests. Individual dispositions were
recorded before edits. Regex searches identified candidates; decisions followed
inspection of the tests, their production owners, independent requirements and
remaining coverage.

Status: cleanup is implemented and integrated; repository validation is in progress.
This is not yet a completed-cleanup claim.

## Disposition records

Each record names the original tests, including deleted cases, and explains their
DELETE, REWRITE or KEEP disposition. Retained cases identify the independent
contract, observable failure, oracle, stable seam, refactor tolerance and unique
owner. Parameterized cases sharing one contract are recorded as a family.

| Area | Records |
| --- | --- |
| Project model, editing, effects and transitions | [1](project1.md), [2](project2.md), [3](project3.md), [4](project4.md) |
| Engine, media, persistence and export | [1](engine1.md), [2](engine2.md), [3](engine3.md), [follow-up](engine3-followup.md), [camera metric correction](camera-metric-correction.md), [remote upload regression](engine1-ssh.md), [AVC3 playback](avc3-playback.md) |
| Web editor | [1](web1.md), [2](web2.md), [3](web3.md) |
| Shared rendering | [1](compositions1.md), [2](compositions2.md) |
| Browser workflows | [1](e2e1.md), [2](e2e2.md), [motion-graphics harness repair](mg-bundler-repair.md) |
| MCP and CLI | [MCP](mcp.md) |
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

Integration also corrected two cleanup mistakes: the motion-graphics browser
protocol still needs the bundler's named-global option, and the camera accuracy
oracle must preserve best-fit alignment rather than use endpoint alignment. The
required bundler option is restored; the camera oracle uses an independent
straight-line derivation with the original tolerances and full trajectory span.
Neither correction restores unused production hooks.

The unused MCP testkit dependency was removed. The lockfile and third-party notices
were regenerated with the owning tools. Lockfile generation also normalized
existing Remotion/webpack peer resolutions; it added no package version.

## Verification

Validation remains in progress. Confirmed results so far:

- `pnpm lint`: passed Biome, tokens, anime, layer/cycle and asset checks.
- Workspace semantic typechecking passed across all packages. The initial run
  exposed two web fixture narrowing errors; the corrected web and testkit checks
  and `pnpm e2e:typecheck` subsequently passed. Final `pnpm build` also passed.
- Config/localization focused tests: 2 files, 9 tests passed.
- Public Remotion retry tests: all seven passed in the owning worktree, including
  the two setup-error regressions that first failed against the unfixed owner.
- Real rsync source-link regression: reproduced the missing partial file before
  the fix, then passed with the exact destination bytes and no partial file.
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
  After rebuilding the unpacked application from the final root build, the
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
  browser cases, and the edit/playback/native-export smoke cases now pass. Screenshot
  metadata, title creation, HDR export and remaining setup/accessibility deadlines
  are under investigation; they are not counted as passes.
- Initial opt-in Remotion run: 109 passed, 24 failed and four setup dependents
  skipped across 19 files. Failures occurred before image comparisons, during
  browser setup/readiness or the resulting layer-bake fallback. The ongoing
  one-worker recheck has passed all 19 compositor and nine text-animation cases.
- All five clip-extension cases passed after explicit setup-failure throws fixed
  TypeScript narrowing and an unsupported tooltip-absence assertion was removed.

The existing [baseline CI run](https://github.com/JasperRaccoon/JasperEditor/actions/runs/38635051386)
never started a step: its annotation says an Actions budget prevents further use.
Local verification remains necessary; this infrastructure refusal is not a test pass.

Full validation results and integrated change measurements will be recorded here
after the remaining gates. Per-area formatting checks and interrupted baseline
attempts are distinguished from runtime passes in the records above.

Independent review through `cd5f3535`, plus the smoke correction in `16c03941`,
reconciled all original declarations and assigned paths, the three added product
regressions, contract splits and transfers, and surviving support callers. The
clipboard workflow now makes the first-visual placement choice required by
CLB-010/SEQ-005/IN-008; its existing placement, media and artifact assertions remain
intact. Both clipboard workflows passed in the second browser run.
