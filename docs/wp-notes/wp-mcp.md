# wp-mcp — Agent panel removed; the agent API ships as an MCP server

Branch `wp/wp-mcp` (from `dev` at `cbd8892`). Ports 48550–48599. User decision: no in-app agent; external
coding agents (Claude Code, Codex CLI, Cursor…) drive JasperEditor through an MCP server. ARCHITECTURE D-18
and §11 are rewritten accordingly; S05 §17 and the other Agent-panel requirements are marked superseded.

## What exists

### A. Agent panel removed (`apps/web`)

Removed: `panels/agent/**` (activity feed, approvals, JSON console, schema browser), `commands/agent.ts`
(`panel.focus.agent`, `agent.console.run`, `agent.approval.approveAll`), the `agent` panel kind and registry
entry, the **Agent** workspace, the **Agent** menu, the header Agent button, the palette's "Ask the agent"
row and its Ctrl+Enter, the `Shift+0` (`panel.open.agent`) and `Ctrl+.` (`agent.stop`) bindings, the
`panel.focus.agent` keymap alias, the **Agent Tool** (Tools panel, `ToolId`), the icons only they used, and
`test/agent-panel.test.tsx`.

Kept: `agent-bridge/**` (in-page `window.jasper`, WS `/agent` relay, approvals store, activity log),
`Agent:` History entries with the sparkle, the clip flash, the `agent` toast kind.

Old saved state still loads (`shell/workspaces/{definitions,store,layout}.ts`):
- `RETIRED_BUILTIN_WORKSPACES = ['agent']`: `parseWorkspacesState` drops the stored Agent workspace, removes
  it from the order, and an `activeId` of `agent` falls back to Editing. Nothing else is reset.
- Stored dock layouts keep their `agent` panels until they are applied; `sanitizeLayout` (already run by
  `DockController.apply` and workspace import) drops unknown panel kinds, picks another active tab and removes
  a group that only held the Agent tab. Test: `apps/web/test/shell.test.tsx` "state saved by a build that had
  the Agent panel still loads".

New in the shell:
- `shell/AgentApprovals.tsx` (mounted by `EditorShell`): one sticky card per pending approval at the top
  centre of the window, above every panel and in every workspace/mode: "Agent request: `<label>`",
  "`<agent>` wants to run N commands: `<summary>`", the reasons, a countdown to the 60 s timeout, Show
  commands, **Deny** / **Approve**. It also turns bridge activity into a toast ("Agent: `<label>`" with
  Undo) for every change an external agent applied, and toasts a timed-out request. It reuses the toast
  frame/tokens and the `Button`/`Icon` primitives; it never takes focus.
- `shell/AgentOpenProject.tsx` (mounted inside the router, so it works on Home): the `editor.openProject`
  engine event navigates the window to the project and brings the desktop window to the front.
- `shell/connect-agent.tsx` + `commands/help.ts`: Help ▸ **Connect an AI Agent…** (`help.connectAgent`).

### B. `apps/mcp` — `@jasper/mcp`, bin `jasper-mcp`

Official `@modelcontextprotocol/sdk` (MIT), zod 4. `pnpm mcp:build` → `apps/mcp/dist/jasper-mcp.mjs` (esbuild,
one executable ESM file, 1.7 MB, everything inlined). `pnpm build` builds it too.

| File | Role |
|---|---|
| `src/cli.ts` | stdio entry: flags, `StdioServerTransport`, shutdown on SIGINT/SIGTERM/stdin end (6 s force exit), stdout guard |
| `src/server.ts` | `createJasperMcpServer({link, agentName, toolsets?})`: tools, resources, prompts, short `instructions`; toolsets and guides: `src/toolsets.ts`, `src/agent-guide.ts` (`docs/wp-notes/agent-footage-context.md`) |
| `src/discovery.ts` | engine discovery, health probe, `--start-engine` (fork a headless engine) |
| `src/link.ts` | `EngineLink` (lazy discovery, re-discovery), `FixedEngineLink` (for `/mcp`), `guardedFetch`, `withEngine` |
| `src/context.ts` | `defineTool` (exceptions → tool errors), `loadDoc`, `transact` (approval progress), `waitJob` |
| `src/errors.ts` | `ToolError`, hints per `E_*` / engine code, `toErrorResult` |
| `src/format.ts` | project/sequence/clip summaries (frames + timecode), the `get_timeline` text table |
| `src/tools/{projects,editing,render}.ts` | the tools |
| `src/examples.ts`, `src/export-presets.ts`, `packages/api/src/media.ts` | `describe_commands` examples, export presets, shared `media.register` command builder |

Transports: **stdio** (primary) and **Streamable HTTP at the engine's `/mcp`** (`apps/engine/src/routes/mcp.ts`:
same `createJasperMcpServer`, one instance per MCP session, max 32 sessions, 30 min idle, engine auth).

Engine additions: `<appdir>/engine/runtime.json` (0600; url, host, port, pid, token, version, appdir,
startedAt; written after listen, removed on stop if it is still ours), `playhead.set` query,
`POST /api/agent/open-project`, `GET /api/agent/mcp-info`, `via: session|headless` on query responses.

Discovery order: `--engine-url`/`--token` → `JASPER_ENGINE_URL`/`JASPER_ENGINE_TOKEN` → `runtime.json` in
`--appdir`, `JASPER_APPDIR`, the platform appdir, the desktop appdir (`<Electron userData>/jasper`) →
`http://127.0.0.1:47900`. Stale files (dead pid or no `/health`) are skipped. With `--start-engine` a headless
engine is forked (`--engine-entry`, else `apps/engine/dist/engine.mjs` or `resources/engine/engine.mjs` next to
the bundle) with a per-launch token.

### C. Tools (31)

| Group | Tools |
|---|---|
| engine | `engine_status` |
| projects | `list_projects`, `create_project`, `get_project`, `open_project_in_editor` |
| media | `import_media`, `list_media`, `get_media_info` |
| editing | `describe_commands`, `apply_commands`, `undo`, `redo` |
| timeline helpers | `add_clip`, `move_clip`, `trim_clip`, `split_at`, `delete_clips`, `add_text`, `add_marker`, `add_motion_graphic` |
| inspection | `get_timeline`, `render_frame`, `get_playhead`, `set_playhead` |
| motion graphics | `list_motion_templates`, `render_motion_graphic_preview` |
| export | `list_export_presets`, `start_export`, `get_job`, `cancel_job`, `wait_for_job` |

Resources: `jasper://projects/{projectId}/document`, `jasper://projects/{projectId}/timeline`, `jasper://guide`.
Prompt: `edit-video {goal, projectId?}`.

Conventions: every time argument accepts frames, `{"frames"}`, `{"seconds"}` or timecode, and says so in its
description; results are compact JSON text (`get_timeline` is a text table, `render_frame` and
`render_motion_graphic_preview` add MCP image content); failures are tool errors
`{"error": {"code", "message", "hint", "details"?}}` with the S01 `E_*` codes. Annotations: read-only tools
carry `readOnlyHint`, `apply_commands` / `delete_clips` / `cancel_job` carry `destructiveHint`.
`describe_commands` serves the command catalog from the engine's `GET /api/agent/schema` (generated from
`@jasper/project`) plus a worked example per common command; every example is dry-run against a real project
in the integration test.

### D. Tests

- `apps/mcp/test/unit.test.ts` (14): discovery (explicit, runtime file, stale pid, default port), engine
  bundle lookup, error mapping, the request guard (timeout, connection lost, retry rules), timeline table,
  export presets, version sync.
- `apps/mcp/test/integration.test.ts` (14; part of `pnpm test`): a real engine in **token mode** on
  `MCP_TEST_PORT` (default 48551) with a temp appdir, and an MCP SDK client over stdio to `jasper-mcp` (run
  from source with tsx). Create project → import fixture media → add/move/trim/split → `render_frame` PNG →
  `start_export` + `wait_for_job` → ffprobe of the file; `cancel_job`; text, markers, motion graphics, delete; transactions,
  dry runs and every `describe_commands` example; actionable errors; resources and the prompt; the token never
  appears in tool output or the server log; `--start-engine` on `MCP_TEST_AUTOSTART_PORT` (default port + 1).
- `apps/engine/test/mcp.test.ts`: `/mcp` with an SDK client and the engine token; 401 without it.
  `apps/engine/test/agent.test.ts`: `open-project`, `mcp-info`, bundle lookup.
- `apps/web/test/`: `shell-render` (no Agent UI anywhere; approval card Deny/Approve; the Connect dialog),
  `shell` (legacy workspace state), `connect-agent` (snippets), `keymap`, `registry`, `wiring-audit`.
- `e2e/agent.spec.ts` (6): the live-editor scenario through the **built** `jasper-mcp` bundle (see
  `docs/M1-STATUS.md`). `pnpm e2e` now builds `@jasper/mcp` as well.

### E. Connecting clients

README "Use JasperEditor from Claude Code / Codex / Cursor" and Help ▸ Connect an AI Agent… give:

```bash
claude mcp add jasper -- node /abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs
codex mcp add jasper -- node /abs/path/to/JasperEditor/apps/mcp/dist/jasper-mcp.mjs
```

plus `.mcp.json` (Claude Code, project scope), `~/.codex/config.toml` `[mcp_servers.jasper]` and
`.cursor/mcp.json`. The dialog fills in real paths: the desktop preload's `mcpInfo()` (packaged: the app
binary with `ELECTRON_RUN_AS_NODE=1` and `resources/mcp/jasper-mcp.mjs`), else the engine's
`GET /api/agent/mcp-info`, else a placeholder with build instructions. It offers the `/mcp` URL only when
the engine has no token, which since the hardening follow-up (docs/security-review.md §8, DEV-1) is only an engine
started with `JASPER_INSECURE_DEV=1`. The engine token is never shown.

Checked with the real CLIs against throwaway config dirs (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` under
`/tmp`; the user's configuration was not touched): Claude Code 2.1.285 `mcp add` + `mcp list` → "✔ Connected"
for the stdio server (plain, with `--env`, with `--appdir`) and for `--transport http` against a running
engine; Codex CLI 0.159.0 `mcp add` wrote the documented TOML and lists the server as enabled. This found
one bug: `claude mcp add --env K=V jasper -- …` fails because `--env` swallows the name; the name now comes
first.

No repo-root `.mcp.json` is committed: Claude Code and Cursor would offer/activate it for everyone opening
the checkout, and the bundle path is machine-specific. Docs only.

Electron: `extraResources` ships `apps/mcp/dist/jasper-mcp.mjs` as `resources/mcp/jasper-mcp.mjs`; the preload
gained `mcpInfo()` and `focusWindow()` (IPC `jasper:mcp-info`, window action `focus`).

## Review of my own diff (what I checked and changed)

- **Leftover Agent panel references:** `grep -ri` for `panels/agent`, "agent panel", `panel.(open|focus).agent`,
  `agent.(ask|stop|newConversation|askSelection|console)`, `tab-agent`, `agent-button`, "Agent Tool" over
  `apps packages e2e scripts`: only negative test assertions and comments about the removal remain. Found and
  removed on the way: the Agent Tool, seven unused icons, stale comments in the bridge/engine/api.
- **Tools against a real engine:** all 31 are called in the integration test (token mode) or the E2E (live
  editor). `cancel_job` had no test; it now has one (cancel → `wait_for_job` reports `JOB_CANCELLED`, the
  existing output file is untouched).
- **Descriptions/schemas:** time arguments had lost their format note when a per-argument description
  replaced it; every one now carries both. Five undocumented arguments got descriptions. `start_export` says
  that existing files are never overwritten (the engine writes `name (2).mp4`).
- **Token leaks:** `engine_status`, error bodies, discovery logs and `mcp-info` never include the token
  (asserted in unit, integration and engine tests). It lives only in `runtime.json` (0600, in the user's
  appdir) and in `--token` / `JASPER_ENGINE_TOKEN` if the user passes it.
- **Unbounded waits:** engine requests had no deadline. `guardedFetch` adds one (180 s, `--request-timeout`)
  → `ENGINE_TIMEOUT`. `wait_for_job` ≤ 900 s, `open_project_in_editor` ≤ 60 s, MG preview ≤ 120 s, engine
  start ≤ 60 s, health probe 1.5 s, shutdown 6 s.
- **Blind retries:** `withEngine` re-sent any request after a NETWORK error, including transactions that
  may already have been applied. Writes cut off mid-flight now fail with `ENGINE_CONNECTION_LOST` and a hint
  to re-read the project; reads and never-sent writes (ECONNREFUSED…) are still retried once.
- **stdout:** only the SDK transport writes to stdout (`--version` aside, which exits). `console.log/info/debug`
  are redirected to stderr at startup; the started engine's output is piped to stderr. A raw stdio session
  (initialize, tools/list, two tool calls with no engine running) produced four stdout lines, all JSON-RPC.
- **Formatting:** the earlier commits on this branch did not pass `biome check`; fixed.

## Not done / limits

- **Packaged installers were not built** (as in M1): the `extraResources` entry and the
  `ELECTRON_RUN_AS_NODE=1` launch command for packaged apps are untested. An AppImage mounts at a new path
  on every launch, so the path in the dialog would go stale there; a stable launcher is needed (M3
  installers). If a later hardening flips Electron's `runAsNode` fuse off, the packaged command stops working
  and `jasper-mcp` needs a bundled Node or a separate binary.
- **No model-driven session** was run through Claude Code, Codex or Cursor (only `mcp add` / `mcp list` health
  checks and the SDK client). Cursor itself was not available here; its snippet is the standard
  `mcpServers` JSON.
- **`open_project_in_editor` with several editor windows:** every window navigates to the project; only
  one gets the editing lease. `launchBrowser` works only for engines without a token (`JASPER_INSECURE_DEV=1`): a
  browser opened by an agent is not signed in, and must not be (it would become the editor that approves).
- **`--start-engine` uses the platform appdir** (`~/.local/share/jasper` on Linux) unless `--appdir` or
  `JASPER_APPDIR` is given, so it does not see the projects of `pnpm dev` (`./.stage`) by default. The started
  engine serves no web UI.
- **Approval card:** no keyboard shortcut for Approve/Deny (the buttons are focusable); approvals are per
  project window, as before.
- **HTTP `/mcp`:** tools call the engine over loopback HTTP from inside the engine. No resumability/event
  store; sessions are in memory. The desktop engine's token changes per launch, so URL-based clients are only
  practical with a dev/standalone engine.
- **Specs:** S05 §17 and related items are marked superseded, not rewritten. Proposals/ghosts (S02 TL-955,
  S05 AG-030…) and the agent-driven UI command surface (S05 AG-050/051) are not implemented in any form.
- **Activity feed:** the panel's scrollable activity list is gone; History (with `Agent:` entries) and the
  toast replace it. The bridge still keeps the last 200 entries in memory (`window.jasper` consumers).
- The desktop smoke's packaged-like mode forks its engine on a random port (`--port 0`), outside the
  assigned range; that is how the test is built.

## For the integrator

Likely conflicts with `wp/wp-lgpl`:

| File | This branch | Note |
|---|---|---|
| `apps/desktop/package.json` | adds the `mcp` entry to `build.extraResources` | keep both entries (theirs: the LGPL ffmpeg dir and the compositor filters) |
| `apps/desktop/test/security.test.ts` | the `extraResources` assertion now checks `toContain` per dir + the `mcp` entry; preload key list | merge the expected dirs; if wp-lgpl kept `toEqual([...])`, add `'mcp'` |
| `apps/desktop/src/main.ts`, `preload.cts`, `security.ts` | `resources().mcpEntry`, IPC `jasper:mcp-info`, window action `focus`, `mcpLaunchInfo` | additive; wp-lgpl may add resource paths to the same `resources()` function |
| `apps/web/src/shell/menus/model.ts` | Agent menu removed; Help gets `help.connectAgent` between the palette entry and `app.notices` / `app.about` | wp-lgpl adds About/Licenses in the same Help block: keep all entries |
| `apps/web/src/commands/index.ts`, `apps/web/test/registry.test.tsx` | new `help` command module (`commands/help.ts`) | if wp-lgpl registers `app.notices` elsewhere, keep both; the registry test lists module names |
| `apps/web/test/wiring-audit.test.ts` | the "agent chat" group is gone; `help.connectAgent` added to the golden list | wp-lgpl probably removes `app.notices` from the absent list |
| `apps/web/src/shell/dialogs.tsx` | **not touched** (the Connect dialog lives in `shell/connect-agent.tsx` on purpose) | none expected |
| `packages/api/src/{agent,routes,events}.ts` | `playhead.set`, `via`, `open-project`, `mcp-info`, `/mcp` route, `editor.openProject` event, `RouteOwner 'wp-mcp'` | `capabilities.ts` and `exports.ts` are not touched |
| `apps/engine/src/index.ts` | runtime file write/remove in `startEngine` | wp-lgpl may touch the same file for binary resolution |
| `apps/engine/src/routes/index.ts`, `apps/engine/package.json` | `mcpRoutes`; deps `@jasper/mcp`, `@modelcontextprotocol/sdk` | additive |
| `packages/config/src/index.ts` | `ENV.ENGINE_URL/ENGINE_TOKEN/ENGINE_ENTRY/MCP_ENTRY`, `runtimeFile`, `desktopAppdir`, `parseEngineRuntime` | wp-lgpl likely adds env names to the same `ENV` object |
| `package.json` | script `mcp:build`; devDependency `@modelcontextprotocol/sdk` (the E2E imports the client) | keep both script sets |
| `pnpm-lock.yaml` | new importer `apps/mcp`, the SDK and its dependencies | take either side, then `pnpm install` |
| `scripts/e2e-prepare.mjs` | also builds `@jasper/mcp` | wp-lgpl may add an ffmpeg step |
| `README.md`, `docs/ARCHITECTURE.md` (D-18, §3, §4.3, §7, §9.2, §11, §12, §15, §16.2, §17, §18), `docs/M1-STATUS.md` | see above | wp-lgpl edits D-13, the Requirements/Quick start and the packaging blocker; different paragraphs, same files |

After merging: `pnpm install && pnpm mcp:build`, then `pnpm verify` and `pnpm e2e`. `pnpm test` starts a real
engine on `MCP_TEST_PORT` (48551) and `MCP_TEST_AUTOSTART_PORT` (48552): set both for another port range.
`apps/mcp/dist/` is gitignored; `pnpm e2e` builds it, a bare `playwright test` needs `pnpm mcp:build` first.
If wp-lgpl changes export encoders/containers, `apps/mcp/src/export-presets.ts` and the integration test's
ffprobe expectations (H.264 in MP4 for the default preset) may need the same update as the E2E.
