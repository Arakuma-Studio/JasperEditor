# edit-structure — nested sequences, adjustment layers, groups, sequence operations, synthetics, through edits, frame holds

Workstream `edit-structure` of the parity program. Everything here is undoable document commands
(`packages/project`), drawn by the compositions (Player, stills, Remotion exports) and by the native export, with UI,
MCP tools and tests. Ported code: `licenses/ported/edit-structure.md` (FilmCraft, MIT OR Apache-2.0).

## 1. Model (schema additions, all optional, no version bump)

| Field / kind | Where | Meaning |
|---|---|---|
| `Clip.frameHold?: {flicks, holdFilters?}` | every clip kind with a picture (not adjustment, captions, audio) | The clip shows content time `flicks` for its whole duration. `holdFilters` also evaluates Motion, Opacity and effect keyframes at the held time (Premiere "Hold Filters"); otherwise they keep animating. |
| `Transition.freezeHandles?: true` | video transitions | Freeze-frame handles (S01:TRN-003 `handles: 'freeze'`): the span keeps its length when the media is short; the missing handle frames repeat the clips' edge frames. |
| clip kind `synthetic-audio` `{syntheticId, gainDb, volumeDb, pan, effects}` | audio tracks | The sound of Bars and Tone (tone) and the Universal Counting Leader (cue blips), linked to the `solid` picture clip. |
| `SessionToggles.insertSequencesAsNests` (default on), `showThroughEdits` (default on) | session only | Premiere's timeline toggle and Sequence ▸ Show Through Edits. Agents see both in `preferences.get` → `timeline`. |

Existing kinds now implemented: `nest-video`, `nest-audio`, `adjustment`; synthetic sources `color-matte`,
`black-video`, `transparent`, `adjustment`, `bars-and-tone {toneHz, toneDb}`, `counting-leader {style}`.

**The nest model** (for the interchange and multicam workstreams; `packages/project/src/structure/nest.ts`):

- A nested sequence is an ordinary `Sequence` with its own project item, shown in another sequence by `nest-video`
  (picture) and `nest-audio` (sound) clips whose `sequenceId` names it. A video + audio nest clip of one placement
  share a link group. The nesting graph is acyclic (INV-009: commands refuse with `E_CYCLE`; `repairDocument` drops a
  nest clip that closes a cycle).
- Content time of a nest clip is the nested sequence's time in flicks (`sourceIn`, speed, reverse, frame hold as for
  media). Nested frame `n` is content time `n · flicksPerFrame(nested rate)`. The nested In/Out are ignored for
  playback; its bound is the nested duration (last clip end, `contentDurationFlicks`). The nested In/Out choose the
  default range when a sequence is *placed*.
- The intrinsic box of a nest clip is the nested frame size; where the nested sequence has no clips it is
  transparent.
- `nestContentKey(doc, seqId)` = FNV-1a 64 of a canonical JSON of everything the nested sequence renders (settings,
  tracks' output/mute/solo/volume/pan/effects, master, clips without names/labels/clip markers/groups, transitions,
  links, the media it uses by engine key + fingerprint + duration + source range, synthetics, fonts, and recursively
  the keys of the sequences nested in it). Equal keys ⇒ identical pictures and sound — for render-segment caches
  (previews workstream). The render snapshot carries it in `source.nest.contentKey`.

## 2. Commands

| Command | Semantics |
|---|---|
| `clip.nest {clipIds, name?, ref?}` | Premiere Nest: moves the clips into a new sequence (parent settings and track layout, names, channel formats), keeping their ids, relative times, track indices, effects, keyframes, links, groups and the transitions among them; replaces them by a `nest-video` on the lowest video track index used (else the next free track at/above it) and a linked `nest-audio` on the lowest audio track index. Trackers whose target moved apart are unlinked (`W_TRACKING_UNLINKED`). Name default `Nested Sequence NN`; the item goes next to the parent's item. |
| `clip.unnest {clipIds}` | Replaces nest clips by copies of the clips they show (trimmed to the nest range, moved to timeline time, new ids, links/transitions/tracker links re-created inside the set, the nest clip's effects appended to each clip — `W_EFFECTS_DISTRIBUTED`, its gain added for audio), on free tracks from the nest clip's track up. Refused for speed ≠ 100 %, reverse, frame hold, Motion/Opacity changes, non-Normal blend, pan, volume keyframes or a different frame size (no exact flattening; FilmCraft refuses the same set). Other frame rates are conformed (`W_CONFORMED`). |
| `clip.place {source: {sequenceId} \| {projectItemId: <sequence item>}, nest?}` | A sequence as linked nest clips (default) or, with `nest: false`, its individual clips (copies, tracks mapped from the targets, links/transitions kept) — Premiere's "Insert and overwrite sequences as nests or individual clips". |
| `clip.addAdjustment {at, duration, track, name?}` | An adjustment clip with its own `adjustment` synthetic source. |
| `clip.group / clip.ungroup` | Premiere Group (Ctrl+G): one group of every clip given and the members of their groups. `clip.move`, `clip.lift`, `clip.extract` move/delete whole groups (`groups: false` turns it off — the UI passes it, its selection already holds the groups); `clip.trim` on the group's outer edge (first In / last Out) trims every member at that edge (`group: false` = this clip only). |
| `sequence.duplicate {sequenceId, name?}` / `sequence.delete {sequenceId, force?}` | Deep copy with new ids (media shared; S01:SEQ-011) next to the original. Delete removes the sequence and item; nest clips of it elsewhere refuse with `E_IN_USE` unless `force` (they are removed). Approval-gated for agents (`APPROVAL_COMMANDS`). |
| `media.removeUnused {kinds?}` | Premiere Remove Unused: media items nothing uses (clips, effect/transition params, master/track effects, transcripts, fonts, processed versions) and unused synthetic items. Approval-gated. |
| `synthetic.create {kind, params?, name?, binId?}` / `synthetic.update {syntheticId, params}` | Validated params with defaults (`structure/synthetic.ts`); an update changes every clip that uses the source. |
| `clip.addFrameHold {at, clipIds? \| tracks?}` | Splits each clip under `at` and holds the frame shown there to the end (no clips given: the topmost unlocked video clip). |
| `clip.insertFrameHoldSegment {clipId, at, duration?}` | Splits at `at` and inserts a segment holding that frame (default 2 s), rippling the track and sync-locked tracks. |
| `clip.frameHoldOptions {clipIds, enabled?, holdOn?, at?, sourceTime?, holdFilters?}` | Hold on `in`, `out`, `sequence-time` / `playhead` (with `at`), `source-time` (`sourceTime`, Premiere "Source Timecode"); `enabled: false` removes. |
| `sequence.joinThroughEdits {clipIds?}` | Heals through edits on unlocked tracks (all, or those touching the clips); the left piece absorbs the right, keeps its own effects; markers merge; a transition on the cut is removed. |
| `sequence.makeSubsequence {clipIds? \| tracks?, from?, to?, name?}` | New sequence with copies trimmed to the range (default In/Out), links/groups/transitions inside kept; name `<sequence>_Sub_NN`. |
| `transition.add/update/applyDefault {handles: 'freeze'}` | Freeze-frame handles (previously `E_NOT_IMPLEMENTED`); `W_TRANSITION_FREEZE_FRAMES`. |

Invariants: `INV-005` for nests (nested duration), frame holds (only the held frame must exist), `INV-006` synthetic ↔
clip-kind compatibility, `INV-012` frame hold validity. `repairDocument`: cycles, invalid holds, nest clips of missing
sequences.

## 3. Rendering

**Snapshot** (`render/snapshot.ts`). `nest-video` → `source.nest = {sequenceId, snapshot, nestedFps, contentKey}`: the
nested snapshot built recursively (cycle/depth guard, `NEST_UNAVAILABLE` warning) over exactly the nested frames the
clip shows, conformed to the parent rate (`conformSequenceRate`: frame-based timing remapped, content times kept),
with a transparent background; its media and fonts join the parent's tables. `nest-audio` → the nested audio clips
flattened into the parent's `audioClips` (`flattenNestAudio`): content time and rate composed (speed, reverse,
trims), the nested track fader, master and fades plus the nest clip's gain, volume and fades composed into
`nestGain` runs (dB per frame); the outer track fader/master apply as usual; the nest clip's effects follow each
piece's (exact for linear effects). `solid` of bars/leader → `source.generator`; `synthetic-audio` →
`audioClip.generator` with `mediaId: syn:<id>`. `adjustment` → `source: {adjustment: true}`; adjustment clips have
no transition handles; a transition on one is drawn as the adjustment fading in/out over the span (GPU transitions
included, warning `ADJUSTMENT_TRANSITION`). Frame holds: `frameHold` on the render clip; `clipPictureTime` = held
time, `clipContentTime` = held only with Hold Filters. Freeze handles: `freezeHead/freezeTail` on the render clip.

**Compositions** (Player, stills, Remotion exports).
- `VideoTracks` (from `SequenceComposition`) draws a doc's tracks; the background is its first layer, so adjustment
  layers process it (as Premiere's composite).
- `NestLayer` draws `VideoTracks` of the nested snapshot (through `NestTracksContext`, no import cycle) inside the
  layer box: a shifted `<Sequence>` at 100 % forward speed (smooth playback), otherwise `ShowFrame` at the nested
  frame. `ShowFrame` (Freeze at the current frame + a shifted Sequence) replaces `<Freeze frame>` for holds and
  nests: Remotion clamps a frozen absolute frame to the composition range, which showed wrong frames in 1-frame
  stills and for nested frames beyond the parent's length. Nest clips with colour effects run their whole stack in
  the canvas chain (`chain` option of `useLayerFx`) through HTML-in-Canvas.
- `AdjustmentScope` wraps the tracks below each track with adjustment clips (stable DOM). `css` mode when every
  adjustment clip on the track is exact as a CSS/SVG filter (filter effects, 100 %, Normal, no crop): the filter on
  the scope element. `canvas` mode otherwise: `<HtmlInCanvas>` with the chain `stash` → effects (shader passes,
  colour LUT runs, CSS filters, flips) → `mix`: inside the crop region `original + (blend(original, adjusted) −
  original) · opacity × fades` in premultiplied space — the adjusted composite *replaces* the original (Premiere: a
  blur on an adjustment layer darkens the frame edges unless Repeat Edge Pixels; EffectCraft mixes the same way),
  it is not composited over it. Renders always have HTML-in-Canvas; a Player without it
  shows the composite unadjusted with a chip; a render that cannot run it fails (never a different picture).
- `GeneratorLayer` draws bars / leader from `renderBars` / `renderCountingLeader` on a canvas, then the normal
  pipeline (shader effects through `FxPicture`, colour stage, CSS effects, Motion, opacity).
- `AudioLayer`: `nestGain` multiplies the volume; generator sounds play a WAV generated in the page
  (`syntheticSamples` → `encodeWavStereo16` → blob URL, content time 0 = file time 0).
- `pictureLocalFrame` maps holds and freeze handles to the frame whose picture is shown.

**Native export** (`apps/engine/src/export`).
- Nests are drawn in the same filtergraph: `drawStack` composites any snapshot (the sequence, or a nested one with a
  transparent background and its own size); a nest clip's source is its nested stack (`layerSourceChain`), mapped to
  layer frames exactly as the composition does (`trim` to the first nested frame, `settb=AVTB`, a `setpts` putting
  nested frame `i` at the first output slot that shows it, `fps … round=up`), or one frame looped for a hold. The
  clip then gets its effects, Motion, opacity, fades like any layer. Extensions are prepared per nested snapshot
  (`prepareNestedExtensions`, keyed by nest path) so baked text, warped layers, GPU transition spans inside nests
  work; fframes masters are collected recursively. The planner classifies nested clips and transitions with the
  sequence's own (`allVisualClips`, `allVideoTracks`): anything Remotion-only inside a nest makes the path
  hybrid/Remotion, never dropped. Limit: a nest clip drawn sub-pixel or corner-pinned (its own decoder process)
  that contains sub-pixel layers is a native blocker (Remotion path).
- Adjustment layers: `[last]split` — one branch continues, the other is the adjustment layer's source (trimmed to
  its range); its effects (built-ins, extension filters incl. colour LUTs), then `premultiply` + alpha 1 (the result
  replaces the composite, as in the preview), the crop (transparency = outside the region), opacity and fades, then
  `overlay` back (= the premultiplied lerp of the preview). Blend modes other than Normal route to Remotion like any layer.
- Frame holds (video, animated image, motion-graphic masters, layer overrides): seek to the held time, one frame
  looped. Freeze handles: the source is built for the real frames, then `tpad … clone`.
- Synthetics (`synthetic.ts` extension, always registered): bars → PNG (`still` layer override), leader → PNG-in-MOV
  of the content frames the clip shows (`contentOrigin` layer override: sourceIn, speed, holds work), tone/blips →
  WAV registered as local media `syn:<id>`. Same pixels/samples as the Player.
- Nested audio: flattened pieces; `nestGain` folded into the per-frame volume expression.
- Remotion path: nested snapshots are adapted recursively by `adaptRemotionDoc` extensions (graded DOM layers inside
  nests get their baked masters).

## 4. UI

- Clip menu: Group / Ungroup, Nest… (Nested Sequence Name dialog), Unnest, Video Options ▸ Frame Hold Options… /
  Add Frame Hold / Insert Frame Hold Segment. Timeline clip context menu: the same + Reveal Nested Sequence, Make
  Subsequence, Join Through Edits. Transition context menu: Repeat Frames for Short Media (freeze handles; the
  transition shows a warning stripe and the tooltip says "contains repeated frames").
- Sequence menu: Reveal Nested Sequence (Ctrl+Shift+F), Go to Gap ▸ Next/Previous in Sequence/Track, Make
  Subsequence (Shift+U), Show Through Edits, Insert and Overwrite Sequences as Nests. Match Frame (F) resolves
  through nests to the source media clip and opens it in the Source monitor at that frame; Reverse Match Frame
  (Shift+R) finds the Source frame in the sequence, also inside nests.
- Edit ▸ Remove Unused; File ▸ New ▸ Adjustment Layer, Bars and Tone, Black Video, Color Matte…, Transparent Video,
  Universal Counting Leader…; the Project panel's New Item menu has the same; its context menu Duplicate (sequences),
  Color Picker… / Universal Counting Leader Setup…, Remove Unused. Double-clicking a Color Matte opens its Color
  Picker.
- Timeline: double-click a nest clip opens the nested sequence at that frame; through edits are marked with a bow tie
  at the cut; dropping a sequence item places nests or individual clips (toggle); Alt-click selects one clip of a
  group; dragging a group's outer edge trims every member there.
- Source monitor: sequences (drawn by the sequence composition, marks = the sequence's In/Out) and synthetic sources
  (a scratch sequence of the active sequence's size and rate) open, play and edit in with Insert/Overwrite.

## 5. Agents (MCP, `apps/mcp/src/tools/structure.ts`)

`nest_clips` `unnest_clips` `place_sequence` `list_nests` `add_adjustment_layer` `group_clips` `ungroup_clips`
`duplicate_sequence` `delete_sequence` (approval) `remove_unused_media` (approval) `create_synthetic`
`update_synthetic` `list_through_edits` `join_through_edits` `find_gaps` `make_subsequence` `add_frame_hold`
`insert_frame_hold_segment` `frame_hold_options`; guide text `STRUCTURE_GUIDE`. Every command is also available via
`describe_commands` / `apply_commands`.

## 6. Verified behaviour (tests)

- `packages/project/test/edit-structure.test.ts` (33): nest/unnest round trip, placing sequences (nest/individual,
  In/Out, item drag, empty, trims bounded by the nested duration), snapshot of nests (nested range, transparent
  background, content key, flattened audio with composed gain, speed and rate conform), adjustment, groups (move,
  outer-edge trim, delete), duplicate/delete (E_IN_USE / force), Remove Unused, synthetics (defaults, A/V placement,
  lengths 1 s / 11 s, validation), bars pixel layout, leader phases/blips, tone level, WAV, frame holds (all three
  commands), through edits (speed + reverse), gaps, subsequence, freeze handles, repair of cycles, content keys,
  Track Matte Keys across nest / duplicate / subsequence / place-individually, Unnest refusing masked nests.
- `packages/compositions/test/edit-structure.test.tsx`: nested frame drawn (incl. 2× speed), CSS / canvas adjustment
  scopes, generator canvas, `pictureLocalFrame`.
- `packages/compositions/test/edit-structure-render.e2e.test.ts` (REMOTION_E2E=1, headless Chrome): nest scaled 50 %
  and at 2×; adjustment with Black & White (canvas chain), 50 % + crop, Gaussian Blur (CSS); bars and leader pixels;
  frame hold of a moving video; an adjustment layer limited by an ellipse Opacity mask.
- `apps/engine/test/edit-structure-export.test.ts` (real ffmpeg, frame codes): nested frames at 1× and 2× speed,
  nested audio present/absent, nest Motion; adjustment with opacity + crop; frame hold; freeze handles (no black
  frames, right frame after the span); bars, −20 dBFS tone (±0.6 dB), leader sweep colours, the two-pop; a masked
  adjustment layer plans the Remotion path with a named blocker.
- `apps/web/test/edit-structure.test.ts`, `apps/mcp/test/structure.test.ts`, `e2e/edit-structure.spec.ts` (built
  app: Nest dialog, double-click into the nest, New Item, Group, Add Frame Hold, native export checked with ffmpeg).

## 7. Adobe fidelity (research, brief §3b) and sources

- Synthetics ("Create special clips (synthetics)", helpx.adobe.com/premiere-pro/using/creating-special-clips-synthetics.html):
  Bars and Tone is "a one-second clip containing color bars and a 1-kHz tone"; HD bars "comply with ARIB STD-B28";
  the leader "is 11 seconds long" with Wipe/Background/Line/Target/Numeral colours and Cue Blip on out / on 2 / at all
  second starts — all implemented with these names. Tone level: Adobe documents −12 dBFS as Premiere's default; we
  default to the SMPTE RP 155 / EBU R 68 alignment level −20 dBFS (the brief's requirement) and expose `toneDb`.
- HD bars layout: SMPTE RP 219-1 (16:9 pattern: 40 % grey side panels d = w/8, seven 75 % bars of 3w/28, 100 %
  cyan/white/75 % white/blue row, yellow/ramp/red row, PLUGE row with −2/0/+2/0/+4 %), full-range RGB values; −2 %
  clips to black in RGB.
- Leader timing (undocumented in detail): 2 s lead-in, numerals 8 → 2 one second each with a clockwise sweep, black
  to 11 s; the two-pop on the first frame of "2" (8 s). Chosen to match the SMPTE universal leader convention.
- Groups (helpx "Group and ungroup clips"; Adobe community answers): grouped clips select, move and delete
  together; Alt/Option-click selects one clip of a group; the group's outer edges trim the group. Implemented so.
- Nest ("Nest sequences"): Clip ▸ Nest… asks for "Nested Sequence Name"; the nested sequence uses the parent's
  settings; double-click opens it; Reveal Nested Sequence Ctrl+Shift+F (Premiere default); Make Subsequence Shift+U
  (Premiere default). Go to Gap has no default shortcut here: Shift+; / Ctrl+Shift+; are already Select Next/Previous
  Clip in this app's keymap (FilmCraft binds them to gaps; Premiere's own defaults vary by version).
- Frame Hold Options: Hold On ▸ Source Timecode / Sequence Time / In Point / Out Point / Playhead, Hold Filters
  (helpx "Frame hold"); Add Frame Hold and Insert Frame Hold Segment (2 s) as in Premiere.
- Freeze-frame handles: Premiere applies a transition over insufficient media with repeated frames and a warning
  stripe; the drop UI here keeps the existing "shorten with feedback" behaviour (transitions workstream) and offers
  Repeat Frames for Short Media per transition (and `handles: 'freeze'` for agents).
- Through edits: Premiere draws a small marker at through edits when Show Through Edits is on and joins them with
  Join Through Edits (left clip's attributes win) — FilmCraft semantics ported.

## 8. Comparison with the references

| Feature | FilmCraft / EffectCraft | Here |
|---|---|---|
| Nest | moves selection, linked nest clips | same + groups/transitions/tracker links preserved, naming, cycle refusal, unnest (FilmCraft flattens multicam only) |
| Nested rendering | CPU recursion, depth 8 | recursive in the browser (Player/Remotion) and in-graph natively, depth 16 + cycle detection, rate conform, exact frame mapping at any speed |
| Nested audio | sub-mix | flattened pieces with composed gain (exact for linear effects); native and Remotion |
| Adjustment layers | effects on canvas, opacity, Motion region | effects on composite (incl. GPU shaders, LUT runs), opacity, blend, crop region; preview, Remotion and native |
| Groups | flag only | selection, Alt single select, move, delete, outer-edge trim |
| Synthetics | bars, matte, black, transparent, leader (fixed colours, beep every second) | + leader colours and the three cue options, tone level, preview = export pixels |
| Through edits / gaps / subsequence | yes | same + timeline markers, MCP |
| Frame holds | yes | same + native and preview, Hold Filters |
| Content keys | `preview.rs` hash | `nestContentKey`, recursive |

## 9. Limits (honest)

- Audio effects on a `nest-audio` clip act on each flattened piece (exact for gain/EQ-like linear effects, not for
  compressors); audio pan and audio effects are Remotion-path/native limits shared with ordinary audio clips.
- Reverse playback of nests is a native blocker (as for every reversed clip); preview audio does not reverse (as for
  every audio clip).
- Adjustment layers have no Motion (the S01 model, KND-012); their crop limits the region.
- Masks (merged with the masks workstream): an adjustment layer's Opacity masks limit where it applies — the mix
  step uses their coverage, `lerp(original, adjusted, opacity × coverage)` (Premiere: masking an adjustment layer
  limits the adjustment, it does not cut the picture below); effect masks on its effects mix that effect alone. A
  masked adjustment layer or nest clip exports through Remotion (named native blocker), not natively. Masked
  (kernel-stream) layers inside a sub-pixel nest clip block the native path like other sub-pixel layers. Unnest
  refuses nest clips with masks (their geometry is in the nest's layer space). Nest, Unnest, placing clips
  individually, Make Subsequence and Duplicate move Track Matte Keys to the matching track of the new layout, and
  clear them with `W_TRACK_MATTE_CLEARED` when that track does not come along. Track mattes inside a nested
  sequence read that sequence's tracks (each nested stack has its own matte context).
- In a browser without HTML-in-Canvas the Player shows non-CSS adjustment layers and colour-graded nests unadjusted
  with a chip (the desktop app and renders have it).
