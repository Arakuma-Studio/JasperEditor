# WP-2A — Premiere shell, docking, workspaces, focus, keymap, menus, palette, design system

Branch `wp/wp-2a`. `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass; `pnpm --filter @jasper/web build`
passes without chunk-size warnings.

## What exists

| Area | Where | Notes |
|---|---|---|
| Design-system primitives | `packages/ui/src/primitives/*`, `menu/`, `dialog/`, `toast/` | IconButton, TextButton (`Button`), TextField, SearchField, Select, Checkbox, Toggle, ColorSwatch + ColorPicker (HSV, hue, alpha, hex, eyedropper, recent/project swatches), ScrubbyNumber, Slider, Menu/ContextMenu/Dropdown/MenuBar, Tooltip (+ `TooltipHost`), Dialog (+ `DialogHost`, `openDialog`, `confirmDialog`), Toast store + `ToastHost` + notification log, Tabs, TimecodeField, EmptyState, PanelErrorBoundary, Linear/CircularProgress, FxBadge, Kbd |
| Icons and cursors | `packages/ui/src/icons/registry.ts`, `packages/ui/src/cursors/` | Custom NLE glyphs for tools, transport/monitor buttons, track headers, engines (R/F/N in a rounded square), agent, fx badge; 20 SVG cursors with hotspots and 2× variants (`cursorCss(id)`); `forceCursor()` + `ForcedCursorLayer` (z 300) |
| Shell | `apps/web/src/shell/EditorShell.tsx` | Row A menubar + centered title; Row B header (Home, Import/Edit/Export, workspace tabs with drag reorder, right-click menu and » overflow, Workspaces menu, engine chip + popover, jobs button with badge from `useJobs`, Quick Export → `export.quick`, Agent → `panel.focus.agent`, palette, full screen) |
| Dock | `shell/dock/DockHost.tsx`, `shell/dock/controller.ts` | dockview-react 8.3 themed by `packages/ui/src/theme/dockview.css`; 3 px gutters (4 px high contrast); Program/Timeline `renderer: 'always'`; per-panel error boundary; custom tabs (context title, ≡ panel menu on the active tab, × on hover, middle-click close, attention dot via `setPanelAttention(kind)`); maximize with Restore button; floating groups; empty-workspace state |
| Workspaces | `shell/workspaces/*` | Data definitions (`editing`, `assembly`, `effects`, `motion`, `agent`, `essentials`, plus the `compact` preset), builder to dockview JSON at the real window size, sanitizer (unknown panel kinds dropped), versioned localStorage adapter with corrupt/newer fallback and one warning toast, current/saved snapshots, Save/Save As/Reset/Edit/Import/Export |
| Focus | `shell/focus.ts` | Capture-phase `pointerdown`/`focusin` → `focusStore`; 1 px `--pr-focus-ring` outline on the focused group only |
| Keyboard | `shell/keymap/dispatcher.ts`, `format.ts` | One capture-phase keydown/keyup listener per window; see "Keyboard rules" below |
| Menus | `shell/menus/model.ts`, `resolve.ts` | S05 §12.2 menubar as command ids; resolver adds labels, shortcuts, checked state and disabled reasons |
| Palette | `shell/palette/*` | `Ctrl+Shift+P`; `>` commands, `@` project items, `#` markers, `:` timecode seek, `?` help; "Ask the agent: …" row runs `agent.ask` (`Ctrl+Enter`) |
| Prefs and themes | `shell/prefs.ts`, `public/theme-boot.js` | `jasper:ui-prefs` (theme, contrast, density, labels, tooltips, layout mode, workspace tabs) → `data-pr-*` on `<html>` |
| Layout modes | `shell/layout-mode.ts` | desktop (≥ 1280), compact (900–1279: compact preset, ≡ app menu); tablet/phone use the compact shell plus a "Touch layout coming soon" notice |
| Runtime | `apps/web/src/runtime/` | `platform.ts` (runtime/platform, `window.jasperDesktop` type), `bootstrap.tsx` (`EngineGate`: "Engine not reachable" screen with Retry and "Continue without engine"), `window-controls.tsx`, `save.ts` (`ensureAutosaver`, `saveNow`) |
| Commands | `commands/app.ts`, `commands/edit.ts` | see the list below |
| Panels | `panels/info`, `panels/markers`, `panels/audioMeters` | Info (selection and sequence readout), Markers (sequence marker list, search, double-click seeks), Audio Meters (52 px strip, dB scale, empty wells) |

## How other panels use the shell

**Run commands, never call editing code from click handlers (S05:KB-001).**

```tsx
import { useRunCommand } from '../../shell/context.tsx';
const run = useRunCommand();
<IconButton icon="tool.razor" label="Razor Tool" shortcut="C" onClick={() => run('tool.razor')} />
```

`useCommandCtx()` gives the live `CommandCtx` getter, and `usePanelServices()` gives the per-window `PanelServices`
(register your `programPlayer`, `timelineViewport` … there). The shell registers itself as the `shell` service:
`ctx.services.get('shell')?.focusPanel('timeline')`.

**Panel menus (PC-011) and context menus.** Put panel-specific entries in `PanelDefinition.menu` (command ids). The dock
appends the common section (Undock, Close, Panel Group Settings). For a context menu, resolve the model and render it:

```tsx
import { ContextMenu } from '@jasper/ui';
import { resolveMenu } from '../../shell/menus/resolve.ts';
const getCtx = useCommandCtx(); const rt = useShellRuntime();
<ContextMenu items={() => resolveMenu(CLIP_MENU, { ctx: getCtx(), platform: rt.platform, runtime: rt.runtime,
  run: (id, args) => void rt.run(id, args) })}>{clipElement}</ContextMenu>
```

Unregistered or unavailable commands render disabled with a tooltip reason. Give commands a `disabledReason(ctx)` for a
better message ("Unlink: selection has no linked clips"), and `labelFor(ctx)` for dynamic labels.

**Toasts.** From a command: `ctx.ui.toast({kind, message, detail?, action?: {label, command}})`. Anywhere else:
`import { toast } from '@jasper/ui'; toast({ kind: 'success', title: 'Proxies ready', dedupeKey?, actions?, progress? })`.
Progress toasts: keep the id and call `toasts.update(id, { progress: { value } })`, then
`toasts.update(id, { kind: 'success', title: 'Export finished' })`. Identical toasts within 2 s merge ("×N"); max three show.

**Dialogs.** Register once at module load, open by kind:

```tsx
import { Dialog, registerDialog, openDialog, confirmDialog, type HostedDialogProps } from '@jasper/ui';
registerDialog('timeline.speedDuration', (p: HostedDialogProps<{ clipId: string }>) => (
  <Dialog open onOpenChange={(o) => !o && p.close()} title="Speed/Duration" primaryLabel="OK"
    onPrimary={() => { /* one session.apply = one undo step (DG-005) */ }}>…</Dialog>));
const result = await openDialog('timeline.speedDuration', { clipId });     // or ctx.ui.openDialog(kind, props)
if (await confirmDialog({ title: 'Delete 3 tracks?', body: 'You can undo this.', confirmLabel: 'Delete Tracks' })) …
```

Enter runs the primary button (not from textareas or other buttons), Esc cancels, focus returns to the invoker.

**ScrubbyNumber (one undo step per drag, CT-023).**

```tsx
let gesture: Gesture | null = null;
<ScrubbyNumber label="Scale" unit="%" value={scale} min={0} max={10000} precision={1}
  onScrubStart={() => { gesture = session.beginGesture('Scale'); }}
  onScrub={(v) => gesture?.update([{ type: 'param.set', clipId, path: ['transform', 'scale'], value: v }])}
  onScrubEnd={() => { gesture?.commit(); gesture = null; }}
  onScrubCancel={() => { gesture?.cancel(); gesture = null; }}      // Esc during the drag
  onCommit={(v) => session.apply({ label: 'Scale', commands: [...] })} />   // typed entry or arrow keys
```

`value={null}` shows a mixed value (`–`); drags then report a `delta`. Shift = 10×, Ctrl/Cmd = 0.1×. Typed entry accepts
`+10`, `-5`, `*2`, `/2`, and `=-5` for an absolute negative value.

**TimecodeField.** `<TimecodeField rate={seq.settings.frameRate} dropFrame={…} startFrames={…} source={frameSource}
onCommit={(f) => transport.seek(f)} size="timeline" />`. Pass `source` ({get, subscribe}) so the playhead text updates by
direct DOM writes (PERF-004).

**Keyboard in widgets.** Mark widgets that handle their own keys with `data-keymap-local` (ScrubbyNumber and SegmentedControl already
do). The dispatcher lets them handle the key first and runs the command only if they did not call `preventDefault()`.
Put `data-panel-autofocus` on the element that should receive focus when the panel is focused (for example the Agent
prompt for `Shift+0`).

**Cursors.** During a gesture, `const release = forceCursor('trimIn')`. It is released automatically on
pointerup/cancel/blur. Use `cursorCss('razor')` for hover cursors.

**Import/Export modes.** WP-2E can plug its views in with `registerModeView('export', ExportMode)` from
`shell/EditorShell.tsx`. Until then a placeholder with "Export Media…" / "Import…" buttons is shown.

**Autosave.** The shell calls `ensureAutosaver(session)` (`runtime/save.ts`). WP-2E should use the same function (it is
idempotent per session) rather than creating a second autosaver.

## Commands registered here

`file.save` (+ `app.save`), `history.undo` / `history.redo` (labels "Undo <step>"), `panel.focus.<kind>` for every panel
kind (+ keymap aliases `panel.open.*`), `panel.maximize` (+ `workspace.maximizeActive`), `workspace.maximizeUnderCursor`,
`panel.close` (+ `app.closePanel`), `panel.float`, `workspace.nextPanel` / `workspace.prevPanel`, `workspace.switch`
({id}) and `workspace.switch.1…9`, `workspace.reset` (+ `workspace.resetToSaved`), `workspace.save`, `workspace.saveAs`,
`workspace.edit`, `workspace.import`, `workspace.export`, `window.resetAllPanels`, `palette.open` (+ `app.commandPalette`),
`palette.findPanel`, `view.theme` ({theme?}), `view.theme.darkest|dark`, `view.contrast.high`, `view.density.touch`,
`view.tooltips`, `view.layout.auto|desktop|compact`, `view.fullscreen`, `mode.import|edit|export`, `app.goHome`,
`app.shortcutReference`, `app.about`, `app.cycleRegions` (F6).

Aliases are marked `hidden` so the palette lists only the canonical ids.

## Keyboard rules (KB-001…007)

- Resolution order: focused panel scope, then `editing` (Timeline, Program, Source, Tools), then `global`. The first
  registered **and enabled** command wins; disabled or unregistered ones fall through.
- Matching uses `KeyboardEvent.code`. Browser-reserved chords use their web fallbacks (`Alt+N`, `Alt+W`, `Alt+T`), and menus
  show the fallback.
- In editable elements, single keys and Shift+key are suspended. Text-editing chords (Ctrl+A/C/V/X/Z/Y, Ctrl+arrows,
  Home/End…) stay with the field. Esc, Enter and other modifier combos run after the field unless it called
  `preventDefault()`.
- Events inside open menus, listboxes and modal dialogs are left to them.
- Auto-repeat only reaches commands or bindings marked `repeat`. `keyup` reaches `onKeyUp` for hold-to-act commands. F10 or
  a lone Alt tap focuses the menubar.

## Verification

- Unit/component tests: `packages/ui/test/primitives.test.tsx` covers ScrubbyNumber (one commit per drag, Esc restores,
  Shift 10×, math entry, mixed values), TimecodeField (`1510` → 00:00:15:10, `+15`, invalid keeps the value, drop-frame, live
  source), toasts (×5 merge, max 3, sticky error with action, dedupe/progress, pause), menu disabled reasons,
  cursors, tooltip fallback.
- `apps/web/test/shell.test.tsx` covers workspace data (every panel exists, no duplicates), Editing proportions, the
  layout sanitizer, store fallback on corrupt/newer JSON, snapshots/save-as/reorder/import/export, dispatcher AC-KB-1,
  AC-KB-2, widget-first handling, repeat/keyup, fall-through, AC-KB-4 (no duplicate bindings per scope on every platform
  and runtime), shortcut labels, undo/redo labels including "Undo Agent: …", capability reasons, the edit-only menu
  disabling, maximize/restore state, reopening a panel in its home group, the empty dock and reset, layout modes, and the
  palette parser.
- `apps/web/test/shell-render.test.tsx` renders the real app: AC-SH-4 (exactly one warning toast), AC-FO-1, AC-DT-1/2,
  header modes/workspace tabs/palette with the "Ask the agent" row.
- Manual run (`pnpm dev`, Chrome at 1920×1080 and 1280×577, `/project/demo`):
  - The Editing workspace renders every panel. Program is 47 % and Properties + Agent is the full-height right column at
    22 %.
  - Tools measures 40.00 px and Audio Meters 52.00 px at 1920×1080 and 1280×577 (review fix: the min-width gutter
    allowance now matches dockview's gap·(n−1)/n share, 2.25 px in the 4-view bottom row). Layouts saved before that fix
    keep their old 43 px minimum until "Reset All Panels".
  - With the pointer over the Timeline, the real `` ` `` key maximizes it; `` ` `` again restores every group rectangle
    exactly (AC-SH-5 verified pixel-equal).
  - Clicking Program outlines only its group.
  - `Ctrl+Shift+P` opens the palette.
  - The Window menu lists panels with checks and Shift+N shortcuts, and unavailable commands show as disabled.
  - A corrupt `jasper:workspaces` value gives the default layout plus one warning toast.
  - The production build (`vite build`, vendor chunks) boots to the engine gate under `vite preview`.

## Deviations, TODOs and notes

- **Creating a project from Home is not possible yet.** The engine answers 501 on `POST /api/projects` until WP-2F
  lands, so the manual check used `/project/demo` (in-memory project), which mounts the same `EditorShell`.
- **`@jasper/ui` now depends on `@jasper/project` at runtime** (it used to be type-only). TimecodeField uses
  `formatTimecode`/`parseTimecodeEntry` from the project package, as the brief asks. ARCHITECTURE §3.1 lists type-only
  imports for `ui`, so the integrator may want to note this exception.
- **Contract-Change (additive):** `UiCommand` gains optional `labelFor(ctx)`, `disabledReason(ctx)` and `hidden`.
- **Test file changed outside owns_paths:** `apps/web/test/app.test.tsx` now sets a 1920×1080 happy-dom viewport, because
  happy-dom's default 1024 px width selects the compact layout. Its title changed from "placeholder shell" to
  "editor shell".
- **Workspaces not shipped:** WS-001 also lists `audio` and `captions`. They need the Audio Track Mixer and Text panels,
  which are not in the panel registry, so they are omitted. `motion` is included.
- **Popout windows (DK-031) are not implemented.** They are optional in the brief. Floating groups work: panel menu ▸
  Undock Panel, or dockview's drag-to-float.
- **Not implemented from the SHOULD/MAY set:**
  - HD-007 status bar
  - DG-006 movable dialogs
  - PC-007 small tabs
  - PC-021 toolbar overflow
  - the Keyboard Shortcuts editor dialog (`app.keyboardShortcuts` stays unregistered and therefore disabled)
  - palette `Tab` secondary actions and usage-learned ranking (recent commands are shown first)
  - DK-023 Ctrl-drop to float (dockview's own float gesture applies)
- **Menus:** `edit.cut` / `edit.copy` / … are global keymap ids that no package registers yet; they show disabled.
  Timeline-scoped equivalents (`timeline.copy` …) are WP-2B's.
- **Code splitting:** vendor chunks are split in `vite.config.ts`. Per-panel lazy loading needs the panel owners to wrap
  their components in `React.lazy`.
- **Dev hook:** in dev builds `window.__jasperShell = { dock, workspaces, shell }` exposes the dock for E2E checks (WP-3I).

## Review (WP-2A reviewer)

Re-ran `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @jasper/web build`, plus `pnpm dev` with
Chrome at 1920×1080 (layout, corrupt-storage toast, `` ` `` maximize, Ctrl+Shift+P) and the production build under
`vite preview` (engine gate, then "Continue without engine" renders the dock). Fixes committed:

- Fixed-width frames are exactly 40 / 52 px (they were 40.75 / 52.75).
- Closing the focused panel through dockview (tab ×, group close) clears the focus store, so its keymap scope stops
  winning and `panel.close` / `panel.float` stop targeting a removed instance. Backward focus cycling with nothing
  focused now starts at the last panel.
- Workspace ids resolve own keys only (`Object.hasOwn`): stored state or the agent-exposed `workspace.switch` could make
  `"constructor"` / `"__proto__"` pass as workspace records.
