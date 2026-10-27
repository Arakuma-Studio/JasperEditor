# Test-suite audit and cleanup

This audit starts at `eb28696c` and integrates upstream through `b5126551` before comparison. Cleanup-only code changes are measured against that integrated upstream, so upstream performance work is not credited to this cleanup. The complete default-suite measurement uses implementation checkpoint `c62e2bb5`. Later browser-only fixture/harness corrections are measured and validated separately; they do not change the production or Vitest input tree.

The audit covers all **1,060 original and incoming Vitest/Playwright files**, plus 13 Rust tests and eight standalone/desktop scenarios. Every file has a disposition record. Source templates represent their parameterized/generated families; some small tables are enumerated explicitly. Runner instance counts are reported separately. These figures describe scope, not coverage or quality percentages.

After four superseded KEEP records are resolved, the ledgers contain **7,365 audit records**: 112 DELETE, 196 REWRITE, 213 OPTIMIZE, 72 CONSOLIDATE and 6,772 KEEP. Consolidation includes removed executions and their surviving owners; it is not a physical deletion count. The two `c.name` records in transition-m2 refer to distinct source declarations, distinguished by context/line. Relocated records retain their original audited path and identify the surviving boundary in their reason.

Test/support code changes total **-3,693 LOC**; production source changes total **-189 LOC**. The separate diagnostic benchmark and configuration changes add 173 lines. The reporting-only 100-kit benchmark remains reproducible in `apps/engine/bench/automation-kits.ts`; it no longer runs through Vitest discovery. No dependency or lockfile changed. No golden was re-blessed. No snapshot file was removed. Generated media and raw validation artifacts remain ignored.

Behavioral changes and surviving protection:

- Removed copied algorithms, declaration inventories, private plan/packing assertions, exact prose checks, false-positive catches and duplicated render/scoring runs. The per-test ledgers name failed criteria and surviving owners.
- Replaced private renderer checks with real Canvas/WebGL pixels, including asymmetric padding with nonuniform scale/rotation at two resolutions. Mutation checks confirm that using horizontal padding for both axes fails the new witness.
- Added full valid-input word preservation to the existing subtitle property. Dropping a valid word fails it; existing timing, cut and duplicate checks remain.
- Replaced the possibly empty random OTIO path fixture with an explicit media reference. Serialized relative URL and base-directory import resolution have literal independent expectations; the absolute-URL mutation fails.
- Corrected the five Node 24 false failures by pinning the actual versioned PCM16 WAV representation. All 160 persisted variants equal the authenticated v1 Node 20 reference on both Node 20 and Node 24. No sample generation or SYNTH_VERSION changed.
- Fixed the real X fallback-font spacing bug: DejaVu Sans with 999.9B left a 5.346073 px gap; corrected bounds give 6.462882 px. Template renderVersion 2 and the existing source-hashed bundle key invalidate cached bakes. Actual Player/export frames match bit for bit and were visually inspected.
- Removed unused controller/clock/audio/vocabulary/store/GPU-fault seams and internalized helper exports with no production consumers. The full diff and area notes identify callers. No project schema or migration changed.
- Reduced repeated synthesis/analysis, PNG subprocesses, conservation fixture frames/pixels and command-built planner setup while retaining the corresponding data, format, numerical and transaction assertions. Replaced arbitrary settle sleeps with actual lifecycle signals or controlled clocks. Shared expensive results are immutable or cloned per consumer.
- Reused supported render-browser instances within isolated suites. Project tests use threads only on Linux with a readable executing-thread CPU clock; other platforms retain forks. Per-file isolation and the global two-worker limit remain. The 30/50 ms CPU budgets and all samples are unchanged.
- Shared MCP teardown clears losing timers, reaps its owned child after the existing eight-second grace period and reports a required SIGKILL as failure. Failed spawns do not wait for a nonexistent exit event. A real-child probe verifies each path.
- Render three automation browser fixtures at their natural 640×360 size, retaining all durations, decoded frame counts, audio streams, review actions and original pixel thresholds. Complete warm three-spec command cost fell from 336.288 to 101.671 seconds (234.617 s / 69.77%). Both candidate repetitions passed. Disabling real rendered output fails the original three pixel witnesses. No production renderer changed.
- Match Playwright fixture tools to the native engine’s existing binary resolver, preserving vendor opt-out, musl paths, explicit overrides and legacy resources. Save and use Home for desktop project isolation instead of triggering the legitimate unload guard.

Eight test files were removed:

- `apps/engine/test/automation-kits-bench.test.ts`
- `apps/engine/test/voice-vad-shared.test.ts`
- `apps/mcp/test/template-media.test.ts`
- `packages/compositions/test/fx-lowered.test.ts`
- `packages/compositions/test/fx-sapphire-distort-warp.e2e.test.ts`
- `packages/compositions/test/fx-sapphire-glows-lighting-render.e2e.test.ts`
- `packages/compositions/test/text-paint.test.tsx`
- `packages/ui/test/scrubby-math.test.ts`

The removed files include cases relocated to stronger existing owners; file deletion alone does not imply lost contracts. The reporting-only benchmark failed the regression-test bar and remains an explicit EA-033 measurement tool. No meaningfully protective case was moved out of a required gate to improve reported time.

Intentionally retained expensive contracts include independent shader fingerprints/compile budgets, native/preview parity, real classifier held-out accuracy, camera and roto workflows, measured sound checks, persistence/migrations, security and process cancellation. Their area ledgers describe the distinct failure modes and measured costs. The combined Sound Design acceptance workflow stays because its final delivered mix exercises interactions not covered by isolated scenarios.

Per-test evidence is in the area JSON files below. Each row provides path/name, disposition, independent source, credible failure, oracle, seam, refactor tolerance, uniqueness, reason and validation command. `runner.json` supersedes the color/ranking CPU harness KEEP rows; `incoming_web.json` supersedes two existing browser/build rows. The current audit supersedes older `docs/test-cleanup/` classifications; historical paths in those records are not active runner configuration.

- [web_1](web_1.json)
- [web_2](web_2.json)
- [web_3](web_3.json)
- [project_1](project_1.json)
- [project_2](project_2.json)
- [project_3](project_3.json)
- [project_4](project_4.json)
- [engine_1](engine_1.json)
- [engine_2](engine_2.json)
- [engine_3](engine_3.json)
- [rendering](rendering.json)
- [motion_templates](motion_templates.json)
- [audio](audio.json)
- [core_support](core_support.json)
- [parsers](parsers.json)
- [browser_scripts](browser_scripts.json)
- [native_standalone](native_standalone.json)
- [mcp_desktop](mcp_desktop.json)
- [runner](runner.json)
- [incoming_engine](incoming_engine.json)
- [incoming_model](incoming_model.json)
- [incoming_web](incoming_web.json)

## Baseline failures and regression checks

The valid Node 20 baseline at integrated upstream had six failures: three automation-overlay cases used a non-dev renderer fixture without the optional LGPL bundle; two X count-layout cases exposed an overly small fallback-font width bound; one OTIO relative-path case used a random valid but empty timeline and therefore had no media URL to assert. The fixture correction preserves strict production binary refusal. The X output bug is fixed with cache invalidation. The OTIO test now has a deterministic real-media witness. None was deleted merely for failing.

An earlier exploratory Node 24 run at `eb28696c` failed five transient Float32 synth pins, three renderer-fixture cases and the worker-wide ZIP memory sample. Persisted PCM16 WAV compatibility remains pinned; ZIP memory is measured in an isolated process with the same limit. A deliberately materializing ZIP mutation fails it. A first attempted Node 20 comparison was cancelled because symlinked fixture paths changed canonical-path expectations. Real hardlinked fixture paths replaced those aliases, both affected path checks passed, and the whole baseline restarted. The exploratory and cancelled runs are excluded from performance results.

Focused mutation checks recorded in the area evidence deliberately break PCM16 rounding, source timing, mix transaction guards, parsing/format paths, CPU budgets, resource teardown, rendering coordinates and subtitle preservation. Each relevant surviving owner failed for the intended reason; sources were restored before positive and integrated runs. These probes validate selected rewritten/optimized seams; they are not an exhaustive mutation score.

## Measurement method

The whole-suite pair uses pristine `b5126551` in its own worktree and the cleaned branch at `c62e2bb5`, Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11, two workers, the same real fixture bytes/paths, FFmpeg 6.1.1 and Chromium 156.0.8078.47. Dependencies and fixtures were prepared before timing. `JASPER_FFMPEG_VENDOR=0` selects the same development oracle in both runs. No other builds or test validators ran during either timed command. OS caches were not dropped; Vitest timing-cache scheduling was disabled. Machine: Ubuntu 24.04, Linux 6.8.0-138, eight AMD EPYC-Genoa virtual CPUs and about 15.2 GiB RAM on a shared host.

The exact command, run in each corresponding checkout with `REPORT` replaced by the actual before20/after20 path, was:

```sh
PATH=/tmp/node-v20.19.0-linux-x64/bin:$PATH \
JASPER_REQUIRE_ORACLES=1 \
JASPER_BROWSER_EXECUTABLE=/usr/bin/chromium-browser \
JASPER_FFMPEG_VENDOR=0 FC_SEED=20261027 \
/usr/bin/time -v -o /tmp/jasper-test-audit/REPORT.time \
pnpm test --maxWorkers=2 --no-cache --reporter=default --reporter=json \
  --outputFile=/tmp/jasper-test-audit/REPORT.json \
  > /tmp/jasper-test-audit/REPORT.log 2>&1
```

GNU time wall time is the overall measurement; runner durations and individual-case times exclude some overhead. File timings come from runner output, including file hooks. They overlap under two workers and must not be summed into wall time. Mixed fork/thread maximum RSS reports different process boundaries, so it does not establish aggregate memory improvement. The full pair was measured once; repeated focused samples and their variance appear in the area notes. The result is an observed local change, with no extrapolated CI savings or causal percentage for each individual optimization.

## Whole-suite performance result

GNU time wall time fell from **2,316.04 s (38m36.04s)** to **1,916.28 s (31m56.28s)**: **399.76 s / 6m39.76s saved, 17.26%**. Recorded user-plus-system CPU fell from 7,139.77 s to 5,669.44 s: 1,470.33 s / 20.59%. These are the measured local pair, not predicted CI results.

The baseline registered 9,664 runtime cases: 9,355 passed, six failed and 303 skipped across 994 files. The final run registered 9,295 cases: **9,000 passed, zero failed and 295 existing optional/environment skips across 986 files**. No new skip gate was introduced. Counts change through parameterized-family pruning as well as declaration deletion, so they are separate from the audit-record dispositions.

The largest baseline file was `processing-steps.test.ts` (134.114 s); its smaller conservation fixture takes 58.910 s while retaining all eight backends and output/audio assertions. `subtitle-export.test.ts` falls from 27.780 s to 13.794 s; `processing-remote.test.ts` from 27.671 s to 15.108 s. File times include overlapping hooks and shared-host variation, so these differences do not isolate each optimization's causal contribution.

The slowest remaining files are `fx-gl.test.ts` (66.708 s), `camtrack-solve.test.ts` (59.895 s), `processing-steps.test.ts` (58.910 s), `sound-check.test.ts` (47.486 s), MCP `roto.test.ts` (47.417 s), `audio-classify.test.ts` (41.844 s), and `fuzz-http.test.ts` (40.830 s). They retain actual shader/pixel outputs, independent synthetic camera truth, real processing conservation, measured audio, end-to-end mask IoU, held-out classifier accuracy and typed HTTP failure guarantees. Cheap plan mocks do not prove these contracts. Their area ledgers justify the individual cases.

[performance/whole-suite.json](performance/whole-suite.json) contains configuration, exact refs, raw-artifact hashes, top file/case timings, failures, CPU counters and limitations. Focused repeated measurements live in the area notes and the [MCP teardown evidence](performance/mcp-teardown.json). No direct CI measurement was available. Shader compilation, solver work, real media processes and module import/startup remain the principal costs; no safety gate or uniquely protective scenario was removed to hide them.

## Validation and delivery

The required shared-host CI-equivalent gate passed on Node 20.19.0: `pnpm lint`, `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck`, the full two-worker oracle/browser suite above, and `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. The final OTIO test-only correction also passed `pnpm --filter @jasper/interchange typecheck`; full lint and the integrated full test run cover it.

Additional completed root checks: `pnpm e2e:typecheck`, `pnpm notices --check`, `pnpm ffmpeg:lgpl`, `pnpm ffmpeg:check`, `pnpm mg:build`, `pnpm --filter @jasper/engine build:remotion`, and `cargo test --manifest-path native/mg/Cargo.toml --release --workspace --locked -j 2` (13 passed, no ignored cases). Rust used the local Cargo/Rustup installation described in the native notes. These are real builds/tests; the optional native build did not skip.

The external Python reader checks also ran with OpenTimelineIO, its plugin adapters, FCPXML adapter and pyaaf2 installed: all seven formerly optional reader cases passed. All seven reader cases also passed in both complete comparable runs, using the same installed `/tmp/interchange-venv`; the tests detect that existing interpreter directly. Relevant opt-in text-paint/effect render, motion Player/export and social-card checks were executed by their area owners; exact commands, results, inspected frames and mutations are in their linked notes. Extended fuzz, strict PERF budgets and the complete optional rendering/GPU matrices are not claimed by the default gate.

The first browser attempt was stopped after two media-import setup failures and an interrupted case (four passed, 132 did not run). A focused file-input probe demonstrated Snap Chromium's `NotFoundError` on the workspace fixture; unconfined Playwright-pinned Chrome for Testing 153.0.8010.12 read its complete 7,105,268-byte MP4 with the correct header. That startup attempt is not a completed browser validation or a performance comparison. Artifacts were preserved under `test-results/test-audit/e2e-snap-startup/`, and the full browser suite restarted with Chrome for Testing. The whole-suite performance pair still uses the same Chromium 156 for both legs; browser integration is a separately reported environment.

The first complete Chrome for Testing run had 137 passes, one existing CLAP skip and one subtitle fixture prerequisite failure (24.2 minutes). The test worker had selected system FFmpeg without OpenH264 although the built engine correctly used the prepared LGPL binary. `playwright.config.ts` now shares the engine’s existing native binary resolver for worker FFmpeg/ffprobe, preserving explicit overrides, resources, vendor opt-out and musl platform selection. Independent review found and corrected opt-out/musl gaps in the initial direct-path implementation before final validation. The unchanged subtitle workflow passed completely without binary environment overrides: 14.5 s test / 20.2 s command, including cut alignment, one history entry and decoded rendered output. Its before/after-cut frames and the built editor/desktop screenshots were inspected.

Both desktop smoke modes passed. The first clipboard-isolation run passed two cases and failed two before their workflows: its new hard navigation hit the correct dirty-editor unload guard. The setup repair saves via Ctrl+S, waits for the public `save-status` saved state and follows the normal Home route before creating the next project. It changes no production guard or clipboard assertion. The repaired full four-case run passed (21.8 s), and both formerly blocked cases passed alone (12.2 s / 13.8 s).

`pnpm --filter @jasper/desktop dist:dir --skip-build` passed using the current outputs, with publishing explicitly disabled by the existing packager. `pnpm e2e:packaged` passed the relocated resources-only license/capability checks and a 30-frame OpenH264 export; poisoned PATH FFmpeg tools were never used. `pnpm e2e:mg-fallback` passed native routing with the binary and named Remotion blockers without it. With the compiled native renderer/vendor binaries available, the six-file optional-native/LGPL run passed all 52 cases with no skips.

The final root `pnpm lint`, `pnpm e2e:typecheck` and all-package `pnpm typecheck` also passed. Five fresh-process configuration probes verified prepared vendor selection, vendor opt-out/PATH, explicit invalid overrides remaining errors, legacy resource priority and genuinely missing tools. Source inspection confirmed that `apps`, `packages`, `scripts` and `native` are byte-identical to the fully measured/tested `c62e2bb5` input tree; later code changes are browser fixtures and Playwright configuration.

[validation.json](validation.json) records executed root commands, environment, results, artifact hashes, initial failures and explicit limits. Area reports record focused batches and regression mutations. Per-row validation strings are rerunnable targets; they do not claim every opt-in target was executed individually.

The three automation fixtures also have separate [paired browser measurements](performance/browser-automation.json): warm complete command 336.288 → 101.671 s, saving 234.617 s / 69.77%. The first baseline had additional fixture preparation and is excluded from this wall comparison. Both candidate runs passed (103.976 / 101.671 s), all 24 movies retained rates/durations/frame counts/stream kinds, and actual missing-output probes failed the original pixel thresholds. This subset is not an overall-browser or CI speedup claim. Fresh generated marker IDs can choose different permitted reaction slots, as documented in that evidence.

The final complete browser run passed **138 workflows, one existing CLAP opt-in skip, zero failures and zero flaky results** in 20.83 minutes of runner time. It used Chrome for Testing 153, the current authenticated stack and prepared builds, with the new native-tool defaults and all optimized fixtures. Earlier full-browser timing used different worker FFmpeg selection and had a prerequisite failure, so no overall-browser speedup is inferred from those two runs. The directly comparable three-spec warm pair above is the browser performance evidence.

Remaining unexecuted environments are the full opt-in render matrix, extended `FUZZ=1` and strict `PERF=1` campaigns, real NVIDIA GPU/CUDA, real SAM/CLAP model catalogues, real remote SSH, external prototype parity inputs, real PowerShell and non-Linux packaging/runtime. Relevant selected render/native oracles and normal-budget fuzz/property cases did execute. No missing dependency is counted as success.

Delivery target: `origin/main`, from work branch `test-suite-cleanup`. Upstream `b5126551` was fetched and integrated before cleanup; subsequent fetches found no incoming commits or changed agent instructions. The implementation checkpoint after browser follow-ups is `73de8721`. Final integration fast-forwards local `main`; the completion response supplies the final report commit and verified remote SHA, which cannot be self-embedded in that commit.

Root raw runner logs/JSON/time output remain under `/tmp/jasper-test-audit/`; durable summaries and artifact hashes are committed here. Generated media/builds/browser screenshots/traces are ignored and are not committed.
