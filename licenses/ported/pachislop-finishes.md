# Pachislop: title finishes, materials and motifs

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks finishes, 2026-11-02; the rotation undo by title-looks core polish, 2026-11-03

| Upstream path | Local path | What |
|---|---|---|
| `src/engine/layer2d/shaders.ts` (`HEIGHT_FRAG`, `COVER_INIT_FRAG`, `COVER_JFA_FRAG`, `COVER_RADIUS_FRAG`) | `packages/project/src/registry/fx/glsl/title-relief.ts` | Height field through a bevel profile; Fit: inscribed-circle flood for the local half-thickness, tube across a rim's band |
| `src/engine/layer2d/materialPass.ts` (`updateHeight`, `updateCover`, `updateSatin`, the light and bevel terms of `shade`) | `packages/project/src/registry/fx/glsl/title-relief.ts`, `finishes/bevel.ts`, `finishes/satin.ts` | Order of the passes, slope from the height, highlight screen and shadow multiply, satin from two shifted blurred silhouettes |
| `src/engine/layer2d/shaders.ts` (`ELEMENT_FRAG`: glass body, reflection colorize, gradient-map ramp, sheen, gloss cap, texture blends) | `finishes/glass.ts`, `finishes/reflection.ts`, `finishes/gradient-map.ts`, `layers/sheen.ts`, `finishes/gloss.ts`, `layers/gloss.ts`, `layers/texture.ts` | Formulas of each material term, re-expressed on `TlSurface` in linear light |
| `src/engine/layer2d/shaders.ts` (`ERODE_FRAG`) | `packages/project/src/registry/fx/title-look/layers/texture.ts` | Dry-brush erosion: bristle lanes along a drag, ink lost from the silhouette, stray bristles, skips |
| `src/engine/layer2d/shaders.ts` (`NEAREST_GLYPH_FRAG`, the seam logic of `ELEMENT_FRAG`) | `packages/project/src/registry/fx/title-look/spans.ts` | Nearest glyph per pixel and the antialiased seam between two glyphs |
| `src/engine/layer2d/contours.ts` (`curveFn`) | `packages/project/src/registry/fx/glsl/title-relief.ts` (`curveLut`) | Monotone cubic Hermite curve baked to a 256-entry table |
| `src/engine/layer2d/reflectionMaps.ts` | `packages/project/src/registry/fx/glsl/title-env.ts` | Layout of a reflection panorama (row 0 the zenith, centre column where a flat face mirrors the view) and the blur scale; the maps themselves are not ported: ours are procedural |
| `src/engine/patterns.ts` | `packages/project/src/registry/fx/glsl/title-pattern.ts` | Every motif's signed distance and its analytic antialiasing |
| `src/engine/patterns.ts` (mark heights), `src/engine/layer2d/materialPass.ts` (the pattern step) | `packages/project/src/registry/fx/title-look/finishes/pattern.ts` | The pattern over the paint in two colours, and raised marks 6 % of a motif tall at full relief |
| `src/effects/b/material.ts` (`chrome`: a Fit bevel domed to the centre, mirroring an environment) | `packages/project/src/registry/fx/title-look/finishes/metal.ts` | The domed surface of a metal over each stroke (Fit on by default) |
| `src/effects/b/material.ts` | `packages/project/src/registry/fx/title-look/material.ts` | A material as an effect on the input's alpha, with the shading of a title's face |
| `src/text/plate.ts` | `packages/project/src/registry/fx/title-look/layers/plate.ts` | Plate kinds and the leaning box with cut corners; here distances on the GPU instead of polygons |
| `src/engine/layer2d/materialPass.ts` (`layerAngle`, `screenAngle`, `uReflM`) | `packages/project/src/registry/fx/title-look/plan.ts` (`lookOrientation`, `titleLookUniforms`), `glsl.ts` (`GLSL_TL_STAGE`) | Lights fixed on screen: the layer's rotation and flip undone for the light, and the reflection's directions taken back to the screen |

## Changes made when porting

- The input is any alpha at any frame, not per-element masks from vector outlines: heights, plates and erosion start from
  the look's shape field (`TlSurface`), and a hull is a support function over blocks of ink instead of Andrew's chain.
- Every size is a percentage of the look's unit. The original clamps blurs (`min(32, …)`) and floors them in pixels; ours
  scale with the unit and run at the resolution that holds the sigma, so 200 % draws what 100 % drew (TL-034).
- Float hashes are gone: motifs and textures use the integer hashes of `GLSL_HASH` (TL-035), with seeds from the appearance.
- Shading is in linear light on `rgba16f`; the signal-space blends that matter to the look of satin and textures convert
  explicitly, and colours pass through the look's roles so colourways apply.
- Reflection environments are closed forms of the direction, so no bundled picture exists; a rough surface widens their edges
  instead of blurring a texture.
- Grain does not sample render pixels: it lives in unit cells and fades with its share of a pixel.
- Motif names are generic (`blossom`, `fans`, `leafLattice`, `rings`, `hexagons`, `scales`), and each kind compiles on its own.
- The dry-brush cut antialiases through screen derivatives rather than the original's analytic exit gradients, and cuts the
  composite of what is below it rather than each element's mask, so lights do not follow the cut.
- Not ported: Pachislop's gloss contours (`ring`, `sawtooth`…) and its surface textures (hammered, crumple, liquid).
- The rotation undo reads the layer map the stage draws with, not a transform's `rotZ` and flips: its orthogonal part (polar
  decomposition), so Motion scale and skew do not tilt the light. It also turns the directions of
  drop, long and inner shadows and of extrusion, which Pachislop keeps in the layer, and the padding grows alike on every side
  of a layer that turns.
