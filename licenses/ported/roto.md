# Code ported by the `roto` workstream (Roto Brush, object mattes, keying and matte tools, face tracking)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14f09bb064cab8f1f8fe85af601a08b6e53`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** roto workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/track/src/roto/maxflow.rs` | `apps/engine/src/roto/core/maxflow.ts` | Boykov–Kolmogorov max-flow / min-cut (search trees, augment, adopt orphans) on typed arrays |
| `crates/track/src/roto/gmm.rs` | `apps/engine/src/roto/core/gmm.ts` | GrabCut colour Gaussian mixtures (Orchard–Bouman splitting, hard-assignment EM, log-likelihoods) |
| `crates/track/src/roto/matting.rs` | `apps/engine/src/roto/core/matting.ts` | Exact Euclidean distance transforms, box / Gaussian filters, colour guided filter, closed-form matting (box-filter Laplacian, conjugate gradients) |
| `crates/track/src/roto/mod.rs` | `apps/engine/src/roto/core/segment.ts`, `apps/engine/src/roto/worker/run.ts` | Stroke-constrained graph-cut segmentation with iterated GMMs, coarse-to-fine banded re-cut, propagation by warping the previous matte and re-cutting in a band with a shape prior, model prompts (points along strokes; box, inner points and the warped matte) as a strong prior, chain keys per frame |
| `crates/track/src/roto/refine.rs` | `apps/engine/src/roto/core/segment.ts` (`matteAlpha`, `clean`), `packages/project/src/registry/fx/object-matte.ts`, `packages/project/src/registry/fx/matte-ops.ts` | Edge refinement of the binary cut (guided / closed-form in the edge band), and the Roto Brush matte controls (Feather, Contrast, Shift Edge, Reduce Chatter, motion blur, decontamination) rewritten as GLSL ES 3.00 passes |
| `crates/track/src/roto/tests.rs` | `apps/engine/test/roto-core.test.ts` | Synthetic-shape segmentation / propagation expectations (extended with IoU thresholds) |
| `crates/effects/src/keylight.rs` | `packages/project/src/registry/fx/keying-matte.ts` (`SCREEN_KEYER`) | Screen-difference keyer: screen gain / balance, biases, clip black / white / rollback, despot, shrink / grow, softness, replace methods, inside / outside masks, colour corrections, crops, the 11 views (Rust → GLSL) |
| `crates/effects/src/matte.rs` | `packages/project/src/registry/fx/keying-matte.ts` (Refine Soft Matte, Refine Hard Matte) | Matte refinement of an existing alpha (smooth, feather, choke / contrast, shift edge, chatter reduction over time samples, motion blur, decontamination) |
| `crates/effects/src/keying.rs` | `packages/project/src/registry/fx/keying-matte.ts` (Key Cleaner, Advanced Spill Suppressor) | Key Cleaner edge restoration and the Standard / Ultra spill suppression |
| `crates/segment/src/mediapipe.rs` | `apps/engine/src/roto/models/face.ts` | The MediaPipe face landmarker graph around the models: BlazeFace anchors and decoding, weighted NMS, detection → rotated ROI, landmarks → next ROI |
| `crates/track/src/face.rs` | `apps/engine/src/roto/models/face.ts` (`FACE_OVAL`, `faceOutline`, `facePose`) | Face outline from the mesh's oval landmarks, head position / scale / rotation from landmarks |
| `crates/raster/src/flow.rs` | `apps/engine/src/roto/core/segment.ts` (`warpPrior`), `apps/engine/src/roto/worker/run.ts` | Used as the reference for warping the previous matte by dense flow (our flow itself is OpenCV.js Farnebäck, Apache-2.0) |
| `crates/effects/src/roto.rs`, `crates/engine/src/roto.rs`, `crates/engine/src/commands/roto_cmds.rs`, `crates/ui-egui/src/panels/roto_tool.rs` | `packages/project/src/roto/index.ts`, `packages/project/src/commands/handlers/roto.ts`, `apps/engine/src/roto/service.ts`, `apps/web/src/roto/RotoOverlay.tsx` | Used as a design reference only: strokes / base frame / span model, derived mattes keyed by chain key, Freeze, the brush tool's interaction (Alt subtracts, Ctrl-drag sizes) |

Notes: everything is TypeScript (engine, child process) or GLSL ES 3.00 (effects). Not ported: EffectCraft's
MobileSAM / TFLite / PyTorch model runners (`crates/segment/src/{mobilesam,tflite,pt}.rs`) — we run SAM 2.1
hiera-tiny and the MediaPipe ONNX conversions through onnxruntime-node instead; its RLE matte storage
(`roto/rle.rs`) — mattes here are grey PNGs in a content-addressed engine cache served to the GPU effects; its
Face Track Points / Face Measurements data effects. New here: the engine roto worker and store, the Object Matte /
Object Blur effects reading per-frame matte textures, the export planner checks, the MCP tools and the web UI.
