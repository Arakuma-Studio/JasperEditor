# Project files

JasperEditor projects are `.jasper` files: UTF-8 JSON with an explicit schema version (S01 §18). The model,
its zod schema, the migrations and the load pipeline are in `packages/project`; the engine stores the files
(`apps/engine/src/projects/`); the editor saves through `@jasper/session` (`packages/session/src/persistence/`).
Decisions: ARCHITECTURE D-08 (engine-backed store), D-29/D-32/D-33 (schema v3–v5), D-39 (versions, backups,
crash recovery).

## Format

```json
{
  "format": "jasper-project",
  "schemaVersion": 7,
  "savedAt": "2026-10-07T10:12:00.000Z",
  "savedBy": { "app": "JasperEditor", "version": "0.1.0", "platform": "web" },
  "revision": 412,
  "document": { "schemaVersion": 7, "projectId": "prj_…", "name": "…", "settings": {…}, "rootItems": […],
                "items": {…}, "media": {…}, "synthetics": {…}, "transcripts": {…}, "fonts": {…},
                "sequences": {…}, "extensions": {…} }
}
```

- `document.schemaVersion` is the version of the document; the envelope repeats it. This build writes
  `CURRENT_SCHEMA_VERSION` (`packages/project/src/schema/document.ts`) and reads every version from 1 up to it.
  A bare document without an envelope, or without `schemaVersion`, is read as v1.
- `revision` counts saves. The engine refuses a save whose `If-Match` is not the stored revision
  (409 `REVISION_CONFLICT`, S01:PER-025): two writers never overwrite each other silently.
- Media is referenced, never embedded: an `engine-store` locator (`mediaKey`) and, on desktop, a `path`.

### Where the engine keeps them

```
<appdir>/projects/<projectId>/
  project.jasper                         the project (atomic writes)
  project.jasper-view                    view state: open tabs, zoom, playhead (not undoable, not shared)
  project (schema v4 backup).jasper      kept before the first save over a v4 file (see Migrations)
  versions/<ISO stamp>.jasper            saved versions (every 5 minutes of saving, newest 20)
  versions/<ISO stamp>-restore.jasper    the state a restore replaced
  recovery/<sessionId>/                  crash-recovery journal of an editing session (see Crash recovery)
```

## Schema history

| Version | Since | Change | Migration |
|---|---|---|---|
| 1 | M1 | the M1 document | — |
| 2 | M1 polish | audio clips take the Audio label by default (S05:DT-021) | `v1→v2`: the audio half of a linked A/V clip still carrying the v1 Movie label (violet) becomes caribbean; user-chosen labels are kept |
| 3 | M2 (D-29) | LUT and Remotion-bundle media, process recipes, trackers, curve parameters | `v2→v3`: version bump only, so M1 builds open M2 files read-only |
| 4 | M2 (D-32) | text animators, anime.js template renderer, shape clips | `v3→v4`: version bump only |
| 5 | M3 (D-33) | `MediaAsset.sourceRange` (which source frames a processed or rendered version holds) | `v4→v5`: processed versions made from the whole source get the explicit full-source range |
| 6 | parity program (D-36…D-48) | masks and track mattes, nests and adjustment layers, groups, captions and transcripts, time remapping, vector shapes, text animators, expressions, 3D layers / cameras / lights, multicam, roto mattes, audio effects / buses / Essential Sound, working colour spaces, interpreted footage, and the other optional fields the parity workstreams added | `v5→v6`: version bump only, so v5 builds open v6 files read-only instead of dropping the new fields on save |
| 7 | sound design (spec 12, Phases 0–1) | Essential Sound SFX Pan is an offset on the clip's own pan (`essential.panOffset`, with `essential.residual` for what the fader range clamped); `MediaAsset.library` (provenance of Sound Library sounds, including `leadSilenceSec` for copies registered with lead silence) | `v6→v7`: version bump only, so v6 builds open v7 files read-only. Why: a v6 build editing Essential Sound Pan on a v7 file writes an absolute pan while keeping the `panOffset` marker, which v7 then reads as an offset (the clip's keyframes would shift). Older SFX Pan settings (no marker) keep being read by `migrate-essential-pan` (repair) and the Essential Sound commands |
| 8 | Premiere port | Crop applies where it sits in the effect stack (v7 always applied it first); user font library references, per-side keyframe interpolation, curved paths on effect points, Premiere crossfade shapes, the Universe-style Slide transition and relink metadata | `v7→v8`: stacks listing a Crop after another effect put their Crop effects first, so v7 projects render as before; v7 builds open v8 files read-only |
| 9 | workflow automation (specs 13–16) | subtitle text clips (words, caption groups), linked project text styles, subtitle templates, voice-cleanup settings and scripts, style recipes, automation provenance, text shadow spread | `v8→v9`: version bump only; v8 builds open v9 files read-only |

Every version has a hand-made fixture, `packages/project/test/fixtures/schema-v<N>.jasper`, that must load
forever (S01:MIG-002), and `packages/project/test/schema-history.test.ts` checks that:

- there is one fixture per version, 1 … `CURRENT_SCHEMA_VERSION`, and one contiguous migration step per version;
- each fixture loads, migrates to the current version and passes the invariants **without repairs**;
- each shipped step makes exactly its documented changes to the fixture of its version (`STEP_CHANGES`), so
  editing a shipped migration fails the test;
- newer files open read-only and are never migrated down.

The older `fixtures/v<N>/basic.jasper` files are richer documents used by feature tests.

## Migrations

Older files are upgraded on load, in memory: `loadProject` = envelope → `migrate` (the chain of `MIGRATIONS`,
one pure step per version) → zod validation → invariants → conservative repair (S01:PER-004). The file on disk
is unchanged until the project is saved.

Rules:

1. **Never edit a migration that has shipped.** A file written by any released build must keep loading to the
   same result. Fix a bad step with a new step.
2. **Bump the schema whenever an older build would drop or misread new data.** Fields added as optional with a
   read-time default (zod `.optional()`/`.default()`, MIG-005) need no migration, as long as an older build that
   loads the file and saves it back keeps them. When it would not (a new clip or media kind, a new required
   shape, a field an older build's strict schema strips), bump `CURRENT_SCHEMA_VERSION` with a step (a no-op
   step is fine): older builds then open the file read-only ("Created with a newer JasperEditor", MIG-003)
   instead of failing or silently dropping the new data on their next save.
3. To bump: add the step to `MIGRATIONS` in `packages/project/src/migrations.ts`, bump
   `CURRENT_SCHEMA_VERSION`, add `fixtures/schema-v<N+1>.jasper` showing the new shape, add the step's expected changes to `STEP_CHANGES`, and add a
   row to the table above.
4. Coordinate concurrent schema changes under [AGENTS.md](../AGENTS.md) §0; the integrated result must
   include any required schema bump and compatibility tests before merge.

### The first save over an older file keeps a backup

When an editor saves a project whose file was written with an older schema, the engine first copies the file
to `project (schema vN backup).jasper` next to it (S01:MIG-004). It is made once and never overwritten, so an
older JasperEditor can still open that work: File ▸ Project Versions… lists it as an *older-format backup*, and
**Open as Copy** makes a separate project of it (it cannot be restored over the project, which would downgrade
it). Agents: `list_project_versions`, `restore_project_version {mode: "copy"}`.

### Optional fields added since v6

These fields are optional with read-time defaults; older v6 builds keep them on save (`looseObject`). The fields
alone needed no bump (rule 2); the v7 bump above is for the SFX Pan reading that came with them. Sound-design
fields of later phases are added to v7 until `feat/sound-design` merges to `main`.

| Field | Since | Read leniently | Repair |
|---|---|---|---|
| `TextStyle.shadow.spreadPx` (text clip styles, runs, paragraphs, Source Text keys; caption clip styles, caption track defaults, caption style presets) — spec 13 SH-004 | v9 | absent = 0; any number is read (invariant INV-012 wants 0…10 000 px) | out of range clamped to 0…10 000, unreadable removed (`repair-text-style`) |
| `TextStyle.strokes[]` drawn in full (every entry, inside / centre / outside) — spec 13 SH-004; no new field, v8 builds drew only `strokes[0]` | v9 | every entry is read | lists longer than 16 strokes (INV-012) are cut to the first 16 (`repair-text-style`) |
| `MediaAsset.library` | sound design (spec 12 §2.1, WP1.1a) | the document schema accepts any value (`z.custom<LibraryProvenance>(() => true)`, typed as valid provenance), so a damaged value never fails a load; INV-LIBRARY checks it against `LibraryProvenanceSchema` | `repair-library`: each unreadable field is reset on its own (title → sound id, licence → `NOASSERTION`, bad types / source / descriptors / URLs dropped, unknown newer fields kept); `drop-library` when there is no usable `soundId`. Pasted media get the same treatment. Commands (`media.setLibraryInfo`, `media.register`) validate strictly (`E_SCHEMA`) |
| `MediaAsset.library.trailSilenceSec`, `library.descriptors.tailSec` | sound design (fix "SFX tail truncation"; still v7) | optional numbers (`trailSilenceSec` 0…1 s: silence registration put after the sound; `tailSec` ≥ 0: peak → −60 dB). Absent = no trailing silence / fade unknown: placement then reaches the end of the file (under one frame past it), Sound Check measures the fade on the file. `libraryDescriptorIssue` refuses a tail past the end or a trail over the peak | `repair-library` drops a bad `trailSilenceSec` on its own; a bad `tailSec` drops the descriptors like any other bad descriptor |
| `Sequence.soundDesign` (`cues`, `settings`, `lastCheck`) | sound design (spec 12 §2.2, WP2.1; still v7) | any value accepted (`z.custom<SoundDesign>`); INV-SOUND checks `SoundDesignSchema`, cue keys = ids, ids `cue_…`, ≤ 20 000 cues; settings default at read time (`soundDesignSettingsOf`: web, balanced, no SFX tracks, no room bus, seed 0, agents may not apply, empty palette). References to clips, transitions, markers and media (anchors, `placedClipIds`) are soft: edits never fail on them, readers skip dangling ids | `repair-sound-design` (cue by cue, field by field: frame clamped to 0…10 368 000, unknown kind / weight / source → manual / support / user, bad optional fields dropped, unknown newer fields kept; unreadable cues dropped; `drop-sound-design` when not an object), `reid-cue` (malformed ids, or ids shared with another sequence; the clips' `sfx.cueId` follow), `drop-cue-anchor` (anchor whose clip / transition / marker / media / keyframe is gone → null, the cue keeps its frame), `prune-cue-clips`, `prune-sfx-tracks`, `reset-room-bus`. `loadProject` also runs the repair when only soft references dangle (`soundDesignNeedsRepair`). Idempotent. `sequence.duplicate` gives the copy new cue ids with its anchors and clips mapped |
| `Marker.soundCheck` (sequence markers) | sound design (Phase 5 verification, `soundDesign.setVerdict`; still v7) | optional object on a listen-here verdict marker (`{v: 1, verdict, slot, subject: {kind: clip, id, start} \| {kind: cue, id, frame} \| null, mixHash, momentHash, reportMixHash}`): which moment the user judged; read by `readSoundCheckVerdictMeta`. Absent = an older verdict marker bound to its frame only (staleness unknown). Older builds keep it (markers are loose objects). INV-SOUND reports an unreadable one | `drop-verdict-meta` removes an unreadable `soundCheck` (the comment marker stays, as a frame-bound verdict). Idempotent |
| `AudioClip.sfx` (`cueId`, `soundId`, `layer`, `role`, `alternatives`, `placement`) | sound design (spec 12 §2.2, WP2.1; still v7) | any value accepted (`z.custom<ClipSfx>`); INV-SFX checks `ClipSfxSchema` and that only audio clips carry it. `soundId` is null for media that is not a library sound | `repair-sfx` (field by field: layer clamped to 0…5, unknown role → support, placement defaults), `drop-sfx` on other clip kinds or non-objects, `unlink-sfx` (`cueId` → null when the cue is not in the clip's sequence) |
| `AudioClip.sfx.pitch` (`st`, `baseRate`) | sound design (WP6.5b; still v7) | optional object: the pitch shift placement / `soundDesign.swap {pitchSt}` applied (−12…12 st) and the clip speed under it (0.01…100, the seeded variation). Used only while it matches the clip (`baseRate · 2^(st/12)` = its speed for \|st\| ≤ 3, else its speed = `baseRate` and its Pitch Shifter = `st`). Absent (older clips) or not matching (speed changed by another command): the speed is read as whole semitones of varispeed plus the variation, as before | `repair-sfx` drops a malformed record on its own (the clip and the rest of `sfx` kept) |
| `Sequence.soundDesign.settings` later fields (`palette`, `credits`, `style`, `referenceProfile`, `agentsMayApply`), `soundDesign.mix` (stop-before / build / room-glue bookkeeping), `soundDesign.acknowledged` (≤ 500) | sound design (Phases 2–6: WP2.4b, WP4.2a, WP6.4, WP-E6, WP-E4, WP-E2; still v7) | inside the `z.custom<SoundDesign>` value; `soundDesignSettingsOf` gives defaults for every absent setting; INV-SOUND checks `SoundDesignSchema` | `repairDocument` reads it leniently (`readSoundDesign`: unreadable cues or fields removed, with a report line), prunes settings naming missing tracks or submixes and mix records of what is gone (their automation stays as ordinary keys); a duplicated sequence starts without acknowledgements; idempotent (`packages/project/test/sound-acknowledge.test.ts`, `sound-mix.test.ts`, `sound-p2v-model.test.ts`) |
| `AudioClip.sfx.level` (`by: default \| solver`, `gainDb`, `limitedBy`, `manual?`) | sound design (Phase 4; still v7) | inside the `z.custom<ClipSfx>` value; absent = a gain the user gave | an unreadable level is dropped (the clip gain stays) |
| `AudioClip.bed` (`purpose`, `shot`, `piece`, loop and bed ids) | sound design (spec 12 P6-E12, WP-E8; still v7) | any value accepted (`z.custom<ClipBed>`); only audio clips carry it | a malformed value is dropped; the clip stays |
| `MediaAsset.library.take`, `library.inexact` | sound design (P6-E9 WP-E5; final carry-over cleanup; still v7) | optional objects in the provenance (`take {soundId, index, sourceStartSec, sourceEndSec}`; `inexact {reason}`) | `repair-library` drops a malformed one (the rest of the provenance stays) |
| `AudioClip.remix.anchors`, `remix.fadeInId` | music to picture (P6-E11 WP-E7; still v7) | `anchors: unknown[]` (≤ 64), read with `readRemixAnchors` | malformed entries are dropped |
| `AudioClip.essential.tagged` | Auto Tag (P6-R3 WP6.3; still v7) | inside `essential` (`z.unknown()`), read with `readEssentialSound` | an unreadable value is dropped (the type stays) |
| `Sequence.master.loudness.analysis.delivery` (`targetLufs`, `truePeakDbtp`, `gainDb`, `limiterCeilingDbtp`, `passes`, `ceilingLimited?`, `deliveredLufs?`) | sound design (fix "preview loudness parity, codec-aware Sound Check, delivery speed"; still v7) | any value accepted in the document (`z.custom`), read with `readLoudnessDelivery` (`LoudnessDeliverySchema`); `mixer.setLoudness` / `soundDesign.applyDelivery` validate it strictly (`E_SCHEMA`). Absent (analyses stored before) or solved for another target / ceiling than the Mix's: the preview plays the one-pass gain `target − integrated` at the target ceiling, as before. Older builds keep it (the analysis is a loose object). Not part of `mixFingerprint` | INV-MIX reports an unreadable one; `drop-loudness-delivery` removes it (the analysis stays). Idempotent |
| `Sequence.soundDesign.lastCheck.exportAudio` (`codec` aac / opus / pcm, `bitrateKbps?`, `sampleRate?`) | sound design (same fix; still v7) | inside the `z.custom<SoundDesign>` value, read with `readSoundCheckAudio`; absent = checked for the PCM master (summaries stored before). Part of `inputsHash` only when present (older hashes stay valid); `soundCheckStatus(…, {checkFor})` adds the stale reason `codec` | as the other summary fields (`readSoundDesign`) |

### Fields added in v8

Optional fields of the Premiere port, read leniently with read-time defaults (MIG-005); v7 builds open v8 files
read-only (the v8 bump above), so they never drop them.

| Field | Since | Read leniently | Repair |
|---|---|---|---|
| `Transition.cutPosition` | Premiere port (audio crossfades: Premiere's Custom Start alignment, wp-notes/audio-crossfades.md) | any value accepted (`z.custom<number>()`); absent = the `alignment`'s position. A number in (0, 1): the fraction of a two-sided span before its cut (frames before the cut = round(cutPosition × duration), `cutOffsetOf`), so a shortened transition keeps its proportions. INV-010 reports a value that is not a number in (0, 1) or sits on a one-sided fade. Commands take `cutOffset` frames (`transition.add` / `transition.update`; an `alignment` drops it) | `drop-cut-position` removes it (the transition keeps its `alignment`). Idempotent |
| `Transition.params` of `jasper.custom-fade` (`fadeShape`, `fadeValue`, `symmetry`, `outFadeShape`, `outFadeValue`) | Premiere port (Custom Fade) | ordinary transition params (`AnimParamSchema`); absent = Cosine @ 19, symmetrical (`audioTransitionCurves` reads unknown shapes as Cosine and clamps values to −100…100). INV-010 reports an unknown option, a non-finite or out-of-range value, or keyframes | `reset-transition-param` deletes the unreadable param (its default applies). Idempotent |
### Fonts named by family (wp fonts, still v8)
Text and caption styles reference `doc.fonts[id]` (`FontRef {id, family, source}`); renders resolve `family` at render
time against the bundled families and the user font library (`<appdir>/fonts`, `docs/wp-notes/fonts.md`): family,
then a face's PostScript / full / legacy family name. No field was added: a project made with an installed font opens
in older builds and on machines without the font with the default family (`FONT_FALLBACK` names it), and renders with
the font as soon as it is installed. The library index (`library.json`, version 1) is app state, not project state:
it is repaired on open, and a newer index is read-only.
| `Keyframe.inInterpolation` (`linear` / `bezier` / `auto-bezier` / `continuous-bezier`) | keyframe-sides ([wp-notes/keyframe-sides.md](wp-notes/keyframe-sides.md)) | the schema is a strict optional enum (it is reused by command and MCP input schemas, which must be JSON-Schema-representable), but documents load leniently: `loadProject` drops an unknown value before validation (`dropUnreadableKeySides`, reported as `repair-key-sides`). Absent = the key is read the legacy way (its `interpolation` for both sides; a segment leaving a Linear key is linear), so existing documents evaluate exactly as before. Present = the segment arriving at the key is evaluated per side (After Effects: a Linear side is influence ⅙ at the average speed). INV-011 reports an unknown value and Auto / Continuous Bezier on a key whose sides differ | `repair-key-sides` (`normalizeKeySides`): an unknown value is dropped (legacy reading); one-sided Auto / Continuous Bezier becomes Bezier with the stored ease. Also on motion-graphic `paramKeyframes`; pastes and presets are normalized the same way. Idempotent |
| `Keyframe.spatial` on effect point params (`fxParam.point`: Transform Position / Anchor Point, Offset Shift Center To, …) | spatial-points ([wp-notes/spatial-points.md](wp-notes/spatial-points.md)) | the existing `SpatialSchema` field, now accepted by the commands on effect points; tangents in the param's normalised units. Absent = linear spatial. Lengths (arc-length timing, Auto Bezier handles) are measured in the layer box's pixels at evaluation (`paramSpatialMetric`), a property of the registry, not stored. An older build keeps the field (loose objects) and draws the same curve, timed in normalised units; INV-011 (vec2 with finite tangents) applies unchanged | none needed (INV-011's existing repair) |
| Effect preset keyframe `spatial` (`PresetKeyframeSchema`, engine library file and exported preset JSON, not the project) | spatial-points | optional `SpatialSchema`; kept only on point properties when applied; absent = linear spatial. Older builds keep it (loose objects) and ignore it | invalid values are refused by the preset parser |

### Fields added in v9

Optional fields of the workflow-automation work (specs 13–16), read leniently with read-time defaults (MIG-005);
v8 builds open v9 files read-only (the v9 bump above), so they never drop them.

| Field | Since | Read leniently | Repair |
|---|---|---|---|

## Saving

- **Atomic writes** (S01:PER-016): every project, version, view and journal file is written to a hidden temp
  file in the same directory, fsynced, renamed over the target, and the directory fsynced
  (`apps/engine/src/tools/fs.ts` `atomicWriteFile`). A crash or `kill -9` leaves the old or the new file,
  never a torn one.
- **Autosave** (S01:PER-020): the editor saves the committed document 1.5 s after the last edit and at least
  every 10 s while edits keep coming, never in the middle of a drag. Ctrl+S saves now. A 409 pauses autosave
  until the user chooses Reload or Overwrite.
- **Single writer** (S01:PER-040): opening a project takes a lease (30 s, heartbeat every 10 s). A second editor
  opens read-only and can **Take over editing**. Closing or reloading the tab releases the lease with a
  keepalive request on `pagehide`; if that never arrives (a crash) the lease expires after 30 s. A reload does not
  depend on that request: the tab remembers the session that held the lease (`sessionStorage`) and takes its own
  lease over at once when the new page finds it still held, after checking that no live page of the origin holds
  it (a duplicated tab copies the memory). Other tabs and agents wait for the expiry or use Take over
  (`packages/session/src/persistence/tab-leases.ts`, `docs/wp-notes/polish.md` §1).

## Versions

The engine keeps the previous file as a version when the newest version is more than 5 minutes old (so one
per 5 minutes of editing), and the newest 20. File ▸ **Project Versions…** lists them with the time, the kind
and the revision:

- **Restore** writes the version over the project. The state it replaces is kept first as a version of its own
  (*Before a restore*), so a restore can always be undone by restoring that one. The editor saves what is on
  screen, restores, and reopens the project. From outside the editor, a restore in place is refused while an
  editor holds the project (409 `LEASE_HELD`).
- **Open as Copy** makes a new project from the version (S01:PER-001 `restoreVersion`) and opens it.

Routes: `GET /api/projects/:pid/versions`, `GET …/versions/:versionId`,
`POST …/versions/:versionId/restore {mode: "replace" | "copy", name?, leaseId?}`.

## Save As, Save a Copy, Revert

| Command | Menu (shortcut) | Does |
|---|---|---|
| `app.saveAs` | File ▸ Save As… (Ctrl+Shift+S) | asks for a name, writes the current document to a new project and continues there; the original keeps its last saved state |
| `app.saveCopy` | File ▸ Save a Copy… (Ctrl+Alt+S) | the same, but you keep editing the original |
| `file.revert` | File ▸ Revert | discards the changes autosave has not written yet and reloads the last saved state (asks first; cannot be undone). Enabled only while there are unsaved changes: with autosave that is a short window, so to go further back use Project Versions |
| `file.projectVersions` | File ▸ Project Versions… | the versions dialog above |
| `file.recoverUnsaved` | File ▸ Recover Unsaved Changes… | the recovery dialog below, for journals left when you chose Not Now |

Agents use the MCP tool `save_project_copy` (the live document of an open editor, unsaved edits included).

## Crash recovery

Autosave makes the file current within 1.5–10 s, but a crash in that window, or while autosave is paused
(a conflict, a lost lease, an engine error), would lose edits. Each editing session therefore keeps a
**recovery journal** (S01:PER-021, AC-18):

- While the session has unsaved changes, it sends its committed document to the engine about **1 s after the
  last edit**, and at most every **5 s** while edits keep coming
  (`PUT /api/projects/:pid/recovery/:sessionId`, `packages/session/src/persistence/recovery.ts`). The engine
  writes `recovery/<sessionId>/snapshot.jasper` (the envelope), `session.json` (project name, base revision,
  the labels of the unsaved History steps, times) and `lock` (`{pid, instance}` of the engine) atomically.
- **The journal is held under a lock while its session can still write it**: the engine process that wrote it
  is alive and, for this engine, the session still holds the project's lease. Only the lease holder can write
  or clear its own journal; a held journal is never offered, read or deleted by anyone else, and journals of
  another live engine process on the same appdir are never touched.
- When autosave catches up (nothing unsaved), the journal is deleted. A clean close deletes it too; if the
  last save failed, the journal stays so the changes are offered next time.
- After an **unclean exit** (the tab or browser crashed, the desktop app or the engine was killed, power
  loss) the lease runs out or the restarted engine no longer knows it, so the journal is no longer held. The
  next time the project opens, if the journal differs from the saved project, the editor asks:
  *"JasperEditor closed before 'X' was saved. Recover the unsaved changes from <time>?"* with the number and
  names of the changes and **Recover**, **Not Now** and **Discard**. A journal equal to the saved project
  (autosave caught up before the crash) is stale and removed silently.
- **Recover** applies the snapshot as one undoable step, *Recover Unsaved Changes*: Edit ▸ Undo goes back to
  the saved state. The recovered state is journalled by the new session and saved before the old journal is
  deleted. If the project was saved again after the crash (by another session), the dialog says so; recovering
  replaces that state, and Undo takes it back.
- **Not Now** keeps the journal for File ▸ Recover Unsaved Changes…; **Discard** deletes it.
- Agents see journals with `list_unsaved_changes`; recovering is the user's decision, in the editor.

Cost: the journal is the same compact JSON as a save, written by the engine off the UI thread (one PUT of the
document per ≥ 1 s of editing).

Routes: `GET /api/projects/:pid/recovery` (candidates), `GET …/recovery/:sessionId` (a candidate's envelope),
`PUT …/recovery/:sessionId {leaseId, baseRevision, revision, changes, changeCount?, envelope}`,
`DELETE …/recovery/:sessionId[?leaseId=]`.

Tests: `apps/engine/test/recovery-versions.test.ts` (routes, lock semantics across engine restarts and other
processes, schema backup, restore), `packages/session/test/persistence/recovery.test.ts` (timing, clearing,
recovery as an undoable step, Revert), `apps/web/test/project-files.test.tsx` (actions and dialogs).

## Newer files

A file whose `schemaVersion` is newer than this build supports opens **read-only** with the banner "Created with
a newer JasperEditor — the project is open read-only and will not be changed" (MIG-003). It is never migrated
down, and the engine stores a newer document verbatim. Update JasperEditor to edit it.
