# Smooth Slide — an eased push with dolly, reflection and motion blur

Video Transitions ▸ Slide ▸ **Smooth Slide** (`jasper.smooth-slide`,
`packages/project/src/registry/transitions/premiere/smooth-slide.ts`). A clean-room approximation of the Red Giant
Universe (Maxon) transition "Slide" (Premiere MatchName `AE.Universe_Transitions_Slide`), which the user's Premiere
projects use heavily. The user-facing name, description and parameter labels are neutral (AGENTS §3); the plug-in's
name and MatchName appear only here and in the interchange mapping (`packages/interchange/src/premiere-transitions.ts`).
No plug-in binaries, presets or artwork were used; behaviour comes from the public help pages and their pictures.

## 1. Sources

| Id | Source | Used for |
|---|---|---|
| S1 | Maxon help, Universe ▸ Slide: <https://help.maxon.net/rg/en-us/Content/html/slide.html> (same text at `help.maxon.net/uni/en-us/Content/html/slide.html`) | description, parameter list and wording, defaults "Ease In Out Quad" and Shutter 180° |
| S2 | Maxon help, Animation Tween Examples: <https://help.maxon.net/rg/en-us/Content/html/animation-tween-examples.html> | the Animation curves: Linear; Ease In / Ease Out / Ease In Out × Quad, Cubic, Quartic, Quintic, Sine, Exponential, Circle |
| S3 | The pictures and demo clip on S1 (`Uni_Transitions_Slide_{Presets,Dolly,Falloff,MotionBlur,Shutter}.png`, `Uni_Transitions_Slide_hero.mp4`), viewed, not copied | look of the push, dolly, reflection, motion blur ghosts, preset names |
| S4 | Decoded parameters of the user's Premiere projects (`/tmp/prproj-inspect`, private, not committed): 292 instances in 26 projects | value ranges, defaults, mappings (§3) |
| S5 | Robert Penner's easing equations (the standard closed forms, e.g. <https://easings.net>) | curve formulas (maths written from the definitions, no code ported) |
| S6 | The user's final renders of S4 projects (the Mario Kart RTX long-form video and his "MI CANAL SECRETO" upload, private), compared frame by frame with the decoded Direction values; recorded in the private scene workspace `JasperVideoStuff/escenas/STYLE_SPEC.md` §1 | Direction index order (§4.2) |

Documented in S1: "A 3D transition that slides the layer right, left, upward, or downward"; the dashboard text (S3)
"slides both layers … shifting the view from A to B" (a push). Direction "Right, Left, Upwards, or Downwards";
Animation default Ease In Out Quad; Dolly "move the camera closer in or farther away … 0 will move the layer
directly to the camera … up to 1.2 will move the camera farther away"; "Reflect creates a reflection … Check the
Reflection box"; "Blurriness and Falloff controls help fade the reflection's crispness" (example: Blurriness 5 =
low, Falloff 0.0 vs 0.6); "The Aspect control lets you stretch the reflection horizontally or vertically"; Motion
Blur Off / Low / Medium / High — "the higher the setting, the more instances of the layer will appear between
frames"; Shutter angle default 180°, examples 90 and 720; Edge Smoothing None / Low / Medium / High ("anti-aliasing").
Not documented anywhere found: the Animation menu order, sample counts, defaults of Dolly / Blurriness / Falloff /
Aspect / Motion Blur / Edge Smoothing, the reflection opacity, what fills the exposed background.

## 2. Model and parameters

| Control (param) | Range, default | Behaviour (TS: `smoothSlidePoses` and the compositing shader) |
|---|---|---|
| Direction (`direction`) | Right, Left, Down, Up; **Left** | Both pictures travel that way; B enters from the opposite edge (S3 preset thumbnails: "Push Left" shows B entering from the right). A at offset `dir·e`, B at `dir·(e − 1)` frame units. |
| Animation (`animation`) | 22 curves; **Ease In Out Quad** | `e = ease(p)`: Linear, Ease In ×7, Ease Out ×7, Ease In Out ×7 over Sine, Quad, Cubic, Quart, Quint, Expo, Circ (S2, S5). |
| Dolly (`dolly`) | 0…1.2; **0** | Camera pull-back peaking mid-move: scale `s = 1 / (1 + dolly · sin(π e))` about the frame centre. At 1.2 the pictures are 1/2.2 ≈ 0.45 of the frame mid-move — matching S3's Dolly 1.2 picture (the shrunk layer measures ≈ 0.455 of the frame width). Uncovered frame = transparent (lower tracks / black), as the S3 "Blurry Push" thumbnails show black around the pictures. |
| Reflection (`reflection`, group Reflection) | off | A mirrored copy below each picture's bottom edge, attached to it (S3 Dolly / Falloff pictures: a floor reflection under both layers, seen once the dolly shrinks them). Vertical moves draw only the lower picture's reflection (the upper one's would be behind the lower picture). |
| Blurriness (`blurriness`) | 0…100; **10** | Gaussian blur of the reflected pictures, σ = 0.4 px × value at 1080 lines (scaled with the sequence height). |
| Falloff (`falloff`) | 0…1; **0.1** | Reflection opacity `0.6 · clamp(1 − d · falloff · 8)` at `d` picture heights below the edge: 0 = even (S3 Falloff 0.0), 0.6 fades out within ≈ 0.2 heights (S3 Falloff 0.6). |
| Aspect (`aspect`) | 0.01…20; **1** | Width:height of the reflection relative to the picture: the reflection is `1 / aspect` picture heights tall (samples at `1 − d · aspect`). |
| Motion Blur (`motionBlur`) | Off, Low, Medium, High; **High** | The framework's adaptive shutter (`planMotionBlur`, fx-shader-framework.md §19) along the real eased path, dolly included: 32 key poses, about one tap per pixel the pictures' corners travel, capped by the level — Low / Medium / High = the Draft / Auto / High qualities (2.5 px apart, ≤ 16 taps / 1 px, ≤ 64 / 1 px, ≤ 96), per-pixel jitter beyond the cap or on eased (non-uniform) moves. A continuous smear (S1 "more instances … between frames": the higher the level, the more taps). |
| Shutter Angle (`shutterAngle`) | 90…720°; **360** | Shutter of `angle / 360` frames centred on the frame (`angleShutter`), in progress space (`step` = 1/(d+1) two-sided, 1/d one-sided, × the Start→End span), shrunk symmetrically near the ends so progress 0 / 1 sample only themselves. |
| Edge Smoothing (`edgeSmoothing`) | None, Low, Medium, High; **None** | Box filter 0 / 1 / 2 / 3 px wide over each picture's and reflection's rectangle, clipped to the frame (a picture at rest stays exact at the frame borders; None = point sampled). |
| Start, End, Custom Completion, Transition Completion, Reverse | framework standard | As every GPU transition (fx-transition-framework.md §3, §13.5); Reverse plays B → A backwards (sides swapped, `1 − p`). |

Defaults follow S4 where the user's choice is unanimous or dominant (Animation, Dolly, Reflection, Blurriness,
Falloff, Aspect, Motion Blur High, Shutter 360°, Edge Smoothing None) — S1's documented Shutter default is 180°, but
all 292 instances use 360°. Direction is spread across all four values in S4 (§3), so the default is Left, the
direction of S1's demo clip.

Rendering: one stage pass (plus four separable blur passes when Reflection is on with Blurriness > 0). Poses are
computed in TS (`gpu.uniforms`: `u_slPose`, `u_slDir`, `u_slAa` and the motion blur plan `u_mbPlan` / `u_mbKeys` /
`u_mbWarp`), so the Player, stills, the
Remotion export and the hybrid span bakes evaluate the same poses. Timing, one-sided spans (the missing side is
transparent), alignment and default durations are the framework's.

## 3. Decoded parameters (S4, aggregated)

292 instances, 26 projects; parameter bounds as the plug-in declares them: Direction 0…3, Animation 0…21, Dolly
0…1.2, Reflect (group, false/false), Reflection (bool), Bluriness 0…100, Falloff 0…1, Aspect 0.01…20, `#10` (bool),
Motion Blur 0…3, Motion Blur Shutter 90…720, Edge Smoothing 0…3, Input (layer picker, 4294967293 = none).

| Field | Values (count) |
|---|---|
| Direction | 3 (127), 2 (85), 1 (43), 0 (37) |
| Animation | 16 (197), 17 (95) |
| Dolly / Reflection / Bluriness / Falloff / Aspect | 0 / false / 10 / 0.1 / 1 (all 292) |
| Motion Blur / Shutter / Edge Smoothing | 3 / 360 / 0 (all 292) |
| Sides | incoming only (226), outgoing only (63), both (3) |
| Duration | 0.5 s (192), 0.417 s (36), 1.485 s (10), others ≤ 6 each (0.18–0.83 s) |
| Alignment ticks | 0 (229), 127 135 008 000 ≈ 0.5 s (30), others |
| Keyframes | none |

Mapping (interchange): Direction index → `SMOOTH_SLIDE_DIRECTIONS` (0 Right, 1 Left, 2 Down, 3 Up: verified, §4.2);
Animation index → `SMOOTH_SLIDE_EASINGS` (0 Linear, 1–7 Ease In, 8–14 Ease Out, 15–21 Ease In Out, each in Penner's
order Sine, Quad, Cubic, Quart, Quint, Expo, Circ) — so 16 = Ease In Out Quad (the documented default, and the
majority value) and 17 = Ease In Out Cubic; Motion Blur / Edge Smoothing indices → the menus in S1's order; numbers
clamped to the ranges above; number keyframes kept, popup / checkbox keyframes dropped with a report entry; Input
and `#10` ignored.

## 4. Assumptions (undocumented; labelled)

1. **Animation order.** 22 entries = Linear + 3 × 7 matches the stored range 0…21. Grouping by In / Out / In Out and
   Penner's curve order (S2's picture file names number the curves sine1, quad2, cubic3, quart4, quint5, expo6, circ7)
   is inferred; it is the only ordering found that puts the documented default on the majority value 16. S2's text
   order (Quad, Cubic, Quartic, Quintic, Sine, …) would make 16 Ease In Out Cubic instead.
2. **Direction order — verified, no longer an assumption.** 0…3 = Right, Left, Down, Up, the order of S1's sibling
   page "Unfold" (Right, Left, Downwards, Upwards), not S1's own sentence (Right, Left, Upwards, Downwards). Checked
   frame by frame on S6 against the stored values: 3 = travels up (`JUEGO C long › video › V2 1c.mp4` head @8.225 s,
   render 8.2–8.5 s: the avatar rises from below with a vertical smear), 2 = travels down (same clip's tail @10.21 s:
   the avatar slides down out of frame, gone by ≈ 10.69 s), 1 = travels left (Mario Kart logo, `intro` @0.784 s),
   0 = travels right, entering from the left (RTX.png, `intro` @2.569 s). Direction = the way the pictures travel
   (S3 thumbnails; S6).
3. **Dolly curve** `1 / (1 + d sin(π e))`: the camera distance grows by `d` frame-filling distances at mid-move (fits
   the 1.2 picture); the bump's shape over the move is a smooth guess from the demo clip's frames.
4. **Reflection** opacity 0.6 at the edge (estimated from S3's Falloff 0.0 picture), the linear fade rate 8 per unit
   Falloff (fits S3's 0.6 picture), Aspect as the reflection's width:height ratio (S1 says only "stretch horizontally
   or vertically"; it may instead be the blur's aspect), uniform blur with σ = 0.4 px per unit at 1080 lines, and the
   lower-picture-only rule for vertical moves.
5. **Motion blur** box shutter centred on the frame, shrunk at the ends. The plug-in's own sample counts are not
   documented and S3's High picture shows separate ghosts; the earlier fixed 4 / 8 / 16 evenly spaced poses
   reproduced those ghosts (16 copies ≈ 4.5 px apart on a 72 px/frame push at 1080p), which users read as a defect,
   so the levels now cap an adaptive, continuous smear instead (a deliberate departure from S3).
6. **Edge smoothing** as a 0 / 1 / 2 / 3 px box filter (the plug-in probably supersamples; S1 says High costs render
   time).
7. **Exposed background** is transparent (S3's preset thumbnails show black; the demo's grey is assumed to be a
   layer below).
8. **Perspective.** S1 calls it a 3D transition; the model has no perspective tilt (pictures stay parallel to the
   frame: a camera dolly and pan only). The demo shows at most a slight perspective; not modelled.

## 5. Validation

- `packages/project/test/transition-smooth-slide.test.ts`: independent easing laws (ends, monotonicity, closed forms,
  mirror symmetry and fallback); shutter widths, taps per pixel of travel and the Low / Medium / High caps, end
  shrink and frame step; dolly and
  reflection blur scaling; public document commands with `E_INVALID_PARAM`, clamping, keyframes and invariants.
  Registry inventories, packed-uniform/pass counts and the unused CPU shader duplicate were removed.
- `packages/compositions/test/transition-smooth-slide-gl.test.ts` (WebGL2, SwiftShader): actual rendered pixels have
  independent physical witnesses for directions, missing head/tail transparency, Reverse, dolly/reflection and edge
  smoothing; motion-blur smear grows with shutter angle and Blurriness affects the reflection. No expected pixel
  comes from a parallel production CPU shader. Generic transition goldens own the default fingerprints.
  `packages/compositions/test/fx-motion-blur-gl.test.ts` (`smooth-slide` smear): the default High blur of a fast push
  (≈ 50 px/frame) leaves no notches between copies, no holes and a max/min below 1.6 along the smear (14 notches with
  the former 16 fixed poses).
- `packages/compositions/test/transition-smooth-slide-parity.e2e.test.ts` (REMOTION_E2E=1): Player (preview) vs
  `renderStill` (export) per pixel.
- `apps/engine/test/smooth-slide-export.test.ts`: the planner bakes the span (hybrid) or routes to Remotion with a
  blocker naming Smooth Slide; with REMOTION_E2E=1 the hybrid and Remotion exports are compared with Remotion stills
  frame by frame. Measured (2026-10-25, shared 16-vCPU build VM, `REMOTION_E2E=1`, 1280×720 ProRes 4444): hybrid
  ≥ 99.93 % of samples within 3/255 (mean |Δ| ≤ 0.155) on every span frame; the Remotion export path's ProRes 422 HQ
  intermediate costs 84.9–85.3 % / mean 2.11–2.26 on frames without a transition and 84.1–89.8 % / mean 1.50–1.95 on
  the span frames (the transition adds no path-specific error; the test requires span frames within 3 points of
  share and 1 level of mean of that baseline).
- `packages/interchange/test/premiere-transitions.test.ts`: MatchName mapping, parameter conversion (fuzzed),
  FCP7 XML import into a valid document; `apps/mcp/test/transitions.test.ts`: list / add / update over MCP. Generic
  `packages/session/test/session.test.ts` and `integrity-property.test.ts` own exact document undo/redo and refusal
  history; feature-specific replays of the same history path were consolidated there.

## 6. Limitations

- Motion blur cost grows with the travel, up to 96 taps per pixel at High (was a flat 16). Measured 2026-11-14 on
  the user's PC (RTX 3080 Ti, 24 threads, a user render running concurrently; all jobs at nice 19): one 1920×1080
  Smooth Slide pass in headless-Chrome SwiftShader (fx-motion-blur GL entry, mean of 3) at High took 447 → 2330 ms
  on a 30-frame Up push mid-move (≈ 70 px of travel: 16 → 70 taps) and 467 → 3430 ms on a 15-frame Left push
  (≈ 240 px: 16 → 96 taps); Low / Medium cap at 16 / 64 taps. On the GPU export paths the pass is not measurable
  in wall time: a 14-frame 1080p ProRes 422 HQ export over the span took 9.0 → 8.8 s (hybrid, warm) and
  18.3 → 17.8 s (Remotion), within run-to-run noise.
- Behaviour beyond the documented wording is approximated (§4); compare against the plug-in before relying on exact
  pixel matches with Premiere renders.
- The `.prproj` reader does not exist yet; `premiereTransitionParams` is the conversion it should call.
- Smooth Slides imported from FCP7 XML by builds that mapped Direction 2 → Up and 3 → Down keep the swapped
  vertical direction: the document stores the motion itself (`'up'` / `'down'`) with no import provenance, so no
  migration or repair can tell an imported value from one the user chose. Re-import the XML or flip Direction.
- FCP7 XML exports write Smooth Slide under its own name (Premiere sees an unknown transition), not as the plug-in.
