# wp `hardening` — closing the security review's residual risks

Branch `feat/hardening` (parity program). The findings, the audit table of every engine route and the measurements
are in [docs/security-review.md](../security-review.md) §8; this note is the design, how to work with it, and what
was decided. Nothing was ported (no `licenses/ported` record); nothing was measured against other software.

## 1. What exists now

| Area | Where |
|---|---|
| Editor key, token for every engine, pairing | `apps/engine/src/{index,server,cli,context}.ts`, `packages/config` (`JASPER_EDITOR_KEY`, `JASPER_INSECURE_DEV`, `devEditorKeyFile`), `packages/api/src/common.ts` (cookie and header names) |
| Approvals bound to the editor connection | `apps/engine/src/agent/{service,sessions,approvals}.ts`, `apps/web/src/agent-bridge/bridge.ts`, `packages/api/src/agent.ts` (`ApprovalCard`, `answerKey`) |
| Gate for destructive routes | `apps/engine/src/agent/user-approval.ts` and the routes in `routes/{effect-presets,roto,speech,cache,previews,projects,media,gaps,processing}.ts` |
| Agent-input mark, agent name | `apps/web/src/state/engine.tsx` (`createEditorEngineClient`), `packages/engine-client` (`requestHeaders`, `automatic`), `apps/mcp/src/{link,context}.ts` |
| Dev server authentication | `apps/web/dev-auth.ts`, `apps/web/vite.config.ts`; `apps/mcp/src/discovery.ts` (token by `/health` → runtime file) |
| Desktop shell | `apps/desktop/src/{main,engine-process,security}.ts` |
| Sandboxed motion-graphics host | `packages/compositions/src/mg-host/{agent,remote,protocol,constants}.ts`, `layers/CompositionLayer.tsx`, `apps/web/src/mg-bundles/{text-measure,CanvasTextEditor}.tsx`, `apps/engine/src/routes/mg-bundles.ts`, `auth/signed-url.ts` (capabilities) |
| Node runtime for engine workers | `apps/engine/src/tools/node-runtime.ts` |
| Parser hardening | `packages/interchange/src/{cfb.ts,aaf/store.ts,aaf/read.ts,omf/bento.ts,omf/read.ts}`, `packages/project/src/three-d/gltf.ts` |
| Windows opener | `apps/engine/src/routes/gaps.ts` (`openerFor`, `WINDOWS_OPEN_COMMAND`) |
| Web test speed and timeout | `apps/web/src/panels/project/virtual.ts`, `packages/ui/src/menu/Menu.tsx`, `packages/ui/src/primitives/fields.tsx`, `apps/web/vitest.config.ts` |

## 2. Design

### Two secrets

| | Token | Editor key |
|---|---|---|
| Proves | "I may use this engine" | "I am the editor window (the user)" |
| Who has it | the editor, `jasper-mcp`, the CLI, scripts, the dev server | the editor window and whoever started the engine for it |
| Where | `runtime.json` (0600), `Authorization: Bearer`, cookie `jasper_session_<port>` | cookie `jasper_editor_<port>` only; engine memory; dev: `editor-key.dev` (0600) |
| Without it | 401 | you are an agent: destructive operations ask the user, approvals cannot be answered |

`req.jasperEditor` (set by the auth hook) is the one place that decides. It is false when the request carries
`x-jasper-agent-input`, which the editor sets while it handles an agent's live-UI input. An engine with no editor key
(in-process test servers, `JASPER_INSECURE_DEV=1`) treats every authenticated client as the editor; `startEngine`
never produces a tokened engine without one.

Who hands the browser the key:

| Stack | How |
|---|---|
| Desktop app | Electron main makes token and key, passes both to the engine it forks, sets both cookies |
| `pnpm dev` and hand-started dev stacks | Vite reads the runtime file (found through `/health`) and `editor-key.dev`; proxies with the token, sets the editor cookie on page loads and on the proxied `/health` poll |
| Playwright (`pnpm e2e`) | `playwright.config.ts` makes both, starts the engine with them, puts both cookies in `storageState` |
| Built engine started by hand | the engine prints `…/pair?key=…` (terminal only); the page it answers sets both cookies |
| `jasper-mcp --start-engine`, headless | nobody: there is no editor, destructive requests are refused |

### Approvals

`AgentService.askUser` creates the approval, sends the card to the editor connections (`SessionRegistry.editors`)
with a random `answerKey` per connection and approval, and publishes the key-less event. `agent.approval.resolve`
is honoured only from an editor connection whose stored key for that approval equals the one presented
(constant-time). The web bridge keeps keys in a private map. Operations (`kind: 'operation'`) reuse the same cards;
their sentence is "⟨agent⟩ wants to ⟨summary⟩".

### Motion-graphics host

```
editor (origin of the app)                       bundle page (opaque origin)
  <iframe sandbox="allow-scripts">  ── load ──▶   /mg/bundles/<key>/index.html?jasper-host=1
                                                   → 302 /mg/sandbox/<cap>/<key>/index.html   (CSP, ACAO *)
  connectMgHost(iframe)             ── port ──▶   host agent (bootstrap): check · configure · seek ·
  MgHostRemote: validates replies   ◀─ JSON ──     locate · fonts · hide · restore
```

The agent is plain ES2019 in a string, like the text probe, and is the only code that knows Remotion's page
protocol. `MgHostRemote` validates everything it receives (section 8 of the review lists what).

## 3. Working with it

- **Dev:** nothing changes for `pnpm dev` or the two-command stack in CLAUDE.md. `curl` against the engine port
  needs the token; against the dev server it does not.
- **A test that starts an engine over a socket** passes `insecure: true` to `startEngine` when it is not about
  authentication, or uses `engine.token`. In-process servers (`makeApp`, `createServer`) are unchanged; pass
  `token` and `editorKey` to `makeApp` to test as an agent (`Authorization`) or as the editor (cookies).
- **A new destructive route** calls `await requireUserApproval(app, req, {label, summary, reasons, projectId?})`
  before it destroys anything, and gets a row in the review's table. The summary is what the user reads: say
  what and how much.
- **A harness that drives the built stack** uses `harnessEngineEnv()`, `harnessHeaders()` and `harnessCookies()`
  (`scripts/perf/ui-scenarios.ts`).
- **Reading a bundle page in a test:** from inside the frame (`page.frameLocator(...)`, `frame.evaluate`), never
  `contentDocument`.
- **PowerShell tests:** `JASPER_PWSH=/path/to/pwsh` (or `pwsh` on the PATH) runs the Windows open command for
  real; `FUZZ=1` runs every adversarial name and 20 000 container mutations.

## 4. Decisions

- **A second secret instead of trusting the connection.** The engine cannot tell a browser from a script by
  anything the script cannot forge; something must reach the editor out of band. An HttpOnly cookie keeps it away
  from page scripts too (a bundle page, an XSS).
- **Per-card, per-connection answer keys on top of the editor key.** The brief asked for a per-editor-session
  secret; a key per card is narrower (a second editor window cannot answer with the first one's, a key is spent
  with its card) and costs nothing.
- **Deny needs the key too.** "Agent, MCP and CLI connections must never be able to answer": a denial by the agent
  would let it cancel another agent's request.
- **Refuse at once without an editor.** Waiting 60 s for a card nobody can see helped nobody.
- **Agent-owned projects.** `save_project_copy` and `create_project` create and then save; a save from an agent is
  allowed while nobody else has saved that project. Tracked in memory: after an engine restart the agent asks.
- **Cache `unused` and named render segments stay open.** They are what the engine does by itself and what an
  editing agent does all day; a card for each would train the user to click Approve.
- **Importing a Remotion project stays open** (residual 1): it needs an installed project on the machine, and
  gating it would end headless agent workflows. Flagged for a human decision if the threat model changes.
- **Dev key in a file.** `tsx watch` restarts the engine on every change and Vite is a separate process; without a
  shared, stable key the page would stop being the editor on every restart. Dev only, 0600, documented.
- **`https:` allowed in the bundle CSP.** Compositions load web fonts and remote media, as they do in a Remotion
  render; blocking it would make preview differ from export. Plain `http:` and the engine are blocked.
- **Storage stand-ins instead of `allow-same-origin`.** Remotion needs `localStorage` to start; giving the frame
  its origin back would undo the sandbox.
- **Work budgets instead of visited-sets in the OMF reader.** OMF objects legitimately form a DAG (shared
  definitions); refusing a second visit would refuse real files. `collectRefs` (a pure collection) does use one.
- **The run-as-node fuse stays on.** See RUN-1: the honest state is "prepared, not flipped".
- **15–60 s web test timeout, scaled by load².** A fixed 15 s was the brief's fallback; the scaled value keeps the
  limit meaningful on a quiet machine and survives the load at which the failures were seen.

## 5. Comparison with the reference

The reference repositories have no approval gate, no engine process and no browser host, so there is nothing to
compare for AGT-2, AGT-3, DEV-1, MG-1 and RUN-1. The AAF, OMF and compound-file readers are ports of FilmCraft
(`crates/cfb`, `crates/interchange/src/{aaf,omf}`; recorded in `licenses/ported/interchange.md`). Reading the
reference at the same places: its `aaf/store.rs` builds `count` keys for a weak set whose key size is 0, bounds
objects only by `MAX_OBJECTS`, and its `omf/bento.rs` `value()` concatenates segments without a total, its
`omf/read.rs` walks with depth limits and no work bound — the shapes our port inherited. Our readers now refuse all
of them (review §8, PAR-2), which is **better** than the reference on hostile input and equal on real files (the
round-trip, pyaaf2 / OTIO and property tests are unchanged and pass).

## 6. Verified

See "Verified in the running app" in the review. Gate results are in the final report of the workstream.

## 7. Limits

- No installer and no Windows host (review §7).
- The editor key is in the packaged engine's start environment (review §6.3).
- The dev server is an authenticated client for anyone on loopback (review §6.2).
- `shell-render` and `speech` are still the slowest web tests (≈ 2 s each at load 20+); the timeout, not their
  speed, is what makes them stable.
- The desktop dev-mode smoke stalled twice in three runs while a cold Vite served the first page load, before any
  engine request; the cause was not found (it passed, and loaded in 5 s in two manual runs).
