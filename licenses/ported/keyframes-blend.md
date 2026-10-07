# Blend-mode formulas, Dissolve noise, Bezier ease inverse, roving and Auto Bezier rules (keyframes-blend)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** keyframes-blend, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/color/src/blend.rs` | `packages/project/src/blend-modes.ts` | `blend_pixel`, separable / non-separable formulas, HDR mode set → TypeScript (`makeBlendKernel`, `blendPixel`) |
| `crates/gpu/src/shaders/common.wgsl` | `packages/project/src/registry/fx/glsl/blend.ts` | `blend_pixel`, `hash_noise` → GLSL ES 3.00 (`fx_layerBlend`, `fx_blendNoise`) |
| `crates/raster/src/lib.rs` (`hash_noise`) | `packages/project/src/blend-modes.ts` | Dissolve's integer hash (`dissolveNoise`) |
| `crates/keyframe/src/lib.rs` | `packages/project/src/keyframes.ts` | closed-form inverse of the 100 % / 100 % ease time curve (`solve_u`); influences not normalised (`ease_progress`); roving run idea (`retime_roving`) |
| `crates/keyframe/src/lib.rs` | `packages/project/src/keyframes-spatial.ts` | proportional Auto Bezier spatial tangents (`auto_spatial`) |
| `crates/keyframe/src/lib.rs` (tests) | `packages/project/test/keyframes-ease-precision.test.ts` | live After Effects samples of overlapping influences used as test oracles |

Notes: the blend formulas are a straight port, plus an 8-bit-grid tie rule for Hard Mix and a luminance tie for
Darker / Lighter Color so GPU and CPU agree. The ease solver adds a double-double midpoint expansion and a
bisection-safeguarded Newton with a step criterion. Roving runs are evaluated as one eased segment (EffectCraft spaces
roving keys for constant speed only). Dancing Dissolve, the Classic modes and Luminescent Premul are not ported
(not in Premiere's menu).
