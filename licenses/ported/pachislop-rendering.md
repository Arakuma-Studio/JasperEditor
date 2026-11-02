# Pachislop: title rendering core

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks foundation, 2026-11-02

| Upstream path | Local path | What |
|---|---|---|
| `src/effects/lib.ts` (`sdf`, `seedFrag`, `jfaFrag`, `sdfFrag`) | `packages/project/src/registry/fx/title-look/glsl.ts` (`FRAG_TL_SEED`, `FRAG_TL_FLOOD`, `FRAG_TL_FIELD`) | Jump flooding over sub-pixel edge points moved along the alpha gradient |
| `src/effects/lib.ts` (`bounds`, `boundsFrag`) | `packages/project/src/registry/fx/title-look/glsl.ts` (`FRAG_TL_BOUNDS_FIRST`, `FRAG_TL_BOUNDS_NEXT`) | Alpha bounds by GPU reduction, no read-back |
| `src/effects/a/shadow.ts` (`dropShadow`) | `packages/project/src/registry/fx/title-look/layers/shadow.ts` | Drop shadow: offset, spread, blurred silhouette |
| `src/effects/a/glow.ts` (`outerGlow`, technique Softer / Precise) | `packages/project/src/registry/fx/title-look/layers/glow.ts` | Outer glow: soft halo, precise distance falloff, from edge or layer |
| `src/engine/layer2d/Title2DRenderer.ts` (rim stack: rims grow from the plate base) | `packages/project/src/registry/fx/title-look/layers/rim.ts`, `plan.ts` (`plannedLayers`) | Rims growing cumulatively from the face or the previous rim |

## Changes made when porting

- The input is the layer's alpha, not vector outlines, so rims come from the shape field with round corners.
- The threshold is local (half the local peak alpha, 50 % once the peak is solid) and rims inherit a nearby opacity, so
  per-character fades do not pop: Pachislop titles are still images and use a fixed 0.5.
- Distances are percentages of the look's unit, never pixels; blurs pick a mip level and a pass scale from the sigma, so
  no radius is clamped in pixels (Pachislop's blur clamps at 48 taps and 5 octaves).
- Compositing is linear light on `rgba16f`, and a missing float target refuses rather than degrading.
- No shader uses a float hash; `seed` comes from the appearance.
- Every number is an `Animatable` and is evaluated per frame.
