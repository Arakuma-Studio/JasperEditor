# edit-ux — editorial UX: trim mode, 3/4-point editing, J/L cuts, keyframe lanes, monitors, keyboard

Branch `feat/edit-ux`. Scope: keyboard trim mode and the Trim Monitor; three- and four-point editing with
backtiming, Fit Clip, source patching, sequences as sources and split edits; J/L-cut correctness of ripple edits;
missing editorial commands and dialogs (Speed/Duration, Match Frame, Linked Selection, subclips, Alt-drag/slide,
spring-loaded tools); Program/Source monitor features (comparison view, rulers and guides, dropped frames, full
screen, Button Editor, marquee); the Keyboard Shortcuts editor with layouts; Premiere keyboard parity; keyframe
lanes, rubber bands and fade handles on timeline clips; MCP tools.

## 1. Model and commands (`packages/project`)

| Command | What |
|---|---|
| `clip.sourceEdit` | Insert/Overwrite from a source (project item: media, subclip, synthetic, sequence; or media/sequence id). Any three of source In/Out and sequence In/Out (absent = the marks, `null` = ignore a mark); the **sequence In wins over the playhead**; a sequence Out alone **backtimes**; source Out + sequence In/Out backtimes the source In. Four points with different durations need `fit`: `change-speed` (fit to fill: the clip speed = source length / sequence length, 1 %–10000 %), `ignore-source-in`, `ignore-source-out`, `ignore-sequence-in`, `ignore-sequence-out` (Premiere's Fit Clip dialog). `split` (or the item's Mark Split marks) gives video and audio their own source ranges: each lands offset by its In's difference from the earliest In (J/L cut). `patch` maps source V1/A1… to tracks or `null` (off). Sequences go in through edit-structure's `placeSequence` as one nest (default) or as individual clips (`sequenceAs`). Returns the clip ids, where it landed, its speed and its end. |
| `clip.trimEdits` | Keyboard trim of several edit points as one edit: each `{clipId, edge, mode: regular \| ripple \| roll}`, one per track. Regular edges trim, ripple edges ripple as one group (`rippleTrimGroup`), rolls roll; link partners at the same edge follow (unless one is itself a selected point). Every point moves by the most restrictive delta (media handles, neighbours, subclip limits, sync locks); `clampToSyncLock` stops at the sync-lock limit instead of refusing (dynamic trimming). |
| `item.makeSubclip`, `item.updateSubclip` | Subclip project items (`kind: 'subclip'`: media id, parent item, content range, `restrictTrims`, its own marks). Usable in the Source monitor, `clip.place {projectItemId}`, `clip.sourceEdit`. Clips placed from a restricting subclip carry `subclipId` and cannot be trimmed, slipped or rolled past the range. Editing a restricting subclip so a placed clip would fall outside is refused. Deleting the subclip keeps its clips (they lose `subclipId`); deleting the parent keeps the subclip (its `parentItemId` becomes null). |
| `item.setMarks {split}` | Mark Split ▸ Video In/Out, Audio In/Out on media and subclip items. |
| `clip.slide {linked}` | Alt+slide ignores links. |

Schema (additive, optional, no version bump): `SubclipItemSchema` in the project item union, `SourceMarks.split`,
`Clip.subclipId`. Invariants: subclip references and range (INV-005/006), `subclipId` references (INV-006),
INV-014 counts subclip media as used; `repairDocument` clears dangling `parentItemId` and `subclipId`.

Pure helpers: `packages/project/src/edit/match-frame.ts` (`resolveMatchFrame`, `matchFrame`, `reverseMatchFrame`,
`projectItemOfClip`: through nests, multi-camera clips through their active angle, frame holds, subclips — the
single implementation behind the UI's F / Shift+R (edit-structure's commands delegate to it) and the MCP tools);
`edit/trim-mode.ts` (edit point frames, roll pairs, trim sides, Select Nearest Edit Point, Toggle Trim Type order).

### J/L-cut correctness (`commands/ripple.ts`)

Before: a ripple trim ahead of a J cut split the early sound (lengthening) or was refused as a sync-lock conflict
(shortening); ripple delete of a clip whose sound edge was split closed two gaps (later clips moved twice) or was
refused; a ripple speed change of a linked group with a split edit moved later material once per member. Now
(ported from FilmCraft `ripple_trim_group`, `ripple_delete_spans`, `set_speed_group`):

- `rippleTrimGroup`: the group's members change by the same delta; later material on their tracks shifts; sync-locked
  tracks get the primary member's insert (straddling clips split) or removal (must be empty). A clip on a rippling
  track that straddles the edit and is linked to a later clip that shifts (a J-cut sound) **moves with its
  picture**; it is refused (`E_SYNC_CONFLICT`) when it has no room (sequence start, a clip before it), or clamped
  with `clampToSyncLock` (binary search for the largest allowed amount).
- `clip.extract` closes the time the deleted clips free on every track that loses one (FilmCraft
  `ripple_delete_spans`), once; refused when nothing can close.
- `clip.setSpeed {ripple: true}` groups linked members: later material moves once, by the largest change.
- `contentWindow` / `trimLimits` / `contentHandles` are shared by trim, roll, slip, slide and speed: media length,
  composition length, nested sequence length, frame holds (edit-structure: unbounded) and subclip limits.

### Overlays across ripple edits (`commands/overlay-ripple.ts`)

Before: a ripple on one track gave every sync-locked track the same insert or removal, razoring whatever spanned the
edit. On a real cut (`range.extract` / Clean Up cuts and ripple trims on V1, sync-locked V2) six of seventeen
363-frame day cards — text clips that pop in, shrink to a corner and pop out at their end — broke into pieces with
gaps and lost their shrink keyframes; a ripple trim shortening under a card was refused (`E_SYNC_CONFLICT`). Now a
**generated overlay** (`text` other than subtitles, `solid`, `adjustment`, `shape`, `motion-graphic`, `camera`,
`light`: no media frames tied to the time) that spans a ripple on a track the edit does not name stays one clip:

- **Default: refit as a whole.** A removal that overlaps it shortens it by the overlapped frames; an insert inside it
  lengthens it. It starts where it started (or at the cut, when it started inside the removed time). The frames are
  taken from / added to a **still stretch** — where every keyframed property holds one value (equal values on a
  straight path; Hold segments) — so the animation before that stretch stays relative to the clip's start and the
  one after it relative to its end: the cut's own place when it is still, else the longest still stretch (as near
  the cut as it fits). Without a still stretch long enough every key time scales with the duration. Keys landing on
  one time merge (the first key's incoming side, the last key's outgoing side). Clip markers move the same way;
  transitions on the clip are shortened to fit (`W_TRANSITION_SHORTENED`).
- One `W_OVERLAY_FITTED` warning names each refitted clip and its frames (e.g. `clp_… (−30 frames)`).
- A removal that covers the whole overlay removes it with the range (`range.extract`, `clip.extract {syncConflict:
  "cut"}`, Clean Up), and a ripple trim that would remove it is refused as before (`E_SYNC_CONFLICT`).
- Covered edits: `range.extract` (overlays on every track the command's `tracks` does not list; with no `tracks`,
  every track — so `transcript.extract` and the transcript tools keep them), `clip.extract` (sync-locked tracks),
  ripple trims (`clip.trim {mode: "ripple"}`, `clip.trimEdits`, the timeline's ripple gestures: non-member tracks)
  and the one-pass cuts of `cleanup.apply`, `transcript.removeFillers` and the other transcript removals
  (`cutRanges`). A track listed in `range.extract {tracks}` is cut as before, overlays included.
- Not overlays: media-backed clips (video, audio, stills, animated images, 3D models), nests and compositions
  (their content has its own timeline, like footage), and subtitle text clips (their words belong to the time).

Why this default (assumption, not a documented Premiere behaviour): Premiere's sync lock razors every clip on a
sync-locked track, which is what broke the cards. Final Cut Pro keeps connected clips (titles, generators) whole and
moves them with the storyline clip they are attached to, keeping their duration (Apple's Final Cut Pro User Guide on
connected clips; from prior knowledge, not fetched for this change). Keeping the overlay's duration
would leave its end animation late against the material it was cut to, so the overlay is refitted instead and its
animations are preserved at both ends. Skipping overlays with a warning was the alternative; it leaves them over the
wrong material.

No per-track "protect from ripple" option was added: it would be a new stored track field (a schema bump with
migration, fixture and compatibility tests, AGENTS §0) while other agents are changing the schema in parallel, and the
refit above already protects every overlay on every track; footage that must not move can keep using sync lock off.

## 2. Trim mode and the Trim Monitor (`apps/web`)

- **Selecting edit points**: click an edge (TL-547, Ctrl/Cmd adds), **Shift+T Trim Edit** (nearest cut on the
  targeted tracks as Roll; again cycles the type), Sequence ▸ Select Nearest Edit Point ▸ As Ripple In / Ripple Out
  / Roll / Trim In / Trim Out (unbound, as in Premiere), double-click an edit point opens the Trim Monitor.
- **Toggle Trim Type** Ctrl+T in the Timeline (macOS ⌃T; web fallback Ctrl+Alt+T because the browser keeps
  Ctrl+T): Ripple → Roll → Trim (Premiere's and FilmCraft's order; points that cannot roll skip Roll).
- **Trim keys**: Trim Backward/Forward Ctrl+←/→ (macOS ⌥←/→), Many (Large Trim Offset = 5) Ctrl+Shift+←/→
  (⌥⇧←/→) and, as the brief asks, also Ctrl+Alt+←/→ while edit points are selected (a *contextual* binding: the
  same chord slips clips when no edit point is selected). Repeated presses coalesce into one History entry.
- **Numeric entry**: keypad + / − (contextual over zoom) opens the Trim Monitor's field; type frames, Enter trims.
- **Extend Edit** E (to the playhead, keeps the trim type), **Extend Previous/Next Edit to Playhead** Shift+Q/W.
- **Trim Monitor** (Program monitor while trim mode is on and not playing): outgoing clip's last frame and
  incoming clip's first frame (each rendered alone through the Program pipeline, `FrameView`), track + clip name,
  timecode, Out/In shift counters (FilmCraft `TrimShift`: how far each side moved since the selection; a roll moves
  both), buttons −5 / −1 / Apply Default Transitions / +1 / +5 / Play Around, drag in the left image = ripple Out,
  right image = ripple In, the strip between = roll (4 px per frame), one History entry per drag.
- **Dynamic trimming**: in trim mode J/L trim instead of shuttling (L again doubles up to 8×, Shift = ¼×), the
  sequence updates live through a session gesture re-applied from the original document each tick (never
  cumulative), the Program follows the edit, a limit holds the trim; **K commits ONE undo step** ("Dynamic Rolling
  Edit" / "Dynamic Ripple Trim" / "Dynamic Trim"), Esc cancels with nothing recorded, any other command or a click
  commits first (FilmCraft semantics).
- **Play Around the Edit**: Space in trim mode loops preroll → postroll (2 s each, Premiere's defaults) until Space
  or K; trim keys keep the loop running.
- Edit point marks: Trim = red bracket, Ripple = yellow, Roll = red on both sides; points follow undo/redo.

## 3. Three/four-point editing UI

`,` / `.` and the Source monitor buttons run `clip.sourceEdit` with the item's marks (and split marks), the
sequence marks, the playhead and the **source patching**: a column left of each track header shows where source
V1/A1… go (click = off/on, click an empty cell = patch there, drag to repatch; default V1→V1, A1→A1 as in Premiere;
track targeting stays separate). A four-point mismatch opens **Fit Clip** (with "Always use this choice", reset by
"Ask Fit Clip Again"). Markers ▸ Mark Split ▸ Video/Audio In/Out (Source monitor) set split marks, drawn on the
Source mini ruler. Sequences and subclips open in the Source monitor (subclips show their range as In/Out).
Toggle All Video/Audio Targets Ctrl+0/9, Toggle All Source Video/Audio Ctrl+Alt+0/9.

## 4. Commands and dialogs

- **Clip Speed / Duration** (Ctrl+R, Clip menu, clip context menu): Speed %, Duration (chain-linked; unlinked
  changes the length at the same speed), Reverse Speed, Maintain Audio Pitch, Ripple Edit Shifting Trailing Clips;
  mixed values stay untouched. Time Interpolation (frame blending / optical flow) belongs to the `time` workstream.
- **Match Frame** F / **Reverse Match Frame** Shift+R (selected clip wins; subclips; through nests and multicam).
- **Linked Selection** `timeline.toggleLinkedSelection` (Sequence menu; the timeline toolbar button already existed).
- **Make Subclip** Ctrl+U (Project/Source panel scope and Clip menu; from the Source item's marks, a Project item or
  a timeline clip's source range) and **Edit Subclip** (Clip menu, Project context menu).
- **Alt-drag / Alt-slide**: Alt ignores links for moves (Premiere Alt-click), edge trims, slips and now slides.
- **Spring-loaded tools**: holding a tool key ≥ 250 ms uses the tool temporarily and returns to the previous tool
  on release (after the drag when one is running); a tap switches. (Premiere documents the behaviour, not the
  threshold; 250 ms is our choice.)
- **Clip volume** ] / [ (±1 dB), Shift+] / Shift+[ (±3 dB, Premiere's Large Volume Adjustment), keyed at the playhead
  when the level is animated; Go to Selected Clip Start/End Shift+Home/End; Play to Out Ctrl+Space; Play In to Out
  with Preroll/Postroll Shift+Space.

## 5. Monitors

- **Comparison View** (View menu, wrench, Button Editor): Side by Side, Vertical Split, Horizontal Split (drag the
  divider), Swap Sides; the reference is a frame of this or another sequence, stepped by edit points or set to the
  playhead. Generic for color-grade: `ComparisonLayout` lays out any two pictures; `ProgramComparison` takes
  `currentOptions` / `referenceOptions` (RenderOptions, e.g. `colorBypassClipIds` for "before"); state in
  `monitorExtras.comparison` / `setComparison` (`apps/web/src/panels/program/monitor-view.ts`).
- **Rulers and guides**: Show Rulers Ctrl+R, Show Guides Ctrl+;, Lock Guides Ctrl+Alt+Shift+R, Add Guide…, Clear
  Guides, Guide Templates ▸ Save Guides as Template… / Manage Guides… (built-ins Center Cross and Rule of Thirds,
  user templates persisted); drag a guide out of a ruler, move it, drop it outside the picture to delete it; guides
  are snap targets for transform moves. Guides are kept per sequence in local view state (not in the document).
- **Dropped Frame Indicator** (wrench): green/yellow dot, frames skipped during native playback counted from the
  Player's frame stream (a jump past the next frame), reset on play or click.
- **Toggle Full Screen** Ctrl+`: the focused monitor's picture through the Fullscreen API; transport keys work.
- **Button Editor** ("+" in both monitors): every available button (Mark In/Out/Clear, Go to In/Out, edits, Play,
  Play In to Out, Play Around, Loop, Lift/Extract, Insert/Overwrite, Match Frame, Trim Edit, Comparison View,
  Multi-Camera, Safe Margins, Rulers, Guides, Export Frame, Full Screen), click to add, drag to reorder, × to remove,
  Reset Layout; persisted per monitor. Buttons run with the shell's context focused on their monitor.
- **Marquee select** on empty Program canvas (Shift/Ctrl adds).

## 6. Keyframe lanes and rubber bands

On tracks at least 48 px tall (Premiere draws keyframes on expanded tracks; Expand/Minimize All Tracks, track
heights and the header double-click already existed) every clip shows a lane: Opacity on video clips, Level on
audio clips by default; the clip context menu **Show Clip Keyframes ▸** offers None and every animatable property
(Motion, Opacity, Volume/Pan, every effect parameter, mask feather/opacity/expansion/path), the track header menu
hides/shows a track's lanes. Number properties draw a rubber band; vectors, colours and paths show their keyframes.

- Selection tool: drag the band (static value, or the two keys of the segment), **Ctrl/Cmd-click** adds a keyframe
  on the band, drag a key (time and value; Shift locks an axis), click/Shift-click selects keys, **Delete** removes
  the selected keys (before clips). Pen tool: click the band adds a key, drag on the lane marquee-selects keys.
- **Fade handles** at the top corners of Opacity and Level lanes drag a fade in/out: a floor key (0 % / −∞ dB) at the
  clip edge and a key at the fade end holding the level the property had there; dragging back to 0 removes it.
- **Volume scale**: −∞ (−96 dB) at the bottom, +6 dB at the top (Premiere's clip band), amplitude-proportional in
  between (y ∝ √(a/a₊₆)), 0 dB at ≈ 71 % — readouts in dB. Undocumented by Adobe; chosen to look like Premiere's band.
- **Roving keys** (keyframes-blend) are drawn as dots and keep their derived times (drags change only their value);
  **expressions** flag the lane "= expression" / "(off)"; audio-mix's clip automation writes the same `volumeDb`
  keyframes, so written passes appear on the band and band edits feed the mixer.
- Every drag is one History entry (session gesture); a drag ending where it started records nothing.

## 7. Keyboard

- **One active keymap**: `getActiveKeymap()` / `setActiveKeymap()` in `commands/keymap-defaults.ts`; the dispatcher,
  monitor fallback, menus, tooltips, palette and Shortcut Reference all read it.
- **Contextual bindings** (`KeyBinding.contextual`): a chord shared on purpose in one scope; the first *enabled*
  command wins (trim keys over slip, Shift+D at edit points over Shift+D on clips, keypad ± numeric trim over zoom).
  The keymap test allows exactly those pairs and still fails every other duplicate.
- **Keyboard Shortcuts editor** (Edit ▸ Keyboard Shortcuts…, Ctrl+Alt+K): layout preset (Adobe Premiere Pro
  default, Avid Media Composer, Final Cut Pro 7, Final Cut Pro, custom layouts with Save As / Delete), search by name,
  id or key, commands grouped by scope, + adds a chord (press it), click a chord to change it, × removes, Clear /
  Reset per command, Undo. Conflicts: the other command in the same scope loses the chord (reported), commands of
  enclosing scopes are reported as shadowed, browser-reserved chords are refused in the web app. Editing a built-in
  layout creates the custom layout "Custom" (Premiere). Persisted in localStorage (`jasper:keymap:v1`, tolerant
  parse). Layout tables: `commands/keymap-presets.ts` (Avid and Final Cut Pro from FilmCraft, FCP 7 from Apple's
  FCP 7 manual). FCP 7's multi-press tool keys (RR, SS, BB) bind the first key only.

### Premiere keyboard parity audit (against FilmCraft `shortcut_presets.rs` PREMIERE/PREMIERE_PANEL and `docs/keyboard.md`)

Present (unchanged or added here): tools V A ⇧A B N R C Y U P H Z T; transport Space J K L ⇧J ⇧L ⇧K ← → ⇧← ⇧→ Home
End ↑ ↓ ⇧↑ ⇧↓, Play In to Out, **⇧Home/⇧End**, **Ctrl+Space**, **⇧Space**; marking I O X / ⇧I ⇧O and clears; lift ;
extract '; insert , overwrite .; markers M ⇧M Ctrl+⇧M clear; Add Edit Ctrl+K / Ctrl+⇧K; Q W Alt+Q Alt+W, **⇧Q ⇧W**,
E, **⇧T**, **Ctrl+T (⌃T)**, trim ±1/±5; nudge, slip, slide (one and five frames); Ctrl+D Ctrl+⇧D ⇧D; F ⇧R ⇧U
Ctrl+⇧F; S snap; = − \; track heights Ctrl± Alt±, ⇧= ⇧−; PageUp/Down; Ctrl+R speed, G gain, ⇧G channels, ⇧E enable,
Ctrl+L link, Ctrl+G group; **] [ ⇧] ⇧[** clip volume; **Ctrl+0/9, Ctrl+Alt+0/9** targets; Ctrl+U subclip; Ctrl+` full
screen; ` ⇧` maximize; panels ⇧1…⇧9; workspaces Alt+⇧0…9; Ctrl+Alt+K shortcuts; program Ctrl+R/Ctrl+;/Ctrl+⇧;/
Ctrl+Alt+⇧R; multi-camera 1…9, Ctrl+1…9, ⇧0 (wp-multicam); captions Ctrl+Alt+A/C (wp-captions); expressions
Alt+⇧= (expressions); audio scrub ⇧S (audio-mix).

Deliberate skips / differences:

| Premiere | Why |
|---|---|
| Select Nearest Edit Point as Ripple In/Out, Roll, Trim In/Out | Unassigned in Premiere's default layout; available as commands, menus and in the editor. |
| T (Type tool) vs "Trim" | Premiere's T is the Type tool; trim mode is Shift+T. |
| Ctrl+T on Windows (New Text Layer vs Toggle Trim Type) | Both exist: Toggle Trim Type is Timeline-scoped and only enabled with edit points selected, so Ctrl+T falls through to New Text Layer otherwise. In the web app Ctrl+T is browser-reserved → Ctrl+Alt+T. |
| Generative/AI, Production panel, Search panel, Media Browser directory keys | Not part of JasperEditor (FilmCraft skips the same). |
| Clip ▸ Time Interpolation in Speed/Duration | Owned by the `time` workstream. |

## 8. MCP tools (`apps/mcp/src/tools/edit-ux.ts`)

`source_edit`, `find_edit_points`, `trim_edit_points`, `match_frame`, `reverse_match_frame`, `make_subclip`,
`edit_subclip`, `set_split_marks` (strict inputs; README tool list and server guide updated). Everything is also in
`describe_commands` / `apply_commands` (`clip.sourceEdit`, `clip.trimEdits`, `item.makeSubclip`,
`item.updateSubclip`, `item.setMarks {split}`, `clip.slide {linked}`).

## 9. Preview and export

All edits produce ordinary clips (speed, sourceIn, keyframes, nests from edit-structure), so preview and every
export path render them with existing features; the planner sees nothing new. Verified in the built app
(`e2e/edit-ux.spec.ts`): the fit-to-fill clip and an Opacity fade made with the fade handle exported (auto path) and
the exported frames show the fade (black first frame, picture later).

## 10. Tests

- `packages/project/test/edit-ux-split-edits.test.ts` — FilmCraft split-edit ripple trim, ripple delete and speed
  group scenarios (all failed before the fix: 7 of 15).
- `packages/project/test/edit-ux-edit-props.test.ts` — fast-check ports of FilmCraft `never_overlaps` (over
  overwrite, insert, razor, extract, trims, ripple trims, split-edit trims, ripple deletes, speed, moves; every op
  kind must succeed > 20 times) and `insert_then_extract_is_identity` (frame-for-frame content).
- `packages/project/test/edit-ux-source-edit.test.ts` — three-point, backtiming, four-point Fit Clip choices, split
  edits, patching, sequences as nests/clips, cycles, subclips, `clip.trimEdits`.
- `packages/project/test/edit-ux-match-trim.test.ts` — match / reverse match, trim-mode helpers.
- `apps/web/test/edit-ux-trim-mode.test.ts` — trim commands, counters, numeric entry, dynamic trimming (one undo step,
  limits, Esc, commit on other commands, J/K/L routing), Shift+D, J-cut through trim mode.
- `apps/web/test/edit-ux-trim-monitor.test.tsx`, `edit-ux-dialogs.test.tsx`, `edit-ux-keyboard.test.tsx`,
  `edit-ux-monitors.test.tsx`, `edit-ux-lanes.test.tsx` — components, dialogs, layouts (conflict-free on every
  platform/runtime), store, spring tools, guides, comparison, dropped frames, Button Editor, lanes and fades.
- `apps/mcp/test/edit-ux.test.ts` — the MCP tools over the protocol.
- `packages/project/test/overlay-ripple.test.ts` — the reported 363-frame day card (pop-in, shrink to a corner,
  pop-out) through `range.extract` in its hold and in its shrink, two Clean Up cuts, ripple trims both ways and
  `clip.extract` (each failed before: the card was split or the edit refused), the refusal that remains and a named
  track cut as before; `packages/session/test/overlay-ripple-history.test.ts` — undo / redo of one refit.

## 11. Comparison with FilmCraft

Equal: trim mode semantics (edit points, toggle order, counters, dynamic J/K/L as one undo step, play around), split
ripple trims and ripple delete, speed groups, the property tests, Avid/FCP layouts. Better: three- and four-point
editing with backtiming and every Fit Clip choice (FilmCraft has neither), fit to fill, multi-point keyboard trims
in one edit (FilmCraft trims points one by one, so a ripple on V1 and A1 moved sync-locked tracks twice), sequences
as sources with patching, subclip trim restriction in every trim/slip/roll/speed path, keyframe lanes with fades and
roving/expression awareness, a generic comparison view, contextual chords, a shortcut editor with conflict
takeover and an FCP 7 layout, MCP tools for every operation.

## 12. Sources

- Larry Jordan, "Five Hidden Keyboard Shortcuts to Faster Trimming in Adobe Premiere Pro" (fetched): Control+T toggle
  trim, Option+←/→ trim one frame, Shift+Option five frames, Q/W.
- Adobe Premiere Pro User Guide (helpx.adobe.com): "Default keyboard shortcuts", "Trimming clips" / "Trim Monitor",
  "Three-point and four-point editing", "Source patching and track targeting", "Change clip speed and duration",
  "Create subclips", "Program Monitor / Comparison view", "Guides and rulers", "Customize keyboard shortcuts". The
  pages answer 403 to scripted fetches here; they were used from prior knowledge and cross-checked against FilmCraft's
  Premiere tables and notes, which state they follow Premiere's defaults.
- FilmCraft (MIT OR Apache-2.0): `crates/engine/src/trim.rs`, `trim_tests.rs`, `split_edit_ripple_trim_tests.rs`,
  `ripple_delete_tests.rs`, `commands.rs`, `shortcut_presets.rs`, `crates/edit/src/{lib,tests}.rs`, `docs/keyboard.md`,
  `docs/monitors.md` (recorded in `licenses/ported/edit-ux.md`).
- Apple, Final Cut Pro 7 User Manual, keyboard shortcuts appendix (FCP 7 layout).
- Undocumented choices (most plausible behaviour): the volume band's amplitude scale, the 250 ms spring-loaded
  threshold, 4 px per frame for Trim Monitor drags, guides per sequence in local view state.

## 13. Limits

- Insert edits (`clip.place {mode: "insert"}`, paste insert, Insert Frame Hold Segment) and `clip.setSpeed {ripple}`
  still split overlays on sync-locked tracks; `gap.close` and ripple speed shortening still refuse when an overlay is
  in the way (no split).
- The Trim Monitor shows each side's clip alone (not the composite of other tracks) and steps aside while playing.
- The comparison view renders frames with Remotion `<Thumbnail>`s and is shown while paused.
- Guides and keyboard layouts live in browser storage, not in the project.
