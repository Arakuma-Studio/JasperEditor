# Spec 11: In-video animation (anime.js), text animators, animated templates, layer bake, shapes

Status: functional spec, v1 (2026-10-01), milestone M2. Audience: the implementers of `wp-m2-anime-contracts`,
`wp-m2-anime-core`, `wp-m2-text-anim`, `wp-m2-anime-templates`, `wp-m2-layer-bake` and `wp-m2-shapes`.
Architecture contracts: `docs/ARCHITECTURE.md` D-31, D-32 and §20. Research: `docs/research/animejs-v4-notes.md`.
Related specs: S01 (KND-006 text, KND-009 motion graphic, §21 agents), S03 (§5.6 shapes KND-055, KND-065, TXT-020,
XF-061, ECP), S05 (MGT-001, PRP-001, ECP-008), S08 (MGC-035 hybrid text layers, MGC-025), S10 (transitions).

This spec is original work. anime.js is used through its public npm package and documentation only; the
clean-room rule (ARCHITECTURE §0) is unchanged.

---

## 0. How to read this spec

Requirement ids: `ANM-` (runtime and determinism), `TXA-` (text animators), `ATP-` (anime templates), `LBK-`
(layer bake = native export of DOM layers), `SHP-` (shapes), `FIX-` (pre-existing defects fixed in this
delivery), `ANA-` (agents / MCP). Priorities: **P0** must, **P1** should, **P2** later. **This delivery implements
every P0 and P1 requirement**; P2 items are recorded for later and must not be stubbed in the UI.

Terms:
- *DOM layer*: a layer whose pixels come from React/DOM inside the Remotion composition (text, shape, anime
  template). It has no native ffmpeg rendering; natively it is exported through a baked master (LBK).
- *Unit*: one animated piece of a text: a grapheme (`char`), a word (`word`) or a laid-out line (`line`).
- *Window*: the frames of a clip during which an animator runs (`in` = first `durationFrames` visible frames,
  `out` = last `durationFrames` visible frames).
- *Seek time*: milliseconds passed to anime.js for a frame, always `frame * 1000 / fps` with an integer frame.
- *Master*: a ProRes 4444 (`yuva444p10le`, straight alpha, bt709 tags) or PNG file produced by the engine.

## 1. Goals and non-goals

Goals:
1. Animated titles inside the video: in/out animators on ordinary text clips (per char/word/line).
2. A first catalogue of animated motion-graphic templates (title reveal, lower third, callout, counter) that use
   anime.js and behave like the existing templates (gallery, Properties form, agents).
3. Rectangles and ellipses (`shape` clips), with the Shape tools and the Graphics menu entries that are dead today.
4. Exports stay native: every DOM layer (all text, shapes, anime templates) is pre-rendered to a cached master and
   overlaid by the native builder (S08:MGC-035 generalised). This is the user's decision "option A": **all text is
   baked**, animated or not.
5. Frame determinism: Player preview, `renderStill`, `renderMedia` at any concurrency and frame order, and the
   native export agree.
6. Fix the pre-existing defects listed in §9.

Non-goals (this delivery): anime.js in the editor chrome (R-PUI motion rule); anime.js in fframes templates, the
TS SVG twins or model transitions (transitions stay pure progress functions, S10); caption animation (captions core
does not exist yet, `E_NOT_IMPLEMENTED`); polygon/star/line/pen shapes (S03 KND-055 P1 items → P2 here); agent-
authored animation timelines (JSON "AnimSpec", M3); on-canvas text editing (TXT-010…012, separate package).

## 2. Determinism contract (ANM-001…020)

- **ANM-001 (P0)** anime.js is only used through `@jasper/motion` (§3). No other package imports `animejs`.
- **ANM-002 (P0)** Timelines are created with `autoplay: false` (`createPausedTimeline`) and are only ever moved
  with `seekCanonical(tl, ms)` = `tl.seek(tl.duration, true); tl.seek(0, true); tl.seek(ms, true)`. Plain `seek`
  is history-dependent in 4.5.0 (research §1: 259/300 random timelines differ by visit order; 0/300 with the
  canonical seek).
- **ANM-003 (P0)** Seek time = `frame * 1000 / fps` with an integer frame; never wall-clock time, `Date`, rAF,
  `performance.now`, timers or callbacks. Callbacks are muted (`seek(…, true)`).
- **ANM-004 (P0) Value engine first.** Text animators and templates animate **plain JS objects** (one per unit or
  element: `{opacity, x, y, scale, rotate, blur, reveal, …}`); React renders inline styles from the seeked values
  (D-14 inline styles). anime.js never writes into DOM nodes owned by React.
- **ANM-005 (P0) DOM leaves.** Only SVG features that need real geometry (`createDrawable`, `morphTo`,
  `createMotionPath`) may target DOM, and only inside a ref-owned leaf element that React renders without children
  or with static children, through `useAnimeDom` (built in `useLayoutEffect`, scoped with `createScope({root})`,
  reverted on cleanup; StrictMode-safe). Explicit `[from, to]` values only.
- **ANM-006 (P0) Banned APIs** (enforced by a lint rule over `packages/motion/**` and `packages/compositions/**`,
  ANM-012): `animate()` (autoplaying), `createTimer`, `.play()/.resume()/.restart()/.reverse()`, `autoplay: true`,
  `animejs/waapi`, `animejs/events`, `animejs/draggable`, `animejs/layout`, `animejs/scope` outside the runtime,
  `onScroll`, `createAnimatable`, `utils.random/randomPick/shuffle`, `easings/irregular`, `scrambleText`,
  `splitText`, `frameRate`, `composition: 'blend'`, `loop` on children, `.set()` and `.call()` in timelines,
  `engine.*` writes, `Math.random`, `Date.now`, `performance.now`.
- **ANM-007 (P0) Randomness** only through `seededRandom(seed)` / `stagger(…, {seed})` with
  `seed = hash32(clipId, <purpose>)`.
- **ANM-008 (P0) One live timeline per (target, property).** Builds never share targets; stagger and spring
  instances are created inside the build.
- **ANM-009 (P0) Rest state.** At seek times outside every window the output equals the un-animated layer (text:
  the same DOM as a text clip without animation; templates: their hold state).
- **ANM-010 (P0) Fonts.** No unit split, measurement or timeline build happens before the layer's font faces are
  loaded (FIX-003). Line grouping measures with `offsetTop`/`offsetHeight` (layout boxes), never
  `getBoundingClientRect` (ancestor transforms: rotation, flip, corner pin, monitor zoom).
- **ANM-011 (P0) Pin.** `animejs` is pinned exactly (`4.5.0`) in `packages/motion/package.json`; its version is part
  of every render key (LBK-020) and of the Remotion bundle hash (§10). Upgrading is one dedicated change that
  re-runs the determinism suite (like D-19).
- **ANM-012 (P0) Lint guard.** `scripts/check-anime.mjs` (wired into `pnpm lint`) fails on ANM-006 patterns under
  `packages/motion/src` and `packages/compositions/src`, with an allow comment `anime-allow: <reason>` for the
  runtime's own internal uses. Biome `noRestrictedImports` mirrors the import bans.
- **ANM-013 (P0) Determinism suite** (`packages/motion/test/determinism.test.ts`, node + happy-dom): for every text
  preset and every anime template, values at frames 0…N visited in order, reversed and shuffled (fast-check, fixed
  seeds) are identical, and identical to a fresh build per frame.
- **ANM-014 (P0) Render parity** (`REMOTION_E2E=1`): a fixture sequence with an animated title, an anime template
  and a shape renders byte-identical PNG frames with `renderStill` frame by frame, `renderMedia` concurrency 1 vs 4,
  and frames rendered in reverse; the Player frame matches `renderStill` (≤ 3/255 on 99.5 % of pixels).
- **ANM-015 (P1) Performance.** A 200-unit animated title computes its values in ≤ 2 ms per frame on this box
  (Chrome); static clips still return identical resolved objects (S03:ARC-011).
- **ANM-016 (P1)** The scaffolded Remotion project (S08:MGC-015, `apps/engine/src/mg-bundles/template/files.ts`)
  contains an anime.js example composition that follows this contract (seek-only, canonical seek) and a README
  paragraph explaining the rule for bundle authors.

## 3. `@jasper/motion` package (ANM-020…030)

- **ANM-020 (P0)** New workspace package `packages/motion` (`@jasper/motion`). Dependencies: `animejs` `4.5.0`
  (exact), `@jasper/project`, `@jasper/mg-templates`, `remotion` `4.0.499`; peer `react`. Exports:
  - `"."` → `src/runtime/index.ts` (runtime, owned by `wp-m2-anime-core`);
  - `"./text"` → `src/text/index.ts` (text animator implementations, owned by `wp-m2-text-anim`);
  - `"./templates"` → `src/templates/index.ts` (anime template implementations, owned by `wp-m2-anime-templates`).
- **ANM-021 (P0) Runtime API** (contract; signatures fixed by §20.2 of ARCHITECTURE):
  `createPausedTimeline(params?)`, `seekCanonical(tl, ms)`, `frameToMs(frame, fps)`, `hash32(...parts)`,
  `seededRandom(seed)`, `useAnimeValues(buildKey, build, ms)` (value engine: builds in `useMemo` on plain objects,
  seeks synchronously during render, returns a frozen copy of the values), `useAnimeDom(ref, buildKey, build, ms,
  ready)` (DOM leaves), `segmentText(text, unit, locale?)` (graphemes/words with `Intl.Segmenter`; whitespace kept
  as separate non-animated segments), `groupLines(container)` (word spans → line indices by `offsetTop`),
  `EASES` (closed list of allowed ease names → anime ease strings).
- **ANM-022 (P0) Dependency rule.** `motion → animejs, remotion, project, mg-templates (react peer)`;
  `compositions → … motion`. The engine, MCP, `@jasper/project` and `@jasper/mg-templates` never import
  `@jasper/motion` (the engine only bundles compositions). The web app reaches it through compositions.
- **ANM-023 (P0) Web bundle.** Vite `manualChunks` puts `animejs` in `vendor-anime`; imports use subpaths
  (`animejs/timeline`, `animejs/utils`, `animejs/svg`, `animejs/easings`) except the runtime's own index.

## 4. Text animators (TXA-001…040)

### 4.1 Model

- **TXA-001 (P0)** `TextClip.textAnimation?: {in?: TextAnimator | null; out?: TextAnimator | null}` with
  `TextAnimator = {preset: string; version: int; durationFrames: int ≥ 1; params: Record<string, unknown>}`
  (`schema/sequence.ts`, loose objects; schema v4, §20.1).
- **TXA-002 (P0) Catalogue** (pure data, `packages/project/src/text-animations.ts`): `TEXT_ANIMATION_SPECS:
  readonly TextAnimationSpec[]` with `{id, version, label, category, phases: ('in'|'out')[], paramsSchema (strict
  zod, every field defaulted), defaults, defaultDurationFrames (at 30 fps; scaled to the sequence fps on apply),
  description}`; `getTextAnimationSpec(id, version)`. Implementations live in `@jasper/motion/text`, keyed
  `id@version`; a test asserts both lists match.
- **TXA-003 (P0) First catalogue** (each usable as in and out; out plays the mirrored motion):
  `fade`, `slide-up`, `slide-down`, `slide-left`, `slide-right`, `pop` (scale with overshoot, spring ease),
  `blur` (blur + opacity), `typewriter` (step reveal per char, optional caret), `tracking` (letter-spacing
  expand/collapse + opacity), `mask-reveal` (per line, units rise from behind a line mask), `rotate-in`
  (per unit rotate + opacity), `drop` (from above with bounce ease). Common params where meaningful:
  `unit: 'char'|'word'|'line'` (preset default), `stagger: 0…1` (fraction of the window spread across units; 0 =
  all together), `order: 'forward'|'backward'|'center'|'edges'|'random'` (random uses the clip seed), `ease`
  (enum of `EASES`), `distance` (px in the text box space, slides/drop), `blur` (px), `scale` (start scale).
- **TXA-004 (P0) Anchoring.** Windows anchor to the clip's visible edges (clip time = `localFrame`), not to content
  time. `in` covers frames `[0, in.durationFrames)`, `out` covers `[duration − out.durationFrames, duration)`.
  If `in + out > duration` both are scaled proportionally at render time (no invariant failure) and the command
  that caused it returns warning `W_ANIMATION_COMPRESSED`. With both sides set, at least one frame stays at rest:
  they are scaled to share `duration − 1` frames whenever `in + out ≥ duration` (a 2-frame clip keeps only the
  longer side, a 1-frame clip drops both and shows the rest state). In transition handles (`localFrame < 0` or
  `≥ duration`) the animator clamps to its start/end state.
- **TXA-005 (P0) Edits.** Razor/split: the left part keeps `in` and drops `out`; the right part keeps `out` and drops
  `in`. Duplicate/paste/paste attributes copy `textAnimation`. Trims keep the anchoring (durations unchanged).
  Sequence frame-rate change remaps `durationFrames` (round, ≥ 1) next to the transitions remap.
- **TXA-006 (P0) Commands.** `clip.addText` gains optional `textAnimation`. `clip.update` patch gains
  `textAnimation`: `null` removes it; for each side `null` removes the side, an object with `preset` replaces the
  side (params reset to that preset's defaults, then merged with the given params; `durationFrames` defaults to the
  preset default scaled to the sequence fps), an object without `preset` merges into the current side. Validation:
  unknown preset → `E_UNKNOWN_EFFECT`; bad params → `E_INVALID_PARAM` with the path; preset that does not support
  the side → `E_INVALID_PARAM`. `clipIds` lists apply to many clips in one transaction. No relayout.
- **TXA-007 (P0) Properties.** New property group `textAnimation`: static keys `textAnimation.in.preset`,
  `textAnimation.out.preset` (enum incl. `none`), `textAnimation.{in,out}.durationFrames` (number, frames, scrubby);
  dynamic keys `textAnimation.{in,out}.params.<name>` from the chosen preset's schema (`jsonSchemaPropertySpecs`).
  `resolvePropertySpec`, `propertiesForClip`, `clipPropertiesJsonSchema` become clip-aware for these keys.
  All entries `animatable: 'no'` (S08:MGC-006 precedent). `param.set` targets them (whole-params validation).
- **TXA-008 (P0) Invariants.** `durationFrames` integer ≥ 1; known presets validate their params (repair to
  defaults, INV-012 style); unknown presets are preserved and skipped with a snapshot warning.
- **TXA-009 (P0) Snapshot.** The text variant of `RenderVisualSource` carries `animation?: {in?, out?: {preset,
  version, params (defaults merged), frames (after compression)}}`; text clips with an animation are frame-dependent
  in the composition (§20.4 `isFrameDependent`).

### 4.2 Rendering (compositions + `@jasper/motion/text`)

- **TXA-010 (P0)** `TextLayer` renders exactly as today at rest (ANM-009). Inside a window it renders the same text
  block split into unit spans (`display: inline-block` for transformed units, whitespace kept as text), with each
  unit's style computed from the seeked values. Styled `runs` keep their style per unit; `allCaps` is applied
  before segmentation; RTL and scripts that need shaping (Arabic, Hebrew, Indic, Thai…) fall back from `char` to
  `word` units automatically.
- **TXA-011 (P0) Lines.** `line` units (and `mask-reveal`) group word spans by `offsetTop` after layout in a layout
  effect with a synchronous state update (no paint in between); the grouping key includes text, style, box and
  fonts.
- **TXA-012 (P0)** Units may move outside the text box; layers never clip to the box (except `mask-reveal`'s own
  per-line masks).
- **TXA-013 (P1)** Glyph shift at the window boundary (split spans → plain block) ≤ 1 px at 1080p for Latin text.

### 4.3 UI

- **TXA-020 (P0) Text Animations tab** in the Motion Templates panel: 16:9 cards ("Aa Title" sample) with category
  chips (In, Out, Fade, Slide, Pop, Typewriter, Reveal…), search, a static poster and an animated hover preview
  (`PreviewThumb`, one shared Player, reduced-motion → static). Double-click/Enter applies the preset to the
  selected text clips (in by default; the card menu offers Apply as In / Apply as Out); drag onto a text clip in
  the timeline or Program applies it (MIME `application/x-jasper-text-anim`, drop side chosen by the drop position:
  first half = in, second half = out).
- **TXA-021 (P0) Properties ▸ Text Animation** section (registered through `clipSections`) for text clips: for In and
  Out, a preset picker (popover grid of small looping previews, "None" first), Duration (frames, scrubby, timecode
  tooltip), and the preset's params form; reset per side. Multi-selection edits all selected text clips.
- **TXA-022 (P0) Effect Controls.** A "Text Animation" section after Motion/Opacity with the same rows, and In/Out
  range bars drawn at the head and tail of the mini-timeline clip bar; dragging a bar's inner edge changes the
  duration (one undo step per gesture).
- **TXA-023 (P1) Timeline.** Animated text clips show head/tail wedges (like fade handles, no gesture).
- **TXA-024 (P0) Commands and menus.** `text.applyAnimation {clipIds, side: 'in'|'out'|'both', preset, version?,
  durationFrames?, params?}` (agent-exposed) and `text.removeAnimation {clipIds, side}`; Graphics menu ▸ Text
  Animation ▸ Apply In…, Apply Out…, Remove; clip context menu submenu (via `clipMenuExtensions`). No default key
  bindings.

## 5. Anime templates (ATP-001…030)

- **ATP-001 (P0) Same kind.** Anime templates are `motion-graphic` templates with `renderer: 'anime'`. The template
  catalogue (`@jasper/mg-templates`) holds their **metadata** only (`MgAnimeTemplateDefinition`: id, version, name,
  category, description, paramsSchema, defaults, intro/outro frames, default duration, canvases, `renderVersion`,
  `posterAt`). Their React implementations live in `@jasper/motion/templates`, keyed `id@version`; a test asserts
  every anime catalogue entry has an implementation and vice versa.
- **ATP-002 (P0) Clip.** `clip.addMotionGraphic` stamps `template.renderer` (`'anime'`) on the clip from the
  registry; absent = fframes. An invariant repairs a stamp that contradicts a known registry entry. The snapshot's
  `mg` source carries `renderer`; `clipEngines(clip)` (kinds.ts) gives `{preview: 'remotion', export: 'remotion',
  badge: 'R'}` for anime templates.
- **ATP-003 (P0) First catalogue**: `title-reveal@1` (char-staggered title + subtitle, underline draw-on),
  `lower-third-anim@1` (bar wipe, name/role word stagger, outro reverse), `callout@1` (target dot, leader line
  draw-on with `createDrawable`, label box, motion path option), `counter@1` (number count-up with format, prefix/
  suffix, decimals, thousands separator; tabular numerals). Canvases 16:9, 9:16, 1:1; design pixels fitted with
  `fitCanvas`. Params follow the existing conventions (strict zod, RGBA 0…1 tuples, vec2 arrays, string `.max`).
- **ATP-004 (P0) Timing.** Responsive time like fframes templates (S01:KND-009): the intro is anchored to content
  time 0, the outro to the content end (`sourceIn + duration`), the hold stretches. Seek time = content frame →
  ms (ANM-003).
- **ATP-005 (P0) Layer.** `MotionGraphicLayer` dispatches on `renderer`; both renderers render through `LayerBox`
  (FIX-001), so Motion, corner pin, opacity, blend (incl. `add`) and effects apply. The anime branch mounts the
  implementation with `{params, timeMs, totalMs, introMs, outroMs, fps, canvas, seed, isPreview}`.
- **ATP-006 (P1) Keyframable params.** Numeric and colour params of anime templates are keyframable (stopwatch in
  Effect Controls, ECP-008); keyframes are stored per param and evaluated per frame by the shared evaluator
  (S01:KF-009) before being passed as props. `clipAnimatables` and keyframe commands find keyframes on these
  dynamic keys. fframes template params stay static (their masters are rendered by `jasper-mg`).
- **ATP-007 (P0) Gallery.** The Motion Templates panel shows anime templates in the Templates tab with engine badge
  "R" and label "anime · Remotion", an engine filter value `anime`, and posters/hover previews through
  `PreviewThumb` (fframes cards keep the SVG poster but gain the hover preview). Insert/drag/double-click work as for
  fframes templates.
- **ATP-008 (P0) Engine routing.** The engine template catalogue (`GET /api/motion-graphics/templates`) lists anime
  templates with `renderer: 'anime'`, `native: false`; `requestRender` / `POST /api/motion-graphics/render` refuse
  anime templates with a clear error (they are baked by LBK); `mg.rerender` and fframes-only UI actions are hidden
  for them; `collectMgMasters` skips them; the planner sends them to LBK.
- **ATP-009 (P0) Template versions (FIX-005).** `MgTemplateDefinition.upgrades?: {fromVersion, migrate(params)}[]`;
  the registry exposes `upgrade(id, fromVersion, params) → {version, params} | null`; Properties shows "Update
  template to vN" when an upgrade exists (one undo step, command `clip.update {template: {version}}` validated);
  agents get it through `clip.update`.
- **ATP-010 (P0) Unknown templates.** A motion-graphic clip whose template is not in the registry draws the
  placeholder card in preview (as today) and **blocks every export path** with "template id@vN is not installed"
  (today the placeholder card is exported silently).

## 6. Layer bake: native export of DOM layers (LBK-001…040)

- **LBK-001 (P0) Extension.** A `NativeExtension` `layer-bake` (`apps/engine/src/layer-bake/**`, route plugin
  `routes/layer-bake.ts`, registered after `mg-bundles` and before `tracking`) with `kinds: {'text', 'shape'}`,
  `claimsLayer(c)` true for `text`, `shape` and `motion-graphic` clips with `renderer: 'anime'`. Every text clip is
  claimed, animated or not (option A).
- **LBK-002 (P0) Planner.** With the extension registered and Remotion available, sequences containing text, shapes
  and anime templates plan **`native`**; the generic "text layer … requires graphics rendering" blocker no longer
  fires for claimed layers; the fframes check (`planner.ts:466`) applies only to `renderer !== 'anime'`; the plan
  summary lists baked layers (`graphicsGroups` engine `remotion`, path `hybrid` when any layer is baked; additive).
- **LBK-003 (P0) Bake.** `prepare` builds, per claimed clip, a dedicated snapshot over the clip's full drawn span
  (`[start − headHandle, start + duration + tailHandle)`, not the export range, so partial exports reuse it) with
  `layerFilter: [clipId]`, `transparentBackground: true`, `isPreview: false`, signed media/font URLs, and renders it
  with a new `RemotionService.renderAlphaMaster` (ProRes 4444, `yuva444p10le`, PNG frames, muted, bt709 remux,
  frame-count check) into `<appdir>/cache/layers/<key>/master.mov`. Override `{space: 'sequence', startFrame,
  includesFades: true}`.
- **LBK-004 (P0) Static layers = one PNG.** A claimed clip with no text animation, no keyframes on any of its
  properties (Motion, opacity, effects, shape props, template params), no anime template and no time-varying effect
  is rendered once with `renderStill` (PNG, straight alpha) and overlaid as a looped still for its span
  (`LayerOverride.still?: true`, additive; the builder loops the input like stills). Fades/transitions still apply.
- **LBK-005 (P1) Crop.** Masters may carry `rect: {x, y, w, h}` (additive `LayerOverride.rect`); the bake computes
  the union of the layer's per-frame bounds (from the resolved scene, plus a bleed of 10 % of the sequence height,
  clamped to the frame) and renders only that region (Remotion `crop`/size override), overlaid at `x, y`.
- **LBK-010 (P0) Colour on DOM layers (FIX-002).** Colour-op effects (D-21) on DOM layers are no longer dropped:
  - native export: the bake renders the layer **without** its colour runs; the override carries
    `colorRuns: true` (additive) and the builder applies the clip's colour runs to the override stream with the
    colour extension's filter (pointwise LUT on straight-alpha RGB — equal to grading before placement because
    colour ops are pointwise, D-21);
  - Remotion export and stills: `prepareForRemotion: true`; for DOM layers with colour effects the bake also writes a
    graded master (bake + `lut3d`), and `adaptRemotionDoc` injects its signed URL so the composition plays it
    through `<OffthreadVideo transparent>` (S08:MGC-033 pattern);
  - preview: the web runtime requests a graded VP9-alpha preview (`POST /api/layer-bake/preview`, 2 s after the last
    change, S08:MGC-023 pattern); until it exists the layer shows ungraded with the existing "Grade pending" chip.
- **LBK-020 (P0) Render key.** `sha256(canonicalJson({v, recipe, clip: normalised RenderVisualClip (clipId
  constant, start shifted to the span start, no URLs), span length, width, height, fps, fonts: [{family, weight,
  style, fileSha256}], media: [{mediaId, fingerprint, size, mtime}] (incl. LUT assets), bundleId, animejs,
  remotion: '4.0.499', browser: executable identity, gl, still, rect, graded}))[:40]`. `bundleId` = the dev
  `sourceHash` or, for packaged builds, a stamp written by `build-remotion.mjs` (bundle content hash).
- **LBK-021 (P0) Cache.** `<appdir>/cache/layers/<key>/{master.mov|still.png, graded.mov?, preview.webm?,
  meta.json}`; `meta.json` has `lastUsedAt`; GC removes entries unused for 14 days (a `gc` pass like mg).
- **LBK-022 (P0) Jobs.** Job kind `layer-bake` (reserved in `JOB_KINDS`), child of the export/still job (`cpuSlots:
  0`, `minSlots: 0`, dedupe `layer-bake:<key>:<parent>`, abort propagation), stage text "Baking graphics i/n",
  child progress "Rendering i/N frames". Remotion concurrency for bakes follows the export's.
- **LBK-023 (P0) Fallback.** `auto` export: a bake failure re-plans the export on the Remotion path with a warning
  (also fixes `prepareExtensions` throwing for other extensions: any extension `prepare` failure in `auto` mode
  falls back to Remotion when the Remotion path is eligible). Forced `native`: the export fails with the bake error.
- **LBK-024 (P0) Blockers.** Remotion unavailable (`remotionLocal: 'unavailable'` or binaries not allowed) →
  "graphics layers need the Remotion renderer to bake" for every claimed layer; `needs-browser-download` counts as
  ready with the `BROWSER_DOWNLOAD` warning. Colour effects on a DOM layer while WebGL is unavailable are fine
  (colour is applied by ffmpeg, LBK-010).
- **LBK-025 (P0) Stills.** `POST /api/stills` and MCP `render_frame` use the same path: a native still with baked
  layers renders one frame per claimed layer (cached full masters are reused when present).
- **LBK-026 (P0) Usage log.** Every bake and every mg pre-render records Remotion usage (`recordUsage('media')`,
  LC-004; the mg pre-render currently does not).
- **LBK-030 (P0) Capabilities.** `features.layerBake = {state: 'ready'|'unavailable', reason?, cacheBytes}`;
  `features.anime = {animejs, textPresets, templates}` (filled by `routes/anime.ts`).
- **LBK-031 (P0)** Generated filter text passes the GPL-filter scan (D-13 M2 note).

## 7. Shapes (SHP-001…030)

- **SHP-001 (P0) Kind.** New clip kind `shape` (S03 KND-055): `ShapeClip.shape = {type: 'rect'|'ellipse', size:
  Animatable<vec2> (px), fill: Animatable<RGBA> | null, stroke: {color: Animatable<RGBA>, width: Animatable<number>,
  position: 'inside'|'center'|'outside'} | null, cornerRadius: Animatable<number> (rect)}` plus the usual transform,
  opacity, blend mode, effects, crop. Schema v4. `intrinsicBox` = size (+ outside stroke).
- **SHP-002 (P0) Engines.** `kinds.ts`: preview `remotion`, export `remotion` (baked natively by LBK), badge "R",
  label colour "graphics". Capabilities like text (effects, Motion, keyframes, transitions, blend).
- **SHP-003 (P0) Commands.** `clip.addShape {trackId, at, duration?, shape: {type, size?, fill?, stroke?,
  cornerRadius?}, transform?}` (defaults: 400×400 at sequence centre, fill white, no stroke, radius 0, duration 5 s),
  `clip.update` patch `shape` (merge), `param.set` on `shape.*` keys; keyframes on `shape.size`, `shape.fill`,
  `shape.stroke.color`, `shape.stroke.width`, `shape.cornerRadius` (KF evaluator).
- **SHP-004 (P0) Rendering.** `ShapeLayer` draws inline SVG (geometry from `@remotion/shapes` `makeRect` /
  `makeEllipse`, pinned 4.0.499) inside `LayerBox`; stroke position inside/outside implemented with clip paths /
  doubled width + mask so the visible stroke width equals `width`.
- **SHP-005 (P0) Properties ▸ Shape** section (TXT-020): type (read-only), size (vec2 with link toggle), fill
  (colour swatch + "None"), stroke colour/width/position (+ "None"), corner radius (rect). Effect Controls gets a
  "Shape" section with stopwatches for the animatable props.
- **SHP-006 (P0) Tools and menus.** Graphics ▸ New Layer ▸ Rectangle / Ellipse (`graphics.newRectangle`,
  `graphics.newEllipse`, currently unregistered) insert a default shape at the playhead on the targeted video track;
  the Program monitor gains the Rectangle and Ellipse tools (XF-061): drag creates the shape with that bounding box,
  Shift constrains to square/circle, Alt draws from the centre; Escape cancels; one undo step. Tool shortcuts follow
  the existing keymap conventions without new conflicts (S05).
- **SHP-007 (P1)** "Resize shapes by size" preference (TXT-020): handles edit `shape.size` instead of Motion scale.
- **SHP-008 (P0) Agents.** MCP `add_shape` (type, size, fill, stroke, radius, position, at, duration, track) and
  shape fields documented in `describe_commands`; `get_timeline` formats shapes.

## 8. Agents and MCP (ANA-001…015)

- **ANA-001 (P0)** `exportAgentSchema` gains `textAnimations: [{id, version, label, phases, paramsSchema (JSON),
  defaults, defaultDurationFrames, description}]`; `mgTemplates[]` gains `renderer`, `description`,
  `defaultDurationSeconds`; the `shape` kind and its properties appear in the property list.
- **ANA-002 (P0)** `tools/animation.ts` (`ANIMATION_GUIDE`): `list_text_animations`, `set_text_animation {clipId(s),
  in?, out?}` (preset, durationFrames/seconds, params; `null` removes); `add_text` gains `animateIn`/`animateOut`.
- **ANA-003 (P0)** `list_motion_templates` outputs `renderer` and a compact params summary; `add_motion_graphic`
  works for anime templates; new `set_motion_graphic_params {clipId, params}`; `render_motion_graphic_preview` routes
  anime templates to a Remotion still/preview of a one-clip snapshot and keeps `RENDERER_UNAVAILABLE` for fframes.
- **ANA-004 (P1)** `render_frames {times[] | count}` returns a contact sheet (one PNG grid) so agents can see motion.
- **ANA-005 (P0)** `render_frame` / exports explain missing Remotion/Chrome with an actionable hint.
- **ANA-006 (P0)** Command examples (`apps/mcp/src/examples.ts`) for `clip.update {textAnimation}`,
  `clip.addMotionGraphic` with an anime template and `clip.addShape` (dry-run automatically by the existing test).
- **ANA-007 (P0)** `queries.clipSource` reports text animation, shape geometry and composition sources (today it
  returns `{}` for composition clips).
- **ANA-008 (P0)** `format.ts` shows `in:<preset> out:<preset>` for text, the renderer for templates, the geometry
  for shapes.

## 9. Pre-existing defects fixed in this delivery (FIX-001…010)

- **FIX-001 (P0)** `MotionGraphicLayer` builds its own box instead of `LayerBox`: no effects, no corner pin, `add`
  blend unmapped. → Both renderers render through `LayerBox` (`wp-m2-anime-templates`).
- **FIX-002 (P0)** Lumetri/LUT colour effects on text/DOM layers are silently dropped in preview and export. →
  LBK-010 (`wp-m2-layer-bake`).
- **FIX-003 (P0)** `useDocumentFonts` does not hold layers back: text mounts and measures with fallback fonts.
  → Font-dependent layers (text, anime templates) render hidden and do not build/measure until their faces are
  loaded (a `FontsReady` context from `useDocumentFonts`, keyed per family/weight/style); renders still wait through
  `delayRender`; the Player shows nothing rather than a fallback-font flash (`wp-m2-anime-core`).
- **FIX-004 (P0)** `param.set` on static text style fields (e.g. `text.sizePx`) writes the field without re-running
  text layout. → Same layout path as `clip.update` (`wp-m2-text-anim`).
- **FIX-005 (P0)** `MgTemplateRegistry` has no version upgrade path. → ATP-009 (`wp-m2-anime-templates`).
- **FIX-006 (P0)** README "Tools (32)" is stale. → The integrator regenerates the tool table/count from the server's
  tool list after the merge (a test asserts the README count matches).
- **FIX-007 (P0)** `graphics.newRectangle` / `graphics.newEllipse` are unregistered (menu entries disabled). → SHP-006
  (`wp-m2-shapes`).
- **FIX-008 (P0)** Unknown motion-graphic templates export as the placeholder card. → ATP-010.
- **FIX-009 (P0)** The dev Remotion bundle cache key ignores the lockfile (a lockfile-only dependency bump reuses a
  stale bundle). → `sourceHash` includes the `pnpm-lock.yaml` hash and the new workspace packages (`wp-m2-anime-
  contracts`).
- **FIX-010 (P1)** There is no third-party notice for the JavaScript dependencies shipped in the web build and the
  Remotion bundle (spec 04 LC-005 `THIRD_PARTY_NOTICES`). → `scripts/third-party-notices.mjs` generates
  `THIRD_PARTY_NOTICES.md` from the production dependency closure of `apps/web` and `packages/compositions`
  (name, version, licence, licence text), checked in, refreshed by `pnpm notices`, verified by a test, copied into
  packaged builds and linked from Help ▸ About (`wp-m2-anime-core`).

Implementers who find further defects in the code they touch fix them in their package (with a test) and list them
in their `docs/wp-notes/<wp>.md` under "Defects fixed".

## 10. Work packages, ownership and order

Order: **wave 0** `wp-m2-anime-contracts` (shared contracts with working minimal implementations, merged to `main`
first) → **wave 1** in parallel worktrees: `wp-m2-anime-core`, `wp-m2-text-anim`, `wp-m2-anime-templates`,
`wp-m2-layer-bake`, `wp-m2-shapes` → integration on `main` (merge order core, layer-bake, text-anim,
anime-templates, shapes), README/ARCHITECTURE fold-in, full verification.

| Package | Owns (exclusive) | Requirements |
|---|---|---|
| `wp-m2-anime-contracts` | everything listed in ARCHITECTURE §20.1–§20.8 | the contracts only |
| `wp-m2-anime-core` | `packages/motion/src/runtime/**`, `packages/motion/test/{runtime,determinism}*`, `scripts/check-anime.mjs`, `scripts/third-party-notices.mjs`, `THIRD_PARTY_NOTICES.md`, `apps/engine/src/anime/**`, `routes/anime.ts`, `packages/compositions/src/fonts.ts`, web licence notice, `vite.config.ts` chunking, scaffold anime example | ANM-*, FIX-003, FIX-010 |
| `wp-m2-text-anim` | `packages/project/src/text-animations.ts`, text-animation parts of `schema`-adjacent handlers (`clip-core.ts` text branch, `param.ts`, `placement.ts` split, `handlers/sequence.ts` remap), `registry/properties.ts` `textAnimation` group, `packages/motion/src/text/**`, `layers/TextLayer.tsx`, `apps/web/src/text-animation/**`, `commands/text-animation.ts`, Text Animations tab, Effect Controls text section + mini-timeline bars, `apps/mcp/src/tools/animation.ts`, `editing.ts` (`add_text`), `agent/queries.ts`, `format.ts` | TXA-*, ANA-002, ANA-004, ANA-006…008, FIX-004 |
| `wp-m2-anime-templates` | `packages/mg-templates/src/templates/anime/**` + catalogue entries, `registry.ts` upgrades, `packages/motion/src/templates/**`, `layers/MotionGraphicLayer.tsx`, `apps/engine/src/mg/**` (anime routing), `apps/web/src/panels/motionTemplates/**` (except the Text Animations tab), `commands/mg.ts`, `apps/mcp/src/tools/render.ts` (templates), `keyframe.ts` dynamic keys for template params | ATP-*, ANA-003, ANA-005, FIX-001, FIX-005, FIX-008 |
| `wp-m2-layer-bake` | `apps/engine/src/layer-bake/**`, `routes/layer-bake.ts`, `export/planner.ts`, `export/service.ts`, `export/native.ts` (override `still`/`rect`/`colorRuns` handling), `remotion/service.ts` (`renderAlphaMaster`, `bundleId`), `scripts/build-remotion.mjs` stamp, `apps/web/src/layer-bake/**` (graded preview runtime), mg pre-render usage log | LBK-*, FIX-002 |
| `wp-m2-shapes` | shape handlers (`commands/handlers/shape.ts`), shape property specs (separate block in `properties.ts`), `layers/ShapeLayer.tsx`, `apps/web/src/shapes/**`, `commands/shapes.ts`, Program shape tools, `apps/mcp/src/tools/shapes.ts` | SHP-*, SHP-008, FIX-007 |

Shared-file protocol (ARCHITECTURE §16.3/§19.8): frozen contracts change additively only, with `Contract-Change:` in
the commit body; `properties.ts`, `kinds.ts`, `snapshot.ts`, `README.md`, `tokens.css`, `pnpm-lock.yaml` are edited
in separate, clearly delimited hunks/blocks per package; each package writes `docs/wp-notes/<wp>.md` (format of
`wp-m2-mg.md`: built by requirement, contract changes, licences, how to test, defects fixed, known gaps) and one
README subsection; the integrator folds notes into ARCHITECTURE.

## 11. Acceptance tests

Every package keeps `pnpm lint && pnpm typecheck && pnpm test` green and adds unit, component (happy-dom), engine
route and one Playwright spec. In addition:

1. **Determinism** (ANM-013/014): all presets and templates pass the shuffled-order suite; `REMOTION_E2E=1` parity
   (stills vs `renderMedia` c1/c4 vs reverse; Player vs still ≤ 3/255 on 99.5 %).
2. **Text animation e2e** (`e2e/text-animation.spec.ts`): add text, apply "Slide up" by word as In and "Fade" as Out
   from the Text Animations tab, see the Program animate, scrub back and forth (pixels identical on revisits),
   razor the clip (left keeps In only, right Out only), undo/redo, export native (plan path `hybrid`/`native` with
   baked layers), the output frame at mid-In matches `renderStill` (≤ 3/255 on 99 %).
3. **Templates e2e** (`e2e/anime-templates.spec.ts`): drag `title-reveal` from the gallery, edit text and colour,
   keyframe a colour param, stretch the clip (intro/outro lengths unchanged, frame-exact), apply a Gaussian blur and
   a corner pin (visible in preview), export native, compare with `renderStill`. fframes templates unaffected
   (`MG_PARITY` and existing mg tests green).
4. **Layer bake** (engine tests + `MG_E2E=1`/`REMOTION_E2E=1`): footage + static title + animated title + shape +
   anime template plans `native`; static title bakes one PNG; output matches a full Remotion render within 3/255 on
   99 %; straight alpha over R/G/B/W ≤ 2/255; second export is a cache hit; changing text, preset, font, animejs
   version or bundle id gives a new key; moving the title in time hits the cache; a Lumetri grade on a title is
   visible in native export, Remotion export and (after the graded preview) the Program; GPL-filter scan passes;
   bake failure in `auto` falls back to Remotion with a warning.
5. **Shapes e2e** (`e2e/shapes.spec.ts`): Graphics ▸ New Layer ▸ Rectangle and Ellipse are enabled and insert shapes;
   the Rectangle tool drag (Shift = square, Alt = from centre) creates the right box; edit fill/stroke/radius,
   keyframe size, export native, compare with `renderStill`.
6. **MCP**: `list_text_animations`, `set_text_animation`, `add_shape`, `set_motion_graphic_params`,
   `render_motion_graphic_preview` (anime), `render_frames` covered in `apps/mcp/test/integration.test.ts`; README
   tool count test (FIX-006).
7. **Fonts** (FIX-003): a text layer with a slow-loading font never paints with the fallback font in the Player and
   never splits/measures before load (component test with a deferred `FontFace`).
8. **Licences**: `/api/licenses` lists anime.js (MIT) with its text in dev and packaged-like runs;
   `THIRD_PARTY_NOTICES.md` is current (`pnpm notices --check`).
