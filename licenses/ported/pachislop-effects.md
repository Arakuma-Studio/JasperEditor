# Pachislop: glow, shadow and finish effects

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks glows stream, 2026-11-02

| Upstream path | Local path | What |
|---|---|---|
| `src/effects/a/lightGlow.ts` (`psfOctaves`, `EMIT_GLSL`, `blurFrag`, `lightGlowComposeFrag`) | `packages/project/src/registry/fx/title-look/deep-glow.ts` | Deep Glow: power-law PSF as an energy-normalised mixture of Gaussians, soft-knee emission, pyramid, over-exposure response |
| `src/effects/a/glow.ts` (`deepGlow`) | `packages/project/src/registry/fx/title-look/layers/deep-glow.ts`, `packages/project/src/registry/fx/title-look/effects/deep-glow.ts` | Deep Glow's params, as a look layer and an effect |
| `src/effects/a/glow.ts` (`outerGlow`) | `packages/project/src/registry/fx/title-look/layers/glow.ts`, `packages/project/src/registry/fx/premiere-stylize-distort-generate/stylize.ts` (Alpha Glow, Soft and Precise) | Soft core, Spread, From layer with either technique, distance gradient, Add as Light |
| `src/effects/a/glow.ts` (`innerGlow`) | `packages/project/src/registry/fx/title-look/layers/inner-glow.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | Inner glow: soft and precise, edge and centre, Normal, Screen and Add |
| `src/effects/a/glow.ts` (`contourLines`) | `packages/project/src/registry/fx/title-look/layers/contour-lines.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | Lines of light following the silhouette |
| `src/effects/a/shadow.ts` (`innerShadow`) | `packages/project/src/registry/fx/title-look/layers/inner-shadow.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | Inner shadow |
| `src/effects/a/shadow.ts` (`perspectiveShadow`) | `packages/project/src/registry/fx/title-look/layers/shadow.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | A shadow cast on a floor: projection by the height on the object, near and far blur, fade |
| `src/effects/a/shadow.ts` (`floorReflection`) | `packages/project/src/registry/fx/title-look/layers/reflection.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | Mirrored fade below the title |
| `src/effects/a/finish.ts` (`keyline`) | `packages/project/src/registry/fx/title-look/layers/rim.ts` (Softness), `packages/project/src/registry/fx/title-look/effects/index.ts` | Keyline: outline with a feathered outer part |
| `src/effects/a/stylize.ts` (`gradientOverlay`) | `packages/project/src/registry/fx/title-look/layers/gradient-overlay.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | Gradient overlay: fitted or as a moving band, with wrap modes |
| `src/effects/a/stylize.ts` (`extrude2d`) | `packages/project/src/registry/fx/title-look/layers/extrude.ts`, `packages/project/src/registry/fx/title-look/effects/index.ts` | Shaded 2D extrusion |
| `src/effects/globalLight.ts` (`GlobalLightRelation`: `away`, `floor`) | `packages/project/src/registry/fx/title-look/layers/shadow.ts`, `layers/inner-shadow.ts`, `layers/extrude.ts` | How a shadow's direction relates to the light; a floor shadow mirrors `away` vertically |

## Changes made when porting

- **Time.** Pachislop is a still-image editor. Every number here is an `Animatable`, padding covers every frame of the clip
  (TL-033), and an animated Deep Glow radius is continuous across pyramid levels.
- **Frame edges.** Pachislop's glows clip at the frame of their pass. Padding here is the reach of the PSF, shadow or
  reflection, and a blur treats outside the canvas as empty, so light leaves the picture instead of piling up at its edge.
- **Downsample variance.** `lib.ts` `blur` shrinks by bilinear copies and does not take their variance off its Gaussian. Deep
  Glow's reductions and its bilinear reads are taken off per channel in the shader; layers use the framework's blur, which
  renders the mask at the blur's own size.
- **Resolution.** `SIGMA_MIN = 1` comp px makes Pachislop's PSF depend on the comp's size; here the mixture is a fixed ratio of
  the radius, and an octave narrower than a pixel joins the unblurred term, so no energy depends on the resolution.
- **Colour.** All blends are linear light, as §8 asks. Pachislop blends Gradient Overlay on sRGB values except its two Light
  modes, which are `add` and `multiply` here. Light on nothing gets the alpha that encodes correctly in a sequence's
  composite (`title-look/light.ts`), not the brightest linear channel.
- **Extrude.** Up to 1024 copies per pixel at 0.75 px became a march on the shape field, with normals from the field.
- **Input.** No float hashes (these effects use none), no `gl_FragCoord`, zod validation through INV-APPEARANCE and effect
  params. `threshold` of Keyline and `follow` of Contour Lines and Keyline are not ported: the field's edge is its local
  threshold, and an effect reads the stack above it by definition.
