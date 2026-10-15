# keyframes-blend — keyframe fidelity, graph editor and motion-path gaps, full blend-mode set

Branch `feat/keyframes-blend`. References: EffectCraft `crates/keyframe/src/lib.rs`, `docs/fidelity/*`,
`crates/color/src/blend.rs`, `crates/gpu/src/shaders/common.wgsl`; FilmCraft `crates/render/src/blend.rs` (Premiere's
27). Ports are recorded in `licenses/ported/keyframes-blend.md`.

## 1. Bezier ease precision (`packages/project/src/keyframes.ts`)

`bezierProgress(u, out, in)` solves the ease's time curve x(t) = u, then returns y(t).

- **100 % / 100 % influence.** x = ½ + 4(t − ½)³ exactly. The closed-form inverse t = ½ + ∛((u − ½)/4) is used
  (EffectCraft `solve_u`). The old Newton loop stopped on an x residual of 1e-6 at the flat midpoint. That was up to
  1.6e-4 of the value change off; now the error is below 1e-12.
- **General solve.** The curve is expanded about its midpoint, where dx/dt is smallest. The constant term is a
  cancellation, so it is kept in double-double (TwoSum / Dekker TwoProduct). Newton is safeguarded by a bisection
  bracket and stops on a **step** criterion (|Δt| ≤ 1e-15).
- **Test** `packages/project/test/keyframes-ease-precision.test.ts`:
  - fast-check property test, 3 000 random eases (influences down to 1e-3 and up to 1 − 1e-12, slopes −4 … 8). It
    checks against an exact BigInt fixed-point reference (2⁻³²⁰, 200 bisection steps) to ≤ 1e-9 (× slope scale).
  - The 100 % / 100 % midpoint within 1e-12.
  - A sweep of the formerly failing region (now < 1e-12).

## 2. Influence overlap above 100 %

The evaluator never normalised: each influence is clamped to (0, 1] and used as given. This is After Effects'
behaviour; EffectCraft measured a 12.46° error from normalising (`docs/fidelity/README.md`). No other code path
normalises (the graph editor, Effect Controls and the commands were audited).

The test reproduces EffectCraft's **live AE 26.3 samples** for three overlapping cases (80/80, 80/60 asymmetric,
descending) to 1e-7, with speed converted to our normalised slope (slope = speed × T / Δv). Premiere uses the same
Bezier temporal model (it shows influence/speed in its graphs and has no normalisation option).

## 3. Roving keyframes (After Effects' Rove Across Time)

**Model.** `Keyframe.roving?: boolean` (optional, absent = false; `keyframeSchema`). A roving key has no time of its
own:

- Each run of roving keys between two fixed keys A and B is evaluated as **one segment**.
- u = (t − t_A)/(t_B − t_A) and p = A's out-ease / B's in-ease progress (linear A → p = u, as for any segment).
- The value is the point at fraction p of the run's cumulative distance: arc length along curved spatial paths,
  value distance otherwise.
- Linear ends give constant speed through the run (EffectCraft's `retime_roving` case). Eased ends shape the whole
  run: an Easy Ease on A and B is one ease across all roving keys.

Fidelity:
- ProVideoCoalition, "After Effects hidden gems: roving keyframes" (provideocoalition.com) notes that the run "works
  even if you … add Easy Ease" to the first or last key.
- EffectCraft instead only spaces roving keys for constant speed and forces them linear. Ours is better: it also
  matches AE with eased ends.

**Stored times.** `retimeRoving` stores each roving key at the time the motion passes it (whole flicks, strictly
between its neighbours). It runs after every key edit (`finish`, `param.set`, effect adds, keyframe paste) and in
`repairDocument`. `evaluate()` never relies on them: the run is derived from values (cached per keyframe array), so
preview, native per-frame sampling, Remotion and MCP all agree.

**Rules.**
- The first and last keys and hold keys never rove. `keyframe.setRoving` skips them with `W_VALUE_CLAMPED`;
  INV-011 reports them and `repairDocument` drops the flag.
- **Dragging a roving key in time turns roving off.** This is undocumented in the sources we could reach; we chose
  it because a key the user places in time is evidently no longer roving.
- Turning roving off keeps the key at its current time. It becomes Continuous Bezier with eases that carry the run's
  speed through it, so there is no jump and no speed change at the key.
- Paste keeps the flag; reversed pastes keep it too, since the run reverses with the keys.

**Command:** `keyframe.setRoving {keyframeIds, roving}` (label "Rove Across Time", owner `keyframes-blend`).

**UI:** right-click a key ▸ **Rove Across Time**, a checkable item. It appears in the lanes and on the graph editor's
keys (shared menu). Roving keys are drawn as a small dot, as AE draws them.

**MCP:** `set_roving`.

## 4. Auto-Bezier spatial tangents

| Rule | Handles | Ends |
|---|---|---|
| Ours (before) | Catmull-Rom ±(next − prev)/6: equal handle lengths | — |
| After Effects (EffectCraft `auto_spatial`) | along next − prev, each ⅓ of its own neighbouring chord | first / last keys have none |

**Evidence.**
- AE draws auto-bezier spatial handles parallel to the line through the neighbours. A key between a short and a long
  segment has visibly unequal handles, so the short segment does not overshoot.
- EffectCraft implemented exactly this rule in its clean-room AE.
- Adobe's keyframe-interpolation guide (helpx.adobe.com/after-effects/using/keyframe-interpolation.html) describes
  Auto Bezier as smooth with handles that adapt to the neighbours, but publishes no formula. Its pages could not be
  fetched here (HTTP 403); the decision rests on the documented behaviour and EffectCraft's port.

**Migration (deliberate, no schema bump).**
- `Spatial.auto?: 'uniform' | 'proportional'`. Absent / `uniform` keeps Catmull-Rom, so existing projects render
  bit-identically (tested).
- New Auto Bezier keys and re-applying Auto Bezier write `proportional`. A Linear key switched to Bezier starts from
  the proportional tangents.

## 5. Graph editor (`apps/web/src/panels/effectControls/{graph.ts,GraphEditor.tsx}`)

- **Overshoot / anticipation.** `EaseSchema.slope` accepts any finite number, which is a backward-compatible
  relaxation. Value-graph handles drag past the next key's value (steep slope) or below the start (negative slope),
  and velocity handles cross zero.
  - Continuous Bezier matching is now **signed** for numbers: a Continuous key at a local extremum gets a smooth zero
    crossing instead of equal-and-opposite speeds.
  - The property's range still clamps the evaluated value (Opacity 0–100 %, as Premiere).
- **vec2 Bezier handles.** Selected Bezier / Continuous vec2 keys show a handle per side on the X (red) and Y (green)
  curve, tangent to the evaluated curve (curved spatial paths included) and influence·T long. Dragging either edits
  the shared temporal ease: horizontal = influence, vertical = slope via that component's rate per unit slope.
- **Independent vertical zoom.** Each graph (Value, Velocity) has its own range:
  - Ctrl/Cmd + wheel zooms about the pointer; Shift + wheel pans.
  - The **Fit** button (pressed = auto-fit) returns to the fitted range.
  - Ranges persist per panel instance (`jasper.ec.<id>.graphViews`).
  - Premiere has no published shortcut for this; the wheel modifiers follow common practice and do not conflict with
    the keymap (no keymap entries were added).

## 6. Motion path (`apps/web/src/panels/program/*`)

- **Anchor Point paths.** When the anchor has ≥ 2 keys, its path is drawn in the accent colour.
  - In the frame, the anchor point always sits at Position (M(A) = P), so we draw the anchor values through the
    layer map at the playhead: the anchor path over the layer, as AE shows it over its layer.
  - Key squares and tangents edit layer-space values (inverse layer map).
  - `get_motion_path {property: 'anchor'}` returns it.
- **Snapping.** A key drag snaps the key to the frame edges / centre, safe margins, other layers' bounds and the
  path's other keys (6 screen px, the gizmo's threshold and snap lines). It honours Snap in Monitor; Ctrl/Cmd during
  the move inverts it, as for the gizmo.
- **Multi-key drags.** Dragging a selected key moves every selected key of that path by the same offset, as one undo
  entry; tangents travel with their keys.
- **Pen-tool vertex conversion** (After Effects' Convert Vertex).
  - With the Pen tool, or Ctrl/Cmd-pressing a key square: a click toggles corner (Linear) ↔ smooth (Auto Bezier).
  - A drag pulls out Continuous Bezier handles (out follows the pointer, in opposite).
  - Ctrl-dragging a key therefore no longer moves it with snapping inverted; use Ctrl during the move for that.
- **Reversed paste off-by-one fixed.** `retimeKeys` maps between a clip's first and **last** frame ((duration − 1)
  frames, as `contentTimeAt`).
  - Scale Attribute Times now maps last frame to last frame (the old test expected 58 of 59).
  - Temporal eases are **mirrored** when keys are pasted or re-timed onto a clip running the other way
    (`reversedKeyTiming`: each segment's out/in eases swap ends; Linear segments become linear-equivalent Bezier).
  - A Hold segment cannot be mirrored (a hold shows its left key). It becomes a hold of the key it now starts from;
    this is documented in the spatial-motion-path gaps.

## 7. Blend modes

**Set.**
- `BLEND_MODES` lists Premiere Pro's 27 in its menu order: Normal, Dissolve | Darken, Multiply, Color Burn, Linear
  Burn, Darker Color | Lighten, Screen, Color Dodge, Linear Dodge (Add), Lighter Color | Overlay, Soft Light, Hard
  Light, Vivid Light, Linear Light, Pin Light, Hard Mix | Difference, Exclusion, Subtract, Divide | Hue, Saturation,
  Color, Luminosity.
- It adds After Effects' Stencil Alpha / Luma, Silhouette Alpha / Luma and Alpha Add.
- The old ids are unchanged (`add` = Linear Dodge (Add)), so existing documents load as-is.
- Labels and groups come from the Premiere Pro guide's blend-mode categories (Normal, Subtractive, Additive, Complex,
  Difference, HSL), plus a Utility group. Metadata and formulas are in `packages/project/src/blend-modes.ts`.

**Formulas.**
- Ported from EffectCraft `blend_pixel` (W3C / PDF separable modes, Lum 0.3/0.59/0.11 for the HSL modes, Rec. 709
  luminance for Darker / Lighter Color and the luma stencils, Hard Mix = threshold of Cb + Cs).
- Compositing is W3C on premultiplied colour.
- `makeBlendKernel` is self-contained: `blendPixel` uses it, and the native workers run its source text.
- The same formulas are in GLSL (`fx_layerBlend`).
- Two tie rules make CPU and GPU decide alike on 8-bit inputs: Hard Mix uses 1 − ¼ code value, and Darker / Lighter
  Color keep the base within 1e-5.
- **Dissolve** is deterministic: EffectCraft's integer hash of the sequence pixel, seeded by `dissolveSeed(clip id,
  clip-local frame)`, 24 bits so the GPU float is exact.
- **Stacking.** Layers blend with everything below, the sequence background included. edit-structure draws the
  background inside the stack so adjustment layers process it, so a mode over an empty area blends with the
  background colour.
  - Premiere's documentation does not say what a blend mode shows over nothing; we chose consistency with the
    adjustment-layer composite and say so here.
  - Stencil / Silhouette cut the stack, background included. What they reveal is the background, drawn once more
    under the whole stack (AE: they reveal the comp background), identically in preview and native.

**Preview and Remotion** (one composition).
- **CSS where exact.** Chrome's `mix-blend-mode` was measured against the formulas
  (`packages/compositions/test/blend-gl.test.ts`, Chrome 150):
  - Darken, Multiply, Lighten, Screen, Overlay, Soft Light, Hard Light, Difference, Exclusion, Hue, Color and
    Luminosity are bit-exact on opaque layers and ≤ 3 code values with layer opacity, so they use CSS.
  - Color Burn, Color Dodge and Saturation drift up to 8 code values with opacity (Chrome un-premultiplies 8-bit
    layers), so they go to GL with the rest.
  - `plus-lighter` differs from Add in alpha.
- **GL blend scope** (`packages/compositions/src/fx/composite.tsx`).
  - A track holding a GL-mode layer wraps everything below it in a scope: background, lower tracks, adjustment
    scopes and its own transition mattes.
  - The backdrop is captured through HTML-in-Canvas, like an adjustment layer.
  - At frames where a GL-mode layer of the track is drawn, every layer the track draws then is captured (the
    transition framework's tap; GPU transition stages deliver their output). Those layers are composited onto the
    backdrop in drawing order by one shader chain. The stack is stored in RGBA8 between layers (`storePremul8`).
  - Pixel-aligned layers sample texel centres exactly.
  - Renders hold the frame until every picture of that frame arrived.
  - Adjustment layers with any mode blend on the GPU with the same formulas (`fxAdjustmentMix`).
  - Still images are now CORS-clean (`crossOrigin`) so HTML-in-Canvas captures paint them. Before, they were left
    out of every capture, adjustment layers included.
- **Without HTML-in-Canvas or WebGL2** (a plain browser without the flag): the Player draws GL modes as Normal with a
  chip naming them. Renders fail with BLEND_UNSUPPORTED / WEBGL_UNAVAILABLE. Electron and Remotion renders enable it.

**Native export** (`apps/engine/src/export/blend/`).
- FFmpeg's `blend` filter is never used. It blends YUV planes independently, ignores alpha compositing and rounds its
  own formulas, so no mode matches exactly.
- Each blend layer ends an ffmpeg process instead: its output is the composite below ‖ the layer placed on
  transparency (`hstack`, raw RGBA).
- A worker pool runs the kernel (`blendStackedFrame` = `makeBlendKernel`, `storePremul8`, Dissolve hash), and the
  result is the next process's `pipe:3` backdrop. Sub-pixel stream layers go into the process they belong to.
- Large filtergraphs go to script files. Any failure stops the pipeline and is reported.
- Pre-rendered GPU transition spans use their sides' common mode.
- The planner keeps every mode native in the sequence's own stack. Blend modes on clips **inside nested sequences**
  are refused with a named blocker and route to Remotion, because the nested stack is drawn inside one process. The
  nest clip itself may use any mode.
- Hybrid layer bakes render the layer alone, and the kernel blends the baked master.

**Effects.** `FX_BLEND_MODES` (effect blend popups, `fx_blend`) gains the 16 missing modes after the original 16, so
existing effect params keep their meaning.

**UI.** Effect Controls / Properties ▸ Opacity ▸ Blend Mode is a select with labelled `<optgroup>`s.

**MCP** (`apps/mcp/src/tools/keyframes-blend.ts`): `list_blend_modes`, `set_blend_mode {clipIds, mode}` (ids or menu
labels), `set_roving`; `KEYFRAMES_BLEND_GUIDE` in the server instructions; README tool list.

## Verified behaviour (tests)

| Area | Test |
|---|---|
| Ease precision, AE overlap samples | `packages/project/test/keyframes-ease-precision.test.ts` |
| Roving: evaluation, property test, commands, move / unrove, repair | `packages/project/test/roving.test.ts` |
| Auto Bezier rules (proportional golden, legacy bit-exact) | `packages/project/test/auto-tangents.test.ts` (+ updated `spatial.test.ts`, `motion-path.test.tsx`, MCP integration) |
| Reversed paste (exact frames, mirrored eases, paste attributes + keyframe paste) | `packages/project/test/reversed-paste.test.ts` |
| GL compositor = `blendPixel` for **every mode** (opaque, opacity, translucent), Dissolve, placement, stencils; CSS modes = formulas | `packages/compositions/test/blend-gl.test.ts` (headless Chrome WebGL2) |
| Native export = `blendPixel` for **every mode** at 60 % opacity, a two-blend stack, planner routing, kernel unit | `apps/engine/test/blend-export.test.ts` (real ffmpeg, PNG stills) |
| Remotion stacks against blend formulas; native/Remotion frame parity | `packages/compositions/test/compositor.e2e.test.ts`, `apps/engine/test/golden-parity.e2e.test.ts` (`REMOTION_E2E=1`) |
| Graph editor: display preferences, vec2 handle edits and undo | `apps/web/test/keyframes-blend-ui.test.tsx` |
| Motion path: anchor path, snapping, multi-drag, pen | `apps/web/test/motion-path-keyframes-blend.test.tsx` |

Historical validation also passed all 31 modes in the former `blend-remotion.e2e.test.ts`. The removed
`e2e/keyframes-blend.spec.ts` exercised the menu, monitor/export Linear Burn and Rove Across Time.

## Comparison with the references

- **EffectCraft (AE).** Same formulas and ease solve, plus:
  - roving runs keep the end eases;
  - signed continuous matching;
  - an exact native export path for every mode (EffectCraft composites on its own CPU/GPU only).
  - Not ported: Dancing Dissolve, the Classic modes and Luminescent Premul (not in Premiere's menu).
- **FilmCraft (Premiere).** The same 27 modes. FilmCraft blends on sRGB-encoded colour as we do. Its Hard Mix
  (vivid-light threshold) and clamped Linear Dodge / Divide differ slightly from the EffectCraft formulas the scope
  asked for. We follow EffectCraft and add AE's utility modes.

## Limits

- Flat (Δv = 0) segments cannot carry an overshoot bump (normalised slopes).
- A reversed Hold segment holds the other end's value.
- Blend modes inside nested sequences export through Remotion, not natively.
- GL modes need HTML-in-Canvas in the Player (chip otherwise).
- The background-included stacking is our documented choice where Adobe's behaviour is undocumented.
- No comparison against real Adobe applications was run (research only, per the brief §3b).
