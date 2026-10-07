# Shape layers: path operators, curve booleans, offset, variable strokes, stacking semantics

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** shapes workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/path/src/ops.rs` | `packages/project/src/vector/ops.ts` | Trim Paths (simultaneous / individual), Pucker & Bloat, Round Corners, Offset Paths copies, Twist (Jacobian-mapped handles), Zig Zag, Wiggle Paths (resampling, noise), Merge Paths modes — Rust (kurbo) → TypeScript |
| `crates/path/src/ops/tests.rs` | `packages/project/test/vector/ops.test.ts` | the operator tests, ported |
| `crates/path/src/boolean.rs` | `packages/project/src/vector/boolean.ts` | contour tidy-up after the sweep (exact re-joins of split input curves, least-squares refit of smooth runs, kept input vertices, sliver removal); the sweep itself is PathBool.js (`path-bool`, MIT) instead of `linesweeper` |
| `crates/path/src/offset.rs` | `packages/project/src/vector/offset.ts` | Offset Paths structure (ring of the outline, grow = union / shrink = difference, spurious holes / islands within the distance dropped); our own per-segment offset fitting replaces kurbo's stroker |
| `crates/path/src/fit.rs` | `packages/project/src/vector/fit.ts` | least-squares cubic fitting with fixed end tangents and Newton reparameterisation |
| `crates/path/src/varstroke.rs` | `packages/project/src/vector/varstroke.ts` | Stroke Taper (lengths, widths, ease) and Wave (amount, wavelength / cycles, phase), dash intervals, union-of-primitives outline |
| `crates/path/src/lib.rs` | `packages/project/src/vector/primitives.ts`, `packages/project/src/vector/values.ts` | rectangle / ellipse / polystar construction (vertex order follows After Effects / lottie-web, see the wp-note), vertex-model ⇄ path conversion |
| `crates/render/src/shapes.rs` | `packages/project/src/vector/evaluate.ts`, `packages/project/src/vector/render-plan.ts` | the stacking semantics (operators on the path slots above them incl. nested groups, paints referencing slots rewritten by later operators, Merge Paths dropping the paints above it, Repeater copies with their own slots and opacity ramp, group transforms), the radial-gradient focal point (Highlight Length / Angle) |
| `crates/project/src/build.rs` | `packages/project/src/vector/defaults.ts`, `packages/project/src/vector/properties.ts` | the shape items' properties, defaults and labels |
| `crates/geom/src/lib.rs` (`Mat3::skew_deg`) | `packages/project/src/vector/geom.ts` (`skewDeg`) | the skew-about-an-axis matrix |

Notes: ported to TypeScript (no kurbo / tiny-skia / linesweeper; geometry is our own cubic kernel in `geom.ts`;
booleans run on PathBool.js). Changes: Fill / Stroke "Composite: Above Previous in Same Group" and group blend modes
are implemented (EffectCraft stores but ignores them); Repeater "Composite Below / Above" order matches After
Effects (EffectCraft draws them swapped); Wiggle Paths gains Spatial Phase; strokes keep Premiere's inside / center /
outside position. Rasterisation is Chromium's (SVG, or Canvas 2D plus the shared blend kernel), not tiny-skia.
