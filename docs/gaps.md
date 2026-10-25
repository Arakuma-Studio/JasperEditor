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
| Breadth of features | ≈ 98% (P0 97%, P1 99%, P2 100%) | [parity.md](parity.md): 89 done, 3 partial (CL-4, EX-2, PL-2), 0 missing of 92, each changed row citing its wp-note and behavior tests; command dispatch and timeline edits are covered by `apps/web/test/registry.test.tsx` and `apps/web/test/timeline-commands.test.ts` |
| Behaves like Premiere | largely unreviewed as workflows, ≈ 60–75% where it exists | Fidelity comes from research during implementation (Adobe's help pages, parameter references, shortcut lists, published formulas), not from captures of Adobe software; each merged workstream cites its sources in its wp-note. The keymap follows Premiere's published defaults and is conflict-checked (`apps/web/test/keymap.test.ts`). Many M1 behaviours (trim modes, sync lock, targeting) follow our own specs S01–S05 without a recorded source review |
| Preview = export | measured for the native paths and the audio mix | Sub-pixel streamed layers: lossless-still parity with Remotion SSIM 0.99999, 0.05 px/frame pans smooth to 0.001 px RMS (D-34); GPU spans and effect bakes: 100% of samples within 3/255 (D-35); one offline mixer renders the audio of every export path (D-42, `apps/engine/test/audio-mix.test.ts`); ffprobe frame counts in `e2e/smoke.spec.ts` |
| Opening existing Premiere work | ≈ 40% | No `.prproj` (out of scope); FCP 7 XML, FCPXML, EDL, AAF, OMF and OTIO import with a report of what each format loses (`docs/wp-notes/interchange.md` §7). Not tried on real projects exported by Premiere |
| Stability | measured by our own suites, unproven in use | Atomic writes, leases (a reloaded tab keeps its own, `polish`), 409 handling, invariant repair, a crash-recovery journal and saved versions (D-39, `apps/engine/test/recovery-versions.test.ts`); `fast-check` property tests and a 10 000-transaction invariant fuzz in `packages/project`; golden frames, fingerprints of every GPU effect and transition, fuzzed loaders, HTTP routes and MCP tools (`golden-fuzz`, [testing.md](testing.md)); a session-level integrity property over 32 kinds of edits with undo / redo / save round trips, and 19 security findings fixed with regression tests ([security-review.md](security-review.md)). No crash reports from users, because there are no users |
| Real-user experience | unknown | No outside users yet. The October audits were internal (no longer kept in the repository; `docs/slop-audit.md` records the latest code audit) |
| Performance | internal numbers only, CPU-only host | [performance.md](performance.md): a command on 1 000 clips 1.7–2.8 ms and a 50-clip gesture update 3.6–6.5 ms (§13 budgets met, `perf-core`); a drag on 1 000 clips 11.5–12.4 ms of main-thread work per frame, 5 000 clips scroll at 56–60 fps (`ui-perf`); a 2 000-item project opens in 2.0–2.9 s at host load ≈ 18, down from 8–14 s (target < 2 s not demonstrated at that load, `polish`); first export ≈ 2× the warp stage and 9–14× Remotion (D-34); render previews and a perf monitor (`previews`). Nothing at 4K with long timelines, nothing on GPUs |
| Media formats | ≈ 75% | Everything the LGPL FFmpeg 7.1 decodes, plus image sequences, layered PSD, PDF / Illustrator, SVG, Lottie, EXR / DPX / HEIC / JPEG XL stills (`docs/wp-notes/imports.md`); export H.264 (OpenH264 or hardware), VP9, AV1, ProRes, 10/12-bit HDR. No software HEVC export; camera RAW not supported |
| AI-assisted tools | ≈ 60% | SPAN upscaler, stabilisation, denoise, de-judder; OpenCV tracking; local speech to text with diarization (`docs/wp-notes/speech.md`); SAM 2.1 roto and face tracking (`docs/wp-notes/roto.md`); scene edit detection and optical flow (`docs/wp-notes/time.md`); Music Remix (`docs/wp-notes/audio-fx.md`); Warp Stabilizer with background analysis (Subspace Warp included), Auto Reframe Sequence (face model when installed, else saliency) and Morph Cut on optical flow (`docs/wp-notes/gaps.md`). No enhance speech; all models run on the CPU |
| Platforms | Linux only | Web, PWA and Electron on Linux (M1-STATUS); macOS / Windows packaging written, never run |
| Maturity | early | First commit 29 September 2026. ≈ 586,000 lines of TypeScript and scripts (tests included), almost entirely agent-written; 526 test files and 54 Playwright specs at the 10 October 2026 polish assessment (historical counts from `git ls-files`) |

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
CI, and MCP `listTools` exposes the current catalog and schemas.
**Status (merged):** done for MCP depth and the CLI — see [wp-notes/mcp-cli.md](wp-notes/mcp-cli.md): the `jasper` CLI over the same tools, `ui_*` tools that drive the live window, 378 MCP tools counted at the sound-design merge (historical count; query `listTools` for the current catalog), with live-UI workflows in `e2e/agent-ui.spec.ts`. The headless session in CI came with `golden-fuzz` (its GitHub Actions workflow). Since `review` the `ui_*` tools cannot answer approvals or run approval-gated or irreversible commands ([security-review.md](security-review.md) AGT-1). `fixups` made clip targets aim at their visible part and fixed a bundle that did not load (`apps/mcp/test/bundle.test.ts`).

### keyframes-blend
Premiere's full keyframe and blend-mode behaviour. **Done when:** all 27 Premiere blend modes exist in the model,
preview and native export (oracle-tested against the published formulas), keyframe interpolation covers linear,
Bezier, auto Bezier, continuous Bezier, hold, ease in/out with temporal and spatial variants, and every one is
editable in Effect Controls and through MCP.
**Status (merged):** done — see [wp-notes/keyframes-blend.md](wp-notes/keyframes-blend.md): Premiere's 27 blend modes native and in preview (native pixels in `apps/engine/test/blend-export.test.ts`, WebGL contracts in `packages/compositions/test/blend-gl.test.ts`, mixed-stack native/Remotion parity in `apps/engine/test/compositor-export.e2e.test.ts`), auto / continuous Bezier and the temporal / spatial variants. Limits: blend modes inside nests export through Remotion; GL modes need HTML-in-Canvas (scope nesting lifted by `compositor`).

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
**Status (merged):** done — see [wp-notes/audio-fx.md](wp-notes/audio-fx.md): 60 audio effects in one DSP (D-42), Exponential Fade, Essential Sound, Music Remix, auto-ducking (`packages/audio-fx/test/*`, `apps/engine/test/audio-fx.test.ts`). The preview compensates clip, track, submix and Mix insert latency like the export (spec 12 WP0.1: sample-level oracle against the export mixer, `packages/compositions/test/audio-preview-oracle.test.ts`). Limits: Remix analyses at most 30 min of music. Since sound-design Phase 6 → preview transport carry-overs every Play is primed (nothing at the play position is lost; the picture waits the read-ahead + 21 ms, up to 3 s, shown as buffering from 0.2 s), a seek while playing and a latency added while playing restart playback primed (a brief picture hold), and edits while playing no longer make Remotion re-anchor the audio ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → preview transport carry-overs", `e2e/sound-p6-transport.spec.ts`); a read-ahead over 3 s still starts unprimed. Sound-design Phase 0 fixed 23 audio-core defects with regression tests ([wp-notes/sound-design.md](wp-notes/sound-design.md) §WP0.2) and the preview defects of §WP0.1.

### captions
**Done when:** caption tracks can be created, edited and styled in the timeline and Program monitor, import and export
SRT and WebVTT (round-trip tests), burn in on every export path, and are drivable over MCP.
**Status (merged):** done — see [wp-notes/captions.md](wp-notes/captions.md) (`e2e/captions.spec.ts`, `apps/engine/test/captions-export.test.ts`). Limits: burn-in needs the layer bake (no libass in the LGPL build), CEA-608 in H.264 SEI is not written.

### speech
**Done when:** a local speech-to-text model (permissive licence, on-demand download) transcribes clips into
transcripts with word timings, captions can be generated from them, and text-based editing (delete words → ripple
the timeline) works as one undoable step.
**Status (merged):** done — see [wp-notes/speech.md](wp-notes/speech.md): local Whisper (ONNX, CPU) with word timings, diarization, captions from transcripts, text-based editing (`apps/engine/test/speech.test.ts`, `apps/web/test/speech.test.tsx`). Limits: CPU only, Linux only checked, classical diarization.

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
**Status (merged):** done — see [wp-notes/text-animators.md](wp-notes/text-animators.md): AE text animators with range / wiggly / expression selectors, text on a path, typography (`packages/project/test/text-animators.test.ts`, `packages/compositions/test/text-animators.e2e.test.ts`). The Essential Graphics panel (layers, align, responsive pins) and rolling / crawling titles (parity GR-5) were added by `gaps` (see below).

### shapes
**Done when:** shape layers carry pen paths, polygons, stars, groups, fills, strokes, trim paths and repeaters, editable
on canvas and exported natively.
**Status (merged):** done — see [wp-notes/shapes.md](wp-notes/shapes.md): vector shapes with groups, Bézier paths, gradients, the path operators (trim paths and repeaters included), Pen / Polygon / Star tools, SVG import (`packages/project/test/vector/*`, `apps/engine/test/vector-shapes-remotion.e2e.test.ts`). `fixups` fixed Merge Paths collapsing at tangencies (a PathBool.js bug, D-45).

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
**Status (merged):** done — see [wp-notes/three-d.md](wp-notes/three-d.md): classic and advanced 3D, cameras, lights, glTF models, a 3D camera tracker (`packages/compositions/test/three-d-gl.test.ts`, `packages/compositions/test/three-d-render.e2e.test.ts`). Limits: no transitions on 3D layers; the black capture of video below a 3D run in headless Program-monitor captures was fixed by `previews` (`capture-safe-canvas.ts`).

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
**Status (merged):** done — see [wp-notes/color-grade.md](wp-notes/color-grade.md): HSL Secondary, hue-vs curves, vignette, Colour Match with Face Detection, Lumetri Scopes upgrade (`apps/web/test/color-grade.test.tsx`, `packages/project/test/color-match.test.ts`, `apps/engine/test/grading.test.ts`). Limits: eyedroppers sample the displayed picture; no Basic Correction Intensity slider.

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
expressions realm, two refused-edit bugs), an integrity property test over 32 kinds of edits, and export pixel,
media-file and named-refusal checks (current owners and limits in security-review.md §3). Residual risks are listed
in its §6, with the hardening follow-up and its checks in §8.

### polish
**Done when:** the loose ends the other workstreams listed are closed: a reload keeps the editing lease, no menu
entry or default shortcut is dead, the language switches without a restart and labels built from effect and preset
names are translated, a 2 000-item project opens in under 2 s, the native motion-graphic smoke test runs or skips
with a reason, and these documents agree with the code.
**Status (merged):** done except the open-time target — see [wp-notes/polish.md](wp-notes/polish.md): tab memory
for leases; the Media Browser panel, Engine Status / Connect, Edit Parameters, Third-Party Notices, Get Properties,
poster frames and custom effect bins; live language switching (ARCHITECTURE D-46) with document and undo-history
preservation checked by `e2e/polish.spec.ts`; project open 8–14 s → 2.0–2.9 s
at host load ≈ 18 (**< 2 s not demonstrated** at that load; a 10-item project takes ≈ 2.3 s there);
the current open-time budget runs through `pnpm perf --sections ui --ui open` (`scripts/perf/ui-run.ts`);
`jasper-mg` builds again (it had not since the asset sidecars landed); code-split panels mount through state
instead of a Suspense retry, which frequent updates on a busy machine could starve for minutes (found by a failed
e2e run, reproduced in a unit test).

### sound-design
**Done when:** spec 12 ([specs/12-sound-design.md](specs/12-sound-design.md)) is done phase by phase: Phase 0 (audio-core
and preview defects), Phase 1 (a licensed, offline sound library that users and agents search, look at, audition and
insert peak-aligned with provenance and credits), then cues and placement (P2), proposals and review (P3), mixing (P4),
Sound Check (P5), packs and more cue sources (P6).
**Status (merged to `main` 2026-10-20, with the test cleanup audit from `origin/main`):** done — every requirement of spec 12 (Phases 0–6, §4 P6-E1…E14) is built and verified: final verification B (wp-note "Final verification B": the requirement audit with evidence per requirement, the editor ↔ MCP parity table, a user and an agent walkthrough measured on the built stack); final verification A runs the gate and every e2e spec, then the merge into `main` (P6-R7). Known limits are listed per package below. Per phase: Phases 0, 1, 2 and 3 done (Phase 3 verified: wp-note "Phase 3 verification", requirement table with evidence; rerun `e2e/sound-review.spec.ts` and `e2e/sound-p3-mcp.spec.ts` — an MCP agent proposes, the user reviews and applies, the agent reads the decisions and notes, is refused, is allowed, applies the rest and exports — plus `packages/session/test/proposals-state-machine.test.ts`; the pass fixed 9 defects, among them a reopen that let an applied item be applied twice, reviewer-only routes open to agents and a row showing a setup item's gain, made a 500-item review usable — preview built in slices and memoised, list virtualised — and closed the WP3.3b follow-ups: `style.cueSources` in MCP, stale reasons with timecodes and the cue kind in the user's language, workspace layouts migrated, ghost lanes in the scroll range. Limits (since WP6.5b): a 1 000-item proposal's preview takes 1.1–1.4 s of work on the idle build server (3.0 s before WP6.5b, the 13–16 s measured earlier at load 40–48), its one end-of-preview invariant check — what finds an invariant conflict among the items before Apply, at any size since WP6.5b — is a single 84 ms task; accepts are journalled (WP6.5b) so a crash between the transaction and the states is settled from the document. History of the work packages: WP3.1: the generic proposal model, engine store, routes, event and the agent accept gate; WP3.2: the `sound-design` plan job and route, `plan_sound_design`, `place_sound` propose mode and the five proposal MCP tools; WP3.3a: the session proposals slice, the preview document the Program monitor plays with "Hear proposal" (A/B, also while playing), timeline ghosts with their cards, Apply as one undo step and Undo back into review — rerun `e2e/sound-proposal-ghosts.spec.ts`; WP3.3b: the proposal card in the agent notices stack ("<agent> proposes …: n sounds on k new tracks", "<agent> is waiting for your review"), the Review panel (rows by role, decisions, alternates, notes, ▶ in context, stale reasons, tab badge), the review bar on the Timeline, the Review keymap scope, Apply only for a trusted key press / click with the toast "Applied n of m sounds from <author>" (Undo, Reopen review), the Auto Sound Pass… dialog, Fill Unfilled Cues as a proposal and the "Allow agents to apply sound proposals" preference — rerun `e2e/sound-review.spec.ts` (Phase 3 "Done when", export peaks 0 / 0 / −1 samples from the cue frames)); Phase 4 done (verified: wp-note "Phase 4 verification", requirement table with evidence; the "Done when" sample-level oracle did not exist for automation, failed — the preview was up to 0.19 off the export on a stop-before ramp — and now holds to 1.4·10⁻⁵: rerun `packages/compositions/test/audio-preview-mix-oracle.test.ts` (headless Chrome), `apps/engine/test/sound-design-plan-mix.test.ts`, `sound-design-plan-levels.test.ts`, `packages/project/test/sound-p4v-mix.test.ts`, `e2e/sound-mix.spec.ts`; the pass fixed 26 defects, each with a regression test (overlapping dips / builds not removable, Bézier curves flattened, splits / duplicates / locked tracks / mute losing the mix, jobs applying gains solved against an edited bed, no CONFLICT, the plan's delivery analysis measured without its sounds, plan reports naming clips that never exist), decided the delivery's ducking depth (music 14.1 LU under the voice, measured), made the first plan with every style option 13–19 s at load ≈ 20 (measured; 78 s at load ≈ 95 before) and made `mixFingerprint` id-free. History of the work packages: WP4.1a masking solver, WP4.1b bed render, `soundDesign.applyGains`, `rebalance_sfx`, plan gains; WP4.2a stop-before, build, room glue, delivery presets and the plan's style options — model, engine and MCP; WP4.2b their web UI: Essential Sound auto gain / room / stop-before / build, Rebalance SFX Levels, Room Glue…, Delivery Target…, the Auto Sound Pass mix options, written vs stored span bars); Phase 5 done (verified: wp-note "Phase 5 verification", requirement table with evidence; rerun `e2e/sound-check.spec.ts` — the panel and MCP `sound_check` list the same findings at the same frames, verdicts given during Play all, a fix that needs judgement confirmed first, bound verdicts reported stale after the edit — plus `apps/engine/test/sound-check{,-review,-kept,-stems}.test.ts`, `apps/web/test/sound-check-{panel,model,listen-keep}.test.*`, `apps/mcp/test/sound-check{,-verdicts}.test.ts`, `packages/project/test/sound-check-verdicts.test.ts`; the pass fixed 15 defects with regression tests — sync of identical sounds near a cue, reversed clips and the sequence's edges, SILENCE of one-channel signals, DIPs from deliberate level moves, dialogue pauses and hit tails, unsafe "safe" fixes (REPEAT to an NC alternative, ducking that cannot reach 8 LU), custom-target and density staleness, Play all / ▶ restarting when pressed to stop, Spanish text quoting English, end-aligned risers 0.03 ms early — and closed the WP5.2 follow-ups: fixes that need judgement are confirmed naming what they change, Play all keeps playing through verdicts, verdicts are bound to the moment they judged (`soundDesign.setVerdict`, stale when that moment changes), the sync strip draws the sound effects over the bed, the last full report is kept per sequence across engine restarts (`POST /api/sound-design/check/last`, MCP `get_sound_check`), and the findings list keys are remappable commands; a 30-minute check measured 120–206 s and ≤ 547 MB peak RSS); Phase 6 done: WP6.1 sound packs done (the ten Kenney CC0 audio packs as sha256-pinned downloads from kenney.nl, licence shown before install, `sound-pack-install` job, removal behind approval, Help ▸ About entries, MCP tools, Preferences ▸ Sound Library ▸ Packs — rerun `apps/engine/test/sound-packs.test.ts`, `apps/mcp/test/sound-packs.test.ts`, `e2e/sound-packs.spec.ts`; plus, by a human decision of 2026-10-17, four curated BigSoundBank CC0 packs — 147 real recordings by Joseph Sardin, each file's own page checked for its CC0 line, downloaded file by file from bigsoundbank.com at most one request per second: keyboard and typewriter typing takes, clicks, foley and hits, air whooshes, pass-bys, 10 risers, a reverse, room tone and 23 ambience beds; the whole catalogue now has a recording of every type — wp-note "Phase 6 → BigSoundBank packs", rerun `apps/engine/test/sound-packs.test.ts`; limits: the typing and ticking recordings are multi-hit files the judge rejects as one key or tick — since WP-E5 they are split into judged single takes (below), the beds are 35 s – 4.7 min OGG files of which 4 loop cleanly by measurement, the ambience pack is a 71 MB download); WP6.2 engine cue
sources done (wp-note "Phase 6 → WP6.2"): the `motion-analysis` job measures the rendered picture (through the export
planner) per frame — footage moves, landings and cuts become cues (confidence ≤ 0.5) anchored to the footage, Sound
Check's NO_PICTURE_EVENT uses the measured motion, MCP `analyze_picture_motion` draws it; shot changes inside footage
(Scene Edit Detection through speed, reverse and time remap) and Essential music beats (`POST /api/audio/beats`) are cue
sources; "snap to the beat" (≤ 2 frames, `anchorOffset`); Suggest Cues… / Auto Sound Pass… show them with counts and
Analyze… — rerun `apps/engine/test/sound-design-motion.test.ts`, `packages/project/test/sound-cues-engine.test.ts`,
`packages/audio-fx/test/beats.test.ts`, `apps/mcp/test/sound-motion.test.ts`, `apps/web/test/sound-engine-sources.test.tsx`,
`e2e/sound-cue-sources.spec.ts`. Limits: a stretch that is not untouched footage (effects, transforms, speed, fades, other layers) is still rendered
through the export before it is measured (one minute of untouched 1080p footage: 3.6–3.8 s since WP6.5b, 24.9–31.7 s before on the same build server, which decodes such
stretches straight at the analysis size; 41–47 s before, measured at load 7–12 on 16 cores); motion
under ≈ 0.6 px per frame at 128 px (≈ 0.12 screen diagonals per second, the keyframe source's threshold) is not seen, and
small objects (≤ 2 blocks of 8 px) are noise to it; the beat tracker reads 60–200 BPM clicks and generated drum patterns at
their own tempo and detects 3 or 4 beats per bar (WP6.5b; other metres only when `timeSignature` is given).
Phase 6 → WP6.3 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP6.3"): Essential Sound **Auto Tag**
(Premiere's "Auto Tag Audio Types") — `POST /api/audio/classify` (an `audio-classify` job, cached per file and range)
classifies clips as dialogue / music / SFX / ambience with documented rules over measured features (VAD, syllabic
modulation, pitch over time, onset periodicity, held partials, stationarity, duration); `essentialSound.autoTag` tags them
marked "auto" (dotted badge) until the user confirms in Essential Sound, never replacing a type the user set unless forced;
Essential Sound's Auto Tag button and banner (Confirm / Change…), Clip ▸ Audio Options and the clip menu, MCP
`auto_tag_audio`. One dialogue definition (`dialogueSpans`: transcript words, else the engine's voice activity of Essential
dialogue clips, else their spans) now drives cue suppression (cuts and, new, derived heroes), the plan, the solver's
dialogue guard and Sound Check's music-over-voice segments. Measured: 192 labelled clips (LJ Speech, the starter kit, the
synth kit, generated music / ambience / long effects; 139 the thresholds were tuned on, 53 held out) all classified right
through the engine — rerun `apps/engine/test/audio-classify.test.ts`, `packages/audio-fx/test/audio-category.test.ts`,
`apps/engine/test/sound-dialogue-consistency.test.ts`, `e2e/sound-autotag.spec.ts`. Limits: rules, not a trained model,
checked on synthetic music and ambience and one speaker: real mixes (dialogue over loud music, walla, footsteps — read as
music) will be wrong more often; VAD is energy-based on the media; since WP6.5b only the dialogue the mix lets through
(clip gain and Volume keyframes, track mutes and Volume automation, solo, submix and Mix faders above −40 dB) counts as
speech. (WP6.5a added the "Auto-tag audio types in the timeline" preference and "select all clips of a tag".)
Phase 6 → WP6.5b ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP6.5b carry-over polish (engine/model)"):
the nineteen engine / model / MCP carry-overs, each with a regression test — exact pitch resets (`sfx.pitch`),
sample-exact copies of sounds up to 1 h (byte cap, disk check, `inexact` beyond) in the narrowest exact PCM WAV (FLAC
rejected: 16-bit FLAC measured not bit-exact in Chrome), older copies replaced in place (`media.upgradeLibraryCopy`),
inter-SFX masking and the summed true peak of overlapping sounds in the solver, `soundDesign.expectMix` closing the
rebalance / delivery race, fast-check seeds captured repo-wide (the `mergeDips` hunt found and fixed 8 edge cases),
measurement renders on worker threads, Sound Check's safe fixes judged together (true-peak headroom, cross-masking),
mono Mixes checked in mono, kept reports deleted with their sequence, one shot-change rule, the beat tracker's tempo
octave and 3/4, measured picture motion in `view_sound_timeline`, untouched footage decoded at the analysis size,
journalled accepts, invariant conflicts found in previews of any size, a 1 000-item preview 2.2–2.9× less work, the anime templates' cues
measured, heard dialogue only (clip gain / automation, mutes, faders), a strict CPU budget for search, a
configurable E2E start-up timeout, and Auto gain on for a mixed selection as one undo step (the rebalance job's
`autoGain`; WP6.5a item 7k). Rerun the tests listed in that section's table.
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
listed in the wp-note). Limits: no keyboard-key recording in the kit (`key` is synth only); sounds over 1 h (or whose
sample-exact copy would pass 2 GiB or the free disk space; 120 s before WP6.5b) keep the ≤ 1-frame placement rule and, when
lossy, can play up to 128 samples late after an In point — registration says so (`inexact`), and since the final
carry-over cleanup the editor shows it too (a warning on insert, Properties ▸ Sound, Sound Check's INEXACT information,
the plan's `W_SOUND_INEXACT`); Fill Unfilled Cues
proposes (review, then Apply) since WP3.3b; Detect Peak analyses at most 2 min of a clip; Auto gain / Room send / levels
against the bed are Phase 4 (placement gives a default level by role, below); `pitchSt: 0` after a fractional varispeed shift is exact since
WP6.5b for clips placed since (`sfx.pitch`; older clips keep up to ±0.5 st until re-pitched). (Fixed in Phase 6 → WP6.5a:
razoring inside a transition's span, the Role / Align arrow keys and "Undo <label>" in the UI language.)
Phase 2 verification B ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 2 verification B"): the primed
start's picture wait no longer gets cut short (`PrimedStartClock`; the Phase 0 transport e2e now measures the wait
itself and replays plays the loaded host disturbed); placed sounds get a default level by role from their loudness and
true peak (`sfx.level`; the Phase 2 fixture filled through MCP exports at −5 dBTP without normalisation); motion-graphic
land / exit cues come from the fframes templates' rendered motion (the lower third lands at 350, not 360). Since WP6.5b the anime
templates are measured too (a pure motion model checked frame by frame against anime.js); default levels are per sound, not
against the bed (Phase 4); real-time audio e2e cannot measure on a host whose audio clock slips (load ≳ 90 here): the
specs then fail saying every play was disturbed.
Phase 4 → WP4.1b ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 4 → WP4.1b"): the bed is rendered per cue
cluster and every sound effect alone by the export mixer, the masking solver (WP4.1a) sets the gains:
`soundDesign.applyGains` (`sfx.level {by: 'solver'}`), `POST /api/sound-design/rebalance` / MCP `rebalance_sfx` (propose or
apply as one undo step) and the plan job (each item applies its solved gain, why-lines name the limit: "−16.2 dB,
limited by dialogue A2"). Measured on the Phase 2 fixture with a music bed and dialogue: every event reaches its target
lift or reports `limitedBy`; on a PCM export, each event's lift over the separately exported bed is within 0.14 dB of
the report (AAC exports add up to 1.3 dB of codec noise to the difference); export true peak −4.8 dBTP; plan with gains
10.2 s (levels 5.0 s) at load ≈ 17 on 16 cores. Limits: since WP6.5b lower-weight SFX are part of a sound's bed
and the summed true peak of overlapping sounds holds the ceiling (an upper bound, Σ of amplitudes; pre-master); non-linear master processing (a limiter on the Mix)
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
−14.1 LUFS / −1.5 dBTP with the music 22.8 LU under the voice during speech (14.1 LU since the Phase 4 verification's
ducking depth). Limits: a dip or build on a time-remapped clip is not modelled (audio clips have none); a curved
(Bézier) volume segment crossing a dip edge is rebuilt adaptively (≈ 0.001 dB); dips and builds follow cue edits,
splits, sequence duplicates and locks, not clips duplicated, pasted or nested by hand (their keys stay ordinary
keyframes); a dip on a track lane stays where it was when the music clip moves.
Phase 4 → WP4.2b ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 4 → WP4.2b"): the mixing UI — Essential
Sound ▸ Sound Design shows a placed sound's level ("Solver · −3.0 dB · limited by dialogue A1"), Auto gain on / off
(`soundDesign.setAutoGain`: off keeps the gain as the user's, `sfx.level.manual`), Rebalance, the per-track Room send,
and the linked cue's Stop before next / Build (validated; written vs stored); Properties ▸ Cue edits the same; the Cue
Seam draws written spans solid and stored-only ones dashed; Sequence ▸ Sound Design ▸ Rebalance SFX Levels / Room
Glue… / Delivery Target… (job progress, measured summary, Undo); Auto Sound Pass… mix options; Preferences ▸ Sound
Library ▸ Delivery. Rerun `e2e/sound-mix.spec.ts`. Limits: the Room row (since the Phase 4 verification it acts on every
selected track, mixed state shown) is blocked for tracks that also play bed audio (the Audio Track Mixer still allows a
send there); the Phase 4 rows show for placed sounds only (an Essential-SFX clip without `sfx` metadata has no level
record to show). Phase 4 limits after the verification: SFX do not mask each other in the solver and headroom is the last
(weakest) constraint, so overlapping events can sum over the ceiling before the master; the preview follows gain and
effect automation sample by sample (pan, the 5.1 puck and send pans too since Phase 6 → preview transport carry-overs);
the mixer renders on the engine's main thread (a first plan's ≈ 69 solo renders are most of its time).
Phase 5 → WP5.1 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 5 → WP5.1"): the `sound-check` job
(`POST /api/sound-design/check`) renders the delivered mix (normalised and limited as the export) and its stems in one pass
(each clip decoded once; every stem equal to `renderMixdown` sample for sample, `apps/engine/test/sound-check-stems.test.ts`)
and reports the 14 spec codes with severities, translatable messages and fixes (dry-run; `safe` ones resolve their finding:
each seeded defect of P5-R4 is found and its fix resolves it on a re-check, `apps/engine/test/sound-check.test.ts`), five
listen-here moments, a per-event table and a verdict; `soundDesign.setCheck` stores the summary (`soundCheckStatus`: stale
on a mix, cue, loudness-setting or preset change); `POST /api/sound-design/visual`; MCP `sound_check` and
`view_sound_timeline` (PNG). Limits: sync is located within ±3 frames of the cue (larger offsets are judged from the
document) and a layer covered by another sound of its cue is "not measurable"; identical sounds closer than ±3 frames can
be confused; MASKED skips ambient beds and cue layers; the visual route's curves omit the limiter; NO_PICTURE_EVENT uses
keyframed motion only (pixel motion is P6). Found by its real run and fixed since ("Fix: SFX tail truncation" in the
wp-note): short library sounds placed on a cue ended at their peak (whole-frame clips inside media padded only in front).
Registration now pads 50 ms of trailing silence, placement rounds every clip up to the end of its sound (under one frame
past media that has no room), and Sound Check reports clips of older projects that still end inside their sound
(OUT_OF_SYNC "cut", TRUNCATED) with a safe fix (re-register + swap, or re-plan on the same media) — measured sample-exact on
rendered audio at 23.976 / 29.97 / 30 / 60 fps. Limits: a clip faster than +19 % at 23.976 fps, a sound over 120 s or project
audio ends past its media by under a frame (silence; later trims clamp to the media and can cut that frame again);
TRUNCATED needs the clip to reach its media's last whole frame (a clip shortened on purpose is not reported).
Phase 5 → WP5.2 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 5 → WP5.2"): the Sound Check panel
(delivery target — the presets or a custom LUFS / dBTP target, also on the job and MCP — and "Use as sequence target";
Run as a job with progress and Cancel; summary chips with a stale badge and Re-run; findings by category with severity
shape + word, timecode jump, translated messages, Fix and Fix all safe — one transaction, engine jobs after it, the check
again; sync strips of 5 engine stills over the waveform; listen-here ▶ / Play all and Sounds right / Flag + note stored
as user comment markers that MCP `sound_check` returns as `humanVerdicts`), Sequence ▸ Sound Design ▸ Run Sound Check
and "Run Sound Check before export" (a fail prompts Export anyway / Review issues). Rerun `e2e/sound-check.spec.ts` (the
panel and MCP report the same codes at the same frames). Phase 5 verification ([wp-notes/sound-design.md](wp-notes/sound-design.md)
"Phase 5 verification"): verdicts are bound to their moment and report staleness, the strip draws the sound effects over the
bed, the last full report is kept across restarts, unsafe fixes are confirmed, Play all survives verdicts and the list keys
are commands. Limits after the verification: each opened sync strip renders 5 still jobs (cached per document revision);
a verdict's staleness follows the audio of its ±2 s window and its clip / cue position, not picture edits, and an older
(name-only) verdict marker cannot tell; with normalisation off a safe MASKED gain can raise the true peak and a safe
demotion plus a safe gain on one hero can overload (the check runs again after Fix all safe); a repeated tonal sound's
renderer offset shows less clearly (sync prefers the document among near-equal matches); `soundCheckInputsHash` ignores
media licences, transcripts and picture edits; a kept report is not removed when its sequence is deleted (it is never
shown for another sequence). Export credits (Phase 6 WP6.4): the Export dialog's SOUND ▸ Credits writes
`<name>.credits.<txt|md|csv>` with the sounds heard in the range (W_SOUND_CREDITS without it); there is no audio-only or
image-sequence export destination to attach it to yet, the header is English, and a cue's window and kind do not survive
an interchange round trip (point markers `SFX: <type> (<weight>)`, re-imported as `manual` cues).
Phase 6 → WP6.5a carry-over polish (UI / editing; [wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP6.5a"):
the Razor / Add Edit / an insert edit inside a transition's span cuts the clips and shortens the transition to the part it
still reaches, and a trim or overwrite that leaves a clip shorter than its transition shortens it too (Premiere: the
duration adjusts to the frames there are; these edits used to fail `E_INVARIANT`); "Undo /
Redo <step>", the crash-recovery list and the built-in workspace names in the UI language (ids and stored names
unchanged); a `SegmentedControl` radio group in `@jasper/ui` (one Tab stop, arrow keys / Home / End choose) for Essential
Sound Role / Align and composition text alignment; Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" (off by
default: Adobe documents it as a setting to enable and documents no default) tags audio clips the user adds through the
Auto Tag route and command, and Essential Sound lists the tags in the sequence — a click (or Clip ▸ Audio Options /
the clip menu ▸ Select All <Type> Clips, agent-exposed `audio.selectAudioType`) selects that tag's clips; exports honour
the requested container and audio codec where the codec fits (H.264 + 24-bit PCM in MOV on the LGPL OpenH264 build, which
wrote MP4 + AAC whatever was asked) and report what cannot be written as asked (`OUTPUT_CONTAINER_CHANGED` /
`AUDIO_CODEC_CHANGED` in the plan, the dialog, the job result with `audioCodec`, the finished-export notice); after an
In Context audition the Timeline view comes back; Delivery Target… and Auto Sound Pass… offer Close alone after a run;
a gain fix's "why" is said in the UI language; `set_sound_cues` counts only the cues it adds. Rerun
`packages/project/test/transition-razor.test.ts`, `apps/engine/test/export-container.test.ts`,
`apps/web/test/{wp65a-i18n,wp65a-audition-view,essential-autotag-on-add,export-format}.test.*`,
`e2e/sound-p65a-polish.spec.ts`. Limits left: since the final carry-over cleanup the sound and format export warnings
(`W_SOUND_CREDITS`, `W_SOUND_LICENSE_NC`, `W_SOUND_SHARE_ALIKE`, `W_SOUND_CHECK_STALE`, `OUTPUT_CONTAINER_CHANGED`,
`AUDIO_CODEC_CHANGED`) and the finished-export detail are said in the UI language (code + `params` from the engine,
`ExportWarningParamsSchema`); other engine-composed messages (planner blockers, job errors, solver notes outside Sound
Check fixes) stay English — the pattern to extend is documented there; auto-tagging on add ignores agents' placements (they tag with
`auto_tag_audio`) and is its own undo step; a clip added to a new or duplicated sequence is not auto-tagged.

Phase 6 → WP-E1 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E1"; spec 12 §4 P6-E1…E3,
P6-E13, ideas and thresholds adapted from earshot, `licenses/ported/earshot.md`): Sound Check also finds clicks at edits
(CLICK, a streaming 14 kHz burst detector on the mix and every stem, fixed by a 1-frame fade), cut edges (EDGE: a head that
starts mid-sound, a chopped decay, music chopped at a joint), harsh sounds (HARSH, 2–6 kHz over the music's peak) and
inaudible layers (LAYER_INAUDIBLE), partial coverage of a class of cues (COVERAGE), a mix that ends mid-sound or starts on
a loud sample (ENDING / HEAD) and a loudest moment without its hero (ARC); risers are judged by a −250…+30 ms end window.
CC BY-SA sounds carry an "SA" badge, a credits notice, `W_SHARE_ALIKE` / `W_SOUND_SHARE_ALIKE` warnings and a Sound
Check LICENSE warning, and the default Commercial-safe filter leaves them out (human decision; "Include ShareAlike" adds
them). Rerun `packages/audio-fx/test/check-findings.test.ts`, `packages/project/test/sound-check-p6.test.ts`,
`apps/engine/test/sound-check-p6.test.ts`, `e2e/sound-check-edges.spec.ts`. Limits left: EDGE judges each edge against
the clip's peak within 10 s of it, decodes at most 400 edges and skips reversed clips; edge levels are the source's with the static clip gains (Volume
automation is not applied to them); HARSH's reference is the music's loudest moment in
the range and an event's window can include another effect playing then; LAYER_INAUDIBLE measures ≤ 64 layers and only
their first 3 s; COVERAGE classes come from stored anchors (separate clips sharing a pattern are one class only through a
shared anchor source such as markers); the fixes' fades are frames (33 ms at 30 fps), not sub-frame keys.

Phase 6 → WP-E5 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E5"; spec 12 §4 P6-E9 and the
`materials` field of P6-E10; earshot `search.py` / `analyze.py` adapted, `licenses/ported/earshot.md`): multi-hit
recordings of a single-hit type are split into takes (one stroke, or a press-and-release pair led by its louder stroke;
never across digital silence; head / tail cuts recorded, never offered; ≤ 64), each with its own descriptors and judge,
addressable as `snd_…~t<n>` everywhere a sound id goes (entry, visual data, audio, sample-exact registration with the
recording's licence, commands, palettes, swap rings); search counts them on their recording and lists them with
`takes`; the plan job and `place_sound` rotate over a recording's takes; the Sound Library lists them under their
recording (→ / ←). New judge flags `lowpassed` (a band-limit cliff under 12 kHz on sounds that need air), `noisy-floor`
and `dc-offset`; materials from words, a `material` filter and Refine pill. Measured on the BigSoundBank and Kenney
packs: 634 clean takes in Keys & Clicks, 21 of the 25 files that kept a rejected type now have a take the judge accepts;
`lowpassed` flags none of 859 real and synth sounds and 94 % of the takes of the same key recordings encoded at 24 kb/s
AAC; a registered take placed on a cue peaks on the cue frame in the export (0 samples, 12 cues, 4 rates). Rerun
`packages/audio-fx/test/{takes,sound-quality-flags}.test.ts`, `apps/engine/test/sound-takes{,-plan}.test.ts`,
`apps/mcp/test/sound-takes.test.ts`, `apps/web/test/sound-library-takes.test.tsx`, `e2e/sound-takes.spec.ts`,
`scripts/sounds/measure-takes.mjs`. Limits left: takes from the first 120 s only, pairs at most (a typewriter's strike,
carriage and bell are separate takes), take numbers can change with a new analysis version (projects keep the range),
`noisy-floor` needs two onsets, MCP swap's next / previous adds no sibling takes of its own.

Phase 6 → WP-E3 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E3"; spec 12 §4 P6-E6, P6-E7,
algorithms adapted from earshot `timeline.py`, `licenses/ported/earshot.md`): a listening transcript — the `sound-listen`
job (`POST /api/sound-design/listen`, ≤ 10 min) renders the mix and lanes of non-overlapping clips once, finds the
events of the mix (onsets refined to the attack, swells, silences, accents), names the clip behind every one and the cue
it fills (production audio by its clip), labels sections (dialogue, music with its ducking and distance under the voice,
ambience, effects, silence), and matches every cut, transition, cue and cached measured motion to the sound that answers
it with the CHANCE level of each share; MCP `listen_to_sequence` (text first, compact JSON, the sheet with `images`),
the Sound Check panel's Log tab (the same lines; a line jumps and selects its clip; Copy log; the mix spectrogram),
Sequence ▸ Sound Design ▸ Listen to Sequence; `view_sound_timeline` became the annotated sheet (frames rendered at the
cuts / cues / accents, the mix spectrogram, sections, answer marks by shape and colour). Rerun
`packages/audio-fx/test/events.test.ts`, `apps/engine/test/sound-listen.test.ts` (`JASPER_LISTEN_BENCH=1` for the
10-minute timing), `apps/mcp/test/sound-listen.test.ts`, `apps/web/test/sound-listen-log.test.tsx`,
`e2e/sound-listen.spec.ts`. Limits left: a 10-minute listen takes ≈ 100 s on the build server (measured; the renders
dominate); the onset detector is earshot's, so a busy bed flickers into low-prominence onsets (they answer no cut: only
events ≥ 3 dB over their bed do) and amplitude-modulated sounds (syllables) read as swells; a sound the mix's onset curve
hides is looked at where its clip has its own onset (`guided`: 2 of 10 hits 6 dB under music in the test); transcript
lines are English in every UI language (the panel prints the engine's lines verbatim, as agents read them).

Phase 6 → WP-E6 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E6"; spec 12 §4 P6-E10; earshot's
launch grammar adapted, `licenses/ported/earshot.md`): one cue grammar module every path uses — ui / click cues share
ONE voice at one level (no variation; the plan solves one gain for them), keys / ticks / taps rotate takes at speed 1,
runs of ≥ 3 staggered appear / emphasis pops, UI blips, chimes or ticks climb +1 st per step (capped +4) and are budgeted
as one unit, typing faster than 25 units/s gets one key per word start, a cut inside music outside dialogue is at half
confidence (balanced drops it, reported `MUSIC_CARRIES_CUT`), six personalities (ranking preferences, type boosts and
exclusions, materials, default density), and a ranking bonus for the dominant material of the placed sounds' family; the
style is stored per sequence (`soundDesign.setSettings {style}`) and set in Preferences ▸ Sound Library, Auto Sound Pass…
and Suggest Cues…; MCP `plan_sound_design` style options, `find_sound_cues` options, `place_sound` picks and `swap_sound`
sibling takes follow it, and Sound Check's REPEAT no longer flags the one voice. Measured in an export: a 4-card stagger plays 1000.0 / 1059.5 / 1122.5 / 1189.2 Hz from 1 kHz
pops (0 / 1 / 2 / 3 st) and three clicks peak at −10.25 dBFS each. Also fixed: a plan proposal holding a take failed
validation (`~` in a setup item id). Rerun `packages/project/test/sound-grammar.test.ts`,
`apps/engine/test/sound-design-grammar.test.ts`, `apps/engine/test/sound-grammar-export.test.ts`,
`apps/mcp/test/sound-grammar.test.ts`, `apps/web/test/sound-style.test.tsx`, `e2e/sound-grammar.spec.ts`. Limits left:
the personality table and its weights are decisions, not measurements; the one-voice rule picks per type within one
plan or pick, it does not re-voice clicks already placed with other sounds, and variation cycling of a click clip
changes that clip alone; a run's fifth and later steps read back in Essential Sound ▸ Pitch as +3 st over a faster base
speed; one key per word needs the text's words (a Range Selector based on characters maps its units to word starts of
the clip's text; lines and words selectors are not typing); the typing dip is a separate item that the user accepts with
the run's first key.

Phase 6 → WP-E2 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E2"; spec 12 §4 P6-E4, P6-E5; the
ideas are earshot's `qa_ok` and critics' "variants", nothing ported): a Sound Check finding can be acknowledged as a
deliberate exception with a reason (`soundDesign.acknowledgeIssue` / `unacknowledgeIssue`, undoable; ≤ 500 per sequence;
agents warnings and infos only — an error is `E_APPROVAL_REQUIRED` and the check never honours an agent's word for one):
it leaves the verdict, the counts (`counts.acknowledged`) and the safe fixes until its clips, cue or listened moment
change, then it is back "acknowledged before the change"; the Sound Check panel's Acknowledge… (A) and "Acknowledged (n)"
with Unacknowledge, MCP `acknowledge_sound_issue`. A proposal can be checked before review (`sound_check {proposalId,
itemIds?}`, `plan_sound_design {check: true}`, the Review panel's Check proposal): the check of its preview against the
current document's kept report (or a fresh run) → fixes / introduces per item, kept on the proposal (`report.check`,
shown in the Review panel, its rows, the ghost card and `get_proposal`), nothing applied. The guides teach the review
lenses (sync, edges, masking, tonal, director), one writer / one proposal per pass and query wording. Rerun
`packages/project/test/sound-acknowledge.test.ts`, `packages/project/test/proposals-preview-batch.test.ts`,
`apps/engine/test/sound-check-ack-proposal.test.ts`, `apps/mcp/test/sound-check-ack.test.ts`,
`apps/mcp/test/proposals.test.ts`, `apps/web/test/{sound-check-panel,review-sound-check}.test.tsx`,
`e2e/sound-check-ack.spec.ts`. Limits left: a finding's key is its report id, so a frame-only finding (SILENCE, DIP) that
moves by a frame is a new finding; an acknowledgement covers its target (the named clips / cue, else ±2 s around its
frame, else the whole mix), not the bed under it (a MASKED acknowledgement holds when the music changes); a duplicated
sequence starts without acknowledgements; a proposal check costs one or two full checks (base and preview; the base is
skipped when the kept report is current) and is attributed by the entities each item's preview touched (setup items only
when no other item did).

Phase 6 → WP-E7 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E7"; spec 12 §4 P6-E11; earshot's
`arrange.py` ideas and stop-down norm adapted, `licenses/ported/earshot.md`): music to picture — the beat analysis gives
the music's key (chroma + Krumhansl–Schmuckler, with a confidence) and its drop candidates; Land the Drop re-cuts a music
clip at bar lines so its drop plays on a chosen frame (`/api/audio/remix-plan {anchors}`, Essential Sound ▸ Duration ▸
Music to picture, Clip ▸ Audio Options ▸ Land Drop on Playhead / Hero Cue, MCP `remix_audio {landDropAt}`,
`fit_music_to_picture`, `find_music_drops`), recorded so a later remix keeps it; End on Bar ends a music clip just
before a downbeat with a one-beat fade; the plan job tunes chimes, shimmers and clearly pitched sounds over music to the
key (`style.tuneToMusic`) and puts stop-befores on the bar line (`style.stopOnBar`), both on by default; every remix's
joints now sit 5 ms before each beat's measured attack with crossfades that end at the joint. Measured in exports: the
drop lands 0.000 ms from the hero frame (cross-correlation), a MIDI-70 chime over C major plays 440.00 Hz (A4, −1 st),
the music sits −24.00 dB in the 19 ms after the downbeat the stop ends on, an End on Bar export is silent from 29.9656 s
before the bar line at 30.000 s. Also fixed: `POST /api/audio/beats` cancelled every analysis requested over a real
socket. Rerun `packages/audio-fx/test/music-picture.test.ts`, `packages/project/test/sound-music-fit.test.ts`,
`apps/engine/test/{music-picture,sound-music-plan}.test.ts`, `apps/mcp/test/music-picture.test.ts`,
`apps/web/test/sound-music-fit.test.tsx`, `e2e/sound-music-fit.spec.ts`. Limits left: drops and keys are measured on
generated music only (no labelled set of real tracks); joints on bar lines make the reachable remix lengths a bar apart
(an exact length is refused naming the nearest; without one the clip moves by up to half a bar); several anchors land
only when the music between them fits within 1 ms; the head of the intro may be trimmed by up to a bar (faded in); a
tuned run climbs the scale (steps of 1–2 st) rather than +1 st; the stop moves onto a bar only within 0.1–0.5 s (or the
cue's own window); keys are major / natural minor only (modes and modulations are read as the nearest key).

Phase 6 → WP-E4 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E4"; spec 12 §4 P6-E8; earshot's
`profile.py` / `critique.py` metric definitions and scorecard adapted, `licenses/ported/earshot.md`; NO bundled profile):
reference profiles — the user builds a profile from 1–20 of their own media or sequences (Preferences ▸ Sound Library ▸
Reference profiles, MCP `build_sound_profile`; a `sound-profile` job: loudness, the arc and ending, onset / hit density,
sync to the picture with chance levels, spectral shares, stereo width, speech share; numbers only, `<appdir>/sounds/
profiles`, export / import as a file), a sequence selects one (`soundDesign.setSettings {referenceProfile}`, the Sound
Check panel's Reference select) and Sound Check adds a Reference row per metric — out-of-range major rows are REFERENCE
warnings, minor ones infos, each with what to do and timecodes (the cuts with no sound, the gaps, the dead end), leave-one-
out when the sequence is a reference. Measured: −20 LUFS pink noise reads −20.0 with its octave shares within 0.5 dB
(sub 1 dB), a 1 s gap 0.95–1.05 s, 2 s of dead air 1.97–2.03 s, clicks at 2/s 2.0 onsets/s, a 0.5 cut/s picture 0.5/s
(the scene detector on generated FFV1 films); a matching sequence passes every row; the seeded mismatch (air −6 dB, 2 s
dead end, sound on 1 of 6 cuts) is flagged by exactly those rows plus the closing level, with the timecodes. Rerun
`packages/audio-fx/test/profile-metrics.test.ts`, `packages/project/test/sound-profile.test.ts`,
`apps/engine/test/sound-profile.test.ts`, `apps/mcp/test/sound-profile.test.ts`, `apps/web/test/sound-reference-profiles.test.tsx`,
`e2e/sound-reference-profile.spec.ts`. Limits left: the metrics are validated on generated material only (no labelled set
of real films); the speech share is the model-free Auto Tag classifier per 5 s window (a voice under music may read as
music); references are measured for at most 60 min each, at ≈ 3.8 s of CPU per minute of stereo audio plus decoding
(measured on the build server), and a check with a profile costs the same on its mix; a sequence reference's loudness and
true peak take the Mix's normalisation gain without running the limiter; the picture events of a media reference come
from the scene detector (dissolves and slow changes are missed) while a sequence's are its edit's cuts and transitions;
Reference rows offer advice, never a command fix.

Phase 6 → WP-E8 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E8"; spec 12 §4 P6-E12; earshot's
ambience-zone ideas adapted, `licenses/ported/earshot.md`): ambience and room-tone beds — `soundDesign.layBed` lays a
bed per scene (V1 cuts to other footage, scene markers, measured shot changes, or the user's scenes) as ordinary clips
on an "Ambience" track: the recording's measured clean window (no spike ≥ 10 dB over its 1 s neighbourhood) looped at
measured loop points with 1.5 s crossfades (equal power; equal gain when it repeats in phase), 0.5 s crossfades at
scene changes, 1 s fades, at the ambience level, optionally ducked; room tone fills the holes between dialogue clips
with the palette / library tone whose octave-band shape is closest to the dialogue's noise floor (within 3 dB), else
the dialogue's own quietest stretch, at the floor's level; Sound Check's SILENCE inside dialogue has the fix "Fill it
with room tone" (not safe). Engine `POST /api/sound-design/beds[/plan]`, `/room-tone[/plan]` (propose / apply), MCP
`lay_ambience_bed`, `fill_room_tone`, Sequence ▸ Sound Design ▸ Lay Ambience Bed… / Fill Room Tone. Measured: a 4 s
ambience over three scenes of 20 s — 9 pieces, 6 loop and 2 scene crossfades, the Sound Check has no finding at all,
the native export is within 0.09 dB of its body at every joint (100 ms RMS) with no click; a 1 s hole between dialogue
clips (floor −53 dBFS) is reported SILENCE, its fix chooses the pink room tone (shape 0.21 dB; hum 5.62, hiss 5.13) and
the export plays −53.06 dBFS there (the floor −52.10). Rerun `packages/audio-fx/test/loop-window.test.ts`,
`packages/project/test/ambience-bed.test.ts`, `apps/engine/test/sound-beds.test.ts`, `apps/mcp/test/sound-beds.test.ts`,
`apps/web/test/sound-beds.test.tsx`, `e2e/sound-beds.spec.ts`. Limits left: loop points are found on the decoded mix of
the recording's channels (the loop is the same for both); the loop length is a whole number of frames, so a mains hum
at 25 / 30 fps always repeats in phase (then the joint is equal-gain); the clean window, loop points and room-tone
ranking are measured on generated recordings in the tests (not a labelled set of real beds); scenes follow cuts to
other footage, not a location the picture shows (two locations in one clip need a marker or the measured shot changes);
room tone from the dialogue's own media can be as short as 0.5 s (its loop then has many joints); a library room tone
is matched by octave-band shape only (no hum detection beyond what the bands show).

Phase 6 → WP-E9 ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → WP-E9"; spec 12 §4 P6-E14, human
decision 2026-10-17; earshot's calibration idea, our vocabulary and maths, `licenses/ported/earshot.md`): Describe-it
search and Find Moment with the optional, user-installed LAION CLAP `larger_clap_general` (Apache-2.0; analysis only).
Its weights and tokenizer are downloaded unmodified from LAION's repository at a pinned revision (776 MB, sha256-pinned,
licence shown first; Preferences ▸ Sound Library ▸ Describe-it search, MCP `install_describe_search_model`; removal asks
an agent's user); our weight-free ONNX graphs (3.5 MB, shipped) read them as external data, so nothing is hosted by us.
The `jasper-clap` worker (ONNX Runtime) embeds every sound and take once (`sound-embed`, incremental, cached by content),
`search_sounds {describe}` / the Library's Describe pill rank by a calibrated match blended with the ranking (without
the model: the words), `match_sound` weighs one sound against alternatives, and Find Moment (`find_sound_moment`, row menu)
finds and inserts the best windows of a long recording. Measured: exports match PyTorch (cosine ≥ 0.99999988), the
TypeScript front end matches the reference (7.6·10⁻⁶ dB, tokenizer 34 / 34); on held-out BigSoundBank packs "strong"
matches are 80.7 % precise and top-5 retrieval by sound alone is 84.7 % (all 184 sounds: 71.7 %, 63.2 %); Find Moment found
three sounds placed in a 90 s recording at their seconds. Rerun `apps/engine/test/sound-semantic{,-unit}.test.ts`,
`packages/project/test/sound-{rank-describe,moment}.test.ts`, `apps/mcp/test/sound-semantic.test.ts`,
`apps/web/test/sound-describe-ui.test.tsx`, and with the model on the build server `e2e/sound-describe.spec.ts`
(`E2E_CLAP=1`), `apps/engine/scripts/{check-clap,measure-clap}.ts`. The listening transcript names its events with it
(`listen_to_sequence {tags}`, Log ▸ Name the sounds; the clip's sound at the event, up to 100 events). Limits left:
English descriptions only; tags name the clip's sound, not the mix; ≈ 0.5 s
of CPU per sound or take to prepare (≈ 40 min for 5 000) and ≈ 0.8 GB of RAM while the worker runs; a 4 h Find Moment pass
≈ 12 min (estimated); quality is modest on synthesised UI sounds and some obvious queries miss (wp-note); the int8 export
(≈ 205 MB) is not offered (it would need hosting and changes the top result for 12–15 % of queries, measured).

Phase 6 → final carry-over cleanup ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Phase 6 → final carry-over
cleanup", item table): every test fixture is made with LGPL encoders and filters (MPEG-4 Part 2, FFV1, VP9 instead of
libx264; `geq` / `hue` instead of `eq`), kept so by `scripts/fixture-gpl-encoders.test.mjs`, so the engine suite runs on
the vendored LGPL ffmpeg; toasts and notices keep clear of a modal dialog's and Export mode's title bar and footer (and a
click on a toast no longer closes the dialog); a sound registered as it is (not sample-exact) is shown in the editor;
in-request work (`/api/sound-design/visual`, `/beds/plan`, `/room-tone/plan`, `/api/audio/beats`, `/api/sync/audio`)
stops when the client goes away and never before (`clientGoneSignal`, a real-connection test); Stop Before Next (cue
menu, Properties) and MCP `set_sound_cues {stopBefore}` end on the music's bar line by the plan's rule when its beats are
analysed (`/api/audio/beats {cachedOnly}`); the sound / format export warnings are translated. Rerun the tests of that
section's table. Limits left: the bar-line stop uses only beats already analysed (the editor never starts an analysis
for it) with the default metre; the general engine-message pattern is applied to export warnings only.
Final verification B ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Final verification B": the requirement audit
against spec 12 with evidence per requirement, the editor ↔ MCP parity table, the walkthroughs): Fill Room Tone found
nothing on dialogue trimmed tight to the words — the room tone is now also taken from the media's handles (≤ 30 s either
side, voice activity left out; rerun `apps/engine/test/sound-beds.test.ts`); the missing parity twins were added — MCP
`export_sound_credits` (listed in the spec, never built), `detect_sound_peak` (`POST /api/sound-design/peak`, the clip
menu's Detect Peak; `align_peak` moves such clips by frames like the editor), the Sound Library's Import to Project
(`import_sounds`' twin) — rerun `apps/engine/test/sound-design-peak.test.ts`, `apps/mcp/test/sound.test.ts`,
`apps/web/test/sound-import-to-project.test.ts`; `e2e/sound-design.spec.ts` (P6-R6: the user walkthrough, measured in
the export) and `e2e/sound-agent-walkthrough.spec.ts` (an agent through the built `jasper-mcp`, following the guide)
are new. Deliberately without a twin: audition (agents cannot hear: pictures and the listening log instead), the
listener's verdicts and the reviewer's notes / alternates (the user's), favourites and recents (the editor user's own
lists). The walkthroughs also found: Delivery Target's Auto-Match matched each remix piece on its own (a landed drop's
joint jumped 9 dB; one gain per remix now, `packages/project/test/essential.test.ts`), a remix joint the plan left
chopped (110 ms there, `apps/engine/test/remix-joints.test.ts`), End on Bar's fade-out reported as ENDING
(`apps/engine/test/sound-check-ending-fade.test.ts`), Sound Check's "Normalise the mix" fix leaving the preview
un-normalised (`apps/engine/test/sound-check.test.ts`), Jasper Synth rotated in among real recordings and alternatives'
notes without their item. Fixed since (wp-note sound-design "Fix: lossy-codec true-peak headroom and loudness
convergence"): the delivered lossy file overshot −1 dBTP (−0.9 … +0.1 dBTP decoded at AAC 256 kb/s) — the limiter now
runs under a codec / bit-rate headroom (EBU Tech 3344, AES TD1008) and the export decodes its own encode and turns the
moments the codec still pushes over down (≤ 8 encodes; ffmpeg `ebur128` on the files of 15 AAC / Opus exports at three
targets: all ≤ the target, `apps/engine/test/export-lossy-true-peak.test.ts`); the limiter left a loud mix ≈ 0.5 LU
under its target — the gain now converges (±0.1 LU, or `ceilingLimited` + a warning). Fixed since (wp-note "Fix:
preview loudness parity, codec-aware Sound Check, delivery speed"): the Program monitor played a heavily limited mix
0.84 LU under the export (the one-pass gain) — the stored analysis now carries the export's converged gain and the
preview plays it (0.06 LU from the PCM export, headless-Chrome oracle `apps/engine/test/preview-loudness-parity.test.ts`);
Sound Check checks for an export encoding everywhere (the panel's "Check for", default the last export settings or the
target's typical AAC 256 / AAC 128 / PCM; the summary records it and is stale for another; MCP defaults the same); a
lossy normalised export took 3–4× the time of the one-pass export — now ≈ 1.0–1.25× on a typical mix (measured,
`apps/engine/test/delivery-speed.bench.test.ts`). Limits left: the preview's peaks are the PCM's, not the codec's; a
loud, bright stress mix at AAC 128 kb/s still needs two encode rounds (≈ 2.7× the one-pass export); Sound
Check's OVERLOAD (the limiter pulls 7 dB on the hero hit) stays a warning for the user's judgement; a review alternate
can be a Jasper Synth sound when the library has fewer real takes.

Final verification A ([wp-notes/sound-design.md](wp-notes/sound-design.md) "Final verification A"): the full gate
(`pnpm verify`, `notices --check`, `i18n:check`, `e2e:typecheck`) and all 83 e2e specs, each in a fresh server, plus the
fframes fallback check, on the build server with Chrome for Testing 150 as `JASPER_BROWSER_EXECUTABLE` (the server's
Chrome 142 predates HTML-in-Canvas). It fixed two product defects — the kept Sound Check report read stale whenever it had
been checked for a lossy export (`POST /api/sound-design/check/last` hashed without the encoding) and
`spectralDistanceDb` overflowed to Infinity on hostile levels — and made the gate deterministic: MCP tests on free ports
(two shared 49563), a toast race in `e2e/support.ts` that hung exports until the test timed out, specs independent of
earlier runs in the same server, sub-sample and envelope-long correlation windows for varispeed and tonal sounds, robust
measures in the transport spec, the Sound Check spec turning off "Music carries the cuts", a property test kept to the
sample grid. Limits left: on Chrome 142 five HTML-in-Canvas specs fail (they test that path); Chrome 153 (CfT
153.0.8010.12) captured only the first child canvas of an HTML-in-Canvas host in a probe, which `capture-safe-canvas.test.ts`
shows; the desktop smoke and packaged-app checks were not run (no xvfb on the server).

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

### social-comment
Animated platform comment cards (`social-comment@1`, design `docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`).
**Done when:** all seven variants are drawn faithfully in light and dark, with presets, Properties controls, canvas
editing, randomize, bulk import and agent batches.
**Status (in progress):** the template, its animation framework, the two TikTok cards, the two YouTube cards (comment,
Shorts reply) and the X post card are built — see [wp-notes/social-comments.md](wp-notes/social-comments.md) "Template
implementation", "YouTube cards" and "X card". The Instagram cards are not built yet: a clip set to one of them shows a
striped "not available yet" card in preview, has no gallery preset, and every export path refuses it
(`TEMPLATE_NOT_INSTALLED`, e.g. "social-comment@1 (Instagram post comment card)"). X card limits: only the blue verified badge (gold / grey need a schema field); the Grok mark is always
drawn; Chirp is the latin subset, so other scripts fall back to the next font of the stack.
Add another and bulk import (CSV / pasted TSV, MCP `import_motion_graphics_csv`) are built — "Add another & bulk
import". Their gaps: an `Image URL` column is reported as ignored (no remote picture import), XLSX is not read, and
Add another has no keyboard shortcut (the free chord collides with macOS's Dock toggle).

## For agents choosing work

1. Read [CLAUDE.md](../CLAUDE.md), then this file. Prefer a gap in a feature parity.md marks as done over a new
   feature: a feature that exists but behaves differently from Premiere's documented behaviour is not done.
2. Fidelity comes from research, not measurement: cite the Adobe documentation and formulas you followed in your
   wp-note, and say so where behaviour is undocumented and you chose.
3. When you fix a behaviour bug in a feature marked done, add it to the evidence above. That is how this assessment
   stays honest.
4. **Don't raise parity.md's numbers without evidence**: a test, a measurement or a user-facing check that a reviewer
   can rerun, recorded in the wp-note and here.
