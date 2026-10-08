# Colour science: camera log curves, gamuts, colour-managed transforms, HDR grading signal, LUT files

- **Upstream:** https://github.com/storytold/filmcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** color-mgmt, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/color/src/log.rs` | `packages/project/src/color/cms/log.ts` | S-Log3, V-Log, Canon Log 2/3, LogC3, LogC4, Apple Log, D-Log encode/decode, signal domains, reference-point tests |
| `crates/color/src/spaces.rs` | `packages/project/src/color/cms/gamut.ts`, `spaces.ts`, `matrix.ts` | gamut primaries, normalised primary matrix (RP 177), colour space catalogue, tag detection |
| `crates/color/src/transform.rs` | `packages/project/src/color/cms/transform.ts`, `hdr.ts` | input/output transforms, BT.2390 EETF tone mapping, desaturation into gamut, HLG OOTF |
| `crates/color/src/grade.rs` | `packages/project/src/color/cms/transform.ts` (`gradeSpace`) | Lumetri grading signal normalised to HDR White (PQ / HLG) |
| `crates/color/src/lib.rs` | `packages/project/src/color/cms/transfer.ts`, `hdr.ts` | PQ / HLG / sRGB functions, HDR static metadata peak |
| `crates/color/src/lut.rs` | `packages/project/src/color/lut.ts`, `lut-formats.ts` | `.cube` 1D + 3D shaper semantics, `.3dl` reader/writer (blue fastest, non-uniform mesh shaper), brute-force tetrahedral test |
| `crates/render/src/effects.rs` (`lumetri`, HDR specular) | `packages/project/src/registry/color-effects.ts` (`lumetriHdrFn`) | HDR Specular above HDR White |

Notes: ported to TypeScript (f64). Added here, not in FilmCraft: S-Log/S-Log2, Canon Log, RED Log3G10/RWG, Blackmagic
Film Gen 5 / Wide Gamut, DaVinci Intermediate/Wide Gamut, F-Log/F-Log2, N-Log, Cineon, ACEScc/cct, Bradford adaptation,
the per-channel ACES RGC 1.0 parameters, the scene-referred OOTF (BT.2408 grey), P3/sRGB working spaces, `.spi1d`,
`.spi3d`, `.csp`.
