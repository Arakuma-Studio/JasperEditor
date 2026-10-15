# wave1/spatial-motion-path — curved position paths and the Program Monitor motion path

Implements S03:KF-021, KF-030, KF-031 (spatial interpolation of vec2 point keys) and OVL-020 (motion path in
the Program Monitor), plus the Effect Controls ▸ Spatial Interpolation menu and MCP tools. S01:KF-008
("spatial interpolation reserved") is superseded by this package.

## Model (`@jasper/project`, additive)

```ts
// schema/common.ts
export const SPATIAL_INTERPOLATIONS = ['linear', 'bezier', 'auto-bezier', 'continuous-bezier'] as const;
export type Spatial = { mode: SpatialInterpolation; inTangent: Vec2; outTangent: Vec2 };
type Keyframe<T> = { …existing fields…; spatial?: Spatial };   // keyframeSchema: spatial: SpatialSchema.optional()
```

- **Absent `spatial` = `linear`.** Documents written before this package evaluate bit-for-bit as before
  (the evaluator only takes the curved path when a segment's control points leave the chord). No schema
  version bump (S01:MIG-005: additive with a default; `looseObject` keeps the field through older builds,
  which would draw such paths straight). If the integrator prefers a v6 read-only marker, add a no-op
  `v5→v6` step like v2→v3.
- Mode names follow the existing temporal `Interpolation` vocabulary (kebab-case), not S03's `auto`/`continuous`.
- Tangents are **offsets from the key's value in value units** (sequence px for Motion position). Segment
  a → b = cubic Bézier `a.v, a.v + out(a), b.v + in(b), b.v` with the *effective* tangents:
  - `linear` (or absent): zero;
  - `bezier`, `continuous-bezier`: the stored ones (continuity `in = −k·out` is enforced by the commands);
  - `auto-bezier`: keyframes-blend: keys with `spatial.auto: 'proportional'` (every key made Auto Bezier now) use
    After Effects' rule — along `next − prev`, each handle ⅓ of its neighbouring chord, none on the first / last key;
    older keys (no marker): Catmull-Rom `out = (next − prev) / 6`, `in = −out`, a missing neighbour being the key itself;
    **derived on every evaluation** (the stored tangents of auto keys are a cache refreshed by the handlers,
    like the temporal auto-bezier eases).
- `spatial` is only valid on vec2 values with finite tangents: **INV-011** reports anything else.
- Which parameters are points: `PropertySpec.spatial?: SpatialInterpolation` and `ParamSpec.spatial?` (the
  mode new keys get). `transform.position` and `transform.anchor`: `'auto-bezier'`; Corner Pin corners:
  `'linear'` (points, but new keys stay straight like tracker output). Everything else (shape size, Lumetri
  wheels, template/composition vec2 params) is not a point: commands refuse spatial data there and keyframe
  paste drops it. `exportAgentSchema().properties[].spatial` exposes the flag.
- **Default for new keys (KF-021):** keys created by `param.set` (stopwatch semantics), `param.setAnimated` and
  `keyframe.add` on position/anchor are Auto Bezier spatial + Linear temporal. Existing keys never change on
  load. Tracker bakes (`tracker.apply`) still write linear keys.

## Evaluation — still ONE implementation (S03:KF-010)

`evaluate()` keeps its signature. New module `packages/project/src/keyframes-spatial.ts` (exported from the
package index): `effectiveTangents`, `spatialSegment(kfs, i)` (null = straight → plain lerp),
`pathPointAt(seg, s)`, `arcLengthTable` (64 samples, cached by the segment's 8 control coordinates; results
never depend on the cache), `bezierPoint`, `spatialSegmentLength(kfs, i)`,
`spatialModeOf`, and the editing helpers used by the handlers
(`setSpatialMode`, `setTangents`, `refreshAutoTangents`, `newKeySpatial`, `reversedSpatial`).

Temporal progress `p` is computed exactly as before (S01:KF-003/004); on a curved segment it is an
**arc-length fraction** (KF-031), so Linear temporal = constant speed along the curve and eases control the
speed along it. `p` outside [0, 1] (steep Bézier eases) continues along the end tangent.
`autoSlope` (temporal auto-bezier) measures path lengths when a neighbouring segment is curved (S03 §12.2:
Δ is the arc length); unchanged otherwise.

### For the native-export agent

- Sample `evaluate()`; don't re-implement lerp. If `spatialSegment(kfs, i)` returns a curve for position,
  anchor or a corner pin corner, the segment is **not** a linear function of the temporal progress: it can't be
  compiled to `lerp(a, b, ease(u))` expressions. Either emit per-frame values / dense piecewise-linear
  expressions sampled from `evaluate`, or route the clip through the existing Remotion/hybrid path.
- Straight segments (`spatialSegment(kfs, i) === null`) behave exactly as before, so all existing projects and
  tracker output keep compiling the way they do now.

### For the graph-editor agent

- Position/anchor value graphs: x(t) and y(t) are no longer `a + p·(b − a)` on curved segments; sample
  `evaluate()` for the curves.
- Velocity of a vec2 property = speed along the path. The segment distance Δ for "speed = slope × Δ / T" is
  `spatialSegmentLength(kfs, i)` (arc length when curved, chord otherwise).
- Temporal handles still edit `easeIn`/`easeOut`/`interpolation` only; spatial data is separate (`spatial`),
  and `keyframe.update` keeps it unless `spatial` is passed.

## Commands (schemas in `commands/schemas/param.ts`, handlers in `commands/handlers/spatial.ts`)

| Command | Fields | Notes |
|---|---|---|
| `keyframe.setSpatialInterpolation` (new) | `keyframeIds`, `mode` | Linear zeroes tangents; Auto derives them; Bezier/Continuous keep the current effective tangents (a Linear key starts from its auto tangents); Continuous turns `in` opposite `out`, keeping its length. Label "Spatial Interpolation". |
| `keyframe.setTangents` (new) | `keyframeId`, `inTangent?`, `outTangent?`, `breakContinuity?` | Motion-path handle drags. Bezier keys stay independent; other keys become Continuous with the other side opposite (length kept) unless `breakContinuity` (Alt) → Bezier. Both sides given and not opposite → Bezier. Label "Edit Motion Path". |
| `keyframe.add`, `keyframe.update` (additive) | `spatial?: {mode, inTangent?, outTangent?}` | Point properties only (`E_INVALID_PARAM` otherwise). |

Both new commands are registered under owner WP-2D. Contract-Change: additive fields/commands only.

Copy rules (S03 §12.5): split and duplicate deep-copy keys (tangents kept, new ids); `keyframe.paste` keeps
`spatial` on point targets (dropped otherwise), swapping in/out when pasted reversed; `clip.pasteAttributes`
re-timing (`retimeKeys`) swaps in/out when source and target run in opposite directions; `effect.add` with
pasted animations validates and keeps `spatial` on point params; `keyframes.simplify` keeps `spatial` on kept
keys (its solver fits along chords, so curved paths are reduced conservatively — the evaluator-verified
tolerance guarantee still holds); `rescaleClipForSource` scales anchor tangents with the values.

## Program Monitor (OVL-020)

- `apps/web/src/panels/program/motion-path.ts`: `buildMotionPath(clip, fps)` (evaluated position at every clip
  frame + keys with effective handles), `hitMotionPath`, `startMotionPathDrag`, `motionPathDragCommands`.
- `MotionPathLayer.tsx`: one SVG path of 2 px round dots (spacing = speed), 7 px key squares (filled with
  `--pr-keyframe-selected` when selected, dimmed when off the clip), tangent lines + 3 px handles for non-linear
  keys (handles hidden above 200 keys).
- `TransformOverlay.tsx`: the path of the one selected clip (≥ 2 position keys) is memoised on the drawn
  document (rebuilt when the document changes, never per playhead frame — ARC-010), hit-tested before the
  transform handles (the anchor crosshair keeps priority over the square under the playhead). Drags are one
  session gesture each (rAF-throttled `update`, one undo entry, Esc cancels): key square → `keyframe.update
  {value}` (Shift locks an axis), tangent → `keyframe.setTangents` (Alt breaks continuity). Clicking a square
  selects the key (Shift toggles), shared with Effect Controls. Locked tracks draw the path but don't edit.
- Geometry: position values are in the layer's parent space (M(q) = P + R·S·(q − A), so M(A) = P whatever the
  layer's anchor/scale/rotation/corner pin), which is sequence space; `toScreen`/`toSequence` (the gizmo's
  mapping) handle zoom and pan. Clip time mapping (speed, reverse) goes through `contentTimeAt`.

## Effect Controls

Right-click a key ▸ **Spatial Interpolation ▸** Linear / Bezier / Auto Bezier / Continuous Bezier
(`effectControls/SpatialMenu.tsx`, one insertion in `EffectControlsPanel.tsx`'s key menu). Offered when at
least one selected key is on a point property; applies to those keys; a check marks a shared mode.

## MCP (`apps/mcp/src/tools/motion-path.ts`)

- `get_motion_path {projectId, clipId, samples?}`: keys (id, frame, timecode, value, temporal, spatial,
  effective tangents), sampled points, path length.
- `set_spatial_interpolation {projectId, mode, clipId | keyframeIds}`.
- `MOTION_PATH_GUIDE` in the server instructions; `describe_commands` examples for `keyframe.add` (spatial),
  `keyframe.setSpatialInterpolation`, `keyframe.setTangents`.

## Tests

- `packages/project/test/spatial.test.ts`: golden evaluation (independent 10⁶-step arc-length reference),
  bit-exact legacy behaviour, constant speed, easing along the path, overshoot, temporal auto-bezier on curves,
  commands, load of pre-spatial documents + INV-011, split/duplicate/paste/reversed paste attributes, simplify.
- `apps/web/test/motion-path.test.tsx`: overlay drawing under zoom/pan, key and tangent drags (one undo entry,
  Alt), selection, locked tracks, Effect Controls submenu.
- `apps/mcp/test/integration.test.ts`: `get_motion_path` / `set_spatial_interpolation` against a real engine.

## Known gaps

keyframes-blend closed the earlier gaps — Anchor Point paths are drawn (through the layer map at the playhead) and
editable, key drags snap and move every selected key, the Pen tool / Ctrl-click converts vertices and pulls out
handles, reversed pastes land on exact frames with mirrored temporal eases, and Auto Bezier keys follow After
Effects' proportional rule (legacy keys keep Catmull-Rom until re-applied); see
`docs/wp-notes/keyframes-blend.md`. Still true:

- Arc-length mapping is the 64-sample polyline table (error ~1e-4 of the segment length); anisotropic
  rescale of curved anchor paths keeps the path but not the exact timing (arc length is not affine-invariant).
- A Hold segment pasted onto a clip running the other way holds the value of the key it now starts from (a hold
  shows its left key, so a reversed hold cannot be represented exactly).
