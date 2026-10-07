# After Effects-style expressions (object model, array maths, controls)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** expressions workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/expr/src/prelude.js` | `packages/expressions/src/prelude.ts` | the AE expression object model and global functions (array maths helpers, vector maths, interpolation, random/gaussRandom/seedRandom, time and colour conversions, Comp/Layer/property group/Prop/Markers objects, loopIn/loopOut, wiggle, smooth, valueAtTime, key/nearestKey, text style getters), adapted to a synchronous host and a Premiere-style document |
| `crates/expr/src/rewrite.rs` | `packages/expressions/src/compile.ts` | the array-maths operator rewrite (`+ - * /` → helper calls, unary minus, compound assignments, nesting limit), re-implemented on an acorn AST; its test cases are in `packages/expressions/test/compile.test.ts` |
| `crates/expr/src/noise.rs` | `packages/expressions/src/prelude.ts` | value noise (1D/3D, quintic fade), lattice hashing and the octave wiggle sum, ported to 32-bit integer hashing |
| `crates/expr/src/host.rs`, `crates/expr/src/runtime.rs` | `packages/expressions/src/world.ts`, `packages/expressions/src/values.ts`, `packages/expressions/src/runtime.ts` | the host request set (comp/layer/child/property info, values, transforms, markers), name/alias matching of properties, result conversion rules and AE-style error messages |
| `crates/effects/src/controls.rs` | `packages/project/src/registry/expression-controls.ts` | the Expression Controls effects (Slider, Angle, Checkbox, Color, Point, 3D Point, Layer, Dropdown Menu) and their parameters |
