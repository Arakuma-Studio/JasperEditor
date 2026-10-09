# Whole-product verification of `integrate/parity`

Workstream `verify`: every gate, every opt-in suite, every Playwright spec, the MCP scenario QA, the desktop checks, the
CI workflow and a cross-feature smoke run together on the integrated branch, with the root cause of each failure fixed.
Each section gives the command, the result and the fixes. Machine: 12 cores, 47 GB, shared with other agents (load
noted where it matters).

Branch `feat/verify`, starting at `integrate/parity` 4870ea54.

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
(without sidecars) into a gitignored `.media/` that the macro embeds; the assets and their sidecars stay together.

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
