# Spec 02: Timeline

Status: functional spec, ready for implementation. Topic: `timeline`.
Audience: engineers building the JasperEditor timeline panel, the pure edit core, the keymap, and the agent command surface.

This document is **original JasperEditor material**. It is written in clean-room fashion: it describes required behavior, data concepts and algorithms. It contains no code, identifiers, file layout or comments from any third-party template. Implementers work only from this spec, the other files in `docs/specs/`, `docs/research/`, and `docs/ARCHITECTURE.md`.

Related documents (ours):
- `docs/research/premiere-ui-design-spec.md`: visual tokens, metrics, colors, cursors, full keymap tables (§3, §4.3, §9, §10, §16, §18, §19). This spec refers to it as **UI-SPEC** and does not repeat pixel values that live there unless they matter for behavior.
- `docs/research/native-video-libraries.md`: the native media engine (`apps/engine`), the `MediaEngine` interface, thumbnails/peaks recipes, proxies, OTIO interchange. Referred to as **NATIVE**.
- `docs/research/fframes.md`: the fframes motion-graphic item kind and its preview/render paths. Referred to as **FFRAMES**.
- `docs/research/orquester-multiplatform-setup.md`: monorepo, web/PWA/Electron shells, engine transport. Referred to as **PLATFORM**.
- Companion specs in `docs/specs/` (data model, monitors and transport, inspector/effect controls, rendering/export, agent API). Where this spec needs something they own, it says so and states the minimum contract.

---

## 0. Conventions

- Requirement IDs have the form `TL-NNN`. Numbers are grouped by feature area (table below). IDs are stable; new requirements get new numbers, removed ones are marked "withdrawn", never reused.
- Keywords: **MUST** (required for the first shippable timeline, "v1"), **SHOULD** (required for Premiere parity, may land after v1), **MAY** (optional / later).
- "Beyond baseline" notes (marked **[BEYOND]**) flag behavior that the purchased starter did not have at all, or had in a weaker form. The starter's behavior is described only at the level of "it could / could not do X".
- Keys are written Windows/Linux first; macOS equivalents follow UI-SPEC §16 (Ctrl→Cmd, Alt→Opt) unless stated.
- All sizes are CSS pixels at 1× density unless stated.
- "Agent" means an AI agent acting through the command API (§21). Anything a human can do in the timeline, an agent can do through a command with the same semantics.

| Range | Area |
|---|---|
| TL-001–049 | Core concepts, data, invariants |
| TL-050–099 | Architecture: edit core, commands, gestures, undo |
| TL-100–149 | Time/pixel math, zoom, scroll, viewport |
| TL-150–199 | Rendering pipeline, virtualization, performance |
| TL-200–249 | Ruler, timecode, render bar |
| TL-250–319 | Track headers and track management |
| TL-320–399 | Clip rendering (body, badges, thumbnails, waveforms, fades, rubber bands) |
| TL-400–449 | Selection and marquee |
| TL-450–479 | Snapping |
| TL-480–529 | Move / drag / drop / nudge |
| TL-530–589 | Trimming (regular, ripple, roll, keyboard trims) |
| TL-590–679 | Tools |
| TL-680–739 | Non-gesture edit commands (add edit, delete, lift/extract, paste, link, ...) |
| TL-740–759 | Gaps |
| TL-760–789 | In/Out and work area |
| TL-790–829 | Markers |
| TL-830–869 | Playhead, scrubbing, timecode entry |
| TL-870–899 | Transport and JKL shuttle |
| TL-900–929 | Keyboard map |
| TL-930–949 | Context menus |
| TL-950–979 | Agent control |
| TL-980–999 | Three-engine integration |
| TL-1000–1029 | Touch / PWA |
| TL-1030–1049 | Platform specifics (web, Electron) |
| TL-1050–1079 | Testing and acceptance |

---

## 1. Core concepts, data and invariants

The data model spec owns the full schema. The timeline needs the following concepts. Names here are **ours** and are the names implementers should use.

### 1.1 Time base

- **TL-001 (MUST)** Every sequence has a fixed frame rate `fps`, stored as a rational `{num, den}` (for example `30000/1001`, `25/1`). Sequence-time positions (clip start, duration, marker position, In/Out, playhead) are **integer frames** at that rate. There is no sub-frame position in sequence time.
- **TL-002 (MUST)** Source-media positions (where inside a media file a clip starts) are stored as **integer flicks** (1 flick = 1/705 600 000 s). This unit divides evenly into every standard frame rate (23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120 fps) and the common audio sample rates (44.1 kHz, 48 kHz), so repeated splits and trims never accumulate floating-point drift. Conversion to seconds happens only at the edge (rendering, engine jobs).
- **TL-003 (MUST)** Frame duration in flicks is `705600000 * den / num`. For all rates in TL-002 this is an integer; other rates MUST be rejected at sequence creation or rounded to the nearest supported rate with a warning.
- **TL-004 (MUST)** Timecode display supports: SMPTE non-drop `HH:MM:SS:FF`, SMPTE drop-frame `HH;MM;SS;FF` (only for 29.97 and 59.94), plain frame count, and seconds with decimals. The sequence has a display-format preference; drop-frame is the default for 29.97/59.94 sequences. The conversion algorithm is in Appendix A.1.
- **TL-005 (MUST)** Sequence **end** = the largest `start + duration` over all clips on all tracks, or 0 for an empty sequence. The last *content* frame is `end - 1`. The playhead may sit on `end` (shows black / silence). Playback and shuttle clamp at `end` (TL-875); the only case where the playhead is beyond `end` is right after an edit shortened the sequence (TL-835).

### 1.2 Sequence

A sequence holds: `id`, `name`, `fps`, frame size, ordered **video tracks** and **audio tracks** (two separate lists), clips (by id), **sequence markers**, **In/Out** (TL-760), **work area** (TL-775), and **transitions** attached to edit points (owned by the transitions spec; the timeline only draws and hit-tests them).

- **TL-006 (MUST)** A project can contain several sequences. The timeline panel can show several sequences as tabs (UI-SPEC §9.2); each tab has its own view state (TL-012). All timeline state MUST be scoped to a timeline instance (no module-level singletons), so two timeline panels and a source-monitor mini-timeline can coexist. **[BEYOND]** The starter supported exactly one timeline per page.

### 1.3 Tracks

- **TL-007 (MUST)** A track has: `id`, `kind` (`video` | `audio`), `name` (default "V1", "V2"... / "A1", "A2"..., numbered from the V/A divider outward), `locked`, `syncLocked`, `targeted`, `outputEnabled` (video "eye"), `muted`, `solo` (audio), and view-only `height`. Audio tracks additionally carry a `channelLayout` (`mono` | `stereo`; v1 may support stereo only) and a track volume in dB (mixer spec owns pan/volume automation).
- **TL-008 (MUST)** Video tracks stack **upward** from the divider (V1 closest to the divider, drawn lowest); audio tracks stack **downward** (A1 closest). Compositing order: higher video track = on top.
- **TL-009 (MUST)** Track kind compatibility: video tracks accept video, still image, animated image, text/title, shape/solid, captions, Remotion composition clips, fframes motion-graphic clips, adjustment layers, nested sequences (video side). Audio tracks accept audio clips (including the audio side of a movie file and of a nested sequence). A clip MUST never be placed on an incompatible track by any path (drag, drop, paste, agent command); the operation is refused or redirected (TL-487). **[BEYOND]** Starter tracks were untyped.
- **TL-010 (MUST)** Tracks persist until the user (or an agent) deletes them. Empty tracks are never removed automatically. A new sequence starts with 3 video + 3 audio tracks (preference). **[BEYOND]** Starter derived track count from content and deleted empty tracks.
- **TL-011 (MUST)** There is a **Master** audio row at the bottom of the audio stack (header only in v1: lock-less label "Master", volume readout). It holds no clips.

### 1.4 View state (not part of the document)

- **TL-012 (MUST)** Per sequence tab, the timeline keeps a view state: `pxPerFrame`, `scrollFrame` (the sequence frame at the left edge of the clip area, may be negative by up to the left padding), `scrollYVideo`, `scrollYAudio`, `dividerRatio` (share of the vertical space given to the video stack), per-track `height`, `headerWidth`, the active tool, snapping on/off, linked selection on/off, display settings (TL-330). View state is **not** undoable. It is persisted per sequence in the project's UI-state record (so reopening restores zoom and scroll), not in the undoable document.
- **TL-013 (MUST)** Track `targeted` flags and source-patch assignments are persisted with the sequence but are **not** undoable (Premiere behaves the same; toggling them is navigation, not editing).

### 1.5 Clips

- **TL-014 (MUST)** A clip has: `id`, `trackId`, `start` (frame), `duration` (frames, ≥ 1), `kind`, a reference to its content (asset id, composition id, fframes template+params, nested sequence id, or inline text/shape data), `sourceIn` (flicks; for media-backed kinds), `speed` (positive number, 1 = 100 %; `reverse` boolean for reversed playback), `enabled`, `name` (defaults to the asset name), `labelColor`, `linkGroupId` (nullable), `groupId` (nullable; "Group" is distinct from "Link", TL-704), `fadeIn` / `fadeOut` for picture and `audioFadeIn` / `audioFadeOut` for sound (frames), static `gainDb` (clip gain, separate from the volume keyframe lane), keyframe lanes (TL-344), and clip markers (TL-800).
- **TL-015 (MUST)** Derived **source out** = `sourceIn + duration * frameFlicks * speed`. For media-backed clips the source range MUST lie inside the asset's available range: `0 ≤ sourceIn` and `sourceOut ≤ assetDuration`. Stills, text, shapes, solids, adjustment layers, Remotion compositions declared "unbounded" and fframes templates have no source limit (they can be extended indefinitely); Remotion compositions with a fixed length and nested sequences are bounded by their own length.
- **TL-016 (MUST)** **No-overlap invariant**: on one track, clip frame ranges `[start, start+duration)` never intersect. Every edit operation MUST preserve it; operations that would break it resolve by overwrite semantics (TL-483) or are refused. The invariant check runs after every command in development builds and in tests (TL-1052).
- **TL-017 (MUST)** `start ≥ 0` for every clip.
- **TL-018 (MUST)** Links: a **link group** ties clips that represent the same source moment (typically V + A of a movie file, possibly V + A1 + A2). Linked clips move, trim, razor and delete together unless the gesture is modified to ignore links (Alt) or linked selection is off. A link group's clips are **in sync** when `start - sourceIn/frameFlicks/speed` agree (to within a frame). If they disagree, each clip shows an out-of-sync badge with the signed frame offset (TL-326).

### 1.6 Derived objects

- **TL-019 (MUST)** **Gap**: a maximal empty range on a track between two clips, or between frame 0 and the first clip. Gaps are not stored; they are derived on demand and can be selected (TL-740). The empty area after the last clip on a track is **not** a gap.
- **TL-020 (MUST)** **Edit point**: a boundary on one track at frame `f` where something ends or begins: clip|clip (a "butt" edit), clip|gap, gap|clip, or the out of the last clip. An edit point is addressed as `(trackId, frame)` and has an **outgoing side** (the clip or gap ending at `f`) and an **incoming side** (the clip or gap starting at `f`). Edit points are selectable (TL-547) and are the anchors for transitions.
- **TL-021 (MUST)** **Through edit**: a butt edit where the incoming clip continues the outgoing one exactly (same content, same speed, `sourceIn` of incoming = `sourceOut` of outgoing, same link group structure). Displayed per TL-335; "Join Through Edits" (TL-712) removes it.

### 1.7 Clip engine attribution

- **TL-022 (MUST)** Every clip kind maps to the engine that produces its pixels/samples for preview and export:
  - `native`: video/audio/image media decoded from files (preview through the browser Player with proxies; export through ffmpeg in the engine),
  - `remotion`: text/titles, shapes, captions, Remotion compositions (React),
  - `fframes`: fframes motion graphics (WASM SVG preview, CPU raster master).
  The timeline uses this for badges (TL-325), thumbnails (TL-981) and the render bar (TL-214). Editing semantics are identical for all engines.

**Acceptance (§1)**
- AC-1a: Splitting a 29.97 fps clip playing at 37 % speed 500 times at random frames, then re-joining, yields the original `sourceIn`/source-out exactly (integer equality).
- AC-1b: Dropping an audio file onto a video track through any path never produces an audio clip on a video track.
- AC-1c: Deleting all clips leaves all tracks in place.

---

## 2. Architecture: edit core, commands, gestures, undo

- **TL-050 (MUST)** All document edits live in a **pure edit core** (proposed package `packages/timeline-core`, see UI-SPEC §1) with no DOM or React dependency. Each operation is a function `(document, args) → result` where the result is either `{ok: true, document, changes, selectionAfter}` or `{ok: false, reason}`. `changes` lists created/updated/deleted clip ids and affected ranges so the UI, the history panel and agents can show what happened.
- **TL-051 (MUST)** Every operation is registered as a **command** with a stable id (for example `timeline.razorAt`, `timeline.rippleDelete`), a zod argument schema, a human-readable undo label ("Razor", "Ripple Delete", "Move 3 clips"), and a flag saying whether it needs a UI context (focused panel, pointer position) or is fully headless. Keyboard shortcuts, menus, the tools and agents all call commands. No UI path mutates the document without going through a command. The keymap spec (UI-SPEC §16.8) binds keys to these ids.
- **TL-052 (MUST)** **Gestures** (drag, trim, slip, marquee, scrub) are split into three phases:
  1. *begin*: capture the document snapshot and precompute gesture data (snap targets, limits, neighbor lists);
  2. *update*: compute a **preview result** by running the same pure operation on the snapshot with the current delta; the preview is stored in a transient gesture store, never in the document or the undo stack;
  3. *commit*: run the operation once more with the final delta and push it as **one** undo step; or *cancel* (Escape, pointer capture lost, window blur) which discards the preview.
- **TL-053 (MUST)** Preview results drive the drawing of ghosts and the Program Monitor (trim two-up, slip four-up) during the gesture. The timeline MUST NOT recompute the whole sequence layout on each pointer move; only clips listed in the preview's `changes` re-render.
- **TL-054 (MUST)** Undo/redo: every committed command is exactly one history entry labeled with its undo label (agent commands are prefixed "Agent: ..."). History depth: at least 200 entries (preference), with memory-aware pruning. Undo restores the selection that existed before the command; redo restores `selectionAfter`.
- **TL-055 (MUST)** A **transaction** API groups several commands into one history entry (used by agents and by compound UI actions like "Paste Insert" or "Extract"). If any command in the transaction fails, the whole transaction rolls back.
- **TL-056 (MUST)** While a gesture is active, incoming external edits (agent commands, collaborative sync later) are queued and applied after the gesture commits or cancels. The gesture never operates on a document that changed under it.
- **TL-057 (MUST)** The sequence **duration used for layout** (scroll extent, ruler) is frozen during a gesture and updated on commit, so trimming the last clip does not make the ruler jump under the pointer.
- **TL-058 (SHOULD)** Commands support a **dry-run** mode returning `changes` without committing. Agents use this for proposals (TL-955); the UI uses it for hover previews (razor line, insert arrows).

---

## 3. Time/pixel math, zoom and scroll

### 3.1 Viewport model

- **TL-100 (MUST)** The timeline is a **viewport** onto sequence time, not a DOM element whose width equals the sequence length. The horizontal state is `(scrollFrame, pxPerFrame)` plus the measured clip-area width `W` (CSS px). There is no maximum content width. **[BEYOND]** The starter sized one real scrolling element to the whole sequence and capped its width, which made frame-level zoom impossible on long sequences.
- **TL-101 (MUST)** Conversions (clip-area-local x, CSS px):
  - `frameToX(f) = (f - scrollFrame) * pxPerFrame`
  - `xToFrameExact(x) = scrollFrame + x / pxPerFrame` (a real number)
  - Frame `f` occupies the cell `[frameToX(f), frameToX(f+1))`.
  - **Seeking** (click on ruler, scrub): target = `floor(xToFrameExact(x))`, clamped to `[0, end]`. Clicking anywhere inside a frame's cell lands on that frame.
  - **Boundary targeting** (clip edges, edit points, razor, In/Out drag): target = `round(xToFrameExact(x))`, the nearest frame boundary.
  - **Deltas** (move, trim, slip): `deltaFrames = round((pointerX - downX + scrollDeltaPx) / pxPerFrame)` where `scrollDeltaPx` accounts for auto-scroll since pointer-down.
- **TL-102 (MUST)** Drawn positions are snapped to device pixels (`Math.round(v * dpr) / dpr`) at draw time only. Stored or computed frame values are never derived from rounded pixels. Thumbnails and waveforms inside a clip are positioned from exact time, not from the rounded clip rectangle, so content never drifts relative to the clip edge.
- **TL-103 (MUST)** Precision: all conversions use float64. The design must stay exact for sequences up to 24 h at 120 fps (≈10.4 M frames).

### 3.2 Zoom range

- **TL-104 (MUST)** Maximum zoom: `pxPerFrame_max = 48` (preference 16–120). At this zoom a single frame is wide enough to show per-frame ticks and a thumbnail per frame.
- **TL-105 (MUST)** Minimum zoom: the value at which `max(end, 10 s of frames) * 1.1` fits into `W`, but never larger than `pxPerFrame_max`. (Zooming out further is pointless; zooming out to exactly this is "zoom to sequence".)
- **TL-106 (MUST)** Zoom is continuous (any value in range). Discrete zoom steps (keys, buttons) multiply/divide `pxPerFrame` by **1.5**. Wheel/pinch zoom applies `factor = exp(-deltaY * 0.0025)` per event (deltaY normalized to pixels), clamped to range.

### 3.3 Zoom anchoring

- **TL-107 (MUST)** Every zoom operation has an **anchor** `(anchorFrame, anchorX)` and keeps that frame under that screen x: `newScrollFrame = anchorFrame - anchorX / newPxPerFrame`.
  - Keyboard (`=`/`-`), zoom buttons, zoom-bar handle drags: anchor = playhead if the playhead is inside the viewport, otherwise the viewport center.
  - Wheel / trackpad pinch: anchor = pointer position.
  - Zoom tool click: anchor = click position; zoom tool marquee: fits the dragged frame range to `W` (TL-650).
  **[BEYOND]** The starter anchored only on the playhead and offered only a slider.
- **TL-108 (MUST)** **Zoom to sequence** (`\`): sets minimum zoom and `scrollFrame` so the whole sequence is visible; pressing `\` again restores the previous `(pxPerFrame, scrollFrame)`. Any other zoom action clears the stored "previous".
- **TL-109 (SHOULD)** "Zoom to selection" (panel menu; agent command `timeline.zoomToRange`) fits the selected clips' union range with 5 % margin on each side.

### 3.4 Horizontal scroll

- **TL-110 (MUST)** Scroll extent: `scrollFrame ∈ [-leftPad, max(0, extentEnd - W/pxPerFrame)]` where `leftPad = 16 px / pxPerFrame` (a small margin so frame 0 is not glued to the header), and `extentEnd = max(end, playhead, outPoint, lastMarker) + W / pxPerFrame * 0.5` (you can always scroll half a screen past the last content, to drop clips there).
- **TL-111 (MUST)** Wheel mapping over the clip area (UI-SPEC §9.7):
  - Windows/Linux: plain wheel = horizontal scroll; Ctrl+wheel = vertical scroll of the stack under the pointer; Alt+wheel = zoom (pointer-anchored).
  - macOS: plain wheel/two-finger = vertical scroll of the stack under the pointer, horizontal trackpad component = horizontal scroll; Shift+wheel = horizontal; Alt+wheel = zoom.
  - Trackpad pinch (a `wheel` with `ctrlKey` set by the browser) = zoom on all platforms.
  - A preference "Mouse wheel scrolls horizontally" overrides the platform default.
- **TL-112 (MUST)** A custom **zoom scroll bar** below the clip area (UI-SPEC §9.7): the thumb spans the visible range relative to the extent; dragging the thumb pans; dragging either round end handle changes zoom while keeping the opposite end fixed; wheel over the bar zooms (anchored at the bar position mapped to time). Double-click on the bar = zoom to sequence. The native browser scrollbar is not used horizontally.
- **TL-113 (MUST)** `Page Up` / `Page Down` (timeline focused) scroll one visible width left/right without moving the playhead. `Home`/`End` move the playhead (TL-879) and scroll it into view.

### 3.5 Vertical layout and scroll

- **TL-114 (MUST)** The track area is split at the **V/A divider** into a video region (grows upward) and an audio region (grows downward), each independently scrollable vertically, each with its own vertical mini zoom bar at the right edge (UI-SPEC §9.7). Dragging the divider changes `dividerRatio`. The ruler, the headers column and the zoom scroll bar never scroll vertically. **[BEYOND]** Starter had one mixed stack.
- **TL-115 (MUST)** Video region content is bottom-aligned (V1 sits on the divider; empty space appears above the top track); audio region content is top-aligned.
- **TL-116 (MUST)** Vertical mini zoom bar handles scale all track heights in that region proportionally (clamped to per-track min/max, TL-262).

### 3.6 Auto-scroll during gestures

- **TL-117 (MUST)** While any pointer gesture is active (drag, trim, roll, slip, slide, marquee, scrub, razor-drag, In/Out drag, marker drag), if the pointer is within 40 px of the clip area's left/right edge (or beyond it), the view scrolls horizontally at `speed = maxSpeed * clamp(depth / 40, 0, 1)^2` px per animation frame, `maxSpeed = 30 px`. Same for top/bottom edges of the region under the pointer (vertical scroll, `maxSpeed = 15 px`). The gesture's delta includes the scrolled distance (TL-101), so the thing under the pointer keeps moving smoothly while the view scrolls.
- **TL-118 (MUST)** Auto-scroll never scrolls left of `-leftPad`. Rightward auto-scroll may extend the extent beyond TL-110 during the gesture.

### 3.7 Follow playhead during playback

- **TL-119 (MUST)** Preference "Timeline playback auto-scroll" with three modes (UI-SPEC §9.5):
  - **Page scroll** (default): when the playhead passes the right edge (forward play) or left edge (reverse), `scrollFrame` jumps by one visible width so the playhead reappears at the opposite side (5 % inset).
  - **Smooth scroll**: once the playhead reaches the viewport center it stays at center and content moves under it.
  - **No scroll**.
  Auto-scroll pauses while the user is interacting with the timeline (pointer down, wheel within the last 1 s) and resumes afterwards.
- **TL-120 (MUST)** Any seek via keyboard/command (edit-point navigation, marker navigation, Home/End, In/Out go-to, timecode entry) scrolls the playhead into view if it is outside, placing it at 25 % of `W` from the edge it came from (minimum movement; no scroll if already visible).

**Acceptance (§3)**
- AC-3a: A 3 h 29.97 fps sequence can be zoomed in until one frame is ≥ 40 px wide, anywhere in the sequence, and trims at that zoom move by exactly one frame per 40 px.
- AC-3b: Alt+wheel over clip X keeps the frame under the pointer fixed to within 1 px across 20 zoom steps.
- AC-3c: `\` then `\` returns to the exact prior zoom and scroll.
- AC-3d: Dragging a clip toward the right edge auto-scrolls; the clip's start frame under the pointer keeps increasing smoothly; releasing commits the frame shown in the tooltip.

---

## 4. Rendering pipeline, virtualization, performance

- **TL-150 (MUST)** The clip area renders in layers (bottom to top):
  1. track background layer (track row fills, locked hatch, target tint, In/Out shading across tracks), drawn on a canvas per region;
  2. clip layer (bodies, names, badges, thumbnails, waveforms, fades, rubber bands, clip markers, transitions);
  3. overlay layer (edit-point highlights, snap line, razor hover line, insert arrows, marquee rectangle, drag ghosts, agent proposal ghosts);
  4. playhead line (topmost except menus and tooltips).
  The ruler and headers are separate, non-scrolling-vertically layers.
- **TL-151 (MUST)** **Virtualization**: only clips intersecting the visible frame window `[scrollFrame - overscan, scrollFrame + W/pxPerFrame + overscan]` (overscan = 50 % of the visible width) **and** on tracks intersecting the visible vertical range (plus one track of overscan) are mounted/drawn. **[BEYOND]** The starter mounted every clip.
- **TL-152 (MUST)** Each track keeps an **interval index** of its clips sorted by `start` (clips on a track never overlap, so a sorted array plus binary search for the first clip whose end is after the window start is enough). Rebuilt incrementally from command `changes`.
- **TL-153 (MUST)** The implementation MAY render clips as DOM elements or on canvas, but MUST meet the budgets in TL-160. Recommended: DOM elements for clip bodies/names/handles (accessibility, hit testing, cursors) positioned with `transform: translateX()` in viewport coordinates; canvas tiles for thumbnails, waveforms, ruler ticks and track backgrounds.
- **TL-154 (MUST)** Level of detail by on-screen clip width `w`:
  - `w < 2 px`: draw a 1 px line in the label color, no hit target of its own (hit-test via the zoom tool or by zooming in; marquee still selects it);
  - `2 ≤ w < 12`: body only;
  - `12 ≤ w < 40`: body + name clipped, no badges;
  - `w ≥ 40`: everything enabled by display settings.
  Edge trim zones shrink per TL-531.
- **TL-155 (MUST)** The playhead line and the timeline timecode readout are updated by writing to the DOM (transform / text) from the transport's frame callback, **not** via React state per frame. Nothing else re-renders on a pure playhead move. **[BEYOND]**
- **TL-156 (MUST)** Pointer-move handling for gestures is coalesced to one update per animation frame.
- **TL-157 (MUST)** Heavy work (thumbnail decoding in the browser fallback, waveform reduction, peak pyramid building) runs in Web Workers or in the engine, never on the main thread.
- **TL-158 (MUST)** Canvas tiles have a fixed maximum size (512 × track height CSS px, times DPR) so no canvas ever exceeds browser limits, regardless of clip length or zoom. **[BEYOND]** Starter drew per-clip canvases sized to whole assets, which could exceed canvas limits.
- **TL-159 (MUST)** Clip-area re-render on a committed edit touches only affected tracks' visible clips (from `changes`).
- **TL-160 (MUST)** Performance budgets (reference machine: 12-core x64, no GPU, Chromium, 1920×1080 window, DPR 1):
  - pan/zoom at 60 fps (p95 frame time ≤ 16 ms) on a sequence with 3 000 clips over 40 tracks, 2 h long;
  - clip drag preview ≤ 8 ms script time per animation frame on the same sequence;
  - committing an edit ≤ 50 ms end-to-end to repaint;
  - playback at 60 fps sequence rate with the playhead updating every frame and no dropped UI frames attributable to the timeline.

---

## 5. Ruler, timecode readout, render bar

- **TL-200 (MUST)** The ruler (height and colors per UI-SPEC §4.3/§9.4) is drawn to canvas tiles for the visible range only. **[BEYOND]** Starter emitted one DOM node per tick across the whole sequence and had no timecode format.
- **TL-201 (MUST)** Tick interval selection: from the ladder of candidate *major* intervals, in frames for the sequence rate: 1, 2, 5, 10 frames; half-second (if fps is even); 1, 2, 5, 10, 15, 30 s; 1, 2, 5, 10, 15, 30 min; 1, 2 h. Choose the smallest candidate whose on-screen width ≥ 80 px. Minor ticks subdivide the major interval into 2, 4, 5 or 10 parts (whichever gives minor spacing ≥ 8 px, preferring 5 and 10). When `pxPerFrame ≥ 6`, per-frame minor ticks are drawn. For drop-frame sequences, intervals are in *displayed* timecode units and labels come from the DF conversion.
- **TL-202 (MUST)** Major labels show the time in the current display format (TL-004), with a short form that drops leading zero hours (`00:00:15:00` → `:15:00` style when the sequence is under 1 h, as Premiere does), full form otherwise. Labels are never clipped mid-glyph at tile boundaries (tiles overdraw labels that straddle them).
- **TL-203 (MUST)** Ruler interactions: pointer-down on the ruler seeks (TL-101 floor rule) and starts **scrubbing** (TL-832); Shift while scrubbing snaps the playhead to snap targets (TL-455) even when snapping is off. Right-click opens the ruler menu (TL-934). Double-click on the ruler MAY add a marker (preference, off by default).
- **TL-204 (MUST)** The ruler has lanes, top to bottom: time labels + ticks; marker lane (TL-805); In/Out bracket lane (TL-763); optional work-area bar (TL-775); render bar (TL-214).
- **TL-205 (MUST)** The **timeline timecode readout** (header, top-left; UI-SPEC §9.2) shows the playhead position. Clicking it turns it into a text field accepting: full timecode, partial timecode (right-aligned: `115` = 1 s 15 f, `1.` = 1 s, `1..` = 1 min), frame counts with `#` prefix, and relative offsets (`+15`, `-1:00`, `+1.` ...). Enter seeks, Escape cancels. Dragging horizontally on the readout scrubs (1 frame per 2 px; Shift = 10×). Ctrl+click toggles display format between timecode and frames.
- **TL-206 (SHOULD)** Premiere-style "Time Ruler Numbers" toggle and "Show audio time units" (audio sample precision) are panel-menu items; audio time units MAY be deferred.

### 5.1 Render bar

- **TL-214 (SHOULD)** A thin render-status strip under the ruler shows, per frame range, the preview state computed by the rendering spec from the three engines (UI-SPEC §9.4):
  - **green**: a cached preview render (engine-rendered segment or proxy) covers the range;
  - **yellow**: plays in real time through the live Player (native media via proxies, light Remotion content, fframes via WASM SVG);
  - **red**: expected not to play in real time (heavy Remotion compositions marked heavy, fframes content without WASM preview, effect stacks over the budget, missing proxies for heavy codecs);
  - no color: empty.
  The timeline only draws the segments it is given (a list of `{startFrame, endFrame, state}` from the rendering service). **[BEYOND]**
- **TL-215 (SHOULD)** `Enter` (timeline focused) runs "Render In to Out" (or the whole sequence when no In/Out): requests preview renders from the engine for red/yellow segments; the bar updates live from job events.

---

## 6. Track headers and track management

Layout and column widths follow UI-SPEC §9.3. This section defines behavior.

### 6.1 Controls

- **TL-250 (MUST)** **Lock** (padlock), both kinds. A locked track:
  - cannot be edited by any gesture, command, paste, drop or agent operation; ripple/insert operations that would need to shift clips on a locked track shift nothing there (locked tracks are treated as sync-lock off) (TL-543);
  - its clips cannot be selected by click or marquee; existing selections on it are cleared when locking;
  - becomes un-targeted and cannot be targeted while locked;
  - is drawn with the diagonal hatch over the whole row (UI-SPEC §3.3), clip bodies stay visible.
  Undoable ("Lock Track"). **[BEYOND]**
- **TL-251 (MUST)** **Targeting** (the `V1`/`A1` pill): marks tracks that receive: paste (TL-700), Add Edit (TL-680), Match Frame, Mark Clip (TL-766), edit-point navigation with Up/Down (TL-880), and Lift/Extract of the In/Out range (TL-690). Clicking toggles. Multiple tracks may be targeted. Not undoable (TL-013). **[BEYOND]**
- **TL-252 (MUST)** **Source patching** (the leftmost column): visible only when the source monitor has a clip loaded. Shows `V1`/`A1`(`A2`...) source indicators; clicking toggles the patch; dragging a source indicator to another track's column moves the patch. Insert/Overwrite from the source monitor (TL-693) place media on patched tracks. Details of source-monitor behavior belong to the monitors spec. **[BEYOND]**
- **TL-253 (MUST)** **Sync lock**, both kinds, default ON for all tracks. Governs which *non-edited* tracks shift during ripple trims, ripple deletes, inserts and extracts (TL-543). Off = track is left alone. Undoable. **[BEYOND]**
- **TL-254 (MUST)** **Track output** (eye), video only. Off = track excluded from Program preview and from export; its clips are drawn at reduced contrast. Undoable ("Toggle Track Output"). **[BEYOND]** Starter's hide toggle was not undoable.
- **TL-255 (MUST)** **Mute** `M` and **Solo** `S`, audio only. Effective mute of a track = `muted OR (anySoloInSequence AND NOT solo)`. Solo'd tracks show the yellow S, tracks silenced by someone else's solo show a dimmed M. Both undoable. Alt+click on S = exclusive solo (unsolo all others). **[BEYOND]** Starter had mute but no solo.
- **TL-256 (SHOULD)** **Voice-over record** button on audio headers: press to arm and record from the microphone into the track at the playhead (preroll 3 s countdown), using `MediaRecorder`; creates an audio asset and a clip. Belongs to a later work package.
- **TL-257 (MUST)** Modifier conventions on header toggles:
  - Shift+click on lock / sync-lock / eye / mute / solo / target = apply the new state to **all tracks of that kind**.
  - Alt+click on **solo** = exclusive solo (all other audio tracks unsoloed).
  - Alt+click on **eye** = show only this video track (all others off); a second Alt+click on the same eye restores the previous set.
  - Alt+click on **mute** has no special meaning (behaves like a click).
- **TL-258 (MUST)** **Track name**: double-click to rename inline (Enter commits, Escape cancels, empty restores the default name). Undoable.
- **TL-259 (SHOULD)** Expanded headers (track height ≥ 48 px) show: keyframe navigator (previous keyframe / add-remove keyframe at playhead / next keyframe for the selected clip's visible lane on this track), a lane selector ("Opacity", "Volume", or any animatable property of the clip; TL-344), and for audio a track volume scrubby value in dB.
- **TL-260 (MAY)** Customize header (Premiere's "Customize Video/Audio Header") button editor.

### 6.2 Track height and header width

- **TL-261 (MUST)** Drag the boundary between two track headers to resize: in the video region, dragging the **top** border of a header resizes that track (tracks grow away from the divider); in the audio region, dragging the **bottom** border. Height changes are view state, not undoable. **[BEYOND]** Starter heights were derived from content only.
- **TL-262 (MUST)** Height limits: min 20 px (minimized: name only, no thumbnails/waveforms), default video 32 px, default audio 40 px, max 240 px.
- **TL-263 (MUST)** Height shortcuts (UI-SPEC §16.6): increase/decrease video heights (Ctrl+= / Ctrl+-), audio heights (Alt+= / Alt+-), expand all (Shift+=) and minimize all (Shift+-). Steps: 20 → 32 → 48 → 72 → 108 → 160 → 240. Double-click on empty header space toggles that track between its last expanded height (≥ 48) and default. Alt+wheel over a header scales that one track; Shift+wheel over the header column scales all tracks of that region.
- **TL-264 (MUST)** Header column width is draggable at its right edge between 140 px and 280 px (view state).

### 6.3 Adding, deleting, reordering tracks

- **TL-265 (MUST)** Header context menu: Add Track (inserts one track of this kind directly above for video / below for audio), Add Tracks… (dialog: counts and placement for video and audio), Delete Track (refused with a confirmation if it contains clips: "Delete track and its N clips?"), Delete Empty Tracks, Rename, and for audio "Channel layout ▸".
- **TL-266 (MUST)** Dragging a clip or media above the topmost video track (into the empty area of the video region) or below the lowest audio track creates a new track of the right kind on drop (TL-486). The new track inherits default flags (sync-lock on, unlocked, untargeted).
- **TL-267 (SHOULD)** Tracks can be reordered within their kind by dragging the header name area vertically (Premiere cannot; this is a JasperEditor convenience). Reordering renames default-named tracks to keep V1..Vn / A1..An numbering; custom names are kept.
- **TL-268 (MUST)** Track-count limits: up to 99 video and 99 audio tracks per sequence.

**Acceptance (§6)**
- AC-6a: With A2 soloed, A1 and A3 are silent in preview and export; unsoloing restores them; undo/redo of the solo toggle works.
- AC-6b: Locking V2 then Ripple Delete of a gap on V1 moves V1 and all sync-locked unlocked tracks, not V2.
- AC-6c: Shift+click on the V1 eye turns off all video tracks.
- AC-6d: Resizing A1 to 108 px shows a larger waveform immediately and does not create an undo entry.

---

## 7. Clip rendering

### 7.1 Body, name, states

- **TL-320 (MUST)** Clip body filled with the clip's label color (default label by media kind per UI-SPEC §3.4 table, including the JasperEditor-specific colors for Remotion compositions and fframes graphics). Corner radius, border and name strip per UI-SPEC §9.6.
- **TL-321 (MUST)** The name strip shows `name`, plus `[V]` / `[A]` suffix when the clip is linked, plus speed in percent when `speed ≠ 1` (e.g. `interview.mov [V] 50%`), plus `(reversed)` when reversed. Names truncate with an ellipsis. When a clip is partly scrolled off the left edge, the name sticks to the visible left edge of the clip (so the name stays readable on long clips).
- **TL-322 (MUST)** States (visuals in UI-SPEC §9.6): selected (white outline), hover, disabled (Shift+E), offline media (red body, "Media Offline"), on a locked track (hatch), on an output-disabled track (dim), being dragged (original position drawn as outline only while the ghost moves).
- **TL-323 (MUST)** Label colors are per clip and can be changed from the context menu (Label ▸) and by command. "Select Label Group" selects all clips with the same label in the sequence.

### 7.2 Badges

- **TL-325 (MUST)** Badges on the right of the name strip (shown only when `w ≥ 40 px` and enabled in display settings), in this order: fx badge (color states per UI-SPEC §9.6), speed badge, proxy badge (preview is using a proxy), **engine badge** `R` (Remotion) or `F` (fframes) — native media shows none, render-state badge for fframes/Remotion clips whose engine render is in progress (a small progress ring). **[BEYOND]**
- **TL-326 (MUST)** **Out-of-sync badge**: for linked clips whose sync offset (TL-018) is not zero, a red box with the signed frame offset (e.g. `-12`) on each affected clip. Right-click on the badge offers "Move into sync" (moves this clip) and "Slip into sync" (slips this clip) (TL-716).

### 7.3 Thumbnails (video filmstrip)

- **TL-327 (MUST)** Display styles (display settings): **Continuous** (default), **Head**, **Head and Tail**, **Off**. Thumbnails are drawn when track height ≥ 40 px, below the name strip, at the clip's content aspect ratio.
- **TL-328 (MUST)** Continuous algorithm (conceptual):
  1. thumbnail height `h` = content area height; slot width `s = h * aspect`;
  2. the source-time span of one slot at the current zoom is `σ = s / pxPerFrame * frameFlicks * speed`;
  3. choose a **quantized step** `q` from a fixed ladder (powers of two times one source frame duration) as the smallest ladder value ≥ `σ`; slots are placed at source times that are multiples of `q`, so neighboring zoom levels and adjacent clips cut from the same asset share the same requested frames;
  4. for each slot whose on-screen rectangle intersects the viewport (plus overscan), request the frame at the slot's source time (middle of the slot) at height `h * dpr` rounded up to a size bucket (40, 64, 96, 144, 216 px);
  5. draw a cached frame immediately if one exists for that asset within one `q` of the target; otherwise draw the nearest cached frame of that asset stretched to the slot (or the label color) and replace it when the exact frame arrives;
  6. reversed clips place slots in reverse source order.
  Only visible slots are requested; requests for slots that scroll away are cancelled. **[BEYOND]** Starter decoded all unfilled slots of a clip, not just visible ones, and did not persist anything.
- **TL-329 (MUST)** Thumbnails are obtained through the **media preview provider** (part of the `MediaEngine` interface in NATIVE §3):
  - `getFrames(assetId, sourceTimes[], heightBucket) → stream of (time, ImageBitmap-compatible bytes)`;
  - Desktop/engine implementation: ffmpeg frame extraction and keyframe sprite sheets precomputed at import (NATIVE §5.4), cached on disk by content hash and served over HTTP;
  - Web-only fallback: in-browser decoding in a Worker (WebCodecs-based);
  - both share an in-memory LRU of decoded bitmaps (budget 256 MB default, preference) keyed `(assetId, heightBucket, time)`; the web fallback also persists JPEG/WebP thumbnails in OPFS/Cache Storage so reloads don't re-decode.
- **TL-330 (MUST)** Timeline **display settings** menu (wrench, UI-SPEC §9.2): Show Video Thumbnails (+ style), Show Video Names, Show Audio Waveform, Show Audio Names, Rectified Audio Waveforms, Show Video Keyframes, Show Audio Keyframes, Show Through Edits, Show Clip Markers, Show fx Badges, Show Engine Badges, Show Label Colors, Show Duplicate Frame Markers (SHOULD), Minimize/Expand All Tracks. Persisted per user (not per sequence).

### 7.4 Waveforms

- **TL-331 (MUST)** Audio clips (and linked audio clips of movies) draw waveforms when track height ≥ 32 px, in the label's light tint (UI-SPEC §3.4). Two styles, switched by "Rectified Audio Waveforms" in display settings: **rectified** (bottom-up, absolute value; default, matching Premiere) and **centered** (symmetric min/max around the lane center). Stereo clips draw two lanes (L top, R bottom) when height ≥ 64 px, a merged envelope otherwise.
- **TL-332 (MUST)** Peak data is a **multi-resolution min/max pyramid** per asset per channel:
  - level 0: one `(min, max)` pair per 256 source samples (187.5 pairs/s at 48 kHz); each higher level halves the rate by combining pairs (min of mins, max of maxes), until < 1 pair per second;
  - values quantized to signed 8-bit (−127..127) for levels ≥ 1 and 16-bit for level 0;
  - drawing picks the coarsest level whose pair duration ≤ the source duration of one device pixel (`frameFlicks * speed / (pxPerFrame * dpr)`), and aggregates pairs per pixel column.
  Generated in the engine (ffmpeg decode to PCM, then reduced; NATIVE §5.5 gives the decode recipe and a simpler max-abs reducer, which this format supersedes) or in a Worker for the web fallback; stored on disk / OPFS by content hash. **[BEYOND]** Starter used a single-resolution mono max-abs envelope held in memory only.
- **TL-333 (MUST)** The drawn waveform reflects the clip's **effective gain**: static clip gain + volume keyframe lane value at each column + fades (TL-340). Samples whose scaled magnitude exceeds full scale draw their top 2 px in `--pr-danger` (clipping hint).
- **TL-334 (MUST)** Waveforms are drawn into tiles (TL-158); a clip's waveform is never one canvas.

### 7.5 Through edits, duplicate frames

- **TL-335 (SHOULD)** Through edits (TL-021) show two small facing triangles at the cut when "Show Through Edits" is on.
- **TL-336 (MAY)** Duplicate-frame markers: a colored stripe at the bottom of clips when the same source frames appear more than once in the sequence (computed lazily per asset).

### 7.6 Fades (quick fades)

JasperEditor keeps quick fades as a clip property (a DaVinci-style convenience) in addition to Premiere-style transitions and keyframes.

- **TL-340 (MUST)** Each clip has picture fades (`fadeIn`, `fadeOut`, frames; video-track clips) and sound fades (`audioFadeIn`, `audioFadeOut`; audio clips and the audio of linked clips). Constraint: `fadeIn + fadeOut ≤ duration` for each pair; operations that shorten a clip clamp fades proportionally-first then from the side being trimmed.
- **TL-341 (MUST)** On hover over a clip (w ≥ 40 px, height ≥ 32 px), small fade handles appear at the top corners. Dragging a handle horizontally sets the fade length (snaps to frames, respects TL-340, snaps to the playhead if snapping is on). A curve overlay (darkened area above an S-curve for picture, log-shaped curve for audio) shows the fade. A tooltip shows the fade length in the display time format. Undoable ("Fade In", "Fade Out").
- **TL-342 (SHOULD)** Fade curve shapes: linear, ease (S), exponential (audio default). Right-click on a fade handle chooses the shape.
- **TL-343 (MUST)** Fades are rendered identically by all engines: the composition layer maps fades to opacity (picture) and gain (sound). Export via the native ffmpeg path maps them to `fade`/`afade` filters (rendering spec).

### 7.7 Rubber bands and keyframe lanes

- **TL-344 (MUST)** A clip shows one **keyframe lane** at a time (the "visible property"): default "Opacity" for video-track clips and "Volume" for audio clips. When the track is expanded (≥ 48 px) and "Show Keyframes" is on, the lane is drawn as a 1 px line across the clip (color per UI-SPEC §9.6) with keyframe diamonds. The visible property can be switched per clip through the fx dropdown on the clip body (SHOULD) or per track through the header lane selector (TL-259).
- **TL-345 (MUST)** Value mapping for the volume lane (normalized height `u ∈ [0,1]`, 0 = bottom of content area, 1 = top): `+15 dB` at `u = 1`, `0 dB` at `u = 0.75`, and below that an audio-taper curve `dB = 60 * log10(u / 0.75)` (so `u = 0.375` ≈ −18 dB), `−∞` at `u = 0`. Opacity lane: linear 0–100 %. Other properties: linear between the property's declared min and max.
- **TL-346 (MUST)** With the Selection tool: dragging the line vertically (no keyframes present) changes the property's static value for the whole clip; with keyframes present it moves the segment's two keyframes together. A tooltip shows the value (`-6.0 dB`, `72 %`). Ctrl+click on the line adds a keyframe at that frame with the current interpolated value. Dragging a keyframe moves it in time (clamped between neighbors, within the clip) and value; Shift constrains to value-only or time-only after the first 4 px of movement. Delete removes selected keyframes. Undoable. **[BEYOND]** Starter had one static volume value per clip and no keyframes.
- **TL-347 (MUST)** Pen tool (TL-640) behavior on lanes: click adds keyframes, drag draws, marquee selects keyframes.
- **TL-348 (MUST)** Keyframe frames are stored clip-relative (so moving a clip moves its keyframes). Trimming a clip's head shifts clip-relative frames so keyframes stay at the same source moment; keyframes outside the new range are kept but hidden (restored if the clip is extended again). Splitting partitions keyframes and inserts boundary keyframes on both halves so the curve value at the cut is preserved (Appendix A.6).

**Acceptance (§7)**
- AC-7a: A 2 h interview clip at max zoom shows correct thumbnails for the visible part within 300 ms (engine cached) and decodes nothing outside the viewport + overscan.
- AC-7b: Setting clip volume to −6 dB halves the drawn waveform amplitude (±1 px).
- AC-7c: A 1-frame-wide clip at mid zoom is still selectable by marquee.
- AC-7d: Waveform and thumbnails stay aligned with the clip edges at every zoom (no drift greater than 1 device px).

---

## 8. Selection and marquee

- **TL-400 (MUST)** Selection is a set of clip ids, plus optionally a set of selected **edit points** (TL-547), selected **gaps** (TL-740), selected **keyframes** and selected **markers**. Selecting objects of one category clears the others, except clips + keyframes of those clips. Selection is not undoable, but undo/redo restores the selection around the undone command (TL-054).
- **TL-401 (MUST)** Selection tool click on a clip: replaces the selection with that clip (plus its link group when linked selection is on). Shift+click: toggles the clip (and its link group) in the selection. Ctrl+click is reserved for edit-point/keyframe actions and does **not** toggle selection. Alt+click: selects only the clicked clip, ignoring links (Alt+Shift+click toggles only that clip). Clicking an already selected clip without dragging, on pointer-up, reduces the selection to that clip (so a multi-selection can be dragged by any member).
- **TL-402 (MUST)** A click (no drag) on empty track space after the last clip of a track deselects everything; a click inside a gap selects the gap (TL-740). Neither moves the playhead. A press-and-drag starting on any empty track space (gap or not) starts a marquee (TL-404).
- **TL-403 (MUST)** **Linked selection** toggle (header toolbar, UI-SPEC §9.2) default ON. When off, clicks select single clips; moves/trims still act only on selected clips. Group membership (TL-704) always expands selection regardless of this toggle.
- **TL-404 (MUST)** **Marquee**: with the Selection tool (or Track Select tools holding nothing), pointer-down on empty track space and drag draws a rectangle (visual per UI-SPEC). Clips whose rectangle intersects the marquee (any overlap, including 1 px-wide clips) are selected; clips on locked tracks are excluded; link groups expand when linked selection is on. Without modifier the marquee replaces the selection; with Shift it toggles the intersected clips relative to the selection at marquee start. The marquee may span both the video and audio regions (it is drawn across the divider). Auto-scroll applies (TL-117). Hit-testing uses the interval index (TL-152), not DOM queries. **[BEYOND]** Starter marquee could not add to a selection.
- **TL-405 (MUST)** Ctrl+A selects all clips on unlocked tracks; Ctrl+Shift+A deselects all.
- **TL-406 (MUST)** "Select Clip at Playhead" (`D`): selects the topmost clip under the playhead on each **targeted** track (all tracks if none targeted).
- **TL-407 (SHOULD)** "Select Next / Previous Clip" (`Shift+;` / `Ctrl+Shift+;` per UI-SPEC §16.4): moves the selection to the next/previous clip on the same track as the current selection's topmost clip.
- **TL-408 (MUST)** Selection is exposed to the rest of the app (Effect Controls, Properties, Program Monitor transform handles) through the editor store; the timeline is not the owner of inspector behavior.

**Acceptance (§8)**
- AC-8a: Marquee over a movie's video clip selects its linked audio clip too; with linked selection off, only the video clip.
- AC-8b: Shift-marquee over a selected clip deselects it and keeps the rest.
- AC-8c: Clips on a locked track are never selected by click, marquee or Ctrl+A.

---

## 9. Snapping

- **TL-450 (MUST)** Snapping toggle: header magnet button and key `S`; default ON; persisted per user. Pressing `S` **during** a gesture toggles snapping for the rest of that gesture and persists the new state. **[BEYOND]** Starter used a different key that we need for marker navigation.
- **TL-451 (MUST)** Snap targets (collected at gesture begin, excluding the objects being manipulated and their link partners):
  - clip starts and ends on all tracks (locked and output-disabled tracks included),
  - edit points of the tracks,
  - the playhead,
  - sequence markers (start and, for duration markers, end) and clip markers of non-moving clips,
  - In and Out points, work-area ends,
  - frame 0,
  - keyframes of the selected clip (only during keyframe drags).
- **TL-452 (MUST)** Threshold: 8 screen px (preference 4–16), converted to frames at the current zoom at gesture begin and on zoom change.
- **TL-453 (MUST)** Algorithm (Appendix A.3): targets sorted by frame; for each **moving edge** (for a move: the start and end of every moved clip; for a trim: the edge being trimmed; for slide: the clip's start and end; for the playhead: the playhead), find the nearest target by binary search; the candidate with the smallest absolute distance within threshold wins; ties break by target priority `playhead > marker > In/Out > clip edge > frame 0`, then by the moving edge that is closest to the pointer. The chosen offset is applied to the whole gesture delta.
- **TL-454 (MUST)** While a snap is active, draw the snap indicator (line through all tracks with small triangles; UI-SPEC §3.3) at the snapped frame. On touch, trigger haptics per TL-1006.
- **TL-455 (MUST)** Playhead snapping: when scrubbing on the ruler with Shift held, or when the preference "Snap playhead in timeline when snap is enabled" is on and snapping is on, the playhead snaps to targets during scrubbing (excluding itself).
- **TL-456 (SHOULD)** Snapping to source keyframes (GOP boundaries) of native media, for lossless-cut exports, available as a preference "Snap to source keyframes (lossless export)"; keyframe timestamps come from the engine's probe (NATIVE §5.2). Shown as tiny ticks on the clip's bottom edge at high zoom. **[BEYOND]**

**Acceptance (§9)**
- AC-9a: Dragging a clip whose end comes within 8 px of the playhead snaps the end exactly onto the playhead frame and draws the indicator.
- AC-9b: With snapping off, holding Shift while scrubbing snaps the playhead to a marker.

---

## 10. Move, drag, drop, nudge

### 10.1 Moving clips with the Selection tool

- **TL-480 (MUST)** Pointer-down on a clip body (not an edge zone, not a fade handle, not a rubber-band) selects per TL-401 and arms a move. The move starts after the pointer travels ≥ 4 px (touch: long-press per TL-1003). Escape before release cancels.
- **TL-481 (MUST)** The moving set = the selection (expanded by links/groups), minus clips on locked tracks (if the pointer-down clip itself is on a locked track, nothing happens).
- **TL-482 (MUST)** Horizontal delta per TL-101, then snapping (TL-453), then clamping so that no moved clip starts before frame 0.
- **TL-483 (MUST)** **Overwrite move (default, Premiere semantics)**: on commit, moved clips are removed from their origin, then placed at their destination; any part of a non-moving clip under a destination range is **overwritten** (trimmed, split into two, or removed entirely). Origin ranges become gaps. The preview shows the ghost clips at the destination and darkens the parts of other clips that will be overwritten. **[BEYOND]** The starter instead pushed a moved clip into the nearest free space or refused the drop; JasperEditor follows Premiere (overwrite by default). Preference "Drag to occupied space: Overwrite / Refuse / Nearest gap" MAY exist for users who prefer the old behavior; default Overwrite.
- **TL-484 (MUST)** **Insert move** (hold Ctrl while releasing): destination tracks are split at the drop frame and everything at/after it on the destination tracks **and on all sync-locked, unlocked tracks** shifts right by the moved span; the origin is left as a gap (Premiere; Ctrl+drag lifts and inserts). The preview shows yellow insert arrows at the drop frame on affected tracks (UI-SPEC §18).
- **TL-485 (MUST)** **Duplicate move** (Alt pressed at release, Alt+drag): the origin clips stay, copies are placed at the destination with overwrite semantics. (Ctrl+Alt is not "duplicate insert"; it is rearrange, TL-489.) Copies get new ids, new link groups mirroring the original link structure.
- **TL-486 (MUST)** Vertical movement: the moved set moves by a **track offset** = (pointer's current track index − track index at pointer-down), counted within the region the pointer is in. Video clips move among video tracks, audio clips among audio tracks. For a linked V/A set: if the drag was grabbed on a video clip, the offset applies to the video parts and the audio parts keep their tracks, and vice versa for a grab on an audio clip (each side of a linked pair changes tracks only when the user drags that side; horizontal movement always applies to both). If a destination track index would be beyond the top video track (or below the bottom audio track), new tracks are created on commit (TL-266); the preview shows a "New track" hint. Moving onto a locked track is refused for those clips (they stay; the ghost shows a not-allowed marker).
- **TL-487 (MUST)** Kind safety: a video-kind clip is never moved onto an audio track and vice versa; the track offset is clamped per kind.
- **TL-488 (MUST)** Shift held **after** the move started constrains the move to the axis with the larger displacement so far (horizontal-only keeps tracks; vertical-only keeps frames).
- **TL-489 (SHOULD)** **Rearrange** (Ctrl+Alt+drag, single clip or contiguous clips on one track): extract the clip(s) (ripple close on origin) and insert at the destination on the same track; other tracks are not shifted (Premiere "swap"/rearrange behavior).
- **TL-490 (MUST)** A tooltip near the pointer during the move shows the signed delta in display timecode (`+00:00:01:12`) and, when vertical, the destination track name.
- **TL-491 (MUST)** Commit produces one undo entry ("Move Clip" / "Move N Clips" / "Insert Move" / "Duplicate").

### 10.2 Dropping media and items from outside

- **TL-492 (MUST)** Drop sources: Project panel assets, OS files (web: drag-and-drop `File`s, which are imported first; Electron: native paths registered with the engine), Effects-panel generators (text, shapes, solids, Remotion composition templates, fframes templates), and agent-created assets. The drag shows a ghost of the clip(s) that would be created, with duration = the asset's default duration (media length, or 5 s for stills/templates, preference).
- **TL-493 (MUST)** A movie asset with both video and audio streams creates a **linked pair**: a video clip on the destination video track and an audio clip on the corresponding audio track (the pointer's audio track if the pointer is in the audio region; otherwise the audio track with the same index as the video destination, i.e. V1→A1, V2→A2, created if missing). Multi-stream audio creates one linked audio clip per stream (up to the track count). **[BEYOND]** Starter embedded a video's sound inside the video clip.
- **TL-494 (MUST)** Drop semantics: overwrite by default, insert with Ctrl (same as moves). Dropping over empty space beyond the last track creates tracks (TL-266). Dropping a video-only asset into the audio region (or an audio asset into the video region) retargets it to the nearest compatible track (V1 or A1) and shows that in the ghost.
- **TL-495 (SHOULD)** Alt+drop of an asset onto an existing clip **replaces** that clip's content, keeping its position, duration, effects and keyframes, aligning source time at the clip's first frame ("Replace with clip").
- **TL-496 (MUST)** Multiple assets dropped at once are placed back-to-back in their selection order starting at the drop frame on the same track.

### 10.3 Keyboard nudge

- **TL-497 (MUST)** Alt+←/→ nudges the selected clips by 1 frame; Alt+Shift+←/→ by 5 frames (macOS Cmd per UI-SPEC §16.6). Nudge uses overwrite semantics; nudging left is clamped at frame 0. Alt+↑/↓ moves the selected clips one track up/down (same kind; refuses at the top/bottom rather than creating tracks). Consecutive nudges within 1 s coalesce into one undo entry.

**Acceptance (§10)**
- AC-10a: Dragging clip B (frames 100–199) over clip A (0–299) at frame 150 leaves A as 0–149 and 250–299, B at 150–249, and a gap at B's old position (if on another track).
- AC-10b: Ctrl+drag insert of a 60-frame clip at frame 300 moves every clip at ≥ 300 on all sync-locked unlocked tracks by +60, splitting any clip that straddles 300 on those tracks.
- AC-10c: Dropping a movie with stereo audio onto V2 creates V2 + A2 linked clips; A2 is created if it does not exist.
- AC-10d: Escape during a drag restores everything and creates no undo entry.

---

## 11. Trimming

### 11.1 Edge hit zones and cursors

- **TL-530 (MUST)** With the Selection tool, hovering near a clip edge shows the trim cursor (red bracket, UI-SPEC §18) facing the side that will be trimmed. With the Ripple tool: yellow ripple bracket. With the Rolling tool near a shared edit: roll cursor. With Rate Stretch: stretch cursor.
- **TL-531 (MUST)** Edge zone width = `min(8 px, max(3 px, w / 4))` measured **inside** the clip from its edge. At a butt edit, the outgoing clip's out zone and the incoming clip's in zone sit next to each other; which side is trimmed is decided by which side of the cut the pointer is on.
- **TL-532 (MUST)** During any trim/roll/stretch/slip/slide gesture, the gesture's cursor is forced on the whole document (UI-SPEC §18).

### 11.2 Regular trim (Selection tool)

- **TL-533 (MUST)** Dragging the in edge of clip C by `d` frames: `start += d`, `duration -= d`, `sourceIn += d * frameFlicks * speed` (reversed clips: the source *out* moves instead). Dragging the out edge: `duration += d`. **[BEYOND]** Speed-aware source math is mandatory everywhere (the starter's split ignored speed).
- **TL-534 (MUST)** Limits for a regular trim (the edge stops, the pointer can go further):
  - duration ≥ 1 frame;
  - source range inside the available media (TL-015); unbounded kinds have no media limit;
  - the adjacent clip on the same track (a regular trim never overwrites the neighbor; it stops at it);
  - frame 0 for in-edge extension.
  While the edge is pinned at a limit, a limit indicator is drawn: a red bar at the edge, plus a faint outline showing the full available media range of the clip (so the user sees how much handle exists). **[BEYOND]** partially; starter showed media bounds only.
- **TL-535 (MUST)** Linked partners are trimmed by the same delta on the same side unless Alt was held at pointer-down (then only the grabbed clip trims; the pair goes out of sync and shows TL-326 badges).
- **TL-536 (MUST)** Multi-clip trim: if the grabbed clip is part of a multi-selection, every selected clip whose corresponding edge (same side) is at the same frame as the grabbed edge is trimmed together; each is clamped individually, and the common delta is the most restrictive (so all move in lockstep).
- **TL-537 (MUST)** Tooltip during trim: signed delta and resulting duration (UI-SPEC §9.9).
- **TL-538 (MUST)** Program Monitor **two-up** during trims and rolls: left = outgoing frame at the edit, right = incoming frame (the monitors spec renders it; the timeline publishes `{mode: 'trim', outgoingClipId, outgoingFrame, incomingClipId, incomingFrame}` through the transient gesture store). **[BEYOND]**
- **TL-539 (MUST)** Fades are clamped after the trim (TL-340); keyframes follow TL-348; transitions attached to the trimmed edit point constrain the trim so the transition keeps enough handle (transitions spec).

### 11.3 Ripple trim

- **TL-540 (MUST)** Ripple trim (Ripple tool `B`, or Selection tool with Ctrl held at pointer-down on an edge): like a regular trim, but the neighbor is **not** a limit; instead, everything after the edit on the same track shifts by the change in duration, so no gap opens and nothing is overwritten.
  - Trimming the **out** edge of C by `d`: C's duration changes by `d`; all clips on the track starting at or after C's old end shift by `d`.
  - Trimming the **in** edge of C by `d`: C's `start` stays fixed, its `sourceIn` changes by `d * frameFlicks * speed`, its duration changes by `-d`, and all clips after C shift by `-d`. (Premiere keeps the clip's start and ripples the rest.)
  - Ripple trim of a **gap** edge (dragging the incoming clip's in edge with ripple where the outgoing side is a gap) shortens/lengthens the gap.
- **TL-541 (MUST)** Ripple limits: duration ≥ 1; media bounds; no shifted clip may move before frame 0. On the edited track itself a ripple can never create an overlap; the constraints for other tracks are in TL-543.
- **TL-542 (MUST)** Visuals: yellow bracket cursor and yellow edit-point highlight (UI-SPEC §3.3); ghost of the shifted content.
- **TL-543 (MUST)** **Sync-locked tracks during ripple/insert/extract**: for every other track that is sync-locked and unlocked, the same shift is applied at the same frame:
  - positive shift (lengthening): clips at/after the edit frame shift right; a clip straddling the edit frame is **split** at the edit frame and its right part shifts (the opened range is empty space);
  - negative shift (shortening by `n`): the range `[editFrame, editFrame + n)` on that track must be **empty**; it is removed and everything after shifts left. If it contains clip content, the operation would destroy material on a track the user did not edit, so (as in Premiere) it is not performed: during a trim **gesture** the edge stops at the largest `n` for which every sync-locked track has empty space; a **command** (ripple delete, keyboard trim, agent call) is refused with `SYNC_LOCK_CONFLICT`. In both cases the blocking clips flash red briefly.
  - Tracks with sync lock off, and locked tracks, are untouched (which can knock them out of sync; that is the user's choice).
  Linked partners of the trimmed clip are trimmed identically (not merely shifted). **[BEYOND]**
- **TL-544 (MUST)** Ripple affects sequence markers after the edit frame when the preference "Ripple sequence markers" is on (default ON, TL-806).

### 11.4 Rolling edit

- **TL-545 (MUST)** Roll (Rolling tool `N`, or edit-point trim type "roll", TL-548): dragging an edit point moves the outgoing clip's out and the incoming clip's in by the same delta; nothing else moves. Works at butt edits and at clip|gap / gap|clip edits (the gap changes size instead). Limits: both sides keep duration ≥ 1, both sides stay within media, and gap sides stay ≥ 0. **[BEYOND]** The starter could roll only where two clips touched exactly, via a tiny hotspot, without a tool mode.
- **TL-546 (MUST)** Roll visuals: red `][` cursor, two-up monitor (TL-538), tooltip showing the delta.

### 11.5 Edit-point selection and keyboard trimming

- **TL-547 (MUST)** Clicking (without dragging) an edge zone selects that **edit point side** (bracket overlay per UI-SPEC §18: red for regular/roll, yellow for ripple). Ctrl+click adds more edit points (on other tracks). Double-click an edit point opens **Trim mode** in the Program Monitor (monitors spec).
- **TL-548 (MUST)** With edit points selected: `Shift+T` cycles the trim type of the selection (regular out/in → roll → ripple out/in); Ctrl+←/→ trims by 1 frame; Ctrl+Shift+←/→ by the "multi-frame trim" amount (preference, default 5). Each keypress is a command; consecutive presses within 1 s coalesce in history. (Premiere binds these in its Trim mode; mark as verify against Premiere's current defaults.)
- **TL-549 (MUST)** Playhead-based trims (UI-SPEC §9.9/§16.5), applying to clips on **targeted** tracks (all unlocked tracks if none targeted) that intersect the playhead:
  - `Q` Ripple Trim Previous Edit to Playhead: ripple-removes `[clipStart, playhead)` of the clip under the playhead; everything after shifts left; playhead moves to the old clip start (so it stays on the same content).
  - `W` Ripple Trim Next Edit to Playhead: ripple-removes `[playhead, clipEnd)`.
  - `Alt+Q` / `Alt+W`: same ranges, regular trim (leave gaps).
  - `E` Extend Selected Edit to Playhead: moves the selected edit point(s) to the playhead using their current trim type (regular / roll / ripple), clamped by limits.
  Linked partners follow. No-op (with a status hint) when nothing intersects the playhead.

**Acceptance (§11)**
- AC-11a: Trimming the head of a 50 % speed clip by 10 frames advances its source in by 5 frames' worth of source time.
- AC-11b: Regular-trimming clip A's out into adjacent clip B stops exactly at B's start and shows the limit indicator.
- AC-11c: Ripple-trimming A's out by −20 frames on V1 shifts everything after it on V1 and on sync-locked A1/A2 by −20; if A1 has content in that range the trim stops at the largest possible value.
- AC-11d: `Q` with the playhead mid-clip removes the head and closes the gap; undo restores exactly.

---

## 12. Tools

- **TL-590 (MUST)** Tool state: `activeTool ∈ {selection, trackSelectForward, trackSelectBackward, ripple, rolling, rateStretch, razor, slip, slide, pen, hand, zoom, type, agent}` (UI-SPEC §10 for icons, grouping, flyouts). Stored in the timeline view state of the editor (shared by timeline and Program Monitor; not undoable). The tools panel and keys `V A Shift+A B N R C Y U P H Z T` switch tools. **[BEYOND]** The starter had no tool modes (only a split-at-playhead button).
- **TL-591 (MUST)** Each tool defines: cursor per hover region (body, in edge, out edge, edit point, empty space, ruler), click behavior, drag behavior, modifier behavior, and touch availability. The pointer dispatcher asks the active tool for the action given `(hit target, modifiers)`; tools share the gesture framework (TL-052).
- **TL-592 (SHOULD)** Spring-loaded tools: holding a tool key for > 250 ms activates the tool temporarily and reverts on key-up (preference, default OFF, UI-SPEC §10).
- **TL-593 (MUST)** The ruler always behaves as a scrub area regardless of tool (except Zoom tool: click/drag on ruler zooms), and header controls are unaffected by tools.

### 12.1 Selection (`V`)

- **TL-600 (MUST)** Behavior as specified in §8, §10, §11 (select, marquee, move, trim, Ctrl-edge ripple, fades, rubber bands).

### 12.2 Track Select Forward / Backward (`A` / `Shift+A`)

- **TL-605 (MUST)** Click at frame `f` (pointer, boundary-rounded) selects every clip on **all unlocked tracks** whose end is after `f` (forward) — i.e. the clip under the pointer and everything to its right; backward selects every clip whose start is before `f`. Shift+click limits it to the clicked track (plus link partners when linked selection is on). (UI-SPEC §10's table describes the Shift variant the other way around; this spec follows Premiere's documented behavior: all tracks by default, Shift = single track.)
- **TL-606 (MUST)** A drag started with the tool selects on pointer-down and then moves the selection exactly like the Selection tool (overwrite, Ctrl insert). This is how users open up space.
- **TL-607 (MUST)** Hover preview: the clips that would be selected are highlighted with a 50 % selection outline and an arrow cursor pointing forward/backward.

### 12.3 Ripple Edit (`B`)

- **TL-610 (MUST)** Edge drags perform ripple trims (TL-540). Clicking a body selects (no move). Clicking an edge selects the edit point as ripple (TL-547).

### 12.4 Rolling Edit (`N`)

- **TL-612 (MUST)** Hovering within the edge zone of either side of an edit point targets the edit point; drag performs a roll (TL-545). Hovering the outer edge of the first clip on a track (preceded by nothing) or the last clip (followed by nothing) behaves like a regular trim of that edge.

### 12.5 Rate Stretch (`R`)

- **TL-615 (MUST)** Dragging a clip edge changes the clip's timeline duration **without changing its source range**, by changing `speed`: `speed_new = sourceSpanFrames / newDuration` where `sourceSpanFrames` is the source range expressed in sequence frames at 100 %. The in edge moves `start`; the out edge moves the end. Limits: speed within [0.1, 20] (preference; Premiere allows 0.01×–100×), duration ≥ 1, and the regular-trim neighbor limit (a stretch never overwrites). Ripple variant: with Ctrl held, downstream clips ripple (same as ripple trim).
- **TL-616 (MUST)** Linked audio stretches along (audio speed follows; "maintain audio pitch" is a clip property, default ON, rendered via engine time-stretch per NATIVE §4.19/§5.11).
- **TL-617 (MUST)** Unbounded kinds (stills, text, shapes, solids) have no speed to change: with these clips Rate Stretch performs a regular trim and shows the regular trim cursor.
- **TL-618 (MUST)** Speed badge and name suffix update live in the preview.

### 12.6 Razor (`C`)

- **TL-620 (MUST)** Hovering over a clip shows a vertical cut-line preview at the boundary-rounded pointer frame, snapped to the playhead and other snap targets when snapping is on (TL-453; razor always snaps to the playhead within threshold even when snapping is off — Premiere behaves this way).
- **TL-621 (MUST)** Click splits the clip under the pointer (and its link partners unless Alt is held) at that frame using the split algorithm (Appendix A.6). Shift+click splits every clip on all **unlocked** tracks at that frame (the cut line then spans all tracks in the preview). Clicking exactly on an existing clip boundary does nothing.
- **TL-622 (SHOULD)** Razor drag: dragging vertically across tracks with the razor splits every clip the line crosses at the pointer frame on release.
- **TL-623 (MUST)** Selection after a razor split: unchanged (the halves of a previously selected clip are both selected).

### 12.7 Slip (`Y`)

- **TL-625 (MUST)** Dragging a clip body shifts its source range under a fixed timeline position and duration: `sourceIn -= d * frameFlicks * speed` (dragging right shows earlier source material, as in Premiere). Limits: media bounds (the gesture pins at the limit). Linked partners slip together unless Alt. Unbounded kinds: slip is meaningful for Remotion compositions and fframes templates (it offsets their internal frame) only when they declare a finite length; otherwise not allowed.
- **TL-626 (MUST)** Program Monitor **four-up** during slip: top-left = previous clip's last frame, top-right = next clip's first frame, bottom-left = this clip's new first frame, bottom-right = new last frame (monitors spec renders; the timeline publishes the frames in the gesture store). Tooltip: source-in timecode and the delta.
- **TL-627 (MUST)** The filmstrip and waveform inside the clip move with the slip in the preview.
- **TL-628 (MUST)** Keyboard slip: Ctrl+Alt+←/→ 1 frame, +Shift 5 frames on selected clips (UI-SPEC §16.6).

### 12.8 Slide (`U`)

- **TL-630 (MUST)** Dragging a clip body moves the clip in time keeping its source range, while the previous neighbor's out and the next neighbor's in are rolled to follow (the previous clip lengthens/shortens, the next shortens/lengthens); total sequence length unchanged. If a neighbor side is a gap, the gap resizes instead. Limits: neighbors keep ≥ 1 frame and stay within their media; gap sides ≥ 0. Linked partners slide together unless Alt.
- **TL-631 (MUST)** Four-up monitor during slide: top-left = previous clip's new out frame, top-right = next clip's new in frame, bottom = this clip's (unchanged) first and last frames.
- **TL-632 (MUST)** Keyboard slide: Alt+, / Alt+. 1 frame, +Shift 5 frames (UI-SPEC §16.6).

### 12.9 Pen (`P`)

- **TL-640 (MUST)** Over a keyframe lane: click adds a keyframe (value interpolated at that frame), drag on a keyframe moves it, drag on the line between keyframes moves the segment, marquee on empty lane space selects keyframes, Shift+click toggles keyframe selection, Ctrl+click on a keyframe cycles interpolation (linear → bezier → hold). Over a clip body without a visible lane: no-op (cursor shows not-allowed). In the Program Monitor the pen draws masks/shapes (monitors spec).

### 12.10 Hand (`H`)

- **TL-645 (MUST)** Drag pans horizontally and vertically (the region under the pointer). No selection changes. Middle-mouse drag pans with any tool (Premiere-independent convenience).

### 12.11 Zoom (`Z`)

- **TL-650 (MUST)** Click zooms in one step anchored at the click; Alt+click zooms out; dragging a rectangle zooms so the dragged frame range fills the viewport (vertical extent of the rectangle is ignored in v1). Cursor: magnifier with + / −.

### 12.12 Type (`T`)

- **TL-655 (MUST)** In the timeline the type tool behaves like the Selection tool for clicks on clips. Clicking in the Program Monitor creates a text clip at the playhead on the lowest targeted video track that is free at that range, or a new track above the topmost used one (Properties/graphics spec).

### 12.13 Agent tool (JasperEditor)

> **Superseded (wp-mcp, ARCHITECTURE D-18 / §11):** there is no in-app agent and no Agent tool; the tool was removed from the Tools panel.

- **TL-660 (MAY)** Dragging a clip edge beyond its media with the agent tool opens an agent request "extend this clip by N frames" (e.g. generative fill, freeze frame + motion, B-roll suggestion). Dragging across a gap asks "fill this gap". The request is a structured agent task referencing `(clipId|gap, frames)`; results arrive as proposals (TL-955). **[BEYOND]**

### 12.14 Tool/gesture matrix (summary)

| Tool | Body drag | Edge drag | Click | Modifiers |
|---|---|---|---|---|
| Selection | move (overwrite) | regular trim | select | Ctrl: insert move / ripple trim; Alt: duplicate / ignore link; Shift: toggle / axis constraint |
| Track Select Fwd/Back | select then move | – | select range | Shift: single track |
| Ripple | – | ripple trim | select / select edit point | Alt: ignore link |
| Rolling | – | roll | select edit point | Alt: ignore link |
| Rate Stretch | – | speed change | select | Ctrl: ripple variant; Alt: ignore link |
| Razor | – | – | split | Shift: all tracks; Alt: ignore link |
| Slip | slip | slip | select | Alt: ignore link |
| Slide | slide | slide | select | Alt: ignore link |
| Pen | keyframe edit | – | add keyframe | Shift: toggle; Ctrl: interpolation |
| Hand | pan | pan | – | – |
| Zoom | range zoom | – | zoom in | Alt: zoom out |

**Acceptance (§12)**
- AC-12a: Razor with Shift at frame 500 on a 6-track sequence splits all clips crossing 500 on unlocked tracks and none on locked tracks; one undo entry "Razor All Tracks".
- AC-12b: Slip of a clip with 10 frames of head handle stops after 10 frames of rightward drag.
- AC-12c: Slide of clip B between A and C by +12 frames lengthens A by 12, shortens C by 12, keeps B's source range, and total sequence length is unchanged.
- AC-12d: Rate-stretching a 100-frame clip at 100 % to 200 frames yields speed 0.5 and identical source range.

---

## 13. Non-gesture edit commands

All of these are commands (TL-051) with keyboard bindings (§19), menu entries and agent access.

- **TL-680 (MUST)** **Add Edit** (`Ctrl+K`): splits, at the playhead, every clip that crosses the playhead on **targeted** tracks (all unlocked tracks if none targeted), and their link partners. **Add Edit to All Tracks** (`Ctrl+Shift+K`): all unlocked tracks. If clips are selected, Premiere's behavior "Add Edit applies to selected clips when there is a selection" is used: only selected clips crossing the playhead are split. **[BEYOND]** Starter had a split button only, no key, and no targeting.
- **TL-681 (MUST)** **Clear** (`Delete` / `Backspace`): removes selected clips, leaving gaps; with selected gaps, see TL-741; with selected keyframes, deletes the keyframes; with selected markers, deletes the markers.
- **TL-682 (MUST)** **Ripple Delete** (`Shift+Delete`, and `Alt+Backspace` in the timeline): removes selected clips and closes the resulting space on their tracks. Algorithm (Appendix A.5): take the union of the removed clips' frame ranges (across all their tracks) as a list of disjoint ranges; process them right to left; each range is closed on every track that had a removed clip in it and on every sync-locked unlocked track, provided that after the removal the range is empty on all of those tracks. If some sync-locked track still has content in a range, the whole command is refused (as in Premiere) with a status message naming the blocking track.
- **TL-683 (MUST)** **Duplicate** (`Ctrl+Shift+/`, UI-SPEC §16.1): copies the selected clips to the first free space to the right on the same tracks (right after the selection's end, overwrite-free: if that space is occupied, placement moves to the first frame after which the whole span is free on all involved tracks). Alt+drag is the main duplicate gesture. **Note:** `Ctrl+D` is **Apply Default Video Transition** in the Premiere keymap, not duplicate. **[BEYOND]** keymap change relative to the starter.
- **TL-684 (MUST)** **Enable/Disable** (`Shift+E`): toggles `enabled` on selected clips; disabled clips are skipped by preview and export (their track space stays occupied).
- **TL-685 (MUST)** **Speed/Duration…** (`Ctrl+R`): dialog with speed %, duration (timecode), reverse, maintain audio pitch, and "Ripple edit, shifting trailing clips". Applies the same math as Rate Stretch; when "ripple" is unchecked and the new duration overlaps the next clip, the change is clamped to the free space (Premiere clamps).
- **TL-686 (MUST)** **Audio Gain…** (`G`): dialog to set/adjust clip gain in dB or normalize peak to X dB (peak from the waveform pyramid, TL-332) on selected audio clips.
- **TL-687 (SHOULD)** **Frame hold**: "Add Frame Hold" (split at playhead, the right part becomes a still of that frame, same duration) and "Insert Frame Hold Segment" (inserts N frames of still at the playhead, 2 s default, ripple). Represented as a clip carrying a "hold frame" flag and the held source time (data model spec).
- **TL-688 (SHOULD)** **Nest…**: replaces the selected clips with a single nested-sequence clip spanning their union range on the lowest selected track, creating a new sequence that contains them (relative timing preserved). Double-click on a nested clip opens that sequence in a new timeline tab.
- **TL-689 (MUST)** **Close Gap(s)**: with gaps selected, ripple-deletes them (TL-741). Panel menu "Close All Gaps" on selected tracks (agent-friendly), respecting sync-lock rules.

### 13.1 In/Out-based edits (three-point editing, timeline side)

- **TL-690 (MUST)** **Lift** (`;`): removes content inside the sequence In/Out range on targeted tracks (splitting clips at In and Out as needed), leaving a gap. **Extract** (`'`): removes the In/Out range from targeted tracks and then closes it. Sync-locked, unlocked, non-targeted tracks also lose the range (their content inside In/Out is removed too) so that everything stays in sync; this differs from the refusal rule of TL-543 because here the user explicitly marked the range. Tracks that are neither targeted nor sync-locked are untouched. After lift/extract, In/Out are cleared and the playhead goes to the old In.
- **TL-691 (MUST)** Lift/Extract require both In and Out; if either is missing the command is a no-op with the hint "Set In and Out first".
- **TL-692 (MUST)** Lifted/extracted content goes to the clipboard (Premiere does this), so `Ctrl+V` re-places it.
- **TL-693 (MUST)** **Insert** (`,`) and **Overwrite** (`.`) from the Source Monitor, and drag from the Source Monitor, place the source In/Out range onto **source-patched** tracks at the sequence In (or playhead when no sequence In is set). Three-point rules: given any three of source In/Out and sequence In/Out, the fourth is derived; if all four are set and durations differ, a dialog offers "Change clip speed (fit to fill)", "Ignore source In", "Ignore source Out", "Ignore sequence In", "Ignore sequence Out" (Premiere's fit-to-fill dialog). Insert ripples targeted-by-patch tracks and all sync-locked tracks at the insert frame; overwrite does not ripple. The source-monitor half of this feature belongs to the monitors spec; the timeline side (placement and ripple) is specified here. **[BEYOND]**
- **TL-694 (SHOULD)** **Replace edit**, **Fit to fill** (as a standalone command) and **Place on top** are later work; the command surface reserves ids for them.

### 13.2 Clipboard

- **TL-700 (MUST)** **Copy/Cut** (`Ctrl+C/X`) copies the selected clips with their relative timing and relative track offsets (for each kind separately), plus effects, keyframes, fades and link structure. Cut = copy + Clear (not ripple).
- **TL-701 (MUST)** **Paste** (`Ctrl+V`): places the clipboard at the playhead, overwrite semantics. Destination track: the **lowest targeted track** of each kind receives the clipboard's lowest track of that kind; higher copied tracks go to the tracks above/below per relative offset (creating tracks if needed). If no track of a kind is targeted, the original tracks are used. After paste, the playhead moves to the end of the pasted content (Premiere). Pasted clips are selected.
- **TL-702 (MUST)** **Paste Insert** (`Ctrl+Shift+V`): same destination rules, insert semantics (ripple on destination tracks and sync-locked tracks).
- **TL-703 (SHOULD)** **Paste Attributes…** (`Ctrl+Alt+V`): dialog selecting which properties (motion, opacity, volume, speed, effects, fades) to paste from the single copied clip onto the selected clips. **Remove Attributes…** mirrors it.
- **TL-705 (MUST)** The clipboard payload is a versioned JSON document (also written to the system clipboard with a custom MIME type and a plain-text description) so copy/paste works between sequences, between projects, between windows, and between the web app and Electron. Pasting text or image data from the OS clipboard into the timeline creates a text clip / image clip at the playhead (imported as an asset first for images).

### 13.3 Link, group

- **TL-704 (MUST)** **Link / Unlink** (`Ctrl+L`): Link joins the selected clips (at most one per track) into one link group; Unlink dissolves the group of every selected clip. **Group / Ungroup** (`Ctrl+G` / `Ctrl+Shift+G`): a group is a selection convenience (clicking any member selects all members), independent of links, that can span any tracks and times.
- **TL-716 (SHOULD)** **Move/Slip into sync** (out-of-sync badge menu, TL-326): computes the frame offset between the clip and its link partner and moves or slips this clip to remove it, refusing if the move would overwrite content (it tells the user which clip is in the way).

### 13.4 Navigation-adjacent edits

- **TL-710 (MUST)** **Match Frame** (`F`): for the topmost clip under the playhead on the highest targeted video track (or the selected clip), opens its source in the Source Monitor at the matching source frame, with source In/Out set to the clip's range (monitors spec).
- **TL-711 (SHOULD)** **Reverse Match Frame** (`Shift+R`): given the Source Monitor's current frame, finds the first clip in the sequence using that source frame and moves the playhead there.
- **TL-712 (SHOULD)** **Join Through Edits**: on selected through edits (or all in the selection range), merges the halves back into one clip.
- **TL-713 (SHOULD)** **Scene Edit Detection…**: on selected clips, requests scene-cut detection from the engine (NATIVE §5.6) and either adds cuts (razor at each scene change), adds clip markers, or creates subclips. Runs as a job; results applied as one undo entry.
- **TL-714 (SHOULD)** **Remove Silences**: engine silence detection (NATIVE §5.8) → proposed ripple deletes shown as an agent-style proposal (TL-955) that the user applies or rejects.

**Acceptance (§13)**
- AC-13a: With V1 and A1 targeted, `Ctrl+K` at frame 240 splits only V1/A1 clips crossing 240.
- AC-13b: Ripple Delete on a clip whose range contains content on a sync-locked, unlocked track is refused with a message; turning that track's sync lock off makes it succeed.
- AC-13c: Copy of clips on V2+V3, then paste with V1 targeted, puts them on V1+V2 at the playhead; the playhead ends at the end of the pasted span.
- AC-13d: Extract with In=100, Out=199 removes exactly 100 frames from targeted and sync-locked tracks and closes the space.

---

## 14. Gaps

- **TL-740 (MUST)** Clicking inside a gap (with the Selection tool) selects the gap: it is drawn with a light gray fill (UI-SPEC §9.6). Shift+click adds more gaps. Gap selection is cleared by any clip selection.
- **TL-741 (MUST)** With a gap selected, `Delete`/`Backspace` and Ripple Delete both **close the gap**: everything after the gap on that track shifts left by the gap length, and the same shift applies to sync-locked, unlocked tracks **only if** each of them is empty in the gap range (otherwise the command is refused, naming the blocking track; Premiere behaves the same).
- **TL-742 (MUST)** Right-click on a gap offers "Ripple Delete". Agents address gaps by `(trackId, startFrame)`.
- **TL-743 (SHOULD)** "Select all gaps on track" and "Close all gaps" commands for agents and power users.

---

## 15. In/Out points and the work area

### 15.1 Sequence In/Out

- **TL-760 (MUST)** A sequence has optional `inFrame` (inclusive) and `outFrameExclusive`. Mark Out at playhead `p` sets `outFrameExclusive = p + 1` (the Out frame is included, as in Premiere). The UI always shows the Out as the last included frame. Setting In after Out (or Out before In) clears the other mark. In/Out edits are **undoable** (Premiere treats marks as edits). **[BEYOND]** Starter had no In/Out.
- **TL-761 (MUST)** Keys: `I` Mark In, `O` Mark Out, `X` Mark Clip (In/Out around the clip under the playhead on the lowest targeted track, or around all targeted clips' union), `/` Mark Selection (union of selected clips), `Ctrl+Shift+I` / `Ctrl+Shift+O` / `Ctrl+Shift+X` clear In / Out / both (macOS `Opt+I/O/X`), `Shift+I` / `Shift+O` go to In / Out.
- **TL-762 (MUST)** Pressing `I`/`O` during playback sets the mark at the currently displayed frame and does not stop playback.
- **TL-763 (MUST)** Display: brackets in the ruler's In/Out lane, the range shaded on the ruler (stronger) and across all tracks (lighter) using UI-SPEC §3.3 tokens; when only In is set, shading runs from In to the sequence end; only Out, from 0 to Out.
- **TL-764 (MUST)** Interaction: drag a bracket in the ruler to move that mark (boundary rounding, snapping); drag the shaded band in the ruler (between brackets) to move both marks keeping their distance. Hover shows the mark's timecode.
- **TL-765 (MUST)** Consumers (the timeline publishes In/Out; consumers are specified elsewhere): export range default ("Source range: Sequence In/Out"), Play In to Out (`Ctrl+Shift+Space`), loop playback range, Lift/Extract (TL-690), three-point editing (TL-693), Render In to Out (TL-215), agent commands that take "the marked range".
- **TL-766 (MUST)** Mark Clip: when no track is targeted, uses the topmost clip under the playhead on any track.

### 15.2 Work area bar

- **TL-775 (SHOULD)** Optional work area bar (panel menu "Work Area Bar", off by default): a draggable range bar in the ruler with its own start/end, set also by `Alt+[` / `Alt+]` (Set Work Area In/Out at playhead). When shown, "Render ... Work Area" and "Export work area" options appear. Undoable like In/Out.

**Acceptance (§15)**
- AC-15a: `I` at 100, `O` at 199 displays a 100-frame duration (00:00:03:10 at 30 fps) and shading from 100 through 199 inclusive.
- AC-15b: Undo after `O` restores the previous Out.

---

## 16. Markers

- **TL-790 (MUST)** Sequence markers: `{id, frame, durationFrames (0 = point marker), name, comment, color (8 colors, UI-SPEC §3.3; default green), type (comment | chapter | segmentation | web link), url?, createdBy (user | agent id)}`. Undoable. **[BEYOND]** Starter had no markers.
- **TL-791 (MUST)** `M` adds a marker at the playhead; if a marker already exists at that exact frame, pressing `M` again opens its edit dialog (Premiere). During playback, `M` adds markers without stopping (one per press, at the displayed frame). If a clip is **selected** and the timeline is focused, `M` still adds a sequence marker (Premiere adds a clip marker only when the clip is open in the Source Monitor; we follow that; "Add Clip Marker" is a separate command bound to nothing by default).
- **TL-792 (MUST)** Navigation: `Shift+M` next marker, `Ctrl+Shift+M` previous marker (moves the playhead; scrolls into view). `Ctrl+Alt+M` clears the marker at the playhead (or selected markers); `Ctrl+Alt+Shift+M` clears all markers (with confirmation if > 10).
- **TL-793 (MUST)** Display: marker glyphs in the ruler marker lane (pentagon, marker color), duration markers show a bar to their end; hovering shows name + comment tooltip; a thin line may be drawn down through the tracks for the marker under hover.
- **TL-794 (MUST)** Interaction: click selects a marker (and seeks the playhead to it, Premiere-like); drag moves it (snapping, boundary rounding); Alt+drag on a point marker's right side creates/changes its duration; double-click opens the marker dialog (Name, In timecode, Duration, Comments, Color, Type, URL); Delete removes selected markers.
- **TL-795 (MUST)** Markers panel (UI-SPEC §17): list of sequence markers with filtering by color and search; clicking a row seeks; editing fields inline edits the marker. The timeline and the panel share the same data.
- **TL-800 (SHOULD)** Clip markers: markers stored on a clip in **source** time (so they move and stretch with the clip and stay on the same source moment through trims/slips/speed changes), drawn inside the clip body when "Show Clip Markers" is on. Created from the Source Monitor or by agents (e.g. "detected laughter here").
- **TL-805 (MUST)** Markers are snap targets (TL-451).
- **TL-806 (MUST)** Ripple behavior: when "Ripple sequence markers" is ON (default), ripple trims, ripple deletes, inserts and extracts shift sequence markers located after the edit frame by the same amount, and markers inside a removed range are deleted (with the edit, so undo restores them). When OFF, markers never move.
- **TL-807 (MUST)** Export: chapter markers become MP4 chapters / YouTube-description timestamps in export (rendering spec), and all markers export to OTIO markers (NATIVE §7) and FCP7 XML.
- **TL-808 (MUST)** Agents create markers as their primary way to annotate ("possible cut here", "bad audio"), with `createdBy` set and a distinctive outline (dashed) until a human edits or accepts them. **[BEYOND]**

**Acceptance (§16)**
- AC-16a: `M` twice on the same frame opens the dialog; editing color changes the ruler glyph color immediately.
- AC-16b: Ripple-deleting a 30-frame clip before a marker moves the marker 30 frames left (preference ON); with the preference OFF it stays.

---

## 17. Playhead, scrubbing, timecode

- **TL-830 (MUST)** The playhead position is owned by the **transport store** shared with the Program Monitor (single source of truth). The timeline reads it and requests seeks; it never keeps its own copy in React state (TL-155).
- **TL-831 (MUST)** Appearance per UI-SPEC §9.5 (blue head in the ruler, 1 px line through both regions). The head's hit area is ≥ 20 px wide. The line is drawn at the **left edge** of the current frame's cell; when `pxPerFrame ≥ 6`, a translucent fill of the frame cell width is drawn in the ruler under the head to show which frame is current.
- **TL-832 (MUST)** Scrubbing: pointer-down on the ruler or the playhead head seeks (TL-101 floor rule) and drag keeps seeking; during scrubbing the Program Monitor shows the frame under the playhead (it may show proxy/low-res frames while moving and settle to full quality within 150 ms after the pointer stops). Scrubbing pauses playback if it was playing and does **not** resume it on release.
- **TL-833 (MUST)** **Audio scrubbing** (`Shift+S` toggles; default ON): while scrubbing, each frame change plays a short grain (one frame of audio, ≥ 40 ms, with 5 ms fades) of the mixed sequence audio at that frame; when scrubbing faster than real time, grains are skipped rather than queued. Implementation: the preview audio path (Web Audio) with decoded audio from proxies; the engine may serve pre-decoded PCM windows. **[BEYOND]**
- **TL-834 (MUST)** Seek range `[0, end]`. The `End` key seeks to `end` (one past the last content frame, shows black); `Home` to 0.
- **TL-835 (MUST)** When the sequence becomes shorter than the playhead (after a delete), the playhead stays where it is (it may be beyond `end` temporarily; the Program shows black) until the next seek. (This avoids surprising jumps; Premiere behaves the same.)
- **TL-836 (MUST)** Timecode readout and entry per TL-205.

---

## 18. Transport and JKL shuttle

- **TL-870 (MUST)** Transport commands are shared by the timeline and the monitors (monitors spec owns buttons). The timeline must handle them when it has focus.
- **TL-871 (MUST)** `Space` toggles play/stop at 1× forward. Stop leaves the playhead where it stopped (preference "Return playhead to start position when stopped", default OFF).
- **TL-872 (MUST)** **JKL shuttle** state machine (Appendix A.8): `L` plays forward at 1×; each further `L` while playing forward steps up through 2×, 4×, 8×. `J` does the same in reverse. `K` stops. Pressing the opposite key while shuttling switches to 1× in the new direction. Holding `K` and tapping `J`/`L` steps one frame back/forward; holding `K` and **holding** `J`/`L` plays at 0.25× in that direction until release. `Shift+J` / `Shift+L` step the current rate down/up by 10 % increments within ±(0.1…1)× (slow shuttle, "verify" against Premiere). **[BEYOND]** Starter had space and arrows only.
- **TL-873 (MUST)** Rate realization: rates within the preview Player's supported playback-rate range (Remotion's `<Player>` accepts a `playbackRate` prop including negative values; confirm the exact bounds for the pinned version, expected ±4) are passed to the Player. Rates beyond it (8×, and anything unsupported, e.g. reverse on some browsers) switch to **seek-stepping**: the transport advances a virtual clock at the requested rate and issues seeks at ≤ 30 per second, displaying the nearest decodable frame (proxies strongly preferred). The playhead and timecode move smoothly on the virtual clock.
- **TL-874 (MUST)** Audio during shuttle: audible at 1× forward; at other rates muted in v1 (SHOULD later: pitch-corrected audio via Web Audio time-stretch for 0.5–2× forward).
- **TL-875 (MUST)** Playback stops at `end` (forward) or 0 (reverse), unless loop is on (loops within In/Out if set, else the whole sequence).
- **TL-876 (MUST)** Step: `←`/`→` one frame, `Shift+←`/`Shift+→` five frames (preference "Large trim/step offset", default 5). **[BEYOND]** Starter used one second for Shift+arrow.
- **TL-877 (MUST)** `Ctrl+Shift+Space` Play In to Out; `Shift+K` Play Around (plays from playhead − preroll to playhead + postroll, prefs default 2 s / 2 s, then returns to the start point).
- **TL-878 (SHOULD)** Loop toggle (monitor button; `Ctrl+L` is Link in the timeline scope, so loop has no default timeline key).
- **TL-879 (MUST)** `Home` / `End` go to sequence start / end.
- **TL-880 (MUST)** `↑` / `↓`: go to previous/next **edit point** on targeted tracks (all tracks if none targeted); `Shift+↑` / `Shift+↓`: on all tracks. Edit points considered: clip starts and ends, In/Out are not edit points. Implementation: merged sorted set of edit frames from the interval indexes, binary search from the playhead (Appendix A.7).
- **TL-881 (MUST)** `Page Up` / `Page Down`: scroll one screen (TL-113).
- **TL-882 (MUST)** During playback, the timeline keeps accepting: markers (`M`), In/Out (`I`/`O`), Add Edit (`Ctrl+K`; cuts at the displayed frame), JKL, and Space. Any gesture start (pointer-down on a clip) stops playback first.

**Acceptance (§18)**
- AC-18a: `L L L` yields 4×; `J` then yields −1×; `K` stops.
- AC-18b: `L` ×4 (8×) plays through seek-stepping without freezing the UI; timecode advances at 8× real time ± 5 %.
- AC-18c: Hold `K` + tap `L` five times advances exactly five frames.

---

## 19. Keyboard map (timeline scope)

- **TL-900 (MUST)** All shortcuts go through the single keymap registry (UI-SPEC §16.8): one capture-phase `keydown` listener, matching on `KeyboardEvent.code`, resolving the focused panel's scope first, then global. The timeline registers its commands with scope `timeline`; transport commands with scope `timeline | program | source`. Components never add their own key listeners. **[BEYOND]** Starter had a separate listener per shortcut and no remapping.
- **TL-901 (MUST)** Shortcuts are ignored while a text field, textarea or contenteditable has focus (except Escape/Enter handling in that field).
- **TL-902 (MUST)** Key repeat: navigation/step/nudge commands honor auto-repeat; toggles and tool switches ignore repeats; JKL uses keydown/keyup pairs (it needs "held" state) and ignores repeats.
- **TL-903 (MUST)** Default timeline keymap (Windows/Linux; macOS per UI-SPEC §16). Command ids are normative (agents use them).

| Command id | Default key | Notes |
|---|---|---|
| `transport.playStop` | Space | |
| `transport.shuttleReverse` / `shuttleStop` / `shuttleForward` | J / K / L | TL-872 |
| `transport.shuttleSlowReverse` / `shuttleSlowForward` | Shift+J / Shift+L | |
| `transport.stepBack` / `stepForward` | ← / → | 1 frame |
| `transport.stepBackMany` / `stepForwardMany` | Shift+← / Shift+→ | 5 frames |
| `transport.goToStart` / `goToEnd` | Home / End | |
| `transport.prevEdit` / `nextEdit` | ↑ / ↓ | targeted tracks |
| `transport.prevEditAny` / `nextEditAny` | Shift+↑ / Shift+↓ | all tracks |
| `transport.playInToOut` | Ctrl+Shift+Space | |
| `transport.playAround` | Shift+K | |
| `transport.toggleAudioScrub` | Shift+S | |
| `timeline.markIn` / `markOut` | I / O | |
| `timeline.markClip` / `markSelection` | X / / | |
| `timeline.clearIn` / `clearOut` / `clearInOut` | Ctrl+Shift+I / Ctrl+Shift+O / Ctrl+Shift+X | macOS Opt+I/O/X |
| `timeline.goToIn` / `goToOut` | Shift+I / Shift+O | |
| `timeline.lift` / `extract` | ; / ' | |
| `timeline.insertFromSource` / `overwriteFromSource` | , / . | |
| `timeline.addMarker` | M | |
| `timeline.nextMarker` / `prevMarker` | Shift+M / Ctrl+Shift+M | |
| `timeline.clearMarker` / `clearAllMarkers` | Ctrl+Alt+M / Ctrl+Alt+Shift+M | |
| `timeline.addEdit` / `addEditAllTracks` | Ctrl+K / Ctrl+Shift+K | |
| `timeline.rippleTrimPrevToPlayhead` / `rippleTrimNextToPlayhead` | Q / W | |
| `timeline.trimPrevToPlayhead` / `trimNextToPlayhead` | Alt+Q / Alt+W | |
| `timeline.extendEditToPlayhead` | E | |
| `timeline.cycleTrimType` | Shift+T | |
| `timeline.trimBack` / `trimForward` (selected edit points) | Ctrl+← / Ctrl+→ | verify; on macOS Cmd+arrows are nudge, so keep physical Ctrl+arrows there |
| `timeline.trimBackMany` / `trimForwardMany` | Ctrl+Shift+← / Ctrl+Shift+→ | verify |
| `timeline.nudgeLeft` / `nudgeRight` | Alt+← / Alt+→ | macOS Cmd+← / → |
| `timeline.nudgeLeftMany` / `nudgeRightMany` | Alt+Shift+← / → | |
| `timeline.nudgeUp` / `nudgeDown` (track) | Alt+↑ / Alt+↓ | |
| `timeline.slipLeft` / `slipRight` | Ctrl+Alt+← / → | +Shift = 5 |
| `timeline.slideLeft` / `slideRight` | Alt+, / Alt+. | +Shift = 5 |
| `timeline.clear` | Delete / Backspace | |
| `timeline.rippleDelete` | Shift+Delete, Alt+Backspace | |
| `timeline.selectAll` / `deselectAll` | Ctrl+A / Ctrl+Shift+A | |
| `timeline.selectClipAtPlayhead` | D | |
| `timeline.selectNextClip` / `selectPrevClip` | Shift+; / Ctrl+Shift+; | |
| `timeline.toggleSnap` | S | |
| `timeline.linkUnlink` | Ctrl+L | |
| `timeline.group` / `ungroup` | Ctrl+G / Ctrl+Shift+G | |
| `timeline.toggleEnable` | Shift+E | |
| `timeline.speedDuration` | Ctrl+R | |
| `timeline.audioGain` | G | |
| `timeline.matchFrame` / `reverseMatchFrame` | F / Shift+R | |
| `timeline.applyDefaultVideoTransition` / `...Audio...` | Ctrl+D / Ctrl+Shift+D | transitions spec |
| `timeline.duplicate` | Ctrl+Shift+/ | |
| `timeline.copy` / `cut` / `paste` / `pasteInsert` / `pasteAttributes` | Ctrl+C / X / V / Ctrl+Shift+V / Ctrl+Alt+V | |
| `timeline.zoomIn` / `zoomOut` | = / - | numpad + / - too |
| `timeline.zoomToSequence` | \ | toggle |
| `timeline.videoTracksTaller` / `Shorter` | Ctrl+= / Ctrl+- | |
| `timeline.audioTracksTaller` / `Shorter` | Alt+= / Alt+- | |
| `timeline.expandAllTracks` / `minimizeAllTracks` | Shift+= / Shift+- | |
| `timeline.pageLeft` / `pageRight` | Page Up / Page Down | |
| `timeline.renderInToOut` | Enter | |
| `timeline.setWorkAreaIn` / `setWorkAreaOut` | Alt+[ / Alt+] | |
| `tool.selection` … `tool.type` | V, A, Shift+A, B, N, R, C, Y, U, P, H, Z, T | TL-590 |
| `history.undo` / `redo` | Ctrl+Z / Ctrl+Shift+Z (also Ctrl+Y) | global |
| `gesture.cancel` | Escape | cancels the active gesture; otherwise deselects |

- **TL-904 (MUST)** Conflicts resolved relative to the starter's bindings: snapping moves to `S`; `Shift+M` becomes next marker; `Ctrl+D` becomes the default video transition (duplicate moves to `Ctrl+Shift+/` and Alt+drag); `Shift+→` steps 5 frames instead of a second. The redo binding must match `Z` regardless of Shift changing the reported key (using `code` avoids this class of bug).
- **TL-905 (MUST)** Every command in the table is callable by agents and from the command palette (`Ctrl+Shift+P`, global) with the same id.

---

## 20. Context menus

- **TL-930 (MUST)** Clip context menu (right-click; long-press on touch): Cut, Copy, Paste Attributes…, Remove Attributes…, Clear, Ripple Delete, Enable, Link/Unlink, Group/Ungroup, Nest…, Label ▸, Speed/Duration…, Audio Gain…, Add Frame Hold, Insert Frame Hold Segment, Scene Edit Detection…, Rename…, Reveal in Project, Reveal in Explorer/Finder (Electron only), Properties, **Engine ▸** (for Remotion/fframes clips: Re-render preview, Open template parameters, Convert to rendered media), **Agent ▸** (Describe this clip, Suggest trims, Find B-roll, Transcribe, Remove silences). The full Premiere list in UI-SPEC §18 is the target; entries whose feature is not yet implemented are hidden, not disabled. **[BEYOND]** Starter offered cut/copy/duplicate and layer ordering only.
- **TL-931 (MUST)** Right-clicking a clip that is not selected selects it first (link group expansion applies).
- **TL-932 (MUST)** Gap context menu: Ripple Delete, Agent ▸ Fill gap.
- **TL-933 (MUST)** Track header context menu: TL-265.
- **TL-934 (MUST)** Ruler context menu: Add Marker, Clear In/Out, Time display format ▸, Work Area Bar, Render In to Out.
- **TL-935 (MUST)** Marker context menu: Edit…, Color ▸, Delete, Ripple markers toggle.

---

## 21. Agent control of the timeline

The agent API spec owns transport, auth and prompting. This section fixes what the timeline must expose.

- **TL-950 (MUST)** **Headless operation**: every edit command in this spec runs against a document without any UI mounted (in the web app, in the engine, and in tests). Commands that normally depend on UI context take explicit arguments instead (e.g. `timeline.razorAt {trackIds|all, frame, ignoreLinks}` instead of pointer position; `timeline.moveClips {clipIds, deltaFrames, trackOffset, mode: overwrite|insert}`; `timeline.trimEdge {clipId, side, deltaFrames, type: regular|ripple|roll|stretch}`; `timeline.slip {clipId, deltaFrames}`; `timeline.slide {clipId, deltaFrames}`).
- **TL-951 (MUST)** **Query API** (read-only, JSON): sequence summary (fps, end, tracks with flags), clips in a frame range (with resolved source ranges in seconds and timecode), gaps, edit points, markers, In/Out, selection, playhead, visible range, current tool; plus derived info: effective mute per track, out-of-sync pairs, render-bar segments. Frames are integers; every frame value is also returned as timecode strings for LLM readability.
- **TL-952 (MUST)** **Semantic addressing**: agents may address things by id, or by `(trackName, timecode)` ("the clip on V1 at 00:01:02:10"), by marker name, or by "the marked range". The command layer resolves these to ids before execution and returns the resolved ids in the result.
- **TL-953 (MUST)** Agents obey the same rules as humans: locked tracks, sync lock, no-overlap, media limits. A refused command returns a structured reason (`LOCKED_TRACK`, `MEDIA_LIMIT`, `SYNC_LOCK_CONFLICT`, `WOULD_OVERLAP`, `INVALID_RANGE`, `KIND_MISMATCH`, ...) and the blocking object ids, so the agent can adapt.
- **TL-954 (MUST)** Agent edits are recorded in history with the "Agent: …" label and the agent/session id; a whole multi-step agent plan executed as a transaction is one history entry (TL-055). After an agent applies edits, the affected clips flash (200 ms outline pulse) and, if they are off-screen, a small arrow chip at the viewport edge offers "Show".
- **TL-955 (MUST)** **Proposals**: an agent can submit a dry-run transaction (TL-058) as a proposal. The timeline draws proposal ghosts on the overlay layer (dashed accent outline, 30 % accent fill for added/changed clips, red hatch for removed ranges, arrows for shifts; UI-SPEC §17 "Agent"), without modifying the document. The Agent panel **[SUPERSEDED: no Agent panel; a future MCP tool would own proposals]** lists proposals; Apply commits the transaction (re-validated against the current document; if it no longer applies cleanly the agent is asked to re-plan), Reject discards it. Multiple proposals can be visible; the focused one is drawn on top. **[BEYOND]**
- **TL-956 (MUST)** **View control for agents**: `timeline.reveal {clipId | frame | range}` scrolls/zooms to show the target; `timeline.setPlayhead {frame}`; `timeline.select {ids}`; `timeline.zoomToRange`. These let an agent "show" the user what it is talking about. View commands are not undoable and never change the document.
- **TL-957 (MUST)** Concurrency: agent commands arriving during a user gesture queue until the gesture ends (TL-056); if an agent transaction touches clips the user changed since the agent read the state (version check on a per-clip revision counter), it is rejected with `STALE` and the agent re-reads.
- **TL-958 (SHOULD)** Event stream: the timeline emits `selection.changed`, `playhead.changed` (throttled to 10 Hz), `document.changed {changes}`, `gesture.began/ended` so agents can react ("you just cut here; want me to add a J-cut?").
- **TL-959 (SHOULD)** Interchange for agents: the whole sequence can be exported/imported as OTIO JSON (NATIVE §7) with JasperEditor data under `metadata.jasper`, so agents can reason with a standard schema; the import path goes through commands (one transaction).

**Acceptance (§21)**
- AC-21a: A test harness runs 100 random agent commands headlessly; the document invariants (TL-016/017/015) hold after each; each refusal carries a reason code.
- AC-21b: A proposal that removes three silences is drawn as ghosts; Apply produces exactly one undo entry "Agent: Remove silences"; undo restores everything.

---

## 22. Three-engine integration (what the timeline must do)

- **TL-980 (MUST)** The timeline is engine-agnostic for editing: all edits operate on the common clip model. Engine differences appear only in content drawing (thumbnails), badges, the render bar and context-menu entries.
- **TL-981 (MUST)** Thumbnails by engine:
  - `native` media: media preview provider (TL-329) using ffmpeg in the engine or browser decoding in a Worker;
  - `remotion` clips (text, shapes, captions, compositions): rendered stills of the clip's composition at the slot times. In the browser, an offscreen rendering path renders the composition frame to a bitmap (throttled, lowest priority); with the engine, the engine's Remotion renderer produces stills. Text-only clips MAY skip thumbnails and show the text content in the body instead;
  - `fframes` clips: the fframes WASM module (FFRAMES §7 design B) renders the frame to SVG, rasterized to a bitmap in a Worker; or the engine's fframes CLI renders a frame (FFRAMES design C). While unavailable, a diagonal-stripe placeholder in the clip's label color is shown.
  All thumbnail sources feed the same cache (TL-329) keyed by a content hash of the clip's parameters instead of an asset id for generated content, so parameter edits invalidate thumbnails.
- **TL-982 (MUST)** Clips whose engine render is pending/in progress (e.g. an fframes clip waiting for its alpha proxy, FFRAMES §7) show progress in the badge (TL-325) and the render bar (TL-214), and remain fully editable. Edits that change timing do not re-render; edits that change parameters do (engine's decision).
- **TL-983 (MUST)** Proxies: when a proxy exists and proxies are enabled, the Program preview uses it; the timeline shows the proxy badge. Thumbnails and waveforms are always generated from the **original** (at thumbnail resolution), so they don't change when proxies toggle.
- **TL-984 (SHOULD)** Lossless-export aid: when the export spec's "lossless cut" mode is selected, edit points on native clips that do not fall on source keyframes get a small warning tick (TL-456), and a command "Snap cuts to nearest keyframes" is offered.
- **TL-985 (MUST)** Missing media: offline clips (asset not reachable) keep their timing and are drawn per TL-322; relinking (project spec) restores them without changing the timeline.

---

## 23. Touch and PWA

The phone/tablet shells are defined in UI-SPEC §19. This section fixes timeline behavior in those shells.

- **TL-1000 (MUST)** Phone shell: **fixed center playhead**. Horizontal drag on the track area scrolls content under it and scrubs (`scrollFrame` and playhead move together); momentum scrolling when paused, disabled while playing (dragging while playing pauses). Pinch horizontally zooms anchored on the playhead. Vertical pan scrolls tracks.
- **TL-1001 (MUST)** Tap on a clip selects it (single selection; no multi-select in the phone shell v1); the selected clip shows large trim handles (16 px visual, 44 px hit area, UI-SPEC §19.2). Dragging handles trims: **ripple** on the main video track (V1) and regular trim on other tracks (Rush-style), with snapping always on.
- **TL-1002 (MUST)** Tap on empty space deselects. Tap on the ruler seeks.
- **TL-1003 (MUST)** Long-press (350 ms) on a clip lifts it (visual scale 1.03 + shadow) and starts a move; on V1 the move is a **rearrange** (extract + insert, TL-489); on other tracks, an overwrite move. Dragging to another row changes track (kind-safe).
- **TL-1004 (MUST)** Split at the playhead via the contextual toolbar (no razor tool on phones). Delete in the toolbar = ripple delete on V1, clear elsewhere.
- **TL-1005 (MUST)** Track headers collapse to a 32 px icon column; lock/mute/eye through a long-press menu; targeting and patching hidden; commands that normally use targeting use the selected clip's track or V1/A1.
- **TL-1006 (MUST)** Haptics on snap engage (Android `navigator.vibrate(10)`; iOS: visual pulse only).
- **TL-1007 (MUST)** Tablet shell: real headers and a movable playhead as on desktop; touch gestures as above; Pencil/trackpad behave like a mouse. A hardware keyboard enables the full keymap.
- **TL-1008 (MUST)** All timeline surfaces use `touch-action: none` and Pointer Events with multi-pointer tracking; the browser's pull-to-refresh and back-swipe are disabled on the timeline (UI-SPEC §19.4).
- **TL-1009 (MUST)** Touch hit areas ≥ 44 px for every interactive element in the touch shells (edges, handles, headers, markers).

---

## 24. Platform specifics

- **TL-1030 (MUST)** Web/PWA: browser-reserved key combos that the keymap cannot receive get alternatives shown in menus (UI-SPEC §16.8); none of the timeline defaults in §19 is browser-reserved except possibly `Ctrl+Shift+A` in some browsers (verify; alternative `Alt+Shift+A`).
- **TL-1031 (MUST)** Electron: menu accelerators forward to the same command ids; native file drag-in passes file paths to the engine (no upload); "Reveal in Finder/Explorer" available.
- **TL-1032 (MUST)** Wheel defaults follow the OS (TL-111); detected by platform in Electron and by `navigator.userAgentData`/UA in the browser.
- **TL-1033 (MUST)** The timeline works identically whether thumbnails/peaks come from the engine or the browser fallback; only speed differs. When the engine becomes reachable mid-session, providers switch transparently and caches are reused.

---

## 25. Testing and acceptance

- **TL-1050 (MUST)** Unit tests for every edit-core operation with table-driven cases covering: normal, at media limits, at neighbors, at frame 0, with speed ≠ 1, reversed clips, linked clips with Alt, locked and sync-locked tracks, transitions present (once transitions exist).
- **TL-1051 (MUST)** Property-based tests (random documents × random commands): invariants TL-015/016/017 hold; `undo(redo(x)) = x`; applying a command's dry-run `changes` equals the committed diff.
- **TL-1052 (MUST)** A development-mode invariant checker runs after every committed command and reports violations with the command id and arguments.
- **TL-1053 (MUST)** Math tests: `xToFrame(frameToX(f)) = f` round trips across zoom levels; zoom anchoring keeps the anchor within 0.5 px; drop-frame timecode conversion round-trips for every frame of 24 h at 29.97 and 59.94.
- **TL-1054 (MUST)** End-to-end tests (Playwright, desktop Chromium + WebKit + mobile emulation) for: drag move overwrite/insert, trim/ripple/roll, razor, slip/slide, marquee, JKL, In/Out + extract, markers, touch trim, agent proposal apply/reject.
- **TL-1055 (MUST)** Performance tests with a synthetic 3 000-clip, 2 h sequence measuring TL-160 budgets in CI (headless Chromium, fixed CPU throttling baseline); regressions > 20 % fail the build.
- **TL-1056 (SHOULD)** Visual regression snapshots of the timeline at fixed zooms (clip states, badges, locked hatch, In/Out shading, proposals).

---

## 26. Where JasperEditor goes beyond the starter (summary)

| Area | Starter capability (behavioral summary) | JasperEditor requirement |
|---|---|---|
| Time/zoom | Whole-sequence-width scroll element with a width cap; slider-only zoom anchored on the playhead | Unbounded viewport model, frame-level zoom at any length, wheel/pinch/keys/zoom-bar, pointer anchoring (TL-100–113) |
| Rendering | All clips mounted; per-clip canvases can exceed limits; per-frame React updates for the playhead | Virtualized clips and tracks, tiled canvases, direct-DOM playhead (TL-150–160) |
| Timecode | Minutes:seconds labels | SMPTE NDF/DF, frames, typed entry with relative offsets (TL-004, TL-201–205) |
| Tracks | Untyped, auto-created/auto-deleted, hide + mute only, content-derived heights | Typed V/A stacks, split regions, lock, target, source patch, sync lock, eye, mute, solo, rename, resize, add/delete (§6) |
| Move | Collision avoidance (push to nearest gap or refuse) | Premiere overwrite/insert/duplicate/rearrange semantics, linked A/V pairs (§10) |
| Trim | Regular trim to neighbor; roll only at exact butt edits via a hotspot | Regular/ripple/roll/rate-stretch, edit-point selection, keyboard trims, Q/W/E, two-up monitor, sync-lock rules (§11) |
| Tools | None (split button only) | Full Premiere tool set + agent tool (§12) |
| Split | Speed-unaware source math | Speed-aware, keyframe/fade/link-aware split (Appendix A.6) |
| Edits | Delete leaves gaps; copy/paste; duplicate | Ripple delete, gaps as objects, lift/extract, 3-point insert/overwrite, paste insert/attributes, link/group, nest, frame hold (§13–14) |
| In/Out, markers | None | Full In/Out, work area, sequence + clip markers with ripple and export (§15–16) |
| Transport | Space + arrows (Shift = 1 s) | JKL shuttle with seek-stepping beyond Player limits, audio scrubbing, edit/marker navigation, play around (§17–18) |
| Keyboard | Per-component listeners, fixed keys | Central remappable registry, Premiere keymap, command ids shared with agents (§19) |
| Media previews | Main-thread browser decoding, memory-only caches, single-resolution mono peaks | Engine-generated, disk/OPFS-cached thumbnails and min/max multi-resolution per-channel peaks; Worker fallback (TL-328–334) |
| Audio | One static gain per clip, fades | Clip gain + keyframed volume lane, audio taper mapping, stereo lanes, clipping hint (TL-331–346) |
| Engines | Browser preview only | Engine badges, render bar, Remotion/fframes thumbnails, proxies (§22) |
| Agents | None | Headless commands, queries, proposals with ghosts, reason codes, view control (§21) |
| Touch | Desktop layout only | Rush-style phone timeline, tablet shell (§23) |

---

## 27. Open questions

1. Confirm the Remotion Player's supported `playbackRate` range and reverse-playback behavior in the pinned version (TL-873).
2. Confirm current Premiere defaults for keyboard trimming of selected edit points (TL-548) and slow shuttle steps (TL-872).
3. Decide whether "Ripple sequence markers" defaults ON (TL-806); Premiere has changed this default across versions.
4. Offscreen rendering of Remotion composition thumbnails in the browser (TL-981): choose between a hidden Player instance per request batch or delegating to the engine only.
5. Whether transitions attached to edit points constrain roll/ripple as Premiere does (needs the transitions spec).
6. Whether gap selection should also be possible with the Ripple tool (Premiere: yes).

---

## Appendix A: Algorithms (conceptual)

### A.1 Drop-frame timecode

For 29.97 (drop 2 frame numbers per minute except every 10th minute; 59.94 drops 4):
- `D = 2` (or 4), `framesPer10Min = round(fps_nominal * 600) - 9 * D` (17 982 at 29.97), `framesPerMin = round(fps_nominal * 60) - D` (1 798).
- Frame count → timecode: `d = floor(f / framesPer10Min)`, `m = f mod framesPer10Min`; if `m > D`, `f' = f + 9*D*d + D * floor((m - D) / framesPerMin)`, else `f' = f + 9*D*d`; then format `f'` as non-drop at the nominal rate (30 or 60) with `;` separators.
- Timecode → frame count: `totalMinutes = 60*H + M`; `f = (nominal*3600*H + nominal*60*M + nominal*S + F) - D * (totalMinutes - floor(totalMinutes / 10))`.
- Invalid DF timecodes (e.g. `00:01:00;00`) are normalized to the next valid frame on entry.

### A.2 Zoom anchoring

Given old `(s, p)` (scrollFrame, pxPerFrame), anchor screen x `a` and new `p'`: `anchorFrame = s + a/p`; `s' = anchorFrame - a/p'`; clamp `s'` to TL-110.

### A.3 Snapping

1. At gesture begin build `T`, a sorted array of `(frame, priority, kind, sourceId)`.
2. On update, for each moving edge frame `e` (after applying the raw delta): binary-search `T` for the insertion index of `e`; examine the neighbors at index−1 and index; compute distances.
3. Keep candidates with `|distance| ≤ thresholdFrames`; pick the one with the smallest distance, then highest priority, then the edge closest to the pointer.
4. Apply `delta += (target - e)`; re-validate limits (limits win over snapping: if the snapped delta violates a limit, fall back to the unsnapped clamped delta and show no indicator).

### A.4 Overwrite placement

For a destination range `[a, b)` on a track, for each existing clip `C` intersecting it (found via the interval index):
- `C` entirely inside → remove;
- `C` covers both ends → split into left `[C.start, a)` and right `[b, C.end)` (right part gets `sourceIn` advanced per speed-aware math, a new id, and a new link group mirroring its partners' treatment);
- `C` overlaps only the left end → trim its out to `a`;
- `C` overlaps only the right end → trim its in to `b` (source advanced).
Linked partners of overwritten clips on other tracks are **not** automatically trimmed (their own tracks are processed only if they are also destination tracks); they become partially unlinked content, which is Premiere's behavior.

### A.5 Ripple delete / insert shift

Insert of length `n` at frame `f` on track set `S` (destination tracks + sync-locked unlocked tracks): for each track in `S`, split any clip straddling `f`, then shift every clip with `start ≥ f` by `+n` (iterate from right to left to keep the no-overlap invariant during the operation). Markers after `f` shift if TL-806 is on.
Ripple removal of `[f, f+n)` from track set `S`: verify for each track in `S` that the range is empty after the explicit deletions (otherwise refuse with the blocking track); then shift every clip with `start ≥ f+n` by `-n` (iterate left to right).

### A.6 Split at frame `f` (clip `C`, `C.start < f < C.end`)

- Left: same id, `duration = f - C.start`, `fadeOut` and `audioFadeOut` set to 0 (they belong to the right part), `fadeIn` clamped to the new duration.
- Right: new id, `start = f`, `duration = C.end - f`, `sourceIn = C.sourceIn + (f - C.start) * frameFlicks * speed` (reversed: left part's source range shrinks from the other end instead), `fadeIn` and `audioFadeIn` = 0, keeps the fade-outs clamped.
- Keyframes: for each lane, the value at `f` is evaluated; left gets keyframes `< f` plus a boundary keyframe at its last frame with that value; right gets keyframes `≥ f` re-based to its own start plus a boundary keyframe at 0 with that value (hold/bezier interpolation preserved where possible).
- Clip markers (source time) go to whichever part contains their source time.
- Links: all linked partners are split at the same frame (unless Alt); the left parts keep the original link group, the right parts get a new shared link group.
- Transitions at the original clip's edges stay attached to the corresponding outer edges.
- Effects are duplicated onto the right part.

### A.7 Edit-point navigation

Maintain, per track, the sorted list of clip boundaries (starts and ends). For a set of tracks, merge lazily (k-way) or keep a sorted multiset updated from `changes`. Next edit = smallest boundary `> playhead`; previous = largest `< playhead`. The sequence end counts as an edit point; frame 0 counts only if a clip starts there.

### A.8 JKL state machine

State `{direction ∈ {-1, 0, +1}, step ∈ {0,1,2,3}, kHeld: bool}`, rates `[1, 2, 4, 8]`.
- `L` down (not repeat): if `kHeld` → step forward one frame (and start a 250 ms timer; if `L` is still held when it fires, play at +0.25× until `L` up). Else if `direction = +1` → `step = min(step+1, 3)`; else `direction = +1, step = 0`.
- `J` symmetric with `-1`.
- `K` down: `direction = 0` (pause), `kHeld = true`. `K` up: `kHeld = false`.
- Effective rate = `direction * rates[step]`. Rates outside the Player's supported range use seek-stepping (TL-873).
- Space while shuttling: stop; Space again: play at 1× forward.

### A.9 Tick interval choice

Candidates (in frames) from TL-201 sorted ascending; pick the first `c` with `c * pxPerFrame ≥ 80`; minor subdivision = first of `[10, 5, 4, 2]` such that `c / k` is an integer number of frames (or allows fractional-second grid at high zoom) and `(c / k) * pxPerFrame ≥ 8`; when `pxPerFrame ≥ 6`, add per-frame ticks.

### A.10 Waveform level choice

`pixelSourceFlicks = frameFlicks * speed / (pxPerFrame * dpr)`; level `L` pair duration = `256 * 2^L / sampleRate` seconds; choose the largest `L` with pair duration ≤ `pixelSourceFlicks` (in seconds); if none (extreme zoom-in), use level 0 and interpolate between pairs (MAY request raw samples from the engine for sample-level display later).
