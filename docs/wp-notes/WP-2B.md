# WP-2B — Timeline panel, Tools panel, timeline UI commands, advanced edit handlers

Branch `wp/wp-2b`. `pnpm lint`, `pnpm typecheck`, `pnpm test` (27 files, 292 tests) and
`pnpm --filter @jasper/web build` pass on Node 20.20.

## What exists

| Area | Files | Notes |
|---|---|---|
| Document handlers | `packages/project/src/commands/handlers/clip-edit.ts` | `clip.trim` mode `roll`, `clip.slip`, `clip.slide`, `clip.setSpeed`, `clip.duplicate`, `clip.link`, `clip.unlink`, `clip.fitToFrame`, `range.lift`, `range.extract`, `gap.close`. |
| Handler tests | `packages/project/test/clip-edit.test.ts` | Table-driven cases (S02:TL-1050), S02 AC-10a/b, 11b/d, 12a–d, 13a/b/d, 15a, 16b at model level, a property test over random transactions mixing the new commands (invariants, dry run = no mutation, rejected = unchanged), and slip/slide/roll properties. |
| Timeline model (pure) | `apps/web/src/panels/timeline/model/*` | `viewport.ts` (TL-100…120, A.2), `ruler.ts` (A.9, DF labels), `layout.ts` (split V/A regions), `snapping.ts` (A.3), `hit.ts` (TL-531), `tools.ts` (TL-591 decision matrix), `gestures.ts` (gesture → command), `filmstrip.ts` (TH-003, TL-328), `waveform.ts` (WF-001/003), `renderbar.ts` (TL-214 via `engineAffinity`), `drop.ts`. |
| Controller | `state/controller.ts` | DOM-free `TimelineController`: move/insert/duplicate, trim, ripple (Ctrl-edge or B), roll (N), rate stretch (R), slip (Y), slide (U), razor (C, Shift = all tracks, Alt = ignore links), marquee, track select, hand, zoom, wheel mapping, auto-scroll, zoom/scroll helpers. Every document gesture uses `session.beginGesture` (one history entry, Esc = none). |
| Panel | `TimelinePanel.tsx`, `components/*` | Tabs, timecode readout (entry/scrub/frames toggle), toolbar, canvas-tiled ruler (≤ 512 px tiles), In/Out brackets + shading, marker lane, render bar, track headers, virtualized clip bodies (translateX), filmstrips/waveforms in canvas tiles, overlays (snap, razor, insert, limit, marquee, edit points, drop), direct-DOM playhead and timecode, zoom bar, context menus. |
| Media caches | `media/media-cache.ts`, `media/peaks.worker.ts` | Sprite index/sheets and peaks fetched from the engine URLs (or `MediaRuntime.spriteUrl/peaksUrl` when set); peak level reduction runs in a module Web Worker (sync fallback without Worker). |
| Tools panel | `apps/web/src/panels/tools/*` | 40 px strip, 28×28 buttons, flyouts (right-click / 350 ms long-press), group faces remembered in localStorage, auto-horizontal. Active tool = `session.toggles.activeTool`. |
| UI commands | `apps/web/src/commands/timeline.ts` | TL-903 ids (see file), `tool.*`, `transport.prevEdit/nextEdit(/Any)`, `gesture.cancel`. |
| Web tests | `apps/web/test/timeline-*.test.ts(x)` | Math (TL-1053), gesture mapping, one-entry-per-gesture + Esc, commands acceptance, panel render with 3 000 clips / 40 tracks + render-count test, tools keys. |

## Integration notes (for WP-3I and neighbours)

- **Services.** The panel registers `timelinePanel`, `timelineViewport` and `timelineGesturePreview` in
  `PanelServices` (declaration-merged in `panels/timeline/env.tsx`, *Contract-Change: additive*). Without a
  shell provider it uses a fallback `PanelServices`; the shell should wrap panels with
  `<TimelineEnvProvider value={{ services, toast, openDialog }}>` so commands, toasts and the marker dialog
  reach the real shell. Commands also find the panel through a module registry (`activeTimeline()`), so
  keyboard commands work either way.
  `TimelineEnvProvider` memoizes its value on `services`/`toast`/`openDialog`, and the panel keeps one
  controller across env changes; pass stable `toast`/`openDialog` callbacks. Unmounting the panel mid-drag
  cancels its session gesture.
- **Program monitor (WP-2C).** Trim two-up / slip-slide four-up payloads (TL-538/626/631) are published in
  `timelineGesturePreview` (zustand store in `state/gesture-preview.ts`, also exposed as the service above).
- **Import (WP-2E).** OS file drops call `services.get('importService').importFiles(...)`; register the
  `ImportService` under the name `importService`. Without it the timeline shows a toast. Project item drops
  read `application/x-jasper-project-items` with `{itemIds}` (or a bare array) and commit one
  "Place N Clips" transaction.
- **Keymap (WP-2A).** No key listeners are installed by the timeline except a gesture-local capture
  listener for Escape while a pointer gesture is active. `gesture.cancel`, `tool.*` and
  `transport.prevEdit/nextEdit/prevEditAny/nextEditAny` are registered here (the brief lists ↑/↓ edit
  navigation for WP-2B). If WP-2C also registers the edit-navigation ids, keep one implementation.
- **Menus/primitives.** WP-2A primitives were not merged; the timeline uses its own small context menu,
  timecode field and tooltip. Swap them when the primitives land.
- **Peaks binary layout.** `peaks/<stream>.bin` is read as planar float32 (channel 0 samples, then channel 1),
  per WF-001 "channels stored separately". WP-2F must match this (or update `media-cache.ts`).
- **Dev helper.** In dev builds the display-settings menu has "Dev: Insert Sample Clips" and the session
  is exposed as `window.__jasperDev.session` for manual checks. Neither exists in production builds.

## Deviations, limitations, TODO

- `clip.slide` always slides linked partners that start with the clip (the frozen schema has no
  `linked` flag), so Alt+slide cannot ignore links. `clip.slip` takes explicit ids, so Alt works there.
- `clip.slip` skips stills, solids, text and adjustment clips with a `W_VALUE_CLAMPED` warning and refuses
  when nothing can slip (TL-625: slip is meaningless for unbounded content).
- `clip.fitToFrame` replaces animated scale with a static value (warning `W_VALUE_CLAMPED`).
- Unbounded generators (solids, text) cannot extend their head past content time 0 (S01:CLP-005), so
  rolls/slides into a generator's head are limited by its `sourceIn`, as in the core trim handler.
- Lift/Extract with no targeted track use all unlocked tracks. Lifted content does not go to the
  clipboard (clipboard is M2, TL-692).
- Rate stretch Ctrl-ripple only applies to the out edge.
- Cursors use standard CSS cursors; custom SVG cursors (S05:IC-010) are WP-2A's.
- Vertical mini zoom bars (TL-116) are not implemented; heights scale with Shift+wheel over the headers,
  Alt+wheel on one header, keys and the resize handles.
- Not implemented (SHOULD/M2): keyframe lanes and rubber bands, fade handles (fades are transitions, M2),
  source patching column, clipboard, Speed/Duration and Audio Gain dialogs, spring-loaded tools, touch
  shells, agent proposal ghosts, render-in-to-out (toast only).
- The WP-00 tests that asserted `E_NOT_IMPLEMENTED` for `clip.slip`, `clip.setSpeed`, `gap.close` and
  roll were updated for the implemented handlers (minimal edits in `packages/project/test`).
- Manual check (`vite` on the demo project, real Chrome): sample clips, move, trim, ripple (Ctrl-edge),
  roll (N), slip (Y), razor (C) each produced exactly one History entry; Esc during an insert drag left
  none; undo restored the original document.
