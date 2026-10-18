# Security and correctness review (parity program, workstream `review`)

An adversarial review of the high-risk surface of JasperEditor after the parity workstreams landed
(`integrate/parity` at 85a90e3d, then 065af535 with workstream `gaps`): the engine's HTTP and WebSocket surface,
the expressions sandbox, the agent surface (MCP, CLI, live-UI automation), data integrity (commands, undo,
persistence), export routing and the Electron shell.

Every finding below was confirmed with a failing test or a reproduction, fixed at its cause, and has a regression
test that failed before the fix. Section 5 lists what was reviewed and found sound; section 6 lists the risks that
remain, on purpose or for lack of a cheap fix. Nothing here was measured against other software.

Section 8 is the follow-up (workstream `hardening`): it closes the residual risks of the first review that could be
closed — approvals over `/agent`, destructive operations outside the gate, token-less engines, same-origin
motion-graphics pages — evaluates run-as-node, audits the AAF / OMF / CFB and glTF readers and tests the Windows
opener. Sections 6 and 7 describe the state after it.

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
| **Another local process as the same user** | Everything the user can do | Out of scope as an attacker on the user's files (it can read them). It holds the token; it does not hold the editor key, so it cannot answer approvals or run the gated operations (section 8, AGT-2 / AGT-3; section 6 says what remains) |

Trusted by design: the application's own code and binaries, the user's own input, and the **source of a
motion-graphics project** when it is built (Remotion projects are code; section 6). A bundle's page in the editor is
not trusted any more: it is sandboxed (section 8, MG-1).

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
(`OPENABLE_EXTENSIONS` in `@jasper/config`, used by the engine and desktop through `isOpenableFile`);
everything else is revealed in the file browser instead. The Windows opener is
`powershell -Command "Invoke-Item -LiteralPath $env:JASPER_OPEN_PATH"` with the path in the environment.

One expectation of the gaps workstream's desktop test changed: an extensionless path is no longer openable (that
was the defect). Tests: `security-review.test.ts` (ENG-5), `apps/desktop/test/security.test.ts`,
`apps/engine/test/gaps-routes.test.ts`. The PowerShell opener could not be run here (no Windows host); its
construction is tested, its behaviour on Windows is not. (Follow-up, section 8 WIN-1: the quoting is now tested
under the parsers involved and the command runs through a real PowerShell.)

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
again in that realm (it reports the error at once). The loop, recursion and string limits were verified to work. (Follow-up: every
resource-limit kill quarantines — heap, operation budget, wall clock — because on a busy host the 2 s wall clock
tripped before the heap limit and the slow loop was run again every frame; section 8, EXPR-3.)

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
(motion-graphics bundle files, which must run, opted out; since the follow-up they run only under their own
sandboxing policy, section 8 MG-1).

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
| `e2e/security-review.spec.ts` | AGT-1 in the real app over `jasper-mcp`: `ui_click` on Approve approves nothing (it did before the fix), the user's click does; `ui_command history.clear {confirmed}` is refused |
| `apps/engine/test/security-review.test.ts` | ENG-1…6, DATA-4/5/6, WebSocket `/agent` Host, Origin and token checks |
| `apps/engine/test/export-coverage.test.ts` | EXP-1, below |
| `packages/session/test/integrity-property.test.ts` | DATA-1, below |
| `packages/project/test/nest-shorten.test.ts`, `split-children-ids.test.ts` | DATA-2, DATA-7 |
| `packages/project/test/vector/svg.test.ts`, `apps/engine/test/interchange.test.ts`, `gaps-routes.test.ts`, `apps/desktop/test/security.test.ts` | PAR-1, DATA-3, ENG-5, ELE-1/2 |
| `apps/engine/test/security-hardening.test.ts` | Follow-up (section 8): AGT-2, AGT-3, DEV-1, MG-1 on the engine |
| `packages/compositions/test/mg-host-remote.test.ts` | MG-1: the host agent and the editor's remote; hostile page replies |
| `packages/interchange/test/hostile.test.ts`, `packages/project/test/three-d-hostile.test.ts` | PAR-2: crafted AAF / OMF / CFB / glTF files, field-aware mutation |
| `apps/engine/test/windows-opener.test.ts`, `node-runtime.test.ts` | WIN-1, RUN-1 |

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

Rewritten after the hardening follow-up (section 8), which closed or narrowed the first list. What remains:

1. **Importing a Remotion project builds it.** A motion-graphics bundle's *page* is now sandboxed in the editor
   (MG-1), but importing a project *folder* (File ▸ Import Remotion Project, `import_mg_bundle {path}`, watch
   rebuilds, `scaffold_mg_project`) runs that project's own Remotion CLI and `remotion.config.ts` in Node with the
   user's privileges, and rendering a bundle runs its code in the engine's headless browser (section 8, MG-1, "trust
   model for export"). The build needs a project whose dependencies are already installed on this machine, in local
   mode; a built bundle (zip upload) is never built. A source project is as trusted as a plug-in.
2. **The dev server speaks for the engine on loopback.** Every engine now has a token (DEV-1). In a dev checkout
   the Vite dev server authenticates to it and hands page loads the dev editor key: whoever can open a page on the
   dev server's port — any local process, not a web page — is the editor there. The dev editor key is also a 0600
   file in the appdir. A dev checkout is not a boundary against local processes (they can edit the sources); packaged
   builds have no dev server and never write the editor key anywhere.
3. **A local process as the same user that goes beyond the token.** Holding the token (the runtime file) no longer
   answers approvals (AGT-2) nor performs the gated operations (AGT-3). It still registers media by path, reads
   caption files, writes exports to new paths, edits through transactions (undoable, destructive ones gated) and
   saves projects it created. A process that reads the engine's memory or environment (`/proc/<pid>/environ` on
   Linux holds the editor key the desktop shell passed at start), drives the editor window with OS-level input, or
   attaches a debugger is the user. `JASPER_INSECURE_DEV=1` removes the token and the attestation by request.
4. **What agents may still do without a card**, each for a stated reason (section 8, AGT-3 table): clean cache
   files nothing references, delete named render segments, cancel jobs, abort uploads, write a recovery journal,
   import and build a Remotion project (item 1), create and fill their own projects.
5. **Expression cost.** One evaluation may take up to 2 s of wall clock; many heavy expressions make rendering
   slow (cancellable). The quarantine disables an expression that exhausts the heap for the realm's lifetime, also
   at times when it would have succeeded.
6. **Run-as-node stays enabled** in packaged builds (RUN-1): the engine's five worker programs and `jasper-mcp`
   are Node programs and the package ships no Node but its own binary. With it a local process can run JavaScript
   as the application binary (and inherit its macOS privacy grants). The code paths for a shipped Node runtime are
   in place; the packaging and its verification are not.
7. **Memory ceilings are high**: PSD reading up to 3 GiB, OCIO bundles 256 MiB, bundle zips 8 GiB on disk, a
   glTF model 64 million vertex and index values (≈ 1 GiB while it is read), model files 512 MiB.
8. **The OS opener decides by type association and sometimes by content.** An allowlisted extension does not
   guarantee a harmless handler on every system. (`explorer.exe /select,` with commas in a path is fixed, WIN-1.)
9. **Version retention can be set to 1** in Preferences by the user; an agent lowering it asks first (AGT-3).
10. **Sandboxed bundle pages reach the network over `https:`** (web fonts, remote media, data; as in a Remotion
    render). They cannot reach the engine, other loopback ports or plain-`http:` hosts, and they hold nothing of the
    user's but the props of their own clip.

## 7. Not done

- No installer was built: `scripts/package.mjs` stages FFmpeg under the shared `vendor/` directory, which these
  workstreams may not modify. The fuses were exercised on a fused copy of the Linux Electron binary (ELE-1); asar
  integrity validation only exists on macOS and Windows and was not exercised. Consequences for section 8: the
  packaged worker fix and the shipped-Node path (RUN-1) are unit-tested and the Electron behaviour behind them was
  measured with the unpackaged Electron 44 binary, not in an installer.
- No Windows host: the Windows opener (ENG-5 / WIN-1) is now tested under the three parsers involved and its
  PowerShell command runs for real in PowerShell 7.4.6 on Linux (section 8); `explorer.exe` itself and Windows
  PowerShell 5.1 were not run.
- Not re-audited line by line: the 375 shader sources, the Rust motion-graphics renderer, the audio DSP and
  third-party packages. (The AAF / OMF / CFB and glTF readers were: PAR-2.)
- The editor key reaches the packaged engine in its environment. Passing it over the utility process's message
  channel instead would keep it out of `/proc/<pid>/environ`; not done (residual 3).

## 8. Hardening follow-up (workstream `hardening`)

Closes the fixable residual risks of the first review. Each item has a regression test; "before" behaviour was
reproduced where it says **measured**. Nothing here was measured against other software. Decisions and usage are in
[wp-notes/hardening.md](wp-notes/hardening.md).

| Id | Was | Now |
|---|---|---|
| AGT-2 | Any client holding the engine token could attach to `/agent` and answer approvals | Only the editor connection that was shown the card can answer, with a key made for that connection and that card |
| AGT-3 | Agents deleted presets, models, render files, cache, journals, projects and restored versions without asking | Destructive engine operations ask the user when the request is not the editor window's own |
| DEV-1 | Dev engines, and any engine started without `JASPER_LOCAL_TOKEN`, had no authentication | An engine that listens always has a token; `JASPER_INSECURE_DEV=1` is the only way out, with a warning |
| MG-1 | Bundle pages ran in a same-origin iframe with the engine API, the editor's DOM and the desktop bridge | A sandboxed, opaque-origin iframe under a capability path with a CSP, driven over one MessagePort |
| RUN-1 | Run-as-node needed for `jasper-mcp` | Evaluated: also needed by five engine worker programs, which did not start in a packaged build at all; that is fixed, the fuse stays on until a Node runtime ships |
| PAR-2 | AAF / OMF / CFB and glTF readers not audited | Audited; seven ways to crash, hang or exhaust memory with a small file fixed; fuzz targets extended |
| EXPR-3 | The expression quarantine missed wall-clock kills (on a busy host the loop was re-run every frame) | Every resource-limit kill quarantines |
| WIN-1 | Windows opener tested by construction only; commas in a path mis-selected in Explorer | Quoting tested under libuv, the C runtime and Explorer parsers and run through a real PowerShell; `/select` quoted verbatim |

### AGT-2 — approvals are bound to the editor window (High)

The engine could not tell the editor window from anything else that presented the token, and the token is in the
runtime file every local tool reads. So an agent with a shell could open `/agent`, say hello for the project, read
the approval id from `/events` and approve its own destructive request.

Fix, two layers:

- **The editor key.** A second per-launch secret that the engine and the editor window share and nothing else
  receives: the desktop shell makes it, passes it to the engine it forks and sets it as an HttpOnly,
  SameSite=Strict cookie (`jasper_editor_<port>`) next to the session cookie; the E2E harness does the same; an
  engine that serves the web app without either prints a pairing link on its terminal (`/pair?key=…`, only when
  standard output is a terminal, so a parent that pipes the output never learns it). It is in no file (except dev,
  residual 2), no HTTP response, no event, no log, not in `runtime.json`; the engine deletes it (and the token)
  from its environment before it starts a child process. A request or a WebSocket upgrade that carries it is the
  editor's; everything else that holds the token is an agent: `jasper-mcp`, the `jasper` CLI, the engine's own
  `/mcp` endpoint, scripts.
- **Answer keys.** A card is sent only to editor connections, each with a random key made for that connection and
  that approval. `agent.approval.resolve` counts only from an editor connection that presents the key it was
  given — to approve and to deny. The key is not in the `agent.approval.requested` event on `/events`, is kept out
  of the store the shell renders and out of `window.jasper`, and dies with the card. With no editor window
  connected a request is refused at once instead of waiting for a timeout; a window that opens the project while a
  request is pending is shown the card with its own key.

AGT-1 (synthetic clicks) still applies on top: the user approves with a real click.

Tests: `apps/engine/test/security-hardening.test.ts` (AGT-2: classification, relay, wrong / foreign / missing keys,
no editor, late window), `apps/web/test/agent-bridge.test.ts`, `e2e/security-review.spec.ts` (a raw WebSocket client
with the runtime file's token attaches and answers: nothing happens; the user's click decides),
`e2e/desktop-smoke.mjs` (the Electron window is the editor; its cookies are invisible to scripts). Mutation check
(measured): with the answer-key check, the route gate, the generated token and the inert bundle path taken out
again, 25 of the 36 tests of `security-hardening.test.ts` fail.

### AGT-3 — destructive operations outside transactions (High)

Transactions were gated; engine routes were not. `requireUserApproval` (`apps/engine/src/agent/user-approval.ts`)
is the same gate for routes: a no-op for the editor window's own request, otherwise a card ("⟨agent⟩ wants to
delete the preset "X" from your preset library") in the windows that have the project open, or in every editor
window when the operation is not about one project; refused with `APPROVAL_DENIED` (`detail.code`
`E_APPROVAL_DENIED`) when no window is open, `APPROVAL_TIMEOUT` after 60 s. The agent is named by its
`x-jasper-agent` header (bounded, control characters removed). A request the editor makes while it handles an
agent's live-UI input (`ui_click` on a Delete button) carries `x-jasper-agent-input` and is treated as the
agent's; the editor's own housekeeping (autosave, its recovery journal, lease upkeep) never carries it.

Every state-changing engine route and what an agent may do with it:

| Route (MCP tool) | Decision | Why |
|---|---|---|
| `DELETE /api/effect-presets/:id`, `…/folders/:id` (`delete_effect_preset`) | **Gated** | The user's library, shared by all projects, no undo |
| `POST /api/effect-presets`, `PUT …/:id`, `POST …/import`, `POST/PUT …/folders` (`save_effect_preset`) | Open | Add, rename, move: nothing is lost; import never overwrites |
| `DELETE /api/roto/models/:id`, `DELETE /api/speech/models/:id` (`remove_roto_model`, `remove_speech_model`) | **Gated** | Gigabytes to download again; features stop working meanwhile |
| `DELETE /api/sounds/semantic/models/:id` (`remove_describe_search_model`; WP-E9) | **Gated** | 780 MB to download again; its cached embeddings go with it; Describe-it search and Find Moment stop working meanwhile (nothing installed: nothing asked) |
| `POST …/models/:id/install` (`install_*_model`, `install_describe_search_model`) | Open | Catalogue-pinned downloads, size-bounded (ENG-2) |
| `POST /api/sounds/semantic/embed`, `POST /api/sounds/:id/moments` (`prepare_describe_search`, `find_sound_moment`) | Open | Derived data in the engine's cache only (embeddings of library sounds); nothing of the user's changes |
| `POST /api/cache/clean` mode `all` (`clean_cache`) | **Gated** | Removes what saved projects reference: hours of proxies, previews, prerenders |
| `POST /api/cache/clean` mode `unused` / `auto` | Open | Only files no saved or open project references; the engine's own automatic pass does the same |
| `POST /api/cache/location` (`set_cache_location`) | **Gated** | Writes to a folder of the caller's choice; `fresh` deletes the cache |
| `PUT /api/cache/settings` | **Gated** | Budgets and age limit decide what the automatic cleaning deletes |
| `POST /api/previews/delete` `{all}` (`delete_render_files` scope `all`) | **Gated** | Every project's render files |
| `POST /api/previews/delete` `{hashes}` (scope `range`) | Open | Named segments of one sequence, rendered again on demand; nothing in the project changes |
| `DELETE /api/projects/:id` | **Gated** | The project, its versions and journals. An agent may delete a project it created and nobody else saved |
| `PUT /api/projects/:id` (`save_project_copy`) | **Gated** unless the agent created the project and nobody else has saved it since | Replaces the whole document outside the undo history |
| `POST /api/projects`, `PUT …/view` (`create_project`) | Open | New project; view state |
| `POST …/versions/:id/restore` `replace` (`restore_project_version`) | **Gated** | The project's current state changes under the user (it is kept as a version) |
| `POST …/versions/:id/restore` `copy` | Open | A new project |
| `DELETE …/recovery/:sessionId` | **Gated** | Unsaved work of a session that ended without saving |
| `PUT …/recovery/:sessionId` | Open | Writes a journal the user is offered and may decline; needs the session's lease |
| `POST …/lease` with `takeOver` | **Gated** | Turns the user's window read-only |
| `POST …/lease`, heartbeat, `DELETE …/lease/:leaseId` | Open | A lease nobody holds; a lease the caller holds |
| `DELETE /api/media/:key` | **Gated** for engine-managed uploads | An upload imported into an unsaved project exists nowhere else |
| `PUT /api/settings/gaps` lowering `keepVersions` | **Gated** | Prunes older versions of every project at its next save |
| `PUT /api/settings/gaps` otherwise | Open | Interval, render optimisation: nothing is deleted |
| `PUT /api/sounds/roots` adding, removing, relicensing or re-crediting (author, credit template) a folder (`add_sound_folder`, `remove_sound_folder`) | **Gated** | Adding reads a folder of the user's disk into a library every project and agent shares, under the licence it declares; removing takes the user's sounds out; a licence declaration decides what counts as safe for commercial use; the credit line is what projects print as attribution. Refused with `409 SOUND_ROOTS_CHANGED` when the list changed while the card waited |
| `PUT /api/sounds/roots` renaming or enabling / disabling a folder | Open | Nothing is read that was not, nothing lost: a disabled folder's sounds come back when it is enabled |
| `DELETE /api/sounds/packs/:id` (`remove_sound_pack`) | **Gated** (card "Remove a sound pack" with the pack's name, sound count and size; nothing installed → nothing asked, `removed: false`; `409 SOUND_PACK_BUSY` while it installs) | A download to repeat; the pack's sounds leave the library every project and agent shares (projects keep their managed copies) |
| `DELETE /api/sound-design/profiles/:profileId` (`delete_sound_profile`, Preferences ▸ Sound Library ▸ Reference profiles ▸ Delete…) | **Gated** (card "Delete a reference profile" with its name and reference count; the editor's own Delete… asks in a confirmation) | The user's data: numbers measured from their own reference media, which building again needs; sequences comparing with it lose their Reference rows |
| `POST /api/sounds/packs/:id/install` (`install_sound_pack`) | Open (like model installs) | Only ids of the engine's catalogue: upstream URL, archive sha256 and size, every file's sha256 and size are pinned in `apps/engine/src/sounds/packs.json` (https only; `JASPER_SOUND_CATALOG` is the operator's override, for tests); the download stops past the pinned size, after 60 s without data and after 30 min; only listed members are extracted, each checked by size before inflating and by sha256 after, to paths taken from the validated catalogue (never from the archive) and checked again to stay inside the pack; nothing is executed or converted. The tool tells agents to state size and licence to the user first |
| `POST /api/sounds/index`, `POST /api/sounds/:id/register` (`rescan_sound_library`, `import_sounds`) | Open | The index is derived data rebuilt from files; registering copies a kit, pack or synth file under an engine-chosen name, or registers a folder file in place like `/api/media/register` |
| `POST /api/projects/:id/proposals/:proposalId/accept` (`accept_proposal`) | **Gated** for agents by the feature's policy: sound design only where the proposal's sequence has `soundDesign.settings.agentsMayApply` (default off), every other feature refused → `403 APPROVAL_REQUIRED` (`E_APPROVAL_REQUIRED`); destructive commands inside the items then still need the approval card (`APPROVAL_DENIED` / `APPROVAL_TIMEOUT`). The editor window's own accept needs nothing more (the Review UI requires a trusted gesture) and is applied as the user's edit; before it, the Review's confirmation names what an agent could not run unasked among the items (destructive commands, `force`, the `agentsMayApply` grant: `approvalNeeds`, Phase 3 verification) | Applies edits nobody reviewed; spec 12 §0 "agents propose, the user applies" |
| `soundDesign.setSettings` with `agentsMayApply: true` in an agent transaction | **Gated** (approval card, `approvalReasons`) | An agent may not grant itself the right to apply its own proposals |
| `POST /api/projects/:id/proposals/:proposalId/applied` (WP3.3a: the editor's Redo of an undone accept) | **Editor only**: without the editor key (or with `x-jasper-agent-input`) `403 APPROVAL_REQUIRED`; nothing in the project changes, refs must be id-shaped | An agent could otherwise mark items applied without applying them and hide them from review |
| `POST …/:proposalId/reopen`, `/note`, `/select` (Phase 3 verification) | **Editor only**: an agent gets `403 APPROVAL_REQUIRED` (they are the reviewer's actions: an agent could otherwise overturn the user's rejection, overwrite their note or swap the alternative they chose just before Apply). Reopening an **accepted** item is refused even for the editor while what its accept created is still in the document (`409 PROPOSAL_STILL_APPLIED`, `reopenRefusals`): accepting it again would apply it twice. `applied` (the Redo record) likewise checks the document has what the accept created (`409 PROPOSAL_NOT_APPLIED`) | Overturned decisions; a duplicate placement after a stray reopen |
| "Allow agents to apply sound proposals" checkbox (Preferences ▸ Sound Library) clicked by an agent's live-UI input (`ui_click`) | **Refused** by the session's agent-UI guard (`agentUiTxGuard`: a user-origin transaction that would need approval while agent input runs) | An agent granting itself the right through the UI |
| `POST /api/projects/:id/proposals`, `…/:proposalId/reject`, `DELETE …/:proposalId` | Open | Nothing in the project changes (proposals live outside the document and its history); an agent is always recorded as the author (`{agent}`), only the editor may name the author; an agent may withdraw (reject, delete) items; deleting one loses review notes only |
| `GET /api/projects/:id/proposals/:proposalId` without `?revalidate` by an agent (WP3.3b: `wait_for_proposal` polling) | Open | Read-only; two such reads within 2.5 s mark the agent "waiting for your review" (list `waiting`, event `proposal.changed` `waiting`, the card's line) until 3.5 s pass without one. The name shown is the `x-jasper-agent` header after `agentNameOf` (control characters removed, ≤ 64 characters), rendered as text; ≤ 1 000 proposals followed, nothing stored |
| `POST /api/sound-design/plan` (`plan_sound_design`), `place_sound` mode "propose" | Open | Stores a proposal (nothing in the document changes); registers the planned library sounds like `POST /api/sounds/:id/register` (copies into managed media, folder files in place only on a local engine); applying it is the gated accept above |
| `POST /api/sound-design/rebalance` (`rebalance_sfx`) | Open | Mode `propose` (the default) stores a proposal (nothing changes); mode `apply` is one ordinary, undoable transaction of `soundDesign.applyGains` (clip gains of sound effects within −30…+12 dB, nothing deleted), classified like any agent transaction (labelled "Agent: Rebalance SFX Levels"); renders are measure-only (no file is written) |
| `POST /api/sound-design/delivery` (`apply_delivery`) | Open | Mode `propose` (the default) stores a proposal (nothing changes); mode `apply` is one ordinary, undoable transaction of `soundDesign.applyDelivery` (settings, the Mix's loudness normalisation, Essential Sound Auto-Match gains, ducking Volume keyframes) and `soundDesign.applyGains`, classified like any agent transaction ("Agent: Apply Delivery Preset"); nothing is deleted; renders are measure-only (no file is written) |
| `POST /api/sound-design/beds`, `/room-tone` (`lay_ambience_bed`, `fill_room_tone`, Sequence ▸ Sound Design ▸ Lay Ambience Bed… / Fill Room Tone) and their `/plan` routes | Open | Mode `propose` (the default) stores a proposal (nothing changes); mode `apply` is one ordinary, undoable transaction of `soundDesign.layBed` (clips, crossfade transitions, fades, Volume dips on a new or free audio track; with `replace` it lifts only earlier bed pieces — clips carrying `bed` metadata of the same purpose — over the scenes, on unlocked tracks) and the `media.register` of the library sounds it uses, classified like any agent transaction ("Agent: Lay Ambience Bed" / "Agent: Fill Room Tone"); the plan routes and the jobs register those sounds like `POST /api/sounds/:id/register` (copies into managed media); decodes are measure-only |
| `POST /api/sound-design/check` (`sound_check`) | Open | Measure-only renders (the first normalisation pass is a scratch file of the job, removed when it ends); with `store: true` one ordinary, undoable transaction of `soundDesign.setCheck` (metadata only, "Agent: Sound Check Result"); fixes are returned, never applied. With `proposalId` (P6-E5) the preview of a proposal of the same project is checked — nothing is applied, `store` is refused, the summary is written on the proposal (`report.check`, no decision, `updatedAt` kept) |
| `POST /api/sound-design/visual` (`view_sound_timeline`) | Open | Read-only: measure-only renders of ≤ 120 s, nothing stored |
| `POST /api/sound-design/listen` (`listen_to_sequence`, `view_sound_timeline`'s sections and answer marks, Sound Check ▸ Log) | Open | Read-only: measure-only renders of ≤ 10 min (the mix and ≤ 24 clip lanes through the export mixer, nothing written), cached beats and picture motion read but never analysed; the result is the job's (nothing stored in the project or the appdir) |
| `POST /api/sound-design/profiles` (`build_sound_profile`), `PUT …/profiles/:profileId/name`, `POST …/profiles/import`, `GET …/profiles[/:profileId]` (P6-E8) | Open | Nothing in a project changes: the job measures project media, sequences or (local engines only, `403 PATHS_NOT_ALLOWED` otherwise) absolute paths read-only — audio streamed, the picture decoded small, sequences rendered through the export mixer — and writes one JSON file of numbers under `<appdir>/sounds/profiles/` (≤ 200); rename and import add or change only those files; import validates strictly and recomputes the statistics; the selection is the ordinary, undoable `soundDesign.setSettings {referenceProfile}` |
| `POST /api/audio/classify` (`auto_tag_audio`, Essential Sound ▸ Auto Tag), the voice activity of `POST /api/sound-design/cues` (dialogue clips) | Open | Read-only for the project: ffmpeg decodes of registered media (≤ 500 items, ≤ 4 × 15 s windows or 60 s each; voice activity streamed into 10 ms levels, ≤ 4 h per clip, 8 h and 64 clips per call); only small JSON results are cached (`<appdir>/sounds/analysis/{classify,voice}/`); tagging is the ordinary, undoable `essentialSound.autoTag` transaction the caller sends |
| `POST /api/sound-design/check/last` (`get_sound_check`) | Open | Read-only: the sequence's last kept report (`<appdir>/projects/<pid>/sound-check/<sequenceId>.json`, written by finished `sound-check` jobs; file names only from document ids, ≤ 32 per project, ≤ 16 MB each, damaged files moved aside) with its staleness against the live document |
| `POST /api/sound-design/motion` (`analyze_picture_motion`), engine cue sources of `POST /api/sound-design/cues` (`find_sound_cues` sources scene / beat / pixel), `POST /api/audio/beats` | Open | Read-only for the project: a picture render of ≤ 10 min into the job's scratch directory (deleted when it ends), Scene Edit Detection and beat analyses of registered media; only small JSON results are cached (`<appdir>/sounds/analysis/`). `POST /api/audio/beats {cachedOnly: true}` reads the cache only (404 `BEATS_NOT_ANALYSED`, nothing started); in-request analyses stop when the client closes its connection (`clientGoneSignal`) |
| `PUT /api/settings/processing` (`set_processing_settings`) | **Gated**, now for every caller without the editor key | Where media is sent (was opt-in by a query parameter) |
| `POST /api/project-manager` (`project_manager`) | Open | Copies into a new destination under free names; sources untouched |
| `POST /api/assets/:id/relink`, `…/relink-scan` (`link_media`) | Open | Registers and compares files; the relink itself is a transaction (undoable; `force` is gated) |
| `POST /api/media/register`, `/derivatives`, `/variants`, `/process`, `/transcribe`, `/loudness-normalize`, `/api/media-jobs` | Open | New derived files under engine-chosen names; originals are never written |
| `POST /api/exports`, `/api/stills`, `/api/interchange/export`, `/api/imports/lottie/export` | Open | Never overwrite (DATA-3) |
| `POST /api/jobs/:id/cancel`, `/retry` (`cancel_job`) | Open | Restartable; partial outputs are the job's own |
| `POST /api/uploads…`, `DELETE /api/uploads/:id` | Open | An upload is known by its unguessable id to whoever started it |
| `POST /api/mg-bundles/import`, `/:key/rebuild`, `/scaffold` (`import_mg_bundle`, `scaffold_mg_project`) | Open | Runs the project's build (residual 1): needs an installed project on this machine; gating it would end headless agent workflows |
| `POST /api/mg-bundles/prerender`, `/measure-texts`, `/api/motion-graphics/render`, `/api/layer-bake/preview`, `/api/previews/render` | Open | Renders into the cache |
| `POST /api/media/:key/open` (`locate_media`) | Open | Allowlisted types only (ENG-5) |
| `POST /api/agent/tx` | Gated by command (S01:AGT-011) | — |
| `POST /api/agent/ui` | AGT-1 and the `x-jasper-agent-input` mark | — |
| analysis routes (`/api/audio/analyze`, `/api/grading/*`, `/api/masks/trace`, `/api/roto/*`, `/api/tracking/track`, `/api/camtrack/solve`, `/api/sync/audio`, `/api/scenes/detect`, `/api/captions/read`, `/api/exports/plan`, …) | Open | Read or compute; results go into the cache or the response |

MCP tools that write files themselves: `export_captions` writes under a free name; the `jasper` CLI's `--out` is the
shell user naming a file. Tool descriptions and the server guide say which tools ask.

Tests: `security-hardening.test.ts` (AGT-3: preset and bin deletion end to end, the editor's own request, the
agent-input mark, one row per gated route with "nothing changed", what stays open, agent-owned projects, lease
take-over, models), `e2e/security-review.spec.ts` (`delete_effect_preset` over real `jasper-mcp`: card, deny,
approve), the MCP suite (34 files, 457 tests) against engines that now have tokens.

### DEV-1 — no unauthenticated mode (Medium; High with other users on the machine)

`pnpm dev`, the E2E stack and anything else that started the engine without `JASPER_LOCAL_TOKEN` listened without
authentication: every local process of every user had the engine user's file access.

Fix: `startEngine` makes a token when none is given. Clients find it like production does: the engine's public
`/health` names its runtime file (0600); `jasper-mcp` reads it for an engine it was pointed at by URL or found on
the default port, and asks again after a 401 (every start has a new token). The Vite dev server
(`apps/web/dev-auth.ts`) adds the token to what it proxies and gives page loads the dev editor key as an HttpOnly
cookie, so `pnpm dev` and the instructions in CLAUDE.md work unchanged. The E2E harness and the performance
harnesses play the desktop shell (they make both secrets). Cookies carry the engine's port in their name: two
engines on one host no longer overwrite each other's. `JASPER_INSECURE_DEV=1` listens without a token and prints a
boxed warning; a non-loopback bind without a token is still refused. In-process servers (`createServer` in tests)
are unchanged: they do not listen.

Tests: `security-hardening.test.ts` (DEV-1: generated token, 401 without it, runtime file and `/health`, the editor
key in no output, the dev key file 0600 and reused, the insecure flag, pairing), `e2e/security-review.spec.ts`,
`e2e/desktop-smoke.mjs` (packaged-like and dev), and the dev stack driven with headless Chrome (below).

### MG-1 — bundle pages are sandboxed (High)

The live frame host loaded a bundle's page same-origin and reached into it. The page's scripts — somebody's
Remotion project — could call the engine API with the user's session, read and change the editor's DOM, use
`window.jasper` and, in the desktop app, the desktop bridge.

Fix:

- The iframe has `sandbox="allow-scripts"` (no `allow-same-origin`): an opaque origin without cookies, storage,
  or access to its parent. The editor no longer touches `contentWindow`.
- A narrow message API. The bootstrap the engine injects installs a host agent in the page
  (`packages/compositions/src/mg-host/agent.ts`); the editor hands it one `MessagePort` and talks to it through
  `MgHostRemote` (`remote.ts`). Seven operations: `check`, `configure`, `seek`, and the text probe's `locate`,
  `fonts`, `hide`, `restore`. The page's own scripts share the agent's realm, so the editor treats every reply as
  hostile: metadata is range-checked (it sizes layers), measurements are matched to the ids that were asked for and
  scrubbed, font sources may only name bundle files of the editor's origin, `data:` or `https:`, counts and bytes
  are bounded, requests time out.
- A capability path and a CSP. The address the editor knows (`/mg/bundles/<key>/index.html?jasper-host=1`,
  authenticated) redirects to `/mg/sandbox/<capability>/<key>/…`; the capability (an HMAC over the bundle key with
  the engine's per-launch secret) authorises reading that bundle's files without a cookie and nothing else. Every
  response there carries `Content-Security-Policy: sandbox allow-scripts; default-src <own path> data: blob:; …;
  frame-src 'none'; form-action 'none'; frame-ancestors <editor origins>`: the document is sandboxed wherever it is
  opened, may load its own files, `data:`, `blob:` and `https:` only — not the rest of the engine, not another
  loopback port, not plain `http:` — and only the editor may frame it. Under the old address bundle files are now
  inert data (`CSP: sandbox`, no scripts).
- Remotion reads `localStorage` when its root starts, which throws in an opaque origin: the bootstrap gives the page
  in-memory stand-ins for `localStorage`, `sessionStorage` and `document.cookie` where the real ones throw.
- Chrome pauses the rendering of cross-origin frames outside the viewport: the hidden measuring page stays inside
  the viewport (invisible), and a host frame that failed while out of view retries when it comes back.
- The desktop bridge answers IPC only from the window's top frame on the app origin (`fromApp` in
  `apps/desktop/src/main.ts`): a bundle page's URL is on the engine's origin although its origin is opaque. The
  preload does not run in subframes either.

**Trust model for export.** Preview is sandboxed as above. An export does not load bundles in the editor: the engine
pre-renders a composition with Remotion's renderer in its own headless Chrome (a throwaway page on a private
loopback server, no engine cookies, no token) and composites the result; text measuring for agents uses the same
kind of page. The bundle's code therefore runs in a browser sandbox there too, with network access, and with
nothing of the engine's. What is *not* sandboxed is building a bundle from a source project (residual 1).

Tests: `packages/compositions/test/mg-host-remote.test.ts` (agent and remote over a real MessageChannel against a
stand-in for the Remotion page globals; hostile replies; storage stand-ins), `security-hardening.test.ts` (MG-1:
redirect, capability, policy, traversal, inert old path), and in the real app `e2e/mg-clips.spec.ts` (the Remotion
4.0.499 contract through the port; `origin === 'null'`, no parent access, no cookies, the engine API unreachable
from inside; live preview, props edit visible in under 500 ms, preview WebM) and `e2e/mg-texts.spec.ts` (text
measuring, on-canvas editing with the bundle's fonts). All existing bundle tests pass; the two e2e specs read the
page from inside the frame instead of through `contentDocument`.

### RUN-1 — run-as-node (evaluated; not closed)

Shipping `jasper-mcp` as its own entry is not enough to disable the fuse. The engine starts five Node programs of
its own with `process.execPath`: the speech, roto and camera-tracking workers, `jasper-proc` and the bundle schema
runner. In the packaged app the engine runs in an Electron utility process, where that path is the application
binary. **Measured** with Electron 44.5.0: from a utility process, `spawn(process.execPath, [script])` starts the
binary as an application (`process.type === 'browser'`; with the `onlyLoadAppFromAsar` fuse, a second instance of
the app) and the script never runs as a worker; with `ELECTRON_RUN_AS_NODE=1` it runs as Node and exits. Only the
schema runner set that variable. So transcription, roto, camera tracking and clip processing could not start in a
packaged build, and all of them — not only `jasper-mcp` — depend on run-as-node.

Done: the engine sets `ELECTRON_RUN_AS_NODE=1` for its children when it runs inside Electron (the workers start);
`apps/engine/src/tools/node-runtime.ts` resolves the Node executable for every worker — `JASPER_NODE`, else
`<resources>/node/node[.exe]`, else the process itself — and `mcpLaunchInfo` launches `jasper-mcp` with a shipped
Node when there is one. Disabling the fuse is then a packaging change: ship a Node runtime per platform in
`resources/node` (≈ 40–100 MB) and set `runAsNode: false`. Not done here: no installer can be built in this
environment, and a fuse flip that cannot be verified would trade a hardening for a broken app.
Tests: `apps/engine/test/node-runtime.test.ts`, `apps/desktop/test/security.test.ts`.

### PAR-2 — AAF / OMF / CFB and glTF readers (High: crash and denial of service from a small file)

Reviewed for out-of-bounds reads, endless loops and allocations sized by input. No out-of-bounds read (typed-array
reads are bounds-checked by the language and the readers check before they read). Found and fixed, with what the
file did before (each **measured** in its own process with a 25–30 s limit):

| Reader | Hostile input | Before | Now |
|---|---|---|---|
| AAF store | A weak reference set of 2³² − 1 keys of 0 bytes (12 KiB file) | Node aborted: out of memory | `StoreError`, 10 ms |
| AAF store | A collection that names the same child storage 60 times, 6 levels deep | 5 s and 350 MiB, then "too many objects" | "referenced twice", 11 ms: an object storage is read once |
| AAF store | 65 535 properties on one object | accepted | refused above 4096 (lookups scan the list) |
| AAF reader | Mob reference chains | unbounded walk on a graph | 20 million steps, then "too complex" |
| CFB | Streams named by many entries or properties | each read allocates the stream again | reads are counted against 8 × the file size |
| Bento (OMF) | One value with 4096 segments over the same megabyte | never finished (4 GiB value, then a string of it) | the value is unreadable (`null`), 7 ms |
| OMF reader | A sequence that contains itself four times (2 KiB file) | never finished (4³² segments) | "too complex", 0.4 s: every lookup, copy and walk is charged against an allowance that grows with the table of contents |
| glTF | An accessor of 100 million elements without a buffer view; a stride of 0 | never finished (2.4 GiB arrays) | "too large", 13 ms: counts are checked and paid for before anything is allocated |
| glTF | Nodes that share their children, 8 ways and 14 levels | never finished (8¹⁴ visits) | "used twice": the node hierarchy is read as the tree the specification requires |
| glTF | 20 000 instances of a 30 000-vertex mesh | never finished | "too large" after 64 million values (3.8 s, 173 MiB) |
| glTF | One megabyte image used by 4000 materials | 4 GiB | one copy (4 MiB) |
| glTF | A broken `data:` URI; negative, fractional or NaN indices | untyped `URIError`; accepted | `ModelParseError` |

A compound file whose directory chain cycles was already refused, and stays covered. Fuzzing: the crafted files are
seeds of the existing mutation targets; a field-aware mutator overwrites 32-bit fields of real AAF and OMF exports
with the values that break container readers (1 500 files each, 20 000 with `FUZZ=1`), each of which must import or
fail with `InterchangeError` within a time limit; a JSON-aware target mutates the fields of glTF documents.
Tests: `packages/interchange/test/hostile.test.ts`, `packages/project/test/three-d-hostile.test.ts`, seeds in
`packages/interchange/test/fuzz.test.ts` and `packages/project/test/fuzz-parsers.test.ts`.

### EXPR-3 — the quarantine missed the wall clock (Medium)

`review`'s test "an expression that exhausted the heap is not run again" failed in isolation on the shared host:
the 2 s wall-clock guard stopped the heap-growing loop before the 64 MiB limit, the result was "took too long", and
the quarantine (heap or more than 4 s only) did not apply, so the loop would run again on every frame. Now the
interrupt hook records why it stopped an evaluation, and any resource-limit kill quarantines the top-level
expression: heap, operation budget, wall clock (reported as "took too long (over 2 s)"), or a run past twice the
wall clock. Ordinary errors are not quarantined. An expression read by another one is not blamed for the reader's
budget. Tests (`packages/expressions/test/sandbox.test.ts`) drive each path deterministically: an immediate 200 MiB
allocation for the heap, a frozen clock for the budget, a clock that jumps a second per reading for the wall clock,
and the original loop for "never twice, whichever limit trips"; the second run takes under 50 ms in each.

### WIN-1 — the Windows opener (Low; tests)

`apps/engine/test/windows-opener.test.ts`: 40 adversarial file names (cmd.exe separators and variable expansion,
PowerShell subexpressions, quotes, splatting, stop-parsing, wildcards, Explorer option look-alikes, commas, spaces,
right-to-left override) in four directories.

- **open**: the command line Node builds (libuv's quoting, reimplemented and checked against Microsoft's documented
  examples and by a round-trip property) is the same constant for every path, and the C runtime splits it back into
  the same five arguments; the path is only in the environment; never `cmd.exe`.
- **For real**: with `pwsh` on the PATH or `JASPER_PWSH`, the exact command runs through PowerShell against a
  recording opener (PowerShell implements `Invoke-Item` with the platform opener off Windows). Run here with
  PowerShell 7.4.6 on Linux: 48 names, each reached the opener as exactly one argument, byte for byte, and nothing
  a name spelled was executed (a default run uses 13 of them; `FUZZ=1` all).
- **reveal**: one change. Node's own quoting wrapped the whole `/select,<path>` argument, which leaves a comma or a
  space in a path to Explorer's parser (residual 8 of the first list). The line is now written verbatim as
  `explorer.exe /select,"<path>"`; a model of Explorer's parsing gives back exactly the path for every name and for
  500 random ones. A name with `"`, NUL or a line break — impossible on Windows — is refused instead of quoted
  around.

### Verified in the running app

- Built stack (`e2e/serve.mjs`, engine with token and editor key): `security-review` (4), `agent` (6),
  `effect-presets` (2), `media-cache` (3), `project-files` (2), `mg-clips` (2), `mg-texts` (2) and `smoke` (11,
  with native, fframes and Remotion exports) — 32 tests, all passed (`smoke` with `JASPER_MG` pointing at the
  prebuilt `jasper-mg`, which `pnpm e2e` otherwise builds).
- Dev stack on ports 49641 / 49642 (`tsx` engine, Vite): the engine answers 401 without a token and to a foreign
  Origin through the dev server; through the dev server the app loads in headless Chrome in 12.6 s, lists
  projects, is the editor on `/agent`, and its scripts see no cookie.
- Desktop shell (Electron 44 under Xvfb): packaged-like passed; dev passed on the third run — the first two stalled
  while the cold Vite server was still serving modules (14 and 80 of ≈ 1 200 requests done after 120 s), before any
  engine request; the same window loaded in 5 s in two further manual runs.

## 9. Added after the review (workstream `polish`)

The last workstream added engine surface after this review; it follows the rules above and was written against
them, but it was reviewed by its author, not by this review.

- **Media Browser** (`GET /api/browse/roots | list | info | thumbnail | file`, `apps/engine/src/routes/browse.ts`):
  a browser of the engine host's file system for the editor. Local mode only; absolute, normalised paths; listings
  show folders and files by name, size and date. Bytes are served for video, audio and picture extensions only,
  checked on the name asked for and on the file it resolves to (a media-named symlink to another file is refused),
  with the `nosniff` and `CSP: sandbox` headers of every served user file. Because a path can be guessed where a
  media key cannot, a request a browser marks as `Sec-Fetch-Site: cross-site` or `same-site` is refused on these
  routes: without that, a page could embed (not read) the user's pictures and videos through a token-less dev
  engine (since §8 DEV-1 only `JASPER_INSECURE_DEV=1` is one). FFmpeg reads the files with `-protocol_whitelist file,crypto,data`. Tests: `apps/engine/test/browse.test.ts`.
  The MCP tool `browse_media_files` lists folders and importable media only (never every file), read-only.
  *Residual:* an agent confined to the MCP tools can now learn the names of folders and media files anywhere the
  engine's user can read (it could already probe single paths through `import_media`); an authenticated local
  client can list any folder (residual risk 3).
- **`POST /api/media/status`**: the per-medium status route for up to 1 000 keys; keys are matched against the
  media key pattern, unknown ones are listed.
- **Engine ▸ Connect to Engine…** can open the editor served by another engine address in the window. The address
  must be http(s) without credentials; an agent's live-UI input cannot trigger the navigation (AGT-1's
  `agentInputActive`); the desktop app does not offer it.
- **`/editor-boot.js`** starts `GET /api/projects/<id>` for the id in the page URL before the bundle loads
  (same origin, same credentials); the id is URL-encoded and reaches the engine through the validated route.
- **Sound library** (spec 12 WP1.2, `apps/engine/src/routes/sounds.ts`; `GET /api/sounds`, `/status`, `/:id`,
  `/:id/audio`, `/:id/visual`, `/roots`; `POST /api/sounds/index`, `/:id/register`; `PUT /api/sounds/roots`):
  sound ids are matched against `snd_` + 16 hex digits before any lookup; files are found through the index only
  (kit and pack files by their manifest's relative path, folder files by root id and relative path), resolved
  through links and refused unless they stay inside their kit, pack or folder and have an audio extension; bytes are
  served with an audio content type only, `nosniff`, `CSP: sandbox` and Range. Folder paths (`PUT /api/sounds/roots`)
  are taken in local mode only, absolute, without NUL, normalised and resolved, must be existing folders and not a
  file-system root; scans skip hidden names and symlinks and stop at depth 12 and 20 000 files per folder; folder
  sounds are served and registered in local mode only. FFmpeg reads library files with `-protocol_whitelist
  file,crypto,data`. Agents adding, removing, relicensing or re-crediting (author, credit template) a folder are
  asked (AGT-3 table); the card counts every kind of change and cuts each path to 120 characters, and a change
  approved after the folder list moved is refused (`409 SOUND_ROOTS_CHANGED`). A remote engine lists no folder paths,
  does not index folders and keeps folder sounds out of search and visual data; only regular files are served. Manifests are
  validated per entry and capped at 16 MB; a damaged index is moved aside and rebuilt. Tests:
  `apps/engine/test/sounds-routes.test.ts`, `sounds-unit.test.ts`, and the generic route fuzzing of
  `fuzz-http.test.ts`. *Residual:* like the Media Browser, an authenticated client of a local engine can have any
  readable folder indexed (the editor itself, or an agent the user approved).
- **Sound packs** (spec 12 WP6.1, `apps/engine/src/sounds/packs.ts`, routes in `routes/sounds.ts`; `GET /api/sounds/packs`,
  `POST /api/sounds/packs/:id/install`, `DELETE /api/sounds/packs/:id`): the only network the sound library uses, and
  only on an explicit install. The catalogue is validated entry by entry (zod: id pattern, allowlisted licence with
  evidence, pinned sha256 and sizes ≤ 256 MB per archive and 1 GB per pack, ≤ 5 000 files, relative audio paths without
  `..`, backslashes, NUL, hidden segments or case-insensitive duplicates; built-in entries https only); invalid entries are
  skipped and listed, never thrown. A download goes to `<packsDir>/.downloads/<id>-<sha16>.partial` (resumed by a Range
  request only when it is the same pinned file; deleted on cancel, on a checksum mismatch or an oversize body; stale ones
  deleted at engine start), is stopped past its pinned size, after 60 s without data and after 30 min, and must match
  its sha256; the ZIP reader (`imports/zip.ts`) refuses ZIP64, encryption and spanned archives and bounds every entry;
  only catalogue-listed members are read, each refused if its declared size differs from the pinned one (before
  inflating) and if its sha256 differs (after); output paths come from the catalogue and are checked again with
  `safeJoin` (property-tested: never outside the folder); files are written with `wx` into a staging folder that
  replaces the pack folder in one rename after its `pack.json` validated; free disk space is checked first (`DISK_FULL`).
  Removing renames the folder aside before deleting it. Tests: `apps/engine/test/sound-packs.test.ts` (sha256 and size
  mismatches, a hostile archive with `../escape.wav`, catalogue zip-slip paths, size caps, cancel and partial cleanup,
  resume over file:// and HTTP Range, a stalled server, the approval gate, a project exporting a pack sound after the
  pack is removed), `apps/mcp/test/sound-packs.test.ts`, `fuzz-http.test.ts` (route fuzzing).
  `files` packs (BigSoundBank, wp-note "Phase 6 → BigSoundBank packs") download each listed file from its own pinned
  https URL, one at a time and at most one request per second (`PACK_FILE_INTERVAL_MS`), with a descriptive
  User-Agent (`PACK_USER_AGENT`); the same size, sha256, staging and `safeJoin` rules apply per file, and the built-in
  catalogue refuses any non-https URL including a file's own licence evidence.
  *Residual:* a catalogue override file is trusted like the engine's own configuration; BigSoundBank's robots.txt and
  ai.txt disallow `/UPLOAD/` for crawlers and AI training — the human decision of 2026-10-17 accepts fetching the
  curated files at the user's request (no crawling, no training, no hosting by us).
- **Sound design cues** (spec 12 WP2.3, `apps/engine/src/routes/sound-design.ts`; `POST /api/sound-design/cues`):
  read-only (Open in the AGT-3 sense: nothing is written). The body is a strict zod object: an inline envelope
  (loaded with `loadProject`, a failure is `400 VALIDATION_FAILED`) xor a project id matched against
  `[A-Za-z0-9_-]{1,128}` and read through the agent service like `doc.get`; option ranges, counts (`maxCues` ≤
  10 000) and the returned curves (≤ 20 000 frames per clip) are bounded; `deriveCues` never throws (each source in
  its own try/catch, sampling capped). Tests: `apps/engine/test/sound-design-cues.test.ts` and `fuzz-http.test.ts`.
- **Sound design plan** (spec 12 WP3.2, `apps/engine/src/sound-design/plan.ts`; `POST /api/sound-design/plan`): a
  strict zod body (project id `[A-Za-z0-9_-]{1,128}`, ≤ 2 000 cue ids, palette ≤ 500 sound ids `snd_` + 16 hex,
  `maxCues` ≤ 200, alternatives ≤ 3); the project, sequence and cue ids are checked before a job starts (typed 404s);
  the job reads the live document through the agent service, ranks only commercial-safe sounds of the allowed sources
  (folder sounds only on a local engine, D-47), registers through the sound service and creates the proposal through
  the proposal service (its validation and limits); its input is re-validated when read back from the journal; a
  cancelled job deletes a proposal it had just stored. Tests: `apps/engine/test/sound-design-plan.test.ts` (typed
  refusals, a fuzz target over mutated bodies: no 5xx, every started job ends succeeded with a result of the schema or
  failed with a code) and `fuzz-http.test.ts`.
- **Rebalance SFX levels** (spec 12 WP4.1b, `apps/engine/src/sound-design/{rebalance,bed,levels}.ts`; `POST
  /api/sound-design/rebalance`): a strict zod body (project id `[A-Za-z0-9_-]{1,128}`, ≤ 2 000 clip ids, a frame range,
  a delivery enum, `mode` / `userGains` enums); the project, sequence and explicit clips are checked before a job
  starts (typed `404 CLIP_NOT_FOUND`, `400 NOT_SFX`); the job reads the live document through the agent service,
  renders only through the export mixer with `measureOnly` (bounded: windows ≤ 20 s, ≤ 2 000 clips, bed PCM cache ≤ 96
  MB), media resolved through the registry (engine-store keys only, like exports); apply mode goes through the agent
  service's transaction path with `expectedRevision` (a concurrent edit fails the job `CONFLICT`, retryable). Tests:
  `apps/engine/test/sound-design-rebalance.test.ts` (refusals and a fuzz target: no 5xx, every started job ends
  succeeded with a result of the schema or failed with a code).
- **Delivery presets** (spec 12 WP4.2a, `apps/engine/src/sound-design/delivery.ts`; `POST /api/sound-design/delivery`): a
  strict zod body (project id `[A-Za-z0-9_-]{1,128}`, a delivery enum, `mode` enum, four booleans, a ≤ 200-character
  label); the project and sequence are checked before a job starts (typed `404`); the job reads the live document
  through the agent service, simulates the commands on a copy (`applyTransaction`, so a refused command fails the job
  with its code before anything is applied), renders only through the export mixer with `measureOnly` (per clip, the
  ducking triggers, the sound effects' clusters as WP4.1b, and the whole sequence three times: mix, voice, music /
  ambience), media resolved through the registry; apply mode goes through the agent service's transaction path with
  `expectedRevision` (a concurrent edit fails the job `CONFLICT`, retryable). The commands it builds are bounded by
  their schemas (≤ 5 000 measured clips, ≤ 256 ducking groups of ≤ 20 000 regions). Tests:
  `apps/engine/test/sound-design-delivery.test.ts` (typed refusals: bad preset, unknown key, unknown or malformed
  project, unknown sequence).
- **Sound Check** (spec 12 WP5.1, `apps/engine/src/sound-design/{check,stems,visual}.ts`; `POST /api/sound-design/check`,
  `POST /api/sound-design/visual`): strict zod bodies (project id `[A-Za-z0-9_-]{1,128}`, a frame range, a preset enum,
  `store` boolean, a ≤ 128-character job id); the project, sequence and range are checked before a job starts (typed `404`,
  `400 RANGE_EMPTY` / `RANGE_TOO_LONG`: ≤ 4 h per check, ≤ 120 s per visual request); the check job reads the live
  document through the agent service and renders only through the export mixer (one `OfflineMixer` per stem, shared
  ffmpeg decoders of engine-registry media, `measureOnly` except the normalisation pass's float scratch file in the job's
  scratch directory, deleted in a `finally`); reference decodes of sound files are bounded (≤ 0.25 s each, 4 at once,
  local protocols only); curves are bounded (≤ 6 h of 10 ms hops; report curves ≤ 1 200 points, ≤ 2 000 findings and
  event rows); fixes are only described (commands dry-run on a copy, never applied by the check); `checkJobId` must name
  a `sound-check` job of the same project (`404 JOB_NOT_FOUND`). `store` goes through the agent service's transaction
  path. Tests: `apps/engine/test/sound-check.test.ts` (typed refusals), `sound-check-stems.test.ts`. A proposal check
  (`proposalId`, `itemIds` ≤ 2 000, spec 12 §4 P6-E5; `sound-design/check-proposal.ts`) reads the proposal through the
  proposal service (`404 PROPOSAL_NOT_FOUND`, an unknown item `404 NOT_FOUND`, another sequence `400`), previews it on a
  copy of the live document (never committed, the revision unchanged), never replaces the kept report, and stores only
  its summary on the proposal under the proposal's lock; `store` with `proposalId` is `400 VALIDATION_FAILED`. Agents may
  acknowledge Sound Check warnings and infos only (`soundDesign.acknowledgeIssue`: an error from an agent origin is
  `E_APPROVAL_REQUIRED`, and the check ignores an agent's acknowledgement of an error whatever severity it claimed). The last full report
  per sequence (Phase 5 verification; `POST /api/sound-design/check/last`, `sound-design/report-store.ts`) is written
  by the finished job inside the project's folder: the file name is the sequence id only when it is a document id
  (`[A-Za-z0-9_-]{1,128}`, never a path), atomic writes, ≤ 32 reports per project (the least recently written evicted),
  ≤ 16 MB per report (larger ones are not kept), a file that does not parse or names another sequence is moved aside
  with a warning; the route is read-only (strict body, typed `404 SOUND_CHECK_NOT_FOUND`). A report goes with its
  sequence (WP6.5b): the reports of sequences the saved project no longer has are deleted when no editing session could
  undo the delete (a save or version restore with no editor lease, the lease released or expired, a new lease), and a
  check finishing after its project or sequence is gone keeps nothing (a late write never re-creates a deleted
  project's folder). Tests: `apps/engine/test/sound-check-kept.test.ts`, `sound-check-kept-lifecycle.test.ts`.
- **Ambience beds and room tone** (spec 12 WP-E8, `apps/engine/src/sound-design/beds.ts`,
  `packages/audio-fx/src/analysis/loop-window.ts`; `POST /api/sound-design/beds[/plan]`, `/room-tone[/plan]`): strict
  zod bodies (project id `[A-Za-z0-9_-]{1,128}`, sound ids by `SOUND_REF_RE`, ≤ 500 scenes / gaps as frame ranges,
  bounded seconds and decibels); the project and sequence are checked before a job starts (typed `404`); library sounds
  are only those of the engine's index (`SoundService.get` / `register`: the same checks as the register route, folder
  sounds only on a local engine), project media only through the engine registry; recordings are decoded by ffmpeg into
  memory capped at the requested duration + 1 s (≤ 10 min per bed, ≤ 120 s per dialogue clip, ≤ 8 dialogue clips, ≤ 8
  candidate room tones), a cancelled request or job kills its decodes; measurements are cached in memory only (≤ 64);
  the plan routes answer JSON only. Sound Check's room-tone fix (a SILENCE inside dialogue) is returned as commands,
  never applied (not safe). Tests: `apps/engine/test/sound-beds.test.ts` (refusals),
  `packages/audio-fx/test/loop-window.test.ts` (hostile input never throws), `packages/project/test/ambience-bed.test.ts`
  (hostile command arguments: a refusal or a valid document).
- **Listening transcript** (spec 12 WP-E3, `apps/engine/src/sound-design/listen.ts`, `packages/audio-fx/src/analysis/events.ts`;
  `POST /api/sound-design/listen`, the visual route's `spectrogram`): a strict zod body (project id `[A-Za-z0-9_-]{1,128}`,
  a frame range, a detail enum); the project, sequence and range are checked before a job starts (typed `404`,
  `400 RANGE_EMPTY` / `RANGE_TOO_LONG`: ≤ 10 min per listen); the job reads the live document through the agent service
  and renders only through the export mixer (`renderStems`: the mix and ≤ 24 lanes of clips that never overlap, shared
  ffmpeg decoders of engine-registry media, nothing written); the analysis streams in 30 s chunks with bounded memory
  (≤ 2 h of input per meter; ≤ 3 000 lines, ≤ 5 000 events, ≤ 400 sections returned); beats and picture motion are read
  from their caches only (`mode: 'cached'`). The spectrogram of the visual route is ≤ 120 s × 96 bytes per 10 ms.
  Tests: `apps/engine/test/sound-listen.test.ts` (typed refusals), `packages/audio-fx/test/events.test.ts` (hostile input
  never throws).
- **Reference profiles** (spec 12 WP-E4, `apps/engine/src/sound-design/profile.ts`, `packages/project/src/sound/profile.ts`,
  `packages/audio-fx/src/analysis/profile-metrics.ts`; `…/sound-design/profiles*`, `POST /api/sound-design/check
  {profileId}`): strict zod bodies (a name of 1–120 characters, 1–20 references, ids ≤ 128 characters, paths ≤ 4 096
  characters, profile ids `sprf_` + 16 hex digits — the only file names the store uses, so a request can never name a
  path); unknown project media or sequences are refused before a job starts (`404`); paths only on a local engine (the
  route refuses them with `403 PATHS_NOT_ALLOWED`, and the job re-checks the flag), resolved through `realpath`, regular
  non-empty files only, read by ffmpeg with the local-protocol whitelist (no network). Each reference is measured for at
  most 60 minutes with bounded memory (≈ 10 MB per hour of stereo; the picture's scene signatures kept in a ring of six,
  not per frame); ffmpeg children are tracked by the job (cancel kills them). Profile files (store and import) are
  untrusted: ≤ 1 MB, parsed with a strict schema (unknown keys, non-finite or out-of-range numbers, more than 20
  references, duplicate reference ids are refused with `400 SOUND_PROFILE_INVALID`), the aggregate is recomputed from the
  references, a damaged file in the store is moved aside and listed (`unreadable`), never served; writes are atomic and
  serialised. Profiles hold numbers, titles (bin names or file names) and fingerprints (content hashes; a sequence's
  `<projectId>/<sequenceId>@<mixHash>`), never audio or paths. Tests: `apps/engine/test/sound-profile.test.ts` (hostile
  imports, a damaged library file, path traversal ids, the agent's delete refused without an editor),
  `packages/project/test/sound-profile.test.ts` (300 fuzzed files never throw), `packages/audio-fx/test/profile-metrics.test.ts`
  (hostile audio never throws).
- **Engine cue sources and picture motion** (spec 12 WP6.2, `apps/engine/src/sound-design/{motion,engine-cues,analysis-cache}.ts`,
  `audio/beats.ts`, `time/scenes.ts`; `POST /api/sound-design/motion`, `POST /api/audio/beats`, the cue route's
  `opts.sources` scene / beat / pixel and `snapToBeats`): strict zod bodies (project id `[A-Za-z0-9_-]{1,128}`, frame
  ranges, media keys matched by `MEDIA_KEY_RE` and looked up in the registry, beat ranges ≤ 30 min, seconds ≤ 240 h); the
  project, sequence and range are checked before a job starts (`404`, `400 RANGE_EMPTY` / `RANGE_TOO_LONG`: ≤ 10 min of
  picture per analysis; the cue route analyses longer sequences in 10-minute windows); the picture is rendered only
  through the export service (`renderToFile`: the export planner, its paths and blockers — what an export would render)
  into the job's scratch directory, decoded by ffmpeg at 128 px (a child process of the job: cancel kills it); beat
  decodes are capped at the requested duration + 1 s of samples, two at once; scene detection of registered media only.
  Results are cached as JSON under engine-made names (sha256 keys: `[0-9a-z]` only, read back through their zod schema,
  a damaged file is a miss), at most 300 motion / 2 000 beat / 2 000 scene results (oldest pruned). Engine-source
  cues are validated again by `deriveCues` (`W_EXTRA_CUE_INVALID`) and by the response schema. A failed analysis is
  reported (`W_ANALYSIS_FAILED`, state `failed`) and not restarted for 5 minutes. Tests:
  `apps/engine/test/sound-design-motion.test.ts` (typed refusals, cancellation), `fuzz-http.test.ts` (both new routes,
  discovered from the server).
- **Auto Tag and dialogue voice activity** (spec 12 WP6.3, `apps/engine/src/audio/classify.ts`,
  `sound-design/voice.ts`, `routes/audio-fx.ts`; `POST /api/audio/classify`, the cue route's `voiceActivity`): a strict zod
  body (exactly one of `clipIds` / `mediaKeys`, ≤ 500 each; ids ≤ 200 characters, media keys matched by `MEDIA_KEY_RE` and
  looked up in the registry; a project id `[A-Za-z0-9_-]{1,128}` or an inline envelope validated by `loadProject`);
  `404 PROJECT_NOT_FOUND` / `SEQUENCE_NOT_FOUND` / `CLIP_NOT_FOUND` / `ASSET_NOT_FOUND` before the job starts, per-item
  errors (not audio, no audio stream, offline, not in the store) in the result. Decodes are ffmpeg child processes of
  registered media only (2 at once; capped at the requested duration + 1 s; voice activity folds samples into 10 ms
  levels as they stream, so memory does not grow with the clip). Results are JSON under engine-made sha256 names, read
  back through their zod schema (≤ 5 000 classifications, ≤ 2 000 voice entries). The route never edits the project: the
  editor and `auto_tag_audio` apply `essentialSound.autoTag` as an ordinary transaction. Tests:
  `apps/engine/test/audio-classify.test.ts` (refusals, item errors), `fuzz-http.test.ts` (discovers the route).
- **Proposals** (spec 12 WP3.1, `apps/engine/src/routes/proposals.ts`, `proposals/{store,service}.ts`; `GET/POST
  /api/projects/:id/proposals`, `GET/DELETE …/:proposalId`, `POST …/:proposalId/accept|reject|reopen|note|select|applied`):
  project ids are matched against `prj_` + 16 Crockford characters and proposal ids against `prp_` + 16 before any path
  is built; bodies are strict zod objects (drafts: ≤ 2 000 items, ≤ 5 000 commands, ≤ 16 alternatives per item, meta ≤
  64 KB, report ≤ 1 MB, ≤ 20 MB in all; every command is checked for unknown keys and against its schema, temp refs
  must be unique); validation and accept are dry runs of ordinary transactions (never throw: typed issues or item
  states). Files are written atomically, at most 50 per project (undecided proposals are never evicted:
  `409 PROPOSAL_LIMIT`), expire 30 days after their last change, are read with a 21 MB cap, and a file that does not
  parse or names another id or project is moved aside (`*.corrupt-<time>`) with a warning. Accept gate: AGT-3 table.
  The relay flag `asUser` (the editor's accept is the user's History entry) is set by the engine only for requests
  carrying the editor key and honoured by the bridge only together with `approved`. The relay field `ids` (an accept's
  journalled id bodies, so a crash between its transaction and its recorded states can be settled from the document)
  is set by the engine only (agents' transactions are nested in `transaction`; the field sits beside it), and the bridge
  takes at most 50 000 well-formed bodies and nothing else. The accept journal's intent files are parsed with a strict
  schema and an 8 MB cap; one that does not parse is moved aside with a warning, never acted on. The editor's Apply (WP3.3a session
  slice) needs a trusted user gesture (`event.isTrusted`; an agent's `ui_click` is synthetic and its live-UI requests
  carry `x-jasper-agent-input`, so the engine treats them as an agent's anyway). Tests:
  `apps/engine/test/proposals{,-store,-fuzz}.test.ts`, `fuzz-http.test.ts`, `apps/web/test/agent-bridge.test.ts`.
  *Residual:* an agent-owned project (created by the agent, AGT-3) can be rewritten with `agentsMayApply` already on;
  the policy reads the live document, so a user who turned it on lets every agent apply in that sequence.
- **Editing leases**: a reloaded tab takes over the lease its previous page held (`takeOver`, which any
  authenticated client could already send); nothing changed on the engine.

