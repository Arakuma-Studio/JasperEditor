# Title Looks for agents (spec 19 §11, TL-100 to TL-107)

The agent surface of [Title Looks](title-looks.md): search, sheet, propose, check, as sound design works.

| Piece | File |
|---|---|
| Tools `title_look_find`, `title_propose`, `title_check`, `title_look_save`, `title_generator_add`, `title_light_set`, guide `TITLE_ART_GUIDE`, resource `jasper://title-looks/{id}` | `apps/mcp/src/tools/titles.ts` |
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
- **`renderPath` in `title_look_find` comes from the planner**, once per page on the sheet's scratch document. `costClass`
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
`lookId` may be a user look (`ulk_…`): its recipe is in the item's `look.apply` command.

`titleArtCheckOf(item)` gives the rendered check of the first option, `{revision, verified, counts, rows, notChecked,
pending?, omitted?}` (rows as `title_check` returns them, fixes as labels), or null: alternatives carry none, and an
unreadable one hides nothing else of the meta.

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
- A proposal keeps the rows of its first option only (`meta.check`); the Review panel draws them under the posters
  (`apps/web/src/proposals/title-art-check.tsx`: status, measured against expected, timecode, fix label, "Pending" for a
  timed-out render, and a line saying an alternate has none), and a later
  `title_check {proposalId}` does not update them.

## After the MCP text cut (merge of `main` at e84806b6)

`main` cut model-visible text by 60–69 % (`docs/wp-notes/agent-footage-context.md` § Model-visible text). The titles and
effects tools follow the same rules since that merge:

- Each of the ten tools (`find_title_looks`, `propose_title`, `title_check`, `get_title_recipe`, `save_title_look`,
  `add_title_generator`, `set_global_light`, `list_effects`, `add_effect`, `set_effect_param`) advertises one short
  sentence; its former description is its `details`, unchanged, read with `describe_tool {name, full: true}`.
  `render_frames`, `add_text` and `list_proposal_features` keep the spec 19 additions inside their `details`.
  `title_check`'s rules for format and judgement rows still reach the agent in every result's `next`.
- The one-line toolset map in the instructions names `titles` with its trigger words, and `list_effects` under effects;
  `text` reads "plain titles, text styles", so a styled title no longer routes to it.
- `describe_commands` lists catalogues only with `catalogues: true`; the effect count and its `list_effects` hint
  live there.
- The guide and `references/title-art.md` send agents to `call_tool` instead of `enable_toolsets`, as `main` does.
- Measured bytes (`pnpm --filter @jasper/mcp eval:measure`, merged tree): `+titles` 10,612 → 6,608 after the split;
  `+effects` 21,137, over the old 19,663 by the three effects tools' schemas; `all` 496,936 (budget 497,324);
  `core` 25,510 (budget 25,884); `+export` 11,549, over the old 11,113 by `render_frames`' six spec 19 arguments
  (`proposalId`, `itemIds`, `overlay`, `wait`, `timeoutSeconds`, `jobId`: proposal previews and one-job sheets, TL-103,
  TL-104). `eval/budget.json` gains `+titles` (6,741) and raises `+effects` to 21,560 and `+export` to 11,780, each the
  measurement plus the 2 % headroom `--write-budget` uses. The eval cases in `eval/cases/titles.jsonl`
  (`titles-effect-by-name`, `titles-styled-title`, `titles-plain-text-control`) are what those bytes have to earn;
  they build (`pnpm eval --dry-run`), but no model samples were run for this merge. `eval/fake-engine.ts` has no
  `requestStillSheet`, so a sample that reaches `find_title_looks` or `propose_title` is marked invalid: until the fake
  models look sheets, `titles-styled-title` cannot produce a valid sample (recorded in `docs/gaps.md`).
- `toolsets.test.ts`'s unknown-tool-name scan reads every tool's `details` as well as its description, since most
  reference text now lives there.

## 3D and delivery tools after the MCP text cut (integration 2)

The 3D stream (`apps/mcp/src/tools/three-d.ts`) and the interchange stream (`apps/mcp/src/tools/delivery.ts`) were written
before `main`'s conventions reached them. At integration 2 they follow them:

- `set_3d_renderer`, `set_3d_surface`, `set_3d_geometry`, `edit_bevel_bands`, `edit_backplates`, `send_to_photoshop`,
  `export_alpha`, `import_layer_styles`, `split_image` and `check_gamut` advertise one sentence; the former description is
  their `details`. One correction inside them: the 3D details sent agents to `set_param`, which is no tool
  (`toolsets.test.ts` caught it); they now name `apply_commands` `param.set` and `keyframe.*`, as `THREE_D_GUIDE` does.
- No toolset is new: the 3D tools are in `3d`, the delivery tools in `export`, `graphics` and `color`, with the guide topic
  `delivery`. The instructions map gains trigger words for both: `3d (cameras, lights, extruded 3D titles)` and
  `export (PSD, PNGs with alpha)`. "Extruded 3D" rather than "metal" keeps a flat gold title in `titles`.
- Measured bytes (`pnpm --filter @jasper/mcp eval:measure`, merged tree):

  | Context | Base budget | Before the split | After | New budget (after + 2 %) |
  |---|---|---|---|---|
  | `core` | 25,884 | 25,510 | 25,571 (map words) | 25,884 (unchanged) |
  | `+3d` | 14,883 | 23,336 | 21,403 | 21,846 |
  | `+color` | 16,928 | 17,216 | 17,139 | 17,482 |
  | `+graphics` | 18,957 | 19,764 | 19,577 | 19,969 |
  | `+export` | 11,780 | 13,459 | 13,282 | 13,548 |
  | `all` | 497,324 | 505,681 (3D only) | 507,077 | 513,876 |

  "Before" for `+3d` was measured on the merged tree before the split; for the delivery contexts it is the measurement
  after plus the description bytes the split moved (77, 187 and 177 bytes). Why they grow: `+3d` gains four tools
  (`set_3d_surface` alone is 2.4 KB of schema: the physical material's values) and the tone mapping, exposure and glint
  arguments of `set_3d_renderer`; `+export` gains `send_to_photoshop` and `export_alpha`, `+graphics`
  `import_layer_styles` and `split_image`, `+color` `check_gamut`. `all` was raised once, after the 3D merge, to its
  measurement + 2 %; the delivery tools fit inside it.
- The eval cases those bytes have to earn: `eval/cases/three-d.jsonl` (`three-d-extruded-title`, and the control
  `three-d-flat-title-control`, which keeps a flat gold title out of the 3D tools) and `eval/cases/delivery.jsonl`
  (`delivery-psd`, `delivery-alpha-png`, `delivery-gamut`). They build (`pnpm --filter @jasper/mcp eval --dry-run`: 42
  cases); no model samples were run. `eval/fake-engine.ts` has no route for `psdPlan`, `psdExport`, `alphaDelivery` or
  `gamutCheck`, so a sample that reaches them is marked invalid (an unmodelled engine call), as for the titles cases
  (`docs/gaps.md`). The 3D cases only edit the document, which the fake applies for real.

## User looks, stored rows and the eval's engine (agents, part 2)

- **`find_title_looks` searches the user's looks** (TL-054, `GET /api/title-looks`), between the library and the
  project's. Rows say `source: library | user | project`. A user look travels whole in `look.apply {look: {…, sourceId:
  ulk_…}}`, so the first use copies it into the project and later ones reuse that copy (the handler matches `sourceId`);
  a project copy of a user look is the user row, not a second one. `propose_title` and `get_title_recipe` take a `ulk_…`
  id without a project. A user look deleted since it was used resolves to the project's copy. When the store cannot be
  read the library and project looks are still searched and `userLooksError` says why.
- **Rows on the proposal.** `propose_title` in `propose` mode now renders first and stores the proposal after, so the
  item's meta carries `check` (`titleArtCheck`: at most 32 KB, passes dropped first, `omitted` counts them; texts cut to
  what the reader takes). Only option 0 is measured, so alternatives carry none. The refusals that cost nothing (headless,
  revision, Agent Proposals, a bad recipe) still come before any render. Item meta is `z.unknown()` in `ProposalSchema`
  and the panel reads it with a loose schema, so an older build keeps the field and ignores it: no schema bump.
- **The eval's engine** (`eval/fake-engine.ts`) models `requestStillSheet`, `listFonts`, `titleLooksList`, `psdPlan`,
  `psdExport`, `alphaDelivery` and `gamutCheck`. Bodies are checked with the routes' request schemas and results built with
  the result schemas. Cells are stand-in pictures (grey footage, a solid's colour, a light box per title), so a sample's
  `title_check` rows are computed, not canned. `open_project_in_editor` makes reads report an editor, which `propose`
  needs. `eval/fake-engine.test.ts` runs these tools through the stub, from a core session with `call_tool`, and checks
  that no call is unmodelled.
- Measured bytes (`pnpm --filter @jasper/mcp eval:measure`): `+titles` 6,608 → 6,624 (the `lookId` argument names user
  looks, in two tools; budget 6,741), `all` 507,077 → 507,093 (budget 513,876); every other context unchanged. No budget
  was raised. No model samples were run.

## Names and merges (AGENTS.md §10)

The sections above "Measured" use the current names; the measurements and the integration notes keep the names the runs
used. Since this pass the 19 tools spec 19 added to `main`'s surface follow §10. The spec (TL-078, TL-100…TL-104) was
amended to these names at integration 4.

| Before | Now | Why |
|---|---|---|
| `find_title_looks` | `title_look_find` | `title_` for the new `titles` toolset; "look" is the one word for a look |
| `get_title_recipe` | `title_look_find {lookId}` | Merged: the same lookup of the same catalogue, as `list_effects {effectId}` returns one effect |
| `propose_title` | `title_propose` | The area is the noun, as `main`'s `scopes_read` |
| `title_check` | `title_check` | Already `<area>_<verb>` |
| `save_title_look` | `title_look_save` | |
| `add_title_generator` | `title_generator_add` | |
| `set_global_light` | `title_light_set` | Only title looks follow the global light; the 3D lights are `add_light` clips |
| `list_effects`, `add_effect`, `set_effect_param` | unchanged | See below |
| `set_3d_surface` | `set_material {surface, preset, values, clearSurface}` | Merged: "the material of a 3D layer" had two routes, and `metal` on `set_material` read as a metal look |
| `set_3d_geometry`, `edit_bevel_bands`, `edit_backplates` | `threed_solid_edit {mode…, band, plate}` | Merged: three edits of one solid; the two `edit_*` tools were the same add / remove / reorder |
| `export_alpha` | `export_frame {alpha, end, clipIds, trimMarginPx}` | Merged: "export a PNG still" had two routes, and the eval case existed because agents could pick the wrong one |
| `send_to_photoshop` | `export_psd` | `main`'s export area is `export_<noun>` (`export_frame`, `export_timeline`, `export_lottie`) |
| `import_layer_styles` | unchanged | Already `main`'s import area, `import_<noun>` (`import_media`, `import_lut`, `import_timeline`) |
| `check_gamut` | `color_gamut_check` | `main`'s colour area prefix (`color_match`) |
| `split_image` | `image_split` | "split" is `split_at`'s cut in time: the still is the noun, its UI and command say "Split Image" |

- **One prefix per area, and the areas are `main`'s where they exist.** A `delivery_` prefix would give `main`'s export
  area two prefixes (`export_frame` and `delivery_…`) and put a logo split and a style import under "delivery". So
  export, import and colour keep `main`'s words; the new areas get one each: `title_` and `threed_`. `threed` rather
  than `3d`: some clients (Gemini) require a name to start with a letter, and it is the documents' own `threeD` key.
  `toolsets.test.ts`'s `TOOL_VERBS` gains `image` and `threed`.
- **The effects tools keep their names.** They were new tools, but not new names: `main`'s `ROTO_GUIDE` and
  `add_adjustment_layer` already sent agents to `add_effect`, `set_effect_param` and `list_effects` (TL-105 says register
  them or correct the guides), and they are the video side of `main`'s own `list_audio_effects`, `add_audio_effect` and the
  `*_effect_preset` tools in the same `effects` toolset. Renaming three of that toolset to `effect_*` would split it across
  two schemes. Not near-duplicates of `apply_commands effect.add` / `param.set` either, in `main`'s terms: like every
  helper (`set_3d_layer` is `clip.set3d`), they add clip lists in one step, times resolved on the owning sequence and the
  keyframe switch.
- **Not merged:** `title_generator_add` (a look layer, or a generator clip kept below the title: no other tool does
  either), `title_look_save` and `import_layer_styles` (one makes a look from a clip, the other reads Photoshop files),
  `export_psd` (a layered file with a dry-run plan; `export_frame` writes flat images), `color_gamut_check` (`scopes_read`
  measures levels, not an output gamut), `image_split`.
- **Descriptions.** Each says what it does and its sibling or misuse where a case tests that boundary: `title_propose`
  "Plain text: `add_text`", `title_light_set` "3D lights are clips: `add_light`", `image_split` "A cut in time:
  `split_at`", `color_gamut_check` "Levels and clipping: `scopes_read`", `export_psd` "A flat image: `export_frame`",
  `export_frame` "A transparent PNG needs `alpha: true`", `set_material` "`metal` is classic shading, not a metal look",
  `threed_solid_edit` "Advanced 3D only", `add_effect` "ids come from `list_effects`, never guessed". Limits the schema
  or an error already states stay out (a page of 12, headless `propose` is `E_NO_EDITOR`, `notChecked` says taste is not
  measured). The new refusals name their fix: `threed_solid_edit` "Pass band.bandId.", "Pass only the clip that holds …";
  `export_frame` "Add alpha: true.", "Pass folder.", "Leave format out."; `set_material` "Add preset or values.".
- **Names that do not follow §10's `<area>_<noun>[_<verb>]` exactly, kept by decision** (the coordinator, review 2 of
  spec 19, 2026-11-03; nothing renamed). Each keeps a reason this note already gives:
  - `title_propose`, `title_check` and `image_split` are area plus verb, with no noun between. In each the area word is
    the noun the verb acts on, as in `main`'s `scopes_read` (the table: "The area is the noun"): a title is proposed or
    checked, a still is split. A noun in between (`title_clip_check`) would only repeat it, and `image_split` keeps
    "split" off `split_at`'s cut in time.
  - `threed_solid_edit` sits beside `main`'s verb-first `set_3d_layer`, `set_3d_renderer` and the other `set_3d_*`, so
    the `3d` toolset holds two schemes. The new area takes one prefix, `threed_`, because a name cannot start with `3`
    for some clients and `threeD` is the documents' own key; and the tool merges three edits of one solid (add, remove
    and reorder bands and plates), which no `set_3d_*` verb covers. Renaming `main`'s `set_3d_*` is outside spec 19.
  - `list_effects`, `add_effect` and `set_effect_param` are verb-first because `main` already used those names: its
    `ROTO_GUIDE` and `add_adjustment_layer` sent agents to them before they existed, and they are the video side of
    `list_audio_effects`, `add_audio_effect` and the `*_effect_preset` tools in the same `effects` toolset (above).
  Renaming any of these later changes names agents have learned and that guides, skills and eval cases cite, so it waits
  for eval samples that show the current names cost a wrong route; none has so far, and no paid samples were run.
- **`threed_solid_edit` returns the new ids** in `refs` (`$band0`, `$plate0`, one per clip), which `edit_bevel_bands` and
  `edit_backplates` did not, so a remove or reorder no longer needs `get_clip_properties` first.

### Eval cases

`eval/cases/titles.jsonl`, `three-d.jsonl`, `delivery.jsonl`: 23 cases at this pass (24 since integration 4, below),
each naming the text it is for. New since this
pass: `titles-check-readable`, `titles-look-recipe`, `titles-save-look`, `titles-generator-behind` with the control
`titles-fire-sound-control`, `titles-global-light` with `titles-3d-light-control`, `effects-keyframe-param`,
`three-d-backplate`, `delivery-title-alpha`, `delivery-jpeg-control` (control of `delivery-alpha-png` and `delivery-psd`),
`delivery-levels-control` (of `delivery-gamut`), `delivery-layer-styles`, `delivery-split-logo` with
`delivery-split-clip-control`. Changed: `three-d-extruded-title` now needs Advanced 3D, a bevel `band` and a gold `preset`;
`delivery-psd` needs `dryRun` and no write; `delivery-alpha-png` needs `export_frame {alpha: true}`; `delivery-gamut` must
not call `title_check`.

The fake engine (`eval/fake-engine.ts`) now answers `layerStylesRead`, `splitImageAnalyze`, `splitImage` and
`gradingScopes` with the routes' schemas, `setup.logo` places a still with three letters (`{{still}}`), and a seed's refs
are vars (`{{seed_t}}`). `eval/cases.test.ts` runs each case's intended route through the stub with the case's own setup
and grades it: all 23 pass and none is invalid. That proves each case can pass, not that it fails without its text.

**No model samples were run** (paid; the owner decides). The runs that would prove each case, on an Orquester-managed
account, from `apps/mcp` (`<a>,<b>` two accounts with quota):

```sh
# Baseline 1: every new or merged tool's description cut to its title (scratch checkout of this branch)
git worktree add /tmp/mcpeval-base-desc <this branch> && cd /tmp/mcpeval-base-desc && pnpm install --frozen-lockfile
python3 -I ablate.py /tmp/mcpeval-base-desc descriptions        # the script is in the report of this pass
cd <this checkout>/apps/mcp
pnpm eval --account <a>,<b> --samples 4 --case titles-effect-by-name,titles-plain-text-control,titles-template-insert,titles-check-readable,titles-look-recipe,titles-save-look,titles-generator-behind,titles-fire-sound-control,titles-global-light,titles-3d-light-control,effects-keyframe-param,three-d-extruded-title,three-d-backplate,delivery-psd,delivery-alpha-png,delivery-title-alpha,delivery-jpeg-control,delivery-gamut,delivery-levels-control,delivery-layer-styles,delivery-split-logo,delivery-split-clip-control --source-root /tmp/mcpeval-base-desc --out /tmp/mcpeval/base-desc
# Baseline 2: the instructions map without the titles, 3d, export and effects trigger words
git worktree add /tmp/mcpeval-base-map <this branch> && cd /tmp/mcpeval-base-map && pnpm install --frozen-lockfile
python3 -I ablate.py /tmp/mcpeval-base-map map
cd <this checkout>/apps/mcp
pnpm eval --account <a>,<b> --samples 4 --case titles-styled-title,titles-plain-text-control,three-d-extruded-title,three-d-flat-title-control,delivery-psd,delivery-alpha-png,titles-effect-by-name --source-root /tmp/mcpeval-base-map --out /tmp/mcpeval/base-map
# After: this branch, compared with each baseline
pnpm eval --account <a>,<b> --samples 4 --case <the same ids> --out /tmp/mcpeval/after-desc --baseline /tmp/mcpeval/base-desc/results.jsonl
pnpm eval --account <a>,<b> --samples 4 --case <the same ids> --out /tmp/mcpeval/after-map --baseline /tmp/mcpeval/base-map/results.jsonl
```

A guard that also passes on its baseline shows its text is not needed: cut that text. A control that fails after shows an
overcorrection.

### Bytes

`pnpm --filter @jasper/mcp eval:measure`, before → after this pass: `core` 25,571 → 25,570; `+titles` 6,624 → 6,507 (7
tools → 6); `+3d` 21,403 → 20,994 (19 → 16); `+export` 13,282 → 13,017 (14 → 13); `+effects` 21,137 → 21,241 (the
siblings and the never-guess rule in the three descriptions); `+color` 17,139 → 17,181; `+graphics` 19,577 → 19,663;
`all` 507,093 → 506,533 (469 tools → 464). `eval/budget.json` lowers the three that shrank to the measurement + 2 %:
`+titles` 6,741 → 6,638, `+3d` 21,846 → 21,414, `+export` 13,548 → 13,278. The rest stay; every context is within budget.

## Title templates in `title_look_find` (integration 4)

The finishing stream added real 3D titles as templates (the 3D category holds templates, the old drawn looks are Drawn
Depth) and listed templates in the Looks tab, but no tool listed them: `apply_commands` `title.insertTemplate` worked only
with an id an agent could not find. AGENTS.md §10 gives one route per intent and merges into an existing tool before adding
a near-duplicate, and the Looks tab, the people's one home for looks and templates (TL-055), lists both. So
`title_look_find` lists the library's templates too, with no new tool and no new parameter:

- Rows have a `kind`. `look` rows are as before. `template` rows carry `templateId`, `name`, `tags` (the format, such as
  `lower-third`, first, so `tags: ["lower-third"]` filters on it), `texts` (sample text by slot, the keys `texts` takes),
  `seconds`, `costClass` and `renderPath`. A template's `costClass` is `3d` or `3d-heavy` when it makes Advanced 3D solids
  (`templateCostClass`, TL-078), else its heaviest look's, and `heavy` with a generator.
- Search and tags work as for looks (name and tags score most, then the category). A tie goes to the look, since that is
  what `title_propose` takes.
- The sheet stays one engine job and one document. The looks are on the first sequence, as before; each template is on a
  sequence of its own, since a 3D template sets its sequence's renderer, drawn at the middle of its span with its own
  texts.
- The result's `next` names the route: `apply_commands {label, commands: [{type: "title.insertTemplate", templateId, at,
  texts?}]}`, one undo step. A template is not proposed: `title_propose` takes one look on one text, and a template makes
  several clips.
- Text: the description says "looks and templates" and the `tags` parameter "Only rows with all of these". `+titles`
  6,507 → 6,520 bytes (budget 6,638), `all` 506,533 → 506,546 (budget 513,876).
- Cases: the guard `titles-template-insert` (a ready-made lower third with the person's texts: `title_look_find`, then
  `title.insertTemplate` with `texts`). `three-d-flat-title-control` now also forbids inserting a 3D template, since a flat
  gold title's search can now show one. `eval/cases.test.ts` runs the new route through the stub; it passes and is valid.
  No model samples were run.
- Tests: `apps/mcp/test/titles.test.ts` "lists the library's title templates as rows of kind template…" (rows, slots,
  one document with a sequence per template, the frame, the route the result names, the 3D cost). It fails without the
  change.
- Open risk, unmeasured: `three-d-extruded-title` ("an extruded 3D title in gold with a bevel") wants the 3D tools. An
  agent that enables `titles` can now find Gold 3D Title and insert it, which makes the same kind of title but fails that
  guard. The paid runs above would show whether it happens.
