# Web audit: agent, editing, color and early alphabetic panels

This pass audits the 63 test files assigned in `web_1.json`, covering 348 original test declarations. The [per-test ledger](web_1.json) names every declaration, its independent source, credible failure, oracle, stable seam, refactor argument, distinct ownership and disposition. A parameterized declaration includes all its existing table rows; `describe.each` shares one declaration record across its unchanged contexts. The ledger's `validation` field is the rerunnable target, **not a claim that every target was separately executed**. Actual executions are listed below.

The baseline is `eb28696c`. Earlier `docs/test-cleanup/` reports supply provenance only; the current tests, production owners and specifications determine these decisions.

## Disposition and implementation

- KEEP 305; DELETE 7; REWRITE 17; OPTIMIZE 15; CONSOLIDATE 4 records (two removed executions and two surviving owners).
- Nine fewer source declarations overall. Test LOC: +185 / −346, net **−161**.
- Deleted the Automation menu/registration inventory, cleanup settings-descriptor/schema inventory, private virtualizer geometry/property probe, and three `easeEnv` wrapper-selection probes.
- Consolidated private cleanup-preview command-shape checks into the actual derived timeline workflow, and direct audio-tag ordering into the existing panel selection workflow with insertion order deliberately different from timeline order.
- Virtualized existing debounce/polling work without pinning private debounce durations. After explicit React/timer completion, synchronous DOM queries avoid React Testing Library's Jest-only fake-timer `asyncWrapper` drain.
- Removed incidental glossary indentation/full-copy assertions, preset search catalog cardinality, numeric display precision and connective text. The documented five reduced-motion preview frames remain at the standalone `CurvePreview` boundary; unverified animation-status flags are removed.
- No snapshot, fixture, helper file, dependency or configuration became unused; surviving tests and production UI still consume the relevant resources. Parser/schema/compatibility fuzz coverage remains.

## Supporting production seams

| Removed seam | Non-test use retained |
| --- | --- |
| `setCleanupControllerForTest`; `CleanupController` polling/worker options | `cleanupFor` creates the real per-session controller consumed by CleanupMode, editing commands and preview UI; default polling and worker fallback are unchanged. |
| `CleanupPlanner` worker override | The controller remains its production constructor caller; browser worker availability and failure fallback still choose the execution path. |
| `watchAutoTagOnAdd` debounce/enabled overrides | `AutoTagOnAddHost` uses the real audio preference and batching behavior; tests now do the same. |
| External exports of `autoTaggable` / `addedClipsToTag` | The watcher still uses both internally; there are no non-test external imports. |
| External exports of `easeEnv`, `warningText`, `runEaseTransaction` | Registered easing command implementations still use these internally; no production external importer exists. |
| `CurvePreview`'s `data-animated` flag | The panel still renders the component; the flag had only test consumers and never proved animation progress. |

No persisted format, public package API or intended application behavior changes.

## Measurements

Linux x64, kernel 6.8.0-138-generic, eight AMD EPYC-Genoa virtual CPUs, approximately 15 GiB RAM; Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11, two workers. Other coordinated work remained active. The one-minute host load rose from 8.24 at the paired baseline start to 13.64 after the second cleaned run. The paired runs use the same five test paths and `FC_SEED=20261027`; each starts a new Vitest process.

| Run | Tests passed | Process wall | Sum of test durations |
| --- | ---: | ---: | ---: |
| Original | 52 | 38.218s | 8440.5ms |
| Cleaned 1 | 43 | 34.160s | 3969.7ms |
| Cleaned 2 | 43 | 34.860s | 4266.6ms |

The raw process median changes from 38.218 s to 34.510 s: **3.709 s / 9.70% lower** for this targeted invocation. This is one baseline sample versus two final samples under increasing shared load, with possible filesystem/cache effects. It is not an isolated estimate, a whole-suite result or a measured CI saving. CPU did not improve in these samples: original user/system 36.679/5.019 s; cleaned 37.401/5.176 s and 39.226/5.229 s. Transform/import overhead dominates the remaining process cost.

The largest test-work reduction is Automation dialog 5882.2 ms → 1794.2/2088.6 ms after removing real sleeps. Cleanup UI 1326.5 ms → 1377.3/1435.3 ms does **not** show an isolated work-time improvement here; its clock change removes test-only shortcuts and makes synchronization deterministic. Automatic tagging 836.8 ms → 484.5/380.6 ms. The earlier unchanged five-file run also passed 52/52 at 25.48 s under different load/cache conditions and is not used for the comparison above.

All nine changed test files passed 81/81 in 42.31 s. Slowest remaining file work in that run: effect presets 1868.4 ms, Automation 1756.8 ms, Easing panel 1669.6 ms. These retain real UI↔session/library request, undo, selection, error and persistence contracts. Their large shared import graph remains; removing meaningful workflows solely to avoid import cost is unwarranted. Root owns the complete-suite and CI-equivalent measurements.

## Validation and regressions

Passed:

- `pnpm install --frozen-lockfile --offline --ignore-scripts` in the isolated worktree.
- `pnpm exec biome check --write` on the 14 changed source/test files and this ledger; `git diff --check`.
- Three short diagnostics for actual Propose/review, actual cleanup preview and audio-tag panel selection, with `--maxWorkers=2 --testTimeout=5000`.
- The normal-timeout run of all nine changed files: 81/81 passed, no skips.
- One unchanged and two cleaned five-file runs with `FC_SEED=20261027`, all passing.
- `pnpm --filter @jasper/web typecheck`.

Exact positive test selections:

```sh
# Paired five-file measurements: the original checkout, then this worktree twice.
FC_SEED=20261027 pnpm exec vitest run apps/web/test/automation-dialog.test.tsx apps/web/test/cleanup-model.test.ts apps/web/test/cleanup-ui.test.tsx apps/web/test/easing-commands.test.ts apps/web/test/essential-autotag-on-add.test.tsx --maxWorkers=2 --reporter=default --reporter=json --outputFile=/tmp/jasper-test-audit/web1-paired-before.json

# All changed files, normal configured timeouts:81 actual tests in nine existing files.
pnpm exec vitest run apps/web/test/automation-dialog.test.tsx apps/web/test/cleanup-model.test.ts apps/web/test/cleanup-ui.test.tsx apps/web/test/easing-commands.test.tsx apps/web/test/easing-commands.test.ts apps/web/test/easing-panel.test.tsx apps/web/test/effect-controls.test.tsx apps/web/test/effect-presets.test.tsx apps/web/test/essential-autotag-on-add.test.tsx apps/web/test/glossary-preferences.test.tsx --maxWorkers=2 --reporter=default --reporter=json --outputFile=/tmp/jasper-test-audit/web1-final.json
```

The full selection accidentally included an unmatched `.tsx` easing-command filter alongside the correct existing `.ts` filter. It did not omit any intended file; the report contains all 81 actual tests in the intended nine files.

The first fake-clock attempt failed 14 cases because RTL `findBy` / `waitFor` awaited an unfired 0 ms drain timer (its automatic advance recognizes Jest, not Vitest). This was test synchronization failure, not a baseline product failure. Explicit React/timer completion followed by synchronous queries resolved it. A short subsequent diagnostic caught the old assumption that Propose must be the last request; a legitimate debounced dry-run can finish later. The test now proves one actual Propose request while preserving review identity and unchanged revision. No timeout was increased and no required assertion was disabled. No further failure or flakiness was observed in the passing runs.

Two temporary production mutations failed at their intended assertions:

| Deliberate regression | Retained test and actual failure |
| --- | --- |
| Ignore the automatic-tagging opt-in preference | `off: adding a clip asks the engine nothing`: expected 0 classification requests, got 1. |
| Leave the first cleanup cut in Play result | Actual derived-preview workflow: expected 411 frames, got 651. The removed private command-shape test did not verify actual preview duration. |

Each mutation ran only its focused test with two workers and a 5 s diagnostic timeout; both owners were restored byte-for-byte in `finally`. The all-green results above are on the unmutated owners.

Raw reports, commands, CPU/load measurements and failure logs are in `/tmp/jasper-test-audit/web1-*.json`, `/tmp/jasper-test-audit/web1-*.time` and `/tmp/jasper-web1-*.log` (mutation/paired logs use `/tmp/web1-*.log`) for the integration agent. They are not shipped runtime state. Full repository lint/typecheck/test/build, browser integration and final remote delivery remain the root integration gate; this shard does not claim they ran here. No rendering algorithm, shader or export path changed.
