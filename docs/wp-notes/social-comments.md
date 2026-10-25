# Social-comment templates — work note

Design: [docs/superpowers/specs/2026-10-25-social-comment-templates-design.md](../superpowers/specs/2026-10-25-social-comment-templates-design.md).

## Placement & agent API

Design §7.9 ("insertion never overwrites") and §7.10 (agent UX). Generic: nothing here is specific to social
comments; every motion-graphic template (and the other generator clips) gets it.

### First-free placement (`@jasper/project`)

- `placement: 'overwrite' | 'first-free'` on the placement target of `clip.addText`, `clip.addSolid`,
  `clip.addMotionGraphic`, `clip.addComposition` and `clip.addShape` (`PlacementModeSchema`,
  `packages/project/src/commands/schemas/clip.ts`). Absent = `overwrite`, today's behaviour.
- `first-free` (`firstFreeTrack`, `packages/project/src/commands/placement.ts`): `track` is the lowest track tried.
  The clip goes on the lowest **unlocked** track of the same kind at or above it with no clip overlapping
  `[at, at + duration)` (a clip ending exactly at `at` does not overlap). When every such track is locked or busy, a
  new track of that kind is appended on top in the same transaction (one undo step). A label above the existing
  tracks (`"V5"` with three) adds the missing tracks, as an overwrite to that label does.
- Locked tracks are skipped, never refused. Wrong kind (`"A1"` for a graphic) → `E_TRACK_KIND`; an unknown track id →
  `E_NOT_FOUND`; the transaction is refused and nothing changes.
- Nothing else moves: the range is empty, so no clip is trimmed, split or shifted, markers stay, and sync-locked
  tracks are untouched (sync lock only matters for insert/ripple edits, which first-free never performs).
- Deterministic: tracks are tried in index order over the transaction's current draft, so commands later in the
  same transaction see the clips placed before them — a batch never collides with itself.
- Disabled clips and clips on tracks with output off still occupy their track. Hidden (output-off) tracks are not
  skipped (only locked ones are) — assumption: hiding a track is a view choice, locking is the "don't touch" one.
- Transitions are not considered separately: they live inside their clips' ranges.

### Template fill hook

- `MgTemplateDefinition.fill?(partial, seed)` (`packages/mg-templates/src/types.ts`), mirrored as
  `MgTemplateInfo.fill?` (`packages/project/src/registry/mg.ts`; the registry passes it through) →
  `{ok: true, params, filled} | {ok: false, error, issues?}` (`MgTemplateFillResult`). `seed` is a uint32.
- `clip.addMotionGraphic {fill: {seed}}` runs it on the given params; the given values always win over what it
  returns, then the template defaults are merged under and the params schema validates. A refusal, a throw or a
  non-object result → `E_INVALID_PARAM` (the issues' messages joined into the message). Templates without a hook:
  defaults only, `filled: []`.
- The command result is `{clipId, sequenceId, trackId, track ("V3"), createdTrack?, start, duration, params,
  filled?, seed?}` with the fully resolved params, also in dry runs.

### MCP `add_motion_graphic` (`apps/mcp/src/tools/add-motion-graphic.ts`)

- One item (`template`, `params`, `at`, `duration`, `track`, `placement`) or `items: [...]` (1–200, zod), never both.
  All items are one transaction (one undo step, all or nothing).
- Default placement: first-free from `V2` (V1 usually holds the footage; for an empty `V2` range this is where the
  tool always put graphics). An explicit `track` keeps the old semantics — overwrite on exactly that track — unless
  `placement: "first-free"` (then the search starts there).
- Template references are parsed by `resolveTemplateRef` only (`"id"`, `"id@version"`); unknown references of all
  items are reported together (`details.items[]`) before anything is sent.
- Seeds: the call's `seed` (default: random uint32, returned) is item 0's; item i uses its own `seed` or
  `(seed + i·0x9E3779B9) mod 2³²`. Same call + same seed = same params.
- Result per item: `index`, `clipId`, `template`, `sequenceId`, `track`, `trackId`, `createdTrack?`, `start`, `end`,
  `duration`, `startTimecode`, `endTimecode`, `params` (fully resolved), `filled`, `seed`.
- `dryRun: true`: the engine's dry-run transaction — same result, nothing stored (clip ids are placeholders).
  `preview: true` (needs `dryRun`, ≤ 10 items): one still per item through the `render_motion_graphic_preview` path
  (`templatePreview` in `tools/templates.ts`): anime templates at the middle of the hold of a one-clip document at the
  sequence's aspect fitted in 960×960 and its rate rounded to whole fps; fframes templates the native renderer's
  poster (its middle frame). A failed preview is reported on its item (`preview.error`), the dry run still succeeds.
- Errors are MCP error results; a refused transaction names the item (`items[1] (lower-third): …`) and
  `details.items[] = {index, template, code, message}`.
- HTTP (`/api/agent/tx`) and the CLI reach the same command: `jasper call add_motion_graphic template=… at=00:02`
  and `jasper call add_motion_graphic '{"items": [...]}'` were run against a dev engine (single item, a 3-item
  batch with a created track, a dry run with a preview PNG written by `--out`).

### Friendly times (`apps/mcp/src/arguments.ts`)

- `TimeArgSchema` = the command forms (`TimeInputSchema`: frames, `{frames}`, `{seconds}`, timecode) ∪ friendly
  strings, which parse to `{seconds}` so the command layer only ever sees its own forms. Every `timeArg` and the
  former direct `TimeInputSchema` arguments of the tools use it; `frameOf`, `edit-ux`'s resolver, still captures
  and the CLI's `--at` accept the same strings (`normalizeTimeArg`, `parseFriendlyTime`).
- Grammar, decided by shape (so `HH:MM:SS:FF` stays unambiguous): `<n>s` / `<n>ms` (decimal, no exponent, no
  leading dot), one `:` = `M:SS` (minutes 1–4 digits), two `:` = `H:MM:SS` (hours 1–3 digits, minutes and seconds
  00–59), three separators = timecode. Clocks take no fraction because `1:02:03.5` is timecode `H:MM:SS.FF`. A
  leading `-` is allowed as in timecode. Bare numeric strings (`"90"`) are refused — frames are numbers.
- Raw commands (`apply_commands`, `/api/agent/tx`) do not take the friendly strings: commands may be stored
  (proposals) and an older build must still read them.

### Tests

- `packages/project/test/first-free-placement.test.ts`: placement rules, locked tracks, created tracks, floor
  labels/ids, batches, refusals, overwrite unchanged, other generator kinds, a fast-check property (random clips,
  locks and batches: no overlap, existing clips untouched, invariants hold), the fill hook (determinism, given
  values win, failures).
- `packages/mg-templates/test/registry.test.ts`: the registry passes `fill` to the command layer.
- `apps/web/test/motion-templates.test.tsx`: stacked inserts, undo/redo through the session, targeted floor and
  locked tracks, an explicit track still overwrites.
- `apps/mcp/test/add-motion-graphic.test.ts`: single/batch, fill + seeds, all-or-nothing errors with item indexes,
  unknown templates, shape validation and the 200 cap, dry run, preview, friendly times, the advertised schema.
- `apps/mcp/test/time-args.test.ts`: fast-check — never throws, finite or null, round trips, timecode/friendly
  disjointness.
