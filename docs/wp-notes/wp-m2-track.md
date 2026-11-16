# wp-m2-track — tracking and screen replacement (S09)

Branch `wp/m2-track`. Spec `docs/specs/09-tracking.md`; contracts ARCHITECTURE §19.5–§19.7, §19.10, D-27, D-28.
Latest `dev` (wp-m2-transitions) is merged in; the audio part of `export/native.ts` merged cleanly.

## What was built

| Area | Requirements | Where |
|---|---|---|
| Model | TRK-001…005, 020…024 | `packages/project/src/commands/handlers/tracker.ts`, `packages/project/src/tracking/` |
| Tracking job | TRK-010…014 | `apps/engine/src/tracking/`, `apps/engine/src/routes/tracking.ts` |
| Warp stage | TRK-030…034 | `apps/engine/src/export/warp/`, `layerSourceChain` in `apps/engine/src/export/native.ts` |
| UI | TRU-001…004 | `apps/web/src/tracking/`, `apps/web/src/commands/tracking.ts` |
| MCP | TRA-001/002 | `apps/mcp/src/tools/tracking.ts` (`TRACKING_GUIDE`) |
| Fixtures | §8.2 | `scripts/fixtures/track.mjs` (`plate-planar.mp4/.json`, `plate-point.mp4/.json`, ground truth) |

**Model.**
- `tracker.add/update/remove/setSamples/apply` and a new `tracker.unlink`.
- `tracking/samples.ts`: interpolated lookup, held outside the span, centred moving-average smoothing, `span` merge (gaps become lost samples), re-anchoring, `scaleTracker` for S07:PRC-006 source swaps.
- `tracking/apply.ts`: plate media px → plate layer map (Motion and its own pin) → inverse target Motion. Corner pin = normalised keyframes per frame; transform = position at the quad centre (diagonal intersection), scale/rotation relative to the reference.
- `tracking/request.ts`: `planTrack` builds forward/backward/both/from-here/step requests; the UI and MCP share it.
- `tracker.update` with corners after tracking re-anchors the whole track through the plane motion: correcting the reference never needs a re-track.
- Split and duplicate give copied trackers new ids; a duplicated target's `trackedBy.effectInstanceId` follows its own pin copy.

**Engine tracker.**
- Runs OpenCV.js (`@techstark/opencv-js` 4.12.0-release.1, Apache-2.0) in `worker_threads`, on ffmpeg `gray8` frames at the quality's resolution.
- Planar (`klt-homography@1`, replaced by `@2`, see "Planar tracker @2" below): Shi–Tomasi features, LK from the reference frame, forward-backward check, re-anchor on low survival, RANSAC homography; `best` added ECC.
- Point (`template@1`): NCC template plus LK.
- Options: `features` (`inside` / `surroundings` / `both`) and `refineEdges`. Edge refinement snaps each side, per frame, to the fitting straight edge nearest it (rise / fall / dark-mask centre), sub-pixel. Sides outside the frame keep the tracked line.
- Live geometry goes out as raw `tracking.progress` events.

**Warp stage.**
- The `warp` NativeExtension claims layers with an enabled corner pin, keyframed Motion or animated opacity (video, still, animated-image, solid, and composition from an earlier extension's `layer` override).
- Pipeline: decode through `layerSourceChain` → per-frame inverse-map bilinear warp on premultiplied colour (bbox only, worker pool, SharedArrayBuffer) → ProRes 4444 in `<appdir>/cache/warp/<sha256>.mov` → `sequence` override.
- The builder already applies fades and overlays at 0,0.

**UI.**
- Properties ▸ Tracking section with Add / track buttons / quality / Track surroundings / Snap to edges / Smoothing / Apply to… / Remove.
- Program overlay for the tracker quad or point, with a confidence colour, a 30-position trail and live progress.
- Corner-pin handles and a corner-pin Effect Controls editor (Driven by…, Re-apply, Unlink, non-convex warning).
- Clip menu entries and `tracking.*` UI commands. A finished track is one "Track" entry and re-applies linked targets over the re-tracked span.

**MCP.** `add_tracker`, `track` (wait or jobId), `apply_tracking`, `get_tracker`, `set_corner_pin`. The descriptions tell agents to verify with `render_frame`.

## Contract changes (all additive)

- `packages/api/src/tracking.ts`: `TrackRequest.trackerId`, `TrackRequest.options {features, refineEdges}`; `TrackResult.trackerId`, `framesPerSec`; `TrackProgressSchema` + `TRACKING_PROGRESS_EVENT`. The event is published as a raw envelope; `events.ts` is unchanged.
- New command `tracker.unlink {clipIds}` (schema in `commands/schemas/tracker.ts`, one catalog label line).
- `render/scene.ts`: `layerMapOf`, `layerMapAtFrame`.
- `commands/placement.ts` `reidentifyClipChildren` (outside owns_paths): remaps tracker ids and `trackedBy.effectInstanceId`. It is the copy helper that split and duplicate share.
- `export/native.ts` changes:
  - `layerSourceChain(...)` was factored out; the output was verified byte-identical.
  - New `pickOverride`: a `sequence` override from any extension wins over an earlier `layer` override, so warp beats mg for corner-pinned compositions, as §19.6 describes.
- Warp sources a claimed layer from an earlier extension's `layer` override for any kind (not only compositions).
- `GET /api/licenses` lists a second component, `opencv-js` (Apache-2.0); `tools/licenses.ts` and its two tests were updated.
- `apps/desktop/scripts/package.mjs` (outside owns_paths) stages `@techstark/opencv-js` with the engine runtime.
- `apps/engine/test/export.test.ts`: keyframed opacity now plans `native`. This lifts the M1 blocker on purpose.

## Licences

- `@techstark/opencv-js` 4.12.0-release.1: Apache-2.0. It is shown in About/Licenses, with the text read from the installed package.
- No ffmpeg GPL filters are used. The warp replaces `perspective`, and the builder, decoder and encoder text is scanned in tests.

## Measurements

**Fixtures** (balanced, against ground truth):

| Case | RMS | Max |
|---|---|---|
| Planar | 0.045 px | 0.12 px |
| Planar with refineEdges | 0.060 px | 0.39 px |
| Planar, LGPL ffmpeg 7.1 + OpenH264 | 0.038 px | 0.10 px |
| Point | 0.096 px | 0.19 px |

- Occlusion frames stay ≤ 0.17 px.
- Cancel latency: 175–217 ms.
- MCP §8.7: the render_frame corners are within 3 px of the ground truth (test passes).

**Speed** (shared 12-core host, load 13–40, never idle):

| Stage | Measured | Note |
|---|---|---|
| Tracking, balanced 1080p | 16–30 fps | Real plates: T05 24 fps, T23 28 fps |
| Warp, 1080p | 21–23 fps at load ~13 | About 0.24 CPU-s/frame, so an idle machine should exceed 25 fps (not measured) |

**Parity** (TRK-034), native still vs resolved quad (what the preview draws with `matrix3d`):

| Layer | Corner error | Colour error |
|---|---|---|
| Corner pin | 0.008 px | ≤ 2/255 |
| Keyframed Motion | 0.047 px | ≤ 1.4/255 |

**Cache:** a second export does no warp work.

**Real plates (acceptance).** Both shots were done through the MCP tools against the engine: import the plate and a replacement video, add a planar tracker on the monitor's screen, track with `refineEdges` (features `inside`), apply as a corner pin, export native.

- `renderPath: native`.
- Edge error was measured independently on every frame of the original plate (`/tmp/wp-m2-track-acceptance/measure_edges.py`): the dark panel-mask centre and the bezel inner edge, sub-pixel, as the median of 60 normals per side.

| Plate, side | Track vs mask centre: median / max | Track vs bezel inner edge: median / max | Max frame-to-frame deviation |
|---|---|---|---|
| T05 top | −0.11 / 0.24 px | −3.38 / 3.63 px | 0.25 px |
| T05 right | −0.45 / 0.64 px | −4.63 / 4.88 px | 0.25 px |
| T05 left | 0.71 / 0.90 px | −3.12 / 3.39 px | 0.50 px |
| T23 top | −1.70 / 2.31 px | −5.87 / 6.12 px | 0.73 px |
| T23 bottom | 3.05 / 3.21 px | 0.08 / 0.14 px | 0.18 px |
| T23 left | 0.47 / 0.55 px | −2.63 / 3.12 px | 0.50 px |

- **Not measured:** T05's bottom side and T23's right side are outside the frame.
- **How to read the table:** every side sits between the bezel's inner edge and the mask centre (the mask is 6–10 px wide). On every frame the edge stays within 0.75 px of where it snapped.
- **Visual check:** corner crops at the first and last frames show no original screen pixels: `/tmp/wp-m2-track-acceptance/sheet_final.png`, full frames `e05_full46.png` and `e23_full34.png`.
- **Placement matters:** edge refinement snaps to the nearest edge, so how precisely the corners are placed decides which edge it takes.

## How to test

```bash
pnpm fixtures
pnpm vitest run --project @jasper/project packages/project/test/tracker.test.ts
pnpm vitest run --project @jasper/engine apps/engine/test/tracking*.test.ts apps/engine/test/warp*.test.ts
pnpm vitest run --project @jasper/mcp apps/mcp/test/tracking.test.ts
pnpm --filter @jasper/engine exec tsx scripts/track-file.ts --file <video> --ref N --corners "x,y x,y x,y x,y" --refine-edges
```

## Open issues

- **TRU-005:** the timeline tracker/link glyphs (P1) — done in M3, see `wp-m3-trackui.md`.
- **TRK-023 P1:** "Simplify keyframes" — done in M3, see `wp-m3-trackui.md`.
- **Transform overlay:** the Program monitor's transform overlay draws a corner-pinned clip's selection box unpinned (`TransformOverlay.tsx`, not ours).
- **§8.4 parity:** no Playwright screenshot comparison; parity is measured against the resolved quad.
- **Speed budgets:** the 25 fps budgets (TRK-014/033) are not confirmed on an idle machine. Tests assert the 2× floor (12.5 fps) only when the load allows.
- **Warp limits:**
  - Animated built-in effects (e.g. keyframed crop) stay blockers.
  - Looping animated images are not supported.
  - M1 `motion-graphic` clips are not claimed.
  - `cache/warp` has no GC yet.
- **`surroundings` features** drift on plates where the ring sits on a background with parallax; use `inside` for screens.
- **Bezel overlap on T05:** T05's bezel lip over the picture's lower-left corner (the trailer's `clipBelow`) is covered by the replacement. Fixing it would need tracked mattes (P2).
- **Quality and options:** per-tracker quality and options in the UI are session state, not saved in the document.

## Planar tracker @2 (`perf/planar-tracker`): speed, handheld footage, hold-out

The video team measured 2.3 fps at `best` on 1080p and confidence 0.53 on a blurry handheld clip with hands passing
over a laptop screen (scratch project `prj_VZNC8ECW1AAHGA4J`, plates `VID_233659` = S95 and `VID_233835` = S96).

### Profile of `klt-homography@1` (measured)

In-process tracker, `plate-planar.mp4` forward from frame 75, 59 frames, 1080p `best`, one worker
(harness: per-call timers around the OpenCV.js functions):

| Stage | Build host (Ryzen 7 7700, 16 threads, load ≈ 15) | User's PC (Ryzen 9 5900X, 24 threads, load ≈ 2, nice 19) |
|---|---|---|
| `findTransformECC` (full frame, 40 iterations max) | 299.5 ms | 195.8 ms (80 %) |
| `calcOpticalFlowPyrLK` ×2 (400 points, window 21) | 57.9 ms | 34.2 ms |
| `warpPerspective` (anchor ROI, full resolution) | 13.5 ms | 9.6 ms |
| `findHomography` + JS | 11.8 ms | 6.0 ms |
| **Total per frame** | **382.7 ms (2.6 fps)** | **245.6 ms (4.1 fps)** |
| ffmpeg decode (separate process, overlapped) | 16.8 ms | 6.3 ms |

Everything runs in single-threaded WASM without SIMD (a 5×5 GaussianBlur of a 1080p frame takes 20 ms). ECC smooths
and differentiates the whole frame on every iteration. Decoding is not the bottleneck, so GPU decode would not
help. On S95 the job ran at 2.4 fps (both directions, two workers) because ECC iterates to its limit on blurred frames.

### What changed (`apps/engine/src/tracking/planar.ts`, `align.ts`)

- **Predicted crop.** The constant-velocity prediction places a crop around the plane: the bbox plus 15 % and at
  least 48 px. Only that crop is pyramided (`pyrDown`, levels 1–3) and processed.
- **KLT at half resolution above 1280 px** (`kltLevel` 1 at `best` on 1080p). Settings: 300 features, window 17, the
  existing pre-warp, a forward-backward check and RANSAC at 1.5 KLT-level px. Features that the prediction puts
  outside the frame or in the hold-out are left out of the confidence's denominator.
- **Dense refinement** (`balanced` and `best`; `fast` stays KLT only) replaces ECC. It is a robust ESM homography
  alignment, run coarse to fine from the KLT estimate (level 2 → 0), or from the prediction when KLT fails:
  - ESM: Benhimane & Malis 2004, "Real-time image-based tracking of planes using Efficient Second-order
    Minimization", IROS. The Jacobian is the mean of the template and warped-frame gradients, with compositional
    updates.
  - Gain/bias photometric fit per iteration, as ECC normalises (Evangelidis & Psarakis 2008, PAMI 30(10)).
  - IRLS with Tukey's biweight (c = 4.685σ) and a MAD scale (Huber, *Robust Statistics*; the M-estimator form of
    Hager & Belhumeur 1998, PAMI 20(10)). Occluder pixels get zero weight.
  - Template: an even subsample of the textured pixels (|∇| ≥ 2) per level, capped at 8000 / 5000 / 3000 / 1500.
  - Level 0 of both images is smoothed with a 5-tap binomial (σ = 1), as ECC smooths its inputs.
  - Order: the reference template first (no drift), then the current anchor's.
- **Confidence:** dense correlation × √(inlier share) × in-frame share. Without dense, the @1 formula over eligible
  features.

Rejected while tuning (measured, `/tmp` harness):
- Inverse compositional (Baker & Matthews 2004): biased by up to 0.6 px on frames blurred differently from the
  reference. ESM was not better there either, but converges in fewer iterations.
- Top-gradient pixel selection: 0.1 px bias from aliased edges.
- Unsmoothed level 0: ≈ 0.1 px.
- Ending at level 1: 0.08–0.24 px.
- Tukey c = 3.5, 2.5, 8 or 14, or including flat pixels: equal or worse on both fixtures.

### Hold-out and smoothing

- **Hold-out.** `TrackRequest.options.holdout` (planar only) takes polygons in media px, per source frame or static;
  at most 500 000 vertices, checked by zod. The worker rasterises them per frame (even–odd), grown by width/480 px
  (4 px at 1080p). In a held-out area:
  - KLT features are not detected in the anchor frame;
  - a match is dropped when its frame position or any corner of its LK window falls in the area;
  - dense pixels are skipped.
- **Hold-out in the UI.** `trackHoldout` (`packages/project/src/tracking/request.ts`) evaluates masks of the plate
  per source frame (or once, without Mask Path keys). Properties ▸ Tracking ▸ **Ignore** lists the plate's masks,
  which can come from a tracked mask or from Roto Brush ▸ Convert to Masks. The choice is session state, like the
  other planar options: no document field and no schema change.
- **Smoothing.** `smoothSamples` (TRK-020) became a confidence-weighted local linear regression: LOESS degree 1,
  tricube weights × confidence (Cleveland 1979, JASA 74(368)). The @1 centred average lagged real motion: on a
  10 px/frame move with radius 2 the end samples were 6.6 px off. It also averaged in lost samples, which repeat
  the last good values. Both caused "smoothing makes it worse". Straight motion is now reproduced exactly and lost
  samples are filled from their neighbours.

### Measurements (`@2`)

Speed on the user's PC (Ryzen 9 5900X, run as a transient systemd user unit with Nice=19 and IOSchedulingClass=idle,
in its own worktree; load 5–10 from the user's other processes during the `@2` runs, 2–4 during the `@1` runs).
The `track-file.ts` job path, `best`, 1080p:

| Clip | `@1` | `@2` |
|---|---|---|
| S95, both directions | 2.4 fps | 39.3 fps |
| S95, forward (one direction, two workers) | — | 45.4 fps |
| S96, both directions | 4.1 fps | 34.3 fps |
| plate-planar-hard, both directions | 3.2 fps | 28.2 fps |
| plate-planar, both directions | — | 49.7 fps |
| In-process, one worker, plate-planar | 245.6 ms/frame | 42.7 ms/frame (23.4 fps) |

The in-process `@2` frame splits into LK 15.1 ms, dense 17.0 ms, warp 3.1 ms, pyrDown 1.2 ms and other JS 5.8 ms.
On the build host at load ≈ 8 the same frame takes 33.8–38.7 ms.

`balanced` speed is about unchanged (S95 38 → 39.6 fps, S96 38.1 → 32.4 fps, hard 28.7 → 30.1 fps); it now also gets
the dense stage.

Accuracy on `plate-planar-hard`, against the ground truth (corner mean over the shutter), `best`, both directions:

| | `@1` | `@2` |
|---|---|---|
| RMS, frames without the occluder | 0.090 px | 0.184 px |
| Max, frames without the occluder | 0.225 px | 0.705 px |
| Max, frames with the occluder | 4.61 px | 0.54 px |
| RMS, all frames | 0.478 px | 0.185 px |

At `balanced` the occluded max goes from 2.98 to 0.46 px. On `plate-planar` at `best`, `@2` gets RMS 0.049 px, max 0.164 px.

Real plates. `scripts/track-check.ts` rectifies the tracked screen to 960×600 and finds 4×3 reference tiles again by
NCC; the error is the median tile shift per frame, in px of the rectification (≈ frame px for these screens):

| Plate, `best` | Mean / median / p90 / max | Frames > 2 px | Mean confidence | Lost |
|---|---|---|---|---|
| S95, `@1` | 1.04 / 0.43 / 2.66 / 22.6 | 40 | 0.526 | 1 |
| S95, `@2` | 0.41 / 0.28 / 0.65 / 9.5 | 4 | 0.939 | 0 |
| S96, `@1` | 0.19 / 0.18 / 0.28 / 0.45 | 0 | 0.879 | 0 |
| S96, `@2` | 0.17 / 0.17 / 0.25 / 0.43 | 0 | 0.974 | 0 |

- The four S95 frames over 2 px are frames 3–5, where the screen is mostly above the frame and smeared, and 113.
- At `@1` they were the hand passes (frames 106–119, 149–156, 250–260).
- S95 `balanced`: 17 → 3 frames over 2 px.

Rerun:
```bash
pnpm --filter @jasper/engine exec tsx scripts/track-file.ts --file VID_233659.h264.mp4 --ref 176 \
  --corners "574,53 1543,94 1396,610 641,623" --quality best --direction both --json s95.json
pnpm --filter @jasper/engine exec tsx scripts/track-check.ts --file VID_233659.h264.mp4 --track s95.json --ref 176
pnpm --filter @jasper/engine exec tsx scripts/track-file.ts --file fixtures/media/plate-planar-hard.mp4 \
  --truth fixtures/media/plate-planar-hard.json --quality best --direction both
```
`track-file.ts` now uses the average frame rate, like the engine's registry. With the nominal 30/1 of phone footage
the S96 reference frame (304) landed on the wrong picture and `@1` lost 341 of 342 frames.

### Occlusion matte (script, not a job yet)

`scripts/track-occlusion.ts` writes a matte video for a finished track: white where something hides the plane. It
works at half resolution:
- warps the reference plane through the track and fits gain and bias to the frame;
- marks foreground where the residual exceeds 4σ plus a 1 px-misalignment allowance from the local gradient;
- opens, closes and softens the result, then upscales it to the media size;
- encodes with OpenH264, or libx264 when allowed, else FFV1.

It is meant to be used as a Track Matte: Luma Inverted on the screen replacement.

On S95 it finds the fingers over the screen on 87 frames, with no false foreground on the screen in the 13
inspected frames (contact sheet). It underestimates motion-blurred, half-transparent parts of the hand.

Limits: the plane must keep the reference frame's look (a static screen). Video playing on the screen, reflections
or exposure changes beyond gain/bias read as foreground. It is gray only (no occluder colour model). There is no
engine job, MCP tool or UI action for it yet.

### Limits and follow-ups

- The dense stage is ≈ 0.1 px less accurate than full-frame ECC on clear frames of the blurred fixture (0.18 vs
  0.09 px RMS). It is far more robust under occlusion.
- MCP `track` has no hold-out parameter yet: a new parameter needs an `apps/mcp/eval` case.
- `tracker.add` still stores `klt-homography@1` as the placeholder method until the first track.
- Speed figures were taken under the load stated above; the user's PC was not idle.
