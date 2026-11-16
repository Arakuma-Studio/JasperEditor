# Corner Pin motion blur

A layer moved by Corner Pin (`jasper.corner-pin`, typed by hand or written by Apply Tracking in corner-pin mode) blurs
its movement over a box shutter, with the settings and the model of Transform's motion blur
(fx-shader-framework.md §19). Before, a corner-pinned layer had no motion blur on any path (the pin is the layer map:
CSS `matrix3d` in the composition, the warp stage natively); the video team faked it with a per-frame Directional Blur.

## 1. Settings

The Corner Pin carries Transform's three controls, with the same names, defaults and ranges (Effect Controls rows
below the four corners; MCP `list_effects {effectId: "jasper.corner-pin"}`, `add_effect` / `set_effect_param`):

| Control | Default | Meaning |
|---|---|---|
| Use Composition's Shutter Angle (`useCompShutterAngle`) | on | Sequences have no shutter angle of their own, so on = no blur (as Transform; `transformShutterFrames`). |
| Shutter Angle (`shutterAngle`, animatable) | 0° (0…360) | Shutter of angle / 360 frames, centred on the frame (`centredShutter`). |
| Mo Blur Quality (`mbQuality`, advanced) | Auto | Draft / Auto / High: ≤ 16 taps 2.5 px apart / ≤ 64 taps 1 px apart / ≤ 96 taps 1 px apart (`mbQuality`). |

Existing projects keep drawing exactly as before: absent params read as the defaults (no blur), and a pin whose
shutter is off takes the old code path on every renderer.

## 2. Model

The pin of a frame, P(t) (layer px → pinned layer px, `boxToQuad` of the four corners; a non-convex quad is the
identity, as `cornerPinQuad`), stays the layer map on every renderer. The blur is a step at the end of the layer's
picture chain, in the layer's own pre-pin pixels y:

    out(y) = Σᵢ wᵢ · src(H(sᵢ) · y) / Σᵢ wᵢ,   H(s) = P(s)⁻¹ · P(frame)

so that P(frame) draws the pinned picture smeared over the shutter. Code: `packages/project/src/render/corner-pin-blur.ts`.

- **Sub-frame poses**: the pin's params at exact sub-frame times (`FxParamsAt`: the shared keyframe evaluator, so
  tracked per-frame keys and hand keys interpolate between frames as everywhere else, spatial metric included).
  32 key poses over the shutter (`planMotionBlur`, `mbKeyTimes`); each H normalised to w = 1 at the box centre and
  interpolated linearly (as S_WarpCornerPin's inverse pins).
- **Taps**: the travel of the pinned box corners and centre (canvas px) sets the count — about one tap per pixel,
  capped by the quality — with the framework's time warp (taps follow time and path length; tracked data that speeds
  up and slows down inside the shutter gets taps where it moves) and the per-pixel R2 jitter when capped or warped.
- **Sampling**: bilinear over the picture's texel centres with texels outside it transparent (premultiplied), the
  warp kernel's sampling; taps whose H is invalid or puts the pixel behind the projection keep their weight and add
  nothing.
- **Canvas**: the step pads the layer canvas by the smear brought back through P(frame)⁻¹ (`cornerPinBlurPadding`:
  the received canvas's corners at every key time, + 1 px of bilinear fringe, capped at `FX_MAX_PADDING` when the
  smear crosses the horizon of P(frame)).
- **Scope**: the pin's own movement is blurred. Motion keyframes are not part of the shutter (Transform's blur also
  covers only Transform's own params); a layer whose Motion moves keeps that movement sharp. The first enabled
  corner pin is the layer map and the only one that blurs.
- **Assumption (labelled)**: the shutter is a box over the whole interval, centred, as Transform's Shutter Angle
  (Premiere's Transform effect documents Shutter Angle / 360 with a centred phase; there is no Premiere or After
  Effects reference for a Corner Pin with its own shutter).

## 3. Paths (AGENTS §4)

| Path | How the blur renders |
|---|---|
| Program preview, Remotion renders and exports, layer bakes (hybrid), stills | The layer's fx plan appends the GPU step `CORNER_PIN_BLUR_GPU` after every other step (compositions `fx/plan.ts`; the chain then covers the whole stack, Opacity masks included, so the blur sees the picture the pin places). Every consumer of the layer's picture — LayerBox, transition taps, track mattes, the GL blend and flat compositors, 3D scopes — places it with the unchanged layer map. DOM layers take the step through HTML-in-Canvas (preview without it: the step is bypassed with the usual chip; renders cancel). |
| Native (warp stage) | `pinBlurOf` (apps/engine `export/warp/extension.ts`) plans the same shutter (`planCornerPinBlur`, `cornerPinBlurPadding`, the fx canvas layout) into a `pinBlurFrame` program; the worker draws the blurred layer canvas (`export/warp/kernel.ts`: tap times, jitter and pose interpolation by the shared `mbTapTime`, `mbJitter`, `mbPoseAt`, bit-identical to `fx_mbTap`, `fx_mbJitter`, `fx_mbPose`) and warps it with P(frame). The cache key carries the programs. |

No path refuses: corner pins on layers the warp stage does not claim keep their existing routing (layer bake or
Remotion), which renders the GL step. The bake's crop rectangle reaches one frame beyond the span when a pin may blur
(`cornerPinMayBlur`), for the half-frame smear at the span's ends.

## 4. Validation

- `packages/project/test/corner-pin-blur.test.ts`: shutter off (composition shutter, angle 0, old documents) plans no
  taps and no padding; a 20 px/frame move takes 20–21 taps and pads the half-frame smear; the Draft / Auto / High caps.
- `packages/compositions/test/fx-motion-blur-gl.test.ts` (WebGL2, SwiftShader; the layer's real fx plan): smears
  `corner-pin-layer` (48 px/frame: length 48, max/min 1.0, no notches or holes) and `corner-pin-layer-capped`
  (80 px/frame, 64 jittered taps: length 81, max/min 1.17, no notches); shutter 0 and a still pin at 360° give the
  unblurred picture's exact checksum. Before the change the smear was 2 px (no blur).
- `apps/engine/test/warp.test.ts` "Corner Pin motion blur on the native path": a 32 px/frame pin move at 360° is a
  linear 32 px ramp at the card's edge (10–90 % width 24–28 px, every step within 0.4–1.8 × the mean slope);
  shutter 0 is byte-identical to the pin without shutter params. Before the change the Corner Pin had no shutter
  params (`E_INVALID_PARAM`) and no blur.
- `packages/compositions/test/corner-pin-blur-parity.e2e.test.ts` (REMOTION_E2E=1): Player (preview) vs
  `renderStill` on a perspective pin tracked unevenly (one key per frame: time-warped, jittered taps), frames 4, 9, 15:
  ≥ 98 % of samples within 4/255, mean < 1.5. Measured 2026-11-16 (same VM as below): 99.88–100 % within 4/255,
  mean |Δ| 0.019–0.074.
- `apps/engine/test/corner-pin-blur-export.test.ts` (REMOTION_E2E=1): native and Remotion ProRes 4444 exports vs
  Remotion stills, 1280×720, frames 3–22. Measured 2026-11-16 on the shared 16-vCPU build VM (AMD Ryzen 7 7700,
  load ≈ 6–10): native 99.99–100 % of samples within 3/255, mean |Δ| 0.017–0.068; Remotion 100 %, mean 0.024–0.038;
  the same frame without the shutter differs from the native export (85.3 % within 3/255, mean 7.5), so the compared
  frames carry the blur.

## 5. Cost and limits

- Native kernel (one worker thread, same VM, load ≈ 6–10, 1920×1080 layer + 80 px of smear): the warp alone 88 ms
  per frame; with the blur 1.2 s (16 taps), 2.2 s (32), 4.5 s (64, strata centres), 9.1 s (64, jittered),
  13.5 s (96, jittered). Frames run on all workers in parallel (one blur canvas per worker, at most 1 GiB together).
  The 1280×720 e2e export (26 frames, a 960×540 pin) took 3.0–4.1 s natively and 13.5–30.7 s on the Remotion path
  (both including their start-up). The cost grows with the travel up to the quality cap; Draft caps it at 16 taps.
- One extra resample: the blurred canvas is resampled once more by the pin (both paths do the same, so they match);
  edges perpendicular to the motion are up to ≈ ½ px softer than the unblurred pin while the shutter is open.
- A smear that crosses the horizon of the frame's pin (extreme perspective + fast motion) is clipped at
  `FX_MAX_PADDING` (2048 layer px) beyond the picture.
- Motion keyframes are not blurred by the Corner Pin's shutter (§2 Scope).
- Older builds (schema 15, no bump) keep the three params on load and save but draw the pin unblurred; their
  `effect.add` refuses the unknown names in a paste. See docs/project-files.md.
