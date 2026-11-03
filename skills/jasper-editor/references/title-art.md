# Stylized titles

A look is a reusable appearance on a clip: rims, glows, shadows, finishes, generators. A colourway fills a look's
colour roles without changing its structure. The tools are in the `titles` toolset: run them with `call_tool` (`describe_tool`
shows the arguments). Guide: `get_guide` topic `title-art`.

## From brief to checked title

1. `title_look_find` {query, tags?, aspect?, sampleText?, projectId?}: rows and one numbered sheet of real renders.
   It searches the library, the user's own looks (`ulk_…`: saved in the editor, shared by every project) and, with
   `projectId`, the project's looks; each row's `source` says which. Any row's `lookId` works with `title_propose` and
   `title_look_find` {lookId}. When the user's looks cannot be read, `userLooksError` says so and the rest is still searched.
   Title templates (lower thirds, full-screen titles, end cards, social hooks, real 3D titles) are rows too, of
   `kind: "template"` with a `templateId` and their text slots: a template makes clips, so insert it with `apply_commands`
   `title.insertTemplate` {templateId, at, texts?} instead of proposing it. Animated lower thirds and social comments
   from the motion-graphic templates are `add_motion_graphic`, in the `graphics` toolset.
2. `title_propose` {projectId, text, at, lookId, colorway?, energy?, alternatives?}: the title on the real footage, one
   sheet of intro, hold and outro × alternatives, and its check. `duration` defaults to the time the text needs.
3. `title_check` {projectId, clipId | proposalId, target?} after any change.

That is three calls. Read `check` before you hand anything over.

## The three modes, and what happens without an editor

| Mode | Editor open | Headless (no editor window) |
|---|---|---|
| `propose` (default) | a `title-art` proposal in the Review panel, colourways as alternatives; `wait_for_proposal` | refused with `E_NO_EDITOR`, nothing stored: nobody could review it |
| `apply` | added now, one undoable History entry | added now, with no History: `undo` cannot reach it, so the result carries `revert` |
| `dryRun` | changes nothing | changes nothing |

- Headless means the engine `.mcp.json` starts by itself, or any project no editor window has open. To review: run
  `open_project_in_editor` (in the `project` toolset, so through `call_tool` from a core session) and ask the user to
  look at the Review panel.
- `revert` holds the `apply_commands` arguments that remove the title. It says what it leaves behind (a font reference,
  a track). Keep it until the user has seen the title.
- `apply` refuses with `E_APPROVAL_REQUIRED` where the user turned title art off in Project Settings ▸ Agent Proposals.
  Do not retry.

## Choosing

- `energy` picks the animations: low fades, medium slides up, high pops.
- `alternatives` (0–3) adds colourways chosen from `seed`, which every result returns. The same seed gives the same
  choice. Fewer than asked come back with `alternativesNote`.
- `costClass`: light, medium or heavy. Heavy looks move on their own and redraw every frame, so they export slowly.
- An empty library is reported plainly: pass `recipe`.

## Going beyond the library

- `title_look_find` {lookId}: a look as JSON, what each of its layer types takes, and every layer type.
- `title_propose` {recipe} and `title_look_save` {clipId | recipe, name, tags}. A recipe is bounded: 24 layers, 64 KB, 12
  levels of nesting, 8 layers of a type, 4 generators.
- `title_generator_add`: a generator behind a title (standalone, `belowClipId`) or a layer of its look (`clipId`).
- `title_light_set`: the light every look with `light.source: "sequence"` follows.
- `get_clip_properties` lists a look's palette, light and layer params with `param.set` targets; keyframes and
  expressions reach them through `apply_commands`.
- `list_effects`, `add_effect`, `set_effect_param`: ordinary effects on top.

## Long renders

Sheets and checks are one engine job. Past `timeoutSeconds` a call returns `{jobId, timedOut: true, next}`; the title is
already stored or applied. `render_frames` {jobId} returns a sheet, `title_check` with the same arguments and `jobId`
returns the rendered rows, `cancel_job` stops the job. The first render of a session may bundle the compositions.

Reading the rows: [verification](verification.md).
