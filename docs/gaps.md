# Where JasperEditor falls short

An honest assessment of how far JasperEditor is from being a real replacement for Premiere Pro (and for the parts
of After Effects that editors reach for), and the work that closes the gap. It is for contributors and agents
choosing what to work on. [parity.md](parity.md) is the feature-by-feature checklist it builds on.

*Assessed 10 October 2026 at `integrate/parity` with every workstream of the parity program merged: the 24
parallel ones and the follow-ups `fixups`, `perf-core`, `compositor`, `ui-perf`, `gaps`, `review` and `polish`
(the first assessment was 7 October at `main` 051cf53). Estimates marked "≈" are judgements from the evidence
listed, not measurements. Update this file when the evidence changes.*

## Two different questions

[parity.md](parity.md) reports **≈ 98% breadth** (it was ≈ 59% before the parallel workstreams and ≈ 91% before
`gaps`). That number answers one question: *does each Premiere feature exist?* It scores a 92-row catalogue we
wrote ourselves, weighted by tier, graded from the code, the wp-notes and their tests: 89 rows done, 3 partial,
0 missing (P0 97%, P1 99%, P2 100%).
Since 7 October the merged workstreams added the audio mixer, meters, 60 audio effects and loudness tools; nests,
adjustment layers, multicam and time remapping; captions, speech to text and timeline interchange (FCP 7 XML,
FCPXML, EDL, AAF, OMF, ALE, OTIO); masks, roto, expressions, vector shapes, text animators, 3D layers, simulation and
warp effects; colour management with HDR; render previews and smart rendering; crash recovery and saved versions.

It does not answer the question users care about: *can someone who edits in Premiere for a living do real work in
JasperEditor?* Nobody has tried. Our best estimate is **≈ 40–50% ready for real use** (was ≈ 20–30% on 7 October,
≈ 35–45% on 8 October). Reasoning: the five blockers of the first assessment were missing features, and four of
them now exist with tests (audio, editing structure, getting work in and out, the safety net); since 8 October the
evidence behind them grew — golden frames and fuzzing (`golden-fuzz`), the editing-core and UI budgets at 1 000 to
5 000 clips (`perf-core`, `ui-perf`), an adversarial security and integrity review with a property test over 32
kinds of edits (`review`), the flat compositor (`compositor`) and the last disabled menu entries (`polish`). The
estimate still moves by far less than breadth, because what limits real use is not measured by a feature list:

1. **Nobody outside has used it.** Every check was ours, on generated media; behaviour against Premiere's
   documentation was researched per feature but never reviewed as a whole workflow.
2. **Platforms**: everything was checked on Linux only; macOS and Windows builds have never run, and hardware
   H.264/HEVC export has never run on a real GPU.
3. **Heavy timelines**: render previews, smart rendering and proxies (create, attach, toggle) exist, the
   ARCHITECTURE §13 command and gesture budgets are met on 1 000 clips, 5 000 clips scroll and zoom at ≥ 50 fps and a
   2 000-item project opens in 2–3 s ([performance.md](performance.md) §4–§6) — all on a CPU-only shared host in
   headless Chrome. Nothing was measured at 4K, on hour-long programmes, or on a GPU; the scripted 11-clip drag
   misses its 1.5 s wall-time target (≈ 2.0 s).
4. **Known render limits**: HTML-in-Canvas scopes cannot nest in Chrome (D-43); since `compositor` the stacks whose
   scopes would nest are drawn by one flat GPU compositor, so every combination of linear-light blending, adjustment
   layers with GPU effects, GL blend modes, 3D runs and the HDR display transform renders
   ([wp-notes/compositor.md](wp-notes/compositor.md)); several exports of masked nests, remapped nests and blend modes
   inside nests go through Remotion instead of the native path.
5. **Stability evidence**: golden frames and fingerprints per effect and transition family and never-crash fuzzing
   of loaders, HTTP routes and MCP tools exist (`golden-fuzz`, [testing.md](testing.md)); the security review's
   integrity property found two refused-edit bugs in common operations (splitting a text clip with an animator,
   shortening a placed nest) that every per-feature suite had missed ([security-review.md](security-review.md)), and
   `polish` found that `jasper-mg` had not built since the asset sidecars landed. Defects of that kind — interactions
   between workstreams — are what remains to be found, and only use finds them reliably.

## By dimension

| Dimension | Estimate | Evidence |
|---|---|---|
| Breadth of features | ≈ 98% (P0 97%, P1 99%, P2 100%) | [parity.md](parity.md): 89 done, 3 partial (CL-4, EX-2, PL-2), 0 missing of 92, each changed row citing its wp-note and tests; every menubar entry (291) and default shortcut resolves to a command (`apps/web/test/polish-menu-wiring.test.ts`) |
| Behaves like Premiere | largely unreviewed as workflows, ≈ 60–75% where it exists | Fidelity comes from research during implementation (Adobe's help pages, parameter references, shortcut lists, published formulas), not from captures of Adobe software; each merged workstream cites its sources in its wp-note. The keymap follows Premiere's published defaults and is conflict-checked (`keymap.test.ts`). Many M1 behaviours (trim modes, sync lock, targeting) follow our own specs S01–S05 without a recorded source review |
| Preview = export | measured for the native paths and the audio mix | Sub-pixel streamed layers: lossless-still parity with Remotion SSIM 0.99999, 0.05 px/frame pans smooth to 0.001 px RMS (D-34); GPU spans and effect bakes: 100% of samples within 3/255 (D-35); one offline mixer renders the audio of every export path (D-42, `apps/engine/test/audio-mix.test.ts`); ffprobe frame counts in `smoke.spec.ts` |
| Opening existing Premiere work | ≈ 40% | No `.prproj` (out of scope); FCP 7 XML, FCPXML, EDL, AAF, OMF and OTIO import with a report of what each format loses (`docs/wp-notes/interchange.md` §7). Not tried on real projects exported by Premiere |
| Stability | measured by our own suites, unproven in use | Atomic writes, leases (a reloaded tab keeps its own, `polish`), 409 handling, invariant repair, a crash-recovery journal and saved versions (D-39, `apps/engine/test/recovery-versions.test.ts`); `fast-check` property tests and a 10 000-transaction invariant fuzz in `packages/project`; golden frames, fingerprints of every GPU effect and transition, fuzzed loaders, HTTP routes and MCP tools (`golden-fuzz`, [testing.md](testing.md)); a session-level integrity property over 32 kinds of edits with undo / redo / save round trips, and 19 security findings fixed with regression tests ([security-review.md](security-review.md)). No crash reports from users, because there are no users |
| Real-user experience | unknown | No outside users yet. The October audits were internal (no longer kept in the repository; `docs/slop-audit.md` records the latest code audit) |
| Performance | internal numbers only, CPU-only host | [performance.md](performance.md): a command on 1 000 clips 1.7–2.8 ms and a 50-clip gesture update 3.6–6.5 ms (§13 budgets met, `perf-core`); a drag on 1 000 clips 11.5–12.4 ms of main-thread work per frame, 5 000 clips scroll at 56–60 fps (`ui-perf`); a 2 000-item project opens in 2.0–2.9 s at host load ≈ 18, down from 8–14 s (target < 2 s not demonstrated at that load, `polish`); first export ≈ 2× the warp stage and 9–14× Remotion (D-34); render previews and a perf monitor (`previews`). Nothing at 4K with long timelines, nothing on GPUs |
| Media formats | ≈ 75% | Everything the LGPL FFmpeg 7.1 decodes, plus image sequences, layered PSD, PDF / Illustrator, SVG, Lottie, EXR / DPX / HEIC / JPEG XL stills (`docs/wp-notes/imports.md`); export H.264 (OpenH264 or hardware), VP9, AV1, ProRes, 10/12-bit HDR. No software HEVC export; camera RAW not supported |
| AI-assisted tools | ≈ 60% | SPAN upscaler, stabilisation, denoise, de-judder; OpenCV tracking; local speech to text with diarization (`docs/wp-notes/speech.md`); SAM 2.1 roto and face tracking (`docs/wp-notes/roto.md`); scene edit detection and optical flow (`docs/wp-notes/time.md`); Music Remix (`docs/wp-notes/audio-fx.md`); Warp Stabilizer with background analysis (Subspace Warp included), Auto Reframe Sequence (face model when installed, else saliency) and Morph Cut on optical flow (`docs/wp-notes/gaps.md`). No enhance speech; all models run on the CPU |
| Platforms | Linux only | Web, PWA and Electron on Linux (M1-STATUS); macOS / Windows packaging written, never run |
| Maturity | early | First commit 29 September 2026. ≈ 586,000 lines of TypeScript and scripts (tests included), almost entirely agent-written; 526 test files and 54 Playwright specs (counted with `git ls-files`) |

## Workstreams

Twenty-four workstreams ran in parallel (branches `feat/<name>`, merged through `integrate/parity`), followed by
seven that closed what they left: `fixups`, `perf-core`, `compositor`, `ui-perf`, `gaps`, `review` and `polish`.
Each says what "done" means, so progress is checked rather than self-graded. All have merged and are counted in the
numbers above with their evidence. Where a later workstream finished something an earlier status calls open, the
status says so.

### mcp-cli
Agents drive everything without a window: a CLI over the same command catalogue and MCP depth (every UI command
reachable, batch steps, rendered checks). **Done when:** each File/Edit/Clip/Sequence menu command is reachable from
MCP or the CLI with a JSON schema, a scripted end-to-end session (import → edit → grade → export) runs headless in
CI, and the README tool list is checked by a test.
**Status (merged):** done for MCP depth and the CLI — see [wp-notes/mcp-cli.md](wp-notes/mcp-cli.md): the `jasper` CLI over the same tools, `ui_*` tools that drive the live window, 338 MCP tools (counted after sound design WP2.3) with a README list checked by `apps/mcp/test/readme-tools.test.ts`, `e2e/agent-ui.spec.ts`. The headless session in CI came with `golden-fuzz` (its GitHub Actions workflow). Since `review` the `ui_*` tools cannot answer approvals or run approval-gated or irreversible commands ([security-review.md](security-review.md) AGT-1). `fixups` made clip targets aim at their visible part and fixed a bundle that did not load (`apps/mcp/test/bundle.test.ts`).

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
**Status (merged):** done — see [wp-notes/golden-fuzz.md](wp-notes/golden-fuzz.md) and [testing.md](testing.md):
`@jasper/testkit`; 56 golden scenes rendered by Remotion and 5 compositor scenes rendered by the native path and by
Remotion; fingerprints of every GPU effect (744 entries) and GPU transition (516); fuzz targets for every parser,
loader, HTTP route and MCP tool under a never-crash harness (`FUZZ=1` for long runs); ffmpeg / ffprobe oracles with
`JASPER_REQUIRE_ORACLES=1`; a 5 000-clip scale benchmark; a GitHub Actions workflow. Limits: goldens are rendered
with SwiftShader (no GPU drivers); the workflow has never run on GitHub (nothing is pushed).

### audio-mix
**Done when:** the Audio Meters show live levels (peak and RMS, clipping) during playback and export, an Audio Track
Mixer and Clip Mixer edit track and clip volume / pan / mute / solo with automation, submixes route tracks, Modify ▸
Audio Channels maps channels, and exports match the preview mix (sample-level oracle test).
**Status (merged):** done — see [wp-notes/audio-mix.md](wp-notes/audio-mix.md): meters, both mixers, submixes, sends, automation, loudness (oracle against ffmpeg `ebur128` and EBU Tech 3341/3342), voice-over (takes placed compensating output + input latency, Latency Offset preference: spec 12 WP0.1), exports from the same offline mixer (D-42); Clip ▸ Modify ▸ Audio Channels came with `gaps` (AU-7). Limit: submixes are not timeline rows.

### audio-fx
**Done when:** the core Premiere audio effects (parametric EQ, compressor, limiter, DeNoise, DeReverb, delay, reverb,
pitch shifter, channel volume) apply to clips and tracks with keyframes in preview and export, exponential fades
join the crossfades, and loudness normalisation (EBU R128 / ITU-R BS.1770, checked against ffmpeg `ebur128`) and
auto-ducking work as in Essential Sound.
**Status (merged):** done — see [wp-notes/audio-fx.md](wp-notes/audio-fx.md): 60 audio effects in one DSP (D-42), Exponential Fade, Essential Sound, Music Remix, auto-ducking (`packages/audio-fx/test/*`, `e2e/audio-fx.spec.ts`). The preview compensates clip, track, submix and Mix insert latency like the export (spec 12 WP0.1: sample-level oracle against the export mixer, `packages/compositions/test/audio-preview-oracle.test.ts`). Limits: Remix analyses at most 30 min of music; after a seek *during* playback the preview's first read-ahead samples (the Mix latency, ≤ ≈ 50 ms with an STFT insert) are silent (a Play after a paused seek is primed and loses nothing, spec 12 Phase 0 close-out, `e2e/sound-p0-transport.spec.ts`); an insert added during playback leaves the Mix that much late until playback stops. Sound-design Phase 0 fixed 23 audio-core defects with regression tests ([wp-notes/sound-design.md](wp-notes/sound-design.md) §WP0.2) and the preview defects of §WP0.1.

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
**Status (merged):** done — see [wp-notes/edit-ux.md](wp-notes/edit-ux.md): Match Frame, Speed/Duration, rulers and guides, Keyboard Shortcuts editor with layouts, Trim Monitor, comparison view, subclips and more. The entries it left unregistered were wired by `gaps` (Project Settings, Add / Delete Tracks, Find, Edit Original, Exit, Rename, Audio Channels, proxies, Export ▸ Frame) and `polish` (the last five, and five default shortcuts that had no command); a test now fails on any menu entry or default key binding without a command.

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
**Status (merged):** done — see [wp-notes/text-animators.md](wp-notes/text-animators.md): AE text animators with range / wiggly / expression selectors, text on a path, typography (`e2e/text-animators.spec.ts`). The Essential Graphics panel (layers, align, responsive pins) and rolling / crawling titles (parity GR-5) were added by `gaps` (see below).

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
existed already. The Warp Stabilizer *effect* (FX-6) was added by `gaps` (see below). Not done here:
Comp Camera / Lights for the 3D simulations, Puppet Sketch recording in the UI.

### three-d
**Done when:** 3D layers with a camera and lights (After Effects overlap) position and render text, shapes and footage
in preview and export with tests against analytic projections.
**Status (merged):** done — see [wp-notes/three-d.md](wp-notes/three-d.md): classic and advanced 3D, cameras, lights, glTF models, a 3D camera tracker (`packages/compositions/test/three-d-gl.test.ts`, `e2e/three-d.spec.ts`). Limits: no transitions on 3D layers; the black capture of video below a 3D run in headless Program-monitor captures was fixed by `previews` (`capture-safe-canvas.ts`).

### imports
**Done when:** image sequences, layered PSD and Illustrator files, relinking with a Link Media dialog, and Project
Manager (collect / consolidate) work, each with fixtures generated by `pnpm fixtures`.
**Status (merged):** done — image sequences, layered PSD (flattened / merged / individual / Sequence), PDF and
Illustrator pages, SVG, Lottie (import and export), EXR/TIFF/TGA/BMP/DPX/HEIC/JPEG XL and Interpret Footage,
see [wp-notes/imports.md](wp-notes/imports.md); Link Media came with interchange, Project Manager (collect /
consolidate) with `gaps`, the Media Browser panel with `polish`. Remaining limits: Lottie clips are not editable layers, PSD adjustment layers / layer styles / CMYK
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
root cause, perf instrumentation ([performance.md](performance.md)). Proxies (create, attach, toggle) and Export
Frame were completed by `gaps`, which also checked that smart-rendered `avc3` plays in Chrome and Electron; the
ARCHITECTURE §13 command / gesture budgets are met since `perf-core`; canvas-scope nesting (wp-note §5) was lifted
by `compositor` ([wp-notes/compositor.md](wp-notes/compositor.md)). Remaining limits: no HEVC smart rendering; razor
cuts re-render both halves.

### process
Guardrails and the project format: AGENTS.md / CLAUDE.md, layering and asset-attribution lints, ported-source
notices, schema-history fixtures, the crash-recovery journal, saved versions with restore, Save As / Save a Copy /
Revert ([project-files.md](project-files.md)). **Done when:** `pnpm lint` enforces layering and attribution, every
schema version has a fixture that loads, unsaved edits survive a killed editor and are offered on the next open,
and saved versions can be restored from the File menu and over MCP.
**Status (merged):** done — see [wp-notes/process.md](wp-notes/process.md): AGENTS.md, layering and asset lints, ported-source notices, crash-recovery journal and versions (D-39). It removed 11 screenshots of unknown provenance; `fixups` replaced them with renders of generated media (ATTRIBUTION.md).

### gaps
**Done when:** the parity rows left partial or missing by the merged workstreams (PRJ-4, PRJ-6, PRJ-8, TL-10, TL-11,
FX-6, GR-4, GR-5, AU-7, EX-2, EX-3, AI-2, UI-4, UI-5, UI-6) work end to end: model, undoable commands, UI, preview,
export or a named blocker, MCP tools, tests.
**Status (merged):** done except EX-2 (0.9) — see [wp-notes/gaps.md](wp-notes/gaps.md): Project Settings, Project
Manager, Media Cache cleaning, Add / Delete Tracks, track names, Warp Stabilizer effect (port of EffectCraft's
stabiliser and Subspace Warp, `licenses/ported/gaps.md`), graphic templates (`.jgt`), Essential Graphics panel with
responsive design and Roll / Crawl, Audio Channels, pixel aspect / fields / HEVC export, Auto Reframe Sequence, Morph
Cut on optical flow, more Preferences pages, Find / Edit Original / Exit, English + Spanish UI and an axe-core audit
(`e2e/gaps.spec.ts`). Limits: HEVC through kvazaar is 8-bit; fields are stored but exports are progressive (plan
warning); MOGRT import is not supported (Adobe's format is
undocumented); the Subspace Warp plan takes seconds for long clips (measured 2.5–4 s for 900 frames under load);
Auto Reframe does not reframe inside nested sequences. The two i18n follow-ups it left (labels built from model
names stayed English; switching language needed a restart) were closed by `polish` (see below).

### fixups
Root-cause fixes for what the parallel workstreams found while merging. **Done when:** each problem has a regression
test and the decision log, parity and gaps reflect the merged state.
**Status (merged):** done — see [wp-notes/fixups.md](wp-notes/fixups.md): Merge Paths at tangencies (a patched
library, D-45), MCP clip targets, the screenshots `process` removed.

### perf-core
**Done when:** one command on a 1 000-clip sequence takes < 4 ms and a 50-clip gesture update < 8 ms
(ARCHITECTURE §13), with incremental invariant checking proven equal to the full check.
**Status (merged):** done — see [wp-notes/perf-core.md](wp-notes/perf-core.md): 1.7–2.8 ms and 3.6–6.5 ms (from 31
and 144 ms), `packages/session/test/perf-budgets.test.ts`; dev builds check every transaction both ways.

### compositor
**Done when:** every stack whose HTML-in-Canvas scopes would nest renders (GL blend modes, linear light, adjustment
layers with GPU effects, 3D runs, the HDR display transform, in any combination) instead of failing with
CANVAS_NESTED.
**Status (merged):** done — see [wp-notes/compositor.md](wp-notes/compositor.md) and ARCHITECTURE D-43: one flat
compositor for those stacks, golden scenes against computed references. Limits: a flat stack composites in RGBA8
(≤ 1 code value from Chrome's own compositing); these stacks export through Remotion or the layer bake, as the
planner already said.

### ui-perf
**Done when:** the editor stays responsive at scale: a drag on 1 000 clips within a frame budget, 5 000 clips
scrolling and zooming at ≥ 50 fps, a 2 000-item Project panel, autosave off the critical path.
**Status (merged):** done except one target — see [wp-notes/ui-perf.md](wp-notes/ui-perf.md) and
[performance.md](performance.md) §5: 11.5–12.4 ms of main-thread work per drag frame (budget 16), 56–60 fps
scrolling, windowed bins, incremental autosave serialisation (≈ 0.5 ms after a one-clip edit of an 8 MB project).
Missed: the scripted drag's wall time (≈ 2.0 s against 1.5 s).

### review
An adversarial security and correctness review of the engine's HTTP and WebSocket surface, the expressions sandbox,
the agent surface, data integrity, export routing and the Electron shell. **Done when:** every confirmed finding is
fixed at its cause with a regression test that failed before, and what remains is written down.
**Status (merged):** done — see [security-review.md](security-review.md): 19 findings fixed (six High: the live-UI
tools bypassing the approval gate, project ids used as paths, Edit Original running programs, a shared mutable
expressions realm, two refused-edit bugs), an integrity property test over 32 kinds of edits, an export-coverage test
(no silent drop found). Residual risks in its §6 (motion-graphics bundles are code; dev engines have no token).

### polish
**Done when:** the loose ends the other workstreams listed are closed: a reload keeps the editing lease, no menu
entry or default shortcut is dead, the language switches without a restart and labels built from effect and preset
names are translated, a 2 000-item project opens in under 2 s, the native motion-graphic smoke test runs or skips
with a reason, and these documents agree with the code.
**Status (merged):** done except the open-time target — see [wp-notes/polish.md](wp-notes/polish.md): tab memory
for leases; the Media Browser panel, Engine Status / Connect, Edit Parameters, Third-Party Notices, Get Properties,
poster frames and custom effect bins, with a test that every menu entry and key binding has a command; live
language switch (ARCHITECTURE D-46) checked by a tour of the UI in both directions; project open 8–14 s → 2.0–2.9 s
at host load ≈ 18 (**< 2 s not demonstrated** at that load; a 10-item project takes ≈ 2.3 s there);
`jasper-mg` builds again (it had not since the asset sidecars landed); code-split panels mount through state
instead of a Suspense retry, which frequent updates on a busy machine could starve for minutes (found by a failed
e2e run, reproduced in a unit test).

### sound-design
**Done when:** spec 12 ([specs/12-sound-design.md](specs/12-sound-design.md)) is done phase by phase: Phase 0 (audio-core
and preview defects), Phase 1 (a licensed, offline sound library that users and agents search, look at, audition and
insert peak-aligned with provenance and credits), then cues and placement (P2), proposals and review (P3), mixing (P4),
Sound Check (P5), packs and more cue sources (P6).
**Status (on `feat/sound-design`, not merged to `main`):** partial — Phases 0, 1, 2 and 3 done (Phase 3 verified: wp-note "Phase 3 verification", requirement table with evidence; rerun `e2e/sound-review.spec.ts` and `e2e/sound-p3-mcp.spec.ts` — an MCP agent proposes, the user reviews and applies, the agent reads the decisions and notes, is refused, is allowed, applies the rest and exports — plus `packages/session/test/proposals-state-machine.test.ts`; the pass fixed 8 defects, among them a reopen that let an applied item be applied twice and reviewer-only routes open to agents, made a 500-item review usable — preview built in slices and memoised, list virtualised — and closed the WP3.3b follow-ups: `style.cueSources` in MCP, stale reasons with timecodes and the cue kind in the user's language, workspace layouts migrated, ghost lanes in the scroll range. Limits: a 1 000-item proposal's preview still takes 13–16 s of work (measured, load 40–48; spread over frames, longest task ≤ 0.17 s) before its ghosts show, and an invariant conflict among a large proposal's items shows as stale only when Apply reports it; the window between an accept's transaction and the write of its states (an engine crash there leaves the items pending although applied) is not journalled. History of the work packages: WP3.1: the generic proposal model, engine store, routes, event and the agent accept gate; WP3.2: the `sound-design` plan job and route, `plan_sound_design`, `place_sound` propose mode and the five proposal MCP tools; WP3.3a: the session proposals slice, the preview document the Program monitor plays with "Hear proposal" (A/B, also while playing), timeline ghosts with their cards, Apply as one undo step and Undo back into review — rerun `e2e/sound-proposal-ghosts.spec.ts`; WP3.3b: the proposal card in the agent notices stack ("<agent> proposes …: n sounds on k new tracks", "<agent> is waiting for your review"), the Review panel (rows by role, decisions, alternates, notes, ▶ in context, stale reasons, tab badge), the review bar on the Timeline, the Review keymap scope, Apply only for a trusted key press / click with the toast "Applied n of m sounds from <author>" (Undo, Reopen review), the Auto Sound Pass… dialog, Fill Unfilled Cues as a proposal and the "Allow agents to apply sound proposals" preference — rerun `e2e/sound-review.spec.ts` (Phase 3 "Done when", export peaks 0 / 0 / −1 samples from the cue frames)); Phase 4 in progress (WP4.1a masking solver, WP4.1b bed render, `soundDesign.applyGains`, `rebalance_sfx`, plan gains; WP4.2a stop-before, build, room glue, delivery presets and the plan's style options — model, engine and MCP; their web UI is WP4.2b); Phases 5–6 not started.
See [wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 1 verification": the Sound Library panel and Sound Design
workspace, the engine library (60-sound Kenney CC0 kit, user folders with a declared licence, Jasper Synth), ten MCP
tools, credits; inserts land on the frame to the sample (library sounds are registered with 50 ms of lead silence, and
since Phase 2 every lossy one as PCM; rerun: `e2e/sound-library.spec.ts` measures 0 samples of error on an
ffmpeg-decoded export for five kit sounds); search over 5 000 sounds 7–15 ms at load ≈ 30
(`apps/engine/test/sounds-search.test.ts`). Schema v7 (D-50). **Phase 2** (cues and placement; wp-note "Phase 2
verification", requirement table with evidence): the cue model and commands, `deriveCues` from every project source,
the `/api/sound-design/cues` route and five MCP cue tools, the Cue Seam, Suggest Cues…, Fill / Fill Unfilled Cues,
Replace mode, variation cycling (one undo step), linked layers, the In Context audition, badges, Essential Sound /
Properties sections. Rerun: `e2e/sound-p2-done.spec.ts` (the spec's "Done when" on the Phase 2 fixture: Suggest Cues
gives the same 17 cues as the engine route, fill, variations, layer, exact undo / redo, and 18 aligned points measured at
−1 … +1 sample from their cue frames in the export), `apps/engine/test/sound-placement-export.test.ts` (7 sequence
rates, 0 samples; varispeed ±2 % ≤ 1 sample), `apps/mcp/test/sound-cues.test.ts`; the verification pass fixed 37
defects, 36 with a regression test that failed before the fix (model review 6, agent surfaces 6, web UI 21, lead 4;
listed in the wp-note). Limits: no keyboard-key recording in the kit (`key` is synth only); sounds over 120 s keep the
≤ 1-frame placement rule and, when lossy, can play up to 128 samples late after an In point; Fill Unfilled Cues
proposes (review, then Apply) since WP3.3b; Detect Peak analyses at most 2 min of a clip; Auto gain / Room send / levels
against the bed are Phase 4 (placement gives a default level by role, below); `pitchSt: 0` after a fractional varispeed shift keeps up to
±0.5 st; razoring inside a transition's span fails with `E_INVARIANT` for any clips (edit-structure, not sound);
Essential Sound Role / Align radio groups have no arrow-key navigation; "Undo <label>" in the Edit menu is composed in
English (every feature).
Phase 2 verification B ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 2 verification B"): the primed
start's picture wait no longer gets cut short (`PrimedStartClock`; the Phase 0 transport e2e now measures the wait
itself and replays plays the loaded host disturbed); placed sounds get a default level by role from their loudness and
true peak (`sfx.level`; the Phase 2 fixture filled through MCP exports at −5 dBTP without normalisation); motion-graphic
land / exit cues come from the fframes templates' rendered motion (the lower third lands at 350, not 360). Limits: anime
templates keep the declared intro / outro timing (unmeasured, lower confidence); default levels are per sound, not
against the bed (Phase 4); real-time audio e2e cannot measure on a host whose audio clock slips (load ≳ 90 here): the
specs then fail saying every play was disturbed.
Phase 4 → WP4.1b ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 4 → WP4.1b"): the bed is rendered per cue
cluster and every sound effect alone by the export mixer, the masking solver (WP4.1a) sets the gains:
`soundDesign.applyGains` (`sfx.level {by: 'solver'}`), `POST /api/sound-design/rebalance` / MCP `rebalance_sfx` (propose or
apply as one undo step) and the plan job (each item applies its solved gain, why-lines name the limit: "−16.2 dB,
limited by dialogue A2"). Measured on the Phase 2 fixture with a music bed and dialogue: every event reaches its target
lift or reports `limitedBy`; on a PCM export, each event's lift over the separately exported bed is within 0.14 dB of
the report (AAC exports add up to 1.3 dB of codec noise to the difference); export true peak −4.8 dBTP; plan with gains
10.2 s (levels 5.0 s) at load ≈ 17 on 16 cores. Limits: SFX do not mask each other in the model and the per-event
true-peak ceiling is pre-master (overlapping events may sum higher); non-linear master processing (a limiter on the Mix)
breaks the bed + sound additivity the measurement assumes; windows over 20 s are measured on their first 20 s.
Phase 4 → WP4.2a ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 4 → WP4.2a"): stop-before (music track
volume automation, or `audio.volumeDip` on the music clips when the music shares its track; dips merge by the minimum),
build (one Butterworth High Pass per music track, keyframed exponential sweep; the Scientific Filter now ramps its
coefficients so the sweep does not click), room glue (`soundDesign.ensureBus`: "SFX Room" submix + Studio Reverb +
post-fader sends, interface sounds dry; the return counts as each sound's contribution in the bed / solo measurement),
delivery presets (`POST /api/sound-design/delivery`, MCP `apply_delivery`: Mix normalisation, Auto-Match by type,
ducking, re-solved SFX gains) and the plan's style options. Measured: an exported stop-before dip −23.99 dB deep, its
ramps' middles 0.2 ms from where they should be; a build raises the music's spectral centroid 3.45 → 8.50 kHz and has no
click (third difference 4.0 × 10⁻⁶ vs 3.2 × 10⁻³ before the filter fix); a web delivery export measured by ffmpeg
−14.1 LUFS / −1.5 dBTP with the music 22.8 LU under the voice during speech. Limits: the Essential Sound "Room send",
"Stop before next" and delivery controls are WP4.2b's (web UI); a dip or build on a time-remapped clip is not modelled
(audio clips have none); a Bézier volume segment crossing a dip edge is resampled every 5 ms; the plan's delivery item
is measured without the plan's own sound effects (its stored analysis then reads stale until re-measured; exports
always re-measure).

### Not covered by any workstream yet

- **Platforms**: run and fix the desktop app on macOS and Windows; hardware H.264/HEVC export on real GPUs; build
  the installers (the Electron fuses were exercised on a fused Linux binary only, [security-review.md](security-review.md) §7).
- **Real-user reliability**: get outside users, triage their reports within a day, a regression test per fix.
- **Performance beyond this host**: 4K multi-layer timelines and hour-long programmes; any GPU; the editor's own
  start (≈ 9 MB of JavaScript to evaluate) now dominates project open.
- **Audio plug-ins** (VST3 / AU) and more codecs (10-bit software HEVC export, camera RAW).
- **Behaviour review**: a documented-behaviour pass (helpx references) over the M1 editing features whose specs
  never cited Adobe's documentation.
- **Sandboxing motion-graphics bundles**: an imported Remotion project runs with the editor's origin
  ([security-review.md](security-review.md) §6.1).
- **Reach**: user documentation; localisation beyond English and Spanish; a screen-reader pass with real assistive
  technology (the axe audit in `e2e/gaps.spec.ts` checks markup, not the spoken experience).

## For agents choosing work

1. Read [CLAUDE.md](../CLAUDE.md), then this file. Prefer a gap in a feature parity.md marks as done over a new
   feature: a feature that exists but behaves differently from Premiere's documented behaviour is not done.
2. Fidelity comes from research, not measurement: cite the Adobe documentation and formulas you followed in your
   wp-note, and say so where behaviour is undocumented and you chose.
3. When you fix a behaviour bug in a feature marked done, add it to the evidence above. That is how this assessment
   stays honest.
4. **Don't raise parity.md's numbers without evidence**: a test, a measurement or a user-facing check that a reviewer
   can rerun, recorded in the wp-note and here.
