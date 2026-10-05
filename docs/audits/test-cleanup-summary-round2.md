# Completed second-pass test cleanup

## Scope and method

Started at `5476d4d`, fetched and fast-forwarded remote `main` to `87ebec9` before implementation. The incoming 235-file change set and all its new tests were included in the same audit. The merged baseline has 185 JavaScript/TypeScript test-bearing files and 1,454 static test declarations (parameterized declarations represent multiple runtime cases), plus native Rust and standalone desktop/browser scripts. An AST inventory reconciled every declaration against the ledgers, allowing documented parameterized expansions and Markdown escaping.

This is implemented cleanup, not an audit-only proposal. Parallel reviewers read tests, production owners and independent requirements, recorded dispositions before edits, then removed failing-bar tests, narrowed exceptional rewrites and removed unused support and test-only production controls. Existing prior-pass audit decisions were reconsidered. Independent final review checked removed exports and options against production callers and documented configuration.

## Per-test dispositions and full retention bar

Each linked ledger records every DELETE / REWRITE / KEEP in its scope, the recognizable failure, independent source/oracle, stable seam, refactor tolerance, lowest owner/stronger remaining coverage, caller search, risk and validation. Generated case families are explicitly mapped to their original templates.

| Area | Ledgers |
|---|---|
| Project, API, config, client and session | [Summary/API/config/client](test-cleanup-project-session-round2.md), [editing](test-cleanup-project-edit-round2.md), [media/time/color/tracking](test-cleanup-project-media-round2.md), [transitions](test-cleanup-project-transition-round2.md), [incoming source-range/text](test-cleanup-project-remote-round2.md), [session/persistence](test-cleanup-session-round2.md) |
| Web and UI | [Core/UI](test-cleanup-web-round2.md), [timeline](test-cleanup-web-timeline-round2.md), [inspector](test-cleanup-web-inspector-round2.md), [shell/clipboard](test-cleanup-web-shell-round2.md), [cache](test-cleanup-web-cache-round2.md) |
| Engine | [Core/cache](test-cleanup-engine-round2.md), [media/export/tracking](test-cleanup-engine-media-round2.md), [rendering](test-cleanup-engine-render-round2.md), [processing](test-cleanup-engine-processing-round2.md), [incoming processing/range](test-cleanup-engine-processing-range-round2.md) |
| MCP | [Protocol and workflows](test-cleanup-mcp-round2.md) |
| Rendering packages | [Compositions](test-cleanup-compositions-motion-round2.md), [motion](test-cleanup-motion-round2.md), [templates](test-cleanup-templates-round2.md) |
| Tooling/native/desktop | [Scripts, desktop and Rust](test-cleanup-scripts-desktop-native-round2.md) |
| E2E | [Browser, desktop and packaged workflows](test-cleanup-e2e-round2.md) |

## Removed support and production seams

Removed duplicate feature scenarios, declaration inventories, exact copy/layout assertions, markup/token parity, private counters/collaborator assertions, false-positive probes, production-derived expected values and unused fixture generation. Removed test-only timer/clock/fetch/path/worker injection options, diagnostic accessors, registry resets and exports across engine, web, session, client, motion/compositions and scripts. The native `svg` parity subcommand retired; native render/frame/schema/version protocols remain. A semantic native XML test uses the existing parser dependency instead of exact entity spelling. Retained documented configuration, including `jasper:color-stage`, `JASPER_SMOOTHPATH_WARP` and `JASPER_CACHE_AUTO_GC`.

## Bugs and validation follow-up

A retained remote-processing test exposed stale development processing bundles being installed remotely; the production owner now rebuilds the development bundle. A retained MCP tracking workflow caught geometry helpers omitted from the worker's serialized source after export cleanup; those runtime dependencies must remain available to the worker. Native invalid-command validation exposed a test-harness BrokenPipe race when the CLI rejects before reading stdin; the harness accepts only that expected write failure and still verifies the structured exit protocol.

The shared host was heavily saturated during focused validation (load averages above 200). Harness timeout failures are recorded in area ledgers, not counted as passes. Final repository test commands use a single worker and larger CLI harness timeouts; independently specified performance assertions remain unchanged. Existing React invalid-nesting warnings were investigated: no hydration caller or demonstrated rendered-output failure was found, so this cleanup does not change rendering behavior to silence a warning.

## Final validation

All commands used the settled source unless a follow-up is explicitly stated. The first root Vitest process had cached the geometry module before its exports were restored; it was interrupted and superseded by a fresh full run. Its partial results are not counted as a pass. That complete run passed 1,249 tests and exposed four harness deadline failures: a generic deep comparison of two 2 MiB buffers, a native 150-frame render, alpha-proxy completion, and FFmpeg startup before the cancellation timer begins. The byte comparison now uses equivalent native `Buffer.equals`; only uncontracted setup/completion deadlines were widened. The actual five-second job cancellation and 500 ms tracking requirements remain unchanged. All four affected files were then rerun against those edits.

| Gate | Result |
|---|---|
| `pnpm lint` | Passed; 973 files, token and anime checks clean. |
| `pnpm typecheck` and `pnpm build` | Passed across the workspace. Final session/web typechecks and web rebuild also passed after the last persistence-seam cleanup. |
| Full default Vitest suite | **1,253 default tests validated** across the complete run and focused rerun. Complete run: 1,249 passed, four harness failures, 31 conditional skips. Final four-file rerun: **31 passed**, one unconfigured SSH skip, no failures; covers all four original failures. This is not a claim that the first full invocation exited successfully. |
| `pnpm e2e:typecheck` and full Playwright suite | Passed; **87/87** browser workflows. After the final persistence cleanup, all **4/4** transition-default/reload workflows passed against a rebuilt web app. |
| Engine opt-in rendering | **34/34** passed across all seven gated files with `REMOTION_E2E=1` / `MG_E2E=1`; includes WebGL color, LGPL, shapes, layer bakes and bundle workflows. |
| Motion browser parity | **6/6** contracts passed, including the corrected callout scene input. Frames, movies and Player artifacts retained. |
| Native template parity | `MG_PARITY=1`: **23/23** package tests passed; regenerated schema has no tracked difference. |
| MCP optional composition workflow | **1/1** passed with `MG_E2E=1`, including text edits, prerender and PNG artifacts. |
| Rust workspace | **8/8** passed (5 CLI, 2 core, 1 semantic XML); rustfmt passed. |
| Desktop and packaging | Both desktop smoke modes and **4/4** clipboard cases passed; native/fallback check and actual unpacked LGPL render passed. The packaged harness shutdown race was fixed and its clean rerun passed. |

No coverage or test-count gate required preserving deleted tests. The optional real-SSH integration needs `JASPER_TEST_SSH`, which is not configured on this host; the default remote-executor protocol cases remain enabled. All other conditional engine prerequisites are available, and every browser/native opt-in suite was explicitly exercised.

The original complete browser report is preserved at `test-results/full-browser-report/index.html`, with screenshots/media under `test-results/` and `test-results/full-browser-artifacts/`. Motion render artifacts are in `/var/lib/orquester/tmp/jasper-anm014-PD4Kxw` and `/var/lib/orquester/tmp/jasper-anm014-N34yot`. Engine render tests retain their temporary appdirs. Logs for repository gates are `/tmp/jasper-round2-{lint-complete,typecheck,build,test-final,test-rerun,e2e,engine-optin,color-optin}.log`; these local artifacts are not committed.

The final test-path diff is **1,733 added / 8,195 removed lines: 6,462 net lines removed** across 164 changed paths. This includes test helpers and E2E scripts; it excludes inline Rust tests and fixture-generator deletions, so it is not a deletion target or a runtime-test count.

The final focused command was `pnpm exec vitest run apps/engine/test/processing-remote.test.ts apps/engine/test/mg.test.ts apps/engine/test/media.test.ts apps/engine/test/jobs.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000 --reporter=verbose`. Remote artifact/cache validation passed in 53 seconds with exact bytes intact; all native frame/codec/alpha and cancellation assertions passed. Final lint and diff-whitespace checks passed after these harness edits.

Remote `main` was fetched again after the complete test run and remained at `87ebec9`; there were no further incoming tests to audit. The cleanup is committed on top of that merged remote baseline. The final response records the pushed commit and verification result.
