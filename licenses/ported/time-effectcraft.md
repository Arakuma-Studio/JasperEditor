# Optical flow, frame interpolation and cut detection (workstream time)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** workstream `time`, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/raster/src/flow.rs` | `packages/project/src/time-remap/flow.ts` | hierarchical block matching (luma pyramid, SAD search ±4 then ±1 around the doubled vectors of the tile and its neighbours, short-vector tie bias), sub-pixel parabola, 3×3 component-wise vector median, bilinear field sampling, frame mix — TypeScript |
| `crates/raster/src/flow.rs` | `packages/compositions/src/retime/flow-gl.ts` | the same block matcher, parabola and median as WebGL2 fragment shaders (GLSL ES 3.00) |
| `crates/raster/src/cuts.rs` | `packages/project/src/time-remap/scenes.ts` | frame signature (4×4×4 joint RGB histogram + 96 px luma thumbnail), dissimilarity = √(half-L1 histogram distance × motion-compensated luma error ×4), adaptive median peak test, minimum shot length — TypeScript |
| `crates/render/src/lib.rs` (`frame_position`, `blend_frames`) | `packages/project/src/time-remap/sampling.ts` | frame and fraction at a media time (Frame Mix / Pixel Motion choice) |

Notes: the interpolation is our own (not effectcraft's single-field cross-fade): both flow directions, ten motion
hypotheses per pixel checked against the flow at both ends, occlusion-aware weights. The analysis picture is
normalised to ≤ 1024 px. Cut detection adds a sensitivity (0…100) and a flash test.
