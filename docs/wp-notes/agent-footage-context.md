# Agent context: toolsets, short instructions, guides, routing, agent skill (spec 18 AF-CTX)

Spec: [`docs/specs/18-agent-footage-editing.md`](../specs/18-agent-footage-editing.md) §2.6 (AF-CTX-001…005), gap 6
("every agent pays for all tool schemas and the whole guide text on connect"). Branch `af/ctx`.

## Code

| Where | What |
|---|---|
| `apps/mcp/src/toolsets.ts` | `TOOLSETS` (the map, in order), `CORE_TOOL_BUDGET`, `parseToolsets`, `installToolsets` (the advertise filter), `registerToolsetTools` (`list_toolsets`, `enable_toolsets`, `disable_toolsets`, `describe_tool`, `call_tool`) |
| `apps/mcp/src/agent-guide.ts` | `buildInstructions` (≤ `INSTRUCTIONS_MAX_BYTES` = 8192), `guideTopics` / `fullGuide` / `guideTitle`, `ROUTES` + `routingMarkdown`, `editVideoPrompt`, `registerGuides` (topic resources, `jasper://guide`, `get_guide`) |
| `apps/mcp/src/server.ts` | `GUIDES` (topic → `*_GUIDE` or a titled bundle), `createJasperMcpServer({toolsets})`: option, else `JASPER_MCP_TOOLSETS`, else core |
| `apps/mcp/src/cli.ts` | `--toolsets <list>` (else `JASPER_MCP_TOOLSETS`); an unknown name exits 2 naming the valid ones |
| `apps/mcp/src/jasper-cli.ts` | the `jasper` CLI's in-process servers advertise `all` |
| `skills/jasper-editor/` | `SKILL.md` + `references/{proposals,verification,setup}.md` |
| `apps/mcp/test/toolsets.test.ts` | every requirement below |

## Toolsets (AF-CTX-001)

- 26 toolsets, every tool in exactly one: `core`, `project`, `media`, `processing`, `editing`, `structure`, `time`,
  `multicam`, `transitions`, `color`, `effects`, `keyframes`, `text`, `graphics`, `shapes`, `3d`, `vfx`, `audio`,
  `sound`, `sound-design`, `transcript`, `captions`, `review`, `automation`, `export`, `ui`. They follow the tool
  modules, merged into task-sized groups of 6–29 tools (e.g. `color` = Lumetri + grading + colour management;
  `transcript` = speech models, transcript/text-based editing, voice, cleanup, script fixes, glossary). Each has a
  one-line description and its guide topics (`list_toolsets` returns both; the instructions list the
  descriptions).
- `core` (32 with the spec 18 tools of the other workstreams, 23 registered on this branch): the six toolset/guide
  tools; `list_projects` `create_project` `get_project` `import_media` `get_timeline`; `describe_commands`
  `apply_commands` `undo`; `add_clip` `trim_clip` `split_at` `delete_clips`; `render_frame`; `transcribe`;
  `wait_for_proposal`; `start_export` `wait_for_job`; and `get_brief` `set_brief` `list_agent_notes`
  `add_agent_note` `get_footage_digest` `find_takes` `view_media_range` `propose_edits` `verify_export`.
  `transcribe` + `wait_for_job` are core because the digest names `transcribe` for media without a transcript;
  `derive_media` is in `media` (spec 18 lists media operations outside the core list).
- Start set: `createJasperMcpServer({toolsets})` → `JASPER_MCP_TOOLSETS` → `core`; `--toolsets` on `jasper-mcp`
  (flag, else env). `all` or a comma list; case and spaces are ignored; `core` is always on; unknown names throw
  (`jasper-mcp` exits 2, the engine's `/mcp` session creation fails with the same message).
- Adding a tool is one line in its toolset's `tools` list. The test fails on a registered tool that is unmapped
  or mapped twice, on a mapped name that is neither registered nor pending, and when `core` exceeds 32.

## Advertising, list_changed, call_tool (AF-CTX-002)

Design: every tool stays registered **and enabled** in the SDK (`@modelcontextprotocol/sdk` 1.31.0).
`installToolsets` wraps the SDK's own `tools/list` and `tools/call` request handlers (read from the protocol's
handler map after the first tool registered them):

- `tools/list` = the SDK list filtered to the advertised toolsets (unmapped tools are always listed, so a
  forgotten mapping never hides a tool at run time; the test catches it).
- `tools/call` of a registered tool whose toolset is off → `E_TOOLSET_NOT_ENABLED` error result
  (`{error: {code, message, hint, details: {tool, toolset}}}`, hint: `enable_toolsets` or `call_tool`). Everything
  else goes to the SDK handler unchanged.
- `enable_toolsets` / `disable_toolsets {names}` (`all` allowed; `core` cannot be disabled → `E_INVALID_PARAM`)
  send **one** `notifications/tools/list_changed` per call that changed the set, none otherwise.
- `call_tool {name, arguments}` sends a synthetic `tools/call` request to the **SDK's original handler** with the
  caller's `extra` (abort signal, `_meta.progressToken`, `sendNotification`): the same strict validation
  (`installStrictValidation`), the same handler, the same error results, approval waits with progress, and
  cancellation that cancels the engine job. It refuses itself and unknown names (`E_NOT_FOUND`). Its own hints
  are destructive + open-world, because it can run any tool; the tool it runs keeps its hints (`describe_tool`).
- `describe_tool {name}` = that tool's `tools/list` entry (same JSON Schema) + `toolset` + `advertised`.
- Why not the SDK's `RegisteredTool.disable()`: a disabled tool's call returns the SDK's plain "Tool X disabled"
  text (no toolset, not our error shape), the SDK handler refuses it so `call_tool` would have to re-implement the
  pipeline, and each `update()` sends its own `list_changed` (30 notifications to enable one toolset).
- The SDK handler map (`Protocol._requestHandlers`) and registry (`McpServer._registeredTools`) are not public
  API: `installToolsets` throws at start-up when either is missing (like `installStrictValidation` for
  `validateToolInput`), so an SDK update cannot silently advertise or hide the wrong tools.
- The full `tools/list` result is cached per server until the number of registered tools changes (JSON Schema
  conversion of 430+ tools costs ≈ 150–250 ms on the shared build machine; measured once with
  `node --import tsx`, not a benchmark).
- The `jasper` CLI (`openSession`, `jasper tools`) creates its servers with `toolsets: 'all'`.
- Test harness: `apps/mcp/vitest.config.ts` sets `JASPER_MCP_TOOLSETS=all` and `cleanEnv()` passes it to spawned
  `jasper-mcp` processes and engines, so the existing suites keep calling every tool; the e2e specs spawn the
  bundle with `--toolsets all`; `apps/engine/test/mcp.test.ts` now checks the core default over Streamable HTTP
  and enables `editing` before `add_marker`. `toolsets.test.ts` covers the default with explicit `core`.

## Instructions, guides, prompt (AF-CTX-003)

- `instructions` = `buildInstructions(topics)`: the workflow (brief → digest/takes → view → propose → wait →
  verify) with the tools of each step, small direct fixes, ask-vs-assume, the core rules (times, tracks, strict
  arguments, approvals, own undo, progress/cancel, hints), the toolset index (one line per toolset from
  `TOOLSETS`) and the guide pointers (topic names, routing, full guide, `jasper` CLI). 7 480 bytes on this branch
  (was ≈ 160 KB: every guide); the test asserts ≤ 8 192 UTF-8 bytes.
- Guides: `GUIDES` in `server.ts` maps 50 topics to the 51 `*_GUIDE` strings. Single guides keep their text and get
  their first line as title (cut at the first `: ` / `. ` outside parentheses); the older composites keep their
  URIs and content: `cleanup` (cleanup + voice), `transcript-fix` (+ glossary), `editing-automation` (+ style
  recipes); `expressions` carries the expression language reference; `editing` (the former instructions) and
  `project-settings` (the Premiere-gap tools) have explicit titles. `routing` is the 51st topic.
- `jasper://guide/<topic>` for each topic and `get_guide {topic}` return identical text; `get_guide {}` lists
  the topics with sizes. `jasper://guide` = every guide once (order of `GUIDES`) including the expression
  reference. The test imports every `*_GUIDE` export of `src/tools/*.ts` and fails when one is in no topic.
- `edit-video {goal, projectId?}`: the six workflow steps naming their tools, a single bundle of defaults instead
  of questions, and the Done / Checked / Not checked report; < 4 000 characters (was the 160 KB guide).

## Routing (AF-CTX-004)

`ROUTES` (82 rows): English request, Spanish request, tools; `routingMarkdown()` adds the toolset column from
`toolsetOf`. Served as `jasper://guide/routing` and `get_guide {topic: "routing"}`. The test checks ≥ 60 rows, both
languages, every tool registered (or pending) and mapped, and that each row's toolset cell is computed.

## Skill (AF-CTX-005)

`skills/jasper-editor/SKILL.md` (5.8 KB; with references 11.9 KB): frontmatter `name` + `description` with English
and Spanish trigger phrases; When to use, Workflow, Ask or assume, Report (Done / Checked / Not checked), Gotchas
(cannot hear → numbers; inspect the output, not the plan; at most three self-review passes; strict arguments;
toolset errors). `references/proposals.md` (writing `propose_edits` items, after proposing),
`references/verification.md` (format vs judgement rows, the three-pass loop, reporting numbers),
`references/setup.md`. README "Toolsets and the agent skill" documents installing it: Claude Code
(`~/.claude/skills/` or `.claude/skills/`), Codex (`~/.codex/skills/`, per Codex documentation — not run here),
Cursor (a `.cursor/rules/*.mdc` rule pointing at the skill — not run here). Top-level `skills/` is plain markdown:
biome ignores `.md`, `check-layers.mjs` only checks packages.

## Tool names in agent-facing text

`toolsets.test.ts` extracts every backticked snake_case identifier from the instructions, the prompt, the routing
table, `SKILL.md` and `references/*.md` and requires a registered tool, or a name in its `PENDING_TOOLS` list.

## Integration of the other spec 18 workstreams

The ten tools of the parallel workstreams are already mapped (`core`: `get_footage_digest`, `find_takes`,
`view_media_range`, `propose_edits`, `verify_export`, `get_brief`, `set_brief`, `list_agent_notes`,
`add_agent_note`; `media`: `derive_media`) and named by the instructions, prompt, routing table and skill. They are
listed in `PENDING_TOOLS` in `apps/mcp/test/toolsets.test.ts`; the test **fails once one of them is registered**
until its name is removed there. After merging a workstream: remove its names from `PENDING_TOOLS`; a new guide
string (e.g. a footage guide) gets one line in `GUIDES` (`server.ts`) and its topic in its toolset's `guides`;
the `jasper://projects/{id}/footage` resource needs no mapping. Any further tool is one line in its toolset.

## Limits

- Clients that ignore `list_changed` and cache `tools/list` see only the start set; `call_tool` covers them.
- `call_tool`'s static hints cannot reflect the target tool's; clients that auto-approve read-only tools will ask
  for `call_tool` every time.
- `tools/list` still converts every tool's schema once per server (cached); a session's first list costs the same
  as before.
- The Codex and Cursor installation paths are documented from their docs, not exercised (neither is installed on
  the build machine); Claude Code's skill layout is the reference format.
