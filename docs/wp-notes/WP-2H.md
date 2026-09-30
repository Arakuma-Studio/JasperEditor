# WP-2H — Agent API stage 1, Electron desktop shell, PWA

> **Partly superseded by wp-mcp** (`docs/wp-notes/wp-mcp.md`, ARCHITECTURE D-18 / §11): the Agent panel
> (`apps/web/src/panels/agent/**`), `commands/agent.ts`, the Agent workspace/menu and the `Shift+0` / `Ctrl+.`
> bindings described below were removed. The engine agent service, the WS relay, the in-page bridge, the
> approval gate, Electron and the PWA are unchanged; approvals are answered on a shell-level card and
> external agents connect through the `jasper-mcp` MCP server.

Branch `wp/wp-2h`. `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass on Node 20.20
(28 test files, 231 tests).

## What exists

### Shared agent helpers (`@jasper/project`, additive)
- `src/agent/queries.ts`: `runAgentQuery(env, name, args)` for every ARCHITECTURE §11 query (`doc.get` with
  path + `fields`, `doc.revision`, `sequence.summary`, `sequence.clipsInRange`, `sequence.at` (evaluated
  stack via `buildRenderSnapshot` + `resolveSceneAt`), `media.list`, `selection.get` / `playhead.get` /
  `history.list` (session hooks), `validate` (invariants or dry run)). `frame.capture` args are resolved by
  `resolveCaptureArgs`; the still itself comes from `POST /api/stills`. Frames always come with timecode
  strings (S02:TL-951). `exportAgentQuerySchemas()` gives JSON Schemas for `GET /api/agent/schema`.
- `src/agent/addressing.ts`: `resolveAgentAddresses` rewrites `{mediaByName}`, `{clipAt: {track, at}}` and
  `{markerByName}` before validation (`E_NOT_FOUND` / `E_AMBIGUOUS` with `commandIndex`). Track labels, temp
  refs and `$selection` stay with `applyTransaction`.
- `src/agent/guard.ts`: `approvalReasons` (the catalog's `APPROVAL_COMMANDS` + any `force: true`; dry runs
  never need approval), `checkAgentTxLimits` (5 000 commands, 20 MB), `normalizeAgentTransaction` (agents
  never act as `user`: other origins become `{agent: <fallback>}`), `historyPseudoCommand`
  (`history.undo` / `history.redo`), `summarizeTransaction`.

### Engine (`apps/engine/src/agent/`, `routes/agent.ts`)
- `GET /api/agent/schema`: `exportAgentSchema` + queries + pseudo-commands + addressing notes + approval
  policy + limits + events + engine error codes.
- `POST /api/agent/query` → `{result, revision?, via: 'session'|'headless'}`; errors use the ENG-022 body
  (`NOT_FOUND` 404, `VALIDATION_FAILED` 400, `NO_SESSION` 409 for session-only queries, `NOT_IMPLEMENTED` 501);
  the E_* code is in `detail.code`.
- `POST /api/agent/tx {projectId, transaction}` → **always 200** with `{result: TransactionResult,
  appliedBy}`; rejections are `result.ok === false` with E_* codes (`E_APPROVAL_DENIED`, `E_APPROVAL_TIMEOUT`,
  `E_NO_SESSION`, `E_REVISION_MISMATCH`, `E_LIMIT`, …). Unknown project → 404 `PROJECT_NOT_FOUND`.
  `revision: -1` means the engine rejected before loading the document.
- `WS /agent` (`@fastify/websocket` 11): `SessionRegistry` (hello / request / response / event, protocol
  pings every 15 s, drop after 45 s silence). Requests go to the newest session of the project **that has a
  leaseId**; 30 s timeout. On timeout the engine applies headlessly only if the store reports the lease
  expired; a disconnect mid-request returns `E_NO_SESSION` (never re-applied: it may have been applied).
- Headless (S01:AGT-020): load envelope → `loadProject` (migrate + repair) → addressing → `applyTransaction`
  → `makeEnvelope` → save with `baseRevision` (retry ×3 on conflict), per-project mutex, publishes
  `doc.changed`. Destructive transactions are rejected with `E_APPROVAL_DENIED`; history pseudo-commands
  with `E_NO_SESSION`.
- Approval gate: 60 s; `agent.approval.requested/resolved` go to `/events` **and** over WS to the project's
  sessions; the Agent panel answers with the WS event `agent.approval.resolve {approvalId, decision}`.
  Approved transactions are relayed with `approved: true`.
- Fast-forward (S01:AGT-010) headless: `RevisionTracker` fed by headless commits and by `doc.changed` events
  forwarded by sessions; trusted only back to the first continuously observed revision (older
  `expectedRevision` or gaps → rejected as stale).
- Store: `FsAgentProjectStore` (thin adapter owned here): `<appdir>/projects/<id>/project.jasper`, atomic
  write (tmp + fsync + rename), optimistic revision check, safe project ids.

### Web (`apps/web/src/agent-bridge/`, `panels/agent/`, `commands/agent.ts`)
- `AgentBridge` per `EditorSession`: `window.jasper = {version, projectId, schema(), query(), transact(),
  on()}` in dev and Electron builds (or `localStorage['jasper:agent-bridge'] = '1'`). Transactions go through
  `session.submit` (queued during gestures, one `Agent: <label>` entry, `agent.flash` for the timeline).
  Local approval cards (60 s) for in-page agents; engine approvals arrive over WS. Activity feed store
  (last 200). `history.undo/redo` only for the agent's own entry (`E_NOT_OWNER`, S01:UND-008).
  `frame.capture` posts `/api/stills` and polls the job.
- Relay client: hello `{projectId, sessionId, leaseId}` on every (re)connect and lease change, backoff
  1 s → 30 s, forwards `doc.changed`, `selection.changed`, `playhead.changed` (≤ 10 Hz, trailing update).
- Started by one line in `state/session-host.tsx` (`useAgentBridge(session)`). Every session with an engine
  client registers, including the in-memory `demo` project (useful before WP-2F lands).
- Agent panel: Activity (result, affected ids, Undo on the top entry), Approvals (reasons, summary,
  commands, countdown, Approve/Deny; the tab auto-selects on a new request), Console (templates, dry run,
  Ctrl+Enter, result viewer; console runs are user-typed and skip approval), Schema browser.
- Commands: `panel.focus.agent` (runs the shell's `panel.open.agent` — **the keymap binds Shift+0 to
  `panel.open.agent`**, which WP-2A registers; otherwise dispatches `jasper:panel-focus` on window),
  `agent.console.run`, `agent.approval.approveAll`.

### Desktop (`apps/desktop`)
- `pnpm dev:desktop` (dev: loads `JASPER_DESKTOP_DEV_URL`, default `http://127.0.0.1:5173`, run `pnpm dev`
  first) and `pnpm --filter @jasper/desktop start:packaged-like` (after `pnpm build`): forks
  `apps/engine/dist/engine.mjs` via `utilityProcess.fork(--port 0 --appdir …)` with `JASPER_LOCAL_TOKEN`
  (32 random bytes), `JASPER_WEB_DIR=apps/web/dist`, `JASPER_APPDIR` (default `<userData>/jasper`), waits for
  `{type:'ready', port}`, sets the HttpOnly SameSite=Strict `jasper_session` cookie, loads the engine origin.
- Frameless window (overlay `#1d1d1d`, symbols `#e3e3e3`, 28 px; macOS `hiddenInset`), show on
  ready-to-show, `setWindowOpenHandler` deny + `openExternal` (http/https/mailto only), `will-navigate`
  same-origin guard, webview attach blocked, `sandbox` + `contextIsolation`, single-instance lock, native
  menu hidden on Windows/Linux, media file dialog IPC, validated reveal / window-control IPC.
- electron-builder config block in `package.json` (config only; `pnpm --filter @jasper/desktop dist:dir`
  uses `pnpm dlx electron-builder`, not run in M1). `extraResources` expects `apps/engine/dist-deploy`
  (produced with `pnpm deploy` in M3) and `native/bin/<os>-<arch>`.
- Smoke hooks: `JASPER_DESKTOP_SCREENSHOT=<png>` (+ `JASPER_DESKTOP_EXIT=1`) captures the window after load.

### PWA
- `public/manifest.webmanifest` (S05:PWA-001), icons in `public/icons/` generated by
  `node apps/web/src/pwa/generate-icons.mjs` (original mark, pure Node PNG encoder): 192/512 `any`,
  **separate** padded 192/512 `maskable`, apple-touch 180, favicons 16/32.
- `src/pwa/sw-routes.ts` classifier + `public/sw.js` (hand-written copy; `test/pwa.test.ts` runs both over the
  same table and every prefix × mode × method × Range combination). Caches `jasper-shell-v1` /
  `jasper-assets-v1`; no `addAll`; `Response.error()` on misses; no auto `skipWaiting`.
- `src/pwa/register.ts`: registers only when `PROD && !window.jasperDesktop`; `useServiceWorkerUpdate()` /
  `onServiceWorkerUpdate()` for the "Update available · Reload" toast, `setReloadGuard()` to refuse reloads
  with unsaved work.

## Verification run (this worktree)
- Headless: `node scripts/agent-demo.mjs <projectId>` against `tsx apps/engine/src/cli.ts` with a seeded
  project → `applied by headless: revision 1`, envelope on disk updated; `track.remove` via curl →
  `E_APPROVAL_DENIED`.
- Live: `pnpm dev` + Chrome on `/project/demo`, `node scripts/agent-demo.mjs <demo projectId>` → `applied by
  session`, `history.list` shows `Agent: Demo title …`; a curl `track.remove` showed an approval card in the
  Agent panel, Approve applied it (`appliedBy: session`). Screenshots were taken with the Agent panel
  temporarily slotted into the placeholder shell (not committed).
- Desktop: `xvfb-run -a` dev mode loaded `http://127.0.0.1:5173/`; packaged-like forked the engine on a
  random port and loaded Home from it ("Engine: connected", `/api/projects` reached the route → cookie auth
  works).

## Integration notes / TODO (WP-3I)
- **Events**: the agent service publishes through `app.jasper.services.events.publish(type, payload,
  projectId?)`. WP-2F's broadcaster must expose that (or WP-3I adds a one-line adapter) so `/events`
  subscribers get `doc.changed` and `agent.approval.*`.
- **Store**: headless uses `FsAgentProjectStore` unless `app.jasper.services.agentStore` implements
  `AgentProjectStore {load, save, leaseHolder?}`. WP-3I should register an adapter over WP-2F's store so
  leases (`leaseHolder`), versions and conflicts share one implementation; without `leaseHolder`, a session
  holding a lease but not connected to WS cannot be detected (headless writes then surface as a 409 on the
  editor's next autosave).
- The "close the tab and run again, see it after reopen" check needs WP-2F's `GET /api/projects/:id`; the
  headless write itself is verified above and in `apps/engine/test/agent.test.ts`.
- **Panel services**: the Agent panel registers `agentConsole` in a module-level `PanelServices`
  (`agentPanelServices`) because no PanelServices React context exists yet; commands check `ctx.services`
  first. When WP-2A provides the shell's instance, pass it as `services` or drop the fallback.
- **Keymap**: Shift+0 is bound to `panel.open.agent` (WP-2A). `panel.focus.agent` exists as the brief's id and
  delegates to it.
- **Electron sandbox on this host**: the chrome-sandbox SUID helper is not configured, so launches need
  `ELECTRON_DISABLE_SANDBOX=1` (e.g. `xvfb-run -a env ELECTRON_DISABLE_SANDBOX=1 pnpm dev:desktop`). The
  Electron binary may need `node node_modules/.pnpm/electron@44.5.0/node_modules/electron/install.js` in a
  fresh worktree.
- `apps/engine/test/server.test.ts` (WP-00) now skips `agent*` routes in the 501 stub test.
- Contract changes (additive): `@jasper/api` `AGENT_QUERIES` + `frame.capture`, server WS message `event`,
  `AGENT_WS_CLIENT_EVENTS`, `AgentApprovalResolveSchema`, `ApprovalSchema.summary/commands` (optional);
  `@jasper/project` exports `agent/{addressing,guard,queries}`; `PanelServiceMap.agentConsole`.
- Dependencies: `apps/engine` adds `@fastify/websocket`, `ws` (+ `@types/ws`); the lockfile changed.

## Review fixes

- Engine approvals: an `agent.approval.resolve` event is honoured only from a WS connection that said hello for
  the approval's project (previously a connection without hello could resolve any approval id).
- `doc.get`: `path` segments and `fields` match own properties only (no prototype walk such as `["constructor"]`).
- Desktop: IPC handlers (`pick-media`, `reveal`, `window`) answer only frames on the app origin.
- Trust model (unchanged, for the record): any holder of the engine token can open WS `/agent`, announce a
  lease and answer its own approvals. The gate protects against unattended destructive edits by agents that
  use HTTP, not against a hostile local process that already has the token.
- Live re-check: the in-memory demo session's relay id is its document `projectId` (`prj_…`, shown by
  `window.jasper.projectId`), not the route segment `demo`.
