# Spec 19: Title Looks — a general system for stylized titles

Status: specified 2026-11-02. Owner wp-note: `docs/wp-notes/title-looks.md` (created by the implementation).
[`ARCHITECTURE.md`](../ARCHITECTURE.md) and [`AGENTS.md`](../../AGENTS.md) win over this spec.

## 0. Background

Editors can type text, but making a title that looks designed takes many separate effects and real skill. An AI agent
has it worse: it can only set raw parameters and cannot judge the result.

[`SafEight/pachislop`](https://github.com/SafEight/pachislop) (commit `dd952d0`) is a browser editor for still pachinko
title art. Its strong ideas are general: an ordered appearance stack per title, finishes such as metal and bevel, looks
separated from colourways, effects that follow the shape of the title, and a style check with one-click fixes.

This spec turns those ideas into a **general system for any stylized title**: corporate lower thirds, cinematic
trailers, gaming, sports, neon, comic, horror, kids, luxury, social and pachinko are all equal users of it. Nothing in
the model, the UI or the tools is specific to pachinko. Pachinko is one category in the library.

Pachislop has no timeline. Everything here is animatable on the Jasper timeline, which Pachislop never needed.

## 1. Goals and non-goals

Goals:

- **G1 Any style.** One model expresses any stylized title, from a clean caption to a chrome trailer title.
- **G2 Fast.** A person goes from nothing to a finished title with: type in place, click a look, click a colourway.
- **G3 Deep.** Every layer of a look can be edited, reordered, keyframed and saved.
- **G4 Agents.** An agent goes from a brief to a checked, undoable title on the timeline in 3–5 tool calls.
- **G5 Exact.** Program preview and every export agree, or the export refuses with a named blocker.
- **G6 Safe.** Looks survive save, reload, undo, split, duplicate, copy and paste, and older builds never lose them.

Non-goals:

- A separate title-design app or workspace, and a second 3D renderer. three.js is not added.
- Print features: CMYK, ICC proofing, bleed and physical sizes.
- A PWA, browser-side PNG encoders and the Local Font Access API.
- Ruby text and automatic kinsoku line breaking.
- Sharp-corner (miter) rims. Rims from distance fields have round corners; plain text strokes keep miter joins.
- Looks on caption and subtitle clips. Subtitle templates remain their tool.

## 2. Content and provenance rules

- **TL-001 No real names.** No shipped look, template, tag, sample text, thumbnail, comment or test may contain the name,
  logo or title text of a real game, show, film, brand, franchise or person. A visual style inspired by something real
  may ship under a generic descriptive name. A look copied from Pachislop whose name or sample text refers to a real
  title is renamed and has that text removed.
- **TL-002 Port records.** Code and data taken from Pachislop are recorded in `licenses/ported/pachislop-<area>.md`,
  pinned to commit `dd952d0`, with licence `LicenseRef-Pachislop` and copyright `Copyright (c) 2026 SafEight`. The
  licence text in `licenses/texts/LicenseRef-Pachislop.txt` states that the author gave permission by direct message on
  2026-11-02 and that the repository has no licence file.
- **TL-003 Upstream sources.** Warp meshes keep Patchy's MIT notice (`https://github.com/SethRobinson/Patchy`,
  `Copyright (c) 2026 Seth A. Robinson`). Fonts come from their OFL upstreams, unmodified.
- **TL-004 Generated notices wording.** `scripts/third-party-notices.mjs` says "these projects", not "these open-source
  projects", because a record may name a source without an open-source licence.

## 3. Terms

- **Look:** a named, reusable appearance: an ordered list of layers, a palette, lighting and optional typography.
- **Appearance:** a look as applied to one clip, with that clip's overrides and keyframes.
- **Layer:** one item in an appearance: face, rim, plate, shadow, glow, inner effect or attached generator.
- **Colourway:** a named palette that fills a look's colour roles without changing its structure.
- **Role:** a named colour slot: `face`, `faceAlt`, `keyline`, `accent1`, `accent2`, `accent3`, `base`, `glow`, `shadow`.
- **Title template:** a preset that expands into ordinary clips: text with a look, animation and generators.
- **Generator:** a procedural picture that needs no source footage.
- **Shape field:** the signed distance field of a clip's alpha, computed each frame it changes.

## 4. Model (`packages/project`)

Schema v12. A look is **one structured effect instance**, following the Puppet precedent
(`EffectInstance.puppet`, `FxStructures.puppet`). This gives it splitting, duplication, copy and paste, Effect Controls
placement, render routing and bake support without per-kind code, and lets it apply to any visual clip.

- **TL-010** `jasper.title-look` is an effect in the registry, marked internal so it is not listed in the Effects panel.
  An `EffectInstance` of it carries `appearance` (read leniently, checked by INV-APPEARANCE). A clip has at most one.
  It applies to `text`, `shape`, `still`, `solid` and `video` clips.
- **TL-011** The appearance shape:

  ```ts
  type Appearance = {
    v: 1;
    lookId?: string;                 // link to doc.titleLooks; absent = unlinked
    lookOverrides?: Record<string, unknown>; // deviations from the linked look, by layer id and param
    colorwayId?: string;
    palette: Partial<Record<Role, Animatable<RGBA>>>;
    light: { source: 'look' | 'sequence'; angle: Animatable<number>; altitude: Animatable<number> };
    seed: number;                    // integer; survives split, duplicate and paste
    layers: AppearanceLayer[];       // bottom-first
    font?: FontRef;                  // applied to the text when the look is applied, then not read again
  };
  type AppearanceLayer = {
    id: string;
    type: LayerType;                 // §5, §7
    enabled: boolean;
    name?: string;
    params: Record<string, AnimParam>;
  };
  type Paint =
    | { kind: 'role'; role: Role }
    | { kind: 'color'; color: RGBA }
    | { kind: 'gradient'; gradient: Gradient }
    | { kind: 'source' };            // the clip's own picture, so a look does not flatten a still or video
  type Gradient = {
    type: 'linear' | 'radial' | 'sweep' | 'shape';
    span: 'block' | 'line' | 'glyph';
    angle: number;
    stops: { at: number; paint: { role: Role } | { color: RGBA }; alpha?: number }[]; // 2..32
  };
  ```

- **TL-012 Units.** Every distance in an appearance is a percentage of the text size (`em`) for text clips and of the
  shorter side of the alpha bounds for other kinds. Looks therefore transfer between sizes and resolutions.
- **TL-013 Limits.** At most 24 layers, 32 gradient stops per gradient and 64 KB serialized per appearance. Commands
  refuse more with `E_LIMIT`. Repair drops the excess layers and reports it.
- **TL-014 Animation.** All numeric layer params and palette colours are `Animatable`. Enums and structure are hold-only.
  `param.set`, `keyframe.*` and `expression.*` reach them by a path through the effect instance, and every explicit
  walker is updated: `clipAnimatables`, `expressions`, `reidentifyClipChildren`, `propertyKeyToParamPath`, clipboard
  closure and Paste Attributes.
- **TL-015 Project looks.** `ProjectDocument.titleLooks` holds looks used by this project, copied in on first use from
  the library. Keyframes stay on clips. A linked clip keeps its effective values, so a missing look only unlinks it.
- **TL-016 Update of a look.** `look.update` rewrites linked clips, keeps their overrides and keyframes, skips locked
  tracks and warns `W_CLIP_SKIPPED`.
- **TL-017 Global light.** `Sequence.settings.globalLight {angle, altitude}` is animatable. Layers using
  `light.source: 'sequence'` follow it.
- **TL-018 Commands.** All undoable, one History entry per user action, `E_*` refusals tested:
  `look.apply`, `look.remove`, `look.detach`, `look.reset`, `look.setColorway`, `look.create`, `look.update`,
  `look.rename`, `look.delete`, `appearance.addLayer`, `appearance.removeLayer`, `appearance.reorderLayer`,
  `appearance.setLayerEnabled`, `appearance.setPaint`, `appearance.setGradient`, `sequence.setGlobalLight`,
  `clip.addGenerator`. `look.apply` on several clips is one transaction.
- **TL-019 Apply semantics.** Applying keeps text, transform, timing, masks, animators and user effects. It replaces the
  previous appearance. Keyframes on replaced params are dropped and the command reports how many. `look.setColorway`
  keeps structure and keyframes because it only changes role values.
- **TL-020 Persistence.** Migration v11→v12, fixture `packages/project/test/fixtures/schema-v12.jasper`, `STEP_CHANGES`,
  INV-APPEARANCE, `repairAppearance`, ids in `ids.ts`, and the steps in `docs/project-files.md`. A v12 project opens
  read-only in older builds. Invalid appearances load, repair conservatively and report repairs; they never stop a
  project opening.
- **TL-021 Media references.** Custom reflection images and pattern tiles are `{mediaId}` values. Media use-counting
  (`orphanRefs`, `clipRefs`, `usedMedia`, INV-014) counts them, along with existing effect media and light environments.

## 5. Rendering (`packages/project/src/registry/fx/title-look`, `packages/compositions`)

- **TL-030 One path.** The look renders through the existing WebGL2 effect framework, in the same code for Player and
  Remotion. It adds no new export engine and no new clip kind. The instance plans its passes from the appearance
  resolved at the frame, through `FxStructures`.
- **TL-031 Shape field.** Jump flooding on the input alpha with sub-pixel seeds gives an inside and outside distance,
  stored in `rgba16f`. Passes share one field per instance. Reach adapts to the largest distance any enabled layer needs.
- **TL-032 Colour.** Compositing inside a look is linear light, premultiplied, on `rgba16f` intermediates. Output is
  converted back to the framework's signal. If float targets are unavailable the look refuses with
  `TITLE_LOOK_NEEDS_FLOAT`, in preview as a visible chip and in export as a blocker. It never falls back to 8-bit.
- **TL-033 Padding.** `gpu.padding` is computed from enabled layers across all frames of the clip, so glows and shadows
  never clip. `contentBleed` honours `gpu.padding`, so a moving look does not bake the full frame.
- **TL-034 Resolution independence.** A look at 50 %, 100 % and 200 % resolution matches within tolerance after scaling.
  No blur is clamped in pixels and no grain is tied to render pixels.
- **TL-035 Determinism.** Frames are pure functions of the document and frame. Noise uses integer hashes. `seed` comes
  from the appearance, not from ids. Splitting a clip leaves every frame unchanged.
- **TL-036 Spans.** `line` and `glyph` gradient spans need text layout boxes, passed as a data texture from the text
  layer. On clips without text they behave as `block`, and the UI says so.
- **TL-037 Cost.** A look with unchanged input and params is not recomputed between frames in preview. Program stays
  responsive by using `fxPreviewScale`. The bake covers export. Measured timings go in `docs/performance.md`.
- **TL-038 Reflections.** Reflection environments are procedural GLSL presets (Studio, Sky, City, Sunset, Chrome Bands,
  Neon), plus an optional user image. No bundled image is needed and no project depends on a bundled file.
- **TL-039 HTML-in-Canvas.** Text reaches GL through HTML-in-Canvas. Where it is unavailable, looks are disabled with a
  reason and a visible chip, and the render refuses. Nothing is silently dropped. Recorded in `docs/gaps.md`.

### 5.1 Layer types

Each type ports Pachislop's visual behaviour where one exists and shares GLSL with the matching standalone effect.

| Type | Behaviour | Main params |
|---|---|---|
| `face` | The fill of the shape | paint, finish, opacity |
| `rim` | Ring around the shape, growing cumulatively from the face or the previous rim | width, offset, paint, finish, opacity |
| `inline` | Ring inside the shape | inset, width, paint, finish |
| `plate` | Backing shape: `contour`, `hull`, `box`, `slant`, `pill` | grow, corner, skew, paint, finish |
| `shadow` | Drop, long or perspective shadow | angle, distance, blur, spread, paint |
| `innerShadow` | Shadow inside the shape | angle, distance, blur, paint |
| `glow` | Outer glow, soft or precise, from edge or layer | radius, intensity, paint |
| `innerGlow` | Glow inside the shape | radius, intensity, paint |
| `deepGlow` | Physically scaled glow: exposure, threshold, radius, falloff, chromatic scatter, tint | see §8 |
| `sheen` | Moving band of light across the shape | angle, position, width, intensity |
| `gloss` | Gloss cap across the upper part of the shape | height, curve, intensity |
| `reflection` | Mirrored fade below the title | gap, fade, blur |
| `texture` | Overlay of noise, grain, pattern or dry-brush erosion | kind, scale, amount, seed |
| `generator:<id>` | Attached shape-aware generator, §7 | as the generator |

**Finish** is shared by `face`, `rim`, `inline` and `plate`:

- `flat`, `gradientMap`, `metal` (gold, silver, chrome, copper, brushed), `glass`, `pattern`, `gloss`.
- `bevel`: size, profile (round, chamfer, ridge, cove, custom curve), depth, softness, fit to stroke width.
- `reflection`: environment preset or image, rotation, blur, strength.
- `satin`: size, offset, angle, intensity.

Glass in a look refracts only its own fill. Refraction of the footage behind a title is §9.

## 6. Looks, colourways and templates

- **TL-050 Library.** At least **60 looks** in at least **12 categories**, stored as data in
  `packages/project/src/title-looks/factory/`: Clean, Corporate, Cinematic, Sports, Gaming, Neon & Retro, Comic, Luxury,
  Horror, Playful, Social, Japanese Variety, Pachinko & Arcade, Brush, 3D. No category holds more than a quarter of them.
- **TL-051 Colourways.** At least **12 colourways**, usable with any look. Colour stays separate from structure, and role
  tags are stored rather than guessed. Generators recolour through a luma gradient map, keeping hot cores white. A look
  may mark a layer's colour as fixed (fire keeps its own colours).
- **TL-052 Templates.** At least **16 title templates** across the same categories, each expanding into ordinary clips
  in one transaction: text with a look, an in and out animation, and generators where they help. Includes lower thirds,
  full-screen titles, end cards and social hooks.
- **TL-053 Fonts.** Looks name fonts with a fallback. Bundled OFL display fonts cover Latin and Japanese display styles
  and appear in `ATTRIBUTION.md`. A missing font follows the existing `FONT_FALLBACK` path.
- **TL-054 User looks.** People can save, rename, delete, import and export looks through the engine-backed preset
  store, extended with a versioned schema. The library is not stored in projects (TL-015).
- **TL-055 Relationship to other libraries.** A Text Style is typography and basic paint. A Look is an appearance. An
  Effect Preset is a stack of ordinary effects. A Title Template creates clips. Each has one home, and the Looks tab links
  to them rather than duplicating them.
- **TL-056 Style check.** `packages/project/src/title-looks/lint.ts` ports Pachislop's rules with tests and thresholds
  chosen for video: no-op settings, rings too close in lightness, too many hue families, rims too thin or thick for the
  text, hard black shadows. Each issue has a code, severity, message and, where mechanical, an undoable fix. Rendered
  checks are in TL-094.

## 7. Generators

- **TL-060** Each generator is a shader effect in the `Generate` category and can also be a `generator:<id>` look layer.
  Both use the same GLSL. A standalone generator is an effect on a `transparent` solid, created by `clip.addGenerator` in
  one transaction. There is no new clip kind.
- **TL-061 Time.** Every generator is a closed-form function of time and seed, needs no simulation history, and scrubs
  exactly. Per-generator motion:

  | Generator | Motion | Shape-aware |
  |---|---|---|
  | Fire, Smoke, Corona | Evolution over time | Yes |
  | Sunburst | Rotation, twist, optional clip to title | Optional |
  | Magic Circle | Rotation per row | No |
  | Lens Flare | Position, intensity | Optional centre |
  | Backlight | Rotation, length | Yes |
  | Light Streaks | Flight offset | No |
  | Shockwave | One `progress` param with frozen texture | No |
  | Particles | Seeded age, ballistic position, tumble; 7 emitters, 11 shapes | Edge and fill emitters |
  | Glints | Per-star twinkle with stable star identity | Yes |
  | Ink Splatter | Per-drop reveal | Yes |
  | Brush Swirl | Write-on along the stroke | No |
  | Speed Lines | Flow scroll and hold-frame boil modes | Optional focus hole |
  | Lightning | Hold-frame boil plus continuous crawl | Yes |
  | Pattern | Scroll, floor plane | No |

- **TL-062 Stable identity.** Star, particle and drop identity stays the same while the title moves, so animated titles
  do not re-roll. Shape-aware generators in a look read the shared shape field (TL-031).
- **TL-063 Preset chips.** Each generator ships at least three presets. Colour goes through roles when it is part of a
  look.
- **TL-064 Layer order.** Adding a generator never hides the title. A shape-aware generator goes behind or in front of
  the title by its own default, and a standalone one goes on a free track below the selected title.

## 8. Standalone effects

These work on any clip, and share code with the matching look layers. Before adding one, check the registry for an
existing effect that does the same job, and extend it instead if so.

Deep Glow (exposure, threshold and knee, radius, falloff, chromatic scatter, tint, highlight shift, using an
energy-normalised Gaussian mixture on a pyramid), Outer Glow, Inner Glow, Inner Shadow, Contour Lines, Perspective
Shadow, Floor Reflection, Title Material (bevel, chrome, glass, satin on any alpha), Gradient Overlay, Shaded Extrude,
Keyline. Each uses `defineShaderEffect`, is searchable, and appears in Effects, Effect Controls and MCP. Colour effects
in this list work in linear light.

## 9. 3D titles (`packages/compositions/src/three-d`)

Extends Advanced 3D. Nothing here adds a dependency.

- **TL-070 Bevel bands.** Up to 6 bevel bands per solid, each with width, depth, profile and its own material.
- **TL-071 Surfaces.** Separate materials per surface: face, bevel bands, side and back.
- **TL-072 Inflate.** A geometry mode that inflates the outline by a distance-based height field with a profile curve.
- **TL-073 Backplates.** Up to 3 stacked solids from contour, hull or box.
- **TL-074 Materials.** Clearcoat, flakes, procedural normals (crumple, hammered, liquid), iridescence and transmission
  glass with thickness, on a floating-point target. Transmission may sample the sequence backdrop.
- **TL-075 Environments.** Radiance `.hdr` import with validated dimensions and capped allocation, prefiltered
  reflections, environment rotation, and procedural environments shared with TL-038. HDR values stay in float.
- **TL-076 Tone mapping.** ACES, AgX, Khronos Neutral and a hue-preserving mode, applied before the RGBA8 output.
- **TL-077 Glints.** HDR-thresholded bloom with star rays, computed from a stable detector so stars do not flicker.
- **TL-078 Routing.** 3D stays on the Remotion export path. The UI shows the cost before enabling it, and `propose_title`
  reports it as `costClass`.
- **TL-079 Gizmos.** The Program monitor gets rotation arcs and a free-rotate ring for 3D layers, scaled to the target.
- **TL-080 Reflections of the backdrop.** Look glass (§5.1) stays self-contained. Backdrop refraction in 2D is not
  provided. 3D transmission (TL-074) is its route.

## 10. People (`apps/web`)

- **TL-085 Direct text entry.** The Type tool places a caret and types in place in Program, using the template text
  editor's approach, instead of inserting the word "Text". Double-clicking a text clip in Program edits it. Escape or
  clicking away commits, and the whole entry is one undo step.
- **TL-086 Looks tab.** A Looks tab in Motion Templates, with search, categories, recents, tile size, and one card per
  look with colourway dots. The grid is virtualised. Cards can be dragged to the Timeline, Program or Effect Controls.
  `Graphics ▸ Apply Look…` opens the same grid as a dialog, so it works in every workspace. Clicking a look with nothing
  selected inserts a new title at the playhead.
- **TL-087 Thumbnails.** Posters come from the engine through the real render path, on the user's own text when one is
  selected, cached on disk by content key, lazy and cancellable. The main thread never blocks on them.
- **TL-088 Hover preview.** Hovering a look or colourway shows it on the selected clip in Program after a short delay,
  through a preview override that is not a document edit. It never adds to History and ends when the pointer leaves.
- **TL-089 Properties.** A Look header shows the look name, link status, Reset and Detach, the colourway strip and an
  intensity control, with Look-defined quick controls beneath. An Appearance section lists layers with eye, swatch, one
  line summary and primary value, opening in place. Drag reorders. Add Layer offers every type.
- **TL-090 Effect Controls.** The stack appears as a block with stopwatches, keyframes and graphs for every numeric
  param, reusing effect header actions.
- **TL-091 Controls.** Add a `gradient` control, with stops that can use roles, reachable from any paint. Add a paint
  control. Reuse `PropertyRow`. Mixed selection shows "—", and relative drags offset each clip from its own value.
- **TL-092 On-canvas.** Selecting a layer outlines it in Program with its name. Rim width, shadow offset, gradient angle,
  sheen position and light angle have on-canvas handles declared in the layer schema. The tool bar shows the target as
  `Clip › Layer`.
- **TL-093 Per-word and per-letter editing.** Text selected in place can get its own `runs` style from a toolbar, and the
  Look applies over it. Per-letter finish overrides use the same runs. Rims stay continuous across letters.
- **TL-094 Style check badge.** A badge in the Look header counts issues from TL-056 and the rendered checks, lists them,
  and applies fixes in one click, undoably.
- **TL-095 Effects panel.** The highlighted effect previews on the selected clip the same way as TL-088, with
  keyboard-first navigation. Effect Controls gets a settings search built from its rendered rows, ranked to show
  "add effect" results first, and using it never changes the selection silently.
- **TL-096 Numeric control.** Scrub from label and value, Shift ×10, Ctrl ×0.1, a 3 px click slop, log or quadratic
  tracks for wide ranges, a changed-state label, and double-click to reset. It goes into the shared `ScrubbyNumber`.
- **TL-097 Wiring.** Every action has a `UiCommand`, a menu entry under Graphics and palette visibility. Effects and
  templates become searchable in the command palette. No default shortcut conflicts. Strings are English and Spanish.
  Colours use design tokens, with document colours marked `tokens-allow`.
- **TL-098 Agent visibility.** Reviewing a `title-art` proposal shows a look thumbnail and its alternatives. A/B applies
  to Program, and its toggle says "Compare" for visual items.

## 11. Agents (`apps/mcp`)

A new `titles` toolset, because `core` is full. It works by intent, with raw recipes as an escape hatch.

- **TL-100 `find_title_looks`** `{query, tags?, aspect?, sampleText?, limit≤12, cursor?}` returns rows
  `{lookId, name, tags, colorways, costClass, renderPath}` and one numbered image sheet.
- **TL-101 `propose_title`** `{projectId, sequenceId?, text, at, duration?, lookId|recipe, colorway?, energy?,
  alternatives≤3, seed?, mode: 'propose'|'dryRun'|'apply', expectedRevision?}` returns `{proposalId|clipIds, seed, check,
  next}` and one sheet of intro, hold and outro × alternatives, composited over the real footage. Headless `apply` also
  returns `revert`. New proposal feature `title-art`, with colourways as item alternatives.
- **TL-102 `title_check`** `{projectId, clipId|proposalId, target?}` returns verify-style rows
  `{id, kind, status, measured, expected, at, message, fix?}` and `verified`. Rows: `safe-area`, `off-frame`, `contrast`
  (measured against the rendered background at sampled frames), `min-size`, `read-time`, `font-available`, `export-path`,
  plus every TL-056 lint issue. Results are bound to `revision`.
- **TL-103 Render extensions.** `render_frames` gains `proposalId`, `itemIds` and `overlay: 'safe-area'`. Sheets run as
  one engine job with `{wait, timeoutSeconds, timedOut, jobId, next}` and cancel on abort.
- **TL-104 Escape hatch.** `get_title_recipe {lookId}`, `save_title_look {clipId|recipe, name, tags}`,
  `propose_title.recipe`, `add_title_generator`, `set_global_light`, and appearance targets in `get_clip_properties`.
- **TL-105 Effects discovery.** Register `list_effects`, `add_effect` and `set_effect_param`, or correct every guide that
  names them, so no guide names a tool that does not exist.
- **TL-106 Bounds.** `recipe` has zod caps on bytes, layers, depth and instances. Lists are paginated and contain no
  schemas. One image per call, 640 px by default, with a fixed cap on alternatives × frames.
- **TL-107 Docs.** Guide topic `title-art`, resource `jasper://title-looks/{id}`, routing rows in both languages, a
  `references/title-art.md` skill reference, `title_check` in `references/verification.md`, and the toolset line within
  the instruction budget. `apps/mcp/test/toolsets.test.ts` also scans `*_GUIDE` strings and tool descriptions for
  unknown tool names.

## 12. Text, interchange and delivery

- **TL-110 Warp.** Text gets 15 Photoshop-style warp styles with bend and distortion, ported from Patchy's meshes, as a
  look-level pixel warp using `mesh`-style geometry, animatable, applied after the look so rims bend with the text.
- **TL-111 Vertical text.** `writingMode: 'horizontal' | 'vertical'` on text, right-to-left columns, `vert`-aware glyphs
  through the browser, and upright 1–3 character tate-chu-yoko. Works with animators and looks.
- **TL-112 Send to Photoshop.** Export the current frame as a layered, registered, explicitly rasterised 8-bit PSD via
  `ag-psd`, with a dialog listing anything baked. Blockers are shown before writing.
- **TL-113 Layer-style import.** Import `.asl` and `.psd` layer styles as user looks. A per-style report lists what was
  mapped and what was approximated. Parsers are fuzzed and capped.
- **TL-114 Alpha delivery.** PNG sequence export with alpha, and transparent still export. Existing ProRes 4444 stays.
  "Export title" trims to content with a margin, so glows do not clip.
- **TL-115 Split image.** Split a still into connected parts as separate clips in one undo step, for logo animation.
- **TL-116 Gamut overlay.** A Program overlay marks pixels outside the output gamut or legal range, with a percentage.

## 13. Fixes this depends on

Each has a regression test that fails before the fix.

- **TL-120** Media use-counting (TL-021): light environments and effect `{mediaId}` params. Data-loss path.
- **TL-121** Seed stability across razor cuts (TL-035), including continuity of frame counters at the cut.
- **TL-122** `contentBleed` honours `gpu.padding` (TL-033).
- **TL-123** `rgba16f` fallback: an effect can declare that it requires float, and then refuses instead of degrading.
- **TL-124** `PlanCapabilities` reports WebGL, so its absence is a plan blocker rather than a mid-render failure.
- **TL-125** `docHasColorEffects` covers nested sequences and GL-only paths.

## 14. Verification

- Unit tests for every command: undo, redo, refusals and invariants. Property tests: appearance diff and apply, loader
  fuzz, repair idempotence, and every parser with `fast-check`.
- Schema v12 fixture, migration and `schema-history.test.ts`.
- GL tests for every layer type, finish, effect and generator, using `packages/compositions/test/*-gl.test.ts` with
  fingerprints and a deliberate perturbation check.
- Resolution test: each layer type at two scales.
- Determinism: double build with fresh ids is byte-identical. Razor test: split clip matches unsplit clip.
- Parity: for a representative look on animated text, Program frame and exported frame compare by SSIM above the
  existing fidelity thresholds. Native-bake and Remotion paths are both covered.
- Registry completeness: a new layer type, effect or generator without a test fails.
- Library checks: every factory look parses, passes the lint at error level, has at least one role per colour, and fails
  the build if it contains a banned name from a checked list. A rendered contact sheet is generated and inspected.
- Agents: an end-to-end MCP test from brief to checked title, with `apps/mcp/test/toolsets.test.ts` budgets kept.
- Browser: Playwright specs for type in place, apply look, swap colourway, edit a layer, keyframe a param, undo, save and
  reload, and export. UI changes are exercised in the running app and inspected visually.
- Gate before merge: `pnpm lint && pnpm typecheck && pnpm test --maxWorkers=2 && pnpm build`, plus `JASPER_REQUIRE_ORACLES=1`
  on affected suites, `REMOTION_E2E=1` on affected suites, and `pnpm e2e`.

## 15. Documentation

- `docs/wp-notes/title-looks.md`: decisions, cited formulas, port map and measured figures.
- `docs/ARCHITECTURE.md`: a new decision for the structured-effect model and the reflection approach.
- `docs/project-files.md`: schema v12 row and fields table.
- `docs/gaps.md` and `docs/parity.md`: only with evidence, including disabled actions and their reasons.
- `docs/performance.md`: measured timings with machine, load and conditions.
- `README.md`: a short user-facing section, and MCP tool documentation.

## 16. Acceptance

The feature is complete when all of these hold on the merged result:

1. A person can type a title in Program, click a look, click a colourway, keyframe a layer, undo, save, reload and export,
   and the export matches Program.
2. An agent can do the same in at most five tool calls, and `title_check` reports real measurements.
3. Every requirement in this spec is implemented and tested, or recorded in `docs/gaps.md` with its reason.
4. No stub, TODO, `E_NOT_IMPLEMENTED` or placeholder UI remains in this feature.
5. The §14 gate passes, and skipped suites are stated with their reason.
