# wp `gaps` — the missing Premiere parity rows

Branch `feat/gaps` (parity program). Ports: [`licenses/ported/gaps.md`](../../licenses/ported/gaps.md). Fidelity comes
from Adobe's published Premiere Pro User Guide pages (titles below) and the EffectCraft / FilmCraft notes; where Adobe
documents nothing we chose the most plausible behaviour and say so here.

Rows closed (docs/parity.md): PRJ-4 Project Settings, PRJ-6 Project Manager, PRJ-8 proxies, TL-10 tracks, TL-11
Sequence Settings, FX-6 Warp Stabilizer, GR-4 / GR-5 Essential Graphics, AU-7 Audio Channels, EX-2 HEVC, EX-3 Export
Frame, AI-2 Auto Reframe + Morph Cut, UI-4 Preferences, UI-5 Find / Edit Original / Exit, UI-6 languages and
accessibility. PL-2 and HDR display hardware were out of scope.

## 1. What exists now

| Area | Where |
|---|---|
| Model | `packages/project/src/gaps/` — `settings.ts` (Project Settings, the gaps invariant registry), `proxies.ts`, `sequence-format.ts` (pixel aspect, fields), `audio-channels.ts`, `project-manager.ts`, `warp/` (analysis, maths, stabiliser, export checks, analysis requests), `auto-reframe.ts`, `graphics*.ts`; `find/` (Find); `timecode.ts` display formats |
| Commands | `commands/{schemas,handlers}/gaps.ts`: `media.attachProxy`, `media.detachProxy`, `clip.setAudioChannels`, `item.setAudioChannels`, `effect.setWarpAnalysis`, `sequence.autoReframe`, `graphic.update`, `graphic.addLayer`, `graphic.align`, `graphic.setPins`, `graphic.importTemplate`; `sequence.updateSettings` gained pixel aspect / storage width / field order, `track.add` a channel format |
| Effects / transitions | `registry/fx/warp-stabilizer.ts` (Distort ▸ Warp Stabilizer), `registry/transitions/premiere/morph-cut.ts` (Dissolve ▸ Morph Cut, replaces the earlier block-matching stand-in) |
| Engine | `apps/engine/src/gaps/` (media jobs: proxies / ingest; Project Manager; Warp Stabilizer analysis; Auto Reframe analysis; render budget), `tracking/warp.ts` (warp tracker in the OpenCV worker), `export/still-formats.ts` (Export Frame), `tools/encoders.ts` (libkvazaar / hardware HEVC), routes in `routes/gaps.ts` |
| Web | `apps/web/src/gaps/` (dialogs: Find, Add/Delete Tracks, Project Settings, Sequence Settings, proxies, Export Frame, Audio Channels, Project Manager, Auto Reframe; Preferences pages; Warp Stabilizer editor / banner / background analysis), `panels/essentialGraphics/`, `i18n/` + `apps/web/i18n/` (transform, Vite plugin, model names) |
| MCP | `apps/mcp/src/tools/gaps.ts` (23 tools, `GAPS_GUIDE`) |

## 2. Design and decisions

**Project Settings (PRJ-4).** `ProjectSettings.display` (video: timecode / frames / feet+frames 35 / 16 mm; audio:
samples / milliseconds), `scratch.media` (Captured and Generated Media folder) and `ingest` (copy / transcode /
proxies / copy and proxies, preset, destination). Every timecode field of the UI goes through
`gaps/time-display.ts`, so the display format follows the open project. Engine folders behind Scratch Disks are
shown read-only (`GET /api/projects/:id/scratch`).

**Proxies (PRJ-8).** A proxy is attached inline (`MediaAsset.proxy`): fingerprint, locators, probe, preset. Attaching
checks duration (± 1 frame), rate and orientation (`proxyMismatch`, `force` = attach anyway). Create Proxies is an
engine job (H.264 540/720/1080 presets, ProRes transcodes) that converts colour with the engine's input rule to
BT.709 and keeps rotation; ingest copies / transcodes / proxies run at import when Project Settings ▸ Ingest says so.
Toggle Proxies is a session toggle (Program / Source monitors and the shortcut editor's button bar); exports use the
originals unless Export ▸ Use Proxies (`draftUseProxies`: plan warning `DRAFT_PROXIES`, `PROXY_OFFLINE`). Reconnect
Full Resolution relinks the clip and makes the file it used its proxy.

**Tracks (TL-10).** Add Tracks / Delete Tracks dialogs (placement, audio track type mono / stereo / 5.1, delete empty
/ unassigned / named tracks with confirmation), Clip ▸ Rename, Track Height presets (save / manage / apply, 5 slots
with shortcuts), Minimise / Expand All.

**Sequence Settings (TL-11).** Timebase, frame size, pixel aspect ratio (square, D1/DV NTSC/PAL, widescreen, HDV 1.333,
DVCPRO HD 1.5, anamorphic 2:1), fields, drop frame, audio sample rate, Mix channel format, links to Video Previews and
Colour Settings; validation; New Sequence From Clip (size, rate, PAR, fields of the media). *Decision:* an anamorphic
sequence is edited at its display width (`width = storageWidth × PAR`) so every coordinate stays square; exports
deliver the storage width with the SAR flag (stream-copy remux), checked with ffprobe (HDV: SAR 4:3, DAR 16:9). Fields
are stored and exports are progressive with the `FIELDS_PROGRESSIVE` plan warning (field-rendered output would need
GPL filters; flagging through stream copy did not stick for H.264).

**Audio Channels (AU-7).** Clip ▸ Modify ▸ Audio Channels: the matrix of source channels × clip channels, clip channel
format, number of audio clips; muted clip channels play silence in preview and export; Project items keep a routing
that placements use.

**HEVC (EX-2).** libkvazaar in the LGPL FFmpeg build: Main (8-bit), presets mapped from the encoder speed, QP from the
CRF (+3), intra period a multiple of the GOP, BT.709 / BT.2020 + PQ / HLG VUI, `hvc1` tag. Kvazaar has no Main10 in
this build: HDR at 8 bits warns, Main10 is refused with the reason unless a hardware HEVC encoder (NVENC, QSV, AMF,
VideoToolbox, VA-API) is present.

**Export Frame (EX-3).** PNG / JPEG / TIFF / DPX (10-bit) / OpenEXR (linear half float through the working space's
EOTF) / BMP / Targa, to a folder (never overwriting, " (2)"), optionally imported; camera button in both monitors'
transport bars and Shift+E. The avc3 smart-render output was verified to play in Chrome and Electron with the frame
codes intact across copy / encode joins (`gaps-avc3-playback`), so no switch to avc1 was needed.

**Project Manager (PRJ-6).** Collect Files and Copy to New Location, or Consolidate and Transcode (ProRes 422 HQ /
WAV of the used range + handles, clips re-based by Replace Footage with Keep Source Timing over a declared source
range); Exclude Unused Clips, Include Handles, Include Preview Files, Include Proxies; disk estimate; the copy is
written as `<dest>/<name>.jasper` and registered as a project; a report lists what was written.

**Warp Stabilizer (FX-6).** A live GPU effect (Distort ▸ Warp Stabilizer) with Premiere's controls: Result (Smooth
Motion / No Motion), Smoothness, Method (Position / Position, Scale, Rotation / Perspective / Subspace Warp), Preserve
Scale, Framing (Stabilize Only / Stabilize, Crop / Stabilize, Crop, Auto-scale / Stabilize, Synthesize Edges),
Maximum Scale, Action-Safe Margin, Additional Scale, Detailed Analysis, Rolling Shutter Ripple, Crop Less ↔ Smooth
More (Adobe's 0–100, 50 = balanced), Synthesis Input Range / Edge Feather / Edge Cropping, Hide Warning Banner.
- *Analysis* (background, as Premiere): when a clip has an enabled stabiliser without a usable analysis, the editor
  starts the engine job `warp-analysis` on the clip's media range ± 15 frames (`tracking/warp.ts` in the OpenCV
  worker: Shi–Tomasi features with ids, pyramidal LK with a forward–backward check, median translation, RANSAC
  similarity, RANSAC homography; trajectories ≥ 6 frames). The result is stored **with the effect instance**
  (`EffectInstance.warpAnalysis`, `effect.setWarpAnalysis`, origin system: no undo step). It is indexed by media time,
  so trims inside the analysed span need no re-analysis. The Program monitor shows "Analyzing in background (step 1 of
  2)" over the clip while it runs; Effect Controls has Analyze / Cancel and a status line (frames, tracked share,
  auto-scale, frames limited by Maximum Scale).
- *Stabilisation* (`gaps/warp/stabilize.ts`, the EffectCraft port): corrections per method and result, Subspace Warp
  meshes, framing and the Maximum Scale relaxation; the plan is cached per analysis and settings, so changing a
  setting re-plans once. The shader samples the source through the frame's homography or mesh; Synthesize Edges fills
  uncovered pixels from up to 8 neighbouring frames (time samples) mapped through the analysed motion.
- *Export:* GPU effects export through the layer bake / Remotion like every shader effect; an enabled stabiliser
  without analysis blocks every path (`WARP_NOT_ANALYZED`), frames outside the analysed span warn (`WARP_PARTIAL`).

**Auto Reframe (AI-2).** Sequence ▸ Auto Reframe Sequence…: Target Aspect Ratio (Square 1:1, Vertical 4:5, Vertical
9:16, Horizontal 16:9, Custom) and Motion Tracking (Slower / Default / Faster). The engine job `reframe` finds the
subject per frame: faces (BlazeFace through the roto workstream's model, every 3rd frame, when installed) else a
saliency centroid (motion after removing the dominant camera shift + centre-surround contrast of luma and chroma +
skin tone, top 15 %). `sequence.autoReframe` duplicates the sequence at the new size, scales video clips to fill and
keys their Position (Gaussian + dead-zone smoothing per preset, kept covering the frame, thinned to ≤ 1.5 px error
with a key at least every 2 s). Clips with animated Motion are kept as they are (reported). *Not done:* Premiere's
"Clip Nesting" option.

**Morph Cut (AI-2).** The transition that existed (block matching on 1/8-size luma, a warp-dissolve) was replaced by
the time workstream's optical flow run as transition passes: analysis luma (≤ 1024 px), 2×2 pyramid, hierarchical
8×8 block matching (SAD ±4 at the top, ±1 around seeds below), sub-pixel parabola, 3×3 median, then the per-pixel
ten-hypothesis interpolation with forward / backward agreement. Exactly A at 0 and B at 1. Premiere's face-aware
analysis is not reproduced: the flow is generic.

**Essential Graphics (GR-4 / GR-5).** A *graphic* is a nested sequence flagged `Sequence.graphic`; its tracks are its
layers and the nest clip is the graphic clip, so text animators, shapes, effects and keyframes all apply and render on
every path the nest does. The Essential Graphics panel (Window ▸ Essential Graphics, Motion workspace): Browse (My
Templates in this browser, Import Template (.jgt)…, link to Motion Templates) and Edit (layer list top first with
visibility / rename / delete / selection, New Layer Text / Rectangle / Ellipse, Align and Transform: 6 aligns + 2
distributes to the frame or the selection, Responsive Design – Position: pin edges to the video frame or a layer,
Responsive Design – Time: Intro / Outro, Graphic Duration, Roll / Crawl Left / Crawl Right with Start Off Screen,
End Off Screen, Pre-roll, Ease-in, Ease-out, Post-roll, Export As Template / Save to My Templates). Pins, Intro /
Outro protection and Roll are applied when a render snapshot is built (`applyGraphics`): pins translate the layer;
a graphic clip shorter than its graphic gets a generated Time Remapping that plays the Intro and Outro at speed; roll
writes Position keys on the nest. *Template format* `.jgt`: JSON `{format: "jasper-graphic-template", version: 1,
name, frame, payload}` where `payload` is the `project-items` clipboard payload of the graphic's sequence item
(layers, fonts, media references) — importing pastes it and places the graphic. **MOGRT import is not implemented:**
a .mogrt is a zip around an After Effects project (`.aegraphic`) or a Premiere graphic (`.prgraphic`) whose layer data
is an undocumented binary format; `definition.json` only lists the editable controls, not the layers or their look.
There is no published spec of a "text-only subset" to implement against, and reverse engineering Adobe's format is
out of bounds; `.jgt` is the template path, and Motion Templates (fframes / anime) cover parametric templates.
*Limits:* a graphic clip can be trimmed only within its graphic's duration (set Graphic Duration to lengthen it);
pins use the layers' static bounds; responsive time needs Intro / Outro > 0 and is not applied to speed-changed or
time-remapped graphic clips; layer order is the track order (move a layer's clip to another track to reorder).

**Preferences (UI-4).** Appearance (theme, contrast, density, reduced motion, language), Auto Save (on / off, interval:
off writes on Save and close, the journal still records), Labels (names, label defaults per item kind), Memory (render
pages for exports / previews / bakes, engine-side), Playback (pre-roll / post-roll used by Play Around and trim
playback), Trim (Large Trim Offset), Audio Hardware (output device through `setSinkId`, latency hint). Collaboration
and Sync Settings are omitted (no such services here).

**Find, Edit Original, Exit (UI-5).** Edit ▸ Find… (Project panel or timeline scope, two criteria, match all / any,
case, Find / Find All), Edit Original (desktop: the default application; web with a local engine: reveal in the file
browser; executables are never opened), File ▸ Exit (desktop only, asks to save).

**Languages (UI-6).** All UI strings are externalised by a build-time transform (`apps/web/i18n/transform.mjs`, Vite
plugin `jasper-i18n`): JSX text, UI attributes (title, aria-label, placeholder, label…), UI properties (label, title,
description, detail, message, disabledReason…), `*_LABELS` maps and menu helper labels become `__t("…")` (template
literals with substitutions become `__t("… {0} …", a)`); ids, class lists and data strings are left alone. Names
that come from the model (8 000-odd effect, parameter, transition and command labels, `model-strings.json`) are
translated at display time by a document observer (only exact model names; user names are marked `data-no-i18n`).
English is the source; the Spanish catalogue `es.json` is complete (8 054 strings; `pnpm i18n:check`, the web test
`i18n.test.ts`). Preferences ▸ Appearance ▸ Language switches after a restart (Premiere also restarts), with a
Restart Now action. *Maintenance:* adding UI strings requires `pnpm i18n` and their Spanish in `es.json` (the test
fails otherwise).

**Accessibility (UI-6).** Reduced motion (preference or system; `data-pr-motion` disables transitions and
animations), the high-contrast theme, ARIA names on the new controls (listbox / option roles for the layer list,
`role=status` for live status lines and banners). The axe-core audit (`e2e/gaps.spec.ts`, WCAG 2.1 A/AA, default and
high-contrast themes) runs over the main workspaces; see §4 for its result.

## 3. Usage

- Warp Stabilizer: drag it from Effects ▸ Distort onto a clip; the analysis starts by itself; change Result / Method /
  Framing; Analyze re-runs it, Cancel stops it. Agents: `stabilize_clip {clipId, params}`.
- Auto Reframe: Sequence ▸ Auto Reframe Sequence…, choose the aspect and tracking, Create (opens the new sequence).
  Agents: `auto_reframe_sequence {aspect: "9:16"}`.
- Morph Cut: Effects ▸ Video Transitions ▸ Dissolve ▸ Morph Cut on a jump cut.
- Essential Graphics: Window ▸ Essential Graphics ▸ Edit ▸ New Layer ▸ Text (makes a graphic at the playhead), add
  layers, align, pin, set Intro / Outro and Roll; Export As Template for a .jgt. Agents: `create_graphic`,
  `set_graphic`, `export_graphic_template`, `import_graphic_template`, `apply_commands` with `graphic.*`.
- Language: Edit ▸ Preferences ▸ Appearance ▸ Language ▸ Español, then Restart Now.

## 4. Verified behaviour

| What | How | Result |
|---|---|---|
| Find, Add/Delete Tracks, track heights, rename, Exit | `apps/web/test/gaps-ui5-tracks.test.tsx`, `packages/project/test/gaps-find.test.ts` | pass |
| Display formats, Project / Sequence Settings, proxies UI | `gaps-display-format`, `gaps-sequence-format`, `gaps-proxies` (project), `gaps-settings-dialogs` (web) | pass |
| Proxies, ingest, draft exports | `apps/engine/test/gaps-media-jobs.test.ts`: proxy sizes, rotation kept, ProRes transcodes, Use Proxies renders the proxy at the original size (mean pixel difference < 6 levels vs the original) | pass |
| HEVC, anamorphic, fields | `gaps-export-formats`: hvc1 + BT.709 VUI, PQ at 8 bits with a warning, Main10 refused, HDV SAR 4:3 / DAR 16:9 | pass (ffprobe) |
| Export Frame | `gaps-export-frame`: EXR gray 0.5 → its BT.1886 EOTF in half float, no overwrite, refusals | pass |
| avc3 playback | `gaps-avc3-playback`: Chrome and Electron play every frame and seek across joins (frame codes read with requestVideoFrameCallback) | pass |
| Audio Channels | `gaps-audio-channels` (project + engine): routing, muted channel decodes to silence | pass |
| Project Manager | `gaps-project-manager`: consolidated copy shows the same frame codes (42 in both) from its own file; collect copies whole files | pass |
| Preferences | `gaps-preferences`: pages, Playback / Trim / Auto Save drive behaviour, hostile storage parses to defaults | pass |
| Warp Stabilizer maths | `packages/project/test/gaps-warp-stabilizer.test.ts`: jitter after < 20 % of before for Position / PSR / Perspective; No Motion fixes a scene point to 1e-6 px; crop rect covered by every frame; auto-scale covers the frame; Maximum Scale relaxation; Preserve Scale; Subspace Warp residual < 0.6 × Perspective's on a parallax scene; command, undo, refusal, INV-WARP repair | pass |
| Warp Stabilizer shader | `packages/compositions/test/fx-warp-stabilizer-gl.test.ts` (headless Chrome WebGL2): No Motion output = input shifted by the exact path difference (error 0) for the three homography methods; Subspace Warp through its mesh; transparent uncovered edge; pass-through without analysis | pass |
| Warp analysis on footage | `apps/engine/test/gaps-warp-analysis.test.ts` on `shaky.mp4` (known random walk): per-frame translation and homography within 0.75 px of the walk on ≥ 87 of 89 frames, > 40 trajectories, tracked share > 0.8; No Motion holds a scene point within 1.5 px (2.5 px Subspace Warp); planner refuses `WARP_NOT_ANALYZED`, accepts the analysed effect | pass |
| Auto Reframe | `apps/engine/test/gaps-reframe.test.ts` on `reframe.mp4`: saliency centre median x error < 6 % of the width (p90 < 15 %); the 9:16 copy keeps the subject inside the middle 80 % on ≥ 4 of 5 sampled frames and the picture always covers the frame | pass |
| Morph Cut | `transition-premiere-gl.test.ts`: a moved square morphs (one square half-way); textured jump cut: mid-frame error < 0.5 × a film dissolve's and < 25 levels; contract A at 0 / B at 1; fingerprints re-blessed for the new algorithm | pass |
| Essential Graphics | `packages/project/test/gaps-graphics.test.ts`: align / distribute, responsive time, roll positions, pins after a frame-size change, refusals, undo, remap in the snapshot, roll keys, INV-GRAPHIC repair, .jgt round trip | pass |
| i18n | `apps/web/test/i18n.test.ts`: every extracted UI string and model name has Spanish with the same placeholders; transform rules | pass |
| Built app | `e2e/gaps.spec.ts` (`E2E_PORT=49540 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/gaps.spec.ts`), screenshots in `test-results/gaps/`: axe-core WCAG 2.1 A/AA audit of six workspaces × default and high-contrast themes with no serious or critical violation; Warp Stabilizer banner then analysis stored (> 420 frames); Essential Graphics New Text → second layer → align left; Auto Reframe Sequence → 608 × 1080 copy; Spanish UI after a restart | 5 / 5 pass |

Plan cost (measured with `tsx` on a 12-core machine at load average ≈ 50 from other agents, synthetic 1080p analysis):
Perspective plans 900 frames in ≈ 0.1 s; Subspace Warp 300 frames ≈ 1.3–2.7 s, 900 frames ≈ 2.5–4 s (the smoothing and
the mesh solves; once per settings change, cached).

## 5. Comparison with the references

| | Premiere | EffectCraft | Here |
|---|---|---|---|
| Warp Stabilizer | Sensei analysis, banners, Subspace Warp | analysis + plan in Rust (rayon) | same algorithms ported; analysis in the engine (OpenCV.js), plan in TS (banded mesh solves, warm-started subspace iteration), Synthesize Edges from 8 neighbouring frames |
| Auto Reframe | Sensei subject detection, nesting option | — | faces when the model is installed, else saliency; no nesting option |
| Morph Cut | face tracking + flow | block flow | the time workstream's hierarchical flow with occlusion-aware interpolation |
| Essential Graphics | graphics with layers, responsive design, MOGRT | — | graphics = flagged nested sequences; responsive position / time and roll applied at render; .jgt; no MOGRT |
| HEVC | Main / Main10 | — | Main (kvazaar), Main10 only with hardware encoders |

## 6. Limits

- Fields: stored, exports progressive. Kvazaar: 8-bit only. PAR sequences edit at display width.
- Project Manager consolidates to ProRes 422 HQ / WAV only; previews are copied, not re-linked in the copy.
- Warp Stabilizer: the analysis covers the clip's range ± 15 frames (extending the clip re-analyses); clips with speed
  changes map through their rate (Time Remapping is not followed); the Subspace Warp plan costs seconds on long clips;
  Detailed Analysis doubles the analysis resolution only.
- Auto Reframe: no Clip Nesting option; saliency can follow the wrong object on busy shots (install the face model).
- Morph Cut: generic flow, no face model; large motions between takes fall back to a cross-fade look.
- Essential Graphics: see §2; no MOGRT import.
- Languages: the model-name translation works on exact text nodes; composite labels built from model names (e.g.
  "Gaussian Blur: Radius") stay English. Changing language needs a restart.
