# wp-m2-shapes — rectangles and ellipses (S11 §7, wave 1)

Branch `wp/m2-shapes` (on `main` a7f1f47 = contracts merge 3ece27f + worktree ignore). Spec:
`docs/specs/11-animation.md` §7 (SHP-001…008), §9 FIX-007, §11 test 5; S03 KND-055, TXT-020, XF-001, XF-061;
S05 TOOL-002/005. Contracts used: ARCHITECTURE §20.1 (`ShapeClip`, `defaultShape`, `shapeIntrinsicBox`,
`KIND_CAPABILITIES.shape`, `clip.addShape` schema, snapshot `{shape}`), §20.4 (`isFrameDependent`, `ShapeLayer`
slot), §20.6 (`commands/shapes.ts`), §20.7 (`tools/shapes.ts`).

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| SHP-001 | `packages/project/src/commands/handlers/shape.ts`, `registry/properties.ts` (block `wp-m2-shapes`), `invariants.ts` | Model from the contracts. **Layer box rule:** the box is `shapeIntrinsicBox` (largest size over value + keys, plus the stroke outside) with the geometry centred in it; every command that can change that box (`clip.update`, `param.set`, `param.setAnimated`, `keyframe.add/update/remove`, `keyframes.prune`) runs inside `keepShapesCentred` (wired once in `catalog.ts`), which moves the anchor (value and keys) by half the box change, so the shape keeps its place on screen (M(c) = P + R·S·(c − A) unchanged). Invariant added: fill/stroke colours RGBA in 0..1. |
| SHP-002 | contracts (`kinds.ts`) | Engines remotion/remotion, badge R, magenta label; the timeline shows the name ("Rectangle"/"Ellipse") and the R badge (e2e). |
| SHP-003 | `handlers/shape.ts`, `clip-core.ts` (exports), `param.ts` (hunk), `catalog.ts` (hunk) | `clip.addShape` with the defaults (400×400 at the sequence centre, white, no stroke, radius 0, 5 s), colour/size/width/radius validation (`E_INVALID_PARAM`, limits in `SHAPE_LIMITS`), placed like text (`newGeneratorClip`: overwrite, creates missing tracks, refuses locked ones). `clip.update {shape}` merges: `null` removes fill/stroke, a partial stroke is created from `DEFAULT_SHAPE_STROKE` (black, 8 px, center), static values replace keys (like `TransformPatch`), Animatables are validated key by key; `cornerRadius` on an ellipse is refused. `param.set` targets `shape.size` (vec2, clamped ≥ 0 per component — `validateValue` now clamps vec2 components to the spec range; no other vec2 spec has one), `shape.fill`, `shape.stroke.color/width/position`, `shape.cornerRadius` (rectangles); a "None" fill/stroke is created on its first write (`ensureShapeStorage`). Keyframes go through the shared keyframe commands and evaluator (`clipAnimatables` iterates `PROPERTY_SPECS`). |
| SHP-004 | `packages/compositions/src/layers/ShapeLayer.tsx`, `packages/project/src/render/shape.ts` | Inline SVG through `LayerBox`; geometry from `@remotion/shapes` `makeRect` / `makeEllipse` (4.0.499); size/paint/radius evaluated at the content time (`evaluateShape`: clamps, radius ≤ half the shorter side, zero-width strokes dropped). Stroke: center = 1× width; inside = 2× width clipped by the shape; outside = 2× width masked by the shape's complement (translucent strokes never darken the fill; miter corners). Per-layer clip/mask ids (`useId`). Zero sizes draw nothing. Keyframed shapes are frame-dependent (contracts' `isFrameDependent`). |
| SHP-005 | `apps/web/src/shapes/ShapeSection.tsx` (registered via `clipSections` in `commands/shapes.ts`), `panels/effectControls/items.ts` (hunk), `shapes/keys.ts` | Properties ▸ Shape: type (read-only), Size (two scrubby numbers + link toggle; linked = the other side scales by the same factor), Fill (swatch + None), Stroke (None toggle, colour, width, position), Corner Radius (rectangles). Rows reuse `PropertyRow` (◆ keys, reset, one gesture per scrub, multi-selection mixed `–`). Effect Controls ▸ Shape: the rows the clip carries, with stopwatches. |
| SHP-006 / FIX-007 | `apps/web/src/commands/shapes.ts`, `shapes/{insert,ShapeToolOverlay,geometry}.ts(x)`, `panels/timeline/model/tools.ts` (hunk), `packages/session/src/types.ts` (`ActiveTool`) | `graphics.newRectangle` / `graphics.newEllipse` registered (menu entries enabled; the existing default keys Ctrl+Alt+R / Ctrl+Alt+E are unchanged and do not conflict): a default shape at the playhead on the targeted video track (busy → first free track → new track), selected, one undo step ("New Rectangle"). `tool.rectangle` / `tool.ellipse` (no default keys, as in S05:TOOL-002) in the Pen flyout group. The Program shape-tool overlay (`programOverlays`, active only while a shape tool is selected) draws the dragged box: Shift = square/circle, Alt = from the centre (re-evaluated when Shift/Alt change mid-drag), Escape cancels, release = one `clip.addShape` transaction, then back to Selection with the shape selected. Clicks without a drag add nothing. In the timeline the shape tools behave like Selection. |
| SHP-007 (P1) | `shapes/prefs.ts`, `shapes/PreferencesPage.tsx` (Edit ▸ Preferences ▸ Graphics), `shapes/geometry.ts` (`resizeShapeBySize`), `panels/program/TransformOverlay.tsx` (hunk) | "Resize shapes by size" (default off = Premiere parity): handles of a single selected shape write `shape.size` (a key at the playhead when animated) instead of Motion scale; strokes keep their width. Default grows about the shape centre (it stays centred on its anchor); Alt keeps the opposite side (writes position too); Shift keeps the ratio. History label "Resize Shape". Multi-selection group handles keep scaling. |
| SHP-008 | `apps/mcp/src/tools/shapes.ts`, `format.ts` (block), `examples.ts` | `add_shape` (type, size, fill hex or null, stroke {color, width, position}, cornerRadius, position, at, duration, track, name, sequenceId) → one "Agent: Rectangle/Ellipse" entry; `SHAPES_GUIDE` (editing and keyframing through `apply_commands`); `get_timeline` shows "rect 640×160 fill #202020cc stroke 6px #ffcc00 inside radius 24 (animated: size)"; `describe_commands` example for `clip.addShape` (dry-run by the integration test); agent schema lists `shape.*` properties with `kinds: ['shape']` and `clip.addShape` as implemented. |
| S03:XF-001 | `shapes/geometry.ts` (`hitsLayerGeometry`), `render/shape.ts` (`shapeContainsPoint`), TransformOverlay hunk | Program monitor clicks hit shapes by their drawn geometry (ellipse interior, rounded corners, outer stroke band); corner-pinned shapes keep the quad test. |

## Contract changes (all additive)

- `@jasper/project`: `clip-core.ts` exports `newGeneratorClip` (kind `'shape'` added), `commonFields`, `visualFields`, `applyTransformPatch`, `frameBox`; `PropertyGroup += 'shape'`; `SHAPE_LIMITS`, `DEFAULT_SHAPE_STROKE` (registry/properties.ts); `render/shape.ts` exports `evaluateShape`, `shapeContainsPoint`, `ShapeGeometry`; `handlers/shape.ts` exports `keepShapesCentred`, `SHAPE_BOX_COMMANDS`, `recenterShape`, `ensureShapeStorage`. `validateValue` clamps vec2 components to a spec range (only `shape.size` has one).
- `@jasper/session`: `ActiveTool += 'rectangle' | 'ellipse'`.
- Web: `TOOLS` / `TOOL_GROUPS` (Pen group = pen, rectangle, ellipse).
- MCP: `editing.ts` exports `applyHelper` and `hexToRgba` (reused by `add_shape`).
- `@jasper/compositions`: `ellipseOffset` exported from `layers/ShapeLayer.tsx` (not from the package index).

## Cross-package edits (delimited, minimal)

- `packages/project/src/commands/catalog.ts` — one hunk: handlers in `SHAPE_BOX_COMMANDS` are wrapped by `keepShapesCentred`.
- `packages/project/src/commands/handlers/clip-core.ts` — `export` on five helpers, `'shape'` in the generator kind union.
- `packages/project/src/commands/handlers/param.ts` — one hunk (`ensureShapeStorage` for `shape` specs) + vec2 range clamp.
- `packages/project/src/registry/properties.ts` — `PropertyGroup 'shape'`, one block of specs (+ a spread in `PROPERTY_SPECS`).
- `packages/project/src/invariants.ts` — colour check inside the contracts' shape block.
- `packages/project/src/render/index.ts` — `export * from './shape.ts'`.
- `packages/session/src/types.ts` — `ActiveTool` members.
- `apps/web/src/panels/timeline/model/tools.ts` — two tools, Pen group, `resolveGesture` cases.
- `apps/web/src/panels/effectControls/items.ts` — Shape section hunk + import.
- `apps/web/src/panels/program/TransformOverlay.tsx` — import, `bySize` field of the scale gesture, geometry hit-test filter, size branch of the scale move.
- `apps/mcp/src/format.ts` (shape text block), `apps/mcp/src/examples.ts` (one example), `apps/mcp/src/tools/editing.ts` (two `export` keywords).
- Tests touched outside my files: contract assertions that expected the stubs (`packages/project/test/anime-contracts.test.ts`, `packages/compositions/test/anime-contracts.test.tsx`, `apps/web/test/anime-contracts.test.tsx`, `apps/mcp/test/anime-contracts.test.ts`), `apps/web/test/wiring-audit.test.ts` (graphics.newRectangle/newEllipse no longer absent; tool ids added to the golden list), `apps/mcp/test/integration.test.ts` (one delimited `it` + `add_shape` in the tool list), `e2e/support.ts` (type fix). Expect trivial conflicts with wp-m2-text-anim in the `anime-contracts` tests (adjacent lines).
- `README.md` — "Shapes" subsection.

## Licences

None new. `@remotion/shapes` / `@remotion/paths` 4.0.499 were added by the contracts (Remotion licence).

## How to test

- Unit/component: `pnpm vitest run packages/project/test/shapes.test.ts packages/compositions/test/shape-layer.test.tsx apps/web/test/shapes.test.tsx apps/mcp/test/shapes.test.ts`.
- Pixel test (real Chrome render through the engine's `/api/stills`, compared with a 4×4-supersampled analytic reference): `REMOTION_E2E=1 pnpm vitest run apps/engine/test/shapes-remotion.e2e.test.ts`.
- MCP end to end: `MCP_TEST_PORT=<free> pnpm vitest run apps/mcp/test/integration.test.ts`.
- Playwright: `E2E_PORT=<free> pnpm e2e e2e/shapes.spec.ts` (without `--`; builds engine, web and jasper-mcp first).

## Verification (2026-10-01, load average 23–66 on 12 cores, shared machine)

- `pnpm install --frozen-lockfile` ok. `pnpm lint`: Biome checked 0 files inside this worktree because of the
  `!**/.claude` include on a7f1f47 (removed on `main` by 48b5897); with that line dropped locally (not committed)
  `pnpm lint` passes (825 files, check-tokens ok, check-anime ok).
- `pnpm typecheck` ok; `pnpm e2e:typecheck` ok.
- `pnpm test` (`MCP_TEST_PORT=48781`): 1307 passed, 22 skipped, 3 failed — `mg-bundles.test.ts` (zod 3 schema child process), `tracking.test.ts` (input-seek decoding) and `shell-render.test.tsx` (header commands), each at Vitest's 5 s default timeout during the parallel run. Re-run alone: `tracking.test.ts` 12/12 and `shell-render.test.tsx` 7/7 pass with default timeouts; `mg-bundles.test.ts` 14/14 (6 env-gated skipped) passes with `--testTimeout=120000` (its zod 3 conversion takes ~5 s under this load; also listed as timing-only in the contracts notes). None of these tests or the code they exercise is changed by this branch.
- New tests: project 17, compositions 9 (+1 updated), web 14, MCP 2 unit + 1 integration case (integration file 17/17).
- `REMOTION_E2E=1 … shapes-remotion.e2e.test.ts`: passed — stroke widths/edges within 1 px, interiors exact (≤ 3/255), 0.261 % of pixels > 3/255 (anti-aliasing only), worst 62/255.
- `e2e/shapes.spec.ts`: 6/6 passed (1.4 min). The export ran on the **Remotion** path (no layer bake on this branch; the plan showed the "graphics rendering" blocker), annotated in the report. Export frame 30 vs `frame.capture` (renderStill): luma mean 0.33/255, 0 px > 16 at 192×108; colour mean 1.18.

## Defects fixed

- **`@remotion/shapes` `makeEllipse` is off-centre:** it draws one arc from (rx, 0) to (rx + 1, 0), so the ellipse's centre is (rx + 0.5, ry·√(1 − (0.5/rx)²)) — every ellipse was half a pixel right of its box (the pixel test measured 174/255 errors on circle edges). `ShapeLayer` offsets ellipses back (`ellipseOffset`, unit-tested); after the fix the worst error is 62/255 (AA only).
- **Shapes jumped when their box changed** (contracts gap: the box is the largest keyed size + outside stroke, the geometry is centred in it, but the anchor stayed put): any size/stroke edit or a new largest key moved the shape by half the change. Fixed by `keepShapesCentred` (tests: static edits, stroke position, keys added and removed, anchor keys shifted, rotation/scale kept).
- **`param.set` on vec2 ignored the spec range** — `shape.size` would reach the invariant check with negative values and reject the transaction instead of clamping with `W_VALUE_CLAMPED`; vec2 components are now clamped.
- **e2e `sequenceSummary()` was typed with `id`** while the query returns `sequenceId`.

## Known gaps / notes for the integrator

- **After merging wp-m2-layer-bake:** re-run `E2E_PORT=<free> pnpm e2e e2e/shapes.spec.ts` — its export step then
  must plan `native`/`hybrid` (the branch taken when `features.layerBake.state === 'ready'`; not exercised here) and
  match the still with the same tolerances; and re-run `REMOTION_E2E=1 … shapes-remotion.e2e.test.ts`, whose still
  then renders natively with baked layers (`renderPath` native/hybrid accepted). Check that the bake's
  per-frame-bounds crop (LBK-005) uses the shape's layer box: geometry never leaves `intrinsicBox`.
- ANA-007 (`queries.clipSource` shape geometry) belongs to wp-m2-text-anim (`agent/queries.ts`); shapes are
  described by `get_timeline` (format.ts) here.
- An animated shape's selection quad is its largest box, not the current size (handles act on the box).
- KND-055 "Color Matte as a solid shape" and polygon/star/line shapes are out of scope (S11 non-goals, P2).
- The shared e2e helper `regionLuma` seeks with `-ss (frame + 0.5)/fps`, which lands one frame late on the
  exported H.264 (first frame with pts ≥ t); harmless for its static-region uses, so left unchanged —
  `e2e/shapes.spec.ts` selects frames by index instead.
- `main` gained 48b5897 (biome.json) after this branch was cut; no conflict expected.
