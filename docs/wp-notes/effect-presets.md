# wp-m3-presets — effect presets ("Save Preset…", Effects ▸ Presets)

Branch `wave1/effect-presets`. Specs: S03 §15.3 FX-030 (presets), FX-010 (applying, one undo entry for N clips),
EC-004 (header menu with Save Preset…), §12.5 (key retiming: deep copy, new ids, re-keyed paths), §22 AGT-002
`presets.apply`, AGT-020 (exchangeable JSON); S01 §21.5 AGT-020 (headless uses the same handlers); S05 EFX-001/002
(Presets bin, custom bins, Delete), DG-001…007 (dialogs). Premiere behaviour is the reference.

## What was built

| Area | Where | Notes |
|---|---|---|
| Format | `packages/project/src/effect-presets/schema.ts` | `{format: "jasper-effect-preset", version: 1, id, name, description?, type, folderId?, builtIn?, category?, spatial?, source: {clipKind?, duration (frames), frameRate, frame?, box?}, intrinsic?: {motion?, opacity?, blendMode?, crop?, volume?, pan?}, effects?: [{effectId, effectVersion?, enabled?, params}]}`. zod, loose objects (unknown fields survive), 2 MB cap, newer versions refused with a message. Key `time` = **offset in flicks from the clip's first frame (sequence time)**, not content time, so presets are independent of in points, speed and frame rate; key `id` / `interpolation` / eases optional (agents can write terse JSON). Unknown effect ids are kept verbatim and flagged (`presetSummary().unknownEffects`). Bundle file (`jasper-effect-presets`) for Export / Import with the bins used. |
| Time mapping | `effect-presets/time.ts` | Scale: `o' = o · last'/last` (first→first, last→last frame); Anchor to In: `o' = o`; Anchor to Out: `o' = last' − (last − o)`, with `last = (duration − 1)` frames. Then snapped to the target frame grid and mapped through in point / speed / reverse to content time (clamped ≥ 0; keys landing on one frame: the later wins, as pastes do). |
| Save | `effect-presets/build.ts` `buildEffectPreset(doc, clipId, {name, type, description, sections})` | Sections: `motion`, `opacity` (+ blend mode), `crop` (the pinned first `jasper.crop`; registry defaults when the clip has none), `volume`, `panner`, `effectIds` (stack order kept). Records the source frame size and layer box. |
| Apply | command `effect.applyPreset {preset, clipIds, index?}` (`commands/{schemas,handlers}/preset.ts`, owner `wp-m3-presets`, M3) | Intrinsics **overwrite** (Motion: only the properties the preset has), the pinned Crop is overwritten in place (or created at index 0), applied effects **append** (or insert at `index`) as new instances; every param goes through `buildParams` (validation, clamping, new key ids, auto-Bezier refresh). Clamps warn `W_VALUE_CLAMPED`; unknown effects are skipped with `W_PRESET_UNKNOWN_EFFECT`; extra params `W_PRESET_PARAM_DROPPED`; media params whose asset is not in the project use the default (`W_PRESET_MEDIA_MISSING`). Fails when nothing applies. One command for N clips = one History entry. `preset` is library data: temp-ref substitution, the AGT-010 touched-id walk and semantic addressing never look inside it. |
| Relative Motion | `spatial: "relative"` | Optional (built-ins use it): position as a fraction of the source frame, anchor of the source layer box, scale of "fit to frame", re-expressed on each target (so PiP / slides work on 4K, vertical, any media size). User presets default to absolute values, as in Premiere. |
| Built-ins | `effect-presets/builtins.ts` | Read-only, 14 presets from effects that exist today: Blurs (Blur In / Out 1 s, Gaussian Blur keys), Fades (Fade In / Out 1 s, Opacity), Slides (in from / out to left and right, eased), Zooms (slow zoom in / out, Scale type), Picture-in-Picture (25 % in each corner). |
| Library storage | engine: `<appdir>/presets/effect-presets.json` (`appdirPaths().effectPresetsFile`), `apps/engine/src/effect-presets/library.ts`, routes `apps/engine/src/routes/effect-presets.ts`, contracts `packages/api/src/effect-presets.ts` | See "Storage decision". Serialized, atomic writes, `revision` bumped per change and published as `effectPresets.changed {revision}`. Invalid entries of a hand-edited file are kept aside in `invalid` (written back, never dropped); an unreadable file is renamed `*.corrupt-<time>`. Routes: `GET/POST /api/effect-presets`, `PUT/DELETE /api/effect-presets/:presetId`, `POST /api/effect-presets/folders`, `PUT/DELETE /api/effect-presets/folders/:folderId` (bins nest; no cycles; delete removes the contents), `POST /api/effect-presets/import`. Built-ins are never stored; `builtin.*` ids answer 404 "Built-in presets are read-only". |
| Effects panel | `apps/web/src/panels/effects/presets/` (`PresetsBin.tsx`, `store.ts`, `hooks.ts`, `apply.ts`, `actions.ts`, `SavePresetDialog.tsx`, `PresetBinDialog.tsx`), hosted at the top of `EffectsPanel.tsx` | Presets ▸ built-in category bins + user bins (nested) + user presets. Search matches name, description, type and the effects used; the RT / N filters keep a preset when every effect it uses passes (intrinsics never hide it; unknown effects fail both). Double-click / Enter applies to the selected clips; drag onto a clip, Program layer or Effect Controls; drag a user preset onto a user bin (or Presets) to move it. Menus: New Preset Bin…, Import Presets…, Export My Presets… / Export Bin… / Export Preset…, Rename…, Preset Properties… (name, type, description, bin), Delete (also Delete key; confirmation, not undoable — the library is not the project). Unknown-effect presets show in the warning colour with the ids in the tooltip. |
| Drag contract | `apps/web/src/panels/effects/drag.ts` | A preset is the effect ref `preset:<presetId>` on the existing effect MIME, so the timeline and Program drop targets apply presets unchanged; `clipsAccepting` / `applyEffectToClips` resolve it. Effect Controls applies a dropped preset to the shown clips (primary + linked partner), at the drop slot. |
| Effect Controls | `EffectControlsPanel.tsx` (header click / Ctrl-Shift-click selection, header context menu), `effectControls/presets.ts` | Any header (Motion, Opacity, Crop, Volume, Panner, applied or missing effects) can be selected; right-click: Save Preset… (selected headers of one clip; disabled with Text Animation / Shape / Template only, or without the engine), Reset <section>, Remove <effect>. Save Preset dialog: Name (default the section name, "Custom Preset" for several), Bin (when bins exist), Type radio with Premiere's three types and a hint each, Description. |
| MCP | `apps/mcp/src/tools/presets.ts`, `PRESETS_GUIDE`, `examples.ts` | `list_effect_presets {query?, builtIn?}`, `get_effect_preset {presetId}`, `apply_effect_preset {projectId, clipIds, presetId | preset, index?}` (one `Agent: Apply Preset <name>` entry, live or headless), `save_effect_preset` (from a clip's sections or from authored JSON, into a bin), `delete_effect_preset` (destructive annotation; built-ins refused). `describe_commands` has an `effect.applyPreset` example. |

## Storage decision

- Web preferences are `localStorage` (timeline prefs, default transitions): per browser profile, invisible to agents
  and to the desktop/web split. Project documents are per project. Neither fits "persist across projects and
  sessions, shared with agents".
- The engine already owns the appdir (`.stage` in dev, `<Electron userData>/jasper` packaged, `/var/lib/jasper` on a
  server) and is what jasper-mcp talks to; MCP tools and the editor both go through `/api/...`. So the library is an
  engine file, `<appdir>/presets/effect-presets.json`, behind `/api/effect-presets` (ARCHITECTURE §4.3 updated).
- Built-ins ship in `@jasper/project` (`BUILTIN_EFFECT_PRESETS`), so the editor, the engine and jasper-mcp see the same
  set without storing it, and a new app version can update them.
- Applying never needs the library: the editor and the MCP tools resolve the id to JSON and send it inline with
  `effect.applyPreset`, so headless edits (AGT-020) and other machines work with the same command.

## Contract changes (additive)

- `@jasper/project`: `effect-presets/*` exports; command `effect.applyPreset` (`PRESET_COMMANDS`, label "Apply Preset");
  `substituteRefs` (`DECL_KEYS += preset`), `referencedIds` and `resolveAgentAddresses` skip `preset`.
- `@jasper/api`: `effect-presets.ts` schemas, routes `effectPresets*` (owner `wp-m3-presets`), event
  `effectPresets.changed`.
- `@jasper/config`: `appdirPaths().presetsDir`, `.effectPresetsFile`.
- Engine: route plugin `effectPresetRoutes` (after `cacheRoutes`), service `app.jasper.services.effectPresets`.
- Web: `writePresetDragPayload`; Effect Controls headers carry `data-ec-header`.

## Tests

- `packages/project/test/effect-presets.test.ts`: time mapping per type (incl. frame-rate change, reverse, speed,
  clamping), Save Preset builder, applyPreset (types onto longer clips, overwrite vs append, pinned crop, new ids, N clips
  = one revision, `index`, clamping warning, unknown effects, invalid presets, preset data never treated as refs),
  format (unknown fields/effects kept and flagged, search, badges, bundles/import shapes), every built-in applies, Fade
  Out ends on the last frame, relative PiP on a 4K sequence with 4K media.
- `apps/engine/test/effect-presets.test.ts`: CRUD, event revisions, persistence across engine restarts, validation,
  read-only built-ins, unknown effect ids kept, nested bins / cycles / recursive delete, import of bundles with bins,
  corrupt-file and invalid-entry handling.
- `apps/mcp/test/presets.test.ts`: list/search/get, save from a clip into a bin, apply by id (Anchor to Out), apply a
  built-in to two clips in one transaction, authored JSON validation, delete (built-ins refused), annotations.
- `apps/web/test/effect-presets.test.tsx`: Presets bin (built-ins, search, empty state, double-click = one undo entry
  for 2 clips), user bins + delete with confirmation, drag payload round trip + Effect Controls drop, Save Preset… from
  multi-selected headers through the dialog into the (faked) engine library.
- `e2e/effect-presets.spec.ts` (built app): double-click a built-in preset; Save Preset… from the Opacity header;
  after a reload the user preset is in Effects ▸ Presets and applies Anchor to Out to a longer clip.

## Known gaps / follow-ups

- Text Animation, Shape and Template parameter sections are not part of presets (no preset form yet).
- Presets with LUT (`{mediaId}`) params do not carry the media; on another project the param falls back to its
  default with a warning. Bundling the asset (like the clipboard does) is a follow-up.
- Effect param migrations (`EffectSpec.migrate`) are not applied to old preset versions (no effect has a version > 1).
- Rename is a small dialog (no inline rename in the tree); built-ins cannot be copied into the user library except by
  Export → Import.
- The Effects panel tree is still a flat render (the shader framework may add nested effect bins; the Presets bin is a
  separate component so the merge stays local).
