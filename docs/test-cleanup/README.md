# Test suite cleanup: current pass

This pass starts at `8b4c8936` and integrates `origin/main` through `69c96e3b`
(merges `ac94a7fc` and `b5303967`). The final implementation is `797e53fc`.
`c3268212` is the earlier measured checkpoint before the second remote integration.
Evidence below the historical divider belongs to an older cleanup and is not
included in this pass's totals.

Status: cleanup, full default tests, lint, TypeScript, notices, production/Remotion
builds, LGPL verification and supplemental PowerShell checks passed.
The complete 53-spec browser run and the separate 14-case transport repeat also
passed, with only the two existing dependency/opt-in browser skips documented below.

## Scope and dispositions

All **6,063 original and incoming named JavaScript/TypeScript declarations** received
one disposition. The latest follow-up intervention supersedes an earlier area row;
an unchanged KEEP during a re-audit does not erase an earlier rewrite/optimization.

| Audit input | DELETE | REWRITE | OPTIMIZE | CONSOLIDATE | KEEP | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original declarations | 160 | 410 | 166 | 125 | 4,861 | 5,722 |
| First incoming additions | 6 | 6 | 0 | 1 | 2 | 15 |
| Second incoming additions | 52 | 112 | 16 | 32 | 114 | 326 |
| **Unique audit inputs** | **218** | **528** | **182** | **158** | **4,977** | **6,063** |

The second integration also re-audited 163 existing owners: 489 rows total,
including 21 dip-property owners and three import owners outside the changed paths.
These overlap
the original audit and must not be added again. Fourteen original decisions were
updated by that integration; two existing joint-fix owners were subsequently
rewritten during the final caller review, bringing original follow-up updates to 16.
Consolidation includes both removed scenarios and their
surviving owners; disposition totals are not physical deletion counts.

The final source contains **5,744 named declarations in 872 files**, versus 5,722
in 843 files initially. This includes the incoming features and replacement owners.
Parameterized/generated cases are not inflated into declarations. Native tests,
standalone desktop harnesses and generated fuzz families are recorded separately
in their area ledgers. No quality or coverage percentage is inferred from counts.

| Diff basis | Test/support LOC | Production `src` LOC |
| --- | ---: | ---: |
| Initial `8b4c8936`, including incoming features | +7,612 | +10,728 |
| Integrated upstream `69c96e3b` (**cleanup-only diff**) | **−10,195** | **−441** |

Incoming work added substantial features, tests and compatibility fixtures; the
cleanup itself removes over ten thousand test/support lines. Test/support includes
`test`, `tests`, `e2e`, `.test.*`, `.spec.*`, testkit and fixture/performance helper
directories. Standalone upstream `bench` directories are separate: their incoming
1,684 lines are unchanged by this cleanup. Required per-test audit documentation is
also separate. No dependency, lockfile or agent instruction changed. Schema v8,
its migration/fixture and the golden changes came from upstream and are preserved;
no shipped migration was edited by the cleanup.

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
| Second incoming keyframe/easing work | [Keyframes](incoming-wave2-keyframes.md) |
| Second incoming model, persistence and history work | [Model](incoming-wave2-model.md) |
| Second incoming interchange and expression work | [Interchange](incoming-wave2-interchange.md) |
| Second incoming font parsing, storage and rendering work | [Fonts](incoming-wave2-fonts.md) |
| Second incoming media, relinking and audio work | [Media](incoming-wave2-media.md) |
| Second incoming render/export work | [Rendering](incoming-wave2-render.md) |
| Second incoming composition and live-media work | [Compositions](incoming-wave2-compositions.md) |
| Second incoming web/MCP work | [Web and MCP](incoming-wave2-web-mcp.md) |

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
wire/artifact bytes or process/storage failures. No cleanup golden was re-blessed and no independently justified pixel/sample
tolerance was relaxed. Invalid expectations calculated by the implementation were
replaced by documented physical bounds or stronger public owners. Upstream
feathered-crop pixels and three added Slide fingerprints were inspected and tested.

A stronger real-worker test exposed a production defect: a failed FFmpeg decoder
could produce a successful silent measurement. Two real-child regressions failed
before the fix. `PcmStreamReader` now observes process errors/nonzero exit and
propagates `BINARY_MISSING`/`TOOL_FAILED`, while deliberate cancellation remains
quiet. Completed audio/job tests and intended production mutations verify this
failure path. Other production edits remove unused test seams or accurately narrow
a static parameter type; upstream performance changes are preserved.

The complete browser run also exposed a real Sound Check click defect. Selecting
a finding on pointer-down scrolled its Fix button 43 px before release, losing the
click. Changing row selection to click alone exposed a second path: bubbled button
focus initialized another finding and scrolled again. Row selection now follows
activation, and only direct list focus initializes keyboard selection. Both failed
variants were reproduced against an isolated copy of the actual failed project;
the final fix passed one physical click and Cancel in both original and floating
layouts, with unchanged document bytes. All 18 existing panel cases and actual web
TypeScript passed. The unchanged full workflow remains the regression owner;
no retry, second-click workaround or relaxed assertion was added. See the
[work note](../wp-notes/sound-design.md#sound-check-finding-actions-selection-must-follow-pointer-activation)
for preserved traces and source-map proof.

The final caller review removes two more internal test-only options: confirmation
injection and rerun suppression, plus the unused confirmation-helper export. The
existing joint-fix cases now use the real DialogHost/Cancel and default production
flow. They retain the independent 4.0 LU safety risk, committed gains, skipped
finding and one undo entry; self-template/wording assertions are gone. A real
rejudgment-bypass mutation fails the required dialog, restored source passes,
and cleanup settles outstanding dialogs before unmounting. Both ledger rows are
REWRITE; no named declaration was added or removed.

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

The final browser review removed all internal audio-recording retries/discards,
private source-player traces and proposal scheduling assertions. Every intended
stress play remains; failed output is no longer replayed. An actual flush mutant
failed the retained lower waveform owner while obsolete C2b still passed, justifying
its consolidation. The restored lower test passed.

The second integration removed unused CPU shader/reference helpers, the test-only
`cropCoverageAt` wrapper, fake font clock/limit controls and helper identity probes.
Native crop uses the real preview edge-profile primitive as a differential oracle;
that primitive separately has independent numerical/literal tests. Existing public
preset save/overwrite owners now catch the detached-crop regression directly.

The final import review removes an optional Python subprocess and same-code ZIP
round-trip assertions. ZIP output is now checked against independent protocol/CRC
observations; deflate and read limits use a separately generated valid archive.
Private FFmpeg-argument probes are consolidated into a public variant job and its
served PNG: known linear EXR greys must become sRGB and retain distinctions smaller
than one 8-bit step, while TIFF output retains 16-bit depth. CRC corruption, ignored
read limits, omitted transfer and 8-bit-then-upcast mutants each fail these owners.

Two incoming font negatives were repaired rather than weakened: a malformed WOFF2
fixture previously passed even without length checks, and all render paths could
silently use a different fallback face. Genuine valid font payload plus a surplus
byte now detects the wire violation. A public fallback-styled control makes failed
library loading produce zero changed glyphs; the real loading mutant now fails.
The documented 1,000-font/2 GiB bounds are tested at the actual limits, without
production override hooks. Real Source/Program codec consumption now observes
decoded pixels, output PCM frequency and pending silence instead of mocked media
props. Ordinary transport timing remains with real-app P0/P6.

## Performance

At the final implementation `797e53fc`, the complete supported-binary run took
**1,936.38 s (32:16.38)** command wall time; Vitest reported 1,934.77 s. It passed
7,689 cases, with 239 explicit skips across 824 files (786 passed, 38 wholly
skipped), and no failures or unhandled errors. Aggregate child CPU was
**6,078.34 s**; maximum single-process RSS was **1,552,728 KiB**.

This final workload includes the second incoming feature batch, the newly available
HEIF fixture and verified pinned LGPL 7.1.5 engine binaries. The normal E2E
preparation regenerated H.264 fixtures with OpenH264 before this final run;
representative fixture SHA-256 values are recorded. Standalone PATH FFmpeg/ffprobe
oracles remain system 6.1.1. Its Node, two-worker and Chrome settings match the
earlier runs, but its feature/fixture/tool workload differs. Therefore **a direct
baseline-to-final speedup percentage is not claimed**. The comparable earlier
checkpoint and its limitations are reported separately below. No CI pipeline wall
time or aggregate process-tree peak memory was measured.

Final JSON file spans (end minus start, excluding process startup):

| File | Final span | Distinct retained contract |
| --- | ---: | --- |
| `apps/engine/test/processing-steps.test.ts` | 128.484 s | Real processing preserves frame count/rate/audio and specified quality bounds |
| `apps/engine/test/camtrack-solve.test.ts` | 78.093 s | Camera, zoom and lens solutions against independent synthetic truth |
| `packages/compositions/test/fx-gl.test.ts` | 68.371 s | Every supported shader's reference pixels, including perturbed settings |
| `apps/engine/test/processing-colour-range.test.ts` | 64.750 s | Actual processed black/white for both declared input ranges |
| `apps/engine/test/sound-check.test.ts` | 48.841 s | Real findings, fixes and remeasurement of delivered audio |
| `apps/mcp/test/roto.test.ts` | 45.723 s | Actual SDK-to-render/export object separation with IoU ≥0.93 and refusals |

Slowest final individual cases were MCP roto (45.723 s), required upscale
conservation (37.004 s), held-out Auto Tag accuracy (35.853 s), camera truth plus
reused tracks (33.966 s), and radial lens recovery (30.458 s). Worker imports remain
a large cost: 1,284.81 s cumulative, plus 247.20 s transformation. These overlap
parallel work and must not be added to command wall time. Process isolation and
real media/worker/browser ownership remain intentional. Exact timings, skips and
provenance are recorded in `integrated-final.{json,log,time}`,
`integrated-final-provenance.json` and `integrated-summary.json` under the local
evidence directory.

### Earlier comparable checkpoint

At `c3268212`, before the second incoming feature batch, complete command wall time fell from **2,111.47 s (35:11.47)** to
**1,929.07 s (32:09.07)**: **182.40 s saved, 8.64% observed improvement**.
Vitest's own durations were 2,109.71 s and 1,927.48 s. The baseline had two
fixture failures; that checkpoint command exited zero with no unhandled errors.

| Metric | Baseline | Checkpoint | Observed change |
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

Checkpoint file spans before/after (JSON end minus start, not whole process startup):

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

The slowest checkpoint individual cases were MCP roto (45.869 s), held-out Auto Tag
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

The first incoming upstream performance changes include resampler coefficient reuse, Find,
selection, sorting, derivative filtering and optional browser runtime loading.
Therefore the overall observed delta includes remote production improvements and
is not a cleanup-only causal estimate. The second batch adds schema v8 and
326 new named tests plus functional changes; its final full-run workload differs
again and must be identified separately. No unmeasured end-to-end CI saving is
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

Second-batch scoped results (exact sources, commands and limitations in its ledgers):

| Scoped workload | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Four real export/render files | 129.88 s | 89.27 / 85.41 s | Both final runs passed; all 22 crop artifacts match. Cache conditions differ. |
| Three disabled opt-in file startups | 22.12 s | 1.57 s | Avoid eager engine loading; existing opt-in flags/skips retained, duplicate planner cases have default owners. |
| Composition/media subset | 83.06 s | 50.98 / 52.49 s | Includes new real codec protection; predates only final literal High-smoothing seam assertion, separately verified twice. |
| Controlled font oracle, static 30→1 frames | 44.81 s | 39.00 / 42.49 s | Final observed saving 2.32 s / 5.18%; variance substantial. Five pictures exactly match both times. |
| Interchange ABBA mean | 18.507 s | 17.994 s | Difference smaller than run spread; no reliable speedup claimed. |
| Engine media ABBA mean | 26.878 s | 27.801 s | Wall time worsened 3.43%; CPU fell 3.45%, setup/body 14.47%. Shared-load/import variance disclosed. |

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

The final required default gate passed at `797e53fc`: 7,689 runtime cases passed,
239 explicitly skipped, no failed cases or unhandled errors. Root lint, actual
TypeScript, E2E TypeScript, notices and fresh production/Remotion builds passed.
The full command's ten FFmpeg/ELF cases executed with the vendor available; the
separate real PowerShell 7.6.8 command passed all 21 cases, including the 14 that
are skipped without an installed interpreter.

`pnpm mg:build` exited zero but explicitly skipped because Cargo was absent:
**native compilation/execution did not pass**. LGPL verification checked all 21
artifacts successfully. The production build's existing nonfatal script/chunk and
third-party annotation warnings are retained in its log; none was suppressed.

The final complete browser run passed **113 cases with two expected skips**
across all 53 specs at `797e53fc`, with zero unexpected/flaky cases, infrastructure
errors or retried test results. Runner time was 1,182.448 s; complete command wall
time, including fixture/LGPL preparation, was **1,183.95 s (19:43.95)**. All 14
strict audio/transport consumer cases passed in that run. A second run of those
four specs in a fresh app directory passed all 14 cases,
with zero skips, failures, flaky results, infrastructure errors or retries, in
292.055 s runner time / **293.49 s (4:53.49)** command wall time. Both passes checked
every intended play without a recording-discard or replay branch.

The two named skips were native motion-graphics export (Cargo/jasper-mg absent)
and the real CLAP model (requires its existing opt-in flag and local catalogue).
Existing capability guards also omit native-graphic portions of mixed sound
fixtures when that renderer is unavailable; those portions are not counted as
validated. The keyword fallback and TypeScript/Remotion rendering paths did run.

The first complete browser attempt at `76af3b2d` failed: 112 passed, two skipped,
one Sound Check confirmation failed, 1,230.41 s command wall time. Its trace exposed
the real pointer/focus defect described above. The baseline and intermediate
onClick-only variants failed isolated first-click probes; the final event/focus
fix passed both layouts and the unchanged whole workflow (55.701 s) in the final
suite. No failure, confirmation assertion or recording was discarded/replayed.
Raw failed evidence is `integrated-e2e-full-attempt1.{json,log,time}`; all 288 fresh
outputs were preserved separately before the next run.

A preparatory invocation also stopped before launching any browser case because
LGPL-only fixture generation selected system FFmpeg without OpenH264. Selecting the
already verified vendor executables through the documented `JASPER_FFMPEG` and
`JASPER_FFPROBE` variables resolved it; no repository behavior or test was changed.
That pre-test failure remains `integrated-e2e-full-prepare1.*`.

The final browser run preserved and SHA-256 indexed 287 fresh artifacts
(180,950,353 bytes), including output movies, PCM/data, screenshots and caption
sidecars, in `/tmp/jasper-test-cleanup/artifacts/integrated-e2e-full/`. The current
first-click confirmation was visually inspected, along with editor screenshots
and an extracted burned-caption frame. The slowest retained browser cases were
the assembled human sound workflow (105.977 s), all 24 paused-seek plays (93.783 s),
Sound Check (55.701 s), the actual stdio-agent/editor handoff (51.159 s), and measured
mix/delivery export (46.009 s). Their distinct obligations are in the browser
ledgers. There is no comparable full-53-spec baseline: neither the failed attempt
nor the earlier 23-spec run is used to claim a browser/CI speedup.

Fresh root builds completed before `E2E_SKIP_BUILD=1`: the wrapper verified their
source HEAD, clean application/package/script inputs and SHA-256 fingerprints of
the engine, MCP, web entry and Remotion bundle stamp. The official `pnpm e2e`
command still ran fixture preparation and the LGPL guard. Both browser invocations
use the normal random, port-scoped authentication harness, a distinct unused port
and a fresh app directory. No authentication or destructive-approval bypass was
used. Exact argv, environment, hashes and results are in
`integrated-e2e-{full,strict-repeat}-provenance.json` and their JSON/log/time files.
Equivalent CLI commands from the repository root (Node 20.19.0 toolchain). These
are the recorded per-run paths; future reruns need new empty app directories and
unused ports. The subshell keeps browser overrides out of the default commands
that follow:

```sh
(
export JASPER_REQUIRE_ORACLES=1
export JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome
export JASPER_FFMPEG_LGPL_ONLY=1
export JASPER_FFMPEG="$PWD/vendor/ffmpeg-lgpl/linux-x64/ffmpeg"
export JASPER_FFPROBE="$PWD/vendor/ffmpeg-lgpl/linux-x64/ffprobe"
export E2E_SKIP_BUILD=1
E2E_PORT=49630 \
  E2E_APPDIR=/tmp/jasper-test-cleanup/integrated-e2e-full-final-appdir \
  JASPER_APPDIR=/tmp/jasper-test-cleanup/integrated-e2e-full-final-appdir \
  PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/jasper-test-cleanup/integrated-e2e-full.json \
  env -u NODE_OPTIONS pnpm e2e --workers=1 --reporter=list,json
E2E_PORT=49620 \
  E2E_APPDIR=/tmp/jasper-test-cleanup/integrated-e2e-strict-repeat-final-appdir \
  JASPER_APPDIR=/tmp/jasper-test-cleanup/integrated-e2e-strict-repeat-final-appdir \
  PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/jasper-test-cleanup/integrated-e2e-strict-repeat.json \
  env -u NODE_OPTIONS pnpm e2e e2e/sound-p0-preview.spec.ts \
    e2e/sound-p0-transport.spec.ts e2e/sound-p6-transport.spec.ts \
    e2e/sound-proposal-ghosts.spec.ts --workers=1 --reporter=list,json
)
```

Root commands (the full test command records default text, JSON and GNU time):

```sh
pnpm lint
env NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck
env -u NODE_OPTIONS pnpm e2e:typecheck
pnpm notices --check
env NODE_OPTIONS=--max-old-space-size=4096 pnpm build
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/engine build:remotion
env -u NODE_OPTIONS pnpm mg:build
env -u NODE_OPTIONS pnpm ffmpeg:check
env -u NODE_OPTIONS JASPER_PWSH=/tmp/jasper-test-cleanup/toolchain/powershell/v7.6.8/pwsh \
  pnpm exec vitest run apps/engine/test/windows-opener.test.ts --maxWorkers=2
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm test --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/integrated-final.json
```

Before the second batch, the integrated focused command ran eight changed files (62 cases), including
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

The second-integration system-tool run completed all 824 files with 7,665 passed,
one failed and 245 skipped cases in 2,003.80 s. This **failed** diagnostic run is
not the final validation or a performance improvement claim. The one failure was
HEIF: a valid fixture had been generated with the pinned LGPL tools after the
earlier checkpoint; system ffprobe 6.1 cannot read its HEIF image items. A bounded
comparison of the same SHA256-identified file proved system exit1 versus pinned
7.1.5 exit0/HEVC320×240. The final run retains HEIF and the verified LGPL engine
tools. It uses the same Node/worker/Chrome settings, but its engine binary and
available fixture set differ from the original baseline. Raw failed evidence is
`integrated-system6.{log,json,time}`; no test or assertion was disabled to pass.

After the late test-only import changes, root's affected engine TypeScript and
full lint checks passed again before the final run.

The first complete integrated attempt ran every default file: 7,380 runtime cases
passed and 232 cases skipped in 1,941.89 s command wall time, but an unhandled
React rejection after `sound-style.test.tsx` teardown made the command fail. Its
request-receipt wait did not await the outstanding plan/dialog operation. This is
not reported as a passing gate or as the final performance sample. The async
fixture correction and final rerun are recorded above; no unhandled-error filter,
retry or disabled case was used.

Root lint initially found a formatting conflict in the merged ELF fixture import;
formatting only that changed import restored the gate. The earlier checkpoint had two lint warnings; the latest integrated lint passed
with no warnings after upstream easing changes. The repository's actual TypeScript compiler exceeded Node 20's default
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
through `69c96e3b` without rewriting history; all 341 new declarations received
the same audit and the affected existing owners were re-audited. The final fetch
confirmed `origin/main` remained at that integrated revision,
with no unaudited incoming changes. The final delivery message records the pushed
commit and verified remote result.
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
