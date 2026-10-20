# shapes — After Effects-style shape layers (vector shapes)

Branch `feat/shapes`. Extends the M2 rectangle / ellipse clips (`wp-m2-shapes.md`) with **vector shapes**: nested
groups with transforms, parametric and free Bézier paths, solid and gradient fills and strokes (dashes, taper,
wave), the nine path operators with After Effects' stacking semantics, every blend mode, expressions, an SVG
converter, the Program monitor tools (Pen, Rectangle, Ellipse, Polygon, Star) with vertex editing, an Essential
Graphics-style layer list with a gradient editor, MCP tools and presets. Old rectangle / ellipse clips are untouched
(same model, same renderer, same pixels); `shape.convertToVector` turns one into a vector shape.

Reference: EffectCraft `crates/path/src/{ops.rs, boolean.rs, offset.rs, fit.rs, varstroke.rs, lib.rs}`,
`crates/render/src/shapes.rs`, `crates/project/src/build.rs` — ported to TypeScript, recorded in
`licenses/ported/shapes.md`.

## 1. Architecture

**One geometry kernel, one renderer, every output path.** Shape clips are DOM layers: the Program monitor, stills,
the Remotion export path and the layer bake of the native/hybrid export all render the *same* composition
(`packages/compositions/src/layers/ShapeLayer.tsx` → `VectorShape.tsx`) in Chromium. So the design keeps all geometry
in one pure TypeScript kernel in `@jasper/project` and lets the composition draw it:

| Layer | Where | What |
|---|---|---|
| Path model | `packages/project/src/path/model.ts` (masks) | the shared Bézier value `BezierPath {closed, vertices: [{p, in, out}]}` — shape `path` items store exactly the mask path value, interpolate with masks' smart vertex correspondence (`path/interp.ts`) and are edited with masks' path ops (`shape.editPath` reuses `mask.editPath`'s operations) |
| Kernel | `packages/project/src/vector/geom.ts` | compound cubic paths (`BezPath`), arc length (adaptive Gauss–Legendre), inverse arc length, splitting, bounds, nearest point, winding, affine maps, SVG path data |
| Operators | `vector/ops.ts`, `offset.ts`, `boolean.ts`, `fit.ts`, `varstroke.ts` | Trim, Pucker & Bloat, Round Corners, Offset Paths, Twist, Zig Zag, Wiggle Paths, Merge Paths; curve-preserving booleans (PathBool.js sweep + EffectCraft's tidy-up); variable-width strokes |
| Evaluation | `vector/evaluate.ts` | the shape tree at a time → draws (paint, geometry, group matrix, opacity, blend, blended-group chain) with AE stacking semantics |
| Render plan | `vector/render-plan.ts` | draws → paint primitives (path data, stroke style or fill outline, inside clip / outside cut) |
| Renderers | `packages/compositions/src/layers/VectorShape.tsx` | **SVG** when every paint uses a CSS-exact blend mode; else the **canvas compositor**: each primitive drawn alone with Canvas 2D (same Skia rasteriser), composited with the shared blend kernel `makeBlendKernel` (the GL compositor's and the native export's formulas, keyframes-blend) |

Why not a Rust/WASM kernel with tiny-skia for export: the export already renders shape clips through the same
Chromium composition (layer bake), so a separate native rasteriser would be a *second* renderer to keep identical
for no gain; a TypeScript kernel is synchronous in React/Remotion, runs in the model (hit-testing, bounds,
validation, agent queries) and needs no build step. Measured result (§9): export = still, and SVG = canvas.

**The layer box.** A vector shape's layer is frame-sized (After Effects shape layers are comp-sized); content
coordinates are layer pixels around the box centre, which is the default anchor — content (0, 0) sits on Motion's
Position. The box never depends on the contents, so editing paths never moves anything (rectangles / ellipses keep
their size-derived box and `keepShapesCentred`). The Program monitor frames a vector shape by its painted contents
(`layerEditRect` / `layerEditQuad`: selection box, handles, hit quad, snapping, group box), not by the frame-sized
box; hit-testing uses the painted fills and stroke bands.

**Never drop an operator.** Every item type is handled by the evaluator; documents from newer versions with unknown
item types fail schema validation and are repaired (item dropped, reported) rather than drawn silently without it.
Time-varying shapes (keys, expressions, a Wiggle Paths with Wiggles/Second ≠ 0) are frame-dependent in the
composition (`vectorShapeIsTimeDependent`) and never baked as one still (`isStaticLayer`); the bake's crop rect
grows by how far static contents leave the box and does not crop animated ones (`contentBleed`).

## 2. Model (`packages/project/src/schema/shapes.ts`)

`ShapeData` is a union: `{type: 'rect' | 'ellipse', size, fill, stroke, cornerRadius}` (unchanged) or
`{type: 'vector', contents: ShapeItem[]}`. Items (`id` unique per clip, prefix `shp_`; `name`; `enabled?`), list
order = stacking order (index 0 = top):

- `group` {contents, transform {anchor, position, scale %, skew (−85…85°), skewAxis°, rotation°, opacity %},
  blendMode?}
- paths: `rect` {size, position, roundness}, `ellipse` {size, position}, `polystar` {starType star|polygon, points,
  position, rotation, innerRadius, outerRadius, innerRoundness %, outerRoundness %}, `path` {path: BezierPath} —
  each with `direction` normal|reversed
- paints: `fill` {color, opacity, fillRule nonzero|evenodd, blendMode, composite below|above}; `stroke` {color,
  opacity, width, lineCap butt|round|square, lineJoin miter|round|bevel, miterLimit, dashes {segments [{dash, gap}]
  ≤ 3, offset}, taper {units percent|pixels, startLength, endLength, startWidth %, endWidth %, startEase %,
  endEase %}, wave {amount %, units pixels|cycles, wavelength, cycles, phase°}, position center|inside|outside,
  blendMode, composite}; `gradientFill` / `gradientStroke` {gradientType linear|radial, startPoint, endPoint,
  highlightLength %, highlightAngle°, colors {colors [{position, color, midpoint?}], opacities [{position, opacity,
  midpoint?}]}} + the fill / stroke fields
- operators: `trim` {start %, end %, offset°, mode simultaneous|individual}, `repeater` {copies, offset, composite,
  transform {anchor, position, scale, rotation, startOpacity, endOpacity}}, `offsetPaths` {amount, lineJoin,
  miterLimit, copies, copyOffset}, `roundCorners` {radius}, `zigZag` {size, ridges, points corner|smooth},
  `twist` {angle, center}, `wiggle` {size, detail, points, speed, correlation %, temporalPhase°, spatialPhase°,
  seed}, `puckerBloat` {amount −100…100}, `mergePaths` {mode merge|add|subtract|intersect|exclude}

Every numeric / point / colour field and the path and gradient values are Animatables (shared evaluator; paths
interpolate with masks' correspondence, gradients stop by stop, resampled when the stop structures differ —
`keyframes.ts` calls `lerpShapeValue`). Optional fields default at read time. Invariants: every item checked field
by field (`checkShapeItem`: finite values, ranges, RGBA, enums, well-formed paths / gradients, keyframes) and item ids
unique per clip (INV-012 / INV-001); `repairDocument` drops malformed items and renumbers duplicate ids. No schema
version bump (all additive).

Property keys: `shape.items.<itemId>.<field…>` (e.g. `….transform.position`, `….dashes.segments.0.dash`,
`….taper.startLength`) — resolved by `resolvePropertySpec` with the clip, enumerated by `propertiesForClip`, the
keyframe commands (`clipAnimatables`), clipboard keyframe paste, the agent schema (`shapeItems` catalogue) and
expressions.

## 3. Commands (undoable, `describe_commands`)

`clip.addShape {shape: {type: 'vector', contents | preset}}`; `shape.addItems {clipId, items | preset, parentId?,
index?}`, `shape.updateItem {clipId, itemId, patch}` (static values replace keys; `null` removes dashes / taper /
wave), `shape.removeItems`, `shape.moveItem {parentId, index}`, `shape.duplicateItem`, `shape.groupItems`,
`shape.setContents`, `shape.editPath {clipId, itemId, ops, at?, allKeyframes?}` (masks' vertex ops in layer px;
feather points refused), `shape.convertToPath` (After Effects' Convert to Bezier Path: rect / ellipse / polystar →
path at that time), `shape.convertToVector` (rectangle / ellipse clip → vector shape: path, stroke, fill with the same
values and keyframes, anchor shifted so the picture does not move). Values and keys through `param.set` /
`param.setAnimated` / `keyframe.*` on `["clip", id, "shape", "items", itemId, field…]`. Items take a relaxed input
form (`ShapeItemInputSchema`): static values or Animatables, colours as RGBA or hex, `path` as SVG path data (several
subpaths → several path items) or a path value; missing fields take the defaults. `clip.update {shape}` is refused on
vector shapes (it is the rectangle / ellipse patch). `clip.pasteAttributes {shapeStyle}` copies a vector shape's
contents onto another vector shape (fresh ids, keys re-timed).
One-click Trim Paths animations (`shape.animateTrim`), `shape.reversePathDirection` and `shape.addLine`: §12.

## 4. Stacking semantics (After Effects; `evaluate.ts`)

- Path operators act on every path above them in the same group, including nested groups' paths (in the space of
  the group the operator lives in).
- A paint paints the paths above it **as modified by every operator in the stack**: a Trim Paths below a Stroke
  still trims it (paints hold path *slots* that later operators rewrite — EffectCraft's design).
- Items higher in the list draw on top. Fill / Stroke **Composite: Above Previous in Same Group** lifts the paint over
  the paints before it in its group (EffectCraft stores the flag but ignores it).
- **Merge Paths** replaces the paths above it with one merged path and drops the paints above it in its group;
  Subtract = the topmost path minus the others (Adobe community answers; EffectCraft) — curve-preserving booleans.
- **Repeater** copies everything above it in its group, each copy with transform^(i + Offset) (anchor, position,
  compounding scale, rotation), opacity ramping Start → End Opacity, a fractional last copy fading by the fraction;
  operators below it act on each copy. Composite **Below** (default) draws each copy under the previous one (the
  original on top), **Above** each copy over the previous one (EffectCraft has these two swapped).
- Group transform = translate(position) · rotate · skew(−skew about skewAxis) · scale · translate(−anchor); group
  opacity multiplies into its paints (After Effects applies it per paint, so overlapping paints inside a 50 % group
  show their overlap — undocumented by Adobe, this is AE's visible behaviour and EffectCraft's); a group **blend mode**
  composites the group's paints together (isolated) and blends the result.
- Strokes scale with their group transform (drawn inside the group's matrix, like AE); gradients live in the paint's
  group space.

## 5. Geometry and fidelity notes

Primitives use After Effects' vertex order (lottie-web, which reproduces AE: rectangles start at the top right and run
clockwise, rounded ones at the top end of the right edge; ellipses start at the top; polystars start straight up at
Rotation 0, roundness handles `2πR/(4·points) · roundness`), so Trim Paths, Zig Zag and Wiggle start where they start
in After Effects; Reversed reverses each path.

| Operator | Behaviour |
|---|---|
| Trim Paths | Start / End %, Offset° (360° = one length); Simultaneously = each path by its own length, Individually = the paths laid end to end in stacking order; a trim across the start of a closed path stays one piece |
| Offset Paths | true curve offset (each cubic fitted to its offset curve, subdivided until within 0.005 px…), grow = region ∪ band, shrink = region − band (boolean sweep), Miter / Round / Bevel joins with Miter Limit, Copies at amount·(i + 1 + Copy Offset), spurious holes / islands closer than the distance dropped (EffectCraft); open paths outline with butt ends |
| Round Corners | corner vertices (tangent discontinuities) replaced by circular arcs tangent to both segments, cut ≤ half of each segment; smooth vertices and open ends kept |
| Zig Zag | Ridges per segment, Size (signed), Corner / Smooth points; corners use their bisector normal |
| Twist | rotation growing linearly with distance from Center to Angle at the farthest point; handles mapped through the warp's Jacobian (smooth) |
| Wiggle Paths | Detail points per segment, smooth Catmull–Rom value noise in time (Wiggles/Second, Temporal Phase) and along the path (Spatial Phase — EffectCraft lacks it), Correlation mixes a shared offset, deterministic per Random Seed. Adobe does not document its noise; the motion is plausible, not identical |
| Pucker & Bloat | vertices towards / away from the mean of the vertices, handles the other way |
| Merge Paths | Merge (compound path), Add, Subtract, Intersect, Exclude Intersections — curve-preserving booleans (PathBool.js arrangement + exact re-joins of split input curves and least-squares refits); a property test checks inclusion–exclusion on random rectangles / circles |
| Strokes | dashes (≤ 3 dash/gap pairs + offset, After Effects' Dash, Gap, Dash 2…), caps, joins, miter limit natively; Taper (Length Units, Start / End Length, Width, Ease) and Wave (Amount, Units pixels / cycles, Wavelength / Cycles, Phase) become exact fill outlines (EffectCraft's union of quads and discs, sampled every half device pixel at the layer's display scale), dashed along the same arc length |
| Gradients | linear start → end; radial centred on Start Point with radius |End − Start|, Highlight Length (−100…100 % of the radius) and Highlight Angle (from the start→end axis) place the focal point; colour stops, independent opacity stops, midpoints (`u^(ln ½ / ln m)`, Photoshop / AE convention) expanded into SVG stops; pad spread, sRGB interpolation |

Stroke Position (center / inside / outside) is kept from Premiere's graphics (After Effects strokes are always
centred); inside clips the doubled stroke to the geometry, outside cuts the geometry out.

**Adobe sources** (helpx pages refuse automated fetches (HTTP 403); their content was read through search excerpts):
After Effects User Guide "Shape attributes, paint operations, and path operations for shape layers" and "How to
taper shape strokes" (Taper / Wave properties, Units Pixels / Cycles, Wavelength, Phase); "Wiggle Paths animation
effects" and "Add animation to shape layers" (operators on the Contents ▸ Add menu); Adobe Community "Merge path
subtraction" / "How to subtract one shape from another" (Subtract = the top path minus the paths below, the Merge Paths
below the paths in the same group); Lottie format documentation (`lottie-docs/shapes`, property meanings, Trim offset
0…360 = whole path, Repeater offset / composite / opacities, highlight length / angle relative to start→end) and
lottie-web's shape code (vertex orders and polystar handle length). Where Adobe documents nothing (group opacity per
paint, Wiggle's noise, Offset Paths on open paths), the choice above is EffectCraft's / the most plausible one.

## 6. UI

- **Properties ▸ Shape Contents** (`apps/web/src/shapes/VectorShapeSection.tsx`, one vector shape selected): the
  layer list (twirls, eye = enable / disable, double-click renames, drag a row onto another to move it before it or
  onto a group's lower half to move it inside), toolbar Add ▸ (Group; Rectangle / Ellipse / Polystar / Path; Fill /
  Stroke / Gradient Fill / Gradient Stroke; the nine operators; presets) — placement as After Effects: into the
  selected group, paths above the group's paints, everything else after the selection / at the end — Group (the new
  group is selected), Duplicate, Move up / down, Delete (also Delete on a row). Below: the selected item's rows
  (PropertyRow: stopwatches, keyframes, enums, scrubs) and, for strokes, Add / Remove Dashes (+ Dash/Gap), Taper,
  Wave; for rectangles / ellipses / polystars, Convert to Bezier Path.
- **Gradient editor** (`GradientEditor.tsx`): ramp over a checkerboard, colour stops under it, opacity stops above
  it, click a lane to add a sampled stop, drag stops and midpoints (one undo step on release), Location / Color /
  Opacity fields, Delete; Path rows show the vertex count and a Closed toggle. Both appear in Properties and Effect
  Controls (PropertyRow's json rows for `shape.items.*`).
- **Effect Controls ▸ Contents**: one section per item (`Contents › Group 1 › Fill 1`), every keyframable row with
  lanes and graphs.
- **Tools** (Pen group: Pen P, Rectangle, Ellipse, Polygon, Star; Polygon / Star have no default keys — Premiere has
  none and After Effects' Q is Premiere's Ripple Trim Previous Edit). Rectangle / Ellipse: as before (rectangle /
  ellipse clips), but with one vector shape selected under the playhead they add a group (path + fill) into it, mapped
  through the layer's transform. Polygon / Star: drag from the centre outwards (radius; the first point turns
  towards the pointer, Shift keeps it upright), 5 points, star inner radius ½ (After Effects' tool defaults); a new
  vector shape centred on the press, or a group in the selected one.
- **Pen and vertex editing** (`VectorPathOverlay.tsx`): Pen clicks add vertices (drag pulls mirrored tangents), a
  click on the first vertex closes, Enter / Escape finish; on a selected path the pen adds a vertex on a segment, a
  click on a vertex deletes it, Alt-click converts it; a pen click on empty space starts a new path (a new group with
  the path, a 4 px stroke and a fill that is off) in the selected vector shape or in a new shape clip. With the
  Selection tool the selected path item shows its vertices: drag (Shift adds to the selection), drag handles (Alt
  breaks), Alt-click convert, Ctrl/Cmd-click delete, Delete removes the selected vertices. Every drag is one undo step
  writing the path at the playhead (a key when animated).
- Graphics ▸ Convert to Vector Shape (`graphics.convertToVector`, also a button in Properties ▸ Shape).
- **Paste**: SVG markup or SVG path data on the system clipboard pastes as a vector shape (into the selected vector
  shape at the playhead, else a new shape clip on the lowest targeted track), warnings in a notice.

## 7. SVG → shapes (for paste, import and agents)

`packages/project/src/vector/svg-import.ts`, exported from `@jasper/project`:

```ts
svgToShapeContents(svgText: string): { contents, width, height, viewBox, warnings }   // throws SvgImportError
svgPathToShapeItems(d: string, paint?: { fill?, stroke? }): items
looksLikeSvg(text): boolean
parseSvgPath(d): BezPath                                // vector/svg-path.ts, every SVG path command, arcs
```

`contents` is the item input form for `clip.addShape {type: 'vector', contents}` / `shape.addItems {items}`: one root
group that maps the viewBox to the document size (preserveAspectRatio xMidYMid meet) centred on the layer centre;
inside, `svg` / `g` / `a` / `use` / `symbol` become groups with exact transforms (matrix decomposed into position ·
rotation · skew · scale; a skew beyond ±85° is baked into the vertices), and every shape element a group of its
path(s), Stroke (above) and Fill. Presentation attributes, `style` and `<style>` rules (element / .class / #id),
colours (hex, rgb[a], hsl[a], named, currentColor), opacity / fill-opacity / stroke-opacity, fill-rule, stroke
width / caps / joins / miter / dashes / offset, linear and radial gradients (stops, href chains, objectBoundingBox,
gradientTransform, focal point) convert; text, images, filters, masks, clip paths, patterns and markers are skipped
and listed in `warnings`. Pure (no DOM; a small XML reader), fuzz-tested. **For the `imports` workstream:** import an
`.svg` as a vector shape clip by reading the file text and issuing `clip.addShape {type: 'vector', contents:
svgToShapeContents(text).contents}` (set the clip's Motion position where it should go; its size is the document's
`width` × `height`); show `warnings` to the user. MCP `svg_to_shape` does exactly this.

## 8. Agents (MCP `apps/mcp/src/tools/shapes.ts`) and expressions

Tools: `add_vector_shape`, `svg_to_shape` (dryRun converts only), `list_shape_presets`, `get_shape` (tree, values,
keyed fields, path vertices at a time), `add_shape_items`, `update_shape_item`, `remove_shape_items`,
`move_shape_item`, `group_shape_items`, `duplicate_shape_item`, `edit_shape_path`, `convert_shape_to_vector`;
`SHAPES_GUIDE` in the server instructions; `get_timeline` prints a vector shape as its item outline; the agent schema
carries the per-type field catalogue. 21 presets (`vector/presets.ts`): rounded rectangle, circle outline, star,
hexagon, burst badge, ring, gradient orb, lower-third bar, heart, arrow, speech bubble, check mark, plus, draw-on
circle, loading spinner, pulse rings, wobbly blob, wave line, burst lines, marching ants, tapered swoosh.

Expressions (expressions workstream): every number / point / colour item property takes an expression
(`expression.set` on its ParamPath; gradients and paths are refused like masks' paths); the object model follows
After Effects: `content("Group 1").content("Rectangle Path 1").size`, `content("Group 1").transform.position`,
`thisLayer.content(…)`, items by name, index or id, AE match names. Bound in documents and render snapshots
(`mapShapeItemAnimatables`).

Blend modes: groups, fills and strokes take the full clip set (`BLEND_MODES`, keyframes-blend's 32). Interchange:
vector shape clips are reported / pre-rendered as shape clips like every DOM graphic.

## 9. Verification (2026-10-07; 12 cores shared, load 12–18)

Measured with the commands given:

- `REMOTION_E2E=1 pnpm vitest run apps/engine/test/vector-shapes-remotion.e2e.test.ts` (a 720p scene with every
  renderer path: inside stroke, Merge Paths ▸ Subtract ring, Repeater opacity ramp, linear and radial gradients,
  Linear Burn through the canvas compositor, dashed trimmed stroke, Wiggle Paths): golden probes computed from the
  model pass in the still and in the export; **SVG renderer vs canvas compositor: 0 pixels differ by > 3, worst 0**;
  export (path `hybrid`, layer bake + native composite, H.264 CRF 4) vs still: mean |Δ| 0.546/255; on pixels ≥ 8 px
  from any edge 7 of 709 095 differ by > 8 (encoder ringing next to saturated edges), worst 14; the wiggling shape
  differs between frames 5 and 20 in both.
- `REMOTION_E2E=1 … shapes-remotion.e2e.test.ts` (old rectangles / ellipses): passes unchanged.
- `E2E_PORT=49340 pnpm e2e e2e/vector-shapes.spec.ts`: 4/4 (Star tool, Shape Contents edits + undo / redo, Pen
  draw + close + vertex drag, export vs still mean |Δ| < 3); `e2e/shapes.spec.ts` 5/5 and `e2e/masks.spec.ts` 5/5
  unchanged. Program monitor screenshot looked at (`test-results/e2e-vector-shapes/program.png`).
- Unit / component: `packages/project/test/vector/*` (ops ported from EffectCraft + boolean property test,
  commands, stacking semantics, render plan, values, SVG with fuzzing), `packages/expressions/test/shapes.test.ts`,
  `apps/web/test/vector-shapes.test.tsx`.

## 10. Comparison with EffectCraft

Equal: the operator set and algorithms (ported), stacking semantics, Taper / Wave / dashes, radial highlight,
curve-preserving booleans, Convert to Bezier Path, SVG import of paths / paints / gradients. Better: Fill / Stroke
Composite Above implemented; group blend modes composite the group; Repeater composite order matches After Effects;
Wiggle Paths Spatial Phase; gradient midpoints; Premiere's stroke position; 32 blend modes per paint through the shared
kernel; expressions on every item property with AE's `content()` model; one renderer for preview and every export
(measured identical). Different: rasterisation is Chromium's (Skia) instead of tiny-skia; booleans use PathBool.js
instead of linesweeper (EffectCraft's tidy-up kept).

## 11. Limits

- GPU (shader) effects on a vector shape capture its layer box, which is the frame at the default transform: contents
  outside that box are not seen by those effects (After Effects' comp-sized shape layers behave alike).
- Wiggle Paths' noise is ours (Adobe's is undocumented): same parameters and character, not the same random motion.
- SVG import leaves out text, images, filters, masks, clip paths, patterns and markers (reported), draws elliptical
  radial gradients circular and `spreadMethod` reflect / repeat as pad (reported).
- Offset Paths on open paths outlines them with butt ends; Merge Paths closes open paths implicitly (as filled).
- Vertices are edited on path items; parametric rectangles / ellipses / polystars convert first (Convert to Bezier
  Path), as in After Effects.

## 12. Trim Paths animations

Branch `feat/trim-core`. One-click Trim Paths animations for vector shape clips, as undoable document commands
(`packages/project/src/commands/{schemas,handlers}/shape-trim.ts`; the keys, expressions and part layout are pure data
from `vector/trim-animate.ts`). Clean-room design from the public idea of "animate a trim in one click"; no third-party
text, names or icons.

### `shape.animateTrim`

`{clipIds (1…1000), style, reverse?, animateOffset?, durationFrames? (1…100000, default 10, sequence frames),
offsetDegrees? (|x| ≤ 36000, default 180), copies? (2…64, default 4, divide styles only), inOutLag? (0 < x ≤ 1, default
0.5, inOut only), at? (sequence time, default each clip's start), curve? (CubicEase)}` →
`{clips: [{clipId, converted, trimIds (master first), groupIds (groups this run created), partIds (divide: every part,
part 1 first)}], skipped: clipId[]}`.

Path parameter u ∈ [0, 1] runs along each path in its direction (Path Direction honoured); p ∈ [0, 1] is the eased
progress of a segment (keys `from` at the segment start, `to` at its end). D = `durationFrames`, L = `inOutLag` · D,
N = `copies`, s = 100 / N. Visible parts and keys (Start / End in %):

| Style | Visible | Keys | reverse: visible | reverse: keys |
|---|---|---|---|---|
| `in` | [0, p] | Start 0, End 0→100 | [1 − p, 1] | End 100, Start 100→0 |
| `out` | [p, 1] | End 100, Start 0→100 | [0, 1 − p] | Start 0, End 100→0 |
| `inOut` | [tail, head] | End 0→100 over [0, D], Start 0→100 over [L, L + D] | [1 − head, 1 − tail] | Start 100→0 over [0, D], End 100→0 over [L, L + D] |
| `middleIn` | [½ − p/2, ½ + p/2] | Start 50→0, End 50→100 | [0, p/2] ∪ [1 − p/2, 1] | Start 0, End 0→100, linked Offset |
| `middleOut` | [p/2, 1 − p/2] | Start 0→50, End 100→50 | [0, (1−p)/2] ∪ [1 − (1−p)/2, 1] | Start 0, End 100→0, linked Offset |
| `divideIn` | ∪ᵢ [(i−1)/N, (i−1)/N + p/N] | master Start 0, End 0→s | ∪ᵢ [i/N − p/N, i/N] | End s, Start s→0 |
| `divideOut` | ∪ᵢ [(i−1)/N + p/N, i/N] | master End s, Start 0→s | ∪ᵢ [(i−1)/N, i/N − p/N] | Start 0, End s→0 |

- **inOut** is two segments of length D each, the tail starting L after the head (total D + L). `inOutLag` 0 is refused
  (`E_SCHEMA`): head and tail would move together and nothing would ever be visible.
- **Linked Offset** (reverse middle styles): the trim keeps [0, End] and its Offset carries the expression
  `value + -1.8 * content("<trimId>").end` (by item id): −1.8 · End degrees = minus half of the visible length
  (360° = one length, §5), so the visible piece is centred on the path start; on closed paths it stays one piece
  across the start (§5), on open paths it shows as two pieces at the ends. `value` keeps the property keyable.
- **Divide**: the clip's top-level contents are wrapped in one group unless they already are one group; that group
  becomes "Part 1" and is duplicated into "Part 2…N" (fresh item and keyframe ids). Part 1 ends with the master trim;
  part i (i ≥ 2) ends with a trim whose Start / End are `content("<part1Id>").content("<masterId>").start|end` and
  whose Offset is `value + content("<part1Id>").content("<masterId>").offset` with value (i − 1) · 360 / N: N
  pieces of 1/N draw on / off together. A clip may hold at most 20 000 items after dividing (`E_LIMIT`).
- **animateOffset**: the master's Offset is keyed 0 → `offsetDegrees` (−`offsetDegrees` with `reverse`) over the
  whole animation (D, or D + L for inOut); with a linked Offset the expression adds to the keyed value; divide parts
  follow it through their expression.
- **Eases**: entering motion (`in`, `middleIn`, `divideIn`, inOut's head) cubic-bezier(⅓, ⅓, ⅔, 1), exiting motion
  (`out`, `middleOut`, `divideOut`, inOut's tail) cubic-bezier(⅓, 0, ⅔, ⅔); the Offset segment uses the style's curve
  (constant speed for inOut). `curve` replaces every animated segment's curve. Curves become key eases with
  `cubicToEases` (bezier interpolation; the outer sides of the two keys are linear).
- **Timing**: keys are at `at` and `at` + segment offsets in sequence frames, converted to the clip's content time
  with `contentTimeAt` (speed scales the spacing; fractional frames — e.g. L = 2.5 — are kept exact in flicks). On a
  reversed clip content time runs backwards: the keys swap and the curve is mirrored (cubic(1 − x2, 1 − y2, 1 − x1,
  1 − y1)) so the on-screen motion is the same. A key before the clip's content start is refused (`E_INVALID_PARAM`).
- **Placement and re-runs**: the trim goes last in the top-level contents (it trims every path above it in the shape,
  §4). Running the command again replaces the animation instead of stacking: earlier parts are found by the exact part
  expressions above (no marker in the document, so it survives renames and saving), the linked parts are removed and
  part 1's master trim is reused; otherwise a trim that is the last top-level item is reused (its id, name and
  Trim Multiple Shapes mode kept, re-enabled; its Start / End / Offset values, keys and expressions replaced — this
  also applies to a static trim the user placed last). After a divide, a non-divide style leaves part 1 as a plain
  group named "Part 1" (the picture is the same; the original group name is not restored).
- **Clips**: rectangle / ellipse clips are converted to vector shapes in the same transaction
  (`convertShapeClipToVector`, the `shape.convertToVector` path; `converted: true`). Other clips and vector shapes
  without path items are skipped with one `W_TRIM_SKIPPED` warning naming them and the reason; when no clip applies
  the command is refused (`E_INVALID_PARAM`); a clip on a locked track refuses the command (`E_TRACK_LOCKED`).

### `shape.reversePathDirection {clipIds}`

Toggles Path Direction on every rect / ellipse / polystar / path item at every depth (reversed → absent = normal, so
toggling twice restores the contents exactly). Returns `{clips: [{clipId, paths}]}`; rectangle / ellipse and non-shape
clips are skipped with `W_TRIM_SKIPPED` (convert first), none applicable → `E_INVALID_PARAM`; locked → `E_TRACK_LOCKED`.

### `shape.addLine`

`{orientation: 'horizontal'|'vertical', length? (default 60 % of the frame width / height), strokeWidth? (default 8),
color? (RGBA 0…1, default white), at? (default 0), durationFrames? (default 5 s), trackId? (default: the top video
track when free over the range, else a new top track — the camera / light rule), name? (default "Line"), ref?,
sequenceId?}` → `{clipId, pathId, strokeId, length}`. Composes `clip.addShape {type: 'vector'}` with an open path
from −length/2 to +length/2 through content (0, 0) and a stroke only: content (0, 0) is the layer centre, the default
anchor and position, so the anchor sits on the line's centre with no offset.

### Verification and limits

Measured 2026-10-20 on the shared host (load average ≈ 65), `--maxWorkers=1`:

- `pnpm exec vitest run packages/project/test/vector/trim-animate.test.ts packages/expressions/test/trim-animate.test.ts`:
  91/91. The project suite checks exact values, key times, interpolation and eases for every style × reverse ×
  animateOffset (28 cases, expectations written out from the table above), divide layout (fresh unique ids, master in
  part 1, part expressions by id), `at` / duration / lag / offset / `curve`, speed and reversed clips (keys in
  content time, mirrored curve; set on the document directly because shape clips have no speed control today),
  re-runs for all 7 × 7 style pairs × reverse (same contents as a fresh run, ids aside; one trim or N, never
  stacked), reuse of a last user trim (id, name, mode), merging parts back next to added items, conversion of
  rectangle clips, `W_TRIM_SKIPPED`, `E_INVALID_PARAM`, `E_NOT_FOUND`, `E_TRACK_LOCKED`, `E_LIMIT`, schema refusals,
  undo (the earlier snapshot is untouched) / redo (the same contents), `checkInvariants` = [] after edits; Path
  Direction toggling and the trimmed geometry following the direction; `shape.addLine` geometry, anchor, defaults
  and refusals. The expressions suite evaluates the geometry through `evaluateVectorShape` with the document's
  expressions bound (`bindDocumentExpressions`) and measures the visible u-intervals at p = 0, ¼, ½, 1 (inOut also
  past D) on an open line and a closed square, with and without animated Offset, and for two paths Simultaneously /
  Individually; the default eases follow `evaluateEaseCurve`; re-running each style pair draws the same geometry
  as a fresh run.
- **Preview / export**: the export path renders shape clips from the JSON render snapshot, binding its expressions
  in the renderer (`bindSnapshotExpressions`, §1); the test builds the snapshot, round-trips it through JSON, binds
  it and draws the layer at its resolved content time: identical SVG path data to the document-bound (preview)
  evaluation for the linked-offset and divide styles at six frames, and different from the unbound document (the
  expressions do run). A real Remotion / layer-bake export run was **not** performed on this host (load ≈ 65;
  `REMOTION_E2E=1 …vector-shapes-remotion.e2e.test.ts` needs the Remotion bundle and Chromium); this change adds no
  renderer code — the trims, keys and expressions it writes are the ones that suite already renders.
- `pnpm --filter @jasper/project typecheck`, `@jasper/expressions`, `@jasper/mcp`: pass. Existing
  `packages/project/test/vector/{commands,evaluate}.test.ts` and `packages/expressions/test/shapes.test.ts`: pass.

Limits: part copies duplicate the whole group, so expressions inside the copied contents that reference items by id
still point at part 1's items; the part expressions address part 1 at the top level (moving the parts into another
group breaks the link, and then a re-run no longer recognises them); if the user deletes every part except part 1,
part 1's trim stays and a non-divide re-run adds a top-level trim; keys follow `contentTimeAt` (speed and reverse),
not a time remap.
