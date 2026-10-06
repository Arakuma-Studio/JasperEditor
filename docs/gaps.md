# Where JasperEditor falls short

An honest assessment of how far JasperEditor is from being a real replacement for Premiere Pro (and for the parts
of After Effects that editors reach for), and the work that closes the gap. It is for contributors and agents
choosing what to work on. [parity.md](parity.md) is the feature-by-feature checklist it builds on.

*Assessed 7 October 2026 at `main` 051cf53. Estimates marked "≈" are judgements from the evidence listed, not
measurements. Update this file when the evidence changes.*

## Two different questions

[parity.md](parity.md) reports **≈ 59% breadth**. That number answers one question: *does each Premiere feature
exist?* It scores a 92-row catalogue we wrote ourselves, weighted by tier, partial features counting half, graded
from the code and the wp-notes. The core is broad (85% of the P0 rows): a docked Premiere-style shell, a real
timeline with ripple / roll / slip / slide, 339 video effects and 172 transitions on the GPU, keyframes with
graphs and motion paths, a Lumetri-style grade with scopes, tracking with corner pin, text and templates, and
native exports that stay native with GPU effects. The rest is thin: 40% of the P1 rows.

It does not answer the question users care about: *can someone who edits in Premiere for a living do real work in
JasperEditor?* Nobody has tried. Our best estimate is **≈ 20–30% ready for real use**, limited mainly by:

1. **Audio**: no live meters, no mixer, no audio effects, no loudness tools. Almost every delivery needs them.
2. **Editing structure**: no nested sequences, multicam, adjustment layers, time remapping or sequence
   duplication; 13 of 90 document commands still answer `E_NOT_IMPLEMENTED`, and 31 of 148 menu entries render
   disabled.
3. **Getting work in and out**: no captions, no transcripts, no FCP XML / EDL / AAF / OTIO.
4. **Platforms and users**: everything was checked on Linux only; macOS and Windows builds have never run, and
   there are no outside users or bug reports yet.
5. **Safety net**: no crash recovery of unsaved edits and no way to restore a saved version on `main`.

## By dimension

| Dimension | Estimate | Evidence |
|---|---|---|
| Breadth of features | ≈ 59% (P0 85%, P1 40%, P2 28%) | [parity.md](parity.md): 39 done, 18 partial, 35 missing of 92 |
| Behaves like Premiere | largely unreviewed, ≈ 60–75% where it exists | Fidelity comes from research during implementation (Adobe's help pages, parameter references, shortcut lists, published formulas), not from captures of Adobe software. The keymap follows Premiere's published defaults and is conflict-checked (`keymap.test.ts`); the effect and transition families cite their sources in their wp-notes. Many M1 behaviours (trim modes, sync lock, targeting) follow our own specs S01–S05 without a recorded source review |
| Preview = export | measured for the native paths | Sub-pixel streamed layers: lossless-still parity with Remotion SSIM 0.99999, 0.05 px/frame pans smooth to 0.001 px RMS (D-34); GPU spans and effect bakes: 100% of samples within 3/255 of the composition (D-35); ffprobe frame counts in `smoke.spec.ts` |
| Opening existing Premiere work | ≈ 0% | No `.prproj` (out of scope) and no interchange formats yet (IX-1) |
| Stability | improving, unmeasured | Atomic writes, leases, 409 conflict handling, invariant repair on load; `fast-check` property tests and a 10 000-transaction invariant fuzz in `packages/project`. No crash-recovery journal on `main`, no fuzzing of media files or HTTP/MCP inputs, no crash reports from users |
| Real-user experience | unknown | No outside users yet. The October audits (`docs/audits/`) are internal |
| Performance | internal numbers only | README "Performance measurements": snapshot, selection, transition-index and cache microbenchmarks; first export ≈ 2× the warp stage and 9–14× Remotion (D-34). Nothing at 4K with long timelines, nothing on GPUs (hardware H.264 has never run) |
| Media formats | ≈ 70% | Everything the LGPL FFmpeg 7.1 decodes; export H.264 (OpenH264 or hardware), VP9, AV1, ProRes 422/4444. No software HEVC export; OpenH264 quality is below x264 at equal bitrate; camera RAW formats are not supported |
| AI-assisted tools | ≈ 30% | SPAN 2× upscaler (ONNX), vid.stab stabilisation, denoise, de-judder as derived media; OpenCV tracking. No speech to text, scene detection, auto reframe or enhance speech |
| Platforms | Linux only | Web, PWA and Electron on Linux (M1-STATUS); macOS / Windows packaging written, never run |
| Maturity | early | First commit 29 September 2026. ≈ 280,000 lines of almost entirely agent-written TypeScript, 256 test files and 23 Playwright specs |

## Workstreams

Twenty-four workstreams are landing in parallel now (branches `feat/<name>`, merged through `integrate/parity`).
Each says what "done" means, so progress is checked rather than self-graded. None is counted in the numbers above
until it has merged and its evidence is recorded.

### mcp-cli
Agents drive everything without a window: a CLI over the same command catalogue and MCP depth (every UI command
reachable, batch steps, rendered checks). **Done when:** each File/Edit/Clip/Sequence menu command is reachable from
MCP or the CLI with a JSON schema, a scripted end-to-end session (import → edit → grade → export) runs headless in
CI, and the README tool list is checked by a test.

### keyframes-blend
Premiere's full keyframe and blend-mode behaviour. **Done when:** all 27 Premiere blend modes exist in the model,
preview and native export (oracle-tested against the published formulas), keyframe interpolation covers linear,
Bezier, auto Bezier, continuous Bezier, hold, ease in/out with temporal and spatial variants, and every one is
editable in Effect Controls and through MCP.

### golden-fuzz
Evidence that features stay correct. **Done when:** golden-frame tests pin preview and export output for every effect
family and transition family, project loading, HTTP routes and MCP arguments are fuzzed under a never-crash
harness, and every crash found has a regression test.

### audio-mix
**Done when:** the Audio Meters show live levels (peak and RMS, clipping) during playback and export, an Audio Track
Mixer and Clip Mixer edit track and clip volume / pan / mute / solo with automation, submixes route tracks, Modify ▸
Audio Channels maps channels, and exports match the preview mix (sample-level oracle test).

### audio-fx
**Done when:** the core Premiere audio effects (parametric EQ, compressor, limiter, DeNoise, DeReverb, delay, reverb,
pitch shifter, channel volume) apply to clips and tracks with keyframes in preview and export, exponential fades
join the crossfades, and loudness normalisation (EBU R128 / ITU-R BS.1770, checked against ffmpeg `ebur128`) and
auto-ducking work as in Essential Sound.

### captions
**Done when:** caption tracks can be created, edited and styled in the timeline and Program monitor, import and export
SRT and WebVTT (round-trip tests), burn in on every export path, and are drivable over MCP.

### speech
**Done when:** a local speech-to-text model (permissive licence, on-demand download) transcribes clips into
transcripts with word timings, captions can be generated from them, and text-based editing (delete words → ripple
the timeline) works as one undoable step.

### interchange
**Done when:** FCP 7 XML, FCPXML, EDL (CMX 3600), AAF and OTIO import and export sequences with clips, tracks, transitions,
markers and basic effects, with round-trip tests through the reference implementations' fixtures.

### edit-structure
**Done when:** nested sequences (Nest…, sequences as clips, open in timeline), group / ungroup, adjustment layers,
color mattes and other synthetic items, sequence duplicate / delete and Remove Unused all work end to end; no
document command answers `E_NOT_IMPLEMENTED`.

### edit-ux
**Done when:** every remaining disabled File/Edit/Clip/Sequence/View menu entry is wired (Project and Sequence Settings,
Match Frame, Add/Delete Tracks, rulers and guides, Find, Keyboard Shortcuts editor, Preferences pages), each with
Premiere's default shortcut where one exists and a keymap test.

### multicam
**Done when:** a multi-camera source sequence with ≥ 4 angles synced by timecode, audio or in points can be created,
switched live in the Program monitor's multi-camera view, recorded as cuts, flattened, previewed and exported natively.

### time
**Done when:** Speed/Duration (with ripple and reverse), time remapping with speed keyframes, frame hold, and frame
sampling / frame blending / optical flow render identically in preview and export.

### masks
**Done when:** ellipse, 4-point polygon and pen masks with feather, opacity, expansion and invert apply to effects and
clip opacity, are keyframable, track forward/backward, and export natively.

### roto
**Done when:** a segmentation model (permissive licence) propagates a roto mask across frames with manual correction,
usable as a track matte or effect mask, measured on synthetic clips (IoU) and documented.

### expressions
**Done when:** After Effects-style expressions (JavaScript, `time`, `value`, `wiggle`, `loopOut`, property links)
drive any keyframable property deterministically in preview and export, sandboxed, with errors shown in Effect Controls.

### text-animators
**Done when:** After Effects-style text animators (range selectors by character / word / line, animated properties)
and an Essential Graphics panel (layers, alignment, responsive pins, rolling and crawling titles) work in preview
and export, and templates can be saved and reused.

### shapes
**Done when:** shape layers carry pen paths, polygons, stars, groups, fills, strokes, trim paths and repeaters, editable
on canvas and exported natively.

### sim-warp
**Done when:** the simulation and warp effects editors use (particles, mesh warp, liquify, turbulent displace, a Warp
Stabilizer-style effect with in-clip analysis) render deterministically in preview and export.

### three-d
**Done when:** 3D layers with a camera and lights (After Effects overlap) position and render text, shapes and footage
in preview and export with tests against analytic projections.

### imports
**Done when:** image sequences, layered PSD and Illustrator files, relinking with a Link Media dialog, and Project
Manager (collect / consolidate) work, each with fixtures generated by `pnpm fixtures`.

### color-mgmt
**Done when:** projects have a working colour space (Rec.709, Rec.2100 PQ/HLG), clips can be interpreted (log
profiles, colour space overrides), and preview and export apply the right transforms, checked against published
transfer functions.

### color-grade
**Done when:** Lumetri's HSL secondary, hue-vs curves, vignette, comparison view and Color Match exist, each with
oracle tests of the maths and native export.

### previews
**Done when:** the timeline shows a render bar, Render In to Out caches previews that playback uses, proxies can be
created, attached and toggled, and File ▸ Export ▸ Frame writes the frame the Program monitor shows.

### process
Guardrails and the project format: AGENTS.md / CLAUDE.md, layering and asset-attribution lints, ported-source
notices, schema-history fixtures, the crash-recovery journal, saved versions with restore, Save As / Save a Copy /
Revert ([project-files.md](project-files.md)). **Done when:** `pnpm lint` enforces layering and attribution, every
schema version has a fixture that loads, unsaved edits survive a killed editor and are offered on the next open,
and saved versions can be restored from the File menu and over MCP.

### Not covered by any workstream yet

- **Platforms**: run and fix the desktop app on macOS and Windows; hardware H.264/HEVC export on real GPUs.
- **Real-user reliability**: get outside users, triage their reports within a day, a regression test per fix.
- **Performance at scale**: 4K multi-layer timelines, hour-long projects, thousands of clips; track the numbers.
- **Audio plug-ins** (VST3 / AU) and more codecs (software HEVC export, camera RAW).
- **Behaviour review**: a documented-behaviour pass (helpx references) over the M1 editing features whose specs
  never cited Adobe's documentation.
- **Reach**: localisation, accessibility (keyboard navigation, screen readers, contrast), user documentation.

## For agents choosing work

1. Read [CLAUDE.md](../CLAUDE.md), then this file. Prefer a gap in a feature parity.md marks as done over a new
   feature: a feature that exists but behaves differently from Premiere's documented behaviour is not done.
2. Fidelity comes from research, not measurement: cite the Adobe documentation and formulas you followed in your
   wp-note, and say so where behaviour is undocumented and you chose.
3. When you fix a behaviour bug in a feature marked done, add it to the evidence above. That is how this assessment
   stays honest.
4. **Don't raise parity.md's numbers without evidence**: a test, a measurement or a user-facing check that a reviewer
   can rerun, recorded in the wp-note and here. The integrator refreshes both numbers after the parallel workstreams
   merge.
