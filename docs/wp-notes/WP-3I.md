# WP-3I — Integration, Playwright E2E, M1 acceptance

Branch `wp/wp-3i` (from `dev` at `3f5498d`). The acceptance results for every ARCHITECTURE §15 item are in
`docs/M1-STATUS.md`. This file lists what the package added or changed, and what is still open.

## E2E suite

- `playwright.config.ts` — headless system Chrome (`channel: 'chrome'`), one worker, a `webServer` that runs
  `e2e/serve.mjs`. That script starts the built engine (`apps/engine/dist/engine.mjs`) on
  `127.0.0.1:${E2E_PORT:-48110}`. The engine serves the built web app (`JASPER_WEB_DIR`) from a throwaway
  appdir.
- `pnpm e2e` = `scripts/e2e-prepare.mjs` (fixtures if missing, then engine and web builds unless
  `E2E_SKIP_BUILD=1`) + `playwright test`. `E2E_KEEP_APPDIR=1` keeps the appdir for inspection.
- The specs drive the real UI: pointer, keyboard, menus, HTML5 drag and drop, and the file chooser.
  `window.jasper` (enabled with `localStorage['jasper:agent-bridge']='1'`) is used only to read state in
  assertions (clips, history, selection, playhead).
  - `smoke.spec.ts` (13 tests):
    - create a project, import clip-a, check the poster, drag it to V1/A1, play and stop;
    - move, head trim, razor, undo, redo;
    - native export (ffprobe: h264 1920×1080 30000/1001, exact frame count, AAC);
    - `lower-third@1` from the Motion Templates panel, then a native export with the fframes master (also
      checks the composited pixels);
    - a Type-tool text clip, then an Auto → Remotion export (the blocker names the text);
    - Program monitor effect and template drops, and the fframes badge after "Re-render Motion Graphics".
  - `editing.spec.ts` (9 tests):
    - workspace chrome, fonts, theme, and `` ` `` maximize;
    - probe/poster/sprite/peaks jobs, filmstrip and waveform pixels;
    - Ctrl-drop insert with sync-lock ripple;
    - timecode entry, arrow keys, JKL, and Ctrl+K;
    - Delete and Shift+Delete, then undo with the selection restored;
    - B ripple trim, Ctrl-move insert, and S snapping;
    - Graphics ▸ New Layer ▸ Text and a Properties scrub (one undo step);
    - Program overlay: move twice, then scale and rotate (one History entry each).
  - `agent.spec.ts` (3 tests):
    - a live `POST /api/agent/tx` (clip.place with `mediaByName` + marker.add). The UI shows the clip and
      the ruler marker, and History shows `Agent:`;
    - `track.remove` waits for approval in the Agent panel, and Deny rejects it with `E_APPROVAL_DENIED`;
    - with the editor closed, the transaction applies headlessly and the marker is there on reopen.
  - `pwa.spec.ts` (2 tests): the manifest is linked and valid, and the icon sizes match. The service
    worker activates and controls the page, creates `jasper-shell-*` caches and never caches `/api`.
- Scripts that `playwright test` does not run:
  - `e2e/desktop-smoke.mjs` (`pnpm e2e:desktop`): Electron under `xvfb-run` with
    `ELECTRON_DISABLE_SANDBOX=1` and a private `--user-data-dir`, in packaged-like mode (the engine is
    forked with a token cookie) and in dev mode (it starts a tsx dev engine and Vite itself on 48140/48141).
    It asserts `did-finish-load` and a non-blank screenshot in `test-results/desktop-*.png`.
  - `e2e/mg-fallback-check.mjs` (`pnpm e2e:mg-fallback`): two built engines. With jasper-mg the plan is
    `native`; with `JASPER_MG` pointing to a missing file it is `remotion`, with a blocker naming fframes.
  - `pnpm e2e:typecheck` runs `tsc` over `e2e/` (`e2e/tsconfig.json`).

## Integration fixes (one commit each)

| Area | Fix |
|---|---|
| engine | **Waveforms never showed.** Peaks were keyed by audio ordinal, but clips store the container stream index (`channels.streamIndex`), so the timeline got a 404 for `peaks/1.bin`. Peaks v2 now key by stream index. |
| engine | **mg-render jobs in `/api/jobs`.** `JobQueue.registerExternalSource` (additive) merges WP-2G's MG scheduler into list/get/cancel/retry. `MgService.retry` was added. Masters requested by an export carry `parentId`, so cancelling the export also cancels them. |
| engine | **Static web files.** The engine now uses a wildcard static route, so web files built after engine startup are served. |
| engine | **Render request cleanup.** Stored requests are removed on non-retryable failure. Requests older than the 7-day journal retention are swept at startup. |
| engine | **System errors.** Node system errors (`ENOSPC`, `EACCES`, `ENOENT`…) map to `DISK_FULL` 507 / `NOT_FOUND` 404 / `INTERNAL` 500 with `{errno, syscall}` and without paths. Before, `400 <errno>` was returned with absolute paths. |
| engine | **D-13 encoders.** H.264 uses libx264 when present, else libopenh264 (bitrate from the CRF curve, `-allow_skip_frames 0`). This covers native export and proxies. x264 is no longer required. |
| engine, config | **`JASPER_DEV_WEB_PORT`** lets the dev engine accept another Vite port. `dev:desktop` no longer overrides `JASPER_DESKTOP_DEV_URL`. |
| session, engine-client | **Keepalive lease release.** It now sends `Authorization: Bearer` in token-only mode (`EngineClient.authorizationHeaders()`, additive). |
| web | **Shared PanelServices.** Export mode and Project panel commands use the shell's PanelServices. `panel.open.jobs` was never registered: `panel.open.<kind>` is now registered for every kind. |
| web | **Missing commands at the WP-3I checkpoint.** Menubar/keymap commands M1 needed: `graphics.newTextLayer` (Graphics ▸ New Layer ▸ Text, Alt/Ctrl+T), `mg.insertTemplate`, `app.newProject/openProject/closeProject/newSequence`, and `edit.selectAll/deselectAll/rippleDelete/duplicate`. The old wiring inventory test was removed during test cleanup; feature tests and browser workflows check current behavior. |
| web | **Header.** Save status (Saving… / Edited / Saved / conflict / read-only) and a Jobs badge built from `useJobsSummary` (uploads included). |
| web | **Program monitor.** It provides `MgRenderStateContext` from live mg-render jobs (`mg.rerender` records clip → job) and accepts effect drops (hit-tested layer) and template drops (at the playhead). |
| web | **Timeline reveal.** Keyboard seeks (edit points, steps, Home/End) scroll the timeline to show the playhead (TL-120). |
| web | **Code splitting.** Panel bodies are `React.lazy` with a Suspense skeleton, and `@jasper/project` has its own chunk. The entry chunk went from 763 kB to 377 kB, and the >500 kB warning is gone. |
| web | **Agent panel.** It publishes its console into the shell registry. |
| web | **Notices.** They sit above the Export mode footer. A sticky "Export finished" toast used to cover the Export button. |
| web | **Export file names.** `name.mp4` no longer becomes `name.mp4.mp4`. |
| web | **Playback watchdog.** If no `frameupdate` arrives within 600 ms of `play()` and the Player is not buffering, the driver pauses, seeks and plays again (up to 3 times). Before, about 2 in 3 E2E runs had the Player stuck on one frame after seeks while the store said "playing". |
| engine tests | **Clean-clone verify.** The media/export/uploads `beforeAll` hooks now allow 180 s. On a fresh checkout they generate the fixtures, which used to hit Vitest's 10 s hook timeout, so `pnpm verify` failed on a clean clone. |
| web | **Program overlay drags.** A second drag was cancelled. A stray text selection made Chromium start a native drag, which fires `pointercancel`. The viewport is now `user-select: none` and a press clears the selection. |

Contract changes (all additive):
- `@jasper/engine-client`: `EngineClient.authorizationHeaders()`.
- `@jasper/config`: `ENV.DEV_WEB_PORT`.
- Engine-internal: `JobQueue.registerExternalSource`, and `MgMasterRequest.parentId` (optional).
- Web-internal: `useEngineOrNull()`.

## Not done / open

- **`pnpm dev` on 5173/47900 was not run.** This host is shared, and this package was limited to ports
  48100–48199. The same commands (tsx dev engine + Vite + proxy) ran on 48121/48130 and 48140/48141 through
  the desktop dev smoke.
- **Automatic MG renders (S01:LIFE-045).** The session does not request renders automatically. The Program
  badge shows a render state only after `mg.rerender` (or for jobs this client started). Native export still
  renders masters on demand.
- **Remotion Player stall.** The root cause of the "Player does not start after seeks" stall (4.0.499 +
  `@remotion/media`) is unknown. The watchdog works around it, and the E2E JKL test now passes 3/3 runs.
- **Filmstrips.** They need a track height of at least 40 px. The default V1 height shows none, so the E2E
  expands the tracks. Premiere behaves the same way, but first-run users see plain clips.
- **`panel.focus.agent`** is still registered by both `app.ts` and `agent.ts`; the WP-2H version wins and
  delegates correctly.
- **Chunk warnings.** Two panels (`JobsPanel`, `AgentPanel`) are also statically imported (header badge,
  agent commands), so Rollup keeps them in the entry chunk and prints a warning. This is harmless.
- **Unregistered commands.** The keymap/menu ids listed in `wiring-audit.test.ts` (clipboard, transitions,
  captions, shapes, Save As…) stay unregistered. They are M2 features.
- **libopenh264 was not exercised end to end** (the system ffmpeg has no libopenh264). Only the argument
  selection is unit-tested.
- **Flaky under load.** One run of the web Vitest project failed a single test under heavy parallel CPU load
  (another E2E was running). It passed on re-run and in `pnpm verify`.
