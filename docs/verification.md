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
