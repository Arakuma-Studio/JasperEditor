# Multi-clip text styling, batch effects and linked text styles (spec 13 SH-003, AS-030…033)

Spec: [`docs/specs/13-auto-subtitles.md`](../specs/13-auto-subtitles.md) §2 SH-002/SH-003, §3.4. Schema fields:
[`docs/project-files.md`](../project-files.md) "Fields added in v10". Problem this solves (spec 13 §0, measured on the
user's projects): Premiere cannot restyle many graphics at once; the user applied saved effect presets to every
caption graphic one by one.

## Model (`packages/project/src/text-styles/`)

- `patch.ts` — **deep, per-field style patches**. `TextStylePatchSchema` (strict, zod) names only the fields that
  change. Plain-object fields (`shadow`, `background`, `openType`) merge field by field, so `{shadow: {blurPx: 4}}`
  keeps the shadow's colour, angle, distance and spread; a partial shadow / background on a style that has none starts
  from `DEFAULT_TEXT_SHADOW` / `DEFAULT_TEXT_BACKGROUND` (only the required fields, so a complete object merged over
  them is exactly that object). `null` turns a shadow / background off, or removes an optional field (`kerning: null`
  = the read-time default); required fields cannot be removed. `strokes` is a whole list, or edits of each clip's own
  list applied in the order `set` (fields of stroke *i*; a clip without stroke *i* gets one, defaults + fields, at the
  end) → `remove` (indices; missing ones ignored) → `add`. At most 16 strokes (`MAX_TEXT_STROKES`), numbers bounded,
  colours 0…1 (`textStyleProblem`).
- `diffStyle(a, b)` is the inverse: `applyStylePatch(a, diffStyle(a, b))` equals `b` (property test, 300 random style
  pairs). Equality ignores key order (`sameValue`).
- `writeTextStyle` in `commands/handlers/clip-core.ts` owns `clip.update`'s merge: fields replace, except a shadow /
  background object given over an existing one, which merges into it. Existing callers pass whole objects, so their result is unchanged except
  that fields they do not name (the shadow's `spreadPx`, fields of newer builds) survive instead of being dropped
  (the old `Object.assign` replaced the object). Paste Attributes ▸ Text Style keeps copying the source's objects
  exactly (`styleMode: 'objects'`).
- `model.ts` — **linked project text styles**. `ProjectDocument.textStyles[id] = {id, name, style}`;
  `TextClip.styleId` links a clip, `TextClip.styleOverrides` records where it deviates. Design decision: the clip's
  `content.style` always stays the **effective** style, so every renderer (preview, every export path) and older
  builds read the look with no knowledge of links, and no rendering code changed. Consequences:
  - editing a style (`textStyle.update`) computes each linked clip's deviations from the clip itself
    (`diffStyle(oldStyle, clip.content.style)`) and writes `applyStylePatch(newStyle, deviations)`; a deviation made
    by any command is therefore never lost, even one that did not update `styleOverrides`;
  - `applyClipPatch` (clip.update, `param.set` on text properties, Paste Attributes, text.setStyle, the style
    commands) re-derives `styleOverrides` after every style write of a linked clip (`syncStyleOverrides`);
  - a `styleId` naming a missing style (clips pasted from another project) is soft: it reads as not linked, the
    invariant does not fail edits on it, and the load repair removes it.
- Invariants (INV-TEXTSTYLE) and `repairTextStyles` are listed in `docs/project-files.md`.

## Commands (`commands/schemas/text-style.ts`, `handlers/text-style.ts`; one transaction = one undo step each)

| Command | Does | Refuses |
|---|---|---|
| `text.setStyle {clipIds \| groupId, patch, runs?}` | deep patch on every clip, re-layout; `runs: "clear-overridden"` removes the patched fields from styled runs and paragraph settings (empty runs dropped) | non-text clips, named (`E_INVALID_PARAM`, "not text: clp_… (solid)"); locked tracks; > 16 strokes (`E_LIMIT`); missing font (`E_NOT_FOUND`); unknown fields (`E_SCHEMA`) |
| `effect.addMany {clipIds, effectId, index?, params?, keyframes?, anchor?}` | one instance per clip; `keyframes: {param: [{offset: {frames}\|{seconds}, value, interpolation?, easeIn?, easeOut?}]}` timed from each clip's In (`anchor: "out"`: back from its last frame) | clips that do not take the effect, named; unknown / internal effects; unknown or non-animatable params |
| `effect.setParamMany {targets:[{clipId, effectInstanceId, value?}] \| {clipIds, effectId, occurrence}, param, value \| delta \| keyframes \| animated, at?, anchor?}` | the same value (or each target's own, or `delta` added to each current value) on every instance; keyed params get a key at `at` frames from each In (clips shorter than that: `W_CLIP_SKIPPED`); `keyframes` replaces the animation; `animated` turns stopwatches on (one key at `at`) or off (the value at `at` kept) | a missing occurrence, naming the clips (`E_NOT_FOUND`); a keyed param without `at`, naming the clips; more than one mode |
| `effect.removeMany {targets \| clipIds+effectId+occurrence}` | removes the matched instance on every clip | as above |
| `textStyle.create {name, fromClipId?, style?, id?, ref?}` | a style from a clip and/or patch fields over the default style | duplicate names (case-insensitive), > 1 000 styles (`E_LIMIT`) |
| `textStyle.update {styleId, patch?, fromClipId?}` | changes the style ("Update Style from Clip" = `fromClipId`); every linked clip follows keeping its deviations; clips on locked tracks keep their look (`W_CLIP_SKIPPED`) | missing style |
| `textStyle.rename / delete` | rename (unique); delete unlinks every clip, which keeps its look | missing style, duplicate name |
| `textStyle.apply {styleId, clipIds \| groupId}` | links the clips; their style becomes the style (runs kept) | non-text clips, named |
| `textStyle.detach / reset {clipIds \| groupId, fields?}` | unlink keeping the look / drop deviations (all, or only the listed fields) | detach: none linked; reset: unlinked clips, named |

`groupId` resolves the text clips whose `caption.groupId` is the group (spec 13 AS-003 field, added by the subtitles
work); until that work merges no clip carries it and a `groupId` call answers `E_NOT_FOUND`.

`clip.update`'s text merge is unchanged for callers (see above). `applyEffectToClips` (Effects panel, Effect Controls
drops, `inspector.applyEffect`) now sends one `effect.addMany` instead of N `effect.add`.

## Editor

- **Properties (AS-030)**: with several text clips selected every text row shows the shared value or mixed — `–` for
  numbers, a split swatch of the first two colours (`ColorField mixed`), "Mixed" in menus and the font picker
  (`SelectField` now says "Mixed" instead of "–" everywhere, the convention spec 13 asks for). Scrubbing a mixed
  number moves each clip by the same amount, typing sets all (`+10`, `*2` stay relative); one History entry labelled
  "Shadow Blur (3 clips)". New sections: **Strokes** (every stroke: colour, width, position; "on 2 of 3" when the
  clips differ; Add Stroke / remove on all through `text.setStyle`), **Shadow** (on/off, colour, opacity, angle,
  distance, blur, spread), Box gains Background on/off and opacity. The rows are property-registry specs
  (`TEXT_LOOK_SPECS`, dynamic `text.stroke.<i>.<width|color|position>`), so `param.set` and MCP property tools reach
  them too.
- **Text Style section (AS-032)**: the style of the selection ("None", a name, or "Mixed"); choosing a style links all
  selected text clips, "None" detaches; status line with the deviating fields; Reset to Style, Detach, Update Style
  from Clip; New Style from Selection… (name prompt); Project Text Styles list with usage counts (click = select those
  clips), Rename…, Delete (confirmation names how many clips are detached; undoable).
- **Edit ▸ Select ▸** lists the registered selection helpers (`apps/web/src/selection/helpers.ts`): **Same Style**
  (clips linked to the primary clip's style; when it is not linked, clips whose effective style equals its style;
  locked tracks left out). Features register more helpers (`selectionHelpers.register({id, label, unavailable?,
  select})`); the subtitles work adds Subtitle Group and Same Template there. Commands: `select.sameStyle`,
  `select.byHelper {helper}`, `textStyles.newFromSelection`, `textStyles.apply {styleId}`, `textStyles.detach`,
  `textStyles.reset`.
- **Effect Controls "N clips" mode (AS-031)**: with ≥ 2 selected clips of the primary's medium (a clip and its linked
  partner stay single-clip) the panel lists Motion and Opacity (Volume and Panner for audio) and every applied effect
  present on all of them, matched by effect id + occurrence. Values are read at each clip's In + the playhead's offset
  from the primary clip's In; edits go out as one `effect.setParamMany` (intrinsics: `param.set` with `at: {frames}`
  per clip), stopwatch / ◆ / ◀ ▶ work relative to each In (`relativePlanner`); bypass / remove on all; drop an effect
  to add it to all. No mini-timeline in this mode.

## Agents (MCP, `apps/mcp/src/tools/text-styles.ts`, guide `TEXT_STYLES_GUIDE`)

`style_text` (style patch + effect ops add / set / remove, keys relative to each In, `$selection`, `groupId`),
`list_text_styles`, `create_text_style` (`applyTo`), `apply_text_style` (apply / detach / reset), `update_text_style`
(patch, `fromClipId`, rename), `delete_text_style`. `describe_commands` has an example per new command (dry-run in
`apps/mcp/test/text-styles.test.ts`). `apply_subtitle_template` belongs to the subtitles work.

## Validation

- `packages/project/test/text-styles.test.ts`: deep merge, stroke edits, refusals naming clips, atomicity, locked
  tracks, `$selection`, runs clearing, clip.update merge, property tests of patch semantics (fast-check), linked
  styles (deviations kept through `clip.update` and `param.set`, reset of chosen fields, rename uniqueness, delete,
  locked tracks), lenient load + repair (malformed keys, unreadable styles, dangling links, bad overrides,
  idempotent), batch effects (keys from In / Out, per-target values, delta, stopwatch, keyframes, removal).
- `packages/session/test/text-styles-history.test.ts`: every batch command over multiple clips is one History entry;
  undo / redo give the exact documents.
- `apps/web/test/text-styles.test.tsx`: mixed display (split swatch, Mixed, –), relative scrub = one entry
  "Shadow Blur (3 clips)", stroke list, Text Style section (Mixed, apply to all, reset), Same Style, Effect Controls
  N-clips mode (one step for 3 clips, stopwatch keys at In + 5 frames, remove on all).
- `e2e/text-styles.spec.ts`: 100 text clips selected in the running editor → stroke width set in Properties → one
  History entry; undo restores all 100.

## Limitations

- Rendering of every stroke and of the shadow spread is the text rendering work (spec 13 SH-004); until it merges,
  preview and export draw what the renderers support today (the first stroke, a CSS shadow without spread). The data
  written here is complete and kept.
- Lumetri curve and colour-wheel controls in N-clips mode write through the default (playhead) planner: static values
  set every clip, keyed curves get keys only where the playhead is inside each clip.
- Effect Controls N-clips mode does not show masks, puppet pins or text animators of the clips (they are per clip).
- Timing of batch commands on 1 000+ clips was not benchmarked (not measured).
