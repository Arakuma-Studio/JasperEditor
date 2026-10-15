# color-grade — Lumetri completion, Colour Match, Lumetri Scopes upgrade, `scopes_read`

Parity workstream `color-grade` (branch `feat/color-grade`). Builds on wp-m2-color (`jasper.lumetri@1`, the colour
run's baked LUT, the Lumetri and Scopes panels). Ports from FilmCraft and EffectCraft are recorded in
`licenses/ported/color-grade-filmcraft.md` and `licenses/ported/color-grade-effectcraft.md`.

## 1. What was built

| Area | Where |
|---|---|
| Lumetri params (additive, every default is the identity: older grades are bit-exact) | `packages/project/src/registry/color-effects.ts` (`LUMETRI_PARAMS`, `LUMETRI_GROUPS`) |
| Pointwise steps baked into the colour run: section switches, built-in looks, Faded Film, Creative Saturation, Shadow/Highlight Tint + Tint Balance, Hue vs Sat / Hue vs Hue / Hue vs Luma / Luma vs Sat / Sat vs Sat | `packages/project/src/color/lumetri.ts`, `hue-curves.ts`, `looks.ts`, `grade-math.ts` |
| Spatial steps: Creative Sharpen, HSL Secondary (key, Refine Denoise/Blur, Invert, Show Mask, 1-way/3-way correction, temperature, tint, contrast, sharpen, saturation), Vignette | maths `packages/project/src/color/lumetri-spatial.ts`; GPU stage `packages/project/src/registry/lumetri-spatial.ts` (`jasper.lumetri-spatial`, internal) |
| Render snapshot: the spatial stage follows every Lumetri instance that uses it | `render/snapshot.ts` → `expandLumetriSpatial` |
| A masked Lumetri instance and its stage mix with the input once (exact with feathered masks) | `packages/compositions/src/fx/plan.ts` (`maskJoin`), `fx/FxPicture.tsx`, `fx/mask.ts` (`fxMasked.followedBy`) |
| Colour Match (FilmCraft port) with Premiere's Face Detection semantics, letterbox cropping | `packages/project/src/color/match.ts` |
| Auto tone | `packages/project/src/color/auto-tone.ts` |
| HSL Secondary eyedropper maths (Set / Add / Remove Color) | `packages/project/src/color/secondary-key.ts` |
| Scope maths (FilmCraft `crates/scopes` port) + numeric summaries | `packages/project/src/color/scopes.ts` |
| Analysis documents (a clip alone, effects before an instance) | `packages/project/src/color/analysis.ts` |
| Engine routes `POST /api/grading/{scopes,match,auto-tone}` (stills → ffmpeg RGBA → shared maths) | `apps/engine/src/grading/service.ts`, `routes/grading.ts`, API `packages/api/src/grading.ts`, client `gradingScopes/Match/AutoTone` |
| Face Detection through the roto face model (`jasper-roto --faces`, child process) | `apps/engine/src/roto/worker/faces.ts`, `RotoService.detectFaces` |
| MCP: `scopes_read`, `color_match`, `auto_tone`, `list_looks`; `grade_clip` / `get_grade` cover every new param (sections `creative`, `curves`, `secondary`, `vignette`, `sections`) | `apps/mcp/src/tools/grading.ts`, `tools/color.ts` |
| Lumetri panel: section checkboxes, Auto, Looks browser, adjustments and tints, hue/saturation curve tabs with eyedropper, Comparison View / Face Detection / Apply Match, HSL Secondary, Vignette; Effect Controls editor draws the tint and correction wheels and the hue curves | `apps/web/src/color/LumetriEditor.tsx`, `color/grade/*`, `controls/CurveField.tsx` (`kind`) |
| Program monitor eyedropper overlay | `apps/web/src/color/grade/{eyedropper.ts,EyedropperOverlay.tsx}` (registered in `commands/color.ts`) |
| UI commands `color.autoTone`, `color.applyMatch` (command palette) | `apps/web/src/commands/color.ts` |
| Lumetri Scopes panel: layouts, every scope type, settings, worker on the shared maths | `apps/web/src/panels/scopes/ScopesPanel.tsx`, `color/scopes/{compute.ts,client.ts,scopes.worker.ts}` |

## 2. Design

### Lumetri: pointwise steps in the LUT, spatial steps on the GPU

Order inside one instance (Premiere processes the sections top-down, helpx "hue and saturation curves"):
1–7 Basic (input LUT, white balance, exposure, contrast, highlights/shadows, whites/blacks, saturation),
8 Look (a look LUT **or** a built-in look, × Intensity), 9 Vibrance, Faded Film, Creative Saturation,
Shadow/Highlight Tint around the Tint Balance pivot, 10 RGB curves then the hue/saturation curves, 11 wheels,
12 clamp — all one pure function, baked into the colour run's 33³ LUT exactly as before (preview WebGL/CPU, native
`lut3d`). Then the spatial stage: Sharpen (Creative + HSL sharpen inside the key), 13 HSL Secondary, 14 Vignette.

The spatial stage is an ordinary GPU effect (`jasper.lumetri-spatial`, fx framework) that the **render snapshot**
inserts right after a Lumetri instance when one of its spatial params can be non-default at some time (static
value, any keyframe, an active expression; switched-off sections never trigger it). It carries the instance's
spatial params (keyframes and expressions included) and its effect masks, gets the instance id + `~spatial`, is
`internal` (never listed; `effect.add` refuses it) and `gradeBypass` (the before/after toggle hides it with the
grade). Because it is a normal GPU effect, every path picks it up with no special case: the Player and Remotion
renders run the shader; the export planner bakes the layer (hybrid, `layer-bake`'s `needsBake`) or renders
through Remotion — never dropped, never approximated (AGENTS.md §4). A Lumetri instance without spatial steps keeps
the plain native `lut3d` path (no change in speed). The colour run LUT stays the authority for the pointwise part
(`lut3d` = WebGL = CPU, 100 % exact, wp-m2-color).

Masks: a masked colour effect is its own run (wp masks). The LUT step and the spatial stage of one instance are
flagged `maskJoin` in the plan and wrapped in ONE `fxMasked` (the stage runs on the LUT output inside a scratch
canvas, then a single mix with the input), so a feathered mask gives mix(input, full Lumetri, coverage) exactly.

Bake budget: the completion steps live in closures called only when used, so the main closure keeps its old size
(V8 optimises it as before). Measured with `tsx` on this host, best of 12×25 bakes, interleaved: the M2 full grade
7.83–7.97 ms before, 7.96–8.08 ms after (≈ +1.5 %, within noise); a grade using every new pointwise step
(look, faded film, tints, all five hue curves) 14.7 ms at load ≈ 9 (budget 15 ms, test fails above 30 ms).

### Hue / saturation curves

`{curve}` params like the RGB curves, y = 0.5 neutral, default flat `[[0,0.5],[1,0.5]]` (so the command validator,
copy/paste and presets need nothing new). Hue curves are periodic (points repeated one period each side, PCHIP,
FilmCraft `hue_lut`); Luma vs Sat and Sat vs Sat are flat outside their points. Hue vs Hue shifts by ±½ turn at
y = 0/1 (HSL rotation, lightness and saturation kept); Hue vs Sat, Luma vs Sat and Sat vs Sat multiply chroma
around luma (y = 1 doubles, 0 removes; they multiply together); Hue vs Luma adds ±0.25. Greys fade out of the hue
curves below 5 % chroma. x of Luma vs Sat = Rec.709 luma; x of Sat vs Sat = chroma (max − min) — more robust in the
shadows than HSL saturation. Curves are tabulated (1024 entries) at build time: no spline evaluation in the bake.
Eyedropper: three points around the picked value (±30° for hue curves, ±0.1 for the others), the centre keeps the
curve's current value (Premiere: "three control points are placed; the centre point corresponds to the colour").

### HSL Secondary

Key (EffectCraft `HslKey`): hue centre/range (half-width)/softness in degrees (range 180 = every hue; greys belong
to a hue key only as far as saturated, ×min(1, 20·S)), saturation and lightness low/high/softness in %, each axis
with its on/off checkbox. Refine: Denoise = a 3 × 3 median of the key at a spacing of (1 + 2·amount) px mixed by the
amount (FilmCraft); Blur = a Gaussian of up to σ = 20 px (scaled with the preview resolution). Invert after
refine. Show Mask: Color/Gray, Color/Black, White/Black (shows the key; sharpen and vignette are skipped while it is
shown). Correction inside the key: temperature/tint gains, contrast, saturation, then the 1-way wheel (an offset:
colour × 0.25 + level × 0.25) or the 3-way wheels (Lumetri's own lift/gamma/gain maths), and HSL Sharpen.
Eyedroppers (`secondary-key.ts`): Set Color keys the picked colour (hue ±15° + 15° soft, saturation ±25 %, lightness
±30 %, 10 % soft; a grey keys lightness only), Add widens the nearer edge of each axis to include the colour, Remove
cuts the cheapest axis so the colour (with the softness) falls outside.

### Vignette, Sharpen

Vignette (EffectCraft shape): position over the clip frame (layer box); Roundness 0 follows the frame's aspect, +100
a circle, −100 a rounded rectangle (superellipse exponent 2…8); Midpoint moves the start, Feather widens the
transition; Amount −5…5 darkens (×(1 − 0.2·|a|·edge)) or lightens. Sharpen: luma unsharp mask (σ = 1 px × preview
scale) — positive amounts add 2.5 × the detail, negative ones move towards the blur.

### Built-in looks and the Looks browser

Eighteen procedural looks (`looks.ts`, our formulas — no LUT files): Teal & Orange, Cinema Neutral, Bleach Bypass,
Night, Warm Film, Vintage Print, Saturated Slide, Cross Process, Faded Matte, Cool Blue, Arctic, Golden Hour,
Sunset, Moody Green, Soft Pastel, Monochrome, High Contrast B&W, Sepia. A look LUT asset takes precedence (one Look
per instance, as Premiere); the browser's tiles show each look on the clip's current Program picture (a hue ×
lightness chart when the clip is not on screen) through the same function the bake uses, at the instance's
Intensity; choosing one also clears a look LUT (one undo step).

### Colour Match and Face Detection

FilmCraft's `color_match.rs`, ported: both frames downsampled to ≤ 96 px, Oklab, three tonal ranges, mean L/a/b
per range + mean chroma; Levenberg–Marquardt on 10 unknowns (three wheels, their levels, Basic saturation) with
numerical derivatives through the real Lumetri function, a small parameter penalty. Changes:
- **Face Detection follows Premiere** ("if Auto Color detects faces in either the reference or current frame it
  gives higher weight to the colors in the facial region", helpx "Match color between shots"): with the face model
  installed (roto workstream, MediaPipe BlazeFace via `jasper-roto --faces`), pixels inside detected faces weigh 4×
  in every statistic, and with faces in both frames three more residuals pull the current faces' mean Oklab colour
  to the reference faces'. No face found → the whole frame counts equally (`skin: "none"`).
- **Without the face model**, Face Detection falls back to FilmCraft's skin-tone protection: skin-coloured pixels
  (Oklab hue 20°–75°) weigh 0.2 in the colour means and the solved cast is scaled until the frame's skin moves ≤ 8°
  in hue (`skin: "hue"`); the UI says so and points to Preferences ▸ Roto & Face Tracking.
- Letterbox / pillarbox bars (rows and columns of near-black pixels at the edges) are cropped from both frames (face
  boxes follow the crop): a clip that does not fill the frame or a reference of another aspect would otherwise
  count its bars as shadows and as zero chroma (measured in the e2e run: without it the match desaturated the clip
  to 21 %).
- The current picture is the clip's picture **before** its Lumetri instance (`clipAnalysisDocument`: the clip alone,
  Motion reset to fit, effects up to the instance); the reference is the Program frame (Comparison View).
The result is written as ordinary Lumetri values (one "Apply Match" step; keyframed params get a key at the
playhead).

### Auto

Premiere's Auto (helpx "Use Auto Color": "applies intelligent color corrections: exposure, white balance and
contrast", Sensei, undocumented maths). Ours is explicit: the luma distribution of the clip's picture before its
Lumetri instance is pushed towards p1 = 2 %, p10 = 10 %, p50 = 42 %, p90 = 80 %, p99 = 98 % by a damped
least-squares solve of Exposure, Contrast, Highlights, Shadows, Whites, Blacks through the real Lumetri maths
(letterbox cropped). Saturation and white balance are left alone (deliberate: a muted look or a warm cast is the
grader's choice). One "Auto Tone" step.

### Lumetri Scopes

FilmCraft `crates/scopes`, ported to TypeScript (`color/scopes.ts`) and shared by the panel's worker and the
engine's `scopes_read`. Signal: the selected clip's graded picture read back at ≤ 480 px, decimated to ≤ 480 × 270
samples by nearest picking (flat colours land on exact cells); transparent pixels give no sample.
- Waveform RGB / Luma / YC (Y green, C blue, as Premiere) / YC no Chroma; Parade RGB / YUV / RGB-White (R, G, B and a
  white luma column, FilmCraft) / YUV-White (the YUV components in white — Premiere lists it, its behaviour is
  undocumented: our interpretation); Histogram (R, G, B, Y, with clipping shares); Vectorscope YUV (75 % / 100 %
  colour-bar targets of the chosen matrix, skin-tone line at 123°, saturation rings) and HLS (hue angle from the
  YUV red angle, HLS saturation radius).
- Colour Space Rec. 601 / 709 / 2020 (Y′CbCr matrix), Clamp Signal (rows over 0…100 %, else −10…110 %), Brightness
  (dimmed / normal / bright), Scale 8-bit / 10-bit / float (axis labels).
- Layouts: each single scope, Vectorscope + Waveform, Parade + Vectorscope, Waveform + Histogram, and Premiere's
  presets **All Scopes RGB** and **All Scopes YUV/YC** (choosing them sets the waveform/parade types), plus All
  Scopes HLS. All scopes of a layout are computed in one worker pass per frame.
- Real time, measured (`scopes.test.ts`, 1080p frame, best of 5, load ≈ 18): decimate 1.9 ms, waveform RGB 5.9 ms,
  YC 5.7 ms, parade RGB-White 11 ms, histogram 4.7 ms, vectorscope YUV 1.9 ms, HLS 5.6 ms — a four-scope layout ≈ 25 ms
  in the worker, ≤ 15 updates/s while playing as before.
The HDR scale (PQ axis) and working spaces belong to the `color-mgmt` workstream; the maths take float signals
(`signalFromRgbaFloat`) for it.

### `scopes_read`

`POST /api/grading/scopes` renders the Program frame (or one clip alone, `clipId`) with the still renderer (the
export paths), decodes it with ffmpeg and returns FilmCraft's `scopes.read` shape: per-channel levels in % (min /
max / mean of R′, G′, B′, Y′), clipping shares, mean chroma hue/saturation, waveform and parade levels per column
range, histogram peak bins (bins on request), vectorscope samples, mean and densest spots (angle from +Cb,
magnitude in % of 0.5). MCP `scopes_read` defaults to 8 columns, 6 peaks, no bins.

## 3. Usage

- Lumetri Color panel (Color workspace): each section's checkbox switches it off; Basic ▸ **Auto**; Creative ▸ Look
  (LUT) or **Built-in Look**, **Browse Looks…**; Curves ▸ Hue Saturation Curves tabs, the eyedropper button then a
  click in the Program monitor (5 × 5 average, Ctrl/Cmd 10 × 10, Esc cancels); Color Wheels & Match ▸ **Comparison
  View** (opens the Program monitor's comparison with a reference frame; pick it with the comparison bar),
  **Face Detection**, **Apply Match**; HSL Secondary ▸ **Set color / + / −**, ranges, Show Mask, Invert, Refine,
  Correction (1-way / 3-way); Vignette.
- Commands (palette): Lumetri Auto Tone, Lumetri Apply Match, Copy/Paste Grade (copies every new param too).
- Agents: `grade_clip {creative: {builtInLook, fadedFilm, sharpen, saturation, shadowTint, highlightTint,
  tintBalance}, curves: {hueVsSat…}, secondary: {hueCenter, hueRange, hueSoftness, …, wheelMode, wheel, …},
  vignette: {amount, midpoint, roundness, feather}, sections: {basic: false…}}`; `get_grade` returns them;
  `list_looks`; `color_match {clipId, at?, reference: {at, sequenceId?}, faceDetection?, apply?}`;
  `auto_tone {clipId, at?, apply?}`; `scopes_read {at?, clipId?, scopes?, waveformType?, paradeType?, matrix?, …}`.

## 4. Verification evidence

Current `packages/compositions/test/lumetri-spatial-gl.test.ts` coverage reads actual WebGL2 output against
independent painted inputs and fixed pixel expectations: selected-only correction and Invert, hue/lightness
softness, all three Show Mask styles, three-way highlight gain, Set/Add/Remove eyedropper selection, and vignette
center/corner/roundness behavior. These cases preserve seven former `packages/project/test/lumetri-grade.test.ts`
contracts at the real shader seam. Denoise, Blur, Sharpen, key-limited sharpening and transparency checks remain.
The [cleanup ledger](../test-cleanup/compositions2.md#final-oracle-independence-rescan-pre-edit-record) records the
exact transfer map and independent sources. Focused integrated GL validation of the rewritten cases is pending;
static review and targeted Biome passed.

The table below records historical workstream results. Browser tours and implementation-only tests named below
may have been removed during cleanup; the counts and pass results are not current suite totals or validation of
the rewritten shader tests.

| Check | Result |
|---|---|
| `packages/project/test/lumetri-grade.test.ts` (27): params/defaults identity, creative steps, looks distinct & bounded & mixed, LUT precedence, hue curves (periodicity, Hue vs Sat only on its hue, greys untouched, Hue vs Hue / Luma / Luma vs Sat / Sat vs Sat), eyedroppers, section switches, HSL/wheel helpers (fast-check), outputs finite in 0..1 for any input (fast-check), bake < 30 ms, spatial maths (key, correction, show mask, invert, 3-way, vignette shape), snapshot expansion (masks carried, keyframes, switched-off sections), Set/Add/Remove Color, hostile params fuzz | pass |
| `packages/project/test/scopes.test.ts` (16): FilmCraft's known-value tests ported + BT.2020/10-bit/clipping/readScopes/1080p timing | pass |
| `packages/project/test/color-match.test.ts` (11): Oklab reference values, self-match, recovers a known grade (stats within 0.02), hue fallback ≤ 8°, faces matched (face hue error smaller than without), no-face = off, letterbox, Auto | pass |
| `packages/compositions/test/lumetri-plan.test.ts` (4): LUT step then spatial stage, `maskJoin`, before/after bypass, pointwise grades stay off the fx path | pass |
| `apps/engine/test/grading.test.ts` (5): scopes of a Program frame and of a clip alone, 404s; match solves towards a warm reference (after < 0.6 × before, highlights wheel towards red, saturation up), face model absent → `hue` + note; refusals; Auto brightens and stretches a darkened clip | pass |
| `apps/mcp/test/grading.test.ts` (6, real engine): every new section in one Agent change and back through `get_grade`; render_frame differs with the vignette on/off (layer bake); `list_looks`; `scopes_read`; `color_match` one "Apply Match" change, dry run, refusal; `auto_tone` one change | pass |
| `apps/web/test/color-grade.test.tsx` (8): section switch, Looks browser, hue-curve eyedropper, Set/Add Color, vignette and correction rows, Apply Match gating; worker compute of a four-up layout | pass |
| `e2e/color-grade.spec.ts` (8, built app, Chrome): Set Color by clicking the Program monitor (one entry), Show Mask, Auto (one entry), Comparison View reference = clip B, Apply Match (one entry, saturation up), Looks browser, vignette darkens the Program monitor corners (corner/centre < 0.6), All Scopes YUV/YC draws traces, **export (auto → hybrid layer bake): corner luma < 0.6 × centre on the exported frame**; frames looked at (`test-results/color-grade/*.png`) | pass |
| Face Detection with the real face model (dev engine :49441, model installed with `install_roto_model`, a public-domain NASA portrait with two dogs and an orange suit; not committed): 1 face found in each frame; the hue test would have counted 57 % of the frame as skin, the face model 1.6 %; with faces the clip's face hue lands within 1.3° of the reference face; without Face Detection the whole-frame match is after = 0.022 | measured |
| Preview vs export of the spatial stage | same shader on both (the export bakes the layer through the compositions); export frame looked at = preview (vignette, look) |

## 4b. Comparison with the references

- **FilmCraft** (`crates/render/src/effects.rs` lumetri, `color_match.rs`, `crates/scopes`): equal on scopes (same
  maths, ported with its tests) plus YUV-White, Premiere's presets, 10-bit scale and clipping shares; Colour Match
  equal plus Premiere's face weighting with a real face detector, letterbox cropping and the no-model fallback; HSL
  Secondary better (EffectCraft's S/L bands with soft edges and invert, 3-way correction, Show Mask styles, Add/Remove
  eyedroppers; FilmCraft keys hue centre/range only); hue curves equal (periodic PCHIP) with eyedroppers.
- **EffectCraft** (`color3.rs` lumetri): equal feature set for Creative/Curves/HSL/Vignette; better: export parity
  (EffectCraft runs Lumetri on the CPU when a CPU-only control is set; here every step runs in the same GPU/LUT
  path in preview and export), section switches, built-in looks browser, Colour Match and Auto (absent there).

## 5. Sources (fidelity by research)

- helpx: "Correct color using HSL Secondary controls", "Correct color using hue and saturation curves", "Match color
  between shots", "Use Auto Color", "Available Lumetri Scopes", "Display Lumetri Scopes", "Create vignettes using
  Lumetri Color" (all under https://helpx.adobe.com/premiere/desktop/correct-color/… and …/add-video-effects/…,
  read 2026-10-08).
- Björn Ottosson, "A perceptual color space for image processing" (Oklab, 2020); ITU-R BT.601 / BT.709 / BT.2020
  Y′CbCr coefficients; NTSC "I" axis (123°) for the skin-tone line.
- Undocumented, our choice (stated above): YUV-White, the eyedroppers' tolerances, the Faded Film / tint / sharpen
  strengths, Auto's target distribution, Denoise spacing.

## 6. Limits and deviations

- The eyedroppers sample the **displayed** picture (after the whole grade); Premiere samples the hue curves at their
  input (after Basic, Creative and RGB curves). The difference is the wheels / secondary / vignette of the same
  instance; set the key/curves before strong wheel moves.
- Basic Correction's newer **Intensity** slider (scales Auto's adjustments in recent Premiere releases) is not built.
- Luma waveform without Clamp Signal spans −10…110 % (FilmCraft); Premiere documents −20…120 IRE for its Luma type.
- Colour Match solves wheels, levels and Basic saturation (as Premiere: "Color Wheels and Saturation"); with Face
  Detection off or no face, a frame dominated by one colour (sky, a coloured wall) drives the cast — choose a
  representative reference frame.
- Letterbox cropping treats edge rows/columns darker than 4 % in every channel as bars (a night shot with a black
  sky band at the top loses that band from the statistics).
- A Lumetri instance with spatial steps takes the fx chain: on a GPU-less host its preview is slower than the
  CPU colour pass (SwiftShader); the export bakes the layer (hybrid) instead of the native `lut3d`.
- With color-mgmt (merged): in HDR working spaces the pointwise Lumetri steps run through color-mgmt's
  `lumetriHdrFn` (graded relative to HDR White), the spatial stage and Colour Match / Auto work on the encoded working
  signal (PQ / HLG code values), and the Lumetri Scopes panel offers color-mgmt's cd/m² scale as **HDR (cd/m²)**
  (the default in HDR sequences, as Premiere). Colour Match / Auto targets assume SDR-like code values; in HDR
  sequences they are untested beyond the unit level.
