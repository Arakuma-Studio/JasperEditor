# JasperEditor: Premiere-style UI design spec

Status: research / design spec (topic `premiere-ui`). Target: web app, installable PWA, and Electron desktop.
Reference: Adobe Premiere Pro 2024–2026 (v24.4 new clip design, v25 "Spectrum" UI refresh, v26/"Adobe Premiere" rename, v27-beta Color mode).

> Legal note: we copy **layout, interaction conventions and keyboard conventions**. These are industry-standard and shared by Avid, Resolve, FCP and others. We do **not** copy Adobe logos, the Premiere icon set, the "Adobe Clean" font, splash screens or product names. Draw every icon from an open set (Lucide / Phosphor / Tabler, or our own SVGs). Label color *names* such as "Iris" and "Caribbean" are generic words, but we can still rename them (see §3.4).

---

## 0. Sources and how the values were derived

- Adobe Help (Premiere desktop docs, fetched 2026-09 via reader proxy):
  - workspaces: `get-started/tour-the-workspace/*`
  - default keyboard shortcuts (page updated Jan 7 2026)
  - monitor docs: `get-started/source-and-program-monitor-adjustments/*`
  - timeline docs: `edit-projects/change-clip-sequence/*` and `edit-projects/intro-to-editing/*`
  - Effect Controls, Properties panel, Audio Track Mixer, Lumetri / Color mode, Project panel views
  - Labels and Appearance preferences
- Colors come from **pixel sampling of official Adobe Help screenshots** of the Spectrum UI (Darkest theme). Each value was cross-checked against the open-source Adobe Spectrum tokens:
  - `@spectrum-css/vars@9.0.8` `spectrum-darkest.css`
  - `@adobe/spectrum-tokens@15.4.1` `dist/json/drover.json`. "Drover" is the internal name of the Premiere Spectrum UI; the help URL is `drover-7-spectrum-ui.html`.
- The two match exactly:
  - panel background `#1d1d1d` = Spectrum-darkest `gray-100` (29,29,29)
  - frame gutters `#000000` = `gray-50`
  - fields `#0e0e0e` = `gray-75`
  - secondary text `#8d8d8d` = `gray-500`
  - disabled `#6a6a6a` = `gray-400`
  - playhead / accent `#4096f3` = `blue-500`
- Pixel measurements come from a 1380 px-wide screenshot of a roughly 1512 pt display (MacBook, about 0.913× scale). Sizes below are rounded to a 2 px / 4 px grid. Treat all sizes as **target values to tune by eye**, not ground truth.
- Scratch material (downloaded screenshots, token dumps, fetched help pages) is in `/tmp/jasper-research/premiere-ui/`. It is not part of the repo.

---

## 1. Where the current starter code maps to Premiere concepts

The Remotion Editor Starter has a fixed vertical layout:

```
ActionRow → TopPanel(Canvas | Inspector) → PlaybackControls → TimelineResizer → Timeline
```

See `src/editor/editor.tsx`. The table below maps each existing module to its Premiere counterpart.

| Premiere concept | Current starter module | Change needed |
|---|---|---|
| Application frame / workspace | `src/editor/editor.tsx` (fixed flex column) | Replace with a docking `WorkspaceHost` (§5) |
| Program Monitor | `src/editor/canvas/*`, `src/editor/top-panel.tsx`, `src/editor/preview-size*.tsx` | Wrap in a `ProgramMonitorPanel` with Premiere monitor chrome (§8) |
| Monitor transport + timecode | `src/editor/playback-controls/*` (`time-display.tsx`, `project-duration-display.tsx`, `play-pause.tsx`, `seeking.tsx`, `loop-button.tsx`) | Move into the monitor's bottom bar; add a Button Editor model |
| Tools panel | `src/editor/action-row/tool-selection.tsx`, `split-item-tool.tsx`, `EditModeContext` in `src/editor/edit-mode.tsx` | Vertical `ToolsPanel` with the Premiere tool set (§10). Extend `editMode` into a `ToolId` union |
| Timeline toolbar (snap/linked/marker/wrench) | `src/editor/action-row/snapping-toggle.tsx`, `keyboard-shortcuts/snapping-shortcut.tsx` | Move into the timeline header (§9.2) |
| Track headers | `src/editor/timeline/timeline-side-panel/*` (`SIDE_PANEL_WIDTH = 110`, `timeline-track-header.tsx`, `timeline-hide-track.tsx`, `timeline-mute-track.tsx`) | Widen to about 176 px. Add lock, target, sync lock, patch, M/S/voice-over (§9.3) |
| Clip colors | `ITEM_COLORS` in `src/editor/constants.ts` | Replace with the label-color system (§3.4) |
| Track height | `DEFAULT_TRACK_HEIGHT = 32`, `TRACK_PADDING = 2` in `src/editor/state/items.ts` | Per-track, user-resizable height (§4) |
| Ruler | `src/editor/timeline/ticks/*` (`TICKS_HEIGHT = 30`) | Premiere ruler + work-area bar + render bar + markers (§9.4) |
| Playhead | `src/editor/timeline/playhead.tsx` (`PLAYHEAD_WIDTH = 19`) | Blue head and a 1 px line (§9.5) |
| Timeline zoom | `src/editor/timeline/timeline-zoom-slider.tsx` | Premiere "zoom scroll bar" with round end handles (§9.7) |
| Rolling edits | `src/editor/timeline/timeline-track/timeline-track-rolling-edit(s).tsx` | Keep; bind to Rolling Edit tool `N` |
| Inspector | `src/editor/inspector/*` | Split into **Properties** (context panel) and **Effect Controls** (keyframes) (§11, §13) |
| Panel resizer | `src/editor/timeline-resizer.tsx` | Replaced by dock splitters |
| Shortcuts | `src/editor/keyboard-shortcuts/*.tsx` (each adds its own `window.keydown` listener) | Replace with one panel-scoped keymap registry (§16) |
| Theme tokens | `src/editor/editor-starter.css` (`--color-editor-starter-*`) | Alias to the `--pr-*` tokens (§3.6) |
| Context menus | `src/editor/context-menu.tsx` (Radix) | Keep Radix and restyle (§3.5 menus) |
| z-order | `src/editor/z-indices.ts` | Add layers for dock overlays, floating panels and the maximize state |

---

## 2. Visual language summary (what makes it "feel like Premiere")

1. **Near-black, flat, low-chrome UI.**
   - Panels are `#1d1d1d` tiles separated by 2–3 px **black gutters** (`#000`).
   - There are no drop shadows inside the workspace.
   - Since v25, panel frames have a slight corner radius (about 4 px). Before v25 they were square.
2. **Blue is the only UI accent.** It is used for:
   - the playhead, timecodes, and "scrubby" numeric values;
   - selected tools, targeted tracks and the focused-panel outline;
   - OK buttons and toggles when on.
   - Everything else is grayscale. Content colors (clip labels, meters, render bar, markers) carry the only other hues.
3. **Tabbed panel groups everywhere.** Each panel has:
   - a tab title;
   - a `≡` panel-menu glyph beside the active tab;
   - `»` overflow when tabs don't fit.
   - The active tab text is white with a 2 px light-gray underline. Inactive tabs are gray.
4. **Blue timecode text** (large, tabular digits) at the top-left of the timeline and bottom-left of each monitor. Durations use gray/white text at the bottom-right.
5. **Scrubby numbers.** Blue numeric values change when dragged horizontally and become text fields when clicked. This applies in Effect Controls, the mixer and Properties.
6. **Dense typography**: roughly 11–12 px UI text, 20–24 px rows.
7. **Saturated, dark clip bodies** (the v24.4+ design) with white names and light-tint waveforms. Selected clips get a white outline.

---

## 3. Color system

### 3.1 Theme structure

- Premiere 25+ ships three themes (**Darkest** default, **Dark**, **Light**) plus a High/Low **contrast** toggle. The source is Appearance preferences.
- Before v25 it was a brightness slider.
- We ship `darkest` as the default and `dark` as an option. `light` is optional and low priority: video UIs are almost always dark.

Apply the theme with `data-pr-theme="darkest|dark|light"` and `data-pr-contrast="normal|high"` on `<html>`.

### 3.2 Core UI palette (CSS custom properties)

Measured means sampled from the Premiere v25 screenshots.

| Token | Darkest (default) | Dark | Usage | Evidence |
|---|---|---|---|---|
| `--pr-bg-app` | `#000000` | `#111111` | Window background; gutters between panel frames; header bar background under panels | measured `#000` |
| `--pr-bg-header` | `#1d1d1d` | `#262626` | Top application header bar | measured `#1d1d1d`–`#1f1f1f` |
| `--pr-bg-panel` | `#1d1d1d` | `#262626` | Panel body; monitor pasteboard | measured `#1d1d1d` = Spectrum `gray-100` |
| `--pr-bg-panel-alt` | `#1a1a1a` | `#232323` | Timeline track area; alternating list rows | measured `#1a1a1a`–`#1b1b1b` |
| `--pr-bg-panel-raised` | `#232323` | `#2e2e2e` | Timeline header strip; section headers; hover rows | measured `#202020`–`#232323` |
| `--pr-bg-field` | `#0e0e0e` | `#1d1d1d` | Text inputs, dropdowns, search boxes, number fields | measured `#0e0e0e` = `gray-75` |
| `--pr-bg-field-deep` | `#080808` | `#171717` | Search fields in the Project panel; meter wells | measured `#080808` |
| `--pr-bg-hover` | `#2a2a2a` | `#363636` | Hover on buttons, list rows, tabs | Spectrum `gray-200`-ish |
| `--pr-bg-pressed` | `#303030` | `#3f3f3f` | Pressed / open-menu state | `gray-200` darkest |
| `--pr-bg-selected-row` | `#2c2c2c` | `#3a3a3a` | Non-emphasized selected row (Project list, Effects tree) | Spectrum `table-selected-row-non-emphasized` |
| `--pr-border-subtle` | `#2a2a2a` | `#3a3a3a` | 1 px dividers inside panels (list rows, EC rows) | measured `#272727`–`#313131` |
| `--pr-border` | `#303030` | `#3f3f3f` | Control borders; track separators | `gray-200` |
| `--pr-border-strong` | `#4b4b4b` | `#545454` | Scrollbar thumbs; slider tracks; zoom-bar track | measured `#4b4b4b` = `gray-300` |
| `--pr-text-primary` | `#e3e3e3` | `#e8e8e8` | Main text, active tab, values that aren't scrubby | measured `#e3e3e3` |
| `--pr-text-strong` | `#ffffff` | `#ffffff` | Clip names; emphasized labels | |
| `--pr-text-secondary` | `#8d8d8d` | `#909090` | Inactive tabs, column headers, durations, units | measured `#8f8f8f` = `gray-500` |
| `--pr-text-tertiary` | `#6a6a6a` | `#707070` | Disabled text/icons, ruler numbers at low zoom | measured `#6a6a6a` = `gray-400` |
| `--pr-icon` | `#b0b0b0` | `#b2b2b2` | Default icon color | `gray-600` |
| `--pr-icon-hover` | `#ebebeb` | `#ebebeb` | | `gray-800` |
| `--pr-accent` | `#4096f3` | `#54a3f6` | Playhead, focused-panel outline, links, active toggles | measured `#4096f3` = `blue-500` |
| `--pr-accent-fill` | `#1473e6` | `#2680eb` | Filled selected buttons: current tool, primary buttons (OK) | measured `#066ce7`–`#0d68a4` |
| `--pr-accent-fill-hover` | `#0d66d0` | `#1473e6` | | |
| `--pr-target-fill` | `#005cc8` | `#1473e6` | Track-target (V1/A1) pill when targeted; source-patch pill | measured `#005cc8` |
| `--pr-timecode` | `#46b8ff` | `#5ec2ff` | Current-time displays (timeline, monitors, EC) | measured `#46bbff`–`#49c5ff` (classic UI used `#2d8ceb`) |
| `--pr-value` | `#46b8ff` | `#5ec2ff` | Scrubby numeric values (EC, mixer pan/gain) | same hue as timecode |
| `--pr-focus-ring` | `#4096f3` | `#54a3f6` | 1 px outline around the **focused panel frame**; 2 px keyboard focus ring on controls | measured `#3e89da` |
| `--pr-overlay-scrim` | `rgba(0,0,0,.6)` | `rgba(0,0,0,.6)` | Modal backdrop | Spectrum `overlay-opacity` .6 dark |
| `--pr-menu-bg` | `#1d1d1d` | `#323232` | Context menus / popovers | |
| `--pr-menu-border` | `#444444` | `#545454` | Popover border | Spectrum drover `popover-border-color` `#444` |
| `--pr-danger` | `#df3422` | `#df3422` | Destructive; Record button | drover `negative-background` |
| `--pr-warning` | `#e06400` | `#e06400` | Offline media, warnings | drover `notice-background` |
| `--pr-success` | `#068850` | `#068850` | | drover `positive-background` |

### 3.3 Editing-specific semantic colors

| Token | Value | Usage |
|---|---|---|
| `--pr-playhead` | `var(--pr-accent)` `#4096f3` | Playhead head and line. **Premiere's playhead is blue, not red.** The line is 1 px (renders about `#3379c5` antialiased) |
| `--pr-inout-range` | `rgba(255,255,255,.10)` | Shaded range between In and Out on the timeline ruler/track area and monitor mini-ruler |
| `--pr-inout-bracket` | `#e3e3e3` | In/Out bracket glyphs `{` `}` on rulers |
| `--pr-workarea` | `#7a7a7a` | Work-area bar (hidden by default; enable from the sequence `≡` menu) |
| `--pr-render-red` | `#d8322a` | Render bar: needs render |
| `--pr-render-yellow` | `#e6df0a` | Render bar: may need render (unrendered but real-time capable). Measured `#ede603` |
| `--pr-render-green` | `#27b14a` | Render bar: rendered preview exists (for us: cached proxy/preview available) |
| `--pr-snap-line` | `rgba(255,255,255,.9)` + `#000` 1 px casing | Snap indicator line with small triangles at the ends |
| `--pr-trim-ripple` | `#f5c518` (yellow) | Ripple-trim cursor and edit-point highlight |
| `--pr-trim-roll` / `--pr-trim-regular` | `#e4453a` (red) | Rolling/regular trim edit-point highlight (Premiere uses red brackets for trim, yellow for ripple) |
| `--pr-locked-hatch` | `repeating-linear-gradient(135deg, rgba(255,255,255,.06) 0 2px, transparent 2px 6px)` | Diagonal slash pattern over locked tracks |
| `--pr-disabled-clip` | clip body at 35% opacity, label desaturated | Disabled clip (`Shift+E`) |
| `--pr-offline-clip` | `#b3261e` body, `#ffdad6` text | Offline / missing media |
| `--pr-keyframe` | `#b0b0b0` fill, `#ebebeb` stroke | Keyframe diamond |
| `--pr-keyframe-selected` | `#4096f3` fill, `#ffffff` stroke | |
| `--pr-meter-green` | `#2fbf4f` | Audio meter below −12 dBFS |
| `--pr-meter-yellow` | `#e6d21a` | −12 … −6 dBFS |
| `--pr-meter-red` | `#e5322b` | ≥ −3 dBFS and clip indicators |
| `--pr-meter-peak-hold` | `#e3e3e3` | Peak hold lines |

Marker colors: Premiere has 8 marker colors and the default for new markers is **Green**. Approximate values:

| Marker | Hex |
|---|---|
| Green (default) | `#3fb54a` |
| Red | `#e0453a` |
| Purple | `#9b59d0` |
| Orange | `#f08a24` |
| Yellow | `#e8d31e` |
| White | `#e6e6e6` |
| Blue | `#3d8ef0` |
| Cyan | `#2cc6d8` |

Marker tokens are `--pr-marker-{green,red,...}`.

### 3.4 Clip label colors (media-type colors)

Premiere uses 16 named **label colors**. The Labels preference assigns a default label per media type, and the label color is what the clip body is painted with in the timeline.

- Since v24.4 there are **Label Color Presets**: `Default`, `Classic`, `Vibrant`, `Editorial`.
- The **v24.4+ `Default` preset** uses dark, saturated bodies and draws waveforms in a light tint. These values were sampled from the Labels preference screenshot.
- The **`Classic` preset** is the older, lighter pastel set.

| Name | Token | New default (body) | Light tint (waveform/text-on-dark) | Classic (pre-24.4) |
|---|---|---|---|---|
| Violet | `--pr-label-violet` | `#3e0aad` | `#b9a2ff` | `#a690e0` |
| Iris | `--pr-label-iris` | `#004b68` | `#5fc2fe` | `#729acc` |
| Caribbean | `--pr-label-caribbean` | `#2a5506` | `#9fe07a` | `#29d698` |
| Lavender | `--pr-label-lavender` | `#741186` | `#e9a6ff` | `#e384e3` |
| Cerulean | `--pr-label-cerulean` | `#06555a` | `#6fe3e6` | `#2fbfde` |
| Forest | `--pr-label-forest` | `#3e4a00` | `#c9d86a` | `#51b858` |
| Rose | `--pr-label-rose` | `#8c0235` | `#ff9dbd` | `#f76fa4` |
| Mango | `--pr-label-mango` | `#893904` | `#ffb27a` | `#eda63b` |
| Purple | `--pr-label-purple` | `#6200b7` | `#c89bff` | `#970097` |
| Blue | `--pr-label-blue` | `#122c9a` | `#9cb0ff` | `#3c3cff` |
| Teal | `--pr-label-teal` | `#014e44` | `#6fe0cc` | `#008080` |
| Magenta | `--pr-label-magenta` | `#830d57` | `#ff9ad6` | `#e732e7` |
| Tan | `--pr-label-tan` | `#6f5a45` | `#e2c9ad` | `#cec195` |
| Green | `--pr-label-green` | `#0d5e26` | `#7fe39a` | `#1d7021` |
| Brown | `--pr-label-brown` | `#5c3b06` | `#e0b877` | `#8b4513` |
| Yellow | `--pr-label-yellow` | `#6f6619` | `#f0e57a` | `#e2e264` |

The light tints are our derivation (label hue at about 80% lightness). The Iris tint `#5fc2fe` was measured from a waveform.

A timeline screenshot from v25 shows these on-screen colors:
- video clip body `#004b67` (Iris);
- graphics clip `#891d9c` (Lavender family, brightened);
- caption clip `#893a04` (Mango);
- audio waveform `#5fc2fe`.

**JasperEditor default label mapping.** This follows Premiere's classic convention (video = blue/violet, audio = green/teal):

| Media type | Label | Notes |
|---|---|---|
| Video only | Iris | Premiere default for Video |
| Movie (video + audio) | Violet | Premiere classic default for Movie |
| Audio | Caribbean | Premiere classic default for Audio (green/teal) |
| Still image / GIF | Lavender | Premiere default for Still |
| Sequence / nested sequence | Forest | Premiere default for Sequence |
| Bin | Mango | Premiere classic default for Bin |
| Captions | Mango | v25 captions render orange |
| Remotion composition (motion graphic) | Magenta | JasperEditor-specific |
| fframes (Rust/SVG) motion graphic | Purple | JasperEditor-specific |
| Solid / color matte / adjustment layer | Tan | |
| Text / title (graphic) | Lavender | v25 graphic clips render in the lavender/magenta family |

- Implement this as `LABEL_DEFAULTS: Record<MediaKind, LabelName>`. It replaces `ITEM_COLORS` in `src/editor/constants.ts`.
- Let users re-label per clip. The clip context menu has a **Label ▸** submenu and a **Select Label Group** item.
- Ship the presets `default | classic | vibrant` as JSON.
- Optional rename to avoid trade-dress confusion: `violet→indigo`, `iris→steel`, `caribbean→jade`, `lavender→orchid`, `cerulean→lagoon`, `forest→moss`, `rose→ruby`, `mango→amber`.

### 3.5 Component styling rules

**Buttons (icon buttons, the most common control)**
- 24×24 hit box and 16 px glyph.
- Transparent background; `--pr-bg-hover` on hover.
- Toggle-on state: `--pr-accent` glyph color. Filled (`--pr-accent-fill` background, white glyph) for mode/tool selection.

**Text buttons**
- 24 px high, radius 4 (v25 rounds corners).
- Secondary: `--pr-border-strong` 1 px border with transparent background.
- Primary: `--pr-accent-fill` background, white text, pill radius 12 in dialogs ("OK").

**Dropdowns**
- `--pr-bg-field` background, 22–24 px high, radius 4.
- Chevron right-aligned; no border until hover (then `--pr-border-strong`).

**Number fields**
- "Scrubby" blue text with no box.
- Cursor `ew-resize` on hover. Click enters edit mode with a `--pr-bg-field` box.
- Shift-drag = 10× step; Ctrl/Cmd-drag = 0.1× step.

**Checkboxes**
- 14 px box, 1 px `--pr-text-secondary` border, radius 2.
- Checked: `--pr-text-primary` fill with dark check. Premiere checkboxes are gray, not blue.

**Sliders**
- 2 px `--pr-border-strong` track.
- 12 px round thumb with a hollow `--pr-text-primary` stroke (v25 style: white ring with dark center).

**Menus (context and panel menus)**
- `--pr-menu-bg`, 1 px `--pr-menu-border`, radius 6, 4 px padding.
- Items are 24 px high with 12 px text.
- Shortcut text right-aligned in `--pr-text-secondary`.
- Hover: `--pr-accent-fill` background with white text. Spectrum desktop menus highlight in blue.
- Checkmark column 20 px; separators 1 px `--pr-border`.

**Tooltips**
- `#3a3a3a` background, 12 px text, radius 4.
- Delay 600 ms.
- Format `Name (Shortcut)`, e.g. "Razor Tool (C)".

**Scrollbars**
- 8 px wide; thumb `--pr-border-strong`, radius 4; track transparent.
- The starter's `scrollbarStyle` in `src/editor/constants.ts` becomes `scrollbar-color: var(--pr-border-strong) transparent`.

**Focus**
- The *focused panel* gets a 1 px `--pr-focus-ring` outline on its frame. This is how Premiere shows which panel receives keyboard shortcuts, and it is essential for panel-scoped shortcuts.
- Control-level focus uses a 2 px ring, shown only for keyboard focus (`:focus-visible`).

### 3.6 Implementation: tokens file + Tailwind 4 bridge

Create `src/editor/theme/premiere-tokens.css` and import it from `src/editor/editor-starter.css`.

```css
/* src/editor/theme/premiere-tokens.css */
:root,
[data-pr-theme='darkest'] {
	--pr-bg-app: #000;
	--pr-bg-header: #1d1d1d;
	--pr-bg-panel: #1d1d1d;
	--pr-bg-panel-alt: #1a1a1a;
	--pr-bg-panel-raised: #232323;
	--pr-bg-field: #0e0e0e;
	--pr-bg-field-deep: #080808;
	--pr-bg-hover: #2a2a2a;
	--pr-bg-pressed: #303030;
	--pr-bg-selected-row: #2c2c2c;
	--pr-border-subtle: #2a2a2a;
	--pr-border: #303030;
	--pr-border-strong: #4b4b4b;
	--pr-text-primary: #e3e3e3;
	--pr-text-strong: #fff;
	--pr-text-secondary: #8d8d8d;
	--pr-text-tertiary: #6a6a6a;
	--pr-icon: #b0b0b0;
	--pr-icon-hover: #ebebeb;
	--pr-accent: #4096f3;
	--pr-accent-fill: #1473e6;
	--pr-accent-fill-hover: #0d66d0;
	--pr-target-fill: #005cc8;
	--pr-timecode: #46b8ff;
	--pr-value: #46b8ff;
	--pr-focus-ring: #4096f3;
	--pr-playhead: var(--pr-accent);
	--pr-menu-bg: #1d1d1d;
	--pr-menu-border: #444;
	/* metrics (see §4) */
	--pr-radius-frame: 4px;
	--pr-gutter: 3px;
	--pr-header-h: 36px;
	--pr-tab-h: 28px;
	--pr-row-h: 22px;
	--pr-track-header-w: 176px;
	--pr-font-ui: 'Source Sans 3', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
	--pr-font-size-ui: 12px;
}
[data-pr-theme='dark'] {
	--pr-bg-app: #111;
	--pr-bg-header: #262626;
	--pr-bg-panel: #262626;
	--pr-bg-panel-alt: #232323;
	--pr-bg-panel-raised: #2e2e2e;
	--pr-bg-field: #1d1d1d;
	--pr-bg-field-deep: #171717;
	--pr-bg-hover: #363636;
	--pr-bg-pressed: #3f3f3f;
	--pr-border-subtle: #3a3a3a;
	--pr-border: #3f3f3f;
	--pr-border-strong: #545454;
	--pr-accent: #54a3f6;
	--pr-timecode: #5ec2ff;
	--pr-value: #5ec2ff;
	--pr-menu-bg: #323232;
	--pr-menu-border: #545454;
}
[data-pr-contrast='high'] {
	--pr-border-subtle: #3d3d3d;
	--pr-border: #5a5a5a;
	--pr-text-secondary: #b0b0b0;
	--pr-text-tertiary: #8d8d8d;
	--pr-gutter: 4px;
}
```

Tailwind 4 bridge (in `editor-starter.css`, next to the existing `@theme` block):

```css
@theme inline {
	--color-pr-app: var(--pr-bg-app);
	--color-pr-panel: var(--pr-bg-panel);
	--color-pr-panel-alt: var(--pr-bg-panel-alt);
	--color-pr-raised: var(--pr-bg-panel-raised);
	--color-pr-field: var(--pr-bg-field);
	--color-pr-hover: var(--pr-bg-hover);
	--color-pr-border: var(--pr-border);
	--color-pr-border-subtle: var(--pr-border-subtle);
	--color-pr-text: var(--pr-text-primary);
	--color-pr-muted: var(--pr-text-secondary);
	--color-pr-dim: var(--pr-text-tertiary);
	--color-pr-accent: var(--pr-accent);
	--color-pr-accent-fill: var(--pr-accent-fill);
	--color-pr-timecode: var(--pr-timecode);
	--font-pr: var(--pr-font-ui);
}
/* Re-point the starter tokens so existing components re-skin immediately */
@theme {
	--color-editor-starter-bg: var(--pr-bg-panel);
	--color-editor-starter-panel: var(--pr-bg-panel-alt);
	--color-editor-starter-border: var(--pr-bg-app);
	--color-editor-starter-accent: var(--pr-accent);
}
```

Usage: `bg-pr-panel text-pr-text border-pr-border-subtle font-pr`.

---

## 4. Typography and metrics

### 4.1 Fonts

- Premiere uses **Adobe Clean**, which is proprietary and must not be shipped.
- Primary replacement: **Source Sans 3** (SIL OFL). It is Adobe's own open-source humanist sans, has the closest letterforms and width to Adobe Clean, and supports `tnum`.
- Secondary: **Inter** (OFL), if we prefer denser hinting on Windows/Linux at 11–12 px.
- Self-host both as `woff2` in `public/fonts/` with `font-display: swap`. Do not rely on Google Fonts at runtime, because the PWA must work offline.
- Timecodes: the same family with `font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1;` so digits don't jitter while playing. A monospace fallback (`'Source Code Pro', ui-monospace`) is acceptable only for the Info panel.

### 4.2 Type scale

| Role | Size / line-height | Weight | Color |
|---|---|---|---|
| UI body (list rows, EC labels, menus) | 12 / 16 px | 400 | `--pr-text-primary` |
| Small UI (column headers, units, ruler numbers, track labels) | 11 / 14 px | 400 | `--pr-text-secondary` |
| Panel tab title | 12 / 16 px | 400 (active 600 optional) | active `--pr-text-strong`, inactive `--pr-text-secondary` |
| Header bar mode tabs (Import / Edit / Export) | 13 / 18 px | 400 (active underlined) | |
| Header project title (centered) | 12 / 16 px | 400 | `--pr-text-primary` |
| Clip name on timeline | 11 / 13 px | 400 | `--pr-text-strong` on label body |
| Timeline playhead-position timecode | 18 / 22 px | 400 | `--pr-timecode` |
| Monitor current-time timecode | 14 / 18 px | 400 | `--pr-timecode` |
| Monitor duration timecode | 14 / 18 px | 400 | `--pr-text-primary` |
| Effect Controls footer timecode | 12 / 16 px | 400 | `--pr-timecode` |
| Dialog title | 16 / 20 px | 600 | |

### 4.3 Metrics (desktop, 1× density)

| Element | Size | Notes |
|---|---|---|
| Application header bar | **36 px** (measured ≈ 33 pt) | Home, mode tabs, title, right-side actions |
| Frame gutter (space between panel frames) | **3 px** (2 px min) | Color `--pr-bg-app`; also the splitter hit area (expand hit area to 7 px with a transparent overlay) |
| Panel frame corner radius | **4 px** (v25+) | Classic: 0 |
| Panel tab strip height | **28 px** | Tab padding 0 12 px; `≡` glyph 16 px placed right of the active tab title |
| Panel inner padding | 8 px (lists 0) | |
| List / tree row height | **22 px** (Project list, Effects tree, Effect Controls) | Measured about 20–21 pt |
| Icon button | 24×24 px (16 px glyph) | Monitor transport: 28×28, 16 px glyph |
| Tools panel width (vertical) | **40 px**; buttons 28×28, gap 4 | |
| Audio Meters panel (docked beside timeline) | **52 px** wide | |
| Timeline header area (sequence tabs + timecode + toolbar) | 28 (tab) + 48 (timecode + toolbar) px | |
| Timeline ruler | **24 px** + 4 px render bar + 6 px work-area bar (when shown) | |
| Track header width | **176 px** default; min ≈ 140 px (limited by icons); max ≈ 2× min | Premiere docs: "The maximum width is about twice the minimum width" |
| Video track height | minimized 20 px, **default 32 px**, expanded 64–96 px, max ≈ 240 | Resize by dragging the header boundary: video tracks resize the track *above* the divider-line, audio tracks resize the one *below* (they grow away from the V/A center line) |
| Audio track height | minimized 20 px, **default 40 px**, expanded 64–96 px | Waveform visible from about 32 px |
| V/A divider | 4 px band `--pr-bg-app` + draggable | Separates video (upwards) and audio (downwards) stacks; each scrolls independently |
| Clip corner radius | 3 px (v24.4+) | Classic: 0 |
| Clip name strip | 14 px from top of clip body | Name at 11 px, padding 4 px |
| Playhead head | 12×14 px downward-pointing pentagon; line 1 px | |
| Keyframe diamond | 9×9 px | |
| Marker glyph (ruler) | 10×12 px (pentagon/shield) | |
| Monitor bottom bar | timecode row 28 px + mini-ruler 16 px + zoom bar 12 px + transport row 36 px ≈ **92 px** | |
| Min panel size | 120×80 px | |

---

## 5. Application frame, workspaces and docking

### 5.1 Header bar (v22–v26 "modes" header)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⌂  Import  Edit  Export            Project Name – Edited              ⊞  ⇪  ≡•  ⚗  🗨  🔍  ⤢ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Left**
  - Home icon: opens the Home/Start screen of recent projects.
  - **Mode tabs**:
    - `Import` is a full-screen media browser/ingest view;
    - `Edit` is the docking workspace;
    - `Export` is a full-screen export view with presets on the left, preview in the center and settings on the right.
  - The active mode is shown with white text and a 2 px underline.
  - Premiere 27-beta adds a **`Color`** mode tab next to `Edit`, which opens a dedicated Color mode (clip grid + color controls).
  - For JasperEditor, propose `Import | Edit | Motion | Color | Export`. `Motion` is the fframes/Remotion graphics mode; it is optional and can be a workspace instead.
- **Center**: project name plus a dirty-state suffix, e.g. `– Edited`.
- **Right**, as icon buttons with tooltips:
  1. **Workspaces menu** (layout icon), with list items: Editing, Essentials, Assembly, Color, Effects, Audio, Captions and Graphics, Vertical, Learning, custom workspaces…, Reset to Saved Layout, Save as New Workspace, Edit Workspaces. Help docs say the icon sits at the upper-left in 2026 builds and upper-right in v22–v25. **Put it on the right.**
  2. Quick Export.
  3. Background tasks / progress: native ffmpeg jobs, proxies, renders. This maps to `src/editor/action-row/tasks-indicator`.
  4. **Agent** (JasperEditor-specific).
  5. Share / review.
  6. Search / command palette.
  7. Full screen.
- **Classic workspace tab bar** (pre-v22 row of workspace names under the menu bar) is optional. Offer "Show workspace labels" as a preference. When shown, it is a 28 px row of text tabs; the active tab is blue text with an underline.
- **Menu bar**:
  - Electron: native menu (`Menu.setApplicationMenu`) with Premiere's top-level menus `File Edit Clip Sequence Markers Graphics and Titles View Window Help`. On macOS it goes in the system bar.
  - Web/PWA: render a 24 px in-app menubar row *above* the header, or collapse it into a `≡` app menu at the left of the header. Default: collapsed on web, native on Electron.

### 5.2 Panel frames, tabs and panel menus

Anatomy of a **panel group** (frame):

```
┌ tab strip (28px) ───────────────────────────────────────────────┐
│ Source: clip.mp4 ≡ │ Effect Controls │ Audio Clip Mixer │ Metadata » │
├──────────────────────────────────────────────────────────────────┤
│ panel body                                                        │
└──────────────────────────────────────────────────────────────────┘
```

**Tabs**
- Tab label = panel name + optional context: `Source: <clip>`, `Program: <sequence>`, `Project: <name>`, `Audio Track Mixer: <sequence>`.
- The `≡` panel-menu button is drawn only on the **active** tab, right after its title.
- The active tab's text is `--pr-text-strong` with a 2 px `#cecece` underline. Inactive tabs are `--pr-text-secondary`.
- Tabs can be reordered by dragging within the strip.
- **Overflow**: when tabs don't fit, show `»` at the right end. It opens a list of hidden tabs.
- Close: a `×` appears on hover of a tab, or on sequence tabs in the Timeline, which always show `×` at the left. `Ctrl/Cmd+W` closes the focused panel. Note that browsers reserve Ctrl+W; see §16.4.

**Panel menu (`≡`)** holds panel-specific commands plus common frame commands:
- Undock Panel, Undock Other Panels in Group, Close Panel, Close Other Panels in Group;
- Panel Group Settings ▸ (Close Panel Group, Undock Panel Group, Maximize Panel Group, Stacked Panel Group, Solo Panels in Stack, Small Tabs).

Right-click on any empty area opens the context menu.

**Focus**
- Clicking anywhere in a panel focuses it, and the frame gets a 1 px blue outline.
- Keyboard focus moves between panels with `Ctrl+Shift+.` (next) and `Ctrl+Shift+,` (previous). On macOS these are `Ctrl+Shift+.` and `Ctrl+Shift+,`.
- `Shift+1` … `Shift+9` jump to specific panels (§16).

**Maximize**
- `` ` `` (backquote) maximizes/restores the panel group **under the mouse cursor**.
- `` Shift+` `` maximizes/restores the **active (focused)** frame.
- `Ctrl+`` ` toggles full-screen video of the Program Monitor (true full screen, video only).
- A maximized frame fills the whole workspace area below the header, with an instant transition and no animation. The layout tree is untouched, so restore is exact.
- For non-US keyboards, bind by `event.code === 'Backquote'` and let users remap.

**Stacked panel groups** (optional, v13+): the tabs render as a vertical accordion of 24 px headers. Low priority.

### 5.3 Docking / drag-and-drop behavior

Behavior as specified by the Adobe docs:
- **Docking zones** run along the edges of a panel, group or window. Dropping there inserts the panel as a **new group next to** the target, splitting the space. Other groups resize to accommodate it.
- **Grouping zones** are the middle of a panel/group and the tab strip. Dropping there adds the panel as a **tab** in that group.
- The drop zone under the pointer is highlighted while dragging. Use `--pr-accent` at 35% fill with a 2 px `--pr-accent` border. Edge zones show a band about 25% of the target dimension; the center zone shows a full-rect or trapezoid highlight.
- **Ctrl (Win) / Cmd (Mac) while dragging** → undock into a floating window.
  - Web: a floating in-viewport frame with a 28 px title/tab strip, draggable and resizable, z-index above the dock.
  - Electron: a real `BrowserWindow` popout, so it can go on a second monitor.
- **Resize**:
  - hover a gutter between two groups → `col-resize`/`row-resize` cursor; drag resizes every group sharing that divider;
  - hover an **intersection** of three or more groups → 4-way `move` cursor, which resizes both axes.
- Closing a group lets neighbors absorb the space. Closing a floating window closes the panels in it.
- Panels are opened from **Window ▸ \<panel\>**. If already open they are brought to front; otherwise they are added to their workspace-default group.
- Workspaces persist the layout. Custom workspaces are named; **Reset to Saved Layout** (`Alt+Shift+0`) restores the last saved state of the current workspace. Monitor / popout configuration is stored with the workspace.

**Recommended implementation:**
- Use **`dockview` (dockview-react, MIT)**. It supports tab groups with overflow, edge/center drop overlays, floating groups, popout windows, maximize-group and JSON (de)serialization out of the box, and can be themed through its `--dv-*` CSS variables mapped to `--pr-*`.
- Alternative: `flexlayout-react` (MIT).
- Avoid building on `react-resizable-panels` alone: it has no tabs or docking.

Layout model to persist (versioned):

```ts
// src/editor/workspace/types.ts
export type PanelId =
	| 'project' | 'mediaBrowser' | 'libraries' | 'info' | 'markers' | 'history'
	| 'effects' | 'effectControls' | 'properties' | 'graphicsTemplates'
	| 'source' | 'program' | 'timeline' | 'tools' | 'audioMeters'
	| 'audioTrackMixer' | 'audioClipMixer' | 'lumetriScopes' | 'colorControls'
	| 'metadata' | 'captions' | 'transcript' | 'agent' | 'jobs';

export type WorkspaceId =
	| 'editing' | 'essentials' | 'assembly' | 'color' | 'effects'
	| 'audio' | 'captionsGraphics' | 'vertical' | 'motion' | 'agent'
	| `custom:${string}`;

export interface SavedWorkspace {
	id: WorkspaceId;
	name: string;
	version: 1;
	dock: unknown; // dockview SerializedDockview
	maximizedGroupId?: string | null;
	floating?: Array<{panel: PanelId; rect: {x: number; y: number; w: number; h: number}}>;
	timeline?: {trackHeaderWidth: number};
}
```

Persistence:
- Current layouts go to `localStorage` (web) or `app.getPath('userData')/workspaces/*.json` (Electron).
- "Saved" layouts are kept separately so that "Reset to Saved Layout" works.
- Follow the existing `src/editor/state/*-persistance.ts` pattern.

### 5.4 Default workspaces

**Editing** is the default and the most important. Proportions are for a 1920×1080 window; percentages refer to the area below the header.

```
┌──────────────────────────────── header 36px ────────────────────────────────┐
├───────────────────────────────────┬─────────────────────────────────────────┤
│ [Source ≡|Effect Controls|         │ [Program: Seq 01 ≡]                     │
│  Audio Clip Mixer|Metadata »]      │                                         │  top row ≈ 55%
│                                    │                                         │
│   Source Monitor (50% width)       │   Program Monitor (50% width)           │
├──────────────────┬──┬──────────────┴───────────────────────────────────┬────┤
│[Project ≡|Media  │T │ [× Sequence 01 ≡]                                 │ A  │
│ Browser|Libraries│o │ 00:00:12:04                                       │ u  │
│ |Info|Effects|   │o │ ⊞ ∩ ⛓ ◆ 🔧                                       │ d  │  bottom row ≈ 45%
│ Markers|History»]│l │ V3 / V2 / V1 ─────────────────────────────────── │ i  │
│                  │s │ A1 / A2 / A3 ─────────────────────────────────── │ o  │
│   ≈ 27% width    │40│            Timeline ≈ 68% width                   │52px│
└──────────────────┴──┴───────────────────────────────────────────────────┴────┘
```

**Editing (v25+ variant with Properties).** The Properties panel is docked as a full-height right column of about 20–22% width, grouped with Effect Controls / Essential Sound. Measured from Adobe's screenshot:

| Region | Width |
|---|---|
| Left group (Source / Text / Media Browser / Audio Clip Mixer / Captions) | 31% |
| Program | 47% |
| Properties (full height) | 22% |

The bottom row splits as: Project 21%, Tools 3%, Timeline 50%, Meters 4%.

**We should default to this variant.** The right column is also where the **Agent** panel naturally lives, as a tab next to Properties.

Other workspaces (Premiere ships 16; these are the ones worth cloning):

| Workspace | Layout summary |
|---|---|
| **Essentials** (v25, single-monitor) | Program center-top; Project + Properties right; Timeline bottom full width. No Source monitor by default |
| **Assembly** | Large Project panel (icon view) top-left ≈ 50%, Source, Program, Timeline bottom |
| **Color** | Program large; Lumetri Scopes left; Lumetri Color / Color Controls right column; Timeline bottom |
| **Effects** | Effect Controls large left; Program; Effects panel right column; Timeline bottom |
| **Audio** | Audio Track Mixer / Essential Sound; Program; Timeline with taller audio tracks; large meters |
| **Captions and Graphics** | Text (Transcript / Captions / Graphics) left; Program; Properties right; Timeline bottom. This matches the v25 screenshot |
| **Vertical** | Program monitor in 9:16 center; Source and Program share one frame (toggle); Properties right |
| **Motion** (JasperEditor) | Program + Properties + Effect Controls with a large mini-timeline + "Motion Templates" browser (Remotion comps + fframes templates) |
| **Agent** (JasperEditor) | Agent chat/plan panel left 28%; Program; Timeline; Jobs panel |

Workspace switching shortcuts are `Alt+Shift+1…9` (§16).

---

## 6. Home / Import / Export modes (brief)

**Home**
- Left rail: New Project, Open Project.
- Main area: recent projects grid/list with thumbnails and modified dates.
- Uses the same dark tokens.

**Import mode**
- Left: locations tree (local folders via the File System Access API on web, native FS on Electron, cloud).
- Center: large thumbnail grid with hover-scrub.
- Right: import settings. Premiere offers "Copy media", "Create new bin" and "Create new sequence"; we add **Create proxies (ffmpeg)** and **Generate waveforms / thumbnails**.
- Bottom-right: a primary "Import" pill button.

**Export mode**
- Left: destination presets (Media File, YouTube, TikTok, …).
- Center: preview with range selector (Entire sequence, In to Out, Work area, Custom).
- Right: settings sections: File name / location, Preset, Format, Video, Audio, Captions.
- Primary "Export" button bottom-right.
- For us, Format includes the engine choice: native ffmpeg (fast, default), Remotion render, or hybrid.

---

## 7. Project panel

**Header**
- Tab `Project: <name> ≡`.
- Breadcrumb row with the project file name and item count on the right, e.g. "10 items".
- Search field (`--pr-bg-field-deep`, magnifier icon) plus a "Find" (binoculars) button and a "New search bin from query" button.

**Views** (buttons in the bottom bar):
- **List view** (`Ctrl+PgUp`);
- **Icon view** (`Ctrl+PgDn`);
- **Freeform view** (a storyboard canvas);
- `Shift+\` toggles view.

**Bottom bar**, left to right:
- lock/"project is editable" pencil toggle;
- List / Icon / Freeform toggles;
- zoom slider (thumbnail size; `Shift+]` / `Shift+[` step);
- Sort Icons menu (icon view: User Order / List View Sort / Metadata Sort);
- **Automate to Sequence**;
- Find;
- **New Bin** (`Ctrl+B`);
- **New Item** ▸ (Sequence, Adjustment Layer, Color Matte, Black Video, Bars and Tone, Transparent Video, Universal Counting Leader, **Remotion Composition**, **fframes Motion Graphic**);
- Clear (trash).

**List view**
- Rows are 22 px, with alternating `--pr-bg-panel` / `--pr-bg-panel-alt` backgrounds.
- Default columns: **Label** (14 px swatch, 12×12 square with radius 2) · **Name** (media-type icon + name; bins have a disclosure triangle and folder icon) · **Frame Rate** · **Media Start** · **Media End** · **Media Duration** · **Video In/Out** · **Video Duration** · **Video Info** (e.g. `1920 x 1080 (1.0)`) · **Audio Info** · **Video Usage** · **Audio Usage** · **Tape Name** · **Description** · **Comment** · **Log Note** · **Media File Path** · **Status** · **Offline Properties** · **Scene** · **Shot** · **Good**.
- Show only Label / Name / Frame Rate / Media Start / Media End / Media Duration / Video Info / Audio Info by default. Columns are chosen via `≡ ▸ Metadata Display…`.
- Column headers are 22 px, `--pr-text-secondary`, with a sort arrow (↑/↓) on the sorted column. Drag to reorder, drag edges to resize, click to toggle sort.
- The Name column cannot be removed.
- The optional **Preview Area** (`≡ ▸ Preview Area`) shows a thumbnail with metadata above the list.
- Selection:
  - Selected rows are `--pr-bg-selected-row`, or `--pr-accent-fill` when the panel is focused and the row is primary.
  - Rename with Enter.
  - Keyboard behavior follows the Project-panel shortcut table (arrows, Home/End, PgUp/PgDn, Shift-extend, Tab to the next column field).

**Icon view**
- Tiles show the thumbnail (16:9), name below, and duration bottom-right on the thumbnail.
- Badges: usage count "filmstrip" badge; label color strip at the bottom edge of the thumbnail.
- **Hover scrub** (toggle `Shift+H`): moving the mouse across a thumbnail scrubs the clip from media start (left) to media end (right).
- Clicking a thumbnail reveals a mini scrubber: J/K/L shuttle, and `I`/`O` set In/Out (shown as a yellow bar).
- Double-click opens the clip in the Source Monitor at the hovered frame.
- Poster frame: `Shift+P` (Win) / `Cmd+P` (Mac).
- In our case, thumbnails come from ffmpeg-generated sprite sheets (fast, CPU).

**Bins**
- Double-click opens the bin in a new tab or in place, according to a preference. Bins are shown as folders.
- **Search bins** (magnifier folder) are saved queries.
- Drag onto a bin to move items into it.

---

## 8. Source and Program monitors

Both monitors share one component, `MonitorPanel`, with a `mode: 'source' | 'program'` prop.

### 8.1 Layout

```
┌ Source: clip.mov ≡  (tab; ≡ lists recent source clips) ──────────────────┐
│                                                                          │
│                  video (letterboxed on --pr-bg-panel)                    │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ 00:00:00:09  [Fit ▾]          ▣  ∿           [1/2 ▾]  🔧   00:00:05:01   │  28px
│ ├──┬──┬──⯆──┬──┬──┬──{▒▒▒▒▒▒▒▒}──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┤   │  16px mini ruler
│ ○══════════════════════════════════════════════════════════════════○   │  12px zoom bar
│      ◆  {  }  ⇤{  ◁|  ▶  |▷  }⇥   ⎘  ⎗  📷   ⧉                      ＋  │  36px transport
└──────────────────────────────────────────────────────────────────────────┘
```

**Row 1**
- **Current-time display** (left). Blue `--pr-timecode`, 14 px, tabular.
  - Click to type a timecode (Enter commits).
  - Drag horizontally to scrub.
  - `Ctrl/Cmd+click` toggles timecode ↔ frame count.
- **Zoom level** dropdown (`Select Zoom Level`): `Fit`, 10%, 25%, 50%, 75%, 100%, 150%, 200%, 400%.
  - In Source, percentages are relative to the media size; in Program, relative to the sequence frame size.
  - Scrollbars appear when zoomed beyond the viewport.
- Source only, center: **Drag Video Only** (filmstrip icon) and **Drag Audio Only** (waveform icon). These are drag handles that start an edit drag with only that component.
- **Playback resolution** dropdown (`Select Playback Resolution`): `Full`, `1/2`, `1/4`, `1/8`, `1/16`.
  - Premiere has separate **Paused Resolution** in the Settings menu. Scrubbing uses the playback resolution.
  - For us these map to Remotion Player scaling / proxy selection: Full = original media, 1/2 and below = ffmpeg proxy tiers.
- **Settings (wrench)** menu items:
  - Display mode: Composite Video / Alpha / All Scopes / Waveform / Vectorscope;
  - Playback Resolution ▸; Paused Resolution ▸; High Quality Playback; Show Dropped Frame Indicator;
  - **Safe Margins**; Transparency Grid; Time Ruler Numbers (off by default); Show Rulers (`Ctrl+R` in Program); Show Guides (`Ctrl+;`); Snap in Program Monitor (`Ctrl+Shift+;`); Overlays; Overlay Settings ▸;
  - Loop; Show Transport Controls; Show Audio Time Units;
  - Comparison View (Program).
- **Duration display** (right). The In→Out duration, or the whole clip/sequence if no marks are set. White, 14 px.

**Row 2 — mini time ruler**
- Tick marks, with numbers only if "Time Ruler Numbers" is enabled.
- **Playhead**: blue downward head, draggable.
- In/Out marks drawn as `{` `}` brackets, with the range shaded `--pr-inout-range`.
- Markers are drawn on this ruler.
- **In/Out grip**: hovering the middle of the marked range shows a hand cursor. Dragging it moves In and Out together.

**Row 3 — zoom scroll bar**
- A 2 px `--pr-border-strong` track with **round 10 px hollow handles** at each end.
- Drag the handles to zoom the mini ruler (centered on the playhead); drag the middle to pan.
- The mouse wheel over the bar expands/contracts it.
- The monitor zoom bar does *not* affect the Timeline.

**Row 4 — transport button bar** (customizable, up to 2 rows):
- **Source default buttons**: Add Marker (M) · Mark In (I) · Mark Out (O) · Go to In (Shift+I) · Step Back 1 Frame (←) · Play-Stop Toggle (Space) · Step Forward 1 Frame (→) · Go to Out (Shift+O) · **Insert (,)** · **Overwrite (.)** · Export Frame (camera) · [Toggle Proxies / Settings]. Then `＋` (Button Editor) at the far right.
- **Program default buttons**: Add Marker · Mark In · Mark Out · Go to In · Step Back · Play-Stop · Step Forward · Go to Out · **Lift (;)** · **Extract (')** · Export Frame · Comparison View · [Toggle Proxies]. Then `＋`.
- Buttons are 28×28 with 16 px glyphs in `--pr-icon`. Play turns into Stop (■) while playing.
- **Button Editor** (`＋`) opens a popover grid of all available buttons. Drag a button into the bar to add it; drag it out to remove it. Also available: "Reset Layout", Cancel, and OK (blue pill).
- Available buttons:
  - Clear In, Clear Out, Go to Previous/Next Edit, Go to Previous/Next Marker, Play In to Out, Loop, Play Around;
  - Safe Margins, Export Frame, Record (red dot), Multi-Camera, Global FX Mute (`fx`), Show Rulers, Show Guides, Comparison View, VR Video;
  - Toggle Proxies, Toggle Multi-Camera View, Trim;
  - Match Frame, Reverse Match Frame, Insert, Overwrite, Lift, Extract;
  - a spacer, used to group buttons.
- Model it as `MonitorButtonLayout = {rows: ButtonId[][]}` persisted per monitor per workspace.

### 8.2 Behaviors to replicate

**Source Monitor**
- Double-click a clip in Project or Timeline to open it.
- The tab's `≡` lists recently opened clips; "Close" and "Close All" are also there.
- Mark In/Out, then:
  - Insert (`,`) or Overwrite (`.`) into the Timeline at the playhead on the **source-patched** tracks; or
  - drag from the video onto the Timeline. **Ctrl/Cmd-drag = insert**; plain drag = overwrite.
  - Dragging onto the Program Monitor shows a drop overlay with zones: Insert, Overwrite, Overlay, Replace, Place On Top, Append At End.

**Program Monitor**
- Shows the active sequence (bound to the active Timeline tab).
- In/Out here are *sequence* In/Out; they are the same marks as on the Timeline ruler.
- Lift (`;`) removes In→Out on targeted tracks and leaves a gap. Extract (`'`) removes it and ripples.
- Direct manipulation: selecting a clip or graphic layer shows transform handles in the Program Monitor. The Remotion Editor Starter already has canvas selection/transform in `src/editor/selection-border/*`; restyle the handles as white squares with a blue outline.

**Safe margins** (reference only, never exported)
- Draw two centered rectangles: **action safe** inset 5% per side (90%×90%) and **title safe** inset 10% per side (80%×80%). Adobe describes these as "10% and 20%" total.
- Add a small center cross.
- Stroke: 1 px `rgba(255,255,255,.55)`.
- Make them configurable in Sequence/Project settings.

**Other**
- **Dropped-frame indicator**: a small green/yellow dot at the top-left of the video when enabled.
- **Comparison view**: side-by-side / vertical split / horizontal split, reference frame versus current frame.
- **Gang Source and Program**: optional.

---

## 9. Timeline panel

### 9.1 Anatomy

```
┌ × Sequence 01 ≡ │ × Sequence 02 ≡ ────────────────────────────────────────────────────┐ tabs 28px
│ 00:00:04:20                    :00:00        00:00:15:00        00:00:30:00         │ ruler 24px
│ ⧉ ∩ ⛓ ◆ 🔧 CC                  ▕▔▔▔▔▔▔ work area bar (optional) ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │
│                                ▔▔▔▔▔ render bar (yellow/red/green) ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │
├────────────────────────────────┬────────────────────────────────────────────────┬──┤
│ V1│🔒│V3│⧈│👁                │           [clip]                                │ ○│ video tracks
│   │🔒│V2│⧈│👁                │        [clip]      [clip fx]                    │ ║│ (scroll up)
│[V1]│🔒│V1│⧈│👁               │ [clip═══════════════][clip]                     │ ○│
├════════════════════════════════╪════════════════════════════════════════════════╪══┤ V/A divider
│[A1]│🔒│A1│⧈│M│S│🎙           │ [≈≈≈ waveform ≈≈≈≈≈≈≈≈]                         │ ○│ audio tracks
│   │🔒│A2│⧈│M│S│🎙            │                                                 │ ║│ (scroll down)
│    │🔒 Master          0.0  ⧓ │                                                 │ ○│
├────────────────────────────────┴────────────────────────────────────────────────┴──┤
│                              ○════════════ zoom scroll bar ════════○               │ 14px
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Timeline header

**Sequence tabs**
- One Timeline panel can hold several sequences as tabs: `× Name ≡`.
- The v25+ sequence tab shows a small **label-color swatch** (the "Label colors in sequence tabs" feature).
- Double-clicking a sequence in Project opens it in a new tab. Dragging a tab out creates a second Timeline panel.

**Playhead Position timecode**
- 18 px, `--pr-timecode`, at the top-left.
- Click to type (timecode shorthand: `+15` moves 15 frames forward; `1.` = 1 second, and so on).
- Drag to scrub. `Ctrl/Cmd+click` toggles frames/timecode.

**Toolbar row**, 16 px icons, toggles blue when on:
1. **Insert and overwrite sequences as nests or individual clips.** Default: nest.
2. **Snap in Timeline** (magnet; `S`). Default ON. The starter's snapping toggle lives in `src/editor/action-row/snapping-toggle.tsx`.
3. **Linked Selection** (chain/select icon). Default ON: clicking video also selects its linked audio. Alt-click temporarily ignores links.
4. **Add Marker** (`M`).
5. **Timeline Display Settings** (wrench). Its menu:
   - Show Video Thumbnails;
   - Show Video Keyframes;
   - Show Video Names;
   - Show Audio Waveform;
   - Show Audio Keyframes;
   - Show Audio Names;
   - Rectified Audio Waveforms;
   - Show Duplicate Frame Markers;
   - Show Through Edits;
   - Show Clip Markers;
   - Show fx Badges;
   - Show Source Clip Effects;
   - Show Proxies badge;
   - Show Label Colors (v25);
   - Minimize All Tracks;
   - Expand All Tracks;
   - Composite Preview During Trim;
   - Customize Video Header…;
   - Customize Audio Header…;
   - Presets (Save/Manage).
6. **Captions track options** (CC).

The sequence `≡` menu contains: Work Area Bar, Time Ruler Numbers, Audio Units, Show Audio Time Units, Close, Close Other Timelines, Panel Group Settings.

### 9.3 Track headers

Track headers are 176 px wide by default and are separated from the clip area by a 1 px `--pr-border` line. Customizable with **Customize Video/Audio Header…**, which opens a Button Editor for the header.

**Video track header columns** (left → right):

| Column | Width | Control | Visual / behavior |
|---|---|---|---|
| Source patch | 24 px | Source patch indicator `V1` | Visible only when a clip is loaded in Source. Blue filled pill (`--pr-target-fill`) = patched. Drag it to another track to re-patch. Click to toggle. Determines where Insert/Overwrite puts media |
| Lock | 20 px | **Toggle Track Lock** (padlock) | Locked = closed padlock in blue + diagonal hatch over the whole track row. A locked track is no longer targeted. Shift-click = all tracks of this type |
| Target | 26 px | **Track Targeting** `V1`, `V2`… | Blue filled rounded pill when targeted; gray outline text otherwise. Targeted tracks receive paste (lowest targeted), navigation (Up/Down edit points), Match Frame (highest targeted), Add Edit, Lift/Extract. Click to toggle |
| Sync lock | 20 px | **Toggle Sync Lock** (film strip with sync arrows icon) | On = visible icon (the default is ON for all tracks); off = empty box. Controls which non-edited tracks shift during insert / ripple delete / ripple trim. Shift-click = all of the type |
| Output | 20 px | **Toggle Track Output** (eye) | Off = eye with slash; track is excluded from Program/export (renders black). Shift-click = all video tracks |
| Name | flex | Track name | Shown when expanded ("Video 1"). Double-click to rename |
| Expanded extras | | Keyframe navigator `◁ ◇ ▷`, Show Keyframes dropdown (Opacity / Motion / effect), Track Volume | Only visible when track height ≥ 48 px |

**Audio track header columns:**

| Column | Control | Notes |
|---|---|---|
| Source patch `A1` | as video | |
| Lock | as video | |
| Target `A1` | as video | |
| Sync lock | as video | |
| **M** | Mute Track | On = green-highlighted "M" (Premiere uses a green fill `#1c8a3a` with white text). Shift-click = all audio |
| **S** | Solo Track | On = yellow fill `#d8b400` with dark text |
| **🎙** | Voice-over Record | Hold to arm/record into the track from the mic. For us this is the `MediaRecorder` API. Right-click opens Voice-Over Record Settings |
| Name | "Audio 1" | when expanded |
| Expanded extras | Keyframe nav `◁ ◇ ▷`, **Track Volume** (dB, blue scrubby), pan knob (optional) | |

**Master (mix) track** sits at the bottom of the audio stack:
- padlock, label "Master", blue volume value (`0.0` dB), and a **Go to Master/Mix** button;
- no target and no patching.

**Visual states**
- Header background: `--pr-bg-panel`.
- Hover row: `--pr-bg-hover`.
- Targeted tracks: header background slightly lighter (`#232323`) in addition to the blue pill.
- A 1 px divider line between tracks: `--pr-border-subtle`.

**Track height behavior**
- Drag the boundary between headers (row-resize cursor). Video tracks grow upward (from the V/A divider outward) and audio tracks grow downward.
- **Alt/Opt + mouse wheel** over a header zooms that track's height. **Shift + wheel** over the header area zooms all tracks of that type.
- `Ctrl+=` / `Ctrl+-` increase/decrease video tracks; `Alt+=` / `Alt+-` do audio tracks (macOS: Cmd for video, Opt for audio).
- Shift+`=` expands all tracks; Shift+`-` minimizes all tracks.
- Double-click empty header space toggles expanded/collapsed.

**Track header width**: drag the right edge of the header column. The minimum is limited by icons; the maximum is about 2× the minimum.

**Add/remove tracks**: right-click a header → Add Track, Add Tracks…, Delete Track, Delete Tracks…, Rename. Dropping a clip above the top video track or below the bottom audio track auto-creates a track.

### 9.4 Ruler, work area, In/Out, render bar, markers

**Time ruler**
- 24 px tall.
- Major labels are timecode at an adaptive interval (≥ 80 px between labels), in 11 px `--pr-text-secondary`. Minor ticks are 4 px; major ticks are 8 px.
- Clicking or dragging the ruler moves the playhead; Shift-drag snaps the playhead to edits/markers.
- Premiere shows the frame-rate tick density at high zoom.

**Sequence In/Out**
- Brackets on the ruler.
- The range is shaded on the ruler and **across all tracks**, using a lighter overlay on the track area: `rgba(255,255,255,.06)` on tracks and `.10` on the ruler.

**Work Area Bar** (off by default)
- A 6 px bar under the ruler in `--pr-workarea`, with draggable ends.
- `Alt+[` / `Alt+]` set its In/Out (macOS: `Opt+[` / `Opt+]`).

**Render bar**
- A 4 px strip directly under the ruler:
  - **red** = needs render;
  - **yellow** = unrendered but should play real-time;
  - **green** = rendered preview available.
- For JasperEditor:
  - green = a cached frame/proxy render exists (native ffmpeg or Remotion prerender);
  - yellow = the Remotion live preview can handle it;
  - red = heavy (fframes/Remotion comp or effect stack) not yet cached.
- `Enter` = Render Effects In to Out.

**Sequence markers**
- Pentagon glyphs on the ruler in the marker color.
- Duration markers show a bar extending to their out time.
- Double-click opens the marker dialog: Name, Duration, Comments, Color, Marker type (Comment / Chapter / Segmentation / Web Link).
- Clip markers are drawn inside the clip body, in the clip's top area.
- **Markers panel** (Window ▸ Markers): list with color filter chips and search.

### 9.5 Playhead

- **Blue** (`--pr-playhead`).
- Head: a 12 px wide downward-pointing pentagon/shield sitting in the ruler.
- Line: 1 px through all tracks, drawn above clips and below drag overlays.
- Drag the head to scrub. Audio scrubbing is on by default; `Shift+S` toggles scrubbing audio.
- Auto-scroll during playback (Timeline preference): **Page Scroll** (default) or **Smooth Scroll** (playhead stays centered) or No Scroll. The starter's `timeline-scroll-while-playing.tsx` implements follow; add the modes.
- The playhead snaps when Snap is on and the preference "Snap playhead in Timeline when Snap is enabled" is set.
- Restyle `src/editor/timeline/playhead.tsx` (currently `PLAYHEAD_WIDTH = 19`, `PLAYHEAD_SVG_WIDTH = 54`) to a 12 px head.

### 9.6 Clips on the timeline (v24.4+ design)

**Body**
- Filled with the clip's label color (dark saturated set, §3.4); radius 3 px.
- A 1 px darker inner border: the label at −20% lightness.

**Name strip**
- The top 14 px holds the clip name in white 11 px, left-aligned with 4 px padding, truncated with ellipsis.
- Video suffix `[V]` and audio suffix `[A]` appear when the clip is linked; Premiere writes `name.mp4 [V]`.

**Content**
- Video thumbnails, when enabled and track height ≥ 40 px. Styles: Head / Head and Tail / Continuous (filmstrip), drawn below the name strip at 70% opacity.
- Audio waveforms in the label's light tint (for example `#5fc2fe` on Iris). Choose rectified (bottom-up) or non-rectified (centered) per the display setting. Stereo shows two lanes labelled L/R.

**Badges** (right side of the name strip):
- **fx badge** (the "fx" glyph in a 12 px square):
  - light gray = no effects;
  - yellow = intrinsic properties (Motion/Opacity/Time Remap) modified;
  - violet = non-intrinsic effect applied;
  - green = both.
  - An underline under the badge means source-clip (master) effects.
- Proxy badge.
- Speed badge (percentage shown in the name when speed ≠ 100%).
- Link-break/out-of-sync badge: a red box with a ±frames offset, e.g. `-12`, shown when linked A/V drifts.
- **JasperEditor**: an engine badge `R` (Remotion comp) or `F` (fframes), 10 px, `--pr-text-strong` at 70%.

**States**
- **Selected**: 2 px white outline (`rgba(255,255,255,.9)`) and body lightened by about 12%.
- Hover: body lightened 6%.
- Disabled (`Shift+E`): body at 35% opacity and the name dimmed.
- Offline: red body with "Media Offline".
- Locked track: hatch overlay.

**Other clip features**
- **Keyframes/rubber band** (when "Show Keyframes" is on and the track is expanded): a 1 px yellow-white line across the clip for Opacity/Volume, with diamond keyframes. Drag the line vertically to change the value (the Pen tool or the Selection tool both work).
- **Transitions**: a darker rectangle straddling or aligned to the cut, with a diagonal line glyph and the name on hover. The default transition is applied with `Ctrl+D` (video) / `Ctrl+Shift+D` (audio).
- **Through edits** (a cut with no content change): small white triangles facing each other at the edit.
- **Duplicate frame markers**: a colored stripe at the bottom of clips that repeat source frames.
- **Gaps**: clicking an empty gap selects it (light gray fill). `Delete` / `Shift+Delete` ripple-deletes the gap.

### 9.7 Scrolling and zoom

- Bottom **zoom scroll bar**: a 14 px row with round hollow handles at both ends. Drag the handles to zoom (centered on the playhead) and drag the middle to pan. The mouse wheel over it zooms.
- Right edge: separate **vertical zoom scroll bars** for the video stack (top) and audio stack (bottom), each with round handles. Dragging a handle scales the height of all tracks in that stack.
- Keys:
  - `=` zoom in and `-` zoom out (panel-scoped; on the numpad `+`/`-` too);
  - `\` toggles zoom-to-sequence (fit all) and the previous zoom;
  - Page Up/Down scroll one screen.
- Mouse wheel:
  - Windows: horizontal scroll by default; Ctrl+wheel = vertical.
  - macOS: vertical by default.
  - Alt+wheel = zoom horizontally.
- Trackpad pinch = zoom.
- The existing `timeline-zoom-slider.tsx` and `use-timeline-zoom.ts` need a "zoom around playhead" behavior plus this visual.

### 9.8 Snapping and linked selection

- With Snap on, dragged clip edges, the playhead, markers and In/Out snap within about 8 px (the starter's `DEFAULT_TIMELINE_SNAPPING_THRESHOLD_PIXELS = 5`).
- A **snap indicator** appears: a vertical line through all tracks with small triangles top and bottom.
- Snap is toggled with `S`; the starter already has `keyboard-shortcuts/snapping-shortcut.tsx`.
- Linked selection is described in §9.2. `Ctrl+L` links/unlinks; Alt-click selects only one side.

### 9.9 Editing gestures (Selection tool)

- **Drag** a clip: overwrite move. **Ctrl/Cmd-drag**: insert move, with a yellow arrow indicator of the rippled content. **Alt/Opt-drag**: duplicate. **Ctrl+Alt-drag**: swap clips (rearrange).
- **Trim edges**: the cursor becomes the red bracket `[`/`]` (regular trim). Ctrl-click an edge for ripple trim (yellow cursor).
- A tooltip during trim shows the delta (`+00:00:00:12`) and the new duration.
- During a trim, the Program Monitor shows a **two-up display**: the outgoing frame on the left and the incoming frame on the right.
- `E` extends the selected edit to the playhead. `Q` / `W` ripple trim the previous / next edit to the playhead.
- Keyboard nudge: `Alt+←/→` 1 frame, `Alt+Shift+←/→` 5 frames (macOS: `Cmd` instead of `Alt`).

---

## 10. Tools panel

This is a vertical 40 px strip docked between Project and Timeline. It can also be oriented horizontally.
- The current tool is shown as a filled `--pr-accent-fill` rounded square (28×28, radius 4) with a white glyph.
- **Grouped tools** have a tiny triangle at the bottom-right. Long-press or right-click shows a flyout of the group.
- The tooltip shows the name and shortcut.
- Premiere's v25/26 group layout is as follows.

| # | Group (flyout members) | Shortcut | Cursor over timeline | Behavior |
|---|---|---|---|---|
| 1 | **Selection** | `V` | arrow; red `[` `]` trim cursors at edges | default; select, move, trim |
| 2 | **Track Select Forward** / Track Select Backward | `A` / `Shift+A` | double arrow → | selects the clicked clip and everything to its right (backward: left) on that track; Shift = all tracks |
| 3 | **Ripple Edit** / **Rolling Edit** / **Rate Stretch** / Remix | `B` / `N` / `R` / — | yellow ripple bracket / red rolling `][` / stretch | Ripple trims and closes gaps; Rolling moves an edit point between two clips; Rate Stretch changes speed by dragging an edge |
| 4 | **Razor** | `C` | razor blade | click splits a clip at that frame (snaps to playhead); Shift-click = all tracks. The starter's `split-item-tool.tsx` is the equivalent |
| 5 | **Slip** / **Slide** | `Y` / `U` | `|↔|` / `↔||↔` | Slip changes source In/Out keeping position and duration (4-up monitor view); Slide moves a clip between its neighbors, trimming them |
| 6 | **Pen** / Rectangle / Ellipse (Shape) | `P` | pen nib | Pen adds keyframes on rubber bands (Ctrl-click), draws masks/shapes in Program |
| 7 | **Hand** / **Zoom** | `H` / `Z` | open hand / magnifier (+, Alt = −) | Hand pans the timeline; Zoom click-zooms in, Alt-click out, drag-marquee zoom |
| 8 | **Type** / Vertical Type | `T` | I-beam | click in the Program Monitor to create a text graphic (Remotion text item in the starter: `EditModeContext 'create-text'`) |
| 9 | Generative Extend (Premiere) → **Agent tool** (JasperEditor) | — | sparkle | Drag a clip edge to ask the agent to extend/fill. Optional |

- Holding a tool key (for example keeping `C` pressed) should switch **temporarily** (spring-loaded) and revert on key-up. Premiere doesn't do this by default; it is optional and off by default.
- Model: `type ToolId = 'selection'|'trackSelectForward'|'trackSelectBackward'|'ripple'|'rolling'|'rateStretch'|'razor'|'slip'|'slide'|'pen'|'rectangle'|'ellipse'|'hand'|'zoom'|'type'|'verticalType'|'agent'`. This extends `EditModeContext` in `src/editor/edit-mode.tsx`, whose current values are `select | draw-solid | create-text`.

---

## 11. Effect Controls panel

Two-pane panel: the property list on the left (about 55%) and the **mini-timeline** on the right (about 45%), with a draggable divider. The right pane is toggled by **Show/Hide Timeline View** (a small `▸|` icon at the top-right).

```
┌ Effect Controls ≡ │ Lumetri Scopes │ Audio Clip Mixer ─────────────────────────────┐
│ [Source · clip.mp4]  [Seq 01 · clip.mp4]                         ◧ │ ▸ :00:00  00:00:05:00 │
├───────────────────────────────────────────────────────────────────┼───────────────────────┤
│ Video                                                             │ ▭ clip.mp4 ▭▭▭▭▭▭▭▭▭ │
│ ▾ fx Motion                                                  ⟲    │                       │
│     ⏱ Position           960.0   540.0                ◀ ◆ ▶ ⟲   │   ◆           ◆       │
│     ⏱ Scale              100.0                        ◀ ◆ ▶ ⟲   │                       │
│     ⏱ Scale Width        100.0                                    │                       │
│         ☑ Uniform Scale                                           │                       │
│     ⏱ Rotation           0.0°                                     │                       │
│     ⏱ Anchor Point       960.0   540.0                            │                       │
│     ⏱ Anti-flicker Filter 0.00                                    │                       │
│ ▾ fx Opacity                                                 ⟲    │                       │
│     ◯ ▭ ✎  (mask tools)                                           │                       │
│     ⏱ Opacity            100.0 %                                  │                       │
│        Blend Mode        [Normal ▾]                               │                       │
│ ▸ fx Time Remapping                                               │                       │
│ Audio                                                        ▴    │                       │
│ ▸ fx Volume                                                  ⟲    │                       │
│ ▸ fx Channel Volume                                          ⟲    │                       │
│ ▸ fx Panner                                                       │                       │
├───────────────────────────────────────────────────────────────────┴───────────────────────┤
│ 00:00:18:13                                                     ⏷(filter)  ▶♪  ⟳▭        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Header**
- Two chips: **`Source · <clip>`** (master clip effects) and **`<Sequence> · <clip>`** (the timeline instance). The active chip has a darker fill.

**Sections**
- `Video` and `Audio` group headers are 22 px rows with bold 12 px text and a collapse caret on the right.
- **Intrinsic effects** always exist: Motion, Opacity, Time Remapping, Volume, Channel Volume, Panner.
- Applied effects are appended below, in stacking order. Drag to reorder.

**Effect row**
- Twirl `▸/▾` · **fx toggle** (click to bypass; the icon gets a slash) · effect name · (right) reset `⟲`.
- For effects with masks: mask tool icons (ellipse, rectangle, pen) and a mask list.

**Property row** (22 px):
- twirl (for properties with graphs);
- **stopwatch ⏱ "Toggle Animation"**. Off = outline gray. Clicking turns animation ON: the stopwatch turns **blue** and a keyframe is created at the playhead. Turning it off asks to delete all keyframes.
- property name;
- value(s) in **blue scrubby numbers**; units in gray;
- **keyframe navigator** `◀ ◆ ▶`, visible when animated. It shows go-to-previous, add/remove keyframe at the playhead (the diamond fills when the playhead is on a keyframe), and go-to-next.
- reset `⟲`.
- Expanding a property's twirl shows **Value** and **Velocity** graphs with Bezier handles in the mini-timeline.

**Mini-timeline**
- Its own ruler.
- The clip range bar (clip name in a gray bar), shown when **Pin to Clip** is on (default). Otherwise it shows the sequence around the clip.
- Playhead: blue, synced.
- Keyframes are diamonds on each property row. Collapsed effects show **summary keyframes** (reference only).
- Interpolation shapes (right-click keyframe ▸ Temporal Interpolation):
  - Linear = diamond;
  - Bezier / Auto Bezier / Continuous Bezier = hourglass/circle shapes;
  - Hold = square-ish;
  - Ease In / Ease Out.
- Marquee-select keyframes, drag to move, Alt-drag to copy.

**Footer**
- Current time (blue).
- **Filter properties** (funnel): show only animated, or only modified.
- **Play only the audio for this clip**.
- **Toggle looping audio playback**.

**Keys**
- `Delete`/`Backspace` removes the selected effect.
- `Ctrl+L` loops audio.

**Implementation notes**
- The starter's `src/editor/inspector/controls/*` provides the value controls (position, rotation, opacity, crop…). Wrap them with the stopwatch/keyframe-nav UI and a keyframe model:
  ```ts
  type Keyframe = {t: number; v: number | [number, number]; interp: 'linear'|'bezier'|'autoBezier'|'continuousBezier'|'hold'; easeIn?: [number, number]; easeOut?: [number, number]};
  ```
- Remotion compositions evaluate keyframes with `interpolate()` / `Easing.bezier` per frame.
- For native/ffmpeg exports, keyframes compile to expressions or segment-wise filters (this belongs to the native-engine topic).

---

## 12. Effects panel

- Search field at the top. Three filter toggles to its right, shown as small badges:
  - **Accelerated** (GPU) → we relabel it "Real-time" (preview-capable);
  - **32-bit color**;
  - **YUV** → relabel "Native (ffmpeg)", meaning the effect can be rendered by the native engine.
- A tree of bins: `Presets`, `Lumetri Presets`, `Audio Effects`, `Audio Transitions`, `Video Effects` (grouped by category: Adjust, Blur & Sharpen, Color Correction, Distort, Generate, Keying, Stylize, Time, Transform, Transition, Utility…), `Video Transitions` (Dissolve, Iris, Page Peel, Slide, Wipe, Zoom…).
- JasperEditor adds: `Motion Graphics ▸ Remotion` and `Motion Graphics ▸ fframes`. These are template items that drop onto the timeline as clips.
- Rows are 22 px with an effect icon (a small preset/effect glyph) and 12 px text. Folders use disclosure triangles.
- Drag an effect onto a clip, or select clips and double-click the effect. Drag a transition onto an edit point.
- Right-click a transition ▸ **Set Selected as Default Transition**. The default transition is marked with a blue outline.
- Keys: `Ctrl+/` creates a new custom bin; `Delete` removes a custom item.

---

## 13. Properties panel (v25+) and Essential Graphics

The **Properties** panel is the modern, context-sensitive inspector. It replaced most of the Essential Graphics "Edit" tab in v25. **It is the natural home for the starter's `src/editor/inspector/*`.**
- **Nothing selected** → sequence properties: frame size, fps, and the Remotion "composition" inspector (`composition-inspector.tsx`).
- **Video clip** → sections Transform (Position, Scale, Rotation, Opacity, Anchor), Crop, Speed & Duration, Blend Mode, Quick actions (Auto Reframe, Scene Edit Detection → for us "Agent: auto-reframe / detect cuts").
- **Audio clip** → Volume (clip gain slider), Pan, Enhance Speech, Auto Duck. Quick action: **Essential Sound tags** (Dialogue / Music / SFX / Ambience).
- **Text / graphic** → a header row with the graphic name and a **layer list** (eye toggle + T icon per layer; drag to reorder). Sections:
  - Text: font family, style, size slider, alignment buttons, tracking/kerning/leading/baseline/tsume, faux bold/italic/all-caps/small-caps/super/sub;
  - Appearance: Fill color + eyedropper, Stroke(s) with width/position, Background, Shadow(s), Mask with Text;
  - Align and Transform;
  - Linked style / Track style;
  - Responsive Design — Position (Pin To) and — Time (intro/outro protection).
- **Multiple selection** → shared properties. Differing values show `–` and adjust relatively.

Styling:
- Sections are collapsible 28 px headers (`▾ Text`) with a right-aligned wrench/`+` icon, and 12 px padding.
- Fields use `--pr-bg-field`.
- Color swatches are 24×16 with a 1 px `--pr-border-strong` border.

**Graphics Templates** panel (formerly the Essential Graphics "Browse" tab):
- a grid of `.mogrt`-like templates with hover preview;
- for us this is the Remotion comp + fframes template gallery with categories and search, dragged onto the timeline.

---

## 14. Color: Lumetri Color panel, Lumetri Scopes, and (v27) Color mode

- The classic **Lumetri Color** panel (docked right in the Color workspace) has collapsible sections, each with an on/off checkbox:
  1. **Basic Correction**
     - Input LUT;
     - White Balance: WB Selector eyedropper, Temperature, Tint;
     - Tone: Exposure, Contrast, Highlights, Shadows, Whites, Blacks;
     - Saturation;
     - Auto / Reset.
  2. **Creative**: Look (LUT) with preview thumbnail + arrows, Intensity, Faded Film, Sharpen, Vibrance, Saturation, Shadow Tint / Highlight Tint wheels, Tint Balance.
  3. **Curves**: RGB curves (white/R/G/B tabs), Hue Saturation Curves (Hue vs Sat, Hue vs Hue, Hue vs Luma, Luma vs Sat, Sat vs Sat).
  4. **Color Wheels & Match**: Comparison View, Apply Match, three wheels (Shadows / Midtones / Highlights) each with a luminance slider.
  5. **HSL Secondary**: key (H/S/L ranges), refine (denoise, blur), correction wheel.
  6. **Vignette**: Amount, Midpoint, Roundness, Feather.
- Sliders are centered (bipolar) with a double-click reset. Sections use a 28 px header with a checkbox + twirl.
- **Premiere 27 retires the Lumetri Color panel.** Lumetri becomes an effect edited in Properties, and a new **Color mode** has:
  - a **Clip Grid**;
  - a **Color Controls** panel with an operations row ("Adjust 1", "Style" nodes at Clip / Group / Sequence levels), latching 2D controls with HUD overlays in the monitor, and a wrench menu for layout (wrapping/centered).
  - Treat this as the *future direction*. Ship a Lumetri-style panel first because it maps directly to ffmpeg filters (`eq`, `curves`, `colorbalance`, `lut3d`, `vignette`) and WebGL preview shaders.
- **Lumetri Scopes**: Waveform (RGB / Luma / YC / YC no chroma), RGB Parade, Vectorscope YUV / HLS, Histogram. Background black, graticule `rgba(255,255,255,.25)`, traces in green/white. Compute on a downscaled frame in a Web Worker / OffscreenCanvas.

---

## 15. Audio: Audio Track Mixer, Audio Clip Mixer, Audio Meters

### 15.1 Audio Meters panel (docked right of Timeline, 52 px)

- A vertical stereo pair of bars, each 8 px wide with a 2 px gap, drawn on a `--pr-bg-field-deep` well.
- dB scale on the right: `0, -6, -12, -18, -24, -30, -36, -42, -48, -54, dB`.
- Gradient: green up to −12 → yellow up to −3 → red above. A 1 px peak-hold line holds for about 1.5 s; the clip indicator sits at the top.
- `S` (solo) buttons under each channel.
- Right-click menu: Dynamic Peaks / Static Peaks, Show Valleys, Show Color Gradient, meter range (−60, −96, −120 dB), Mono / Stereo / 5.1.

### 15.2 Audio Track Mixer

**Channel strip**, one per timeline audio track plus **Mix** (master). Strip width is about 124 px. Top to bottom:
1. **Effects / sends** area (collapsible via the `▸` at the top-left): 5 effect slots + 5 send slots, gray insert boxes with dropdown arrows.
2. **Input / output routing** dropdown ("Mix").
3. **Pan knob**: a 36 px circle outline with a white indicator line, L/R labels, and a blue value `0.0` below.
4. **Automation mode** dropdown: `Off | Read | Latch | Touch | Write`.
5. **M S R** buttons: mute (green on), solo (yellow on), record-arm (red on).
6. **Fader + meter**:
   - a fader cap (white rounded rectangle with a line) on a vertical track;
   - left dB scale `15, 5, 0, -4, -7, -13, -19, -∞`;
   - a stereo meter to the right with scale `0 -12 -24 -36 -48 dB`.
7. **Readouts**: fader gain (blue scrubby, e.g. `0.0`) and peak level (e.g. `-15.1`).
8. **Track label**: `A1 Audio 1` (editable name).

**Footer**: the timeline's current time (blue, left), transport (Go to In, Go to Out, Play/Stop, Play In to Out, Loop, Record ●), and duration (right).

Keys: `Ctrl+Alt+T` shows/hides tracks; `Ctrl+L` loops.

**Audio Clip Mixer**: the same fader/pan UI per *clip at the playhead* on each track. It has no effects/sends, and a keyframe-write toggle per strip.

**Essential Sound**
- A panel with Auto Tag and type buttons: Dialogue, Music, SFX, Ambience.
- The "Edit" tab shows presets and per-type controls: Loudness (Auto Match), Repair (Reduce Noise, Reduce Rumble, DeHum, DeEss, Reduce Reverb), Enhance Speech, Clarity, Ducking, Clip Volume.
- For us it maps to ffmpeg `loudnorm`, `afftdn`, `highpass`, `deesser`, `sidechaincompress`.

---

## 16. Keyboard shortcut map (default "Premiere" keymap)

Sources:
- the official Adobe Premiere default-shortcuts page (updated Jan 7 2026), for the menu and panel tables;
- long-standing defaults not listed on that page (tools, JKL, trimming, navigation), cross-checked with Adobe's Tools-panel doc and third-party cheat sheets.

Rows marked `(verify)` are uncertain across versions.

### 16.1 Global / application

| Command | Windows | macOS |
|---|---|---|
| New Project | Ctrl+Alt+N | Opt+Cmd+N |
| New Sequence | Ctrl+N | Cmd+N |
| Open Project | Ctrl+O | Cmd+O |
| Close (panel) | Ctrl+W | Cmd+W |
| Close Project | Ctrl+Shift+W | Shift+Cmd+W |
| Save | Ctrl+S | Cmd+S |
| Save As | Ctrl+Shift+S | Shift+Cmd+S |
| Save a Copy | Ctrl+Alt+S | Opt+Cmd+S |
| Import | Ctrl+I | Cmd+I |
| Import from Media Browser | Ctrl+Alt+I | Opt+Cmd+I |
| Export Media | Ctrl+M | Cmd+M |
| Send to Media Encoder (→ our background render queue) | Alt+Shift+M | Opt+Shift+M |
| Get Media File Properties | Ctrl+Shift+H | Shift+Cmd+H |
| Exit | Ctrl+Q | Cmd+Q |
| Keyboard Shortcuts dialog | Ctrl+Alt+K | Opt+Cmd+K |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z | Cmd+Z / Shift+Cmd+Z |
| Cut / Copy / Paste | Ctrl+X / C / V | Cmd+X / C / V |
| Paste Insert | Ctrl+Shift+V | Shift+Cmd+V |
| Paste Attributes | Ctrl+Alt+V | Opt+Cmd+V |
| Clear (delete) | Delete | Forward Delete |
| Ripple Delete | Shift+Delete (Timeline: Alt+Backspace) | Shift+Fwd Delete (Timeline: Opt+Delete) |
| Duplicate | Ctrl+Shift+/ | Shift+Cmd+/ |
| Select All / Deselect All | Ctrl+A / Ctrl+Shift+A | Cmd+A / Shift+Cmd+A |
| Find | Ctrl+F | Cmd+F |
| Edit Original | Ctrl+E | Cmd+E |
| Maximize/restore frame under cursor | `` ` `` | `` ` `` |
| Maximize/restore active frame | Shift+`` ` `` | Shift+`` ` `` |
| Full-screen video | Ctrl+`` ` `` | Ctrl+`` ` `` |
| Next / previous panel | Ctrl+Shift+. / Ctrl+Shift+, | Ctrl+Shift+. / Ctrl+Shift+, |

### 16.2 Panels and workspaces

| Command | Windows | macOS |
|---|---|---|
| Project panel | Shift+1 | Shift+1 |
| Source Monitor | Shift+2 | Shift+2 |
| Timeline | Shift+3 | Shift+3 |
| Program Monitor | Shift+4 | Shift+4 |
| Effect Controls | Shift+5 | Shift+5 |
| Audio Track Mixer | Shift+6 | Shift+6 |
| Effects | Shift+7 | Shift+7 |
| Media Browser | Shift+8 | Shift+8 |
| Audio Clip Mixer | Shift+9 | Shift+9 |
| Workspace 1…9 (All Panels, Assembly, Audio, Captions & Graphics, Color, Editing, Effects, Essential, Learning; alphabetical order of the workspace list) | Alt+Shift+1…9 | Opt+Shift+1…9 |
| Reset to Saved Layout | Alt+Shift+0 | Opt+Shift+0 |

Premiere numbers workspaces by their order in the workspace list. We should bind `Alt+Shift+1` = Editing (our default), then the rest in menu order.

### 16.3 Tools (Timeline / Program focused)

| Tool | Key |
|---|---|
| Selection | V |
| Track Select Forward / Backward | A / Shift+A |
| Ripple Edit | B |
| Rolling Edit | N |
| Rate Stretch | R |
| Razor | C |
| Slip | Y |
| Slide | U |
| Pen | P |
| Hand | H |
| Zoom | Z |
| Type | T |

### 16.4 Playback and navigation (Timeline / monitors)

| Command | Windows | macOS | Notes |
|---|---|---|---|
| Play / Stop | Space | Space | |
| Shuttle left | J | J | repeat: 2×, 3×/4×, 8× reverse |
| Stop shuttle | K | K | |
| Shuttle right | L | L | repeat: 2×, 3×/4×, 8× |
| Frame step while holding K | K+J / K+L | same | hold K + hold J/L = slow-motion shuttle |
| Shuttle slow left / right | Shift+J / Shift+L | same | incremental slow speeds (verify exact steps) |
| Step back / forward 1 frame | ← / → | ← / → | |
| Step back / forward 5 frames | Shift+← / Shift+→ | same | |
| Go to previous / next edit point (targeted tracks) | ↑ / ↓ | ↑ / ↓ | |
| Go to previous / next edit point (any track) | Shift+↑ / Shift+↓ | same | |
| Go to sequence start / end | Home / End | Home / End | |
| Go to In / Out | Shift+I / Shift+O | same | |
| Play In to Out | Ctrl+Shift+Space | Opt+K (verify) | |
| Play Around | Shift+K | Shift+K | (verify) |
| Toggle audio scrubbing | Shift+S | Shift+S | |
| Loop (in monitors) | Ctrl+L | Cmd+L | panel-scoped |
| Next / previous in sequence (select) | Shift+; / Ctrl+Shift+; | Shift+; / Opt+; | |
| Go to next / previous marker | Shift+M / Ctrl+Shift+M | Shift+M / Shift+Cmd+M | |
| Show next / previous screen | Page Down / Page Up | same | |

JKL state machine (implement in `src/editor/playback/shuttle.ts`):

```ts
const STEPS = [1, 2, 4, 8]; // Premiere: 1x→2x→3x(4x)→8x; pick 1,2,4,8
type Shuttle = {dir: -1 | 0 | 1; step: number};
// J: dir===-1 ? step=min(step+1, 3) : (dir=-1, step=0)
// L: dir=== 1 ? step=min(step+1, 3) : (dir= 1, step=0)
// K: dir=0 (pause). While K held: J/L tap = ∓1 frame; J/L hold = ±0.25x slow shuttle.
// rate = dir * STEPS[step]
```

- The Remotion `PlayerRef` supports `playbackRate`, including negative values, within Remotion's allowed range (check `@remotion/player` docs for 4.0.499; it historically clamps to ±4).
- For 8× or beyond the clamp, fall back to timer-driven `seekTo()` stepping that plays only keyframes/proxy frames.
- Pressing the opposite key while shuttling switches direction at 1×. This is Premiere's behavior (verify); Avid decelerates instead.

### 16.5 Marking and editing

| Command | Windows | macOS |
|---|---|---|
| Mark In / Mark Out | I / O | I / O |
| Mark Clip (In/Out around clip under playhead on targeted tracks) | X | X |
| Mark Selection | / | / |
| Clear In / Clear Out | Ctrl+Shift+I / Ctrl+Shift+O | Opt+I / Opt+O |
| Clear In and Out | Ctrl+Shift+X | Opt+X |
| Insert (from Source) | , | , |
| Overwrite (from Source) | . | . |
| Lift | ; | ; |
| Extract | ' | ' |
| Add Marker | M | M |
| Clear Selected Marker | Ctrl+Alt+M | Opt+M |
| Clear All Markers | Ctrl+Alt+Shift+M | Opt+Cmd+M |
| Add Edit (split at playhead, targeted tracks) | Ctrl+K | Cmd+K |
| Add Edit to All Tracks | Ctrl+Shift+K | Shift+Cmd+K |
| Ripple Trim Previous Edit to Playhead | Q | Q |
| Ripple Trim Next Edit to Playhead | W | W |
| Trim Previous / Next Edit to Playhead (no ripple) | Alt+Q / Alt+W | Opt+Q / Opt+W |
| Extend Selected Edit to Playhead | E | E |
| Trim Edit (enter trim mode) | Shift+T | Cmd+T |
| Match Frame | F | F |
| Reverse Match Frame | Shift+R | Shift+R |
| Select Clip at Playhead | D | D (verify) |
| Snap in Timeline | S | S |
| Link / Unlink | Ctrl+L | Cmd+L |
| Group / Ungroup | Ctrl+G / Ctrl+Shift+G | Cmd+G / Shift+Cmd+G |
| Enable / Disable clip | Shift+E | Shift+Cmd+E |
| Make Subclip | Ctrl+U | Cmd+U |
| Make Subsequence | Shift+U | Cmd+U (per Adobe table; conflicts with Make Subclip; verify) |
| Speed/Duration | Ctrl+R | Cmd+R |
| Audio Gain | G | G |
| Audio Channels | Shift+G | Shift+G |
| Apply Video Transition (default) | Ctrl+D | Cmd+D |
| Apply Audio Transition (default) | Ctrl+Shift+D | Shift+Cmd+D |
| Apply Default Transitions to Selection | Shift+D | Shift+D |
| Render Effects In to Out | Enter | Return |
| Add caption track / caption at playhead | Ctrl+Alt+A / Ctrl+Alt+C | Opt+Cmd+A / Opt+Cmd+C |
| Next / previous caption segment | Ctrl+Alt+↓ / ↑ | Opt+Cmd+↓ / ↑ |

### 16.6 Timeline panel (panel-scoped)

| Command | Windows | macOS |
|---|---|---|
| Zoom In / Zoom Out | = / - | = / - |
| Zoom to sequence (toggle) | \ | \ |
| Increase / Decrease Video Track Height | Ctrl+= / Ctrl+- | Cmd+= / Cmd+- |
| Increase / Decrease Audio Track Height | Alt+= / Alt+- | Opt+= / Opt+- |
| Expand All / Minimize All Tracks | Shift+= / Shift+- | Shift+= / Shift+- |
| Nudge Clip Left / Right 1 frame | Alt+← / Alt+→ | Cmd+← / Cmd+→ |
| Nudge Clip Left / Right 5 frames | Alt+Shift+← / → | Shift+Cmd+← / → |
| Slide Clip Left / Right 1 frame | Alt+, / Alt+. | Opt+, / Opt+. |
| Slide Clip Left / Right 5 frames | Alt+Shift+, / . | Opt+Shift+, / . |
| Slip Clip Left / Right 1 frame | Ctrl+Alt+← / → | Opt+Cmd+← / → |
| Slip Clip Left / Right 5 frames | Ctrl+Alt+Shift+← / → | Opt+Shift+Cmd+← / → |
| Ripple Delete | Alt+Backspace | Opt+Delete |
| Clear Selection | Backspace | Delete |
| Set Work Area In / Out | Alt+[ / Alt+] | Opt+[ / Opt+] |

### 16.7 Program Monitor, Project, Effects, Effect Controls, History, Mixer (panel-scoped)

| Panel | Command | Windows | macOS |
|---|---|---|---|
| Program | Show Rulers | Ctrl+R | Cmd+R |
| Program | Show Guides | Ctrl+; | Cmd+; |
| Program | Snap in Program Monitor | Ctrl+Shift+; | Shift+Cmd+; |
| Program | Lock Guides | Ctrl+Alt+Shift+R | Opt+Shift+Cmd+R |
| Program | Nudge selected object 1 / 5 px | Ctrl+Arrows / Ctrl+Shift+Arrows | Cmd+Arrows / Shift+Cmd+Arrows |
| Project | New Bin | Ctrl+B | Cmd+B |
| Project | List / Icon view | Ctrl+PgUp / Ctrl+PgDn | Cmd+PgUp / Cmd+PgDn |
| Project | Toggle view | Shift+\ | Shift+\ |
| Project | Hover Scrub | Shift+H | Shift+H |
| Project | Thumbnail size next / previous | Shift+] / Shift+[ | same |
| Project | Open in Source Monitor | Shift+O | Shift+O |
| Project | Delete with options | Ctrl+Delete | Cmd+Fwd Delete |
| Project | Zoom in / out | = / - | = / - |
| Project | Next / previous column field | Tab / Shift+Tab | same |
| Project | Next / previous row field | Enter / Shift+Enter | Return / Shift+Return |
| Project | Set / clear poster frame | Shift+P / Ctrl+Shift+P | Cmd+P / Opt+P |
| Effects | New Custom Bin | Ctrl+/ | Cmd+/ |
| Effects | Delete custom item | Backspace | Delete |
| Effect Controls | Remove selected effect | Backspace | Delete |
| Effect Controls | Loop during audio-only playback | Ctrl+L | Cmd+L |
| History | Step backward / forward | ← / → | ← / → |
| Audio Track Mixer | Show/Hide Tracks | Ctrl+Alt+T | Opt+Cmd+T |
| Audio Track Mixer | Meter Input(s) Only | Ctrl+Shift+I | Ctrl+Shift+I |
| Graphics | New Text / Rectangle / Ellipse layer | Ctrl+T / Ctrl+Alt+R / Ctrl+Alt+E | Cmd+T / Opt+Cmd+R / Opt+Cmd+E |
| Graphics | Bring to Front / Forward / Backward / to Back | Ctrl+Shift+] / Ctrl+] / Ctrl+[ / Ctrl+Shift+[ | Shift+Cmd+] / Cmd+] / Cmd+[ / Shift+Cmd+[ |
| Graphics | Select next / previous layer | Ctrl+Alt+] / [ | Opt+Cmd+] / [ |

Multi-camera (optional): `1`–`9` cut to camera N during multicam playback; `Ctrl+1…9` switch camera without cutting.

### 16.8 Keymap implementation requirements

1. **One registry.** Create `src/editor/keymap/registry.ts` with entries `{id, win: 'Ctrl+K', mac: 'Cmd+K', scope: 'global'|'timeline'|'program'|'source'|'project'|'effectControls'|..., when?: (ctx) => boolean, run: (ctx) => void}`.
   - Resolve bindings against the **focused panel** (tracked by the dock host; see §5.2) first, then global.
   - Premiere shortcuts are panel-scoped: `=` zooms the Timeline when it has focus but zooms thumbnails in Project. Arrow keys differ per panel too.
   - Remove the per-component `window.addEventListener('keydown')` hooks in `src/editor/keyboard-shortcuts/*`.
2. **Match on `KeyboardEvent.code`** (physical key: `KeyJ`, `Semicolon`, `Quote`, `Comma`, `Period`, `Backquote`, `Backslash`, `Equal`, `Minus`, `BracketLeft`, `BracketRight`).
   - This keeps editing-key *positions* stable on non-US layouts, which is how NLE keymaps behave.
   - Show labels using `navigator.keyboard.getLayoutMap()` where available.
3. **Ignore shortcuts while typing** in `input`, `textarea` or `[contenteditable]`, except Escape / Enter handling. The Remotion starter's text editing is in `src/editor/canvas/*` / `items/text/*`.
4. **Browser-reserved combos.** Chrome/Edge will not deliver `Ctrl+N`, `Ctrl+W`, `Ctrl+T`, `Ctrl+Shift+N/T/W`, `Ctrl+Tab`, or `Ctrl+Q` (Linux) to pages, even to installed PWAs outside Keyboard-Lock fullscreen.
   - Web/PWA fallbacks: New Sequence `Alt+N`, Close Panel `Alt+W`, New Text Layer `Alt+T` (show these in menus when not in Electron).
   - Electron receives everything. Register menu accelerators there with `role`-less custom items and forward them to the renderer registry via IPC.
   - `Ctrl+`` ` full-screen: use the Fullscreen API on web and `BrowserWindow.setFullScreen` on Electron.
5. **Customizable.** The Keyboard Shortcuts dialog (`Ctrl+Alt+K`) shows:
   - a visual keyboard with keys colored by type: purple = application-wide, green = panel-specific, both = striped;
   - a searchable command list and conflict warnings.
   - Presets: "Premiere (default)", "Avid-like", "FCP 7-like", "Custom".
   - Store as JSON (`keymaps/<name>.json`) and allow import/export.
6. Keep the starter's existing behaviors mapped:
   - `space-to-play-pause.tsx` → Space;
   - `backspace-to-delete.tsx` → Clear;
   - `undo-redo.tsx`, `copy-paste-layers.tsx`, `duplicate-layers.tsx` → Duplicate is `Ctrl+Shift+/` in Premiere; Alt-drag also duplicates;
   - `select-all-shortcut.tsx`, `save-shortcut.tsx`, `snapping-shortcut.tsx` → S.

---

## 17. Other panels (brief specs)

- **Media Browser**: left = locations tree; right = file grid/list with hover scrub; ingest checkbox. Web uses the File System Access API; Electron uses native FS. `Shift+O` opens the selection in Source.
- **Info**: key–value readout of the selection (Type, Video, Audio, Duration, In, Out, Cursor) and the sequence playhead / each track's clip at the playhead. 11 px text.
- **Markers**: list rows with color swatch, name, In/Out/Duration, and comment. Color filter chips at the top; search field.
- **History**: an undo stack list. The current state is highlighted; later states are grayed. Click to jump. Hook it to the starter's undoable state (`src/editor/state/*`, `undoableState`).
- **Metadata**: clip, file and XMP fields.
- **Text** (v25+): tabs `Transcript | Captions | Graphics`.
  - Transcript: text-based editing, with a speaker label, timecode and paragraphs. Selecting text selects a range, which can be inserted/extracted.
  - Captions: segments with In/Out timecodes and editable text.
  - The starter's `src/editor/captioning/*` plus `@remotion/openai-whisper` feed this.
- **Agent** (JasperEditor):
  - **Top**: a chat/plan area.
  - **Middle**: pending actions list. Each action shows its targets (clip/track/time range) and **ghost previews** on the timeline: dashed `--pr-accent` outlines and a 30% blue fill for proposed clips/edits.
  - **Bottom**: prompt field with an "Apply" / "Apply all" / "Reject" pill row.
  - Agent edits enter the History panel as named steps, e.g. "Agent: remove silences".
- **Jobs** (native engine): a queue of ffmpeg/fframes/Remotion jobs with per-job progress bars (`--pr-accent`), ETA, and cancel. The header "background tasks" icon shows a badge count. Existing component: `src/editor/action-row/tasks-indicator`.

---

## 18. Interaction details checklist

**Cursors.** Provide custom SVG cursors (32×32, with hotspots) for:
- trim-in / trim-out (red brackets) and ripple-in / out (yellow);
- rolling, slip, slide, rate-stretch;
- razor;
- pen / pen-add-keyframe;
- hand / hand-grab;
- zoom-in / zoom-out;
- track-select forward / backward;
- insert-drag (with an arrow) and overwrite-drag.

Existing plumbing: `src/editor/force-specific-cursor.tsx`.

**Drag feedback when dragging media onto the timeline**:
- a translucent clip ghost at 60% opacity;
- a vertical insert line (yellow triangles) when Ctrl is held;
- a track highlight;
- a "New track" hint when dragging above V-top or below A-bottom.

**Tooltips on trims.** Show the delta and the resulting duration; also in the Info panel.

**Double-clicks**
- clip → open in Source (for a nested sequence, open the sequence);
- graphic → select the layer in Properties;
- edit point → trim mode (optional);
- marker → marker dialog.

**Right-click on a clip** opens:
- Cut, Copy, Paste Attributes…, Remove Attributes…, Clear, Ripple Delete;
- Edit Original, Replace With Clip ▸, Enable, Unlink, Group, Ungroup;
- Synchronize, Merge Clips, Nest…, Make Subsequence, Multi-Camera ▸, Label ▸;
- Speed/Duration…, Scene Edit Detection…, Audio Gain…, Audio Channels…;
- Frame Hold Options…, Add Frame Hold, Insert Frame Hold Segment, Field Options…, Time Interpolation ▸, Scale to Frame Size, Set to Frame Size, Adjustment Layer;
- Link Media…, Make Offline…, Rename…, Reveal in Project, Reveal in Explorer/Finder, Properties;
- **Agent ▸** (JasperEditor).

**Selection highlights.** A selected clip gets a white outline. A selected edit point gets a red (regular) or yellow (ripple) bracket overlay on the side being trimmed.

**Animation.** Premiere is almost motion-free: no panel transitions, and instant maximize. Keep UI transitions ≤ 100 ms and only use them for hover/press fades. Never animate the timeline or playhead with CSS transitions; the playhead must track frames exactly.

---

## 19. Touch / mobile adaptation (PWA): Premiere Rush / "Premiere on iPhone" style

- Adobe retired Premiere Rush and shipped **Premiere for iPhone/iPad** (Sept 30 2025). It has an unlimited multi-track timeline (video, audio, text layers), frame-accurate trim/split/crop, an out-of-player transform tool, auto captions, Enhance Speech, and one-tap social export.
- On phones we do **not** try to show the docking workspace. The PWA switches to a dedicated touch shell below the breakpoints listed next.

### 19.1 Breakpoints and shells

| Width | Shell | Notes |
|---|---|---|
| ≥ 1280 px | **Desktop workspace** (full docking) | also Electron |
| 900–1279 px | **Compact workspace** | Same dock engine with the fixed preset "Essentials": Program + Properties + Timeline; Project as a tab; Tools collapse into the timeline toolbar |
| 600–899 px (tablet portrait / small landscape) | **Touch tablet shell** | Viewer + side sheet + timeline; see §19.3 |
| < 600 px | **Touch phone shell** | Rush-like; see §19.2 |

- Choose by `matchMedia('(pointer: coarse)')` **and** width.
- A tablet with keyboard + trackpad (iPad Magic Keyboard) can opt into the desktop workspace via a setting.

### 19.2 Phone layout (portrait)

```
┌──────────────────────────────┐  safe-area-inset-top
│ ←  Project name        ↶ ↷ ⤴ │  48px app bar (back, title, undo, redo, Export pill)
├──────────────────────────────┤
│                              │
│          VIEWER              │  ~38–45% height; letterboxed on #000
│   (9:16 or 16:9 fit)         │  pinch on a selected layer = transform
│                              │
├──────────────────────────────┤
│ 00:01:12:04  ▶  ⤢   ◆   🔊   │  44px transport row: timecode, play, fullscreen, keyframe, mute
├──────────────────────────────┤
│        ▼ fixed centered playhead
│ T  [ text clip ]             │  ← overlay/text track(s) (compact 32px)
│ V  [▭▭clip▭▭][▭▭clip▭▭▭▭]    │  ← main video track (56px, thumbnails)
│ ♪  [≈≈≈ music ≈≈≈≈≈≈≈≈≈]     │  ← audio track(s) (40px, waveform)
│ ＋ Add track                  │
├──────────────────────────────┤
│ ✂ Split  ⧉ Dup  🗑 Del  ⚡ Speed│  contextual toolbar (clip selected) 56px
├──────────────────────────────┤
│  ＋     Tt     ♪     🎨     ✦   │  bottom tab bar 56px: Add media, Text/Graphics,
│ Media  Text  Audio  Color Agent│  Audio, Color/Effects, Agent (+ Captions in overflow)
└──────────────────────────────┘  safe-area-inset-bottom
```

**Timeline model on touch (Rush/iPhone style)**
- The **playhead is fixed at the horizontal center**. Dragging the timeline horizontally scrolls the content under it, which scrubs. Momentum scrolling is on while paused and off while playing.
- **Pinch horizontally** to zoom time. Pinch vertically is ignored; vertical pan scrolls tracks.
- **Tap** a clip to select it: a thick white outline plus **trim handles** (16 px visual, 44 px hit area) on both edges. Drag the handles to trim; this is a ripple trim on the main track and a regular trim on overlay tracks, as in Rush.
- **Long-press (≈350 ms)** a clip to lift it (scale 1.03, shadow) and drag to reorder or move to another track. Drop indicators appear between clips.
- **Split** at the playhead from the contextual toolbar. The Razor tool doesn't exist on touch.
- Snapping is always on. Snapping to the playhead, clip edges and markers triggers **haptic feedback** (`navigator.vibrate(10)` on Android; iOS Safari has no vibrate API, so show a visual pulse only).
- Double-tap the viewer to toggle full-screen preview. Two-finger tap = undo, three-finger tap = redo (optional; matches iPadOS).
- Track headers are collapsed to a 32 px icon column (T / V / ♪ + lock / mute via long-press menu). Track targeting and patching are hidden; edits go to the selected track or the main track.

**Properties on touch**
- Selecting a clip and tapping a tool (Speed, Volume, Crop, Transform, Color, Text style) opens a **bottom sheet**:
  - detents at 40% / 90%;
  - drag handle;
  - large sliders (thumb 28 px, track 4 px) with numeric chips;
  - reset button.
- Keyframes on touch: a ◆ button in the transport row adds/removes a keyframe for the property currently open in the sheet. Keyframes show as small diamonds on the selected clip.

**Touch sizing tokens** (override via `[data-pr-density='touch']`):

```css
[data-pr-density='touch'] {
	--pr-font-size-ui: 14px;
	--pr-row-h: 44px;
	--pr-tab-h: 44px;
	--pr-hit-min: 44px;
	--pr-track-h-video: 56px;
	--pr-track-h-audio: 40px;
	--pr-track-h-text: 32px;
	--pr-clip-radius: 6px;
	--pr-handle-w: 16px;
	--pr-header-h: 48px;
	--pr-bottom-bar-h: 56px;
}
```

Use the same color tokens. Touch uses the Darkest theme only, plus a pure-black viewer background.

### 19.3 Tablet layout

- **Landscape**:
  - left column 30%: Media / Text / Audio / Effects / Agent sheets as a segmented control;
  - center: viewer;
  - right column 25%: Properties;
  - bottom 40%: timeline with **real** track headers (lock, eye/mute), 48 px tracks, and a visible (non-fixed) playhead.
  - Pencil/trackpad users get desktop-like direct dragging of the playhead.
- **Portrait**: the phone layout with a larger viewer and a two-column bottom sheet.
- Hardware keyboard: the full keymap (§16) stays active. JKL, I/O, `,` `.` and `;` `'` work on iPad keyboards.

### 19.4 PWA specifics

- `manifest.webmanifest`:
  ```json
  {"display": "standalone", "display_override": ["window-controls-overlay", "standalone"], "background_color": "#000000", "theme_color": "#1d1d1d", "orientation": "any"}
  ```
  Provide maskable icons.
- **Window Controls Overlay** (desktop PWA): the 36 px header bar becomes the draggable title bar. Use `env(titlebar-area-*)` and `app-region: drag` on the empty header area. This gives the Premiere-like single header.
- Use `100dvh` and `env(safe-area-inset-*)` paddings. Disable pull-to-refresh on the timeline (`overscroll-behavior: none`); the starter already sets `overscroll-behavior-x: none` in `editor-starter.css`. Use `touch-action: none` on the timeline and viewer canvases and handle gestures with Pointer Events. Hammer.js is not needed: use a small pinch/pan recognizer on `pointerdown/move/up` with multiple pointer IDs.
- Offline: cache the app shell, fonts, icons and WASM. Media stays in OPFS / IndexedDB (the starter's `src/editor/caching/*`).

---

## 20. Electron specifics (UI-level)

- **Frameless window with custom title bar**:
  - Windows/Linux: `titleBarStyle: 'hidden'` + `titleBarOverlay: {color: '#1d1d1d', symbolColor: '#e3e3e3', height: 36}`.
  - macOS: `trafficLightPosition` inside the 36 px header.
- Native application menu with the full Premiere menu structure (§5.1); accelerators come from the keymap registry.
- **Popout panels** use real `BrowserWindow`s (dockview popout groups) so panels can go on a second monitor. The workspace JSON saves display IDs and bounds.
- The full-screen Program Monitor on a secondary display (Premiere's "Mercury Transmit"-like "Playback on external display") is optional later.

---

## 21. Suggested implementation order

1. **Tokens + fonts**
   - Add `premiere-tokens.css`, self-hosted Source Sans 3 and the Tailwind bridge.
   - Re-point `--color-editor-starter-*`.
   - Replace `ITEM_COLORS` with the label system.
   - This gives an instant re-skin with no layout change.
2. **Dock host**
   - Add `dockview`, create `WorkspaceHost`, and wrap the existing Canvas / Inspector / Timeline / PlaybackControls as panels.
   - Build the Editing (v25 variant) preset.
   - Add focus tracking, `` ` `` maximize and workspace persistence.
3. **Keymap registry**: panel-scoped, with the Premiere default map, JKL shuttle, and the browser-reserved fallbacks.
4. **Timeline chrome**:
   - 176 px track headers with lock / target / sync lock / eye / M / S;
   - source patching;
   - ruler with In/Out, render bar and markers;
   - blue playhead;
   - zoom scroll bars;
   - track height resizing;
   - clip visual redesign.
5. **Tools panel** + tool cursors + trim modes (ripple / rolling / slip / slide / rate stretch).
6. **Monitors**: Source + Program chrome, button bar + Button Editor, safe margins, playback resolution (proxy tiers).
7. **Project panel** (list/icon views, bins) and **Effects** panel.
8. **Effect Controls** with keyframes + mini-timeline; **Properties** panel refactor of `src/editor/inspector/*`.
9. **Audio Meters**, **Audio Track Mixer**; Lumetri-style panel + scopes.
10. **Touch shells** (phone/tablet), PWA manifest + WCO; Electron frameless + native menu + popouts.

---

## 22. References

- Adobe Help (Premiere desktop):
  - Default keyboard shortcuts: https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html
  - Dock, group, or undock panels: https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/dock-group-undock-panels.html
  - Customize panels (resize, 4-way intersections): https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/customize-panels.html
  - Display any panel full-screen (`` ` ``): https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/display-any-panel-full-screen.html
  - Workspaces overview: https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/what-are-workspaces.html
  - Tools panel: https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/tools-panel-and-options-panel.html
  - Appearance preferences (Darkest/Dark/Light, contrast): https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/appearance-preferences.html
  - Labels preferences / presets: https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/labels-preferences.html
  - Timeline preferences: https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/timeline-preferences.html
  - Source/Program monitors: `.../source-and-program-monitor-adjustments/about-source-monitor-and-program-monitor.html`, `time-controls-...`, `display-controls-...` (Button Editor), `set-display-quality-...`, `adjust-the-magnification-...`, `view-safe-zones-in-the-monitors.html`
  - Timeline navigation controls: https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html
  - Source patching / track targeting / sync lock / track lock / track appearance: `edit-projects/intro-to-editing/*`, `edit-projects/change-clip-sequence/*`
  - Effect Controls: https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/about-effect-controls-panel.html
  - Properties panel: https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/about-properties-panel.html
  - Audio Track Mixer: https://helpx.adobe.com/premiere/desktop/add-audio-effects/advanced-audio-techniques/about-audio-track-mixer.html
  - Lumetri Color / Color mode (v27): https://helpx.adobe.com/premiere/desktop/correct-color/color-mode-fundamentals/lumetri-color.html, `.../color-tools-panel-overview.html`
  - Project panel views/columns: `get-started/customize-the-project-panel/*`
- Adobe Spectrum tokens:
  - `@adobe/spectrum-tokens` 15.4.1 (`dist/json/drover.json`);
  - `@spectrum-css/vars` 9.0.8 (`css/themes/spectrum-darkest.css`).
- ProVideo Coalition, "Understanding the new label color and icons in the 2024 Adobe Premiere Pro update" (v24.4 clip redesign, fx badges).
- Adobe newsroom / MacRumors / TechCrunch, Sept 30 2025: Premiere for iPhone launch; Rush retirement.
- Label classic hex values (community-documented): Violet A690E0, Iris 729ACC, Caribbean 29D698, Lavender E384E3, Cerulean 2FBFDE, Forest 51B858, Rose F76FA4, Mango EDA63B, Purple 970097, Blue 3C3CFF, Teal 008080, Magenta E732E7, Tan CEC195, Green 1D7021, Brown 8B4513, Yellow E2E264.
