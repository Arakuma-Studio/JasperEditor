# Code ported by the `sim-warp` workstream (particles and simulations, mesh and brush warps, Puppet)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14f09bb064cab8f1f8fe85af601a08b6e53`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** sim-warp workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/effects/src/util.rs` (`SimCache`), `crates/effects/src/sim.rs` (`steps_at`) | `packages/project/src/registry/fx/simulation-warp/core.ts` | Fixed-rate stepped simulations with checkpoints so seeking equals playing; index hashes |
| `crates/effects/src/sim.rs` (`Phys::spawn` / `step`, `pw_phys`, `particle_world_plan`, `ps2_phys`, `mercury_blobs`, `mr_mercury`, `sprite_shade`) | `packages/project/src/registry/fx/simulation-warp/engine.ts`, `particles.ts`, `particle-render.ts`, `sprites.ts` | Particle World / Particle Systems II / Mercury physics (producers, animation types, velocity, gravity, resistance, extra, floor), particle shapes and birth/death size and colour, Mercury metaballs; rewritten as TS state + GLSL ES 3.00 instanced draw passes |
| `crates/effects/src/sim.rs` (`rainfall_plan`, `snowfall_plan`, `bubble_list`, `drizzle_drops`, `star_burst_plan`) | `packages/project/src/registry/fx/simulation-warp/weather.ts` | Closed-form weather and star fields (moved into vertex shaders) |
| `crates/effects/src/sim3.rs` (`Pg`, `Mapper`, `Affects`, `playground_plan`) | `packages/project/src/registry/fx/simulation-warp/playground.ts` | Particle Playground: cannon, grid, layer exploder, property mapper, gravity, repel, wall |
| `crates/effects/src/sim2.rs` (`pattern_cells`, `shatter_impl`, `Piece`) | `packages/project/src/registry/fx/simulation-warp/shatter.ts`, `pieces.ts` | Shatter patterns, force spheres, gradient-timed breaking, piece physics |
| `crates/effects/src/card3d.rs` | `packages/project/src/registry/fx/simulation-warp/pieces.ts` | Camera systems (Camera Position with transform orders, Corner Pins), distant / point lighting and material shading for 3D pieces |
| `crates/effects/src/sim2.rs` (`card_dance_plan`, `pixel_polly_plan`), `crates/effects/src/transition.rs` (`card_wipe_plan`) | `packages/project/src/registry/fx/simulation-warp/cards.ts` | Card Dance, Pixel Polly, Card Wipe |
| `crates/effects/src/sim2.rs` (`ball_action_plan`, `scatterize_plan`, hair strands) | `packages/project/src/registry/fx/simulation-warp/pixel-fx.ts` | Ball Action, Scatterize, Hair |
| `crates/effects/src/sim2.rs` (`foam_full_plan`) | `packages/project/src/registry/fx/simulation-warp/foam.ts` | Foam bubbles (producer, physics, flow map, popping, rendering) |
| `crates/effects/src/sim2.rs` (`wave_world_impl`, `Producer`) | `packages/project/src/registry/fx/simulation-warp/wave-world.ts` | Wave World height-field simulation (producers, ground, reflection / pinning) |
| `crates/effects/src/sim2.rs` (`caustics_setup` and passes) | `packages/project/src/registry/fx/simulation-warp/caustics.ts` | Caustics (bottom refraction, surface, light, caustic strength) |
| `crates/effects/src/distort.rs` (polar), `distort2.rs` (`displacement_map`, `optics_compensation`, `bezier_grid`), `distort3.rs` (`smear_setup`, `reshape_setup`) | `packages/project/src/registry/fx/simulation-warp/distort.ts` | Polar Coordinates, Displacement Map, Optics Compensation, Bezier Warp, Smear, Reshape |
| `crates/effects/src/distort4.rs` (`build_mesh`) | `packages/project/src/registry/fx/simulation-warp/meshes.ts` | Liquify brushes (extended with reconstruction modes and a keyframable mesh) |
| `crates/effects/src/puppet/mesh.rs` | `packages/project/src/puppet/mesh.ts` | Outline from alpha (rasterise, expand, region, trace, simplify), constrained Delaunay triangulation |
| `crates/effects/src/puppet/arap.rs` | `packages/project/src/puppet/arap.ts` | As-rigid-as-possible deformation (Igarashi et al. 2005, two-step similarity + fitting) with sparse symmetric solves |
| `crates/effects/src/puppet/mod.rs` (`solve`, `starch_weights`, `depths`), `puppet/tests.rs` | `packages/project/src/puppet/model.ts`, `packages/project/test/sim-warp-commands.test.ts` | Pin solve, Starch weights, Overlap depths; test expectations |
| `crates/effects/src/psim.rs` | `packages/project/src/registry/fx/simulation-warp/engine.ts` | Used as a design reference only (rate `carry` births, per-particle independence) |

Notes: everything is TypeScript or GLSL ES 3.00; Rust code was rewritten, not transpiled. New here: the fx framework's
draw passes, data textures, `rgba32f` targets, GPU bitonic sort and CPU pixel access (`packages/project/src/registry/fx/shader.ts`,
`packages/compositions/src/fx/{host,stage,pixels}.ts`), the `mesh` param type, the `EffectInstance.puppet` model with
its commands, invariants and expressions, the Program-monitor tools (`apps/web/src/simwarp/`) and the MCP tools
(`apps/mcp/src/tools/sim-warp.ts`).
