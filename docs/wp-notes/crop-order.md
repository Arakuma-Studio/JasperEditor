# crop-order — Crop applies where it sits in the effect stack; Crop's Edge Feather renders

Branch `feat/pp-crop-order` (Premiere port). Before this work every renderer moved a clip's Crop in front of its other
effects (`effectStages` and `planLayerFx` sorted it first, adjustment layers and the sub-pixel kernel special-cased it),
and the Crop effect's **Edge Feather** parameter (pixels) was stored but drawn by no path. Schema v8 (the coordinator's
foundation commit) makes the stored order the render order; its v7→v8 step moves Crop effects listed after other
effects to the front, so v7 projects keep their look. This work makes every renderer honour the order and draws the
feather identically in preview and every export path.

## 1. Research

### Render order

- **Premiere Pro help, "Effects in Premiere Pro"** (helpx.adobe.com/premiere-pro/using/effects.html; read through the
  Wayback Machine, capture 2021-10-26, because helpx answers 403 here). Quoted: "Premiere Pro renders Fixed effects
  after any Standard effects that are applied to the clip. Standard effects are rendered in the order in which they
  appear, from the top down. You can change the order of Standard effects by dragging them to a new position in the
  Effect Controls panel, but you can't reorder Fixed effects." The same page lists Crop among the standard effects
  (Accelerated / 32-bit / YUV lists).
- **Premiere help, "Transform effects"** (helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-
  library/transform-effects.html, capture 2026-05-14): "The Crop effect trims pixels from the edges of a clip. The Left,
  Top, Right, and Bottom properties specify what percentage of the image to remove." The page does not describe the
  Crop effect's Edge Feather (its "Edge Feather effect" entry is the separate frame-edge vignette effect).

Consequences used here: Crop (a standard effect) is applied at its stack position, in the clip's own frame, before
Motion and Opacity (fixed effects). So **Edge Feather is in clip pixels** (JasperEditor's layer pixels: the clip's
intrinsic box) **and scales with Motion Scale**.

### The user's projects (evidence, read-only)

The decoded Premiere projects (`/tmp/prproj-inspect`, not committed) contain 119 `AE.ADBE AECrop` instances: params
Left / Top / Right / Bottom (0–100), a boolean (Zoom, false in all 119) and **Edge Feather with bounds −30000…30000**.
19 instances sit after another effect (Basic 3D ×11, Ultra Key ×7, Gaussian Blur, Shake + Alpha Glow), so a
Crop-first renderer drew real projects wrongly. Feather values used: 50, 71, 77 (×2), 500.

### Edge Feather behaviour (undocumented — assumptions labelled)

No Adobe documentation of the Crop effect's Edge Feather was found. Forum evidence, which partly conflicts:

- community.adobe.com, "Edge feather no longer functioning properly" (m-p/14973682): a Community Expert says that to
  feather all sides with the Crop effect "adjust the Edge Feather slider within the effect. Dragging it to a negative
  number will feather all sides."
- creativecow.net, "Edge feathering a lower third box?" (2013): "Crop effect has feathering option, but it feathers all
  edges equally … no controls for separate X and Y feathering … leave cropping from each side at 0% and apply negative
  value feathering."
- community.adobe.com bug report "Crop Effect - Right Crop stops working if Edge Feather property is adjusted"
  (24.6.1): "Edge Feather only affects the vertical crop line and also the top and bottom of the image once I go about
  12% or so" — i.e. a large positive feather reaches into the picture from uncropped (off-screen) edges too.

Choices (assumptions, **A1–A5**):

- **A1 (direction):** a positive Edge Feather fades the picture in *inward* from each edge of the crop window, all four
  edges (an uncropped edge is the box edge). This matches the coordinator's brief, FCP 7's Edge Feather (which our FCP
  7 XML interchange maps 1:1, `packages/interchange/src/fcp7.ts`) and the 24.6.1 report; it does not explain the
  negative-value advice, which suggests Premiere's positive values may extend *outward* from cropped edges. Not
  measurable without Premiere.
- **A2 (falloff):** linear ramp of alpha from 0 on the edge to 1 at `feather` pixels inside, box-filtered over each
  pixel (so feather 0 is exactly the hard edge's area coverage and the profile is continuous in the feather).
- **A3 (corners):** the four edges multiply.
- **A4 (space):** layer (clip) pixels, before Motion (follows from the render order above).
- **A5 (range):** 0…1000 px as registered before; negative values (Premiere allows them) are not supported.

## 2. The profile (`packages/project/src/render/crop.ts`)

For an edge at position `e` and a pixel centred at distance `d` inside it (pixels; negative outside), with feather `f`:

    G(t) = 0 (t ≤ 0);  t − f/2 (t ≥ f);  t² / (2f) otherwise        (integral of clamp(u / f, 0, 1))
    coverage(d, f) = clamp(G(d + ½) − G(d − ½), 0, 1)
    alpha factor(x, y) = Π over the four edges of coverage(distance inside that edge, f)

`cropEdgeCoverage` is the shared reference for each edge; the four edges multiply as above. The preview shader
(`CROP_FEATHER_GPU`, `packages/compositions/src/fx/builtins.ts`) and the native mask (`axisCoverageExpr`,
`apps/engine/src/export/crop.ts`) evaluate the same expression. Property tests (fast-check) pin the laws: in [0, 1],
monotone in the distance, non-increasing in the feather, 0 beyond half a pixel outside, 1 beyond `f + ½` inside,
continuous at f → 0, and equal to a numerical box-filtered average of the ramp.

## 3. Renderers

| Path | Hard crop | Edge Feather |
|---|---|---|
| Preview / Remotion, CSS stages (`pipeline.ts` `effectStages`, `LayerBox`) | `clip-path: inset()` on its own wrapper at its stack position (inner wrappers = earlier effects): exact | CSS gradients are dithered/resampled, so never used: the layer takes the fx chain |
| fx canvas chain (`fx/plan.ts`) | `crop` step at its position; after the last chain step it stays a CSS stage (still in order) | GPU stand-in step at its position (shared profile, feather × `pxScale`); keyframed/expressed feather (`cropMayFeather`) keeps this path on every frame |
| Colour stage (`color/chain.ts`) | stays a CSS stage (crop commutes with LUTs); a crop placed before a pixel-mixing effect that precedes a colour run would be cut after it, so such layers take the fx chain (`cropNeedsChain`) | layer takes the fx chain |
| Flat compositor (`fx/flat-plan.ts`) | DOM layers captured in composition space keep their CSS stages | a DOM layer with a feathered crop counts as drawing through its own canvas (`clipDrawsThroughCanvas`) |
| No WebGL2 / no HTML-in-Canvas (preview) | unchanged | hard `clip-path` plus the "GPU effects unavailable" chip (bypass recorded); renders cancel instead |
| Adjustment layers (`AdjustmentScope.tsx`, `fxAdjustmentMix`) | region = intersection of the crop windows, each mirrored by the flips after it; a crop before a pixel-mixing effect also cuts (hard) at its place | region coverage × profile: original + coverage · (mixed − original) |
| Native filter path (`native.ts` `layerSourceChain`) | `crop`+`pad` (whole px) or the keyframed rectangle mask, at its place | `cropFeatherFilter`: `geq` x- and y-profiles (`W×1`, `1×H`, per-frame edge/feather expressions), replicated, `lut2` product, alpha multiply — at its place |
| Native sub-pixel kernel (`stream/plan.ts`) | anti-aliased clip after the source chain: the windows of all hard crops, each mirrored by the flips after it, intersected (exact: native effects after a crop are colour LUTs and flips) | stays in the source chain at its place (exact at any edge position) |
| Native adjustment layers | region after the effects (`adjustmentCropFilters`), mirrored windows | feather mask on the region |
| Hybrid layer bake, Remotion export, stills, thumbnails, frame export | the compositions above (bake renders the layer through them) | same |
| Scopes | read the Program picture (the renderers above) | same |
| Overlays, Fit/Fill, anchor presets (`resolveLayerProps().crop`, `layer-ops.ts`) | `cropWindow`: visible window of all crops, mirrored by later flips | the window (feather only fades inside it) |

The planner needs no new blocker: every native route above draws crops exactly. Corner Pin stays the layer map after
every effect (D-27), on every path alike, so a Crop listed after a Corner Pin cuts the unpinned picture (limitation).

## 4. Editing surfaces

- **Effect Controls:** the pinned "Crop" section shows a crop at stack index 0 and is an effect header (draggable,
  a drop target at index 0, removable). A crop after another effect is listed with the effects at its stack position;
  then the pinned defaults section is hidden (editing it would add a second crop). Reordering is `effect.reorder` (one
  undo step); the renderers apply the stored order.
- **Properties:** the Crop section edits the clip's first crop wherever it sits; with none, the first edit adds one at
  index 0.
- **Effect presets:** a preset's intrinsic Crop is the source's crop at stack index 0; a crop placed after other effects
  is saved as an ordinary effect (its place is kept). Applying overwrites the target's crop at index 0 or inserts one
  there. MCP `save_effect_preset` defaults follow the same rule.
- **MCP:** the editing guide states the stack order (Crop included) and Edge Feather; the structure guide states the
  adjustment-layer region rules.
- No on-canvas crop handles exist (S03 XF-040 is not implemented); nothing to adapt there.

## 5. Migration interplay

`packages/compositions/test/crop-order.test.ts` loads the v7 fixture with a clip listing Flip → Blur → Crop: after
`loadProject` the stack is Crop → Flip → Blur (no repairs), the CSS stages and the chain plan put the crop first and
the visible window is mirrored (as v7 drew it).

## 6. Evidence (measured on the shared VM, 16 vCPU, load ≈ 9–13 from other agents)

- `apps/engine/test/crop-order-native.test.ts` (FFmpeg, LGPL build, lossless PNG stills): Crop → Flip and Flip → Crop
  exact (0 differing values); Edge Feather vs the profile ≤ 2/255 on every pixel; feather before a flip mirrored;
  keyframed feather at frame 15 = profile at f = 30; feathered crop on a sub-pixel layer = bilinear of the profile
  (≤ 3); adjustment layer: original + coverage · (adjusted − original) ≤ 3; flip after / before the crop mirrors / does
  not mirror the region (≤ 1).
- `apps/engine/test/crop-order-parity.e2e.test.ts` (REMOTION_E2E=1, Chrome for Testing 153): export vs Remotion
  (the preview's renderer) — crop→flip 51.9 dB / max 22 (291 px of anti-aliased fractional edge), flip→crop 50.5 dB,
  feather 60.0 dB max 2, feather→flip 59.0 dB, keyframed feather 59.3 dB, feather on a scaled + rotated layer 56.9 dB
  max 3, Mirror→Crop ∞ dB, Crop→Mirror 75.2 dB, Crop→Blur 58.1 dB, Blur→Crop 60.2 dB (both hybrid), adjustment layer
  with feather and a flip 60.4 dB; feathered scenes vs the profile ≤ 2/255 on both; Crop→X differs from X→Crop
  (max > 64) for Flip, Mirror and Blur.
- Golden `packages/compositions/test/goldens/scenes/crop-corner-pin.png` re-blessed after inspection: the scene's crop
  has `feather: 6`, which no path drew before; old vs new differ only in a band along the four edges of the pinned crop
  window (2 515 px, PSNR 27.1 dB against the old frame, max 193 where the hard edge met the card), the rest of the frame
  is unchanged.
- Regression suites rerun unchanged (REMOTION_E2E=1): all 61 `golden-scenes.e2e` scenes (only `crop-corner-pin`
  re-blessed, above), `golden-parity.e2e`, `edit-structure-render.e2e`.
- Unit tests: `packages/project/test/crop-stack.test.ts`, `packages/compositions/test/crop-order.test.ts`,
  `apps/web/test/crop-order-ui.test.tsx`.

## 7. Limitations

- A1–A5 are assumptions (no Premiere available to measure); negative Edge Feather is not supported.
- Corner Pin is applied as the layer map after all effects (D-27), so Corner Pin → Crop renders as Crop → Corner Pin.
- Geometric effects after a crop other than flips (Transform, Mirror, Offset…) move the visible picture; overlays and
  Fit/Fill use the crop window, which ignores them.
- Adjustment layers: a crop before a pixel-mixing effect cuts hard at its place (its feather is the region's) — a
  model choice consistent with the frame-edge behaviour, not measured against Premiere.
- The Crop effect's Zoom option (Premiere) is not modelled (all 119 instances in the user's projects have it off).
