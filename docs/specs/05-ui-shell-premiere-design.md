# 05 — UI shell and Premiere-style design system (functional spec)

Status: implementation-ready functional spec. Topic: `ui-shell`.
Audience: engineers building `packages/editor-ui` (shared React UI), `apps/web` (web + PWA) and `apps/desktop` (Electron).
Clean-room: this is original prose. It describes behavior and requirements only. It contains no code, identifiers, paths or comments from the purchased starter template. Implementers must not consult the template; they work from this doc, the other docs in `docs/specs/`, `docs/research/` and `docs/ARCHITECTURE.md`.

Primary inputs (ours, free to use): `docs/research/premiere-ui-design-spec.md` (palette, metrics, keymap; cited below as **[PUI §n]**), `docs/research/orquester-multiplatform-setup.md` (**[OMS §n]**), `docs/research/native-video-libraries.md` (**[NVL §n]**), `docs/research/fframes.md` (**[FF §n]**).

Companion specs own the internals this doc only frames. This doc owns the chrome, layout, look and cross-panel UX:
- Timeline editing behavior (trim modes, snapping math, drag semantics) belongs to the timeline spec. This doc owns the timeline panel's *chrome*: header, track-header visuals, ruler visuals, and the zoom bars.
- The document model (sequences, tracks, clips, assets, bins, keyframes, markers) belongs to the state/data spec.
- The Program monitor's compositing and direct manipulation belong to the preview/inspector spec. This doc owns monitor chrome.
- Export pipelines (native ffmpeg, Remotion, fframes, browser) belong to the rendering/engine spec. This doc owns the Export dialog/mode UX and the Jobs panel.
- Agent planning, tools and safety belong to the agent spec. This doc owns the Agent panel and how the agent drives the UI.

> **Superseded (wp-mcp, ARCHITECTURE D-18 / §11).** JasperEditor has no in-app agent: external coding agents (Claude Code, Codex CLI, Cursor) drive it through the `jasper-mcp` MCP server. The Agent panel (§17), the Agent workspace, the Agent menu, the header Agent button, the Agent tool, the palette's "Ask the agent" row and the `Shift+0` / `Ctrl+.` bindings were removed. Requirements below that depend on them are marked **[SUPERSEDED]** and are not implemented. What remains of the agent UI: `Agent:` History entries with the sparkle (HIS-002, without the "Show in Agent panel" link), the clip flash, agent toasts, a shell-level approval card (Approve / Deny) for destructive agent transactions, and Help ▸ **Connect an AI Agent…**.

---

## 0. How to read this spec

- Requirements have IDs of the form `AREA-NNN`. Work packages reference them. IDs are stable: never renumber; mark removed IDs "withdrawn".
- **MUST** = required for the first shippable shell. **SHOULD** = expected in v1 unless descoped explicitly. **MAY** = optional or later.
- "Beyond baseline" (⊕) marks requirements where JasperEditor goes past the starter template's capabilities. Section 23 summarizes them.
- Sizes are CSS px at 1× density on the desktop "normal" density. Touch density overrides are in §19.
- Keyboard shortcuts are written Windows-style (`Ctrl`, `Alt`). On macOS, `Ctrl`→`Cmd` and `Alt`→`Opt` unless a row says otherwise. The keymap tables in [PUI §16] are the source of truth for the default map. This doc only adds shell-level bindings and deviations.

### 0.1 Area prefixes

| Prefix | Area | Section |
|---|---|---|
| `SH` | Shell architecture, runtime, state, persistence | §2 |
| `HD` | Title/menu bar and header bar | §3 |
| `WS` | Workspaces and workspace tabs | §4 |
| `DK` | Docking, splitters, floating/popout, maximize | §5 |
| `PC` | Panel chrome: tab strip, panel menu, panel toolbar | §6 |
| `FO` | Focus model | §7 |
| `DT` | Design tokens: color, spacing, radius, elevation, z-order, motion | §8 |
| `TY` | Typography and timecode display | §9 |
| `IC` | Icons and cursors | §10 |
| `CT` | Core controls: buttons, fields, scrubby numbers, sliders, lists, scrollbars | §11 |
| `MN` | Menus: menubar, panel menus, dropdowns, context menus, command palette | §12 |
| `TT` | Tooltips | §12.6 |
| `TS` | Toasts and notifications | §13 |
| `DG` | Dialogs (general) and the dialog catalog | §14 |
| `EX` | Export dialog / Export mode / Quick Export | §15 |
| `PN` | Panel catalog (common rules) | §16.0 |
| `PRJ` `PGM` `ECP` `EFX` `TOOL` `TLC` `MTR` `MIX` `HIS` `INF` `MRK` `PRP` `MGT` `TXT` `MTD` `JOB` `EVT` | Individual panels (`PGM` covers both monitors; Source-only items are marked) | §16 |
| `AG` | Agent panel and agent control of the UI | §17 |
| `KB` | Command registry and keymap (shell level) | §18 |
| `MB` | Mobile/tablet shells, gestures, sheets | §19 |
| `PWA` | Installable PWA specifics | §20 |
| `EL` | Electron desktop specifics | §21 |
| `A11Y` `PERF` | Accessibility and performance budgets | §22 |

---

## 1. Goals, non-goals, and the baseline we replace

### 1.1 Baseline (what the starter template offers, described behaviorally)

The starter ships one fixed, non-responsive editor screen:
- a top toolbar with a few tool modes (select, draw a solid, insert text), a file import button, undo/redo, save/load of the project state as JSON, a background-activity indicator and preview zoom buttons;
- a preview area with a fixed-width properties column to its right (showing composition settings and the export controls when nothing is selected, and per-item properties when exactly one item is selected);
- a playback bar (split, snapping, current time, go-to-start/end, play/pause, duration, loop, mute, fullscreen, timeline zoom);
- a timeline with a vertical height drag handle, untyped numbered tracks, per-track hide and mute toggles.

Its styling is a handful of theme colors plus ad-hoc gray utility classes. It has no configured font, no docking, no tabs, no panel focus, no menus beyond two context menus, no dialogs, no tooltips, no breakpoints and no PWA plumbing. Keyboard shortcuts are global. The export UI offers two codecs with one browser/cloud render path. Toasts exist for a few error and success cases.

### 1.2 Goals

1. G1 — **Premiere-grade workspace.** A docked, tabbed, resizable, persistent panel workspace that a Premiere Pro editor recognizes immediately: layout, panel names, panel menus, the focused-panel outline, `` ` `` maximize, workspace presets, the Premiere default keymap.
2. G2 — **One design system.** Every pixel comes from tokens (the Premiere research palette, [PUI §3]). There are no raw color literals in components.
3. G3 — **Three engines are visible and controllable in the UI.** The user always knows which engine previews, renders or processes something: Remotion (React compositions and the preview Player), Native (ffmpeg and friends in the engine daemon), and fframes (Rust/SVG motion graphics). See §16 (badges, render bar, Jobs) and §15 (engine choice on export).
4. G4 — **Agent as a first-class citizen.** The AI agent has its own dockable panel. It can drive the same command surface as menus and shortcuts, and its proposals are previewed in place (ghosts) before being applied as undoable, labeled history steps.
5. G5 — **Three runtimes, one UI package.** The same panel components run on the web, as an installed PWA (desktop and mobile), and in Electron. Phones and tablets get dedicated touch shells that reuse panel internals.

### 1.3 Non-goals (v1)

- A light theme (tokenized so it can come later; `DT-004`).
- Multicam, VR, Lumetri-parity color grading, and the v27-style Color mode. The Color workspace ships with a basic color panel and scopes only if the color spec delivers them.
- Pixel-perfect Premiere cloning. We copy *conventions*, never Adobe assets (logos, icons, the "Adobe Clean" font, product names, splash art). [PUI legal note]

---

## 2. Shell architecture

### 2.1 Layering

```
packages/editor-ui/src/
  shell/        workspace host, header, menubar, focus, layout-mode switch, persistence adapters
  panels/       one folder per panel (see §16); each exports a PanelDefinition
  ui/           design-system primitives (Radix-based): button, icon-button, menu, dropdown, dialog,
                tooltip, tabs, toggle-group, slider, scrubby-number, scroll-area, toast host, sheet
  theme/        tokens.css (the --pr-* variables), fonts.css, tailwind bridge
  icons/        icon registry: lucide re-exports + our own NLE glyphs
  commands/     command registry, keymap resolver, menu model
  mobile/       phone and tablet shells, bottom sheets, touch timeline adapters
apps/web        hosts <EditorApp runtime="web"> (SPA, PWA registration)
apps/desktop    Electron main/preload; loads the same web build from the engine origin [OMS §8.5]
```

Paths are proposals. `docs/ARCHITECTURE.md` is authoritative once written.

- **SH-001 (MUST)** The shell is a separate layer from panel internals. A panel component receives no layout props. It reads the data it needs from stores and context, so it can be rendered in a dock group, a floating group, a popout window, a phone bottom sheet or a tablet tab without changes.
- **SH-002 (MUST)** A single root component `EditorApp` accepts `{runtime: 'web' | 'pwa' | 'desktop', engine: EngineConnection, storage: ShellStorage}`. Runtime differences (native menus, window controls, file pickers, popout windows) go through injected adapters, never through `if (electron)` checks inside panels. This mirrors Orquester's `runtime` / transport injection [OMS §0, §8.2].
- **SH-003 (MUST)** A **layout-mode switch** chooses `desktop | compact | tablet | phone` (§19.1) and renders the matching shell. Every shell shares the same stores, command registry, toast host, dialog host and drag-overlay host.
- **SH-004 (MUST)** Globally mounted, once per window, above all panels: the toast host, the dialog host, the menu/popover portal root, the tooltip provider, the drag overlay layer (clip/asset ghosts can cross panels, including floating ones), the forced-cursor layer (§10.2), and the single keyboard dispatcher (§18).
- **SH-005 (MUST)** There are no module-level singleton DOM refs. Anything a panel exposes to others (the Program player handle, the timeline scroll container, the Source player handle) is published through a **panel service registry** keyed by panel instance id, with explicit "not mounted" handling. Callers must tolerate a missing target (they no-op and, if user-initiated, show a toast). This is what lets Program and Timeline be docked, floated, popped out or hidden.
- **SH-006 (MUST)** Program Monitor and Timeline panels are **keep-alive**: they stay mounted when their tab is hidden behind another tab (their DOM is detached from layout but not unmounted), so playback state, scroll position and decoded frames survive tab switches. Other panels MAY unmount when hidden and MUST restore their view state (scroll offset, expanded tree nodes, sort) from a per-panel view-state store.
- **SH-007 (SHOULD)** Hidden panels receive a `visible=false` signal and pause expensive work (meters, scopes, thumbnail generation, agent streaming animations), but keep their data subscriptions.

### 2.2 Shell state (data concepts)

| Store | Contents | Undoable | Persisted where |
|---|---|---|---|
| `workspaceStore` | active workspace id; for each workspace: *current* layout JSON and *saved* layout JSON; floating/popout groups; maximized group id; per-panel view state | No | Shell storage (per user, per machine), §2.3 |
| `focusStore` | focused panel instance id; panel under the pointer; last focused panel per kind (last Timeline, last monitor) | No | Not persisted |
| `uiPrefsStore` | theme, contrast, density, label-color preset, tooltips on/off, reduced motion, show workspace tabs, compact header, auto-scroll mode, timecode display mode, language | No | Shell storage |
| `commandRegistry` | all commands (id, label, icon, scope, enabled/checked predicates, run) | n/a | Code |
| `keymapStore` | active keymap preset and user overrides | No | Shell storage, exportable JSON |
| `notificationStore` | toast queue and the notification log | No | Session only (log capped at 200) |
| `agentUiStore` | agent panel UI state: draft prompt, scroll anchor, expanded cards, autonomy mode | No | Per project |

Editing state (sequences, selection, playhead, marks) lives in the document/editor stores defined by the data spec. The shell only reads it.

- **SH-010 (MUST)** Shell state changes are **never** entries in the undo history. Undo/redo never changes layout, focus or preferences.
- **SH-011 (MUST)** Selection, playhead position, active sequence and active tool are editor state shared by all panels. Two panels showing the same thing, such as two Project panels on the same bin, stay in sync.

### 2.3 Persistence

- **SH-020 (MUST)** Shell storage is a small versioned key-value adapter with `load(key) / save(key, value) / migrate(fromVersion)`. The web/PWA implementation uses `localStorage` (layout JSON is small). The Electron implementation writes JSON files under the app's user-data directory (`workspaces/*.json`, `prefs.json`, `keymaps/*.json`). The interface is identical in both.
- **SH-021 (MUST)** Every persisted shape carries a `version`. On load: migrate if older; if newer or corrupt, discard **that key only**, fall back to defaults, and show a one-time warning toast ("Workspace layout was reset because it could not be read").
- **SH-022 (MUST)** Layout saves are debounced (300 ms after the last layout change) and flushed on `pagehide`/`beforeunload` and on Electron window close.
- **SH-023 (SHOULD)** Layout JSON references panels by **panel kind + instance id**, never by component identity. Unknown panel kinds (e.g. from a newer build) are dropped on load and their space is given to neighbors.
- **SH-024 (MUST)** Project files never contain workspace layouts. Layouts are a per-user preference, as in Premiere where workspaces live in user preferences. A project MAY record the name of the last-used workspace as a hint.

### 2.4 Engine connection awareness ⊕

The UI talks to the engine daemon (`apps/engine`) over HTTP/NDJSON/WS [OMS §8.6]. The web/PWA build can also run browser-only with fallbacks [NVL §3].

- **SH-030 (MUST)** The shell exposes `engineStatus: 'local' | 'remote' | 'browser-only' | 'connecting' | 'disconnected'` plus capability flags `{nativeFfmpeg, fframes, remotionServerRender, transcription, proxies}`.
- **SH-031 (MUST)** Any command whose capability is unavailable stays **visible but disabled** in menus, toolbars and the Export dialog. Its tooltip names the missing capability ("Requires the native engine. Connect to an engine in Preferences ▸ Engine."). Hiding such commands is not allowed: discoverability matters, and the agent must also see them as unavailable.
- **SH-032 (MUST)** When the engine drops mid-session, show a persistent warning toast with a "Reconnect" action. Running jobs are shown as "stalled" in Jobs. The editor keeps working on the browser-only path.

---

## 3. Title/menu bar and header bar

### 3.1 Anatomy (desktop shell, ≥ 1280 px)

```
Row A — title/menu bar (28 px)
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [J] File Edit Clip Sequence Markers Graphics View Window Agent Help │  MyProject — Sequence 01 • Edited │ ─ □ ✕ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
Row B — header bar (36 px)
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⌂  Import  Edit  Export │ Editing  Assembly  Effects  Audio  Captions  Motion  Agent  »  ⊞▾ │ ● Engine  ⟳3  ⇪  ✦  🔍  ⤢ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **HD-001 (MUST)** Row A (28 px, `--pr-bg-header`) holds the app mark, the in-app **menubar** (§12.1), the centered document title, and window controls or their reserved space (§21). The whole empty area of Row A is a window drag region in Electron and in desktop PWAs using Window Controls Overlay (§20). Interactive children opt out of dragging.
- **HD-002 (MUST)** The document title is `<project name> — <active sequence name>` with a dirty suffix `• Edited` while there are unsaved changes, and `(Read-only)` when the project is locked. Truncate the middle with an ellipsis. Hover shows the full project path (desktop) or project id (web).
- **HD-003 (MUST)** Row B (36 px) contains, left to right:
  1. **Home** (house icon): opens the Home screen (recent projects, new/open). §3.3.
  2. **Mode tabs** `Import | Edit | Export`. Active mode = `--pr-text-strong` with a 2 px underline; inactive = `--pr-text-secondary`. Modes swap the entire area below the header. The dock layout is untouched while in another mode, and returning to Edit restores it exactly.
  3. **Workspace tabs** (visible only in Edit mode): one text tab per workspace in the user's workspace list order (§4). The active tab is `--pr-accent` text with a 2 px `--pr-accent` underline, matching the classic Premiere workspace bar. Tabs that don't fit collapse into a `»` overflow menu.
  4. **Workspaces menu** button (layout-grid icon + chevron): §4.3.
  5. Right cluster (icon buttons, 24×24 with tooltips):
     - **Engine status** chip (§2.4): a colored dot + short label (`Local`, `Remote`, `Browser`, `Offline`). Click opens an engine popover with capability list, engine version, CPU/queue load, and "Connect to engine…".
     - **Background jobs**: circular progress icon with a numeric badge of running+queued jobs. Click opens the Jobs panel (focus it if open; otherwise open it floating near the button). Right-click lists the last 5 jobs.
     - **Quick Export** (share/upload icon): popover (§15.6).
     - **Agent** (sparkle icon) **[SUPERSEDED: removed]**: toggles/focuses the Agent panel (§17). It shows a pulsing dot while the agent is working and a count badge when proposals are waiting for review.
     - **Search / command palette** (magnifier): §12.5.
     - **Full screen** (expand icon): toggles app full screen (Fullscreen API on web, window full screen on Electron).
- **HD-004 (MUST)** Workspace tabs can be reordered by dragging (this reorders the workspace list and therefore the `Alt+Shift+N` numbering). Right-click on a workspace tab shows: Reset to Saved Layout, Save Changes to This Workspace, Duplicate…, Rename…, Delete (custom only), Hide from Bar, Edit Workspaces….
- **HD-005 (SHOULD)** A "Compact header" preference merges Row A into Row B: the menubar collapses into a single `≡` app-menu button at the far left, and the title moves into Row B's center. It is the default on web when the viewport is shorter than 800 px, and always used in the compact desktop layout (§19.1).
- **HD-006 (MUST)** On Electron/macOS the menubar is native (system menu bar). Row A then shows only the traffic-light space on the left and the title, and is 28 px tall to align with the traffic lights.
- **HD-007 (SHOULD)** An optional **status bar** (22 px, bottom of window, off by default; View ▸ Show Status Bar) shows: engine status, dropped-frame counter of the Program monitor, the current job summary, and the agent state. When the status bar is visible, the header's job indicator still stays.

### 3.2 Header behaviors

- **HD-010 (MUST)** Switching workspace via tab, menu or shortcut (`Alt+Shift+1…9`) loads that workspace's *current* layout (not its saved one) within one frame, with no animation. Panel instances present in both layouts keep their state (the same Timeline instance keeps its scroll/zoom).
- **HD-011 (MUST)** Mode switching (Import/Edit/Export) preserves playback state. Entering Export pauses playback.
- **HD-012 (MUST)** Header icons meet the tooltip rules (§12.6): `Name (Shortcut)`.

### 3.3 Home screen and Import mode (brief)

- **HD-020 (MUST)** Home: left rail with New Project, Open Project…, Open from engine (remote projects list), Recent; main area a grid/list of recent projects with poster thumbnail, name, modified time, duration and location. It uses the same tokens. On first launch with no projects, it shows a three-step "Create, Import, Edit" empty state and a "Start with the agent" prompt field (the agent creates a project from a description) ⊕.
- **HD-021 (SHOULD)** Import mode: left locations tree (desktop: local disks via the engine; web: File System Access API when available, otherwise a picker/drop zone; remote engine: server media folders), center thumbnail grid with hover scrub, right "Ingest settings": copy media into project, create bin, create sequence from selection, **Create proxies (native)**, **Generate thumbnails and waveforms (native)**, **Transcribe (native/remote)** ⊕. A primary pill "Import" button sits bottom-right. The native options are disabled per SH-031 when unavailable.

---

## 4. Workspaces

### 4.1 Concepts

- A **workspace** = named layout (dock tree + sizes + floating/popout groups + per-panel view state + monitor button layouts) with a *current* and a *saved* snapshot.
- **Built-in** workspaces ship with the app and cannot be deleted, only reset. **Custom** workspaces are user-created.

### 4.2 Built-in workspaces (default order)

| # | Id | Name | Layout summary (percentages of the area below the header) |
|---|---|---|---|
| 1 | `editing` | Editing (default) | Top row ≈ 55% height: left group (Source, Effect Controls, Audio Clip Mixer, Metadata) 31% · Program 47% · right column **full-height** group (Properties, Agent, Essential Graphics) 22%. Bottom row: Project group (Project, Media Browser, Effects, Markers, History, Info) 21% · Tools 40 px · Timeline · Audio Meters 52 px. [PUI §5.4] |
| 2 | `assembly` | Assembly | Project (icon view) top-left 50%, Source, Program; Timeline bottom |
| 3 | `effects` | Effects | Effect Controls large left; Program; Effects + Properties right column; Timeline bottom |
| 4 | `audio` | Audio | Audio Track Mixer top-left; Program; Timeline with taller audio tracks; wide meters |
| 5 | `captions` | Captions and Graphics | Text panel (Transcript / Captions) left; Program; Properties right; Timeline bottom |
| 6 | `motion` ⊕ | Motion | Motion Templates browser (Remotion + fframes) left; Program center; Properties + Effect Controls right (Effect Controls with a large keyframe area); Timeline bottom |
| 7 | `agent` ⊕ | Agent | **[SUPERSEDED: removed; stored state drops this workspace on load]** Agent panel left 28% full-height; Program top-center; Timeline bottom-center; Jobs + Properties right |
| 8 | `vertical` | Vertical | Program at 9:16 centered with Source as a tab in the same group; Properties right; Timeline bottom |
| 9 | `essentials` | Essentials | Single monitor: Program center-top; Project + Properties right; Timeline full width bottom |
| — | `color` | Color | Program large; scopes left; color controls right; Timeline bottom. Only listed when the color feature ships. |

- **WS-001 (MUST)** Ship `editing`, `assembly`, `effects`, `audio`, `captions`, `motion`, `agent`, `essentials`. `vertical` is SHOULD. Each built-in is defined as data (a builder function or a JSON fixture per workspace), and the definitions are unit-tested for "every panel referenced exists" and "no panel appears twice unless multi-instance".
- **WS-002 (MUST)** First launch opens `editing`. The app remembers the last active workspace per machine.
- **WS-003 (MUST)** Default sizes are proportions, applied to the actual window size at creation time. Fixed-size panels (Tools 40 px wide, Audio Meters 52 px wide) keep their pixel size; proportional panels absorb the remainder.

### 4.3 Workspace operations (Workspaces menu and Window ▸ Workspaces)

- **WS-010 (MUST)** Workspaces menu contents: list of workspaces with a check on the active one and their shortcut (`Alt+Shift+1…9`), separator, **Reset to Saved Layout** (`Alt+Shift+0`), **Save Changes to This Workspace**, **Save as New Workspace…**, **Edit Workspaces…**, separator, **Import Workspace…**, **Export Workspace…** (JSON file).
- **WS-011 (MUST)** Semantics:
  - Any layout change updates the workspace's *current* snapshot (auto-saved, SH-022).
  - *Save Changes* copies current → saved.
  - *Reset to Saved Layout* copies saved → current and re-renders. For built-ins, "saved" starts as the factory layout. Edit Workspaces offers "Restore factory layout" per built-in.
  - *Save as New Workspace* asks for a name (unique, 1–40 chars, trimmed; duplicates get an inline error) and creates a custom workspace whose current and saved snapshots are both the present layout.
- **WS-012 (MUST)** Edit Workspaces dialog: a reorderable list (drag handles) of workspaces with a per-row "Show in bar" checkbox, rename (custom only), delete (custom only, confirmation), and "Restore factory layout" (built-ins). It also has a "Show workspace tabs in header" checkbox (default on). The first 9 visible entries get `Alt+Shift+1…9`.
- **WS-013 (SHOULD)** Workspaces store the Program/Source monitor button-bar layouts (§16.3) and the timeline's track-header width, as in Premiere.
- **WS-014 (MUST)** Imported workspace JSON is validated against the layout schema. Unknown panels are dropped (SH-023). If the name conflicts, it is suffixed ` (2)`.

---

## 5. Docking

Recommended engine: **dockview** (MIT) themed through its CSS variables mapped to our tokens; alternative `flexlayout-react` [PUI §5.3]. Verify the API of the installed version. Requirements below are library-agnostic.

### 5.1 Structure

- **DK-001 (MUST)** The Edit-mode area is a **dock tree** of splits (rows/columns) whose leaves are **panel groups**. A group holds one or more panels as tabs; exactly one tab is active.
- **DK-002 (MUST)** Groups are separated by **gutters** of `--pr-gutter` (3 px) painted `--pr-bg-app` (black). Group frames have `--pr-radius-frame` (4 px) corners and `--pr-bg-panel` bodies. No borders or shadows inside the workspace.
- **DK-003 (MUST)** Minimum group size 120×80 px, or the panel's declared minimum if larger (e.g. Tools 40×120, Audio Meters 40×120, Timeline 320×160, Program 240×160).

### 5.2 Resizing

- **DK-010 (MUST)** Hovering a gutter shows `col-resize`/`row-resize`. The visual gutter is 3 px, but the hit area is 7 px (a transparent overlay centered on it). Dragging resizes every group that shares that divider line.
- **DK-011 (SHOULD)** Hovering an **intersection** where three or more groups meet shows a 4-way `move` cursor, and dragging resizes on both axes at once.
- **DK-012 (MUST)** Resizing runs at display refresh rate: pointer moves are coalesced into one layout per animation frame, and panel contents learn their new size through ResizeObserver. No React re-render of panel internals is triggered by the dock itself during a drag (PERF-003).
- **DK-013 (MUST)** Resizing respects minimum sizes. When the window shrinks below the sum of minimums, the dock clips (scrolls) rather than overlapping groups, and the compact layout switch (§19.1) takes over below 1280 px wide.
- **DK-014 (SHOULD)** Double-clicking a gutter equalizes the two neighbors.

### 5.3 Drag-and-drop docking

- **DK-020 (MUST)** A panel is dragged by its **tab**. A whole group is dragged by the empty area of its tab strip (or the group grip at the strip's left edge).
- **DK-021 (MUST)** While dragging over a target group, show drop zones:
  - **Edge zones** (left/right/top/bottom bands ≈ 25% of the target dimension): dropping inserts a *new group* beside the target, splitting its space.
  - **Center zone** and the target's **tab strip**: dropping adds the panel as a *tab* in that group. Over the tab strip, an insertion caret shows the exact tab position.
  - **Window-edge zones** (outer 16 px of the whole dock): dropping inserts a full-height or full-width group at that edge.
  - Highlight: `--pr-accent` at 35% fill with a 2 px `--pr-accent` border, drawn above everything except the drag ghost.
- **DK-022 (MUST)** `Esc` during a dock drag cancels it with no layout change.
- **DK-023 (MUST)** Holding `Ctrl` while dropping (or dropping outside the dock area) **undocks** the panel into a floating group (§5.4).
- **DK-024 (MUST)** When a group loses its last panel, it is removed and its neighbors absorb its space. The dock never shows empty groups, except the "empty workspace" state (DK-043).

### 5.4 Floating groups and popout windows

- **DK-030 (MUST)** A floating group is an in-window frame above the dock with a 28 px tab strip that works as a title bar (drag to move, drag edges/corners to resize). It keeps a minimum 40 px of its tab strip on screen when the window resizes. Floating groups accept drops like docked groups.
- **DK-031 (SHOULD, desktop and web)** **Pop out** (panel menu ▸ Undock Panel into Window): the group moves to a separate OS window. On Electron this is a real `BrowserWindow` sharing the renderer session. On web it uses `window.open` of a same-origin shell page. The popout window is chrome-less apart from its tab strip. Closing the popout window re-docks its panels to their last docked location; it does not close them.
- **DK-032 (MUST)** Keyboard shortcuts, drag-and-drop between windows (asset → timeline), toasts and dialogs work in popout windows. Toasts and dialogs render in the window that triggered them.
- **DK-033 (MUST)** Floating and popout positions/sizes persist in the workspace. For popouts on Electron, the target display id is stored too. On load, windows are clamped to a currently connected display.
- **DK-034 (SHOULD)** Program Monitor and Timeline MAY be popped out (useful for a second display). Because of SH-005 this must work. If it proves unstable, gate popout for those two behind a preference, but keep floating supported.

### 5.5 Maximize

- **DK-040 (MUST)** `` ` `` (physical key `Backquote`) toggles maximize of the group **under the pointer**. `` Shift+` `` toggles maximize of the **focused** group. The panel menu has Maximize Panel Group. A maximized group fills the entire dock area instantly (no animation). Restoring returns to the exact prior layout; the dock tree is not modified while maximized.
- **DK-041 (MUST)** While maximized, a thin `--pr-accent` 1 px inner outline and a small "Restore" button in the tab strip's right edge are shown. Switching workspace restores first.
- **DK-042 (MUST)** `` Ctrl+` `` toggles **full-screen video** of the Program monitor (video only, black background, no chrome; `Esc` exits). This is a monitor feature, not dock maximize.
- **DK-043 (MUST)** If a user closes every panel, show an empty-workspace state: a centered message "No panels open", buttons "Reset to Saved Layout" and "Window menu", and a drop target.

### 5.6 Opening panels

- **DK-050 (MUST)** Window menu lists every panel kind with a check if open. Choosing a **closed** panel opens it in its *home group* for the current workspace (the group where the workspace default would put it). If that group doesn't exist, it opens as a floating group near the center. Choosing an **open** panel brings its tab to front and focuses it.
- **DK-051 (MUST)** `Shift+1…9` focus panels (Project, Source, Timeline, Program, Effect Controls, Audio Track Mixer, Effects, Media Browser, Audio Clip Mixer) opening them if closed [PUI §16.2]. `Shift+0` ⊕ focuses the Agent panel and places the caret in its prompt field (verify that `Shift+0` is unused in the active keymap; if it conflicts, it is user-remappable). **[SUPERSEDED: `Shift+0` is unbound.]**
- **DK-052 (MUST)** Multi-instance panels (Project, for extra bins; Timeline, for extra sequences) are listed in Window with their instance context, e.g. `Project: Graphics bin`. Source, Program, Tools, Audio Meters, Agent and Jobs are single-instance per window. Opening a bin "in new panel" creates a new Project panel instance as a tab next to the current one.

---

## 6. Panel chrome

### 6.1 Tab strip

```
┌ 28 px ───────────────────────────────────────────────────────────────────────┐
│ Source: interview_A.mov ≡ │ Effect Controls │ Audio Clip Mixer │ Metadata │ » │
├──────────────────────────────────────────────────────────────────────────────┤
│ [optional panel toolbar row, 28 px]                                           │
│ panel body                                                                    │
```

- **PC-001 (MUST)** Tab strip height `--pr-tab-h` (28 px), background `--pr-bg-panel` (same as the body; tabs are distinguished by text, not by boxes). Tab padding 0 12 px, text 12 px.
- **PC-002 (MUST)** Tab label = panel title plus optional context: `Source: <clip>`, `Program: <sequence>`, `Project: <project or bin>`, `Audio Track Mixer: <sequence>`, `Timeline` panels show sequence tabs instead (§16.7). Truncate context with an ellipsis; the full label goes in a tooltip.
- **PC-003 (MUST)** Active tab: `--pr-text-strong` text with a 2 px `#cecece` (token `--pr-tab-underline`) underline. Inactive: `--pr-text-secondary`; hover: `--pr-text-primary`. When the group is focused, the active tab's underline is unchanged; focus is shown by the frame outline (FO-002).
- **PC-004 (MUST)** The **panel menu** glyph `≡` (16 px) is drawn right after the *active* tab's title only. Clicking it (or right-clicking the tab) opens the panel menu (§6.2).
- **PC-005 (MUST)** Tabs reorder by drag within the strip. When tabs overflow, a `»` button at the right end lists hidden tabs; choosing one activates it (and scrolls it into view).
- **PC-006 (MUST)** Close affordance: a 12 px `×` appears on hover of a tab (always visible on touch). Middle-click closes a tab. Closing the last tab of a group removes the group (DK-024). Closing the Program or Timeline panel when they are the only instance asks nothing but is reversible through Window.
- **PC-007 (SHOULD)** "Small tabs" group setting (Panel Group Settings ▸ Small Tabs): 22 px strip, 11 px text.
- **PC-008 (MUST)** Tab strip double-click on empty area toggles maximize of the group (same as DK-040).
- **PC-009 (MUST)** An attention indicator can be placed on an inactive tab: a 6 px dot after the title in `--pr-accent` (new agent message, finished job, new captions). It clears when the tab becomes active. ⊕

### 6.2 Panel menu

- **PC-010 (MUST)** Every panel menu ends with a common section:
  - Undock Panel (to floating), Undock Panel into Window (popout, if supported), Undock Other Panels in Group;
  - Close Panel, Close Other Panels in Group;
  - Panel Group Settings ▸ Close Panel Group, Undock Panel Group, Maximize Panel Group, Small Tabs, (MAY) Stacked Panel Group.
- **PC-011 (MUST)** Panel-specific commands come first, defined by the panel's definition (§16.0). Examples: Project ▸ Preview Area, Metadata Display…, New Bin, List/Icon/Freeform; Program ▸ Playback Resolution, Safe Margins, Transparency Grid, Loop; Agent ▸ New Conversation, Autonomy ▸, Clear Proposals, Export Transcript….

### 6.3 Panel toolbar and footer rows

- **PC-020 (MUST)** Panels that need controls use a 28 px toolbar row below the tab strip (search fields, filters, view toggles) and/or a 28–36 px footer row (Project view switches and zoom, monitor transport). These rows use `--pr-bg-panel` and are separated from the body by `--pr-border-subtle` only when the body scrolls under them.
- **PC-021 (MUST)** Toolbars reflow: when narrower than their content, lower-priority controls move into a trailing `⋯` overflow menu (each control declares a priority).

### 6.4 Panel body

- **PC-030 (MUST)** Body padding 8 px for forms, 0 for lists/viewers. Scrollbars per CT-060.
- **PC-031 (MUST)** Each panel defines an **empty state** (icon, one-line message, primary action): Effect Controls "Select a clip to edit its effects", Source "Double-click a clip in the Project panel to open it here", Timeline "Create or open a sequence" with a New Sequence button and a drop zone, Agent "Ask the agent to edit, find, or generate", Jobs "No background jobs".
- **PC-032 (MUST)** A panel error boundary: if a panel throws, only that panel shows "This panel crashed" with Reload Panel and Copy Details. The rest of the workspace keeps working.

---

## 7. Focus model

Premiere's shortcuts depend on the focused panel; the outline tells the user which one.

- **FO-001 (MUST)** Exactly one panel instance is **focused** per window. Focus moves on `pointerdown` anywhere inside a panel (capture phase, before the panel's own handlers), on `focusin` from keyboard navigation, when a tab is activated, and through focus commands (`Shift+1…0`, next/previous panel).
- **FO-002 (MUST)** The focused group's frame gets a 1 px `--pr-focus-ring` outline (inside the gutter, so layout doesn't shift). No other visual change.
- **FO-003 (MUST)** `Ctrl+Shift+.` / `Ctrl+Shift+,` cycle focus forward/back through open, visible panels in reading order (top-left → bottom-right by group center).
- **FO-004 (MUST)** Opening a menu, dialog, popover or toast action does **not** change panel focus. When the overlay closes, focus returns to the previously focused element in the focused panel.
- **FO-005 (MUST)** Floating and popout groups participate in focus. The focused panel is per window; the keyboard dispatcher of each window uses its own focused panel.
- **FO-006 (MUST)** Implicit targets: commands that act on "the monitor" use the focused monitor if one is focused; otherwise, when the Timeline is focused, they act on Program; otherwise the last focused monitor. Commands that act on "the sequence" use the sequence of the focused Timeline, else of the Program monitor, else the last active sequence.
- **FO-007 (MUST)** Clicking inside a text input focuses the panel and the input. While an input, textarea or contenteditable has keyboard focus, single-key shortcuts are suspended (§18).

---
## 8. Design tokens

All values come from the Premiere research palette [PUI §3–§4] (sampled from Premiere's Spectrum "Darkest" UI and cross-checked against Adobe's open-source Spectrum tokens). They are ours to use; treat sizes as targets to tune by eye.

### 8.1 Rules

- **DT-001 (MUST)** Tokens are CSS custom properties with the `--pr-` prefix, defined in `packages/editor-ui/src/theme/tokens.css` and bridged into Tailwind 4 via an `@theme inline` block so utilities like `bg-pr-panel`, `text-pr-muted`, `border-pr-border-subtle` exist [PUI §3.6].
- **DT-002 (MUST)** Components use tokens only. Lint rule: no hex/rgb/hsl literals and no raw Tailwind palette classes (`neutral-*`, `gray-*`, `white/…`) in `packages/editor-ui/src/**` outside `theme/`. Exceptions: content colors that belong to the document (text fill defaults, solid colors), which live in the data layer.
- **DT-003 (MUST)** Themes switch via `data-pr-theme="darkest|dark"` and `data-pr-contrast="normal|high"` on `<html>`, applied before first paint (a tiny external boot script reads the stored preference, like Orquester's theme boot, to avoid a flash) [OMS §8.2].
- **DT-004 (MAY)** `light` theme later. Nothing may assume a dark background except the monitor pasteboard and meters.
- **DT-005 (MUST)** Density switches via `data-pr-density="normal|touch"` (§19.5).

### 8.2 Surface, text and accent tokens (Darkest = default, Dark = option)

| Token | Darkest | Dark | Use |
|---|---|---|---|
| `--pr-bg-app` | `#000000` | `#111111` | Window background, gutters, V/A divider |
| `--pr-bg-header` | `#1d1d1d` | `#262626` | Title/menu bar, header bar |
| `--pr-bg-panel` | `#1d1d1d` | `#262626` | Panel bodies, tab strips, monitor pasteboard |
| `--pr-bg-panel-alt` | `#1a1a1a` | `#232323` | Timeline track area, zebra rows |
| `--pr-bg-panel-raised` | `#232323` | `#2e2e2e` | Section headers, timeline header strip, targeted track header |
| `--pr-bg-field` | `#0e0e0e` | `#1d1d1d` | Inputs, dropdowns, number-field edit state |
| `--pr-bg-field-deep` | `#080808` | `#171717` | Search fields, meter wells |
| `--pr-bg-hover` | `#2a2a2a` | `#363636` | Hover |
| `--pr-bg-pressed` | `#303030` | `#3f3f3f` | Pressed, open-menu trigger |
| `--pr-bg-selected-row` | `#2c2c2c` | `#3a3a3a` | Selected row, unfocused panel |
| `--pr-border-subtle` | `#2a2a2a` | `#3a3a3a` | 1 px dividers inside panels |
| `--pr-border` | `#303030` | `#3f3f3f` | Control borders, track separators |
| `--pr-border-strong` | `#4b4b4b` | `#545454` | Scrollbar thumbs, slider tracks, secondary button borders |
| `--pr-text-primary` | `#e3e3e3` | `#e8e8e8` | Main text |
| `--pr-text-strong` | `#ffffff` | `#ffffff` | Active tab, clip names, emphasis |
| `--pr-text-secondary` | `#8d8d8d` | `#909090` | Inactive tabs, column headers, units, durations |
| `--pr-text-tertiary` | `#6a6a6a` | `#707070` | Disabled text/icons |
| `--pr-icon` / `--pr-icon-hover` | `#b0b0b0` / `#ebebeb` | `#b2b2b2` / `#ebebeb` | Icons |
| `--pr-accent` | `#4096f3` | `#54a3f6` | Playhead, focus outline, active toggles, links |
| `--pr-accent-fill` / `-hover` | `#1473e6` / `#0d66d0` | `#2680eb` / `#1473e6` | Primary buttons, current tool, menu item hover, primary selected row in focused panel |
| `--pr-target-fill` | `#005cc8` | `#1473e6` | Track target / source patch pills |
| `--pr-timecode` | `#46b8ff` | `#5ec2ff` | Current-time displays |
| `--pr-value` | `#46b8ff` | `#5ec2ff` | Scrubby numeric values |
| `--pr-focus-ring` | `#4096f3` | `#54a3f6` | Focused panel outline, keyboard focus ring |
| `--pr-tab-underline` | `#cecece` | `#cecece` | Active tab underline |
| `--pr-menu-bg` / `--pr-menu-border` | `#1d1d1d` / `#444444` | `#323232` / `#545454` | Menus, popovers, tooltips border |
| `--pr-tooltip-bg` | `#3a3a3a` | `#3a3a3a` | Tooltips |
| `--pr-overlay-scrim` | `rgba(0,0,0,.6)` | same | Modal backdrop |
| `--pr-danger` / `--pr-warning` / `--pr-success` | `#df3422` / `#e06400` / `#068850` | same | Status |

High contrast (`data-pr-contrast="high"`) raises `--pr-border-subtle` to `#3d3d3d`, `--pr-border` to `#5a5a5a`, `--pr-text-secondary` to `#b0b0b0`, `--pr-text-tertiary` to `#8d8d8d`, and `--pr-gutter` to 4 px.

### 8.3 Editing semantic tokens

Playhead (`--pr-playhead` = accent; **blue, not red**), In/Out range (`rgba(255,255,255,.10)` on rulers, `.06` on tracks), In/Out brackets `#e3e3e3`, work-area bar `#7a7a7a`, render bar red `#d8322a` / yellow `#e6df0a` / green `#27b14a`, snap line white 90% with 1 px black casing, trim regular/rolling red `#e4453a`, ripple yellow `#f5c518`, locked-track hatch, disabled clip 35% opacity, offline clip `#b3261e` body and `#ffdad6` text, keyframe `#b0b0b0`/`#ebebeb`, selected keyframe `#4096f3`/`#ffffff`, meters green `#2fbf4f` / yellow `#e6d21a` / red `#e5322b` / peak hold `#e3e3e3`, 8 marker colors (green default `#3fb54a`, red, purple, orange, yellow, white, blue, cyan). Full values: [PUI §3.3].

⊕ JasperEditor additions:

| Token | Value | Use |
|---|---|---|
| `--pr-agent` | `#a78bfa` | Agent identity color: agent avatar, agent-authored history entries, agent badge on clips it created |
| `--pr-ghost-stroke` | `var(--pr-accent)` dashed 1 px | Proposed (not yet applied) agent edits on the timeline and monitor |
| `--pr-ghost-fill` | `color-mix(in srgb, var(--pr-accent) 30%, transparent)` | Proposed clip bodies |
| `--pr-ghost-remove` | `color-mix(in srgb, var(--pr-danger) 35%, transparent)` + diagonal hatch | Ranges the agent proposes to delete |
| `--pr-engine-remotion` | `#e056b8` (Magenta tint) | Engine badge "R" and legends |
| `--pr-engine-fframes` | `#b07cff` (Purple tint) | Engine badge "F" |
| `--pr-engine-native` | `#58b6a6` (Teal tint) | Engine badge "N" (native-processed media: proxies, conformed audio) |

### 8.4 Label colors

- **DT-020 (MUST)** Implement the 16 label colors with three presets (`default` dark-saturated v24.4-style, `classic` pastel, `vibrant`) as JSON [PUI §3.4]. Each label has a body color and a light tint (for waveforms and text on dark).
- **DT-021 (MUST)** Default label per media kind: video-only Iris, video+audio Violet, audio Caribbean, still/GIF Lavender, sequence/nested Forest, bin Mango, captions Mango, **Remotion composition Magenta ⊕**, **fframes graphic Purple ⊕**, solid/adjustment Tan, text/title Lavender. Users can change defaults per kind in Preferences ▸ Labels, and relabel individual items.
- **DT-022 (SHOULD)** Offer the rename set (indigo, steel, jade, orchid, lagoon, moss, ruby, amber…) as the displayed names to avoid trade-dress confusion. Token names stay neutral (`--pr-label-01…16`) with display names from a locale table.

### 8.5 Spacing, sizing, radius

| Token | Value | Notes |
|---|---|---|
| `--pr-gutter` | 3 px | 4 px in high contrast |
| `--pr-radius-frame` | 4 px | Panel frames |
| `--pr-radius-control` | 4 px | Buttons, fields, dropdowns |
| `--pr-radius-menu` | 6 px | Menus, popovers |
| `--pr-radius-pill` | 12 px | Primary dialog buttons |
| `--pr-radius-clip` | 3 px | Timeline clips |
| `--pr-title-h` | 28 px | Row A |
| `--pr-header-h` | 36 px | Row B |
| `--pr-tab-h` | 28 px | Tab strips |
| `--pr-row-h` | 22 px | List/tree/property rows |
| `--pr-control-h` | 24 px | Buttons, dropdowns |
| `--pr-icon-btn` | 24 px (16 px glyph) | Transport buttons 28 px |
| `--pr-track-header-w` | 176 px | Min ≈ 140, max ≈ 2× min |
| `--pr-hit-min` | 24 px (normal), 44 px (touch) | Minimum pointer target |
| Spacing scale | 2, 4, 6, 8, 12, 16, 24 px | Use only these |

### 8.6 Elevation and z-order

There are no shadows inside the dock. Shadows are allowed only on overlays: `0 8px 24px rgba(0,0,0,.5)` for menus/popovers/dialogs, `0 4px 12px rgba(0,0,0,.45)` for floating groups and toasts.

- **DT-030 (MUST)** One z-index scale, exported as constants and CSS variables, used by every overlay:

| Layer (bottom → top) | z | Contents |
|---|---|---|
| panel internals | 0–50 | Clips, playhead, in-panel overlays |
| dock drop zones | 90 | Docking highlights |
| floating groups | 100–199 | Stacked by last activation |
| maximized group | 200 | |
| forced-cursor layer | 300 | Transparent full-window cursor capture during gestures |
| popovers, dropdowns, menus, sheets | 1000 | Portal root |
| dialogs + scrim | 1100 | |
| tooltips | 1200 | |
| drag ghost (asset/clip/panel) | 1300 | Must cross floating groups |
| snap indicators during drag | 1310 | |
| toasts | 1400 | Always visible, including above dialogs |

### 8.7 Motion

- **DT-040 (MUST)** The UI is nearly motion-free, like Premiere. Allowed transitions: hover/press color fades ≤ 100 ms, menu/popover fade+2 px slide ≤ 120 ms, toast enter/exit ≤ 160 ms, bottom sheets (touch) ≤ 220 ms spring. No animation on dock changes, maximize, tab switches or workspace switches.
- **DT-041 (MUST)** Never animate the playhead, ruler, timecode, meters or clip geometry with CSS transitions; they are driven per frame.
- **DT-042 (MUST)** `prefers-reduced-motion: reduce` (or the preference) disables all non-essential transitions, including sheet springs (they snap).

---

## 9. Typography

- **TY-001 (MUST)** UI font: **Source Sans 3** (SIL OFL), self-hosted woff2 (400, 600; italic 400) with `font-display: swap`. Fallback stack: `Inter, system-ui, -apple-system, "Segoe UI", sans-serif`. No runtime Google Fonts for UI chrome: the PWA must work offline and Electron must not depend on the network [PUI §4.1]. Composition fonts (text inside videos) are a separate system owned by the preview spec.
- **TY-002 (SHOULD)** Offer Inter as an alternative UI font in Preferences ▸ Appearance (some users prefer its hinting at 11–12 px on Windows/Linux).
- **TY-003 (MUST)** Type scale:

| Role | Size / line | Weight | Color |
|---|---|---|---|
| UI body (rows, menus, labels) | 12 / 16 | 400 | primary |
| Small (column headers, units, ruler labels, track labels) | 11 / 14 | 400 | secondary |
| Tab title | 12 / 16 | 400 (active MAY be 600) | strong / secondary |
| Mode and workspace tabs | 13 / 18 | 400 | strong / secondary / accent |
| Clip name on timeline | 11 / 13 | 400 | strong |
| Timeline current time | 18 / 22 | 400 | timecode |
| Monitor current time and duration | 14 / 18 | 400 | timecode / primary |
| Effect Controls footer time | 12 / 16 | 400 | timecode |
| Section header (Properties) | 12 / 16 | 600 | primary |
| Dialog title | 16 / 20 | 600 | strong |
| Agent chat body ⊕ | 13 / 19 | 400 | primary (long-form reading needs slightly larger text) |
| Code / JSON in agent tool cards ⊕ | 12 / 16 monospace (`Source Code Pro`, `ui-monospace`) | 400 | primary |

- **TY-004 (MUST)** Every changing number (timecodes, durations, dB, percentages, coordinates) uses `font-variant-numeric: tabular-nums` so digits don't jitter.
- **TY-005 (MUST)** Timecode formatting (shared utility used by every panel):
  - Non-drop-frame SMPTE `HH:MM:SS:FF`, where `FF` counts frames within the second (`frame = floor(seconds × fps)` at the sequence rate).
  - Drop-frame for 29.97 and 59.94 fps sequences uses `;` separators (`00;00;01;05`) and the standard drop-frame numbering.
  - Alternative display modes (per display, toggled with `Ctrl+click` on the display, and globally in Preferences): frames count, feet+frames (MAY), and seconds with milliseconds `SS.mmm` for audio time units.
  - Negative times (before sequence start, e.g. in trim tooltips) are prefixed with `-`. Deltas are prefixed with `+`/`-`.
- **TY-006 (MUST)** Timecode entry (click a timecode display to edit): accepts full timecode, partial timecode (digits fill from the right: `1510` = 00:00:15:10), `+N`/`-N` for relative frames, and `N.` style shorthand (`1.` = 1 second, `1..` = 1 minute) [PUI §9.2]. Enter commits, Esc cancels, invalid input shakes the field red once (no animation under reduced motion) and keeps the old value.

---

## 10. Icons and cursors

### 10.1 Icon system

- **IC-001 (MUST)** Generic glyphs come from **lucide-react** (ISC license; Orquester already uses it). NLE-specific glyphs lucide lacks are drawn by us on the same grid: 24-unit viewBox rendered at 16 px, `fill="none"`, `stroke="currentColor"`, 1.5 px stroke, round caps. No Adobe/Premiere icons are copied or traced.
- **IC-002 (MUST)** Components never import icon files directly. They use an **icon registry** keyed by semantic id (`tool.razor`, `transport.markIn`, `track.syncLock`, `engine.fframes`…) that maps to a lucide icon or a custom glyph. Swapping an icon is a registry change.
- **IC-003 (MUST)** Icons inherit color (`currentColor`), default `--pr-icon`; hover `--pr-icon-hover`; active toggles `--pr-accent`; disabled `--pr-text-tertiary`. Icons have no built-in classes or sizes; size comes from the button primitive (16 px default, 14 px in dense rows, 20 px in touch shells).
- **IC-004 (MUST)** Custom glyph inventory (minimum):
  - Tools: track select forward/backward, ripple edit, rolling edit, rate stretch, slip, slide, pen, rectangle, ellipse, hand, zoom in/out, type, vertical type, razor, agent tool.
  - Monitor: mark in `{`, mark out `}`, clear in/out, go to in/out, step back/forward 1 frame, insert, overwrite, lift, extract, export frame, button editor `+`, safe margins, comparison view, drag video only, drag audio only, play in to out, play around, match frame.
  - Timeline: nest/individual toggle, linked selection, add marker, display settings wrench, snap magnet (lucide `magnet` is fine), captions track.
  - Track header: source patch, target, lock/unlock, sync lock on/off, toggle output (eye), mute, solo, voice-over mic, keyframe navigator (prev/add/next).
  - Project: list/icon/freeform view, new bin, new item, automate to sequence, find, poster frame, hover scrub.
  - Engines ⊕: Remotion mark (a generic "R" in a rounded square, **not** the Remotion logo), fframes mark ("F" in a rounded square), native ("N" / chip icon).
  - Agent ⊕: sparkle, plan, tool call, apply, reject, stop.
- **IC-005 (MUST)** A single "fx" badge glyph with the 4 color states (none/intrinsic/effect/both) [PUI §9.6].

### 10.2 Cursors

- **IC-010 (MUST)** Custom SVG cursors (32×32 with hotspots, 2× variants for HiDPI) for: trim in/out (red brackets), ripple in/out (yellow), rolling, slip, slide, rate stretch, razor, pen, pen-add-keyframe, hand/grab, zoom in/out, track select forward/backward, insert-drag, overwrite-drag, no-drop.
- **IC-011 (MUST)** While a gesture (trim, drag, scrub, splitter resize) is active, the gesture's cursor is forced on the whole window through the forced-cursor layer (z 300) so it does not flicker when the pointer crosses other elements. The layer is removed on pointerup/cancel/blur.
- **IC-012 (MUST)** On coarse pointers, cursors are irrelevant. Their meaning must be conveyed by handles and labels (§19).

---

## 11. Core controls

All primitives live in `packages/editor-ui/src/ui/` and are built on Radix where Radix has the primitive. Panels never style raw `<button>`/`<input>` elements.

### 11.1 Buttons

- **CT-001 (MUST)** **Icon button**: 24×24 hit box, 16 px glyph, transparent background, `--pr-bg-hover` on hover, `--pr-bg-pressed` on press. States: default, hover, pressed, **toggled on** (glyph `--pr-accent`), **selected mode** (filled `--pr-accent-fill` rounded square with white glyph, used for current tool), disabled. Requires `aria-label` and a tooltip.
- **CT-002 (MUST)** **Text button**: 24 px high, radius 4, 12 px text, padding 0 10. Variants: *secondary* (1 px `--pr-border-strong` border, transparent), *primary* (`--pr-accent-fill`, white text; pill radius 12 in dialogs), *danger* (`--pr-danger` fill), *quiet* (no border).
- **CT-003 (MUST)** Buttons that run an async command show an inline spinner in place of the glyph/label and are disabled until done. They never block the UI.

### 11.2 Fields

- **CT-010 (MUST)** Text field: `--pr-bg-field`, 22–24 px high, radius 4, no border until hover (`--pr-border-strong`) or focus (`--pr-focus-ring`). Search field: `--pr-bg-field-deep`, magnifier icon, clear `×` when non-empty, `Esc` clears then blurs.
- **CT-011 (MUST)** Dropdown (select): `--pr-bg-field`, chevron right; opens a menu styled per §12. Keyboard: type-ahead, arrows, Enter/Space.
- **CT-012 (MUST)** Checkbox: 14 px box, 1 px `--pr-text-secondary` border, radius 2; checked = `--pr-text-primary` fill with a dark check (gray, not blue, like Premiere). Mixed state shows a dash.
- **CT-013 (MUST)** Toggle switch (preferences only): 28×16, on = `--pr-accent-fill`.
- **CT-014 (MUST)** Color swatch: 24×16 with 1 px `--pr-border-strong` border; click opens the color picker popover (HSV square, hue strip, alpha strip, hex field, eyedropper where the platform supports it, recent colors, project swatches).

### 11.3 Scrubby numbers ("hot text")

- **CT-020 (MUST)** Numeric values display as **blue text** (`--pr-value`) with no box. On hover the cursor is `ew-resize` and the value gets an underline.
- **CT-021 (MUST)** Drag horizontally to change: 1 step per px by default, `Shift` = 10× step, `Ctrl` = 0.1× step. The pointer is captured, and the pointer lock API is used where available so drags aren't limited by screen edges; the cursor is hidden during the drag and restored at the start position.
- **CT-022 (MUST)** Click without drag (movement < 3 px) enters edit mode: a `--pr-bg-field` box, value selected, arrow keys ±1 step (Shift ±10), Enter/Tab commit, Esc cancel. Simple math is accepted (`+10`, `*2`, `/2`, `-5`) relative to the current value.
- **CT-023 (MUST)** A scrub drag is **one undo step** (the value streams live to preview during the drag and commits on pointerup). Esc during a drag reverts.
- **CT-024 (MUST)** Units are shown after the value in `--pr-text-secondary` (`%`, `°`, `px`, `dB`). Mixed values in multi-selection show `–`; dragging a mixed value applies a relative delta to each.
- **CT-025 (MUST)** Each numeric property declares min/max/step/precision/unit. Clamping happens on commit, and the displayed value is always the clamped one.

### 11.4 Sliders

- **CT-030 (MUST)** 2 px `--pr-border-strong` track; 12 px round thumb with a hollow `--pr-text-primary` ring and dark center; filled part `--pr-text-secondary`. Bipolar sliders (gain, pan, color controls) fill from the center. Double-click the thumb resets to the default. Always paired with a scrubby number.
- **CT-031 (MUST)** Keyboard: arrows = step, Shift+arrows = 10 steps, Home/End = min/max. Touch: thumb hit area 44 px (§19.5).

### 11.5 Lists, trees and tables

- **CT-040 (MUST)** Row height `--pr-row-h` (22 px), zebra `--pr-bg-panel` / `--pr-bg-panel-alt` where the panel uses it (Project list), hover `--pr-bg-hover`.
- **CT-041 (MUST)** Selection colors: selected rows in an unfocused panel `--pr-bg-selected-row`; in the focused panel the primary (last-clicked) row is `--pr-accent-fill` with white text, other selected rows `--pr-bg-selected-row`.
- **CT-042 (MUST)** Selection semantics: click, `Ctrl+click` toggle, `Shift+click` range, arrows move, `Shift+arrows` extend, `Home/End`, `PgUp/PgDn`, type-ahead by name, `Enter` renames (in Project), `F2` also renames ⊕.
- **CT-043 (MUST)** Tables: 22 px column headers in `--pr-text-secondary` with a sort arrow on the sorted column; click toggles sort; drag to reorder; drag edges to resize; right-click header to choose columns. Column layout persists per panel instance.
- **CT-044 (MUST)** Lists longer than ~200 rows are virtualized. Keyboard navigation and screen-reader row counts still work (`aria-rowcount`/`aria-rowindex`).
- **CT-045 (MUST)** Trees: disclosure triangles, `→` expands, `←` collapses or goes to the parent, `Alt+click` expands/collapses recursively.

### 11.6 Scrollbars

- **CT-060 (MUST)** 8 px scrollbars, thumb `--pr-border-strong` radius 4, transparent track; via `scrollbar-color`/`scrollbar-width: thin` plus WebKit pseudo-elements. Overlay (auto-hide) scrollbars on touch.
- **CT-061 (MUST)** Timeline and monitor mini-ruler do **not** use native scrollbars: they use the Premiere zoom-scroll bar (TLC-030, PGM-004).

### 11.7 Progress

- **CT-070 (MUST)** Linear progress: 2 px high (4 px in Jobs), `--pr-accent` fill on `--pr-border` track; indeterminate = a 30% segment sweeping (disabled under reduced motion: show a static striped bar). Circular progress: 16 px ring, used in the header jobs button and on clips.

---

## 12. Menus, context menus, command palette, tooltips

### 12.1 One menu model

- **MN-001 (MUST)** Menus are **data**: a tree of entries `{kind: 'command' | 'submenu' | 'separator' | 'group-label' | 'dynamic', commandId?, label?, children?, provider?}`. Labels, icons, shortcuts, enabled and checked state come from the **command registry** (§18), never from the menu entry. The same model drives:
  1. the in-app menubar (Radix Menubar) on web/PWA and Electron Windows/Linux;
  2. the Electron native application menu (built from the model; accelerators rendered from the keymap; clicks forwarded to the renderer's command registry over IPC) (§21);
  3. the command palette (§12.5);
  4. the agent's UI tool catalog (§17.6) ⊕.
- **MN-002 (MUST)** Menu styling: `--pr-menu-bg`, 1 px `--pr-menu-border`, radius 6, 4 px padding, overlay shadow. Items 24 px high, 12 px text, 20 px check/icon column, shortcut right-aligned in `--pr-text-secondary`, submenu chevron. Hover/keyboard-highlight = `--pr-accent-fill` with white text (Spectrum desktop style). Disabled items `--pr-text-tertiary` but still hoverable for their tooltip (SH-031). Separators 1 px `--pr-border`.
- **MN-003 (MUST)** Menus are fully keyboard operable: `Alt` (Windows/Linux, web) focuses the menubar; `F10` too; arrows navigate; type-ahead jumps to items; mnemonics (underlined letters) MAY come later.
- **MN-004 (MUST)** Shortcut labels are platform-rendered (`Ctrl+K` vs `⌘K`) and reflect user remaps and web fallbacks (KB-013).

### 12.2 Menubar contents (top level)

Only the structure is fixed here; each command's behavior is owned by the relevant spec.

| Menu | Key entries |
|---|---|
| **File** | New ▸ (Project, Sequence, Bin, Remotion Composition ⊕, fframes Motion Graphic ⊕, Color Matte, Adjustment Layer, Captions), Open Project…, Open Recent ▸, Close Project, Save, Save As…, Save a Copy…, Revert, Import…, Import from Media Browser, Export ▸ (Media… `Ctrl+M`, Add to Render Queue `Alt+Shift+M`, Frame…, Captions…, Interchange ▸ OTIO / FCP7 XML / EDL / AAF ⊕), Project Settings…, Project Manager… (MAY), Engine ▸ Connect…, Disconnect, Engine Status ⊕, Exit (desktop) |
| **Edit** | Undo `<label>`, Redo `<label>` (labels show the history step name, e.g. "Undo Ripple Delete"), Cut, Copy, Paste, Paste Insert, Paste Attributes…, Remove Attributes…, Clear, Ripple Delete, Duplicate, Select All, Deselect All, Find…, Label ▸, Edit Original, Keyboard Shortcuts… `Ctrl+Alt+K`, Preferences ▸ (General, Appearance, Labels, Timeline, Playback, Engine ⊕, Agent ⊕, Auto Save, Media Cache) |
| **Clip** | Rename…, Make Subclip…, Speed/Duration… `Ctrl+R`, Audio Gain… `G`, Audio Channels…, Enable `Shift+E`, Link/Unlink `Ctrl+L`, Group/Ungroup, Nest…, Scene Edit Detection… (native ⊕), Create Proxies (native ⊕), Replace With ▸, Motion Graphic ▸ Edit Parameters…, Re-render, Convert to Clip (bake) ⊕ |
| **Sequence** | Sequence Settings…, Render Effects In to Out `Enter`, Render Selection, Delete Render Files, Match Frame `F`, Reverse Match Frame, Add Edit `Ctrl+K`, Add Edit to All Tracks, Trim Edit, Extend Edit `E`, Apply Video/Audio Transition, Apply Default Transitions to Selection, Transition Defaults… (S10:TUI-031), Lift `;`, Extract `'`, Zoom In/Out, Go to Gap ▸, Snap in Timeline `S` (check), Linked Selection (check), Normalize Master Track…, Add Tracks…, Delete Tracks…, Auto Reframe… (agent ⊕), Remove Silences… (native ⊕) |
| **Markers** | Mark In/Out/Clip/Selection, Go to In/Out, Clear In/Out/Both, Add Marker `M`, Go to Next/Previous Marker, Clear Selected/All Markers, Edit Marker…, Ripple Sequence Markers (check) |
| **Graphics and Titles** | New Layer ▸ Text `Ctrl+T` (web fallback §18), Vertical Text, Rectangle, Ellipse, From File…, Insert Motion Template ▸ (Remotion ⊕ / fframes ⊕), Align ▸, Arrange ▸, Select Next/Previous Layer, Upgrade to Template (MAY) |
| **View** | Playback Resolution ▸, Paused Resolution ▸, Show Rulers, Show Guides, Snap in Program Monitor, Safe Margins, Transparency Grid, Timecode Display ▸, Show Status Bar, Theme ▸, Density ▸ ⊕, Full Screen |
| **Window** | Workspaces ▸ (§4.3), Find Panel… (palette filtered to panels), a list of all panels with checks (§5.6), Maximize Frame `` ` ``, Reset All Panels |
| **Agent** ⊕ **[SUPERSEDED: menu removed; Help gained "Connect an AI Agent…"]** | Open Agent Panel `Shift+0`, New Conversation, Ask About Selection…, Autonomy ▸ (Ask / Propose / Auto-apply), Apply All Proposals, Reject All Proposals, Stop Agent `Ctrl+.` (verify no conflict), Agent History…, Agent Settings… |
| **Help** | Help, Keyboard Shortcut Reference, What's New, Report a Problem…, Third-Party Notices (FFmpeg, fframes, Remotion, fonts), About JasperEditor |

- **MN-010 (MUST)** Menus that don't apply to the current mode are disabled, not removed (e.g. Sequence menu in Export mode).
- **MN-011 (MUST)** Undo/Redo labels include the step name, and agent steps read "Undo Agent: Remove Silences" ⊕.

### 12.3 Dropdown menus in panels

- **MN-020 (MUST)** Panel menus (`≡`), wrench menus, monitor zoom/resolution dropdowns, Project New Item and similar use the same menu primitive and the same model-driven rendering when they contain commands.
- **MN-021 (MUST)** Menus open below their trigger, flip when there is no room, and never exceed the viewport (they scroll with 24 px scroll arrows when too tall).

### 12.4 Context menus

- **MN-030 (MUST)** Right-click (and long-press ≈ 450 ms on touch, and `Shift+F10`/the Menu key on keyboards) opens a context menu for the element under the pointer (or the focused element for keyboard). If the element under the pointer isn't selected, it becomes the selection first (Premiere behavior), except in the Project panel where `Ctrl`-right-click adds to the selection.
- **MN-031 (MUST)** Minimum context menus (each entry is a command id):

| Surface | Entries |
|---|---|
| Timeline clip | Cut, Copy, Paste Attributes…, Remove Attributes…, Clear, Ripple Delete · Edit Original, Replace With ▸, Enable, Unlink, Group, Ungroup · Nest…, Label ▸ · Speed/Duration…, Audio Gain…, Audio Channels… · Frame Hold ▸, Scale to Frame Size, Set to Frame Size · Rename…, Reveal in Project, Reveal in Folder (desktop), Properties · Motion Graphic ▸ Edit Parameters…, Re-render, Open Template (for R/F clips) ⊕ · **Agent ▸** Ask About This Clip…, Describe, Suggest Edits, Extend with Agent (MAY) ⊕ |
| Timeline gap | Ripple Delete, Close Gap |
| Timeline empty area | Paste, Paste Insert, Add Tracks…, Select All, **Agent ▸ Fill Gap…** ⊕ |
| Track header | Rename, Add Track, Add Tracks…, Delete Track, Delete Tracks…, Customize Video/Audio Header…, Lock/Unlock, Sync Lock, (audio) Voice-Over Record Settings… |
| Ruler | Add Marker, Clear In and Out, Work Area Bar (check), Time Ruler Numbers (check), Audio Time Units (check) |
| Marker | Edit Marker…, Clear Marker, Color ▸, Ripple With Sequence (check) |
| Keyframe (Effect Controls or timeline) | Temporal Interpolation ▸ (Linear, Bezier, Auto Bezier, Continuous Bezier, Hold, Ease In, Ease Out), Spatial Interpolation ▸, Copy, Paste, Delete |
| Project item | Open in Source Monitor, Open in Timeline (sequences), Reveal in Folder (desktop), Rename, Label ▸, Make Subclip…, Create Proxies (native) ⊕, Transcribe (native/remote) ⊕, Modify ▸ (Interpret Footage, Audio Channels), Properties…, Duplicate, Clear, **Agent ▸** Describe, Tag, Find Similar ⊕ |
| Project empty area | New Bin, New Search Bin…, New Item ▸, Import…, Paste, View ▸ |
| Program monitor | Playback Resolution ▸, Paused Resolution ▸, Safe Margins, Transparency Grid, Show Rulers/Guides, Snap in Program Monitor, Magnification ▸, Loop, Export Frame… · with a selected layer: Bring Forward/Backward, Align ▸, Edit Text, Reset Transform |
| Source monitor | Open Recent ▸, Close, Close All, Playback Resolution ▸, Loop, Export Frame…, Make Subclip… |
| Panel tab | Close, Close Other Panels in Group, Undock, Undock into Window, Maximize Panel Group |
| Effect (Effect Controls) | Reset, Bypass (fx toggle), Rename (presets), Save Preset…, Cut/Copy/Clear, Move Up/Down |
| Effects panel item | Apply to Selected Clips, Set Selected as Default Transition, New Custom Bin, Delete (custom), Reveal Engine Info ⊕ |
| Agent message / card ⊕ | Copy, Copy as Markdown, Retry, Edit Prompt, Apply, Reject, Show Affected Items, Delete From Conversation |
| Job ⊕ | Cancel, Retry, Reveal Output (desktop) / Download (web), Copy Command/Log, Remove From List |

- **MN-032 (MUST)** Context menus show at most 2 levels of submenus. Items not applicable to the current selection are disabled (not hidden), with the reason in a tooltip, e.g. "Unlink: selection has no linked clips".

### 12.5 Command palette ⊕

Premiere's search box is limited. JasperEditor has a full command palette, which is also the fastest route to agent prompts.

- **MN-040 (MUST)** `Ctrl+Shift+P` (global; the Project panel's "clear poster frame" binding moves to its panel menu to avoid the conflict) and the header search button open a centered 560 px palette at 20% from the top.
- **MN-041 (MUST)** Fuzzy search over: commands (with shortcut and enabled state), panels ("Open Effects panel"), workspaces, project items (clips, bins, sequences), markers, effects/transitions, motion templates, and preferences. Results are grouped with headers; `↑/↓`, `Enter` runs; `Tab` shows secondary actions for the highlighted result (e.g. for a clip: Open in Source, Reveal in Project, Insert at Playhead).
- **MN-042 (MUST)** Prefixes: `>` commands only, `@` project items, `#` markers, `:` go to timecode (`:00:01:10:00` moves the playhead), `?` help. Text that matches no command offers a last row **"Ask the agent: <text>"** (`Ctrl+Enter` sends directly), which opens/focuses the Agent panel with the prompt submitted ⊕. **[SUPERSEDED: the row was removed.]**
- **MN-043 (SHOULD)** Recent commands appear first when the query is empty. Ranking learns from usage (local only).

### 12.6 Tooltips

- **TT-001 (MUST)** Every icon-only control has a tooltip: `--pr-tooltip-bg`, 12 px text, radius 4, max width 280 px, 600 ms delay (0 ms when moving between tooltipped controls within 300 ms), hidden on press/drag/scroll.
- **TT-002 (MUST)** Format: `Name (Shortcut)`, e.g. "Razor Tool (C)", "Snap in Timeline (S)". Disabled controls append a second line with the reason (SH-031, MN-032).
- **TT-003 (MUST)** Tooltips can be globally disabled (Preferences ▸ General) and never appear on touch (long-press opens the context menu or a label popup instead).
- **TT-004 (SHOULD)** "Rich" tooltips for engine badges and render-bar segments explain state ("Rendered by fframes · proxy ready · 5.0 s").

---

## 13. Toasts and notifications

- **TS-001 (MUST)** A single toast host per window, bottom-right, 16 px from edges (above the status bar if shown), stacking upward, width 360 px (full width minus 16 px on phones, above the bottom tab bar). Uses `--pr-menu-bg`, 1 px `--pr-menu-border`, radius 6, overlay shadow. Library: `sonner` restyled or our own; either way the API below is ours.
- **TS-002 (MUST)** Toast API (called by UI code and by the agent's UI tool, §17.6):

```ts
type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'progress' | 'agent';
interface ToastRequest {
  kind: ToastKind;
  title: string;               // ≤ 60 chars, sentence case, no trailing period
  detail?: string;             // ≤ 2 lines shown; "Details" expands the rest
  dedupeKey?: string;          // same key replaces the existing toast instead of stacking
  actions?: Array<{label: string; commandId?: string; run?: () => void}>; // max 2
  progress?: {value: number | null; jobId?: string};                        // for kind 'progress'
  durationMs?: number | 'sticky';
  source?: 'user' | 'system' | 'engine' | 'agent';
}
```

- **TS-003 (MUST)** Default durations: info 4 s, success 4 s, warning 8 s, error **sticky** when it has an action, else 10 s; progress sticky until done, then converts to success/error (same toast, same position). Timers pause while hovered or while the window is blurred.
- **TS-004 (MUST)** Max 3 visible; older ones collapse into a "+N more" pill that opens the notification log. Identical toasts within 2 s are merged ("×3").
- **TS-005 (MUST)** Each kind has an icon and a 3 px left accent bar: info `--pr-accent`, success `--pr-success`, warning `--pr-warning`, error `--pr-danger`, progress `--pr-accent` with a 2 px bar at the bottom, agent `--pr-agent` with the sparkle icon.
- **TS-006 (MUST)** Usage rules:
  - Confirm **non-obvious** results only (export finished, proxies ready, "Pasted 3 clips" when pasting to a hidden track). Don't toast things visible in place (a clip moved).
  - Destructive, undoable operations triggered from menus offer an **Undo** action (e.g. "Deleted 12 unused items · Undo").
  - Long work (> 1 s) is a job in the Jobs panel, with at most one progress toast per user-initiated job, and none for background/automatic jobs (thumbnails, waveforms).
  - Errors say what failed and what to do ("Export failed: disk is full. Free space or choose another location. [Change Location] [Details]").
  - Agent toasts are used only when the Agent panel isn't visible: "Agent proposed 4 edits · Review" ⊕. **[SUPERSEDED: there is no Agent panel, so the shell shows one `agent` toast per applied external-agent transaction ("Agent: <label>" with Undo).]**
- **TS-007 (MUST)** Accessibility: info/success/progress toasts announce via a polite live region; warning/error via assertive. Toasts are reachable with `F6` cycling (window regions) and dismissible with `Esc` when focused. Focus is never stolen.
- **TS-008 (SHOULD)** **Notification log** (the "Events" panel, Window ▸ Events, or "+N more"): the last 200 notifications with time, source, kind and actions still runnable where it makes sense. Errors from the engine and agent include copyable details.

---

## 14. Dialogs

### 14.1 General rules

- **DG-001 (MUST)** Dialogs are Radix Dialog based, rendered in the window that opened them, centered, with `--pr-overlay-scrim` backdrop. Frame `--pr-bg-panel`, 1 px `--pr-menu-border`, radius 6, overlay shadow. Header 40 px with 16/600 title and a close `×`; body padding 16; footer 48 px with buttons right-aligned: secondary (Cancel) then primary (OK/Export). Primary buttons are pills (`--pr-radius-pill`).
- **DG-002 (MUST)** Focus is trapped; initial focus goes to the first input (or the primary button in confirmations). `Esc` = Cancel; `Enter` = primary unless focus is in a multi-line field or on another button. Focus returns to the invoker on close.
- **DG-003 (MUST)** Sizes: small 400 px (confirmations), medium 560 px (settings forms), large 880 px (Keyboard Shortcuts, Sequence Settings), full (Export mode is not a dialog; §15). On viewports under 600 px wide, dialogs become full-screen sheets (§19).
- **DG-004 (MUST)** Modal dialogs never open on top of another modal dialog except confirmations spawned from a dialog. Non-blocking flows prefer popovers or panels.
- **DG-005 (MUST)** Dialogs that edit document state apply on OK as **one undo step** with a descriptive label; Cancel leaves no trace. "Preview" checkboxes MAY apply live but revert on Cancel.
- **DG-006 (SHOULD)** Desktop dialogs are movable by their header (position remembered per dialog kind during the session).
- **DG-007 (MUST)** Confirmation dialogs name the object and consequence: title "Delete 3 tracks?", body "Clips on these tracks will be removed. You can undo this.", primary uses the action verb ("Delete Tracks"), danger styling only for destructive, non-undoable actions (e.g. deleting files from disk, clearing the media cache).

### 14.2 Dialog catalog (UI shell responsibilities)

| Dialog | Trigger | Notes |
|---|---|---|
| New Sequence / Sequence Settings | File ▸ New ▸ Sequence, Sequence ▸ Settings | Presets list (1080p 25/30/60, 4K, 9:16 1080×1920, 1:1, custom), frame size (W/H with aspect lock), frame rate, pixel aspect (square only in v1), audio sample rate, background color, **preview engine note** ⊕ ("Remotion Player, proxies from native engine"). Owned jointly with the data spec. |
| Keyboard Shortcuts | `Ctrl+Alt+K` | Large dialog: preset dropdown (Premiere default, Avid-like, FCP-7-like, Custom), Save As, Delete, Import/Export JSON; a **visual keyboard** (keys colored: purple application-wide, green panel-specific, striped both; modifier toggles show combos); search over commands and over keys; command list grouped by menu/panel with columns Command, Shortcut(s), Scope; click a shortcut cell and press keys to bind; conflicts shown inline with "Reassign" / "Undo"; `Clear`, `Undo`, `Reset to preset`. Browser-reserved combos are flagged "Not available in browser" with the fallback (KB-013). |
| Preferences | Edit ▸ Preferences | Left category list, right form; applies immediately (no OK); "Restore Defaults" per category. Categories: General, Appearance (theme, contrast, density, UI font, label preset), Labels, Timeline (auto-scroll page/smooth/none, snap distance 5–10 px, playhead snapping, default still/transition durations), Playback (preroll/postroll, audio scrubbing, default playback resolution), Engine ⊕ (URL, token, status, proxy tiers), Agent ⊕ (model/provider, autonomy default, confirmation rules, telemetry), Auto Save, Media Cache (location, size, clean). |
| Marker | Double-click marker, `M` twice | Name, In/Duration (timecode fields), Comments (multi-line), Color (8 swatches), Type (Comment, Chapter, Segmentation, Web Link + URL). |
| Speed/Duration | `Ctrl+R` | Speed %, duration timecode, link toggle, Reverse, Maintain Audio Pitch, Ripple Edit (shift trailing clips), Time Interpolation (frame sampling/blending/optical flow — only options the engine supports). |
| Audio Gain | `G` | Set gain to, Adjust gain by, Normalize max peak to, Normalize all peaks to; shows peak amplitude (computed by engine or browser). |
| Nest | Clip ▸ Nest | Name field. |
| Relink Media / Offline | Opening a project with missing media | List of missing files with Locate…, Search, Skip, Offline All; desktop can search folders via the engine. |
| Motion Graphic Parameters ⊕ | Double-click an R/F clip, Clip ▸ Motion Graphic ▸ Edit Parameters | Auto-generated form from the template's parameter schema (strings, numbers, colors, fonts, images, enums, booleans, keyframeable numbers); live preview in Program; OK = one undo step. Also editable in Properties (§16.13). |
| Engine Connect ⊕ | File ▸ Engine ▸ Connect | URL, credentials, test connection, capability summary. |
| Save changes? | Close with unsaved edits | "Save", "Don't Save", "Cancel". |
| About / Third-Party Notices | Help | Versions of app, engine, ffmpeg build, fframes renderer, Remotion; license texts and source offer links for (L)GPL components [NVL §8]. |

---

## 15. Export: Export mode, Export dialog, Quick Export, render queue ⊕

Premiere 22+ uses a full-screen Export *mode* plus Media Encoder for queued jobs. We replicate that with the Jobs panel as our queue, and add engine selection. The pipelines themselves are specified by the rendering/engine spec [NVL §6, FF §7].

### 15.1 Entry points

- **EX-001 (MUST)** Export mode opens from the header `Export` tab, `Ctrl+M`, File ▸ Export ▸ Media…. The export **source** is the focused Timeline's sequence, else the Program monitor's sequence; if a Project item is focused and selected, that item (sequence or clip) is the source. The source name is shown at the top of the settings column with a dropdown to change it.
- **EX-002 (MUST)** On phones and narrow tablets the same content is a full-screen sheet with the three columns stacked (Presets → Preview → Settings).

### 15.2 Layout

```
┌ Export ─────────────────────────────────────────────────────────────────────────────────────┐
│ DESTINATIONS (240)      │ PREVIEW (flex)                               │ SETTINGS (380)          │
│ ▸ Media File        ●   │ ┌──────────────────────────────────────┐    │ Source: Sequence 01 ▾    │
│ ▸ Frame / Image seq      │ │         preview frame                │    │ File name [Sequence 01 ] │
│ ▸ Audio only             │ │                                      │    │ Location  [~/Movies  ▸]  │
│ ▸ Social: YouTube 16:9   │ └──────────────────────────────────────┘    │ Preset    [Match Source – High ▾] ⋯ │
│   TikTok/Reels 9:16      │ 00:00:12:04  ─────{▒▒▒▒▒▒▒▒}────  00:00:30:00│ Format    [H.264 (MP4) ▾] │
│   Instagram 1:1          │ Range [Entire Sequence ▾]  Scaling [Fit ▾]   │ Engine    [Auto ▾]  ⓘ     │
│ ▸ Interchange            │                                              │ ▸ Video                  │
│   OTIO · FCP7 XML · EDL  │                                              │ ▸ Audio                  │
│   · AAF                  │                                              │ ▸ Captions               │
│ ▸ Your presets           │                                              │ ▸ Effects (LUT, overlay) │
│                          │                                              │ ▸ General                │
│                          │                                              │ ─ Summary ─────────────  │
│                          │                                              │ 1920×1080 · 30 fps · H.264│
│                          │                                              │ ~ 312 MB · 00:00:30:00   │
│                          │                                              │ Engine: Hybrid (native + │
│                          │                                              │ fframes + Remotion)      │
├──────────────────────────┴──────────────────────────────────────────────┴──────────────────────┤
│                                         [Cancel]  [Add to Queue]  (● Export)                    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **EX-010 (MUST)** Destinations column: Media File (default), Frame (single still, PNG/JPEG), Image Sequence (PNG), Audio Only (WAV/AAC/MP3/FLAC/Opus), Social presets (YouTube 16:9, TikTok/Reels/Shorts 9:16, Instagram 1:1 and 4:5; these set frame size, rate, bitrate, loudness target and a reframe hint) ⊕, **Interchange** (OTIO, FCP7 XML, CMX3600 EDL, AAF; availability per engine capability, since non-OTIO formats need the engine's Python sidecar [NVL §4.12]) ⊕, and user presets. Several destinations can be enabled at once (checkbox per destination, like Premiere's multi-destination export); each has its own settings; the Settings column edits the selected one.
- **EX-011 (MUST)** Preview column: shows the frame at the export playhead using the Program preview path, a mini-ruler with In/Out, a timecode, **Range** (Entire Sequence, Sequence In/Out, Work Area, Custom — Custom enables dragging In/Out on the mini-ruler), and **Scaling** when output size ≠ sequence size (Fit/letterbox, Fill/crop, Stretch). Toggle "Show output preview" (MAY) renders a true export frame through the chosen engine for WYSIWYG checks.
- **EX-012 (MUST)** Settings column sections:
  - **Top**: File name (validates illegal characters per OS; auto-increments on conflict when "Avoid overwrite" is on), Location (desktop: native folder picker via engine; web: "Download" or engine-side output folder when remote), Preset (dropdown + `⋯` Save Preset, Import, Export, Delete), Format.
  - **Engine** ⊕: `Auto` (default), `Native (ffmpeg)`, `Remotion`, `Hybrid`, `Browser`. See §15.3.
  - **Video**: frame size (Match Source or W/H with lock), frame rate, field order (progressive only v1), codec-specific options (profile, level; bitrate mode CBR/VBR 1-pass/VBR 2-pass/CRF-quality; target/max bitrate; keyframe distance), pixel format/bit depth, color tagging (Rec.709 default), "Render at maximum depth" (MAY), **Use proxies (draft)** checkbox with a warning badge.
  - **Audio**: codec, sample rate, channels (stereo v1; mono), bitrate, **Loudness normalization** (Off, −14 LUFS streaming, −16 LUFS podcast, −23 LUFS EBU R128, custom; true-peak ceiling) — uses two-pass loudness in the native engine [NVL §5.9].
  - **Captions**: None / Burn in / Sidecar (SRT, WebVTT) / Embed (MP4 mov_text, MAY).
  - **Effects**: LUT (.cube) with intensity, timecode overlay (MAY), image overlay/watermark (MAY).
  - **General**: import result into project, open containing folder when done (desktop), post-export notification.
  - **Summary**: output description, estimated file size, duration, which engine(s) will run, and warnings (e.g. "3 fframes graphics will be rendered first (~12 s)").
- **EX-013 (MUST)** Footer: Cancel (leave Export mode, keep settings), **Add to Queue** (creates a job, stays in Export mode or returns per preference), **Export** (primary; creates a job and switches to Edit mode with the Jobs panel's new job highlighted; also toasts per TS-006).
- **EX-014 (MUST)** Export settings per sequence are remembered (last used preset, destination, range), stored in the project (they are document metadata, not undoable).

### 15.3 Engine choice and validation ⊕

- **EX-020 (MUST)** Engine options and constraints (full capability matrix owned by the rendering spec):

| Engine | When available | Formats (v1) | Notes |
|---|---|---|---|
| Native (ffmpeg) | Engine connected with `nativeFfmpeg` | H.264, H.265, AV1 (SVT), VP9, ProRes 422/4444, DNxHR, GIF, PNG seq; audio AAC, Opus, MP3, WAV, FLAC | Fastest for media-only timelines; graphics layers go through Hybrid |
| Remotion | Engine with `remotionServerRender`, or cloud if configured | H.264, H.265, VP8, VP9, ProRes, GIF, PNG seq | Renders the whole composition in headless Chrome; slowest, highest fidelity for React graphics |
| Hybrid | Engine with `nativeFfmpeg` (+ `fframes` if the sequence has fframes items) | Native formats | Graphics (Remotion/fframes) are rendered to alpha intermediates for their time ranges, then composited natively [NVL §6] |
| Browser | Always (fallback) | H.264 MP4, VP8/VP9 WebM | In-page render; tab must stay open; limited speed; no fframes native render (uses WASM/SVG preview path if available [FF §7 Design B]) |

- **EX-021 (MUST)** `Auto` picks: Native when the sequence has no graphics items; Hybrid when it has graphics and the engine supports it; Remotion when Hybrid can't express something (the rendering spec provides a "can composite natively" check); Browser when no engine. The Summary shows the resolved choice and why ("Auto → Hybrid: 2 text layers, 1 fframes lower third").
- **EX-022 (MUST)** Invalid combinations are prevented, not silently fixed: incompatible options are disabled with a reason (e.g. "Alpha requires ProRes 4444, VP9 or PNG sequence"; "H.264 requires an even width and height" with an explicit "Round to 1082" fix button; values are never changed silently). The Export button is disabled while blocking errors exist; the error list appears above the footer.
- **EX-023 (MUST)** Estimated file size = (video bitrate + audio bitrate) × duration, shown with `~`; for quality-based modes (CRF), show "Size depends on content" with a range estimate if the engine provides one.
- **EX-024 (MUST)** Starting an export while an earlier export of the same output path is running asks to Replace, Keep Both (rename) or Cancel.

### 15.4 Render queue = Jobs panel

- **EX-030 (MUST)** Every export is a job in the Jobs panel (§16.17) with stages (e.g. "Rendering fframes graphics 2/3", "Rendering Remotion layers", "Compositing", "Muxing", "Normalizing loudness"), per-stage and overall progress, ETA, cancel, and on completion Reveal/Open/Download plus "Import into Project".
- **EX-031 (MUST)** Jobs keep running when the user switches modes, workspaces or closes the Export mode. On web with the Browser engine, closing the tab cancels the job; the UI warns before unload while such a job runs.

### 15.5 Export Frame

- **EX-040 (MUST)** The monitors' Export Frame button (camera) opens a small popover: name, format (PNG/JPEG/TIFF MAY), location (desktop) or download (web), "Import into project", "Copy to clipboard" (where supported). The frame is rendered at full resolution through the preview path (or engine for exact output, if selected).

### 15.6 Quick Export

- **EX-050 (MUST)** Header Quick Export popover: source, file name + location, preset dropdown (Match Source – High Bitrate, 1080p H.264, 9:16 Social, Audio WAV, plus user presets), engine (Auto, read-only summary), estimated size, and an Export button. Last choice is remembered.

---

## 16. Panel catalog

### 16.0 Common panel contract

```ts
// packages/editor-ui/src/panels/types.ts (proposal; our own design)
export type PanelKind =
  | 'project' | 'mediaBrowser' | 'source' | 'program' | 'timeline' | 'tools'
  | 'effectControls' | 'effects' | 'properties' | 'motionTemplates' | 'audioMeters'
  | 'audioTrackMixer' | 'audioClipMixer' | 'history' | 'info' | 'markers'
  | 'text' | 'metadata' | 'agent' | 'jobs' | 'events' | 'scopes' | 'colorControls';

export interface PanelDefinition {
  kind: PanelKind;
  title: (ctx: PanelTitleContext) => string;         // "Source: interview.mov"
  icon: IconId;                                      // used in overflow lists, touch tabs, palette
  instance: 'single' | 'multi';
  keepAlive?: boolean;                               // SH-006 (program, timeline)
  minSize: {w: number; h: number};
  fixedAxis?: 'width' | 'height';                    // tools (width 40), meters (width 52)
  keymapScope: string;                               // KB-002 scope id
  menu: MenuModel;                                   // panel-specific ≡ entries (PC-011)
  touch: 'tab' | 'sheet' | 'hidden';                 // how the phone/tablet shells present it (§19)
  requires?: Capability[];                           // e.g. ['nativeFfmpeg'] for Jobs actions; shown disabled otherwise
  agentDescription: string;                          // one-line description for the agent's UI tool catalog (§17.6)
  component: React.ComponentType<PanelProps>;
}
```

- **PN-001 (MUST)** Every panel is registered through a `PanelDefinition`. The Window menu, command palette, dock deserializer, touch shells and the agent's UI catalog are generated from the registry.
- **PN-002 (MUST)** Every panel has: empty state (PC-031), panel menu (PC-010/011), keymap scope, error boundary (PC-032), and a stored view state (scroll, sort, expanded nodes, view mode, zoom) that survives unmount (SH-006).
- **PN-003 (MUST)** Panels do not own global state. A panel may own *view* state only (its scroll, local search text, column widths).

Panel set by release:

| Panel | v1 MUST | v1 SHOULD | Later |
|---|---|---|---|
| Project, Source, Program, Timeline, Tools, Effect Controls, Effects, Properties, Audio Meters, History, Agent, Jobs | ✓ | | |
| Motion Templates ⊕, Info, Markers, Text (Transcript/Captions), Media Browser, Events | | ✓ | |
| Audio Track Mixer, Audio Clip Mixer, Metadata, Scopes, Color Controls | | | ✓ |

### 16.1 Project panel (`PRJ`)

- **PRJ-001 (MUST)** Header: tab `Project: <name>` (or `<bin name>` for bin panels); toolbar row with breadcrumb (project ▸ bin ▸ sub-bin; each segment clickable), item count ("10 items", "3 of 10 selected"), and search field with a filter dropdown (All / Video / Audio / Stills / Sequences / Graphics (R/F) ⊕ / Offline / Unused).
- **PRJ-002 (MUST)** Views: **List** (`Ctrl+PgUp`), **Icon** (`Ctrl+PgDn`), and (SHOULD) **Freeform**; `Shift+\` toggles list/icon. View mode and thumbnail size persist per panel instance.
- **PRJ-003 (MUST)** Footer (left → right): read-only toggle (pencil), List/Icon/Freeform buttons, thumbnail zoom slider (`Shift+[`/`Shift+]`), Sort ▸ (icon view), Automate to Sequence…, Find…, New Bin (`Ctrl+B`), New Item ▸ (Sequence…, Bin, Color Matte, Adjustment Layer, Transparent Video, Captions, **Remotion Composition ⊕**, **fframes Motion Graphic ⊕** (opens the Motion Templates picker)), Clear (trash).
- **PRJ-004 (MUST)** List view columns: Label (12×12 swatch, radius 2), Name (media-type icon + name; bins with disclosure triangle), Frame Rate, Media Start, Media End, Media Duration, Video Info (`1920 × 1080 (1.0)`), Audio Info (`48000 Hz – Stereo`), plus optional: Video/Audio Usage, Proxy (none/generating %/ready ⊕), Engine (Remotion/fframes/native ⊕), Status (online/offline), Path, Comment, Created, Modified. Name can't be hidden. Column set persists.
- **PRJ-005 (MUST)** Icon view tiles: 16:9 thumbnail, name below (2 lines max), duration bottom-right on the thumbnail, a 3 px label color strip at the bottom edge, badges top-right (usage count, proxy, offline, R/F engine ⊕). **Hover scrub** (toggle `Shift+H`): horizontal pointer position maps to media time from start (left edge) to end (right edge). Clicking a thumbnail selects it and shows a mini scrubber on the tile; `I`/`O` set In/Out on that item (source marks, shown as a strip), `J/K/L` play it inline.
- **PRJ-006 (MUST)** Double-click: clip → Source monitor; sequence → opens in Timeline (new sequence tab) and Program; bin → opens in place or in a new panel per preference (`Ctrl+double-click` does the other); R/F graphic → Motion Graphic Parameters (§14.2) ⊕.
- **PRJ-007 (MUST)** Drag and drop:
  - From Project to Timeline/Program/Source: drag payload is a typed in-app payload (asset id(s), optional in/out), never files. Dragging onto the Program monitor shows the edit overlay zones (Insert, Overwrite, Overlay, Replace, Place On Top, Append At End) — behavior per timeline spec.
  - OS files onto Project (or anywhere in the window when no other target accepts them) import them into the current bin. Desktop imports by path; web uploads to the engine or stores locally in browser-only mode. A drop highlight `--pr-accent` 2 px inset outline on the panel.
  - Items onto a bin move them; `Alt`-drag copies (duplicates) ⊕.
- **PRJ-008 (MUST)** Status visualization per item: importing (progress ring), analyzing (thumbs/waveform pending — subtle pulse on the thumbnail placeholder), proxy generating (% in the Proxy column and a ring badge), offline (red "Media Offline" tile/icon and row text in `--pr-danger`). All derived from engine events.
- **PRJ-009 (SHOULD)** Preview Area (panel menu toggle): a 120 px area above the list with poster thumbnail, play button, name, type, duration, video/audio info, and usage.
- **PRJ-010 (MUST)** Thumbnails come from the engine (sprite sheets) when available and from the browser path otherwise [NVL §8]; tiles show a neutral placeholder with the media-type icon until ready. Never block interaction on thumbnails.

### 16.2 Media Browser (`PRJ-020…`)

- **PRJ-020 (SHOULD)** Locations tree (left) and file grid/list (right) with hover scrub, ingest toggle and "Import" / "Open in Source". Desktop: engine-backed filesystem listing with probe metadata; web: File System Access API directory handles (persisted with permission re-prompt) or a picker; remote engine: server-side media roots. `Shift+O` opens the selection in Source.

### 16.3 Source and Program monitors (`PGM`)

```
┌ Program: Sequence 01 ≡ ─────────────────────────────────────────────────────────┐
│                         video area (letterboxed on --pr-bg-panel)                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 00:00:04:20  [Fit ▾]                              [Full ▾]  🔧      00:00:30:00 │ 28
│ ├──┬──┬──⯆──┬──┬──{▒▒▒▒▒▒▒▒▒▒}──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┤   │ 16 mini ruler
│ ○══════════════════════════════════════════════════════════════════════════○   │ 12 zoom bar
│  ◆  {  }  {←  ◁|  ▶  |▷  →}   ⎘ lift  ⎗ extract  📷                          ＋ │ 36 transport
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **PGM-001 (MUST)** Row 1 (28 px): current-time display (blue, 14 px, click to type per TY-006, drag to scrub, `Ctrl+click` cycles display mode); **Zoom** dropdown (Fit, 10, 25, 50, 75, 100, 150, 200, 400%; relative to sequence frame in Program and to media size in Source; beyond fit, scrollbars and hand-panning appear); (Source only) Drag Video Only / Drag Audio Only handles; **Playback Resolution** dropdown (Full, 1/2, 1/4, 1/8, 1/16 — maps to proxy tiers/player scaling per preview spec); **Settings** wrench menu; duration display (In→Out duration if marks exist, else total; primary text color).
- **PGM-002 (MUST)** Settings wrench menu: Display Mode ▸ (Composite, Alpha, (later) Scopes), Playback Resolution ▸, Paused Resolution ▸, High Quality Playback, Show Dropped Frame Indicator, Safe Margins, Transparency Grid, Time Ruler Numbers, Show Rulers (`Ctrl+R`), Show Guides (`Ctrl+;`), Snap in Program Monitor (`Ctrl+Shift+;`), Loop, Show Transport Controls, Show Audio Time Units, Comparison View (MAY), **Show Engine Overlays** ⊕ (outlines R/F layers with their engine badge and render state).
- **PGM-003 (MUST)** Row 2 (16 px) mini time ruler: ticks (numbers only when enabled), blue draggable playhead head, In/Out brackets with shaded range (`--pr-inout-range`), markers. Hovering the middle of a marked range shows a grab cursor; dragging moves In and Out together.
- **PGM-004 (MUST)** Row 3 (12 px) **zoom scroll bar**: 2 px track with 10 px hollow round handles at both ends; dragging a handle zooms the mini ruler (anchored at the playhead), dragging the middle pans, wheel over it zooms. Independent of the Timeline's zoom.
- **PGM-005 (MUST)** Row 4 (36 px) transport button bar, 28×28 buttons, 16 px glyphs:
  - Source default: Add Marker, Mark In, Mark Out, Go to In, Step Back 1, Play/Stop, Step Forward 1, Go to Out, Insert (`,`), Overwrite (`.`), Export Frame, then `＋`.
  - Program default: Add Marker, Mark In, Mark Out, Go to In, Step Back 1, Play/Stop, Step Forward 1, Go to Out, Lift (`;`), Extract (`'`), Export Frame, then `＋`.
  - Play toggles to Stop while playing. The bar centers its buttons and wraps to a second row when narrow; below 260 px wide it shows only Play/Step/Mark and overflows the rest into `⋯`.
- **PGM-006 (MUST)** **Button Editor** (`＋`): a popover grid of all available buttons (Clear In/Out, Go to Previous/Next Edit, Previous/Next Marker, Play In to Out, Play Around, Loop, Safe Margins, Export Frame, Global FX Mute, Show Rulers/Guides, Toggle Proxies, Match Frame, Reverse Match Frame, Insert, Overwrite, Lift, Extract, Comparison View, spacer). Drag a button into the bar to add, out to remove, within the bar to reorder; Reset Layout, Cancel, OK (pill). The layout is stored per monitor per workspace (`{rows: ButtonId[][]}`), max 2 rows.
- **PGM-007 (MUST)** Overlays drawn above the video (never exported): safe margins (action safe 90% and title safe 80% rectangles + center cross, 1 px `rgba(255,255,255,.55)`; percentages configurable in Sequence Settings), transparency checkerboard (when enabled; otherwise the composition background), rulers and guides (Program), dropped-frame indicator dot (top-left: green ok / yellow dropped), and in Program the direct-manipulation handles (owned by the preview spec; styled white squares with an `--pr-accent` outline).
- **PGM-008 (MUST)** Keyboard in monitors (scope `source`/`program`): Space, J/K/L (shuttle rates 1×, 2×, 4×, 8× — see [PUI §16.4] for the state machine), `←/→` step, `Shift+←/→` 5 frames, `I/O`, `Shift+I/O`, `Ctrl+Shift+I/O/X` clear, `M`, `Home/End`, `Up/Down` previous/next edit (Program), `Ctrl+L` loop. Monitor zoom keys when the monitor is focused: `Ctrl+=`/`Ctrl+-` zoom, `Ctrl+0` fit ⊕ (to not collide with the timeline's `=`/`-`).
- **PGM-009 (MUST)** Program-specific: bound to the active sequence (the focused/last active Timeline sequence tab); tab title `Program: <sequence>`; `≡` lists open sequences to switch; In/Out are the sequence marks (shared with the timeline ruler). During trims the monitor shows the two-up/four-up trim views (owned by the timeline spec; the chrome must accommodate a split view with labels and timecodes per side).
- **PGM-010 (MUST)** Source-specific: tab title `Source: <clip>`; the tab's `≡` lists recently opened clips (up to 20) plus Close and Close All; per-asset source marks persist in the project (non-undoable UI state per data spec); Insert/Overwrite act on source-patched targeted tracks at the playhead.
- **PGM-011 (MUST)** Engine-aware states ⊕: when the frame under the playhead includes an fframes/Remotion item whose render isn't ready, the monitor shows the live preview path (WASM SVG for fframes, React for Remotion). If neither is available, show a checkerboard placeholder with "Rendering motion graphic… 45%" centered in the layer bounds. While proxies are in use, a small "PROXY" chip is always shown in the top-right corner of the video area.
- **PGM-012 (MUST)** Full-screen video (`Ctrl+`` `) shows only the video on black; transport appears on pointer move at the bottom for 2 s (touch: tap); `Esc` exits.

### 16.4 Effect Controls (`ECP`)

- **ECP-001 (MUST)** Two panes: property list (≈55%) and **mini-timeline** (≈45%), divided by a draggable splitter; `▸|` toggle (top-right) shows/hides the mini-timeline (persisted per instance).
- **ECP-002 (MUST)** Header chips: `Source · <clip>` (master clip effects) and `<Sequence> · <clip>` (instance); the active chip has a darker fill. Empty state when no clip is selected; with multiple clips selected, show "Multiple clips selected" and (SHOULD) shared intrinsic properties with mixed values (Premiere shows nothing; we go further ⊕).
- **ECP-003 (MUST)** Sections `Video` and `Audio` (22 px, bold 12 px, collapse caret right). Intrinsic effects always present: Motion (Position, Scale, Scale Width + Uniform Scale, Rotation, Anchor Point, Anti-flicker), Opacity (mask tools, Opacity, Blend Mode), Time Remapping, and audio Volume, Channel Volume, Panner. Applied effects listed below in stacking order, drag to reorder.
- **ECP-004 (MUST)** Effect row: twirl, **fx toggle** (bypass; icon gets a slash), name, reset `⟲` right. **Engine badge** ⊕ after the name when an effect is realized differently per engine (e.g. "Preview: WebGL · Export: native"); a warning badge when the effect can't be rendered by the export engine currently selected.
- **ECP-005 (MUST)** Property row (22 px): twirl (for graph view), **stopwatch** (Toggle Animation: off = outline gray; on = blue, and creates a keyframe at the playhead; turning off asks to delete all keyframes, one undo step), name, scrubby value(s) with units, **keyframe navigator** `◀ ◆ ▶` when animated (diamond filled when the playhead sits on a keyframe), reset.
- **ECP-006 (MUST)** Mini-timeline: own ruler, clip range bar (when Pin to Clip is on, default), blue synced playhead, keyframe diamonds per property row (summary keyframes on collapsed effects), interpolation shapes (linear diamond, bezier variants, hold square), marquee selection, drag to move, `Alt`-drag to copy, right-click interpolation menu. Expanded property shows value and velocity graphs with bezier handles (SHOULD).
- **ECP-007 (MUST)** Footer: current time (blue), Filter Properties (all / animated only / modified only), Play Only Audio for This Clip, Loop Audio.
- **ECP-008 (MUST)** Motion-graphic clips (R/F) ⊕ show a `Template` section at the top with the template name, version, engine, and its parameters (same auto-generated controls as Properties); keyframeable parameters get stopwatches.

### 16.5 Effects panel (`EFX`)

- **EFX-001 (MUST)** Search field + filter badges: **Real-time** (preview-capable without render), **Native** (renderable by the native engine), **32-bit** (MAY). Tree bins: Presets, Audio Effects, Audio Transitions, Video Effects (by category), Video Transitions, **Motion Graphics ▸ Remotion**, **Motion Graphics ▸ fframes** ⊕, Custom bins.
- **EFX-002 (MUST)** Rows 22 px with an effect glyph and 12 px text; the default transition has a blue outline around its icon. Drag an effect onto a clip, or double-click with clips selected, to apply; drag a transition onto an edit point. `Ctrl+/` new custom bin; `Delete` removes custom items.
- **EFX-003 (MUST)** Items unavailable in the current runtime (e.g. native-only effects in browser-only mode) are shown with a disabled style and tooltip per SH-031, but can still be applied (they are flagged "will render on the engine" and preview as bypassed with a warning badge).

### 16.6 Tools panel (`TOOL`)

- **TOOL-001 (MUST)** Vertical 40 px strip; 28×28 buttons with 4 px gaps; current tool = filled `--pr-accent-fill` rounded square with white glyph. Auto-horizontal when the group is wider than it is tall.
- **TOOL-002 (MUST)** Tool groups with flyouts (small triangle bottom-right; long-press 350 ms or right-click opens the flyout; the last chosen member becomes the group's face): Selection (`V`) · Track Select Forward/Backward (`A`/`Shift+A`) · Ripple (`B`) / Rolling (`N`) / Rate Stretch (`R`) · Razor (`C`) · Slip (`Y`) / Slide (`U`) · Pen (`P`) / Rectangle / Ellipse · Hand (`H`) / Zoom (`Z`) · Type (`T`) / Vertical Type · **Agent tool** ⊕ (no default key; click-drag on a range or clip edge to ask the agent: extend, fill, replace, describe) **[SUPERSEDED: removed]**.
- **TOOL-003 (MUST)** Tool shortcuts are active when the Timeline, Program or Tools panel is focused (scope `editing`), not while typing.
- **TOOL-004 (SHOULD)** Spring-loaded tools (hold key to switch temporarily, revert on release): preference, default off.
- **TOOL-005 (MUST)** The active tool is editor state; the Program monitor reads it (Type → click creates text; Rectangle/Ellipse → draw shape; Hand/Zoom → pan/zoom the viewer; Pen → masks/shapes).

### 16.7 Timeline panel chrome (`TLC`)

Editing behavior is owned by the timeline spec; this section fixes visuals and chrome.

- **TLC-001 (MUST)** Sequence tabs in the panel's tab strip: `× <name> ≡` with a small label-color swatch; the `×` sits left of the name on sequence tabs (always visible). Multiple sequences per Timeline panel; dragging a sequence tab out creates another Timeline panel instance. Double-click a sequence in Project opens it as a new tab (or activates it).
- **TLC-002 (MUST)** Header area (left of the ruler, width = track header width): the **playhead position timecode** (18 px, blue; editable per TY-006) and the toolbar row with 16 px toggles: Insert/Overwrite sequences as nests or individual clips, Snap (`S`), Linked Selection, Add Marker (`M`), Timeline Display Settings (wrench), Captions track options, **Agent ghosts visibility** ⊕ (eye-sparkle toggle; default on).
- **TLC-003 (MUST)** Display Settings menu: Show Video Thumbnails (with style ▸ Head / Head and Tail / Continuous), Show Video Keyframes, Show Video Names, Show Audio Waveform, Rectified Audio Waveforms, Show Audio Keyframes, Show Audio Names, Show Through Edits, Show Clip Markers, Show fx Badges, Show Proxy Badges, **Show Engine Badges** ⊕, Show Label Colors, Minimize All Tracks, Expand All Tracks, Customize Video Header…, Customize Audio Header…, Presets ▸.
- **TLC-004 (MUST)** Ruler 24 px: adaptive timecode labels (≥ 80 px apart; 11 px secondary), minor ticks 4 px, major 8 px; In/Out brackets and shading (ruler .10, tracks .06); markers (pentagon glyph, color; duration markers extend a bar); optional 6 px work-area bar; **4 px render bar** beneath: red = needs render (uncached heavy Remotion/fframes/effects), yellow = real-time previewable, green = cached render/proxy available ⊕ semantics per [PUI §9.4]. Hovering a render bar segment shows a rich tooltip with the reason and engine (TT-004).
- **TLC-005 (MUST)** Track headers (default 176 px; resizable between min and 2× min by dragging their right edge; width stored in the workspace):
  - Video: source patch (24 px, `V1` pill `--pr-target-fill` when patched, visible only when Source has a clip), lock (padlock; locked → blue closed padlock + hatch over the whole row), target (`V1` pill blue when targeted, outline text otherwise), sync lock, toggle output (eye), name (when expanded), expanded extras (keyframe navigator, Show Keyframes dropdown) when height ≥ 48 px.
  - Audio: patch, lock, target, sync lock, **M** (mute; on = green `#1c8a3a` fill, white text), **S** (solo; on = yellow `#d8b400` fill, dark text), voice-over mic, name, expanded extras (keyframe navigator, track volume scrubby in dB).
  - Master: padlock, "Master", blue volume value, Go to Master button; no patch/target.
  - Shift-click on lock/sync/eye/M/S applies to all tracks of that type. Targeted tracks' header background is `--pr-bg-panel-raised`. Hover `--pr-bg-hover`. 1 px `--pr-border-subtle` between tracks.
- **TLC-006 (MUST)** Track heights: video min 20, default 32, max ≈ 240; audio min 20, default 40. Drag the boundary between headers (video grows upward, audio downward, away from the V/A divider); `Alt+wheel` over a header zooms that track; `Shift+wheel` all tracks of that type; `Ctrl+=`/`Ctrl+-` video, `Alt+=`/`Alt+-` audio, `Shift+=`/`Shift+-` expand/minimize all; double-click empty header space toggles expanded.
- **TLC-007 (MUST)** V/A divider: 4 px `--pr-bg-app` band, draggable to split vertical space; the video stack scrolls independently (anchored to the bottom) from the audio stack (anchored to the top).
- **TLC-030 (MUST)** Horizontal **zoom scroll bar** (14 px row at the bottom): round hollow end handles zoom (anchored at the playhead), middle drags pan, wheel over it zooms. Vertical zoom scroll bars at the right edge for each stack scale all track heights in that stack.
- **TLC-031 (MUST)** Keys (scope `timeline`): `=`/`-` zoom, `\` toggle fit-all / previous zoom, `PgUp/PgDn` page scroll. Wheel: Windows default horizontal scroll, `Ctrl+wheel` vertical; macOS default vertical; `Alt+wheel` zoom (anchored at pointer); trackpad pinch zoom.
- **TLC-032 (MUST)** Auto-scroll during playback: Page (default), Smooth (playhead centered), None (Preferences ▸ Timeline).
- **TLC-040 (MUST)** Clip visuals: label-color body (radius 3, 1 px inner border at label −20% lightness), 14 px name strip (11 px white text, ellipsis), `[V]`/`[A]` suffix for linked pairs, thumbnails (≥ 40 px height, 70% opacity) and waveforms (label light tint, rectified or centered, L/R lanes for stereo), badges on the right of the name strip: fx badge (4 states), proxy, speed %, out-of-sync `±N` red box, **engine badge R/F/N** ⊕ (10 px, 70% white), **agent badge** ⊕ (tiny `--pr-agent` sparkle for clips created/modified by the agent in the last N steps; clears on user edit; toggle in Display Settings). States: selected (2 px white outline, body +12% lightness), hover (+6%), disabled (35% opacity), offline (red body, "Media Offline"), locked (hatch).
- **TLC-041 (MUST)** Motion-graphic clips (R/F) ⊕ render a mini filmstrip from the WASM/React preview or render proxy when available, and a progress ring + % in the name strip while an fframes/Remotion render job for that clip runs (render state from the engine; per [FF §7] `renderState`).
- **TLC-042 (MUST)** **Agent ghosts** ⊕: proposed changes render as overlays on top of real clips without altering them: added clips as dashed `--pr-ghost-stroke` outlines with `--pr-ghost-fill`, removed ranges hatched `--pr-ghost-remove`, moved clips as a ghost at the destination with a thin connector arrow from the source, trims as ghost edges; each ghost carries a small numbered chip matching the proposal list in the Agent panel (§17.4). Hover a ghost highlights the matching proposal and vice versa. Ghosts are not selectable as clips; clicking one selects the proposal.

### 16.8 Audio Meters (`MTR`)

- **MTR-001 (MUST)** Docked right of the Timeline, 52 px wide by default (resizable 40–120; horizontal orientation when wider than tall). Stereo bars 8 px wide with 2 px gap on a `--pr-bg-field-deep` well; dB scale 0 to −54 (labels 0, −6, −12, −18, −24, −30, −36, −42, −48, −54, "dB"); color zones green below −12, yellow −12…−3, red above −3; 1 px peak-hold line held 1.5 s; clip indicator at the top (click to reset); S (solo) buttons under each channel.
- **MTR-002 (MUST)** Meter source: live levels during playback from the preview audio path (Web Audio analyser) when available; precomputed envelopes (peaks per 10 ms from engine/browser waveform data, summed per active clip with gain/fades/mute/solo) when paused/scrubbing or when live tapping isn't possible. The meter shows which source is active in its panel menu (Live / Envelope).
- **MTR-003 (MUST)** Right-click menu: Dynamic Peaks / Static Peaks, Show Valleys, Show Color Gradient, Range (−60/−96/−120 dB), Mono/Stereo.
- **MTR-004 (MUST)** Rendering at display refresh via canvas; no React re-render per frame (PERF-004).

### 16.9 Audio Track Mixer / Audio Clip Mixer (`MIX`, later)

- **MIX-001 (MAY)** Channel strips per audio track + Master: collapsible effects/sends area, routing dropdown, pan knob (36 px) with blue value, automation mode dropdown, M/S/R buttons, fader with dB scale and meter, gain and peak readouts, editable track label; footer with timecode and transport. The Audio Clip Mixer shows strips for clips under the playhead with keyframe-write toggles. Specified in detail when audio mixing lands.

### 16.10 History (`HIS`)

- **HIS-001 (MUST)** A list of undo steps, newest at the bottom, each with an icon by kind (edit, effect, import, agent ⊕), a human-readable label ("Razor", "Move 3 clips", "Agent: Remove silences (12 cuts)"), and relative time. The current state row is highlighted (`--pr-accent-fill` when focused); states after it are dimmed (`--pr-text-tertiary`). Clicking a row jumps to that state; `←/→` step back/forward; panel menu: Clear History (confirmation), History Settings (max steps).
- **HIS-002 (MUST)** Agent steps ⊕ show the `--pr-agent` sparkle and can expand to list their sub-operations (read-only) and a link "Show in Agent panel" **[SUPERSEDED: no link]**.
- **HIS-003 (MUST)** Jumping back and then making a new edit discards the dimmed states (standard linear history); the UI warns in a toast only if more than 20 states are discarded ("Discarded 24 undone steps · Undo").

### 16.11 Info (`INF`)

- **INF-001 (SHOULD)** Key–value readout (11 px) of the selection (type, name, video/audio info, duration, In/Out, source In/Out, speed, engine ⊕) plus the active sequence (playhead, duration, and for each track the clip at the playhead). Updates during trims show deltas.

### 16.12 Markers (`MRK`)

- **MRK-001 (SHOULD)** List with color swatch, name, In, Out, Duration, Comment; color filter chips; search; double-click to go to the marker and open its dialog; inline editing of name/comment; sequence vs clip markers toggle.

### 16.13 Properties panel and Essential Graphics (`PRP`)

The context-sensitive inspector, JasperEditor's **primary** property editor (Premiere v25 Properties model).

- **PRP-001 (MUST)** Nothing selected → sequence properties: frame size, frame rate, duration, background color, and quick actions (Sequence Settings…, Export…). Video clip → Transform (Position, Scale, Rotation, Anchor, Opacity), Crop, Speed & Duration, Blend Mode, quick actions (**Auto Reframe** via agent ⊕, **Scene Edit Detection** via native ⊕, **Create Proxy** ⊕). Audio clip → Clip gain, Pan, Fades, quick actions (Enhance Speech (MAY), **Auto Duck**, **Normalize Loudness** native ⊕, **Remove Silences** native ⊕, Tag as Dialogue/Music/SFX/Ambience). Text/graphic → layer list (eye, type icon, drag reorder) and sections Text (font family with preview, style, size, alignment, tracking, leading, baseline, caps options), Appearance (fill + eyedropper, strokes, background, shadows), Align and Transform, Responsive Design (pin to edges, intro/outro protection) (SHOULD). Motion graphic (R/F) ⊕ → Template section (§16.4 ECP-008) with the auto-generated parameter form, engine and render state, and actions Re-render, Open in Motion Templates, Convert to Clip (bake to video).
- **PRP-002 (MUST)** Multi-selection → shared properties; differing values show `–` and adjust relatively (CT-024). Different kinds selected → only common sections (Transform, Opacity, Speed).
- **PRP-003 (MUST)** Section headers 28 px (`▾ Transform`), collapsible, collapse state remembered per section kind; a right-aligned reset and (where applicable) `+` (add stroke/shadow). Fields use `--pr-bg-field`; values are scrubby numbers (CT-020).
- **PRP-004 (MUST)** All edits are undoable; scrubs are single steps (CT-023); typing into text fields commits on blur/Enter as one step.
- **PRP-005 (SHOULD)** Essential Graphics' "Browse" role is served by the Motion Templates panel (§16.14); Properties hosts all editing.

### 16.14 Motion Templates panel (`MGT`) ⊕

- **MGT-001 (SHOULD)** A gallery of Remotion compositions and fframes templates: search, category chips (Titles, Lower Thirds, Callouts, Counters, Charts, Transitions, Social), engine filter (Remotion / fframes / All), grid of cards with animated hover preview (WASM SVG for fframes, Player for Remotion; static poster on touch/reduced motion), name, duration, aspect ratios supported, engine badge.
- **MGT-002 (SHOULD)** Drag a card to the Timeline/Program to insert it (default duration from the template); double-click inserts at the playhead on the targeted video track; right-click: Insert, Insert and Edit, Favorite, Show Details (parameters, license, version).
- **MGT-003 (MAY)** "Create with agent…" card at the start of the grid opens the Agent panel with a template-authoring prompt (agent-authored custom graphics [FF §7 Design A]); results appear in a "Custom" category with a "Promote to library" action.

### 16.15 Text panel: Transcript and Captions (`TXT`)

- **TXT-001 (SHOULD)** Tabs `Transcript | Captions`. Transcript: speaker labels, timecodes, paragraphs; selecting text selects the corresponding time range (Program In/Out preview); actions Insert, Overwrite, Extract, "Delete filler words" (agent ⊕); a Transcribe button that runs the engine's transcription (native whisper.cpp or remote) with a progress job; search within transcript. Captions: list of segments with In/Out timecodes, editable text, split/merge, style preset dropdown, and "Create captions from transcript". Detailed behavior owned by the captions spec.

### 16.16 Metadata (`MTD`, later)

- **MTD-001 (MAY)** Clip, file and custom metadata fields with inline editing.

### 16.17 Jobs panel (`JOB`) ⊕

- **JOB-001 (MUST)** A queue of engine and browser jobs: exports, proxy creation, thumbnails/waveforms (grouped under "Media analysis" and collapsed by default), transcription, scene detection, silence detection, fframes renders, Remotion renders, agent long-running tools. Columns/rows: kind icon, title, source, engine badge (N/R/F/Browser), status (Queued, Running, Paused, Stalled, Done, Failed, Canceled), progress bar (4 px, `--pr-accent`), ETA, elapsed, actions.
- **JOB-002 (MUST)** Row actions: Cancel (running/queued), Retry (failed/canceled), Pause/Resume (if the engine supports it), Reveal/Open (desktop) or Download (web), Import into Project (exports), Copy Log / Copy Command (for ffmpeg jobs; for support) — shown on hover and in the context menu; `Delete` removes finished rows.
- **JOB-003 (MUST)** Expanding a job shows its stages with individual progress (EX-030), the log tail (monospace, last 200 lines, copy button), and output paths.
- **JOB-004 (MUST)** Footer: running/queued counts, total ETA, concurrency indicator ("Engine: 2 of 2 slots busy"), Clear Finished, Pause Queue (MAY).
- **JOB-005 (MUST)** Job events stream from the engine; the panel reflects state within 250 ms of an event. When the engine disconnects, running jobs show "Stalled" with the last known progress (SH-032).

### 16.18 Events / notification log (`EVT`)

- **EVT-001 (SHOULD)** See TS-008.

---

## 17. Agent panel and agent control of the UI ⊕

> **Superseded (wp-mcp, ARCHITECTURE D-18 / §11).** This whole chapter describes an in-app agent that JasperEditor does not have. Nothing here is implemented or planned as written: the panel (§17.1), presence (§17.2), autonomy modes (§17.3), proposals (§17.4) and agent errors (§17.5) went away with the Agent panel. The intent of §17.6 (a UI command surface agents can drive) and of proposals/ghosts may return as MCP tools. The one UI requirement that survives is the approval of destructive agent transactions, now a shell-level card (ARCHITECTURE §11.1).

The template has no agent. In JasperEditor the agent is a peer of the human editor: it reads the same state, calls the same commands, and its edits pass through the same undo history. This section defines the UI; planning, tools, model and safety policy are in the agent spec.

### 17.1 Panel anatomy

```
┌ Agent ≡ ───────────────────────────────────────────────┐
│ [Conversation: "Tighten interview" ▾]   Autonomy [Propose ▾] ⏹ │  toolbar 28
├────────────────────────────────────────────────────────┤
│ 👤 Remove the ums and long pauses from A1, keep it      │
│    under 3 minutes.                                     │
│ ✦  I'll detect silences and filler words on A1…         │  streaming text
│   ┌ tool · Detect silences (native) ───────── done ✓ ┐  │  tool card (collapsible)
│   │ A1 · -35 dB · min 0.6 s → 41 ranges             │  │
│   └─────────────────────────────────────────────────┘  │
│   ┌ PLAN ─────────────────────────────────────────── ┐ │
│   │ ✓ 1 Transcribe A1 (native, 34 s)                  │ │
│   │ ● 2 Find filler words                              │ │
│   │ ○ 3 Propose cuts                                   │ │
│   └───────────────────────────────────────────────────┘ │
├──── Proposals (12) ──────────────── [Reject all] [Apply all] ┤
│ ① Cut 00:00:12:04–00:00:13:10  "um"   A1+V1   [✓][✕]  │
│ ② Cut 00:00:31:00–00:00:33:12  pause  A1+V1   [✓][✕]  │
│ …                                                        │
├────────────────────────────────────────────────────────┤
│ [@Selection: 3 clips] [@In/Out] [+ context]              │  context chips
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Ask the agent…                                        │ │  prompt (auto-grow, max 8 lines)
│ └─────────────────────────────────────────────────────┘ │
│ 🎙  📎                                        [Send ⏎]   │
└────────────────────────────────────────────────────────┘
```

- **AG-001 (MUST)** The Agent panel is a normal dockable, floatable, pop-out-able panel (single instance per window) with default homes: tab next to Properties in Editing; left column in the Agent workspace; bottom-tab "Agent" on phones (§19).
- **AG-002 (MUST)** Toolbar: conversation switcher (list, New Conversation, rename, delete; conversations are stored per project), **Autonomy** dropdown (§17.3), **Stop** (⏹, `Ctrl+.` default — verify against keymap; enabled while the agent runs), panel menu (Export Transcript…, Clear Proposals, Agent Settings…).
- **AG-003 (MUST)** Message stream: user messages (right-aligned or with avatar; 13 px), agent messages (markdown: paragraphs, lists, inline code, links to timeline items/time ranges rendered as chips that select/seek on click), **tool cards** (collapsible; title = tool name + engine badge; status queued/running (spinner + progress)/done/failed; summary line; expanded shows arguments and results as formatted JSON, with Copy), **plan cards** (ordered steps with status icons; the current step pulses subtly — disabled under reduced motion), **proposal groups** (§17.4), and **clarifying questions** with quick-reply buttons.
- **AG-004 (MUST)** Streaming text renders incrementally without layout jank: auto-scroll follows the bottom unless the user scrolled up; then a "Jump to latest ↓" pill appears.
- **AG-005 (MUST)** Prompt field: multi-line (Enter sends, Shift+Enter newline), history recall with `↑` when empty, `@` mentions (clips, tracks, bins, markers, sequences, "selection", "in/out", "playhead") that insert **context chips**, `/` slash commands (e.g. `/silences`, `/captions`, `/reframe 9:16`, `/describe`), paste images (reference frames) and files (MAY), voice input via the mic button (MediaRecorder → transcription on the engine; MAY). Keyboard shortcuts of the editor are suspended while typing (FO-007).
- **AG-006 (MUST)** Context chips: the current selection, In/Out, and playhead are offered automatically as removable suggestions ("Use selection: 3 clips"). The chip row shows exactly what context the agent will receive.

### 17.2 Agent presence in the rest of the UI

- **AG-010 (MUST)** Header Agent button state: idle; working (pulsing dot in `--pr-agent`); needs review (badge with proposal count); error (red dot). Tooltip shows the current step ("Agent: Rendering lower third 2/3").
- **AG-011 (MUST)** When the agent operates on a panel's content (e.g. selects clips, opens Effect Controls), the affected panel's tab shows the attention dot (PC-009) if not visible, and the timeline shows **ghosts** (TLC-042) for proposals and a transient `--pr-agent` 1 px outline (1.5 s) on items it just changed.
- **AG-012 (MUST)** Agent-created undo steps are labeled `Agent: <summary>` and marked in History (HIS-002). One accepted proposal group = one undo step; "Apply all" = one undo step.
- **AG-013 (MUST)** Agent-driven UI changes (switching workspace, opening panels, moving the playhead, changing zoom) are **visible but non-disruptive**: they never steal keyboard focus from a text field the user is typing in, never close a dialog the user opened, and never move the playhead while the user is playing back or scrubbing (such calls are deferred until playback stops or are rejected with a reason the agent sees).

### 17.3 Autonomy modes

- **AG-020 (MUST)** Three modes, selectable per conversation (default from Preferences ▸ Agent):
  - **Ask**: the agent may read state and run analysis tools (probe, transcribe, detect) but must ask before any document change; proposals are presented, not applied.
  - **Propose** (default): the agent creates proposals (ghosts) that the user applies or rejects.
  - **Auto-apply**: the agent applies its changes directly as labeled undo steps and reports them. Destructive-outside-the-document actions (deleting media files, overwriting exports, clearing caches, spending cloud credits) **always** require explicit confirmation regardless of mode (confirmation dialog per DG-007, with the agent's reason quoted).
- **AG-021 (MUST)** The current mode is always visible in the Agent panel toolbar and on phones in the Agent sheet header.

### 17.4 Proposals review

- **AG-030 (MUST)** A proposal group lists numbered proposals (①…), each with: operation summary ("Cut 00:00:12:04–00:00:13:10"), reason ("filler: um"), affected tracks/items, and per-item Apply ✓ / Reject ✕. Group actions: Apply all, Reject all, Apply selected, "Preview" (plays the result by temporarily applying the group to a scratch copy of the sequence in the Program monitor; exit restores) (SHOULD).
- **AG-031 (MUST)** Selecting a proposal seeks the playhead to it, scrolls the timeline to it and highlights its ghost; `↑/↓` move between proposals and `Enter`/`Backspace` apply/reject while the proposal list has focus.
- **AG-032 (MUST)** **Staleness**: if the user edits items that a pending proposal depends on, that proposal is marked "Outdated" (amber chip) and can no longer be applied as-is; the group offers "Ask agent to update". Applying never silently overwrites user changes.
- **AG-033 (MUST)** Applied proposals collapse to "Applied ✓ (Undo)" rows; rejected ones collapse to "Rejected" and are sent back to the agent as feedback.

### 17.5 Agent errors and long jobs

- **AG-040 (MUST)** Tool failures show inline in the tool card with the error summary and Retry; the agent's own recovery continues in the stream. Engine-capability failures link to the engine popover (SH-031).
- **AG-041 (MUST)** Long agent tools (transcription, renders) create Jobs (§16.17) and show their progress both in the tool card and in Jobs. Stopping the agent cancels its queued jobs and asks whether to cancel running ones.

### 17.6 The UI command surface the agent can drive

- **AG-050 (MUST)** The agent's UI tools are generated from the **command registry** and **panel registry**, not hand-written. Each command that is marked `agentExposed` (default true for editing/navigation/view commands, false for app-level ones like Exit or Keyboard Shortcuts) is offered with its id, description, argument schema and current enabled state. The same command id runs the same code path as the menu item and the shortcut.
- **AG-051 (MUST)** Minimum UI-level tools available to the agent:
  - `workspace.switch(id)`, `panel.open(kind, {focus?})`, `panel.focus(kind)`, `panel.maximize(kind)`, `panel.close(kind)`;
  - `monitor.setZoom`, `monitor.setPlaybackResolution`, `monitor.toggleSafeMargins`;
  - `timeline.zoomToRange(start, end)`, `timeline.scrollToItem(id)`, `playhead.seek(time)` (subject to AG-013), `selection.set(ids)`;
  - `ui.toast(request)` (kind forced to `agent`, rate-limited to 1 per 5 s), `ui.highlight(target, durationMs)` (transient outline on an item or panel), `ui.openDialog(kind, prefill)` (e.g. Export with prefilled settings, the user still presses Export);
  - `ui.describe()` returns a structured snapshot of the shell: workspace, open panels and their visibility, focused panel, selection summary, playhead, active sequence, engine status and capabilities, running jobs.
- **AG-052 (MUST)** The agent can never: change keymaps or preferences without the user confirming, dismiss user dialogs, bypass confirmations, or interact with OS-level windows beyond what commands expose.

---

## 18. Command registry and keymap (shell level)

The complete default keymap is [PUI §16]. This section sets the rules.

- **KB-001 (MUST)** Every user action is a **command**: `{id, label, description, icon?, scope, when?(ctx), checked?(ctx), run(ctx, args?), argsSchema?, agentExposed?, capability?}`. Menus, toolbar buttons, context menus, the command palette, shortcuts and the agent all invoke commands by id. No component calls editing functions directly from a click handler except through the command runner (which also logs for analytics and the agent's "recent user actions" context).
- **KB-002 (MUST)** Scopes: `global`, `editing` (Timeline, Program, Tools), and one per panel kind. Resolution order for a key event: the focused panel's scope → `editing` if the focused panel is in that family → `global`. First enabled match wins.
- **KB-003 (MUST)** Exactly one `keydown`/`keyup` listener per window (capture phase) dispatches through the registry. Components don't register their own global key listeners (local key handling inside focused widgets, like lists and text fields, is fine and runs before the dispatcher sees the event only when the widget consumes it).
- **KB-004 (MUST)** Bindings match on physical `KeyboardEvent.code` for editing keys (J/K/L, I/O, `,` `.` `;` `'`, `` ` ``, `\`, `=`, `-`, `[`, `]`) so positions are stable on non-US layouts; labels are displayed using the keyboard layout map where available.
- **KB-005 (MUST)** While focus is in an editable element, single-key and Shift+key shortcuts are suspended; `Esc`, `Enter` and modifier combos that the widget doesn't handle (e.g. `Ctrl+S`) still dispatch.
- **KB-006 (MUST)** Key repeat is honored for step/nudge commands and ignored for toggles.
- **KB-007 (MUST)** `keyup` events are dispatched for hold-to-act commands (K-held JKL combinations, spring-loaded tools, the Hand tool on Space-hold in Program if enabled).
- **KB-010 (MUST)** Shell-level bindings added by this spec: `Shift+0` Agent panel (DK-051) **[SUPERSEDED: unbound]**, `Ctrl+Shift+P` command palette (MN-040), `Ctrl+.` stop agent (AG-002) **[SUPERSEDED: unbound]**, `Ctrl+0` fit monitor (PGM-008), `` ` `` / `` Shift+` `` / `` Ctrl+` `` (DK-040/042), `Ctrl+Shift+.`/`,` panel focus cycle (FO-003), `Alt+Shift+0…9` workspaces (WS-010), `F6` cycle window regions (header → dock → toasts) for accessibility.
- **KB-011 (MUST)** Conflicts in the default map are resolved in code review: a test enumerates all bindings per scope and fails on duplicates within the same scope.
- **KB-012 (MUST)** Keymap presets and overrides are stored as JSON, importable/exportable (Keyboard Shortcuts dialog §14.2).
- **KB-013 (MUST)** Browser-reserved combos (`Ctrl+N`, `Ctrl+W`, `Ctrl+T`, `Ctrl+Shift+N/T/W`, `Ctrl+Tab`, `Ctrl+Q` on Linux) are not delivered to web pages. On web/PWA the registry automatically adds fallbacks — New Sequence `Alt+N`, Close Panel `Alt+W`, New Text Layer `Alt+T` — and menus show the fallback instead of the unreachable binding. Electron receives everything and uses the Premiere bindings.
- **KB-014 (SHOULD)** A "Keyboard Shortcut Reference" overlay (`Ctrl+Alt+/` or Help menu) shows the bindings for the focused panel's scope plus global ones, printable.

---

## 19. Mobile and tablet (touch shells)

Premiere's docked UI doesn't scale to phones; Adobe ships a separate touch app. We do the same with **one set of panels and several shells** [PUI §19].

### 19.1 Layout modes

| Mode | Condition (evaluated on resize/orientation change, debounced 150 ms) | Shell |
|---|---|---|
| `desktop` | width ≥ 1280 and fine pointer, or user forced desktop | Full docking (§3–§5) |
| `compact` | 900 ≤ width < 1280 with a fine pointer | Docking with the fixed Essentials-like preset: Program + Properties/Agent tabs top; Timeline bottom; Project/Effects/Agent as tabs; Tools collapse into the timeline header; compact header (HD-005) |
| `tablet` | coarse pointer and width ≥ 700 (either orientation), or 600 ≤ width < 900 | Touch tablet shell (§19.3) |
| `phone` | width < 600, or coarse pointer and min(width, height) < 500 | Touch phone shell (§19.2) |

- **MB-001 (MUST)** The mode is computed client-side (the app is SPA-only; guard against non-browser environments). A user preference can force `desktop` on tablets with keyboard + trackpad.
- **MB-002 (MUST)** Switching modes at runtime (rotating a tablet, resizing a window) swaps the shell without losing document state, selection, playhead, playback state or the agent conversation. Dock layout of the desktop modes is kept and restored when returning.
- **MB-003 (MUST)** Sizing uses the visual viewport height (not `100vh`), `env(safe-area-inset-*)` paddings on top bar, bottom bar and sheets, and hides the timeline/transport while the soft keyboard is open for text entry (Orquester's viewport and soft-keyboard hooks are the pattern [OMS §3.7]).

### 19.2 Phone shell (portrait)

```
┌──────────────────────────────┐ safe-area top
│ ←  Project name      ↶ ↷  ⇪  │ 48  app bar (back to Home, title, undo, redo, Export)
├──────────────────────────────┤
│           VIEWER             │ ~40% height, letterboxed on #000
├──────────────────────────────┤
│ 00:01:12:04 ▶  ◆  🔊  ⤢       │ 44  transport: timecode, play, keyframe, mute, fullscreen
├──────────────────────────────┤
│         ▼ fixed playhead      │
│ T  [ text ]                   │ overlay tracks 32
│ V  [▭▭clip▭▭][▭▭clip▭▭▭]      │ main video 56 (thumbnails)
│ ♪  [≈≈ music ≈≈≈≈≈≈≈]         │ audio 40 (waveform)
│ ＋ Add track                   │
├──────────────────────────────┤
│ ✂ Split ⧉ Dup 🗑 Del ⚡ Speed … │ 56  contextual toolbar (when something is selected)
├──────────────────────────────┤
│ ＋Media  Tt Text  ♪ Audio  ✦ Agent  ⋯ │ 56  bottom tab bar
└──────────────────────────────┘ safe-area bottom
```

- **MB-010 (MUST)** Bottom tab bar: **Media** (Project in grid view + import from files/camera roll + Motion Templates), **Text** (add text, captions), **Audio** (music, voice-over, levels), **Agent** ⊕ (the Agent panel as a sheet; it's a primary entry point on phones) **[SUPERSEDED: no Agent tab]**, **More** (Effects, Color, History, Jobs, Settings). Each opens a **bottom sheet** (detents 40% / 90%, drag handle, swipe down to dismiss, content scrolls inside) hosting the panel component in its touch presentation.
- **MB-011 (MUST)** There is no Source monitor on phones: Media items show a preview card with "Add to timeline" (inserts at the playhead on the main track or as overlay). There is no Tools panel: tools become contextual actions.
- **MB-012 (MUST)** Touch timeline model:
  - The **playhead is fixed at horizontal center**; one-finger horizontal drag scrolls the content (and scrubs), momentum while paused, none while playing.
  - Pinch horizontally zooms time (anchored at the playhead); vertical drag scrolls tracks.
  - Tap selects a clip: thick white outline + **trim handles** (16 px visual, 44 px hit area) at both edges; dragging a handle trims (ripple on the main track, regular on overlay tracks).
  - Long-press (≈ 350 ms) lifts a clip (scale 1.03, shadow) for moving/reordering; drop indicators between clips; long-press without moving (≈ 450 ms total) opens the context menu instead.
  - Split at the playhead from the contextual toolbar (no Razor tool).
  - Snapping always on; snapping to playhead, edges and markers triggers a haptic tick (`navigator.vibrate(10)` where supported; visual pulse otherwise).
  - Track headers collapse to a 32 px icon column (T/V/♪); lock/mute via long-press menu on the icon; targeting and patching hidden.
- **MB-013 (MUST)** Viewer gestures: pinch/two-finger pan on the viewer zooms/pans the preview when no layer is selected; with a layer selected, one finger moves it, pinch scales, two-finger rotate rotates (transform handles have 44 px hit areas). Double-tap toggles full-screen preview.
- **MB-014 (MUST)** Properties on touch: selecting a clip and tapping a contextual tool (Speed, Volume, Crop, Transform, Color, Text style, Template params ⊕) opens a sheet with large sliders (28 px thumb, 4 px track) plus numeric chips (tap to type), and a Reset button. The transport's ◆ adds/removes a keyframe for the property open in the sheet.
- **MB-015 (MUST)** Export on phone: full-screen sheet with simplified presets (Social 9:16, 16:9 1080p, Square, Audio), engine summary, and progress; when the device is a client of a remote engine, the export runs remotely and a notification/download link appears when done [OMS §8.3].
- **MB-016 (SHOULD)** Phone landscape: viewer left ~60% with transport; right column shows the active sheet as a side panel; timeline bottom ~40% with the tab bar as a left rail.
- **MB-017 (MAY)** Two-finger tap = undo, three-finger tap = redo.

### 19.3 Tablet shell

- **MB-020 (MUST)** Landscape: top compact header; left column 30% with a segmented control (Media, Text, Audio, Effects, Agent ⊕); center viewer with transport; right column 25% Properties; bottom 40% timeline with real track headers (lock, eye, mute, solo; 120 px wide), 48 px tracks, and a **movable** (not fixed) playhead for precise pencil/trackpad work.
- **MB-021 (MUST)** Portrait: phone layout with a larger viewer, the bottom sheet in two-column form, and track headers of 64 px.
- **MB-022 (MUST)** With a hardware keyboard attached, the full keymap is active (JKL, I/O, `,` `.` `;` `'`, etc.). Pointer type is re-evaluated per event: a trackpad/pencil pointer gets desktop-like direct manipulation (drag playhead, marquee) even in the tablet shell.
- **MB-023 (SHOULD)** In split-view/narrow multitasking widths, the tablet falls back to the phone shell (MB-002 guarantees continuity).

### 19.4 Touch rules applied everywhere

- **MB-030 (MUST)** Every hover-only affordance has a touch alternative: fade/volume handles are always visible on the selected clip, hover scrub becomes a scrub strip under the thumbnail, tooltips become long-press labels or are omitted.
- **MB-031 (MUST)** `touch-action: none` on the timeline canvas, viewer, sliders and handles (gestures handled via Pointer Events with multi-pointer tracking); `touch-action: manipulation` on buttons; `overscroll-behavior: none` on the app root to prevent pull-to-refresh and swipe-back; iOS page pinch-zoom is suppressed inside the editor surfaces.
- **MB-032 (MUST)** Minimum target 44×44 px for all interactive elements in touch density; spacing between adjacent targets ≥ 8 px.
- **MB-033 (MUST)** Default preview resolution on phones is 1/2 (1/4 for 4K sources); filmstrips on long timelines are sampled sparsely to cap decode work.

### 19.5 Touch density tokens

`[data-pr-density="touch"]` overrides: `--pr-font-size-ui: 14px`, `--pr-row-h: 44px`, `--pr-tab-h: 44px`, `--pr-hit-min: 44px`, `--pr-track-h-video: 56px`, `--pr-track-h-audio: 40px`, `--pr-track-h-text: 32px`, `--pr-radius-clip: 6px`, `--pr-handle-w: 16px`, `--pr-header-h: 48px`, `--pr-bottom-bar-h: 56px` [PUI §19.2]. Colors are unchanged (Darkest only), and the viewer background is pure black.

---

## 20. PWA specifics

- **PWA-001 (MUST)** Hand-rolled PWA, as in Orquester [OMS §3, §8.3]: `manifest.webmanifest` with `name`/`short_name` "JasperEditor", `display: "standalone"`, `display_override: ["window-controls-overlay", "standalone"]`, `orientation: "any"`, `background_color: "#000000"`, `theme_color: "#1d1d1d"`, 192/512 px icons plus separate maskable icons, `file_handlers` for `.jasper` projects and common media (SHOULD), `share_target` for media (MAY).
- **PWA-002 (MUST)** Head meta: viewport `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`, `theme-color`, `mobile-web-app-capable`, Apple web-app capable and `black-translucent` status bar, apple-touch-icon, manifest link.
- **PWA-003 (MUST)** Window Controls Overlay (installed desktop PWA): Row A becomes the title bar area; it lays out using `env(titlebar-area-x/y/width/height)`, empty areas are drag regions (`app-region: drag`), interactive children `no-drag`. When WCO is not active, Row A renders normally.
- **PWA-004 (MUST)** Service worker registered only in production web builds (never in Electron). It precaches the app shell, fonts and icons; network-first for navigations; cache-first for hashed assets; and **bypasses** engine routes and any media/proxy/thumbnail/waveform/render URL, `blob:` URLs and cross-origin requests (Range requests and multi-GB media must not touch Cache Storage) [OMS §8.3].
- **PWA-005 (MUST)** Update flow: when a new service worker is waiting, show an info toast "Update available · Reload" (sticky); never auto-reload while there are unsaved changes or running browser-engine jobs.
- **PWA-006 (MUST)** Offline behavior: the shell and open project remain usable in browser-only mode; engine-dependent commands disable per SH-031; the engine chip shows `Offline`. Media stays in the browser's local storage layer defined by the data spec.
- **PWA-007 (SHOULD)** Install prompt: a quiet "Install app" item in the Help menu and on Home (no nagging banners).

---

## 21. Electron specifics (UI level)

- **EL-001 (MUST)** Frameless main window: Windows/Linux `titleBarStyle: 'hidden'` with a title-bar overlay colored `--pr-bg-header` (`#1d1d1d`), symbol color `#e3e3e3`, height 28 (Row A); macOS `hiddenInset` with traffic lights positioned inside Row A. Row A is the drag region (HD-001). Window background `#1d1d1d` to avoid white flashes; show on ready-to-show.
- **EL-002 (MUST)** Native application menu built from the menu model (MN-001); accelerators from the keymap; menu clicks dispatch the command id to the focused window's renderer via IPC; enabled/checked states are pushed from the renderer when they change (debounced 100 ms). On Windows/Linux, Row A shows the in-app menubar instead (native menu hidden) for visual consistency; macOS uses the system menu bar (HD-006).
- **EL-003 (MUST)** Popout panels (DK-031) are real `BrowserWindow`s created by the main process in response to a renderer request; same session, same preload, frameless with a 28 px tab strip as title bar; bounds and display id persisted with the workspace; closing re-docks.
- **EL-004 (MUST)** Window state (bounds, maximized, full screen, display) persists across launches; restored windows are clamped to connected displays.
- **EL-005 (MUST)** Desktop-only affordances are exposed through the preload bridge and shown only when present: native file/folder pickers, Reveal in Folder, open exported file, drag files **out** to the OS (exports, frames) (SHOULD), file-association open (`.jasper`), import by path (no upload) [OMS §8.5].
- **EL-006 (SHOULD)** Program monitor "Playback on external display": full-screen video on a chosen secondary display (later).
- **EL-007 (MUST)** Keyboard: Electron receives browser-reserved combos, so the Premiere defaults apply without the web fallbacks (KB-013).

---

## 22. Accessibility and performance

### 22.1 Accessibility

- **A11Y-001 (MUST)** Text contrast: primary and secondary text meet WCAG AA against their backgrounds (`#8d8d8d` on `#1d1d1d` ≈ 5:1; `#e3e3e3` ≈ 13:1). Tertiary (`#6a6a6a`, ≈ 3.1:1) is used only for disabled content. High-contrast mode raises secondary/tertiary (§8.2).
- **A11Y-002 (MUST)** All controls are reachable by keyboard: `F6`/`Shift+F6` cycle regions (menubar/header → dock groups → status bar → toasts); `Ctrl+Shift+.`/`,` cycle panels; inside a panel, `Tab` order follows visual order; the tab strip is a proper `tablist` (arrow keys move between tabs; `Enter` activates; `Ctrl+W`/`Alt+W` closes).
- **A11Y-003 (MUST)** ARIA: menus (`menubar`, `menu`, `menuitemcheckbox`), dialogs (`dialog` + labelled), tabs, trees (`tree`/`treeitem` with `aria-expanded`), grids for the Project list, sliders with `aria-valuetext` (e.g. "Scale 120 percent"), timecode displays with `aria-label` in spoken form, toasts as live regions (TS-007), icon buttons with labels.
- **A11Y-004 (MUST)** Focus-visible ring (2 px `--pr-focus-ring`, offset 1 px) on keyboard focus only.
- **A11Y-005 (MUST)** Color is never the only signal: mute/solo show letters, render bar has tooltips and a legend in the Display Settings menu, labels have names, agent ghosts have numbered chips and patterns (hatch for removals).
- **A11Y-006 (SHOULD)** Screen-reader announcements for playback state changes ("Playing", "Stopped at 00:00:12:04") and edit results ("Razor: split V1 at 00:00:12:04") via a polite live region, throttled.
- **A11Y-007 (MUST)** UI scaling: View ▸ UI Scale (80–150%, step 10%) scales the whole UI in all runtimes. `Ctrl+=`/`Ctrl+-` are **not** used for UI zoom because they are track-height commands in the Timeline (TLC-006); Electron's default view-zoom accelerators are removed. Browser zoom on web must not break the layout.

### 22.2 Performance budgets

- **PERF-001 (MUST)** Cold start to interactive editor (cached assets, local engine, medium project): < 2.5 s on the reference machine (Linux x64, 12 cores, no GPU). Shell chrome renders within 300 ms of script start with skeleton panels.
- **PERF-002 (MUST)** Workspace switch < 100 ms for built-ins (no panel remounts for panels present in both layouts).
- **PERF-003 (MUST)** Splitter drag and panel resize at 60 fps with Program and Timeline visible; no React re-render of panel internals caused by the dock; ResizeObserver callbacks coalesced per frame.
- **PERF-004 (MUST)** Playhead, timecodes, meters and ruler update via direct DOM/canvas writes per animation frame, not via React state at 60 Hz.
- **PERF-005 (MUST)** Opening a menu or context menu < 50 ms; command palette results < 30 ms for 5k indexed entries.
- **PERF-006 (MUST)** Agent streaming renders at ≤ 1 layout per animation frame (chunks are batched); a 500-message conversation scrolls at 60 fps (virtualized).
- **PERF-007 (SHOULD)** Hidden panels cost < 1% CPU (SH-007).

---

## 23. Where JasperEditor goes beyond the baseline ⊕

| Area | Baseline (template) | JasperEditor |
|---|---|---|
| Layout | One fixed layout, fixed-width properties column, draggable timeline height | Docking workspace: tab groups, splitters with 4-way intersections, floating and popout windows, maximize, 8+ built-in workspaces, custom workspaces with saved/current snapshots, workspace tabs |
| Chrome | Single top toolbar | Title/menu bar, header with modes (Import/Edit/Export), workspace tabs, engine/jobs/agent/search status cluster, optional status bar |
| Focus and keys | Global shortcuts, a handful of bindings | Panel-focus model with outline, scoped keymap, full Premiere default map, remappable with presets and a visual keyboard, web-safe fallbacks |
| Menus | Two context menus | Data-driven menubar (in-app and native), panel menus, comprehensive context menus, command palette with agent fallback |
| Design | Few theme colors, ad-hoc grays, system font | Full token system (Darkest/Dark, high contrast, touch density), Premiere label colors with presets, Source Sans 3, icon registry (lucide + our NLE glyphs), custom cursors |
| Panels | Preview, properties column, timeline | Project (list/icon, bins), Media Browser, Source + Program monitors with button editor, Effect Controls with keyframe mini-timeline, Effects, Tools with flyouts, Premiere track headers, Audio Meters, Properties, Motion Templates, History, Info, Markers, Text, Jobs, Events, Agent |
| Engines | One render path, two codecs | Three engines visible everywhere: engine chip, capability gating, engine badges on clips/effects/templates, render bar semantics, Jobs panel with stages, export engine choice (Auto/Native/Remotion/Hybrid/Browser) with validation |
| Export | Codec picker + render button in the properties column | Premiere-style Export mode (destinations, preview with range, settings sections, summary), multi-destination, interchange formats, loudness targets, Quick Export, render queue |
| Agent | None | First-class dockable Agent panel, autonomy modes, plan/tool cards, proposal review with timeline ghosts, staleness handling, labeled undo steps, command-registry-driven UI tools |
| Platforms | Desktop browser only | Web, installable PWA (WCO, offline shell), phone and tablet touch shells with gestures and sheets, Electron frameless with native menus and popouts |
| Feedback | A few toasts | Toast system with kinds, actions, dedupe, notification log; dialogs catalog; accessibility requirements |

---

## 24. Acceptance criteria

Each item is a test (unit/component/E2E via Playwright on web and Electron; touch via device emulation plus one real iOS and Android device pass).

### Shell and docking
1. **AC-SH-1** Fresh profile opens the Editing workspace with groups in the documented positions; Program and Timeline are visible; Tools is 40 px and Audio Meters 52 px wide at 1920×1080. (WS-001/002/003)
2. **AC-SH-2** Drag the Effects tab onto the right edge of Program → a new group appears between Program and the right column; reload → layout persists; Reset to Saved Layout → Effects returns to its original group. (DK-021, WS-011, SH-022)
3. **AC-SH-3** Hide the Timeline behind another tab, play, switch back → playback continued and the timeline scroll position is unchanged. (SH-006)
4. **AC-SH-4** Corrupt the stored layout JSON → app opens with the default layout and shows exactly one warning toast. (SH-021)
5. **AC-SH-5** `` ` `` over the Timeline maximizes it; `` ` `` again restores the exact prior sizes (pixel-equal). (DK-040)
6. **AC-SH-6** Pop out Project into a window (Electron and Chrome), drag a clip from it to the Timeline in the main window → the clip is added. Close the popout → Project re-docks. (DK-031/032)
7. **AC-SH-7** Close all panels → empty-workspace state with working Reset. (DK-043)

### Focus and keyboard
8. **AC-KB-1** Focus Project, press `=` → thumbnails grow; focus Timeline, press `=` → timeline zooms in. (KB-002)
9. **AC-KB-2** Type "j" into a Project search field → no shuttle playback. (KB-005)
10. **AC-KB-3** On web, the New Sequence menu item shows `Alt+N`; pressing it opens New Sequence. In Electron it shows `Ctrl+N`. (KB-013)
11. **AC-KB-4** The binding-conflict test passes for the default keymap. (KB-011)
12. **AC-FO-1** Clicking inside Effect Controls draws the 1 px blue outline on its group only; opening a menu doesn't move the outline. (FO-001/002/004)

### Design system
13. **AC-DT-1** Lint finds zero color literals/raw palette classes outside `theme/`. (DT-002)
14. **AC-DT-2** Switching Darkest → Dark → High contrast updates every surface without reload and without a flash on next launch. (DT-003)
15. **AC-TY-1** Timecode during playback doesn't change width (tabular numerals); `1510` typed into the timeline timecode seeks to 00:00:15:10; `+15` moves 15 frames. (TY-004/006)
16. **AC-CT-1** Scrubbing Scale from 100 to 150 and releasing creates one undo step; Esc during scrub restores 100. Shift-drag moves 10× faster. (CT-021/023)

### Menus, toasts, dialogs
17. **AC-MN-1** The Edit menu shows "Undo Ripple Delete" after a ripple delete; after an agent apply it shows "Undo Agent: …". (MN-011)
18. **AC-MN-2** Command palette: typing "razor" lists the Razor tool with `C`; typing "make the intro punchier" shows "Ask the agent: …" and Ctrl+Enter sends it to the Agent panel **[SUPERSEDED: no agent row]**. (MN-041/042)
19. **AC-TS-1** Five rapid identical errors produce one toast with "×5"; max three toasts visible; error with an action stays until dismissed. (TS-003/004)
20. **AC-DG-1** In the Marker dialog, Enter commits and Esc cancels; focus returns to the timeline. (DG-002)

### Export and engines
21. **AC-EX-1** With no engine connected, Export shows Engine = Browser, native-only formats disabled with a reason tooltip, and interchange formats other than OTIO disabled. (SH-031, EX-020)
22. **AC-EX-2** Sequence with an fframes clip + footage, engine connected: Auto resolves to Hybrid and the summary explains why; Export creates a job with stages visible in Jobs. (EX-021/030)
23. **AC-EX-3** Setting width 1081 with H.264 blocks Export with a fix-it message. (EX-022)
24. **AC-JOB-1** Kill the engine during an export → the job shows Stalled, a Reconnect toast appears, and the editor still plays in browser-only mode. (SH-032, JOB-005)

### Agent

> **Superseded (wp-mcp):** AC-AG-1…4 test the removed in-app agent. The agent acceptance checks are now ARCHITECTURE §15 item 10 and `e2e/agent.spec.ts` (an MCP client drives the live editor).

25. **AC-AG-1** In Propose mode, "remove the long pauses" yields numbered proposals and matching ghosts on the timeline; clicking proposal ③ seeks to it and highlights ghost ③; Apply all creates exactly one undo step labeled "Agent: …". (AG-030/031/012)
26. **AC-AG-2** Editing a clip referenced by a pending proposal marks it Outdated and disables its Apply. (AG-032)
27. **AC-AG-3** While the user types in a text field, an agent `panel.focus` call does not steal keyboard focus. While playing, an agent `playhead.seek` is deferred. (AG-013)
28. **AC-AG-4** `ui.describe()` returns workspace, visible panels, focused panel, selection summary and engine capabilities matching the screen. (AG-051)

### Touch, PWA, Electron
29. **AC-MB-1** At 390×844 (coarse pointer) the phone shell renders; horizontal drag on the timeline scrubs with the playhead fixed at center; pinch zooms; long-press on a clip opens the context menu. (MB-012)
30. **AC-MB-2** Rotating an iPad from landscape to portrait keeps the playhead, selection and open Agent conversation. (MB-002)
31. **AC-MB-3** All interactive elements in the phone shell are ≥ 44×44 px (automated audit). (MB-032)
32. **AC-PWA-1** Installed PWA with WCO shows Row A in the title bar area and drags the window from empty areas; offline reload shows the editor with the engine chip "Offline". (PWA-003/006)
33. **AC-PWA-2** Seeking a media file via Range requests never hits the service worker cache (verified by DevTools). (PWA-004)
34. **AC-EL-1** macOS: native menu shows Premiere-style menus with accelerators; choosing Sequence ▸ Add Edit splits at the playhead in the focused window. (EL-002)

### Performance and accessibility
35. **AC-PERF-1** Splitter drag holds ≥ 55 fps average on the reference machine with a 20-track, 300-clip sequence visible. (PERF-003)
36. **AC-A11Y-1** axe-core finds no critical violations in the desktop and phone shells; all icon buttons have accessible names. (A11Y-003)

---

## 25. Open questions and risks

1. **Docking library fit.** Confirm with a spike that the chosen library supports: keep-alive tabs, popout windows under Electron, custom tab rendering (the `≡` glyph, context in titles, sequence-tab `×` on the left), 4-way intersection drags, maximize without tree mutation, and theming via variables. If intersections or maximize don't fit, implement them in our wrapper.
2. **Two Remotion Players (Source + Program)** plus template-gallery hover previews may exceed decoder/memory budgets on phones. On phones, previews are posters and there is no Source monitor (MB-011); on desktop, limit animated gallery previews to one at a time.
3. **Live audio metering** depends on whether the preview audio path exposes an analyser tap; the envelope fallback (MTR-002) is the safe default.
4. **Browser-reserved shortcuts** reduce Premiere parity on the web; the Electron app and KB-013 fallbacks mitigate it. Keyboard Lock API in full screen MAY recover some combos.
5. **Agent-driven UI** needs guardrails beyond AG-013/052 once multiple agents or remote collaborators exist (presence cursors, locks). Out of scope for v1.
6. **Trade dress.** We copy conventions, not assets. Keep label display names neutral (DT-022), use our own icons, our own logo, and never the word "Premiere" in UI strings.
7. **Shortcut choices to verify** against the final default keymap: `Shift+0` (Agent), `Ctrl+.` (Stop agent), `Ctrl+Shift+P` (palette), `Ctrl+0` (monitor fit).

---

## 26. Suggested work packages

| WP | Scope (requirement IDs) | Depends on |
|---|---|---|
| UI-1 Tokens, fonts, icon registry, lint rule | DT-*, TY-001…004, IC-001…005 | — |
| UI-2 Primitives (buttons, fields, scrubby, slider, lists, menus, tooltips, dialogs, toasts) | CT-*, MN-002/003, TT-*, DG-001…007, TS-* | UI-1 |
| UI-3 Command registry + keymap dispatcher + menu model | KB-*, MN-001/004/010/011 | UI-2 |
| UI-4 Shell: header, menubar, layout-mode switch, persistence, engine chip | SH-*, HD-*, MB-001 | UI-3 |
| UI-5 Docking + workspaces + focus + maximize + floating | DK-*, WS-*, FO-*, PC-* | UI-4 |
| UI-6 Panel registry + Program/Source monitor chrome + Tools | PN-*, PGM-*, TOOL-* | UI-5, preview spec |
| UI-7 Timeline chrome (header, track headers, ruler, zoom bars, clip visuals) | TLC-* | UI-5, timeline spec |
| UI-8 Project, Effects, Effect Controls, Properties, History | PRJ-*, EFX-*, ECP-*, PRP-*, HIS-* | UI-6, data spec |
| UI-9 Jobs, Export mode, Quick Export, Export Frame | JOB-*, EX-* | UI-5, engine/rendering spec |
| UI-10 Agent panel, ghosts, agent UI tools | AG-*, TLC-042, MN-042 | UI-3, UI-7, agent spec |
| UI-11 Audio Meters, Motion Templates, Info, Markers, Text, Events | MTR-*, MGT-*, INF-*, MRK-*, TXT-*, EVT-* | UI-8 |
| UI-12 Touch shells (phone/tablet), sheets, gestures | MB-* | UI-6…UI-10 |
| UI-13 PWA + Electron shell integration | PWA-*, EL-* | UI-4, desktop/engine setup |
| UI-14 Accessibility + performance pass | A11Y-*, PERF-* | all |
