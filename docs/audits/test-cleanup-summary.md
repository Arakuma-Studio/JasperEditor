# Test cleanup: audit and completed work

## Scope and disposition

The audit covered the repository's unit, integration, browser, desktop, script, and native tests. The baseline inventory contains 181 test-bearing paths. An exact-title reconciliation found all 1,654 static title-pattern matches in the ledgers, including one documented regex false positive; the ledgers explicitly describe generated cases. Each ledger records the original test path and title, its **DELETE**, **REWRITE**, or **KEEP** disposition, the failure it could detect, the stronger remaining owner where a test was deleted, and the independent contract, oracle, stable seam, refactor tolerance, and lowest owner for retained tests. The per-area ledgers are the full per-test report:

| Area | Per-test disposition and retention rationale |
| --- | --- |
| Web and UI | [Web/UI audit](test-cleanup-web.md) |
| Engine and MCP | [Engine/MCP audit](test-cleanup-engine-mcp.md) |
| Project, session, API, client, config | [Project/session audit](test-cleanup-project-session.md) |
| Compositions | [Compositions audit](test-cleanup-compositions.md) |
| Motion | [Motion audit](test-cleanup-motion.md) |
| Motion graphic templates | [Template audit](test-cleanup-mg-templates.md) |
| Scripts, desktop, native | [Scripts/desktop/native audit](test-cleanup-scripts-desktop-native.md) |
| Browser and desktop E2E | [E2E audit](test-cleanup-e2e.md) |

The cleanup removed source-shape checks, markup snapshots, exact layout/geometry checks, declaration self-comparisons, assertion-free probes, and duplicate coverage. Real contracts trapped in weak tests were rewritten to check published APIs, HTTP/protocol responses, rendered pixels or media, document persistence, and user workflows. Across the cleanup and merged remote commit, test-like tracked files changed by **2,336 inserted and 16,205 deleted lines**, a net reduction of **13,869 test lines**. This count excludes the audit documents.

## Removed support and production seams

Deleted the unused SVG snapshot, motion determinism fixtures and scene, redundant test files, and obsolete browser helpers. Removed test-only exports, counters, injection hooks, and wrappers from the engine, uploads, layer bake, warp, processing, web preview, compositions, project, UI, scripts, and native renderer. The desktop smoke now captures its screenshot and verifies IPC through CDP, so the application no longer carries screenshot/exit environment hooks. Removed test-only C reference functions and the SIMD toggle from the vid.stab WASM build and regenerated its checked-in binary and metadata; the binary is 7,284 bytes smaller. Public documented motion exports and the exported broadcaster completion indicator were preserved after cross-review.

The retained Ctrl-drag ScrubbyNumber test exposed a real fractional-accumulation bug, fixed in the primitive. A post-merge E2E import check exposed a second product bug: the Remotion import dialog closed before its asynchronous import completed and hid failures. Its primary action now awaits import, closes on success, and leaves errors visible; the redundant Enter handler that could start two imports was removed. The rewritten upload and audio tests exercise disk/expiry and decoded pitch/timing through real service and media outputs. The E2E rewrites leave screenshots, JSON observations, or encoded media for the critical flows.

## Remote merge review

Remote commit `ebb01ed` was reviewed before merging as `ce1ee63`. It added no new test scenarios. Its edits to already-pruned tests were reconciled against the same six-part bar, with the local deletions retained; compatible unused-code cleanup was incorporated. The merge kept `Broadcaster.since().complete`, the documented anime-template `fps`/`isPreview` props, browser-reserved shortcut handling, older-version workspace migration, and `EngineClient.requestDerivatives` because those are caller-visible contracts. The private `ProjectEnvelopeSchema` declaration and MCP internal re-export inventory were allowed to retire.

## Validation

Repository gates passed before and after the remote merge: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm e2e:typecheck`, `pnpm test`, and `pnpm e2e`. The final full Vitest run used `--maxWorkers=1 --testTimeout=120000`: **137 files and 1,184 tests passed**, with **7 files and 30 tests skipped** by their default opt-in configuration. The final sequential Playwright run passed **84 of 84 tests**. Post-merge focused Chrome motion parity (5/5), engine and MCP tests, native template parity, Rust workspace tests, desktop smoke in both modes, desktop clipboard (4/4), MG fallback, and an unpacked desktop LGPL export also passed; see area ledgers for commands, artifacts, and skip details. The real remote-SSH processing test has no configured host and remains skipped.

An earlier split Playwright run overlapped two server processes and made two MCP cases read a stale shared test-server record; the normal single-process `pnpm e2e` rerun passed all 84 cases. The post-merge desktop dev smoke sometimes loaded Vite HTML before a cold module graph mounted React under heavy host load. The test now allows 120 seconds for dev startup and saves page, resource, browser-event, and Electron diagnostics plus a screenshot on failure. The packaged mode retains its 30-second wait. The full desktop suite and a focused dev rerun passed after this adjustment.

The first post-merge browser run exposed the import-dialog bug described above. Its Remotion export case also exceeded a test-side job wait while the render was visibly progressing on the loaded host. The final check keeps the output assertions and gives that one job a longer wait. The S08 500 ms title-update check now measures Enter-to-visible-title time inside the browser, excluding Playwright command and polling overhead. The affected workflows and the final full browser suite passed.

A final two-worker Vitest run missed the unchanged S06 33³ Lumetri bake tolerance by 0.43 ms on the loaded host (30.43 ms versus the test's 30 ms failure threshold). That complete run had 1,183 other tests pass. The color file passed all 22 tests in isolation, and the final single-worker repository run passed all 1,184 without weakening or deleting the specified performance check. The color source and test were unchanged from the baseline.
