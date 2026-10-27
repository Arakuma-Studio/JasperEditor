# text-render — spec 13 SH-004: strokes, shadow spread and the text measurer

Workstream `textrender` (spec 13 §2 SH-004). Every `TextStyle.strokes[]` entry is drawn (outside / centre / inside,
colour, width, opacity), the shadow gains a spread (`TextStyle.shadow.spreadPx`, schema v10) and is drawn as a blurred,
grown silhouette, and text boxes follow glyph metrics: a real text measurer in the editor session and in the engine
(headless), replacing the 0.55 em estimate and clearing `layoutPending`. One implementation draws the plain text
block, the In/Out animation overlay, the typeset (animator) renderer and caption clips, in the Program monitor and on
every export path. The layer-bake crop of measured titles is tightened to their glyph + stroke + shadow extent
(prerequisite of AS-070). The subtitle export architecture (AS-070…076) is not part of this work.

## 1. Semantics

Model of a painted text, bottom to top: (caption line backgrounds), the shadow, the fill, then the strokes from the
last in the list to the first (`strokes[0]` on top). Each stroke paints only its region of the glyph outline:

| Position | Region (distance d from the outline, + = outward) | Drawn as |
|---|---|---|
| `outside` | 0 ≤ d ≤ w | a centred text stroke of 2w, cut outside the glyph |
| `center` | −w/2 ≤ d ≤ w/2 | a centred text stroke of w |
| `inside` | −w ≤ d ≤ 0 | a centred text stroke of 2w, cut inside the glyph |

- Strokes are measured from the glyph outline independently (a wider stroke lower in the list shows around a narrower
  one above it). **Assumption** (Premiere's documentation does not state the stacking rule; the Graphics panel lists
  strokes top first and Adobe Community requests for "Stroke Alignment (Inner, Outer, Center)" and "multiple strokes"
  in After Effects describe Premiere as having both — https://community.adobe.com/t5/after-effects-ideas/text-panel-upgrades-drop-shadow-tweak/idi-p/14989108).
- Joins are Chromium's text-stroke joins: miter, limit 4 (`-webkit-text-stroke` has no join control; `stroke-linejoin`
  does not apply to HTML text — checked on the build VM's Chromium 153). A pixel font's right angles therefore get
  square corners. Premiere's default line join is not documented (**unverified**; it may round them).
- Opacity: the stroke colour's alpha. Faux bold (typeset) thickens the outline first: bands follow the thickened outline
  (centre: w + bold width; inside: max(0, 2w − bold width) — an approximation for inside strokes thinner than half
  the faux-bold width).
- Shadow (`resolveTextShadow`, `packages/project/src/text-style.ts`): the silhouette of the glyphs and their outer
  strokes, grown by `spreadPx`, blurred by a Gaussian of σ = `blurPx` / 2, offset by `distancePx` at `angleDeg`
  (0° = right, 90° = down, the convention of the CSS renderers since S03), at the shadow colour's alpha. It shows
  through translucent fills (as the CSS `text-shadow` it replaces did). Spans with different shadows get one shadow
  layer each.
- Premiere mapping (for templates such as the user's "Pixel Pop": shadow #221D58 80 %, distance 0, size 26.87,
  blur 250 at ≈ 98 px): Size → `spreadPx` 1:1 in pixels, Blur → `blurPx` 1:1 (σ = 125 px), Distance → `distancePx`,
  Angle → `angleDeg` (ours: 0° = right, 90° = down; Premiere's angle origin is **unverified**), Opacity → colour alpha. **Assumption**: no
  public reference gives Premiere's shadow units (searched helpx "work-with-fill-stroke-background-shadow" and
  tutorials: only the control names Opacity / Angle / Distance / Size / Blur are documented). σ = blur / 2 keeps every
  existing project's shadow unchanged (CSS blur radius semantics, CSS Backgrounds 3 §7.2). Calibrating against a
  Premiere export of the user's style needs footage from the Mac and is left to the template work (AS-020).

## 2. Implementation (`packages/compositions/src/layers/text/paint.tsx`)

The text is drawn several times with the same layout — one copy per pass (`render(mode)`); copies differ only in
colour and `-webkit-text-stroke`, which never changes layout.

- **Fast path** (no filter): no inside stroke, every fill opaque (base style, runs, caption highlight), every centre
  stroke above every outside stroke. Outside strokes are drawn as whole centred strokes under the opaque fill (it hides
  their inner half), centre strokes over it — exactly the model, no seams. The user's style takes this path.
- **Filter path** (any inside stroke; a translucent fill with an outside stroke; a centre stroke below an outside one):
  the copies are laid out as tiles side by side in one element — fill (real colours), glyph mask (white), one tile per
  (slot, position) — and one SVG filter aligns them with `feOffset` by whole tiles (rows wrap at 8192 px) and
  composites, premultiplied:
  `inner` = stack of inside / centre bands, `outer` = stack of outside / centre bands (list order),
  `result = (inner IN glyph) + (fill OUT inner) + (outer OUT glyph)`.
  The glyph coverage splits every edge pixel between the inside and the outside, so there is no conflation seam at
  the outline (a plain cut band composited over the fill leaves a 25 % hole at half-covered edge pixels). Prototyped
  first: the filter path and the fast path agree within 1 level on an opaque fill (build VM, Chromium 153).
  Tiles grow to the content's measured overflow (a paragraph taller than a fixed box).
- **Shadow**: a copy in the opaque shadow colour with a centred text stroke of 2 × (outer stroke + spread), in a layer
  with `filter: blur(σ)`, the offset and the alpha as opacity.
- **Renderers**: `RestText` (the plain block) and `CaptionsLayer` paint the whole block; the In/Out animation overlay
  paints each animated unit (its transform, opacity and blur apply to the painted unit as a group); `TypesetText`
  paints each glyph (the animators' stroke colour / width drive `strokes[0]`, After Effects' one text stroke; the
  other strokes are static). In `allFillsOverAllStrokes` / `allStrokesOverAllFills` a filter-path glyph's stroke pass
  is the cut stroke regions (`output: 'strokes'`) drawn apart from its fill — edge pixels there are composited
  source-over (approximation of those two AE orders). Typeset shadows are one layer under all glyphs (the union of
  their silhouettes is blurred once; per-glyph opacity scales a glyph's silhouette).
- Only the fill copy carries `data-text-block` / `data-caption-page` / `data-caption-word` (tests and probes see one
  text); the others are `aria-hidden` `data-text-copy` / `data-caption-copy`.
- The path through a layer effect (HTML-in-Canvas, `FxDomPicture`) captures the painted text with its filters: a
  text layer with inside + outside strokes and a shadow under Invert draws every ring and the shadow, in the preview
  and the export (`text-paint.e2e.test.ts` "through a layer effect").

No export path draws text without the compositions (no `drawtext` / libass): native and hybrid exports bake text with
the same component (layer bake), stills and thumbnails render the composition, so no new planner blocker is needed;
the planner now warns `TEXT_LAYOUT_PENDING` when a text box is still an estimate. Validation: `MAX_TEXT_STROKES` (16)
and `MAX_SHADOW_SPREAD_PX` (10 000) are invariants (INV-012; `MAX_TEXT_STROKES` is the one constant the text-style
patches of SH-003 also bound with; their command schema accepts spreads up to 1 000 px) with repair (`repair-text-style`); the renderers also cap
at 16 strokes and clamp the spread, so an unreadable value never allocates.

## 3. Text measurer

- Contract (`packages/project/src/commands/types.ts`): `measure(content, box, fonts) → {width, height} | null`; null =
  cannot measure now. `layoutText` (`clip-core.ts`) sizes auto-size boxes (point text: width and height; paragraph
  text: height), rejects non-finite or > 65 536 px answers and measurer exceptions (estimate + `layoutPending`), and
  moves the default anchor (the old box centre, not keyframed) to the new centre.
- `measureTextBox` (`box-measure.ts`, browser): the same block CSS as the text layer (`block.ts`) or, for extended
  typography, the same typeset layout (`measure.ts`), off screen, untransformed; whole pixels rounded up. Faces are
  the snapshot's (`fonts[fontId].family` + the URL the catalog resolves); a face still loading starts loading and the
  measurement returns null.
- Editor (`apps/web/src/fonts/text-measure.ts`, `session-host.tsx`): faces from the engine font catalog as the Program
  monitor resolves them; while the catalog is unknown the measurer waits. `EditorSession` measures pending clips as a
  system transaction (`text.relayout`, no History entry) when the measurer reports settled faces, after open and after
  any document change (undo / redo back to an estimate measure again); a catalog change (font installed / removed)
  re-measures the clips whose faces changed.
- Engine (`apps/engine/src/fonts/text-measure.ts`): headless agent transactions run with `HeadlessTextMeasurer.apply`:
  the transaction runs with a cache, the missing measurements are made in a page of the Remotion bundle
  (`window.__jasperTextMeasure`, installed by `remotion-entry.ts`) in the render browser, served by a private loopback
  server with the font files the export resolves (`FontCatalogService.resolve`, fallback family included), and the
  transaction runs again (≤ 3 rounds). A round waits ≤ 20 s, the bundle ≤ 3 s (a dev engine bundles on first use and
  keeps building); what is not measured stays `layoutPending` for the editor. The page closes after 60 s idle.
  `JASPER_TEXT_MEASURE=off` disables it (under Vitest it is off unless `on`).
- `text.relayout {clipIds?}` (command, label "Measure Text"): the listed text clips (locked tracks included: the box
  is derived data), else every pending text clip; refuses non-text clips (`E_INVALID_PARAM`); warns `W_LAYOUT_PENDING`
  without a measurer or for clips still pending. MCP: `describe_commands` example; `add_text` gains `strokes` and
  `shadow` (with `spreadPx`); the caption style field list documents positions and the spread.
- Fixed by the way (regression tests): the Stroke Width / Stroke Color property rows and the Captions tab's Outline
  replaced the whole stroke list with one stroke; they now edit the first stroke and keep the others
  (`text-style.test.ts` "first-stroke property rows"). `caption.applyPreset` scales a built-in preset's spread too.

## 4. Layer-bake crop (`apps/engine/src/layer-bake/layer.ts`)

`contentBleed` for text = max over the styles (base and runs) of `textPaintExtent` (outer strokes; shadow offset +
outer strokes + spread + 3 σ) + `textInkPad` (⌈size × (0.35 + max(0, 1.25 − lineHeight) / 2)⌉ + 2: accents,
descenders and overhangs beyond the line boxes), at least the background padding. `tightTextCrop`: a text clip whose
box is measured (not pending), auto-size, without In/Out animation, animators, text path or per-character 3D is
cropped with a 2 px bleed instead of 10 % of the frame height. The textperf caption (130 px, 30 px outside stroke,
shadow 12 / 8, 1080 × 1920): **1072 × 370** instead of **1080 × 750** (`apps/engine/test/text-bake-crop.test.ts`,
deterministic; textperf measured 1080 × 760 with its own box) — ≈ 2 × fewer pixels per baked frame. The user's look
(98 px, shadow blur 250) needs ≈ 413 px of shadow bleed per side: its very soft shadow really reaches that far.

## 5. Verification (build VM `6b922ed28e39`, 16 shared vCPU, Chromium 153 headless shell / Chrome for Testing)

- `packages/compositions/test/text-paint.e2e.test.ts` (REMOTION_E2E=1): geometry oracles on a generated square
  glyph (`@jasper/testkit/fonts` `glyphRects`; the generator moved there from `apps/engine/test/font-fixtures.ts`):
  two outside rings at their widths with square corners; inside + centre rings; a translucent fill with an outside
  stroke (no stroke under the fill, no seam: every pixel across the outline at least as bright as the fill); spread
  with blur 0 (square + 10 px, moved 40 px); the blur profile against Φ((spread − d) / σ) within 12 levels at
  d = 10…55 px (σ = 20 for blurPx 40); a layer effect (HTML-in-Canvas). Preview (Player) vs export (renderStill)
  on every case, tolerance ≤ 1 % of pixels off by > 16 levels and mean ≤ 1 level — measured: real fonts (Source Sans 3
  three strokes + shadow, runs with their own strokes, typeset, animated units, captions, the pixel-font subtitle
  look) 0.000 % / mean ≤ 0.51; synthetic squares 0.19–0.67 % (glyph edges rasterised a fraction of a pixel apart by
  the Player and the render page). Measurer oracles on the generated pixel font: n × 0.6 em × line height exactly,
  tracking, paragraph wrapping at the box width; Source Sans 3 bold wider than regular, tsume narrower.
- `apps/engine/test/text-paint-export.e2e.test.ts` (REMOTION_E2E=1): an agent transaction applied headless gets a
  measured box; the bake rect is tight; the hybrid export (bake composited natively) and a Program still match the
  Remotion frame (share within 3/255 > 99.5 %).
- Unit: `packages/project/test/text-style.test.ts` (geometry, invariants, repair property test, load repair, measurer
  contract, `text.relayout` refusals / no-op / warnings, the stroke-row regression), `packages/session/test/
  text-relayout.test.ts` (system relayout without History entries, redo back to an estimate, read-only),
  `apps/engine/test/text-bake-crop.test.ts`.
- In the running app (build VM dev stack, engine 47923 / vite 5193, Chromium via agent-browser): a project made by
  an agent transaction while the dev bundle was still building (boxes estimated, `layoutPending`) opened in the editor;
  the session measured both titles at once (Montserrat 800: 848 → 836 px and 1144 → 1027 px wide, anchors moved to
  the new centres, no History entry) and autosave wrote them (revision 1 → 2). The Program monitor and a Program
  still drew the outside stroke with its 27 px-spread / 120 px-blur shadow (fast path) and the inside + outside
  strokes under a 50 % fill (tile filter). Found and fixed on the way: autosave took the revision current when it
  attached as saved, so a measurement made between open and autosave was never saved
  (`packages/session/src/persistence/autosave.ts` now starts from `EditorSession.openedRevision`; regression test in
  `text-relayout.test.ts`).
- Goldens re-blessed after inspection: `goldens/scenes/text.png` (drop shadow blur 1 px: the shadow is now a blurred
  silhouette instead of a CSS text-shadow; PSNR 42.2 dB vs the old golden, max 67 levels on the shadow's anti-aliased
  edge, the text pixels unchanged) and `goldens/scenes/captions.png` (3 pixels where the two lines' background boxes
  meet: every background is now drawn under all text). `text-animators.e2e.test.ts` "strokes over fills" now uses a
  centred 12 px stroke: an outside stroke no longer paints inside its own glyph (After Effects' strokes are centred).

## 6. Limits

- Joins are miter (see §1); round joins would need vector outlines the DOM does not expose.
- The Premiere shadow units are an assumption until calibrated (§1).
- Preview at a fractional zoom shifts the tiles by fractional device pixels: filter-path text may look slightly soft
  in the Program monitor at such zooms (exports are 1:1).
- An animated unit with opacity < 1 draws its strokes and fill as one group per unit (not per block): where a unit's
  stroke overlaps a neighbouring unit, the later unit is on top, as before.
- Performance: the fast path adds one DOM text copy per stroke and per shadow; the filter path one filter per text
  block (per animated unit / typeset glyph). Not benchmarked here (AS-050 / AS-075 measure subtitle playback).
- Caption clips are not cropped tighter (their layer box is the frame; the bake renders full frame as before).

## Test ownership

Text paint is protected by the independent glyph/ring/alpha/Gaussian pixel witnesses and preview/export comparisons
in `packages/compositions/test/text-paint.e2e.test.ts`. Paint-plan branch decisions, CSS strings, tile counts and DOM
copy counts are implementation choices; their redundant unit and browser assertions were removed. The paint helpers
remain internal to the rendering layers rather than being exposed by the package barrel. Per-case dispositions are
recorded in `docs/test-audit/rendering.json`.
