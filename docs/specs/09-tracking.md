# Spec 09: Tracking and screen replacement (point / planar tracker, corner pin)

Status: functional spec, v1 (2026-10-01), milestone M2. Audience: the implementers of `wp-m2-track`.
Architecture contracts: `docs/ARCHITECTURE.md` §19.5 (tracking, homographies), §19.6 (native extensions,
warp stage), D-27, D-28.

This spec is original work. The OpenCV scripts in `MatsSmileTrailer/mg/scripts/tracks/` were read as a record of
which techniques held up on real footage (KLT from a fixed reference frame, RANSAC homography, template-match
drift correction, CSS `matrix3d` compositing); nothing is copied.

---

## 0. How to read this spec

Requirement ids: `TRK-NNN` (model, tracker, apply, render), `TRU-NNN` (UI), `TRA-NNN` (agents). Priorities as in
S06. "Plate" = the clip whose picture is tracked (a video clip). "Target" = the clip that follows (a screen
recording, graphic, composition…).

## 1. Goals

1. Track a point or a planar surface (a screen, a sign) through a plate clip as an **engine job**.
2. Apply the track to a target clip as a **corner pin** (4-corner perspective) or as **Motion** follow
   (position / scale / rotation), producing ordinary keyframes the user can correct by hand.
3. Preview in the Player and export on the **native** path (no Remotion fallback for corner pins or keyframed
   Motion).
4. Agents can place trackers, run them and apply them over MCP.

Non-goals (M2): hold-out mattes for foreground occluders (P2: tracked masks), 3D camera solving, mocha-style
spline surfaces, tracking on nested sequences.

## 2. Model

- **TRK-001 (P0)** Trackers live on the plate clip: `VideoClip.trackers?: ClipTracker[]`
  (`packages/project/src/schema/sequence.ts`), ids with prefix `tkr_`. `ClipTracker = {id, name, kind:
  'point'|'planar', reference: {time (content flicks), corners? (TL, TR, BR, BL), point?, patch?, search?},
  samples: TrackerSamples | null, method, smoothing?}`. All geometry is in **media pixels** of the plate's
  source (after its rotation metadata is applied, i.e. the display orientation), before the clip's Motion.
- **TRK-002 (P0)** `TrackerSamples = {start (content flicks of sample 0), step (flicks per source frame), stride
  (8 planar / 2 point), data, confidence}`: dense, one sample per source frame over the tracked span. A lost frame has
  confidence 0 and repeats the last good values.
- **TRK-003 (P0)** Trackers travel with the clip: `clip.split` copies them to both halves (content time is
  unchanged); `clip.duplicate` copies them with new ids; slips/trims never rewrite them (content time,
  ARCHITECTURE §2.3). Swapping the source to a processed version with a different size scales them (S07:PRC-006).
- **TRK-004 (P0)** Commands (schemas in `commands/schemas/tracker.ts`, handlers in `handlers/tracker.ts`):
  `tracker.add {clipId, kind, at, corners?|point?, patch?, search?, name?, ref?}`, `tracker.update`,
  `tracker.remove {trackerIds}`, `tracker.setSamples {trackerId, samples, method, merge?: 'replace'|'span'}`,
  `tracker.apply {trackerId, targetClipId, mode: 'corner-pin'|'transform', components?, range?}`. `setSamples` with
  `span` replaces only the samples covered by the new span (track-from-here corrections).
- **TRK-005 (P0)** Targets record their source: `trackedBy = {clipId, trackerId, mode, effectInstanceId?,
  simplify?: {tolerance}}` on the target clip (visual clips). It is informational (UI, re-apply); the keyframes are
  the truth.

## 3. The tracking job

- **TRK-010 (P0)** `POST /api/tracking/track {mediaKey, kind, reference: {frame, corners?|point?, patch?, search?},
  range: {startFrame, endFrame}, direction, quality}` → `track` job (lane `interactive` when ≤ 300 frames, else
  `user`), `result = TrackResult` (`packages/api/src/tracking.ts`) in **source frames** and media pixels. The client
  converts frames to content flicks (`start = startFrame · flicksPerFrame(mediaRate)`) and commits
  `tracker.setSamples` (one history entry "Track"). Progress events carry the current frame's corners so the Program
  overlay can draw the live track.
- **TRK-011 (P0)** Engine library: **OpenCV.js** (`@techstark/opencv-js`, Apache-2.0, WASM, pinned version) loaded
  in a `worker_threads` worker (the main thread never blocks); frames decoded by ffmpeg to `gray8` rawvideo at the
  tracking resolution (`fast` ≤ 960 px wide, `balanced` ≤ 1280 px, `best` = source width), geometry scaled back to
  media pixels. The licence is listed in About/Licenses.
- **TRK-012 (P0)** Planar tracker (`method: 'klt-homography@1'`):
  1. On the reference frame, detect Shi–Tomasi corners (`goodFeaturesToTrack`, up to 400, quality 0.01, min
     distance 6 px) inside the reference quad (option "Track surroundings": in a ring 5–25 % of the quad size
     outside it — for screens whose content changes).
  2. For every frame in the direction(s), track the reference features **from the reference frame directly** into
     the frame with pyramidal Lucas–Kanade (window 21, 4 levels) and a forward-backward check (≤ 1 px); frames far
     from the reference (low survival < 30 %) re-anchor on the last good frame (chained, with its own features).
  3. Estimate the homography with RANSAC (reprojection threshold 2 px at tracking resolution), map the reference
     corners; confidence = inlier ratio × (1 − normalised reprojection error).
  4. Optional drift correction (`quality: 'best'`): an ECC refinement (`findTransformECC`, homography model) of the
     quad region against the reference.
- **TRK-013 (P0)** Point tracker (`method: 'template@1'`): normalised cross-correlation (`matchTemplate`
  `TM_CCOEFF_NORMED`) of the reference patch within the search window around the previous position, refined with
  KLT; the template is re-anchored to the reference patch every frame to cancel drift; confidence = correlation
  score; below 0.5 → lost.
- **TRK-014 (P0)** Performance: `balanced` planar tracking of 1080p runs at ≥ 25 frames/s on the reference 12-core
  machine; cancellation within 500 ms.

## 4. Applying a track

- **TRK-020 (P0)** `tracker.apply` bakes, for every sequence frame `f` in the range (default: the overlap of plate
  and target), the plate geometry into the target:
  1. plate content time `t_p(f)` → sample (linear interpolation between neighbouring samples; outside the tracked
     span the nearest sample is held);
  2. optional temporal smoothing (centred moving average of radius `tracker.smoothing` frames) on corners;
  3. media px → sequence px through the plate's layer map at `f` (its Motion and its own corner pin/projective map);
  4. sequence px → target layer px through the inverse of the target's Motion at `f`.
- **TRK-021 (P0)** `mode: 'corner-pin'`: the target gets a `jasper.corner-pin` effect (created at the top of its
  stack if absent, the existing one reused otherwise) whose four vec2 params — **normalised to the target's
  intrinsic box** (TL = (0,0) … BR = (1,1) is identity) — receive one linear keyframe per frame in the range,
  replacing existing keyframes inside the range (outside are kept). The target's own Motion is left as is.
- **TRK-022 (P0)** `mode: 'transform'`: Motion `position` (and optionally `scale`, `rotation`) keyframes per frame so
  the target's anchor follows the tracked point / the quad centroid; scale = ratio of the tracked quad's diagonal
  lengths to the reference frame's; rotation = angle of the TL→TR edge relative to the reference frame.
- **TRK-023 (P0; simplification P1, done in M3 `wp-m3-trackui`)** Apply is one transaction ("Apply Tracking"), sets
  `trackedBy`, and simplifies the baked per-frame keys only when the user asks: `tracker.apply {simplify:
  {tolerance}}` in the same transaction, or afterwards `keyframes.simplify` (S01:KF-010) on the tracked keys or on any
  keyframed parameter. Default tolerance 0.1 px.
  - **Guarantee:** at every sample — every frame the clip shows at its current timing (extended over its handles to
    the keys around the simplified span) and every original key time — the simplified animation deviates from the
    original by at most the tolerance. Geometry (Motion position/anchor/scale/scale width/rotation and the clip's
    corner pin, one group per clip) is measured as the largest displacement of the drawn picture in **sequence
    pixels**: for unpinned (affine) layers on the four box corners, which bounds every point of the picture; for
    corner-pinned layers on a 9×9 grid over the picture through the pin's homography (the solver uses 3×3 and the
    result is verified on 9×9). Other parameters are measured in their own units (|Δ|, Euclidean for vectors).
    Measured with the real evaluator; when the check fails the solve is repeated with a smaller budget and finally
    the offending sub-group keeps its original keys, so the guarantee is unconditional. Export renders the same
    evaluated keys (warp stage), so the export moves by at most the tolerance too.
  - **Method:** kept keys are a subset of the originals (same id, time, value). Each segment between kept keys is
    `linear` or a fitted Bézier ease: with influence 1/3 on both sides the timing curve is a cubic Hermite in time
    whose two slopes are fitted (Lawson-reweighted least squares towards the minimax fit; slopes ≥ 0, ≤ 40).
    Consecutive original keys keep their original segment shape. The minimal key count is found by dynamic
    programming over the candidate keys (pruned). Channels with identical key times (the four corners of a pin,
    Motion from one apply) share their kept times and are solved jointly; other channels of a group are solved
    in turn with a cumulative share of the tolerance. Keys outside the span and the segments leaving it are
    unchanged. Vectors move along straight lines between keys (S01:KF-008), so curved paths keep more keys.
  - The tolerance used on tracked keys is remembered in `trackedBy.simplify` and re-used by Re-apply and by a
    re-track of linked targets.
- **TRK-024 (P0)** Manual correction = keyframe editing: dragging corner handles on the Program monitor at a frame
  adds/updates keyframes of the corner-pin params at that frame (stopwatch semantics, S01:KF-005). "Track from here"
  uses the current (corrected) corners at the playhead as a new reference and re-tracks forward (or backward),
  merging samples with `span` and re-applying to the linked target over the re-tracked span.

## 5. Rendering

- **TRK-030 (P0)** Corner pin effect `jasper.corner-pin` (registered in the default registry; params `topLeft`,
  `topRight`, `bottomRight`, `bottomLeft`, vec2 normalised to the layer box). The scene resolver computes
  `ResolvedLayerProps.projective = Motion · H(box → pinned quad)` and the pinned quad (`render/homography.ts`,
  `render/scene.ts`); a non-convex quad is ignored (the layer draws unpinned; the Effect Controls row shows a
  warning).
- **TRK-031 (P0)** Preview and the Remotion path: `LayerBox` draws `projective` with CSS `matrix3d`
  (`mat3ToCss`); crop, effects and opacity apply as before (effects are in layer space, before the pin).
- **TRK-032 (P0)** Native path — the **warp stage** (native extension `warp`): `claimsLayer(c)` for layers with an
  enabled corner pin **or keyframed Motion** (which today forces the Remotion path). `prepare` renders each claimed
  layer to a sequence-space straight-alpha intermediate:
  1. ffmpeg decodes the layer's source and applies its source chain and native effects (the builder's per-layer
     chain up to, not including, Motion — factored out of `export/native.ts` as `layerSourceChain(...)` by this
     package) and pipes box-sized `rgba` frames;
  2. worker threads warp each frame into the `W×H` sequence frame with the per-frame inverse map (bilinear
     sampling on premultiplied colour, outside = transparent), multiply by the evaluated opacity;
  3. ffmpeg encodes ProRes 4444 (`yuva444p10le`) into `<appdir>/cache/warp/<key>.mov`, `key = sha256(source
     fingerprint, chain text, per-frame matrices + opacities, W, H, frame span, warp version)`.
  `override` returns `{space: 'sequence', startFrame: f0}`; the builder then only applies transition fades and
  overlays at (0, 0).
- **TRK-033 (P0)** Warp performance ≥ 25 frames/s at 1080p output on the reference machine (12 worker threads);
  the intermediate is cached, so re-exports are free. Only the bounding box of the destination quad is processed per
  frame.
- **TRK-034 (P0)** Parity: native warp vs preview `matrix3d` agree to ≤ 1 px in position and ≤ 3/255 in colour on
  edges-excluded pixels.

## 6. User interface

- **TRU-001 (P0)** Properties section **Tracking** (`clipSections`) on video clips: tracker list (name, kind,
  tracked span, mean confidence), buttons Add Planar Tracker / Add Point Tracker, per tracker: ◀◀ Track Backward,
  ◀ Step Back, ▶ Step Forward, ▶▶ Track Forward, Track Both, Track from Here, Stop; Smoothing slider; "Apply to…"
  (target picker = clips overlapping the plate on tracks above it; mode Corner Pin / Position / Position+Scale+
  Rotation); Remove.
- **TRU-002 (P0)** Program overlay (`programOverlays`), active while a tracker of the selected clip is being placed
  or selected: the quad (or point + patch + search boxes) at the current frame from the samples (or the reference
  before tracking), draggable corners/edges for the reference; a confidence colour (green/amber/red) and a trail of
  the last 30 positions. During a track job the overlay follows the live progress corners.
- **TRU-003 (P0)** Corner-pin handles: when a clip with `jasper.corner-pin` is selected and the effect is focused in
  Effect Controls (or the Corner Pin tool mode is on), the Program overlay shows four draggable corner handles on
  the pinned quad; each drag is one gesture writing the corner params (keyframe at the playhead when animated).
- **TRU-004 (P0)** Effect Controls editor for `jasper.corner-pin` (`effectEditors`): shows "Driven by tracker
  <name> on <clip>" with Re-apply and Unlink when `trackedBy` points at it.
- **TRU-005 (P1, done in M3)** Timeline glyphs (`clipDecorations` extension point, drawn inside the virtualised
  clip view; no transport subscription, so nothing re-renders on playhead moves):
  - plate clip: a tracker badge in the name strip (planar/point icon, count when > 1) whose tooltip lists each
    tracker (span, frames, mean confidence, low and lost frame counts, or "Not tracked"); and one confidence strip
    per tracker (≤ 3 stacked, the active one taller) along the bottom of the body over exactly the tracked span,
    coloured per frame (≥ 0.8 good, ≥ 0.5 fair, > 0 low, 0 lost — lost frames have their own look), drawn in canvas
    tiles over the visible part only with the worst confidence of each pixel column at low zoom; hovering the strip
    names the frame's timecode and confidence; while a track job runs the strip grows live from the job's
    `tracking.progress` events (merged over the committed samples, redraws throttled to ≤ 10 Hz, nothing in the
    document or History) and the committed result replaces it when the job ends;
  - target clip: a link glyph, tooltip "Follows <tracker> on <plate> · Corner Pin|Motion" ("Tracker removed" when
    dangling);
  - clicking a glyph (Selection tool) selects the plate, makes the tracker active, focuses Properties and reveals
    the Tracking section; it never starts a drag, and the strips leave the trim edge zones to the timeline.
- **TRU-006 (P1, M3)** "Simplify Keyframes…" (TRK-023): a dialog with the tolerance (px, presets, remembered), a
  live preview through a gesture (Program monitor and Effect Controls show the result; no History entry until
  Apply), the key counts, max/mean deviation, a deviation-over-time graph against the tolerance and a per-parameter
  table; Apply = one History entry "Simplify Keyframes". Entry points: Properties ▸ Tracking "Simplify…" (the keys
  the tracker drives), the corner-pin editor (with "simplified ≤ x px" in its Driven-by line), the Apply Tracking
  dialog option "Simplify keyframes" (same entry as the apply), the Effect Controls keyframe context menu (the
  selected keys; with fewer than three, their parameters — any keyframed parameter), the timeline clip menu and
  Clip ▸ Simplify Keyframes… (every keyframed parameter of the selected clips).

## 7. Agents (TRA)

- **TRA-001 (P0)** MCP tools (`apps/mcp/src/tools/tracking.ts`):
  - `add_tracker {projectId, clipId, kind, at, corners? (media px) | point?}` → tracker id;
  - `track {projectId, trackerId, direction?, range?, quality?, wait?}` → runs the job and commits
    `tracker.setSamples` when done; returns span, mean/min confidence and lost frames;
  - `apply_tracking {projectId, trackerId, targetClipId, mode, components?, smoothing?}`;
  - `get_tracker {projectId, trackerId, frames?}` → corners at given frames + confidence summary;
  - `set_corner_pin {projectId, clipId, corners (sequence px or normalised), at?}` for manual placement.
- **TRA-002 (P0)** Agents verify with `render_frame`; the tool descriptions say so.
- **TRA-003 (P1, M3)** `simplify_keyframes {projectId, clipId (+trackedOnly) | trackerId | targets | keyframeIds,
  tolerance? (0.1), dryRun?}` → key counts and the measured max/mean deviation per group; `apply_tracking` gains
  `simplifyTolerance`.

## 8. Acceptance tests

1. **Math** (unit): homography helpers (done in `packages/project`, extended with the apply pipeline):
   `tracker.apply` on a synthetic tracker reproduces known target corners within 1e-6 px through plate Motion
   (scale 150 %, rotation 10°) and target Motion; split/duplicate copy trackers; scaling on source swap.
2. **Tracker accuracy**: fixture `pnpm fixtures` gains `plate-planar.mp4` (1080p, 5 s) — a textured quad warped
   by a known per-frame homography over a moving noisy background, plus `plate-point.mp4`. Planar `balanced`:
   RMS corner error ≤ 1.5 px, max ≤ 4 px; point: RMS ≤ 1 px. Occlusion segment (10 frames covered): tracker marks
   them lost or keeps error ≤ 4 px and recovers within 5 frames after.
3. **Speed**: TRK-014 and TRK-033 budgets measured (reported; fail above 2×).
4. **Preview/native parity**: a corner-pinned still over a plate: native still vs Playwright Program monitor
   screenshot within TRK-034 tolerances.
5. **Planner**: a sequence with a corner-pinned overlay and with keyframed Motion plans `native`; the second export
   reuses the warp cache (no warp job).
6. **UI**: add planar tracker → drag corners (one history entry) → Track Forward (job, live overlay) → Apply to…
   corner pin (one entry) → drag a corner at a frame (keyframe updated, one entry) → undo chain.
7. **MCP**: `add_tracker` + `track` (wait) + `apply_tracking` + `render_frame` on the fixture project produces a
   pinned overlay whose corners in the PNG are within 3 px of the fixture's ground truth.
8. **Simplification** (M3): property tests (solver and documents: random dense tracks, mixed interpolations,
   spans, locked keys) and the trailer's real tracks (`MatsSmileTrailer/mg/public/tracks/*.json` baked as corner
   pins / Motion): the drawn quad (`resolveSceneAt`) and the warp stage's per-frame maps move ≤ tolerance at every
   frame; one undoable entry; the MCP end-to-end test simplifies the tracked fixture pin and the rendered corners
   stay within 3 px of the ground truth.
9. **Timeline glyphs** (M3): badge/strip/link render with the right tooltips, clicks reveal the tracker, strips
   aggregate the worst confidence per column, no re-render on transport changes; e2e `tracking.spec.ts`.
