# Project model test audit: agent through fps-conform

Audited all 59 files assigned in this range: 795 named declarations/templates, including
parameterized cases and fixture-driven prototype oracles. The JSON ledger records each
contract source, oracle, seam, regression, disposition, remaining owner and validation.
Final dispositions: 776 KEEP, 10 REWRITE, 1 OPTIMIZE, 5 DELETE and 3 CONSOLIDATE
(two removed executions and one surviving owner). Seven declarations were removed.
The assigned test files lose 101 lines; the shared cleanup helper loses another two.

Removed fixture/catalog inventories, private convex-polygon coverage, malformed
out-of-domain font input, a duplicate fixture classifier and redundant model-only
history/repeated cleanup analysis. Real session undo/redo owns easing history. The
existing cleanup-review transaction now also checks one revision and the reported
output duration on the frame grid. Reverse-audio expectations use fixed independent
sample vectors. Bulk parsing checks structured diagnostics instead of English prose.
Two unused production helper exports became private; cleanup-synth no longer exports
its RNG/sample-rate or retains unused PCM/breath fields in its result. Local signal
synthesis and actual DSP analysis remain intact. No dependencies, snapshots or
configuration were removed in this scope.

## Validation

All commands used Node v20.19.0, pnpm 10.34.5 and the repository Vitest configuration.
CPU tests/typechecks ran exclusively under `/tmp/jasper-validation-pure.lock` after
an earlier paired run under `/tmp/jasper-validation.lock`.

- `pnpm exec vitest run <all 59 assigned paths> packages/project/test/script-fix-proposal.test.ts apps/mcp/test/cleanup.test.ts apps/web/test/cleanup-model.test.ts apps/web/test/cleanup-ui.test.tsx --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-project1-all.json`: **887/887 passed**, including 858 assigned executions and 29 shared-helper consumer executions; 109.29 s wall. Full command and exact path expansion are in `/tmp/jasper-project1-validate.sh`.
- `pnpm --filter @jasper/project typecheck`: passed, repeated after planner optimization.
- `pnpm exec biome check <changed source/test files> docs/test-audit/project_1.json`: passed (18 files before adding the summary/work-note correction).
- `pnpm exec vitest run packages/project/test/automation-planners.test.ts --maxWorkers=2`: five complete final-file runs passed, 22/22 each. A temporary fixture equivalence check matched the 2,400 clips against command-built input (excluding incidental generated clip names), sequence settings and media IDs/kinds/probes.
- Mutation checks failed for the intended regressions: shifting reversed audio one source frame; suppressing typo hints while retaining accepted-key lists; forcing every planner family draw to family zero. Restored production passed each targeted case. All mutation instrumentation was removed.

The first full run exposed a newly migrated assertion's copied 1e-5-second tolerance:
the existing review fixture represents 467 frames as 15.567 seconds. Comparing at its
30 fps frame grid fixes that test oracle; no production change was needed. The next
full run passed. No unchanged baseline failure was observed in these assigned tests.
The final repository-wide gate and integration are the root agent's responsibility.

## Measured performance

Same host/worktree, Node20, default fork pool, `--maxWorkers=2`; no hard timeout,
retry, sample-count or assertion reduction. Host load is shared, so CI impact is
unmeasured and the following file-level timings are not global-suite speed claims.

| Measurement | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Two alternating full automation-planners file runs, mean wall | 17.49 s | 9.89 s | 7.60 s / 43.5% |
| Weighted-family case, mean of those runs | 7,468.0 ms | 196.6 ms | 7,271.4 ms / 97.4% |

Before file walls were 19.11/15.87 seconds; after walls 10.34/9.44 seconds. Three
additional final-file runs had walls 9.32/10.32/10.43 seconds and weighted-case
192.7/218.6/212.6 ms. Profiling separated old fixture setup (7,227.6 ms) from planner
work (242.4 ms). The optimization replaces 2,400 editing commands with isolated
clones of one real valid clip, preserving all lengths, media alternation, source
ranges, random seed, 2,400 opportunities and measured distribution/repeat assertions.
The final fixture is invariant-checked; no mutable state is shared between tests.

An earlier ten-file paired run passed 137 original versus 132 revised executions:
24.61 versus 22.37 seconds. One shared-host pair is insufficient for a suite speed
claim. The removed duplicate cleanup analysis case cost 290.6 ms in that sample.

In the pre-optimization full assigned run, the planner distribution case was the
largest test (8.73 s). Remaining expensive tests include clip-edit property checks
(4.18 s), cleanup property checks (1.38 s), overlay distribution (1.28 s), random
split invariants (1.25 s), face/color processing (1.13 s) and 1,000-item batch commands
(0.80–0.94 s). They retain independent command/model/quality or capacity contracts;
no arbitrary property run or workload cuts were made. Global setup and production
render/browser costs are outside this assigned slice.
