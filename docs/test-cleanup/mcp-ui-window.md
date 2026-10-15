# MCP UI window metadata regression

This follow-up is authorized by the integration owner and based on `9073b4f8`.
The disposition and validation plan below were recorded before editing the test
or production owner. This is one new regression declaration outside the original
163-declaration MCP cleanup census.

## NEW regression — `apps/mcp/test/ui-state.test.ts`

Test: `ui_state preserves window measurements alongside the relay identity`.

The public `ui_state` tool description promises window size and pixel ratio.
`UI_GUIDE` also promises window size. The web producer in
`apps/web/src/agent-bridge/ui-automation.ts` returns those measurements as
`result.window`. `AgentUiResponseSchema` and the engine relay separately return
`window: {projectId, sessionId}` to identify the responding editor. The MCP
adapter currently replaces the measurement object with that identity object.

1. Independent contract: the published MCP tool description promises size and
   pixel ratio, while the HTTP API and `docs/wp-notes/mcp-cli.md` §4 require the
   identity of the editor that answered. Both must reach the caller.
2. Recognizable failure: an MCP/CLI automation client cannot obtain the promised
   viewport size or DPR; the current response contains only routing identity.
3. Independent oracle: literal upstream measurements (1280, 720, 2) and routing
   identifiers supply the expected public result. The upstream stub returns the
   two distinct objects; it does not implement their merge. Conflicting identity
   values in the result verify that the relay remains authoritative.
4. Stable seam: an SDK client calls `ui_state` through the real MCP server and
   inspects its JSON response. No private helper is exported or invoked.
5. Refactor tolerance: changing registration, serializer or relay implementation
   cannot affect the test if the same public response is delivered.
6. Lowest owner: the collision occurs in MCP `uiJson`; engine relay tests only
   observe the separate HTTP envelope, and web tests never execute this merge.
   Browser screenshot/element audits therefore cannot replace this regression.

## Callers, compatibility and risk

- `uiJson` is private and used by the MCP live UI tool handlers. External MCP
  clients and `jasper ui state` / `jasper call ui_state` consume its flattened
  output. There are no source-inspection or export-inventory assertions.
- `apps/mcp/src/jasper-cli.ts` project resolution reads `EngineClient.agentUi`
  directly and uses `result.projectId`; that path is unaffected.
- `apps/engine/test/agent.test.ts` checks relay targeting, identity and error
  mapping. It does not cover MCP flattening. The retained
  `e2e/agent-ui.spec.ts` screenshot checks do not read `ui_state.window`.
- Preserve existing `window.projectId` and `window.sessionId` keys and give the
  relay values precedence. Merge measurements only when the result's `window`
  is a non-null object that is not an array. Other tool results keep their
  existing identity-only window metadata. `ui_screenshot` uses its own response
  path and needs no change.
- No API schema, web producer, production export, injection hook or new helper
  seam is needed. The change is additive to the existing MCP window object.

## Validation plan

Install with `pnpm install --frozen-lockfile --offline`. Run
`pnpm exec vitest run apps/mcp/test/ui-state.test.ts --maxWorkers=1` before the
owner edit and record the missing measurements as the RED failure. Apply the
guarded merge, run the same GREEN check, then
`pnpm --filter @jasper/mcp typecheck`. Run changed-file Biome and
`git diff --check`; request static cross-review. Root owns integrated gates and
browser screenshot verification. Results will be recorded below.

## Recorded results

- Frozen offline installation succeeded. Expected warnings concerned unbuilt
  MCP executable links and the disabled optional onnxruntime install script;
  neither is required for this in-memory protocol regression.
- RED on the original owner: one test failed because the received `window`
  contained the correct relay identities but lacked `width`, `height` and
  `devicePixelRatio`. It reached the public response assertion, not a timeout or
  fixture/setup failure. Vitest reported 115.05 seconds total (108.69 seconds
  imports, 1.08 seconds test execution) on the loaded shared host.
- GREEN after the guarded merge: the same regression passed (1/1). Vitest
  reported 188.55 seconds total (181.36 seconds imports, 2.69 seconds test
  execution) on the loaded shared host. This timing is verification evidence,
  not a performance comparison.
- Changed-file Biome and `git diff --check` passed. Static cross-review cleared
  the independent protocol oracle, routing identity precedence, object guard
  and lack of a new private test seam.
- The first MCP semantic typecheck was interrupted by SIGTERM (exit 143), with
  no TypeScript diagnostics. Its interruption does not count as a pass.
- The retry reported TS2352 for the test's partial engine stub cast. The stub
  now uses the existing suite's explicit `unknown` boundary; its `agentUi`
  signature remains checked with `satisfies Pick<EngineClient, 'agentUi'>`.
  This type-only correction does not change the tested behavior or runtime.
- The final `pnpm --filter @jasper/mcp typecheck` passed (exit 0). Changed-file
  Biome and staged diff checks passed again after the type-only correction.
- Full repository gates and the browser screenshot workflow are owned by the
  integration checkout; this isolated follow-up does not claim those checks.
