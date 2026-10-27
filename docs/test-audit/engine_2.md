# Engine processing, security, proposals and sound audit

The ledger in [engine_2.json](engine_2.json) records every named declaration or parameterized template in the 73 assigned test files: 441 original entries. Dispositions are 403 KEEP, 18 OPTIMIZE, 13 CONSOLIDATE, 4 REWRITE and 3 DELETE. Parameterized backend cases are listed explicitly under their template; these counts are declarations, not expanded runner counts. Each entry records its contract source, recognizable regression, independent oracle, stable seam, refactor resistance, unique protection and validation target. Assertion excerpts supply concrete evidence for the retained cases.

The cleanup changes 14 test/helper files and two production files. Test code changes by **−147 lines**. No snapshots, dependencies, configurations or fixture files were deleted. The duplicate kept-report construction now has one existing shared-helper owner returning a fresh schema-validated report per call. The unused exported grammar fixture is file-local. The remote host limiter's unused test-only inspection accessor and six unused proposal watcher options were removed after checking all callers. Watcher production timings and limits are unchanged; fake system time now drives the real timer implementation.

Three cases were deleted: the smart-piece array-shape restatement, a duplicate proposal destructive-acceptance case and a duplicate ordinary route-token check. Smart-render's actual H.264/ProRes output frame/hash checks, proposals' richer destructive policy workflow and the server authentication matrix remain their stronger owners. No public endpoint, persistent format or rendering behavior changed.

Thirteen original cases were consolidated into four explicit owners: authenticated remote asset/cache/privacy/notice lifecycle; remote processing setup/cache/upload/cancel/failure lifecycle; sound measurement cache reuse after gain edits and identity remapping; and the late sound-delivery conflict. This removes nine separate executions/declarations. The earlier sound-delivery conflict probe is superseded by the later real edit crossing the snapshot read: the actual transaction must refuse with retryable CONFLICT, preserve every existing clip and master setting, and leave only the user's new hit and revision. It uses the real AgentService transaction and a real user HTTP edit rather than a production test hook. The corresponding hook removal is owned by the coordinated rebalance cleanup.

Remote asset planner setup now resets its template declaration before every case. The personality grammar case gets a fresh local document instead of mutating shared state. Remote processing stages that genuinely form one lifecycle are expressed in one test, eliminating prior-case setup assumptions. Queue completion replaces periodic HTTP polling; cancellation still waits for observable remote process start and verifies process/job-directory cleanup.

## Processing measurement

Measured on Linux 6.8 x86-64, eight AMD EPYC-Genoa vCPUs, Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11, default fork pool and `--maxWorkers=2`. Dependencies, media fixtures and model files were already installed. Both runs used the same worktree and engine validation lane; startup and transforms are included. Other agents ran independent workloads on the host, so background contention was not fixed.

Both runs used `pnpm exec vitest run apps/engine/test/processing-steps.test.ts --maxWorkers=2 --reporter=json` under `/usr/bin/time`; JSON reports were `/tmp/jasper-test-audit/engine_2-processing-before.json` and `/tmp/jasper-test-audit/engine_2-processing-after.json`, with timing files of the same stem.

| Measurement | Before | After |
| --- | ---: | ---: |
| Whole file wall time | 175.62 s | 93.20 s |
| User CPU time | 482.68 s | 192.20 s |
| System CPU time | 35.27 s | 17.47 s |
| Peak resident set | 967,092 KiB | 835,824 KiB |
| Upscale conservation case | 44.364 s | 0.835 s |
| Passing runtime cases | 16 | 16 |

Observed wall time saved is **82.42 s (46.93%)**. The eight backend conservation cases now process 18 frames at 320×180 and the original encoded AAC packets, rather than 150 frames at 1280×720. Eighteen frames span more than the temporal denoiser's nine-frame window and multiple dejudder cycles. Each backend still checks exact frame count, frame rate, BT.709 output, dimensions and encoded audio packet hash. Full-size DSP effectiveness, motion reduction, range-context and ONNX seam/tiling cases are unchanged.

The slowest cases before were upscale conservation (44.364 s), FFT denoise conservation (14.787 s) and deshake effectiveness (13.849 s). Afterward they were noise reduction effectiveness (22.064 s), deshake effectiveness (15.005 s) and vid.stab effectiveness (14.314 s). Those remaining cases prove actual signal/motion quality rather than transport conservation and justify their real processing cost. Unchanged noise effectiveness slowed from 13.69 s to 22.06 s, evidence of environmental variance. A repeated conservation-only run passed all eight backend cases in 17.155 s including runner startup. No full-suite or CI percentage improvement is inferred from this file-level measurement; integrated measurement belongs to the repository-wide validation.

## ZIP memory regression

The original process-wide ArrayBuffer sampler failed in the exploratory full Node 24 run but passed alone under Node 20. It included fixture allocation and unrelated Vitest allocations/garbage-collection scheduling. The replacement extracts the same valid 128 MiB entry through the actual bundled extractor in a fresh Node process. Explicit garbage collection removes unreachable stream chunks; retained entry-sized buffers stay live. The OS resident-memory high-water mark catches synchronous materialization too. The test requires under 64 MiB additional resident memory and checks the real extracted file's exact length. It does not mock allocation or extraction.

The complete security file passed 23 cases. The memory case increased from approximately 0.683 s alone to 1.226 s; this is a deliberate reliability cost. Restored extraction passed again under Node 20.19.0 and Node 24.22.1. A temporary whole-entry `Buffer.alloc(entry.size, 1)` held through the real write pipeline failed this case specifically at the 64 MiB assertion. Production source was restored and the test passed afterward.

Removing the real atomic `soundDesign.expectMix` command made the late delivery-race job incorrectly succeed, so its expected failed/CONFLICT assertion failed. Restoring the guard passed. This separately validates delivery wiring; the coordinated rebalance shard checks its own caller.

A separate mutation replaced real AAC packet copying with re-encoding. The optimized deblock case failed specifically at its encoded-audio packet hash assertion. Restoring the original runner passed. These mutations demonstrate that the cheaper fixtures and isolated memory oracle still reject their intended regressions.

## Executed validation

All commands used Node 20.19.0 unless explicitly stated. Vitest targets used `--maxWorkers=2`.

- `pnpm install --frozen-lockfile --offline --ignore-scripts`: passed using the existing offline store.
- `pnpm exec vitest run apps/engine/test/proposals-waiting.test.ts apps/engine/test/proposals-features.test.ts apps/engine/test/remote-assets-routes.test.ts apps/engine/test/sound-design-cues.test.ts --maxWorkers=2`: 22 cases passed across four files.
- `pnpm exec vitest run apps/engine/test/sound-design-bed.test.ts apps/engine/test/smart-render.test.ts --maxWorkers=2`: ten cases passed across two files.
- `pnpm exec vitest run apps/engine/test/processing-steps.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-processing-after.json`: all 16 cases passed; the baseline used the `engine_2-processing-before.json` output, as measured above.
- `pnpm exec vitest run apps/engine/test/security-review.test.ts --maxWorkers=2`: all 23 cases passed after the memory rewrite.
- `pnpm exec vitest run apps/engine/test/sound-design-delivery.test.ts apps/engine/test/processing-remote.test.ts apps/engine/test/sound-check-kept.test.ts apps/engine/test/sound-check-kept-lifecycle.test.ts apps/engine/test/sound-design-grammar.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-new-targets.json`: 21 cases passed; the existing real-SSH opt-in case remained unselected because `JASPER_TEST_SSH` is unavailable. Wall time 49.996 s.
- `pnpm exec vitest run apps/engine/test/processing-steps.test.ts --maxWorkers=2 -t 'keeps frame count' --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-conservation-repeat.json`: eight backend cases passed, 17.155 s.
- `pnpm exec vitest run apps/engine/test/security-review.test.ts --maxWorkers=2 -t '128 MiB' --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-zip-mutant.json` with temporary retained-entry allocation: one expected failure at the intended memory assertion; source restored afterward.
- `pnpm exec vitest run apps/engine/test/processing-steps.test.ts --maxWorkers=2 -t 'keeps frame count.*deblock$' --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-audio-mutant.json` with temporary AAC re-encoding: one expected failure at the intended hash assertion; source restored afterward. The same target then passed.
- `pnpm exec vitest run apps/engine/test/security-review.test.ts --maxWorkers=2 -t '128 MiB'`: passed on restored Node 20 source.
- `/root/.local/share/mise/installs/node/lts/bin/node node_modules/vitest/vitest.mjs run apps/engine/test/security-review.test.ts --maxWorkers=2 -t '128 MiB'`: passed on restored source under Node 24.22.1.
- `pnpm --filter @jasper/engine typecheck`: passed after the production and test rewrites.
- `pnpm exec biome check <the 16 changed TypeScript files>` and `git diff --check`: passed.

- `pnpm exec vitest run apps/engine/test/remote-assets-routes.test.ts apps/engine/test/sound-design-grammar.test.ts --maxWorkers=2 --sequence.shuffle --sequence.seed=27 --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-isolation-27.json`: all 16 cases passed. Repeated with `--sequence.seed=81` and output `engine_2-isolation-81.json`: all 16 passed. Engine typecheck passed again afterward.
- `pnpm exec vitest run apps/engine/test/sound-design-delivery.test.ts --maxWorkers=2 -t 'a hit added after measurement' --reporter=json --outputFile=/tmp/jasper-test-audit/engine_2-delivery-mutant.json` with the actual atomic guard temporarily removed: one expected failure because the stale job succeeded. Source restored and the same target passed with output `engine_2-delivery-restored.json`.

No production mutations remain. All shard validation completed successfully; the exploratory full-suite ZIP failure was resolved by isolating its memory oracle, without relaxing the input size or budget. This shard did not execute optional real SSH/GPU/native animation/Remotion golden/browser/desktop suites. Their meaningful cases were retained; this report does not count unavailable suites as passing. Parent integration owns full lint, repository typecheck, default suite, build, remote integration and delivery.
