# Code ported by the `color-grade` workstream from FilmCraft (Lumetri Scopes, Colour Match, Lumetri details)

- **Upstream:** https://github.com/storytold/filmcraft (commit `771b614ad4c3fbefda5d668ce4384504b8c13f6d`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** color-grade workstream, 2026-10-08

| Upstream path | Our path | What |
|---|---|---|
| `crates/scopes/src/lib.rs` | `packages/project/src/color/scopes.ts` | Scope maths: decimated signal, waveform RGB / Luma / YC / YC no Chroma, parade RGB / YUV / RGB-White, 256-bin histogram with below/above counts, YUV and HLS vectorscopes, colour-bar targets, HLS hue placement (red at the YUV red angle), clamp / unclamped ranges, name parsing (Rust → TypeScript typed arrays; the per-sample closures became monomorphic loops) |
| `crates/scopes/src/summary.rs` | `packages/project/src/color/scopes.ts` (`channelStats`, `traceColumns`, `vectorPeaks`, `readScopes`) | Numeric summaries for agents: per-channel levels in %, trace column levels, densest vectorscope cells (extended with clipping shares) |
| `crates/scopes/src/paint.rs` | `packages/project/src/color/scopes.ts` (`scopeIntensity`, `paintGrids`, `paintVectorscope`) | Log intensity of a cell, additive trace painting, the colourised 3 × 3 vectorscope spread |
| `crates/scopes/src/tests.rs` | `packages/project/test/scopes.test.ts` | Known-value tests (exact bins, ramp rows, colour bars, primaries' cells, HLS angles, YC, decimation, clamp, summaries, paint) |
| `crates/engine/src/scopes.rs` | `apps/engine/src/grading/service.ts`, `apps/mcp/src/tools/grading.ts` (`scopes_read`) | The `scopes.read` command shape (scopes, types, colour space, clamp, columns, peaks, bins) |
| `crates/render/src/color_match.rs` | `packages/project/src/color/match.ts`, `packages/project/test/color-match.test.ts` | Colour Match: Oklab, tonal-range weights, skin weight, statistics, residuals, Levenberg–Marquardt with numerical derivatives through the real Lumetri maths, the 8° skin-hue limit, Gaussian elimination, the three tests |
| `crates/render/src/effects.rs` (`hue_lut`, `apply_look`, `lumetri`, `hsl_secondary`, `median_filter`) | `packages/project/src/color/hue-curves.ts`, `packages/project/src/color/looks.ts`, `packages/project/src/color/lumetri.ts` (Faded Film), `packages/project/src/color/lumetri-spatial.ts`, `packages/project/src/registry/lumetri-spatial.ts` | Periodic hue curves (points repeated one period each side), eight procedural looks, the Faded Film formula, the median Denoise of the HSL key mixed by its amount and the Gaussian key Blur of up to 20 px (Rust → TypeScript and GLSL ES 3.00) |

Notes: the solve runs on our own Lumetri maths (lift/gamma/gain wheels, display-referred), so the solved values
differ from FilmCraft's for the same frames. New here: letterbox bars are cropped before the statistics, face boxes
from the roto face model restrict skin protection to faces (FilmCraft uses the hue test only), Auto tone, the
engine routes, the MCP tools, the web worker and the panel layouts.
