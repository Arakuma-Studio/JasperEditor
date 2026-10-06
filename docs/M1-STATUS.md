# M1 acceptance status (ARCHITECTURE §15)

**M1 acceptance snapshot: `dev` after wave 3 (WP-3L, WP-3I, WP-3V merged). All 13 items PASS.** The final check on
`dev` (2026-09-30, below) re-ran every command. The per-item evidence further down is from the WP-3I
acceptance run on `wp/wp-3i` (based on `dev` at `3f5498d`). The wave-3 merge
changes are listed in `docs/wp-notes/INTEGRATION-W3.md`, and the re-run on `dev` gives the same results.

**After M1 — wp-mcp (merged into `main`):** the in-app Agent panel is gone and the agent API
ships as an MCP server (`jasper-mcp`, ARCHITECTURE D-18 / §11). Item 10 below is now exercised through MCP;
see "wp-mcp: Agent panel → MCP server" at the end of this file and `docs/wp-notes/wp-mcp.md`.

Environment: Linux x64, Node 20.20, pnpm 10.34, cargo 1.96, system ffmpeg 6.1.1 (GPL build with libx264; the
product does not require it, D-13), system Chrome, 12 cores, no GPU. This host is shared with other agents,
so every server ran on a private port range instead of 5173/47900. The commands and code paths are the same.

## Final check on `dev` (2026-09-30)

Main checkout, `dev` at `254cd16` plus the commits of this check. Ports 48350–48399.

| Command | Result |
|---|---|
| `pnpm install` | lockfile up to date |
| `pnpm verify` | lint, typecheck, test (65 files + 1 skipped, **682 passed**, 5 skipped: opt-in Remotion e2e and fuzz sweeps; 681 before the fix below) and build all pass |
| `pnpm fixtures && pnpm mg:build` | fixtures present; `jasper-mg` built |
| `E2E_PORT=48350 pnpm e2e` | **27/27 passed** (agent 3, editing 9, PWA 2, smoke 13) in 2.6 min |
| `MG_CHECK_PORT=48360 pnpm e2e:mg-fallback` | PASS (ready → `native`; binary missing → `unavailable` → `remotion` with the blocker) |
| `DESKTOP_SMOKE_PORT=48362 ELECTRON_DISABLE_SANDBOX=1 pnpm e2e:desktop` | PASS for packaged-like and dev (xvfb) |
| `pnpm e2e:typecheck` | pass |
| README walk-through | dev engine + Vite on alternate ports: `/api/capabilities` answered through the Vite proxy. `curl` `POST /api/projects` then `POST /api/agent/tx` with `marker.add` returned `ok: true, appliedBy: headless`. The built engine served the PWA build: `/`, `/manifest.webmanifest`, `/sw.js` and the icons all returned 200. |
| Clean room | `.gitignore` still ignores `.reference/` and `editor-starter.zip`. `git ls-files \| grep -iE 'reference\|editor-starter'` is empty, and no commit in history touches them. |

Fixed during the check: with the README's PWA command (`JASPER_WEB_DIR=apps/web/dist node
apps/engine/dist/engine.mjs …`) the built engine refused to start, because @fastify/static requires an
absolute root. `engineConfig` now resolves `webDir` against the cwd, and a unit test covers it. Before the fix,
only callers that passed an absolute path (E2E, desktop) worked.

Housekeeping: two untracked QA screenshots (`proj-icon.png`, `proj-list.png`) were left in the repo root by
the WP-3V visual QA. They are superseded by the committed `docs/screenshots/m1/after/0{4,5}-*.png` and were
moved out of the checkout.

### Still open at the end of M1

These are not M1 blockers. Details are in the follow-ups below and in `docs/wp-notes/INTEGRATION-W3.md`.

- ~~**Packaging blocker (D-13):** the Remotion compositor ships a GPL/nonfree FFmpeg.~~ **Resolved after M1
  (wp-lgpl, `wp-notes/wp-lgpl.md`):** the Remotion path uses our LGPL FFmpeg 7.1 through Remotion's
  `binariesDirectory` (`pnpm ffmpeg:lgpl`, sha256-pinned); packaged builds ship it as
  `<resources>/ffmpeg-lgpl`, never stage `@remotion/compositor-*`, and the license guard (`pnpm ffmpeg:check`,
  electron-builder `afterPack`) fails the build on any GPL/nonfree FFmpeg. Verified on Linux x64 (Remotion
  export on the LGPL build, unpacked desktop build, `pnpm e2e:packaged`). What remains before distribution:
  - macOS: the from-source LGPL build and the dylib loading under the hardened runtime are not run on a Mac
    (the same build script was built and run on Linux);
  - Windows: the LGPL directory and an unpacked app were assembled and checked statically (license strings,
    every import of `remotion.exe` resolves), but never run on Windows;
  - license review items: H.264/AAC patent coverage of a self-built OpenH264 (Cisco's grant covers only its
    own binary), LGPL 3 terms of the BtbN build on sealed installers, and Remotion's company license (D-19);
  - installers, signing and auto-update stay M3.
- **Not run on real hardware:** hardware H.264 export has not run on a GPU host (only the argument sets are
  unit-tested). OpenH264 now runs for real: with `vendor/ffmpeg-lgpl` present every H.264 export and proxy in
  the unit tests and in `pnpm e2e` is encoded by libopenh264.
- **Remotion Player stall (4.0.499):** the root cause is unknown. The playback watchdog works around it
  (E2E is stable).
- **Editing lock (corrected 2026-10-07):** an earlier version of this list said the lock is not released on
  `pagehide`. That was wrong: `EngineProjectStore` (`packages/session/src/persistence/engine.ts`) sends a
  keepalive `DELETE …/lease/:id` for every held lease on `pagehide`, with the bearer token in token-only auth
  mode since e8b4d14 (test: "keepalive lease release carries the bearer token…" in
  `packages/session/test/persistence/engine-store.test.ts`), so a reload reopens the project editable. If the
  browser drops the request (a crash, a killed process), the lease expires after 30 s, and the unsaved changes
  are offered for recovery on the next open (ARCHITECTURE D-39).
- **Unregistered commands at the M1 checkpoint:** clipboard, transitions, captions, preferences, and
  other M2 menu commands were pending. The old wiring inventory test was removed during test cleanup;
  current command behavior is checked through feature tests and browser workflows.

## WP-3I acceptance run (evidence)

### Commands used (all green on that tree)

| Command | Result |
|---|---|
| `pnpm install && pnpm fixtures && pnpm mg:build && pnpm verify` | lint, typecheck, test (62 files, **661 passed**, 4 skipped) and build all pass |
| `git clone` of this branch into `/tmp` → `pnpm install && pnpm verify` | pass (62 files, **658 passed**, 7 skipped: without `pnpm mg:build` the real jasper-mg render tests skip) |
| `pnpm e2e` (builds engine + web, Playwright headless Chrome) | **27 passed** (smoke 13, editing 9, agent 3, PWA 2) in 2.6 min |
| `pnpm e2e:desktop` | packaged-like PASS (engine forked on a random port, Home loaded) and dev PASS (tsx engine + Vite, Home loaded); screenshots in `test-results/desktop-*.png` |
| `pnpm e2e:mg-fallback` | with jasper-mg: fframes `ready` → plan `native`; with the binary missing: `unavailable` → plan `remotion`, blocker "motion graphic "Lower Third" needs the fframes renderer, which is unavailable" |
| `pnpm e2e:typecheck` | pass |

### Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm install && pnpm verify` passes on a clean clone | **PASS** (after a WP-3I test fix) | A fresh `git clone` of `wp/wp-3i` ran `pnpm install` and `pnpm verify`: lint, typecheck, 62 test files (658 passed, 7 skipped) and build. The first clean-clone run failed. On a fresh checkout the engine media/export/uploads suites generate `fixtures/media` in `beforeAll` and hit Vitest's 10 s hook timeout; the hooks now allow 180 s (commit `f61d16c`). In the worktree (fixtures and jasper-mg built), 661 passed and 4 skipped (the opt-in Remotion e2e and fuzz sweeps). |
| 2 | Home and the Editing workspace (panels, chrome, tokens, font, focus, `` ` ``) | **PASS** (dev server on other ports) | `e2e/editing.spec.ts` "Editing workspace chrome" checks:<br>• title bar and menubar;<br>• mode tabs, workspace tabs and the engine chip (Local);<br>• tabs for Project, Program, Tools, Timeline, Audio Meters, Properties, Agent, Effect Controls, History and Jobs;<br>• body font `Source Sans 3` and `data-pr-theme=darkest`;<br>• `` ` `` maximize and restore.<br>`smoke.spec.ts` checks that New Project uses the 1080p 29.97 preset (1920×1080). The focus outline is AC-FO-1 in `apps/web/test/shell-render.test.tsx`. The dev stack (`tsx` engine + Vite proxy) ran through `e2e/desktop-smoke.mjs dev` on 48140/48141, because 5173/47900 are outside this package's port range. |
| 3 | Import `clip-a.mp4` → Project row/tile with poster; Jobs panel shows the analysis jobs | **PASS** | `smoke.spec.ts` imports through the File ▸ Import (Ctrl+I) file chooser. The row appears, and the Icon view poster `<img>` loads (`naturalWidth > 0`). `editing.spec.ts` sees ≥ 2 succeeded probe/poster/sprite/peaks jobs in `/api/jobs` and the job groups in the Jobs panel. In Electron, File ▸ Import uses the native dialog (`pickMedia`, WP-2E tests). |
| 4 | Drag to the timeline → linked V1/A1 with filmstrip and waveform; Ctrl-drop inserts and ripples sync-locked tracks | **PASS** (WP-3I fixed the waveform) | `smoke.spec.ts`: HTML5 drag of the Project row → V1 video and A1 audio at frame 0, linked, 299 frames. `editing.spec.ts` counts drawn canvas pixels in the V1 filmstrip and the A1 waveform. Waveforms were broken before WP-3I: the peaks were keyed by the wrong stream index. With Ctrl held, the drop of clip-b inserts at 5 s: V1 becomes a/b/a and A1 ripples with it, in one History entry. Note: filmstrips need a track height ≥ 40 px, and the default V height is smaller (the test expands the tracks). |
| 5 | Space / J / K / L / ← / → drive the Program monitor; timecode entry; no React re-render per frame | **PASS** (WP-3I fixed a playback stall) | Covered by `smoke.spec.ts` (Space) and `editing.spec.ts` (timecode `00;00;02;00` → frame 60, → → ← = 61, L plays, K stops, J plays in reverse). `programPixels()` reads the Program canvas at 3 s (test pattern, std > 20). The playback stall that WP-3I fixed: after seeks the Player sometimes did not start (2 of 3 runs); the driver watchdog fixes it (see follow-ups). No React work per frame: `apps/web/test/program-monitor.test.tsx` "does not re-render React outside the Player per played frame (S03:ARC-010)". |
| 6 | Move, Ctrl-move, trims, razor, Delete / Shift+Delete, snapping — one History entry each; undo/redo with selection restore | **PASS** | `smoke.spec.ts` (each one History entry): move (linked partner follows), head trim, and razor `C`. Ctrl+Z / Ctrl+Shift+Z undo and redo the razor. `editing.spec.ts` (one entry each unless noted):<br>• Ctrl+K at the playhead;<br>• Delete lifts and leaves a gap; Ctrl+Z restores the clip and its selection;<br>• Shift+Delete ripples, V1 and A1;<br>• `B` ripple trim of a tail, with later clips ripple-shifted;<br>• Ctrl-drag insert-move;<br>• `S` toggles snapping (the toolbar toggle state flips).<br>Ctrl-edge ripple trim is covered by unit tests (`apps/web/test/timeline-gestures.test.ts`), not E2E. |
| 7 | Text clip (Graphics menu / `T` in Program) and `lower-third@1`; Properties scrub = one undo step; Program shows them; move/scale/rotate on the overlay | **PASS** (WP-3I added the menu command and fixed a drag bug) | Graphics ▸ New Layer ▸ Text (`graphics.newTextLayer`) was unregistered before WP-3I and now adds a centred 5 s text clip. `T` + click in Program adds one too (smoke). `lower-third@1`: dragged from the Motion Templates panel to V2. A Properties scrub gives one History entry. On the Program overlay, move twice, scale (SE handle) and rotate (NE rotation zone) give one entry each (`Move, Move, Scale, Rotate`). The second drag used to be cancelled by a stray text selection; WP-3I fixed that. The MG layer renders in Program: its fframes badge (`data-mg-badge`) is visible and reports `ready` after "Re-render Motion Graphics". |
| 8 | Export: media-only Auto → native with an exact frame count; with text → Remotion with a blocker; progress in Jobs; download works | **PASS** | `smoke.spec.ts` uses Export mode (Ctrl+M), engine Auto, Export, and the Jobs panel row → Download. ffprobe of the downloads (sequence = 329 frames):<br>• `smoke-native.mp4`: h264 1920×1080 30000/1001, **329 frames**, 10.978 s, AAC 48 kHz stereo, `renderPath: native`;<br>• `smoke-remotion.mp4`: 329 frames, `renderPath: remotion`, and the plan blocker list names the text clip.<br>Export mode used to hide the Jobs panel (`panel.open.jobs` was not registered) and a sticky toast used to cover the Export button; WP-3I fixed both. |
| 9 | `pnpm mg:build`; `jasper-mg render … --raw-rgba \| ffmpeg` → 150 straight-alpha frames; fframes ready; footage + MG exports native via the ProRes master; without the binary → unavailable → Remotion | **PASS** | `pnpm mg:build` built `native/mg/target/release/jasper-mg`. `jasper-mg render --spec native/mg/fixtures/lower-third.json --raw-rgba \| ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i pipe:0 -c:v prores_ks -profile:v 4444 …` gives prores yuva444p12le, **150 frames**. Pixel (1500,100) has alpha 0; the panel at (300,900) is RGBA 10/15/31/200 (straight alpha, 78 %). `/api/capabilities` reports `fframes: ready`. In `smoke.spec.ts`, footage + lower third exports with `renderPath: native` (329 frames), and the lower-third region is bright while the empty top-right stays black. `pnpm e2e:mg-fallback` shows the binary-missing → `remotion` fallback. |
| 10 | Agent tx adds a marker live and History shows `Agent: …`; headless when closed; `track.remove` requires approval | **PASS** | `e2e/agent.spec.ts` posts `POST /api/agent/tx` over HTTP to the engine, the same call as the curl in §15 (on port 48110):<br>• Live: `clip.place {mediaByName}` + `marker.add` → `appliedBy: session`; the clip body and the ruler marker appear, and History contains `Agent:`.<br>• `track.remove` waits for approval in the Agent panel; Deny → `E_APPROVAL_DENIED`, and the track is kept.<br>• With the editor closed, the call returns `appliedBy: headless`, and after reopening the project both markers are in the ruler. |
| 11 | Electron under xvfb shows the editor; the packaged-like start loads Home | **PASS** (the dev window shows Home) | `pnpm e2e:desktop` runs `xvfb-run -a` with `ELECTRON_DISABLE_SANDBOX=1` and a private profile.<br>• packaged-like: `utilityProcess.fork(engine.mjs --port 0)` with a token cookie; it loads `http://127.0.0.1:<random>/` and Home shows "Engine: connected".<br>• dev: it loads Vite on 48141, which proxies to the tsx engine on 48140; Home shows "Engine: connected".<br>Screenshots are in `test-results/desktop-{packaged-like,dev}.png` (1600×960). `pnpm dev:desktop` now honours `JASPER_DESKTOP_DEV_URL`. |
| 12 | `pnpm --filter @jasper/web build` emits `manifest.webmanifest`, `sw.js`, icons; the SW route classifier tests pass | **PASS** | `apps/web/dist/{manifest.webmanifest, sw.js, icons/*}` exist. `apps/web/test/pwa.test.ts` (classifier == `sw.js` over every prefix × mode × method × Range) passes in `pnpm verify`. `e2e/pwa.spec.ts` checks the production build served by the engine:<br>• the manifest is linked; standalone, WCO, colours and the `.jasper` file handler are set; the 192/512 `any` and maskable icons are PNGs of the declared sizes;<br>• the SW activates, controls the page and creates `jasper-shell-*` caches, and `/api/capabilities` is never cached. |
| 13 | `pnpm e2e` smoke passes headless | **PASS** | 27/27, headless system Chrome, against the built engine serving the built SPA with a temp appdir. |

Item 1 clean-clone command: `git clone --branch wp/wp-3i <repo> /tmp/wp3i-clean && cd /tmp/wp3i-clean && pnpm install && pnpm verify` → exit 0.

## Follow-ups for M2 (by owner package and spec ID)

- **WP-2C / compositions (S03:ARC-010, PGM-003): Player stall.** Find the root cause of the Remotion Player
  4.0.499 not starting after seeks with `@remotion/media`. The playback watchdog (`PLAY_WATCHDOG_MS`) is a
  workaround.
- **WP-2G / session (S01:LIFE-045): automatic renders.** Request preview/master renders automatically,
  500 ms after MG param, duration or canvas changes. Today the Program badge only tracks renders started
  with `mg.rerender`.
- **WP-2B (S02:TL-150): filmstrips.** Filmstrips are hidden at the default video track height; consider a
  default height ≥ 40 px or a thumbnail strip for small tracks.
- **WP-2A / WP-2E (S05 §12.2): remaining commands at this checkpoint.** Register menubar/keymap ids for
  clipboard (S01 §20), transitions, captions, shapes, Save As /
  Revert, preferences, keyboard shortcuts dialog, `sequence.settings`, and `timeline.toggleLinkedSelection`.
- **WP-2F (D-13): hardware H.264.** Run an export on a GPU host. The WP-3L encoder selector
  (`apps/engine/src/tools/encoders.ts`) picks hardware encoders first, but only their argument sets are
  unit-tested here (no GPU on the dev host). OpenH264 on the LGPL build is covered since wp-lgpl.
- **WP-2F (S04:RP-006): audio mix.** Remotion-path exports are about 50 ms longer in container duration
  (AAC padding from Remotion's audio). The frame count is exact.
- ~~**WP-2H: `panel.focus.agent`.** Drop the duplicate registration in `commands/agent.ts`.~~ Obsolete:
  wp-mcp removed the Agent panel and its commands.
- **Web bundle (§13).** `JobsPanel` is also statically imported by the header badge. Move `useJobsSummary`
  into a small module so the panel loads lazily too. (`AgentPanel` no longer exists, wp-mcp.)

## wp-mcp: Agent panel → MCP server (after M1)

User decision: remove the in-app Agent panel and expose the agent capabilities as an MCP server for external
coding agents. The wp-mcp acceptance run used ports 48550–48599. Details, tool list and open points:
`docs/wp-notes/wp-mcp.md`.

| Command | Result |
|---|---|
| `DESKTOP_SMOKE_PORT=48570 ELECTRON_DISABLE_SANDBOX=1 pnpm e2e:desktop` | PASS for packaged-like and dev (xvfb); the preload now also exposes `focusWindow()` and `mcpInfo()` |
| Real clients, throwaway config dirs (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` under `/tmp`) | Claude Code 2.1.285: `claude mcp add jasper -- node …/apps/mcp/dist/jasper-mcp.mjs` → `claude mcp list` "✔ Connected"; also with `--env`, with `--appdir`, and `--transport http …/mcp` against a real engine. Codex CLI 0.159.0: `codex mcp add jasper -- node …` wrote the `[mcp_servers.jasper]` table shown in the README; `codex mcp list` shows it enabled. No model session was run through either client. |

Checklist item 10 is now: "an MCP client adds a clip and a marker live and History shows `Agent: …`; headless
when closed; `track.remove` requires approval". **PASS**, `e2e/agent.spec.ts` (6 tests), with an MCP SDK
client connected over stdio to the built `apps/mcp/dist/jasper-mcp.mjs`, which finds the E2E engine through
its `runtime.json`:

- `engine_status` reports `foundBy: runtime-file`; `get_project` reports `editorOpen: true` and the media
  imported through the UI.
- `apply_commands` (`clip.place {mediaByName}` + `marker.add`) → `appliedBy: session`; the clip body and the
  ruler marker appear, History gets exactly one entry `Agent: Place clip-b and mark it`, and an agent toast
  names it. There is no Agent tab.
- `add_text`, `get_timeline`, `render_frame` (320 px PNG of the live document), `set_playhead` (the playhead
  moves, History does not grow), `get_playhead`, `undo` and `redo` against the open editor.
- `track.remove` → the approval card appears at the top of the window ("e2e-agent wants to run 1 command:
  track.remove"); **Deny** → tool error `E_APPROVAL_DENIED` and the track is kept; **Approve** → applied live.
- Help ▸ Connect an AI Agent… shows the Claude Code, Codex CLI and Cursor snippets with the real bundle path
  and the engine's `/mcp` URL; the Agent menu is gone.
- With the editor closed `add_marker` applies headlessly and a destructive transaction is refused;
  `open_project_in_editor` navigates the window (which was on Home) to the project and both markers are in
  the ruler.

Item 2 changed accordingly: the Editing workspace has no Agent tab (`e2e/editing.spec.ts`).
