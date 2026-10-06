# wave1/native-animated-export — keyframed Motion, Opacity, crop and volume on the native path (+ wave1b sub-pixel, wave1c GPU spans)

Branches `wave1/native-animated-export` (from `b56f7d4`) and **`wave1b/native-subpixel`** (from `feat/effects-system`
`749c7a2`: sub-pixel layers, see "wave1b" below — it replaces the whole-pixel Motion placement of wave1 for every
layer whose geometry is not whole pixels). Spec: S03 §3.2 (DM-010/012), §4.2 (RND-010), §12.2
(KF-010), §15 (FX-040, AC-FX-1), §21.2 (ENG-030/032/033); S04 §11 (RP-001/008), §12.2 (RN-020/021/022).
Decision: ARCHITECTURE **D-34** (narrows D-28).

## State before

- `planner.ts` blocked keyframed Motion (`position`, `anchor`, `scale`, `scaleWidth`, `rotation`) and keyframed
  opacity ("not native in M1"), keyframed built-in effects (crop edges), and keyframed audio levels (clip, track,
  master volume; pan).
- In a full engine the `warp` extension (wp-m2-track, D-28) **claimed** layers with keyframed Motion/opacity of the
  kinds video, still, animated-image, solid and composition, so those already exported natively: every claimed
  layer is warped per frame in 12 worker threads into a sequence-size ProRes 4444 intermediate
  (`cache/warp/*.mov`), then overlaid. They fell back to Remotion only without the warp extension, for kinds it does
  not claim (fframes `motion-graphic` with keyframes), with a keyframed crop, or with keyframed volume/pan.

## What was built

| Item | Where |
|---|---|
| Per-frame sampling → piecewise-linear fit → ffmpeg expressions | `apps/engine/src/export/keyframed.ts` (`fitPieces`, `piecewiseExpr`, `frameIndex`, `framesWhere`) |
| Motion → Opacity stage (static and keyframed, one code path) | `keyframed.ts` `motionStage`, `motionFilters`, `mergeResize`; used by `native.ts` `buildNativeGraph` |
| Keyframed crop edges | `keyframed.ts` `cropMaskFilter`, `native.ts` `layerSourceChain` (also used by the warp decode) |
| Keyframed clip / track / master volume | `keyframed.ts` `audioVolumeFilters`, `native.ts` audio chains |
| Planner | `planner.ts`: Motion/opacity/crop-keyframe and volume-keyframe blockers removed; pan stays blocked (static and keyframed, precise reasons) |
| Warp stage | `warp/extension.ts`: claims corner pins (as before) and keyframed Motion/opacity of **animated images** only; keyframed built-in effects (crop) are no longer warp blockers (the source chain renders them) |
| Tests | `apps/engine/test/native-animated.test.ts` (new), `warp.test.ts` (two expectations updated) |

### How values reach ffmpeg

Every frame of the layer is evaluated with `resolveLayerProps(clip, clipContentTime(clip, f))` — the shared
evaluator (`evaluate`, S03:KF-010) — so linear, Bezier (incl. auto/continuous), hold and the new spatial (curved)
position paths come out exactly as the composition draws them, with no interpolation code in the engine. The samples
are fitted piecewise-linearly (Ramer–Douglas–Peucker over the integer frames, forced breaks every 1024 frames so the
fit is O(n·1024) on any data; tolerances 0.1 px, 0.005°, 0.1 % opacity, 0.01 dB, inside ENG-032's 0.25 px / 0.1°);
a hold is a one-frame piece and stays exact. Each fit becomes `st(0,t*num/den);if(lt(ld(0),a),…,…)` — a balanced
tree, depth log₂(pieces). Expression size grows with the number of pieces, not the clip length (a linear 100 000-frame
ramp is ~100 pieces because of the forced breaks; a 10 s 900 px eased move is ~70). Graphs over 60 kB already go to a
`-filter_complex_script` file, so there is no expression-length limit to fall back from.

- **Why `t`, not `n`:** FFmpeg 7.1 numbers `n` from 1 in `scale` and `overlay` but from 0 in `rotate` (measured); `t`
  is the frame's own timestamp everywhere. (`geq` spells it `T`.)
- **Why not `sendcmd`/`zmq`:** a command is applied when the frame carrying it passes `sendcmd`; a target filter can
  still hold an earlier frame in its queue (the 7.1 scheduler activates the highest-`ready` filter, ties by graph
  order), so values could land one frame early. Expressions are evaluated per frame inside the filter.

### The Motion → Opacity stage (S03:DM-010, RND-010 order)

`flips → scale → rotation about the centre → alpha multiply → (transition fades) → overlay`, positions from
`M = P + R·S·(q − A)` of the shared `layerMatrix`:

- **Flips** (`flipH/flipV`, or an eased scale overshooting 0): `hflip`/`vflip` on the fixed-size source, with a
  timeline `enable` when the sign changes per frame.
- **Size:** `scale` with per-frame `w`/`h` (`eval=frame`, whole pixels). When no effect sits between the source's
  own scale to the layer box and Motion, the two are folded into one (`mergeResize`: decode → per-frame size → RGBA
  in one resample, with the source's colour matrix and swscale flags). That halved the PiP's CPU cost. A per-frame
  size re-creates the scaler every frame, so it gets swscale slice threads (`threads=min(8, job threads)`).
- **Rotation** (keyframed, or any angle together with a keyframed size): a 2 px transparent border (`pad`,
  `eval=frame`) — FFmpeg's `rotate` reads the edge row for samples up to 1 px outside its input, which made the old
  static path's rotated layers ~1 px fat — then `rotate` with the per-frame angle into one fixed frame (the largest
  rotated bounds), centre on centre (measured: ≤ 0.03 px), then `unpremultiply`. Pixels are premultiplied first
  (`premultiply`, on the fixed-size source) unless the source is opaque-or-clear (video/still without alpha,
  opaque solids, effects limited to flips / static crop / colour), where straight and premultiplied bilinear agree.
  Static quarter turns of a fixed-size layer stay exact `transpose`/flips.
- **Without rotation:** `pad` (`eval=frame`) centres the per-frame picture in a fixed box; the overlay offset repeats
  the size expression to account for the box offset's ½-pixel parity (otherwise the centre wobbles by ½ px as the
  size parity changes).
- **Opacity** (and frames with a zero scale): alpha × a per-frame constant — `geq` on a 1×1 gray stream (one
  expression evaluation per frame), `scale` to the frame size, `lut2` (`x·y/255`) with `alphaextract`, `alphamerge`.
  `colorchannelmixer` has no per-frame expression and ~2× the cost.
- **Position:** `overlay` `x`/`y` per frame, whole pixels (like the M1 static path).

A layer without keyframes is the one-sample case of the same code. Two static-path outputs changed with it:
rotated layers (padded, premultiplied `rotate`: corner error 1.6 → 0.7 px vs the evaluated quad) and scaled media
layers without effects (one resample instead of two).

### Crop with keyframed edges

`crop` evaluates only `x`/`y` per frame, so a keyframed crop multiplies the alpha with a per-frame rectangle mask:
a white `w×h` (per-frame `scale` of a 1×1 white) in the middle of a black `2bw×2bh` (`pad`), cut back to `bw×bh` by
`crop` at a per-frame offset. Edges are whole pixels like the static crop. Feather is rendered by neither engine
(no-op in both).

### Audio levels

Per frame: clip volume at the clip frame's content time, track and master volume at its sequence time, handles take
the nearest clip frame — the same sampling as the composition's `audioGainAt`. `asetnsamples=128` +
`volume=…:eval=frame`: the gain steps at frame boundaries (≤ 2.7 ms late), like Remotion's per-frame volume;
≤ −96 dB is silence (`dbToGain`). Pan stays blocked: the composition does not pan (S03:KND-012 P1), so a native pan
would make the export differ from the preview; and S01:FX-010's −3 dB-centre law would also change every unpanned
mix.

## wave1b — sub-pixel layers (`wave1b/native-subpixel`)

The wave1 filtergraph placed and sized layers in whole pixels: a 0.05 px/frame pan stepped by 1 px every 20 frames.
That was rejected. Now a layer whose Motion has keyframes, or whose static geometry (scaled size, position, rotation,
crop edges) is not whole pixels, is **drawn by our own kernel and streamed into the composite**; layers with
whole-pixel geometry (the common full-frame clip) keep the filter path (`motionStage`, exact there).

### Approaches measured (LGPL FFmpeg 7.1, this host)

| Approach | Result |
|---|---|
| Pure filters: `overlay`/`pad`/`crop` take integers, `scale` makes integer sizes, `zoompan` crops at integers, `rotate` maps centre to centre only | no per-frame fractional translation or fractional scale without `perspective` (GPL) |
| `geq` with bilinear `p(X−dx, Y−dy)` | 150 ms CPU per 0.75 Mpx frame with a constant shift, 350 ms with a per-frame expression; translation only. Rejected |
| `sendcmd`-driven `convolution` / `colorchannelmixer` | commands can land one frame early (see wave1); rejected |
| swscale on a padded source (fractional placement via pad + scale ratios) | needs per-frame pad/crop sizes, which `pad`/`crop` cannot take from `t`; rejected |
| `libplacebo` (float `pos_x/pos_y`) | needs a Vulkan device (lavapipe here; not on every user machine, no MoltenVK in our macOS build); rejected |
| Supersampled compositing | not needed |
| **Warp kernel, but layer-sized and streamed** (chosen) | exact affine, any scale/rotation, one resample, no intermediate file; fastest of all measured paths (below) |

### How it works (`apps/engine/src/export/stream/`)

- **Plan** (`plan.ts`, in `buildNativeGraph`): every frame is evaluated with `resolveLayerProps` (shared evaluator);
  the layer map, opacity and crop give the inverse map output px → picture px, the drawn rectangle and the visible
  part. The streamed frame is as large as the layer's bounds over the clip (clamped to the sequence ± 2 px); its
  per-frame integer offset is `round(fit(left − 2))` from a piecewise-linear fit (`overlay` x/y expressions, the same
  values JS uses; ties nudged away so ffmpeg and JS round alike). The fraction lives in the drawn pixels.
- **Decoder** (one ffmpeg per layer): the layer's source chain (`layerSourceChain`: seek, speed, box scale, effects;
  crop left out) as raw RGBA on stdout. Layers drawn below half size are pre-scaled like a mipmap (largest
  power-of-two reduction still ≥ the drawn size, folded into the source's own scale; levels change rarely, so the
  scaler is rarely re-created) — the kernel then minifies by < 2×, as the browser samples a layer.
- **Kernel** (`kernel.ts`, worker threads, `pool.ts`): the browser's way of drawing a transformed layer box — the
  visible rectangle (picture or crop) gets anti-aliased edges from geometric **coverage** (signed distance of the
  pixel centre to each edge, in output px; product at corners), the colour is bilinear with clamp-to-edge on
  premultiplied colour, alpha × coverage × opacity. Coverage edges move continuously at any scale; the warp stage's
  "texels outside are transparent" bilinear edges step under minification (measured below).
- **Composite**: the frames go to the composite ffmpeg on extra pipes (`spawnTool({pipes})`, `-f rawvideo -i
  pipe:3…`), then fades and `overlay` at the per-frame integer offset. Producers run while the composite runs
  (`ExportService.runNative`); a failed producer stops the composite and is the reported error; frame count is
  verified as before.
- **Crop** is no longer a mask in the decoder for these layers: the kernel clips to the per-frame crop rectangle
  (mirrored by an odd number of flip effects, crop first like the composition), with the same coverage edges.
- **Rotation, non-uniform scale, flips, anchor**: all in the affine map (no `rotate` filter, no centre/parity issues).

### wave1b measurements

Shared 12-core host (other agents running; load noted per run).

**Smoothness** — `native-animated.test.ts` "a 0.05 px/frame pan over 300 frames": a 384×216 white card (20 % of a 1080p
solid) panned 14.95 px in 300 frames on a fractional y, exported (ProRes 4444), per-frame intensity-weighted centroid
vs the evaluated layer centre:

| Path | x RMS | worst step error | smallest step | worst y error |
|---|---|---|---|---|
| **Sub-pixel (this branch)** | **0.0010 px** | **0.0032 px** | **0.0468 px** (monotonic) | **0.0000 px** |
| Whole-pixel filtergraph (wave1) | 0.289 px | 0.95 px (1 px jumps) | 0 (stalls) | 0.40 px |
| Warp stage (`b56f7d4`) | 0.235 px | 0.20 px | 0 (stalls) | 0.40 px |

(The warp stage minifies 5× with plain bilinear and transparent-texel edges, so its 20 % layer also steps.) Kernel-only
check (no ffmpeg) at 20, 37, 50, 63, 80, 95, 100, 130 % scale: edge position RMS ≤ 0.0023 px (test asserts ≤ 0.01).

**Geometry** (every frame of the 48-frame keyframed card, coverage-integral edge fits, corners inside the frame):
worst corner error **0.050 px**, colour ≤ 5/255 (ProRes ringing; mean < 1); keyframed crop + keyframed non-uniform scale
on a rotated solid: **0.014 px**.

**Parity with Remotion** (`REMOTION_E2E=1`):

| Path | Lossless stills (native PNG vs `renderStill` PNG, 9 frames): SSIM min / mean, corner error max | Exports (ProRes 4444 vs Remotion export, 48 frames): SSIM min / mean, corner error max |
|---|---|---|
| **Sub-pixel (this branch)** | **0.99999 / 1.0000, 0.051 px** | 0.9935 / 0.9955, **0.050 px** |
| Warp stage (`b56f7d4`) | 0.9999 / 0.9999, 0.084 px | 0.9936 / 0.9955, 0.084 px |
| Whole-pixel filtergraph (wave1) | 0.9980 / 0.9988, 0.645 px | 0.9917 / 0.9951, 0.717 px |
| Remotion itself vs the evaluated quad | 0.147 px | 0.190 px |
| Static layer (same props, frame 26): sub-pixel / warp-era static / wave1 static | — | 0.9959 / 0.9939 / 0.9952 SSIM; 0.008 / 1.72 / 0.51 px |

The export comparison is limited by codec noise, not by the renderers: Remotion's export goes through a ProRes 422 HQ
intermediate (chroma subsampled, DCT ringing next to the saturated cells — visible as 8…29 code values around a
20-gray plate where the native frame is flat), so its worst frames (38–43, large card) score U/V ≈ 0.9915 for every
native path. The lossless still comparison isolates the renderers: the sub-pixel kernel matches Chrome to
SSIM 0.99999 (mean |Δ| 0.001 code values on flat areas, ~2 on edges). Against the old warp path the export SSIM
minimum differs by 0.0001 (0.9935 vs 0.9936) — within that codec noise; on lossless stills the sub-pixel path is closer.

**Speed** (`NATIVE_ANIM_BENCH=1`, 300 frames 1080p30 → H.264 (OpenH264), fresh engine per run, full job time;
interleaved runs, load average 15–25 except the first sub-pixel run at ~3):

| Fixture | Remotion | Warp stage (first / cached re-export) | Whole-pixel filtergraph | **Sub-pixel streamed** |
|---|---|---|---|---|
| Plate + keyframed 1080p PiP | 145.6 s | 23.7 / 9.8 s; 25.7 / 13.3 s | 21.2 s; 16.6 s | **12.7 s (load 3); 10.6 s; 10.3 s** |
| Plate + 3 keyframed 640×360 cards | 93.0 s | 35.9 / 15.8 s; 37.8 / 17.4 s | 44.8 s; 19.4 s | **9.1 s (load 3); 9.3 s; 21.5 s¹** |

¹ load spike. The sub-pixel path is the fastest first export (≈2× the warp stage, 1.6× the whole-pixel filtergraph on
the PiP; up to 4× on small layers) and 9–14× faster than Remotion. It has no cache (no intermediate): the warp
stage's cached re-export of the full-screen PiP (9.8–13.3 s) is about as fast as a sub-pixel first export.

## wave1c — GPU effects and GPU transitions (`wave1c/native-gpu-spans`, D-35)

### What happened before (measured on `feat/effects-system` `29f9b7c`, plan of a 1080p sequence)

| Content | Plan |
|---|---|
| video + `jasper.s.flicker` (time-dependent GPU) | **remotion** — blocker "video clip … uses effect jasper.s.flicker, which the native path cannot render" |
| video + `jasper.bevel-edges` (time-invariant GPU) | **remotion** (same blocker) |
| solid + GPU effect | **remotion** (same blocker) |
| text + GPU effect | hybrid — DOM layers were already baked (per-frame masters for time-dependent GPU effects) |
| two solids + Push (GPU transition) | **remotion** — blocker "transition "Push" is a GPU transition" |

So the shader framework's per-frame bakes covered DOM layers only; any GPU effect on media, and any GPU transition,
sent the whole export through Remotion.

### Approach

All in the `layer-bake` extension (it already renders one-clip documents through Remotion into cached straight-alpha
masters with child jobs, page budget, shared browser, GC and pins) plus two `NativeExtension` hooks:

- **GPU-effect media layers**: `needsBake(c)` = DOM layer, or a video / still / solid / animated-image layer with a
  browser-only effect (`hasBrowserEffect`: enabled, known, video, not a colour op, not crop/flips/corner pin). The
  whole layer is baked like a DOM layer (source, effects in stack order, Motion, opacity; colour runs still applied by
  ffmpeg, LBK-010); videos are always masters, stills/solids with time-invariant effects one PNG. The key keeps the clip
  id (GPU effects seed by it).
- **GPU transition spans**: `planSpan` builds the render document of one span — the track's sides A and B (whole
  clips with handles and every enabled effect) and the transition stage, shifted so the span starts at frame 0,
  transparent background, no layer filter — and its content key (sides, transition incl. keyframed params, media
  fingerprints, fonts, environment). The master is rendered by the same child-job machinery; a still inside the span
  uses the cached master or bakes one frame.
- **Planner**: `bakesTransition` → the span is a graphics group (`engine: 'remotion'`, item = transition id), path
  `hybrid`; without the extension (or without the Remotion renderer) the blocker stays, now saying "no span renderer
  is available".
- **Builder**: per track, a baked span cuts its sides (A drawn up to the span, B from its end) and is overlaid as a
  `sequence` override over the span, above the track's clips — where the composition draws the stage. Range exports
  seek into the master.
- **Export UI**: the plan summary of a hybrid export says how many layers or transitions Remotion pre-renders.
  (The timeline render bar is about live preview, where GPU effects and transitions play in real time: unchanged.)

### Measurements

**Parity** (`gpu-spans.e2e.test.ts`, REMOTION_E2E=1, 720p30, 90 frames): a PNG card → blue solid with Iris Round
(keyframed border width 0 → 24 px, yellow border) and a small solid with two stacked GPU effects (Bevel Edges +
S_Flicker, time-dependent) on V2. Hybrid ProRes 4444 export vs Remotion `renderStill` of the whole sequence at frames
5, 20, 35, 40, 45, 50, 54, 55, 70, 89 (before, inside and after the span): **100.00 % of samples within 3/255 on every
frame** (the LBK parity bar is ≥ 99 %). Plan: `hybrid`, no blockers, exactly two bakes (span + layer); the re-export
renders **no bake** and is identical.

**Speed** (`GPU_SPANS_BENCH=1`, 59.5 s 1080p30 → H.264 OpenH264: 7 video clips, 3 GPU transitions of 20 frames —
Iris Round, Push, Cross Zoom —, Color Emboss on one 8.5 s clip, a 5 s lower third with Bevel Edges + S_Flicker; fresh
engine; shared host, load 20–50):

| Export | Wall time |
|---|---|
| Full Remotion | 881.6 s |
| **Hybrid (5 bakes: 3 spans, 2 layers)** | **351.8 s (2.5×)** |
| Hybrid re-export (masters reused, 0 bakes) | 95.8 s (9.2×) |

Most of the hybrid time is the bakes (≈ 540 of 1785 frames rendered by Remotion, the 8.5 s video with Color Emboss
the largest); exports with GPU transitions only bake 20 frames per transition.

### Limits

- A GPU-effect layer is baked whole (its source too): a long video clip with a GPU effect costs Remotion time for its
  whole length (still far less than the whole export).
- Composition clips (mg bundles) with GPU effects are not baked by this rule (their pictures come from the mg masters);
  they still route to Remotion.
- DOM sides with colour effects inside a span render ungraded in the master, as on the Remotion path (which fails
  them with `FX_TRANSITION_UNSUPPORTED`).

## Now native vs still blocked

| Native now | Still blocked (precise blocker) |
|---|---|
| Keyframed position (linear, Bezier, auto/continuous Bezier, hold, spatial paths), anchor, scale, scale width, rotation, opacity — video, still, solid, fframes motion-graphic, composition (`layer` override) | Animated images: still not a native kind; with keyframed Motion the warp stage keeps them (unchanged) |
| Keyframed crop edges (and feather, which neither engine renders) | Gaussian blur, static or keyframed ("uses effect jasper.gaussian-blur, which the native path cannot render"): needs a transparent margin past the box (CSS blur spreads) and premultiplied blur; `gblur` takes `sigma` only as a command, so keyframes would need `sendcmd` |
| Colour-run effects with keyframes (already native via the colour extension, unchanged) | Audio pan, static or keyframed ("animated audio pan is not supported by the native path") |
| Keyframed clip / track / master volume | Audio effects, reversed audio/video, blend modes (unchanged) |
| Corner pins + keyframed Motion (warp stage, unchanged) | |

## Measurements

Shared 12-core host with other agents compiling (load average 8–60 during the runs, never idle). Wall-clock numbers
below were interleaved before/after at similar load; treat them as ratios.

**Geometry** (`native-animated.test.ts`, every frame of a 48-frame card with linear, eased and hold position keys,
keyframed anchor, eased rotation, scale and opacity; corners from sub-pixel edge fits vs the evaluated quad):

| Case | Corner error (max over all frames) | Colour |
|---|---|---|
| Keyframed card (ProRes 4444 export) | 0.74 px | ≤ 3.5/255 |
| Keyframed crop edges + keyframed non-uniform scale, rotated solid | 0.79 px | — |
| Keyframed volume (clip + track + master), per-frame gain vs expected | 0.17 dB max (AAC) | — |

The warp stage measured 0.05 px for keyframed Motion (sub-pixel warp); the filtergraph places layers on whole pixels
like the M1 static path (bound per edge: ½ px position rounding + ¼ px size rounding).

**Parity with Remotion** (`REMOTION_E2E=1`, same fixture rendered by both paths, every frame, ffmpeg `ssim`):

| Render | SSIM per frame, min / mean (≥ 0.98 required) | Samples within 8/255, min | Corner error vs evaluated quad, max |
|---|---|---|---|
| Keyframed card, this branch (filtergraph) | **0.9917 / 0.9951** | 98.2 % | 0.74 px |
| Keyframed card, before (warp stage) | 0.9936 / 0.9955 | 98.4 % | 0.20 px |
| Same layer without keyframes, this branch (static: padded premultiplied `rotate`) | 0.9959 | 99.2 % | 0.15 px |
| Same layer without keyframes, before (M1 static `rotate`) | 0.9935 | 99.0 % | 1.61 px |
| Remotion itself vs the evaluated quad | — | — | 0.29 px (card), 0.12 px (static) |

Keyframed layers now match Remotion like static layers do (FX-040's 0.98 with margin); the warp stage's sub-pixel
warp is slightly closer (+0.002 SSIM) — the price of whole-pixel placement (see open issues).

**Speed** (`NATIVE_ANIM_BENCH=1 [NATIVE_ANIM_BENCH_REMOTION=1]`, 300 frames 1080p30 → H.264 OpenH264, fresh engine,
full job time):

Load average 7–10. Before = `b56f7d4` (keyframed Motion goes through the warp stage, which caches its
intermediates, so its re-export skips the warp); after = this branch (no intermediate, re-export = export).

| Fixture | Remotion path | Before: warp stage, first / re-export | After: filtergraph, first / re-export | First export speed-up |
|---|---|---|---|---|
| Plate + keyframed 1080p PiP (eased position, scale, rotation, fade-in) | 94.8 s | 14.4 / 6.8 s; 13.9 / 7.3 s | 10.8 / 10.5 s; 10.5 / 10.5 s | 1.3× vs warp, 9× vs Remotion |
| Plate + three keyframed 640×360 cards | 64.3 s | 23.1 / 10.8 s; 23.8 / 11.6 s | 13.5 / 19.8 s¹; 11.8 / 10.5 s | 1.9× vs warp, 5× vs Remotion |

¹ load spike during that run. Earlier rounds at load 15–22 gave the same ordering (PiP 14.1–17.1 s after vs 16.6–18.6 s
before; cards 12.8–13.3 s vs 31.3 s). The warp stage renders every claimed layer full-frame (W×H ProRes 4444, written
to `cache/warp`), so it costs the same for a small card as for a full-screen PiP; the filtergraph's cost follows the
layer size. The warp's cached re-export of the single full-screen PiP is faster (6.8–7.3 s vs 10.5 s): it then only
decodes the intermediate.

What previously fell back to Remotion even with the warp stage now exports natively at the "after" speed (~10× faster):
keyframed fframes motion graphics, keyframed crop edges on unpinned layers, keyframed clip/track/master volume, and
every keyframed layer on engines without the warp stage.

Filter-level CPU (FFmpeg 7.1 LGPL, `-benchmark`, 1080p RGBA): a per-frame size costs ~17 ms CPU more per frame
than a fixed one (the scaler is re-created whenever the size changes; swscale slice threads cut its wall time by
~1/3); folding the Motion scale into the source's scale cut the PiP graph from 66 to 45 CPU-s; `premultiply`
and `unpremultiply` cost ~20 ms CPU per 1080p frame each (hence skipping `premultiply` for opaque sources);
`colorchannelmixer` 20 ms vs `lut2`+`alphamerge` 10 ms.

## How to test

```bash
pnpm fixtures
pnpm vitest run apps/engine/test/native-animated.test.ts apps/engine/test/warp.test.ts apps/engine/test/export.test.ts
REMOTION_E2E=1 pnpm vitest run apps/engine/test/native-animated.test.ts -t "Remotion"     # parity (stills + exports)
NATIVE_ANIM_KEEP=/tmp/keep REMOTION_E2E=1 …                                               # keep the renders
NATIVE_ANIM_BENCH=1 NATIVE_ANIM_BENCH_REMOTION=1 pnpm vitest run apps/engine/test/native-animated.test.ts -t "export speed"
```

Measurements are appended to `$TMPDIR/native-animated.txt`.

## Open issues

- **Sub-pixel positioning** — done in wave1b (streamed kernel layers). The whole-pixel numbers in the wave1 sections
  above describe the filter path, which now only draws layers with whole-pixel geometry.
- **Extra pipes on Windows:** the streamed layers use inherited fds 3, 4, … (`pipe:N`). Verified on Linux; Windows
  (libuv passes extra stdio to the child's CRT) is not tested here — a localhost TCP input would be the fallback.
- **No cache for streamed layers:** re-exports redraw (the warp stage cached its intermediates).
- **`motionStage`'s per-frame geometry branches** (per-frame `scale`, `rotate` expressions) are no longer reached by
  keyframed geometry (it streams); they remain for completeness of the filter path.
- **Gaussian blur** is not native at all (static or keyframed), see above.
- **Pan** is rendered by no engine yet.
- **ENG-032's `sendcmd` fallback** is not implemented (not needed: no expression limit is hit; see "Why not
  `sendcmd`").
