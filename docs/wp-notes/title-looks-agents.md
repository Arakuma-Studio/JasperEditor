# Title Looks for agents (spec 19 §11, TL-100 to TL-107)

The agent surface of [Title Looks](title-looks.md): search, sheet, propose, check, as sound design works.

| Piece | File |
|---|---|
| Tools `find_title_looks`, `propose_title`, `title_check`, `get_title_recipe`, `save_title_look`, `add_title_generator`, `set_global_light`, guide `TITLE_ART_GUIDE`, resource `jasper://title-looks/{id}` | `apps/mcp/src/tools/titles.ts` |
| `list_effects`, `add_effect`, `set_effect_param` | `apps/mcp/src/tools/effects.ts` |
| Sheets as one job, safe-area guides, numbers, downscaling | `apps/mcp/src/still-sheet.ts`, `render_frames` in `tools/animation.ts` |
| The `still-sheet` job | `apps/engine/src/export/service.ts` (`runStillSheet`), `POST /api/stills/sheet`, `GET /renders/:jobId/cells/:index` |
| Measurements and rows (pure, no render) | `packages/project/src/title-looks/check.ts` |
| Style lint as rows | `apps/mcp/src/title-lint.ts` |
| Recipe bounds | `packages/project/src/title-looks/recipe-bounds.ts` |
| Feature `title-art`, draft, meta reader | `packages/project/src/proposals/{features,title-art}.ts` |

## Decisions

- **One job with many cells.** A sheet is `still-sheet`: documents, then cells naming a document, a sequence, a frame and
  clips to hide. One progress, one cancel, one result. `renderStillPng` is what `runStill` always did, so a cell takes the
  export's path. Frames were up to 120 s each with no overall limit before: about 48 minutes for 24 cells.
- **Cells are PNGs the engine serves; the sheet is composed in MCP.** The check needs the pixels of every cell, and the
  overlay and numbers are drawn there. A sheet that outlives its wait stays recoverable, because the job remembers its
  layout in `result.meta`: `render_frames {jobId}`.
- **`hide` on a cell, not a second document.** The picture behind a title differs from the frame by one clip. Sending a
  copy would double the request against the engine's 20 MB body limit. Each alternative is still a document, so a sheet
  that would exceed the limit is refused with `E_TOO_LARGE`, naming alternatives as what to drop.
- **Real alpha by difference matting.** The title alone over black and over white gives `a = 1 − (white − black) / 255`.
  It needs no alpha support in the still path, works on native, hybrid and Remotion alike, and does not depend on the
  title's colour. A frame's measurement is four renders: with, behind, black, white. Layer bakes are cached, so on the
  hybrid path the extra renders are cheap.
- **Contrast is per tile, with three ways to pass.** The title's box is cut into tiles of 1/40 of the width. A tile
  takes the best of: inside the title against the picture behind it, its outer edge against it (a dark rim on a light
  picture), and its own contrast (letters on a plate). The median decides `fail`, the worst tenth decides `warn`, so a
  title half over sky and half over sand is not averaged into a pass. A tile needs 10 % solid ink: slivers of soft
  shadow are not parts of the title to read.
- **Sampled at rest.** `title_check` measures the first, middle and last frame of the hold, from the text animators.
  Sliding in from off the frame is not a safe-area failure. The animation itself is listed in `notChecked`.
- **Headless propose is refused, not stored.** With no editor window nobody can review a proposal, and an agent told
  "stored" would report it as waiting in Review. `E_NO_EDITOR` names both ways out. `open_project_in_editor` is outside
  core, so the hint names `call_tool`.
- **Headless apply returns `revert`.** There is no History there. `revert` lifts the clip and deletes the look if this
  call created it, and says what it leaves: fonts have no remove command, and removing a track needs the user's approval.
- **`apply` obeys Agent Proposals.** It would otherwise be a way round the user's own setting for `title-art`.
- **`title-art` is on by default**, like the other decoration features: one undoable title the user asked for. Rough
  cuts stay the exception.
- **Bounds run before anything reads the recipe.** The walk is iterative and stops at the first problem, so 200 000 levels
  of nesting or a cycle cannot overflow the stack. `instances` is 8 layers of a type and 4 generators: TL-106 names the
  cap without a figure, and each layer repeats its passes (`docs/performance.md` §7). TL-013 still applies at the command.
- **`renderPath` in `find_title_looks` comes from the planner**, once per page on the sheet's scratch document. `costClass`
  is computed: `heavy` for a look that moves on its own or has over 8 layers, `medium` over 4, else `light`. The bands
  are an assumption, based on §7's six-layer figures.
- **Width.** TL-106's "640 px by default" is read literally: the sheet, not a cell. At three columns a cell is 208 px, so
  the tools take `width` up to 1280.
- **The lint seam.** `title-lint.ts` imports `lintAppearance` from `@jasper/project` (the library's TL-056 lint; the
  Properties style badge uses the same one). It calls the lint once per measured frame with `rendered.backdropL` and keeps
  the worst answer per issue. A caller that passes no lint gets an `unverified` row, never a clean pass. `titles.test.ts`
  runs the real lint (rings that merge, thin rims, a measured backdrop) as well as stand-ins.
- **Two tool names were wrong.** The scan of TL-107 found `remove_time_remap` in `TIME_GUIDE` and `generate_subtitles` in
  the subtitles feature's producers; both now name real tools. It also scans feature producers, which TL-107 does not ask for.

## TL-098 contract for the Review panel

`titleArtMetaOf(item)` and `titleArtMetaOf(item.alternatives[k])` give `{text, lookId?, lookName, colorwayId?, colorwayName?,
seed, clipRef, costClass?, renderPath?}`, or null. Item id `title`, group `titles`. `clipRef` is the temp ref of the clip.

## Thresholds and sources

| Value | Source |
|---|---|
| Contrast 3:1 for large text, 4.5:1 otherwise | WCAG 2.x SC 1.4.3 (AA) |
| Large = 24 px on a 1080-line frame | Assumption: WCAG's 24 CSS px, taking the frame as the page |
| Relative luminance, contrast ratio | WCAG 2.x definitions |
| Safe margins: action 5 %, title 10 % per side | The Program monitor's `SAFE_MARGINS` (`TransformOverlay.tsx`), so the row and the overlay agree |
| Reading: 15 characters a second | BBC subtitle guidelines, 160–180 words a minute; 180 ≈ 15 cps by a secondary source |
| CJK: 9 characters a second | Netflix's Chinese timed text guides. Applied to Japanese and Korean too: an assumption, and Netflix's Korean guide says 12 |
| At least 1.5 s on screen | Assumption |
| Animations count half towards reading time | Assumption |
| Minimum size: 1/30 of the shorter side (36 px at 1080) | Assumption |
| Platform interface zones (`TITLE_PLATFORM_ZONES`) | **Unofficial.** No official Meta or TikTok table was found on 2026-11-02 and secondary sources disagree (TikTok top 130–210 px, bottom 310+; Reels top 14 %, bottom 23–35 %). So `target-safe-area` only warns, and says it is an estimate |

Sources: [WCAG 2.2](https://www.w3.org/TR/WCAG22/#contrast-minimum), [BBC subtitle guidelines](https://clevercast.com/bbc-subtitling-guidelines),
[Netflix Simplified Chinese guide](https://backlothelp.netflix.com/hc/en-us/articles/215986007-Chinese-Simplified-Timed-Text-Style-Guide),
[Netflix Korean guide](https://backlothelp.netflix.com/hc/en-us/articles/216001127),
[a secondary list of vertical safe zones](https://www.upload-post.com/tools/safe-zone-checker/).

## Measured

Real engine, real rendering, MCP over stdio: `apps/mcp/test/qa/titles.test.ts`. Rerun:
`JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome MCP_QA=1 pnpm exec vitest run --project @jasper/mcp apps/mcp/test/qa/titles.test.ts --maxWorkers=1`.
Machine: shared 8-vCPU host, 15 GB, no GPU (SwiftShader), Chrome 156. Load average 3 to 10 during the run; other agents were working.

| Scenario, 1280×720 | Result | Test time |
|---|---|---|
| Brief to checked title on real footage: `enable_toolsets`, `find_title_looks`, `propose_title`, `title_check`, 4 calls | pass; alpha bounds centred within 40 px, `revert` restores the picture (mean difference < 0.05) | 208 s |
| White on white fails on measured contrast (ratio < 1.2); the rim fix, rendered again, is > 3:1 | pass | 218 s |
| A title cut by the frame fails on its real bounds; the fix, rendered again, is inside | pass | 274 s |
| Headless `propose` refused; a cancelled sheet ends `cancelled` | pass | 1 s |

These runs were made before the library was merged, so they use a recipe and `find_title_looks` returned no rows and no
sheet; with the library merged that call also renders a sheet (not rerun end to end since). The first render of an engine bundles the compositions (about 110 s at load 1); the
suite does that in `beforeAll`, outside the figures above. At load 31, before slots existed, one `title_check` on a four-layer look
at 1080p took 32 s. At load 80 a sheet ran past 600 s and the engine stopped answering during the bundle, so jasper-mcp reported
`ENGINE_NOT_FOUND`: those runs prove nothing about a normal host, and the timeout path behaved as designed.

## Limits

- `min-size` reads the style's size and Motion's scale, not rendered glyph height.
- `font-available` answers for the family, not for each character: a Latin font asked for Japanese text passes.
- Title-only renders drop the clips around the title, so an adjustment layer over it does not count towards its alpha.
  The `with` and `behind` frames are the real document, so contrast does count it.
- A title moving through a frame edge during the hold is measured only at three frames.
- User looks in the engine-backed store (TL-054) are not searched here; `find_title_looks {projectId}` covers project looks.
- Rendered rows of a proposal are not stored on it, so Review does not show them; the agent reports them.
