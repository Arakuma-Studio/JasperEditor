# Whole-product verification of `integrate/parity`

Workstream `verify`: every gate, every opt-in suite, every Playwright spec, the MCP scenario QA, the desktop checks, the
CI workflow and a cross-feature smoke run together on the integrated branch, with the root cause of each failure fixed.
Each section gives the command, the result and the fixes. Machine: 12 cores, 47 GB, shared with other agents (load
noted where it matters).

Branch `feat/verify`, starting at `integrate/parity` 4870ea54; merged again at ea17f67d (perf-core), 85a90e3d (ui-perf),
065af535 (gaps), c67a6dfb (review), ee9cb4e2 (polish) and 8bcf5df5 (hardening). Sections 1–8 were run on the way (each
says on which tree where it matters); §9 is the gate after review, **§10 the full re-run on the final merged head**
(polish and hardening), §11 the desktop dev-mode stall.

## 1. Static gates

| Step | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | pass (Biome: 1 info, no errors; tokens, anime, layers, assets ok) |
| Typecheck | `pnpm typecheck` | pass (4 m 38 s) |
| E2E typecheck | `pnpm e2e:typecheck` | pass |
| Notices | `pnpm notices --check` | pass (150 packages, 30 ported records) |
| FFmpeg licence | `pnpm ffmpeg:check` | pass (all artefacts LGPL) |
| Build | `pnpm build` | pass (web chunk-size warnings only) |

## 2. Unit and integration tests

`pnpm vitest run --maxWorkers=2`: 476 files, 4,648 tests; **1 failure** on the first run (31 min):

- `apps/engine/test/time-export.test.ts` › Scene Edit Detection: a false cut at frame 165 of `scenes.mp4`
  (precision 0.8). Deterministic on rerun.
  - **Root cause 1, fixture not reproducible.** `scripts/fixtures/time.mjs` built the dissolve from `cellauto` and
    `gradients` with their defaults: random seed, and for `gradients` random colours and end points (drawn even when
    `seed` is set). Every regeneration made different footage, so the test passed or failed by chance.
  - **Root cause 2, detector weakness inherited from effectcraft.** This instance's gradient was a flat blue whose green
    went 73 → 59 on the last dissolve step, across the 64 edge of the 4×4×4 histogram. Hard bins moved almost every
    pixel to another bin (histogram distance ≈ 0.6), so the step stood out as a cut.
  - **Fix.** Scene signatures use soft (trilinear) bins (`packages/project/src/time-remap/scenes.ts`), which make the
    distance continuous in colour; the frame-165 score dropped from 0.265 to 0.125. Every random source of
    `scenes.mp4` is pinned (two regenerations are byte-identical), using the failing instance's colours. There are
    two new regression tests in `packages/project/test/time-scenes.test.ts`; both fail with hard bins. Before the
    change, 12 random instances of the fixture and the new pinned one all still gave P = R = 1.

## 3. Opt-in suites

Opt-in switches found with `grep -rn "process.env.<X>" … runIf/skipIf` across the repository (gating flags only; the
`*_DUMP`, `*_GALLERY`, `*_OUT`, `SCENE_REPORT` and similar flags only write extra artefacts):

| Flag | Gates |
|---|---|
| `REMOTION_E2E=1` | 31 compositions suites, 14 engine suites, motion render parity, MCP QA render tier |
| `MG_E2E=1` | motion-graphics bundle suites (engine `mg-bundles`, MCP `compositions`) |
| `MG_PARITY=1` | `packages/mg-templates` native jasper-mg comparison (needs `pnpm mg:build`) |
| `SPEECH_E2E=1` | speech model download + transcription (`apps/engine/test/speech-model.e2e.test.ts`, `e2e/speech.spec.ts`) |
| `FUZZ=1` (`FUZZ_SEED`) | 20× fuzz cases; `packages/project/test/fuzz.test.ts` 10,000 runs |
| `JASPER_REQUIRE_ORACLES=1` | a missing ffmpeg/ffprobe fails instead of skipping (CI) |
| `PERF=1`, `NATIVE_ANIM_BENCH=1`, `MB_PERF=1` | exact timing budgets / benchmarks |
| `MCP_QA=1` | the MCP scenario QA (`pnpm qa:mcp`) |
| `FX_GL=0`, `RETIME_GL=0` | opt-*out* of GL suites (they run when a Chrome is found) |

Test ports: the MCP suites default to fixed ports (48145, 48551–48587, 49025–49026, 49443); every run here set them
to this workstream's range (49564–49573) so parallel agents could not collide.

### 3.1 `REMOTION_E2E=1`

| Run | Command | Result |
|---|---|---|
| compositions | `REMOTION_E2E=1 pnpm vitest run --project @jasper/compositions --maxWorkers=2` | 73 files / 660 tests pass, 6 files skipped (gallery-only flags), 41 min |
| engine + motion + MCP | `REMOTION_E2E=1 MG_E2E=1 … pnpm vitest run --project @jasper/engine --project @jasper/motion --project @jasper/mcp --maxWorkers=2` | 1,216 pass, **4 fail** (below) |

Failures and fixes:

- `packages/motion/test/determinism-render.e2e.test.ts`, 3 Player tests: `__parity` undefined. The harness page had no
  `<meta charset>`, so Chrome read the `file://` bundle as Latin-1. `packages/project/src/captions/formats/xml.ts`
  (captions workstream) wrote its XML-name regex with literal `À-￿`, which became an invalid range, so the whole bundle
  failed to evaluate. **Fix:** the regex uses `À-￿` escapes (same set), and the harness declares UTF-8.
  6/6 pass.
- `apps/engine/test/interchange-prerender.e2e.test.ts`, text pre-render: the frame is correct ("Lower third", alpha 255
  on the glyphs, 0 elsewhere; looked at), but the check took the max of a 64×36 area downscale (20×), which for ≈10 px
  strokes cannot exceed ≈60 % coverage (147). **Fix:** the same claim measured at full resolution: corner 0,
  peak > 250, more than 2,000 opaque pixels. Passes.
- `apps/engine/test/blend-static-layer.e2e.test.ts` (new) and the smoke project: see §8, "GL blend modes on static layers".

### 3.2 `FUZZ=1`

`FUZZ=1 pnpm vitest run <every file using describeFuzz / runFuzzTarget / assertFuzzSync> --maxWorkers=2` (11 files,
42 min at load ≈ 45): **25 failures in 4 files**, all fixed. Each fix has a regression test that fails without it.

| Finding | Root cause | Fix |
|---|---|---|
| ffprobe JSON → probe not schema-valid (8 inputs over two runs) | `mapProbe` let a `sample_aspect_ratio` / stream `index` beyond 2^53, a fractional `sample_rate` and a ±1e308 rotation through (degrees mod 360 of a huge float is no multiple of 90) | safe-integer rationals and index, integer sample rate, rotation reduced in quarter turns (`apps/engine/src/media/probe.ts`); pinned in `apps/engine/test/fuzz-regressions.test.ts` |
| project load / repair left INV-001 issues | a `projectId` equal to an item's id: `repairIds` replaced the malformed id *everywhere*, renaming the item too, and the passes ping-ponged | a malformed project id is replaced in place (`packages/project/src/invariants.ts`); `packages/project/test/fuzz-regressions.test.ts` |
| interchange "any document" / ALE → project: 14–29 s per input | `project.importTimeline` (paste machinery) searched the payload and the draft `doc.media` linearly per media: quadratic | indexes in the clipboard `Resolver`; a 3,000-clip ALE bin: **50.8 s → 0.9 s** (same load), budget test in `packages/interchange/test/jasper.test.ts` |
| 21 HTTP routes: `URIError` | the harness's `encodeURIComponent` threw on lone surrogates the mutator made, before any request | harness makes params well-formed (U+FFFD) (`apps/engine/test/fuzz-http.test.ts`) |
| engine fuzz suite: `afterAll` timeout | removing 20× more temp inputs outlasted the 10 s hook timeout under load | 120 s hook timeout |

### 3.3 Other opt-in suites

| Flag | Command | Result |
|---|---|---|
| `MG_PARITY=1` | `pnpm mg:build`, then `MG_PARITY=1 pnpm vitest run packages/mg-templates/test/parity.test.ts` | **`pnpm mg:build` was broken** (below); after the fix 4/4 pass against the freshly built binary; `cargo test --release` in `native/mg` passes |
| `SPEECH_E2E=1` | `SPEECH_E2E=1 pnpm vitest run apps/engine/test/speech-model.e2e.test.ts` (downloads whisper-tiny / tiny.en, 2 × 154 MB) | 5/5 pass |
| `MG_E2E=1` | with the engine/MCP `REMOTION_E2E` run (§3.1) | pass |
| `PERF=1`, `NATIVE_ANIM_BENCH=1`, `MB_PERF=1` | not run strictly: the host was 3–5× oversubscribed by other agents for the whole session (load average 25–65 on 12 cores), so exact budgets would only measure the other agents. The load-scaled budgets run in the normal suite (§2, §7). | — |

**`pnpm mg:build` broken on `integrate/parity` (since the asset-sidecar commit).** `fframes::include_media_dir!`
panics on any file it cannot decode, and `native/mg/crates/jasper-mg-templates/media/` now holds
`Inter_24pt-*.ttf.attribution` sidecars (AGENTS.md §3). **Fix:** a `build.rs` stages the media files of `media/`
(without sidecars) into a gitignored `.media/` that the macro embeds; the assets and their sidecars stay together. *Superseded at
the polish merge:* polish's equivalent `build.rs` (staging into `target/mg-media`, nothing in the source tree) was kept.

## 4. Playwright (all specs)

`node scripts/e2e-prepare.mjs` once (then again after fixes), then chunks with
`E2E_PORT=49560 E2E_SKIP_BUILD=1 pnpm exec playwright test <specs> --reporter=list`; failures rerun alone (a serial
spec is rerun as a whole file: its tests share one page).

| Chunk | Result | Failures → cause → fix |
|---|---|---|
| 1 (agent-ui … captions) | 57 passed | — |
| 2 (clipboard … fixups, compositor) | 35 passed, 2 failed | see below (both reproduced alone, 3/3) |
| 3 | 35 passed | — |
| 4 + 5 (perf-core … ui-audit, `SPEECH_E2E=1`) | 78 passed, 1 failed | `previews` "seek-and-play cycles never stall", see below |

- **`effect-presets` "Save Preset… survives a reload".** After `page.reload()` the editor opened the project
  **read-only** ("open in another session"): the old page's lease release (a keepalive `DELETE` sent on `pagehide`)
  raced the new page's acquire, and the new page did not know the holder was itself. **Fix**
  (`packages/session/src/persistence/engine.ts`): lease session ids of this tab are remembered in `sessionStorage`
  (survives a reload, not shared with other tabs) and a holder from that list is waited for (bounded, like a closing
  session of the same page); a duplicated tab whose original still holds the lease still opens read-only. Two tests in
  `packages/session/test/persistence/engine-store.test.ts` (the reload case fails without the fix). One later run still
  failed with the old page's release not arriving within 3.5 s; 8 further runs passed.
  *Superseded at the polish merge:* polish fixed the same race independently (a tab's own leases are recorded and
  reclaimed at once, `tabLeases`); its version was kept and verify's two regression tests pass against it.
- **`color-mgmt` "Blend using 1.0 gamma".** The spec expected the pre-compositor behaviour (display stage steps aside,
  chip, raw 129.9). The compositor workstream keeps the display transform running (`compositor-player.e2e` asserts no
  chip). Spec updated to that contract with the value computed by the TS colour science:
  `outputTransformFn(working, displaySpaceFor('rec2100-pq'))` maps the linear-light mix 129.9 to **190.3** (encoded
  blending: 69.1); 3/3 pass.
- **`previews` "seek-and-play cycles never stall"** (4/4 failures). Instrumented: on this software-GL host a play's first
  frame after a seek took 0.76–1.2 s while frames came every ≈ 300 ms; the playback watchdog reset its frame-interval
  estimate at every play, so each first frame got the fixed 600 ms window (later `4 ×` the interval) and a healthy slow
  play was "recovered" as a stall. **Fix** (`apps/web/src/panels/program/playback-driver.ts`): the interval is kept
  across plays and a play's first frame gets `8 ×` (≤ 2.5 s); a genuine stall is still kicked (unit test in
  `apps/web/test/transport.test.ts` fails without the fix). 5/5 pass afterwards.

## 5. MCP scenario QA

| Command | Result |
|---|---|
| `MCP_QA_PORT=49572 pnpm qa:mcp` | 7/7 scenarios pass (2 m 55 s) |
| `MCP_QA_PORT=49572 REMOTION_E2E=1 pnpm qa:mcp` (render tier) | 7/7 pass (2 m 52 s) |

## 6. Desktop checks (xvfb)

| Command | Result |
|---|---|
| `DESKTOP_SMOKE_PORT=49576 pnpm e2e:desktop` | packaged-like PASS, dev PASS (screenshots looked at: the Home screen, engine connected), desktop clipboard 4/4 |
| `MG_CHECK_PORT=49574 pnpm e2e:mg-fallback` | PASS (native with jasper-mg; Remotion with a named blocker without it) |
| `pnpm --filter @jasper/desktop dist:dir`, then `PACKAGED_CHECK_PORT=49578 pnpm e2e:packaged` | PASS: the packed app's FFmpeg is LGPL, a Remotion export used only the bundled FFmpeg (OpenH264), PATH ffmpeg never run |

## 7. CI workflow on a clean checkout

`act` is not installed, so the workflow's steps ran as written in a fresh clone of `feat/verify`
(`git clone`, `pnpm install --frozen-lockfile`, no `vendor/`, no `fixtures/media/`), with the workflow's environment
(`JASPER_REQUIRE_ORACLES=1`, `JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome`, `JASPER_TEST_RESULTS`) and the
apt FFmpeg 6.1.1 (libx264, no OpenH264) as the oracle — exactly what the runner has. Steps: `pnpm lint`,
`pnpm typecheck`, `pnpm test --maxWorkers=2`, `pnpm build` (`/tmp/verify-logs/ci-run.sh`).

**First run: lint and typecheck pass, `pnpm test` fails (12 tests, 7 files).** None of them shows in a developer
checkout (fixtures present, the LGPL FFmpeg in `vendor/`), so the CI workflow could never have passed:

| Failure | Cause | Fix |
|---|---|---|
| fixture generation crashed (`ENOTEMPTY` renaming `imports-seq`), `native-animated` / `cache` suites failed | many test files spawn `scripts/make-fixtures.mjs` at once on a clean checkout; concurrent runs made every fixture twice, replaced files under readers and collided on the directory fixture | a cross-process lock (pid, stale-lock takeover) serialises the generators; waiters then skip; checked with three concurrent runs on an empty `fixtures/media` |
| `mcp grading` (2), `mcp roto` (1): `BINARY_MISSING` | the tests start a built-mode engine, which refuses Remotion without the LGPL FFmpeg folder (correct, D-13); CI has none | run a dev engine (`JASPER_DEV=1`), as `compositions.test` and the QA harness already do |
| `engine color-mgmt` (7): `TypeError … null` | the test hard-coded `vendor/ffmpeg-lgpl/…/ffprobe` | vendor build when present, else `JASPER_FFMPEG` / PATH (`@jasper/testkit/oracle`) like the other tests |
| `engine previews` (1): "not all I-frames" | ffprobe's CSV output puts x264's SEI side data on the first frame's line; the frames were all I | picture types read as JSON through `@jasper/testkit/oracle` |
| `engine smart-render` (1): 52 of 54 frames | encoded pieces are joined with copied GOPs as one raw Annex B stream (no timestamps); libx264 pieces with B-frames lost frames there — a real bug for every B-frame encoder (NVENC, QSV, VideoToolbox, AMF, VAAPI) | smart-render pieces are encoded with `-bf 0` (`EncodeParams.noBFrames`); unit test in `encoders.test.ts`; 5/5 with libx264 and OpenH264 |

**Second run, after merging ui-perf and gaps (`integrate/parity` 065af535):** the fixes above held; 10 new failures in
5 files, all in tests that arrived with the merge or share their pattern:

| Failure | Cause | Fix |
|---|---|---|
| `gaps-export-frame` (7), `gaps-export-formats` (2), `gaps-project-manager` (1), `gaps-audio-channels` (suite) | hard-coded `vendor/ffmpeg-lgpl/linux-x64/ffmpeg` / `ffprobe` | shared `TEST_FFMPEG` / `TEST_FFPROBE` in `apps/engine/test/helpers.ts` (vendor when present, else the oracle tools) |
| `cache.test.ts` (suite; also in the first run), same pattern in `gaps-routes`, `cache-location` | `beforeAll(() => ensureFixtures())` with the default 10 s hook timeout, while a clean checkout generates fixtures for minutes | 900 s hook timeout |

The seven files then pass in the clone (41 tests, apt FFmpeg). The runs on later heads are in §9 and §10.

## 8. Cross-feature smoke (MCP against a dev engine on 49561)

Driven through `jasper-mcp` (stdio, `--appdir .stage/verify`) by small scripts. Project "verify-cross-feature", 720p30,
6 s:

| Track | Content | Features |
|---|---|---|
| V1 | `Nested Multicam` nest of a multi-camera source (clip-a 1080p30, xfade-red 720p30) cut 1 → 2 → 1 at 2 s / 4 s | multicam create + record cuts, nest |
| V2 | clip-b (720p**25**), Time Remapping (speed key at 1 s, 50 % after), ellipse mask, Hard Light | time remap, masks, CSS blend |
| V3 | vector star, Color Dodge | vector shapes, GPU-composited blend |
| V4 | adjustment layer: Lumetri (exposure, contrast, temperature) + HSL secondary (hue key, saturation 160) | adjustment layer, Lumetri, HSL secondary |
| V5 | "CROSS FEATURE", text animator `fade-in`, opacity expression `50 + 50 * Math.sin(time * 3)` | text animators, expressions |
| V6 / V7 | "3D" text as a 3D layer (rotation Y 35°, Z −200) + a 35 mm camera | 3D layer, camera |
| C1 | two captions | captions |
| A2 / A3 | voice-hum (1–4 s), music-beat with Dynamics (compressor), auto-ducked by the voice (−12 dB, 4 keys) | audio effects, ducking |
| sequence | loudness normalisation to −16 LUFS / −1 dBTP | loudness |

Results (frames looked at; numbers measured with ffprobe / ffmpeg `ebur128`, `ssim`, `psnr`):

- **Preview** (`render_frame`): every layer as expected; the 3D layer is a perspective trapezoid (scene corners from
  `get_3d_scene`, visible in a 1280 px crop); Hard Light / Color Dodge are invisible over identical / saturated bars
  and visible over camera 2's red, as the formulas say.
- **Native**: refused with named blockers (Lumetri spatial secondary, 3D layer) — AGENTS §4. A duplicate without those
  two exports through the **hybrid** path (natively composited, text / shapes / captions baked) in 35–48 s; against
  the Remotion export of the same sequence: SSIM 0.988 overall, worst frame 0.979 (edges and a 1 px column inside
  the feathered mask; difference image looked at).
- **Remotion / auto**: H.264 1280×720 30 fps, 180 frames, AAC 48 kHz stereo, 6.000 s; integrated **−16.0 LUFS**,
  LRA 4.3 LU (normalisation gain −4.9 dB). The title opacity follows the expression (≈100 % at 0.5 / 2.5 / 4.5 s, ≈0
  at 1.5 / 3.5 / 5.5 s), multicam cuts at 2 s / 4 s, captions at their times.
- **Render previews**: 4 segments green; **export using previews + smart render**: 3 s instead of 424 s, SSIM 0.993 /
  PSNR 42.6 dB against the full render (one more H.264 generation), same loudness.
- **Interchange**: FCP7 XML (6 pre-renders: masked clip, shape, animated text, 3D, 2 captions; the report names the
  colour-dodge blend, the adjustment layer, 12 Lumetri parameters and the camera it cannot carry) and OTIO (metadata
  round trip) exported and **re-imported into the same project**.

Bugs the smoke found, all fixed with regression tests:

1. **MCP tools refused to work in any project with a nest or multicam.** Tools document "`sequenceId`: default the
   project's first sequence" but forwarded nothing; the command system refuses sequence-scoped commands without one
   when the project has several sequences (`add_text`, `add_marker`, `record_multicam_cuts`, `render_frame`, …).
   `apps/mcp/src/context.ts`: a refusal for exactly that reason is retried once with the first sequence (approval
   transactions resolve it first); `captureStill` defaults to the first sequence. `apps/mcp/test/default-sequence.test.ts`
   (the fake engines of the existing tests injected a sequenceId, hiding it).
2. **GL blend modes on static DOM layers hung Remotion renders** ("Blend modes at frame 6"): the composite hub's layer
   tap was keyed by the clip, so a text / shape whose picture does not change delivered only on each page's first
   frame. Keyed per frame (as the 3D scope already was). `apps/engine/test/blend-static-layer.e2e.test.ts` (fails with
   the exact error before).
3. **Worker pools hung the job forever when a worker died** (dev engine: eval'd worker sources contained esbuild's
   `__name`, every blend worker died at start, `render_frame` stayed "running"). Dead workers now fail the pool
   (blend, layer streams, warp, optical flow) and worker sources define `__name`. `apps/engine/test/worker-pools.test.ts`.
4. **OTIO re-import into its own project / Ctrl+K on an animated title**: `INV-001 Duplicate id tan_…` — copies of a
   clip re-identified effects, keyframes, masks… but not text animators / selectors nor Puppet meshes / pins.
   `packages/project/test/reidentify-children.test.ts`, `packages/interchange/test/jasper.test.ts`.
5. **Remotion renders of heavy compositions timed out under load** (frame extraction / first mount > 60 s with 6 pages;
   one page renders a still of this project in 25 s at load 30): exports, short ranges and previews failed. A
   multi-page render that times out is rendered once more on one page before failing (`withSinglePageRetry`,
   `apps/engine/test/remotion-retry.test.ts`). Afterwards all of them succeed.
6. **Remapped / retimed clips rendered one frame early in Remotion** (and the Program monitor) against the native export:
   the retime decoder took the AAC priming timestamp (−0.0213 s) as the file origin. Origin = ffmpeg's start_time;
   native vs Remotion SSIM 0.961 → 0.992. New fixture `frame-code-aac.mp4` and a browser test in
   `packages/compositions/test/retime-frames.test.ts`.
7. `get_timeline` reported a remapped clip's source as `sourceIn + duration` ("0–11 s" of 6 s media): now the media
   range its frames show. `apps/mcp/test/format.test.ts`.

## 9. Gate after the review merge

Last merge: `integrate/parity` **c67a6dfb** (perf-core, ui-perf, gaps and review landed during the work). One merge
follow-up: review's DATA-7 fix and §8's re-identification fix had landed separately, so the duplicate loop was
dropped (both regression tests kept).

Two more findings on the merged head, fixed:

- `packages/expressions/test/sandbox.test.ts` "an expression that exhausted the heap is not run again" failed 4/4 at
  load ≈ 25: the 2 s wall clock stopped the heap-filling loop (≈ 2.3 s) before the memory limit, and the quarantine
  only took expressions that ran past **twice** the limit, so the hostile expression ran again every frame. Now an
  expression that fails after blocking for the limit or longer is quarantined too (`runtime.ts`; note added to
  `docs/security-review.md` EXPR-2); the test accepts whichever guard fires. *Superseded at the hardening merge:* hardening quarantines an
  expression that hits any resource limit (EXPR-2); its runtime and test were kept.
- `apps/web/test/shell-render.test.tsx` timed out (default 5 s) on the loaded CI run: it mounts the whole editor;
  suite timeout 60 s (its assertions wait on conditions).

| Gate | Command | Result |
|---|---|---|
| Lint, typecheck, e2e typecheck, notices, ffmpeg licence | `pnpm lint`, `pnpm typecheck`, `pnpm e2e:typecheck`, `pnpm notices --check`, `pnpm ffmpeg:check` | pass |
| Every vitest suite with every opt-in | `REMOTION_E2E=1 MG_E2E=1 MG_PARITY=1 SPEECH_E2E=1 pnpm vitest run --maxWorkers=2` (MCP ports 49650–49659) | 514 files / 4,812 tests pass, 1 failure = the sandbox test above (fixed, 18/18 and the package's 75/75 after); 106 min |
| All Playwright specs (53 files) | `SPEECH_E2E=1 E2E_PORT=49560 E2E_SKIP_BUILD=1 pnpm exec playwright test` | 214 passed, 5 failed, 6 did not run (serial followers), 1.2 h at load 42–65; **each failed file rerun alone passes**: project-files 2/2, color-mgmt 3/3, compositor 4/4, previews 3/3, ui-perf 4/4. The failures were 3-minute export timeouts, a playback stall and a UI frame budget under 4–5× oversubscription |
| CI workflow, clean clone | `/tmp/verify-logs/ci-run.sh` (§7) on the final head | **pass**: lint, typecheck, `pnpm test` 471 files / 4,512 tests (0 failures, JASPER_REQUIRE_ORACLES=1, apt FFmpeg), build (head 6ee6f517) |

On the previous head (065af535, before review) the clean-clone CI passed in full (lint, typecheck,
`pnpm test` 464 files / 4,450 tests, build) and the full Playwright suite passed 223/223.

## 10. Full re-run on the final merged head (polish and hardening)

`integrate/parity` 8bcf5df5 (polish ee9cb4e2 and hardening 8bcf5df5) merged into `feat/verify`. Conflicts:

- polish's lease engine and `jasper-mg-templates` `build.rs`: polish's version taken.
- hardening's expression runtime, `sandbox.test.ts` and `security-review.md`: hardening's version taken.

Each of these supersedes an equivalent verify fix (§3, §4, §9); verify's regression tests pass against them. Then the
desktop stall fix (§11). Every tier was run again on the head that includes it.

| Gate | Command | Result |
|---|---|---|
| Static gates | `pnpm lint`, `pnpm typecheck`, `pnpm e2e:typecheck`, `pnpm notices --check`, `pnpm ffmpeg:check`, `pnpm build` | pass |
| Every vitest suite with every opt-in | `REMOTION_E2E=1 MG_E2E=1 MG_PARITY=1 SPEECH_E2E=1 JASPER_REQUIRE_ORACLES=1 pnpm vitest run --maxWorkers=2` (MCP ports 49650–49659) | 540 files / 5,437 tests: 5,326 pass, 110 skipped by their own gates, **1 failure**, fixed (below); 85 min at load 10–19 |
| `FUZZ=1` | `FUZZ=1 pnpm vitest run --maxWorkers=2` on the 7 files that read it | 7 files, 372 pass (48 skipped by their own gates) |
| All Playwright specs (54 files) | `SPEECH_E2E=1 E2E_PORT=49560 E2E_SKIP_BUILD=1 pnpm exec playwright test` | **234/234 pass** (34.7 min), first run, no reruns; including `effect-presets` "survives a reload" and polish's bundle-failure spec with the automatic reloads |
| MCP scenario QA | `MCP_QA_PORT=49662 pnpm qa:mcp`, then with `REMOTION_E2E=1` | 7/7 and 7/7 (82 s, 81 s) |
| Desktop | `DESKTOP_SMOKE_PORT=49600 pnpm e2e:desktop` | packaged-like PASS, dev PASS (warm-up 1,183 modules in 8 s, 7 s to Home; screenshot looked at: Home, engine connected), clipboard 4/4 |
| | `MG_CHECK_PORT=49574 pnpm e2e:mg-fallback` | PASS (native with jasper-mg; a named blocker and Remotion without it) |
| | `pnpm --filter @jasper/desktop dist:dir`, then `PACKAGED_CHECK_PORT=49578 pnpm e2e:packaged` | PASS (bundled LGPL FFmpeg n7.1.5, a Remotion export with OpenH264, no PATH ffmpeg used) |
| CI workflow, clean clone | `/tmp/verify-logs/ci-run.sh` (§7) | CI_ROW |

Findings on this head, fixed:

- `apps/engine/test/blend-static-layer.e2e.test.ts` (verify's own, §8 #2): 401 "Missing or invalid engine token".
  hardening gave every engine a token and marked the engine-driving tests `insecure: true`; this test was not on
  `integrate/parity` yet, so it did not get the change. It now uses the same option; it passes.
- Clean-clone CI: `packages/audio-dsp` "Tech 3342 loudness range" timed out at vitest's default 5 s at load ≈ 15.
  Alone it takes 2.4 s at load 14: it measures minutes of 48 kHz audio. The package was the only DSP package
  without a test timeout; it now has 60 s, like `project`, with `audio-fx` and `interchange` at 120 s. The assertions
  are unchanged.

**Cross-feature smoke on the merged code.** The §8 project was reopened by an engine built from this head. The dev
engine now has a token; `jasper-mcp --appdir` found it through the runtime file. Every result was rendered again:

- **Stills** (`render_frame` at frames 80 and 95): same picture as before (looked at).
- **Render Previews**: 4 of 4 segments red → green (415 s at load ≈ 16).
- **Export `auto`**: the Remotion path, naming why (Lumetri spatial secondary, 3D layer). H.264 1280×720 30 fps,
  180 frames, AAC 48 kHz stereo, 6.000 s, **−16.0 LUFS**, LRA 4.3 LU. A contact sheet at 0.5–5.5 s was looked at:
  - the title opacity follows the expression;
  - multicam cuts at 2 s and 4 s;
  - both captions.
- **Previews + smart render**: 3 s, SSIM 0.993 / PSNR 42.6 dB against the full render, the same loudness.
- **Hybrid against Remotion** (the variant without Lumetri and 3D): SSIM 0.988, worst frame 0.979. Identical to
  before the merges.
- **FCP7 XML**: the same 6 pre-renders and the same not-carried report. **OTIO**: 5 not-carried entries. Both
  re-imported into the same project.
  - The destination never overwrites: with `timeline.xml`'s media folder left from an earlier run, the files were
    written as `timeline (2).xml` and `timeline (N).otio`, and the job result names them.
- **hardening's agent gate**, checked from the same MCP client:
  - `sequence.delete` with no editor window open is refused with `E_APPROVAL_DENIED` ("headless mode rejects
    destructive transactions").
  - `delete_clips` is applied: an undoable edit, not one of the gated commands (`APPROVAL_COMMANDS`).

## 11. Desktop dev-mode smoke stalled on a cold Vite

hardening saw `node e2e/desktop-smoke.mjs dev` fail twice before passing on the third try. It did not reproduce at
normal load. It reproduces at will with the whole run pinned to one CPU next to three busy loops
(`taskset -c 3`, i.e. a quarter of a core) and a cold Vite (`apps/web/node_modules/.vite` removed).

**What the window showed.** polish's start-up message "JasperEditor could not load. Check your connection and
reload." The window had requested a few hundred of the ≈ 1,200 modules of a cold dev load. Every request in flight
had failed at once with **`net::ERR_NETWORK_CHANGED`**, so the entry module failed and nothing ever ran.

**Root cause.** Chromium aborts every request in flight, loopback included, when its address tracker reports that the
host's IP addresses changed. A Chromium net log (`--log-net-log`) of a failing run shows `NETWORK_IP_ADDRESSES_CHANGED`
→ `NETWORK_CHANGED` 10, 77 and 87 s after the window opened. The source is the host, not the app: `ip monitor
address` sees Docker `veth*` interfaces come and go, often several per minute, as other agents' containers start and
stop. Chromium on Linux counts every interface.

A warm load takes a few seconds and is rarely hit. A cold dev load is Vite transforming each module on demand, and on a
loaded machine it takes 1–2 minutes, so it is almost always hit. The page then showed the failure message for good: it
cannot know the failure was transient.

| Fix | Where |
|---|---|
| **The page reloads itself before giving up.** A load that failed **quickly** (the server is down or broken) is retried 3 times (backoff 0.3–0.9 s) before the message. A load that failed after **8 s** was making progress and was cut off; it counts only toward a cap of **8 reloads** per tab, and each reload is faster than the last (transforms and browser cache warm). The count (`sessionStorage`) is cleared once the app renders, and by the message's Reload button. The same applies to the built app and the PWA (a network change during a slow first load). | `apps/web/editor-boot.ts`; unit test in `apps/web/test/polish-open.test.tsx` (quick and slow budgets, the cap, reset on boot, a broken stored value); `e2e/polish.spec.ts` now also asserts the automatic reloads before the message |
| **Vite warms the app graph at start** (`server.warmup.clientFiles`: `index.html`, `src/main.tsx`), so the first page asks for transforms that are done or under way, not queued behind it. | `apps/web/vite.config.ts` |
| **The smoke warms the dev server from Node** before opening the window. It loads the static module graph as a first browser visit would; Node's `fetch` is not subject to Chromium's network-change aborts. It also waits for Home to settle (the project list, the empty state or an error) before the screenshot: a starved run had passed the "home visible" check on the "Loading projects…" placeholder. | `e2e/desktop-smoke.mjs` (`warmViteGraph`) |

Measured, `DESKTOP_SMOKE_PORT=49600`:

| Condition | Before | Boot retry only (3, fixed count) | Boot retry (quick 3 / slow 8) | All three fixes |
|---|---|---|---|---|
| normal load, warm Vite | pass, 1 load, 5–13 s | — | — | pass, 1 load, 5–9 s (warm-up 5–6 s, 1,183 modules) |
| ¼ core, cold Vite | fail: "could not load" | 2 of 3 pass (2–3 loads, ≈ 120 s); 1 fails after its retries | fail after 6 loads (every load cut off) | **3 of 3 pass, 1 load each** (warm-up 64–66 s) |

The app-level reloads are what users get (a network change during a slow first load no longer leaves a dead page). The
warm-up keeps the smoke testing the desktop shell rather than the race with the host's interfaces. Under extreme
starvation and constant interface churn, a cold load without the warm-up can still run out of its 8 reloads and then
shows the message with its Reload button, never a blank page.

## Not done or caveated

- `PERF=1` / `NATIVE_ANIM_BENCH` / `MB_PERF` strict benchmarks were not run: the host was 3–5× oversubscribed
  throughout, so the numbers would measure other agents.
- `act` is not installed; the workflow was simulated step by step in a clean clone with the runner's apt FFmpeg (§7).
  GitHub's runner itself (Ubuntu 24.04 image, its Chrome) was not exercised.
- The hybrid vs Remotion comparison of the cross-feature variant is SSIM 0.988 overall, worst frame 0.979, just under
  the 0.98 the repo's parity tests use for simpler scenes; the residual is anti-aliasing at edges, a 1 px column inside
  a feathered mask and H.264 loss (difference image looked at), not a feature difference.
- The reload lease race (§4): verify's bounded wait left a window (the old page's release never arriving) that
  polish's reclaim of the tab's own leases closes; `effect-presets` "survives a reload" passes on the merged head.
- The desktop dev-mode stall (§11) comes from the host: Chromium aborts loads whenever an interface appears or goes.
  The page now reloads itself (8 at most), and the smoke warms Vite first. A cold, very slow load with constant
  interface churn can still run out of reloads; it then shows the message and its Reload button, never a blank page.
  No supported Electron or Chromium setting to ignore such interfaces was found, so none is used.
- Remotion renders of heavy compositions on a loaded software-GL host now retry once on a single page (§8 #5); on a
  real GPU machine the first attempt should succeed, but this was not measured here (no GPU).
