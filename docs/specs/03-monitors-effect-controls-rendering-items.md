# Spec 03: Monitors, on-canvas transform, clip rendering, Effect Controls, effects, text, captions, color

Status: functional spec, implementation-ready. Owner topic: `monitor-inspector`.
Audience: engineers building `apps/web` (UI), the shared model packages, and `apps/engine` (native export).
Clean-room: this spec is original. It describes behavior, data concepts and algorithms in our own terms. All type and field names below are JasperEditor names, invented for this spec. Implementers work only from `docs/specs/*`, `docs/research/*` and `docs/ARCHITECTURE.md`.

Related documents (ours):
- `docs/research/premiere-ui-design-spec.md`: visual tokens (`--pr-*`), metrics, keymap, monitor chrome and the Effect Controls layout. This spec defines behavior; that doc defines look. Where they disagree on behavior, this spec wins. Where they disagree on pixels or colors, that doc wins.
- `docs/research/native-video-libraries.md`: ffmpeg recipes, proxies, the hybrid export pipeline, LUTs.
- `docs/research/fframes.md`: the motion-graphics engine (template library, WASM SVG preview, alpha intermediates).
- `docs/research/orquester-multiplatform-setup.md`: web, PWA and Electron packaging, and the `apps/engine` daemon.
- Sibling specs in `docs/specs/` (document model, timeline, engines/export, agent API). This spec lists the document fields it needs (§3). If the document-model spec names them differently, keep the semantics and rename.

---

## 0. Conventions

### 0.1 Requirement IDs

Each requirement has an ID `<AREA>-<NNN>`. Work packages cite these IDs.

| Prefix | Area | Section |
|---|---|---|
| `ARC` | Render architecture (one scene function, three engines) | §2 |
| `DM` | Data concepts this spec adds to the document | §3 |
| `RND` | Composition and rendering rules shared by all clip kinds | §4 |
| `KND` | Per-clip-kind rendering rules | §5 |
| `PGM` | Program Monitor | §6 |
| `SRC` | Source Monitor | §7 |
| `OVL` | Monitor overlays (safe margins, rulers, guides, grid) | §8 |
| `XF` | On-canvas selection and transform | §9 |
| `SNP` | Spatial snapping in the monitor | §10 |
| `PRP` | Property registry, resolved values, write path | §11 |
| `KF` | Keyframes, interpolation, retiming | §12 |
| `EC` | Effect Controls panel | §13 |
| `INS` | Properties panel (context-sensitive inspector) | §14 |
| `FX` | Effects stack, effect registry, effect catalogue | §15 |
| `BLD` | Blend modes | §16 |
| `MSK` | Masks (later phase) | §17 |
| `TXT` | Text and graphics editing | §18 |
| `CAP` | Captions rendering and styling | §19 |
| `CLR` | Color (Lumetri-like), scopes (later phase) | §20 |
| `ENG` | Engine parity and export routing | §21 |
| `AGT` | Agent control surface | §22 |
| `TCH` | Touch / PWA adaptations | §23 |
| `NFR` | Performance, undo, persistence, accessibility | §24 |

### 0.2 Priority and phase tags

Each requirement carries a priority: **[P0]** is needed for the first usable editor, **[P1]** is needed for Premiere parity, **[P2]** is later or optional. The phase plan in §26 groups them.

"**Beyond template**" marks behavior the purchased starter did not have. We build everything from scratch anyway. The marker exists so reviewers know there is no prior art to compare against. §25 has the full list.

### 0.3 Coordinate, unit and naming conventions (normative)

| Quantity | Unit and space |
|---|---|
| Sequence space | Pixels of the sequence frame. Origin at the top-left, +x right, +y down. The frame is `[0, W] x [0, H]`. |
| Layer space | Pixels of a clip's **natural box** `[0, w0] x [0, h0]` (see `DM-003`), before crop and transform. Origin at the top-left of the natural box. |
| Screen space | CSS pixels in the monitor viewport. `sequencePx = (screenPx - viewOrigin) / viewScale`. |
| Timeline time | Integer frames at the sequence fps. |
| Clip-local time `f` | Integer frames from the clip's first visible frame (`f = 0` at clip start). Keyframe times use this clock (see §12.5 for how trims shift it). |
| Source time | Seconds into the media file. `sourceSec(f) = sourceInSec + (f / fps) * speed` for constant speed. |
| Rotation | Degrees, clockwise positive on screen (y-down), unbounded (720 means two turns). Displayed Premiere style as `2 x 0.0°` when the magnitude is at least 360. |
| Scale | Percent. 100 = natural size. Stored as numbers such as `100`, not fractions. |
| Opacity | Percent 0..100 in the UI and in storage. |
| Crop insets | Percent of the natural width (left, right) or natural height (top, bottom), 0..100. |
| Colors | CSS color strings in storage: `#rrggbb` or `#rrggbbaa`. Interpolated in linear-light RGB (see `KF-012`). |
| Audio gain | dB. |

Compositing order: tracks are composited **bottom to top** (V1 is the bottom, as in Premiere). The document-model spec decides the array order. Every renderer (the Remotion composition, the native filtergraph builder, the hit-tester) must iterate in compositing order through one shared helper, `compositingOrder(sequence)`. Nobody re-derives it inline.

---

## 1. Scope and non-goals

In scope:
1. Program Monitor and Source Monitor: preview, chrome behavior, zoom, playback resolution, overlays.
2. On-canvas direct manipulation: select, move, scale, rotate, anchor, crop, nudge, align, with snapping and handles.
3. How each clip kind renders (one scene function shared by preview and export), including timing, media selection, fades, transform, effects and blend order.
4. The property model: every editable, animatable value, its registry entry, resolved value at a frame, and the write path.
5. Keyframes: stopwatch, navigator, mini-timeline, interpolation, easing, spatial motion paths, retiming on edits.
6. The Effect Controls panel and the Properties panel.
7. The effects stack, effect registry, blend modes, and masks (later phase).
8. Text and shape graphics editing, and captions styling.
9. Color correction (Lumetri-like) and scopes, as a later phase.
10. Agent control of all of the above.

Out of scope (owned by sibling specs): timeline editing gestures, trims, the insert/overwrite mechanics themselves, the project/media bin, import, audio mixing panels, export UI and encoding settings, and transitions. This spec only states the interfaces it needs from them.

---

## 2. Render architecture

### 2.1 Principles

- **ARC-001 [P0] One scene function.** A pure function `resolveSceneAt(sequence, frame, options) -> ResolvedScene` produces, for one timeline frame, the ordered list of visible layers. Each layer has resolved geometry (a matrix), resolved property values, its effect chain, blend mode and media source. It must not import React or touch the DOM, so it can run in the browser, in a Web Worker, and in `apps/engine` (Node). It lives in a shared package (proposed: `packages/scene`).
- **ARC-002 [P0] One composition.** A Remotion composition component, `SequenceComposition`, renders a `ResolvedScene` to DOM for the current frame. The same component is used by:
  - the Program Monitor, inside `@remotion/player`;
  - the engine's Remotion render path (`@remotion/renderer` `renderMedia`/`renderStill`), for full renders and for graphics-only alpha intermediates;
  - the optional in-browser render path (`@remotion/web-renderer`), when no engine is reachable.
- **ARC-003 [P0] The composition is a pure function of its props.** Its only input is `inputProps = {doc: RenderDoc, options: RenderOptions}`. `RenderDoc` is a serializable snapshot of the sequence, the assets it references and font manifests. `RenderOptions` holds `mediaTier`, `renderScale`, `globalFxBypass`, `isPreview` and `transparentBackground`. The composition must **not** read editor stores through React context. That guarantees what you see in the Program Monitor is what the engine renders, and render paths need no stubbed contexts. (Beyond template: the starter shared editor contexts across the Player boundary and drew editor overlays inside the composition.)
- **ARC-004 [P0] Editor overlays live outside the composition.** Selection boxes, handles, snap lines, safe margins, guides, rulers, motion paths and mask editors are drawn in an **overlay layer** stacked above the Player in the monitor viewport (§6.3). It uses the same `resolveSceneAt` output to place geometry. Overlays can extend onto the pasteboard around the frame, and they never leak into renders.
- **ARC-005 [P0] Transient previews go through the doc.** Live gesture state (a drag in progress, a hovered font, a hovered effect preset) is applied by deriving a temporary `RenderDoc`: the committed document plus a transient patch. That derived doc is what goes to the Player. There is no side channel.
- **ARC-006 [P0] Three engines, one model.** Each clip kind and each effect declares, in a registry, how each engine realizes it (§21):
  - **Remotion (DOM)** is the reference implementation, and the only one used for interactive preview.
  - **Native (ffmpeg, CPU)** is used for fast export of media-heavy timelines, proxies, stills of plain media, and effects with ffmpeg equivalents.
  - **fframes (Rust/SVG, CPU)** renders `motionGraphic` clips: in preview through WASM SVG, in export through alpha intermediates.

### 2.2 Data flow

```
 Project document (committed) ──┐
 Transient gesture patch ───────┼─► derive RenderDoc ─► <Player inputProps={{doc, options}}>
                                │                          └─ SequenceComposition(frame)
                                │                               └─ resolveSceneAt(doc, frame) ─► DOM layers
                                │
 Playhead store (frame) ────────┼─► Overlay layer ─► resolveSceneAt(doc, frame) ─► handles, outlines, paths
                                │
                                └─► Effect Controls / Properties ─► resolvePropertyAt(clip, prop, f) ─► values
 apps/engine export:
   RenderDoc ─► route planner (§21) ─► ffmpeg filtergraph (native clips)
                                    ─► @remotion/renderer alpha intermediates (DOM-only clips/effects)
                                    ─► jasper-mg alpha intermediates (motionGraphic clips)
                                    ─► final native composite + encode
```

- **ARC-010 [P0] Single playhead store.** Current frame, playing state and shuttle rate live in one store (`playheadStore`). The Program Monitor's Player is the clock while playing: its `frameupdate` events write to the store. While paused, the store is the source of truth, and the Player is `seekTo`'d on change. Overlays, the Effect Controls mini-timeline, the Properties panel and the timeline all read from this store. Overlays need throttling: at most one overlay recomputation per animation frame.
- **ARC-011 [P0] Resolution cache.** `resolveSceneAt` is memoized per `(docVersion, frame)`, with an LRU of at least 8 entries. Per clip, a static clip (no keyframes, no animated effect params) resolves to the **same object** for every frame, so React layers memoized by identity do not re-render during playback.

---

## 3. Data concepts added by this spec

This section defines the fields the document must hold for monitors, rendering and effect controls. Names are ours. Sketches are TypeScript-flavored for precision; they are not final code.

### 3.1 Visual clip base

- **DM-001 [P0]** Every *visual* clip kind (video, image, animatedImage, text, shape, captions, motionGraphic, remotionGraphic, adjustment [P2]) carries:

```ts
type VisualLayerProps = {
  motion: {
    position: Vec2;        // sequence px: where the anchor point lands
    scale: number;         // % (used when uniformScale = true)
    scaleWidth: number;    // % (x scale when uniformScale = false; y uses `scale`)
    uniformScale: boolean;
    rotation: number;      // degrees
    anchor: Vec2;          // layer px within the natural box
  };
  opacity: number;         // 0..100
  blendMode: BlendModeId;  // §16, default 'normal'
  crop: {left: number; top: number; right: number; bottom: number; edgeFeather: number}; // % and px
  fades: {inFrames: number; outFrames: number}; // quick fades, multiply with opacity (§4.4)
  effects: AppliedEffect[];  // §15, ordered top = applied first
  masks: LayerMask[];        // §17, [P2]
  anim: AnimationMap;        // §12, keyframe tracks keyed by property path
  enabled: boolean;          // disabled clips render nothing (Premiere Shift+E)
};
```

- **DM-002 [P0]** Audio-capable clips (audio, video with audio) carry `{gainDb, pan, audioFades: {inFrames, outFrames}}`. `gainDb` and `pan` are animatable (their track lives in the same `anim` map). Channel volume is [P2].
- **DM-003 [P0] Natural box.** Every visual clip has a natural size `(w0, h0)` in layer px:
  - video, image, animatedImage: the media's **display** dimensions. These are the coded dimensions times the pixel aspect ratio, swapped when the container's rotation metadata is 90 or 270 degrees. The asset record must store true source dimensions, never a fitted size.
  - text: the measured text box (point text) or the user-set box (paragraph text), see §18.
  - shape: its own `size` property.
  - captions: the caption box `size` property (default: 90% of the frame width by 30% of its height).
  - motionGraphic / remotionGraphic: the template's canvas size, scaled to the sequence (see `KND-060`).
  - adjustment [P2]: the full frame.
- **DM-004 [P0] Default placement on insert.** A new visual clip gets `anchor = (w0/2, h0/2)`, `position = (W/2, H/2)`, `rotation = 0`, and a `scale` from the **Default Media Scaling** preference:
  - `none`: 100%;
  - `fit` (default): `min(W/w0, H/h0) * 100`;
  - `fill`: `max(W/w0, H/h0) * 100`.

  This mirrors Premiere's "Set to Frame Size", which changes the Scale value, not the natural size. We deliberately do **not** re-rasterize media at frame size.
- **DM-005 [P0]** When the first media clip is added to an empty sequence, the sequence may adopt that clip's size and fps. That is a timeline/sequence-settings decision, outside this spec. The Program Monitor must re-fit (`PGM-012`) whenever the sequence size changes.

### 3.2 Layer transform math (normative)

For a visual clip at clip-local frame `f`, with resolved motion values:

```
S = diag(sx, sy)        sx = (uniform ? scale : scaleWidth) / 100,  sy = scale / 100
R = rotation(θ)         θ in degrees, y-down (clockwise on screen)
M(q) = P + R · S · (q − A)   maps a layer-space point q to sequence space
```

- **DM-010 [P0]** The **visible rect** in layer space is the natural box minus the crop insets: `[l·w0, (1−r)·w0] x [t·h0, (1−b)·h0]`, where `l, t, r, b` are fractions. Crop never moves content. It only hides it. Changing crop does not change `A`, `P` or `S`.
- **DM-011 [P0]** The **layer quad** is `M` applied to the four corners of the visible rect. The **layer bounds** is the axis-aligned bounding box of the quad. Hit-testing, snapping, marquee and alignment use the quad or the bounds, and are therefore rotation-aware (see `XF-*`). (Beyond template: the starter's handles and snapping ignored rotation.)
- **DM-012 [P0] DOM realization.** The layer element is `w0 x h0`, positioned at the sequence origin, with `transform-origin: 0 0` and
  `transform: translate(Px, Py) rotate(θ deg) scale(sx, sy) translate(−Ax, −Ay)`.
  Crop is realized inside the element with `clip-path: inset(t% r% b% l%)`. Edge feather is realized with a CSS mask of inset linear gradients, or an SVG mask when feather > 0. The same matrix is used by the overlay layer, and in native export (`ENG-030`).

### 3.3 Monitor view state (not in the document, not undoable)

- **DM-020 [P0]** Per monitor instance (Program, Source, and later Reference), persisted per workspace in user preferences:

```ts
type MonitorViewState = {
  zoom: 'fit' | number;              // 10..800 (%), 'fit' default
  pan: Vec2;                         // screen px offset, clamped (PGM-014)
  playbackResolution: 'full' | '1/2' | '1/4' | '1/8';
  pausedResolution: 'full' | '1/2' | '1/4' | '1/8';
  highQualityPlayback: boolean;
  overlays: {safeMargins: boolean; rulers: boolean; guides: boolean; transparencyGrid: boolean;
             droppedFrameIndicator: boolean; motionPaths: boolean; pasteboardContent: boolean};
  snapInMonitor: boolean;            // Ctrl/Cmd+Shift+;
  displayMode: 'composite' | 'alpha' | 'scopes';   // 'scopes' is [P2]
  buttonLayout: {rows: MonitorButtonId[][]};        // see premiere-ui-design-spec §8.1
};
```

- **DM-021 [P0]** Guides (`{id, axis: 'x'|'y', at: number}` in sequence px) and safe-margin percentages are **sequence properties**. They live in the document, persist with the project and are undoable, as in Premiere where guides are saved with the sequence.
- **DM-022 [P0]** Selection lives in session state: `selectedClipIds`, `selectedKeyframeIds`, `selectedEffectId`, `selectedMaskId`, `monitorMode` (`'select' | 'crop' | 'textEdit' | 'maskEdit' | 'anchor'`), `textEditingClipId`. None of it is undoable. Undo/redo must drop selected ids that no longer exist.

---

## 4. Composition and rendering rules (all clip kinds)

### 4.1 Layer stacking

- **RND-001 [P0]** The composition renders a background, then every enabled, visible clip on visible (non-hidden) video tracks whose timeline range contains the frame, in compositing order (bottom track first). Within a track, clips never overlap in time, which the timeline spec guarantees. During transitions [P1, owned by the timeline spec] two clips can be active on one track. They render as a transition pair (rules in the timeline spec).
- **RND-002 [P0] Background.** Black by default (Premiere). The sequence has a `background` setting: `'black' | '#color' | 'transparent'`. `transparent` is used for alpha exports and graphics intermediates. The transparency grid overlay (`OVL-010`) is a monitor-only checkerboard drawn *behind* the Player when the background is transparent, or when the user enables the grid.
- **RND-003 [P0] Isolation.** The layer stack container establishes an isolated stacking context (`isolation: isolate`). Blend modes then composite only against lower layers of the same sequence, never against the page or the monitor chrome.
- **RND-004 [P0] Frame clipping.** Content is clipped to the frame in renders. In the monitor, the optional **pasteboard content** toggle [P1, beyond template] shows out-of-frame content at 25% opacity. It is implemented as a second, non-clipped, low-opacity render of the same scene behind the clipped one. Only the Player instance does this, and only while paused.

### 4.2 Per-layer processing order (normative)

For each visual layer, in this order. It mirrors Premiere, where applied effects run before the intrinsic Motion and Opacity:

1. **Source pixels**: the media frame at the resolved source time, or the generator output (text, shape, template).
2. **Crop** (intrinsic), in layer space.
3. **Applied effects**, top to bottom, in layer space. Each effect sees the output of the previous one. Effects whose output extends past the natural box (blur, drop shadow) may draw outside it. The layer element must not clip them, so crop uses `clip-path` on an inner element, not `overflow: hidden` on the outer one.
4. **Masks** [P2], in layer space. They affect alpha only.
5. **Motion** transform (the matrix from §3.2).
6. **Opacity**: `opacity/100 x fadeInFactor x fadeOutFactor`.
7. **Blend** with the composite below, using `blendMode`.

- **RND-010 [P0]** The order above is the same in every engine. The native builder must emit filters in this order (`ENG-031`).
- **RND-011 [P1]** An applied **Transform** effect [P1] runs at step 3 and has its own position/scale/rotation/opacity. That gives users Premiere's "transform before other effects" option.

### 4.3 Timing

- **RND-020 [P0]** Each clip is placed on the timeline as a Remotion `<Sequence from={clip.start} durationInFrames={clip.duration}>`, so inside it the local frame is `f`. Media clips use `premountFor` of 2 s worth of frames, so decoders warm up before the cut.
- **RND-021 [P0]** For media, with constant `speed` (≠ 0, may be negative [P1] for reverse):
  - `sourceSec(f) = sourceInSec + (f / fps) * speed` for forward playback.
  - Remotion media elements are given the trim-before offset (in frames at sequence fps: `round(sourceInSec * fps)`) and the playback rate `speed`.
  - Reverse, variable speed (time remapping) and frame hold use a **native retime proxy** (`KND-015`). The composition then plays that proxy at 1x from its start.
- **RND-022 [P1]** Frame hold: a clip with `hold: {atSourceSec}` shows one still frame for its whole duration. Preview uses a paused media element seeked to that time, or a still extracted by the engine (preferred: cached PNG).

### 4.4 Quick fades

- **RND-025 [P0]** `fades.inFrames` / `fades.outFrames` multiply opacity. The fade-in factor at `f` is `ease(clamp(f / inFrames, 0, 1))`. The fade-out factor is `ease(clamp((duration − 1 − f) / outFrames, 0, 1))`. `ease` is a smooth cubic, symmetric ease-in-out, fixed across engines. Constraint: `inFrames + outFrames ≤ duration`. Editing one clamps the other. The quick-fade UI (timeline fade handles) belongs to the timeline spec. The Properties panel exposes both values in frames/timecode.
- **RND-026 [P0]** Audio fades are independent (`audioFades`) and use an equal-power curve in preview and export.

### 4.5 Media source selection

- **RND-030 [P0]** Each media layer asks a resolver for a URL: `mediaUrlFor(asset, tier, context)`, where `tier ∈ {original, p1080, p720, p540, p360}` and `context ∈ {preview, export}`.
  - **Export** always uses originals. The only exception is an explicit "draft export using proxies" option.
  - **Preview** chooses the tier from the monitor's playback resolution (while playing) or paused resolution (while paused) and the sequence height: `Full` = original; `1/2` = the tier nearest to H/2; `1/4` = nearest to H/4; and so on.
  - If the tier does not exist yet, preview falls back to the next larger available tier, then the original, and queues proxy generation in the engine (native recipe: `docs/research/native-video-libraries.md` §5.3).
- **RND-031 [P0]** Local media resolution per platform: blob or object URLs from browser storage (web/PWA), engine-served `http://127.0.0.1:<port>/media/<assetId>/<tier>` (desktop, and web with a reachable engine), or remote URLs. The composition only ever sees final URLs in the `RenderDoc` asset table. The resolver runs before the doc is handed to the Player.
- **RND-032 [P0] Offline media.** When an asset has no reachable URL, the layer renders a red **Media Offline** card: the `--pr-offline-clip` color, white text with the file name, filling the layer's visible rect. Export must refuse, listing the offline assets, unless the user opts to render the placeholder.
- **RND-033 [P1] Loading state.** In the Player, media that is still buffering keeps the last shown frame. It never renders blank. In renders, the layer waits (the Remotion media components' built-in delay).

### 4.6 Global switches

- **RND-040 [P1]** `options.globalFxBypass = true` (the Program Monitor's **Global FX Mute** button, preview only) skips step 3 of §4.2 for every layer. Masks, motion, opacity and blend still apply. It never affects export.
- **RND-041 [P1]** `options.renderScale` (0.25..1) multiplies the composition's pixel size and all geometry, including fonts and effect radii in px, uniformly. The monitor may use it at 1/4 playback resolution on weak devices. It is not required at P0.

---

## 5. Per-clip-kind rendering rules

Clip kinds below are ours: `video`, `audio`, `image`, `animatedImage`, `text`, `shape`, `captions`, `motionGraphic`, `remotionGraphic`, `adjustment`. Each kind has one layer component in the composition and one entry in the **kind registry** (`packages/scene/kinds.ts`). The registry declares its capabilities, so the UI and agents never switch on the kind by hand:

```ts
type KindCapabilities = {
  visual: boolean; audio: boolean;
  croppable: boolean; hasNaturalMedia: boolean; visualFades: boolean; audioFades: boolean;
  supportsEffects: boolean; supportsMasks: boolean; supportsSpeed: boolean;
  defaultUniformScale: boolean;
  engines: {remotion: true; native: 'full' | 'partial' | 'none'; fframes: boolean};
  intrinsicGroups: PropertyGroupId[];   // which groups appear in Effect Controls (§13)
};
```

- **KND-001 [P0]** Adding a kind means adding one registry entry, one layer component and one native mapping (or `native: 'none'`). A compile-time exhaustiveness check over the kind union fails until all three exist.

### 5.1 `video`

- **KND-010 [P0]** Rendered with `@remotion/media` `<Video>`, falling back to `<OffthreadVideo>` in render contexts where the new media tags are unsupported. Verify for 4.0.499. The element fills the natural box, and object-fit is irrelevant because the box has the media's own aspect.
- **KND-011 [P0]** Audio from a video clip is played by the same element, with volume given as a per-frame callback: `gain(f) = dbToLinear(resolved gainDb at f) x audioFadeFactor(f) x (trackMuted ? 0 : 1)`. The callback's frame argument must be converted to clip-local `f`. Verify the offset semantics when a trim-before offset is set, and add a unit test.
- **KND-012 [P1]** Pan: preview through Web Audio (a stereo panner node per clip, when the media element exposes a Web Audio path), export through the ffmpeg `pan` / `stereotools` balance. If preview cannot pan (a platform limit), show a small "pan not previewed" badge in the Effect Controls row.
- **KND-013 [P0]** Rotation metadata: the displayed frame must already be upright (browsers apply container rotation). The natural box uses the upright display size (`DM-003`). The native path must apply `transpose` equivalently, or rely on ffmpeg autorotate, which is on by default. Add a golden test with a 90°-tagged phone clip.
- **KND-014 [P1]** Frame-accurate stills: when paused, the displayed frame must equal the frame export produces for the same timeline frame (±0 frames). Use a test harness that compares Player screenshots with engine stills (§24).
- **KND-015 [P1] Retime proxy.** For reverse, time remapping or frame blending, the engine produces an intermediate (native `setpts`/`reverse` segments, `minterpolate` for optical-flow blending) keyed by `hash(assetId, sourceIn, sourceOut, speedCurve)`. The layer plays it at speed 1. Until it is ready, preview shows the first frame of the clip with a "Rendering speed change…" badge in the monitor corner.

### 5.2 `audio`

- **KND-020 [P0]** No visual output and no overlay outline. Uses `@remotion/media` `<Audio>` with the same gain callback as `KND-011`. Audio clips have no `VisualLayerProps`. The property registry must report motion/opacity as unsupported for them.

### 5.3 `image`

- **KND-030 [P0]** Rendered with Remotion `<Img>` sized to the natural box. Loading waits for decode in renders. SVG images are rasterized by the browser at their natural size times the current effective scale, so they stay crisp when scaled up. Set the intrinsic size from the SVG's viewBox.
- **KND-031 [P1]** Very large images (over 8K on a side): the engine makes a downscaled preview tier, and preview uses it the same way video tiers are used.

### 5.4 `animatedImage` (GIF, animated WebP/AVIF)

- **KND-040 [P0]** Rendered with Remotion's public animated-image component (`@remotion/gif`, or `@remotion/animated-image` for WebP/AVIF; verify availability in 4.0.499). The source offset `sourceInSec` and `speed` **must** be honored: the frame shown at `f` is the animation frame at `sourceSec(f)`, looping modulo the animation duration when `loop` is on. After a split, the right half continues the animation. It does not restart. Add a test.

### 5.5 `text`

- **KND-050 [P0]** A DOM text block inside the natural box. Full rules are in §18. It waits for its fonts before the first render frame (Remotion `delayRender` until the font's `FontFace` resolves), in both Player and render.

### 5.6 `shape`

- **KND-055 [P0]** Rectangle, ellipse and solid (a full-frame rectangle). Polygon, star and line are [P1]. Rendered as inline SVG. Path geometry comes from `@remotion/shapes` (public). Properties: `size`, `fill` (color; gradient is [P2]), `stroke {color, width, position: inside|center|outside}`, `cornerRadius` (rect), `points`/`innerRadius` (polygon/star). A "Color Matte" is a shape of kind solid with `size = (W, H)` whose size follows the sequence size.

### 5.7 `captions`

- **KND-057 [P0]** See §19.

### 5.8 `motionGraphic` (fframes)

- **KND-060 [P0]** Params `{templateId, params, canvas}`, validated against the template's JSON Schema, which the engine's `jasper-mg schema` command provides (`docs/research/fframes.md` §7).
  - Natural box = the template canvas (for example 1920x1080 for `16x9`). When the sequence differs, initial `scale` fits it (`DM-004`).
  - **Preview**, in order of preference:
    1. The WASM bridge renders SVG for frame `f`, injected into the layer box. Params changes call the bridge's spec update. Its cost is ~37 µs/frame, so scrubbing is effectively free.
    2. If WASM is unavailable or the template needs raster features, the engine-rendered VP9-alpha WebM proxy (Chromium).
    3. A PNG-sequence or WebP sprite on Safari/iOS.
  - **Export**, in order of preference:
    1. The ProRes 4444 or PNG-sequence master from the engine, overlaid natively.
    2. The WASM SVG inside the Remotion render, when the whole export goes through Remotion.
  - The clip shows a render-state badge (`none | rendering n% | ready`) in the monitor and on the timeline.
- **KND-061 [P0]** Our `motion`, opacity, effects and blend apply on top of the template output, like any layer. Animated numeric or color params use our keyframes (`anim['params.<name>']`). They are passed to the template **as keyframe tracks inside the spec**, never as per-frame values, so native renders do not need per-frame spec updates. Each template maps its tracks through its own runtime-animation adapter.
- **KND-062 [P1]** Param edits debounce master re-rendering (500 ms after the last edit). Preview updates immediately through WASM.

### 5.9 `remotionGraphic` (React template)

- **KND-065 [P1] Beyond template.** A clip that renders one of our own registered React components, with props validated by a zod schema: title cards, lower thirds, charts. It is the Remotion counterpart of `motionGraphic`. Its Properties panel section is generated from the schema. Numeric and color props are animatable: resolved per frame, then passed as props. It is also the agent-authoring target for DOM graphics. Export: Remotion alpha intermediate, or the Remotion full render.

### 5.10 `adjustment` [P2]

- **KND-070 [P2]** A full-frame layer with no pixels of its own. Its effects apply to the composite of all layers below it within its time range. Preview: render the lower layers into an isolated group, then apply the adjustment's CSS/SVG filter chain to that group. Its opacity mixes the filtered and unfiltered composite. Native: split the filtergraph at the adjustment layer, then filter and blend.

### 5.11 Capability summary

| Kind | Crop | Effects | Masks | Speed | Native export | fframes |
|---|---|---|---|---|---|---|
| video | yes | yes | P2 | yes | full | no |
| audio | – | audio fx (audio spec) | – | yes | full | no |
| image | yes | yes | P2 | – | full | no |
| animatedImage | yes | yes | P2 | yes | full (`-ignore_loop 0`) | no |
| text | no (use masks) | yes | P2 | – | via Remotion intermediate | no |
| shape | no | yes | P2 | – | via Remotion intermediate (solid: native `color` source) | no |
| captions | no | yes | – | – | via Remotion intermediate, or native `subtitles`/ASS [P2] | no |
| motionGraphic | yes | yes | P2 | – | fframes master + native overlay | yes |
| remotionGraphic | yes | yes | P2 | – | Remotion intermediate | no |
| adjustment | – | yes | P2 | – | partial | no |

---

## 6. Program Monitor

Chrome layout, sizes and the button set follow `docs/research/premiere-ui-design-spec.md` §8. Both monitors share one `MonitorPanel` component with `mode: 'program' | 'source'`.

### 6.1 Player configuration

- **PGM-001 [P0]** The viewport hosts one `@remotion/player` `<Player>` with:
  - `component = SequenceComposition`, `inputProps = {doc, options}` (`ARC-003`), memoized so it only changes when the doc or options change;
  - `compositionWidth/Height` = the sequence size, `fps` = the sequence fps;
  - `durationInFrames = max(1, sequenceEndFrame)`. For an empty sequence, use 10 s of frames so the ruler stays usable;
  - `controls = false`, because we draw our own transport. Also turn off the Player's built-in click-to-play, double-click-to-fullscreen and space key handling. The keymap owns those;
  - `acknowledgeRemotionLicense` set, per our Remotion license tier;
  - `numberOfSharedAudioTags` sized to the maximum simultaneous audio layers expected (start with 8; verify the behavior in 4.0.499);
  - no `loop` by default. The loop state comes from the monitor's Loop toggle.
- **PGM-002 [P0]** The Player element is sized at the native composition size and scaled by CSS to the viewport scale (`PGM-012`). Overlays use the same scale and origin (`PGM-020`).
- **PGM-003 [P0] Transport integration.** Play/stop, JKL shuttle (rates ±1, 2, 4, 8, and ±0.25 slow shuttle while holding K), frame step (←/→, Shift for 5 frames), go to In/Out, and Play In to Out. All of them go through `playheadStore` actions, which call the Player ref. Rates beyond the Player's supported range fall back to timer-driven `seekTo` stepping, which shows proxy frames only. The keymap spec owns the key assignments.
- **PGM-004 [P0] Timecode displays.** Left: current time, clickable to type a timecode (accepts `HH:MM:SS:FF`, `+15` or `-1:00` relative, and a bare frame count after the user toggles Ctrl/Cmd-click frames mode). Right: the In→Out duration, or the sequence duration when no marks are set. Drop-frame formatting applies for 29.97/59.94 when the sequence says so.
- **PGM-005 [P1] Dropped-frame indicator.** A dot at the top-left of the frame: green, turning yellow when the Player reports a buffering/waiting state or when measured display frames lag by more than 2 frames over the last second. It stays yellow for 2 s after the last drop. Data comes from Player buffering events and the `frameupdate` cadence (verify event names in 4.0.499).
- **PGM-006 [P1] Export Frame.** The camera button opens a small dialog (name, format PNG/JPEG, "Import into project" checkbox). The frame is produced by, in order of preference:
  1. the engine's `renderStill` of `SequenceComposition` at the playhead frame, using original media;
  2. the in-browser still renderer, when there is no engine (verify `@remotion/web-renderer` still support);
  3. as a last resort, a canvas capture of the Player viewport, which requires that no cross-origin media taint the canvas.

  The output is at sequence resolution, excludes overlays, and uses the sequence background (transparent when set).
- **PGM-007 [P1] Gang Source/Program** (optional): when ganged, moving one monitor's playhead moves the other by the same delta.

### 6.2 Zoom, fit and pan

- **PGM-010 [P0]** The zoom dropdown offers `Fit`, 10, 25, 50, 75, 100, 150, 200, 400 and 800%. Program percentages are relative to sequence pixels (100% = one sequence pixel per CSS pixel, times devicePixelRatio when the "Pixel-accurate at 100%" preference is on).
- **PGM-011 [P0]** Ctrl/Cmd+wheel (and trackpad pinch) zooms around the cursor: the sequence point under the pointer stays under the pointer. Zoom steps are multiplicative, ×1.1 per wheel notch. `+`/`-` zoom around the viewport center. `0` or Shift+Z returns to Fit.
- **PGM-012 [P0] Fit.** `viewScale = min((vw − 2·pad)/W, (vh − 2·pad)/H)`, where `pad` is 16 px. The frame is centered. Fit recomputes on viewport resize and on sequence size change.
- **PGM-013 [P0]** When zoomed beyond fit, a plain wheel pans vertically, Shift+wheel pans horizontally, and the Hand tool (H), or holding Space while in the monitor, drags to pan. Space only pans when the pointer is over the monitor and the user starts dragging; a Space tap still toggles play.
- **PGM-014 [P0]** Pan is clamped so that at least 10% of the frame (or 48 screen px, whichever is larger) stays visible. The pan resets on Fit.
- **PGM-015 [P0]** A zoom change never changes the playhead and never triggers a Player re-render beyond the scale change.

### 6.3 Overlay layer

- **PGM-020 [P0]** The overlay layer is an absolutely positioned SVG (plus HTML for text inputs) covering the whole viewport, above the Player. It receives the current `viewScale` and `viewOrigin`, and draws in screen space with a helper `toScreen(p) = viewOrigin + p · viewScale`. Stroke widths and handle sizes are constant in **screen** px, independent of zoom.
- **PGM-021 [P0]** The overlay intercepts pointer events only where it has interactive elements: handles, the selected-layer body, and tools that capture the whole viewport, such as Type, Shape, Pen or Crop mode. Everything else passes through to the viewport's own handler (click-to-select, marquee).
- **PGM-022 [P0]** The overlay recomputes from `resolveSceneAt(doc, playheadFrame)` once per animation frame while the playhead moves. While playing, only outlines of selected clips are drawn. Handles are hidden during playback, matching Premiere, and reappear on pause.

### 6.4 Playback resolution and quality

- **PGM-030 [P0]** The playback resolution dropdown (`Full`, `1/2`, `1/4`, `1/8`) selects the preview media tier while playing (`RND-030`). Paused resolution (Settings menu) selects it while paused, and defaults to `Full`. Changing either takes effect without losing the playhead position.
- **PGM-031 [P1]** "High Quality Playback" off: while playing, the Player may skip effects marked `expensive` in the effect registry (§15), such as large blur radii, LUT shaders and masks with feather. A small "fx reduced" chip appears. Paused frames are always full quality.
- **PGM-032 [P1]** When the engine is unreachable (pure web/PWA), tiers other than `Full` are available only for assets whose proxies were made in-browser (mediabunny/WebCodecs transcode at 540p, background task). Otherwise the dropdown shows the tiers disabled, with a tooltip.

### 6.5 Settings (wrench) menu

- **PGM-040 [P0]** Items: Safe Margins, Transparency Grid, Show Rulers (Ctrl/Cmd+R), Show Guides (Ctrl/Cmd+;), Snap in Program Monitor (Ctrl/Cmd+Shift+;), Lock Guides, Guides ▸ (Add Guide…, Clear Guides, Manage…), Playback Resolution ▸, Paused Resolution ▸, High Quality Playback, Show Dropped Frame Indicator, Motion Paths, Pasteboard Content, Display Mode ▸ (Composite, Alpha; Scopes is [P2]), Loop, Show Transport Controls, and Comparison View [P2].
- **PGM-041 [P1] Alpha display.** Renders the composite's alpha as grayscale. Implementation: a CSS/SVG filter on the Player container that maps alpha to luminance over black. Useful for graphics work.

### 6.6 Drops onto the Program Monitor

- **PGM-050 [P1]** Dragging media or a template from the Project or Effects panel over the monitor shows a drop-zone overlay (Insert, Overwrite, Overlay, Replace, Place On Top, Append At End). The timeline spec executes the edit. Dropping an **effect** onto a layer under the pointer appends it to that clip's effect stack (`FX-010`). Dropping a **preset** applies it (`FX-030`).

### 6.7 Acceptance criteria (Program Monitor)

- AC-PGM-1: With a 1080p30 sequence of 3 video layers plus 2 text layers on a 12-core CPU without GPU, playback at `1/2` holds 30 fps (at most 1 dropped frame per 10 s) in Chromium and Electron.
- AC-PGM-2: For 20 random frames of a test project, a paused frame at `Full` is pixel-identical to `renderStill` of the same frame, or SSIM ≥ 0.995 where video decode differs.
- AC-PGM-3: Zooming with the wheel keeps the sequence point under the cursor fixed within 1 screen px.
- AC-PGM-4: Overlays stay aligned with the rendered layers within 1 screen px at every zoom level, with rotation, crop and non-uniform scale applied.

---

## 7. Source Monitor

- **SRC-001 [P0]** Opens one **asset** (master clip) at a time: double-click in the Project panel, double-click a timeline clip (which opens its asset at the clip's source In/Out; `Match Frame` [P1] also moves the source playhead to the matching frame), or `Shift+O`. The tab title is `Source: <name>`. The tab menu lists recently opened assets (at most 20), plus Close and Close All.
- **SRC-002 [P0]** Rendering uses a second `<Player>` with a tiny composition, `AssetComposition`, which shows one asset at its native size and fps:
  - video: with its audio;
  - image: a still. Its duration is the default still duration from preferences, 5 s;
  - audio: a full-width waveform drawn from engine-provided peaks, or browser-computed peaks (native recipe §5.5), plus a playhead;
  - motionGraphic / remotionGraphic templates: rendered with default params over the transparency grid.

  The Player's `compositionWidth/Height` equals the asset's natural size. Its fps is the asset's fps, falling back to the sequence fps for stills.
- **SRC-003 [P0] In/Out marks.** `I`/`O` set marks, `Alt+I`/`Alt+O` clear them, and `Ctrl/Cmd+Shift+X` clears both. Marks are stored **on the asset** (master clip), in the document, and are undoable, so they persist across sessions (Premiere behavior). The mini ruler shows `{` `}` brackets with a shaded range. Dragging the grip in the middle of the range moves both marks.
- **SRC-004 [P0] Edit hand-off.** Insert (`,`), Overwrite (`.`), and drag to the timeline or Program Monitor. The source monitor only emits `{assetId, inSec, outSec, components: 'av'|'v'|'a'}`. The timeline spec performs the edit. The Drag Video Only and Drag Audio Only handles start drags with `components` set.
- **SRC-005 [P1]** Zoom and playback resolution work as in the Program Monitor, relative to the asset's native size. On-canvas transform does not exist in Source. Overlays are limited to safe margins and the transparency grid.
- **SRC-006 [P1]** Source markers: `M` adds a marker at the source playhead, stored on the asset.
- **SRC-007 [P2]** Reference Monitor and Comparison View (side-by-side, vertical or horizontal split, with a reference frame chosen by timecode or from a clip) reuse `MonitorPanel` with a still `Thumbnail` (`@remotion/player` `<Thumbnail>`) of the reference frame.

Acceptance:
- AC-SRC-1: Marks set in Source survive reload, and are applied when inserting with `,`.
- AC-SRC-2: An audio-only asset shows its waveform within 1 s of opening for a 10-minute file (engine present).

---

## 8. Monitor overlays

- **OVL-001 [P0] Safe margins.** Two centered rectangles: action safe (default inset 5% per side) and title safe (default inset 10% per side), plus a small center cross. Stroke is 1 screen px `rgba(255,255,255,.55)`. Percentages are editable in sequence settings (`DM-021`). They are never rendered into export.
- **OVL-002 [P1] Rulers.** Horizontal and vertical rulers, 16 px, along the viewport's top and left edges, in sequence px with adaptive tick spacing (1, 2, 5 × 10^n chosen so labels are at least 60 screen px apart). The pointer position is marked on both rulers.
- **OVL-003 [P1] Guides.** Drag from a ruler to create a guide, drag a guide to move it, and drag it back onto a ruler to delete it. Double-clicking a guide opens a numeric editor (px or %). Guides are cyan, 1 screen px. Lock Guides disables dragging. Guides are sequence data (`DM-021`), so creating, moving and deleting them are undoable. Guides are snap targets (`SNP-002`).
- **OVL-010 [P0] Transparency grid.** A checkerboard (8 screen px squares, `#2b2b2b`/`#3a3a3a`) behind the frame. It is shown automatically when the sequence background is transparent, and can also be toggled manually.
- **OVL-020 [P1] Motion path.** For the selected clip, when `motion.position` has at least 2 keyframes: draw the path sampled at every frame of the clip as small dots (2 px). Dot spacing encodes speed. Keyframes are drawn as 7 px squares, filled when selected. Bezier spatial keyframes show tangent handles (`KF-030`). Dragging a key square edits that keyframe's position value. Dragging a tangent edits its spatial tangent. Alt-drag breaks tangent continuity.
- **OVL-030 [P1] Agent overlay (beyond template).** While an agent command touches a clip, draw a pulsing dashed outline in the agent accent color around that clip for 1.5 s, labeled with the agent's name. Implemented from agent command events (`AGT-030`).

---

## 9. On-canvas selection and transform

Tools referenced below come from the Tools panel (`docs/research/premiere-ui-design-spec.md` §10): Selection (V), Type (T), Rectangle/Ellipse (the Shape group), Pen (P), Hand (H), Zoom (Z). Crop mode and Anchor mode are monitor sub-modes.

### 9.1 Hit testing and selection

- **XF-001 [P0]** A click with the Selection tool picks the **topmost** layer whose quad (`DM-011`) contains the pointer at the current frame. Topmost means last in compositing order. Hidden tracks, disabled clips and audio clips are skipped. Locked tracks are skipped for selection and show a lock cursor. Text layers hit-test their box. Shapes hit-test their geometry (point-in-path for ellipses and polygons).
- **XF-002 [P1] Beyond template.** Alt/Option-click cycles the selection to the next layer below under the pointer (repeated clicks walk down the stack).
- **XF-003 [P0]** Shift-click or Ctrl/Cmd-click toggles a layer in the selection. Clicking empty frame or pasteboard area clears the selection, unless it starts a marquee.
- **XF-004 [P1]** A marquee drag starting on empty area selects all layers whose bounds intersect the marquee at the current frame. Shift adds to the selection.
- **XF-005 [P0]** Selection is shared with the timeline: selecting on canvas selects the clip on the timeline, and vice versa. If the selected timeline clip is not visible at the playhead, no canvas box is shown, but the Effect Controls panel still shows it.
- **XF-006 [P0]** Hover highlight: a 1 screen px outline in `--pr-accent` at 50% on the hovered layer's quad, when no drag is active.
- **XF-007 [P0]** Double-click with the Selection tool: a text layer enters text edit mode (`TXT-010`). A croppable layer enters Crop mode (`XF-040`). A motionGraphic or remotionGraphic layer focuses its params section in Properties.
- **XF-008 [P0]** Esc leaves any sub-mode (crop, text edit, anchor, mask edit) and returns to plain selection. A second Esc clears the selection.

### 9.2 Selection box and handles

- **XF-010 [P0]** For a single selected visual layer, draw:
  - the quad outline (1 screen px, `--pr-accent`);
  - 8 scale handles: white 7x7 screen px squares with a 1 px `--pr-accent` border, at the corners and edge midpoints of the quad, oriented with the layer;
  - the anchor crosshair: a 10 px circle with a cross at `M(A)`;
  - rotation zones: the area 6–20 screen px outside each corner, where the cursor becomes a rotate arrow (Premiere behavior). On touch and on request (preference "Show rotation handle"), also a round handle 24 px beyond the top edge midpoint.
- **XF-011 [P0]** For a multi-selection: one axis-aligned **group box** around the union of the layer bounds, with 8 handles and rotation zones. Each layer also gets a thin outline. The group anchor is the group box center.
- **XF-012 [P0]** Handles have a minimum hit area of 12 screen px (44 px on coarse pointers, `TCH-001`). When the quad is smaller than 24 screen px on a side, only corner handles show.
- **XF-013 [P0]** A dimension tooltip during a drag shows position (x, y of the anchor), scale %, rotation °, or crop %, depending on the gesture. It is placed 16 px from the pointer.

### 9.3 Move

- **XF-020 [P0]** Dragging inside a selected layer's quad (or any layer's quad, which selects it first) moves all selected layers: `P' = P0 + Δp`, with `Δp = Δscreen / viewScale`.
- **XF-021 [P0]** Shift constrains to the dominant axis once the pointer has moved 6 screen px from the start. The axis is re-evaluated if the user releases and presses Shift again.
- **XF-022 [P0]** Snapping applies (§10) unless snapping is off or Ctrl/Cmd is held during the drag. Premiere uses the same modifier-to-bypass convention.
- **XF-023 [P0]** Nudge: with the monitor focused and a layer selected, Ctrl/Cmd+Arrow moves it 1 sequence px and Ctrl/Cmd+Shift+Arrow moves it 5 px. Plain arrows keep their playback meaning (frame step). Each key press is one undo step, and repeated nudges within 800 ms coalesce into one step.
- **XF-024 [P0]** A move writes `motion.position` through the property write path (`PRP-020`). When position is animated, the move creates or updates a keyframe at the playhead, which may make the motion path visible.

### 9.4 Scale

- **XF-030 [P0] Scale about the anchor (default, Premiere parity).** For a handle whose layer-space point is `q_h`, define `d = q_h − A`. With pointer `p`, compute the unrotated local vector `u = R(−θ)(p − P)`, then:
  - corner handle, uniform scale on: `k = (u · Sd) / |Sd|²`, `s' = s0 · k` (projected, so there is no jitter off-diagonal);
  - corner handle, uniform off: `sx' = u.x / d.x`, `sy' = u.y / d.y`;
  - to avoid a jump on grab, `p` is the pointer position minus the initial offset between the pointer and the handle's screen position at pointer-down;
  - edge handle: only the matching axis changes. With uniform on, a vertical edge still changes `scale` uniformly (Premiere behavior). Shift temporarily inverts the uniform setting.
- **XF-031 [P0] Alt/Option: scale about the opposite handle.** Keep the opposite handle's sequence position fixed. Compute the new scale as above, using the opposite handle as the reference instead of `A`, then solve for the new position: `P' = p_opp − R·S'·(q_opp − A)`. This writes both scale and position, which is a keyframe on each if animated.
- **XF-032 [P0]** Scale is clamped to [0.1, 10000]%. Dragging through the anchor does **not** flip; it clamps at the minimum. Flips come from the Flip effects (`FX-051`).
- **XF-033 [P0]** Multi-selection scale about the group anchor `G` with factor `k`: each layer gets `P' = G + k(P − G)` and `s' = k·s`. Rotated layers keep their rotation.
- **XF-034 [P0] Text layers.** Handles scale point text (Motion scale). For paragraph text, handles in **text edit mode** resize the paragraph box instead (reflow, no scale). This distinction is shown by a different handle style: hollow squares for box resize.

### 9.5 Rotate

- **XF-035 [P0]** Dragging in a rotation zone rotates about the anchor's sequence position `Q = P`: `θ' = θ0 + (atan2(p − Q) − atan2(p0 − Q))`. The angle is unwrapped so continuous dragging accumulates multiple turns. Shift snaps θ' to 15° multiples. With monitor snapping on, θ' also snaps to multiples of 90° within ±2° (beyond template).
- **XF-036 [P0]** Multi-selection rotation about the group center `G`: positions rotate around `G`, and each layer's rotation gets the same delta.

### 9.6 Anchor point

- **XF-037 [P0]** Anchor mode, entered by dragging the anchor crosshair (or via "Edit Anchor Point" in the monitor context menu): dragging the crosshair moves the anchor **without moving the image**. `A' = A0 + S⁻¹R(−θ)Δp`, `P' = P0 + Δp`. Alt-drag changes only `A`: the crosshair stays at the Position and the image slides by `−R·S·δA` (useful to re-center content on a point). The crosshair snaps to the layer's visible-rect corners, edge midpoints and center, within 8 screen px.
- **XF-038 [P1]** Context menu entries: "Anchor to Center", and "Anchor to ▸ 9-point grid". Each keeps the image in place.

### 9.7 Crop mode

- **XF-040 [P0]** Crop mode is entered by double-click, by the crop icon in the Properties Crop section, or from the context menu. The layer's full natural box is shown as a ghost at 35% opacity (the full image), with the visible rect at full opacity. The overlay renders the ghost with a separate, non-committed preview doc in which crop is zero. Eight crop handles sit on the visible rect, drawn as L and T bracket shapes to distinguish them from scale handles.
- **XF-041 [P0]** Dragging a crop handle converts the pointer to layer space, `q = S⁻¹R(−θ)(p − P) + A`, and sets the corresponding inset: left = `q.x / w0`, right = `1 − q.x / w0`, and so on. Each inset is clamped to [0, 100)%, with `left + right ≤ 100% − 1px/w0` (same for vertical). Shift keeps the visible rect's aspect ratio.
- **XF-042 [P0]** Dragging inside the visible rect in crop mode **pans the content under a fixed window**: the insets shift by `δ = S⁻¹R(−θ)Δp` in layer units (left −= δx, right += δx, top −= δy, bottom += δy), and `P` shifts by `R·S·δ`, so the window stays put while the image slides. It is clamped so that no inset goes negative.
- **XF-043 [P0]** Crop is animatable. In crop mode, drags write keyframes when crop properties have their stopwatch on.
- **XF-044 [P0]** Crop snapping: crop edges snap to frame edges, safe margins, guides, and other layers' bounds (§10), as long as the layer is unrotated (θ mod 90 = 0). Rotated layers snap only to their own natural box edges.

### 9.8 Other canvas commands

- **XF-050 [P0]** Right-click on a layer: Cut, Copy, Paste, Paste Attributes…, Duplicate, Delete, Enable/Disable, Reset Motion, Reset Crop, Fit to Frame, Fill Frame, Set to Native (100%), Anchor ▸, Arrange ▸ (Bring to Front / Forward / Backward / to Back: moves the clip to a higher or lower track at the same time. The timeline spec defines track creation), Reveal in Timeline, Reveal in Project, Agent ▸ (`AGT-040`).
- **XF-051 [P0] Fit/Fill.** Set scale as in `DM-004` for the current visible rect (after crop), set `position` so the visible rect is centered, and leave `rotation` unchanged. When the layer is rotated, fit uses the rotated bounds.
- **XF-052 [P1] Align/Distribute** (Properties panel "Align and Transform" section, and toolbar): align to Frame (default for a single selection) or to Selection (default for a multi-selection): left, h-center, right, top, v-center, bottom, using the **visible bounds** after rotation. Distribute evenly by centers or by gaps, for 3 or more layers.
- **XF-053 [P0] Undo granularity.** Every drag gesture (move, scale, rotate, anchor, crop, crop-pan, guide drag) produces exactly **one** undo entry, labeled for the History panel ("Move", "Scale", "Rotate", "Crop", …). Intermediate frames are transient (`ARC-005`). Esc during a drag cancels it and restores the pre-drag values.

### 9.9 Creation tools in the monitor

- **XF-060 [P0] Type tool.** A click creates point text at the click point, a drag creates paragraph text with the dragged box, and either enters text edit mode immediately. The clip is placed at the playhead on the targeted video track (or the topmost free track), with the default graphic duration (5 s). The tool returns to Selection after the edit ends, unless the "Stay in tool" preference is on.
- **XF-061 [P0] Shape tools.** A drag creates a rectangle or ellipse with that bounding box. Shift constrains to square or circle. Alt draws from the center. The clip is placed like text.
- **XF-062 [P2] Pen tool.** Clicks add polygon points and drags add bezier points. Clicking the first point closes the path. It creates a `shape` (polygon/path) or, when a layer is selected and Mask Edit is active, a mask (§17).

### 9.10 Acceptance criteria (transform)

- AC-XF-1: On a layer rotated 37° with a 150%/80% non-uniform scale and a 20% left crop, dragging each of the 8 handles moves the handle under the cursor with at most 1 screen px error, at zoom 25%, 100% and 400%.
- AC-XF-2: Moving the anchor crosshair leaves every pixel of the rendered layer unchanged (screenshot diff = 0).
- AC-XF-3: A move, a rotate and a crop-pan are each exactly one undo step. Undo restores the exact prior numeric values.
- AC-XF-4: With position animated (2 keys), dragging at a playhead between keys creates a third key at the playhead, and the motion path updates live during the drag.

---

## 10. Spatial snapping (Program Monitor)

- **SNP-001 [P0]** Snapping is on when the monitor's "Snap in Program Monitor" setting is on (default on). Holding Ctrl/Cmd during a drag inverts it for that drag.
- **SNP-002 [P0] Targets.** X targets are vertical lines and Y targets are horizontal lines, from:
  1. frame edges and center (`0, W/2, W`; `0, H/2, H`);
  2. guides (`OVL-003`), when guides are visible;
  3. action-safe and title-safe edges, when safe margins are visible;
  4. other visible, unselected layers at the current frame: their bounds' min, center and max (beyond template: the starter snapped only to the frame);
  5. [P1] the selection's original position (a "return home" snap).
- **SNP-003 [P0] Candidates.** For move: the moving selection's bounds min, center and max on each axis. For scale or crop: only the edges being dragged (their axis-aligned extent for rotated layers). For the anchor: see `XF-037`.
- **SNP-004 [P0] Algorithm (per axis, independent).**
  - Compute every `(candidate, target)` pair distance `d = target − candidate` in sequence px.
  - Keep pairs with `|d| ≤ τ`, where `τ = 6 / viewScale` (6 screen px).
  - Choose the pair with minimal `|d|`. Break ties by preferring center-to-center, then frame targets, then guides, then safe margins, then layers.
  - Apply `d` to the proposed geometry. For move, offset the position. For scale, re-solve the scale so the snapped edge lands on the target (for a uniform scale that one axis drives k).
  - At most one snap per axis per pointer event.
- **SNP-005 [P0] Indicators.** For each applied snap, draw a line across the full frame (`--pr-snap-line`, 1 screen px, with a dark 1 px casing) for frame, guide and safe targets. For layer targets, draw a line spanning from the target layer's extent to the moving selection's extent, with small end ticks. Indicators clear on pointer-up.
- **SNP-006 [P1]** When the playhead is on a frame where the moving layer is animated, snapping uses resolved (animated) bounds of the other layers at that frame.
- **SNP-007 [P1] Beyond template.** Equal-spacing snap: when moving one layer between two others on an axis, snap so the gaps are equal, and show the gap labels.

Acceptance:
- AC-SNP-1: At 50% and 200% zoom, snapping engages within 6 ± 1 screen px of a target, and not beyond it.
- AC-SNP-2: With two targets at 3 px and 4 px, the 3 px target wins. With equal distance, center-to-center wins.

---

## 11. Property registry, resolved values, write path

This is the central abstraction. One registry drives the Effect Controls panel, the Properties panel, keyframe evaluation, canvas gizmos, agent tools (JSON Schema), and the native export mappings. (Beyond template: the starter had hand-written controls per field, and no animation.)

### 11.1 Property paths

- **PRP-001 [P0]** Every editable value of a clip is addressed by a **property path**: a dot-separated string that is stable across versions:
  - `motion.position`, `motion.scale`, `motion.scaleWidth`, `motion.uniformScale`, `motion.rotation`, `motion.anchor`
  - `opacity`, `blendMode`, `crop.left|top|right|bottom|edgeFeather`, `fades.inFrames|outFrames`
  - `audio.gainDb`, `audio.pan`
  - `effects.<fxId>.<paramId>`, `effects.<fxId>.enabled`
  - `masks.<maskId>.path|feather|opacity|expansion|inverted|mode` [P2]
  - `text.<field>` (see §18), `shape.<field>`, `captions.<field>`, `params.<name>` (templates)
- **PRP-002 [P0]** The registry maps **path patterns** to a `PropertySpec`:

```ts
type ValueKind = 'number' | 'vec2' | 'color' | 'enum' | 'boolean' | 'string' | 'path' | 'curve' | 'lut';
type PropertySpec<V> = {
  pattern: string;                 // e.g. 'motion.rotation' or 'effects.*.radius' (resolved via effect spec)
  label: string;                   // UI name, e.g. "Rotation"
  group: PropertyGroupId;          // 'motion' | 'opacity' | 'crop' | 'timeRemap' | 'audio' | 'text' | ... | effect id
  kind: ValueKind;
  unit?: 'px' | '%' | 'deg' | 'dB' | 'frames' | 's';
  range?: {min?: number; max?: number; softMin?: number; softMax?: number; step: number};
  animatable: 'continuous' | 'hold-only' | 'no';   // enums, booleans, strings: 'hold-only'
  defaultValue: V | ((clip, seq) => V);           // used by Reset (⟲)
  appliesTo: (clip) => boolean;                   // capability check (kind registry, effect presence)
  read: (clip) => V;                              // static (base) value
  write: (clip, v: V) => Clip;                    // returns a new clip; pure
  lerp?: (a: V, b: V, t: number) => V;            // absent => hold-only
  ui: {control: 'scrub' | 'slider' | 'vec2' | 'angle' | 'color' | 'select' | 'toggle' | 'text' | 'curve' | 'custom';
       display?: (v: V) => string; bipolar?: boolean};
  expensive?: boolean;                            // for PGM-031
};
```

- **PRP-003 [P0]** The registry exports a **JSON Schema** per clip (all applicable paths with types and ranges), generated from the specs. Agents use it, and the validator runs it on every external write (`AGT-010`).

### 11.2 Resolution

- **PRP-010 [P0]** `resolvePropertyAt(clip, path, f)`: if `clip.anim[path]` has at least one keyframe, evaluate it (§12.2). Otherwise return `read(clip)`. It is pure and allocation-free for static values.
- **PRP-011 [P0]** `resolveClipAt(clip, f) -> ResolvedClip`: the same shape as the clip, with all animated values baked in. It returns the **input object itself** when the clip has no animation. Layer components render only from `ResolvedClip`.

### 11.3 Write path (the only way UI and agents change properties)

- **PRP-020 [P0]** `applyPropertyEdit(clip, path, value, {f, mode})`, where `mode ∈ {'auto', 'base', 'keyframe'}`:
  - `auto` (UI default): if the property's stopwatch is on (`anim[path]` exists), upsert a keyframe at `f`. `f` must be within `[0, duration − 1]`, otherwise the edit is rejected with the reason `playhead-outside-clip`, and the UI shows the hint "Move the playhead over the clip to add a keyframe". If the stopwatch is off, write the base value.
  - `base`: always writes the base value. Allowed only when not animated, or explicitly used by "Offset all keyframes" [P1], which shifts every key by the same delta for numeric and vec2 kinds.
  - `keyframe`: forces a keyframe, and turns the stopwatch on if needed. This is the agent default when `atFrame` is given.
- **PRP-021 [P0]** Values are validated and clamped with `range`. Clamping is reported back to the caller (agents receive `{clamped: true, applied: v}`).
- **PRP-022 [P0] Multi-clip edits.** `applyPropertyEdit` over N clips writes each clip with its own local frame `f_i = playhead − clip_i.start`. In the Properties panel, a relative drag on a mixed value (`–`) adds the same delta to each clip's own value (`INS-004`).
- **PRP-023 [P0]** Every UI write is either **transient** (during a drag or scrub) or **committed** (on release, Enter, or a discrete change). Only committed writes create undo entries (`NFR-010`).

---

## 12. Keyframes

### 12.1 Model

```ts
type Interp = 'linear' | 'bezier' | 'autoBezier' | 'continuousBezier' | 'hold';
type Key<V> = {
  id: string;            // stable, unique within the project (agents address keys by id)
  t: number;             // clip-local frame (integer; see KF-003)
  v: V;
  inInterp: Interp;      // temporal interpolation of the segment arriving at this key
  outInterp: Interp;     // temporal interpolation of the segment leaving this key
  easeIn?: {influence: number; speed: number};   // 0..1, value-units/frame
  easeOut?: {influence: number; speed: number};
  spatial?: {inTangent: Vec2; outTangent: Vec2; mode: 'linear' | 'bezier' | 'auto' | 'continuous'}; // vec2 only
  roving?: boolean;      // [P2]
};
type KeyTrack<V> = {keys: Key<V>[]};             // sorted by t, unique t
type AnimationMap = Record<PropertyPath, KeyTrack<unknown>>;  // presence == stopwatch on
```

- **KF-001 [P0]** The stopwatch is on exactly when `anim[path]` exists, even with zero keys (a transient state; see `KF-041`).
- **KF-002 [P0]** Keys are unique per frame within a track. Upserting at an existing `t` replaces `v` and keeps `id` and the interpolation settings.
- **KF-003 [P0]** `t` is an integer clip-local frame. Keys may lie outside `[0, duration)` after trims. They are kept, drawn hatched in the mini-timeline, and still influence interpolation (Premiere keeps off-clip keys).

### 12.2 Evaluation (normative)

For track `K` at local frame `f`:

1. If `f ≤ K[0].t`, return `K[0].v`. If `f ≥ K[last].t`, return `K[last].v`.
2. Find `i` with `K[i].t ≤ f < K[i+1].t` by binary search.
3. Let `a = K[i]`, `b = K[i+1]`, `T = b.t − a.t`, `x = (f − a.t) / T`.
4. If `a.outInterp === 'hold'` or the spec has no `lerp`, return `a.v`.
5. Otherwise compute the progress `y` from the temporal easing:
   - both sides linear (`a.outInterp` and `b.inInterp` both `linear`): `y = x`;
   - otherwise use a cubic Bezier timing curve from `(0,0)` to `(1,1)`, with control points
     `c1 = (a.easeOut.influence, a.easeOut.influence · a.easeOut.speed · T / Δ)` and
     `c2 = (1 − b.easeIn.influence, 1 − b.easeIn.influence · b.easeIn.speed · T / Δ)`,
     where `speed` is measured along the direction of travel from `a` to `b` (positive = toward `b`), and `Δ` is the value distance of the segment: `|b.v − a.v|` for numbers, or the spatial arc length for vec2 with a spatial path. When `Δ = 0`, use `y = x`. Solve `x → y` with Newton's method plus bisection (use Remotion `Easing.bezier`, or an equivalent shared implementation in `packages/scene`, identical in Node);
   - the missing side of a mixed linear/bezier segment uses influence `1/3` with the linear-equivalent speed.
6. Return `lerp(a.v, b.v, y)`. For vec2 with spatial Bezier: return `pathPointAt(a, b, y)` (`KF-031`).

- **KF-010 [P0]** Evaluation is identical in the composition, overlays, panels and the engine. There is one implementation, in `packages/scene`, covered by golden unit tests.
- **KF-011 [P0]** `lerp` per kind:
  - number: linear;
  - angle: linear, without wrap, so 350→10 rotates −340° (Premiere semantics);
  - vec2: component-wise, unless spatial;
  - color: linear in linear-light sRGB, with alpha lerped separately;
  - enum/boolean/string: hold only;
  - path (masks, shapes): point-wise when point counts match (`@remotion/paths` interpolation is acceptable in preview), otherwise hold.
- **KF-012 [P0]** Colors are converted sRGB → linear → lerp → sRGB. This must be the same in every engine.

### 12.3 Interpolation presets

- **KF-020 [P0]** Right-click a key (or a selection of keys) ▸ **Temporal Interpolation** ▸ Linear, Bezier, Auto Bezier, Continuous Bezier, Hold, Ease In, Ease Out:
  - **Ease In** sets `inInterp = bezier`, `easeIn = {influence: 0.33, speed: 0}`.
  - **Ease Out** sets `outInterp = bezier`, `easeOut = {influence: 0.33, speed: 0}`.
  - **Auto Bezier** computes the speed at the key as the slope between its neighbors, `(v[i+1] − v[i−1]) / (t[i+1] − t[i−1])`. At local extrema (both neighbors on the same side) the speed is 0, which prevents overshoot. Influence is 1/3. It is recomputed whenever a neighbor changes.
  - **Continuous Bezier** means user-editable handles whose in and out speeds stay equal (a smooth tangent). **Bezier** means independent in and out handles.
  - **Hold** means the value jumps at the next key.
- **KF-021 [P1]** Spatial Interpolation (vec2 position and anchor) ▸ Linear, Bezier, Auto Bezier, Continuous Bezier, edited in the monitor motion path (`OVL-020`). The default for new position keys is **Auto Bezier spatial with Linear temporal**, which is Premiere's default feel.
- **KF-022 [P1] Graphs.** Twirling open a property shows its Value graph and Velocity graph in the mini-timeline, with draggable Bezier handles. Dragging a handle vertically changes speed, and horizontally changes influence (clamped to 0.01..1). Alt breaks the in/out link.

### 12.4 Spatial paths

- **KF-030 [P1]** vec2 keys with `spatial.mode ≠ 'linear'` define cubic Bezier path segments `a.v → a.v + a.outTangent → b.v + b.inTangent → b.v`. `auto` computes tangents Catmull-Rom style, `(next − prev) / 6`. `continuous` keeps `inTangent = −k · outTangent`.
- **KF-031 [P1]** `pathPointAt(a, b, y)` maps progress `y` to **arc length**: precompute a 64-sample arc-length table per segment, cached by segment content hash, so temporal easing controls speed along the path. Linear spatial segments degenerate to plain lerp.

### 12.5 Retiming on timeline edits (normative)

All timing edits must call one function, `retimeKeys(clip, op)`. The timeline spec owns the edits. This spec owns the key rules.

| Edit | Rule |
|---|---|
| Move clip in time | No change (keys are clip-local). |
| Trim/extend **head** by `Δ` frames (new start = old start + Δ, content stays put) | Every key `t -= Δ` for every track. Keys stay attached to the source content. Keys that fall outside the clip are kept (`KF-003`). |
| Trim/extend **tail** | No change. |
| Slip (content moves under a fixed clip, source offset changes by `Δs` frames) | Every key `t -= Δs`, so keys follow the content (Premiere behavior). A preference "Keyframes stay with clip on slip" disables this. [P1] |
| Split at local frame `s` | Both halves keep **all** keys (off-clip keys are allowed, `KF-003`). The right half shifts every key by `−s`. Both halves then evaluate exactly like the original at every frame, including eased segments, and no keys are synthesized. All copied keys in the right half get new ids. A [P1] command "Remove off-clip keyframes" deletes keys that lie outside the clip and are not needed to interpolate the visible range (the nearest outside key on each side is kept). |
| Constant speed change from `r0` to `r1` (duration rescales) | `t' = round(t · r0 / r1)`. Collisions from rounding merge, keeping the later key. |
| Duplicate, copy/paste, paste attributes | Deep copy with new key ids, effect instance ids and mask ids. Paths in `anim` are re-keyed to the new effect ids. |
| Delete effect | Remove all `anim['effects.<id>.*']` tracks. |

- **KF-040 [P0]** Every rule above has unit tests, including round trips (split then join [P2] reconstructs the curve within 1e−6 at sampled frames).
- **KF-041 [P0] Stopwatch toggle.**
  - **On**: create the track with one key at `clamp(f, 0, duration − 1)` holding the currently resolved value.
  - **Off**: show a confirm dialog "This will delete all existing keyframes. Continue?", with a "Don't ask again" option stored in preferences. On confirm, write the value resolved at the playhead into the base value and delete the track, as one undo entry.

---

## 13. Effect Controls panel

Layout and metrics: `docs/research/premiere-ui-design-spec.md` §11. This section specifies behavior.

### 13.1 Structure

- **EC-001 [P0]** Shows **one** clip: the most recently selected clip in the timeline or monitor. With several clips selected, it shows the last-selected one and a header chip "+N more (edit in Properties)". It never shows nothing when a selection exists. (Beyond template: the starter's inspector was blank for multi-selection.)
- **EC-002 [P0]** Header chips: `Source · <asset>` (master-clip effects, [P2]) and `<Sequence> · <clip>` (the timeline instance, active by default).
- **EC-003 [P0]** Sections, in order, each only when applicable (`appliesTo`):
  - **Video**:
    - `fx Motion`: Position, Scale, Scale Width, Uniform Scale, Rotation, Anchor Point, Anti-flicker Filter [P2];
    - `fx Opacity`: mask tools and mask list [P2], Opacity, Blend Mode;
    - `fx Crop` (intrinsic here; in Premiere it is an applied effect): Left, Top, Right, Bottom, Edge Feather;
    - `fx Time Remapping` [P1]: Speed, with a curve;
    - kind-specific intrinsic groups: `Text` (source text styling, §18), `Shape`, `Captions`, `Parameters` (templates);
    - applied video effects, in stack order.
  - **Audio**:
    - `fx Volume`: Level (dB), Bypass;
    - `fx Channel Volume` [P2];
    - `fx Panner`: Balance;
    - applied audio effects (owned by the audio spec, rendered here with the same row components).
- **EC-004 [P0] Effect header row**: twirl, **fx toggle** (bypass, `effects.<id>.enabled`; intrinsic effects can be bypassed too, except Motion, which is only reset), name, and a menu (Reset, Save Preset…, Copy, Delete, Move Up/Down) plus a reset button ⟲ on the right. The header row shows **summary keyframes** in the mini-timeline: the union of its properties' key times, drawn as gray reference diamonds that cannot be edited directly.
- **EC-005 [P0] Property row**:
  - twirl (only if the property has graphs), **stopwatch** (`KF-041`), label, value editor(s) (`EC-010`);
  - the **keyframe navigator** `◀ ◆ ▶`, shown when animated. ◀/▶ move the playhead to the previous/next key of this property; they are disabled at the ends. ◆ adds a key at the playhead with the current value, or removes the key under the playhead. The diamond is filled when the playhead is exactly on a key;
  - reset ⟲, which resets to `defaultValue`. When animated, reset writes a key at the playhead with the default value, as Premiere does.
- **EC-006 [P0]** Values shown are **resolved at the playhead** (`PRP-010`), and update live during playback, throttled to the display refresh. When the playhead is outside the clip, values show the clamped first or last value, dimmed.

### 13.2 Value editors

- **EC-010 [P0] Scrubby number.** Blue value text (`--pr-accent`):
  - Horizontal drag changes the value by `step` per 2 screen px. Shift ×10, Ctrl/Cmd ×0.1. The pointer is locked (Pointer Lock API) during the drag where supported, with a fallback that wraps at the window edge;
  - Click to type. Enter or Tab commits (Tab moves to the next field), Esc cancels. Input accepts arithmetic (`+10`, `*2`, `/3`, `-5`), applied relative to the current value;
  - Arrow Up/Down while focused steps (Shift ×10);
  - Double-click a bipolar slider resets it.
  One drag equals one undo entry.
- **EC-011 [P0] vec2.** Two scrubby numbers (x, y). Linked editing for scale and size shows a chain icon.
- **EC-012 [P0] Angle.** A scrubby number displayed as `n x d°` for multi-turns, plus a small dial on twirl-open (drag the dial to set the angle).
- **EC-013 [P0] Color.** A swatch (24x16) that opens a picker with HSV area, hue strip, alpha, hex input, eyedropper (EyeDropper API where available; otherwise a click on the monitor that samples the paused frame from an engine still or canvas), and recent colors.
- **EC-014 [P0] Select, toggle, text.** Dropdown, checkbox, or single-line or multi-line text.
- **EC-015 [P1] Curve and LUT pickers** (color, §20). Custom editors are registered by `ui.control: 'custom'` plus a component id.

### 13.3 Mini-timeline (right pane)

- **EC-020 [P0]** Its own ruler covering the clip range when **Pin to Clip** is on (default). With it off, it shows the sequence ±2 s around the clip. It has its own zoom (a zoom bar like the monitor's) and pan. The playhead is blue and shared with `playheadStore`. Dragging in the ruler scrubs.
- **EC-021 [P0]** Clip range: a gray bar with the clip name. The regions outside the clip are hatched.
- **EC-022 [P0]** Keyframe glyphs (9x9 px) per property row. The shape encodes interpolation:
  - diamond: linear/linear;
  - hourglass: bezier or continuous;
  - circle: auto bezier;
  - square: hold on the outgoing side;
  - half shapes for mixed in/out.
  Selected keys are `--pr-keyframe-selected`.
- **EC-023 [P0] Key interaction.**
  - Click selects, Shift/Ctrl-click toggles, and a marquee in the pane selects several keys.
  - Dragging moves the selected keys in time, by whole frames, snapping to the playhead, other keys, clip edges and markers (Shift disables the snap). A tooltip shows the delta and the resulting time. Moving onto an existing key's frame of the same property replaces that key on drop.
  - Alt-drag duplicates.
  - Delete/Backspace removes the selected keys, or the selected effect when no keys are selected.
  - Ctrl/Cmd+C/V copies and pastes keys at the playhead, preserving relative timing, onto the same property paths of the target clip, or onto the selected property when the kinds match.
  - Double-click a key moves the playhead to it.
- **EC-024 [P1]** Right-click a key: Temporal Interpolation ▸, Spatial Interpolation ▸ (vec2), Ease In, Ease Out, Copy, Delete, "Go to key".
- **EC-025 [P1]** Footer:
  - the current time;
  - a Filter menu: Show All, Only Animated, Only Modified (different from the default);
  - the "Play only this clip's audio" and "Loop" toggles.

### 13.4 Effect stack operations in the panel

- **EC-030 [P0]** Drag an effect header to reorder it among applied effects. Intrinsic groups are fixed and cannot be reordered. A drop indicator line shows the target slot. Reordering is one undo entry and is reflected immediately in the preview.
- **EC-031 [P0]** Dropping an effect from the Effects panel into the Effect Controls panel inserts it at the drop position.
- **EC-032 [P0]** Copying and pasting an effect header (Ctrl/Cmd+C/V) copies the effect with its params and keyframes to all selected clips.

### 13.5 Acceptance criteria (Effect Controls)

- AC-EC-1: The stopwatch on Opacity at frame 10 creates a key with the current value. Changing the value at frame 40 creates a second key. Playback shows a linear ramp, and the Program Monitor, the Properties panel and `renderStill` all agree at frames 10, 25 and 40.
- AC-EC-2: Easing a key (Ease Out) changes the value at the midpoint as the Bezier math predicts (unit-tested table), and the glyph changes shape.
- AC-EC-3: Splitting a clip with animated position between two keys produces two clips whose concatenated motion is identical to the original at every frame (max error 0.001 px).
- AC-EC-4: With 30 applied properties and 500 keys, scrubbing the playhead updates the panel at ≥ 50 fps on the reference machine.

---

## 14. Properties panel (context-sensitive inspector)

JasperEditor's primary inspector (Premiere v25+ style). It uses the same registry and write path as Effect Controls, but without the mini-timeline. Keyframing here uses a ◆ toggle per property.

- **INS-001 [P0]** Nothing selected shows **Sequence** properties: frame size (with presets 16:9 1080p/4K, 9:16, 1:1, 4:5, custom; a swap button), fps (23.976, 24, 25, 29.97, 30, 50, 59.94, 60), background (black, color, transparent), safe-margin percentages, guides list, and a duration readout. Changing size asks: "Keep layer sizes" or "Scale layers proportionally", which multiplies positions and scales.
- **INS-002 [P0]** One visual clip shows these sections:
  - **Transform** (Position, Scale, Rotation, Opacity, Anchor, with alignment buttons);
  - **Crop**;
  - **Speed & Duration** (media kinds);
  - **Blend Mode**;
  - kind sections (Text, Shape, Captions, Parameters);
  - **Effects** (a summary list with fx toggles; click to jump to Effect Controls);
  - **Quick actions** (Fit, Fill, Reset, "Agent: auto-reframe" [P2]).
- **INS-003 [P0]** One audio clip shows Volume (clip gain), Pan, quick fades, Speed.
- **INS-004 [P0] Multi-selection (beyond template).** Shows the intersection of applicable properties. Equal values display normally. Differing values show `–`; typing a value sets all of them, and dragging applies a **relative** delta to each. Kind-specific sections appear only when every selected clip supports them. Align and Distribute appear (`XF-052`).
- **INS-005 [P0]** Every numeric field uses `EC-010` behavior. Every property row has a ◆ toggle, which behaves as the stopwatch plus "add key at playhead", and ◀ ▶ when animated, so users can keyframe without opening Effect Controls. The same data is used, so the two panels stay in sync.
- **INS-006 [P1]** Section open/closed state persists per section id in the workspace preferences (not per clip).
- **INS-007 [P1] Speed & Duration.** Speed %, a duration field, Reverse, "Ripple edit, shifting trailing clips" (delegated to the timeline spec), and time interpolation (Frame Sampling / Frame Blending / Optical Flow; the last two produce retime proxies, `KND-015`). A speed change must rescale keyframes (`KF` table) and respect the next clip on the track, as defined by the timeline spec.

Acceptance:
- AC-INS-1: Selecting 3 clips with scales 50/80/100 shows `–`. Dragging +10 gives 60/90/110 as one undo step.
- AC-INS-2: A sequence size change with "Scale layers proportionally" keeps every layer at the same relative frame position (verified by comparing normalized bounds).

---

## 15. Effects stack and effect registry

### 15.1 Model

```ts
type AppliedEffect = {id: string; effect: EffectTypeId; enabled: boolean; params: Record<string, unknown>};

type EffectSpec = {
  id: EffectTypeId;                 // e.g. 'blur.gaussian'
  label: string; category: EffectCategory;   // 'Adjust' | 'Blur & Sharpen' | 'Color Correction' | 'Distort' | 'Generate' | 'Keying' | 'Stylize' | 'Transform' | 'Utility'
  kinds: 'video' | 'audio';
  params: ParamSpec[];              // each becomes PropertySpec 'effects.<instanceId>.<param>'
  badges: {realtime: boolean; native: boolean};  // shown in Effects panel (premiere-ui-design-spec §12)
  preview: {css?: (p) => string; svgFilter?: (p, uid) => SvgFilterDesc; webgl?: ShaderDesc; wrap?: 'component-id'};
  native?: {filter: (p, ctx) => string; animatable: 'expr' | 'sendcmd' | 'segment' | false} | null;
  bounds?: (p, rect) => Rect;       // how much the effect expands the drawn area (blur, shadow)
  expensive?: boolean;
};
```

- **FX-001 [P0]** The effect registry is data plus pure functions in `packages/scene/effects`. Preview realizations are produced by the composition (CSS `filter` chains, inline SVG `<filter>` elements with unique ids, WebGL wrappers [P1]). Native realizations are strings that the engine inserts into the filtergraph.
- **FX-002 [P0]** Consecutive effects that are all CSS-expressible are merged into one CSS `filter` string. Any SVG-filter effect breaks the chain. Each segment gets its own wrapper element, which preserves order (`RND-010`).
- **FX-003 [P0]** Disabled effects (`enabled = false`) are skipped everywhere. `globalFxBypass` skips all of them in preview only.

### 15.2 Applying effects

- **FX-010 [P0]** An effect is applied by:
  - dragging it from the Effects panel onto a timeline clip, a layer in the Program Monitor (the target is the topmost layer under the pointer, highlighted while hovering), or the Effect Controls panel;
  - double-clicking it with clips selected;
  - an agent command.

  It is appended at the end of the stack unless a drop position is given. Applying to N clips is one undo entry.
- **FX-011 [P0]** Remove: Delete/Backspace in Effect Controls with the effect selected, or its menu. Remove Attributes… (timeline context menu) opens a dialog of checkboxes (Motion, Opacity, Crop, each applied effect, Volume, Panner), which resets or removes the chosen items across all selected clips.
- **FX-012 [P0] Paste Attributes…** copies from the clipboard clip a checkbox list (intrinsics plus effects). A "Scale attribute times" option rescales key times to the target clip's duration (Premiere option).

### 15.3 Presets

- **FX-030 [P1]** "Save Preset…" on one or more effect headers saves `{effects: AppliedEffect[], anim subset, intrinsic values chosen}` as JSON in the user's preset library, with a name and a type (Scale, Anchor to In Point, Anchor to Out Point). This decides how key times map when the preset is applied to clips of other durations. Presets show in Effects ▸ Presets and are the same format agents use (`AGT-020`).

### 15.4 v1 effect catalogue

| Effect id | Params | Preview | Native (ffmpeg) | Phase |
|---|---|---|---|---|
| `blur.gaussian` | radius px, repeat edge pixels (bool), dimensions (both/h/v) | CSS `blur()`. For one-direction blur or repeat-edge, an SVG `feGaussianBlur` with `stdDeviation="x y"` plus `edgeMode` | `gblur=sigma=r:sigmaV=` | P0 |
| `adjust.brightnessContrast` | brightness −100..100, contrast −100..100 | SVG `feComponentTransfer` linear slope/intercept (mapping per FX-040) | `eq=brightness:contrast` | P0 |
| `adjust.hueSat` | hue °, saturation %, lightness | CSS `hue-rotate()` `saturate()` | `hue=h:s`, `eq=saturation` | P0 |
| `adjust.blackWhite` | amount % | CSS `grayscale()` | `hue=s=0` blended by amount | P0 |
| `stylize.invert` | amount % | CSS `invert()` | `negate` + blend | P0 |
| `color.tint` | map black to, map white to, amount | SVG `feColorMatrix` | `colorchannelmixer` / `lutrgb` | P0 |
| `transform.flipH` / `flipV` | – | CSS `scale(-1,1)` inside the layer box | `hflip` / `vflip` | P0 |
| `blur.sharpen` | amount | SVG `feConvolveMatrix` | `unsharp` | P1 |
| `stylize.dropShadow` | color, opacity, direction °, distance, softness | CSS `drop-shadow()` | alpha split + `gblur` + `overlay` (graphics route) | P1 |
| `generate.vignette` | amount, midpoint, roundness, feather | radial-gradient overlay | `vignette` (approximate) or alpha-mask overlay | P1 |
| `keying.colorKey` / `ultraKey` | key color, tolerance, softness, spill | WebGL shader | `colorkey` / `chromakey` + `despill` | P2 |
| `transform.transform` | position, anchor, scale, rotation, opacity, shutter [P2] | nested transform wrapper | `scale`/`rotate`/`overlay` in layer space | P1 |
| `color.lumetri` | see §20 | LUT shader / SVG approx | `lut3d` + `vignette` + `unsharp` | P2 |
| `distort.mirror`, `stylize.mosaic`, `stylize.posterize`, `stylize.glow` | … | SVG/WebGL | ffmpeg equivalents | P2 |
| `transition.*` | timeline spec | – | `xfade` | timeline |

- **FX-040 [P0] Canonical parameter math.** Each effect's params map to engine-specific values through one documented mapping function per engine, with golden tests (§24.3). Example: brightness `b ∈ [−100, 100]` adds `b/100 · 0.5` in sRGB-encoded space in both engines. CSS gets an SVG `feComponentTransfer` linear `intercept` (not CSS `brightness()`, which multiplies), and ffmpeg gets `eq=brightness=b/200`. Where two engines cannot match within the tolerance, the effect declares `native: null` and is routed through the Remotion intermediate (§21).
- **FX-041 [P0] Effect bounds.** Effects that spread (blur, shadow, glow) declare `bounds`. Layer quads for hit-testing stay the visible rect. Render wrappers must be at least as large as `bounds`, so nothing is clipped at the box edge.
- **FX-050 [P0] Audio effects** use the same stack model, rendered by the audio spec. Only the UI rows are shared with this spec.
- **FX-051 [P0]** Flips are effects, not negative scale (`XF-032`).

Acceptance:
- AC-FX-1: For each P0 effect, a golden-frame test compares the Remotion still with the native ffmpeg output on a reference image and a video frame. SSIM ≥ 0.98 is required, or the effect is marked `native: null`.
- AC-FX-2: Reordering blur before or after tint produces visibly different results, identically in preview and export.

---

## 16. Blend modes

- **BLD-001 [P0]** Modes are grouped as in Premiere:
  - Normal, Dissolve;
  - Darken, Multiply, Color Burn, Linear Burn, Darker Color;
  - Lighten, Screen, Color Dodge, Linear Dodge (Add), Lighter Color;
  - Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix;
  - Difference, Exclusion, Subtract, Divide;
  - Hue, Saturation, Color, Luminosity.
- **BLD-002 [P0] Preview.** CSS `mix-blend-mode` covers Normal, Multiply, Screen, Overlay, Darken, Lighten, Color Dodge, Color Burn, Hard Light, Soft Light, Difference, Exclusion, Hue, Saturation, Color and Luminosity, plus `plus-lighter` for Linear Dodge (Add). These are **Tier A**.
- **BLD-003 [P1]** **Tier B** modes (Dissolve, Linear Burn, Darker Color, Lighter Color, Vivid Light, Linear Light, Pin Light, Hard Mix, Subtract, Divide) have no CSS equivalent:
  - Preview: a WebGL track compositor (P2), or until then an approximation (the nearest Tier A mode) with a warning badge "Approximate in preview" in Effect Controls and on the monitor corner.
  - Export: native ffmpeg `blend` (`linearlight`, `vividlight`, `pinlight`, `hardmix`, `subtract`, `divide`, `burn`), with both inputs converted to planar RGB with alpha before blending. Blending YUV planes would give wrong colors.
- **BLD-004 [P0]** Native Tier A mapping: Normal, Multiply, Screen, Overlay, Darken, Lighten, Difference, Exclusion, Color Dodge (`dodge`), Color Burn (`burn`), Hard Light, Soft Light, and Add (`addition`) through `blend` on full-frame RGBA layers. The layer is padded to the frame with transparent pixels before blending. Hue, Saturation, Color and Luminosity have no ffmpeg `blend` mode, so they route through the Remotion intermediate for that time range (`ENG-020`).
- **BLD-005 [P0]** A blend mode blends a layer with the composite of **all layers below it** in the sequence. The layer's opacity applies before blending. Keyframing the blend mode is hold-only.

Acceptance:
- AC-BLD-1: For each Tier A mode, a 2-layer test frame matches between the Remotion still and the native export within SSIM 0.99, except for modes routed through Remotion.

---

## 17. Masks [P2]

- **MSK-001** Each visual layer has an ordered list of masks: `{id, name, shape: 'ellipse'|'rect'|'bezier', path (layer-space points, normalized 0..1 of the natural box so crop and resize keep the shape), feather px, opacity %, expansion px, inverted, mode: add|subtract|intersect|difference|none}`. All numeric fields and `path` are animatable.
- **MSK-002** UI: in Effect Controls › Opacity, three tool icons (ellipse, rectangle, pen) create a mask centered on the layer. The mask list rows have a mode dropdown, an Inverted checkbox, and Feather/Opacity/Expansion values. The selected mask shows its path in the monitor with vertex handles, a feather ring handle and an expansion handle. Vertex editing: drag vertices, Alt-click toggles corner/smooth, Ctrl-click on a segment adds a vertex.
- **MSK-003** Preview: an inline SVG `<mask>` per layer, applied with CSS `mask`. Feather is a blur filter on the mask's paths, expansion is a stroke-and-fill or morphology operation, and modes are realized by composite ordering. Export: rasterize the mask per frame in the engine (a tiny SVG→PNG renderer, resvg, shared with the fframes stack), then use `alphamerge`. Alternatively, route masked layers through the Remotion intermediate (simplest first).
- **MSK-004** Mask tracking (Premiere "Track Selected Mask Forward") is an engine job (OpenCV-based, later). It writes a `masks.<id>.path` keyframe track. It is out of scope until the OpenCV adoption decision.

---

## 18. Text and graphics

### 18.1 Model

```ts
type TextProps = {
  content: string;                              // plain text; runs are [P1]
  runs?: {start: number; end: number; style: Partial<TextStyle>}[];   // [P1] per-range overrides
  style: TextStyle;
  box: {mode: 'point'} | {mode: 'paragraph'; width: number; height: number; overflow: 'clip' | 'grow'};
  measured: {w: number; h: number};             // natural box, written by the editor after layout (DM-003)
};
type TextStyle = {
  fontFamily: string; fontWeight: number; fontStyle: 'normal' | 'italic';
  fontSize: number;                             // px at scale 100%
  fill: {color: string; enabled: boolean};
  strokes: {color: string; width: number; position: 'outside' | 'center' | 'inside'; enabled: boolean}[];  // P0: 1 stroke
  shadow?: {color: string; opacity: number; angle: number; distance: number; blur: number; enabled: boolean}; // [P1]
  background?: {color: string; opacity: number; padX: number; padY: number; radius: number; mode: 'block' | 'perLine'; enabled: boolean};
  tracking: number;                             // 1/1000 em
  leading: number;                              // line height multiplier
  align: 'left' | 'center' | 'right' | 'justify';
  verticalAlign?: 'top' | 'middle' | 'bottom';  // paragraph only [P1]
  direction: 'ltr' | 'rtl' | 'auto';
  caps: 'none' | 'all' | 'small';               // [P1]
};
```

### 18.2 Behavior

- **TXT-001 [P0] Layout source of truth.** Text layout runs in the browser (DOM) at edit time and at render time, with identical CSS in both. `measured` is updated after each committed text or style change and is used as the natural box (`DM-003`) for transforms, handles and snapping. The render uses real layout. `measured` is used only for geometry, so a mismatch (for example a font fallback) shows up as a warning, not as clipping.
- **TXT-002 [P0] Growth direction.** When `measured` changes, keep the anchor at the same **fractional** position of the box, where the fraction follows the alignment: left → x 0, center → 0.5, right → 1; vertically → 0.5. Then left-aligned text grows to the right, centered text grows both ways, and the visual anchor stays put. `position` is unchanged.
- **TXT-003 [P0] Stroke.** Rendered with `-webkit-text-stroke` and `paint-order: stroke fill` for outside strokes, so strokes do not eat into glyphs. Center strokes do not reorder the paint, and inside strokes use an SVG text fallback [P1]. Multiple strokes [P1] use stacked text copies.
- **TXT-004 [P0] Background box.** `block` draws one rounded rectangle behind the whole text box. `perLine` draws a rounded box per line, with the corners merged (as in social-media captions). `@remotion/rounded-text-box` is an acceptable public helper for `perLine`.
- **TXT-005 [P0] Fonts.**
  - Google Fonts load on demand through `@remotion/google-fonts` (a per-family import, loading only the weights used).
  - Desktop: local system fonts, enumerated by the engine and served as files, and registered with `@remotion/fonts`.
  - User-uploaded font files are assets.

  `RenderDoc.fonts` lists `{family, weight, style, url}` for every used face. The composition blocks rendering until they load (`KND-050`). A missing font falls back to a default sans font, and shows a yellow "Missing font" badge on the clip and in the Properties panel.
- **TXT-006 [P0] Font picker.** Search, recently used, favorites, a live sample in the list, and weight/style dropdowns filtered to the family's available faces. Hovering a family in the list previews it on the selected layer through a transient patch (`ARC-005`) without committing. Leaving or pressing Esc restores the original. Clicking commits.
- **TXT-007 [P0] Animatability.**
  - Continuous: colors (fill, stroke, background, shadow), stroke width, background padding and radius, shadow params.
  - Hold-only at P0: layout-affecting props (`fontSize`, `tracking`, `leading`, `content`, `fontFamily`). To animate size, users should animate Motion › Scale, and the UI shows that hint on the stopwatch tooltip.
  - [P2]: continuous layout props, with per-frame layout in the composition. `measured` then becomes a per-frame resolved value.

### 18.3 Inline editing

- **TXT-010 [P0]** Enter edit mode by double-clicking a text layer, by pressing Enter with one text layer selected and the monitor focused, or after creating text with the Type tool (`XF-060`).
- **TXT-011 [P0]** The editor is a `contenteditable` element (or a textarea) in the **overlay layer**, positioned with the layer's full matrix (`DM-012`) and styled with the resolved text style. While it is open, the composition hides that clip's text through a transient doc flag, so glyphs are never doubled. The caret goes to the click position. Ctrl/Cmd+A selects all. IME composition and RTL input are supported. Point text re-measures as you type (the box grows per `TXT-002`). Paragraph text wraps at the box width.
- **TXT-012 [P0]** Exit and commit: Esc, a click outside the layer, or switching tools. Exit and cancel: none (Premiere has no cancel; the user undoes). The whole edit session is **one** undo entry ("Edit Text"). If the content is empty on exit, the clip is deleted as part of the same undo entry.
- **TXT-013 [P1]** With runs support: selecting a range and changing style in Properties writes a run override. Otherwise changes apply to the whole layer.
- **TXT-014 [P1]** Spell-check underline (browser native) is on in edit mode only.

### 18.4 Shapes and graphic layers

- **TXT-020 [P0]** Shape properties (§5.6) appear in a `Shape` section. Resizing a shape with handles changes Motion scale by default. A preference "Resize shapes by size" makes handles edit `shape.size` instead, keeping the stroke width constant (beyond template).
- **TXT-021 [P2] Graphic groups** (Premiere graphics with several layers in one clip): out of scope. Use multiple clips on multiple tracks, or `remotionGraphic` templates.

Acceptance:
- AC-TXT-1: Typing into right-aligned point text keeps the right edge fixed on screen (±1 px).
- AC-TXT-2: A project using a Google font renders identically in the Player and in `renderStill` (SSIM ≥ 0.995). The render log shows the font loaded before frame 0.
- AC-TXT-3: Undo after a 20-keystroke edit session restores the pre-edit text in one step.

---

## 19. Captions

The transcription itself (whisper.cpp, cloud ASR) belongs to a sibling spec. This spec covers the caption clip's rendering, styling and editing.

### 19.1 Model

- **CAP-001 [P0]** A caption **asset** stores tokens `{text, startMs, endMs, confidence?}`, compatible with the public `Caption` type of `@remotion/captions`. Leading spaces are stored in `text`, as that package expects, so word joining is lossless. A `captions` clip references the asset and holds:
  - `offsetMs`: shifts all tokens relative to the clip start;
  - `paging`: `{maxPageMs (default 1500), maxChars (default 32, 0 = off), breakOnSentence: boolean}`;
  - `lingerMs`: default 300, how long a page stays after its last token when there is a gap;
  - `lineLimit`: default 2;
  - `style`: a `TextStyle` (§18.1) plus `activeWord: {mode: 'color' | 'box' | 'scale' | 'underline' | 'none', color, boxColor, scale}`, `inactiveOpacity`, `transform: 'none' | 'upper'`;
  - `placement`: `'bottom' | 'middle' | 'top' | 'custom'` (preset positions inside title-safe);
  - `animation`: `'none' | 'popIn' | 'wordFade' | 'karaoke'` [P1].

### 19.2 Rendering rules

- **CAP-010 [P0] Paging.** Tokens are grouped into pages greedily. A page closes when adding the next token would exceed `maxPageMs` measured from the page's first token start, or exceed `maxChars`, or when the previous token ends a sentence (`.?!…`) and `breakOnSentence` is on. `createTikTokStyleCaptions` from `@remotion/captions` may be used for the duration-only rule. The char and sentence rules are ours.
- **CAP-011 [P0] Page timing, all in ms, converted to frames once.** A page is visible from `pageStart = firstToken.startMs + offsetMs` until `min(nextPageStart, lastToken.endMs + offsetMs + lingerMs)`. Frames are computed as `floor(ms / 1000 · fps)`, relative to the clip start, and clipped to the clip range. Mixing ms and frames anywhere else is a bug. Add unit tests at 23.976, 30 and 60 fps.
- **CAP-012 [P0] Active word.** A token is active while `startMs ≤ t < endMs`, where `t` is the clip-local time in ms plus the offset. Styling per `activeWord.mode`. Inactive tokens use `inactiveOpacity` (default 100%).
- **CAP-013 [P0] Fit.** The font size starts at `style.fontSize`. If the page does not fit within `lineLimit` lines at the caption box width, shrink it to the largest size that fits (`@remotion/layout-utils` fit-on-N-lines helper), down to 50% of the style size. Below that, wrap anyway and flag "Caption overflow" on the clip.
- **CAP-014 [P0]** The caption box is a visual layer: Motion, Opacity, effects and blend apply. `placement` presets set `position` within title-safe. `custom` leaves it to the user.

### 19.3 Editing

- **CAP-020 [P0] Transcript section** (Properties panel): a virtualized list of pages, each showing its tokens as editable chips. The user can:
  - edit a token's text inline;
  - split a token at the caret (the time is split proportionally to character count);
  - merge it with the next token;
  - delete a token (its time goes to its neighbors);
  - nudge a token or page start/end by ±1 frame or by typed ms;
  - "Shift all" by ms.

  Clicking a token seeks the playhead to its start. The active page is highlighted during playback.
- **CAP-021 [P1]** Low-confidence tokens (confidence < 0.6) are underlined in orange in the Transcript list.
- **CAP-022 [P1]** Inline editing on the monitor: double-clicking a caption page opens the page text in the overlay editor. On commit, the token text is re-tokenized, keeping the times of unchanged words and distributing time proportionally for changed spans.
- **CAP-023 [P1]** Import SRT/VTT to a caption asset. Export SRT/VTT from a caption clip (`serializeSrt` from `@remotion/captions` is acceptable for SRT), with times offset by clip start and `offsetMs`.
- **CAP-024 [P1] Style presets** ("Bold pop", "Minimal", "Karaoke"…) are presets in the `FX-030` format, scoped to captions.

Acceptance:
- AC-CAP-1: A 60 s transcript at 29.97 fps shows no page for longer than `maxPageMs + lingerMs`, and every page starts on the frame `floor(startMs·fps/1000)`.
- AC-CAP-2: Editing a word's text updates the monitor without changing any other token's timing.

---

## 20. Color (Lumetri-like) and scopes [P2 unless noted]

### 20.1 Design: a canonical color pipeline baked to a LUT

- **CLR-001** Color correction is an applied effect, `color.lumetri`, so it gets stack order, bypass, keyframes and presets for free. There is also a **Lumetri Color panel**, a dedicated UI with collapsible sections and per-section enable checkboxes, that edits that effect on the selected clip. It creates the effect if absent.
- **CLR-002** Sections and params:
  - **Basic**: Input LUT (`.cube`), Temperature, Tint, Exposure (stops), Contrast, Highlights, Shadows, Whites, Blacks, Saturation, Vibrance.
  - **Creative**: Look LUT, Intensity, Faded Film, Sharpen, Shadow Tint, Highlight Tint.
  - **Curves**: master plus R, G and B monotone splines; Hue-vs-Sat [P3].
  - **Color Wheels**: Shadows, Midtones, Highlights (offset plus luminance).
  - **Vignette**: Amount, Midpoint, Roundness, Feather.
  - **HSL Secondary**: [P3].
- **CLR-003 Canonical math.** All **point-wise** operations (everything except Sharpen and Vignette) are defined once in `packages/color` as a pure function `gradePixel(rgb, params) -> rgb`. Order: Input LUT → White balance (channel gains in linear light) → Exposure (multiply by 2^stops in linear) → tone (contrast pivot at 18% gray in log2 space; highlights, shadows, whites and blacks as smooth luminance-weighted curve adjustments) → Saturation and Vibrance (mix with Rec.709 luma; vibrance weighted by 1 − current saturation) → Curves → Wheels (lift/gamma/gain) → Look LUT (mixed by Intensity) → Faded film. The function is **baked into a 33³ 3D LUT** whenever params change.
- **CLR-004 Engines.**
  - **Native export**: write the baked LUT as `.cube` and apply `lut3d=file=…:interp=tetrahedral`, then `unsharp` for Sharpen and a vignette overlay mask for Vignette. This gives exact parity with preview, because both use the same LUT.
  - **Preview** options, pick by verification:
    - (a) a WebGL shader sampling the baked LUT on the layer's video frame (needs frame access from the media component, or a canvas-based video layer);
    - (b) on devices without WebGL or frame access, an **engine-rendered graded proxy** (the native LUT applied to the proxy tier), used when paused or as the playback tier;
    - (c) an SVG `feComponentTransfer` approximation (per-channel 1D curves only), marked "approximate".
  - Option (a) is the default if verification (§27 item 1) passes.
- **CLR-005** Keyframed color params: the LUT is baked per unique param set. For animated ranges, the engine segments the clip into runs of frames with ≤ 0.5% LUT difference and uses `sendcmd`/segment concatenation. Preview re-bakes per frame in a worker (a 33³ LUT bakes in < 5 ms target).
- **CLR-006** Exports tag color explicitly (bt709 primaries/transfer/matrix, tv range), as in the native recipe §5.10. HDR and ACES are out of scope.

### 20.2 Scopes [P2]

- **CLR-020** A Lumetri Scopes panel: Waveform (luma/RGB), RGB Parade, Vectorscope (YUV), Histogram. Scopes are computed in a Worker from a downscaled (max 480 px wide) RGBA snapshot of the current Program frame. When paused, the snapshot comes from an engine still (`PGM-006` path) or a canvas capture. While playing, it updates at ≤ 10 Hz from proxy frames or not at all (a user option). Graticule, colors and layout follow the design spec §14.
- **CLR-021** Display Mode ▸ Scopes in the Program Monitor settings shows the scopes in place of the picture.

---

## 21. Engine parity and export routing

The export UI and encoding live in the engines/export spec. This section defines how this spec's rendering rules map to each engine, so the export planner can route work.

### 21.1 Route planner

- **ENG-001 [P0]** For an export range, the engine computes **segments**: maximal time ranges where the set of active layers, and their routes, is constant. Segment boundaries sit at clip starts and ends, and at the start and end of any animated range that forces a route change.
- **ENG-002 [P0]** Each visual layer in a segment gets a route:
  - `native`: the kind is natively supported (`KND` table), and every applied effect has a native realization whose `animatable` capability covers its animation. Motion animation is `native` when all motion tracks are linear or hold (expressible as per-frame expressions), or when sampled piecewise-linear within 0.25 px / 0.1° error (`ENG-032`).
  - `remotion`: text, shape, captions, remotionGraphic, masks [P2], Tier B-in-preview-only blend modes, and effects with `native: null`. These layers render through `@remotion/renderer` as an **alpha intermediate** (ProRes 4444 or PNG sequence) of just that layer, or of a run of adjacent remotion-routed layers when no native layer sits between them. The intermediate is then overlaid natively. Motion is baked into the intermediate at full frame size.
  - `fframes`: motionGraphic layers use the template master (ProRes 4444 or PNG sequence) at the template canvas size. Our Motion transform, effects and blend are then applied natively on top, as for any media layer.
- **ENG-003 [P0]** When **every** layer in the whole export is routed `remotion`, skip native compositing and render once with `@remotion/renderer` (`renderMedia`). Exception: when there is no engine at all (pure web), `@remotion/web-renderer` renders everything, and effects it cannot draw show a pre-export warning list (verify its support for CSS filters, SVG filters, blend modes and masks).
- **ENG-004 [P1]** The timeline's render bar (timeline spec) shows the route per segment: green means a cached intermediate exists, yellow means native real-time, red means it needs an intermediate. This is the Premiere render-bar metaphor applied to our routes.

### 21.2 Native mapping of the layer pipeline (§4.2)

- **ENG-030 [P0]** Per native layer, in order:
  1. Source: an input with seek and duration. Speed goes through `setpts`, a constant rate.
  2. `fps` normalization.
  3. `crop` (natural box insets, in pixels).
  4. Effect filters (§15.4 native column).
  5. `format=rgba` or `yuva444p`.
  6. `scale` by `sx, sy`.
  7. `rotate` about the center, with transparent fill and output size grown to the rotated bounds.
  8. Opacity through alpha multiplication (`colorchannelmixer=aa=`, or `geq` for animated opacity).
  9. `fade` in/out on alpha for quick fades.
  10. `overlay` (Normal) or pad-to-frame + `blend` (other modes), at the offset that places the anchor at `P`.

  The overlay offset for the rotated, scaled layer must be derived from the same matrix `M` (§3.2): the top-left of the rotated bounds is `min over corners of M(corner)`.
- **ENG-031 [P0]** Filter order must follow `RND-010`. Golden tests compare a native frame with the Remotion still for each transform combination: rotation × non-uniform scale × crop × anchor offset.
- **ENG-032 [P0] Animated motion natively.**
  - Linear segments become piecewise expressions over `t`. `overlay` x/y, `rotate` a, and `scale` w/h with `eval=frame` accept expressions.
  - Bezier-eased segments are sampled per frame and reduced (Ramer–Douglas–Peucker) to a piecewise-linear approximation within tolerance, then emitted as nested `if(between(t,…))` expressions.
  - If the expression size exceeds a limit (default 4 KB per filter), fall back to `sendcmd` with per-frame commands. If that fails, route the layer to `remotion`.
- **ENG-033 [P0] Parity harness.** `pnpm test:parity` renders N sample frames of a fixture project set through `renderStill` (Remotion) and through the native path. It compares them with ffmpeg `ssim`, with a per-fixture threshold (default 0.98) stored next to the fixture. It runs in CI on Linux x64 without a GPU.

### 21.3 fframes specifics

- **ENG-040 [P0]** The template library, WASM bridge and CLI are defined in `docs/research/fframes.md` §7. This spec requires:
  - `jasper-mg schema` output, which becomes the `params.*` property specs (`PRP-002`);
  - keyframe tracks passed through the spec (`KND-061`);
  - `renderState` on the clip, updated from engine progress events.
- **ENG-041 [P1]** When WASM preview and the tiny-skia master differ (text rasterization, filters), the master wins in native exports and the WASM SVG wins in Remotion exports. The Properties panel shows "Preview may differ slightly from export" for templates flagged `rasterSensitive`.

---

## 22. Agent control surface

Agents (in-app, the daemon, and MCP clients) drive the same write path as the UI. (Beyond template: the starter had no programmatic surface.) The agent API spec owns transport and auth. This section defines the commands for this spec's domain.

- **AGT-001 [P0]** All commands are JSON messages validated against schemas generated from the property and effect registries (`PRP-003`). Unknown paths, out-of-range values and type mismatches return structured errors: `{code, path, message, allowed?}`.
- **AGT-002 [P0] Commands (this spec's domain):**

| Command | Payload | Notes |
|---|---|---|
| `clip.getProperties` | `{clipId, atFrame?}` | Returns base values, `anim` tracks and resolved values at `atFrame` (timeline frame). |
| `clip.setProperty` | `{clipId, path, value, atFrame?, mode?}` | `PRP-020`. `atFrame` given → `keyframe` mode by default. |
| `clip.setProperties` | `{clipId, values: {path: value}, atFrame?}` | Atomic multi-property write. |
| `keys.add` / `keys.update` / `keys.remove` | `{clipId, path, keys: [{t or atFrame, v, inInterp?, outInterp?, easeIn?, easeOut?, spatial?}]}` / `{keyIds…}` | Returns key ids. |
| `keys.setInterpolation` | `{keyIds, temporal?, spatial?, preset?: 'easeIn' / 'easeOut' / 'easyEase'}` | |
| `anim.setStopwatch` | `{clipId, path, on}` | Off bakes the value at the playhead (or `atFrame`). |
| `effects.list` | `{}` | The catalogue with params schemas, engine badges and phase availability. |
| `effects.apply` | `{clipIds, effect, params?, index?}` | Returns instance ids. |
| `effects.remove` / `effects.reorder` / `effects.setEnabled` | … | |
| `presets.apply` | `{clipIds, preset (inline JSON or id)}` | `FX-030` format. |
| `transform.fit` / `transform.fill` / `transform.align` / `transform.distribute` | `{clipIds, to?: 'frame' / 'selection', edge?}` | `XF-051`/`XF-052` semantics. |
| `text.set` | `{clipId, content?, style?: Partial<TextStyle>}` | Re-measures in the browser session; returns the new `measured`. |
| `captions.editTokens` | `{clipId, edits: [...]}` | `CAP-020` operations. |
| `monitor.snapshot` | `{frame, width?, format?}` | Returns a PNG or JPEG of the rendered frame without overlays, for vision-model self-checks. It uses `PGM-006` routes. |
| `monitor.layout` | `{frame}` | Returns resolved layer quads, bounds, visibility and z-order at a frame, for spatial reasoning ("is the title overlapping the face?"). |
| `monitor.setView` | `{zoom?, playbackResolution?, overlays?}` | UI convenience, not undoable. |

- **AGT-010 [P0] Batching.** A command envelope `{batch: Command[], label}` applies atomically and creates one undo entry named `Agent: <label>`. When any command fails validation, none are applied.
- **AGT-011 [P0] Frame addressing.** Agents address time in timeline frames (`atFrame`). Conversion to clip-local frames is done by the handler. Agents may also pass seconds (`atSec`), which are converted with `floor(sec · fps)`.
- **AGT-012 [P1] Key reduction.** When an agent sends dense per-frame keys (for example from tracking data), the handler may reduce them with RDP within a caller-given tolerance, and reports the resulting count.
- **AGT-020 [P1]** Presets and effect stacks are exchangeable as JSON, so agents can author them.
- **AGT-030 [P1] Visibility.** Every applied agent command emits an event (`{agentId, label, clipIds, paths}`) that drives the agent overlay (`OVL-030`) and a History panel entry with an agent icon.
- **AGT-040 [P1]** The canvas context menu `Agent ▸` offers prompts scoped to the selection ("Animate in from left", "Make this a lower third", "Match color to clip…"). The UI sends the selection plus `monitor.layout` context to the agent runtime.

Acceptance:
- AC-AGT-1: An agent batch that fades a title in (two opacity keys), moves it (two position keys with ease out) and applies a drop shadow shows as one undo entry, and undo restores the prior document exactly (deep-equal).
- AC-AGT-2: `monitor.snapshot` at frame N equals the Program Monitor's paused frame N (SSIM ≥ 0.995).

---

## 23. Touch and PWA adaptations

Shells and breakpoints: `docs/research/premiere-ui-design-spec.md` §19.

- **TCH-001 [P0]** On coarse pointers, handle hit areas are 44 px and visual handles are 12 px. Rotation uses an explicit rotation handle (`XF-010`). Hover states are absent, so the first tap on a layer selects it and a second drag moves it.
- **TCH-002 [P0] Gestures on a selected layer in the viewer.**
  - One-finger drag moves it.
  - Two-finger pinch scales it uniformly about the pinch midpoint mapped to the layer (position is adjusted accordingly).
  - Two-finger twist rotates it (with a 5° dead zone, then snaps to 0/90/180/270 within 3°).
  - All three combine within one gesture, which is one undo step.
  - Pinch or pan on **empty** viewer area zooms or pans the view instead.
- **TCH-003 [P0]** Snapping on touch always runs, with `τ` = 10 screen px, and gives haptic feedback where available (`navigator.vibrate(10)`), otherwise a visual pulse on the snap line.
- **TCH-004 [P0]** Property editing uses bottom sheets with large sliders and numeric chips, which call the same write path. The keyframe ◆ button in the transport row toggles a key for the property currently open in the sheet. The mini-timeline is replaced by key diamonds drawn on the selected timeline clip, where tapping one seeks to it and long-pressing it opens interpolation and delete options.
- **TCH-005 [P0]** Text edit on touch opens the on-screen keyboard. The viewer scrolls or shrinks so the edited layer stays visible above the keyboard (Visual Viewport API).
- **TCH-006 [P1]** The Effect Controls panel is not shown on phones. The Properties sheet exposes stopwatch, ◆ and ◀ ▶ per property. Effects are added from an Effects sheet by tapping.

---

## 24. Non-functional requirements

### 24.1 Performance

- **NFR-001 [P0]** Overlay drag latency: pointer event to repainted handles in ≤ 16 ms at 60 Hz, with up to 30 visible layers.
- **NFR-002 [P0]** `resolveSceneAt` for 50 layers with 10 animated properties each takes ≤ 1 ms per frame on the reference CPU (Node benchmark in CI).
- **NFR-003 [P0]** Static clips never re-render during playback (verified by a React Profiler test: 0 commits for static layers across 60 frames).
- **NFR-004 [P0]** A document change during a drag re-renders only affected layers. Per-clip layer components are memoized on the resolved clip identity.
- **NFR-005 [P1]** The WASM fframes bridge, SVG filters and WebGL resources are created once per clip and effect and released when the clip leaves the premount window.

### 24.2 Undo, persistence, collaboration

- **NFR-010 [P0]** One committed gesture or command equals one undo entry, with a human-readable label. Transient updates never reach history. Undo/redo restores the document, then re-validates the selection (`DM-022`).
- **NFR-011 [P0]** All new document fields (`VisualLayerProps`, `anim`, `effects`, `masks`, text/caption styles, guides) are part of the versioned project schema. Every change to them ships with a migration step and a round-trip test (save → load → deep-equal).
- **NFR-012 [P0]** Ids (clips, keys, effect instances, masks, guides) are globally unique strings (for example 21-character random, URL-safe). Copy, paste and duplicate always regenerate them (`KF` table).

### 24.3 Testing

- **NFR-020 [P0]** Unit tests: every `KF` evaluation rule, every retime rule, transform math (`XF-030`…`XF-042`) including rotation and crop, snapping selection (`SNP-004`), caption paging and timing (`CAP-010`…`CAP-012`), color bake determinism (`CLR-003`).
- **NFR-021 [P0]** Golden-frame tests: preview vs `renderStill` (DOM parity), and Remotion vs native (`ENG-033`), for a fixture set covering every clip kind, every P0 effect, the Tier A blend modes, and transform combinations.
- **NFR-022 [P1]** Interaction tests (Playwright in Chromium, also run inside Electron): drag handles and assert numeric values, and undo counts.

### 24.4 Accessibility and input

- **NFR-030 [P0]** All property editors are keyboard reachable, expose `role="spinbutton"` or `slider` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax` and a label, and announce the unit. Keyframe navigator buttons have labels ("Previous keyframe for Opacity").
- **NFR-031 [P1]** A selected layer can be transformed entirely from the keyboard: nudge (`XF-023`), plus numeric entry in Properties.
- **NFR-032 [P0]** Numbers display with the locale decimal separator, and input accepts both `.` and `,`.

---

## 25. Where this goes beyond the template

| Area | Template baseline (behavioral summary) | JasperEditor |
|---|---|---|
| Transform model | Box position and size in frame pixels, rotation about the box center, no scale or anchor | Premiere Motion: position of the anchor, scale %, uniform/non-uniform, anchor point, one matrix shared by all engines (`DM-010`…`DM-012`) |
| Animation | None (fixed fades only) | Keyframes on every continuous property, stopwatch, navigator, temporal and spatial Bezier, motion paths, retiming rules (§12) |
| Inspector | Hand-built per kind; blank for multi-selection | A registry-driven Properties panel plus the Effect Controls panel with mini-timeline, and multi-selection with mixed values (§13, §14) |
| Canvas manipulation | Move and resize, unrotated math, snapping to frame only | Rotation-aware scale, rotate zones, anchor mode, crop pan, snapping to layers, guides, safe margins, equal spacing, Alt-cycle selection, marquee, nudge (§9, §10) |
| Overlays | Drawn inside the composition | A separate overlay layer: rulers, guides, safe margins, transparency grid, motion paths, dropped-frame indicator, agent overlay (§8) |
| Preview quality | Always original media | Playback and paused resolution backed by native proxy tiers, high-quality toggle, retime proxies (§6.4, `KND-015`) |
| Monitors | One canvas | Program and Source monitors, In/Out on assets, export frame, alpha display, [P2] comparison and scopes (§6, §7) |
| Effects | None | An effects stack with registry, presets, paste/remove attributes, a v1 catalogue with engine badges (§15) |
| Blend modes, masks | None | Tier A/B blend modes (§16), masks (§17, P2) |
| Text | Single style, plain box | Point/paragraph modes, strokes, shadows, per-line backgrounds, runs [P1], growth by alignment, font hover preview, missing-font handling (§18) |
| Captions | Pages by duration, one highlight color | Char and sentence paging, linger, active-word modes, transcript editing, SRT/VTT, presets, consistent ms→frame math (§19) |
| Color | None | A canonical LUT pipeline with exact preview/export parity, scopes (§20) |
| Engines | Remotion only | Routing across Remotion, native ffmpeg and fframes with a parity harness (§21) |
| Agents | No API | Schema-validated commands, batching, snapshots and layout queries, visible agent actions (§22) |

---

## 26. Phases and work packages

| WP | Title | Requirements | Depends on |
|---|---|---|---|
| WP-03.1 | Scene core: transform math, kind registry, resolved clips, compositing order | ARC-001, ARC-011, DM-001…DM-012, PRP-010, PRP-011, RND-001…RND-026, KND-001 | document-model spec |
| WP-03.2 | Composition and per-kind layers (video, audio, image, animatedImage, text, shape) | ARC-002, ARC-003, KND-010…KND-055, RND-030…RND-033 | WP-03.1 |
| WP-03.3 | Program Monitor shell: Player, playhead store, zoom/fit/pan, transport hookup, timecode | PGM-001…PGM-015, ARC-010 | WP-03.2, keymap |
| WP-03.4 | Overlay layer: selection, hover, handles, move, scale, rotate, anchor, nudge, undo granularity | PGM-020…PGM-022, XF-001…XF-037, XF-050…XF-053 | WP-03.3 |
| WP-03.5 | Snapping and overlays: safe margins, grid, rulers, guides | SNP-001…SNP-006, OVL-001…OVL-010 | WP-03.4 |
| WP-03.6 | Crop mode | XF-040…XF-044 | WP-03.4 |
| WP-03.7 | Property registry, write path, Properties panel (static values), multi-select | PRP-001…PRP-023, INS-001…INS-005 | WP-03.1 |
| WP-03.8 | Keyframe engine: evaluation, interpolation, retime rules | KF-001…KF-020, KF-040, KF-041 | WP-03.7 |
| WP-03.9 | Effect Controls panel with mini-timeline and key editing | EC-001…EC-032 | WP-03.8 |
| WP-03.10 | Text editing and fonts; shapes; Type and Shape tools | TXT-001…TXT-012, TXT-020, XF-060, XF-061 | WP-03.4, WP-03.7 |
| WP-03.11 | Captions rendering, styling, transcript editing | CAP-001…CAP-020 | WP-03.2, WP-03.7 |
| WP-03.12 | Effects stack: registry, v1 P0 catalogue, apply/remove/paste attributes | FX-001…FX-012, FX-040…FX-051 | WP-03.7 |
| WP-03.13 | Blend modes Tier A | BLD-001, BLD-002, BLD-004, BLD-005 | WP-03.12 |
| WP-03.14 | Source Monitor | SRC-001…SRC-006 | WP-03.3 |
| WP-03.15 | Playback resolution via proxies; offline media; export frame | PGM-030…PGM-032, PGM-006, RND-032 | engine proxies |
| WP-03.16 | fframes motionGraphic clip (WASM preview, masters) | KND-060…KND-062, ENG-040, ENG-041 | engine + fframes WPs |
| WP-03.17 | Native route mapping and parity harness | ENG-001…ENG-004, ENG-030…ENG-033 | engines/export spec |
| WP-03.18 | Agent commands for this domain | AGT-001…AGT-040, OVL-030 | agent API spec, WP-03.9, WP-03.12 |
| WP-03.19 | Touch adaptations | TCH-001…TCH-006 | WP-03.4, WP-03.7 |
| WP-03.20 | Spatial keyframes, motion path, graphs, presets | KF-021, KF-022, KF-030, KF-031, OVL-020, FX-030 | WP-03.9 |
| WP-03.21 | Tier B blend modes, masks, adjustment layers | BLD-003, MSK-001…MSK-004, KND-070 | WP-03.13 |
| WP-03.22 | Color: canonical LUT pipeline, Lumetri panel, scopes | CLR-001…CLR-021 | WP-03.12, engine |
| WP-03.23 | remotionGraphic templates | KND-065 | WP-03.7 |

Phase mapping:
- **Phase A (first usable editor):** WP-03.1–03.7, 03.10, 03.11, 03.14.
- **Phase B (Premiere motion parity):** WP-03.8, 03.9, 03.12, 03.13, 03.15, 03.18, 03.19.
- **Phase C (three engines):** WP-03.16, 03.17, 03.23.
- **Phase D (advanced):** WP-03.20, 03.21, 03.22.

---

## 27. Open questions and items to verify during implementation

1. **Remotion 4.0.499 surface.** Confirm:
   - Player buffering event names (for `PGM-005`);
   - negative and high `playbackRate` limits (JKL);
   - `numberOfSharedAudioTags` behavior with `@remotion/media`;
   - the frame-argument semantics of the volume callback when a trim-before offset is set (`KND-011`);
   - whether `@remotion/media` `<Video>` exposes decoded frames (for WebGL color, `CLR-004a`);
   - animated WebP/AVIF component availability (`KND-040`);
   - still rendering in `@remotion/web-renderer`, and its support for CSS filters, SVG filters, `mix-blend-mode` and CSS masks.
2. **Overlay-outside-Player alignment.** The Player's internal scaling must be disabled or matched: we size the Player at native resolution and apply our own CSS scale. Verify that `getContainerNode()` geometry and our `viewOrigin` stay in sync under devicePixelRatio ≠ 1 and browser zoom.
3. **Premiere parity details to confirm:**
   - whether direct manipulation scales about the anchor in all cases (we assume yes, with Alt for opposite-corner);
   - Esc behavior in text edit;
   - whether the stopwatch-off confirmation text matches.
4. **Brightness/contrast canonical mapping (`FX-040`).** Pick curves that ffmpeg `eq` can match within SSIM 0.98. If it cannot, route through SVG/Remotion intermediates.
5. **Pasteboard content (`RND-004`).** Measure the cost of the double render. Drop it if playback suffers, since it is paused-only anyway.
6. **Caption paging vs. `@remotion/captions` behavior.** If its page builder cannot be combined with char and sentence limits, implement paging entirely ourselves (it is a small function).
7. **Text layout in the engine.** Native routes never lay out text (text is always `remotion`-routed), so no Node text shaping is needed. Keep it that way.
8. **Tier B blend preview via a WebGL compositor.** It requires rendering each track to a texture. Evaluate feasibility inside the Remotion Player (canvas-based layer compositing) before committing to P2.
