# spatial-points — curved (spatial Bézier) motion paths on effect point params

Branch `feat/pp-spatial-points` (Premiere port). Before this work only Motion's Position / Anchor Point (and
Corner Pin corners, puppet pins) carried spatial paths. Effect `point` params (`fxParam.point`, values normalised to
the layer box) had no `spatial` flag, so the commands refused spatial data on them and the user's Transform /
Offset motion paths could not be represented.

## 1. Research

### Which effect params are positions

- **After Effects help, "Assorted animation tools ▸ Motion paths"**
  (helpx.adobe.com/after-effects/using/assorted-animation-tools.html): "When you animate spatial properties
  (including Position, Anchor Point, and effect control point properties), the motion is displayed as a motion path";
  "You can change the shape of a motion path by changing the spatial interpolation methods for its keyframes". The
  same page pastes paths "into the Position property of an effect control point". So in After Effects *every* effect
  control point is a spatial property with a motion path, not only the transform-like ones.
- **After Effects scripting, `PropertyValueType.TwoD_SPATIAL`** (ae-scripting.docsforadobe.dev/property/property/):
  point properties are "spatial" value types; their keys have spatial tangents (`keyInSpatialTangent`,
  `keyOutSpatialTangent`). *Assumption, labelled:* After Effects effect points are stored in layer pixels, so its
  arc length and Auto Bezier lengths are pixel measures.
- **The user's Premiere projects** (`/tmp/prproj-inspect/json`, 31 projects, read-only; scripts kept out of the repo).
  Every keyframe of a `PointComponentParam` carries a `spatial` record (`mode`, `in_tangent`, `out_tangent`):
  - 39 481 point keys: Transform (`AE.ADBE Geometry`) Position 15 915, Offset Shift Center To 10 474, Transform
    Anchor Point 10 340, Transform (`Geometry2`) Position 2 118, Motion Position 632, `Geometry2` Anchor Point 2.
  - Keys with non-zero tangents: Transform 7 174 + 1 900, Offset 6 799, Motion 621.
  - Tangents are stored **normalised**, in the value's own units (an offset of 0.0469 = 4.69 % of the frame height).
  - Every interior key with tangents (8 182 keys: Transform 2 172, Offset 5 880, Motion 130) has exactly the
    Catmull-Rom tangents `out = (next − prev) / 6`, `in = −out`. Premiere's Auto Bezier spatial rule is therefore the
    uniform rule, which is affine-invariant: its curve does not depend on the frame's aspect ratio.
  - The stored temporal speeds of diagonal point segments equal their length in **normalised** units per second
    (chord or arc), not in pixels. *Inference, labelled:* Premiere times its spatial segments by normalised arc length.
    No Adobe document states it; it could not be checked against a live Premiere render.

**Decision.** Every `fxParam.point` (the params with an on-canvas crosshair: Transform Position / Anchor Point, Offset
Shift Center To, Mirror Reflection Center, Spherize / lens / zoom / light / gradient centres, Lightning control points,
simulation producer positions, …: 182 params in the default registry) is a spatial point, `spatial: 'auto-bezier'` for new keys like Motion's
Position. Corner Pin corners stay `spatial: 'linear'` (tracker output) and gain the same units. Non-position vec2s
(Lumetri colour wheels, offsets in px) are not spatial. Transition params built with `fxParam.point` are stripped of
the flag (`shaderTransitionParams`): transitions have no motion path.

### Units — why lengths are measured in layer pixels

An effect point is normalised to its layer box (x · width, y · height). The curve is unaffected by that: an affine map
of a cubic Bézier is the Bézier of the mapped control points, so tangents stay in value units and a path drawn round
on a 16:9 layer *is* round. What depends on the metric is every **length**: arc-length timing (Linear temporal =
constant speed), After Effects' proportional Auto Bezier handles (⅓ of each neighbouring chord), the length a
Continuous Bezier handle keeps, temporal auto-bezier speeds and roving distances. Measured in normalised units those
are anisotropic on a non-square layer (the e2e test below measures a 43.9 px detour on 1280 × 720).

JasperEditor measures them in the layer box's pixels, as After Effects does for its pixel-valued effect points and as
Motion's Position (sequence px) already did. This deliberately differs from the timing Premiere's stored speeds imply
(normalised units, §1); there is no Premiere project importer, so no imported project changes, and the shapes agree
(Premiere's uniform Auto Bezier is metric-independent).

## 2. Model

- `ParamSpec.spatialMetric?: 'layer-box'` (`registry/effects.ts`), set by `fxParam.point` and Corner Pin;
  `PropertySpec.spatialMetric` mirrors it for effect params. No persisted field is added: effect point keys use the
  existing `Keyframe.spatial` (tangents in value units). See the "Fields added in v8" row in `docs/project-files.md`.
- `SpatialMetric = [px per unit x, px per unit y]`; `paramSpatialMetric(spec, box)`, `effectParamMetric(fx, name,
  box)` (box = the clip's intrinsic box; the sequence frame for track / master effects), `evaluateEffectParam`.
- `activeMetric`: absent, invalid (non-finite / ≤ 0) and isotropic metrics are ignored, so documents without effect
  points, square boxes and straight segments evaluate bit-identically (property test).

## 3. Evaluator (`keyframes.ts`, `keyframes-spatial.ts`)

`EvaluateOptions.metric`. With a metric, the keys around the segment (`metricWindow`: keys i − 2 … i + 3, enough for
every tangent and first/last test the segment reads) are copied in pixels (`keysInMetric`); the progress
(`segmentProgress`, temporal auto-bezier), the curved segment and its arc-length point are computed there and the
point is mapped back (`fromMetric`); a straight segment is the plain lerp of the stored values at that progress.
Roving runs use the whole list in pixels (cached per array). `effectiveTangents`, `spatialSegmentLength`,
`autoSlope`, `segmentShape`, `setSpatialMode`, `setTangents`, `refreshAutoTangents`, `retimeRoving`, `stopRoving`
take the metric too.

## 4. Commands

`resolveTarget` gives effect param targets their `metric`; `keyframe.add` / `update` / `setSpatialInterpolation` /
`setTangents` / `setRoving` / `move` / `remove` / `simplify` / `prune`, `param.set` / `setAnimated`, `effect.add` with
pasted animations, `clip.pasteAttributes`, `keyframe.paste` and `effect.applyPreset` refresh Auto Bezier caches,
roving times and auto-bezier eases with it (`finish(anims, metricOf)`, `MetricMap`). Refusals are unchanged
(`E_INVALID_PARAM` "… is not a point property" for numbers, wheels and transition params). Undo / redo are document
swaps (tested).

## 5. Every consumer

| Consumer | How |
|---|---|
| Preview, Remotion, hybrid export (GPU effects such as Transform are rendered by the compositions), native warp stage (Corner Pin) | `resolveLayerProps` → `evaluateEffectParam` with the clip's intrinsic box; sub-frame samples (`fxParamsAtFn`, motion blur, time remaps) get the same `metricOf` |
| Expressions | the property's options carry the metric (`world.ts`), so `value`, `valueAtTime`, `velocity`, `speed` follow the rendered path; `velocity` / `speed` stay in the property's units (normalised per second), consistent with `value` |
| Effect Controls values, graphs, timeline lanes | `resolvePropertyAt` returns the `metric` it evaluated with; the graph editor and lanes sample with it. The velocity graph shows an effect point's speed in layer px/s |
| Program monitor | the focused effect's point params with ≥ 2 keys draw a motion path through the layer map at the playhead (dots per frame, key squares, Bezier handles): key drags → `keyframe.update`, handle drags → `keyframe.setTangents` (Alt breaks continuity), Pen / Ctrl converts vertices, one undo entry per drag. Corner Pin corners map through Motion only (where the box corners go), other points through the full layer map like their crosshair |
| Effect Controls ▸ Spatial Interpolation | offered for these keys through `PropertySpec.spatial` (no shortcut added) |
| Simplify keyframes | effect points are evaluated with their metric and their deviation is measured in layer px (`unit: 'px'`; previously in normalised units, where 0.1 meant 10 % of the box) |
| Presets | preset keys carry `spatial` (Motion and effect points); relative Motion scales tangents with the values; a reversed target clip swaps in / out |
| Paste | `keyframe.paste` and pasted effects keep `spatial` (and the Auto Bezier rule `auto`, which `effect.add` used to drop) |
| MCP | `get_motion_path` / `set_spatial_interpolation` take `effect {effectInstanceId, param}`; the guide documents the units |

**Interchange.**

- **FCPXML.** `curve (linear | smooth) "smooth"`: "whether the value changes smoothly over the keyframe, or
  linearly" (FCPXML 1.10 DTD, developer.apple.com/documentation/professional-video-applications/document-type-definition);
  Final Cut's viewer offers Linear / Smooth on motion-path keyframes (support.apple.com/guide/final-cut-pro/verfc8a4bdc).
  For point properties (Motion Position / Anchor Point, effect points) `curve` is now the key's spatial interpolation
  (Linear ↔ linear, others ↔ smooth; read back as Auto Bezier). There is no handle data: Bezier / Continuous handles
  are reported as lost (warning), curved Auto Bezier paths as approximated by the receiving application (info).
  Animated vec2 effect params are now written with their keyframes (they were written as their static value, without
  a report); other array params with keys report that they are written static. Non-point properties keep the
  temporal-derived `curve` as before.
- **FCP 7 XML.** Point keys are written as values; a curved path is reported (the documented 2D curve data, Apple's
  "Keyframe Interpolation" page, is not mapped).
- **OTIO / JasperEditor metadata** keep the keys whole (tested). **AAF / OMF** carry no effect params.

## 6. Evidence

- `packages/project/test/spatial-points.test.ts`: the curved path against an independent 10⁵-step pixel arc-length
  reference (< 0.25 px), constant pixel speed (spread < 1 %, > 5 % without the metric), a κ-circle on 16:9 stays round
  (radius error < 0.1 px of 300) at constant speed, proportional handles in px, bit-identity property (fast-check),
  registry classification, commands with undo / redo and refusals, paste / presets / simplify, Corner Pin quad.
- `packages/expressions/test/spatial-points.test.ts`, `packages/interchange/test/spatial-points.test.ts`,
  `apps/web/test/motion-path-effect-points.test.tsx`, `apps/mcp/test/integration.test.ts` (effect motion path).
- `apps/engine/test/spatial-points.e2e.test.ts` (REMOTION_E2E=1, measured 2026-10-25 on the shared 16-vCPU VM, other
  agents' jobs running): a Transform with a curved Position path on 1280 × 720 exported through the hybrid path;
  export vs Remotion stills of the composition: 100 % of channel values within 3/255 at 9 frames; square centroid vs
  the evaluator: ≤ 0.31 px; a metric-free reading would be up to 43.9 px away.

- **In the running app** (VM dev stack, ports 47916 / 5186, 2026-10-25): an orange solid with a Transform effect,
  Scale 20 %, Position keys (0.2, 0.75) → (0.5, 0.25) → (0.8, 0.75) at frames 0 / 60 / 120. Focusing the Position row in
  Effect Controls drew the arched effect path over the Program monitor (key squares, Auto Bezier handles on the middle
  key). Dragging the middle key moved it to (0.5, 0.55) and reshaped the path; dragging its out handle made it
  Continuous Bezier with the in handle opposite (the stored tangents are exactly collinear, in normalised units).
  Right-click ▸ Spatial Interpolation showed Continuous Bezier checked; Linear straightened the path; Ctrl+Z restored
  the curve. At frame 30 Effect Controls read (0.3587, 0.6868), and the engine's `render_frame` put the square's
  centroid at (0.3594, 0.6861) of the frame (0.4 px at 640 × 360).

## 7. Limits

- Premiere's timing along curved effect-point segments is inferred to use normalised arc length (§1); JasperEditor
  uses pixel arc length. Not compared against a live Premiere render.
- FCPXML / FCP 7 carry no spatial handles (reported). Puppet pin positions (normalised, spatial) still measure in
  normalised units (they are not effect params; out of scope).
- Changing a clip's media to one of another aspect ratio changes the pixel metric, hence the timing (not the shape)
  of its effect point paths, as it changes the pixels those points address.
