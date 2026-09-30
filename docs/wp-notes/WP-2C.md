# WP-2C — Remotion compositions, Program/Source monitors, transport, on-canvas transform

Branch `wp/wp-2c`. `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass;
`pnpm --filter @jasper/compositions still:smoke` passes (needs `pnpm fixtures`). Verified Remotion
behavior is in `docs/research/remotion-4.0.499-notes.md`.

## What exists

| Area | Files | Notes |
|---|---|---|
| Composition | `packages/compositions/src/SequenceComposition.tsx`, `layers/*`, `pipeline.ts`, `fonts.ts`, `stabilize.ts` | Background → V1…Vn → audio. Each clip in `<Sequence from durationInFrames premountFor>` (2 s for media). Per layer (`LayerBox`): source → effects (crop first, registry `preview.css`/`svgFilter`, unknown/disabled bypassed) → matrix (`transform-origin: 0 0`) → opacity → `mix-blend-mode` (`add` → `plus-lighter`), root `isolation: isolate`. `ClipLayer` evaluates `@jasper/project` values per frame (static clips return one cached object); a memoized `LayerView` skips re-rendering frame-independent layers (`FRAME_DEPENDENT_KINDS` = motion-graphic, animated-image). |
| Layers | `VideoLayer` (`@remotion/media` `<Video>`, `trimBefore` from sourceIn, `playbackRate` = speed, muted — sound comes from the linked audio clip), `AudioLayer` (`<Audio>` + per-frame gain from `gainDb + volumeDb(t) + track volume + master`), `StillLayer` (`<Img>`), `SolidLayer`, `TextLayer` (fill, first stroke with paint-order, background box, shadow, align, tracking, leading, caps, point vs paragraph box), `OfflineCard`, `UnsupportedLayer`. `MotionGraphicLayer.tsx` untouched (WP-2G). |
| Fonts | `useDocumentFonts(doc.fonts)` holds the frame with `delayRender` until every face loads; failures fall back to the default sans instead of `cancelRender` (why we register FontFace ourselves instead of `@remotion/fonts` `loadFont`, which cancels the render on a failed face). |
| Asset composition | `AssetComposition` + `calculateAssetMetadata`, registered as `JasperAsset` next to `JasperSequence` in `Root.tsx`. |
| Structural sharing | `stabilizeRenderDoc(prev, next)` keeps identity of unchanged clips/media/fonts across snapshot rebuilds, so a drag re-renders only the dragged layer. |
| Program monitor | `apps/web/src/panels/program/*` | `ProgramMonitor.tsx` (Player at composition size inside one CSS `translate+scale` wrapper, fit/zoom presets/Ctrl+wheel zoom about cursor/wheel pan/Hand or middle-drag pan, safe margins, transparency grid, PROXY chip, buffering dot, timecode display + entry, duration, mini ruler with In/Out/markers, transport bar, resolution dropdown → `toggles.useProxies` + proxy tier, wrench menu). `render-doc.ts` builds inputProps from the drawn document + `MediaRuntime` (`/media/<key>`, `/media/<key>/proxy/<tier>` when ready, offline → Media Offline card) + engine font catalog. |
| Transport | `playback-driver.ts`, `shuttle.ts`, `transport-registry.ts`, `apps/web/src/commands/transport.ts` | `PlaybackDriver` is the `PlayerController` attached to the session `TransportStore`: native Player for forward rates 0.1–1×, seek-stepping for reverse and > 1× (measured, see notes), loop In→Out, Play In to Out, Play Around, external seeks while playing, mute ≠ 1×. JKL per S02 A.8 (K-hold stepping, K+hold L = 0.25×, Shift+J/L slow shuttle). Commands: all `transport.*` of TL-903 except `transport.toggleAudioScrub`, plus `monitor.fit`, `monitor.toggleLoop`, `program.snapInMonitor`, `program.nudge*`, `source.open`, `timeline.insertFromSource`, `timeline.overwriteFromSource`. |
| Overlay | `TransformOverlay.tsx`, `transform-math.ts`, `snapping.ts`, `edits.ts` | Hit test topmost unlocked layer (quad, rotation-aware), Shift/Ctrl toggle, empty click clears, hover outline, single selection quad + 8 oriented handles (corners only under 24 px) + anchor crosshair, multi-selection group box. Gestures: move (Shift axis lock, snapping to frame/center/safe margins/other layers, Ctrl inverts), scale about anchor (corner uniform by projection, edges one axis, Shift inverts uniform, Alt about the opposite handle, clamp 0.1–10000 %), rotate (unwrapped, Shift 15°, 90° snap ±2°), anchor (image stays; snaps to rect points; Alt moves only the anchor), group scale/rotate, nudge commands (coalesced). Each drag = one `beginGesture` → `update` per animation frame → `commit` (one History entry, Esc cancels). Writes go through `param.set` with `at: {sequenceFrame: playhead}` (keyframes when animated). Readout tooltip. While playing: no handles, selected outlines by direct DOM writes. Type tool click → `clip.addText` at the playhead on a free/targeted video track, then back to Selection. |
| Source monitor | `apps/web/src/panels/source/*` | Own `TransportStore` + driver + Player with `AssetComposition`, clip chooser + close, marks via `item.setMarks` (I/O, Shift+I/O, Alt/Ctrl+Shift clears handled locally when the Source is focused), mini ruler, Insert/Overwrite buttons → `clip.place` of the marked range at the Program playhead on source-patched (else targeted) tracks. |

## Verification run

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (25+ files; new: `packages/compositions/test/compositions.test.tsx`,
  `apps/web/test/{program-math,transport,program-monitor,source}.test.*`). Covered: matrix of the rendered
  element equals `layerMatrix` for 37° × 150/80 % × anchor, crop innermost / blend outermost, effect order,
  metadata from props, offline card, static prop identity, gain/trim/volume-frame math, AC-XF-1 (all 8
  handles ≤ 1 px at 25/100/400 %), XF-031, XF-037, AC-SNP-1/2, AC-PGM-3, AC-18a, AC-18b (8× ± 5 %),
  AC-18c, one undo step per move/rotate drag + exact undo, Esc cancel, Type tool, nudge coalescing,
  no per-frame React commits while playing, Source marks/Insert/Overwrite.
- `still:smoke`: 1920×1080 PNGs, video visible, frame-accurate trimBefore at 1× and 2×.
- Manual (agent-browser against `vite --port 5291` + a CORS static server for `fixtures/media`, demo
  project `/project/demo`, clips placed through the dev handle `window.__jasperMonitor.session.apply`):
  video + text render; Space plays/stops; Home, L L L → 4× (stepping), J → −1×, K stops; timecode entry
  `115` → 00;00;01;15; move/scale/rotate of the text are one History entry each and undo restores; VP9
  alpha shows transparency.

## Deviations / decisions

- Rates above 1× are seek-stepped (not native up to 4×) — measured Player buffering on this CPU.
- Player length = sequence end + 1 frame (so End, one past the last frame, is a valid black frame);
  empty sequences get 10 s.
- `VideoLayer` is muted: in the S01 model the sound of a placed video is its linked audio clip.
- Reverse speed plays forward in preview (needs the retime proxy, S03:KND-015, M2). Animated images use
  the browser's own animation (KND-040 frame-accurate playback is M2). Pan is not previewed (P1).
- Text layout uses the document box (`clip.box`); without a `TextMeasurer` in the session context the
  box is the model's estimate. A DOM `TextMeasurer` for `CommandContext.textMeasurer` would improve
  handle fit (can live in `@jasper/compositions`; not wired, the session host is not ours).
- Monitor view state (zoom, overlays, resolution, snap) persists in localStorage (`jasper.monitor.<kind>.v1`).
- Export Frame button is hidden (engine stills route is WP-2F); the Button Editor (`＋`), zoom scroll bar,
  rulers/guides, dropped-frame indicator colors and full-screen video are not implemented.
- `transport.toggleAudioScrub` (TL-833) is not registered (audio scrubbing is not implemented).
- Marquee selection (XF-004, P1), crop mode (XF-040…044), scale snapping (SNP-003 for scale), inline
  text editing (TXT-010…012) and the context menu (XF-050) are not implemented.

## Integration notes (for WP-2A / WP-2B / WP-2E / WP-3I)

- **Keyboard:** the monitors have a bubble-phase fallback key handler that only acts on events nobody
  `preventDefault`ed. The WP-2A capture-phase dispatcher must call `preventDefault()` on handled keys,
  otherwise a key could run twice.
- **Panel services:** the monitors publish `programPlayer` into `monitorPanelServices()` from
  `panels/program/monitor-commands.ts`. The shell should call `setMonitorPanelServices(itsServices)`
  once at startup so it is the same registry as `CommandCtx.services`.
- **Command ids owned elsewhere:** the Program buttons call `timeline.addMarker/markIn/markOut/goToIn/
  goToOut/lift/extract` and fall back to local implementations (`marker.add`, `sequence.setInOut` with an
  exclusive Out, `range.lift/extract`) when those ids are not registered. When the Source monitor is
  focused, WP-2B's `timeline.markIn/markOut/clear*/goToIn/goToOut` should defer to the source (check
  `ctx.focus.panel === 'source'`; helpers in `panels/source/source-state.ts`), since the dispatcher may
  run them before the Source fallback sees the key. `timeline.insertFromSource/overwriteFromSource` are
  registered here (`performSourceEdit`); if WP-2B registers the same ids, keep this implementation.
- **Duplicate command ids with WP-2B (review):** `wp/wp-2b` also registers `transport.prevEdit`,
  `transport.nextEdit`, `transport.prevEditAny` and `transport.nextEditAny` in `commands/timeline.ts`.
  The registry replaces on re-register and `transport` registers after `timeline`, so the WP-2C versions
  win (they also respect the Source focus). Keep one implementation at merge time.
- **Keyup:** the WP-2A dispatcher prevents default on keydown only. The monitor fallback therefore runs
  `onKeyUp` only for codes whose keydown it handled itself (review fix), so J/K/L keyups are not doubled.
- **Transport scope:** transport commands act on the Source monitor's local transport when
  `ctx.focus.panel === 'source'`, else on `ctx.transport`.
- **Project panel:** double-click should run `source.open {itemId}` (registered here).
- **Dev handle:** in dev builds the Program sets `window.__jasperMonitor = {session, driver}` (useful
  before the agent bridge exists; remove or keep behind `import.meta.env.DEV`).
- **Engine renders:** `selectComposition({inputProps})` with the exact props you render (see research
  notes); use `chromeMode: 'chrome-for-testing'` with a system Chrome.
- **Dependencies added:** `@remotion/player` and `remotion` (4.0.499 exact) in `apps/web`;
  `@remotion/bundler` and `@remotion/renderer` (4.0.499 exact, dev) in `packages/compositions`.

Contract changes (additive): `LayerProps.fonts?`, `AudioLayerProps.{fpsRational?, master?, sequenceFrom?}`,
`AssetCompositionProps`, `ASSET_COMPOSITION_ID`, new exports of `@jasper/compositions`.
