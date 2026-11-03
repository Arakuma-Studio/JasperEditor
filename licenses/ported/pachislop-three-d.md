# Pachislop: 3D titles

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks 3D stream, 2026-11-02

| Upstream path | Local path | What |
|---|---|---|
| `src/engine/three/bevel.ts` | `packages/project/src/three-d/bevel.ts` | Bevel cross-sections, curve bend, facet counts |
| `src/engine/three/extrude.ts` (`bandSpans`, `makeRing`, `rayHit`, `computeLimits`, `untangle`, `extrudeSolid`) | `packages/project/src/three-d/solid.ts` | Ring-stack extruder: profile spans, ray limits, untangling, caps and strips |
| `src/engine/three/inflate.ts` | `packages/project/src/three-d/inflate.ts` | Inflate: a grid clipped exactly to the outline, distance field with relaxed ridges, exact normals |
| `src/engine/three/title.ts` (`buildTitle`: bands, backplates, stacking) | `packages/project/src/three-d/title-solid.ts` | Assembly of a title's solid and plates |
| `src/engine/three/tonemap.ts` | `packages/compositions/src/three-d/hdr-passes.ts` (`TONEMAP_GLSL`) | ACES fitted, AgX, Khronos Neutral, and `punch` as the hue-preserving mode |
| `src/engine/three/hdrResolve.ts` | `packages/compositions/src/three-d/hdr-passes.ts` (`HDR_SHOULDER_GLSL`, `EXPAND_FS`) | Tone-map-aware MSAA resolve |
| `src/engine/three/resample.ts` | `packages/compositions/src/three-d/hdr-passes.ts` (`DOWNSAMPLE_FS`, `downsample`) | Mitchell–Netravali supersampling resolve |
| `src/engine/three/glint.ts` | `packages/compositions/src/three-d/hdr-passes.ts` (`renderGlint`) | Bright pass, bloom, point detector, Kawase streaks |
| `src/engine/three/materials.ts` (surface relief, flakes, clearcoat, gem transmission, reflectivity) | `packages/compositions/src/three-d/advanced.ts` (`RELIEF_GLSL`, `shadePhysical`) | Written directly in our shader: upstream patches three.js chunks |
| `src/engine/layer2d/contours.ts` (`curveFn`) | `packages/project/src/three-d/inflate.ts` (`inflateCurveFn`) | Monotone height curve |
| `src/model/defaults.ts` (`PRESET_VALUES`) | `packages/project/src/three-d/surfaces.ts` (`SURFACE_PRESETS`) | Material preset numbers and metal banding ramps |
| `src/model/defaults.ts` (metal banding), `src/engine/three/bevel.ts` (profile names) | `packages/project/src/schema/three-d.ts` (`SurfaceRamp`, `BEVEL_PROFILES`) | The shape of a surface's tint ramp and the bevel cross-sections a band may take |

## Changes made when porting

- Outlines are traced from the layer's alpha, not read from opentype. A trace has a tiny edge at every antialiased corner, so
  rings are a shrinking wavefront (`waveOf`): a collapsed edge leaves the front. Upstream's per-vertex clamp would leave a spike
  at every corner of a traced glyph.
- Clipper offsets are replaced by iso-lines of a distance field (`packages/project/src/three-d/offset.ts`, our own code), which
  need no boolean library and are simple for any input.
- z points away from the viewer here: every z and normal z is negated.
- `three.ShapeUtils.triangulateShape` became our earcut port.
- Glints: a tent prefilter at every mip step instead of 2 × 2 boxes (a small measured gain, `docs/wp-notes/three-d.md` §9).
- Float hashes in the surface relief became the integer hashes of `fx/hash`; the antialiasing width comes from the depth, not
  from derivatives.
- Zod at every entry point; a missing float target refuses with `THREE_D_NEEDS_FLOAT` instead of degrading.
- Everything numeric is an `Animatable`, evaluated per frame. Materials, lights and cameras never rebuild geometry.
- Pachislop's PMREM comes from three.js: our prefilter (`buildEnvMaps`) is a GGX importance-sampled equirectangular pyramid,
  written from Karis (2013) and Křivánek and Colbert (2008), not ported.
- Procedural environments are the look presets' GLSL (`registry/fx/glsl/title-env.ts`), by the same names (TL-038), not
  upstream's scenes of softboxes.
