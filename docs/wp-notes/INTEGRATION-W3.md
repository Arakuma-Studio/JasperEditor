# Wave 3 integration (dev)

Merge order: WP-3L (LGPL-safe encoder selection, D-13), WP-3I (integration, Playwright E2E, M1
acceptance), WP-3V (Premiere visual QA). All merges are `--no-ff`.

## Conflicts and how they were resolved

- **D-13 was implemented twice (WP-3L and WP-3I).** Both branches changed `derivatives/service.ts` and
  `export/native.ts`, which conflicted.
  - WP-3L's `EncoderService` / `tools/encoders.ts` is kept: hardware H.264, then OpenH264, then libx264,
    then AV1/VP9, plus LGPL-only mode.
  - WP-3I's parallel helpers are removed: `Ffmpeg.h264Encoder()`, `pickH264Encoder`, `h264VideoArgs`,
    `bitsPerPixel` and `NativeBuildOptions.videoEncoder`.
  - WP-3I's native-graph test now passes an OpenH264 `EncoderChoice` through `output.encoder`.
  - WP-3I's non-encoder change to `derivatives/service.ts` is kept: the peaks generator v2, keyed by the
    container stream index.
  - README and M1-STATUS now describe the merged selector.
  - **Behaviour change vs WP-3I:** when a build has both libopenh264 and libx264, OpenH264 is preferred
    (WP-3L's order). This dev host has no libopenh264, so libx264 is still used here.
- **Waveform stream numbering (semantic, no textual conflict).**
  - WP-3I changed the engine to key peaks by the *container* stream index (`peaks/1.bin` for a movie's
    audio) and bumped the generator version.
  - WP-3V changed the web to map the clip's container index to the audio *ordinal* (`peaks/0.bin`).
  - Together they would have made every movie waveform 404. The WP-3V mapping (`audioOrdinal`) is
    reverted, because the engine now uses the same numbering as `channels.streamIndex`.
  - `timeline-peaks-stream.test.ts` now checks that `peaksFor` fetches `peaks/<streamIndex>.bin`.
- **E2E flake: L/K/J shuttle.** In the first full `pnpm e2e` run the Remotion Player advanced 61 → 62 and
  then stalled.
  - WP-3I's watchdog only covered a Player that never started: it stood down after the first
    `frameupdate`.
  - The watchdog now stays armed for the whole native playback. Its window is 600 ms, or three frame
    periods at slow rates. It allows at most three consecutive kicks without progress, and progress
    restores that budget.
  - The unit test covers a mid-play stall. Two further full E2E runs passed 27/27.
  - The root cause in Remotion 4.0.499 is still unknown.

- **Unit-test flake: `app.test.tsx`.** The first post-merge verify failed once because the Project panel
  breadcrumb sits in a lazily loaded chunk (WP-3I) and was checked with the default 1 s `waitFor`. The test
  now waits for all lazy panels (20 s) before the breadcrumb.

## Verification (this checkout)

- `pnpm verify`: lint, typecheck, 681 tests passed (5 opt-in skipped), build.
- `pnpm e2e:typecheck`: passes.
- `pnpm e2e` (E2E_PORT=48300):
  - Run 1: 22 passed, 1 failed (the JKL flake above), 4 did not run (serial).
  - After the fix: 27/27 passed twice.
- `REMOTION_E2E=1` with `JASPER_E2E_PORT=48310` (the LGPL-only case uses 48311): 2 passed.
- `pnpm mg:build && pnpm e2e:mg-fallback` (MG_CHECK_PORT=48320): PASS.
- `pnpm e2e:desktop` (DESKTOP_SMOKE_PORT=48330, xvfb, ELECTRON_DISABLE_SANDBOX=1): PASS for both
  packaged-like and dev.
  - The packaged-like engine picked its own free port, which does not honour DESKTOP_SMOKE_PORT.

## Still open

The per-WP lists are in `WP-3I.md`, `wp-3l.md`, `wp-3v.md` and `docs/M1-STATUS.md`. Integration-level
items:

- Remotion Player stall root cause (4.0.499) is unknown. The watchdog is a workaround.
- The Remotion compositor ships a GPL/nonfree FFmpeg. This is a packaging blocker (see wp-3l.md, D-13).
- No real OpenH264 or hardware encode has been run on this host.
- WP-3V's editing-lock note is still open: the lock is not released on `pagehide`, so a reload leaves the
  project read-only until "Take over editing".
