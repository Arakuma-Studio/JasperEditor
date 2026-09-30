# wp-m2-transitions — transitions in the timeline UI (S10)

Branch `wp/m2-transitions`. Spec: `docs/specs/10-transitions-ui.md`. Contracts: ARCHITECTURE §19.1, §19.9, §19.10, D-30.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| TUI-001…004 drawing | `apps/web/src/panels/timeline/model/transitions.ts` (`transitionIndex`, `transitionGeom`, `transitionRect`), `components/TransitionView.tsx`, `components/TrackArea.tsx` | Per-track sorted index cached on the identity of `sequence.transitions` (+ clips, media); DOM rects positioned with `translateX`, virtualised with the clips' ±50 % window, memoised on primitive props (no render per playhead frame — test). Ramp glyph (rising / falling / both; dip to black = V; quarter-sine curves for constant power), elided label, tooltip (type, duration TC + frames, alignment, handles used, shortened / not rendered), selection accent, hatched end caps where the span uses up the media handle on that side (TUI-003). Spans are the *rendered* spans (`fitTransitionDuration` against the current handles, like `resolveVideoTransitions`). |
| TUI-005 | `TimelinePanel.tsx` | The index is built from the drawn (transient) sequence, so transitions follow clip moves/trims during gestures. |
| TUI-006 (P1) | `TransitionView.tsx` | Audio transitions draw on audio tracks with linear / quarter-sine curves. |
| TUI-010 hit priority | `model/hit.ts` (`Hit.kind 'transition'` with `under`), `model/transitions.ts` (`hitTransition`) | Transition edge (4 px, reaching 2 px outside) → body → clip edge → clip body; the rect is the clip body minus the name strip, inset 2 px, so clip edges stay reachable above/below it. 3 px minimum hit width. Only resizable edges are edge zones (centre: both; at-cut / fades: the edge away from the cut). Tools other than Selection/Type act on `under` (razor, ripple, roll… keep working through transitions, TUI-016). |
| TUI-011 | `state/controller.ts` (`beginTransition`), `TimelinePanel.tsx` | Click selects (clears clips), Shift/Ctrl toggles; selecting a clip clears transitions unless Shift; double-click selects and runs `panel.focus.effectControls`; right-click → menu. |
| TUI-012 edge drag | `controller.ts` (`updateTransitionEdge`), `edgeDrag()` | One gesture "Transition Duration" → `transition.update {duration, alignment}`; centre resizes symmetrically; Alt keeps the other edge and turns into start-/end-at-cut when the dragged edge reaches the cut (otherwise symmetric). Clamped live by the handler (`fitTransitionDuration`); tooltip `Duration 00:00:01:05 (35)` + "Limited by media handles"; ghost with handle bands / missing part. A drag that ends unchanged records nothing. |
| TUI-013 body drag | `updateTransitionBody`, `bodyDragAlignment()` | Two-sided only; nearest of end-at-cut / centre / start-at-cut; duration kept or reduced; one entry "Transition Alignment". |
| TUI-014 snapping | edge drags use `collectSnapTargets` (playhead, markers, In/Out, clip edges) with the timeline threshold. |
| TUI-015 Delete/Esc | `commands/transitions.ts` | `timeline.clear` and `timeline.rippleDelete` are re-registered wrapped: with transitions selected they run `transition.remove` (one entry "Clear Transition(s)"), otherwise the original command. Esc cancels gestures (existing controller path). |
| TUI-020 Effects bins | `panels/effects/EffectsPanel.tsx`, `panels/effects/transitions.ts` (`transitionTree`) | "Video Transitions ▸ Dissolve", "Audio Transitions ▸ Crossfade" from `TRANSITION_SPECS`; the defaults carry a blue outline badge; search filters them; double-click / context menu "Apply to Selected Clips". |
| TUI-020 payload | `panels/effects/drag.ts` | `{type:'jasper/transition', effectId}` on `application/x-jasper-transition` + `jasper-transition:<id>` text; `activeTransitionDrag()` keeps the id during dragover (data is unreadable there). |
| TUI-021…024 drop | `resolveTransitionDrop`, `handleFeedback`, `dropCommand`; `TimelinePanel.tsx` (`onTransitionDragOver/Drop`) | ±12 px band in thirds (left end-at-cut, middle centre, right start-at-cut); free edge → fade; clip body → nearer edge; existing transition → replace type (`transition.update {effectId}`). Ghost: fitted span, light bands = available handles, red hatch = missing media, tooltip "Insufficient media: the transition will be N frames"; N = 0 → `dropEffect none` + the model's `E_OUT_OF_MEDIA` text. One entry "Add Transition" / "Replace Transition"; `W_TRANSITION_SHORTENED` toasts; the new transition is selected. |
| TUI-030 keys | `commands/transitions.ts` | `timeline.applyDefaultVideoTransition` (Ctrl+D), `…AudioTransition` (Ctrl+Shift+D), `…TransitionsToSelection` (Shift+D); selected clips → both edges; no selection → edit point nearest the playhead (visible range) on every targeted track; all via `transition.applyDefault` with `media`, `videoEffectId`/`audioEffectId` from the preference; one entry per invocation. Keymap ids unchanged. |
| TUI-031 defaults | `panels/effects/transition-prefs.ts` | localStorage `jasper.transitions.defaults.v1` `{video, audio}`; "Set Selected as Default Transition" (Effects panel), "Set as Default Transition" (timeline menu). P1 `sequence.transitionDefaults` "Transition Defaults…" command (prompt → `project.updateSettings {defaultTransitionFrames}`), reachable from the command palette. |
| TUI-040/041 inspector | `panels/effectControls/TransitionSection.tsx`; hosted by `EffectControlsPanel.tsx` (transition selected, no clip) and `PropertiesPanel.tsx` | Type (same medium), duration (timecode field), alignment (disabled for fades), A/B diagram (A/B bars, handle bands, cut line, span) from the drawn document; span edges drag with the TUI-012 semantics as one scrub gesture. |
| TUI-045 menu | `TimelinePanel.tsx` (`transitionMenu`) | Set Duration… (frames or timecode), Alignment ▸, Replace With ▸, Clear, Set as Default Transition. |
| TUI-046 (P1) | `commands/transitions.ts` | Clip menu "Apply Default Transitions ▸ In / Out / Both" through `clipMenuExtensions`. |
| TUI-050 | `packages/project/src/commands/handlers/transition.ts` | `transition.update {effectId}`: same medium (`E_TRACK_KIND` otherwise), unknown → `E_UNKNOWN_EFFECT`, duration re-fitted, `effectVersion` updated; result gains `effectId`. |
| TUI-051 | same | `transition.applyDefault {media (default ['video']), videoEffectId (cross dissolve), audioEffectId (constant power), duration (project default)}`; locked tracks and edit points without room are skipped. |
| TUI-052 (P1) | `packages/project/src/transitions.ts` (`resolveAudioTransitions`), handler, `render/snapshot.ts` (audio part), `apps/engine/src/export/native.ts` (audio section), `packages/compositions/src/layers/AudioLayer.tsx`, `SequenceComposition.tsx` (audio `<Sequence>` only) | Two-sided constant gain / constant power crossfades: outgoing `tailHandle`, incoming `headHandle`, complementary fades over the span; `afade` `qsin`/`tri` natively, the same curves in preview; handles re-clamped at render time. `transition.add` with `clipId`+`edge` on audio stays a one-sided fade; `trackId`+`at` at an audio cut makes a crossfade. |
| TUI-060 | `apps/mcp/src/tools/transitions.ts`, `apps/mcp/src/format.ts` | `list_transitions`, `update_transition`, `remove_transitions`, `apply_default_transitions` (+ `TRANSITION_GUIDE`); `get_timeline` lists transitions per track. |

## Contract changes (additive)

- `transition.update` result gains `effectId`.
- `RenderAudioClip.headHandle?` / `tailHandle?` (snapshot); `resolveAudioTransitions(doc, seq)` (new), `resolveAudioFades(seq, doc?)` keeps its signature.
- Drag payload `application/x-jasper-transition` (`panels/effects/drag.ts`).
- `packages/ui/src/theme/tokens.css`: `/* wp-m2-transitions */` block with `--pr-transition-*` tokens.
- MCP `get_timeline` text gains a "Transitions:" block (`apps/mcp/src/format.ts`); the `get_timeline` description in `apps/mcp/src/tools/render.ts` and the `add_transition` description in `tools/editing.ts` mention them (one-line changes outside owned paths).
- `SequenceComposition.tsx` (not in owned paths): the audio `<Sequence>` starts `headHandle` early and lasts `duration + head + tail`.
- `commands/transitions.ts` re-registers `timeline.clear` / `timeline.rippleDelete` (wrapping the WP-2B commands; `COMMAND_MODULES` registers `transitions` after `timeline`).

## Licences

No new dependencies. Native audio crossfades use `afade` (LGPL build).

## How to test

- `pnpm vitest run --project @jasper/project --project @jasper/web` (model: `packages/project/test/transition*.test.ts`; web: `apps/web/test/transitions-timeline.test.ts`, `transitions-panels.test.tsx`).
- Engine: `apps/engine/test/audio-crossfade.test.ts` (filter text + real ffmpeg export of two tones, `astats` level check ≤ 0.5 dB).
- MCP: `MCP_TEST_PORT=48561 pnpm vitest run --project @jasper/mcp`.
- E2E: `pnpm fixtures && E2E_PORT=48410 pnpm e2e -- e2e/transitions.spec.ts`.
- Fixtures: `scripts/fixtures/transitions.mjs` (`xfade-tone-440.wav`, `xfade-tone-660.wav`, steady tones for crossfade checks).

## Open issues / gaps

- S10 §8 test 7 preview half (Web Audio analysis in the browser) is covered by a pure gain test (`packages/compositions/test/audio-layer.test.ts`), not an in-browser measurement; the export half is measured with ffmpeg.
- "Transition Defaults…" is a command (palette) with a prompt; the shell's Sequence menu entry and a proper dialog are left to the integrator (the menu model is not in this package's paths).
- Dropping a transition dragged from another window cannot preview a ghost (the id is unreadable during dragover); the drop itself works.
- The shortened-at-creation state is not stored (TUI-003): caps mark spans that use up the available media instead.
