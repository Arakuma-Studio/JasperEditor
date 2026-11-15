# scene-file — declarative scenes: `jasper apply`, `preview`, `export-scene`

Branch `feat/scene-file`. One YAML or JSON file describes a whole sequence; `jasper apply` makes the project match
it with ordinary document commands (one transaction, one undo step), `jasper preview` applies and renders a labelled
contact sheet, `jasper export-scene` writes a sequence back as a file.

Code: `packages/project/src/scene/` (pure: `format.ts` schema, `resolve.ts` file → canonical form, `read.ts` clip →
canonical form, `plan.ts` diff → commands, `write.ts` export, `bindings.ts` ownership), the `scene.bind` command
(`commands/{schemas,handlers}/scene.ts`), the shared ease-name parser `ease/names.ts` (also behind MCP
`apply_ease`), and the CLI side `apps/mcp/src/scene-cli.ts` (YAML via `yaml`, ISC; file I/O; media imports; the
labelled sheet; `--watch`). Tests: `packages/project/test/scene.test.ts` (validation paths, apply/idempotence, 40 px
move = one command, removals, moves, images, export round trips, `scene.bind`, a fast-check property: apply twice
plans nothing, export → apply plans nothing, apply → export → apply on a fresh project then the original plans
nothing), `apps/mcp/test/scene-cli.test.ts` (YAML/JSON parsing, export YAML reads back, labelled sheet, `--watch`
debounce and error survival with an injected watcher and timers, a missing HTML page imported once and found again), `apps/mcp/test/jasper-cli.test.ts` (the CLI
against a real engine).

## Format (`scene: 1`)

```yaml
scene: 1
sequence:
  name: Promo              # the sequence (by its project item name); created when missing
  size: [1920, 1080]       # optional: managed when given (default 1920×1080 for a new sequence)
  fps: 30                  # 30, 29.97, 23.976, 59.94 or "30000/1001" (default 30 for a new sequence)
  duration: 6              # default layer length
  background: "#101018"
layers:                    # bottom to top: a later layer draws over an earlier one
  - id: headline           # identity in this file; the clip's name unless `name:` is given
    type: text             # text | image | svg | shape | composition
    start: 0.3             # sequence time; default 0
    duration: 5.5          # default sequence.duration − start
    track: 3               # or "V3"; default = position in the list (first = V1)
    position: [960, 540]   # sequence px
    anchor: [0, 0]         # layer px
    scale: 100             # percent (uniform)
    rotation: 0            # degrees
    opacity: 100           # 0…100
    blend: normal          # a blend mode id
    keyframes:             # per property; a keyed property is not also given statically
      scale: [{ t: 0, value: 70, ease: ease-out }, { t: 1, value: 100 }]
    effects:               # in order; [] removes them
      - effect: jasper.gaussian-blur
        params: { dimensions: both }
        keyframes: { radius: [{ t: 0, value: 20 }, { t: 15f, value: 0 }] }
    masks:                 # Opacity masks, layer-box-normalised 0…1; [] removes them
      - ellipse: [0.1, 0.1, 0.8, 0.8]   # or rect: [x, y, w, h] or path: { closed?, points: [[x, y] | {p, in?, out?}] }
        feather: 10        # mode, inverted, opacity, expansion, falloff too
```

- **Times**: seconds (`2.5`) or `"2.5s"`, `"250ms"`, `"45f"`. Keyframe `t` counts from the layer's start, so moving a
  layer moves its animation.
- **Colours**: `"#RRGGBB"`, `"#RRGGBBAA"`, `"#RGB"` or `[r, g, b(, a)]` in 0…1.
- **Keys** `{t, value, ease?, path?}`: `ease` shapes the segment leaving the key — a built-in preset id or name
  (`list_ease_presets`), a CSS keyword (`linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`), `"cubic-bezier(x1,
  y1, x2, y2)"` or `hold`; default linear. Multi-point presets (bounce, elastic) are refused: a key holds one cubic
  segment (`apply_ease` applies them). `path` (position only): `linear` (default) or `auto` (Auto Bezier).
  Keyable: `position`, `anchor`, `scale`, `rotation`, `opacity`; shapes also `size`, `radius`, `fill`.
- **text**: `text` (required), `font` (family; registered with `font.add` when the project lacks it), `size` (px),
  `weight`, `italic`, `color`, `align`, `lineHeight`, `tracking` (em), `allCaps`, `stroke {color, width, position?}`,
  `shadow {color, angle?, distance?, blur?, spread?}`, `background {color, padding?, radius?}` (each `null` removes),
  `box: [w, h]` (fixed box) or `width: w` (paragraph text; neither = point text), `animation: {in?, out?}` — a preset
  id (`list_text_animations`) or `{preset, duration?, params?}`, `null` removes a side (`animation: null` both).
- **image / svg**: `src` — a path relative to the file (imported on the first apply; matched afterwards by its path
  locator, else by file name and size) or a media id.
- **shape**: `shape: rect | ellipse`, `size`, `fill` (`null` = none), `stroke`, `radius` (rectangles).
- **composition**: `bundle` (a Remotion project folder — imported with `import_mg_bundle` when missing —, a bundle
  media id or its name), `composition` (id in the bundle), `props` (the whole override object).
- **HTML composition pages** (schema v15, [html-compositions.md](html-compositions.md)): `bundle` is the page file
  (`.html` / `.htm`, relative to the scene file) and `page: {width, height, fps, query?}` is required — one page
  imported at another size, rate or query is another media item, so `page` names which import the layer shows.
  `composition` is the page's file name without its extension (what `import_html_composition` produces); `page` on a
  Remotion bundle is an error (a media id `bundle` may carry it). Apply finds the import with the same page path
  (its `mgBundle.source.path`), size, fps and query (`findScenePage`), else imports it with `import_html_composition
  {path, width, height, fps, query?}` first; export-scene writes `page` for every HTML page layer.

  ```yaml
  - { id: pano, type: composition, bundle: pages/pano.html, composition: pano,
      page: { width: 1080, height: 1350, fps: 30, query: s=2 } }
  ```
- Unknown keys are errors; every error names its path: `layers[2].keyframes.position[0].ease: unknown ease "foo"`.

## Apply

1. Parse (YAML: `.yaml`, `.yml`, anything not `.json`; JSON: `.json`), validate (`SceneFileSchema`), import the
   files it names that the project lacks, then resolve against the project and the catalogues the commands use
   (ease presets, text animation presets and their params schemas, the effect registry and its param ranges —
   out-of-range values are refused so nothing is clamped, which would never converge).
2. **Matching**: a layer is the clip `scene.bind` recorded for its id, else the clip its `clip:` pin names, else the
   one clip of a scene kind with its name (several → an error asking for a pin). Unmatched layers are created with
   explicit ids. A matched clip of another kind (or composition / shape type) the scene created is made again.
3. **Canonical form, both sides**: the file layer (`resolveScene`) and the clip (`readSceneLayer`) are brought to
   frames, RGBA, cubic ease handles read through the evaluator's own segment shapes (`spanEases`), full effect
   params; the diff compares them with tolerances matching the export's rounding (1e-3, colours ½/255, ease handles
   2e-3) and emits only what differs: `param.set` / `param.setAnimated` + `keyframe.add` (explicit interpolation,
   eases from `cubicToEases`, a Bezier incoming side, the spatial mode for position), `clip.update` (name, blend,
   text, style, box, text animation, shape stroke, composition props), `clip.replaceSource`, `effect.*`
   (in place when the effect ids are unchanged, else replaced), `mask.remove` + `mask.add` when the masks differ.
   Box properties (size, radius, fill) are written before the anchor (a shape's box change moves its anchor).
4. **Managed aspects**: what the file gives. A field the file leaves out is left as the clip has it (write `[]` /
   `null` to clear); on a new layer it gets the command's default. Timing and track are always managed.
5. **Timing**: start / duration / track changes are `clip.move` (overwrite mode, `groups: false`) and `clip.trim`
   (out edge), scheduled so a move never lands on a clip that has not left yet (shrink: trim first; grow: move
   first); a cycle (two layers trading places) makes one of them again. A layer whose final range would overlap a
   clip the scene does not manage is refused (`V4 already holds clip "mine" …`): nothing is overwritten.
6. **Ownership and removal** (`extensions["jasper.scene"]`, written by `scene.bind` in the same transaction): only
   clips the scene *created* are bound. When a bound layer leaves the file its clip is lifted (`clip.lift`, no ripple).
   Clips the scene adopted by name or pin, and everything else in the sequence, are never removed. Renaming a layer
   id is a removal plus a creation. A binding whose clip the user deleted is forgotten and the layer made again.
7. One `apply_commands` transaction with `expectedRevision` = the revision the plan was made from (a concurrent edit
   refuses it with a revision conflict; re-run), label `Scene: <file>`; live editor windows apply it like any agent
   edit. Zero commands = no transaction. `--dry-run` validates the plan in the engine without applying it.

## Preview

`jasper preview <file> --times 0.3,1,2.5,6 --out sheet.png [--width N] [--columns N] [--timeout s] [--watch]`
applies, then calls `render_frames {sequenceId, times}` — one `still-sheet` engine job (spec 19 TL-103) — and
re-composes its PNG with a header (file, sequence, revision) and a caption strip under every cell (the time asked and
its timecode), written atomically. Plain numbers are seconds; `45f` frames; timecodes pass through. The wait is
`--timeout` (default 600 s, at most 900): graphics re-bake after an edit. `--watch` watches the file's directory
(editors save by rename), debounces 150 ms, never overlaps runs (a save during a run schedules one more), prints a
failing run's error — a half-written or invalid file included — and keeps watching until Ctrl+C.

## Export

`jasper export-scene [--sequence <name|id>] [--out f.yaml|f.json] [--format yaml|json]` (default sequence: the
editor's active one, else the first; stdout without `--out`). Layers are the sequence's text, still (image / svg by
media format), rectangle / ellipse shape and composition clips, bottom to top (track, then start); other kinds are
left out with a warning. Ids are clip names; a repeated name gets a suffix and a `clip:` pin. Default values are
left out (position at the frame centre, the box-centre anchor, scale 100, rotation 0, opacity 100, linear eases,
effect params at their defaults, a text animation's default length and params). Media paths are written relative to
the output file when they lie under its folder. What the format cannot say exactly — an expression, roving keys,
curved motion paths with custom handles, several text strokes, styled runs, keyed / tracked masks, non-uniform scale,
3D — is not written (a warning names it), so applying the export never rewrites it.

## Limitations

- Vector shape layers (`shape.type: vector`), solids, video / audio / nest / motion-graphic clips are not scene
  layers (export leaves them out; apply leaves them alone).
- Static values only for text style, shape stroke, mask paths and composition props (no keys); multi-point eases
  are refused; image size is `scale` (uniform).
- A composition layer longer than its composition is clamped by `clip.addComposition`, so the next apply plans a
  trim that the composition refuses: give such layers the composition's length.
- Measured 2026-11-11 on the shared host (load average ≈ 40–48, dev engine from source): a 4-frame `preview` of
  the sample scene took 1 min 57 s the first time (text and shape layer bakes in headless Chrome), and one
  render after a text edit outlived render_frames' default 120 s wait — hence preview's 600 s default.
