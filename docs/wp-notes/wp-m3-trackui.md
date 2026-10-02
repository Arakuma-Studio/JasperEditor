# wp-m3-trackui — tracking timeline glyphs and keyframe simplification (S09)

Branch `wp/m3-trackui` (from `main` ebb01ed). Closes the two P1 gaps of S09 left by `wp-m2-track`:
TRU-005 (timeline glyphs) and TRK-023 "Simplify keyframes"; adds TRU-006 (simplify UI), TRA-003 (MCP), S01:KF-010.

## What was built

| Area | Requirements | Where |
|---|---|---|
| Solver | TRK-023, KF-010 | `packages/project/src/animation/simplify.ts` |
| Document groups, deviation | TRK-023 | `packages/project/src/animation/simplify-doc.ts` |
| Command | KF-010 | `commands/schemas/simplify.ts`, `commands/handlers/simplify.ts`; `tracker.apply {simplify}` |
| Timeline glyphs | TRU-005 | `apps/web/src/tracking/TimelineGlyphs.tsx`, `timeline-strip.ts`; `clipDecorations` in `extensions/index.ts`; `ClipView.tsx` |
| Simplify UI | TRU-006 | `apps/web/src/tracking/SimplifyKeyframesDialog.tsx`, `simplify-actions.ts`; Tracking section, corner-pin editor, Apply Tracking dialog, Effect Controls keyframe menu, clip menu, Clip menu command `keyframes.simplify` |
| MCP | TRA-003 | `apps/mcp/src/tools/tracking.ts`: `simplify_keyframes`, `apply_tracking.simplifyTolerance` |

### Simplification

- **What it keeps:** a subset of the original keys (same id, time, value). Only the segment shapes between kept keys
  change: `linear`, or `bezier` with fitted eases. Keys outside the selected span and the segments leaving it are
  unchanged (boundary eases are written explicitly; a `linear` span end followed by a key stays `linear`).
- **Curve fitting:** with influence 1/3 on both sides the evaluator's timing curve has x(τ) = τ, so a segment is a
  cubic Hermite in time with two slopes. They are fitted by Lawson-reweighted least squares (an approximation of the
  minimax fit, which is what the check needs), constrained to `0 ≤ slope ≤ 40` (S01 eases need slope ≥ 0). Linear
  is tried first. Consecutive original keys always keep their original segment (so a solution always exists).
- **Minimal keys:** DP (shortest path over feasible segments) with pruning: a segment is only fitted when it could
  improve a count; the scan from a key stops after 6 consecutive infeasible ends. 5000 dense vec2 keys take ~0.2 s.
- **Joint channels:** channels with identical key times (the four pin corners; position/scale/rotation from one
  apply) are solved together with shared kept times; different-time channels of one group are solved one after the
  other with a cumulative share of the tolerance against the already simplified ones.
- **Deviation:** geometry groups per clip (Motion + its active corner pin) in sequence px of the drawn picture: box
  corners for unpinned layers (affine ⇒ exact bound for every point), for pinned layers a 3×3 grid in the solver and
  a 9×9 grid for verification (through the pin homography). Value groups in the parameter's units.
- **Samples:** every frame of the owner (`sourceIn + k·F·rate`), extended over the handles to the keys around the
  span, plus every original key time.
- **Guarantee:** the result is verified with the real evaluator on all samples. If it is over the tolerance (only
  possible on the denser verification grid), it is solved again with 0.8× the budget, up to 8 times; after that the
  offending sub-group keeps its original keys. So `maxError ≤ tolerance` always.
- **Remembered tolerance:** `trackedBy.simplify = {tolerance}` is set by `tracker.apply {simplify}` and by
  `keyframes.simplify {trackedOnly}`. Re-apply and the re-track of linked targets pass it again.

### Live progress on the strips

- **Source:** `tracking/live.ts` collects the running job's `tracking.progress` events (source frame and confidence)
  in a plain per-tracker buffer outside React state.
- **Redraw:** a throttled per-tracker counter, `liveVersion` in the tracking store (≤ 10 Hz), re-renders only the plate
  clips whose trackers run.
- **Drawing:** `liveSamples()` merges the received frames over the committed samples (`span` semantics). Frames the
  engine skipped between two events take the lower neighbour's confidence. The strip pulses (`data-live`) while live.
- **Job end:** when the tracker leaves `running` (finished, failed or stopped) the buffer is dropped and the committed
  samples show. Nothing reaches the document or History.
- **Edge zones:** the strips' trim edge zones use the timeline's own `edgeZonePx`, now exported from
  `panels/timeline/model/hit.ts`.

### Results on the trailer's real tracks

Each `MatsSmileTrailer/mg/public/tracks/*.json` was baked with `tracker.apply` (corner pins) or per-frame Motion keys
onto a 1280×720 clip at 150 % / 4° over a 1920×1080 plate, then simplified with `clipIds`. The deviation was measured
on `resolveSceneAt` (the Player and the warp stage). Test: `packages/project/test/simplify-doc.test.ts`.

| Track | Keys | 0.1 px | 0.5 px | Max dev. 0.5 px (corners / 9×9 / 33×33) |
|---|---|---|---|---|
| MG06 pin | 428 | 180 (42 %) | 56 (13 %) | 0.488 / 0.488 / 0.488 |
| MG09 pin | 552 | 204 (37 %) | 44 (8 %) | 0.497 / 0.497 / 0.497 |
| MG12-screen pin | 216 | 216 | 216 | 0 (track jitter ≈ 0.8 px/frame) |
| MG14 pin | 292 | 292 | 160 (55 %) | 0.498 |
| MG17 Motion | 43 | 36 | 11 (26 %) | 0.495 |
| MG21 pin | 276 | 276 | 228 (83 %) | 0.477 |
| MG22 Motion | 273 | 192 | 66 (24 %) | 0.477 |
| MG23 pin | 276 | 264 | 96 (35 %) | 0.481 / 0.494 / 0.494 |
| MG28 Motion | 58 | 48 | 17 (29 %) | 0.483 |
| MG29-sign Motion | 94 | 60 | 28 (30 %) | 0.486 |
| MG29 Motion | 125 | 101 | 58 (46 %) | 0.498 |
| demo-handheld Motion | 453 | 99 (22 %) | 42 (9 %) | 0.495 |

- **Noisy tracks:** jitter that is larger than the tolerance cannot be removed without breaking the guarantee
  (MG12, MG21: the frame-to-frame deviation from a straight line is about 0.7 px). They keep their keys; raise the
  tolerance or smooth the tracker first.
- **Interior of pins:** before the 9×9 verification, MG23's interior moved 0.61 px at 0.5 px (corners 0.48). This is
  why pins are verified on the grid.

## Contract changes (all additive)

- **Commands:** new command `keyframes.simplify` (`schemas/simplify.ts`, one line each in `schemas/index.ts` and
  `catalog.ts`, owner `wp-m3-trackui`). Catalog milestone union gains `'M3'` (owners `wp-m3-*`), and the schema export
  type follows.
- **`tracker.apply`:** optional `simplify {tolerance}`; the result gains `simplified {before, after, maxError, tolerance}`.
- **Schema:** `TrackedBySchema.simplify?: {tolerance}` (loose object, optional; no migration).
- **Exports:**
  - `keyframes.ts` exports `outgoingEase` / `incomingEase`.
  - `handlers/keyframe.ts` exports `clipAnimatables`, `allAnimatables`, `locate`, `targetOf`, `finish`, `AnimLocation`, `Located`.
- **`SHAPE_BOX_COMMANDS`** includes `keyframes.simplify` (shape boxes stay centred).
- **Web:**
  - `extensions/index.ts`: `clipDecorations` registry (`ClipDecorationProps`, `ClipDecorationDef`, `decorationsFor`).
    `ClipView` renders decoration badges in the name strip (also with names hidden) and overlays in the body.
  - `panels/properties/controls/Section.tsx`: `revealSection(id)`.
  - `panels/timeline/model/hit.ts`: `edgeZonePx` is exported (used by the tracker strips).
  - `tracking/store.ts`: `liveVersion` (tracking UI state, not the document).
  - Effect Controls keyframe menu: "Simplify Keyframes…" item.
  - Clip menu (`shell/menus/model.ts`): `keyframes.simplify`.
- **MCP:** new tool `simplify_keyframes`; `apply_tracking.simplifyTolerance`. The README tool list is now 68 tools.

## How to test

```bash
pnpm vitest run --project @jasper/project packages/project/test/simplify.test.ts packages/project/test/simplify-doc.test.ts
pnpm vitest run --project @jasper/engine apps/engine/test/simplify-export.test.ts
MCP_TRACK_TEST_PORT=48640 pnpm vitest run --project @jasper/mcp apps/mcp/test/tracking.test.ts
pnpm vitest run --project @jasper/web apps/web/test/tracking-timeline.test.tsx apps/web/test/tracking-simplify.test.tsx apps/web/test/tracking-live.test.tsx
E2E_PORT=48640 pnpm e2e -- e2e/tracking.spec.ts
```

`JASPER_TRAILER_TRACKS` points the real-track test elsewhere; it is skipped when the directory is missing.

Screenshots: `docs/screenshots/wp-m3-trackui/` — the timeline glyphs (02), a link click revealing Tracking (03), the
dialog at 0.1 / 0.5 px (04, 05), Effect Controls after simplifying (06), the keyframe menu (07, 08) and a strip
tooltip (09).

## Open points

- **Spatial curves:** vec2 parameters (position, pin corners) move along straight lines between keys (S01:KF-008).
  Curved paths keep more keys than a spatial-Bézier model would need.
- **Corner-pin guarantee:** for pins the bound is verified on a 9×9 grid over the picture. A homography's
  displacement between grid points can exceed it only by a second-order amount. The 33×33 measurement on the real
  tracks found no excess.
- **Speed changes:** the guarantee holds for the clip's timing at the moment of simplification. A later speed change
  samples other content times, between the checked ones.
