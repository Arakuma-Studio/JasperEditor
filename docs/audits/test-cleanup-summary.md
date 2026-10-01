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

The cleanup removed source-shape checks, markup snapshots, exact layout/geometry checks, declaration self-comparisons, assertion-free probes, and duplicate coverage. Real contracts trapped in weak tests were rewritten to check published APIs, HTTP/protocol responses, rendered pixels or media, document persistence, and user workflows. Test-like tracked files changed by **2,201 inserted and 16,145 deleted lines**, a net reduction of **13,944 test lines**. This count excludes the audit documents.

## Removed support and production seams

Deleted the unused SVG snapshot, motion determinism fixtures and scene, redundant test files, and obsolete browser helpers. Removed test-only exports, counters, injection hooks, and wrappers from the engine, uploads, layer bake, warp, processing, web preview, compositions, project, UI, scripts, and native renderer. The desktop smoke now captures its screenshot and verifies IPC through CDP, so the application no longer carries screenshot/exit environment hooks. Removed test-only C reference functions and the SIMD toggle from the vid.stab WASM build and regenerated its checked-in binary and metadata; the binary is 7,284 bytes smaller. Public documented motion exports and the exported broadcaster completion indicator were preserved after cross-review.

The retained Ctrl-drag ScrubbyNumber test exposed a real fractional-accumulation bug, fixed in the primitive. The rewritten upload and audio tests exercise disk/expiry and decoded pitch/timing through real service and media outputs. The E2E rewrites leave screenshots, JSON observations, or encoded media for the critical flows.

## Validation

Repository gates: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm e2e:typecheck`, `pnpm test --maxWorkers=2 --testTimeout=120000`, and `pnpm e2e` passed. The full Vitest result was **137 files and 1,184 tests passed**, with **7 files and 30 tests skipped** by their default opt-in configuration. The sequential Playwright run passed **84 of 84 tests**. Focused opt-in Chrome motion parity, engine Remotion/MG/layer-bake rendering, native template parity, Rust workspace tests, desktop smoke in both modes, desktop clipboard, and MG fallback also passed; see area ledgers for commands, artifacts, and skip details. The real remote-SSH processing test has no configured host and remains skipped.

An earlier split Playwright run overlapped two server processes and made two MCP cases read a stale shared test-server record; the normal single-process `pnpm e2e` rerun passed all 84 cases. A concurrent remote cleanup commit was fetched after these gates; its merge and post-merge validation are recorded in the final commit history and report.
