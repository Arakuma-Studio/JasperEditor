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
- Planar (`klt-homography@1`): Shi–Tomasi features, LK from the reference frame, forward-backward check, re-anchor on low survival, RANSAC homography; `best` adds ECC.
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
pnpm build && E2E_PORT=48450 pnpm e2e -- e2e/tracking.spec.ts
pnpm --filter @jasper/engine exec tsx scripts/track-file.ts --file <video> --ref N --corners "x,y x,y x,y x,y" --refine-edges
```

## Open issues

- **TRU-005:** the timeline tracker/link glyphs (P1) are not done; the timeline belongs to transitions.
- **TRK-023 P1:** "Simplify keyframes" (RDP) is not done.
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
