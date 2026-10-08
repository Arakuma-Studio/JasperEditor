# Ported code: golden-frame harness, fuzzing and oracles (wp `golden-fuzz`)

Licence of the ported code: **MIT OR Apache-2.0** (we use it under MIT).

## FilmCraft — https://github.com/storytold/filmcraft

Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors

| Upstream | Ours | What |
|---|---|---|
| `crates/testkit/src/golden.rs` | `packages/testkit/src/golden.ts` | Golden-image checks: `Diff` (max, mean, p99 of the per-pixel max channel difference, PSNR, differing pixels), `Tolerance` (`EXACT`, `RENDER` = PSNR ≥ 45 dB / max ≤ 12 / p99 ≤ 2), bless mode, size cap on bless, actual + ×8 difference images on failure, attribution sidecar on bless |
| `crates/testkit/src/golden.rs` (PNG I/O) | `packages/testkit/src/png.ts` | RGB-when-opaque encoding, decode of gray/RGB/RGBA/palette PNGs to RGBA8 (rewritten on node:zlib, with filters, Adam7, 16-bit and CRC checks) |
| `crates/testkit/src/oracle.rs`, `crates/testkit/src/lib.rs` | `packages/testkit/src/oracle.ts` | ffmpeg / ffprobe discovery (explicit env path, PATH, well-known directories), `SKIPPED (…)` reporting and the require-oracles switch that turns skips into failures |
| `crates/golden/tests/golden.rs` (`scenes_are_distinct`) | `packages/testkit/src/golden.ts` (`assertDistinctScenes`) | Guard against blank or duplicated golden scenes |
| `crates/render/src/transitions/tests.rs` (golden fingerprints) | `packages/testkit/src/image.ts` (`meanGrid`), `packages/testkit/src/golden.ts` (`expectFingerprints`), `packages/compositions/test/transition-gl/entry.ts` (`fingerprints`) | 4×4 mean-RGB fingerprints at p = 0.25 / 0.5 / 0.75 with ±4 levels |
| `crates/isobmff/tests/fuzz.rs` | `packages/testkit/src/fuzz.ts` | Deterministic mutation fuzzing: seeded xorshift, bit flips, random bytes, extreme 32-bit field overwrites, truncations, span edits; "never panic" becomes "never an untyped throw" |
| `docs/testing.md` | `docs/testing.md` | Structure of the testing guide (kinds of tests, oracle rules, golden-image workflow) |

## EffectCraft — https://github.com/storytold/effectcraft

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors

| Upstream | Ours | What |
|---|---|---|
| `crates/gpu/src/context.rs` (`scratch`: NaN-filled under test) | `packages/compositions/src/fx/host.ts` (`poison`) | Pooled GPU scratch targets poisoned in tests (NaN in float targets, magenta in 8-bit ones) so kernels that skip pixels fail |
| `crates/gpu/src/tests.rs` (`diff`: a NaN on one side is the largest difference) | `packages/testkit/src/golden.ts` (`expectFingerprints`) | NaN-aware comparisons |
| `docs/architecture.md` §7 (`bench --ops`, `engine::perf::large_project`) | `packages/project/bench/scale-project.ts`, `packages/session/bench/scale.ts` | Everyday-operations benchmark on a large generated project (200 sequences / ~5,000 clips) |
