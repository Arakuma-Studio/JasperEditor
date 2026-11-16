# mcp-cli — agent interface: strict MCP, cancellation, property reads, live-UI automation, `jasper` CLI, scenario QA

Branch `feat/mcp-cli`, ports 49020–49029. References studied: EffectCraft `docs/agents.md`,
`docs/control-protocol.md`, `crates/automation` (`tests/qa/*`), `apps/effectcraft-cli`,
`crates/ui-egui/tests/ui_agent_audit.rs`; FilmCraft `docs/agents.md` (Conventions, Long exports),
`docs/control-protocol.md`, `crates/automation` (`server.rs`, `long_job.rs`), `apps/filmcraft-cli`. Ports are
recorded in `licenses/ported/mcp-cli-effectcraft.md` and `licenses/ported/mcp-cli-filmcraft.md`.

## 1. Strict arguments and annotations

**Design.** `apps/mcp/src/strict.ts` + `packages/project/src/agent/strict.ts`.

- `defineTool` turns each input shape into a *deep-strict* zod schema (`deepStrict`): every fixed-shape object,
  nested ones and union members included, rejects unknown keys (`looseObject`s too, unless marked `OPEN_OBJECT`;
  records and typed catchalls stay open). `describe_tool {full: true}` shows that schema, `additionalProperties:
  false` included; `tools/list` advertises the compact form of `apps/mcp/src/advertise.ts`, and validation does not
  use it.
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
- Long waits that commit (`transcribe`): the wait polls the engine with short `getJob` requests (`waitJob`, every
  250 ms), never one long HTTP request, so `--request-timeout` / the link's request deadline never ends it; it ends at
  `timeoutSeconds` (default 600, max 3600). Reported: about 30 min of batched windows outlived a CLI `transcribe
  {wait: true}` and its words were never committed. Now the jobs keep running when the wait ends early — the
  timeout, or a cancelled request (a client's own tool timeout, Ctrl+C) — and are never cancelled by it (`cancel_job`
  stops them); the first progress message names them and the call that commits them; a timeout is an error
  (`E_TIMEOUT`, nothing committed) whose hint is that exact call, `transcribe {"projectId": …, "jobIds": […]}`;
  and that call now waits for jobs still running (up to `timeoutSeconds`) and commits, instead of refusing
  (`E_NOT_READY` only with `wait: false`). CLI: `--timeout <s>` becomes the `timeoutSeconds` of any `call` whose tool
  has one (capped at its maximum), so a wrapper with its own limit gets that error before it kills `jasper`. Eval case
  `transcribe-commit-after-timeout` (bad). Other waiting tools checked: `process_clip` and `derive_media` resubmit to
  the same engine job or reuse its finished file (dedupe key / recipe hash), so "call again" commits it;
  `start_export`, `render_previews`, `wait_for_job` commit nothing; `normalize_media_loudness` has no dedupe, so
  calling it again after its `E_TIMEOUT` runs the job again (limit).
- Export destinations (`start_export {outputPath}`; CLI `export --out`): an existing file is kept and the export goes to
  `name (2).ext`… (`copyNoOverwrite`) unless `overwrite: true` (CLI `--overwrite`): then `copyReplacing` writes a hidden
  `.<name>.<random>.partial` in the same folder (claimed as the job's partial, so a cancel or failure deletes it and
  the old file stays), fsyncs it, renames it over the old file and fsyncs the folder; caption and credits sidecars
  follow the same choice. The job result has `path` (the file written), `requestedPath` when that is not the path
  asked for, `replaced: true` after an overwrite; every MCP job view (`start_export {wait}`, `wait_for_job`,
  `get_job`) repeats `path` at the top with a `pathNote` naming the kept file and `overwrite: true`. `overwrite`
  without `outputPath` is refused (`E_INVALID_PARAM`). Eval cases `export-overwrite-asked` (bad),
  `export-kept-file-reported` (guard) and `export-new-path-plain` (control).
- An export needs an explicit project. MCP `start_export` always required `projectId`; the CLI's `call` filled it in
  from the editor window (or the only project), so `jasper call start_export '{}'`, meant as a look at the arguments,
  queued a 15-minute export of the open project. `call` now never guesses the project for `start_export`
  (`NAMED_PROJECT_TOOLS`): it needs `projectId`, `--project` or `JASPER_PROJECT`, and otherwise gets the server's
  refusal naming `projectId` (exit 1). `outputPath` stays optional: without it the file is the job's download
  (`/renders/:jobId/output`), the only output an engine outside local mode allows (`LOCAL_MODE_ONLY` refuses export
  paths there) and the one a linked engine on another machine can hand back; requiring it would only make agents
  invent paths. `jasper export` keeps its own guess (it requires `--out`, an explicit intent to export).
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
  result says so and points to `render_frame`). Returned `width` and `height` describe the encoded PNG raster;
  `bounds` describe its target in window CSS pixels. Web dimensions are read from the decoded output image,
  so fractional panel sizes do not make the metadata disagree with the actual raster. The PNG bytes and their
  density metadata remain unchanged.

**Audit.** `e2e/ui-audit.spec.ts` opens a project with clips, a title with an effect and keyframes, a transition
and a marker, selects the title, then for every workspace focuses and maximizes each of its panels, opens the
panels no workspace shows, opens every menu-bar menu and the clip context menu, and fails on any interactive
element without a stable id (it also checks it saw real content: > 400 elements, > 15 in Effect Controls). The
gaps it found and that were fixed: track-header name / height handle, the video/audio divider, the header-width
resizer, the playhead head, the zoom bar thumb and ends, Effect Controls section headers and keyframe lanes,
Properties/Lumetri section toggles, job rows, dockview tab strips and floating title bars.

## 5. `jasper` CLI

`apps/mcp/src/jasper-cli.ts` (bin `jasper`, bundled to `apps/mcp/dist/jasper.mjs`; `pnpm jasper` from source).
Commands: `status`, `projects`, `describe [name…] [--full]` (no name: the command catalogue; a command type:
`describe_commands`; an MCP tool of any toolset: what `describe_tool` returns, one document per tool; a name that is
both prints both, with a note on stderr; neither is `E_NOT_FOUND`, resolved without the engine),
`exec <type> k=v… | '<json>'`, `run <file.jsonl|->`, `get <path>`, `set <path> <value>`, `props <clip>`,
`inspect [seq]`, `import <file…>`, `render-frame --at --out
[--width | --full]` (`--width` ≤ 1280 through `render_frame`, whose image comes back inline and so stays small;
`--full` writes the sequence's full size through `export_frame` — never proxies, format by extension — into the
output's folder under a temporary name and renames it over `--out`, so it needs the engine on this machine), `export
--out [--preset --range --engine]`, `query <name> k=v…`, `ui <action> k=v…`, `tools`, `call
<tool> k=v… [--out f.png]` (`--out` writes every image the tool returns: one to the path, several — e.g. the
previews of an `add_motion_graphic {dryRun, preview}` batch — to `f-0.png`, `f-1.png`… in result order; without
`--out` they go to temporary files; the printed JSON lists the paths in `images`, so no image is dropped). `call`'s
stdout is always one JSON document: a failure prints `{"ok": false, "error"}` there too (with or without `--json`;
the human line stays on stderr), a tool error whose text is not JSON becomes `{"error": {"code": "E_FAILED",
"message"}}`, and the `jasper` bin sends dependency `console.log` to stderr like `jasper-mcp`. An MCP tool name given
as a command (`jasper render_frame`) answers with the command (`render-frame`) and `jasper call render_frame`. It runs the very same tools in process (`createJasperMcpServer` + an in-memory MCP client), so the
CLI, MCP and HTTP behave identically (strict arguments, live editor targeting, approvals, progress on stderr,
Ctrl+C = MCP cancellation → the export is cancelled and its file deleted). Project: `--project <id|name>`,
`JASPER_PROJECT`, the project open in an editor window, or the only project. `--json` = one JSON document per
line; exit status 0 ok, 1 command failed, 2 usage error. Scene files (`apply`, `preview`, `export-scene`): [scene-file.md](scene-file.md).

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

`render_frames` no longer submits one still per frame: since spec 19 TL-103 a sheet is one `still-sheet` job
([title-looks-agents.md](title-looks-agents.md)).

## 7. Easing and Trim Paths tools

Branch `feat/mcp-ease-trim`. The agent surface of the easing commands (`docs/wp-notes/easing.md` § Easing commands)
and the Trim Paths animations (`docs/wp-notes/shapes.md` § 12, `docs/wp-notes/expressions.md` § 1.9). Code:
`apps/mcp/src/tools/ease.ts` (`EASE_GUIDE`), `apps/mcp/src/tools/trim-paths.ts` (`TRIM_PATHS_GUIDE`), read-outs in
`packages/project/src/agent/keyframe-eases.ts` and `properties-query.ts` (`clipKeyframesQuery`). Both guides are in
the server instructions and `jasper://guide`.

**Read-back.** Every keyframe listing of `clip.properties` / `param.get` (clip, transition, track and master
parameters) now carries, per key, the segment **leaving** it as the evaluator draws it: `ease` = `"hold"`,
`"linear"` or `"cubic-bezier(x1, y1, x2, y2)"` (four decimals; auto-bezier eases derived from the neighbours), plus
`easePreset` when a shaped segment matches a built-in preset (`matchEasePreset`, 1e-3) and `roving: true` on roving
keys (their run is one segment, reported on its first key). The last key has no `ease`. The shape is the
evaluator's `segmentShape` (keyframe-sides: the key's outgoing side and the next key's incoming side, listed as
`inInterpolation` when explicit — linear only when both are Linear, a Linear side of a curved segment ⅙·1), with
effect points' auto-bezier eases in their layer-box metric (`resolvePropertyAt`'s `metric`). Linear and hold segments do
not run the matcher, so tracking data and plain fades cost nothing extra; matches are memoised per curve within a
listing. Speeds and influences are left to `get_keyframe_eases` to keep the listing small.

**Key selection** (all ease tools except `transfer_*` / `set_keyframe_velocity`): one of `keyframeIds`, `clipId` +
`properties?` (keys or prefixes as `get_clip_properties` lists them; unknown ones are `E_NOT_FOUND`), or
`effectInstanceId` + `param?` (the effect param as `set_effect_param` / `get_param` address it, `["effect", id,
param]`, on a clip, track or master effect; without `param` every keyframed param of the instance; resolved by the
`param.get` query, so an unknown instance or param is `E_NOT_FOUND`); `from?` / `to?` (sequence times, inclusive) narrow the last two. `create_path_controller` and
`cleanup_motion_path` default to `["transform.position"]`. The tools read the stored document (no expression
binding) so ids are the stored ones.

| Tool | Arguments | Command / notes |
|---|---|---|
| `list_ease_presets` | `{group?}` | groups; per preset `id, name, group, kind` and `cubicBezier` or `points` |
| `get_keyframe_eases` | selection (≤ 2000 keys, else `E_LIMIT`) | `keyframeEasesView`: per property `path, label, clipId, spatial`, keys `{id, frame, timecode, value, interpolation, inInterpolation?, roving?, in/out: {interpolation, influence %, speed, slope}}`, segments `{fromId, toId, section, ease, outInterpolation, inInterpolation, preset?, roving?, averageSpeed}` (side types: the outgoing type of the first key, the type the last key's incoming side acts as), `span.preset` for 3+ keys whose run matches a preset (2e-3); speeds in layer px/s for effect points |
| `apply_ease` | selection, `curve`, `sections?` | `keyframe.applyEase`; result `{affected, created, removed}` + the read-back of the resulting keys |
| `transfer_ease` | `fromKeyframeIds, toKeyframeIds, sections?, mode?` | `copyEase` on the current document, then `keyframe.pasteEase` (one step; returns what was copied — one key: both sides with their `interpolation`, influence %, slope) |
| `transfer_keyframe_values` | `fromKeyframeIds, toKeyframeIds` | `copyValues` + `keyframe.pasteValues` |
| `set_keyframe_velocity` | `keyframeId, side, speed?, influence? %` | `keyframe.setVelocity` (one of speed / influence required) |
| `create_path_controller` | selection, `replaceExpression?` | `keyframe.createPathController`; also returns the slider's `param.set` target |
| `cleanup_motion_path` | selection, `tolerance?` | `keyframes.cleanupPath` (tolerance in sequence px for Motion, layer px for effect points) |
| `animate_trim_paths` | `clipIds, style, reverse?, animateOffset?, duration?, offsetDegrees?, copies?, inOutLag?, at?, curve?, tracer?, sequenceId?` | `shape.animateTrim` (+ `shape.addTrimTracer` per animated clip); returns per clip `trimId`, its Start / End / Offset keys with frames and eases, parts, tracer |
| `reverse_path_direction` | `clipIds` | `shape.reversePathDirection` |
| `add_line` | `orientation, length?, strokeWidth?, color? "#RRGGBB(AA)", at?, duration?, track?, name?, sequenceId?` | `shape.addLine` |
| `add_trim_tracer` | `clipId, trimItemId?, pathItemId?, tip?, followerClipId?, orient?, name?` | `shape.addTrimTracer` |

- **Curves** (`parseCurveArg`): a preset id or name (case-insensitive), a CSS keyword (`linear`, `ease`,
  `ease-in`, `ease-out`, `ease-in-out` → the `basic.*` preset with that timing), `"cubic-bezier(a, b, c, d)"` (exactly
  four plain decimal numbers, x in 0…1, y in ±10; hex, `NaN`, `Infinity` and wrong counts are refused),
  `{x1, y1, x2, y2}` or `{points}` (validated by `MultiEaseSchema`). Unknown presets name close ids. Trim Paths take
  cubic curves only (`parseCubicCurveArg`; multi presets refused with a hint).
- **Durations** (`animate_trim_paths`, `add_line`): frames, `{frames}`, `{seconds}` or a timecode counted from 0
  (the sequence start timecode is not subtracted, unlike a time).
- **Trim + tracer atomicity.** The tracer needs the master trim's id, which only exists after `shape.animateTrim`
  ran. `shape.addTrimTracer`'s `trimItemId` is now optional (default: the clip's master trim — Part 1's last trim
  after a divide, else the last top-level item when it is a Trim Paths; none → `E_INVALID_PARAM`), so the tool sends
  `[animateTrim, addTrimTracer × animated clips]` as **one transaction = one History entry**. Which clips animate is
  the command's decision (others warn `W_TRIM_SKIPPED`), so the tool dry-runs the animation first and adds tracers
  only for the clips it reports.
- Annotations: reads `READ_ONLY`; `apply_ease`, `transfer_ease`, `cleanup_motion_path` destructive-idempotent (a
  multi-point curve or a clean-up deletes keys); `set_keyframe_velocity`, `transfer_keyframe_values` idempotent
  setters; `animate_trim_paths` destructive (re-running replaces an animation; a tracer is added each time);
  `create_path_controller`, `reverse_path_direction` (a toggle), `add_line`, `add_trim_tracer` additive.
- `describe_commands` examples: `keyframe.applyEase`, `keyframe.pasteEase`, `keyframe.pasteValues`,
  `keyframe.setVelocity`, `keyframe.createPathController`, `keyframes.cleanupPath`, `shape.addTrimTracer` (next to
  trim-core's `shape.addLine`, `shape.animateTrim`, `shape.reversePathDirection`); the test applies all of them to a
  real document.

**Tests.** `apps/mcp/test/ease-trim.test.ts`: every tool against an in-process engine stand-in that applies
transactions with the real command system, answers queries with `runAgentQuery` and keeps an undo stack; read-back
after apply (cubic presets of four groups, `bounce.out-3` → `span.preset`), sections, transfer / velocity / path
controller / clean-up, refusals and strict-argument errors (nothing applied), undo of agent entries, trim + tracer as
one transaction, re-runs replacing, skipped clips without tracers, multi curves refused for trims; the curve parser
with fast-check (any string parses or is `E_INVALID_PARAM`; cubic strings round-trip; out-of-range x refused); the
command examples; the guide resource. `packages/project/test/vector/tracer.test.ts`: the default master trim,
including after a divide in the same transaction.

Measured 2026-10-20 on the shared host (load average ≈ 57–60), `--maxWorkers=1`: `pnpm exec vitest run` of
`apps/mcp/test/{ease-trim,conventions,vector-shapes,animation,unit,bundle}.test.ts`,
`packages/project/test/{vector/tracer,agent-mcp-cli,agent,ease-clipboard}.test.ts`,
`packages/session/test/trim-tracer.test.ts`, `packages/expressions/test/{trim-tracer,bind}.test.ts`: 13 files,
92 tests passed. `pnpm --filter @jasper/project typecheck`, `pnpm --filter @jasper/mcp typecheck`,
`node scripts/check-layers.mjs` and `biome check` on the changed files: pass. Not run here: the full `pnpm verify`
gate, the opt-in `pnpm qa:mcp` scenarios and a live editor session (the History / undo path was exercised through the
engine stand-in's undo stack, not `EditorSession`).

**Limits.** `get_keyframe_eases` / read-backs resolve properties with the built-in registries: keyframed params of
motion-graphic templates the MCP process does not know are not described (the commands themselves run in the
engine / editor with the real registries). Segments into / out of a selection name their outside key by id only (its
frame is in `get_clip_properties`). `span.preset` matching on point properties is subject to the arc-length tables'
accuracy (≈ 0.2 % of the path) and may not match at 2e-3.

## 8. Headless `undo` / `redo`

`undo` / `redo` (`history.undo` / `history.redo`) used to fail with `E_NO_SESSION` whenever no editor had the project
open, although headless agent edits worked. With an editor session holding the lease the editor still owns History
(relayed, unchanged). Otherwise `AgentService` steps through `HeadlessHistory` (`apps/engine/src/agent/headless-history.ts`):

- Each saved headless transaction records its before / after documents (snapshots, as the editor's History, D-05) and
  the revision it was saved as. Undo saves the before snapshot, redo the after one, each as a new revision through the
  project store (If-Match, atomic write), under the project's lock and the same lease check as any headless edit;
  `doc.changed` carries `isUndo` / `isRedo`. A new headless transaction clears the redo stack.
- Refusals: nothing recorded → `E_NOT_FOUND`; the entry is the user's (a headless proposal accept) or another agent's →
  `E_NOT_OWNER`; the stored project is not at the revision the history recorded (an editor, another writer or a version
  restore saved since) → `E_NOT_OWNER` naming both revisions, and the history of that project is dropped, because no
  older entry can be restored without discarding that change. The code and its hint are the ones the editor gives when
  someone else's entry is on top, so the MCP text did not change; only "Needs the project open in the editor" left the
  two descriptions.
- Memory: the history keeps the document each project is at, and the next headless transaction applies on that object
  while the stored revision is still the one it saved (instead of a fresh load), so snapshots share structure as in the
  editor's History and an entry costs what its transaction changed.
- Limits (decided): the history is in the engine process's memory, at most 16 entries per project, 32 across all
  projects (the least recently edited project loses its oldest entries first) and 8 projects; an engine restart forgets
  it. It is not persisted: a snapshot on disk would be a whole document per entry, and the editor's own History is per
  session too. While an editor has the project open, undo goes to its History, which does not hold
  the earlier headless steps; they are undoable again after it closes only if it saved nothing. Nothing to undo is
  `E_NOT_FOUND` as in the editor, whose MCP hint speaks of ids (the message says what happened). `history.list` still
  needs an editor session.
- Tests: `apps/engine/test/agent.test.ts` "headless undo / redo" (undo and redo round trip as new saved revisions;
  refusals with the project left untouched; the oldest project's undo refused with `E_NOT_FOUND` past 32 entries).

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
