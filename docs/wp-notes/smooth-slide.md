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

| Control (param) | Range, default | Behaviour (TS: `smoothSlidePoses`, `smoothSlideContributions`; GLSL mirrors them) |
|---|---|---|
| Direction (`direction`) | Right, Left, Up, Down; **Left** | Both pictures travel that way; B enters from the opposite edge (S3 preset thumbnails: "Push Left" shows B entering from the right). A at offset `dir·e`, B at `dir·(e − 1)` frame units. |
| Animation (`animation`) | 22 curves; **Ease In Out Quad** | `e = ease(p)`: Linear, Ease In ×7, Ease Out ×7, Ease In Out ×7 over Sine, Quad, Cubic, Quart, Quint, Expo, Circ (S2, S5). |
| Dolly (`dolly`) | 0…1.2; **0** | Camera pull-back peaking mid-move: scale `s = 1 / (1 + dolly · sin(π e))` about the frame centre. At 1.2 the pictures are 1/2.2 ≈ 0.45 of the frame mid-move — matching S3's Dolly 1.2 picture (the shrunk layer measures ≈ 0.455 of the frame width). Uncovered frame = transparent (lower tracks / black), as the S3 "Blurry Push" thumbnails show black around the pictures. |
| Reflection (`reflection`, group Reflection) | off | A mirrored copy below each picture's bottom edge, attached to it (S3 Dolly / Falloff pictures: a floor reflection under both layers, seen once the dolly shrinks them). Vertical moves draw only the lower picture's reflection (the upper one's would be behind the lower picture). |
| Blurriness (`blurriness`) | 0…100; **10** | Gaussian blur of the reflected pictures, σ = 0.4 px × value at 1080 lines (scaled with the sequence height). |
| Falloff (`falloff`) | 0…1; **0.1** | Reflection opacity `0.6 · clamp(1 − d · falloff · 8)` at `d` picture heights below the edge: 0 = even (S3 Falloff 0.0), 0.6 fades out within ≈ 0.2 heights (S3 Falloff 0.6). |
| Aspect (`aspect`) | 0.01…20; **1** | Width:height of the reflection relative to the picture: the reflection is `1 / aspect` picture heights tall (samples at `1 − d · aspect`). |
| Motion Blur (`motionBlur`) | Off, Low, Medium, High; **High** | 1 / 4 / 8 / 16 poses evenly spread (stratum centres) over the shutter and averaged: discrete instances along the real eased path, dolly included (S1 "more instances … between frames"; S3 High shows visible ghosts). |
| Shutter Angle (`shutterAngle`) | 90…720°; **360** | Shutter of `angle / 360` frames centred on the frame (`angleShutter`), in progress space (`step` = 1/(d+1) two-sided, 1/d one-sided, × the Start→End span), shrunk symmetrically near the ends so progress 0 / 1 sample only themselves. |
| Edge Smoothing (`edgeSmoothing`) | None, Low, Medium, High; **None** | Box filter 0 / 1 / 2 / 3 px wide over each picture's and reflection's rectangle, clipped to the frame (a picture at rest stays exact at the frame borders; None = point sampled). |
| Start, End, Custom Completion, Transition Completion, Reverse | framework standard | As every GPU transition (fx-transition-framework.md §3, §13.5); Reverse plays B → A backwards (sides swapped, `1 − p`). |

Defaults follow S4 where the user's choice is unanimous or dominant (Animation, Dolly, Reflection, Blurriness,
Falloff, Aspect, Motion Blur High, Shutter 360°, Edge Smoothing None) — S1's documented Shutter default is 180°, but
all 292 instances use 360°. Direction is spread across all four values in S4 (§3), so the default is Left, the
direction of S1's demo clip.

Rendering: one stage pass (plus four separable blur passes when Reflection is on with Blurriness > 0). Poses are
computed in TS (`gpu.uniforms`: `u_slPoses` vec4[16], `u_slCount`, `u_slDir`, `u_slAa`), so the Player, stills, the
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

Mapping (interchange): Direction index → `SMOOTH_SLIDE_DIRECTIONS` (0 Right, 1 Left, 2 Up, 3 Down: S1's order);
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
2. **Direction order** 0…3 = Right, Left, Up, Down follows S1's sentence; S1's sibling page "Unfold" lists Right,
   Left, Downwards, Upwards, so Up / Down may be swapped. Direction = the way the pictures travel (S3 thumbnails).
3. **Dolly curve** `1 / (1 + d sin(π e))`: the camera distance grows by `d` frame-filling distances at mid-move (fits
   the 1.2 picture); the bump's shape over the move is a smooth guess from the demo clip's frames.
4. **Reflection** opacity 0.6 at the edge (estimated from S3's Falloff 0.0 picture), the linear fade rate 8 per unit
   Falloff (fits S3's 0.6 picture), Aspect as the reflection's width:height ratio (S1 says only "stretch horizontally
   or vertically"; it may instead be the blur's aspect), uniform blur with σ = 0.4 px per unit at 1080 lines, and the
   lower-picture-only rule for vertical moves.
5. **Motion blur** sample counts 4 / 8 / 16, evenly spaced, box shutter centred on the frame, shrunk at the ends.
6. **Edge smoothing** as a 0 / 1 / 2 / 3 px box filter (the plug-in probably supersamples; S1 says High costs render
   time).
7. **Exposed background** is transparent (S3's preset thumbnails show black; the demo's grey is assumed to be a
   layer below).
8. **Perspective.** S1 calls it a 3D transition; the model has no perspective tilt (pictures stay parallel to the
   frame: a camera dolly and pan only). The demo shows at most a slight perspective; not modelled.

## 5. Validation

- `packages/project/test/transition-smooth-slide.test.ts`: param schema; curves (ends, monotonic, closed forms,
  mirror symmetry, fallback); poses (counts, shutter width 90…720°, end shrink, frame step); dolly; reflection blur σ;
  planned uniforms / passes; CPU reference geometry (directions, dolly, reflection mapping / fade / vertical rule,
  edge smoothing, coverage ≤ 1 by fast-check); document commands with refusals (`E_INVALID_PARAM`), clamping,
  keyframes, one-sided head / tail, invariants.
- `packages/compositions/test/transition-smooth-slide-gl.test.ts` (WebGL2, SwiftShader): whole frames equal the CPU
  reference (≥ 98 % of pixels within 4/255) for five parameter sets (directions, easings, dolly, reflection, motion
  blur levels and shutters, edge smoothing, one-sided head / tail, Reverse); exact A / B at progress 0 / 1 with heavy
  settings; motion-blur smear grows with the shutter; Blurriness changes only the reflection. Golden fingerprints in
  `transition-gl.test.ts`.
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
  FCP7 XML import into a valid document; `apps/mcp/test/transitions.test.ts`: list / add / update over MCP;
  `packages/session/test/smooth-slide-history.test.ts`: undo / redo of adding and editing it.

## 6. Limitations

- Behaviour beyond the documented wording is approximated (§4); compare against the plug-in before relying on exact
  pixel matches with Premiere renders.
- The `.prproj` reader does not exist yet; `premiereTransitionParams` is the conversion it should call.
- FCP7 XML exports write Smooth Slide under its own name (Premiere sees an unknown transition), not as the plug-in.
