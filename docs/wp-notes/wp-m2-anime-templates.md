# wp-m2-anime-templates — animated motion-graphic templates (S11 §5)

Branch `wp/m2-anime-templates` (from `main` a7f1f47 = the wp-m2-anime-contracts merge). Spec:
`docs/specs/11-animation.md` (ATP-001…010, ANA-003, ANA-005, FIX-001, FIX-005, FIX-008). Contracts: ARCHITECTURE
§20, D-31, D-32. Research: `docs/research/animejs-v4-notes.md`.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| ATP-001 | `packages/mg-templates/src/templates/anime/*`, `catalog.ts`; `packages/motion/src/templates/*` | Metadata (`MgAnimeTemplateDefinition`: strict zod params, defaults, intro/outro frames, default duration, canvases, `renderVersion`, `posterAt`) in `@jasper/mg-templates` (`ANIME_CATALOG`, appended to `MG_CATALOG`); React implementations in `@jasper/motion/templates` (`ANIME_TEMPLATE_IMPLS`, keyed `id@version`). Tests assert both lists match (motion + mg-templates). |
| ATP-002 | contracts (`clip.addMotionGraphic` stamp, `clipEngines`, snapshot `mg.renderer`); `packages/project/src/invariants.ts` (delimited block) | `checkInvariants(doc, {mgTemplates})` flags a stamp that contradicts a known registry entry (INV-012); `repairDocument(doc, ids, {mgTemplates})` / `loadProject(raw, {mgTemplates})` re-stamp it (`restamp-renderer`). Wired where a registry is at hand: the export planner and the engine agent service. Runtime consumers (layer, engine routing, web) decide by the registry for installed templates and by the stamp only for unknown ones. `clip.update {template}` re-stamps. |
| ATP-003 | `title-reveal@1`, `lower-third-anim@1`, `callout@1`, `counter@1` | Canvases 16:9 / 9:16 / 1:1, design pixels fitted with `fitCanvas` (`DesignStage`). title-reveal: graphemes (word fallback for scripts that need shaping) rise in a forward / centre / seeded-random order, subtitle follows, underline draws on (dash length from its known width). lower-third-anim: bar grows, panel wipes (clip-path), name/role words stagger; outro = reversed intro. callout: dot pop + pulse ring, leader line drawn by `createDrawable` on a ref-owned `<path>` leaf (`useAnimeDom`), label box; `motionPath` moves the box along the line (arc-length table of the line's own geometry, no DOM measurement). counter: progress 0→1 over `countSeconds` (own timeline, read un-rounded — see Review fixes), `from + (to − from)·p` formatted by `formatCounterValue` (locale-independent: decimals, thousands `none/comma/period/space/thin/apostrophe`, decimal `period/comma`, prefix/suffix, U+2212 minus), tabular numerals. |
| ATP-004 | `anime/timing.ts` (`animeTemplateTiming`, `animeFramesAt`), `motion/src/templates/common.tsx` (`addInOut`, `phaseTimes`) | Intro anchored at content 0, outro ending at the content end (`sourceIn + duration`), hold stretches; `introFrames`/`outroFrames` are written at 30 fps (`ANIME_REFERENCE_FPS`) and converted to whole sequence frames (seconds kept, frame-exact at any rate); intro + outro longer than the content are compressed proportionally. One paused timeline per template: each phase's intro tween and its mirrored outro tween (explicit `[from, to]`, never overlapping on one property, ≥ 1 ms). Seek = content frame → ms, canonical seek through `useAnimeValues`. |
| ATP-005, FIX-001 | `packages/compositions/src/layers/MotionGraphicLayer.tsx` | Dispatch on the renderer; both renderers inside `LayerBox` (effects stages, corner pin = projective `matrix3d`, opacity, every blend mode incl. `add` → `plus-lighter`). fframes twin markup unchanged (same `renderSvg` call; the badge moved to LayerBox's overlay). Anime: `{params, timeMs, totalMs, introMs, outroMs, fps, canvas, seed = hash32(clipId, 'template'), isPreview}`; drawn only once `FontsReadyContext.allLoaded` (FIX-003). New `MgTemplatePreview` (gallery posters / hover previews; same drawing code). |
| ATP-006 | `schema/sequence.ts` (`paramKeyframes`), `registry/properties.ts` (delimited block), `commands/handlers/mg-template.ts`, `keyframe.ts`, `param.ts` hunk, `placement.ts` hunk, `render/snapshot.ts` hunk | Storage: the static value stays in `params[name]` (validated by the template schema, what every M1 consumer reads); keyframes in `MotionGraphicClip.paramKeyframes[name]` (content time, flicks). Numeric (non-integer) and colour params of anime templates are `animatable: 'continuous'` (`isKeyframableTemplateParam`); integers, strings, enums, booleans and every fframes param stay static. `param.set` / `param.setAnimated` / `keyframe.*` / `keyframes.prune` work on `['clip', id, 'params', name]` through a draft Animatable view (`templateParamDraftAnim`: the keyframe list is attached only when a key is pushed, emptied lists are pruned). `clipAnimatables` lists the dynamic keys. The snapshot's mg source carries `paramKeyframes` (anime only, unevaluated); the layer evaluates them with `evaluateTemplateParams` (shared evaluator, clamped to the param ranges). Effect Controls / Properties get stopwatches through the generic property rows. Split/duplicate re-id them. Invariants: strictly increasing times, value shape = the param's (INV-011), ids claimed (INV-001); repair drops malformed lists. |
| ATP-007 | `apps/web/src/panels/motionTemplates/{MotionTemplatesPanel,PreviewThumb,TemplateSection}.tsx` | Gallery: anime cards (badge **R**, label *anime · Remotion*), engine filter `all / fframes / anime`; every card has the shared hover `<Player>` (PreviewThumb over `MgTemplatePreview`, 640×360 @ 30). Anime posters = `<Thumbnail>` at `posterAt`; fframes posters keep the SVG twin (new optional `PreviewThumb.poster`, additive). Insert / drag / double-click / Enter unchanged. |
| ATP-008 | `apps/engine/src/mg/{templates,service}.ts`, `routes/mg.ts`; planner/service hunks | Catalogue: anime entries `renderer: 'anime'`, `native: false` (also when jasper-mg is ready). `requestRender` and `POST /api/motion-graphics/render` refuse anime templates (400 `ANIME_TEMPLATE`, before the fframes capability check); `mgMasterProvider` returns null; `collectMgMasters` skips them; the planner adds a native blocker for anime clips no extension claims (Auto → Remotion), none when layer-bake claims them. Web: `mg.rerender` / `mgSpecForClip` fframes-only; the Template section hides Re-render for anime. |
| ATP-009, FIX-005 | `packages/mg-templates/src/registry.ts` (`upgradeParams`, `MgRegistry.upgrade`), `handlers/mg-template.ts`, `apps/web/src/commands/mg.ts`, `TemplateSection.tsx` | `upgrade(id, fromVersion, params, toVersion?)` searches the graph of `upgrades` steps (depth-first, largest jump first, backtracking past steps that throw or yield invalid params), validating with the target schema: the highest reachable version, or exactly `toVersion`; null without a path. `clip.update {template: {version}}`: no-op for the same version; refuses downgrades, versions not installed and versions without a path; migrates params, re-stamps the renderer, keeps keyframes of params that stay keyframable with the same value shape and drops the others (`W_KEYFRAMES_DROPPED`). UI: Properties ▸ Template "Update template to vN" and the agent-exposed `mg.updateTemplate` (one undo step). Agents also use `clip.update`. |
| ATP-010, FIX-008 | `apps/engine/src/mg/templates.ts`, planner hunk; `MotionGraphicLayer` | Preview: "Template id@vN is not installed" card (whatever the stamp). Exports: `planExport` throws `TEMPLATE_NOT_INSTALLED` (409, per-clip blockers, hint) for native, Remotion and still plans when a clip in range uses a template this build lacks — `POST /api/exports`, `/api/exports/plan` answer 409, still jobs fail with that code (MCP `render_frame`, Export Frame). |
| ANA-003, ANA-005 | `apps/mcp/src/tools/{render,templates}.ts`, `errors.ts`, `server.ts` hunk | See "MCP" below. |

## MCP

- `list_motion_templates`: per template `renderer` ('fframes' default), `native`, and `params: [{name, type
  ('string ≤120', 'number 24…240', 'integer 0…6', 'enum a|b', 'boolean', 'rgba', 'vec2'), default, keyframable,
  description?}]` (keyframable = anime template and a non-integer number or RGBA, the model's rule); `defaults` and
  `paramsSchema` kept.
- `render_motion_graphic_preview`: anime templates never go to `mgRender`; params are checked against the JSON
  Schema (`E_INVALID_PARAM` with the issues), a one-clip document (sequence = requested size rounded to even, default
  960×540 @ 30, clip on V1 from 0, canvas 'sequence') is rendered with `requestStill` at the middle of the clip
  (`posterAt` is not in the API catalogue) — superseded by the review fixes: the hold's middle; optional `frames`
  1–6 samples intro, hold and outro (3 = their middles, the outro's at `d − ceil(outro/2)`). `RENDERER_UNAVAILABLE` stays for fframes templates only.
- New `set_motion_graphic_params {projectId, clipId, params, at?, keyframe?, dryRun?}` (`tools/templates.ts`,
  `TEMPLATES_GUIDE`): one Agent transaction; static params → one merged `clip.update {params}`; `keyframe: true` (needs
  `at`) → `param.setAnimated` (when not animated yet) + `param.set {value, at}`; already animated params need `at`
  (otherwise refused — their keyframes would override a static write). Rejects unknown clips/params, non motion-graphic
  clips, keyframing non-keyframable or fframes params, `at` outside the clip; `TEMPLATE_NOT_INSTALLED` for templates
  missing from the catalogue.
- ANA-005 hints (`renderHint` in `errors.ts`): `TEMPLATE_NOT_INSTALLED`, `PATH_NOT_ELIGIBLE` (blockers + engine
  auto/remotion), missing Remotion/Chrome (install Chrome, `JASPER_BROWSER_EXECUTABLE`, browser download, `pnpm build` /
  `JASPER_REMOTION_BUNDLE`, `JASPER_REMOTION_BIN_DIR` for packaged builds), `needs-browser-download`,
  `WEBGL_UNAVAILABLE` (`JASPER_REMOTION_GL`), applied in `render_frame`, `start_export` (also on plan warnings
  `REMOTION_UNAVAILABLE` / `BROWSER_DOWNLOAD`) and `wait_for_job`; capabilities are fetched only after a failure.
- `add_motion_graphic` works unchanged for anime templates (integration test).

## Contract changes (additive)

- `MgTemplateRegistry.upgrade?(id, fromVersion, params, toVersion?)` (optional `toVersion`).
- `MotionGraphicClipSchema.paramKeyframes?: Record<string, Keyframe<number | number[]>[]>`; `RenderVisualSource` mg `paramKeyframes?` (anime only).
- `WARNING_CODES += 'W_KEYFRAMES_DROPPED'`.
- `InvariantOptions.mgTemplates?`, `repairDocument(doc, ids, opts?)`, `loadProject(raw, {mgTemplates?})`.
- `@jasper/mg-templates`: `ANIME_CATALOG`, anime metadata exports, `animeTemplateTiming`, `ANIME_REFERENCE_FPS`, `formatCounterValue`, `rgbaCss`, `upgradeParams`; `MgRegistry.upgrade` always present.
- `@jasper/motion/templates`: `AnimeTemplateProps` moved to `types.ts` (re-exported unchanged), builders exported.
- `@jasper/compositions`: `MgTemplatePreview`; MotionGraphicLayer's `data-mg-template` / `data-mg-renderer` attributes moved from the box to its content (the box is now LayerBox's).
- `PreviewThumb.poster?` (web).
- Engine: route error code `ANIME_TEMPLATE`; plan error `TEMPLATE_NOT_INSTALLED`.

## Cross-package edits (minimal, delimited `wp-m2-anime-templates`)

- `apps/engine/src/export/planner.ts` (wp-m2-layer-bake): `loadProject(…, {mgTemplates: mgRegistry})`; the
  `TEMPLATE_NOT_INSTALLED` block after the snapshot; the anime native blocker in the classification loop.
- `apps/engine/src/export/service.ts` (wp-m2-layer-bake): `collectMgMasters` filters `!isAnimeTemplateClip(c)`.
- `apps/engine/src/agent/service.ts`: `loadProject` gets `mgTemplates`.
- `apps/engine/src/routes/mg.ts` (WP-2G): anime refusal before the capability check; `ANIME_TEMPLATE` code.
- `packages/project/src/commands/handlers/param.ts`: the keyframable-template-param branch of `resolveTarget`.
- `packages/project/src/commands/placement.ts`: `reidentifyClipChildren` re-ids `paramKeyframes`.
- `packages/project/src/{schema/sequence.ts,render/snapshot.ts,invariants.ts,migrations.ts,commands/types.ts,registry/mg.ts}`: the additive contract items above.
- `packages/project/test/anime-contracts.test.ts`, `packages/mg-templates/test/anime-contracts.test.ts`, `packages/compositions/test/{anime-contracts,motion-graphic-layer}.test.tsx`, `packages/motion/test/runtime.test.tsx` (2 lines: no longer asserts `ANIME_TEMPLATE_IMPLS` is empty), `apps/engine/test/mg.test.ts`, `apps/web/test/motion-templates.test.tsx`: expectations that described the empty contracts state.
- `README.md`: subsection "Animated templates (anime.js)".

## Licences

No new dependencies (anime.js 4.5.0 and `@remotion/*` came with the contracts).

## How to test

- Unit/component: `pnpm vitest run --project @jasper/mg-templates --project @jasper/motion --project @jasper/compositions` and the files `packages/project/test/anime-templates.test.ts`, `apps/engine/test/anime-templates.test.ts`, `apps/web/test/anime-templates.test.tsx`, `apps/mcp/test/templates.test.ts`.
- Parity of the fframes templates: `pnpm mg:build && MG_PARITY=1 pnpm vitest run packages/mg-templates`.
  Requires Chromium (Playwright installation, system Google Chrome or `JASPER_BROWSER_EXECUTABLE`). The native/TS
  SVG comparison rasterizes both frames in the same browser and saves PNGs under the logged temporary
  `jasper-mg-svg-parity-*` directory; equivalent SVG markup is allowed.
- Playwright: `E2E_PORT=48447 pnpm e2e e2e/anime-templates.spec.ts`.

## Verification (2026-10-01, load average 25–55 on 12 cores)

- `pnpm install --frozen-lockfile`: ok. `pnpm typecheck`: ok. `pnpm e2e:typecheck`: ok.
- Lint: `pnpm lint` reports "No files were processed" inside this worktree because `biome.json` ignores `**/.claude`
  (a7f1f47) and the worktree lives under `.claude/worktrees/`; the equivalent `biome check apps packages e2e scripts
  fixtures docs *.json *.ts` (833 files) + `check-tokens` + `check-anime`: ok.
- `pnpm test`: 1349 passed, 19 skipped, 8 failed in the parallel run. 1 was mine (`apps/engine/test/anime.test.ts`
  asserted `templates: 0`; fixed). The other 7 are timing-only under load and pass alone / with a longer timeout:
  `mg-bundles.test.ts` zod 3 schemas (5 s timeout; passes with `--testTimeout=60000`, 9.7 s), `jobs.test.ts` HTTP
  cancel (passes alone), `tracking.test.ts` input seek (passes with 60 s) and "stops within 500 ms" (766 ms in the
  parallel run, passes alone), `mg.test.ts` real jasper-mg render (120 s timeout; passes alone), web `app.test.tsx`
  and `shell-render.test.tsx` (5 s; pass alone). The same files were reported as load-sensitive by the contracts run.
- `pnpm mg:build && MG_PARITY=1 pnpm vitest run --project @jasper/mg-templates`: 39 passed (schema + SVG parity).
- MCP: `npx vitest run --project @jasper/mcp` unit files 41 passed / 1 skipped (MG_E2E); `REMOTION_E2E=1`
  `integration.test.ts` 20/20 (incl. the real Remotion still of an anime template).
- Playwright `E2E_PORT=48447 pnpm e2e e2e/anime-templates.spec.ts`: 8/8 passed (1.7 min). This branch alone:
  layer-bake is not registered, so the export planned the Remotion path (annotated); ProRes export vs
  `renderStill` at frame 44: 99.23 % of pixels within 3/255 (max 10).

## Defects fixed

- FIX-001: `MotionGraphicLayer` built its own box (no effects, no corner pin, `add` blend unmapped) — LayerBox now
  (test `compositions/test/anime-template-layer.test.tsx`).
- FIX-005 / FIX-008 (spec items).
- `mg.rerender` and `mgSpecForClip` sent every motion-graphic clip (would include anime templates and templates
  this build lacks) to jasper-mg; now fframes-only (test `apps/web/test/anime-templates.test.tsx`).
- `POST /api/motion-graphics/render` with an anime spec answered `503 MG_UNAVAILABLE` (or tried jasper-mg) instead
  of explaining; now `400 ANIME_TEMPLATE` before the capability check (test `apps/engine/test/anime-templates.test.ts`).
- Checked, not a defect: `title-card.ts` ignores `idPrefix` — its markup (TS and Rust) has no element ids.

## Review fixes (branch `fix/anime-templates-review`)

Verified review findings, each with a regression test.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Preview/export mismatch when a template draws outside its canvas (`DesignStage` was `overflow: visible`; the hybrid bake crops box + 10 % bleed, `contentBleed` 0 for motion graphics) — e.g. `callout@1` with `labelX: 0.95` at 50 %: Player showed the label, the export cut it. | `DesignStage` (the anime content root) clips: `overflow: hidden`, like the fframes SVG; Player, `renderStill` and the hybrid crop agree. `contentBleed` documents why motion graphics need no bleed. The designs stay inside every design canvas at default params (checked; no range changes needed — out-of-canvas params are clipped consistently). `renderVersion` 2 for all four templates (bake keys). README note. | `motion/test/templates-review.test.tsx` (root clips; parts of callout / lower-third-anim inside 16:9, 9:16, 1:1 at intro and hold, motion path too; title-reveal / counter text fits by estimate); `compositions/test/anime-template-layer.test.tsx` (callout `labelX: 0.95` scaled 50 % clipped at the layer box); `engine/test/layer-bake.test.ts` (`contentBleed` 0) |
| 2 | `callout@1` pulse ring showed at 0.8 opacity before it started (first frames, head handles): a tween starting at 0.08·intro holds its from-value. | The ring's opacity is keyed from content 0: `0 → 0.8` while the dot pops, `0.8 → 0` during the pulse (`CALLOUT_PULSE_PHASE`); the scale tween is unchanged. | `templates-review.test.tsx` (initial state at −1000 ms / −3 frames / 0: dot 0, ring 0, label 0; peak 0.8 at the pulse start; rest: dot 1, ring 0, label 1; end of outro: all 0; rendered ring opacity 0 at frames 0, −2 and the hold) |
| 3 | `render_motion_graphic_preview` `frames: 3` never reached the outro (evenly spaced frames). | `previewFrames(d, count, {introFrames, outroFrames, fps})` + `previewPhases` (reference-rate conversion and proportional compression of `animeTemplateTiming`, mirrored because the MCP does not depend on `@jasper/mg-templates`): 1 = hold middle, 2 = + intro middle, 3 = + `d − ceil(outro/2)`, 4–6 alternate extra samples between intro and outro; empty phases hand their share to the hold / the clip. Tool description and arg docs updated. | `mcp/test/templates.test.ts` (title-reveal 5 s → frame 84; 25 fps 2 s `frames: 3` → `[15, 32, 42]`; counts 1–6, compressed clips 10–300 frames keep the last sample inside the outro, 60 fps, no outro) |
| 4 | `upgradeParams` took the biggest single jump without backtracking (dead ends, failing migrations ended the walk). | Depth-first search over the step graph, largest jump first, backtracking; highest reachable version without a target, an exact path with one; steps that throw / produce invalid params are skipped in favour of other steps. A working direct jump is still preferred. | `mg-templates/test/anime-templates.test.ts` "searches the step graph" |
| 5 | Hybrid stills reported as `renderedBy: 'remotion'`. | `renderedBy` = the still job's `renderPath` (`native` / `hybrid` / `remotion`). | `mcp/test/templates.test.ts` "reports the still path" |
| 6 | `mg.updateTemplate` ignored its `clipIds` arg in `when` (disabled without an upgradable selection even when an agent passed ids). | `when` = an editable session (like `text.applyAnimation`); `run` checks the selection only when no `clipIds` are given (info toast); `hasTemplateUpgrade` helper. | `web/test/anime-templates.test.tsx` (clipIds with an empty selection upgrades; no-op toast; error for ids without an upgrade) |
| 7a | `applyTemplatePatch` did not check the clip's canvas against the new version's `canvases`. | Refuses (`E_INVALID_PARAM`, names the canvases) when the new version has no canvas of the clip's aspect (explicit size, or the sequence frame for `'sequence'`; a `canvas` in the same patch counts) and the old version had one; same aspect at another size is fine; templates without `canvases` accept any size. | `project/test/anime-templates.test.ts` "template upgrade checks the clip canvas" |
| 7b | `list_motion_templates` dropped the counter's ±1e12 range (`HUGE = 1e9`). | Bounds count unless they reach `Number.MAX_SAFE_INTEGER` (zod's `.int()` default bounds). | `mcp/test/templates.test.ts` (`number -1000000000000…1000000000000`; safe-integer bounds → `integer`) |
| 7c | Properties ▸ Template based the engine label and Re-render on the first selected clip. | Mixed selections list every engine (`anime · Remotion / fframes`); Re-render shows when any selected clip is fframes; the update button reads "Update templates" when the targets differ. | `web/test/anime-templates.test.tsx` "mixed selections" |
| 8 | `counter@1` precision: the hook rounds values to 1e-6, so `from + (to − from)·p` moved in steps of (to − from)·1e-6 (0 → 25,000,000 ended in 00/25/50/75 only). | The count progress has its own timeline (`buildCounterCount`); `counterProgressAt` reads it un-rounded right after the canonical seek (pure in the time), snapping to exactly 0 / 1 where the rounded value is 0 / 1; `counterValue` returns `from` / `to` exactly at the ends. The global 1e-6 rounding is unchanged. | `templates-review.test.tsx` (0 → 25,000,000: exact ends, counting frames not multiples of 25; progress exact at rest and reproducible) |

Verification (2026-10-01): `pnpm lint` (897 files + check-tokens + check-anime), `pnpm typecheck`, `pnpm e2e:typecheck`:
ok. `pnpm test`: 147 files passed, 5 skipped; 1590 tests passed, 45 skipped, 0 failed (647 s). Playwright
`E2E_PORT=48463 pnpm e2e e2e/anime-templates.spec.ts`: 8/8 passed (5.4 min); hybrid export vs `renderStill` at frame 44:
99.85 % of pixels within 3/255 (max 6).

## Known gaps

- The renderer-stamp repair runs where `loadProject` gets the registry (export planner, engine agent service). The
  web session's project stores (`packages/session`, not this package) load without it; every consumer that matters
  decides by the registry for installed templates, so a contradicting stamp only shows a wrong timeline badge until
  the stores pass `mgTemplates` (one-line follow-up for the integrator).
- `posterAt` is seconds of content time; the API catalogue does not carry it, so MCP previews use the middle of the hold (review fix 3).
- With both `params` and `template` in one `clip.update`, the params are applied (old version) before the upgrade
  (order in `clip-core.ts`, not mine).
- No shipped template has a version 2, so "Update template to vN" is covered by unit/component tests with test
  registries, not by the e2e.
- Planner (layer-bake owns it): `graphicsGroups` still lists anime clips with engine `fframes`, and the fframes
  blocker also fires for anime clips when jasper-mg is unavailable (LBK-002 changes both).
- Template text uses the `Inter, 'Source Sans 3', …, sans-serif` stack from the system (no document font face to
  wait for); Player and Remotion renders on one machine agree, other machines may pick another family.
- S05:MGT-002 card context menu (Insert and Edit, Favorite, Show Details) is not part of S11 and not done.
- README core-tool list / count (FIX-006) is left to the integrator.

## After merging wp-m2-layer-bake (integrator)

- `export/planner.ts`: keep both delimited hunks; the anime native blocker disappears automatically for clips the
  bake extension claims (it checks `claimsLayer`). Apply LBK-002's `renderer !== 'anime'` to the fframes check and
  `graphicsGroups`.
- `export/service.ts`: `collectMgMasters` must skip anime templates exactly once (this branch adds the filter).
- The bake should claim with `isAnimeTemplateClip` (registry first) or the snapshot `mg.renderer` (re-stamped by
  the planner's `loadProject`); its render key should include the template's `renderVersion`
  (`mgRegistry.getDefinition`) — `paramKeyframes` are already in the clip source. Anime templates are never static
  (LBK-004).
- Re-run `E2E_PORT=… pnpm e2e e2e/anime-templates.spec.ts`: with `features.layerBake.state === 'ready'` the export
  step expects a `native`/`hybrid` plan and the same ≥ 99 % within 3/255 parity with `renderStill`.
