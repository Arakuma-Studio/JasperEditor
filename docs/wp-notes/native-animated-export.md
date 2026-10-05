# wave1/native-animated-export — keyframed Motion, Opacity, crop and volume in the native filtergraph

Branch `wave1/native-animated-export` (from `b56f7d4`). Spec: S03 §3.2 (DM-010/012), §4.2 (RND-010), §12.2
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
REMOTION_E2E=1 pnpm vitest run apps/engine/test/native-animated.test.ts -t "Remotion"     # parity, ~4 min
NATIVE_ANIM_BENCH=1 NATIVE_ANIM_BENCH_REMOTION=1 pnpm vitest run apps/engine/test/native-animated.test.ts -t "export speed"
```

Measurements are appended to `$TMPDIR/native-animated.txt`.

## Open issues

- **Sub-pixel positioning.** Positions (and sizes) are whole pixels; slow moves step by 1 px where Chrome and the
  warp stage move smoothly. LGPL FFmpeg has no filter that translates by a fraction of a pixel per frame without
  `perspective` (GPL) or per-pixel `geq` (far too slow); a bilinear `convolution` per fractional offset would need
  `sendcmd` or one filter instance per offset. If this matters for a project, the warp stage could take such layers
  again (it is still the corner-pin path).
- **Gaussian blur** is not native at all (static or keyframed), see above.
- **Pan** is rendered by no engine yet.
- **ENG-032's `sendcmd` fallback** is not implemented (not needed: no expression limit is hit; see "Why not
  `sendcmd`").
