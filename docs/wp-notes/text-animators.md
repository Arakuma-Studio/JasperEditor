# text-animators — After Effects text animators, text on a path, typography

Branch `feat/text-animators`, ports 49320–49329. Reference studied and ported: EffectCraft `crates/text/src/selectors.rs`,
`crates/text/src/path_text.rs`, `crates/render/src/text.rs`, `crates/text/src/layout.rs`, `crates/project/src/build.rs`,
`crates/engine/src/commands/text_anim.rs`, `crates/engine/presets/text_animators.json` (record:
`licenses/ported/text-animators.md`).

## 1. Design

### 1.1 Model (`packages/project`)

All new data is optional on the text clip (no schema version bump; absent = none):

| Field | Schema | What |
|---|---|---|
| `animators[]` | `schema/text-animators.ts` `TextAnimatorGroupSchema` | `{id: tan_…, name, enabled, properties, selectors[]}` |
| `animators[].properties` | `TextAnimatorPropertiesSchema` | only the properties added; Animatables (`position`, `positionZ`, `anchor(Z)`, `scale(Z)`, `skew`, `skewAxis`, `rotation`, `rotationX/Y`, `opacity`, `fillColor`, `fillHue/Saturation/Brightness/Opacity`, `strokeColor`, `stroke…`, `strokeWidth`, `tracking`, `lineAnchor`, `lineSpacing`, `characterOffset`, `characterValue`, `blur`, `axes.<tag>`) and static popups (`trackingType`, `characterAlignment`, `characterRange`) |
| `animators[].selectors[]` | `TextSelectorSchema` | `range` (start/end/offset, units %/index, basedOn, mode, amount, shape, smoothness, easeHigh/Low, randomize, randomSeed), `wiggly` (mode, max/min amount, basedOn, wiggles/second, correlation, temporal/spatial phase, lock dimensions, seed), `expression` (basedOn, amount with `expression`) |
| `pathOptions` | `TextPathOptionsSchema` | `{maskId, reversePath, perpendicularToPath, forceAlignment, firstMargin, lastMargin}` — the path is a **mask of the clip** (shared Bezier model `path/model.ts` from the masks workstream; mode `none` = guide only, as in AE) |
| `moreOptions` | `TextMoreOptionsSchema` | anchor point grouping, grouping alignment (animatable), fill & stroke order, inter-character blending |
| `perCharacter3d` | boolean | enables Z, X/Y rotation (AE "Enable Per-character 3D") |
| `sourceTextKeyframes[]` | `keyframeSchema(TextContentSchema)` | Source Text hold keys (`content` is the value when there are none) |
| `content.style` (+ runs, + `content.paragraphs[]`) | `TextStyleSchema` additions | `kerning` (`metrics`/`optical`/number), `baselineShiftPx`, `tsume`, `fauxBold`, `fauxItalic`, `smallCaps`, `script`, `ligatures`, `openType{…}`, `fontVariations{tag: v}`, `justifyLast`, indents, paragraph spacing; per-paragraph overrides by paragraph index |

Ids: `tan_` (animators) and `tsl_` (selectors) prefixes. Invariants (INV-012) and `repairDocument`
(`text-animators/validate.ts`): malformed animators / options removed, out-of-range values clamped, Source Text keys
sorted, held and validated, Path Options on a missing mask removed (`mask.remove` also resets them to Path: None).

### 1.2 Maths (pure, `packages/project/src/text-animators/`)

- `selectors.ts`: bit-exact port of EffectCraft's selectors — shapes, ease high/low (cubic Bezier `y(t)`), `rangeValue`
  (square smoothness edge per unit, degenerate ranges), modes (initial value, combine clamped to ±1), SplitMix64 hashing
  with BigInt so seeds, Randomize Order permutations, value noise and Wiggly match the Rust code exactly (oracle
  fixtures generated from the upstream source by `scripts/oracles/text-animators`).
- `evaluate.ts`: `animatorSelection` (selectors top to bottom, per dimension, memoised per unit) and `charTransforms`
  (`CharXf`: offsets summed weighted by selection, scale/opacity multiplied, colours blended by k with HSB offsets,
  tracking before/after, line anchor by strongest selection, character offset/value, blur, axes); `substituteCharacter`
  (Preserve Case & Digits / Full Unicode), `adjustColor`; a selector-evaluator registry (`registerTextSelectorEvaluator`)
  with Range, Wiggly and Expression; `textAnimatorsTimeVarying` / `textAnimatorsSeeded` / `textSourceFrameDependent`.
- `place.ts`: tracking and Line Anchor shifts per line, Line Spacing, Anchor Point Grouping pivots, Path Options
  placement, the per-character matrix `T(pivot+position)·Rz·Ry·Rx·Skew(−skew, axis)·S·T(−anchor)` and its CSS
  `matrix3d` (AE Z away from the viewer → conjugated for CSS).
- `path.ts`: `PathMeasure` over the shared Bezier model (flattened by `flattenPath`, 0.05 px), `placeOnPath`,
  `arcPositions` (margins, alignment, Force Alignment).
- `catalog.ts`: the "Animate ▸" menu with AE's companions (Skew Axis with Skew, Tracking Type with Tracking,
  Character Alignment/Range with Character Offset, Z / X-Y rotation with per-character 3D), property defaults/ranges,
  selector field definitions and factories.
- `presets.ts`: the animator preset library (§1.6).

### 1.3 Commands (undoable, `describe_commands`)

`textAnimator.add | remove | update (name, enabled, order) | duplicate | addProperty | removeProperty`,
`textSelector.add | remove | update`, `textAnimator.applyPreset {clipIds, preset, at?, durationFrames?, replace?}`,
`textAnimator.convertLegacy {clipIds}`, `text.setPathOptions {clipIds, maskId | null, …}`,
`text.setPerCharacter3d`, `font.add {family}` (registers a bundled family; the Properties font menu now offers every
catalog family). Values and keyframes: `param.set` / `param.setAnimated` / every `keyframe.*` / `expression.set` on
the dynamic property keys (`registry/text-animator-properties.ts`):
`["clip", id, "textAnimators", animatorId, "properties", prop]`, `[…, "selectors", selectorId, field]`,
`["clip", id, "textPath", field]`, `["clip", id, "textMore", field]`, `["clip", id, "text", "sourceText"]`
(Source Text: a JSON value, hold keys), and the typography keys `text.kerning`, `text.kerningAmount`, … (§1.5).
Keyframe commands find animator keys through `clipAnimatables` (extended); the keys are in the agent JSON schemas
(`clipPropertiesJsonSchema`).

### 1.4 Rendering (`packages/compositions/src/layers/text/`) — one renderer for preview and export

Clips without animators, path, Source Text keys or the new typography keep the existing renderer (plain text block,
In/Out presets) byte for byte. Others go through `TypesetText`:

1. **Layout by the browser** (`measure.ts`): an off-screen, untransformed copy of the text (paragraph blocks with the
   paragraph CSS, run spans with the character CSS, per-grapheme spans only where optical/manual kerning or tsume add
   space) attached to `document.body`; every grapheme measured with a `Range` (sub-pixel; layer transforms and the
   monitor zoom never round it); baselines from each font's ascent (measured with a baseline marker); lines from the
   unshifted baselines. Cached per content/box/fonts.
2. **Animation**: `charTransforms` at the clip's content time (keyframes, bound expressions), substitutions (Adjust
   Kerning re-lays out), variable-axis advances (measured), `placeGlyphs`.
3. **Drawing**: each character is one absolutely positioned element with its `matrix3d`, its own baseline exactly on
   the measured one (`drawnBaseline`, measured per font with the same CSS as the drawn element), fill and stroke as
   separate passes (per-character palette: outside strokes under the fill, centre/inside over it; or all fills over
   all strokes / all strokes over all fills), faux bold (Skia's fake-bold width as a fill-coloured outline), faux
   italic (0.21 shear about the baseline), Blur as a Gaussian of σ = blur/2 per axis (CSS `blur()` or an SVG
   `feGaussianBlur` for unequal axes) in layer space, opacity, `mix-blend-mode` for inter-character blending, and for
   per-character 3D the comp camera: `perspective` = AE's 50 mm default zoom (2666.67 px at 1920 px wide), origin
   the frame centre mapped into the layer.
4. **Text on a path**: the mask's path at the content time (`resolveMask`, normalised → text-box pixels).
5. **Expressions**: animator properties are expression locations (`sequenceAnimatables` yields them; the expression
   World resolves their keys and exposes `text.animator("Animator 1").property.position`,
   `.selector("Range Selector 1").start`, `text.pathOption…`, `text.moreOption…`; `bindSnapshotExpressions` binds
   them in render snapshots). The **Expression Selector** runs per unit through `textSelectorExpressionHost` (new in
   `@jasper/expressions`, on `World.evaluateText` with `textIndex`, `textTotal`, `selectorValue` and per-selector,
   per-unit seeded `random()`), provided to the text layer by `SequenceComposition` (`TextExpressionContext`) from
   the snapshot's expression world — so it works after JSON in the Remotion renderer. Without the engine (or on an
   error) the static Amount scales the selection above (EffectCraft's fallback). Selector amounts are not bound as
   per-frame properties (`AnimLocation.kind: 'selector'`).
6. **Legacy In/Out presets on a typeset clip** are drawn in their animator form (the `convertLegacy` mapping); the
   commands that create this combination warn `W_TEXT_ANIMATION_AS_ANIMATORS`.

Export: text clips are DOM layers, so every export path renders them through the same composition (layer bake →
`hybrid`/`native`, or `remotion`). Layer-bake static detection treats Wiggly and Expression selectors as
time-varying (keyframes and expressions were already found by the deep scans); the bake key keeps the clip id when
Randomize Order / Wiggly / Expression selectors are seeded by it. `isFrameDependent` (Program memoisation) counts
animators, Source Text keys and text paths. Interchange pre-renders text clips (reason "text clip with animators");
OTIO carries the whole clip in `metadata.jasper`.

### 1.5 Typography

Character settings follow AE's Character panel, drawn by the browser from CSS (same Chrome for preview and export):
Metrics kerning = `font-kerning`; Optical kerning (pull every ink gap halfway to the run's median gap, EffectCraft
`space_item`, side bearings from canvas `measureText` ink bounds), Manual kerning (1/1000 em before each character
except a paragraph's first) and Tsume (removes `t ·` side bearings) as per-character margins; tracking =
`letter-spacing`; leading = `line-height`; baseline shift = relative offset that keeps the line box (AE);
superscript/subscript = 58.3 % size ±33.3 % (AE defaults, synthesized so every font behaves the same); small caps =
`font-variant-caps` (Chrome synthesizes 70 %, AE's default); all small caps, ligatures, discretionary ligatures,
contextual / stylistic alternates, stylistic sets ss01–ss20, swash, titling, ordinals, fractions, lining / oldstyle,
proportional / tabular figures = `font-variant-*` / `font-feature-settings`; variable axes =
`font-variation-settings` (catalog gains **Inter Variable**, `@fontsource-variable/inter`, OFL-1.1, wght 100–900 and
opsz 14–32; axes listed in `/api/fonts`); paragraph indents (left/right/first line), space before/after, justify with
last line left/center/right/justify (`text-align-last`). Properties panel: new **Character** and **Paragraph**
sections (`TYPOGRAPHY_SPECS`, read-time defaults through a `$typo` storage head; writes go through `clip.update`).

### 1.6 Presets (`TEXT_ANIMATOR_PRESETS`, 58)

In (27) with mirrored Out twins (27) and loops (4): the shipped In/Out presets re-expressed (Fade In, Slide
Up/Down/Left/Right, Pop, Blur In, Typewriter, Tracking In, Rise Lines for Mask Reveal, Rotate In, Drop) and an AE-style
library (Fade Up Characters, Fade In by Character / by Word, Random Fade In, Bounce In Words, Slide In Characters,
Raining Characters, Skew In, Tracking In Tight, Blur By Word, Scramble, Decoder Fade In, Drop In Lines, 3D Flip In,
3D Fly In; loops Wave, Jitter, Hue Sweep, Pulse Words). Out presets end on the clip's last frame, loops repeat over the
clip, `durationFrames` stretches key times.

### 1.7 UI

- Effect Controls ▸ **Text**: tool row with **Animate ▸** (every property in AE's order with separators, Enable
  Per-character 3D, Animator Presets ▸ by category, Convert In/Out Animations), **Path** popup (None / the clip's masks)
  and a 3D switch; Source Text row (stopwatch = hold keys, editor writes the text at the playhead); Path Options;
  More Options; per animator a twirl (enable, name, **Add ▸** Property / Selector Range-Wiggly-Expression / Remove
  Property, duplicate, move, delete) with selector twirls (enable, delete, Advanced twirl) and property rows — all
  ordinary inspector rows with stopwatches, keyframe lanes, graphs and expressions (Alt-click).
- Properties ▸ Character / Paragraph; the font menu registers catalog families (`font.add`).
- The shared context menu now opens one submenu per level on hover (nested submenus used to open all at once).

### 1.8 Agents

MCP `apps/mcp/src/tools/text-animators.ts`: `list_text_animator_presets`, `apply_text_animator_preset`,
`add_text_animator` (properties + values + keys + range settings/keys in one transaction), `add_text_selector`
(incl. Expression), `get_text_animators`, `remove_text_animators`, `set_text_path` (creates a guide mask from points /
a Bezier path), `convert_text_animation`; `TEXT_ANIMATORS_GUIDE` in the server instructions; README lists.

## 2. Verified behaviour (measured)

These are historical workstream results. Browser tours and implementation-only tests named below may
have been removed during cleanup; the counts are not current suite totals.

- `pnpm vitest run packages/project/test/text-animators-maths.test.ts` — 14: Range (126 cases), ease, SplitMix64,
  permutations, noise and Wiggly **bit-identical** to the Rust reference; path measure/placement/arc positions equal;
  property tests (shapes in range, ease monotonic, permutations, wiggly bounds/smoothness, combine bounds); character
  substitution; HSV.
- `packages/project/test/text-animators.test.ts` — 19: commands, companions, 3D companions, selectors (static fields,
  clamping, reorder), keyframes via generic commands (move, interpolation, remove), duplicate with fresh ids, axes,
  registry/JSON schema, every preset applied (Out ends on the last frame, In starts at frame 0, loops cover the clip),
  reversed clips, conversion of every shipped In/Out preset, Path Options on a mask (keyframed margins, mask removal
  → None), More Options, Source Text keys (validation, snapshot, fonts of keyed contents, removal), invariants + repair,
  typewriter evaluation, typography param writes, `font.add`.
- `packages/compositions/test/text-animators.e2e.test.ts` (`REMOTION_E2E=1`, headless Chrome) — 10: typewriter
  reveal and **rest state glyph extents equal to the browser's own text (≤ 1 px)**, position + fill colour, a range on
  half the characters, text on an ellipse mask, 3D flip + jitter deterministic (byte-identical re-render), small caps
  + superscript + faux italic, variable wght 150 vs 850 and an animated +700 offset (ink within 8 %), stroke with
  horizontal blur and strokes-over-fills, Expression Selector `textIndex % 2 * 100` (half the ink), a property
  expression. The PNGs were inspected (contact sheets).
- `apps/mcp/test/text-animators.test.ts` — 3 (presets, animator with values/keys/range, expression selector, get,
  remove, text path); conventions + README tool list pass.
- `e2e/text-animators.spec.ts` (Playwright, built stack, port 49320) — 4: Animate ▸ Position, Add ▸ Selector ▸
  Wiggly, delete, Animator Presets ▸ Animate In ▸ Typewriter through the real menus; the Program types the title in
  and revisiting a frame is identical; the Path popup on a mask; **export frame 30 equals renderStill (≤ 3/255 on
  ≥ 99 % of pixels)** and frame 0 is empty.

## 3. Comparison with the reference (EffectCraft)

Equal: selector maths (bit-exact), modes, Randomize Order, Wiggly, Expression Selector semantics (replaces the
selection, fallback to the static Amount), CharXf accumulation, substitution, Path Options placement, More Options,
per-character 3D, presets (all eight upstream ideas present). Better: animator properties take expressions and the
object model reaches them (`text.animator(…)`), Source Text hold keys with keyed fonts, 58 presets with In/Out/loop
variants and a conversion of our In/Out presets, mask paths are any animated mask of the shared model, UI exposes
everything with keyframe lanes and graphs. Different by design: glyph shaping/raster is the browser's (same in preview
and export) rather than EffectCraft's own shaper and rasteriser; the Blur σ = blur/2 convention is EffectCraft's.

## 4. Sources (Adobe documentation, §3b)

- After Effects User Guide, "Animating text" (animators, Range / Wiggly / Expression selectors and their properties,
  per-character 3D, text animation presets): https://helpx.adobe.com/after-effects/using/animating-text.html
- "Creating and editing text layers" (Path Options: Reverse Path, Perpendicular To Path, Force Alignment, First /
  Last Margin; More Options): https://helpx.adobe.com/after-effects/using/creating-editing-text-layers.html
- "Formatting characters with the Character panel" (kerning metrics/optical/manual, tracking, baseline shift, tsume,
  faux bold/italic, all caps/small caps, superscript/subscript):
  https://helpx.adobe.com/after-effects/using/formatting-characters-character-panel.html
- "Formatting paragraphs" (alignment, justification with last line, indents, space before/after):
  https://helpx.adobe.com/after-effects/using/formatting-paragraphs-paragraph-panel.html
- Expression language reference (Text Index, Text Total, Selector Value):
  https://helpx.adobe.com/after-effects/using/expression-language-reference.html
- Undocumented, chosen most plausibly: the default comp camera for per-character 3D (AE's 50 mm preset), Blur's σ
  (EffectCraft), superscript/subscript always synthesized, faux bold width (Skia's fake bold).

## 5. Limits (honest)

- Ligatures spanning several characters are drawn as separate characters while a clip uses animators (each character
  is its own element; AE behaves alike for per-character animation). Joining scripts keep their joined forms through
  ZWJ; per-character transforms of complex-script clusters follow graphemes.
- Line breaking does not reflow when animated tracking widens a line (AE and EffectCraft alike: tracking shifts
  characters, Line Anchor sets where).
- Selector range handles in the Program monitor (optional in the scope) are not drawn.
- In/Out presets combined with animators/typography on one clip render in their animator form (warning above).
- Outside text strokes are drawn at twice the width under the fill and inside strokes as centred, as the plain text
  renderer did before; multiple strokes per style still draw only the first.
