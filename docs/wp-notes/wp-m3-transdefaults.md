# wp-m3-transdefaults — Transition Defaults (S10 TUI-031…036)

Branch `wp/m3-transdefaults`. Spec: `docs/specs/10-transitions-ui.md` §4 (TUI-031 updated, TUI-032…036 new),
S01 §13 TRN-006 and `ProjectSettings`. Closes the "Transition Defaults… is a bare prompt" gap of
`wp-m2-transitions.md`.

## What was built

| Req | Where | Notes |
|---|---|---|
| TUI-031 dialog | `apps/web/src/transitions/TimelinePreferencesPage.tsx`, registered in `commands/transitions.ts` as Preferences page `timeline` (order 20) | Edit ▸ Preferences ▸ Timeline…, Sequence ▸ Transition Defaults… (`sequence.transitionDefaults`, now opens the page instead of `window.prompt`), transition context menu ▸ Transition Defaults…. Two groups with explicit scope badges: *Default transitions — This computer* and *Default durations — This project*. |
| TUI-031 user scope | `apps/web/src/panels/effects/transition-prefs.ts` | Same localStorage key (`jasper.transitions.defaults.v1`), value now `{version: 2, video, audio, alignment, units: {video, audio, still}}`; v1 values are read and completed; wrong-medium/unknown ids fall back. Other windows follow through the `storage` event. Never in History. Reset button. |
| TUI-032 project durations | `packages/project`: `settings.defaultAudioTransitionFrames?` (schema, additive), `defaultTransitionFrames(settings, medium)` (`transitions.ts`), handler `transition.add` / `transition.applyDefault` use the track medium's length | Page: video / audio transition and still image durations, frames or seconds per field (unit is a user pref; defaults frames / seconds / seconds like Premiere). Seconds convert at the active sequence's rate, rounded to whole frames with a note; invalid input is red with the reason and commits nothing; Enter/blur commit, Esc reverts. One History entry per change ("Default Video Transition Duration", "Default Audio Transition Duration", "Default Still Duration"). The first video change in a project without the audio field pins the audio length so it does not silently follow. Pure helpers: `apps/web/src/transitions/durations.ts`. |
| TUI-033 alignment | `transition.applyDefault {alignment?}` (schema + handler), `defaultTransitionFields()` | Used by Ctrl+D / Ctrl+Shift+D / Shift+D, clip menu Apply Default Transitions, Effects ▸ Apply to Selected Clips. Fades keep their fixed alignment; a cut lacking the handle the alignment needs is skipped (as before). |
| TUI-021 ghost | `TimelinePanel.tsx` | The drop ghost uses `defaultTransitionFrames(settings, spec.appliesTo)`. |
| TUI-034 agents | `packages/project/src/agent/queries.ts` (`preferences.get`, session-only), `packages/api/src/agent.ts` (name), `apps/web/src/agent-bridge/bridge.ts` (answers it), `apps/mcp/src/tools/transitions.ts` | `apply_default_transitions` gains `alignment`; per value: call argument → the open editor's preferences → built-ins; returns `defaults {video, audio, alignment, durationFrames, source}`. New `set_transition_defaults` (project durations, one entry). `list_transitions` adds `defaultAudioTransitionFrames`. |
| TUI-035 menus | `apps/web/src/shell/menus/model.ts` | Sequence: Apply Video Transition, Apply Audio Transition, Apply Default Transitions to Selection, Transition Defaults…; Edit ▸ Preferences ▸ Timeline…. |
| TUI-036 cross-window ghost | `apps/web/src/panels/effects/drag.ts` (`transitionDragId`) | The effect id is also encoded in a drag *type* name (`application/x-jasper-transition-id.<id>`); types are readable during dragover, data is not, so a drag from another window of the app resolves its ghost. Browsers that hide custom types fall back to "drop without ghost" (the drop still works). |

## Contract changes (additive)

- `ProjectSettings.defaultAudioTransitionFrames?: number` (int ≥ 1; absent = `defaultTransitionFrames`). No
  schema version bump or migration needed (optional field, `project.updateSettings` takes it as a partial).
- `defaultTransitionFrames(settings, medium)` exported from `@jasper/project`.
- `transition.applyDefault` accepts `alignment?` (center | start-at-cut | end-at-cut).
- Agent query `preferences.get` (session-only; `AgentQueryEnv.session.preferences?()`), in `AGENT_QUERIES`
  (`@jasper/api`) and `SESSION_ONLY_QUERIES`.
- `PreferencesDialog` takes `session?` and wraps pages in `SessionProvider`; `app.preferences` /
  `process.preferences` pass `ctx.session` (`commands/process.ts`, outside owned paths: one-line changes).
- Menu model: Sequence and Edit ▸ Preferences entries (above).
- Drag payload gains the id-carrying type name (TUI-036).
- `@jasper/ui`: `InDialogContext` / `useInDialog()` / `popoverZClass()`; `Select` lists opened inside a `Dialog`
  stack just above the dialog layer (they were under the dialog scrim and could not be clicked — this affected
  every Select in a dialog, e.g. Preferences ▸ General ▸ Theme). Menus and the colour picker popover still use
  the popover layer (none of them is opened from a dialog today); they can adopt `popoverZClass` the same way.
- `@jasper/ui` `Dialog`: a focused element marked `data-escape-reverts="true"` (`DIALOG_ESCAPE_REVERTS`) takes
  the first Esc (the dialog stays open, the field reverts its typing); a second Esc, or Esc with nothing being
  edited, closes the dialog. The Preferences ▸ Timeline duration fields set it while they hold uncommitted text.
- MCP: `apply_default_transitions {alignment}` + `defaults` in the result, new tool `set_transition_defaults`
  (README tool count 68).

## Scopes (why)

The model as built keeps the default *types* as a user preference (S10:TUI-031, S01:SES-005, D-30) and the
default *length* as a project setting (S01). M3 keeps that split and labels it in the UI; the new alignment and
unit choices are user preferences next to the types; the audio length is a project setting next to the video
length. Agents see the user's part through `preferences.get` when the editor is open; headless they use the
built-ins (or what the call passes) and say so (`defaults.source`).

## Licences

No new dependencies.

## How to test

- `pnpm vitest run --project @jasper/project packages/project/test/transition-defaults.test.ts`
- `pnpm vitest run --project @jasper/web apps/web/test/transition-defaults.test.tsx` (+ the existing
  `transitions-*.test.ts(x)`, `shell.test.tsx`, `wiring-audit.test.ts`, `agent-bridge.test.ts`)
- `pnpm vitest run --project @jasper/mcp apps/mcp/test/transitions.test.ts apps/mcp/test/readme-tools.test.ts`;
  `MCP_TEST_PORT=48661 pnpm vitest run --project @jasper/mcp apps/mcp/test/integration.test.ts`
- E2E: `E2E_PORT=48660 pnpm e2e -- e2e/transition-defaults.spec.ts e2e/transitions.spec.ts` (dialog from the
  Sequence menu, change type/alignment/duration, Ctrl+D applies them, persistence across reload; screenshots in
  `test-results/e2e-transition-defaults-*.png`).

## Open issues / remaining gaps from wp-m2-transitions

- Audio crossfade preview measurement in the browser (S10 §8 test 7, preview half) is still covered by the pure
  gain test, not an in-browser Web Audio measurement (not trivial; unchanged).
- The shortened-at-creation state is still not stored (TUI-003 by design: caps mark spans that use up the media).
- A drag from another *application* (or a browser that hides custom drag types) still cannot show a ghost before
  the drop; that is a browser limitation (DataTransfer data is protected until `drop`).
