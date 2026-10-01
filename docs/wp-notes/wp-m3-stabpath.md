# wp-m3-stabpath — Smooth path stabiliser + colour-range check of processing (S07)

Branch `wp/m3-stabpath` (from `main` ebb01ed). Spec `docs/specs/07-clip-processing.md` (PST-001, **PST-005**,
PRU-001, §8 test 3b); previous package notes `docs/wp-notes/wp-m2-process.md`.

## 1. Smooth path ("trayectoria suavizada", PST-005)

A third stabilise method next to vid.stab (WASM, default) and deshake, for a shot from a fixed position with ONE
sudden operator reframe / jerk or a slow uneven drift that should become a single even camera move. Port of the
trailer's `MatsSmileTrailer/grade/tools/smoothstab.py` (our own code), which fixed T01 where vid.stab could not
(vid.stab with a very long window turned the reframe into a drift but added up to 8 px/frame of vertical bobbing).

| Where | What |
|---|---|
| `apps/engine/src/processing/proc/smoothpath/math.ts` | pure math: least-squares similarity, deterministic RANSAC + robust LS refinement, Gaussian / straight-line path smoothing, corrections, border test, minimal static zoom (capped), plan with fallback to the largest smoothing that fits, conversion to the vid.stab warp transform |
| `…/smoothpath/step.ts` | the FrameStep: analysis (8-bit luma ≤ 960 px → OpenCV.js corner tracking in the worker pool → similarities → plan), warp through the vid.stab WASM warp kernel (16-bit, bicubic, workers), notes + sidecar info |
| `…/dejudder/worker.mjs`, `pool.ts` | the OpenCV worker gains a `track` request (goodFeaturesToTrack + calcOpticalFlowPyrLK); `CvPool.track()` |
| `…/proc/steps.ts` | `method: 'smoothpath'` → the step; `SMOOTHPATH_UNAVAILABLE` when the WASM warp module is missing (never silently another method) |
| `packages/project/src/schema/media.ts` | stabilize step: `method` + `'smoothpath'`; optional `lockVertical`, `lockRotation`, `maxZoom` (percent). `smoothing` = the Gaussian sigma in frames for smoothpath. Additive: no migration |
| `packages/api/src/m2-capabilities.ts`, `processing/service.ts` | `features.processing.smoothPath: 'ready'|'unavailable'` |
| `apps/web/src/processing/{model.ts,ProcessDialog.tsx}` | method "Smooth path (one even move)" + a help line per method; path smoothing 1–120 frames (default 30), Lock Vertical (no tilt) / Rotation (level horizon), Borders "Crop (one fixed zoom)" / Keep, Max zoom 101–150 % (default 112, crop only). The vid.stab smoothing (15) is kept separately |
| `apps/mcp/src/tools/processing.ts` | `PROCESSING_GUIDE` and the `steps` example describe smoothpath (`process_clip` takes it through `ProcessStepSchema`) |
| `scripts/fixtures/process.mjs` | `reframe.mp4` (848×480, 90 f: jerky 160 px reframe + 6 px bump + slow drift, a textured subject crossing on its own; `reframePath()` is the ground truth) |

Differences from smoothstab.py: OpenCV.js does not export `estimateAffinePartial2D`, so the similarity fit is ours
(2-point RANSAC with a fixed seed per pair, then least squares on the inliers with an adaptive threshold —
3·1.4826·median residual, ⅓…1× the RANSAC threshold — for up to 5 rounds). The plain "refit on the winning
hypothesis' inliers" gave 0.100 px rms of vertical frame-to-frame noise on crudo.mp4 (cv2: 0.045); the robust
refinement gives 0.038 and no longer depends on which 2-point sample won. Tracking runs at ≤ 960 px wide (points
mapped back with pixel-centre scaling), so 1080p/4K sources cost the same. The cap fallback is new (smoothstab
failed instead); the zoom margin (+0.2 %) never exceeds the cap.

Report: job notes (in the success toast and `process_clip` result) e.g. `stabilize (smooth path): zoom 111.2 %,
camera speed max 20.5 → 4.1 px/frame (1080p), smoothing 30.0 frames, vertical locked, rotation locked`, and on a
fallback `… needs 118.7 % zoom, above the 112.0 % cap — used the largest smoothing that fits: 13.8 frames …`.
Sidecar `steps[i].info`: `request`, `used`, `zoomPercent`, `fallback`, `speed` (raw/smoothed peak px/frame and
px/frame² at 1920 wide), `camera` (travel, rotation), `tracking` (size, pairs, failed pairs, min inliers),
`timing`, `warp`.

### Validation on real footage — crudo.mp4 frames 0–124 (T01, operator reframe at ~35–52)

Recipe `dejudder(auto) → stabilize(smoothpath, smoothing 30, lockVertical, lockRotation, maxZoom 112)`.
Independent measurement: `/tmp/sp/motion.py` (Python OpenCV 5: gftt + LK + `estimateAffinePartial2D` RANSAC per
pair on 848-wide grey frames, camera motion at the frame centre in px/frame scaled to 1920 wide).

| | zoom | path speed raw → smoothed (step report) | measured output peak | p95 | peak |Δv| (accel) | peak |dy| |
|---|---|---|---|---|---|---|
| source crudo.mp4 0–124 | — | — | 20.42 | 15.95 | 12.85 | 1.01 |
| **ours, local (LGPL FFmpeg 7.1)** | **111.2 %** | 20.5 → 4.1 | **4.28** | 4.01 | **0.61** | 0.32 |
| **ours, remote home PC (system FFmpeg 6.1)** | 111.2 % | 20.5 → 4.1 | 4.09 | 3.96 | 2.02¹ | 0.83¹ |
| smoothstab.py on our de-juddered frames | 111.0 % | 20.4 → 4.1 | 4.15 | 3.90 | 0.85 | 0.39 |
| trailer `grade/out/T01.mov` (SR + grade) | 111.25 % | 20.4 → 4.1 | 4.44 | 4.13 | 0.98 | 0.67 |

¹ one pair at frames 120–122, where the patient fills the frame and the measurement itself is noisy.
Targets met: ≤ ~5 px/frame peak at 1080p with zoom ≤ 112 %. Frames 0 / 52 / 123 next to T01.mov
(`/tmp/sp/sheet.png` while the session lasted): same framing, door bars straight and vertical, no warping (the
correction is a similarity: no local deformation is possible), no border.

Remote path: engine on 127.0.0.1:48610 with Preferences ▸ Processing → `jasper@100.92.198.117`
(RTX 3080 Ti, 24 threads), remote dir `~/jasper-proc-test/stabpath`; *Set up* built and uploaded the jasper-proc
0.2.0 bundle and `npm install`ed it (probe: runtime ready); the process job uploaded the source, ran de-judder +
smooth path remotely (tracking 1.5 s, warp 4.9 ms/frame) and downloaded/verified the result in 28 s — identical
report numbers. The remote directory was deleted afterwards.

Time on this (shared, load 11–20) host for the 124 frames: tracking 17 s, warp ~0.14 s/frame (6 threads).

## 2. Colour range of processed (stabilised) clips

(see below)

## Contract changes (additive)

- `packages/project` ProcessStep `stabilize`: `method` gains `'smoothpath'`; optional `lockVertical`,
  `lockRotation`, `maxZoom`.
- `packages/api` `M2Features.processing.smoothPath?: 'ready'|'unavailable'`.
- OpenCV worker (`proc/dejudder/worker.mjs`) `track` request; `CvPool.track()`.
- jasper-proc `PROC_VERSION` 0.2.0: remote hosts report "runtime outdated" until *Set up* runs again (needed: the
  remote worker must know `track`).
- `packages/ui` Dialog: Enter on an option of a Select / menu inside a dialog no longer also runs the primary
  action (React bubbles the key out of the popup portal; picking a stabilise method with the keyboard started the
  job). Regression test in `packages/ui/test/primitives.test.tsx`.

## Licences

No new dependency: OpenCV.js 4.12 (Apache-2.0) and the vid.stab WASM module (LGPL-2.1-or-later) were already
shipped and listed.

## How to test

```bash
pnpm fixtures                                   # + reframe.mp4
pnpm vitest run --project @jasper/engine apps/engine/test/smoothpath.test.ts apps/engine/test/processing-steps.test.ts
pnpm vitest run --project @jasper/web apps/web/test/processing.test.tsx
pnpm vitest run --project @jasper/ui packages/ui/test/primitives.test.tsx
E2E_PORT=52610 pnpm e2e -- e2e/processing.spec.ts
```

## Open issues

- The smooth path needs the vid.stab WASM module for its warp; an OpenCV `warpAffine` fallback was not added
  (3–5× slower at 1080p, and the module ships with the app).
- A shot containing a cut should be split first: pairs across a cut count as still (identity), so the path is
  continuous but the zoom is computed over both parts.
