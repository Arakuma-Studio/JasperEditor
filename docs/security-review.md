# Security and correctness review (parity program, workstream `review`)

An adversarial review of the high-risk surface of JasperEditor after the parity workstreams landed
(`integrate/parity` at 85a90e3d, then 065af535 with workstream `gaps`): the engine's HTTP and WebSocket surface,
the expressions sandbox, the agent surface (MCP, CLI, live-UI automation), data integrity (commands, undo,
persistence), export routing and the Electron shell.

Every finding below was confirmed with a failing test or a reproduction, fixed at its cause, and has a regression
test that failed before the fix. Section 5 lists what was reviewed and found sound; section 6 lists the risks that
remain, on purpose or for lack of a cheap fix. Nothing here was measured against other software.

## 1. Threat model

JasperEditor is a single-user, local application: a browser or Electron window talks to an engine on loopback,
which runs FFmpeg and other child processes with the user's privileges. The assets worth protecting are the user's
files (projects, media, anything else the user can read), the user's work (never lost, never silently changed), and
the user's machine (no code execution the user did not ask for).

| Attacker | What they control | What must hold |
|---|---|---|
| **A web page** in the user's browser | Requests to `127.0.0.1:<port>` (no custom headers cross-origin, an `Origin` header on writes and WebSockets), DNS names | Cannot call the engine: Host allowlist (DNS rebinding), Origin allowlist (CSRF), token or `SameSite=Strict` cookie in packaged builds |
| **A file the user opens or imports** | Project files, media and their metadata, SVG, Lottie / dotLottie, PSD, LUTs, OCIO configs, caption and timeline documents, zip uploads, file *names* | Parsed without crashing, without reading or writing files it does not name legitimately, without running code; expressions stay inside the sandbox and cannot affect other projects |
| **An agent** driving the editor over MCP (possibly prompt-injected) | The MCP tools, the CLI, the live-UI tools | Cannot delete projects, sequences, tracks or media, run `force` commands, or do anything irreversible without the user's approval in the editor (S01:AGT-011); cannot approve itself; cannot make the app run a program |
| **A network peer** | Model download hosts and redirects | Only catalogue-pinned bytes are installed (sha256); a download cannot fill the disk |
| **Another local process as the same user** | Everything the user can do | Out of scope: it can already read the token file and the user's files. Section 6 says where this matters (dev engines have no token) |

Trusted by design: the application's own code and binaries, the user's own input, and **motion-graphics bundles**
(Remotion projects are code; importing one runs it, section 6).

## 2. Findings

Severity: **High** = code execution, deletion or disclosure of the user's files, a bypass of the agent approval
gate, or a common edit made impossible; **Medium** = needs an unusual precondition, or limited impact; **Low** =
hardening and robustness.

| Id | Severity | Finding | Fix |
|---|---|---|---|
| AGT-1 | High | An agent could bypass the approval gate through the live-UI tools | Trusted-input approvals, session transaction guard, refused commands |
| ENG-4 | High | Project ids from URLs and bodies were used as paths: `rm -rf` and reads outside the appdir | Ids validated at the appdir layout and at the call sites |
| ENG-5 / ELE-2 | High | Edit Original could run a program (Windows command injection; a denylist of program types) | One allowlist of media types; no `cmd.exe` |
| EXPR-1 | High | One expression could change every later expression of every project | Hardened QuickJS realm |
| DATA-2 | High | Edits that shorten a placed nested sequence were refused | Invariant corrected |
| DATA-7 | High | Splitting, duplicating or pasting clips with text animators or Puppet pins was refused | Children re-identified |
| ENG-3 | Medium (High on Windows) | File paths in FFmpeg filter text were escaped for one of two parsing levels | Two-level escaping |
| ENG-1 | Medium | Imported SVG ran script with the engine's origin when opened as a document | `nosniff` and `CSP: sandbox` on served user content |
| EXPR-2 | Medium | An expression that exhausts the heap blocked its thread for seconds per frame | Quarantine |
| DATA-3 | Medium | Timeline (interchange) exports silently overwrote files | Free name chosen first; exclusive copy |
| DATA-4 | Medium | A hostile OCIO config copied arbitrary files into the project | Only LUT/CDL files that parse |
| ELE-1 | Medium | Packaged Electron builds honoured `NODE_OPTIONS` and `--inspect`, no asar integrity | Fuses |
| ENG-6 | Low | Export and still sizes were unbounded | Named refusal above 16384 px |
| ENG-2 | Low | A model download could write an endless body | Stops at the catalogue size |
| DATA-5 | Low | A Lottie file embedded any file next to it | Picture bytes only |
| DATA-6 | Low | Schema backups and versions were copied non-atomically | Atomic copy |
| ZIP-1 | Low | A bundle zip entry was inflated wholly in memory (up to 4 GiB) | Streamed to disk |
| PAR-1 | Low | An out-of-range character reference in SVG threw `RangeError` | Replaced by U+FFFD |
| SSH-1 | Low | An SSH user name starting with `-` became an `ssh` option | Refused |

### AGT-1 — the live-UI tools bypassed the approval gate (High)

The `ui_*` MCP tools act like the user in the editor window (synthetic DOM events). `apply_commands` waits while
the approval card is open, so an agent could issue a destructive transaction and click **Approve** on its own
request with `ui_click`. It could also skip the gate: `ui_key Delete` on project items, `ui_command`
`edit.removeUnused`, `history.clear {"confirmed": true}` (the confirmation is an argument) or `file.revert` all ran
as the user.

Fix (`apps/web/src/agent-bridge/agent-input.ts`, `shell/AgentApprovals.tsx`, `commands/registry.ts`,
`packages/session/src/session.ts`):

- Approving needs a *trusted* event; synthetic input never is. Denying stays possible (it only refuses).
- Every live-UI input action runs as agent input. While it runs, and for 1.5 s after it unless the user has pressed
  a key or the pointer since (asynchronous handlers, confirmation dialogs), the session refuses user-origin
  transactions that need approval (`E_APPROVAL_DENIED`, "run them with apply_commands, which asks the user"),
  through a new `EditorSession.addTxGuard`.
- `history.clear` and `file.revert` are refused for agent input.

Tests: `apps/web/test/agent-ui-guard.test.tsx`. The MCP guide text for the UI tools states the limits.

### ENG-4 — project ids used as paths (High)

`DELETE /api/projects/:projectId/recovery/:sessionId` and its `GET` built
`<appdir>/projects/<projectId>/recovery/<sessionId>` without validating the id, and Fastify decodes `%2F` in a path
parameter. `..%2F..%2F…` removed (recursively) or read `<anywhere>/recovery/<name>`; a path parameter is at most
100 characters, which bounds the depth, not the bug. `POST /api/media-jobs` took any string as `projectId` and
wrote under it without the local-mode check.

Fix: `appdirPaths` (`packages/config`) refuses any id that is not a single path segment (`AppdirPathError`, HTTP
400), so a caller that forgets to validate cannot leave the appdir; the recovery store and media jobs validate the
project id explicitly. Also fixed there: the partial file of an extensionless ingest copy was `.partial` in the
engine's working directory (`slice(0, -0)`).

Tests: `apps/engine/test/security-review.test.ts` (ENG-4).

### ENG-5 / ELE-2 — Edit Original could run a program (High)

Workstream `gaps` added `POST /api/media/:mediaKey/open` (also the MCP tool `locate_media {action: "open"}`) and the
desktop bridge `openPath`. Two defects:

- On Windows the engine ran `cmd.exe /c start "" <path>`. Node quotes an argument only when it contains a space, so
  a file named `a&calc.exe&.mp4` ran `calc.exe`.
- Both refused a list of known program extensions. The OS opener runs whatever a type is associated with: `.hta`,
  `.pif`, `.cpl`, `.reg`, `.scpt`, `.workflow`, `.inetloc`, `.py` were opened, and so were files without an
  extension (macOS runs an extensionless Unix executable in Terminal). Media are probed by content, so a
  picture/script polyglot registers as media; the desktop bridge opened any absolute path the renderer named.

Fix: one allowlist of media, picture, document, caption, timeline, model and LUT extensions
(`OPENABLE_EXTENSIONS` in `@jasper/config`, mirrored in `apps/desktop/src/security.ts`, a test keeps them equal);
everything else is revealed in the file browser instead. The Windows opener is
`powershell -Command "Invoke-Item -LiteralPath $env:JASPER_OPEN_PATH"` with the path in the environment.

One expectation of the gaps workstream's desktop test changed: an extensionless path is no longer openable (that
was the defect). Tests: `security-review.test.ts` (ENG-5), `apps/desktop/test/security.test.ts`,
`apps/engine/test/gaps-routes.test.ts`. The PowerShell opener could not be run here (no Windows host); its
construction is tested, its behaviour on Windows is not.

### EXPR-1 — expressions shared one mutable realm (High)

One QuickJS context serves every document a process evaluates (all projects of an engine, every project a tab
opens). An expression could assign `Math.sin`, `Array.prototype.map`, `JSON.stringify` or the prelude's own helpers
and change the result of every later expression in every project until restart; implicit globals (`x = 5`) and
`globalThis.k` persisted between evaluations, so results depended on evaluation order (preview could differ from
export); `new Date().constructor.now()` reached the real clock.

Fix (`packages/expressions/src/harden.ts`, `compile.ts`, `runtime.ts`): after the prelude loads, every object
reachable from the global object is deep-frozen (built-ins, hidden intrinsics, the prelude's prototypes), every
global binding becomes read-only except the per-evaluation state the prelude restores itself, the global object is
made non-extensible, and the original `Date` is pinned. Implicit globals are declared as locals of the compiled
function, so `x = 5; x * 2` still works inside one evaluation. A few inherited properties ordinary code overrides
on its own objects (`toString`, `valueOf`, error `name`) are accessors, so `obj.toString = f` keeps working.

No escape from the sandbox to the host was found: no `std`/`os` modules are linked, the only host function takes a
numeric op and JSON, and results are type-checked on the way out. Tests: `packages/expressions/test/sandbox.test.ts`.

### EXPR-2 — heap exhaustion blocked the thread (Medium)

`var a = []; while (1) a.push(new Array(1e5).fill(1))` took 5–8 s per evaluation: at the memory limit the time is
spent in QuickJS's allocator and collector, where the interrupt hook cannot fire, so neither the operation budget
nor the wall clock stops it. Per frame and per property that freezes the editor or the engine.

Fix: an expression text that ran out of memory, or failed after more than twice the wall-clock limit, is not run
again in that realm (it reports the error at once). The loop, recursion and string limits were verified to work.

### DATA-2 — shortening a placed nested sequence was refused (High, correctness)

Found by the integrity property test. INV-005 refused any document in which a nest clip was longer than its nested
sequence's content, so lifting or trimming the last clip inside a placed nest, or deleting media used inside it
(multicam angles too), failed with `E_INVARIANT`. As in Premiere, the nest clip now keeps its length and shows
nothing past the content; trim handles still stop at the content's end, and the incremental checker falls back to
the full check when a nested length changes, so both stay equal. Test: `packages/project/test/nest-shorten.test.ts`.

### DATA-7 — copies of clips kept the ids of some children (High, correctness)

Found by the same property test. The right part of a split, a duplicate and a paste re-identified keyframes,
effects, markers, masks, trackers and rotos, but not text animators with their selectors nor Puppet meshes with
their pins, so those edits were refused with `E_INVARIANT` (INV-001 duplicate id): a text clip with an animator
could not be razored. Fixed in `reidentifyClipChildren`; pins follow their mesh's new id.
Test: `packages/project/test/split-children-ids.test.ts`.

### ENG-3 — filter-text paths escaped for one parsing level (Medium; High on Windows)

FFmpeg unescapes filter text twice (graph, then filter options). `lut3d`, `metadata` and vid.stab paths were
quoted once, so the option parser split every path at `:` — every Windows path (`C:/…`), which means every LUT or
colour-managed native export failed there — and a `'` or `:` in a file name broke the filter or injected options
into it. On POSIX, backslashes in names were rewritten to `/`. Fix: `apps/engine/src/tools/filter-text.ts`.
Test: real FFmpeg loads LUTs from hostile names (`security-review.test.ts`, ENG-3).

### ENG-1 — imported SVG as a document (Medium)

`/media/<key>` served an imported SVG as `image/svg+xml` from the engine's origin. Media keys derive from the
content, so the author of an SVG knows its URL; on an engine without a token (`pnpm dev`) a page could open it and
its script ran same-origin, with the whole API. Packaged builds were protected by the `SameSite=Strict` cookie.
Fix: served user content carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`
(motion-graphics bundle files, which must run, opt out).

### DATA-3, DATA-4, DATA-5 — imports and exports touching files they should not (Medium / Low)

- **DATA-3.** Interchange exports (FCP XML, FCPXML, OTIO, EDL, AAF, OMF, ALE) copied the document and its side
  media over existing files; media exports never overwrite. The export now picks the first free stem (`Cut`,
  `Cut (2)`…, also when the `<stem> Media` folder exists) before writing the document, and copies exclusively.
- **DATA-4.** Importing a `.ocio` config bundled the text of every file its `FileTransform`s name, by absolute path
  or `../` on the search path, up to 64 MiB each: a hostile config copied `~/.ssh/id_rsa` into the bundle that
  travels with the project. Only files with a LUT or CDL extension that also parse as one are bundled; the rest
  are listed as missing.
- **DATA-5.** A Lottie file embedded any file inside its own folder as an "image" (a Lottie in `~/Downloads` could
  carry a neighbouring PDF into the project). Only picture bytes (PNG, JPEG, WebP, GIF, SVG) are embedded.

### ELE-1 — Electron fuses (Medium, hardening)

Packaged builds now disable `NODE_OPTIONS` and `--inspect`, validate and load only the asar, encrypt cookies and
drop the `file://` extra privileges (`electronFuses` in `apps/desktop/package.json`, electron-builder 26).
Run-as-node stays on because Help ▸ Connect an AI Agent launches the bundled `jasper-mcp` that way (section 6).
The configuration is pinned by a test. Checked on Linux with a copy of the Electron 44 binary: the desktop main
packed as `app.asar`, the same fuses written with `@electron/fuses`, booted under Xvfb in packaged-like mode
against the built engine and web app — the app loaded from the asar, the engine forked and the editor loaded;
`--inspect` opened no port and a `NODE_OPTIONS=--require` script did not run; `ELECTRON_RUN_AS_NODE` still worked.
The installers themselves were not built (section 7).

### Low

- **ENG-6.** `ExportSettings.video.width/height` and the still `width` had no bound; frame buffers are sized by
  them. The planner refuses more than 16384 px a side by name. (A hostile *sequence* size was already clamped to
  8192 px by `repairDocument` on load.)
- **ENG-2.** Model downloads were verified (sha256, pinned revision URLs) only after the whole body was on disk; a
  mirror or redirect target could stream an endless body. Both downloaders stop at the catalogue size.
- **DATA-6.** The pre-migration schema backup and project versions were plain `copyFile`s; a crash mid-copy left a
  truncated file, and for the schema backup the existence check then prevented the real one for ever. They are
  copied to a temporary file, synced and renamed.
- **ZIP-1.** `extractZip` (motion-graphics bundle uploads) inflated each entry in memory up to its declared size;
  a small archive could ask for gigabytes. Entries are streamed to disk and cut at their declared size. Paths were
  already safe (no absolute names, `..`, drive letters, symlinks; 8 GiB and 50 000 entries in total).
- **PAR-1.** `&#x110000;` in an SVG threw `RangeError` out of the importer (an untyped engine error).
- **SSH-1.** A remote-executor user name such as `-oFoo` was accepted and reached `ssh` as part of `user@host`.

## 3. Tests added

| File | What it holds |
|---|---|
| `packages/expressions/test/sandbox.test.ts` | Realm isolation (10 poisoning vectors), implicit globals, clock, override taming, limits, quarantine |
| `apps/web/test/agent-ui-guard.test.tsx` | Session guard, irreversible commands, approval card |
| `apps/engine/test/security-review.test.ts` | ENG-1…6, DATA-4/5/6, WebSocket `/agent` Host, Origin and token checks |
| `apps/engine/test/export-coverage.test.ts` | EXP-1, below |
| `packages/session/test/integrity-property.test.ts` | DATA-1, below |
| `packages/project/test/nest-shorten.test.ts`, `split-children-ids.test.ts` | DATA-2, DATA-7 |
| `packages/project/test/vector/svg.test.ts`, `apps/engine/test/interchange.test.ts`, `gaps-routes.test.ts`, `apps/desktop/test/security.test.ts` | PAR-1, DATA-3, ENG-5, ELE-1/2 |

**DATA-1, the integrity property** (`fast-check`, 40 runs by default, 400 with `FUZZ=1`): random transactions
through a real `EditorSession` over 32 step kinds — masks, time remap, multicam recording and flattening, roto,
camera tracker, 3D, cameras, captions, text animators, expressions, effects, keyframes, speed, proxies, audio
channel mapping, sequence format, Warp Stabilizer, and the core move / trim / split / lift / delete edits. After
every step: a refusal leaves the document reference unchanged and is never `E_INVARIANT` or `E_INTERNAL`; the
incremental autosave serialisation equals `JSON.stringify`. At the end: `loadProject` of the JSON gives the same
document with no repairs and no issues; undoing every step restores each earlier document and the exact initial
one, redoing restores the exact final one. It found DATA-2 and DATA-7. About 2 800 further random sequences
passed after the fixes (seven `FUZZ=1` runs).

**EXP-1, export coverage**: with the engine's real native extensions, every registered video effect (375), video
transition (172), audio effect, and the clip kinds and features built from commands is checked to be rendered
natively by a stage that implements it, baked by an extension, or refused by a blocker (or a plan error) that
names it — and, when not native, actually drawn by the compositions. Result at this commit: 8 effects native
(crop, flips, colour ops), 366 baked, Warp Stabilizer refused by name until analysed, 170 GPU transitions baked and
the 2 built-in ramps rendered as fades, all 60 audio effects with an export processor, 3D layers named. No silent
drop was found.

## 4. Decisions

- **Refuse, do not ask, for agent UI input.** A destructive edit triggered through the UI tools is refused with a
  message that points at `apply_commands`; routing it into the approval dialog would need every UI command to be
  resumable.
- **Quarantine by expression text.** An out-of-memory failure is deterministic for a given text and state; a
  legitimate After Effects expression does not approach 64 MiB. An expression that exhausts the heap only at some
  times is then disabled at all times in that realm (section 6).
- **Allowlist for the OS opener.** A list of program types cannot be complete.
- **The nest bound is an editing rule, not a document invariant.** Premiere's behaviour; the alternative
  (shortening the outer clips automatically) changes timelines the user did not touch.
- **Frozen intrinsics over a context per evaluation.** A fresh QuickJS context per property per frame is orders of
  magnitude too slow.

## 5. Reviewed and found sound

- **Auth.** One global `onRequest` hook: Host allowlist on every request, Origin allowlist when the header is
  present (opaque `null` refused), constant-time token comparison, `/health` the only public path, signed URLs for
  `GET`/`HEAD` of media, fonts, renders only. The WebSocket upgrade goes through the same hook (now tested). A
  non-loopback bind without a token is refused. `runtime.json` is written 0600.
- **File-serving routes** (`/media`, `/mg`, `/mg/layers`, `/mg/roto`, `/mg/bundles`, `/renders/…`, `/fonts`):
  names and keys are matched against strict patterns or a containment check; no traversal.
- **Path-taking routes** are refused outside local mode, require absolute paths, and resolve media through the
  registry only (`mediaKeyOf`: path and URL locators of a client document are never trusted). Media exports and
  Export Frame never overwrite. Project Manager and ingest pick free names; a client-supplied `originalName` cannot
  leave the destination.
- **Child processes.** Argument arrays everywhere, no shell. Speech, roto and camera-tracking workers get an
  engine-written JSON spec path. Remote-executor commands quote every path; settings are validated.
- **Prototype pollution.** Fastify rejects `__proto__` in bodies; zod drops it from records; loaded documents get
  null-prototype records.
- **Parsers.** XML parsers skip DOCTYPE subsets (no entity expansion) and bound depth; the OCIO YAML subset has no
  anchors; the dotLottie reader bounds entries; PSD reading is capped by ag-psd's total memory limit; uploads are
  bounded by declared size, free disk and a 24 h expiry; folder scans by depth and count, without following
  symlinked directories.
- **Agent gate for transactions.** The engine classifies before relaying; `approved` is set only by the engine;
  address resolution cannot change a command's type or add `force`; no handler deletes sequences, tracks or media
  on behalf of another command type; unknown keys are refused at any depth; the processing-settings tool always
  asks for approval.
- **Persistence.** Saves are atomic with revision checks under a per-project mutex; restores keep the replaced
  state; schema backups are never pruned; hostile sequence sizes are clamped on load with a report.
- **Electron.** `contextIsolation`, `sandbox`, no node integration; every IPC handler checks the sender's origin;
  `openExternal` only for http(s) and mailto; navigation and new windows guarded; permissions limited to the
  microphone, clipboard and fullscreen for the app origin.

## 6. Residual risks

1. **Motion-graphics bundles are code.** Importing a Remotion project runs its CLI and config in Node; a bundle's
   pages run in a same-origin, unsandboxed iframe in the editor, with the engine API and, in the desktop app, the
   desktop bridge of the parent window. A bundle is as trusted as a plug-in. Sandboxing the live host needs a
   different origin or a message-based protocol.
2. **Dev engines have no token** (`pnpm dev`, and the engine an MCP client starts from a checkout uses a per-launch
   token only with `--start-engine`). Any local process, including other users of the same machine, can use a
   token-less engine with the engine user's file access.
3. **An authenticated local client is the user.** It can register media by path, read caption files, write exports
   to new paths, and attach to `/agent` as an editor session, which can answer approval requests. The approval gate
   protects against agents confined to the MCP tools, not against code that holds the token.
4. **Agents can delete things outside the gate** that are regenerable or outside the project: cached renders,
   models, and effect presets in the user's library (`delete_effect_preset`; not undoable).
5. **Expression cost.** One evaluation may take up to 2 s of wall clock; many heavy expressions make rendering
   slow (cancellable). The quarantine disables an expression that exhausts the heap for the realm's lifetime, also
   at times when it would have succeeded.
6. **Run-as-node stays enabled** in packaged builds for the bundled `jasper-mcp`; with it a local process can run
   JavaScript as the application binary (and inherit its macOS privacy grants).
7. **Memory ceilings are high**: PSD reading up to 3 GiB, OCIO bundles 256 MiB, bundle zips 8 GiB on disk.
8. **The OS opener decides by type association and sometimes by content.** An allowlisted extension does not
   guarantee a harmless handler on every system; `explorer.exe /select,` with commas in a path may select the wrong
   item.
9. **Version retention can be set to 1** in Preferences; older versions are then pruned on the next save.

## 7. Not done

- No installer was built: `scripts/package.mjs` stages FFmpeg under the shared `vendor/` directory, which this
  workstream may not modify. The fuses were exercised on a fused copy of the Linux Electron binary (ELE-1); asar
  integrity validation only exists on macOS and Windows and was not exercised. The Windows opener (ENG-5) is tested
  by construction only: no Windows host.
- Not re-audited line by line: the 375 shader sources, the Rust motion-graphics renderer, the audio DSP, the AAF /
  OMF binary readers and the glTF reader (their owners' fuzz suites cover them), and third-party packages.
