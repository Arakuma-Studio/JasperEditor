# Parity with Premiere Pro

How close JasperEditor is to Adobe Premiere Pro 2026, including the features it shares with After Effects, feature
by feature.

> **Read this as a measure of breadth, not of readiness for real use.** It checks whether each feature exists,
> using our own catalogue, graded from the code and the wp-notes. It does not say whether a feature behaves like
> Premiere, whether it holds up on real projects, or how the app does on macOS and Windows. Those questions, and
> the work that closes them, are in [gaps.md](gaps.md). **Don't raise the numbers here without the evidence
> gaps.md asks for.**

## Current status

Assessed 7 October 2026 at `main` **051cf53**, before the parallel workstreams below land. The integrator refreshes
these numbers after the merge.

| Measure | Value |
|---|---|
| **Breadth, weighted by tier** (P0 ×3, P1 ×2, P2 ×1) | **≈ 59%** counting every partial feature as half; ≈ 60% using the fractions below |
| P0 / P1 / P2 | 85% / 40% / 28% (half credit) |
| Features done / partial / missing | 39 / 18 / 35 of 92 |
| Video effects / transitions | 339 effects, 172 video transitions + 2 audio crossfades (counted from the registries); no audio effects |
| Menu entries | 148 on `main`, of which 31 are unregistered and render disabled (counted from `MENUBAR` and the command registry; `process` wires 3 of them and adds 2) |
| Document commands | 90 in `COMMAND_CATALOG`, of which 13 return `E_NOT_IMPLEMENTED` (`commands/handlers/m2.ts`) |
| Agent tools | 84 MCP tools on `main` |

How a row is graded: **done** when the model, an undoable command, the UI, the preview and every export path exist
(per its wp-note and tests); **partial** with a fraction when part of that is missing; **missing** when there is no
code or only a disabled menu entry. A feature that exists but has never been compared with Premiere's documented
behaviour still counts as done here; gaps.md tracks that separately.

## By area

| Area | Breadth (fractions, tier-weighted) | Features |
|---|---|---|
| Project & media | 59% | 8 |
| Import | 62% | 5 |
| Monitors | 75% | 5 |
| Timeline | 68% | 13 |
| Timing | 25% | 2 |
| Keyframes | 77% | 6 |
| Effects | 81% | 6 |
| Transitions | 91% | 3 |
| Tracking & roto | 67% | 2 |
| Graphics | 50% | 7 |
| Colour | 68% | 5 |
| Audio | 33% | 7 |
| Captions & speech | 0% | 2 |
| Interchange | 0% | 1 |
| Export | 62% | 4 |
| Processing | 50% | 2 |
| Project files | 46% | 5 |
| Interface | 58% | 6 |
| Agents | 100% | 1 |
| Platforms | 62% | 2 |

## Feature catalogue

### Project & media

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| PRJ-1 | Project panel: bins, list and icon views, search, labels, drag to timeline | P0 | done | WP-2E | — |
| PRJ-2 | Import media (upload / register path), probe, posters, filmstrips, waveforms | P0 | done | WP-2E, WP-2F | — |
| PRJ-3 | Relink and Replace Footage | P1 | partial (0.5) | `media.relink`, MCP `replace_footage`; no Link Media dialog | imports |
| PRJ-4 | Project Settings dialog | P1 | missing | File ▸ Project Settings… unregistered | edit-ux |
| PRJ-5 | Color mattes and other synthetic items | P1 | done | `synthetic.create/update` (Bars and Tone, Black Video, Color Matte, Transparent Video, Universal Counting Leader, Adjustment Layer), New Item menu, preview and native/Remotion export (edit-structure tests) | edit-structure |
| PRJ-6 | Remove unused media, Project Manager (collect / consolidate) | P2 | partial (0.5) | Remove Unused done (`media.removeUnused`, Edit menu, MCP, edit-structure); no Project Manager | imports |
| PRJ-7 | Media cache: usage, cleaning, location | P1 | done | wp-m3-cachegc | — |
| PRJ-8 | Proxies: create, attach, toggle | P1 | partial (0.5) | 720p/540p playback proxies exist (S04); Clip ▸ Create Proxies unregistered, no attach/toggle UI | previews |

### Import

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| IMP-1 | Video, audio and stills that ffmpeg reads (LGPL build) | P0 | done | apps/engine media service | — |
| IMP-2 | Image sequences | P1 | missing | no code found | imports |
| IMP-3 | Layered PSD / Illustrator files as sequences | P2 | missing | none | imports |
| IMP-4 | Animated images (GIF, APNG, WebP) | P2 | done | clip kind `animated-image` | — |
| IMP-5 | Remotion projects as clips (beyond Premiere) | P2 | done | wp-m2-mg, wp-m3-mgtext | — |

### Monitors

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| MON-1 | Program monitor: Player preview, JKL, timecode entry, playback resolution | P0 | done | WP-2C | — |
| MON-2 | Source monitor: in/out, insert and overwrite | P0 | done | apps/web/src/panels/source | — |
| MON-3 | Match Frame / Reverse Match Frame | P1 | done | F / Shift+R, through nests (`apps/web/src/commands/structure.ts`, edit-structure web tests) | edit-ux |
| MON-4 | Rulers, guides, safe margins | P2 | missing | View ▸ Show Rulers / Guides unregistered | edit-ux |
| MON-5 | Direct manipulation in the Program monitor (move, scale, rotate, anchor) | P0 | done | WP-2C, wp-3v | — |

### Timeline

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| TL-1 | Tracks, linked A/V, targeting, sync lock, track lock | P0 | done | WP-2B | — |
| TL-2 | Insert / overwrite, lift / extract, ripple delete | P0 | done | WP-2B | — |
| TL-3 | Trim: regular, ripple, roll; slip, slide; razor / Add Edit | P0 | done | WP-2B, `clip.slip`, `clip.slide` | — |
| TL-4 | Snapping, zoom, JKL, Space | P0 | done | WP-2B, editing.spec.ts | — |
| TL-5 | Markers (sequence and clip) and the Markers panel | P1 | done | WP-2B | — |
| TL-6 | Undo / redo with the History panel | P0 | done | packages/session | — |
| TL-7 | Copy / paste, paste insert, paste attributes | P1 | done | wp-clipboard | — |
| TL-8 | Nested sequences (Nest…, sequences as clips) | P1 | done | Nest…/Unnest, sequences as clips (nest or individual clips), double-click / Reveal Nested; preview, native in-graph and Remotion export (docs/wp-notes/edit-structure.md) | edit-structure |
| TL-9 | Group / ungroup | P2 | done | `clip.group/ungroup`, select / move / delete / outer-edge trim as a group, Alt single select | edit-structure |
| TL-10 | Add / delete tracks dialogs, track rename and heights | P1 | partial (0.5) | `track.add/remove/update` exist; dialogs unregistered | edit-ux |
| TL-11 | Multiple sequences: create, duplicate, delete, Sequence Settings | P1 | partial (0.75) | create, `sequence.duplicate`, `sequence.delete` (approval-gated for agents); Sequence Settings dialog unregistered | edit-structure |
| TL-12 | Adjustment layers | P1 | done | effects on the composite below with opacity, blend, crop and Opacity masks; preview, native and Remotion export | edit-structure |
| TL-13 | Multi-camera source sequences and live switching | P1 | missing | none | multicam |

### Timing

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| TM-1 | Speed / Duration, reverse, ripple on speed change | P1 | partial (0.5) | `clip.setSpeed`; Clip ▸ Speed/Duration… unregistered | time |
| TM-2 | Time remapping (speed keyframes), frame hold, frame blending, optical flow | P1 | partial (0.25) | frame holds done (Add Frame Hold, Insert Frame Hold Segment, Frame Hold Options; edit-structure); no time remapping, blending or optical flow | time |

### Keyframes

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| KF-1 | Keyframes on Motion, Opacity, crop, volume and effect parameters; linear, Bezier, hold | P0 | done | S01 KF, wave1 native export | — |
| KF-2 | Value and velocity graphs with Bezier handles | P1 | done | graph-editor.md | — |
| KF-3 | Spatial motion paths in the Program monitor | P1 | done | spatial-motion-path.md | — |
| KF-4 | Blend modes (Premiere has 27) | P1 | partial (0.25) | schema enum holds 8 (ARCHITECTURE §2.3) | keyframes-blend |
| KF-5 | Effect presets | P2 | done | effect-presets.md | — |
| KF-6 | Expressions (After Effects overlap) | P2 | missing | none | expressions |

### Effects

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| FX-1 | Video effects: 339 (Premiere categories plus a Sapphire-style catalogue) | P0 | done | `defaultEffectRegistry`, fx-shader-framework.md | — |
| FX-2 | GPU live preview, exported natively or through the hybrid bake | P0 | done | D-35 | — |
| FX-3 | Keying (11 effects) | P1 | done | premiere-adjust-color-keying | — |
| FX-4 | Shutter motion blur | P2 | done | fx-motion-blur | — |
| FX-5 | Effect masks and opacity masks (ellipse, polygon, pen), mask tracking | P1 | missing | none | masks |
| FX-6 | Warp Stabilizer-style stabilisation | P1 | partial (0.75) | vid.stab as clip processing (D-25), not a live effect with analysis in the clip | sim-warp |

### Transitions

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| TR-1 | Video transitions: 172 (Premiere standard plus Sapphire-style) | P0 | done | `TRANSITION_SPECS` | — |
| TR-2 | Audio crossfades: constant gain and constant power (no exponential fade) | P0 | partial (0.75) | transition-audio tests | audio-fx |
| TR-3 | Default transitions, apply to selection, timeline handles | P1 | done | wp-m3-transdefaults | — |

### Tracking & roto

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| MT-1 | Point and planar tracking, corner pin, screen replacement (beyond Premiere) | P1 | done | wp-m2-track, wp-m3-trackui | — |
| MT-2 | Roto brush / segmentation (After Effects overlap) | P2 | missing | none | roto |

### Graphics

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| GR-1 | Text clips: fonts, fill, strokes, shadow, background box | P0 | done | S01 text, layer bake (D-31) | — |
| GR-2 | Shapes: rectangle and ellipse only (no pen paths, polygons, groups) | P1 | partial (0.5) | wp-m2-shapes | shapes |
| GR-3 | Text animators: presets (no After Effects range selectors) | P1 | partial (0.5) | wp-m2-text-anim | text-animators |
| GR-4 | Motion graphics templates with editable parameters (fframes, anime.js) | P1 | partial (0.75) | wp-m2-mg, wp-m2-anime-templates; no MOGRT import, no responsive design | text-animators |
| GR-5 | Essential Graphics panel (layers, align, responsive pins), rolling / crawling titles | P1 | missing | none | text-animators |
| GR-6 | 3D layers, cameras and lights (After Effects overlap) | P2 | missing | none | three-d |
| GR-7 | Simulation and warp effects beyond the catalogue (particles, mesh warp, liquify) | P2 | missing | none | sim-warp |

### Colour

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| CL-1 | Lumetri-style grade: basic, creative, curves, colour wheels (one baked LUT, D-21) | P0 | partial (0.75) | wp-m2-color; HSL secondary and hue curves not verified | color-grade |
| CL-2 | Lumetri scopes: waveform, parade, vectorscope, histogram | P1 | done | apps/web/src/panels/scopes | — |
| CL-3 | LUT import (.cube) | P1 | done | wp-m2-color | — |
| CL-4 | Colour management: working space, log / HDR input, output transforms | P1 | partial (0.25) | working space is Rec.709 only | color-mgmt |
| CL-5 | Comparison view, Color Match | P2 | missing | none | color-grade |

### Audio

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| AU-1 | Clip gain, volume and pan with keyframes; audio in preview and export | P0 | done | S01 audio, D-34 volumes | — |
| AU-2 | Track volume / pan, mute / solo | P0 | partial (0.75) | track fields exist; no mixer UI | audio-mix |
| AU-3 | Live audio meters | P0 | missing | Audio Meters panel is a placeholder (MTR-002 later) | audio-mix |
| AU-4 | Audio Track Mixer and Clip Mixer, submixes | P1 | missing | none | audio-mix |
| AU-5 | Audio effects (EQ, dynamics, reverb, noise reduction, pitch) | P1 | missing | no effect applies to audio | audio-fx |
| AU-6 | Essential Sound, loudness normalisation, ducking | P1 | missing | none | audio-fx |
| AU-7 | Audio channel mapping (Modify ▸ Audio Channels) | P2 | missing | menu unregistered | audio-mix |

### Captions & speech

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| CP-1 | Caption tracks: create, style, import / export SRT and VTT | P1 | missing | `clip.addCaptions` E_NOT_IMPLEMENTED | captions |
| CP-2 | Speech to text, transcripts, text-based editing | P1 | missing | `transcript.*` E_NOT_IMPLEMENTED | speech |

### Interchange

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| IX-1 | FCP 7 XML, FCPXML, EDL, AAF, OTIO import and export | P1 | missing | none | interchange |

### Export

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| EX-1 | Export mode, presets, planner with native / hybrid / Remotion paths and named blockers | P0 | done | D-11, D-22, D-34, D-35 | — |
| EX-2 | Codecs: H.264 (hardware or OpenH264), VP9, AV1, ProRes, alpha; AAC / Opus | P0 | partial (0.75) | D-13; no HEVC software encoder, OpenH264 quality below x264 | — |
| EX-3 | Export Frame, Quick Export, export queue | P1 | partial (0.5) | Quick Export and queue registered; File ▸ Export ▸ Frame unregistered (MCP `render_frame` exists) | previews |
| EX-4 | Render previews (timeline render bar), smart rendering | P1 | missing | none | previews |

### Processing

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| AI-1 | Upscale (SPAN), stabilise, denoise, de-judder as derived media (beyond Premiere) | P2 | done | wp-m2-process | — |
| AI-2 | Scene edit detection, auto reframe, morph cut | P2 | missing | none | — |

### Project files

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| PF-1 | Autosave, atomic writes, single-writer leases, conflict handling | P0 | done | WP-2E, WP-2F | — |
| PF-2 | Schema migrations, read-only for newer files | P0 | done | migrations.ts | — |
| PF-3 | Crash recovery of unsaved changes | P0 | missing | none on main (S01:PER-021, AC-18) | process |
| PF-4 | Saved versions: browse and restore | P1 | missing | `restoreVersion` NOT_IMPLEMENTED on main | process |
| PF-5 | Save As, Save a Copy, Revert | P1 | missing | menu-only on main | process |

### Interface

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| UI-1 | Docked panels, workspaces (save, import, export, reset) | P0 | done | WP-2A | — |
| UI-2 | Premiere default shortcuts, conflict-free keymap | P0 | done | keymap-defaults.ts, keymap.test.ts | — |
| UI-3 | Keyboard Shortcuts editor | P1 | missing | Edit ▸ Keyboard Shortcuts… unregistered | edit-ux |
| UI-4 | Preferences dialog | P1 | partial (0.5) | Preferences ▸ Media Cache, Timeline defaults, Graphics; most pages absent | edit-ux |
| UI-5 | Find, Edit Original, Exit | P2 | missing | unregistered menu commands | edit-ux |
| UI-6 | Localisation and accessibility | P2 | missing | none | — |

### Agents

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| AG-1 | MCP server: 84 tools on main, every edit an undoable transaction, approvals (beyond Premiere) | P1 | done | wp-mcp, README | — |

### Platforms

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| PL-1 | Web, PWA and Electron on Linux | P0 | done | M1-STATUS | — |
| PL-2 | macOS and Windows checked | P0 | partial (0.25) | builds exist; never run (M1-STATUS) | — |

## In flight: 23 parallel workstreams landing now

Each runs on its own branch `feat/<name>` and merges into `integrate/parity`. **None is credited above.** The
numbers describe `main` at 051cf53 (7 October 2026); the integrator refreshes them after the merge, row by row,
with the evidence each workstream records in its wp-note. The "done when" of each is in [gaps.md](gaps.md#workstreams).

| Workstream | Targets |
|---|---|
| `mcp-cli` | AG-1 (CLI and MCP depth), PL-1 |
| `keyframes-blend` | KF-4, KF-1 |
| `golden-fuzz` | stability evidence (gaps.md), PF-2 |
| `audio-mix` | AU-2, AU-3, AU-4, AU-7 |
| `audio-fx` | AU-5, AU-6, TR-2 |
| `captions` | CP-1 |
| `speech` | CP-2 |
| `interchange` | IX-1 |
| `edit-structure` | TL-8, TL-9, TL-11, TL-12, PRJ-5 |
| `edit-ux` | MON-3, MON-4, TL-10, PRJ-4, UI-3, UI-4, UI-5 |
| `multicam` | TL-13 |
| `time` | TM-1, TM-2 |
| `masks` | FX-5 |
| `roto` | MT-2 |
| `expressions` | KF-6 |
| `text-animators` | GR-3, GR-4, GR-5 |
| `shapes` | GR-2 |
| `sim-warp` | GR-7, FX-6 |
| `three-d` | GR-6 |
| `imports` | IMP-2, IMP-3, PRJ-3, PRJ-6 |
| `color-mgmt` | CL-4 |
| `color-grade` | CL-1, CL-5 |
| `previews` | EX-3, EX-4, PRJ-8 |
| `process` | PF-3, PF-4, PF-5 (and guardrails: AGENTS.md, layering and asset checks, project-format hygiene) |

## Out of scope or intentionally absent

- **Native `.prproj`**: undocumented binary/XML format; interchange goes through FCP XML, EDL, AAF and OTIO (IX-1).
- **Adobe services**: Team Projects, Productions, Frame.io review, Creative Cloud Libraries, Adobe Stock, Dynamic Link,
  Media Encoder as a separate application, Adobe Fonts sync.
- **Third-party plug-ins**: Premiere/After Effects SDK plug-ins cannot run. VST3 / AU audio plug-ins are a real gap
  rather than out of scope (users rely on them for audio finishing); they are not in any current workstream.
- **Capture** from tape decks and hardware control surfaces.

Better than Premiere today (counted as done, not as extra credit): every edit is an undoable transaction that
external agents drive over MCP (AG-1); tracking with corner pin (MT-1); Remotion projects as clips (IMP-5);
processing models as derived media (AI-1); the command palette.
