# Parity with Premiere Pro

How close JasperEditor is to Adobe Premiere Pro 2026, including the features it shares with After Effects, feature
by feature.

> **Read this as a measure of breadth, not of readiness for real use.** It checks whether each feature exists,
> using our own catalogue, graded from the code and the wp-notes. It does not say whether a feature behaves like
> Premiere, whether it holds up on real projects, or how the app does on macOS and Windows. Those questions, and
> the work that closes them, are in [gaps.md](gaps.md). **Don't raise the numbers here without the evidence
> gaps.md asks for.**

## Current status

Assessed 8 October 2026 at `integrate/parity` (workstream `fixups`); recounted 9 October by workstream `gaps` (its
rows and the breadth below) and 10 October by workstream `polish` (the counts, with every workstream of the program
merged). Every row that changed cites the wp-note and the tests that show it. The breadth number is recomputed from
the table below (`P0 ×3, P1 ×2, P2 ×1`, each row's fraction); no row's grade changed after `gaps`.

| Measure | Value |
|---|---|
| **Breadth, weighted by tier** (P0 ×3, P1 ×2, P2 ×1) | **≈ 98%** using the fractions below; ≈ 98% counting every partial feature as half (was ≈ 91% before `gaps`, ≈ 59% at `main` 051cf53) |
| P0 / P1 / P2 | 97% / 99% / 100% (fractions) |
| Features done / partial / missing | 89 / 3 / 0 of 92 (partial: CL-4, EX-2, PL-2) |
| Video effects / transitions | 385 video effects, 60 audio effects; 172 video transitions + 3 audio transitions (counted from `defaultRegistries().effects` and `TRANSITION_SPECS`) |
| Menu entries | 291, all registered; the 280 default key bindings resolve to commands too (`apps/web/test/polish-menu-wiring.test.ts` fails otherwise; counted from `MENUBAR` and `DEFAULT_KEYMAP` against the registry after `registerAllCommands()`) |
| Panels | 22 (`listPanels()`), the Media Browser among them |
| Document commands | 256 in `COMMAND_CATALOG`; none answers `E_NOT_IMPLEMENTED` (no `notImplemented()` handler left) |
| Agent tools | 338 MCP tools (counted from a live `listTools`; the README list is checked by `apps/mcp/test/readme-tools.test.ts`) |
| UI languages | English and Spanish, 8 614 strings (`pnpm i18n:check`), switched without a restart |

How a row is graded: **done** when the model, an undoable command, the UI, the preview and every export path exist
(per its wp-note and tests); **partial** with a fraction when part of that is missing; **missing** when there is no
code or only a disabled menu entry. A feature that exists but has never been compared with Premiere's documented
behaviour still counts as done here; gaps.md tracks that separately.

## By area

| Area | Breadth (fractions, tier-weighted) | Features |
|---|---|---|
| Project & media | 79% | 8 |
| Import | 100% | 5 |
| Monitors | 100% | 5 |
| Timeline | 95% | 13 |
| Timing | 100% | 2 |
| Keyframes | 100% | 6 |
| Effects | 96% | 6 |
| Transitions | 100% | 3 |
| Tracking & roto | 100% | 2 |
| Graphics | 81% | 7 |
| Colour | 95% | 5 |
| Audio | 97% | 7 |
| Captions & speech | 100% | 2 |
| Interchange | 100% | 1 |
| Export | 82% | 4 |
| Processing | 62% | 2 |
| Project files | 100% | 5 |
| Interface | 75% | 6 |
| Agents | 100% | 1 |
| Platforms | 62% | 2 |

## Feature catalogue

### Project & media

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| PRJ-1 | Project panel: bins, list and icon views, search, labels, drag to timeline | P0 | done | WP-2E; windowed from 200 items (ui-perf); Set / Clear Poster Frame and Get Properties for Selection (`item.setPoster`, wp-notes/polish.md; `packages/project/test/polish-poster.test.ts`, `apps/web/test/polish-keybindings.test.tsx`) | — |
| PRJ-2 | Import media (upload / register path), probe, posters, filmstrips, waveforms | P0 | done | WP-2E, WP-2F; Media Browser panel: browse the engine host, preview, import in place, drag to the Project panel or Timeline (wp-notes/polish.md; `apps/engine/test/browse.test.ts`, `apps/web/test/polish-media-browser.test.tsx`, `e2e/polish.spec.ts`) | polish |
| PRJ-3 | Relink and Replace Footage | P1 | done | Link Media dialog (Project panel and File menu, folder search, relink by name / path), `media.relink`, MCP `link_media` / `replace_footage` (wp-notes/interchange.md §Link Media; `e2e/interchange.spec.ts`, `apps/engine/test/interchange.test.ts`); no Tape Name match | interchange |
| PRJ-4 | Project Settings dialog | P1 | done | File ▸ Project Settings…: display formats (timecode / frames / feet+frames, samples / ms), Scratch Disks, Ingest Settings (wp-notes/gaps.md; `apps/web/test/gaps-settings-dialogs.test.tsx`, `packages/project/test/gaps-display-format.test.ts`) | gaps |
| PRJ-5 | Color mattes and other synthetic items | P1 | done | `synthetic.create/update` (Bars and Tone, Black Video, Color Matte, Transparent Video, Universal Counting Leader, Adjustment Layer), New Item menu, preview and native/Remotion export (edit-structure tests) | edit-structure |
| PRJ-6 | Remove unused media, Project Manager (collect / consolidate) | P2 | done | Remove Unused (edit-structure); File ▸ Project Manager: collect / consolidate with handles (ProRes 422 HQ / WAV), exclude unused, previews, proxies, disk estimate, report (wp-notes/gaps.md; `apps/engine/test/gaps-project-manager.test.ts`: the copy shows the same frame codes) | gaps |
| PRJ-7 | Media cache: usage, cleaning, location | P1 | done | wp-m3-cachegc | — |
| PRJ-8 | Proxies: create, attach, toggle | P1 | done | Create / Attach Proxies, Reconnect Full Resolution, Detach, Toggle Proxies (monitors + button bar), ingest proxies, Export ▸ Use Proxies only when asked (wp-notes/gaps.md; `apps/engine/test/gaps-media-jobs.test.ts`, `packages/project/test/gaps-proxies.test.ts`) | gaps |

### Import

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| IMP-1 | Video, audio and stills that ffmpeg reads (LGPL build) | P0 | done | apps/engine media service | — |
| IMP-2 | Image sequences | P1 | done | numbered stills → Image Sequence prompt, `image-sequence` job (wp-notes/imports.md; `apps/engine/test/imports.test.ts`, `e2e/imports.spec.ts`) | imports |
| IMP-3 | Layered PSD / Illustrator files as sequences | P2 | done | PSD flattened / merged / individual layers / Sequence; PDF and Illustrator pages as vector stills (flattened, as Premiere) (wp-notes/imports.md; `packages/compositions/test/imports-layers.test.tsx`); PSD layer styles, CMYK layers and EPS not read | imports |
| IMP-4 | Animated images (GIF, APNG, WebP) | P2 | done | clip kind `animated-image` | — |
| IMP-5 | Remotion projects as clips (beyond Premiere) | P2 | done | wp-m2-mg, wp-m3-mgtext | — |

### Monitors

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| MON-1 | Program monitor: Player preview, JKL, timecode entry, playback resolution | P0 | done | WP-2C | — |
| MON-2 | Source monitor: in/out, insert and overwrite | P0 | done | apps/web/src/panels/source | — |
| MON-3 | Match Frame / Reverse Match Frame | P1 | done | F / Shift+R, through nests (`apps/web/src/commands/structure.ts`, edit-structure web tests) | edit-ux |
| MON-4 | Rulers, guides, safe margins | P2 | done | Show Rulers / Guides / Lock Guides, Add Guide…, guide templates, snapping (wp-notes/edit-ux.md; `apps/web/test/edit-ux-monitors.test.tsx`, `e2e/edit-ux.spec.ts`); guides are per-browser view state | edit-ux |
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
| TL-10 | Add / delete tracks dialogs, track rename and heights | P1 | done | Add Tracks… / Delete Tracks…, Clip ▸ Rename…, track height presets, minimise / expand all (wp-notes/gaps.md; `apps/web/test/gaps-ui5-tracks.test.tsx`) | gaps |
| TL-11 | Multiple sequences: create, duplicate, delete, Sequence Settings | P1 | done | one Sequence Settings dialog (timebase, frame size, pixel aspect, fields, audio rate, channels, links to Video Previews and colour), New Sequence From Clip; anamorphic delivery checked with ffprobe (wp-notes/gaps.md; `packages/project/test/gaps-sequence-format.test.ts`, `apps/engine/test/gaps-export-formats.test.ts`) | gaps |
| TL-12 | Adjustment layers | P1 | done | effects on the composite below with opacity, blend, crop and Opacity masks; preview, native and Remotion export | edit-structure |
| TL-13 | Multi-camera source sequences and live switching | P1 | done | create by timecode / audio / in points, Multi-Camera view, live switching recorded as cuts, flatten; nests (D-44) in preview, native and Remotion export (wp-notes/multicam.md; `packages/project/test/multicam.test.ts`, `apps/engine/test/multicam-export.test.ts`, `e2e/multicam.spec.ts`) | multicam |

### Timing

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| TM-1 | Speed / Duration, reverse, ripple on speed change | P1 | done | Clip ▸ Speed/Duration… (Ctrl+R) with ripple and reverse (wp-notes/edit-ux.md, wp-notes/time.md; `packages/project/test/edit-ux-edit-props.test.ts`, `apps/engine/test/time-export.test.ts`) | time |
| TM-2 | Time remapping (speed keyframes), frame hold, frame blending, optical flow | P1 | done | `timeRemap` speed keyframes with ramps, Frame Sampling / Frame Blending / Optical Flow, frame holds (wp-notes/time.md; `apps/engine/test/time-export.test.ts`, `apps/mcp/test/time.test.ts`, `e2e/time.spec.ts`); remapped nests export through Remotion | time |

### Keyframes

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| KF-1 | Keyframes on Motion, Opacity, crop, volume and effect parameters; linear, Bezier, hold | P0 | done | S01 KF, wave1 native export | — |
| KF-2 | Value and velocity graphs with Bezier handles | P1 | done | graph-editor.md | — |
| KF-3 | Spatial motion paths in the Program monitor | P1 | done | spatial-motion-path.md | — |
| KF-4 | Blend modes (Premiere has 27) | P1 | done | `BLEND_MODES` holds Premiere's 27 in menu order, native in the sequence's own stack (wp-notes/keyframes-blend.md §7; `apps/web/test/keyframes-blend-ui.test.tsx`, `e2e/keyframes-blend.spec.ts`); inside nests through Remotion | keyframes-blend |
| KF-5 | Effect presets | P2 | done | effect-presets.md | — |
| KF-6 | Expressions (After Effects overlap) | P2 | done | QuickJS-wasm sandbox (D-41), AE object model, Expression Controls (wp-notes/expressions.md; `packages/expressions/test/*`, `e2e/expressions.spec.ts`); `sampleImage` exact on solids only | expressions |

### Effects

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| FX-1 | Video effects: 339 (Premiere categories plus a Sapphire-style catalogue) | P0 | done | `defaultEffectRegistry`, fx-shader-framework.md | — |
| FX-2 | GPU live preview, exported natively or through the hybrid bake | P0 | done | D-35 | — |
| FX-3 | Keying (11 effects) | P1 | done | premiere-adjust-color-keying | — |
| FX-4 | Shutter motion blur | P2 | done | fx-motion-blur | — |
| FX-5 | Effect masks and opacity masks (ellipse, polygon, pen), mask tracking | P1 | done | masks on effects and Opacity, feather / expansion / invert, keyframes, tracking (wp-notes/masks.md; `packages/project/test/masks-commands.test.ts`, `apps/engine/test/masks-export.test.ts`, `apps/engine/test/masks-track.test.ts`, `e2e/masks.spec.ts`) | masks |
| FX-6 | Warp Stabilizer-style stabilisation | P1 | done | live Warp Stabilizer effect with background analysis stored in the effect, Smooth Motion / No Motion, Position / PSR / Perspective / Subspace Warp, all four framings, Advanced options; preview + export, WARP_NOT_ANALYZED blocker (wp-notes/gaps.md; `packages/project/test/gaps-warp-stabilizer.test.ts`, `packages/compositions/test/fx-warp-stabilizer-gl.test.ts`, `apps/engine/test/gaps-warp-analysis.test.ts`); vid.stab processing stays (D-25) | gaps |

### Transitions

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| TR-1 | Video transitions: 172 (Premiere standard plus Sapphire-style) | P0 | done | `TRANSITION_SPECS` | — |
| TR-2 | Audio crossfades: constant gain, constant power, exponential fade | P0 | done | 3 audio transitions in `TRANSITION_SPECS` (wp-notes/audio-fx.md; transition-audio tests, `apps/engine/test/audio-fx.test.ts`) | audio-fx |
| TR-3 | Default transitions, apply to selection, timeline handles | P1 | done | wp-m3-transdefaults | — |

### Tracking & roto

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| MT-1 | Point and planar tracking, corner pin, screen replacement (beyond Premiere) | P1 | done | wp-m2-track, wp-m3-trackui | — |
| MT-2 | Roto brush / segmentation (After Effects overlap) | P2 | done | wp-notes/roto, `apps/mcp/test/roto.test.ts`, `e2e/roto.spec.ts` | roto |

### Graphics

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| GR-1 | Text clips: fonts, fill, strokes, shadow, background box | P0 | done | S01 text, layer bake (D-31) | — |
| GR-2 | Shapes: pen paths, polygons, stars, groups, fills, strokes, path operators | P1 | done | vector shapes with the nine AE path operators, Pen / Rectangle / Ellipse / Polygon / Star tools (wp-notes/shapes.md; `packages/project/test/vector/*`, `apps/engine/test/vector-shapes-remotion.e2e.test.ts`, `e2e/vector-shapes.spec.ts`) | shapes |
| GR-3 | Text animators: presets and After Effects range selectors | P1 | done | range / wiggly / expression selectors, text on a path, typography (wp-notes/text-animators.md; `packages/project/test/text-animators.test.ts`, `packages/compositions/test/text-animators.e2e.test.ts`, `e2e/text-animators.spec.ts`) | text-animators |
| GR-4 | Motion graphics templates with editable parameters (fframes, anime.js) | P1 | done | wp-m2-mg, wp-m2-anime-templates; graphic templates (.jgt) export / import with responsive design; MOGRT import not supported, documented why (wp-notes/gaps.md §2) | gaps |
| GR-5 | Essential Graphics panel (layers, align, responsive pins), rolling / crawling titles | P1 | done | Essential Graphics panel: layers, New Layer, align / distribute, Responsive Design position (pins) and time (intro / outro), Roll / Crawl with off-screen, pre-roll, ease, post-roll, applied on every render path (wp-notes/gaps.md; `packages/project/test/gaps-graphics.test.ts`, `e2e/gaps.spec.ts`) | gaps |
| GR-6 | 3D layers, cameras and lights (After Effects overlap) | P2 | done | classic and advanced 3D, cameras, lights, models, 3D camera tracker (wp-notes/three-d.md; `packages/compositions/test/three-d-gl.test.ts`, `packages/compositions/test/three-d-render.e2e.test.ts`, `e2e/three-d.spec.ts`) | three-d |
| GR-7 | Simulation and warp effects beyond the catalogue (particles, mesh warp, liquify) | P2 | done | 18 AE simulation effects, Mesh Warp, Liquify, Puppet, Bezier Warp… as deterministic GPU effects with monitor tools (wp-notes/sim-warp.md; `packages/compositions/test/fx-sim-warp-gl.test.ts`, `packages/project/test/sim-warp-commands.test.ts`, `e2e/sim-warp.spec.ts`) | sim-warp |

### Colour

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| CL-1 | Lumetri-style grade: basic, creative, curves, colour wheels, HSL secondary, vignette | P0 | done | wp-m2-color plus HSL Secondary, hue-vs curves, vignette with native export (wp-notes/color-grade.md; `apps/web/test/color-grade.test.tsx`, `e2e/color-grade.spec.ts`) | color-grade |
| CL-2 | Lumetri scopes: waveform, parade, vectorscope, histogram | P1 | done | apps/web/src/panels/scopes | — |
| CL-3 | LUT import (.cube) | P1 | done | wp-m2-color | — |
| CL-4 | Colour management: working space, log / HDR input, output transforms | P1 | partial (0.75) | working spaces incl. Rec. 2100 PQ / HLG, 18 log curves, OCIO, HDR exports (wp-notes/color-mgmt.md; `packages/project/test/color-mgmt-*.test.ts`, `e2e/color-mgmt.spec.ts`); no HDR display output (needs HDR hardware), 8-bit composite; stacks whose canvas scopes would nest render through the flat compositor since `compositor` (D-43) | color-mgmt |
| CL-5 | Comparison view, Color Match | P2 | done | Program monitor Comparison View (edit-ux), Colour Match with Face Detection (wp-notes/color-grade.md; `apps/web/test/edit-ux-monitors.test.tsx`, `e2e/color-grade.spec.ts`) | color-grade |

### Audio

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| AU-1 | Clip gain, volume and pan with keyframes; audio in preview and export | P0 | done | S01 audio, D-34 volumes | — |
| AU-2 | Track volume / pan, mute / solo | P0 | done | Audio Track Mixer strips with automation (wp-notes/audio-mix.md; `packages/project/test/audio-mix.test.ts`, `apps/engine/test/audio-mix.test.ts`, `e2e/audio-mix.spec.ts`) | audio-mix |
| AU-3 | Live audio meters | P0 | done | Audio Meters panel: BS.1770 loudness, true peak, peak / RMS (wp-notes/audio-mix.md; `apps/web/test/audio-mix-panels.test.tsx`, `e2e/audio-mix.spec.ts`) | audio-mix |
| AU-4 | Audio Track Mixer and Clip Mixer, submixes | P1 | done | mixers, sends, submixes, automation modes (wp-notes/audio-mix.md; `apps/web/test/audio-mix-panels.test.tsx`, `e2e/audio-mix.spec.ts`); submixes are not timeline rows | audio-mix |
| AU-5 | Audio effects (EQ, dynamics, reverb, noise reduction, pitch) | P1 | done | 60 audio effects in one DSP for preview and export (D-42; wp-notes/audio-fx.md; `packages/audio-fx/test/*`, `apps/engine/test/audio-fx.test.ts`, `e2e/audio-fx.spec.ts`) | audio-fx |
| AU-6 | Essential Sound, loudness normalisation, ducking | P1 | done | Essential Sound panel, two-pass loudness normalisation with true-peak limiter, auto-ducking, Music Remix (wp-notes/audio-mix.md, wp-notes/audio-fx.md; `packages/audio-fx/test/remix.test.ts`, `apps/engine/test/audio-mix.test.ts`) | audio-fx |
| AU-7 | Audio channel mapping (Modify ▸ Audio Channels) | P2 | done | Clip ▸ Modify ▸ Audio Channels: matrix, clip channel format, number of clips, muted channels in preview and export, routings on Project items (wp-notes/gaps.md; `gaps-audio-channels` project + engine tests) | gaps |
| AU-8 | Sound effects library: browse, audition, insert (Essential Sound's "Browse") | P2 | done | Sound Library panel + Sound Design workspace, starter kit (60 CC0 sounds), user folders, peak / end / start-aligned insert exact to the sample, provenance and credits, MCP tools (wp-notes/sound-design.md "Phase 1 verification"; `e2e/sound-library.spec.ts`, `apps/mcp/test/sound.test.ts`, `apps/engine/test/sounds-routes.test.ts`); added by sound-design on `feat/sound-design`, not yet counted in the numbers above | sound-design |

### Captions & speech

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| CP-1 | Caption tracks: create, style, import / export SRT and VTT | P1 | done | caption tracks, styles, SRT / VTT / SCC / MCC import and export, burn-in (wp-notes/captions.md; `packages/project/test/captions-commands.test.ts`, `apps/engine/test/captions-export.test.ts`, `e2e/captions.spec.ts`); burn-in needs the layer bake | captions |
| CP-2 | Speech to text, transcripts, text-based editing | P1 | done | local Whisper (ONNX, CPU), word timings, diarization, captions from transcripts, text-based editing (wp-notes/speech.md; `apps/engine/test/speech.test.ts`, `apps/web/test/speech.test.tsx`, `e2e/speech.spec.ts`) | speech |

### Interchange

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| IX-1 | FCP 7 XML, FCPXML, EDL, AAF, OTIO import and export | P1 | done | plus OMF and ALE, in-process TypeScript (D-40), pre-renders of what a format cannot carry, a report per run (wp-notes/interchange.md; `packages/interchange/test/*`, `apps/engine/test/interchange.test.ts`, `e2e/interchange.spec.ts`); per-format losses listed in its §7 | interchange |

### Export

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| EX-1 | Export mode, presets, planner with native / hybrid / Remotion paths and named blockers | P0 | done | D-11, D-22, D-34, D-35 | — |
| EX-2 | Codecs: H.264 (hardware or OpenH264), VP9, AV1, ProRes, alpha; AAC / Opus | P0 | partial (0.9) | D-13; HEVC Main via libkvazaar (hvc1, BT.709 / PQ / HLG tags), Main10 through hardware encoders only (wp-notes/gaps.md; `apps/engine/test/gaps-export-formats.test.ts`); OpenH264 quality below x264 | gaps |
| EX-3 | Export Frame, Quick Export, export queue | P1 | done | File ▸ Export ▸ Frame (PNG / JPEG / TIFF / DPX / EXR / BMP / Targa, import into project, camera buttons in both monitors, Shift+E); smart-rendered avc3 plays in Chrome and Electron (wp-notes/gaps.md; `gaps-export-frame`, `gaps-avc3-playback`) | gaps |
| EX-4 | Render previews (timeline render bar), smart rendering | P1 | done | render bar with reasons, Render Effects In to Out / In to Out / Selection / Audio, Delete Render Files, previews played by the Program monitor, Export ▸ Use Previews, smart rendering (ProRes; H.264 opt-in) (wp-notes/previews.md; `apps/engine/test/previews.test.ts`, `apps/engine/test/smart-render.test.ts`, `e2e/previews.spec.ts`); no HEVC smart rendering | previews |

### Processing

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| AI-1 | Upscale (SPAN), stabilise, denoise, de-judder as derived media (beyond Premiere) | P2 | done | wp-m2-process | — |
| AI-2 | Scene edit detection, auto reframe, morph cut | P2 | done | Scene Edit Detection (time); Auto Reframe Sequence (faces when installed, else saliency; keyed Position) and Morph Cut on the time workstream's optical flow (wp-notes/gaps.md; `apps/engine/test/gaps-reframe.test.ts`, `packages/compositions/test/transition-premiere-gl.test.ts`) | gaps |

### Project files

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| PF-1 | Autosave, atomic writes, single-writer leases, conflict handling | P0 | done | WP-2E, WP-2F; a reloaded tab keeps its own lease (wp-notes/polish.md §1; `packages/session/test/persistence/tab-leases.test.ts`, `e2e/project-files.spec.ts`) | — |
| PF-2 | Schema migrations, read-only for newer files | P0 | done | migrations.ts | — |
| PF-3 | Crash recovery of unsaved changes | P0 | done | engine-side per-session journal, Recover / Discard (D-39; wp-notes/process.md; `apps/engine/test/recovery-versions.test.ts`, `packages/session/test/persistence/recovery.test.ts`) | process |
| PF-4 | Saved versions: browse and restore | P1 | done | File ▸ Project Versions…, restore in place or as a copy, MCP (wp-notes/process.md; `apps/engine/test/recovery-versions.test.ts`, `apps/mcp/test/versions.test.ts`) | process |
| PF-5 | Save As, Save a Copy, Revert | P1 | done | `app.saveAs`, `app.saveCopy`, `file.revert` (wp-notes/process.md) | process |

### Interface

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| UI-1 | Docked panels, workspaces (save, import, export, reset) | P0 | done | WP-2A | — |
| UI-2 | Premiere default shortcuts, conflict-free keymap | P0 | done | keymap-defaults.ts, keymap.test.ts | — |
| UI-3 | Keyboard Shortcuts editor | P1 | done | Edit ▸ Keyboard Shortcuts… (Ctrl+Alt+K) with layouts and conflict display (wp-notes/edit-ux.md; `apps/web/test/edit-ux-keyboard.test.tsx`) | edit-ux |
| UI-4 | Preferences dialog | P1 | done | pages General, Timeline, Audio, Graphics, Media Cache, Transcription, Processing, Roto & Face Tracking plus Appearance, Auto Save, Labels, Memory, Playback, Trim, Audio Hardware wired to behaviour; Collaboration / Sync Settings omitted (no such services) (wp-notes/gaps.md; `apps/web/test/gaps-preferences.test.tsx`) | gaps |
| UI-5 | Find, Edit Original, Exit | P2 | done | Edit ▸ Find…, Edit Original, File ▸ Exit (desktop) (wp-notes/gaps.md; `apps/web/test/gaps-ui5-tracks.test.tsx`, `apps/engine/test/gaps-routes.test.ts`) | gaps |
| UI-6 | Localisation and accessibility | P2 | done | every UI string externalised at build time (English + complete Spanish, 8 614 strings, `pnpm i18n:check`), language in Preferences ▸ Appearance, switched while the editor runs with the undo history kept (D-46; `e2e/polish.spec.ts` leaves no string behind in either direction), labels built from effect and preset names translated (`apps/web/test/polish-i18n.test.tsx`); ARIA roles/labels, focus rings, reduced motion, high-contrast theme; axe-core audit with no serious or critical violation in six workspaces × two themes (wp-notes/gaps.md; `apps/web/test/i18n.test.ts`, `e2e/gaps.spec.ts`) | gaps |

### Agents

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| AG-1 | MCP server: 338 tools, every edit an undoable transaction, approvals, the `jasper` CLI (beyond Premiere) | P1 | done | wp-mcp, wp-notes/mcp-cli.md, README; tools counted from a live `listTools`; the live-UI tools cannot answer approvals or run gated commands (security-review.md AGT-1, `e2e/security-review.spec.ts`) | mcp-cli |

### Platforms

| Id | Feature | Tier | Status | Evidence | Workstream |
|---|---|---|---|---|---|
| PL-1 | Web, PWA and Electron on Linux | P0 | done | M1-STATUS | — |
| PL-2 | macOS and Windows checked | P0 | partial (0.25) | builds exist; never run (M1-STATUS) | — |

## After the parallel workstreams

Every workstream of the program has merged into `integrate/parity`; nothing is in flight. These merged after the
assessment of 8 October; apart from `gaps` they changed the evidence behind rows, not their grades:

| Workstream | What it added to the rows above |
|---|---|
| `golden-fuzz` | golden frames and fingerprints per effect / transition family, fuzzed loaders, HTTP routes and MCP tools (gaps.md "Stability"; PF-2) |
| `fixups` | Merge Paths at tangencies (GR-2), MCP clip targets (AG-1) |
| `perf-core`, `ui-perf` | the ARCHITECTURE §13 budgets and the editor at 1 000 – 5 000 clips (docs/performance.md) |
| `compositor` | stacks whose canvas scopes would nest render (KF-4, TL-12, GR-6, CL-4; D-43) |
| `gaps` | PRJ-4, PRJ-6, PRJ-8, TL-10, TL-11, FX-6, GR-4, GR-5, AU-7, EX-3, AI-2, UI-4, UI-5, UI-6 to done, EX-2 to 0.9 (wp-notes/gaps.md) |
| `review` | 19 security and integrity fixes with regression tests (docs/security-review.md) |
| `polish` | the last disabled menu entries and dead shortcuts, the Media Browser, lease memory, live language switch, project open (wp-notes/polish.md) |

Rows still partial: CL-4 (HDR display output needs hardware; the composite is 8-bit), EX-2 (HEVC Main10 needs a
hardware encoder; OpenH264 quality), PL-2 (macOS and Windows builds have never run). No workstream is assigned to
them.

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
