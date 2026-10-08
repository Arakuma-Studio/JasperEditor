# Where JasperEditor falls short

An honest assessment of how far JasperEditor is from being a real replacement for Premiere Pro (and for the parts
of After Effects that editors reach for), and the work that closes the gap. It is for contributors and agents
choosing what to work on. [parity.md](parity.md) is the feature-by-feature checklist it builds on.

*Assessed 8 October 2026 at `integrate/parity` after 23 of the 24 parallel workstreams merged (the first assessment
was 7 October at `main` 051cf53). Estimates marked "≈" are judgements from the evidence listed, not measurements.
Update this file when the evidence changes.*

## Two different questions

[parity.md](parity.md) reports **≈ 91% breadth** (it was ≈ 59% before the parallel workstreams). That number answers
one question: *does each Premiere feature exist?* It scores a 92-row catalogue we wrote ourselves, weighted by tier,
graded from the code, the wp-notes and their tests: 75 rows done, 13 partial, 4 missing (P0 97%, P1 89%, P2 79%).
Since 7 October the merged workstreams added the audio mixer, meters, 60 audio effects and loudness tools; nests,
adjustment layers, multicam and time remapping; captions, speech to text and timeline interchange (FCP 7 XML,
FCPXML, EDL, AAF, OMF, ALE, OTIO); masks, roto, expressions, vector shapes, text animators, 3D layers, simulation and
warp effects; colour management with HDR; render previews and smart rendering; crash recovery and saved versions.

It does not answer the question users care about: *can someone who edits in Premiere for a living do real work in
JasperEditor?* Nobody has tried. Our best estimate is **≈ 35–45% ready for real use** (was ≈ 20–30%). Reasoning: the
five blockers of the first assessment were missing features, and four of them now exist with tests (audio,
editing structure, getting work in and out, the safety net), which is why the estimate moves at all. It moves by
far less than breadth because what limits real use now is not measured by a feature list:

1. **Nobody outside has used it.** Every check was ours, on generated media; behaviour against Premiere's
   documentation was researched per feature but never reviewed as a whole workflow.
2. **Platforms**: everything was checked on Linux only; macOS and Windows builds have never run, and hardware
   H.264/HEVC export has never run on a real GPU.
3. **Heavy timelines**: render previews and smart rendering exist now (`previews`), but proxies cannot be toggled
   from the UI, playback was measured only on a CPU-only shared host ([performance.md](performance.md)), and the
   ARCHITECTURE §13 command / gesture budgets are missed; nothing measured at 4K, hour-long or thousands of clips.
4. **Known render limits**: HTML-in-Canvas scopes cannot nest in Chrome (D-43); since `compositor` the stacks whose
   scopes would nest are drawn by one flat GPU compositor, so every combination of linear-light blending, adjustment
   layers with GPU effects, GL blend modes, 3D runs and the HDR display transform renders
   ([wp-notes/compositor.md](wp-notes/compositor.md)); several exports of masked nests, remapped nests and blend modes
   inside nests go through Remotion instead of the native path.
5. **Stability evidence**: golden frames per effect / transition family and fuzzing of loaders, HTTP and MCP are in
   flight (`golden-fuzz`); a fast-check property of the Merge Paths booleans failed once at random before `fixups`
   fixed the library bug behind it, the kind of defect only broader fuzzing finds.

## By dimension

| Dimension | Estimate | Evidence |
|---|---|---|
| Breadth of features | ≈ 91% (P0 97%, P1 89%, P2 79%) | [parity.md](parity.md): 75 done, 13 partial, 4 missing of 92, each changed row citing its wp-note and tests |
| Behaves like Premiere | largely unreviewed as workflows, ≈ 60–75% where it exists | Fidelity comes from research during implementation (Adobe's help pages, parameter references, shortcut lists, published formulas), not from captures of Adobe software; each merged workstream cites its sources in its wp-note. The keymap follows Premiere's published defaults and is conflict-checked (`keymap.test.ts`). Many M1 behaviours (trim modes, sync lock, targeting) follow our own specs S01–S05 without a recorded source review |
| Preview = export | measured for the native paths and the audio mix | Sub-pixel streamed layers: lossless-still parity with Remotion SSIM 0.99999, 0.05 px/frame pans smooth to 0.001 px RMS (D-34); GPU spans and effect bakes: 100% of samples within 3/255 (D-35); one offline mixer renders the audio of every export path (D-42, `apps/engine/test/audio-mix.test.ts`); ffprobe frame counts in `smoke.spec.ts` |
| Opening existing Premiere work | ≈ 40% | No `.prproj` (out of scope); FCP 7 XML, FCPXML, EDL, AAF, OMF and OTIO import with a report of what each format loses (`docs/wp-notes/interchange.md` §7). Not tried on real projects exported by Premiere |
| Stability | improving, partly measured | Atomic writes, leases, 409 handling, invariant repair, a crash-recovery journal and saved versions (D-39, `apps/engine/test/recovery-versions.test.ts`); `fast-check` property tests and a 10 000-transaction invariant fuzz in `packages/project`. Golden frames and fuzzing of media, HTTP and MCP inputs are in flight (`golden-fuzz`); no crash reports from users |
| Real-user experience | unknown | No outside users yet. The October audits (`docs/audits/`) are internal |
| Performance | internal numbers only | README "Performance measurements"; first export ≈ 2× the warp stage and 9–14× Remotion (D-34). Render previews and a perf monitor exist (`previews`, [performance.md](performance.md)); nothing at 4K with long timelines, nothing on GPUs |
| Media formats | ≈ 75% | Everything the LGPL FFmpeg 7.1 decodes, plus image sequences, layered PSD, PDF / Illustrator, SVG, Lottie, EXR / DPX / HEIC / JPEG XL stills (`docs/wp-notes/imports.md`); export H.264 (OpenH264 or hardware), VP9, AV1, ProRes, 10/12-bit HDR. No software HEVC export; camera RAW not supported |
| AI-assisted tools | ≈ 60% | SPAN upscaler, stabilisation, denoise, de-judder; OpenCV tracking; local speech to text with diarization (`docs/wp-notes/speech.md`); SAM 2.1 roto and face tracking (`docs/wp-notes/roto.md`); scene edit detection and optical flow (`docs/wp-notes/time.md`); Music Remix (`docs/wp-notes/audio-fx.md`). No auto reframe, morph cut or enhance speech; all models run on the CPU |
| Platforms | Linux only | Web, PWA and Electron on Linux (M1-STATUS); macOS / Windows packaging written, never run |
| Maturity | early | First commit 29 September 2026. ≈ 530,000 lines of TypeScript and scripts (tests included), almost entirely agent-written; 489 test files and 47 Playwright specs (counted with `git ls-files`) |

## Workstreams

Twenty-four workstreams ran in parallel (branches `feat/<name>`, merged through `integrate/parity`). Each says what
"done" means, so progress is checked rather than self-graded. 23 have merged and are counted in the numbers above
with their evidence; `golden-fuzz` is still running and is not counted.

### mcp-cli
Agents drive everything without a window: a CLI over the same command catalogue and MCP depth (every UI command
reachable, batch steps, rendered checks). **Done when:** each File/Edit/Clip/Sequence menu command is reachable from
MCP or the CLI with a JSON schema, a scripted end-to-end session (import → edit → grade → export) runs headless in
CI, and the README tool list is checked by a test.
**Status (merged):** done for MCP depth and the CLI — see [wp-notes/mcp-cli.md](wp-notes/mcp-cli.md): the `jasper` CLI over the same tools, `ui_*` tools that drive the live window, 299 MCP tools with a README list checked by `apps/mcp/test/readme-tools.test.ts`, `e2e/agent-ui.spec.ts`. The headless session in CI belongs to `golden-fuzz` (in flight). `fixups` made clip targets aim at their visible part and fixed a bundle that did not load (`apps/mcp/test/bundle.test.ts`).

### keyframes-blend
Premiere's full keyframe and blend-mode behaviour. **Done when:** all 27 Premiere blend modes exist in the model,
preview and native export (oracle-tested against the published formulas), keyframe interpolation covers linear,
Bezier, auto Bezier, continuous Bezier, hold, ease in/out with temporal and spatial variants, and every one is
editable in Effect Controls and through MCP.
**Status (merged):** done — see [wp-notes/keyframes-blend.md](wp-notes/keyframes-blend.md): Premiere's 27 blend modes native and in preview (oracle `blendPixel`, Remotion parity 31/31 in `apps/engine/test/blend-remotion.e2e.test.ts`), auto / continuous Bezier and the temporal / spatial variants. Limits: blend modes inside nests export through Remotion; GL modes need HTML-in-Canvas (scope nesting lifted by `compositor`).

### golden-fuzz
Evidence that features stay correct. **Done when:** golden-frame tests pin preview and export output for every effect
family and transition family, project loading, HTTP routes and MCP arguments are fuzzed under a never-crash
harness, and every crash found has a regression test.
**Status: in flight** (not merged when this was assessed; not counted).

### audio-mix
**Done when:** the Audio Meters show live levels (peak and RMS, clipping) during playback and export, an Audio Track
Mixer and Clip Mixer edit track and clip volume / pan / mute / solo with automation, submixes route tracks, Modify ▸
Audio Channels maps channels, and exports match the preview mix (sample-level oracle test).
**Status (merged):** partial — see [wp-notes/audio-mix.md](wp-notes/audio-mix.md): meters, both mixers, submixes, sends, automation, loudness (oracle against ffmpeg `ebur128` and EBU Tech 3341/3342), voice-over, exports from the same offline mixer (D-42). Not done: Clip ▸ Audio Channels… (the model has clip channel selection and track channel formats; the dialog is unregistered); submixes are not timeline rows.

### audio-fx
**Done when:** the core Premiere audio effects (parametric EQ, compressor, limiter, DeNoise, DeReverb, delay, reverb,
pitch shifter, channel volume) apply to clips and tracks with keyframes in preview and export, exponential fades
join the crossfades, and loudness normalisation (EBU R128 / ITU-R BS.1770, checked against ffmpeg `ebur128`) and
auto-ducking work as in Essential Sound.
**Status (merged):** done — see [wp-notes/audio-fx.md](wp-notes/audio-fx.md): 60 audio effects in one DSP (D-42), Exponential Fade, Essential Sound, Music Remix, auto-ducking (`packages/audio-fx/test/*`, `e2e/audio-fx.spec.ts`). Limits: preview latency of track inserts is not compensated (export is).

### captions
**Done when:** caption tracks can be created, edited and styled in the timeline and Program monitor, import and export
SRT and WebVTT (round-trip tests), burn in on every export path, and are drivable over MCP.
**Status (merged):** done — see [wp-notes/captions.md](wp-notes/captions.md) (`e2e/captions.spec.ts`, `apps/engine/test/captions-export.test.ts`). Limits: burn-in needs the layer bake (no libass in the LGPL build), CEA-608 in H.264 SEI is not written.

### speech
**Done when:** a local speech-to-text model (permissive licence, on-demand download) transcribes clips into
transcripts with word timings, captions can be generated from them, and text-based editing (delete words → ripple
the timeline) works as one undoable step.
**Status (merged):** done — see [wp-notes/speech.md](wp-notes/speech.md): local Whisper (ONNX, CPU) with word timings, diarization, captions from transcripts, text-based editing (`e2e/speech.spec.ts`). Limits: CPU only, Linux only checked, classical diarization.

### interchange
**Done when:** FCP 7 XML, FCPXML, EDL (CMX 3600), AAF and OTIO import and export sequences with clips, tracks, transitions,
markers and basic effects, with round-trip tests through the reference implementations' fixtures.
**Status (merged):** done — see [wp-notes/interchange.md](wp-notes/interchange.md): FCP 7 XML, FCPXML, EDL, AAF, OMF, ALE and OTIO in process (D-40), round trips tested (`packages/interchange/test/*`), pre-renders of what a format cannot carry, Link Media. Per-format losses in its §7; never tried on files exported by Premiere.

### edit-structure
**Done when:** nested sequences (Nest…, sequences as clips, open in timeline), group / ungroup, adjustment layers,
color mattes and other synthetic items, sequence duplicate / delete and Remove Unused all work end to end; no
document command answers `E_NOT_IMPLEMENTED`.
**Status (merged):** done — see [wp-notes/edit-structure.md](wp-notes/edit-structure.md). Remaining limits: audio
effects on a nest act on each flattened piece; a masked nest or adjustment clip and a Track Matte Key export through
Remotion, not natively; adjustment layers in a Player without HTML-in-Canvas show unadjusted with a chip; the
Sequence Settings dialog is edit-ux's.

### edit-ux
**Done when:** every remaining disabled File/Edit/Clip/Sequence/View menu entry is wired (Project and Sequence Settings,
Match Frame, Add/Delete Tracks, rulers and guides, Find, Keyboard Shortcuts editor, Preferences pages), each with
Premiere's default shortcut where one exists and a keymap test.
**Status (merged):** partial — see [wp-notes/edit-ux.md](wp-notes/edit-ux.md): Match Frame, Speed/Duration, rulers and guides, Keyboard Shortcuts editor with layouts, Trim Monitor, comparison view, subclips and more. Still unregistered (15 menu entries in all): Project Settings, Add / Delete Tracks, Find, Edit Original, Exit, Clip ▸ Rename, Audio Channels, Create Proxies, Export ▸ Frame (`previews`).

### multicam
**Done when:** a multi-camera source sequence with ≥ 4 angles synced by timecode, audio or in points can be created,
switched live in the Program monitor's multi-camera view, recorded as cuts, flattened, previewed and exported natively.
**Status (merged):** done — see [wp-notes/multicam.md](wp-notes/multicam.md): built on nests (D-44), sync by timecode / audio / in points, live switching, flatten, native and Remotion export (`apps/engine/test/multicam-export.test.ts`, `e2e/multicam.spec.ts`). Limits: the Multi-Camera view decodes every angle at full size.

### time
**Done when:** Speed/Duration (with ripple and reverse), time remapping with speed keyframes, frame hold, and frame
sampling / frame blending / optical flow render identically in preview and export.
**Status (merged):** done — see [wp-notes/time.md](wp-notes/time.md): time remapping with speed keyframes, Frame Sampling / Blending / Optical Flow, reverse playback, scene edit detection (`apps/engine/test/time-export.test.ts`, `e2e/time.spec.ts`). Limits: remapped nests export through Remotion; nests support Frame Sampling only.

### masks
**Done when:** ellipse, 4-point polygon and pen masks with feather, opacity, expansion and invert apply to effects and
clip opacity, are keyframable, track forward/backward, and export natively.
**Status (merged):** done — see [wp-notes/masks.md](wp-notes/masks.md): masks on effects and Opacity with tracking; Opacity masks export natively (≤ 3/255, `apps/engine/test/masks-export.test.ts`), effect masks through the layer bake. Limits: the CSS fallback covers Opacity masks only; no mask motion blur.

### roto
**Done when:** a segmentation model (permissive licence) propagates a roto mask across frames with manual correction,
usable as a track matte or effect mask, measured on synthetic clips (IoU) and documented.
**Status (merged):** done — see [wp-notes/roto.md](wp-notes/roto.md): SAM 2.1 tiny (Apache-2.0, downloaded on
request) + graph cut, propagation with corrections, Object Matte / Object Blur effects (compose with effect masks,
usable as a Track Matte source since the Track Matte Key reads the matte track's finished picture — not separately
tested —, Convert to Masks), IoU 0.98 on the synthetic plate. Limits: CPU speed with the model
(≈ 3 s per 640×360 frame unloaded), refine mattes' temporal controls read the source, no default tool key.

### expressions
**Done when:** After Effects-style expressions (JavaScript, `time`, `value`, `wiggle`, `loopOut`, property links)
drive any keyframable property deterministically in preview and export, sandboxed, with errors shown in Effect Controls.
**Status (merged):** done — see [wp-notes/expressions.md](wp-notes/expressions.md): QuickJS-wasm (D-41), deterministic in every path, errors in Effect Controls (`packages/expressions/test/*`, `e2e/expressions.spec.ts`). Limits: `sampleImage` exact on solids only; faders, audio effects and mask paths take no expressions.

### text-animators
**Done when:** After Effects-style text animators (range selectors by character / word / line, animated properties)
and an Essential Graphics panel (layers, alignment, responsive pins, rolling and crawling titles) work in preview
and export, and templates can be saved and reused.
**Status (merged):** partial — see [wp-notes/text-animators.md](wp-notes/text-animators.md): AE text animators with range / wiggly / expression selectors, text on a path, typography (`e2e/text-animators.spec.ts`). Not done: the Essential Graphics panel (layers, align, responsive pins) and rolling / crawling titles (parity GR-5).

### shapes
**Done when:** shape layers carry pen paths, polygons, stars, groups, fills, strokes, trim paths and repeaters, editable
on canvas and exported natively.
**Status (merged):** done — see [wp-notes/shapes.md](wp-notes/shapes.md): vector shapes with groups, Bézier paths, gradients, the path operators (trim paths and repeaters included), Pen / Polygon / Star tools, SVG import (`packages/project/test/vector/*`, `e2e/vector-shapes.spec.ts`). `fixups` fixed Merge Paths collapsing at tangencies (a PathBool.js bug, D-45).

### sim-warp
**Done when:** the simulation and warp effects editors use (particles, mesh warp, liquify, turbulent displace, a Warp
Stabilizer-style effect with in-clip analysis) render deterministically in preview and export.
**Status (merged):** partial — see [wp-notes/sim-warp.md](wp-notes/sim-warp.md): the 18 After Effects simulation
effects + Card Wipe and Bezier Warp, Mesh Warp, Liquify, Puppet, Displacement Map, Optics Compensation, Polar
Coordinates, Reshape, Smear as deterministic GPU effects (seek = play, GL tests per effect, export via the layer
bake verified by extracted frames), Program-monitor Puppet / Liquify / Mesh Warp tools, MCP tools. Turbulent Displace
existed already. Not done here: a Warp Stabilizer-style *effect* (stabilisation is a clip-processing recipe),
Comp Camera / Lights for the 3D simulations, Puppet Sketch recording in the UI.

### three-d
**Done when:** 3D layers with a camera and lights (After Effects overlap) position and render text, shapes and footage
in preview and export with tests against analytic projections.
**Status (merged):** done — see [wp-notes/three-d.md](wp-notes/three-d.md): classic and advanced 3D, cameras, lights, glTF models, a 3D camera tracker (`packages/compositions/test/three-d-gl.test.ts`, `e2e/three-d.spec.ts`). Limits: no transitions on 3D layers; the black capture of video below a 3D run in headless Program-monitor captures was fixed by `previews` (`capture-safe-canvas.ts`).

### imports
**Done when:** image sequences, layered PSD and Illustrator files, relinking with a Link Media dialog, and Project
Manager (collect / consolidate) work, each with fixtures generated by `pnpm fixtures`.
**Status (merged):** partial — image sequences, layered PSD (flattened / merged / individual / Sequence), PDF and
Illustrator pages, SVG, Lottie (import and export), EXR/TIFF/TGA/BMP/DPX/HEIC/JPEG XL and Interpret Footage are done,
see [wp-notes/imports.md](wp-notes/imports.md); Link Media came with interchange. Not done: Project Manager (collect /
consolidate). Remaining limits: Lottie clips are not editable layers, PSD adjustment layers / layer styles / CMYK
layers are not carried, Illustrator layers are not split, EPS is not read (wp-note §11).

### color-mgmt
**Done when:** projects have a working colour space (Rec.709, Rec.2100 PQ/HLG), clips can be interpreted (log
profiles, colour space overrides), and preview and export apply the right transforms, checked against published
transfer functions.
**Status (merged):** done — see [wp-notes/color-mgmt.md](wp-notes/color-mgmt.md). This covers:
- working spaces: Rec. 709 / sRGB / Rec. 2020 / P3 / Rec. 2100 PQ and HLG, plus linear variants;
- Blend Using 1.0 Gamma;
- interpretation of media and clips: 18 log curves, 16 gamuts, custom OCIO configs;
- BT.2390 tone mapping and ACES RGC;
- 10/12-bit HDR exports with tags and mdcv/clli metadata;
- `.cube` shaper / 1D, `.3dl`, `.spi1d/.spi3d/.csp` with tetrahedral interpolation;
- Lumetri HDR White and HDR Specular, and an HDR scale for the scopes.

Remaining limits:
- the HDR monitor is tone mapped (no HDR display output);
- no HEVC Main10 in the LGPL build;
- the composite is 8-bit encoded;
- linear-light compositing renders on the Remotion path only;

### color-grade
**Done when:** Lumetri's HSL secondary, hue-vs curves, vignette, comparison view and Color Match exist, each with
oracle tests of the maths and native export.
**Status (merged):** done — see [wp-notes/color-grade.md](wp-notes/color-grade.md): HSL Secondary, hue-vs curves, vignette, Colour Match with Face Detection, Lumetri Scopes upgrade (`apps/web/test/color-grade.test.tsx`, `e2e/color-grade.spec.ts`). Limits: eyedroppers sample the displayed picture; no Basic Correction Intensity slider.

### previews
**Done when:** the timeline shows a render bar, Render In to Out caches previews that playback uses, proxies can be
created, attached and toggled, and File ▸ Export ▸ Frame writes the frame the Program monitor shows.
**Status (merged):** render previews done — see [wp-notes/previews.md](wp-notes/previews.md): render bar with a
cost model, Render Effects In to Out / In to Out / Selection / Audio, Delete Render Files, content-hashed preview
files the Program monitor plays, Export ▸ Use Previews, smart rendering (H.264 opt-in, ProRes), the Player stall
root cause, perf instrumentation ([performance.md](performance.md)). Proxies and Export Frame predate this workstream
and were not reworked. Remaining limits: no HEVC smart rendering; browser playback of mixed-parameter `avc3` smart
renders unverified; razor cuts re-render both halves; ARCHITECTURE §13 command / gesture budgets missed. Canvas-scope
nesting (wp-note §5) was lifted by the compositor workstream ([wp-notes/compositor.md](wp-notes/compositor.md)).

### process
Guardrails and the project format: AGENTS.md / CLAUDE.md, layering and asset-attribution lints, ported-source
notices, schema-history fixtures, the crash-recovery journal, saved versions with restore, Save As / Save a Copy /
Revert ([project-files.md](project-files.md)). **Done when:** `pnpm lint` enforces layering and attribution, every
schema version has a fixture that loads, unsaved edits survive a killed editor and are offered on the next open,
and saved versions can be restored from the File menu and over MCP.
**Status (merged):** done — see [wp-notes/process.md](wp-notes/process.md): AGENTS.md, layering and asset lints, ported-source notices, crash-recovery journal and versions (D-39). It removed 11 screenshots of unknown provenance; `fixups` replaced them with renders of generated media (ATTRIBUTION.md).

### Not covered by any workstream yet

- **Platforms**: run and fix the desktop app on macOS and Windows; hardware H.264/HEVC export on real GPUs.
- **Left over from the merged workstreams** (parity rows partial or missing): Essential Graphics panel and rolling /
  crawling titles (GR-5), MOGRT import (GR-4), Project Manager (PRJ-6), a Warp Stabilizer-style effect (FX-6), the
  15 unregistered menu entries (Project Settings, Add / Delete Tracks, Audio Channels, Find, Edit Original, Exit…),
  more Preferences pages, auto reframe and morph cut (AI-2).
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
