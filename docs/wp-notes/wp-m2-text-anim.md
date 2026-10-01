# wp-m2-text-anim — text animators (S11 §4, ANA-002/004/006/007/008, FIX-004)

Branch `wp/m2-text-anim` (from `main` a7f1f47 = the merged `wp-m2-anime-contracts`). Spec: `docs/specs/11-animation.md`.
Contracts: ARCHITECTURE §20, D-31, D-32. Research: `docs/research/animejs-v4-notes.md`.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| TXA-001 | (contracts) `schema/sequence.ts` | Unchanged. A clip without sides has no `textAnimation` (never `{}`); removed sides are deleted, not stored as `null`. |
| TXA-002/003 | `packages/project/src/text-animations.ts` | `TEXT_ANIMATION_SPECS`: fade, slide-up/down/left/right, pop, blur, typewriter, tracking, mask-reveal, rotate-in, drop — all `@1`, phases in+out, strict zod params with every field defaulted (`defaults` = `schema.parse({})`). Common params `unit` (char/word/line), `stagger` 0…1, `order` (forward/backward/center/edges/random), `ease` (`TEXT_ANIMATION_EASES` = the motion `EASE_NAMES`, asserted by a test); preset params `distance`, `blur`, `scale` + `bounce` (pop), `spacing` em (tracking), `angle` (rotate-in), `caret` (typewriter, units char/word). `latestTextAnimationSpec(id)`. |
| TXA-002 impls | `packages/motion/src/text/{index,presets,types}.ts` | `TEXT_ANIMATION_IMPLS` (one per spec, keyed `id@version`, tested equal to the catalogue). Value engine only: each build creates fresh `UnitValues` objects at their start values and adds explicit `[from, rest]` tweens on a paused timeline exactly `durationMs` long. Stagger = fraction of the window spread over the units (each unit keeps ≥ 10 % of the window); `orderRanks` (random = Fisher–Yates with `seededRandom(hash32(clipId, 'text-anim', side))`). Pop uses the spring's ease *function* (`spring({bounce}).ease`, so the window length is kept); typewriter uses `steps(1, true)` per unit slot. Optional `lineMasks` (mask-reveal) and `caret(params)` (typewriter) on `TextAnimationImpl`. |
| TXA-004 | `text-animations.ts` (contracts maths), `motion/src/text/index.ts` `activeTextAnimation`, `commands/handlers/text-animation.ts`, `commands/apply.ts` | In = frames `[0, in)` seeking frame k → `k·1000/fps`; Out = `[d − out, d)` playing the In timeline mirrored (its last frame = the In start state), so the last unit in is the first out. Handles clamp (before the clip: In start; after: Out end; missing side: rest). Compression at render time; `W_ANIMATION_COMPRESSED` from clip.addText/clip.update (their command index) and, for any other command that compresses a clip (trim, razor, speed, rate change), a transaction-level warning (commandIndex −1) from `compressionWarnings` in `apply.ts`. |
| TXA-005 | `placement.ts` `splitClipAt` → `splitTextAnimation`; `handlers/sequence.ts` `changeFrameRate` → `remapTextAnimationFrames` | Razor (and overwrite splits): left keeps In, right keeps Out. Duplicate copies (snapshot of the clip). Trims keep the anchoring. Frame-rate change: `scaleAnimationFrames(d, to, from)` (round, ≥ 1). |
| TXA-006 | `commands/handlers/text-animation.ts` | `clip.addText {textAnimation}` and `clip.update {textAnimation}`: `null` removes all; side `null` removes it; with `preset` replaces (version default = newest; params = defaults ⊕ given; `durationFrames` default = preset default scaled to the sequence fps); without `preset` merges (version change re-validates). Errors: `E_UNKNOWN_EFFECT` (unknown preset/version), `E_INVALID_PARAM` with `['textAnimation', side, 'params', …]` paths, side without animator, non-text clips. Unknown stored presets keep their params; their duration can change, params cannot. `clipIds` in one transaction; no relayout. |
| TXA-007 | `registry/properties.ts` (delimited block), `handlers/param.ts` | Group `textAnimation`: static `textAnimation.{in,out}.preset` (enum `none` + presets, labels) and `.durationFrames` (frames, scrub, default = preset default at the sequence fps); dynamic `textAnimation.{side}.params.<name>` via `jsonSchemaPropertySpecs` (cached per preset). `resolvePropertySpec(key, template?, composition?, clip?)`, `propertiesForClip`, `clipPropertiesJsonSchema` include them. All `animatable: 'no'`, written through `clip.update` patches; `param.set` on them takes the clip.update path (whole-params validation). |
| TXA-008 | `invariants.ts` | INV-012 for invalid params of known presets; `repairDocument` resets them to the preset defaults (`reset-params`). Unknown presets: preserved, snapshot warning `UNKNOWN_TEXT_ANIMATION` (contracts), drawn at rest. |
| TXA-009 | (contracts) `render/snapshot.ts`, `isFrameDependent` | Verified: animated text is frame-dependent in `layerViewEqual` (compositions test). Additional hunk: faces of styled runs are listed in `RenderDoc.fonts`. |
| TXA-010…013 | `packages/compositions/src/layers/TextLayer.tsx` | Rest (and unknown presets, and before the faces are ready — then hidden) = exactly the plain text block (tested: identical `outerHTML` to an un-animated clip). In a window: caps applied, `segmentText` (char → word for RTL/complex scripts), units cut at styled-run boundaries, laid out as inline spans in the same block (same breaks, shaping, kerning), measured once per layout key in a layout effect (`offsetLeft/Top/Width/Height`, `groupLines`) — no `getBoundingClientRect`; the flow is then hidden and an overlay draws each unit (or line) box at its measured place with the seeked values (`translate/scale/rotate`, opacity, `blur()`, letter spacing grown from the centre, reveal). No clipping except mask-reveal's per-line masks; typewriter caret after the last shown unit. TXA-013 measured in Chrome by the e2e spec: character boxes at the last In frame vs the glyphs of the plain text ≤ 1 px. `TextAnimationPreview` + `textAnimationPreviewDoc/Timing` (`src/text-animation-preview.tsx`) render one preset through the real `SequenceComposition` for gallery cards and pickers. Styled runs are now rendered at rest too (defect fix below). |
| TXA-020 | `apps/web/src/text-animation/{TextAnimationsTab,PresetPreview,actions}.tsx` | Cards (poster + shared hover Player via `PreviewThumb`, reduced motion/touch → poster), In/Out side chips + category chips, search; double-click/Enter applies (side = chip), card menu Apply as In / Out; drag MIME `application/x-jasper-text-anim` (`{type: 'jasper/text-anim', preset, version}`). Drops: Timeline clip (pointer frame in the first/second half of the clip), Program layer (left/right half of the layer quad), Effect Controls (position on the mini-timeline, else In). |
| TXA-021 | `text-animation/TextAnimationSection.tsx`, `commands/text-animation.ts` (`clipSections`) | Per side: preset picker popover (grid of previews, None first, "–" for mixed), Duration row (scrubby, timecode/seconds tooltip), params rows (PropertyRow over the dynamic keys; shown when the selection shares the preset), reset (= re-apply the preset). Multi-selection edits all selected text clips in one transaction. |
| TXA-022 | `effectControls/items.ts`, `EffectControlsPanel.tsx`, `MiniTimeline.tsx` (delimited hunks), `text-animation/TextAnimationBars.tsx` | "Text Animation" section after Motion/Opacity (same body as Properties); In/Out bars on the ruler's clip bar (windows as rendered); dragging the inner edge = one gesture (`ops.scrub`), Escape cancels. |
| TXA-023 | `text-animation/TextAnimationWedges.tsx`, `timeline/components/ClipView.tsx` (hunk) | Head/tail SVG wedges of the compressed windows, no gesture. |
| TXA-024 | `commands/text-animation.ts`, `shell/menus/model.ts` (hunk) | `text.applyAnimation {clipIds?, side in/out/both, preset?, version?, durationFrames?, params?}` (agent-exposed; without preset it opens the picker dialog), `text.removeAnimation {clipIds?, side}`; Graphics ▸ Text Animation ▸ Apply In… / Apply Out… / Remove; clip context submenu (Apply In ▸, Apply Out ▸, Remove In/Out/All). No key bindings. |
| ANA-002 | `apps/mcp/src/tools/animation.ts`, `editing.ts` (`add_text` hunk) | `list_text_animations`, `set_text_animation {clipId(s) | "$selection", in?, out?}` (preset id or `{preset?, durationFrames | durationSeconds, params}`, `null` removes; one `clip.update`, one `Agent:` entry, warnings surfaced), `add_text {animateIn, animateOut}`, `ANIMATION_GUIDE`. |
| ANA-004 (P1) | `tools/animation.ts`, `apps/mcp/src/png.ts` | `render_frames {times | count, clipId?, from?, to?, width?, columns?}` → one PNG contact sheet (≤ 24 frames, ≤ 2048 px) + JSON cells (frame, timecode). Self-contained PNG decode/encode (`node:zlib`). |
| ANA-006 | `apps/mcp/src/examples.ts` | `clip.addText` with `textAnimation`; `clip.update` with a replaced and a merged side (dry-run by the integration test). |
| ANA-007 | `packages/project/src/agent/queries.ts` | `clipSource`: text + `animation {in, out}`, shape geometry (static values; `{value, keyframes: n}` when animated), composition `{mediaId, id}` + props + canvas. |
| ANA-008 | `apps/mcp/src/format.ts` | `text "…" in:slide-up out:fade`; `motion graphic id@v (anime)`. Shapes add their own hunk. |
| FIX-004 | `handlers/param.ts`, `clip-core.ts` (`applyClipPatch` exported) | `param.set` on any text property written by `clip.update` (style, box, stroke, background, text animators) runs the clip.update path: layout re-runs, values are schema-checked. |

## Contract changes (additive)

- `PropertyGroup += 'textAnimation'`; `resolvePropertySpec` optional 4th argument `clip`; new exports `textAnimationParamSpecs`, `latestTextAnimationSpec`, `TEXT_ANIMATION_UNITS/ORDERS/EASES`; `applyClipPatch` exported from `clip-core.ts`.
- `TextAnimationImpl.lineMasks?`, `.caret?`; `@jasper/motion/text` exports `activeTextAnimation`, `textAnimationImpl`, `textAnimationUnit`, `orderRanks`.
- `@jasper/compositions` exports `TextAnimationPreview`, `textAnimationPreviewDoc`, `textAnimationPreviewTiming`, `TEXT_ANIMATION_PREVIEW`.
- `Ruler` (Effect Controls mini-timeline) optional `overlay` prop.
- Snapshot: faces of styled runs are part of `fonts`.

## Cross-package edits (delimited hunks)

`packages/project/src/commands/apply.ts` (transaction-level compression warning), `placement.ts` (razor), `handlers/sequence.ts` (rate remap), `render/snapshot.ts` (run faces), `apps/web/src/panels/timeline/TimelinePanel.tsx` and `components/ClipView.tsx`, `panels/program/TransformOverlay.tsx`, `panels/effectControls/{EffectControlsPanel.tsx,items.ts,MiniTimeline.tsx}`, `panels/properties/lib/model.ts` (`bindProperty` passes the clip), `shell/menus/model.ts`, `packages/motion/test/runtime.test.tsx` and the three `anime-contracts` tests (assertions that expected empty catalogues/stubs), `e2e/editing.spec.ts` (the `Graphics ▸ New Layer ▸ Text` selector must not match the new "Text Animation" submenu).

## Licences

No new dependency. anime.js 4.5.0 (MIT) through `@jasper/motion` (contracts).

## How to test

- Unit/component: `pnpm vitest run --project @jasper/project packages/project/test/text-animation.test.ts`, `--project @jasper/motion packages/motion/test/text.test.ts` (determinism of every preset: in order, reversed, shuffled, fresh build; In and Out), `--project @jasper/compositions packages/compositions/test/text-animation.test.tsx`, `--project @jasper/web apps/web/test/text-animation.test.tsx`, `--project @jasper/mcp apps/mcp/test/animation.test.ts apps/mcp/test/integration.test.ts` (`REMOTION_E2E=1` adds the render over the animated clip).
- Playwright: `pnpm e2e` prerequisites, then `E2E_PORT=48461 npx playwright test e2e/text-animation.spec.ts`.

Verification (2026-10-01, load average 25–35 on 12 cores): `pnpm typecheck` ok, `pnpm e2e:typecheck` ok, lint
(Biome with the worktree workaround below, `check-tokens`, `check-anime`) ok. `pnpm test`: 1343 passed, 22
skipped, 2 failed — `apps/engine/test/anime.test.ts` expected `textPresets: 0` (updated to the catalogue) and
`apps/engine/test/mg-bundles.test.ts` (zod 3 schema conversion) hit the 5 s default timeout under load; both files
pass alone (21 passed, 6 skipped). MCP: `animation.test.ts` + `anime-contracts.test.ts` 13/13, integration 19 + 1
gated (20/20 with `REMOTION_E2E=1`). Playwright `e2e/text-animation.spec.ts`: 8/8 passed (Remotion export path,
`features.layerBake` not ready on this branch).

## Defects fixed

- Styled `runs` were stored but never rendered (the text layer drew `text` only) and their faces were never loaded: runs now render as inline spans (rest and animated) and the snapshot lists their faces (`packages/compositions/test/text-animation.test.tsx`, `packages/project/test/text-animation.test.ts`).
- FIX-004: `param.set text.sizePx` (and every other layout-affecting text field) wrote the field without re-running layout.
- `param.set` on `text.strokeWidth`, `text.strokeColor` and the background keys failed ("Unsupported parameter path") when the clip had no stroke/background yet, although Properties could create them: they now use the same clip.update patches (test).

## Known gaps

- Paste / Paste Attributes do not exist in the app yet (no clip clipboard); `clip.duplicate` copies the animators.
- The random order is seeded by the clip id (ANM-007); LBK-020 normalises the clip id out of the bake key, so two clips with identical content and `order: 'random'` would share a key but not a permutation — layer-bake should put the seed (or the clip id when `order === 'random'`) into the key.
- A word broken across lines by `overflow-wrap` is drawn on its first line during the window.
- The typewriter caret does not blink.
- ANM-015 (performance) is wp-m2-anime-core's; most presets animate 1–2 properties per unit (≈ 2N tweens).
- `text.applyAnimation` stays enabled without a text selection (agents pass `clipIds`); from menus it then reports "Select a text clip first".
- Biome's `!**/.claude` ignore makes `pnpm lint` check no files inside an agent worktree; lint was run with that line removed from a temporary copy of `biome.json`.

## For the integrator after merging wp-m2-layer-bake

- Re-run `e2e/text-animation.spec.ts`: with `features.layerBake.state === 'ready'` the export step expects plan path native/hybrid and render path `native` or `hybrid`, and still compares the mid-In frame with `renderStill` (≤ 3/255 on 99 %). Before layer-bake it asserts the Remotion path and adds a `layer-bake` annotation.
- Check the bake key includes what the text layer depends on: text, style, runs and their faces, box, `animation` (params + compressed frames) and the random-order seed (see gaps).
