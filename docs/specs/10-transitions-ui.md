# Spec 10: Transitions in the timeline UI

Status: functional spec, v1 (2026-10-01), milestone M2. Audience: the implementers of `wp-m2-transitions`.
Architecture contracts: `docs/ARCHITECTURE.md` §19.10 (UI extension points), D-30; model: S01 §13 and
`packages/project/src/transitions.ts` (merged in `443b7bc`).

This spec is original work; Premiere Pro is referenced only for familiar behaviour.

---

## 0. How to read this spec

Requirement ids: `TUI-NNN`. Priorities as in S06. Terms: *edit point* = frame where one clip ends and the next
starts on a track; *two-sided* transition = between two adjacent clips; *one-sided* (fade) = at a clip edge
without a neighbour; *span* = `[start, end)` sequence frames covered (`transitionSpan`); *handles* = media beyond
a clip's in/out points (`clipHandles`).

## 1. Current state and goals

Transitions exist in the document (`sequence.transitions`), in the commands (`transition.add / update /
remove / applyDefault`), in the preview (opacity ramps, dip mattes, audio fades) and in the native export. The
timeline panel neither draws nor edits them, the Effects panel does not list them, and the Ctrl+D keys are bound
to commands nobody registers. Goals:

1. See every transition on the timeline, at the right place, with its type, and whether it had to be shortened.
2. Add them by drag and drop from the Effects panel and by keyboard (Ctrl+D family).
3. Edit duration, alignment and type directly on the timeline and in Effect Controls; delete them.
4. Show handle availability while adding/resizing.
5. Two-sided audio crossfades (currently `E_NOT_IMPLEMENTED`) — P1.

## 2. Drawing (TUI-001…010)

- **TUI-001 (P0)** Each transition is drawn in its track row as a rectangle over its span: two-sided transitions
  straddle the cut per alignment (centre / start-at-cut / end-at-cut); one-sided fades sit inside the clip at its
  head or tail. Height: the clip body minus the name strip; the clip underneath stays visible (semi-opaque fill
  `--pr-transition-fill`, 1 px border, a diagonal line from bottom-left to top-right for fade-in shapes and the
  mirror for fade-outs, both for two-sided dissolves — the familiar "ramp" glyph). Text: the transition's label
  (`TRANSITION_SPECS`), elided; tooltip: type, duration (timecode + frames), alignment, handles used.
- **TUI-002 (P0)** Selected transitions use the selection accent; hovered ones show resize cursors on their edges.
  Transitions are part of the timeline selection (`selection.timeline.transitions`, already in the session);
  selecting a transition clears clip selection (and vice versa unless Shift).
- **TUI-003 (P0)** Shortened transitions (the stored duration is shorter than what the user asked for at creation)
  are not tracked in the model; instead the drawing marks transitions whose span touches the limit of the
  available handles with a thin hatched end cap ("no more media on this side").
- **TUI-004 (P0)** Rendering is virtualised with the clips (a per-track sorted transition index keyed by the
  transitions record identity), uses DOM elements positioned with `translateX` like clip bodies, and never
  re-renders per playhead frame (S02:TL-155).
- **TUI-005 (P0)** Transitions follow their clips in gestures: while a clip is moved or trimmed, the drawing uses
  the gesture's transient document (the model already moves/drops transitions per S01 §13).
- **TUI-006 (P1)** Audio transitions draw on audio tracks the same way, with the curve shape (linear for constant
  gain, quarter-sine for constant power).

## 3. Hit-testing and gestures (TUI-010…025)

- **TUI-010 (P0)** Hit priority inside a track row: transition edge (4 px zones at both ends of the transition
  rect) → transition body → clip edge → clip body. The clip trim zones next to a transition remain reachable
  outside the transition rect (the transition rect is inset 2 px vertically so clip edges above/below it can
  still be grabbed with the Ripple/Roll tools).
- **TUI-011 (P0)** Click selects; Shift/Ctrl-click toggles; double-click opens Effect Controls on the transition
  (TUI-040); right-click opens the transition context menu (TUI-045).
- **TUI-012 (P0)** **Edge drag** changes the duration (one gesture = one history entry "Transition Duration",
  `transition.update`):
  - `start-at-cut` / `end-at-cut`: the cut-side edge is fixed, the dragged edge moves;
  - `center`: both edges move symmetrically (the span stays centred); holding Alt releases the symmetry and the
    alignment becomes `start-at-cut` or `end-at-cut` when the fixed edge sits on the cut (otherwise the drag snaps
    back to symmetric);
  - the duration is clamped live with `fitTransitionDuration`; the tooltip shows `Duration 00:00:01:05 (35)`
    and, when clamped, "Limited by media handles".
- **TUI-013 (P0)** **Body drag** (two-sided only) snaps the alignment between end-at-cut / centre / start-at-cut
  as the pointer crosses thirds of the span (one entry "Transition Alignment"); the duration is kept or reduced to
  what the new alignment allows.
- **TUI-014 (P0)** Snapping: transition edges snap to the playhead, markers and other edit points with the
  timeline's snapping rules (S02:TL-450…455).
- **TUI-015 (P0)** Delete / Backspace with transitions selected removes them (`transition.remove`, one entry);
  Esc cancels a gesture; undo restores.
- **TUI-016 (P1)** Ripple/roll edits of the underlying cut keep working when the pointer is on the cut line (the
  Rolling Edit tool on a transition's cut rolls the edit point and the transition moves with it).

## 4. Adding transitions (TUI-020…035)

- **TUI-020 (P0)** **Effects panel**: new folders "Video Transitions ▸ Dissolve" (Cross Dissolve, Dip to Black) and
  "Audio Transitions ▸ Crossfade" (Constant Gain, Constant Power), generated from `TRANSITION_SPECS`; the default
  video and audio transitions show a blue outline badge (Premiere convention). Drag payload
  `{type: 'jasper/transition', effectId}` on MIME `application/x-jasper-transition` (+ text fallback), like the
  effect payload.
- **TUI-021 (P0)** **Drop on the timeline**: while dragging over a track of the right kind, the drop target is
  resolved from the pointer:
  - near an edit point with two clips: left third of a ±12 px band → `end-at-cut`, middle → `center`, right third →
    `start-at-cut`;
  - near a clip edge without a neighbour → a one-sided fade on that edge;
  - elsewhere on a clip → the nearer edge of that clip.
  A ghost rectangle shows the resulting span with the default duration, clamped by the handles.
- **TUI-022 (P0)** **Handle availability feedback** during drop and edge drags: the ghost shows, per side, the
  available handle as a light band up to the handle end and, when the requested duration does not fit, the missing
  part hatched red with the tooltip "Insufficient media: the transition will be N frames" (N = what
  `fitTransitionDuration` allows). If N = 0 the drop is refused (cursor `not-allowed`, tooltip explains which clip
  needs media after its out-point / before its in-point, as the model's `E_OUT_OF_MEDIA` message).
- **TUI-023 (P0)** Dropping on an existing transition replaces its type (`transition.update {effectId}`; the
  schema has the additive `effectId` field; the handler implements it: video↔video, audio↔audio only).
- **TUI-024 (P0)** Drop commits `transition.add` (one entry "Add Transition"); warnings `W_TRANSITION_SHORTENED`
  show as a toast.
- **TUI-030 (P0)** **Keyboard** (keymap ids already bound in `keymap-defaults.ts`):
  - `timeline.applyDefaultVideoTransition` (Ctrl+D): with clips selected → default video transition on the selected
    clips' edges (both edges; two-sided where a neighbour exists); with no clip selected → at the edit point
    nearest the playhead (within the visible range) on every **targeted** video track;
  - `timeline.applyDefaultAudioTransition` (Ctrl+Shift+D): same for audio tracks (one-sided fades until P1 audio
    crossfades land);
  - `timeline.applyDefaultTransitionsToSelection` (Shift+D): video and audio defaults on the selected clips.
  All go through `transition.applyDefault` with the M2 fields (`media`, `videoEffectId`, `audioEffectId`,
  `duration`) — the handler (this package) implements them; one entry per invocation.
- **TUI-031 (P0)** Default transitions and duration: Effects panel context menu "Set Selected as Default
  Transition" (per medium) stored in user preferences (web `localStorage`, like timeline prefs); default duration =
  the project's `defaultTransitionFrames`, editable in Sequence ▸ Transition Defaults… (P1: a small dialog that runs
  `project.updateSettings`).

## 5. Editing in the inspector (TUI-040…046)

- **TUI-040 (P0)** Selecting a transition shows a **Transition** section in Effect Controls (and in Properties):
  type (select among specs of the same medium → `transition.update {effectId}`), duration (timecode field →
  `transition.update {duration}`), alignment (Center at Cut / Start at Cut / End at Cut; disabled for one-sided),
  and an A/B diagram: outgoing clip "A" and incoming clip "B" bars over the transition span with their available
  handles, the cut line and the span, updated live while editing.
- **TUI-041 (P0)** Effect Controls' mini-timeline shows the transition span with draggable edges (same semantics
  as TUI-012).
- **TUI-045 (P0)** Transition context menu: Set Duration…, Alignment ▸ (three), Replace With ▸ (types), Clear
  (delete), Set as Default Transition.
- **TUI-046 (P1)** Clip context menu gains "Apply Default Transitions" (in / out / both).

## 6. Model additions owned by this package

- **TUI-050 (P0)** `transition.update` accepts `effectId` (type change within the same medium; unknown ids →
  `E_UNKNOWN_EFFECT`; switching between dissolve and dip re-fits the duration).
- **TUI-051 (P0)** `transition.applyDefault` accepts `media`, `videoEffectId`, `audioEffectId`, `duration`.
- **TUI-052 (P1)** **Two-sided audio crossfades**: `transition.add` on an audio edit point with two clips creates a
  two-sided transition (constant gain / power); `resolveAudioFades` gives the outgoing clip a tail handle + fade
  out and the incoming clip a head handle + fade in over the span (handles as for video); the snapshot's
  `RenderAudioClip` gains `headHandle?`/`tailHandle?`; the composition's AudioLayer and the native audio chain
  render the handles (the native change is confined to the audio section of `export/native.ts`).

## 7. Agents

- **TUI-060 (P0)** MCP tools (`apps/mcp/src/tools/transitions.ts`): `update_transition {projectId, transitionId,
  duration?, alignment?, effectId?}`, `remove_transitions {projectId, transitionIds}`, `apply_default_transitions
  {projectId, clipIds, edges?, media?}`, `list_transitions {projectId, sequenceId?, range?}` (id, type, track,
  span, clips); the existing `add_transition` stays. `get_timeline` lists transitions per track (it may already).

## 8. Acceptance tests

1. **Geometry** (unit, `panels/timeline/model/`): transition rects for all alignments, one-/two-sided, at several
   zoom levels; hit-test priority (TUI-010) including 1–2 px transitions at low zoom (they stay selectable via a
   3 px minimum hit width).
2. **Gesture → command mapping** (unit): edge drags per alignment incl. Alt, body-drag alignment snapping, clamping
   with `fitTransitionDuration` against fixtures with short handles, snapping to the playhead.
3. **Drop resolution** (unit): pointer → (edit point, alignment | fade edge) mapping; refusal when nothing fits.
4. **Component** (happy-dom): a sequence with a centred cross dissolve and a fade-out renders both rects with the
   right `translateX`/width; selecting and pressing Delete removes one (one history entry).
5. **E2E** (Playwright, `e2e/transitions.spec.ts`): drag Cross Dissolve from the Effects panel onto the cut between
   two fixture clips → visible, preview shows the mix at the cut; Ctrl+Z removes it; Ctrl+D at the playhead near a
   cut adds the default; dragging its right edge lengthens it and the tooltip shows the new duration; the Effect
   Controls Transition section changes the type to Dip to Black; native export of the result succeeds.
6. **Keyboard**: Ctrl+D with two clips selected adds transitions at their edges (two-sided where adjacent);
   Ctrl+Shift+D adds audio fades; Shift+D both; each is one history entry.
7. **Audio crossfade (P1)**: a two-sided constant-power crossfade between two tones plays without a gap or level
   bump > 0.5 dB at the cut in preview (Web Audio analysis) and export (ffmpeg `astats`).
