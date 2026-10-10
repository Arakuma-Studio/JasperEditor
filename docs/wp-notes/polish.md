# polish — the loose ends

Workstream `polish` of the parity program (BASE port 49620), the last one before the integration branch is handed
over. Its scope was what the other workstreams' notes, `docs/gaps.md` and `docs/M1-STATUS.md` listed as still open:
the editing-lease race on reload, the menu entries nobody registered, stale decision rows, the i18n follow-ups, a
slow open of large projects, a smoke test that needed an optional native tool, and documents that disagreed.
Nothing was ported (no `licenses/ported` record). Sources for Premiere's behaviour are cited where a choice
depended on them.

## 1. A reloaded tab keeps its editing lease

**Root cause.** The single-writer lease (S01:PER-040) is released by a keepalive `DELETE …/lease/:id` on
`pagehide`. That request is best effort: when the reloaded page's `POST …/lease` reached the engine first, or the
browser dropped the request, the new page saw `LEASE_HELD` — by the page it had just replaced — and opened
read-only until the lease expired (30 s). `docs/M1-STATUS.md` had seen it once in six runs; `e2e/gaps.spec.ts`
worked around it by clicking **Take over editing**.

**Fix** (`packages/session/src/persistence/tab-leases.ts`, `engine.ts`). A page remembers, in `sessionStorage`,
which session id held each project's lease. `sessionStorage` survives reloads and same-tab navigations and is not
shared with other tabs, so when the engine answers `LEASE_HELD` with a remembered id, the holder was an earlier page
of this very tab, and the store takes the lease over at once (the engine's existing `takeOver`, no API change).

"Duplicate tab" copies `sessionStorage`, so a remembered id alone is not proof the holder is gone. Before taking
over, the page asks the origin's live pages over a `BroadcastChannel` whether one of them still holds that lease
(250 ms); a live holder answers, the new page opens read-only as before and forgets the inherited id. Other tabs,
other browsers and agents never match a remembered id, so they stay locked out. A clean release forgets the id;
`pagehide` keeps it (that is the case the memory is for). The set of "sessions of this page" that the store already
kept (to wait for an in-flight release during a route change) moved into the same registry.

The old session's recovery journal is untouched: after a take-over it no longer holds the lease, so unsaved changes
of the page before the reload are offered exactly as when its `pagehide` release wins.

**Tests.** `packages/session/test/persistence/tab-leases.test.ts` (six cases: reload with a lost release reclaims in
< 2 s and sends `takeOver`; another tab stays read-only; a duplicated tab whose original is open stays read-only and
drops the id; an agent's lease is never reclaimed; a clean close forgets; corrupt storage and a missing channel).
`e2e/project-files.spec.ts` aborts every lease release in the browser and reloads, navigates to Home and back, and
opens a second tab (read-only, with Take over editing). `e2e/gaps.spec.ts` no longer takes over after a reload.

**Limit.** A duplicated tab whose original is frozen by the browser (background-tab freezing) cannot answer the
probe; the duplicate then takes the lease and the original shows "lost" when it wakes, as after any take-over.

## 2. Every menu entry and every default shortcut does something

Five menubar entries rendered disabled because no command had their id; a new test then found five default key
bindings in the same state. All ten are commands now (`apps/web/src/commands/polish.ts`), and
`apps/web/test/polish-menu-wiring.test.ts` fails when a menubar entry, a Workspaces or panel menu entry or a default
key binding has no registered command (entries limited to a runtime, such as File ▸ Exit, are wired too).

| Entry | What it does | Notes |
|---|---|---|
| File ▸ Import from Media Browser (Ctrl+Alt+I) | imports the files selected in the Media Browser into the active bin; with nothing selected, opens the panel | Premiere: "Import from Media Browser" imports the Media Browser selection ([Adobe: Importing media](https://helpx.adobe.com/premiere-pro/using/importing-media.html)) |
| Window ▸ Media Browser (Shift+8) | the Media Browser panel (below) | Premiere's default shortcut |
| File ▸ Engine ▸ Engine Status | a dialog read live from `/health` and `/api/capabilities`: address, version, API, response time, event stream, jobs; FFmpeg build, licence and source, export / proxy encoders, hardware encoders and decoders; render paths; feature blocks; CPU threads, free disk, upload limit; Reconnect and Copy Details | also reachable from the header's engine chip |
| File ▸ Engine ▸ Connect to Engine… | reconnects to the engine of the window; on the web, opens the editor served by another engine by its address (recent addresses kept), after saving | see "Connect" below |
| Clip ▸ Motion Graphic ▸ Edit Parameters… | focuses Properties and reveals the Parameters section of the selected motion-graphic clips, caret in the first field | Premiere edits a template's parameters in Essential Graphics ▸ Edit / the Properties panel, not in a dialog ([Adobe: Use Motion Graphics templates](https://helpx.adobe.com/premiere-pro/using/motion-graphics-templates.html)) |
| Help ▸ Third-Party Notices | the licence screen of About on its own, with the package notices and the ported-source records expanded | |
| File ▸ Get Properties for Selection… (Ctrl+Shift+H) | a read-only dialog per selected medium: file path (from the engine), type, file size, image size, frame rate, pixel aspect ratio, codec, pixel format, colour, field order, alpha, audio format, total duration, start timecode | Premiere: File ▸ Get Properties for ▸ Selection; new menu entry |
| Set / Clear Poster Frame (Shift+P / Alt+Shift+P, Project panel) | the frame under the pointer while hover-scrubbing a thumbnail in Icon View becomes the item's poster; Clear acts on the hovered item, else on the selected ones | new document command `item.setPoster {itemId, time \| null}` (undoable, in `describe_commands`); the schema already had `MediaItem.poster` |
| Effects ▸ New Custom Bin (Ctrl+/) / Delete Custom Item (Backspace, Effects panel) | a preset bin inside the picked bin (else under Presets); deletes the picked user preset or bin after the existing confirmation | user bins can now be picked (highlighted); both are in the Effects panel menu |

**Media Browser** (`apps/web/src/panels/mediaBrowser/`, engine `apps/engine/src/routes/browse.ts`, API
`packages/api/src/media-browser.ts`). Premiere's panel over the engine host's file system: places (Home, the usual
media folders that exist, mounted volumes, the root or drive letters), back / forward / up, an editable path, a
type filter (all supported, video, audio, images, graphics, captions, timelines, LUTs, 3D models), search, "All
files", list and thumbnail views (natural name order, folders first, at most 2 000 entries with a notice), and a
preview of the selected file: a player for video and audio the browser can play, the picture for stills, otherwise
the engine's thumbnail, with the ffprobe summary (size, frame rate, duration, codec, audio). Import, double-click
or Enter registers the files **in place** through the existing import service (`POST /api/media/register`), so
timeline documents, caption files and image sequences behave as in File ▸ Import; files can be dragged onto the
Project panel or the Timeline (`application/x-jasper-host-paths`). The panel docks next to the Project panel
(`PanelDefinition.dockWith`, as in Premiere's default layout) when the workspace has no place for it, and collapses
its places into a dropdown when narrow. The last folder, view and filter are remembered per browser.

The routes exist for **local engines only** and follow the path rules of `docs/security-review.md` (ARCHITECTURE
D-47): absolute, normalised paths; bytes served only for video, audio and picture extensions, checked on the name
and on what it resolves to; `nosniff` and `CSP: sandbox` on what is served; requests a browser marks as
cross-site refused (on an engine without a token a page could otherwise embed local pictures by guessing paths);
FFmpeg reads with `-protocol_whitelist file,crypto,data`. Thumbnails are cached under `<appdir>/tmp/browse-thumbs`
(two renders at a time, pruned past 1 500 files).

**Connect.** The editor only ever talks to the origin that served it (ARCHITECTURE §4.2: Host and Origin
allowlists), so "connect to another engine" cannot mean pointing this page at another API. Each engine serves its
own editor; the dialog therefore offers what is true: retry the connection to this engine, or open the other
engine's editor in this window (reachability checked first, the project saved first). The desktop app runs its own
engine and only reconnects. An agent driving the window through the live-UI tools cannot use it to send the editor
to another address (`agentInputActive`, security review AGT-1).

**Agents.** MCP tool `browse_media_files` (`apps/mcp/src/tools/polish.ts`, 323 tools now): the places, or one
folder's sub-folders and importable files with kind, size and date, optionally the ffprobe summary of up to 20;
read-only; never the listing of every file. `item.setPoster` reaches agents through `apply_commands`.

## 3. Decision log

`docs/ARCHITECTURE.md` D-43 described CANVAS_NESTED as an open limitation; it now states what `compositor` built
(one flat compositor for stacks whose scopes would nest) and what `CANVAS_NESTED` is left for. D-38 (asset
sidecars) names the one tool that must not see them, D-39 (recovery) the lease's tab memory, D-41 (expressions) the
hardened realm of the security review. New rows: D-46 (UI languages), D-47 (agent input and path rules), D-48
(project open). The route table lists `/api/media/status` and `/api/browse/*`.

## 4. Languages: labels built from names, and switching without a restart

**Labels built from the model's names.** Effect, parameter, transition, preset and command names are data; the
document observer of the `gaps` workstream translated a text node only when its whole text was such a name, so
"Gaussian Blur: Radius" or "Bypass Gaussian Blur" stayed English. Now (`apps/web/src/i18n/runtime.ts`):

- `translateName` also translates a label made of names joined by separators (`:` `·` `▸` `—` `/` `|` `,`
  parentheses), part by part;
- `__t("… {0} …", arg)` translates a placeholder value that is exactly a model name — unless the placeholder
  stands in quotes in the source string (“{0}”), which is how the UI writes names the user gave;
- the names of the built-in presets (effect, caption, sequence, proxy, EQ, reverb, shape, text animator, Essential
  Sound: names, bins and descriptions) joined `model-strings.json` (5 298 → 5 545 names).

The hazard of the second rule: a user's name that equals a model name ("Blur") is shown translated inside an
unquoted message. It is cosmetic, and the exact-match observer already had it for unmarked DOM text.

**More strings found.** The transform did not look at JSX expression children (`{busy ? 'Saving…' : 'Save'}`) nor
at `*_TEXT` / `*_HINTS` / `*_REASONS` maps: about 200 strings were never externalised although the catalogue was
"complete". Both are rules now (and an explicit `t('…')` is recorded). Plural fragments glued from pieces ("file" +
"s are" + "offline:") became whole sentences. `es.json` covers all 8 614 strings (`pnpm i18n:check`).

**Switching live.** Preferences ▸ Appearance ▸ Language used to need a reload, which throws the undo history away
— the one piece of state that cannot be put back (history entries are document snapshots; they cannot be
serialised cheaply). So the switch is live (ARCHITECTURE D-46):

- A string inside a function is looked up every time the function runs. Of 4 421 wrapped strings, 1 107 sat at
  module scope (command tables, option lists, label maps, the menu model) and were looked up once at load. The
  transform now makes those lazy: an object property becomes `get label() { return __t("…") }` with a setter that
  turns it back into a plain value on assignment; inside functions the same is done for plain string literals
  (factories called at load); label arguments of the menu and shell-command helpers stay the English source and are
  translated when read (`src/i18n/lazy.ts`: `defineLazyLabel`, `assignLazy` for copies that must stay lazy).
- `setLanguage` loads the catalogue, puts back the source text of what the observer had translated, and bumps the
  language epoch. `App` keys the editor views and Home on it, so they remount; the session, its history, selection
  and lease are held above (`ProjectSessionHost`, `ProjectLifecycle`) and stay. Preferences stays open on the same
  page; toasts are redrawn; dock tab titles are re-read from the panel definitions (stored layouts carry the titles
  of the language they were saved in), including the accessible name dockview gives a floating group.

**Verified** (`e2e/polish.spec.ts`): English → Spanish through Preferences without a reload (a flag on `window`
survives), the History list is unchanged and undo / redo work across the switch; then a tour of six workspaces, six
panels, nine menus, the command palette and Preferences collects every on-screen string that is an English
catalogue key with another Spanish text, and compares it with the same tour after a reload in Spanish — the live
switch may not leave more behind. The same in the other direction (page loaded in Spanish, switched to English).
It found and fixed: toasts, floating-group names, a status map. Unit tests: `apps/web/test/polish-i18n.test.tsx`.

**Limits.** Text already written into the document or the history (a History label made of a translated UI
string) keeps the language it was written in. Module-scope values *derived* from labels at load (a `Map` built
from `x.label`) would freeze; the tour found none, new code should build such values lazily.

## 5. Opening a large project

`ui-perf` reported 8–14 s for the 2 000-item project. Profiled end to end with `scripts/perf/ui-profile.ts
items:2000 open` and the new `scripts/perf/open-phases.ts` (phases from navigation start, requests by kind,
main-thread time by kind from a Chrome trace). Where the time went, and what changed:

| Cost | Cause | Change |
|---|---|---|
| ≈ 5 s | one `GET /api/media/:key` per medium (2 000 requests), each answer a store update that re-ran every subscriber and forced a layout | `POST /api/media/status` answers ≤ 1 000 keys; each answer is applied as one store update; an engine without the route is asked per medium as before |
| ≈ 2 s | the bin rendered all 2 000 rows once: windowing turned on in an effect, after the first render (style + layout ≈ 1 s) | the row window starts windowed (`panels/project/virtual.ts`) |
| ≈ 0.4 s | the editor’s 30 chunks (shell, dock, panel bodies) were discovered in three round trips after the bundle had run | `/editor-boot.js` (generated at build from the bundle graph, an external script for `script-src 'self'`) adds `modulepreload` links on editor URLs |
| ≈ 0.1 s | the project file was requested only after the bundle had booted | the same script starts the request; the engine client's first matching GET takes the answer (`fetchWithEarly`) |
| one extra sweep | `engine.subscribe` was a new function whenever the engine state changed, so the media sync was torn down and resolved every medium again | `subscribe` / `refresh` keep their identity; the sync restarts only on reconnect |

Not changed: validating the project (zod, ≈ 170 ms for 2.1 MB), evaluating the bundle (≈ 450 ms), the first render
of the visible panels. Mounting background-tab panels when idle was tried and measured (alternating runs): no
measurable gain on this host, so it was not kept.

**Measured** (shared 12-core host, other agents building, headless Chrome, cold HTTP cache per run;
`pnpm exec tsx scripts/perf/open-phases.ts items:2000 --runs 6`; "media" = editor interactive and every medium
resolved; the load factor is `scripts/perf/budget.ts`):

| Build | Load average / factor | Open to "media" |
|---|---|---|
| before (`integrate/parity` 065af535, profiler attached) | ≈ 12 | 10.9 s (ui-perf reported 8–14 s) |
| + batch status | 19–23 | 4.7 – 5.9 s |
| + windowed first render | 13–18 | 2.45 – 3.0 s |
| + preload and early fetch | 14 / ≈ 1.4 | 2.0 – 2.2 s |
| final, several sessions | 17–19 / 1.3–1.8 | median 2.7 s, best 2.2 s (10-item project in the same runs: median 2.3 s, best 1.9 s) |
| final, after §7 and §7.1 (5 runs) | 20–21 | median 2.9 s, best 2.6 s |

**The 2 s target is not demonstrated**: on this host at its usual load the open takes 2.0–2.9 s (4.2–4.9 s in one e2e run while the load factor read 5), of which about
2.3 s is the editor starting for any project. Divided by the measured load factor it is under 2 s, which is what
the budget enforces (`pnpm perf --sections ui --ui open`, budget 2 000 ms × load², exact with `PERF=1`); a run on an
idle machine was not possible. The deterministic guards do not depend on load: `e2e/polish.spec.ts` asserts two
status requests (not 2 000) and fewer than 200 rows ever rendered.

Not measured: 2 000 media that are *online* (the fixture's media are offline, so the engine answers without
touching disk; online media cost a few `stat` calls each, 16 at a time).

## 6. The native motion-graphic smoke test

`e2e/smoke.spec.ts` "motion graphic + footage exports with Auto → native" needs `jasper-mg`. Two things were wrong:

- **`pnpm mg:build` had been failing since the asset sidecars landed**: fframes' `include_media_dir!` refuses a
  folder that holds anything but media, and every asset now has a `<file>.attribution` next to it (AGENTS.md §3).
  The engine tests skip without the binary, so nobody saw it. `native/mg/crates/jasper-mg-templates/build.rs`
  stages the media without the sidecars into `native/mg/target/mg-media`, which the macro embeds.
- `pnpm e2e` did not build the binary. `scripts/e2e-prepare.mjs` runs `mg:build` (incremental; it prints why and
  exits 0 when cargo is missing; `E2E_SKIP_MG=1` skips it), and the test skips with the engine's own reason when
  `render.fframes` is not `ready` — like the WebGL-dependent colour spec does.

Verified: `cargo test -p jasper-mg-templates`, `apps/engine/test/mg.test.ts` (the six real-render tests ran instead
of skipping), `e2e/smoke.spec.ts` 11 / 11 with the native motion-graphic export.

## 7. Panels that never appeared (found while running the gate)

One run of the e2e suite on a busy host failed in a way no test had described: after New Project, the Project
panel and the Program monitor stayed skeletons for three minutes, and the console held 21 976 "Blocked attempt to
create a WebMediaPlayer" errors. Every chunk had loaded.

**Root cause.** Panel bodies were `React.lazy` components under `<Suspense>`. When a lazy component's module
arrives, React renders it in a *retry lane*: time-sliced, restarted from scratch whenever any other update arrives
on the root, and — unlike transitions — never expired. When updates arrive more often than the panel takes to
render (engine events of running jobs, on a machine slow enough that the Program monitor needs longer than the gap
between them), the retry never commits. Each abandoned attempt of the Program monitor had already created the
Player's eight `<audio>` elements; a thousand of them later Chrome refused new media players.
`apps/web/test/polish-panel-loading.test.tsx` shows it in isolation: a 180 ms render under a Suspense boundary never
appears while a sibling updates every 4 ms.

**Fix** (`apps/web/src/panels/lazy.ts`, `shell/dock/DockHost.tsx`, `App.tsx`). Code-split panels and the editor
shell are mounted through state: `loadable()` shares one download (retried after a failure), `useLoaded()` sets
state when it resolves, and a state update renders in a blocking lane that cannot be starved. A failed download
still reaches the panel's error boundary (Reload Panel asks again) or, for the shell, the "Could not load the
editor" screen. The same test mounts the same panel through `useLoaded` under the same ticker and finds it on
screen.

The source of the frequent updates in that run was not identified (the trace was gone when the cause was
understood); the fix does not depend on it.

### 7.1 A bundle that could not be downloaded left a blank page

A later run failed differently: the 2 000-item open waited 60 s on a black page with no error. The Playwright trace
showed five of the entry's static imports (`app-project`, `vendor-icons`, `vendor-radix`, `vendor-remotion`,
`vendor-anime`) aborted with `net::ERR_NETWORK_CHANGED` 60 ms after the navigation: the host's network configuration
changed while the page loaded (another job on the machine was building containers) and Chrome aborts every request in
flight when that happens. A module graph that cannot be fetched never runs, so nothing could report it. The same
happens to a user whose laptop changes network, or whose engine restarts, during a page load.

**Fix.** `/editor-boot.js` (a classic script that runs before the bundle, `apps/web/editor-boot.ts`) listens for the
`error` event of the entry module script; when it fires and nothing is on screen it shows "JasperEditor could not
load. Check your connection and reload." with a Reload button (English or Spanish by the stored preference: the
catalogue is part of what failed to load). A lazy chunk that fails was already reported by the app ("Could not load
the editor", Reload Panel). Tests: the unit test of the script in `polish-open.test.tsx`; `e2e/polish.spec.ts` aborts
`vendor-react`, sees the message, reloads and reaches Home.

The measurement helper (`scripts/perf/open-phases.ts`) now listens for console and page errors before navigating, so
such a failure names its cause, and repeats a run (at most twice) when a request failed with exactly
`net::ERR_NETWORK_CHANGED`: that run measured the host, not the editor. Every other failure is reported.

## 8. Documents

`docs/gaps.md`, `docs/parity.md`, `docs/M1-STATUS.md` and the README were brought to the final state: no workstream
is "in flight", the five disabled menu entries are gone, the counts are recounted (323 MCP tools from a live
`listTools`, 291 menubar entries all registered, 256 document commands, 22 panels, 526 test files, 54 Playwright
specs), the README opens with what the product does.

## 9. Tests added

| File | What |
|---|---|
| `packages/session/test/persistence/tab-leases.test.ts` | §1 |
| `packages/project/test/polish-poster.test.ts` | `item.setPoster`: set in three time forms, clear, undo, refusals |
| `apps/engine/test/browse.test.ts` | Media Browser: classification, path checks, ordering, places, listing with symlinks and the cap; the routes on the fixtures; typed refusals; symlink to a non-media file; cross-site requests; playlist-like file; non-local engine |
| `apps/engine/test/polish-media-status.test.ts` | batch status equals the per-medium route; unknown keys; validation |
| `apps/mcp/test/polish.test.ts` | `browse_media_files` |
| `apps/web/test/polish-menu-wiring.test.ts` | every menu entry and key binding has a command |
| `apps/web/test/polish-media-browser.test.tsx` | the panel, the drag payload, the commands, the engine dialogs, the agent guard on Connect |
| `apps/web/test/polish-keybindings.test.tsx` | Get Properties, poster frames, custom bins |
| `apps/web/test/polish-i18n.test.tsx` | lazy strings, composite names, the observer, the epoch |
| `apps/web/test/polish-open.test.tsx` | batch resolution, fallback, the boot script, the chunk list, the early fetch, the start-up failure message (§7.1) |
| `apps/web/test/polish-panel-loading.test.tsx` | §7: the starved Suspense retry, the state-mounted panel, `loadable` |
| `e2e/polish.spec.ts` | menus and dialogs, Media Browser import, Edit Parameters, the live language switch both ways, the 2 000-item open, a bundle that cannot be downloaded (§7.1) |
| `e2e/project-files.spec.ts` (one test added), `e2e/gaps.spec.ts`, `e2e/smoke.spec.ts` | §1, §6 |

## 10. Comparison with the references

The reference repositories (EffectCraft, FilmCraft) are editors in Rust with egui; nothing in this scope has a
counterpart to port. Where they have the feature: FilmCraft's media browser draws every row of a folder in a scroll
area and imports by path; here the listing is capped and filtered by what can be imported, with previews and
thumbnails — equal in function, better at scale. Neither has single-writer leases across windows, a web build, UI
languages, or an engine to report on.

## 11. Not done, and caveats

- The 2 s open target is not demonstrated on this host (§5).
- The Media Browser previews what the browser can play; other files show the engine's thumbnail and say so. There
  is no hover-scrub in its thumbnails, and it does not show the engine's proxies.
- Set Poster Frame takes the frame of the hover scrub (a sprite-sheet tile, so its time is that tile's time); there
  is no numeric entry. Stills and audio have no poster frame.
- Connect cannot attach this window to another engine's API (by design, see §2); in the desktop app it only
  reconnects.
- Everything was checked on Linux in headless Chrome; the directory roots for macOS and Windows are covered by unit
  tests of the function only.
