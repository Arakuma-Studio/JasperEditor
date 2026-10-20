# Code ported by the `three-d` workstream (3D layers, cameras, lights, Classic 3D, 3D Camera Tracker)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14f09bb064cab8f1f8fe85af601a08b6e53`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** three-d workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/geom/src/lib.rs` (Matrix4), `crates/render/src/three_d/camera.rs` | `packages/project/src/three-d/math.ts` | Row-major 4×4 matrices, After Effects' layer transform order, orientation ↔ matrix, quaternion slerp |
| `crates/render/src/three_d/camera.rs` | `packages/project/src/three-d/model.ts`, `packages/project/src/three-d/tools.ts` | Camera presets and lens relations (zoom ↔ focal length ↔ angle of view, film size), the camera rig and the orbit / pan / dolly tools, the 3D views |
| `crates/render/src/three_d/camera.rs`, `crates/render/src/three_d/light.rs` | `packages/project/src/three-d/scene.ts` | Camera state and projection, circle of confusion, light states, falloff and spot cone attenuation, layer world matrices |
| `crates/render/src/three_d/compose.rs`, `crates/render/src/three_d/light.rs` | `packages/project/src/three-d/classic.ts` | Classic 3D per-pixel compositor: plane homographies, depth from the plane equation, far → near fragment sort (coplanar in stack order), Blinn-Phong both sides, ray-cast shadows with Light Transmission, blur levels |
| `crates/render/src/three_d/bokeh.rs` | `packages/project/src/three-d/bokeh.ts` | Iris row spans, span-kernel gather over row prefix sums, highlight boost, progressive blur levels |
| `crates/gpu/src/shaders/classic3d.wgsl` | `packages/compositions/src/three-d/gl.ts` | The Classic 3D composite and depth-of-field passes (WGSL → GLSL ES 3.00, data textures instead of storage buffers) |
| `crates/track/src/camtrack/linalg.rs` | `apps/engine/src/camtrack/core/linalg.ts` | Vectors / 3×3 matrices, Rodrigues, one-sided Jacobi SVD, Jacobi eigen-decomposition, Cholesky |
| `crates/track/src/camtrack/geometry.rs`, `crates/track/src/fit.rs` | `apps/engine/src/camtrack/core/geometry.ts` | Normalised 8-point essential matrix, Sampson distance, RANSAC, essential / homography decomposition, triangulation, pose selection, plane fit, Procrustes, homography RANSAC |
| `crates/track/src/camtrack/mod.rs` | `apps/engine/src/camtrack/core/types.ts` | Tracks, radial distortion (k1, k2) and its inverse / Jacobian, settings and the solve |
| `crates/track/src/camtrack/bundle.rs` | `apps/engine/src/camtrack/core/bundle.ts` | Levenberg–Marquardt bundle adjustment with the Schur complement, Huber IRLS, fixed / shared / per-camera focal lengths, distortion |
| `crates/track/src/camtrack/solver.rs` | `apps/engine/src/camtrack/core/solver.ts` | Keyframes by parallax, two-view initialisation (essential or homography), incremental resection and triangulation, focal search, tripod solve and Auto Detect, lens distortion passes, canonical frame |
| `crates/track/src/camtrack/features.rs` | `apps/engine/src/camtrack/features.ts` | Feature tracking approach: Shi–Tomasi corners, pyramidal LK with a forward–backward check, epipolar RANSAC, re-detection away from live features |
| `crates/track/src/camtrack/tests.rs` | `apps/engine/test/camtrack-solve.test.ts` | The synthetic-scene accuracy tests (dolly with a known path and focal length, specified angle, variable zoom, tripod pan, flat scene, lens distortion) |

Notes: ported to TypeScript (the solver runs in the `jasper-camtrack` child process, features with OpenCV.js instead
of the upstream tracker). The Advanced 3D renderer (rasteriser, GGX, shadow maps, environment light, extrusion, model
loading) is our own and not ported.
