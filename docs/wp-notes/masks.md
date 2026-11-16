# wp `masks` — masks, mask tracking, auto-trace and track mattes

Branch `feat/masks`. Specs: S03 §17 (MSK-001…004). Ports: `licenses/ported/masks.md` (EffectCraft `path`, `track`,
`render/masks`; FilmCraft `render/mask`, `gpu/mask.wgsl`, `engine/masks`, Track Matte Key).

## 1. What exists now

| Feature | Where |
|---|---|
| Shared Bézier path toolkit (vertex + relative tangents, flatten, split, insert / remove / convert vertices, nearest point, transforms, SVG) | `packages/project/src/path/model.ts` |
| Smart path interpolation (different vertex counts) | `packages/project/src/path/interp.ts` |
| Auto-trace (marching squares → Douglas–Peucker → cubic fit), pure | `packages/project/src/path/trace.ts` (`tracePaths`, `traceFieldOf`) |
| Mask schema (optional fields) | `packages/project/src/schema/mask.ts`; `clip.masks` (Opacity masks), `effect.masks` (per-effect masks) |
| Mask model, defaults, mode algebra, export route | `packages/project/src/masks/model.ts` |
| Coverage definition + tiled CPU rasteriser + data packing | `packages/project/src/masks/raster.ts` |
| GL rasteriser (GLSL ES 3.00) | `packages/project/src/masks/glsl.ts`, host side `packages/compositions/src/fx/mask.ts` |
| Mask tracking plan / result → keys | `packages/project/src/masks/tracking.ts`; engine tracker `apps/engine/src/tracking/mask.ts` |
| Track mattes | `packages/project/src/masks/track-matte.ts`, Track Matte Key (`registry/fx/premiere-adjust-color-keying/keying.ts`), `packages/compositions/src/fx/matte.ts` |
| Commands | `packages/project/src/commands/{schemas,handlers}/mask.ts` |
| Effect Controls UI | `apps/web/src/masks/{MaskList,MaskControls}.tsx`, `apps/web/src/panels/effectControls/items.ts` |
| Program monitor editing | `apps/web/src/masks/{MaskOverlay.tsx,geometry.ts}` |
| UI commands / keys | `apps/web/src/commands/masks.ts`, `keymap-defaults.ts` |
| Engine: auto-trace route, mask track jobs | `apps/engine/src/routes/masks.ts`, `apps/engine/src/tracking/{mask,service,worker}.ts` |
| Native export of Opacity masks | `apps/engine/src/export/stream/{plan,kernel,pool,run}.ts` |
| MCP tools | `apps/mcp/src/tools/masks.ts` (`MASKS_GUIDE` in the server instructions) |

## 2. Model

```ts
Mask = {
  id: 'msk_…', name: 'Mask (1)', shape?: 'ellipse' | 'polygon' | 'bezier',
  mode: 'none' | 'add' | 'subtract' | 'intersect' | 'lighten' | 'darken' | 'difference',
  inverted: boolean,
  path: Animatable<BezierPath>,   // { closed, vertices: [{ p, in, out }], feather?: FeatherPoint[] }
  feather: AnimNumber,            // layer px, ≥ 0, default 10
  opacity: AnimNumber,            // 0..100, default 100
  expansion: AnimNumber,          // layer px, default 0
  featherFalloff?: 'smooth' | 'linear', trackMethod?: 'position' | 'position-rotation' |
  'position-scale-rotation' | 'perspective', locked?: boolean,
}
```

- **Coordinates.** Paths are normalised to the clip's intrinsic box (0..1; MSK-001), so a replaced / resized source
  keeps the shape; feather, expansion and feather-point radii are layer pixels. Masks are in layer space (before
  Motion), so Motion moves them with the clip (Premiere).
- **Where.** `clip.masks` = the Opacity masks of a visual clip (cut the layer out after its effects). `effect.masks` =
  Premiere's per-effect masks on every *clip* video effect (not track / master effects, not the corner pin, which is
  the layer geometry): the effect applies only inside them (`mix(input, effected, coverage)`).
- **Schema rule.** All fields are optional (absent = no masks); no schema version bump. `checkInvariants` checks ids
  (`msk` prefix), path structure, ranges, modes, masks only on clip effects, Track Matte tracks (exist, not own track,
  no cycles); `repairDocument` drops invalid masks and clears bad track-matte references.
- **Animation.** Mask properties are ordinary animatable params at `["mask", maskId, "path"|"feather"|"opacity"|
  "expansion"]` (`param.set`, `param.setAnimated`, `keyframe.*`, graphs, clipboard id refresh, split / duplicate
  re-identification). Path values are interpolated by the shared evaluator: equal vertex counts → vertex-wise (Premiere),
  different counts → smart correspondence (port of `interp.rs`: arc-length vertex insertion, winding fix, shape-context
  cyclic matching; cached per key pair). Keyframe timing (linear, Bézier eases, hold, auto-Bézier speed by RMS vertex
  displacement) is the shared one.

## 3. Coverage (one definition, three implementations)

Per mask, at a pixel centre (canvas px), with the outline flattened to ≤ 0.05 px chord error:

```
sd  = signed distance to the outline (> 0 inside, nonzero winding), |sd| ≤ band
s   = sd + expansion
ro, ri = outer / inner radius of the variable feather at the nearest outline position (feather points)
lo  = max(ro + feather/2, ½),   hi = max(ri + feather/2, ½)
u   = clamp((s + lo) / (lo + hi), 0, 1)
c   = linear ? u : u + (smoothstep(u) − u) · clamp(lo + hi − 1, 0, 1)
m   = opacity · (inverted ? 1 − c : c)
acc = first mask's start (1 for subtract / intersect / darken, else 0); acc = clamp(combine(mode, acc, m), 0, 1)
```

- feather 0 = the analytic box-filtered edge (exact for straight edges; antialiased everywhere);
- Mask Feather = a symmetric ramp `feather` px wide centred on the expanded edge (Premiere's feather; corners round);
- feather points (AE's Mask Feather tool; port of `feather.rs`) add outward (radius > 0) or inward (< 0) width,
  interpolated along the arc with tension (smoothstep at 0, linear at 1), wrapping on closed paths;
- modes are AE's: Add `a + m − am`, Subtract `a(1 − m)`, Intersect `am`, Lighten `max`, Darken `min`, Difference
  `a + m − 2am`; None and open (unclosed pen) paths are ignored.

Acceleration (same algorithm on GPU and CPU): 16 px tiles list the edges within `band` of them; each tile stores, per
row, the winding of the edges not in its list crossing the row left of the tile. The packed RGBA32F texture is the
same bytes for `rasterizeMaskPack` (CPU) and the shader.

## 4. Rendering

- **Preview + Remotion renders** (`packages/compositions`): a layer with an active Opacity mask, or an enabled effect
  with an active mask, takes the fx chain (like a GPU-transition side): masked steps (GPU effects, colour runs —
  a masked colour effect is its own run —, CSS filters, crop, flips) are wrapped in `fxMasked` (scratch canvas + mix
  pass); the Opacity masks are the last step (`fxMaskApply`). One shared WebGL2 host; programs compiled once; packed
  data cached by content and uploaded only when it changes. DOM layers (text, shapes, motion graphics) run it through
  HTML-in-Canvas. Without WebGL2 / HTML-in-Canvas the preview falls back to a CSS `mask-image` of the CPU coverage
  (same numbers) for Opacity masks; per-effect masks then show the chip of the bypassed chain; renders never fall
  back (they cancel with `WEBGL_UNAVAILABLE` / `FX_LAYER_UNSUPPORTED`).
- **Native export.** `maskExportRoute(clip)`:
  - `stream` — Opacity masks only, on video / still / solid / composition / fframes motion-graphic layers: the layer
    goes through the sub-pixel streamed kernel; per frame the coverage is rasterised (CPU, the definition above) at the
    decoded picture's size and multiplies its alpha before the warp — exactly what the composition does to the layer
    canvas before its CSS transform. Static masks rasterise once (cache by geometry key).
  - `bake` — effect masks, corner-pinned layers, animated images, DOM layers: the layer-bake extension renders the
    whole layer through the composition (hybrid). With effect masks the bake keeps the colour effects too (a masked
    colour effect mixes inside the stack; ffmpeg could only grade the finished layer). The warp stage no longer claims
    masked layers.
  - Without the layer bake a `bake` route is a planner blocker (Remotion path) — never a silent drop.
- **Track mattes.** Track Matte Key has `matteTrack` (a video track id; the Effect Controls row is a track picker) plus
  Composite Using (Matte Alpha / Matte Luma) and Reverse (Premiere's parameters). The matte is the matte track's
  composite at the same sequence time (each clip with its effects, masks, Motion and opacity), placed in sequence
  space and sampled through the fill layer's layer → sequence map (AE semantics: the fill's Motion moves the fill
  under a fixed matte; see §8). Hidden tracks (Toggle Track Output off) still work as mattes: the snapshot carries
  them in `RenderSnapshot.matteTracks` and the composition renders their clips into the matte only. Implementation:
  each matte-track clip's chain ends with a matte tap (`fxMatteTap`) delivering its picture to a `TrackMatteHub`, which
  composites the frame on the GPU (premultiplied over, projective placement); fill layers bind it as `u_matte`. Renders
  hold a `delayRender` until every clip of the matte track delivered *this* frame (deterministic in any frame order).
  Export: a fill whose key reads a track renders on the Remotion path (the planner names the Track Matte Key; a layer
  bake draws its clip alone, without the matte track, so it would drop the matte — the earlier claim that bakes
  include matte tracks was wrong). Without a track the old `matte` media param still works; with neither (Matte =
  None, `set_track_matte {matteTrack: null}` removes the key) the layer passes through unchanged, also with Reverse.
  Decontaminate Edges (clean plate track or estimated background) restores the foreground colour of soft edges:
  [track-matte-holdout.md](track-matte-holdout.md).

## 5. Editing

Effect Controls (Opacity and every video effect, Premiere's layout): three tool buttons (ellipse, 4-point polygon,
free draw Bézier) + Auto-trace; per mask a header (twirl, name, mode, Inverted, Track backward / back 1 frame /
forward 1 frame / forward, tracking method, progress + stop, delete) and four property rows (Mask Path with its
vertex count, Mask Feather, Mask Opacity, Mask Expansion) with stopwatches, keyframe lanes and graphs. Clicking a
header selects the mask for the monitor.

Program monitor (`MaskOverlay`):

| Gesture | Effect |
|---|---|
| click an outline of the selected clip's masks | select that mask |
| drag a vertex / Shift-click | move the selected vertices / add to the selection |
| Alt-click a vertex | convert smooth ↔ corner (Premiere's Convert Vertex) |
| Ctrl/Cmd-click a vertex | delete it (Premiere) |
| click on the path | insert a vertex there (shape unchanged; in every keyframe) |
| drag a tangent handle (Alt: break) | edit the tangent; the opposite one mirrors its direction |
| drag inside the mask | move the whole mask |
| corner squares / outside a corner | scale about the centre / rotate |
| square / circle handle on the guides | Mask Expansion / Mask Feather (guides drawn at the expanded edge and at expansion + feather/2) |
| pen (Effect Controls) | click adds vertices, drag pulls out tangents, click the first vertex closes |
| Delete / Backspace (Program focused) | delete the selected vertices (a closed mask keeps 3), else the mask |
| Escape (Program focused) | stop the pen / deselect |

Every drag is one gesture (one undo step) writing the path at the playhead (a keyframe when animated).

UI commands (agent-exposed): `mask.trackForward`, `mask.trackBackward`, `mask.trackForwardOneFrame`,
`mask.trackBackwardOneFrame` (Premiere has no default keys for them), `mask.deleteSelection` (Delete / Backspace in
the Program monitor), `mask.escape` (Escape). The keymap conflict tests pass.

## 6. Commands, tracking, auto-trace, MCP

- Commands: `mask.add {clipId|effectId, shape, path?, …}`, `mask.remove`, `mask.update` (name, mode, inverted,
  falloff, track method, locked), `mask.reorder`, `mask.duplicate` (copy / paste onto another clip or effect),
  `mask.editPath {maskId, at?, allKeyframes?, ops}` (set, moveVertices, setVertex, transform, convert,
  insertVertex, removeVertices, appendVertex, setClosed, add/set/removeFeatherPoint — topology ops apply to every key),
  `mask.setPathKeys` (bulk keys: tracking).
- Mask tracking: engine `track` job of kind `mask` (`POST /api/tracking/track`, `reference.polygon` in media px,
  `options.maskMethod`), frame to frame: Shi–Tomasi features inside the outline → pyramidal LK + forward–backward
  check → Position (median translation), Position & Rotation (RANSAC rigid), Position, Scale & Rotation (RANSAC
  similarity, Umeyama refit) or Perspective (OpenCV RANSAC homography, similarity fallback). Result: one homography per
  source frame (stride 9). `planMaskTrack` / `maskKeysFromTrack` turn it into Mask Path keys (one History entry), stopping
  at the first lost frame. Job progress shows in the mask header and the Jobs panel; Stop cancels the job.
- Auto-trace: `POST /api/masks/trace {mediaKey, frame, width, height, channel alpha|luma|r|g|b, threshold, invert,
  tolerance, minArea, cornerRoundness}` → normalised paths with nesting depth (holes → subtract masks).
- MCP (`apps/mcp/src/tools/masks.ts`): `list_masks`, `add_mask` (normalised or px units), `edit_mask`,
  `remove_masks`, `track_mask`, `auto_trace_mask`, `set_track_matte`. Everything else through `apply_commands`.

## 7. Verified behaviour (tests)

| Test | What |
|---|---|
| `packages/project/test/masks-path.test.ts` | path model, interpolation (correspondence finds the rotation, paths don't cross, rigid in-betweens turn), keyframe evaluation of paths, auto-trace (disc + square with hole: 3 loops, IoU ≥ 0.96; min area, threshold, borders) |
| `packages/project/test/masks-raster.test.ts` | exact box coverage, ellipse area within 0.2 %, symmetric feather, expansion / inversion / opacity / modes, tiled = brute force over random stacks (≤ 1e-4), variable feather |
| `packages/project/test/masks-commands.test.ts` | every command, ParamPaths, keys, topology edits in every key, split/duplicate ids, snapshot, locked tracks, invariants + repair, track mattes (hidden track in `matteTracks`, cycle / own-track refusal, repair) |
| `packages/compositions/test/masks-gl.test.ts` | GL coverage = CPU rasteriser within 1/255 (hard, feathered/expanded/inverted in a padded canvas, every mode stacked at ½ scale, variable feather); `fxMaskApply` / `fxMasked` in Remotion's effect chain |
| `packages/compositions/test/masks-render.e2e.test.ts` (REMOTION_E2E) | Remotion still vs CPU definition ≤ 2/255 over every pixel; masked effect; Track Matte Key on a hidden track: alpha, luma (½ grey → ½), reverse |
| `apps/engine/test/masks-export.test.ts` | routing (Opacity masks native, effect masks never native); native export of stacked masks = plate + (white − plate)·coverage ≤ 3/255 on every pixel; keyframed path + Motion |
| `apps/engine/test/masks-track.test.ts` | mask tracking ≤ 0.6 px over 24 frames (position, similarity, perspective), backward, document round trip, validation; auto-trace route |
| `apps/mcp/test/masks.test.ts` | MCP tools through the protocol |
| `apps/web/test/masks-ui.test.tsx` | Effect Controls tools / header / rows / stopwatch / delete; monitor geometry |
| `e2e/masks.spec.ts` | real app: ellipse tool, monitor vertices, vertex drag = one undo step, pen, masked preview, native export pixels |

## 8. Decisions and comparison with the references

- **Track matte semantics.** Premiere applies the fill clip's Motion to the matte as well (a long-standing complaint:
  "if I zoom my clip to 120 %, … so does the matte", community.adobe.com idea 13515591); After Effects keeps the matte
  fixed. We follow After Effects / FilmCraft (`apply_matte` maps layer px through `layer_to_output`): the matte stays
  in sequence space. Documented as a deliberate improvement.
- **Feather** is centred on the edge (Premiere: the feather handle drags a guide outside the path; the falloff spans
  both sides). Default 10 px (FilmCraft, Premiere). Expansion grows by signed distance (rounded corners), like
  Premiere's expansion guide.
- **Modes** are After Effects' (Premiere masks only add / invert); a lone Intersect / Darken mask shows its inside
  (FilmCraft's start values; EffectCraft's start of 0 would show nothing).
- **Tracking methods**: Premiere offers Position; Position & Rotation; Position, Scale & Rotation (default) — plus our
  Perspective (homography). Frame to frame like Premiere; the lost frame stops the track and is reported.
- **Equal or better than the references:** EffectCraft rasterises masks on the CPU with tiny-skia + Gaussian blur
  feather; FilmCraft has an analytic SDF rasteriser (CPU + WGSL) without variable feather or path smart interpolation.
  We have the SDF definition on GPU and CPU (bit-compatible packing, parity-tested), variable feather in both, smart
  interpolation in the shared evaluator, auto-trace, four tracking models, per-effect masks in preview, Remotion and
  native/hybrid export, and track mattes reading hidden tracks.
- **Not Adobe-measured** (research, not measurement, brief §3b). Sources: Adobe Help "Create clip masks" (helpx.adobe.com/
  premiere-pro/how-to/create-clip-masks.html: feather handle, expansion guide, inverted, multiple masks, default
  tracking method), Adobe Help "Add Track Matte Key" (helpx.adobe.com/premiere-pro/how-to/add-track-matte-key.html:
  Matte = a track, Composite Using Matte Alpha / Matte Luma), Adobe community threads on vertex modifiers (Alt converts,
  Ctrl-click deletes, clicking the path adds), After Effects Help "Track mattes and traveling mattes" and mask modes;
  Belongie, Malik & Puzicha 2002 (shape contexts); Schneider 1990 (cubic fitting).

## 9. Limits

- The preview CSS fallback (no WebGL2 / no HTML-in-Canvas) covers Opacity masks only and does not draw coverage
  outside the layer box; per-effect masks and track mattes need the GPU chain (renders always have it).
- Transitions on a matte track are not applied to the matte (the sides' pictures are composited as they are); blend
  modes of matte-track clips composite as Normal into the matte.
- Mask motion blur (AE's) is not implemented (Premiere has none).
- Auto-trace reads media pictures (video, still, animated image), not rendered DOM layers.
