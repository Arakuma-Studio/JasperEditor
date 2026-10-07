# Ported code: masks and track mattes (wp `masks`)

Licence of the ported code: **MIT OR Apache-2.0** (we use it under MIT).

## EffectCraft — https://github.com/storytold/effectcraft

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors

| Upstream | Ours | What |
|---|---|---|
| `crates/path/src/interp.rs` | `packages/project/src/path/interp.ts` | Smart path interpolation: arc-length vertex insertion (de Casteljau), shape-context (Belongie–Malik–Puzicha) cyclic correspondence with winding fix, Procrustes in-betweens, crossing count |
| `crates/path/src/trace.rs` | `packages/project/src/path/trace.ts` | Auto-trace: marching squares with saddle resolution and padded borders, Douglas–Peucker on closed loops, nesting depth, per-span cubic fit with chord/smooth tangent blend |
| `crates/path/src/fit.rs` | `packages/project/src/path/trace.ts` (`fitCubicWithTangents`) | Least-squares cubic with fixed end tangents + Newton reparameterisation |
| `crates/path/src/feather.rs` | `packages/project/src/masks/raster.ts` (`featherProfileAt`, profile placement), `packages/project/src/masks/glsl.ts` (`profileAt`) | Variable-width feather: feather points on segments, outer/inner radii interpolated along the arc length with tension (smoothstep ↔ linear), wrap-around on closed paths |
| `crates/path/src/lib.rs` (`to_kurbo` vertex model) | `packages/project/src/path/model.ts` | Vertex / relative tangent model, segments, ellipse construction |
| `crates/render/src/masks.rs` (mode algebra) | `packages/project/src/masks/model.ts` (`combineMaskMode`) | Add / Subtract / Intersect / Lighten / Darken / Difference |
| `crates/track/src/mask.rs` | `apps/engine/src/tracking/mask.ts` | Mask tracking approach: features inside the outline, pyramidal LK with forward–backward check, robust model fit with fallback, outline moved by the step |

## FilmCraft — https://github.com/storytold/filmcraft

Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors

| Upstream | Ours | What |
|---|---|---|
| `crates/render/src/mask.rs`, `crates/gpu/src/mask.wgsl` | `packages/project/src/masks/raster.ts`, `packages/project/src/masks/glsl.ts` (WGSL → GLSL ES 3.00) | Signed-distance mask coverage: nonzero winding + distance to the flattened outline, `falloff(s, feather)` (analytic 1-px edge at feather 0, centred smooth ramp), opacity / inversion, first-mode start values (Subtract / Intersect / Darken start from 1) |
| `crates/project/src/mask.rs` | `packages/project/src/schema/mask.ts`, `packages/project/src/masks/model.ts` | Premiere mask model: Mask Path / Feather (default 10) / Opacity / Expansion, Inverted, mode, tracking method; "Mask (n)" naming |
| `crates/engine/src/masks.rs` | `packages/project/src/commands/handlers/mask.ts` | Command shapes (add / set / move vertex / add & remove vertex in every key / convert vertex / track writing path keys) |
| `crates/render/src/vfx/color.rs` (`track_matte`, `apply_matte`) | `packages/project/src/registry/fx/premiere-adjust-color-keying/keying.ts` (Track Matte Key) | Track matte: another track's composite sampled through the layer → output map, Matte Alpha / Matte Luma, Reverse |
