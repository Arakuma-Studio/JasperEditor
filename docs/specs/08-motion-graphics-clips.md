# Spec 08: Motion graphics as editable clips (Remotion bundles)

Status: functional spec, v1 (2026-10-01), milestone M2. Audience: the implementers of `wp-m2-mg`.
Architecture contracts: `docs/ARCHITECTURE.md` §19.3 (bundles), §19.6 (native extensions), D-19 (Remotion pinned
to 4.0.499), D-26.

This spec is original work. The standalone Remotion project `MatsSmileTrailer/mg/` (kit + registry + render
scripts) was read as a record of what a real motion-graphics package looks like; nothing is copied.

---

## 0. How to read this spec

Requirement ids: `MGC-NNN` (model, import, render), `MGU-NNN` (UI), `MGA-NNN` (agents). Priorities as in S06.
"Bundle" = the output of `remotion bundle` (a static site whose page registers the project's compositions);
"composition" = one `<Composition>` in it; "composition clip" = a timeline clip of kind `composition`.

## 1. Goals

1. Bring an existing Remotion project (or a built bundle) into a JasperEditor project and place its compositions
   on the timeline as clips.
2. Edit a clip's props in the inspector, with a form derived from the composition's schema or default props, and
   see the result live in the Program monitor.
3. Export on the **native** path: each composition clip is pre-rendered once to a cached ProRes 4444 alpha master
   that ffmpeg overlays; the cache is invalidated when props or code change.
4. Agents do the same over MCP, including creating a new composition project from a template.

Non-goals (M2): an in-app code editor, animated (keyframed) props, audio from compositions (P2: rendered as a
separate audio intermediate), nested JasperEditor sequences inside compositions.

## 2. Model

- **MGC-001 (P0)** A bundle is a `MediaAsset` of kind **`mg-bundle`** (schema v3). `MediaAsset.mgBundle =
  {remotionVersion, bundleHash, builtAt, source: {type: 'project-dir'|'bundle-upload', path|null, name},
  compositions: MgCompositionInfo[]}`; `probe = EMPTY_PROBE`; the engine locator key is the bundle's media key.
  The engine stores the bundle as a managed directory `<appdir>/mg-bundles/<bundleHash>/` (content-addressed:
  `bundleHash = sha256` over the sorted relative paths and file contents).
- **MGC-002 (P0)** `MgCompositionInfo = {id, width, height, fps, durationInFrames, defaultProps, propsSchema
  (JSON Schema) | null, schemaSource: 'bundle'|'manifest'|'inferred'}`.
- **MGC-003 (P0)** A composition clip (`CompositionClipSchema`) stores `composition = {mediaId, id, version: 1}`,
  `props` = **overrides** over the composition's `defaultProps` (effective props = deep merge, arrays replaced),
  `canvas` = `'sequence'` or the composition size (default: the composition size; the clip is fitted to the
  frame by the default scaling rule), plus the usual visual fields (Motion, opacity, blend, effects — colour
  grading and corner pin apply to it like to any layer).
- **MGC-004 (P0)** Time: a composition clip is bounded content. Content time `t` (flicks) maps to composition
  frame `floor(t · compFps / FLICKS_PER_SECOND + ε)`; the clip cannot be trimmed beyond `durationInFrames`;
  handles exist inside that range (transitions work). Default placed duration = the composition duration in
  sequence frames.
- **MGC-005 (P0)** Frame-rate mismatch: renders and previews use the **sequence frame rate** by overriding the
  composition's `fps` (and scaling `durationInFrames`) when they differ. Compositions that derive timing from
  `useVideoConfig().fps` look the same; purely frame-counted animations play faster/slower — the clip shows a
  warning badge "Composition is 25 fps, sequence 30 fps" and the export plan a warning `MG_FPS_MISMATCH`.
- **MGC-006 (P0)** Props are **not** animatable in M2 (hold-only; the stopwatch is hidden). P2: keyframed props
  evaluated per frame.
- **MGC-007 (P0)** Command `clip.addComposition {composition: {mediaId, id, version?}, props?, canvas?, at, track,
  duration?, …placement}` (handler in `packages/project/src/commands/handlers/composition.ts`); props are edited
  with `clip.update {patch: {props}}` (whole override object) and `param.set` on `["clip", id, "props", …path]`
  (property keys `props.<dotted.path>`), both validated against `propsSchema` when present (`E_INVALID_PARAM`).
- **MGC-008 (P0)** The render snapshot source is `{composition: {mediaId, compositionId, props (effective),
  canvas}}` (already in `RenderVisualSource`); this package may add an optional `prerender?: {masterUrl,
  previewUrl}` filled by consumers that know a cached master (additive).

## 3. Import and bundles

- **MGC-010 (P0)** `POST /api/mg-bundles/import {path | uploadId, watch?, projectId?}` → `RegisteredMedia`
  (kind `mg-bundle`):
  - **Project directory** (local mode only, S04:SC-002): must contain a `package.json` depending on
    `remotion`/`@remotion/cli` **exactly 4.0.499** (D-19; anything else → `MG_REMOTION_VERSION` with the found
    version) and installed `node_modules`. The engine runs the project's own CLI
    `<dir>/node_modules/.bin/remotion bundle --out-dir <tmp>` (its `remotion.config.ts`, Tailwind, webpack
    overrides apply), with a 10 min timeout and the log kept on failure (`MG_BUNDLE_FAILED`).
  - **Built bundle directory** (local mode) or **zip upload** (web; uploads flow with `purpose: 'mg-bundle'`,
    additive field): must contain `index.html` and the bundle's JS; the Remotion version is read from the bundle
    (`window.remotion_version` via the metadata step) and must be 4.0.499.
- **MGC-011 (P0)** Metadata: `getCompositions(serveUrl, {binariesDirectory: LGPL dir, browserExecutable,
  chromiumOptions})` from `@remotion/renderer` 4.0.499 (the engine's own dependency) gives id, size, fps, duration,
  defaultProps. Remotion does not expose zod schemas as data, so `propsSchema` comes from, in order:
  1. **Manifest** `jasper.mg.json` in the project root (or bundle root):
     `{"compositions": {"<id>": {"propsSchema": {JSON Schema}, "ui"?: {"<prop>": {"control": "color"|"text"|
     "textarea"|"slider"|"asset", …}}, "category"?, "thumbnailFrame"?, "texts"? (MGC-036)}}}`.
  2. **Schema module** (project directories): `package.json` → `"jasper": {"schemas": "./src/jasper-schemas.ts"}`
     exporting `Record<compositionId, ZodType>`. The engine bundles that module for Node with esbuild (externals:
     `zod`), imports it in a child process, and converts: zod 4 → `z.toJSONSchema`, zod 3 (what Remotion's
     `schema` prop uses) → `zod-to-json-schema` (ISC). Failures fall back to 3 with a warning.
  3. **Inference** from `defaultProps`: string → text (multiline when > 80 chars or contains `\n`); `#rgb`,
     `#rrggbb(aa)`, `rgb()/rgba()` strings → colour; number → number (integer when all defaults are integers);
     boolean → toggle; array of primitives → list; object → nested group; strings ending in an image/video
     extension → asset path (P2 picker). Everything stays editable as JSON in an "Advanced" field.
- **MGC-012 (P0)** Serving: `GET /mg/bundles/:key/*` serves the bundle directory (immutable, Range, same auth as
  media, signed URLs for headless renders). `staticFile()` paths inside the bundle resolve under it.
- **MGC-013 (P0)** Watch (project directories, `watch: true`, desktop/dev): source changes (`src/`, `public/`,
  `remotion.config.*`, `jasper.mg.json`; debounce 1 s) rebuild the bundle (`mg-bundle` job). A successful rebuild
  yields a new `bundleHash` and media key; the engine publishes `mgBundle.rebuilt {oldKey, newKey, mgBundle}` and the
  open editor commits `media.relink` for the asset (new locator key, new `mgBundle` header — additive fields on
  `media.relink`) as a system transaction (no history entry, S01:UND-012). Pre-render caches keyed by the old
  hash are never reused (MGC-031). `POST /api/mg-bundles/:key/rebuild` triggers the same manually.
- **MGC-014 (P1)** Missing compositions after a rebuild: clips whose composition id disappeared render the
  "Media Offline"-style card "Composition <id> not in bundle" and block export with a clear blocker.
- **MGC-015 (P1)** **New composition project** (authoring): `POST /api/mg-bundles/scaffold {dir, name}` (local
  mode) copies a template project (`apps/engine/src/mg-bundles/template/`: Remotion 4.0.499, one example
  composition with a zod schema, `jasper.mg.json`, `jasper-schemas.ts`), runs `pnpm install` (or `npm install`)
  there, imports it with `watch: true`. Code is edited by the user or their coding agent outside the app.

## 4. Preview

- **MGC-020 (P0)** The composition layer (`packages/compositions/src/layers/CompositionLayer.tsx`) shows, in order
  of preference:
  1. the cached **preview** (VP9 alpha WebM, half resolution) of the clip's current render key, played like a
     media layer (exact timing, cheap) — when present;
  2. otherwise the **live frame host**: an `<iframe>` of the bundle page (`/mg/bundles/<key>/index.html`), sized to
     the composition, transformed like any layer (LayerBox), transparent background, `pointer-events: none`.
- **MGC-021 (P0)** The live frame host drives the bundle page through the page protocol `@remotion/renderer`
  4.0.499 uses (`remotion_setBundleMode` for the composition + input props, `remotion_setFrame`,
  `remotion_renderReady`, delay-render handling). The protocol is wrapped in one adapter module
  (`packages/compositions/src/mg-host/protocol.ts`) with a contract test (Playwright, against a fixture bundle)
  so a Remotion upgrade fails loudly (D-19). The implementer reads the protocol from the public
  `@remotion/renderer` package source, not from any template.
- **MGC-022 (P0)** Sync: paused → the host renders exactly the playhead frame (the Program monitor shows a subtle
  "rendering" spinner until ready); playing → the host renders as fast as it can and the layer shows the latest
  ready frame (frames may drop; preview only). Props edits are applied within 300 ms (debounced 100 ms).
- **MGC-023 (P0)** After props stop changing for 2 s, the client requests a preview pre-render (MGC-030,
  `quality: 'preview'`); when it lands the layer switches to it without a visual jump (same frame shown).
- **MGC-025 (P0)** Effects on composition clips: CSS/SVG effects and Motion apply to the live host element; colour
  effects (S06) and other pixel-reading stages cannot read a cross-document iframe, so they apply only once the
  preview WebM is available (the layer shows a "Grade pending" chip meanwhile). A clip with colour effects gets its
  preview pre-render requested immediately (no 2 s debounce).
- **MGC-024 (P1)** At most 4 live hosts are mounted at once (clips nearest the playhead); others show their
  preview or poster.

## 5. Pre-render and export

- **MGC-030 (P0)** `POST /api/mg-bundles/prerender {mediaKey, compositionId, props (effective), width, height, fps,
  startFrame, durationFrames, quality}` → `mg-prerender` job (lane `user`, 4 CPU slots, dedupe by render key) with
  result `{renderKey, masterUrl, previewUrl}`. It calls `renderMedia` (LGPL `binariesDirectory`, D-13) with the
  composition overridden to `{width, height, fps, durationInFrames}` and `frameRange` =
  `[startFrame, startFrame + durationFrames − 1]`:
  - `master`: `codec: 'prores', proResProfile: '4444', pixelFormat: 'yuva444p10le', imageFormat: 'png'`,
    muted; then a lossless re-mux adding BT.709 tags (Remotion leaves them unset); straight alpha verified by the
    test suite (compositing over four flat colours);
  - `preview`: VP9 `yuva420p` at half size, CRF 32, `-row-mt 1`.
  Output under `<appdir>/mg/<renderKey>/{master.mov, preview.webm, poster.png}` (the M1 `/mg/:key/:file` route
  serves them).
- **MGC-031 (P0)** `renderKey = sha256(canonicalJson({bundleHash, compositionId, props, width, height, fps,
  startFrame, durationFrames, renderer: '4.0.499', recipe: 1}))`. Changing props, bundle code (hash), size, fps or
  range produces a new key; nothing is invalidated in place. A GC job removes render directories unused for 14 days.
- **MGC-032 (P0)** Native path: the `mg` native extension declares `kinds: {'composition'}`; its `prepare` computes
  the render key of every composition clip in the export (range = the clip's drawn span including transition
  handles, converted to composition frames) and runs missing masters as child jobs of the export ("Rendering
  compositions 2/5"); `override` returns `{path: master.mov, space: 'layer', startFrame: clip.start −
  headHandle}`. Effects, Motion, opacity and fades are then applied by the builder as for any layer.
- **MGC-033 (P0)** Remotion path: the composition layer, in renders (`isPreview: false`), plays the master through
  `<OffthreadVideo transparent>`; the Remotion export runs the same `prepare` step before rendering and passes
  `prerender.masterUrl` (signed) in the snapshot.
- **MGC-034 (P0)** Blockers: `mgBundles.status: 'unavailable'` (no Remotion renderer/browser) → composition clips
  block the native path with "composition clips need the Remotion renderer to pre-render" (the Remotion path would
  fail too; the plan reports it).
- **MGC-035 (P1) Hybrid text layers** — two halves:
  1. *Native text clips* (the original statement): the native path keeps sequences with titles native by
     pre-rendering each `text` clip through JasperEditor's own composition (`layerFilter: [clipId]`,
     `transparentBackground`) to a sequence-space ProRes 4444 intermediate (`override.space = 'sequence',
     includesFades: true`), keyed by the clip's snapshot JSON + fonts + bundle identity. **Delivered by the layer
     bake (S11 §6, LBK-001…LBK-026, extension `layer-bake`, plan path `hybrid`)**, which claims every DOM layer
     (text, shape, anime templates) instead of the `mg` extension; acceptance test 8 is covered by
     `apps/engine/test/layer-bake.e2e.test.ts` (text frames ≥ 99 % within 3/255 of the Remotion render).
  2. *Texts inside composition clips* (M3, wp-m3-mgtext): MGC-036…039 below.
- **MGC-036 (P1) Text layers of a composition.** A composition exposes as *text layers* the string props (any
  depth, dotted paths) that are, in this order: declared in the manifest `compositions.<id>.texts.<prop.path>`
  (`{label?, multiline?, maxChars?, maxLines?, box?: {x, y, width, height}, frame?, hint?, style?: {<role>:
  <prop.path>}}`; `false` hides a string; the `"*"` entry merges entry by entry); annotated `"x-jasper-text": true |
  {…same fields}` in the JSON Schema (zod 4: `.meta({'x-jasper-text': …})`); hinted `ui.<path>.control: "text" |
  "textarea"`; or plain strings (no enum/pattern/format/const, not a colour or asset, not named like a URL, id,
  font, mode, variant, alignment, colour…). Style props are linked per role (`fontFamily`, `fontSize`,
  `fontWeight`, `italic`, `color`, `align`, `lineHeight`, `letterSpacing`) by the manifest `style`, else by
  convention: a *text object* (`{headline: {text, color, fontSize|size, fontFamily|font, fontWeight|weight,
  align|textAlign, …}}`, labelled by the object) or *prefixed siblings* (`title` + `titleColor`, `titleFontSize` /
  `titleSize`, `titleFont` / `titleFontFamily`, `titleWeight`, `titleAlign`, `titleItalic`, `titleLineHeight`,
  `titleLetterSpacing`, also `title_color`). A linked prop must fit its role (colour control, number, enum…).
  `MgCompositionInfo.texts` (additive) carries the manifest declarations; `compositionTextLayers(info)` is the
  shared, pure discovery (`packages/project/src/composition/texts.ts`).
- **MGC-037 (P1) Checks.** Errors (edit refused): the props schema (`maxLength`, `minLength`, type). Warnings
  (allowed): more characters than `maxChars`, more rows than `maxLines`, a line break in a single-line text, and
  layout measured in the bundle's own page at the text's `frame` (manifest, else the composition's
  `thumbnailFrame`, else the middle): the text **runs off the frame**, is **cut off by its box** (an ancestor with
  `overflow` ≠ visible), shows an **ellipsis**, **leaves its safe area** (`box`), or **wraps to more lines** than
  `maxLines`. A text not drawn at that frame is reported as not checkable (info). The page's *text probe*
  (`packages/compositions/src/mg-host/text-probe.ts`, installed by the host bootstrap) locates a prop's text by
  its characters — whitespace, case and `*_~` markup ignored, so copy split across spans and rows still matches.
- **MGC-038 (P1) Edits.** A text edit is `param.set` on `["clip", id, "props", …path]`; a text with style changes
  (on-canvas editor, MCP) is one `clip.update {props}` built by `overridesWithEdits` — either way one History
  step. Edits change the effective props, hence the render key (MGC-031): the cached preview and master no longer
  match, the next export renders a new master and shows the new text (§8 test 9).
- **MGC-039 (P1) Bundle fonts.** The host bootstrap records the faces a bundle registers (`new FontFace(…)`,
  `@remotion/fonts`, `@font-face`). The editor adds them to its own document under a per-bundle alias so the
  on-canvas editor draws in the composition's font, and font menus of text layers list the bundle's families
  (they render identically on every export path, which uses the same bundle).

## 6. User interface

- **MGU-001 (P0)** Import: File ▸ Import Remotion Project… (desktop: folder picker; web: zip upload of a built
  bundle), Project panel drop of a folder containing `package.json` + `remotion` (desktop), and the Motion
  Templates panel "Remotion" tab.
- **MGU-002 (P0)** Motion Templates panel, "Remotion" tab: bundles of the project, each with its compositions
  (poster at `thumbnailFrame` or frame 0, size, duration); drag to the timeline or double-click (insert at the
  playhead on the targeted track) → `clip.addComposition`.
- **MGU-003 (P0)** Properties section "Composition" (`clipSections`): bundle name + composition id, status
  (live / preview ready / rendering master n %), the props form generated from `propsSchema` (reusing the
  JSON-Schema → property-spec code of M1 motion-graphic params, generalised to nested objects and arrays),
  "Reset to defaults", "Edit as JSON", "Rebuild bundle" (project directories), "Render master now".
- **MGU-004 (P0)** Timeline: composition clips use the graphics label colour and an "R" engine badge that turns
  into a check mark when the master for the current props is cached.
- **MGU-005 (P1, was P2; wp-m3-mgtext)** Program monitor: **double-click** a composition clip's text (selection
  tool) — or **Edit on canvas** next to a text in Properties — opens an in-place editor: the clip shows its live
  frame host (not the cached preview), the text under the pointer is located in the page and hidden, and a field
  in the same box, size, weight, colour, alignment and bundle font takes its place, mapped through the layer's
  Motion and corner pin. Texts in the lower half grow upwards. Enter (single-line) / Ctrl+Enter (multi-line) or a
  click elsewhere applies (one History step "Edit Text «label»"; schema errors are shown and keep the editor
  open), Esc cancels; playback, a deleted clip or a playhead outside the clip closes it. From Properties the
  playhead moves into the clip (the text's `frame`). Where no text is under the pointer, a note points to
  Properties and its field takes the focus. Extension point: `layerDoubleClickHandlers` (web).
- **MGU-006 (P1, wp-m3-mgtext)** Properties ▸ Composition ▸ **Text** (above the remaining props): per text a
  label, a character counter (`n/maxChars`, else `n/maxLength`; amber/red when over), Edit on canvas, Reset; a
  multi-line field (single-line input for single-line texts) that previews live while typing (one gesture →
  one History step on Enter / Ctrl+Enter / leaving the field; Esc reverts; invalid values never reach the preview
  and are not applied); its style props (Font = the bundle's families or the schema's enum, Weight 100–900, Size,
  Colour, Align buttons, Italic, Leading, Tracking); the static and measured warnings (MGC-037) and the manifest
  `hint`. The generic form lists only the props no text editor owns.

## 7. Agents (MGA)

- **MGA-001 (P0)** MCP tools (`apps/mcp/src/tools/compositions.ts`):
  - `import_mg_bundle {projectId, path, watch?}` → `{mediaId, compositions: [{id, size, fps, duration, props
    schema summary}]}`;
  - `list_compositions {projectId, mediaId?}`;
  - `add_composition {projectId, mediaId, compositionId, at, track?, duration?, props?}`;
  - `set_composition_props {projectId, clipId, props, mode?: 'merge'|'replace'}`;
  - `prerender_composition {projectId, clipId, quality?}` (job);
  - `scaffold_mg_project {dir, name}` (P1, local mode).
  `render_frame` renders composition clips through the same pre-render (native still) path.
- **MGA-003 (P1, wp-m3-mgtext)** `list_composition_texts {projectId, clipId}` → texts with path, label, value,
  default, limits, safe box, hint and style props (prop, value, type, options, range) plus static warnings;
  `set_composition_text {projectId, clipId, texts: [{text: path|label, value?, style?: {fontFamily, fontSize,
  fontWeight, italic, color, align, lineHeight, letterSpacing}}]}` → one transaction (one undo step), schema
  errors as `E_INVALID_PARAM`, unknown texts `E_NOT_FOUND` with the list, unexposed style roles
  `E_INVALID_PARAM` with the exposed ones. `list_compositions` lists each composition's texts. Layout warnings are
  measured in the editor only (agents check with `render_frame`).
- **MGA-002 (P0)** Errors carry actionable hints (`MG_REMOTION_VERSION`: "the project uses remotion X; JasperEditor
  needs 4.0.499 — pin it in package.json and reinstall").

## 8. Acceptance tests

1. **Fixture**: `fixtures/mg-project/` — a minimal Remotion 4.0.499 project (made a private workspace package so
   pnpm links its dependencies) with two compositions: `Title` (zod schema via `jasper-schemas.ts`: title string,
   accent colour, delay number) and `Badge` (no schema: inferred from defaultProps), transparent backgrounds.
2. **Import**: importing the directory registers an `mg-bundle` asset with both compositions, `Title.propsSchema`
   from the schema module, `Badge` inferred; a project pinned to another Remotion version fails with
   `MG_REMOTION_VERSION`; a zip of the built bundle imports on the web path.
3. **Commands**: `clip.addComposition` places a 90-frame clip; `param.set props.title` validates against the
   schema (a number is rejected); undo/redo; invariants.
4. **Preview** (Playwright): the Program monitor shows the live host frame for the playhead; editing `title` in
   Properties updates the Program monitor within 500 ms; after 2 s idle the layer switches to the preview WebM;
   the protocol contract test passes.
5. **Export**: a sequence with footage + a `Title` clip plans `native`; the first export renders one master
   (child job visible) and the output frame at the title's midpoint matches a direct Remotion still of the same
   props within 3/255 on 99 % of pixels; a second export renders no master (cache hit); changing a prop, or
   rebuilding the bundle after editing its source, renders a new master.
6. **Alpha**: the master composited over red/green/blue/white equals the premultiplied expectation (straight
   alpha, no dark fringes beyond 2/255).
7. **MCP**: `import_mg_bundle` → `add_composition` → `set_composition_props` → `render_frame` on the fixture
   produces the edited title; the history shows agent entries.
8. **Hybrid text (P1)**: a sequence with footage + text plans `native` when the extension claims text; the text
   frame matches the Remotion render within 3/255. (Covered by the layer bake, S11 §6: path `hybrid`.)
9. **Texts in compositions (P1, wp-m3-mgtext)**: the fixture's `LowerThird` (text object `name`, prefixed `role`
   style props, manifest `texts` with limits and a safe box, Inter Bold embedded in the bundle) lists three
   texts with their style roles; editing the name text + colour + size and the quote as one step renders a new
   master and the native export frame at the hold matches a direct Remotion still of the edited props within
   3/255 on 99 % of the frame, frame-exact during the entrance (±1 frame fails), drawn with the embedded font;
   the Properties editor previews while typing and commits one History entry; a double-click on the quote in the
   Program monitor edits it in place in the bundle font; long text shows the off-frame / cut-off / safe-area
   warnings; MCP `list_composition_texts` → `set_composition_text` → `render_frame` changes the frame and one
   `undo` restores text and style.
