# mcp-cli — agent interface: strict MCP, cancellation, property reads, live-UI automation, `jasper` CLI, scenario QA

Branch `feat/mcp-cli`, ports 49020–49029. References studied: EffectCraft `docs/agents.md`,
`docs/control-protocol.md`, `crates/automation` (`tests/qa/*`), `apps/effectcraft-cli`,
`crates/ui-egui/tests/ui_agent_audit.rs`; FilmCraft `docs/agents.md` (Conventions, Long exports),
`docs/control-protocol.md`, `crates/automation` (`server.rs`, `long_job.rs`), `apps/filmcraft-cli`. Ports are
recorded in `licenses/ported/mcp-cli-effectcraft.md` and `licenses/ported/mcp-cli-filmcraft.md`.

## 1. Strict arguments and annotations

**Design.** `apps/mcp/src/strict.ts` + `packages/project/src/agent/strict.ts`.

- `defineTool` turns each input shape into a *deep-strict* zod schema (`deepStrict`): every fixed-shape object,
  nested ones and union members included, rejects unknown keys, so `tools/list` advertises
  `additionalProperties: false` everywhere (`looseObject`s too, unless marked `OPEN_OBJECT`; records and typed
  catchalls stay open).
- `installStrictValidation(server)` replaces the SDK's argument validation for **every tool on the server**, also
  tools registered with `server.registerTool` directly (tested with such a tool). It walks the arguments against
  the schema (`findUnknownKeys`: wrappers, arrays, tuples, records, lazy, pipes; in a union the option the caller
  meant = the one whose only problems are unknown keys), then parses. Failures are `isError` results with the same
  body as every tool error: `{error: {code: "E_UNKNOWN_ARGUMENT", message, hint, details: {unknown: [{path, keys,
  accepted}]}}}` with "did you mean" suggestions (Damerau–Levenshtein, transpositions count once), or
  `E_INVALID_ARGUMENT` with the issue paths, accepted and required keys. The MCP SDK turns any error thrown during
  `tools/call` into an `isError` result (it never returns `-32602` for tool arguments), so that is the form used.
  If an SDK update removes the hook, the server refuses to start and the test fails.
- `apply_commands` commands are an `OPEN_OBJECT` at the MCP layer; their keys are checked **where every agent
  path meets**: the engine's `/api/agent/tx` and the in-page bridge both run `unknownCommandKeyIssues` (nested
  keys too — command schemas strip unknown nested keys, which used to drop e.g. `patch.opactiy` silently). The
  message lists the command's accepted keys, suggests the typo and, when the command declares `ref`, how temp refs
  work. An undeclared temp ref (`$b`) now names the refs declared so far and how to declare one.
- Annotations: `defineTool` requires all four hints (`FullToolAnnotations`); presets `READ_ONLY`, `EDIT`
  (additive, not idempotent), `EDIT_IDEMPOTENT` (setters), `DESTRUCTIVE`, `DESTRUCTIVE_IDEMPOTENT`. All 163 tools —
  including the ≈60 added by masks, process, edit-structure, captions, keyframes-blend and audio-mix — were
  reviewed one by one (deletes/overwrites → destructive; setters → idempotent; `install_processing_model`,
  `test_remote_executor` → open world). `apps/mcp/test/conventions.test.ts` checks every listed tool: a title, all
  four booleans, consistency rules (read-only ⇒ idempotent and not destructive; `list_/get_/describe_` read-only;
  `delete_/remove_/clean_/cancel_` destructive; `add_/create_/import_/paste_` neither) and that every fixed-shape
  object of every input schema forbids additional properties.

## 2. Cancellation and progress

- `progressReporter(extra)`: one channel per request shared by all its reporters (nested waits), at most one
  `notifications/progress` per 100 ms, strictly increasing, the latest value wins with a trailing send, `flush()`
  before a result so the final update precedes the response, nothing without a `progressToken`.
- `waitJob` watches `extra.signal`: on `notifications/cancelled` it cancels the engine job, waits (≤ 10 s) until it
  is terminal — the engine deletes partial outputs before it reports `cancelled` — and throws `RequestCancelled`
  (the SDK sends no response for a cancelled request). `cancelIfAborted` covers a cancel that arrives while a job
  is being submitted. Covered tools: `start_export` (new `wait: true` / `timeoutSeconds`), `wait_for_job`,
  `render_frame` and `render_frames` (now rendered as a still job the tool owns, `captureStill`, same document and
  path as `frame.capture`), `render_motion_graphic_preview`, `process_clip`, `track`, `prerender_composition`,
  `set_cache_location`, `track_mask`, `normalize_media_loudness` — every tool that waits uses `waitJob`.
- Engine: an audit of every job runner that writes files (export, still, layer-bake, mg-bundle import,
  mg-prerender, process, model-download, derivatives, warp, cache-move, the mg-render scheduler). Gaps fixed:
  the export's copy to the user's destination (and caption sidecars) — `copyNoOverwrite` now claims the name with an
  exclusive create, registers it as a partial before writing, streams with the abort signal and deletes a
  half-written file; mg-prerender's preview and poster are written to `*.part.*` partials and renamed; a bundle
  import's new content-addressed directory is a partial until it is registered; the schema-loader scratch moved
  into the job's scratch dir. Already correct and verified: export/still out dirs, processing (`.partial-*`),
  derivatives (tmp + rename), layer bakes (scratch + rename), warp layers (`.tmp` + rename), model downloads
  (`.partial`, `finally rm`), cache moves (`.partial-*` rollback), mg-render (`.tmp-<job>` removed in `finally`).

## 3. Property reads, UI command listings, actionable errors

- Agent queries `clip.properties {clipId, frame?, keys?}` and `param.get {target, frame?}`
  (`packages/project/src/agent/properties-query.ts`, also allowed by `@jasper/api`'s query list); MCP tools
  `get_clip_properties`, `get_param`; CLI `props`, `get`. Each property: `value` = the keyframed value at the time
  (`resolvePropertyAt`: hold-only types step, numbers clamp to their range — what Effect Controls shows),
  `evaluated` = what the renderer draws (the render snapshot + `resolveSceneAt`, the code the Program monitor and
  exports use: Motion is not clamped, bypassed effects and disabled clips draw nothing), keyframes in sequence frames
  and timecode, the `param.set` target, and `rendered: false` + `why` (outside the clip — evaluated at the nearest
  frame, `evaluatedAt` —, disabled clip, track output off, bypassed effect, inaudible audio).
- `ui_commands` lists the window's UI commands (menus, shortcuts, panel focus, workspaces…) with `enabled` and,
  when disabled, `why` (the command's `disabledReason`, else a derived reason: missing capability, wrong panel
  focus, no project), checked state and shortcut; `ui_command` runs one and reports why when it cannot.

## 4. Live-UI automation

**Path.** MCP `ui_*` tool → engine `POST /api/agent/ui {projectId?, action, args}` → WS `/agent` request kind
`ui` → the window's `AgentBridge` → `apps/web/src/agent-bridge/ui-automation.ts`. The target window: the lease
holder of `projectId`, else its most recent window, else the most recently connected window of any project; the
answer says which window replied. `ui_state.window` contains the editor's `width`, `height` (CSS pixels)
and `devicePixelRatio` together with the relay's authoritative `projectId` and `sessionId`.
Works identically in the browser and in Electron (both load the same SPA).

- `ui-elements.ts`: interactive = native controls, interactive ARIA roles, focusable, `draggable`, or React
  pointer/click/keyboard handlers (read from the fiber props). Automation id = the element's unique
  `data-testid`; else an entity id `<panel>.<entity>.<id>` from data attributes (`timeline.clip.<id>`,
  `timeline.track.<id>`, `timeline.trackHeader.<id>`, `effectControls.fx.<id>`, `effectControls.lane.<row>`,
  `jobs.job.<id>`, `project.item.<id>`, keyframes, transitions…); else `<scope>/<testid|role>[<accessible name>]`
  with the nearest entity / unique-testid / panel / dialog / menu as scope; dockview's tab strips and floating
  title bars are named after their group's first tab. An id still ambiguous gets `#n` and `stable: false`.
  Unnamed wrappers filled by a stable inner control are not listed separately (EffectCraft's "covered" rule).
- `ui-input.ts`: synthetic pointer (with emulated pointer capture: a handler's `setPointerCapture` routes later
  moves and the release to it), mouse compatibility events, focus on press, click / dblclick / auxclick /
  contextmenu, per-frame drag steps (the timeline coalesces moves per frame), HTML5 drag-and-drop with one shared
  `DataTransfer` for draggable sources, wheel, keyboard with real `KeyboardEvent.code`s (the keymap dispatcher
  matches on codes; `Cmd` = ⌘ on macOS and Ctrl elsewhere; letters in chords are case-insensitive), text entry via
  `insertText` so React sees real input events.
- `ui_set`: text/number inputs (select, type, Enter), scrubby numbers and other display-mode spinbuttons
  (Enter opens the field), checkboxes, switches, toggle buttons, native selects and ARIA comboboxes/menus, ranges.
- Coordinate mapping registered by the panels themselves (`registerUiLocator`): the Timeline maps frames ↔ x
  (cell centres), tracks ↔ row centres, clips and their edges, and hit-tests a point to frame/timecode/track/clip/
  edge zone with the panel's own `hitTest`; the Program monitor maps sequence pixels ↔ window points with its
  live view transform (zoom, pan, fit).
- Aiming (follow-up, `docs/wp-notes/fixups.md`): an `{id}` target, a `{timeline: {clipId}}` target and `ui_locate`
  aim at the middle of the *visible* part (the element's box clipped by its overflow-clipping ancestors and the
  window; a clip's frames clipped to the visible range and its row to its region's band), so a clip that runs off
  the timeline is still hit. A target with nothing on screen is scrolled into view first: timeline clips, frames
  and track rows through the Timeline's own scroll (`reveal` on its locator; a scrolled-away clip may have no DOM
  element at all), anything else with `scrollIntoView`.
- Screenshots: Electron — `webContents.capturePage` via a new preload IPC (`jasper:capture-page`, rect validated
  in `security.ts`), the real pixels; web — `modern-screenshot` (MIT) DOM rasterisation of the window or one
  element/panel (canvases and videos included; a WebGL canvas without preserved buffers can come out stale — the
  result says so and points to `render_frame`).

**Audit.** `e2e/ui-audit.spec.ts` opens a project with clips, a title with an effect and keyframes, a transition
and a marker, selects the title, then for every workspace focuses and maximizes each of its panels, opens the
panels no workspace shows, opens every menu-bar menu and the clip context menu, and fails on any interactive
element without a stable id (it also checks it saw real content: > 400 elements, > 15 in Effect Controls). The
gaps it found and that were fixed: track-header name / height handle, the video/audio divider, the header-width
resizer, the playhead head, the zoom bar thumb and ends, Effect Controls section headers and keyframe lanes,
Properties/Lumetri section toggles, job rows, dockview tab strips and floating title bars.

## 5. `jasper` CLI

`apps/mcp/src/jasper-cli.ts` (bin `jasper`, bundled to `apps/mcp/dist/jasper.mjs`; `pnpm jasper` from source).
Commands: `status`, `projects`, `describe [type…]`, `exec <type> k=v… | '<json>'`, `run <file.jsonl|->`, `get
<path>`, `set <path> <value>`, `props <clip>`, `inspect [seq]`, `import <file…>`, `render-frame --at --out
[--width]`, `export --out [--preset --range --engine]`, `query <name> k=v…`, `ui <action> k=v…`, `tools`, `call
<tool> k=v…`. It runs the very same tools in process (`createJasperMcpServer` + an in-memory MCP client), so the
CLI, MCP and HTTP behave identically (strict arguments, live editor targeting, approvals, progress on stderr,
Ctrl+C = MCP cancellation → the export is cancelled and its file deleted). Project: `--project <id|name>`,
`JASPER_PROJECT`, the project open in an editor window, or the only project. `--json` = one JSON document per
line; exit status 0 ok, 1 command failed, 2 usage error.

## 6. Scenario QA

`apps/mcp/test/qa/` (`pnpm qa:mcp` = `MCP_QA=1`; also runs with `REMOTION_E2E=1`): a real dev engine on
`MCP_QA_PORT` (49025) and `jasper-mcp` over stdio JSON-RPC; scenarios: rough cut (place, split, ripple delete,
stacking), colour grade (exposure raises luma by > 12, saturation 0 → > 95 % grey pixels, `get_grade` and
`value/evaluated` agree), titles (white-pixel coverage and centroid where placed, moves with `param.set`), cross
dissolve (pure red before, pure blue after, purple at the cut, more red early), keyframes (opacity fade, linear
position: centroid at the midpoint; `get_clip_properties` matches the render), export + re-import (ffprobe frame
count, frames vs `render_frame` mean diff < 6–10, re-imported clip renders the same), and a cancelled `start_export
{wait}` (progress seen, job `cancelled`, no file). Measured 2026-10-07 on the shared 12-core machine: 7/7 pass in
55 s (`node scripts/mcp-qa.mjs`).

## Verified in the real app

Built stack on 49020 (`e2e/agent-ui.spec.ts`, `e2e/ui-audit.spec.ts`): a clip dragged 30 frames by `ui_drag`
landed exactly at frame 30 and `ui_key Cmd+Z` undid it; `ui_set` 40 on the Opacity scrubby → `get_clip_properties`
value/evaluated 40; Program `ui_locate (960, 540)` → `ui_hit` round trip < 2 px; workspace switch through
`ui_command`; window and panel screenshots looked at (`test-results/agent-ui/window.png` shows the editor with
the Program frame, timeline and panels). QA frames looked at in `test-results/mcp-qa/`.

## Comparison with the references

| | EffectCraft / FilmCraft | JasperEditor |
|---|---|---|
| Unknown arguments | top-level only (FilmCraft `-32602` naming accepted keys; EffectCraft command params) | every depth, union members, every tool on the server, typo suggestions, and inside agent commands on every path (MCP, HTTP, in-page) |
| Annotations test | FilmCraft: every tool has title + 4 hints | same + consistency rules + strict JSON Schemas checked |
| Progress / cancel | FilmCraft: one command (`file.exportMedia {wait}`), 100 ms | every waiting tool; partial outputs deleted by the engine for every file-writing job kind, audited |
| `value` vs `evaluated` | EffectCraft: expressions | the renderer's own resolution vs the keyframed value, plus `rendered: false` with a reason |
| Live UI | egui control channel, bridge-only MCP tools | web and desktop through the existing relay; DOM rasterisation or real pixels; timeline and Program mapping incl. clip edges and hit zones |
| Audit | egui widget rects vs automation elements | DOM/React audit over every workspace's panels, menus and a context menu |
| CLI | headless engine per invocation | the live engine (edits appear in the open editor), JSON lines, 0/1/2, `ui`, `call` any tool |
| QA | Rust in-process MCP server | real engine + stdio JSON-RPC, includes export re-import and cancellation |

## Gate

`pnpm lint`, `pnpm typecheck`, `pnpm vitest run --maxWorkers=3` (2 530 passed; the only other failure was the
load-sensitive Lumetri bake timing test, which passes when rerun), Playwright `e2e/agent-ui.spec.ts`,
`e2e/ui-audit.spec.ts`, `e2e/agent.spec.ts` (13/13), `pnpm qa:mcp` (7/7).

## Limits

- Web screenshots are a DOM rasterisation: WebGL canvases created without `preserveDrawingBuffer` may be blank or
  one frame old; cross-origin images would be skipped (all media is same-origin here). Electron captures real pixels.
- Synthetic input is untrusted (`isTrusted: false`): browser-gated actions (fullscreen, clipboard reads, file
  pickers) cannot be triggered by `ui_*`; use the equivalent document or UI command instead.
- The Electron capture path (`jasper:capture-page`) is covered by the rect validation unit test only; no packaged
  desktop app was run here.
- The CLI's `set --at` takes sequence frames or timecode (param.set keys sit on sequence frames), not seconds.

## 2026-10-11 code audit

The MCP audit collapsed eight identical sequence lookup/error conversions into `requireSequence`, five
identical transaction/result helpers into `applyCommands`, and the time-remap clip lookup into the existing
`findClip`. Tool registration, schemas, result fields, approval handling and error text remain unchanged.
Unused progress-reporter configuration/disposal and private-helper exports were removed after checking all
repository references; the request-level disposal and 100 ms progress interval remain.

The audit also reproduced a PNG allocation bug: a 1,096-byte PNG declaring one RGBA pixel expanded to
1,048,576 bytes instead of its five-byte scanline, and the decoder accepted it. The decoder now caps dimensions
at 64 × 1024 × 1024 pixels (the testkit decoder's existing ceiling, allowing 8K), and caps zlib output at the
scanline size declared by the header. Oversized dimensions return `E_LIMIT`; surplus inflated data returns
`E_INVALID_PARAM`, both with an actionable hint. Existing supported images retain their decoding behavior.
`apps/mcp/test/png-limits.test.ts` contains the failing-before regression plus seeded property cases for valid,
overlong and oversized inputs. No test assets were added; its PNGs are generated in memory.

Validation recorded by the audit worker: formatting and `git diff --check` passed; all three new PNG tests
failed against the original decoder. Post-change tests and package typechecking were stopped at the
integrator's request because the shared host was thrashing, and must run in the serial integration gate.
