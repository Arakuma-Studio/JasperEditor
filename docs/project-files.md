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
  "schemaVersion": 9,
  "savedAt": "2026-10-07T10:12:00.000Z",
  "savedBy": { "app": "JasperEditor", "version": "0.1.0", "platform": "web" },
  "revision": 412,
  "document": { "schemaVersion": 9, "projectId": "prj_…", "name": "…", "settings": {…}, "rootItems": […],
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
| 9 | social comments (design §7.7, template media params) | motion-graphic template params may reference media: `{mediaId} \| null` values (`mediaParam()` of `@jasper/mg-templates`, e.g. a comment's avatar), anywhere inside `params` | `v8→v9`: version bump only, so v8 builds open v9 files read-only. Why: a v8 build counts only a clip's own `mediaId` as a use, so its orphan collection, item delete, Project Manager "Exclude Unused" and paste would drop (or leave dangling) media referenced only from template params on its next save. v9 counts them everywhere (`collectParamMediaIds`): INV-006 reports a missing one, INV-014 counts it as a use, and repair sets a dangling one to `null` (`clear-template-media`) |
| 10 | workflow automation (specs 13–16) | subtitle text clips (words, caption groups), linked project text styles, subtitle templates, voice-cleanup settings and scripts, style recipes, automation provenance, text shadow spread | `v9→v10`: version bump only; v9 builds open v10 files read-only |
| 11 | agent footage editing (spec 18 AF-BRF) | `Sequence.brief` (what the video should be: text, platform, target length, aspect) and `ProjectDocument.agentNotes` (notes agents keep) | `v10→v11`: version bump only, so v10 builds open v11 files read-only. Why: a v10 build neither shows, checks nor repairs the brief and notes, and its agents cannot read them; it would keep them on save (loose objects) but edit a project whose brief it ignores |
| 12 | Title Looks (spec 19) | looks on clips (`EffectInstance.appearance` on the internal `jasper.title-look` effect), project looks (`ProjectDocument.titleLooks`), the sequence's light (`Sequence.settings.globalLight`), the seeded-pattern identity of effects (`EffectInstance.patternOrigin`, TL-121), vertical text (`TextContent.writingMode`, `tateChuYoko`, TL-111), per-letter finishes on runs (`runs[].finish`, TL-093) and 3D titles (surfaces, bands, inflate, backplates, tone mapping, glints, environment presets, `hdri` media) | `v11→v12`: version bump only, so v11 builds open v12 files read-only. Why: a v11 build bypasses the unknown effect and draws the clip without its look, its orphan collection, item delete and Project Manager would drop media referenced only by a look layer, it ignores `patternOrigin`, so a razor cut's seeded pattern would restart, and it would draw vertical text in lines at a box measured for columns |

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

### Fields added in v10

Optional fields of the workflow-automation work (specs 13–16), read leniently with read-time defaults (MIG-005);
v9 builds open v10 files read-only (the v10 bump above), so they never drop them.

| Field | Since | Read leniently | Repair |
|---|---|---|---|
| `Transcript.segments` (`[{start, end, avgLogprob?, noSpeechProb?, compressionRatio?}]`, media-time flicks) | recogniser segment scores (spec 14 TC-003 / spec 16, [wp-notes/speech.md](wp-notes/speech.md) §3) | any list accepted (`z.array(z.unknown())`); absent = no scores. INV-012 (`transcriptSegmentsProblem`) checks ≤ 100 000 entries, each `TranscriptSegmentSchema` (non-negative integer flicks, end ≥ start, finite scores, noSpeechProb in 0…1), sorted by start. Readers use `transcriptSegments(t)` (only the well-formed entries). `transcript.attach` replaces them with the words, merges them inside `coverage` for sequence-mix results | `normalize-segments`: malformed entries dropped, the rest sorted; the field removed when nothing is left. Idempotent |
| `ProjectDocument.textStyles` (`{[id]: {id, name, style}}`) | linked project text styles (spec 13 SH-002 / AS-032, [wp-notes/text-styles.md](wp-notes/text-styles.md)) | any value accepted (`z.custom`); absent = no styles. INV-TEXTSTYLE checks an object of at most 1 000 entries, each `ProjectTextStyleSchema` (name 1…120 characters, `style` a valid `TextStyle` with ≤ 16 strokes and colours in 0…1), keyed by its own `tsy_…` id, its font in `doc.fonts`. `textStylesOf` reads only the readable entries | `repairTextStyles`: an unreadable record dropped (`drop-text-styles`); a malformed key re-keyed (the entry's id when free, else a new id) with its clips relinked, id = key (`fix-id`); long names cut; a missing font replaced by the default family (`reset-font`); an entry still unreadable dropped, its clips unlinked keeping their look (`drop-text-style`). Idempotent |
| `TextClip.styleId` | linked project text styles (spec 13 SH-002) | any value accepted (`z.custom`); absent = not linked. A string naming a style that is gone (pasted from another project) reads as not linked (soft). INV-TEXTSTYLE reports a non-`tsy_…` value or one on a non-text clip. The clip's `content.style` stays its effective style, so older builds and every renderer read the look without the link | `unlink-text-style` drops it (with `styleOverrides`) on non-text clips and when the style is missing; `loadProject` also runs the repair for dangling links alone (`textStylesNeedRepair`). Idempotent |
| `TextClip.styleOverrides` | linked project text styles (spec 13 SH-002) | any value accepted (`z.custom`); absent = no deviation. A `TextStyleOverrides` patch (fields where the clip differs from its style; shadow / background / openType field by field; `null` = removed) kept equal to `diffStyle(style, content.style)` by every command that writes a linked clip's style (`applyClipPatch`). INV-TEXTSTYLE reports it without a `styleId` or when unreadable. Editing a style re-derives each clip's deviations from the clip itself, so a stale value never loses one | `fix-style-overrides` recomputes an unreadable value from the clip; removed with the link. Idempotent |
| `TextClip.caption` (`{groupId, words: [{text, start, end}], speaker?, anchorIn?}`) | automatic subtitles (spec 13 AS-003 / AS-006, [wp-notes/auto-subtitles.md](wp-notes/auto-subtitles.md) §2) | any value accepted (`z.custom`); absent = an ordinary text clip. Words are in the clip's content time (flicks, the keyframe axis), sorted and non-overlapping, ≤ 2 000; `anchorIn` = the content time of the In the template's keys were laid out from. INV-SUBTITLE reports it on another clip kind, unreadable, a malformed `cgp_…` group id, unsorted / overlapping words, or a group the sequence does not have. `captionOf` reads only readable values. The text, style and effects stay ordinary text-clip fields, so older builds and every renderer show the subtitle unchanged | `drop-caption` (other clip kinds, unreadable; the text stays), `repair-caption-words` (sorted, overlaps cut, times rounded), `repair-caption` (unreadable anchor); a missing group is recreated with the default rules (`add-caption-group`; `loadProject` also repairs when only that soft problem exists, `subtitlesNeedRepair`). Idempotent |
| `Sequence.captionGroups` (`{[cgp_…]: {id, name, templateId, rules, text, language, cutAware, sourceRef, range, trackId?, highlight?, createdAt?}}`) | automatic subtitles (spec 13 AS-003) | any value accepted (`z.custom`); absent = no groups. Each group is `CaptionGroupSchema` (rules / text transforms / cut awareness stored resolved, `StoredSubtitleRulesSchema` …); ≤ 1 000 per sequence; members are the text clips whose `caption.groupId` is the id. `sequence.duplicate` gives the copy's groups new ids | `drop-caption-groups` (not an object), `fix-id` (key ≠ id, malformed keys re-keyed with their clips), `repair-caption-group` (unreadable fields reset to the defaults, readable ones and the name kept), `drop-caption-group` (> 1 000). Idempotent |
| `ProjectDocument.subtitleTemplates` (`{[id]: SubtitleTemplate}`) | subtitle templates (spec 13 AS-020) | any value accepted (`z.custom`); absent = none. Each entry is a `jasper-subtitle-template` v1 (`parseSubtitleTemplate`: style without font id + `fontFamily`, box, position per aspect, animation (text animation and an anchor-in effect preset), rules, text, cut awareness, highlight), keyed by its id, ≤ 500. Built-ins are copied in when used, so a project renders and regenerates the same on a build whose built-ins changed | `drop-subtitle-templates` (not an object), `drop-subtitle-template` (unreadable, > 500), `fix-id`. Idempotent |
| `EffectInstance.patternOrigin` (`{clipId, effectId, frame}`) | seeded effect patterns across razor cuts, duplicate and paste (spec 19 TL-121, [wp-notes/title-looks-fixes.md](wp-notes/title-looks-fixes.md)) | any value accepted (`z.custom`); absent = the instance is its own origin at frame 0. `readPatternOrigin` reads only well-formed values (non-empty ids, `frame` rounded and clamped to 0…`PATTERN_ORIGIN_MAX_FRAME`); an unreadable one is ignored, so the effect draws as an unsplit one. `u_seed` hashes the origin's ids, `u_frame` / `u_time` and `ctx.patternFrame` add `frame`. Set on GPU effects by `reidentifyClipChildren`. Ships with schema v12: an older build would redraw the pattern from the new ids | none needed (an unreadable value is ignored). Idempotent |
| `EffectInstance.subtitleTemplate` | subtitle templates (spec 13 AS-020) | any value accepted (`z.custom`); absent = the user's own effect. A template id: the instance was added by that template; its keys follow the clip's In after trims and razor cuts, and applying another template replaces it. INV-SUBTITLE reports a non-string | `repair-caption` removes a non-string mark (the effect stays). Idempotent |
| `settings.agentProposals` (`Record<feature, boolean>`, spec 15 EA-001: "Allow agents to apply <feature> proposals" for `edit-automation`, `subtitles`, `transcript-cleanup`; merged per feature by `project.updateSettings`) | v10 | absent entry = the feature's default (on); an unreadable value never fails the load and counts as off for every feature (`agentProposalsAllowed`) | readable boolean entries kept, the rest rewritten as `false` (never the default on), reported `reset-project-settings` (INV-PROJECT-SETTINGS) |
| `Sequence.cleanup` (`{settings?: {presetId?, overrides?}, script?: {name, text}, rejected?: fingerprint[], lists?: {<lang>: {fillers?, markers?, allow?}}}`) | transcript cleanup (spec 14 TC-030, [wp-notes/transcript-cleanup.md](wp-notes/transcript-cleanup.md)) | any value accepted (`z.custom`); absent = Fast, no script, nothing rejected, built-in lists; an absent override (e.g. `joins.fadeMs`) means the preset's current value (the built-ins' `joins.fadeMs` is 0, hard cuts; stored values are never rewritten). INV-CLEANUP checks `SequenceCleanupSchema` (strict: override groups and keys of `CleanupSettingsSchema` with their ranges, script ≤ 256 KB UTF-8, ≤ 20 000 distinct fingerprints, ≤ 32 languages of ≤ 500 list entries). `readSequenceCleanup` reads the readable parts; written only by `cleanup.configure` | `repair-cleanup` (`repairSequenceCleanup`): the preset id and each override key kept when valid, unknown keys and bad values dropped; the script kept (cut to 256 KB on a code point); malformed and duplicate fingerprints dropped; bad languages / entries dropped; removed when nothing readable is left. Idempotent |
| `AudioClip.edgeFades` (`{inMs?, outMs?}`, 0 < ms ≤ 30) | transcript cleanup (spec 14 TC-024: equal-power declick fades at cleanup joins) | any value accepted (`z.custom`); absent = no micro-fades. Rendered by `resolveAudioTransitions` as sub-frame `RenderAudioFade`s (`edge: true`) in every path; an edge with an audio transition plays the transition only. Splits keep each fade on its edge, Join Through Edits combines them. INV-CLEANUP reports an unknown key, a value outside 0 < ms ≤ 30, an empty object, or the field on a non-audio clip. Interchange exports name it as not carried | `repair-edge-fades`: the readable side kept, else the field removed (always removed from non-audio clips). Idempotent |
| Cleanup preset library (`<appdir>/presets/cleanup-presets.json`, `{format: "jasper-cleanup-preset-library", version 1, revision, presets, invalid?}`; app state, not the project) | transcript cleanup (spec 14 TC-030) | entries validated with `CleanupPresetSchema` (`cup_…` ids, `basedOn` Fast / Natural, overrides); unreadable entries kept aside in `invalid` and written back; built-ins never stored | an unreadable file is renamed `cleanup-presets.json.corrupt-<time>` and the library starts empty |
| Personal speech glossary (`<appdir>/speech/glossary.json`, `{format: "jasper-speech-glossary", version 1, revision, entries: [{id, from, to, lang?, count, createdAt, updatedAt}], invalid?}`; app state, not the project) | script-guided transcript correction (spec 17 SC-070, [wp-notes/script-correction.md](wp-notes/script-correction.md) "Personal glossary") | entries validated with `GlossaryEntrySchema` (`gle_…` ids; texts NFC, single-spaced, 1–64 characters; ≤ 20 distinct spellings, none equal to the target; ≤ 2 000 entries; unique target + language). Writes atomic (temp file, fsync, rename, directory fsync) and serialised; a file of a newer version is listed but never written (writes → 409 `GLOSSARY_READ_ONLY`) | reported to the user (`GET /api/speech/glossary` `repairs`): an unreadable file (not JSON, not an object, another format) is renamed `glossary.json.corrupt-<time>` and the glossary starts empty; invalid, duplicate and over-the-cap entries are kept aside in `invalid` and written back |
| `ProjectDocument.styleRecipes` (`{active?: recipeId, recipes: {[id]: StyleRecipe}}`) | style recipes (spec 15 EA-010, [wp-notes/edit-automation.md](wp-notes/edit-automation.md) "Style recipes, Apply Style and Style Check") | any value accepted (`z.custom`); absent = none (the pass dialogs use the measured defaults). Each recipe is `StyleRecipeSchema` (format `jasper-style-recipe` v1, strict: the passes' own parameter schemas, Clean Up preset + overrides, subtitle template + rules, asset roles, Style Check targets; ≤ 512 KB), keyed by its id (`builtin:…` / `rcp_…`), ≤ 100; `active` names a copy or a built-in. A recipe of a later format version is kept untouched, never used or rewritten (`projectStyleRecipes` lists it in `newer`). INV-STYLE-RECIPE checks the record. Written by `styleRecipe.add` (accepting an Apply Style proposal copies the recipe used and makes it active), `styleRecipe.setActive`, `styleRecipe.remove`; older builds ignore the field | `repairStyleRecipes`: `drop-style-recipes` (not an object), `repair-style-recipes` (unknown fields, unreadable list, an active id naming nothing: cleared), `drop-style-recipe` (unreadable entries, > 100; newer-format entries kept), `fix-id` (key ≠ id: the key wins when it is a recipe id, else the entry is re-keyed to its id); the field removed when nothing is left. Idempotent |
| Style recipe library (`<appdir>/style-recipes/`: `index.json` `{format: "jasper-style-recipe-library", version 1, revision, recipes: [{id, file, name, updatedAt}]}` and one `rcp_….json` per recipe; app state, not the project) | style recipes (spec 15 EA-010) | the index is zod-validated; each file with `parseStyleRecipe` (its id must be its file name); a recipe of a newer format is listed read-only; an index of a newer version makes the whole library read-only (never written). Writes are atomic (temp file, fsync, rename, directory fsync) and serialised; built-ins (`builtin:*`) are never stored | on load, reported to the user (`GET /api/style-recipes` `repairs`): an unreadable index is renamed `index.json.corrupt-<time>` and rebuilt from the files (`rebuild-index`); an entry whose file is gone is dropped (`drop-entry`); an unlisted recipe file is adopted (`adopt`); a file that is not a readable recipe is renamed `….invalid-<time>` (`set-aside`), never deleted. The repaired index is written back |
| `TextStyle.shadow.spreadPx` (text clip styles, runs, paragraphs, Source Text keys; caption clip styles, caption track defaults, caption style presets) — spec 13 SH-004 | v10 | absent = 0; any number is read (invariant INV-012 wants 0…10 000 px) | out of range clamped to 0…10 000, unreadable removed (`repair-text-style`) |
| `TextStyle.strokes[]` drawn in full (every entry, inside / centre / outside) — spec 13 SH-004; no new field, v9 and older builds drew only `strokes[0]` | v10 | every entry is read | lists longer than 16 strokes (INV-012) are cut to the first 16 (`repair-text-style`) |

### Optional fields added since v10 (no bump)

Fields added after v10 was published, without a schema bump. A bump is needed when an older build would drop or misread
the data (AGENTS §0); these fields are safe because a v10 build that predates them keeps them through load, edit and
save. Verified in the code: `SequenceSchema` is a `z.looseObject` (`packages/project/src/schema/sequence.ts`), so
unknown Sequence keys survive parsing; `loadProject` (`packages/project/src/migrations.ts`) continues with the parsed
data (`parsed.data`, unknown keys included) and `repairDocument` works on a JSON copy of the whole document without
rebuilding sequences; commands edit Immer drafts, which keep keys they do not touch; the engine store writes the
document the session sends (`apps/engine/src/projects/store.ts` `saveLocked`). An older build neither checks nor
repairs the field (its invariants do not know it), and its edits never write it, so the value stays as the newer
build wrote it. Contrast: a new key inside `Sequence.cleanup` would be stripped by an older build's strict
`SequenceCleanupSchema` repair, and new word-level transcript fields are dropped by older edit handlers — those need a
bump.

| Field | Since | Read leniently | Repair |
|---|---|---|---|
| `Sequence.scriptFix` (`{rejected?: fingerprint[], settings?: {strictness?: 'careful' \| 'standard' \| 'generous', sources?: ('script' \| 'glossary')[], scope?: 'recordings' \| 'used' \| 'inOut'}}`) | script-guided transcript correction (spec 17 SC-055, [wp-notes/script-correction.md](wp-notes/script-correction.md) "Applying fixes") | any value accepted (`z.custom`); absent = Standard, script + glossary, whole recordings, nothing rejected. `readSequenceScriptFix` reads the readable parts; INV-SCRIPTFIX checks `SequenceScriptFixSchema` (strict: fingerprints 1–512 characters without control characters, distinct, ≤ 10 000; settings keys and values from the lists above, sources distinct and non-empty). Written only by `scriptFix.configure` (settings merged field by field, `null` clears them; `reject` / `unreject` / `clearRejected`; more than 10 000 → `E_LIMIT`), one undo step | `repair-script-fix` (`repairSequenceScriptFix`): malformed and repeated fingerprints dropped, the first 10 000 kept; each readable setting kept, unknown keys and bad values dropped; removed when nothing readable is left. Idempotent |
| `Transcript.redecoded` (`{createdAt, ranges: [start, end][]}`, media flicks) | fix "hidden retakes" ([wp-notes/speech.md](wp-notes/speech.md) §11.3 "Hidden takes") | any value accepted (`z.unknown()`); absent = no range was decoded again. Readers use `transcriptRedecoded`: the ranges count only while `createdAt` equals the transcript's `createdAt` (the recognition that decoded them), well formed (integer, `0 ≤ start < end`, sorted and merged, ≤ 10 000). Written only by `transcript.attach` (from the job result's `guard.redecoded`; a `merge` keeps the current ranges outside its coverage). INV-012 reports a malformed value or a mark of another recognition. No bump: `TranscriptSchema` is a `z.looseObject` and older handlers assign transcript fields one by one, so an older build keeps the value through load, edit and save and ignores it; when an older build transcribes the media again it writes a new `createdAt`, so the earlier mark no longer counts (no restart is labelled "hidden retake" from it) | `normalize-redecoded`: a mark of another recognition or without ranges removed; malformed ranges dropped, the rest sorted and merged. Idempotent |

### Fields added in v11

Agent footage editing (spec 18 §2.8, [wp-notes/agent-footage-brief.md](wp-notes/agent-footage-brief.md)); v10 builds
open v11 files read-only (the v11 bump above).

| Field | Since | Read leniently | Repair |
|---|---|---|---|
| `Sequence.brief` (`{text, platform?, targetDurationSec?, aspect?}`) | spec 18 AF-BRF-001 | any value accepted (`z.custom`); absent = no brief. INV-BRIEF checks `SequenceBriefSchema` (strict: text ≤ 8 000 characters, platform a delivery target id (`isDeliveryTargetId`), target length 1…36 000 s, aspect one of `DELIVERY_ASPECTS`; optional fields may be null). `readSequenceBrief` reads the readable parts (canonical: no null fields, an empty brief reads as none). Written only by `sequence.setBrief` (given fields replace, null clears one, `brief: null` removes it), one undo step; `sequence.duplicate` copies it | `repair-brief` (`repairSequenceBrief`): the text kept (cut to 8 000 characters on a code point), each readable field kept, unknown keys and bad values dropped; removed when nothing readable is left. Idempotent |
| `ProjectDocument.agentNotes` (`{entries: [{id, at, author, text}]}`) | spec 18 AF-BRF-002 | any value accepted (`z.custom`); absent = none. INV-AGENT-NOTES checks `ProjectAgentNotesSchema` (strict: ≤ 500 entries, unique `agn_…` ids, `at` an ISO time, author 1…64 and text 1…4 000 characters, neither blank). `readAgentNotes` reads the readable entries. Written by `project.addAgentNote` (signed with the agent of the transaction; 500 → `E_LIMIT`) and `project.removeAgentNote` (approval-gated for agents, `APPROVAL_COMMANDS`), one undo step each | `repair-agent-notes` (`repairAgentNotes`): entries without text or a valid time dropped; unknown keys dropped; long texts and authors cut; a blank author read as "agent"; a malformed or repeated id replaced by a fresh one no entry uses; the newest 500 kept; removed when nothing is left. Idempotent |

### Fields added in v12

Title Looks (spec 19 §4, [wp-notes/title-looks.md](wp-notes/title-looks.md)); v11 builds open v12 files read-only (the v12
bump above). All are read leniently: an invalid value loads, repairs conservatively and reports it; it never stops a project
opening (TL-020).

| Field | Since | Read leniently | Repair |
|---|---|---|---|
| `EffectInstance.appearance` (`{v: 1, lookId?, lookOverrides?, colorwayId?, palette, light, seed, layers, font?}`), on a `jasper.title-look` instance | spec 19 TL-010, TL-011 | any value accepted (`z.custom`); absent on every other effect. `AppearanceSchema` plus the layer catalogue: at most 24 layers, 32 stops per gradient, 64 KB, ids `apl_…` unique inside the appearance, known layer types, params of the type's specs with values in range. INV-APPEARANCE reports what fails, a look on a track or the master, on a clip kind other than text, shape, still, solid or video, a second look on a clip, and `appearance` on another effect. `lookId` naming a look that is gone reads as not linked. Every Animatable is walked by the generic key checks (INV-011, INV-001). Written by the `look.*` and `appearance.*` commands; `param.set`, `keyframe.*` and `expression.*` reach numbers and palette colours at `["appearance", fxId, layerId \| "palette" \| "light", name]` | `sanitizeAppearances` runs first in `loadProject` and `repairDocument`, before anything walks the document (`repairAppearance`): unknown keys, bad values and keys dropped or clamped (`repair-appearance`), unknown layer types and layers over the limits removed from the bottom of the stack (`drop-appearance-layer`), repeated or malformed layer ids replaced. Nothing readable left, or a newer `v`: the instance goes (`drop-look`) and the clip shows its own picture. A look that is gone unlinks the clip, which keeps its values (`unlink-look`; `loadProject` runs this for that soft problem alone, `titleLooksNeedRepair`). Idempotent |
| `AppearanceLayer.fixedColor` (boolean) and the typography of `Appearance.font` (`weight`, `italic`, `trackingEm`, `fallback`, `ja`) | spec 19 TL-051, TL-053 | part of the appearance above, optional, shipped in v12. A fixed layer reads no role and a generator keeps its own colours. `font` is read when a look is applied, then not again | a `fixedColor` that is not `true` is dropped; unreadable font settings are removed and the family stays (`repair-appearance`). Idempotent |
| `ProjectDocument.titleLooks` (`{[tlk_…]: {id, name, tags?, category?, sourceId?, colorways?, quickControls?, appearance}}`) | spec 19 TL-015 | any value accepted (`z.custom`); absent = none. Copied in on first use from the library, never read from it again. At most 1 000 entries, key = id, an appearance as above (`titleLooksOf` / `titleLookOf` read only the readable ones). Keyframes stay on clips: `look.create` stores values | `repairTitleLooks`: `drop-title-looks` (not a record), `drop-title-look` (unreadable, over the limit), `fix-id` (malformed key or id), the appearance through `repairAppearance`. Idempotent |
| `threeD.material.pbr`, `threeD.geometry.{surfaces, bands, inflate, backplates}` on a clip | spec 19 TL-070 to TL-074 | any value accepted (`z.custom`); absent = Material Options and Bevel Style, as before. INV-012 checks them (`threeDProblem`): surfaces as `SurfaceMaterialSchema`, at most 6 bands and 3 plates with unique ids, 16 ramp stops, 16 curve points. Numbers are Animatables, walked by the generic key checks. Written by `threeD.*`, keyed at `["clip", id, "threeD", "surface" \| "band" \| "plate", …]` | `sanitizeThreeD` runs first in `loadProject` and `repairDocument`: unreadable surface values reset to defaults (`repair-3d-surface`), unreadable surfaces removed (`drop-3d-surface`), bad or excess bands and plates removed (`drop-3d-band`, `drop-3d-plate`), bad inflate options removed, back to extrusion (`drop-3d-inflate`). Idempotent |
| `threeD.geometry.{mode, bevelPosition}` | spec 19 TL-072, TL-070 | enums, strict; absent = `extrude`, `inside` | none needed |
| `Sequence.threeD.{toneMapping, exposure, glint}` | spec 19 TL-076, TL-077 | strict; absent = `none`, 0 stops, no glint. Keys in sequence time at `["scene3d", sequenceId, prop]` | none needed |
| `LightData.environmentPreset`; media kind `hdri` | spec 19 TL-075 | strict enum; absent = `studio`. `hdri` media are Radiance files: `environmentMediaId` may name one, a clip may not. Environment media in use count as ever (`clipParamMediaIds`) | `reset-environment` as for any environment media |
| `Sequence.settings.globalLight` (`{angle, altitude}`, Animatables in sequence time) | spec 19 TL-017 | any value accepted (`z.custom`); absent = looks that follow it use their own light. INV-APPEARANCE checks `GlobalLightSchema`. Written by `sequence.setGlobalLight`, keyed at `["globalLight", sequenceId, prop]` | `repair-global-light` removes an unreadable value. Idempotent |
| `TextContent.writingMode` (`'horizontal'`, `'vertical'`), on text clips and Source Text keys | spec 19 TL-111, [wp-notes/title-looks.md](wp-notes/title-looks.md) "Text" | any value accepted (`z.custom`); absent = horizontal, and anything but `'vertical'` reads as horizontal (`isVerticalText`). INV-012 reports an unknown value (`textWritingIssues`). Written by `clip.addText` and `clip.update` (`horizontal` removes the field). `clip.update` refuses vertical text on a path and `text.setPathOptions` refuses a path on vertical text, `E_INVALID_PARAM` | `repair-text-writing` removes an unknown value. Idempotent |
| `TextContent.tateChuYoko` (boolean) | spec 19 TL-111 | any value accepted (`z.custom`); absent = on, read only for vertical text (`tateChuYokoRanges`: 1 to 3 half-width characters between other characters or paragraph edges). INV-012 reports a non-boolean | `repair-text-writing` removes it. Idempotent |
| `TextContent.runs[].finish` (a finish id) | spec 19 TL-093 | any value accepted (`z.custom`); absent = the look's own finish. Commands take 1 to 64 characters. An id that is not in the catalogue draws the layer's finish. INV-012 reports a non-string | `repair-text-writing` removes it. Idempotent |
| `TitleLook.quickControls` (`[{label, layerType, nth?, param}]`, at most 6) | spec 19 TL-089 | unreadable ones read as absent (`.catch`), and the header then offers the layers' primary values. They name a layer by type and position, so no ids are stored | dropped on read, never reported: nothing in the document depends on them |
| `params.lookIntensity` of a `jasper.title-look` instance (Animatable, percent) | spec 19 TL-089 | an ordinary effect param; absent = 100, the default every instance reads, so stored looks draw unchanged | none needed |
| Clipboard payload `titleLooks` (not the project) | spec 19 TL-015 | optional array, each entry checked at paste (`titleLookProblem`). Older payloads have none: a pasted look then only unlinks | an unreadable entry is ignored and the clip keeps its values |
| User look library `<appdir>/presets/title-looks.json` (not the project) | spec 19 TL-054 | `jasper-title-look-library` version 1. Entries through `parseUserLook`; a newer file is read-only, an unreadable one moves aside | entries that no longer validate are kept in `invalid` and written back |

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
- **Losing the lease** ends saving and journalling in that window ("Editing was taken over…" banner). Only another
  session holding the project does that: a heartbeat that fails with an engine error or a timeout leaves the lease
  as it was (the next heartbeat confirms it), and a lease the engine forgot (restart, expiry while the tab was
  throttled) is re-acquired and used under its new id, by the journal and the agent relay alike. A window whose
  lease is lost refuses agent transactions (`E_NOT_OWNER`) and stops announcing a lease on WS /agent; the engine
  relays a transaction only to the window of the session that holds the project's lease
  (`AgentService.relayTarget`), so an edit acknowledged to an agent is one the window can save.
- **Opening takes the lease first, then reads the project** (`EditorSession.open`). The engine grants a lease under
  the project's save lock (`ProjectStoreFs.acquireLease`), and a headless agent write checks for a lease under that
  lock right before it writes (`save(…, {unleased: true})`; refused `E_NO_SESSION`, retryable, once an editor holds
  it). So a headless write either is on disk before the window reads the project or never lands: a window does not
  open on a revision that a racing write then supersedes (which made its first autosave a conflict while agent edits
  kept being acknowledged).
- **What an agent sees.** While a window cannot save, agent transactions it would apply are refused instead of
  acknowledged: a lost lease with `E_NOT_OWNER`, a revision conflict (autosave paused until the user picks Reload or
  Overwrite in the banner) with `E_SAVE_CONFLICT`, whose message names that step; `history.undo/redo` too. A failing
  save (engine error, retried every 10 s, the edits journalled) does not refuse. Relayed transaction and query answers
  carry `persistence: {state, savedRevision}` (`AgentPersistenceSchema`): `saved`, `pending`, `save-failing`,
  `paused-conflict`, `lease-lost` or `read-only`, and the revision on disk; headless answers are `saved` at their
  revision. jasper-mcp shows them as `savedRevision` and `persistence` in `get_project` and transaction results; judge
  by `persistence`, as an Overwrite saves at the engine's next revision, which can be above the live one. File ▸ Save
  run by an agent (`ui` command `file.save`) fails when it wrote nothing: `E_SAVE_CONFLICT` during a conflict,
  `E_NOT_OWNER` without the lease, `E_INTERNAL` when the save failed.
- **Closing a session** (`EditorSession.close`) first finishes its persistence (the last save and, if that fails,
  the journal write) and only then releases the lease, whichever of the two the app tears down first.

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
recovery as an undoable step, Revert, close order), `packages/session/test/persistence/engine-store.test.ts`
(leases: transient heartbeat errors, journalling under a re-acquired lease, a lost window refusing agent edits),
`apps/web/test/agent-bridge.test.ts` and `apps/engine/test/agent.test.ts` (relay only to the lease holder, a
headless write racing a lease grant, conflict refusals and `persistence` in relay answers), `apps/web/test/agent-ui.test.ts`
(`file.save` during a conflict), `apps/mcp/test/persistence.test.ts`,
`apps/web/test/project-files.test.tsx` (actions and dialogs).

Known limits: a journal write that fails is reported only on the console (`[recovery] journal write failed`);
edits made in the last ~1 s before a reload or tab close can be lost when the browser skips the "unsaved changes"
prompt (`beforeunload`, shown only after the user interacted with the page) and neither the save nor the journal
request completes during unload (neither is a keepalive request: project bodies exceed its 64 KB limit).
A heartbeat that re-acquires a lease the engine forgot (restart, expiry) does not re-read the project: a headless
write that landed in the gap still surfaces as a conflict at the next autosave (agent edits are refused from then
on). `PUT /api/projects/:pid` (If-Match only; an agent needs the user's approval for it) is not lease-checked:
a window it supersedes finds out at its next save, as a conflict.

## Newer files

A file whose `schemaVersion` is newer than this build supports opens **read-only** with the banner "Created with
a newer JasperEditor — the project is open read-only and will not be changed" (MIG-003). It is never migrated
down, and the engine stores a newer document verbatim. Update JasperEditor to edit it.
