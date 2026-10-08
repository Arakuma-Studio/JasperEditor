# Code ported by the `color-grade` workstream from EffectCraft (Lumetri HSL Secondary, vignette, hue curves)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14f09bb064cab8f1f8fe85af601a08b6e53`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** color-grade workstream, 2026-10-08

| Upstream path | Our path | What |
|---|---|---|
| `crates/effects/src/color3.rs` (`HslKey`) | `packages/project/src/color/lumetri-spatial.ts` (`secondaryKey`), `packages/project/src/registry/lumetri-spatial.ts` (`lm_key`) | The HSL Secondary key: hue centre / range / softness with grey attenuation, saturation and lightness bands with soft edges (TypeScript and GLSL ES 3.00) |
| `crates/effects/src/color3.rs` (`lumetri`: secondary correction, vignette, sharpen, tint balance) | `packages/project/src/color/lumetri-spatial.ts`, `packages/project/src/registry/lumetri-spatial.ts`, `packages/project/src/color/lumetri.ts` | Correction inside the key (temperature / tint gains, contrast, saturation), the Show Mask styles, the vignette shape (roundness, midpoint, feather), the luma unsharp sharpen, the tint-balance pivot |
| `crates/effects/src/color3.rs` (`OffsetCurve`) | `packages/project/src/color/hue-curves.ts` | Hue/saturation curves as offsets from a neutral 0.5 with chroma attenuation of greys |

Notes: our Lumetri keeps its own S06 maths for the pre-existing steps; the ported parts are rewritten to our param
names and ranges. The pointwise steps bake into the colour run's LUT, the spatial ones run as a GPU stage.
