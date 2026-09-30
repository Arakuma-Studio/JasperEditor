# wp-3v: Premiere Pro visual QA and polish

The goal was to make the Editing workspace look and feel like Premiere Pro. It was checked against
`docs/research/premiere-ui-design-spec.md` (R-PUI) and `docs/specs/05-ui-shell-premiere-design.md` (S05).
All fixes are styling or layout changes. The one exception is a waveform stream lookup bug that stopped
every A/V clip from drawing a waveform. No command or model logic was changed.

## How the screenshots were made

- **Build and engine.** Ran `pnpm build` and `pnpm fixtures`. The engine ran from
  `apps/engine/dist/engine.mjs --port 48250` with a temporary appdir and `JASPER_WEB_DIR=apps/web/dist`.
- **Browser.** agent-browser (Chromium) at 1920×1080, and at 390×844 for the phone shot.
- **Project.** "Premiere QA", 1080p30. The fixture media was imported by dropping `File`s on the
  Project panel.
- **Timeline content**, placed through the in-page agent bridge (`window.jasper.transact`):
  - V1/A1: clip-a (linked A/V movie, violet)
  - V2/A2: clip-b (linked)
  - V2: still.png
  - A2: tone.wav
  - V3: a Remotion text clip and an fframes "Lower Third" motion graphic
  - two sequence markers
  - Scale and Opacity keyframes on the V1 clip, for Effect Controls
- **Before shots:** `docs/screenshots/m1/before/`. **After shots:** `docs/screenshots/m1/after/`. File
  names match, so the two folders form before/after pairs:
  - 01 whole Editing workspace
  - 02 timeline close-up
  - 03 Source and Program monitors
  - 04 Project list view
  - 05 Project icon view
  - 06 Effect Controls with keyframes
  - 07 Tools panel
  - 08 Export mode
  - 09 Home
  - 10 phone at 390×844
- **After-only shots:** 11 tooltip, 12 menubar menu, 13 Program monitor with the fframes lower third.
- **Iterations.** Five screenshot rounds in total (r1 to r5, then the final `after/` set). Each round
  re-checked the previous fixes.
- **Runtime errors.** No page errors were reported (`agent-browser errors` was empty after every round).

## Discrepancies found and fixed

| # | Area | What was wrong (vs spec) | Fix |
|---|---|---|---|
| 1 | Timeline timecode | The playhead-position timecode rendered at about 12 px in the monospace font. `text-[var(--pr-font-size-timeline-tc)]` is read by Tailwind as a *color*, so the 18 px size never applied. Spec: 18 px UI font, tabular digits (R-PUI §4.2, TY-003/004) | `text-[length:…]` + `font-pr` + `pr-tabular` (`Playhead.tsx`) |
| 2 | Focus model | The focused panel's 1 px blue outline was invisible. The ring was an outline on `.dv-groupview`, painted under panel content and under the keep-alive render overlays (Program, Timeline). Spec: FO-002 | Drawn as a `::after` overlay (z 60), also used for the maximized frame (`dockview.css`) |
| 3 | Waveforms | No A/V clip showed a waveform. Clips address audio by container stream index (1 for a movie), but the engine writes peaks per audio ordinal (`0:a:k` → `0.bin`). The client asked for `peaks/1.bin` and got a 404 | `audioOrdinal()` maps index → ordinal (`media-cache.ts`), with a unit test |
| 4 | Waveforms | A −18 dBFS tone drew as a 3 px sliver on a 40 px track | Logarithmic display scale (`waveHeight`, −48 dB floor), with a unit test. Premiere also draws waveforms on a log scale |
| 5 | Timeline tabs | "Timeline: Sequence 01" dock tab plus a second 28 px row "× Sequence 01", so the sequence was named twice. Premiere shows one "Sequence 01 ≡" tab (R-PUI §9.1) | The dock tab shows the sequence name. The inner strip only appears with 2+ open sequences. The playhead overlay offset now follows it reactively |
| 6 | Timeline lanes | Lanes used `--pr-bg-field` (#0e0e0e). Spec track area: `--pr-bg-panel-alt` (R-PUI §3.2) | panel-alt; targeted lanes use panel-raised, like their headers |
| 7 | Timeline playhead | The line started below the render bar, leaving a gap under the head | The line hangs from the head's tip through the ruler (R-PUI §9.5) |
| 8 | Track headers | Sync Lock used the chain glyph (the same as Linked Selection) and was drawn blue | Custom glyph: a clip frame with sync arrows when on, an empty box when off, neutral icon color (R-PUI §9.3) |
| 9 | Track headers | Mute/Solo "on" fills used the success green and the meter yellow. Spec: `#1c8a3a` / `#d8b400` with dark text | `--pr-track-mute`, `--pr-track-solo`, `--pr-track-solo-text` tokens |
| 10 | Narrow panels | The Tools tab rendered a clipped, empty title. The Audio Meters tab showed "A." | Fixed-width panels (`fixedAxis: 'width'`) show only the centered ≡ glyph. The title stays as tooltip/aria-label |
| 11 | Audio Meters | The dB scale was left of the bars. Spec: stereo pair with the scale on the right, S under each channel (R-PUI §15.1) | Layout swapped |
| 12 | Monitors | The mini-ruler playhead head was a 6 px triangle. Markers were squares in the dark clip-label body colors | 12 px blue pentagon head. Pentagon marker glyphs in the marker palette (same mapping as the Timeline) |
| 13 | Source monitor | Tab read "Source" with a clip loaded. The title context never received the source item (PC-002) | "Source: clip-b.mp4" |
| 14 | Source monitor | Empty monitor showed a duration of 00:00:00:01 | 00:00:00:00 when no clip is loaded |
| 15 | Effect Controls | Mini-timeline ruler labels overlapped ("00:00:00:0000:00:02:00…") | Label density follows width (about 1 per 64 px), hour field dropped, overflow clipped |
| 16 | Project panel | The primary selected row looked like every other selected row. Spec CT-041: accent fill + white text in the focused panel | `data-primary` + CSS rule scoped to `.pr-focused` |
| 17 | Tooltips | Tools and monitor transport buttons used native `title` tooltips (OS-styled, not TT-001) | Wrapped in the shared `Tooltip` ("Razor Tool (C)") |
| 18 | Export mode | The preview was a 320 px poster floating in a huge black well | Shown at up to 2× (640 px). A larger size just blurs the 320 px derivative |
| 19 | Home | Black main area, 12 px heading, cards on `--pr-bg-panel` (almost invisible) | Panel surfaces, 16/600 heading, cards on panel-raised, rail on panel-alt with a divider |
| 20 | Phone (390×844) | The compact desktop preset was squeezed into a phone: Program, Properties side by side, plus meters | New `phone` layout preset: viewer on top, timeline below, inspectors and bins as tabs. The dedicated touch shell (S05 §19.2) is still to come |

Verified as matching the spec, no change needed:
- palette tokens (`tokens.css` matches R-PUI §3.2/§3.3 exactly)
- 28 px tab strips with 12 px text and a 2 px `#cecece` underline
- 3 px black gutters and 4 px frame radius
- 36 px header with Import/Edit/Export and blue workspace tabs
- 28 px Row A menubar
- menus: 24 px rows, right-aligned shortcuts, `#444` border
- clip label colors (movie = Violet, audio = Caribbean, still/text = Lavender, fframes = Purple, sequence = Forest)
- blue 12 px playhead head
- blue timecodes (14 px monitors, 12 px Effect Controls)
- 40 px Tools strip with a filled current tool and flyout triangles
- Properties sections and blue scrubby values
- Source Sans 3 loaded

## Remaining gaps (not done)

- **Monitor zoom scroll bar** (PGM-004) is missing in both monitors. The mini ruler always shows the
  full duration. This needs real zoom/pan behaviour, not styling.
- **Monitor transport** has no Export Frame button or `＋` Button Editor. The Source bar has no Add Marker.
- **Source patching** (TLC-005): no `V1`/`A1` patch column appears in the track headers when Source
  has a clip.
- **Default track targeting** (TLC-005): V1/A1 are not targeted by default (`defaultSequenceView()`
  targeting is empty), so all target pills are grey outlines. Premiere targets V1 and A1. This is
  session/command semantics, so it was left alone.
- **Linked Selection menu item** is disabled and unchecked in the Sequence menu, while the timeline
  toolbar shows it on. This comes from the command enablement state, not styling.
- **Lease after reload:** reloading the page leaves the project read-only ("open in another session")
  until "Take over editing" is used or the lease expires. The lease is not released on
  pagehide/unload. This is persistence logic, out of scope; it should be picked up by the lifecycle owner.
- **Timeline toolbar** lacks the "Insert/overwrite sequences as nests" and captions toggles.
- **Export mode:**
  - the preview is still the 320 px poster, not a rendered export frame
  - section headers are uppercase
  - no "Add to Queue"
- **Phone/tablet:** the touch shells (MB-010…014) are still not built. The phone preset is a stop-gap
  and still uses 176 px desktop track headers.
- **Audio Meters** show no live levels (MTR-002). At 52 px the bottom "dB/S" row is cramped.
- **Tooltips:** track-header M/S/target and a few other raw buttons still use native `title` tooltips.
- **Waveform log floor:** the −48 dB floor is an eyeballed value. A Timeline preference
  ("Logarithmic Waveform Scaling") would be the proper home for it.
- **`PlayheadLine`:** the `rulerHeight` prop is now unused and could be removed in a later cleanup.
