# Agent-interface QA harness, UI automation audit and CLI conventions (from EffectCraft)

- **Upstream:** https://github.com/storytold/effectcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** mcp-cli workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/automation/tests/qa/harness.rs` | `apps/mcp/test/qa/harness.ts` | the QA seat (an MCP server spoken to over JSON-RPC) and the pixel helpers `coverage`, `centroid`, `luma`, `mean_diff`, ported to TypeScript (plus `meanLuma`, `meanColor`, `videoFrame`, `ffprobe`) |
| `crates/automation/tests/qa/*.rs` | `apps/mcp/test/qa/scenarios.test.ts` | the scenario style: realistic edits through the agent tools, assertions on rendered pixels and written files (our scenarios are new: rough cut, grade, titles, dissolve, keyframes, export + re-import, cancel) |
| `crates/ui-egui/tests/ui_agent_audit.rs` | `e2e/ui-audit.spec.ts`, `apps/web/src/agent-bridge/ui-elements.ts` | the audit idea (every panel, every interactive widget must have an automation element) and the "covered by a larger/inner automation element" rule, re-done for the DOM (React handlers, ARIA roles, focusability) |
| `docs/control-protocol.md` (`ui.*` methods) | `apps/web/src/agent-bridge/ui-automation.ts`, `apps/mcp/src/tools/ui.ts` | the live-UI method set (inspect, elements, click/drag/scroll/key/type, set, screenshot of the window or a panel, timeline/viewer locate and hit) |
| `apps/effectcraft-cli/src/main.rs` | `apps/mcp/src/jasper-cli.ts` | CLI conventions: `exec`/`run`/`get`/`set`/`props`/`render-frame`, `--json`, exit status 0/1/2 |

Notes: no Rust was copied; behaviour was re-implemented in TypeScript for a DOM/React shell, an HTTP engine and the
MCP TypeScript SDK.
