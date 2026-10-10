# wp `roto` — Roto Brush, object mattes, keying / matte tools and face tracking

Branch `feat/roto` (parity program). Ports: [`licenses/ported/roto.md`](../../licenses/ported/roto.md) (EffectCraft
`track/roto`, `effects/{keylight,matte,keying}`, `segment/mediapipe`, `track/face`).

## 1. What exists now

| Feature | Where |
|---|---|
| Roto model (optional `rotos` on video / still clips: strokes, boxes, base frame, span, settings, result, frozen) | `packages/project/src/schema/sequence.ts` (`ClipRotoSchema`), ids `rto_` |
| Roto helpers (settings defaults, staleness hash, media-frame mapping, matte URLs, retarget / drop-foreign on copy) | `packages/project/src/roto/index.ts` |
| Commands: `roto.add`, `update`, `addStrokes`, `removeStrokes`, `setBox`, `setResult`, `freeze`, `remove`, `apply`, `faceTracker` | `packages/project/src/commands/{schemas,handlers}/roto.ts` |
| Export checks (`ROTO_NOT_COMPUTED`, `ROTO_MATTES_MISSING`, `ROTO_STALE` warning) | `packages/project/src/roto/export.ts`, `apps/engine/src/export/planner.ts` |
| Convert matte to masks (still or animated, via masks' `tracePaths`) | `packages/project/src/roto/masks.ts`, `apps/engine/src/roto/service.ts` (`trace`) |
| Segmentation core: Boykov–Kolmogorov max-flow, GrabCut GMMs, guided filter, closed-form matting, EDT | `apps/engine/src/roto/core/{maxflow,gmm,matting,segment,image,codec}.ts` |
| SAM 2.1 hiera-tiny runner (ONNX Runtime) | `apps/engine/src/roto/models/sam.ts` |
| MediaPipe Face Landmarker runner (BlazeFace + Face Mesh V2, ONNX) | `apps/engine/src/roto/models/face.ts` |
| Worker child process (`jasper-roto`, NDJSON progress), job kind `roto` | `apps/engine/src/roto/{entry,service,store,models}.ts`, `worker/{cli,run,frames}.ts` |
| Content-addressed matte store (`cache/roto/pool`, `cache/roto/sets/<key>`), cache kind `roto` | `apps/engine/src/roto/store.ts`, `apps/engine/src/cache/*` |
| Routes: models list / install / delete, segment, trace, sets, `GET /mg/roto/:key?n=` | `apps/engine/src/routes/roto.ts`, `packages/api/src/{roto,routes}.ts` |
| Model catalogue entries (pinned revisions, SHA-256, licence, attribution) | `apps/engine/src/processing/models.json` (`vision`) |
| Object Matte / Object Blur effects (GPU, per-frame matte textures) | `packages/project/src/registry/fx/{object-matte,matte-ops}.ts` |
| Screen Keyer, Refine Soft Matte, Refine Hard Matte, Key Cleaner, Advanced Spill Suppressor | `packages/project/src/registry/fx/keying-matte.ts` |
| fx framework: `GpuEffect.mattes` (roto-object params bound as samplers) | `packages/project/src/registry/fx/shader.ts`, `packages/compositions/src/fx/{stage.ts,FxPicture.tsx}` |
| Web: Program monitor Roto Brush overlay, Properties ▸ Roto, Preferences ▸ Roto & Face Tracking, clip menu ▸ Roto, UI commands | `apps/web/src/roto/*`, `apps/web/src/commands/roto.ts` |
| MCP tools (14) and the `ROTO_GUIDE` | `apps/mcp/src/tools/roto.ts` |
| Fixture: moving, rotating ellipse with known geometry | `scripts/fixtures/roto.mjs` → `fixtures/media/roto-object.{mp4,json}` |

## 2. Design

**Mattes are derived, content-addressed data.** A roto stores only what the user did (strokes `fg | bg | refine |
refineErase`, boxes, base frame, span, settings). Each media frame gets a *chain key*: a hash of the media, the
settings, the model actually used and the strokes / boxes from the base frame out to that frame. A frame's matte is a
deterministic function of its chain key, so the worker reuses every frame whose key did not change (a correction at
frame 30 re-computes only 30 onwards in that direction), and undo / redo / reopening never sees a stale matte. Frame
mattes are 8-bit grey PNGs in `cache/roto/pool`; a computed span is a *set* (`cache/roto/sets/<key32>/`, hard links +
`set.json`) whose key is recorded in `roto.result`. Saved projects reference sets, so the cache GC keeps them.
`roto.result.inputs` hashes the inputs; when they change the roto is *stale* (UI and `get_roto` say so; export warns
and keeps using the computed set until propagated again; a span without a set refuses).

**Segmentation** (engine child process, never in the UI thread):

1. *Base frame*: strokes / points / box → hard constraints. With the segmentation model installed (`engine: 'model'`,
   default) SAM 2.1 hiera-tiny is prompted with points along the strokes (and the box) and its mask becomes a strong
   prior (weight 4) of the graph cut, so strokes stay hard constraints and the edge snaps to colour; a model mask that
   disagrees (IoU < 0.5 with the flow-warped previous matte) is ignored for that frame. Without the model the cut uses
   the GrabCut colour models alone (`engine: 'classic'`, or automatic fallback, reported as `modelUsed`).
2. *Graph cut*: 8-connected contrast-sensitive n-links (γ/dist·exp(−β‖ΔI‖²)), GMM t-links, Boykov–Kolmogorov
   max-flow, GMMs re-fitted to the result and the cut repeated (GrabCut). Coarse to fine: the cut runs at reduced size
   and is re-cut at full matte resolution in a band around the upsampled boundary.
3. *Propagation* forward and backward from the base frame: Farnebäck optical flow (OpenCV.js, at ≤ 960 px) warps the
   previous matte, the frame is re-cut only in a band of **Search Radius** px around the warped boundary with the
   previous colour models and the warped matte as shape prior; Motion Threshold / Motion Damping follow After
   Effects' propagation controls. Strokes on any frame restart propagation from there.
4. *Edges*: the binary cut is refined in an edge band (Edge Radius, plus Refine Edge strokes) by the colour guided
   filter (`edgeMode: 'guided'`, default) or guided + closed-form matting (`'closed-form'`, Quality Best).

**Rendering** (preview and every export path are the same GPU code): Object Matte reads the frame's matte as a
texture (`u_object`, state uniform: matte / not computed in preview / outside the span) and applies the Roto Brush
Matte controls on the GPU — Feather, Contrast, Shift Edge (±100 % = ±10 px), Reduce Chatter (blend with neighbouring
frames' mattes), Use Motion Blur (shutter-angle samples of neighbouring mattes), Decontaminate Edge Colors — then
views Final / Alpha / Alpha Overlay / Alpha Boundary / Decontamination Map. Object Blur blurs (Gaussian), pixelates
(Mosaic) or fills the object or everything else (Blur Faces uses it). Both are ordinary effects, so they keyframe,
reorder, take effect masks, work on nests and adjustment layers like any other effect. The Screen Keyer's Inside /
Outside Mask take roto objects of the same clip. A clip cut out by Object Matte on a matte track drives a Track Matte Key
(the hub reads the matte track's finished picture, effects included; by design, not separately tested).

Preview resolves per-frame URLs (`/mg/roto/<key>?n=<frame>`, signed in export), prefetches 4 frames ahead, keeps an
LRU of 96 decoded mattes and shows the last good matte while a frame loads. Export never draws a frame without its
matte: a missing matte fails the render (`ROTO_MATTE_MISSING`) and the planner refuses an uncomputed span before any
work (`ROTO_NOT_COMPUTED`, all paths: native, hybrid layer bake, Remotion).

**Face tracking**: BlazeFace short-range detection (letterboxed 128², 896 anchors, weighted NMS, plus overlapping
tiles for small faces; detections inside a bigger face are dropped), Face Mesh V2 landmarks (478 points) in a rotated
ROI, then tracked from the previous landmarks with re-detection every 12 frames. Each face becomes a matte (the mesh
oval, grown by Expand %, or an ellipse) in a `faces` roto, plus a pose per frame (centre, size, angle). `blur_faces` /
**Blur Faces** = track + Object Blur in one History entry; `roto.faceTracker` / **Face to keyframes** turns a face
into a planar tracker so the tracking workstream's `tracker.apply` bakes position / scale / rotation keyframes onto
another clip.

**Models** are not shipped. Preferences ▸ Roto & Face Tracking lists them with size, licence, attribution and
source; Download shows the licence first, fetches from Hugging Face at a pinned revision, verifies SHA-256, writes a
`NOTICE.txt` next to the weights (`<appdir>/models/vision/<id>/`). Delete keeps computed mattes.

| Model | Licence | Size | Revision |
|---|---|---|---|
| SAM 2.1 hiera-tiny (Meta), ONNX export by onnx-community | Apache-2.0 | 155.6 MB | `814a0666…` |
| MediaPipe Face Landmarker (Google): BlazeFace short-range + Face Mesh V2, ONNX by F. Tonon | Apache-2.0 | 5.3 MB | `32714088…` |

SAM 2.1 tiny was chosen over MobileSAM (EffectCraft's default): same licence class, a stronger image encoder, and its
mask decoder's object-presence score lets us return "no object" instead of a hallucinated mask.

## 3. Usage

- **UI**: select a video or still clip → Properties ▸ Roto ▸ **Roto Brush** (or clip menu ▸ Roto ▸ Roto Brush), paint
  over the object on the Program monitor. Alt/Option-drag subtracts, Shift-drag draws a box, Ctrl/Cmd-drag resizes
  the brush, `[` / `]` change the size while the tool is on; Segment / Refine Edge brush toggle. Each stroke segments
  the current frame at once (a "Propagate Roto" entry for that frame); **Propagate** (both / forward / backward) runs
  an engine job with progress and **Stop**; frames before a correction are reused. View: Alpha Overlay, Alpha
  Boundary, Alpha, Off (`roto.cycleView`). **Convert to Masks**, **Freeze**, **Track Faces**, **Blur Faces**. Effect
  Controls ▸ Object Matte ▸ Object picks the roto object.
- **Effects** (Effects panel, Keying / Matte): Object Matte, Object Blur, Screen Keyer, Refine Soft Matte, Refine Hard
  Matte, Key Cleaner, Advanced Spill Suppressor.
- **MCP**: `list_roto_models`, `install_roto_model`, `remove_roto_model`, `create_roto` (points / box / strokes →
  segment, propagate, apply), `add_roto_strokes`, `propagate_roto`, `get_roto`, `apply_object_matte`,
  `convert_roto_to_masks`, `freeze_roto`, `remove_roto`, `track_faces`, `blur_faces`, `face_to_keyframes`.
  Cancelling an MCP request cancels the job and deletes its partial output.
- **HTTP**: `GET /api/roto/models`, `POST /api/roto/models/:id/install`, `DELETE /api/roto/models/:id`,
  `POST /api/roto/segment[?wait=1]`, `POST /api/roto/trace`, `GET /api/roto/sets/:key`, `GET /mg/roto/:key?n=`.

## 4. Verified behaviour

All measured on this machine (12 cores, shared with other agents; load average noted).

| What | How | Result |
|---|---|---|
| Real model download through the app | MCP `install_roto_model` against a fresh appdir (engine :49281), Hugging Face, SHA-256 checked | SAM 2.1 tiny 155.6 MB ≈ 9 s, face models 5.3 MB ≈ 1 s; both `installed: true` |
| SAM 2.1 end to end | `create_roto` one point on `roto-object.mp4` frame 10, `engine: 'model'`, propagate both ways (45 frames, 640×360), `render_frame` vs the analytic ellipse | IoU 0.9872 / 0.9840 / 0.9824 / 0.9808 at frames 0 / 10 / 25 / 44; 45 model frames in 326 s (0.14 fps) at load ≈ 26; 30 frames in 91.8 s at lower load earlier |
| Classic engine | `apps/engine/test/roto.test.ts`, 30 frames | mean IoU 0.9866, 19.4 s |
| Blur Faces end to end | `blur_faces` mosaic on a 30-frame 640×480 face clip (public-domain Lincoln portrait, animated), render + export frames looked at | 30 frames tracked in ≈ 5 s, mosaic follows the face; landmark jitter ≈ 1 px |
| Every export path | the same project exported with the planner's default route and with `engine: 'remotion'`; frames 25 / 75 extracted with ffmpeg and looked at | object cut out and faces mosaicked in both, identical to `render_frame` |
| Composes with effect masks | `apps/mcp/test/roto.test.ts`: a left-half effect mask on the Object Matte | left half cut out, right half keeps the plate, object kept |
| Export refusal | `start_export` before propagation | `ROTO_NOT_COMPUTED` |
| UI | `e2e/roto.spec.ts` (Playwright, built stack): brush stroke → one "Roto Brush" entry + Object Matte, segmented frame shown; Propagate (one entry, `Computed 0–44`), views, Convert to Masks + undo, Effect Controls object picker, Freeze | 4/4 pass; screenshots `test-results/e2e-roto-*.png` looked at |

Tests: `apps/engine/test/roto-core.test.ts` (max-flow vs brute force, GMM, guided filter / closed form, codec,
segmentation of synthetic shapes, propagation), `apps/engine/test/roto.test.ts` (service, store reuse, cancel cleans
up, SAM when `JASPER_ROTO_MODELS_DIR` has the model, faces), `packages/project/test/roto.test.ts` (commands with
undo / redo and refusals, staleness, snapshot states, export issues, copy / paste / preset dropping foreign roto
refs, repair, face tracker), `packages/compositions/test/fx-object-matte-gl.test.ts` and
`fx-keying-matte-gl.test.ts` (GL: every view and control of the seven effects against CPU expectations),
`apps/mcp/test/roto.test.ts`, `e2e/roto.spec.ts`.

## 5. Comparison with the references

**After Effects** (research, not measurement — see §7). Matches: the Roto Brush workflow (base frame, span,
propagation both ways, corrective strokes, Alt subtracts, Ctrl-drag brush size, Freeze), Alpha / Alpha Overlay / Alpha
Boundary views, the Roto Brush Matte controls (Feather, Contrast, Shift Edge, Reduce Chatter), Refine Edge as a
separately painted band, Use Motion Blur / Shutter Angle, Decontaminate Edge Colors / Amount / Extend Where Smoothed /
Increase Decontamination Radius / View Decontamination Map; Keylight's control set and its 11 views; Refine Soft /
Hard Matte, Key Cleaner and Advanced Spill Suppressor (Standard / Ultra with Key Color, Tolerance, Desaturate, Spill
Range, Spill Color Correction, Luma Correction) by name, range and default. Premiere Pro has no Roto Brush; the
reference is After Effects' (Premiere users round-trip to After Effects for it). Face
tracking follows After Effects' Face Tracking (Outline Only) — a face outline matte that follows the face — plus a
pose for keyframes; one-click Blur Faces has no Adobe equivalent and is ours. Different on purpose: our mattes are
computed by an explicit Propagate job (After Effects propagates lazily while you scrub), so export can never render
a half-propagated span; the matte is an effect you can reorder and reuse (Object Matte, Object Blur, Screen Keyer
masks) instead of one fused effect.

**EffectCraft**: equal on the algorithmic core (same graph cut, GMM, banded coarse-to-fine, flow-warped propagation,
guided / closed-form edges, chain keys). Better here: SAM 2.1 instead of MobileSAM with a presence score; mattes are
stored once per chain key and shared between rotos / projects (hard-linked sets) instead of per-instance RLE in the
project; the matte controls run live on the GPU (no re-segmentation when Feather / Shift Edge / Chatter change);
face tracking produces mattes and a one-click blur in addition to poses. Not carried over: EffectCraft's Face Track
Points / Face Measurements data effects (our faces give a pose, not 478 animatable points).

## 6. Limits

- Model speed is CPU-bound: SAM 2.1 tiny costs ≈ 1.8 s encode + 75 ms decode per 1024² frame unloaded (≈ 3 s per
  frame for a full propagation step; ≈ 7 s under load 26). The classic engine is ≈ 5× faster (19.4 s vs 91.8 s for 30 frames) and nearly as good on
  clean plates; `engine: 'classic'` is a setting.
- Refine Soft / Hard Matte's temporal controls (Reduce Chatter, Motion Blur) read neighbouring frames of the clip's
  *source* (before earlier effects), not the output of the effects above them in the stack.
- The monitor overlay of a roto on a clip with corner pin / distortion effects is drawn with the clip's affine
  transform (the cut-out itself is exact).
- No default shortcut for the Roto Brush tool: Premiere has none (it has no Roto Brush) and After Effects' Alt+W is
  not a Premiere default we can mirror; it can be bound in the keyboard shortcuts editor (`roto.tool`).
- Face tracking finds frontal and moderately turned faces (MediaPipe short-range model; estimated minimum face size ≈ 40 px, from the tiled 128² detector input); profile faces
  and heavy occlusion lose the track until the next re-detection (every 12 frames).
- Mattes are 8-bit, at most 1920 px on the long side (larger sources are matted at 1920 px and the matte is
  upsampled bilinearly on the GPU).

## 7. Sources (Adobe documentation and references)

helpx.adobe.com answers `403 Access Denied` to this host (curl, WebFetch and the headless browser), so the pages
below were read through search-engine excerpts and secondary guides; where a value was not documented (e.g. Shift
Edge's pixel scale, Reduce Chatter's frame window) we took EffectCraft's documented choice and say so in code.

- Adobe, "Roto Brush and Refine Matte in After Effects" —
  https://helpx.adobe.com/after-effects/using/roto-brush-refine-matte.html (base frame, span, propagation, Freeze,
  views, Roto Brush Matte and Refine Edge controls, motion blur, decontamination).
- Adobe, "Matte effects" (Refine Hard Matte, Refine Soft Matte, Matte Choker, Simple Choker) —
  https://helpx.adobe.com/ca/after-effects/desktop/apply-effects-and-animation-presets/list-of-effects/matte-effects.html
- Adobe, "Keying effects" (Keylight, Key Cleaner, Advanced Spill Suppressor) —
  https://helpx.adobe.com/after-effects/using/keying-effects.html and the how-to
  https://helpx.adobe.com/lt/after-effects/how-to/fix-green-screen-footage.html
- Adobe, "Face Tracking" (Face Tracking (Outline Only) / Detailed Features) —
  https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/track-faces/facetracking.html
- Foundry, Keylight reference (the plug-in bundled with After Effects; views Source … Final Result, Screen Gain /
  Balance, biases, Clip Black / White / Rollback, Despot, Replace methods, Inside / Outside masks) —
  https://learn.foundry.com/nuke/content/reference_guide/keyer_nodes/keylight.html
- No Film School, "Key Cleaner & Advanced Spill Suppressor" (Ultra mode from Premiere's keyer) —
  https://nofilmschool.com/2014/07/after-effects-key-cleaner-advanced-spill-suppressor
- FilmDaft, "How To Roto Brush In After Effects, Part 2: Advanced Settings" (Feather / Contrast / Shift Edge / Reduce
  Chatter, motion blur samples and shutter angle) —
  https://filmdaft.com/roto-brush-tutorial-part-2-after-effects-advanced/
- Algorithms: Boykov & Kolmogorov (PAMI 2004), Boykov & Jolly (ICCV 2001), Rother et al. GrabCut (SIGGRAPH 2004),
  Lombaert et al. banded graph cuts (ICCV 2005), Bai et al. Video SnapCut (SIGGRAPH 2009), He et al. guided filter
  (PAMI 2013), Levin et al. closed-form matting (PAMI 2008), Farnebäck (SCIA 2003), Ravi et al. SAM 2 (2024),
  Bazarevsky et al. BlazeFace (2019), Kartynnik et al. Face Mesh (2019).
