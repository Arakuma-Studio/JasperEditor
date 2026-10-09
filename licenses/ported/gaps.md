# Ported code: Premiere parity gaps (wp `gaps`)

Licence of the ported code: **MIT OR Apache-2.0** (we use it under MIT).

## EffectCraft — https://github.com/storytold/effectcraft

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors

| Upstream | Ours | What |
|---|---|---|
| `crates/track/src/stabilize.rs` | `packages/project/src/gaps/warp/stabilize.ts` | Warp Stabilizer stabilisation: per-method frame motions, Smooth Motion as the Gaussian-weighted average of neighbouring viewpoints (Matsushita et al. 2006), No Motion onto the middle frame, Preserve Scale, valid-fraction search, framing (Stabilize Only / Crop / Crop + Auto-scale / Synthesize Edges), Maximum Scale relaxation with min-filter + Gaussian spreading, Crop Less ↔ Smooth More sigma, plan source / output mapping |
| `crates/track/src/stabilize.rs` (`Analyzer`) | `apps/engine/src/tracking/warp.ts`, `apps/engine/src/gaps/warp-analysis.ts` | The analysis: features tracked frame to frame, robust translation / similarity / homography per frame (with the "wild homography falls back to the similarity" rule), trajectories of at least 6 frames at 0.1 px, compact per-frame record |
| `crates/track/src/subspace.rs` | `packages/project/src/gaps/warp/stabilize.ts` (`WarpMesh`, `solveMesh`, `smoothTrajectories`, `stabMeshes`) | Subspace Warp: eigen-trajectory smoothing over a sliding window with incomplete trajectories fitted by least squares (Liu et al. 2011), content-preserving mesh warps with the triangle similarity term and a perspective prior (Liu et al. 2009), inverse mesh storage, Newton forward mapping, mesh valid fraction |
| `crates/track/src/fit.rs` (`least_squares`), `crates/track/src/solve.rs` (`Homography`) | `packages/project/src/gaps/warp/math.ts` | Least-squares translation / similarity / normalised-DLT homography; homography algebra (apply, compose, inverse, lerp, scale about a point) |
| `crates/track/src/camtrack/linalg.rs` (`cholesky_solve`) | `packages/project/src/gaps/warp/math.ts` (`choleskySolve`, `bandedCholeskySolve`) | Cholesky solve (ours adds band storage for the mesh systems); the symmetric eigensolver is replaced by our warm-started subspace iteration |
