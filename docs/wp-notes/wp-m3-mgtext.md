# wp-m3-mgtext — hybrid text layers (S08:MGC-035…039, MGU-005/006, MGA-003)

Branch `wp/m3-mgtext` (from `main` ebb01ed). Spec: `docs/specs/08-motion-graphics-clips.md` (MGC-035 rewritten,
MGC-036…039, MGU-005 promoted to P1, MGU-006, MGA-003, §8 test 9). Closes the "MGC-035 not implemented /
acceptance test 8 uncovered" gap of `wp-m2-mg.md`.

## What MGC-035 meant, and what was built

MGC-035 as written in M2 ("the `mg` extension may also claim `text` clips: pre-render them through
`SequenceComposition` with `layerFilter` to a sequence-space ProRes 4444 intermediate") was delivered by
**wp-m2-layer-bake** under another extension id: `layer-bake` claims every DOM layer (text, shape, anime
templates), plans `hybrid` and bakes exactly that intermediate (S11 §6, LBK-001…026). Acceptance test 8 is the
layer-bake e2e parity (`apps/engine/test/layer-bake.e2e.test.ts`, ≥ 99 % within 3/255). The spec now says so.

The missing half — and what an editor user means by "hybrid text layers" — is **text inside Remotion composition
clips**: the copy of a title/caption made in code must be editable in the editor like a text clip, preview live,
export natively. That is this package (MGC-036…039).

| Req | Where | Notes |
|---|---|---|
| MGC-036 discovery | `packages/project/src/composition/texts.ts` (`compositionTextLayers`, `textLayerPropertyKeys`, `findTextLayer`) | Manifest `texts` (order kept, `false` hides) → `x-jasper-text` schema annotation → `ui.control text/textarea` → plain strings (heuristic exclusions: pattern/format/enum/const, colours, assets, names like `…Url`, `id`, `font…`, `mode`, `variant`, `theme`, `align`, `color`, `bg`…). Style links per role (fontFamily, fontSize, fontWeight, italic, color, align, lineHeight, letterSpacing): manifest `style`, text object `{x: {text, color, size…}}`, prefixed siblings (`titleColor`, `title_color`…); a link must fit its role. Linked props are not texts. Cached per info object. |
| MGC-036 model | `packages/project/src/schema/media.ts` (`MgTextDeclSchema`, `MgCompositionInfo.texts?`), `apps/engine/src/mg-bundles/schemas.ts` | Additive optional field (no migration). The manifest's `"*"` entry and the id's own `texts` merge entry by entry. |
| MGC-037 checks | `texts.ts` (`checkCompositionText`, `measuredTextIssues`), `packages/compositions/src/mg-host/text-probe.ts`, `apps/web/src/mg-bundles/text-measure.ts` | Static: schema length = error; `maxChars`, `maxLines`, a line break in a single-line text = warning. Measured (editor): an off-screen live host page (same bundle page + protocol as the Program monitor) renders the clip's props at the text's `frame` (manifest → `thumbnailFrame` → middle), the page's text probe returns boxes, line boxes, the clipping ancestor and ellipsis: off frame, cut off by its box (what is left is then checked against frame/box), ellipsis, outside the safe `box`, more rendered lines than `maxLines`; not drawn = info. |
| MGC-037 probe | `text-probe.ts` (string script), `protocol.ts` (`hostBootstrapScript` appends it) | Runs before the bundle's scripts. Locates a value by its characters ignoring whitespace, case and `*_~` (copy split into spans/rows matches); prefers exact element matches and visible occurrences. `hide/restore` for the on-canvas editor. |
| MGC-038 edits | `texts.ts` (`overridesWithEdits`, `validateTextEdit`, `textLayerValue`) | `param.set props.<path>` for one value; text + style in one `clip.update {props}`; both one History step and validated by the composition schema in the model (unchanged handler). Props → render key (MGC-031) → new preview and master, so exports show the new text. |
| MGC-039 fonts | `text-probe.ts` (FontFace wrapper + `@font-face` CSSOM), `apps/web/src/mg-bundles/bundle-fonts.ts` | Faces recorded with absolute URLs (or the raw buffer, copied into the editor's realm), registered in the editor document as `jmg-<key>-<family>`; the computed `font-family` of the text is rewritten to the alias. Font menus of linked `fontFamily` string props list the bundle's families. |
| MGU-006 Properties | `apps/web/src/mg-bundles/CompositionTexts.tsx`, `CompositionSection.tsx` | "Text" above "Props". Per text: label, counter (`n/maxChars` or `n/maxLength`, amber/red), Edit on canvas, Reset; textarea/input with live preview while typing (`createScrub` gesture; invalid values never reach the preview, Esc reverts, Enter / Ctrl+Enter / blur commits one step "Edit Text «label»"); style rows (Font select of bundle families, Weight 100–900 select, Size scrub, Colour swatch, Align buttons, Italic, Leading, Tracking — the generic `PropEditor` otherwise); warnings (static while typing, measured when not focused); manifest `hint`. Generic form skips owned keys. |
| MGU-005 on canvas | `apps/web/src/mg-bundles/{CanvasTextEditor,text-edit}.tsx`, `extensions/index.ts` (`layerDoubleClickHandlers`), `TransformOverlay.tsx` (`onDoubleClick`), `runtime.ts` (`setTextEditing`), `CompositionLayer.tsx` (`data-mg-host-clip`, `data-mg-host-frame`) | Double-click (selection tool) → handler → editor overlay (Program overlay registry). The clip is forced to its live host; the editor waits for the host to draw the playhead's composition frame, probes all texts, picks the one under the pointer (line boxes ± 12 px, else nearest ≤ 64 px, else the only visible one), hides it, registers the bundle fonts and renders a `field-sizing: content` textarea in the layer's coordinate system (view transform · layer matrix or corner-pin matrix3d) with the probed size/weight/colour (opaque)/line height/tracking/alignment/transform. Lower-half texts grow upwards. Enter / Ctrl+Enter / blur applies (schema errors keep it open), Esc cancels; playback, a vanished layer or a playhead outside the clip closes it. From Properties it seeks into the clip (the text's `frame`). No text under the pointer → a note and the Properties field takes the focus. |
| MGA-003 MCP | `apps/mcp/src/tools/compositions.ts` | `list_composition_texts`, `set_composition_text` (one transaction; path or label; style by role; `E_NOT_FOUND` lists the texts, unexposed roles list the exposed ones; soft-limit warnings in the result); `list_compositions` gains `texts`; `COMPOSITION_GUIDE` updated. |
| Template | `apps/engine/src/mg-bundles/template/files.ts` | Scaffolded projects declare `texts` for their LowerThird and the README explains the conventions. |

## Contract changes (additive; `Contract-Change:` in the commits)

- `MgCompositionInfo.texts?`, `MgTextDeclSchema` / `MgTextDecl` (`@jasper/project`); manifest `compositions.<id>.texts`.
- `@jasper/project` exports `compositionTextLayers`, `checkCompositionText`, `measuredTextIssues`, `overridesWithEdits`,
  `validateTextEdit`, `textLayerValue`, `textLayerPropertyKeys`, `findTextLayer`, `textLength`, `TEXT_STYLE_ROLES`,
  types `CompositionTextLayer`, `StyleLink`, `TextIssue`, `MgTextMeasurement`, `TextEdit`.
- `@jasper/compositions` (`./mg-host`): `TEXT_PROBE_SCRIPT` appended to `hostBootstrapScript()`; `locateTexts`,
  `textProbeOf`, `BundleFontSource`. The page gets `window.__jasperTexts` and a recording `window.FontFace` wrapper
  (constructs the native face; `instanceof` unchanged).
- `CompositionLayer` live host iframe: `data-mg-host-clip`, `data-mg-host-frame`; `HostState.frame`.
- Web: `layerDoubleClickHandlers` registry (`extensions/index.ts`) + `TransformOverlay` `onDoubleClick`;
  `MgRuntime.setTextEditing`; `PropEditor` exported from `CompositionSection.tsx`.
- Fixture `fixtures/mg-project`: new composition `LowerThird` (tests that listed `['Badge', 'Title']` now list three).

## Licences

No new dependency. `fixtures/mg-project/public/fonts/Inter-Bold.ttf` = the repo's existing Inter Bold
(`native/mg/crates/jasper-mg-templates/media/Inter_24pt-Bold.ttf`), SIL OFL 1.1, licence text next to it
(`public/fonts/OFL.txt`). Test-only ffmpeg use: decode/overlay/compare (LGPL build or system ffmpeg).

## The trailer's real project (MatsSmileTrailer/mg)

Copied to `/tmp/wp-m3-mgtext/mats/mg` (`.bundle`, `out`, `archive`, `.entries` excluded; original untouched).
Its four headline captions (MG07, MG10, MG19, MG25, `src/shots/_parts/captions-system.tsx`) hold their copy in code
as rows of timed segments (`segmentsOf(COPY, [[{text, at}, {text, accent, at, lightAt}], …])`). The light
convention that makes them editable without touching their look:

1. `captions-system.tsx` gains two helpers:
   - `headlineText(template)` — the verbatim copy as one string: rows joined by `\n`, accent segments in
     `*asterisks*` (MG07: `"La clínica sabe que\ntu paciente *ha llegado.*"`);
   - `editableHeadline(headline, template)` — parses an edited string back into rows/segments; a segment of row i
     takes the beat (`at`, accent `lightAt`) of the template segment of row i with the same accent flag; rows beyond
     the template follow the last row 3 frames apart; the default string returns the template itself (identical
     pixels).
2. Each shot: `const TEMPLATE = segmentsOf(…)` (was `LINES`), the component takes `{headline?: string}` and computes
   `LINES = editableHeadline(headline, TEMPLATE)`, and `mgShot('MG07', MG07, {defaultProps: {headline:
   headlineText(TEMPLATE)}})`. Shade width/height follow the edited rows as before.
3. `jasper.mg.json`: the M2 `"*"` entry (runtime props `matte`, `bg`, `guides`) plus per shot
   `"texts": {"headline": {"label": "Headline", "multiline": true, "maxChars": 48|40|40|72, "maxLines": 2|2|1|3,
   "hint": "One row per line; *asterisks* mark the accent colour (#3E99F5)…"}}`, with safe boxes from the shot
   headers where they state one (MG07 `{x: 0, y: 810, width: 874, height: 270}` — clears her face and the
   monitor; MG19 `{x: 0, y: 886, width: 1920, height: 194}` — MG20's reserved band).

Results (dev stack engine 48630 / web 52630, appdir `/tmp/wp-m3-mgtext/appdir`):

- Import (project CLI bundle + metadata + schema): ~2 min under load; 38 compositions; MG07/10/19/25 expose
  `headline` (multiline, limits, box), the other shots none (empty `defaultProps`, runtime props only).
- MCP on the real project: `create_project` → `import_media timeline.mp4` → `add_clip` → `import_mg_bundle` →
  `add_composition MG07@389, MG10@604, MG25@1901` → `list_composition_texts` (value, default, limits, safe box,
  hint).
- Properties: typing a 62-character single row previews live in Plus Jakarta Sans (the bundle's font); applied, the
  editor shows "has 62 characters (designed for 48)", "runs off the frame (right by 58 px)" and "goes outside its
  safe area (1882×91 px in a 874×270 px box)" (screenshot `trailer-mg07-overflow-warnings.jpg`).
- On canvas: double-click on the caption → the editor sits on the caption in `jmg-…-Plus Jakarta Sans`, grows
  upwards; two rows with `*ha llegado.*` → Ctrl+Enter → one History entry; the caption re-renders with the accent
  lighting up; remaining warning "goes outside its safe area (892×169 px in a 874×270 px box)" — true: the accent
  row ends 18 px past the monitor line (screenshots `trailer-mg07-on-canvas-editor.jpg`, `trailer-mg07-applied.jpg`).
- Native export (MCP `start_export`, `master-prores-422hq`, frames 380–500, plan `native`, new master for the
  edited props) vs an independent reference — the trailer's own `remotion render MG07 --props '{"headline": …}'`
  (ProRes 4444) composited straight-alpha over `timeline.mp4` with ffmpeg: caption frames 99.05 % of values within
  3/255 (min frame 98.87 %), PSNR mean 45.1 dB / min 44.3 dB. Shifting the reference by ±1 frame drops the minimum
  to 85.4 % / 86.9 % (PSNR min 24.4 / 24.6 dB) → placement is frame-exact and the export shows the edited text.

## How to test

```bash
pnpm vitest run --project @jasper/project packages/project/test/composition-texts.test.ts
pnpm vitest run --project @jasper/compositions packages/compositions/test/text-probe.test.ts
pnpm vitest run --project @jasper/engine apps/engine/test/mg-bundles.test.ts          # manifest texts (unit)
MG_E2E=1 pnpm vitest run --project @jasper/engine apps/engine/test/mg-bundles.test.ts -t "hybrid text layers"
MG_E2E=1 MCP_MG_TEST_PORT=48632 pnpm vitest run --project @jasper/mcp apps/mcp/test/compositions.test.ts
E2E_PORT=48630 pnpm e2e e2e/mg-texts.spec.ts      # also e2e/mg-clips.spec.ts (fixture now has 3 compositions)
```

## Known gaps / deviations

- Layout warnings are measured in the editor (a browser page); MCP returns the static ones and agents check with
  `render_frame`. An engine-side measurement would need the headless page to load the bundle with the host
  bootstrap through authenticated, signed bundle URLs (a signed-prefix scheme), left for later.
- The on-canvas editor draws the raw prop value (e.g. `*accent*` markup, plain colour) in the text's font, size and
  first colour — it replaces the rendered text while editing, it is not the composition's own rendering; the
  composition shows the result on apply. Texts drawn on a canvas/SVG/WebGL (not DOM text) cannot be located: they
  stay editable in Properties.
- Matching is by characters: a composition that transforms the copy beyond case/whitespace/`*_~` (e.g. typewriter
  reveal mid-way, number formatting) is "not drawn" at frames where the shown text differs; the measuring frame
  (`texts.<path>.frame`) and Properties still work.
- A text editor needs the clip's live host: with more than 4 live hosts mounted (MGC-024 budget) the on-canvas
  editor reports that the composition did not render and points to Properties.
