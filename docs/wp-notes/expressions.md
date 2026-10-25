# Expressions (parity workstream `expressions`)

After Effects-style expressions on any animatable property: JavaScript evaluated per frame, whose result replaces
the property's keyframed value, with AE's object model, helpers and Expression Controls. User and agent
documentation: [docs/expressions.md](../expressions.md) (it ends with the language reference generated from
`packages/expressions/src/reference.ts`).

## 1. Design

### 1.1 Engine: QuickJS compiled to WebAssembly (`@jasper/expressions`)

`quickjs-emscripten-core` 0.32 with the `@jitl/quickjs-singlefile-browser-release-sync` variant (MIT; QuickJS
2025-09-13). The same WebAssembly binary runs in the editor (browser), in the Remotion renderer (headless Chrome)
and in Node (engine native export, MCP), so expression maths — including `Math.sin/exp/pow`, which are libm code
inside the binary, not the host's — is bit-identical everywhere. Alternatives considered: `new Function`/`eval`
in the host (no sandbox, no limits, host-specific maths), a JS-in-JS interpreter (slow, no memory limit). The
single-file variant needs no `.wasm` URL handling in Vite, webpack (Remotion bundler) or esbuild (engine/MCP
bundles); it is a lazy chunk (`import()` in `runtime.ts`), fetched only when a document has expressions.

- **Sandbox:** no std/os modules are linked: no I/O, no network, no timers. `Date` is fixed at 0 and
  `Math.random` is the seeded `random()`, so nothing depends on the wall clock.
- **Limits:** memory 64 MiB (`setMemoryLimit`), QuickJS stack 160 KiB (measured: it must trip before V8's ~1 MB
  native stack under the WebAssembly frames, else the instance aborts instead of throwing; ~800 nested calls),
  an operation budget (the interrupt hook fires every ~10 000 interpreter steps; 500 hooks ≈ 5 M steps ≈ 30 ms on
  this box) plus a 2 s wall-clock guard, and 16 levels of expressions reading each other (cycles stop there with
  an error). A host-side failure (should not happen) drops the instance and reloads it.
- **Compile once, cache:** `compile.ts` turns the expression text into the source of one function (array maths
  + completion values, below), compiled once per text into a QuickJS function handle (LRU, 2048 entries) and
  called per evaluation through the prelude's `__run`. Measured: 10 000 calls of a small function ≈ 50 ms in Node
  (5 µs each) versus 130 ms for 10 000 `eval`s.
- **Source transform on a real AST (acorn):** AE's array maths (EffectCraft `rewrite.rs`, ported): every binary
  `+ - * /` becomes `__add/__sub/__mul/__div`, unary minus `__neg` (numeric literals stay `-5`), compound assignments
  `x op= v` → `x = __op(x, v)`; `%` and `**` stay native. The helpers fall back to the native operator for numbers
  and strings. **Completion values** (`if (a) 1; else 2`) are kept without re-parsing per frame: every expression
  statement outside nested functions becomes `__r = (…)`, compound statements reset `__r` first (ECMAScript
  UpdateEmpty), and the program is the body of `function () { var __r; …; return __r; }`. Newlines are preserved,
  so runtime errors report the user's line (`Error at line 2: …`). Nesting deeper than 64 levels is refused (the
  parser and QuickJS recurse per level).
- **Determinism:** `random`, `gaussRandom`, `noise` and `wiggle` are computed inside QuickJS with 32-bit integer
  hashing (`Math.imul`, a SplitMix-style finaliser and FNV-1a), seeded by the clip id and property path (+ time,
  `seedRandom`, the call counter). Seeds are stable across edits (they do not use layer indexes, which change when
  clips move).

### 1.2 Model and commands (`@jasper/project`)

- `Animatable.expression?: {text, enabled}` on every animatable (optional, additive, no schema bump), and
  `TextContent.expression` for Source Text. `EffectInstance.name?` (Effect Controls ▸ Rename…) because expressions
  find effects by name. `ParamValue` gains `vec3` (3D Point Control).
- Commands (undoable, in `describe_commands`): `expression.set {target, text, enabled?}` (empty text removes),
  `expression.clear`, `expression.setEnabled`, `effect.rename`. `target` is the usual ParamPath (`["clip", id,
  "transform", "position"]`, `["effect", fxId, param]`, `["mask", maskId, "feather"]`, `["transition", id, param]`,
  `["clip", id, "text", "content"]`). The text is not compiled by the handler (handlers are pure and the engine is
  WebAssembly): syntax and runtime errors surface at evaluation as `expressionError`, as in AE.
- Refused with a named error: track / Mix faders and audio effects (the Audio Track Mixer automates them and the
  mixer processes them per sample), motion-graphic template parameters, mask paths, curves and media params,
  static properties. `checkInvariants` reports `INV-EXPR` for malformed or misplaced expressions;
  `repairDocument` drops them (`drop-expression`).
- Pasted / duplicated / preset effect params keep their expressions (`buildParams` validates them).

### 1.3 Evaluation everywhere: binding

The one shared `evaluate()` stays the single evaluator. An Animatable whose active expression has been *bound* to
its place in a document carries its evaluator under the non-enumerable symbol `EXPRESSION_BINDING`;
`evaluate()` delegates to it (`evaluateKeyframes()` is the pre-expression value). Bound objects are fresh
copy-on-write copies (documents are frozen, and an Animatable shared by two document versions must not carry
either version's evaluator). JSON, `structuredClone` and Immer never see the symbol.

- `bindExpressions(doc)` (installed into `@jasper/project` by `loadExpressionEngine()`; identity without
  expressions) is applied by `buildRenderSnapshot`, so the Program preview, overlays, stills, the native export's
  per-frame sampling (Motion, opacity, crop, effects, masks, audio levels) and agent queries see post-expression
  values without changes at their call sites. Static/animated checks (`isAnimated`, `isStaticClip`,
  `masksAnimated`, `needsSubpixel`, colour runs, layer-bake static detection, the audio mixer) count an active
  expression as animation.
- Render snapshots carry `expressions` (every sequence, sequence names, layer boxes, solid colours) when the
  document has active expressions. `bindSnapshotExpressions` rebinds a snapshot that went through JSON — the
  Remotion renderer: `SequenceComposition` loads the engine (`delayRender` until ready) and binds. Nested-sequence
  snapshots share the root's world.
- Layer bakes (text, shapes, DOM layers on the native path): the bake key includes a hash of the expression world
  and the clip's start when the clip has expressions (anything an expression reads can change its pixels); the
  one-clip render document carries the world; a bake's render-rect shift is applied to a Position expression's
  result (`expressionPositionShift`).
- Audio levels (clip Volume and Pan) are read per sample by the mixer: like AE, the expression runs once per
  frame and samples interpolate linearly between frames.
- `stabilizeRenderDoc` treats Animatables bound to different worlds as different (a clip's expression can read
  another clip that changed).

### 1.4 Object model (Premiere → AE mapping, `prelude.ts` + `world.ts`)

comp = sequence (`thisComp`, `comp("Sequence name")`), layer = clip (`thisComp.layer(index | "name" | clip id)`;
index 1 = topmost: caption tracks, video tracks top → bottom, audio tracks; clips of a track by start), `time` =
sequence seconds (keyframes live in content time; the clip's speed and reverse map between). Groups: Transform
(`anchorPoint`, `position`, `scale`, `scaleWidth`, `rotation`, `opacity`), Effects (`effect(name | index | id)(param
name | index)`), Masks (`mask("Mask 1").maskFeather / maskOpacity / maskExpansion`), Shape (`size`, `fillColor`,
`strokeColor`, `strokeWidth`, `cornerRadius`), Audio (`audioLevels`, `pan`), Text (`sourceText` + read-only
`style`), template Params (`params("name")`, read only). Layer attributes: `name, index, inPoint, outPoint,
startTime, width, height, hasVideo, hasAudio, enabled, active, marker, toComp/fromComp(+Vec), toWorld/fromWorld
(= comp, sequences are 2D), sourceRectAtTime, sampleImage`. Properties: `value, valueAtTime, velocityAtTime,
speedAtTime, velocity, speed, numKeys, key(n), nearestKey, wiggle, temporalWiggle, smooth, loopIn/loopOut(+Duration),
preExpressionValue, propertyIndex, name`. Markers: `marker.key(n | "name").time/duration/comment/name/…`,
`numKeys`, `nearestKey`. Values: colours `[r, g, b, a]` 0…1, checkboxes 1/0, menus 1-based (results may also be the
item name), Layer Control → a Layer object. A property's own expression reads its keyframed value at other times
(`valueAtTime`), like AE.

### 1.5 Expression Controls

`jasper.slider-control` (−1,000,000…1,000,000, slider 0…100), `angle-control` (degrees), `checkbox-control`,
`color-control` (default red, as AE), `point-control` and `point3d-control` (start at the clip centre, z = 0),
`layer-control` (a clip id, '' = None), `dropdown-control` (1-based Menu + Menu Items, one per line). Category
Effects ▸ Video Effects ▸ Expression Controls; `passthrough`: render snapshots omit them, so no renderer, planner or
export path sees them (they can never block native export).

### 1.6 UI (Effect Controls)

- Alt/Option-click a stopwatch adds an expression (AE's default text, the property's own reference) or removes it;
  `Alt+Shift+=` (`Opt+Shift+=`) does the same on the focused property (UI command `inspector.toggleExpression`,
  AE's shortcut; Premiere has none, no keymap conflict — tested).
- Expression row: Enable Expression switch (`=`), pick-whip (drag the spiral onto any property row; the reference
  text is inserted at the cursor or replaces the expression), language menu (Enable/Remove, Presets by category,
  Link to Property: every property of every clip of the sequence, and the whole reference by scope), and the
  CodeMirror 6 editor: JavaScript highlighting, autocomplete of the object model, effect names, parameter names
  and clip names; `Ctrl/Cmd+Enter` or keypad `Enter` commits, `Escape` cancels, blur commits. Errors show under the
  field (warning glyph, AE's message format). Values driven by an expression are shown in red
  (`--pr-expr-value`); editing them edits the keyframed value, as in AE.
- Source Text has its own Text section in Effect Controls (its stopwatch only takes expressions).
- Value / Velocity graphs draw the post-expression curve (`--pr-graph-post`, sampled evenly across the view since
  an expression is any function of time) over the keyframed curve whose keys and handles stay editable — AE's
  "Show Post-Expression Graph". The graphs keep keyframes-blend's features (roving keys, view zoom).
- Effect header ▸ Rename… names an instance.

### 1.7 Agents (MCP, `apps/mcp/src/tools/expressions.ts`)

`set_expression` (returns evaluated samples with `expressionError`), `clear_expression`, `enable_expression`,
`test_expression` (evaluate without storing), `get_property_values` (value, keyframed value, error per frame),
`list_expression_properties` (with pick-whip reference text), `list_expression_presets`, `add_expression_control`.
MCP documents are bound (`loadDoc`), so `get_motion_path`, `get_grade`… report post-expression values. The
`jasper://guide` resource carries the full language reference.

### 1.8 Text Expression Selector API (for the `text-animators` workstream)

`evaluateSelectorExpression(doc, {sequenceId, clipId, selectorId}, text, contentTime, {textIndex, textTotal,
selectorValue})` → `{ok, amount: [x, y, z]}` (percent; a number applies to all three; booleans 100/0) or `{ok:
false, error}`. `textIndex` (1-based), `textTotal`, `selectorValue` are globals; `random()` is seeded per selector
and unit. Tested in `packages/expressions/test/bind.test.ts`. The text-animators workstream had not landed in
`integrate/parity` when this one merged, so the selector itself (UI and rendering) is theirs to build on this API.

### 1.9 Path methods and the trim tracer (path-trace)

**Path objects.** Every path-producing shape item — Path, and the outlines of Rectangle, Ellipse and Polystar —
exposes After Effects' Path property as `.path` (`content("Group 1").content("Path 1").path`, name "Path", match
name `ADBE Vector Shape`). Methods, `t` = sequence seconds (default `time`):

| Method | Result |
|---|---|
| `points(t)`, `inTangents(t)`, `outTangents(t)` | vertices `[[x, y], …]`; tangents relative to their vertex (AE's vertex model) |
| `isClosed()` | the closed flag |
| `pointOnPath(percentage = 0.5, t)` | point at that fraction of the **arc length** |
| `tangentOnPath(percentage = 0.5, t)` | unit tangent (direction of travel) there |
| `normalOnPath(percentage = 0.5, t)` | unit normal: the tangent turned a quarter, `[-ty, tx]` |

- **Space:** the coordinates of the space the item lives in — its group's contents, group transforms *not* applied
  (Adobe: shape path points are relative to the anchor point of the path's shape group). Parametric outlines use the
  renderer's vertex order (`vector/primitives.ts`); Path Direction Reversed reverses them, so a reversed rectangle
  lists the same first vertex and runs the other way.
- **Percentage:** clamped to 0…1, closed paths do not wrap (After Effects clamps); non-finite percentages and
  times are expression errors (`pointOnPath: percentage must be a finite number`), never host failures.
- **Arc length:** the geometry comes from `vector/trace.ts` (`PathQuery`) on top of Trim Paths' own measurement
  (`ops.ts` `Measured`: walked segments, closing line included, adaptive 8-point Gauss–Legendre per segment to
  1e-4 px, Newton/bisection inverse to 1e-4 px), so a point at a trim's tip fraction is where the renderer cuts.
  Measured against dense chord sampling (4 000 chords per segment) on a rectangle, a reversed rectangle, an
  ellipse, a star and an open Bézier: < 0.01 px at eight fractions each (`test/paths.test.ts`).
- **Bounded cost:** a query measures at most 50 000 segments (more → error, e.g. a Repeater of a dense star);
  measured paths are cached per world (layer, locator, time; 64 entries) and the prelude memoises host answers
  within an evaluation. Animated paths and expression-driven item values are evaluated at `t` on the bound clip.
- **`createPath()` stays unported:** no expression-capable property takes a path value (shape paths and mask paths
  refuse expressions), so it raises `createPath(): no property takes a path value here…`.

**Ours (not After Effects), documented in the language reference:**

- `item.toLayer(point, t)`, `fromLayer`, `toLayerVec`, `fromLayerVec` on every shape item: between the space the
  item's values live in (its enclosing groups' transforms) and layer pixels (the box's top-left origin that
  `toComp` takes; vector contents are centred on the box). AE has no equivalent — its users chain group transforms
  by hand; `thisComp.layer(…).toComp(item.toLayer(p))` gives sequence pixels.
- `trim.trimPath(item?)` on a Trim Paths: a Path object for what that trim measures, in its group's space —
  operators above it applied, nested groups' paths mapped into its space (so non-uniform group scales change arc
  length exactly as the renderer sees it), Repeater copies included (`item` = the first copy). With an item (id or
  name) the one path (Simultaneously); without, all its paths laid end to end (what Individually measures). Built
  from the renderer's own stack evaluation (`trimInputPaths` in `vector/evaluate.ts`, which runs the shared
  `collect` with a probe and stops at the trim).

**`shape.addTrimTracer`** (command; `packages/project/src/commands/handlers/shape-tracer.ts`) writes, on a follower
clip's Position (and Rotation with `orient`), an expression of this form (ids, so renames keep it working):

```js
var shape = thisComp.layer("clp_…");
var trim = shape.content("shp_group").content("shp_trim");
var path = trim.trimPath("shp_path"); // Individually: trim.trimPath()
var u = clamp(trim.end / 100, 0, 1) + ((trim.offset / 360) % 1 + 1) % 1;
if (u > 1) u -= 1;                    // Start tip: if (u >= 1) u -= 1;
shape.toComp(trim.toLayer(path.pointOnPath(u)))
// orient: var d = shape.toCompVec(trim.toLayerVec(path.tangentOnPath(u)));
//         value + radiansToDegrees(Math.atan2(d[1], d[0]))
```

The tip fraction is the renderer's (`ops.ts` `trimIntervals`): Start / End clamped to 0…1, Offset wrapped into
0…1 (360° = one length) and added; the kept interval `[s + off, e + off]` wraps past 1, so the End tip at exactly
1 stays at the path's end and the Start tip at 1 moves to its start — on open and closed paths alike (an open path
then draws two pieces, a closed one draws one piece across its start). Simultaneously each path is trimmed by its own
length, so the tracer follows the chosen path; Individually the paths are measured end to end. The follower's
anchor point rides the tip (Position is the anchor's sequence position); its own Rotation value adds to the path
angle. `tip: 'auto'` picks the property whose keyframes change most (summed |Δ| between keys; End on a tie).
Defaults: a 12 px white dot with a 1.5 px black stroke named "Tracer" on the free, unlocked video track right above
the shape clip, else a new track inserted there; same start and duration. Refusals: unknown clip / items
(`E_NOT_FOUND`), non-vector clips, non-trim items, paths the trim does not affect, trims with no path or in a
disabled group, followers in another sequence or without Motion (`E_INVALID_PARAM`), the shape clip as its own
follower (`E_CYCLE`), a follower on a locked track (`E_TRACK_LOCKED`; the shape clip is only read, so its own
track may be locked). Replacing an expression the follower had
warns `W_EXPRESSION_REPLACED`. One undo step. Without `trimItemId` the clip's master trim is followed (Part 1's
last trim after a divide, else the last top-level item when it is a Trim Paths; none → `E_INVALID_PARAM`), so
`shape.animateTrim` + `shape.addTrimTracer` fit in one transaction (MCP `animate_trim_paths {tracer}`,
`docs/wp-notes/mcp-cli.md` § 7).

Limits: at the joint between two paths of an Individually trim the End tip belongs to the earlier path (the
renderer's piece ends there too; the Start tip is drawn from the next one — they differ only at that instant, by the
gap between the paths). When Start and End cover the whole length the renderer draws the untrimmed path while the
tracer keeps the computed position; a disabled trim trims nothing but the tracer still follows its values. The
follower is placed with a 2D `[x, y]` Position (3D followers keep their own z only through their pre-expression
value: not handled). Rotation from `atan2` wraps at ±180°. No Effect Controls / menu entry yet: the command is
available through `apply_commands` and the MCP tools `add_trim_tracer` / `animate_trim_paths` (the trim UI belongs to
the `trim-ui` workstream).

## 2. Verified behaviour (measured)

- `pnpm exec vitest run packages/expressions --maxWorkers=1` exercises observable expression values,
  syntax locations, bounded nesting, object-model helpers, deterministic randomness, sandbox isolation and
  quarantine, document/snapshot binding, pick-whip evaluation and selector results. The test cleanup removed
  private emitted-source assertions, generated-reference inventories and duplicate resource-limit probes;
  [the per-test audit](../test-cleanup/formats.md) records dispositions and current validation status.
- `packages/project/test/expressions.test.ts` (10): commands, refusals, rename, paste with expressions, controls
  (passthrough, centred points, vec3 validation, left out of snapshots), ParamPath ↔ ref round trip, INV-EXPR and
  repair.
- `apps/web/test/expressions-ui.test.tsx` (3): Alt-click, red post-expression values, undo, error display, the
  switch, Expression Control editors (dropdown items, layer picker, 3D point).
- `e2e/expressions.spec.ts` (Playwright, built stack): Alt-click, typing in the editor, Program preview layer
  rotation 45° / 90° at frames 15 / 30 for `time * 90`, red post-expression values, the post-expression graph, an
  error falling back to the keyframed value, a preset from the language menu, undo; and **browser vs Node**: five
  frames of expressions using sin/exp/log/pow/atan2, noise, wiggle (3 octaves), random and gaussRandom, evaluated in
  the editor page (Chrome) and recomputed in Node, are bit-identical (`toEqual` on full-precision values; 3 runs).
  Finding: the *host's* `Math.cos/sin` (used by the pre-existing `layerMatrix`, not by expressions) differs in the
  last ulp between Chrome's V8 and Node's in some runs (layer bounds 99.72918198458979 vs …956), which is why the
  expression engine keeps all maths inside QuickJS.
- **Real app, all paths** (engine on :49301 driven through the MCP tools): a project with footage, a solid with a
  Slider Control renamed "Speed", Rotation `time * effect("Speed")("Slider")`, Position
  `[linear(time, 0, 3, 300, 1600), 540 + 200 * Math.sin(time * Math.PI)]` and a text clip with Source Text
  `timeToTimecode()`. `get_property_values` returned 0/90/180/270° at frames 0/15/30/45; `render_frame`,
  the native ("hybrid": ffmpeg + baked text) export and the Remotion export were inspected frame by frame (box at
  x = 950, y = 340, rotated 270° at 1.5 s; timecode text per frame). Native vs Remotion export over all 300
  frames: PSNR 43.4 dB average (min 42.4) — the Node and headless-Chrome evaluations agree; the difference is
  encoding.

- `packages/expressions/test/paths.test.ts` (5): vertex lists, tangents and closed flags of rectangle (normal and
  reversed), ellipse, star and Bézier paths; `pointOnPath` / `tangentOnPath` / `normalOnPath` against dense chord
  sampling (< 0.01 px); clamping; animated paths at `t`; `toLayer` / `fromLayer` against hand-written group
  matrices; non-finite / malformed arguments, non-invertible groups and `createPath()` as expression errors; the
  50 000-segment bound.
- `packages/expressions/test/trim-tracer.test.ts` (5): followers created by `shape.addTrimTracer` against the tip
  computed from the geometry (< 0.01 px; requirement 0.5 px) at six frames each and against the first / last point
  of the stroke the renderer draws (< 0.01 px) for: End on an open path in nested groups (position, rotation,
  non-uniform scale, anchor) under the clip's Motion (position, rotation, scale, anchor) with `orient` (< 0.05°);
  Start (erase) on a reversed closed rectangle with Offset animated; Offset wrapping twice around a closed ellipse
  and across the ends of an open path; Individually over two paths in different groups; Simultaneously on a
  chosen path, still exact after renaming the items and the clip. **Export fidelity:** the follower's Position and
  Rotation from the render snapshot bound in Node — sampled with `resolveLayerProps(clip, clipContentTime(…))`
  exactly as `apps/engine/src/export/native.ts` does — equal the values from the snapshot after a JSON round trip
  and `bindSnapshotExpressions` (what the Remotion renderer does) and the document's (`toEqual`). Real exports:
  `apps/engine/test/trim-paths-export.e2e.test.ts` (`REMOTION_E2E=1`; shapes.md § 12 "Verification and limits")
  measures the exported dot / oriented follower on the evaluated tip on the hybrid (layer bake) and Remotion paths:
  centroid ≤ 0.09 px (dot), ≤ 0.13 px and 0.28° (bar).
- `packages/project/test/vector/tracer.test.ts` (5) and `packages/session/test/trim-tracer.test.ts` (1): created
  dot (track above, span, contents), generated text, auto tip, Individually, busy / locked track above → new track,
  driving an existing clip with `W_EXPRESSION_REPLACED`, every refusal code, invariants clean; undo / redo restore
  the exact documents (follower, new track, replaced expression).
- Cost (measured, Node 20, 16 cores at load average ≈ 105, `propertyStatusAt` over 90 frames, median): the tracer's
  Position ≈ 52 ms vs ≈ 32 ms for a baseline expression reading `content()` + `toComp` + `wiggle` in the same run —
  ≈ 1.6× an ordinary multi-reference expression; the shared measured path makes the Rotation cheaper (≈ 28 ms).
  Profiled: most of the time is QuickJS interpretation; property-tree lookups (`content()` chains) are now cached per
  world (`World.children`), which cut the profiled CPU of the run by ≈ 35 %.

## 3. Comparison with EffectCraft (`crates/expr`, `crates/effects/src/controls.rs`)

Equal: the object model surface used in Premiere-style documents, array maths semantics, loop types, wiggle /
noise construction, interpolation, conversions, the eight Expression Controls, AE-style errors with line numbers,
recursion depth limit, nesting limit.

Better: (1) one WebAssembly engine everywhere, so preview, both export paths and agents are bit-identical, where
EffectCraft's boa differs from browsers' JS maths; (2) compile once per text and call per frame (EffectCraft
re-runs scripts after each host miss: up to 2000 passes); (3) a real AST transform instead of a token-stream
rewriter (no mis-parsed ASI or regex cases), with completion values without `eval`; (4) memory, stack and
operation limits enforced by the engine (boa only had loop/recursion limits); (5) stable random seeds across clip
reordering (EffectCraft seeds by layer index); (6) post-expression graphs, pick-whip across all clips through the
language menu, presets, and agent tools that test and sample expressions.

Not ported (no counterpart in a Premiere document): 3D layers, cameras and lights (`activeCamera`, `lookAt`
returns the AE angles but nothing 3D renders), `footage()` data files, the Source Text style *setters*
(`setText`, `setFontSize`… — styles are read-only here), `createPath` (no property takes a path value; §1.9),
parenting (`hasParent` is false).

## 4. Limits and decisions

- `sampleImage` is exact for solid clips only (their pixels are known without rendering); on other clips it
  raises an error and the property keeps its keyframed value. A synchronous expression cannot wait for a
  rendered frame in the browser preview. (EffectCraft renders the sampled layer in its CPU renderer.)
- Track and Mix faders, audio effects, mask paths and template parameters take no expressions (refused).
- Expressions run once per frame and per sub-frame sample (motion blur samples call `evaluate()` at fractional
  times, so expressions are motion-blurred correctly); audio levels interpolate between frames.
- The expression engine is a lazy ~580 KB chunk (WebAssembly inlined as base64); documents without expressions
  never load it.
- `thisComp.layer(n)` indexes follow Premiere's stacking (topmost track first), so they change when clips move;
  prefer names, as in AE.
- Decisions recorded here rather than in ARCHITECTURE's decision table: the new package `@jasper/expressions`
  (layer above `@jasper/project`; edges from compositions, web, engine and MCP, listed in ARCHITECTURE §3.1 and
  `scripts/check-layers.mjs`).

## 5. Sources (behaviour research, BRIEF §3b)

- Adobe, *Expression language reference* and *Expression Controls* (helpx.adobe.com/after-effects/using/
  expression-language-reference.html, …/desktop/work-with-expressions/expression-controls/expression-controls.html):
  globals, interpolation, random, loop types, dropdown values as 1-based indexes, controls list.
- *After Effects Expression Reference* (ae-expressions.docsforadobe.dev): exact wording of linear/ease/easeIn/easeOut
  (easeIn: tangent 0 only on the tMin side; easeOut: only on the tMax side), Dropdown Menu `.value` is an index,
  `gaussRandom` (~90 % in range), `wiggle` defaults (octaves 1, amp_mult 0.5).
- Adobe keyboard shortcuts for After Effects: Add/remove expression = Alt+Shift+= (Option+Shift+= on macOS);
  Alt-click the stopwatch.
- EffectCraft `crates/expr` (prelude.js, rewrite.rs, noise.rs, host.rs) and `crates/effects/src/controls.rs`
  (recorded in `licenses/ported/expressions.md`).
- Path methods: Adobe, *Expression language reference* ▸ "Path property attributes and methods" (`points(t)`,
  `inTangents(t)`, `outTangents(t)`, `isClosed()`, `pointOnPath(percentage = 0.5, t)`, `tangentOnPath(…)`,
  `normalOnPath(…)`, `createPath(…)`; shape path points relative to the anchor point of the path's shape group, the
  group transform not applied; percentages of the path's arc length) and the docsforadobe Path Property page
  (ae-expressions.docsforadobe.dev/objects/path-property/). Clamping of out-of-range percentages and the normal's
  orientation (`[-ty, tx]`) are not stated by Adobe: taken from lottie-web's expression support (MIT; behaviour
  reference only, no code ported), which reproduces After Effects' results. The trim tracer is our command
  (inspired by public descriptions of After Effects scripts that drive a null with `pointOnPath` at a trim's end);
  its maths is the renderer's Trim Paths (`docs/wp-notes/shapes.md` §5).
- Undocumented, chosen as most plausible: the exact noise function and wiggle construction (AE does not publish
  them; ours are smooth, bounded by `amp` per octave and deterministic); the post-expression graph sampling
  density; audio-level interpolation between frames.
