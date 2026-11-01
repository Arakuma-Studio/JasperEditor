# agent-footage-export — GIF and audio-only exports (spec 18 AF-EXP-001…003)

Workstream AF-EXP of [spec 18](../specs/18-agent-footage-editing.md) §2.7. No code is ported.

## 1. What exists now

| Feature | Where |
|---|---|
| Settings: `container` `gif` / `wav` / `flac` / `m4a`, `gif {fps, width, loop, dither, bayerScale, palette}`, `audio.codec` `flac`, `audio.bitDepth` 16 / 24 | `packages/api/src/exports.ts` (`EXPORT_CONTAINERS`, `ExportGifSchema`, `GIF_LIMITS`) |
| Plan: `path: 'audio'`, `plan.deliverable` (GIF rate, size, frames, loop, dither, palette; audio container, codec, rate, channels, depth / bit rate), warning `GIF_NO_AUDIO` | `RenderPlanSchema`; `apps/engine/src/export/planner.ts` (`planExport`, `planAudioOnly`) |
| What the settings ask for, refusals, GIF size / frames / loop, filtergraphs, muxer arguments | `apps/engine/src/export/deliverables.ts` |
| GIF render + conversion, audio-only file, verification | `apps/engine/src/export/service.ts` (`renderGif`, `renderAudioOnly`, `finishExport`) |
| FLAC encode (16 / 24-bit), FLAC as lossless in the loudness delivery | `apps/engine/src/tools/encoders.ts` (`audioEncodeArgs`), `apps/engine/src/audio/deliver.ts` (`isLossyCodec`, `deliveryContainerOf`) |
| Result: `container`, `encoder: 'gif'`, `gif {fps, width, height, frames, loop}`, `renderPath: 'audio'`, `audioCodec` | `ExportResultSchema` |
| MCP `start_export {format: video \| gif \| wav \| flac \| m4a, gif, audioBitDepth, audioBitrateKbps}` | `apps/mcp/src/tools/render.ts`, `apps/mcp/src/export-presets.ts` (`buildDeliverableSettings`) |
| Export mode ▸ Export As (Video / Animated GIF / Audio Only – WAV, FLAC, M4A) with their rows; remembered per sequence; Quick Export uses it | `apps/web/src/export/{ExportMode.tsx,settings.ts,quick.ts}` |

## 2. GIF (AF-EXP-001)

- **Nothing dropped.** `deliverableOf` turns a GIF request into the settings of a picture intermediate — ProRes 4444
  (10-bit 4:4:4) in MOV at the GIF's size and the *sequence* rate, `videoOnly`, colour space `working` — and the planner
  plans that like any export: the same blockers, path choice (native, hybrid layer bake, Remotion), Remotion fallback
  (S11:LBK-023) and Use Previews. The plan id is computed over the requested GIF settings.
- **Conversion** (`gifGraphs`, LGPL filters only, checked with `assertLgplFilters`): `fps=<rate>` (nearest frame), then
  YUV → RGB with the intermediate's matrix (BT.709, BT.2020 for BT.2020 / HDR working spaces), limited range, the
  engine's `SWS_FLAGS`, then the working space's display LUT (`displayLutFilter`, as stills and `render_frame` do:
  HDR is tone-mapped to the Program monitor's Rec. 709 rendition). Palette `full` / `diff` run two passes
  (`palettegen` writes one PNG, then `paletteuse`), so no frame is buffered; `single` is one pass with a palette per
  frame (`paletteuse new=1`). `diff` adds `diff_mode=rectangle`.
- **Why 4444.** The GIF frame vs Program SSIM was 0.916 with a 4:2:2 intermediate and 0.9755 with 4:4:4 (§5).
- **Numbers.** Rate 1–50 fps, default 15 (browsers clamp delays under 2 cs, i.e. above 50 fps, to 10 cs — assumption
  from common browser behaviour, not a cited spec). Width 16–4096, default the sequence width capped at 1080; both
  sides even, height at the sequence aspect; GIFs are square-pixel (anamorphic sequences are not signalled). `loop`:
  0 = forever, 1 = once (no NETSCAPE2.0 block), n = n plays (muxer `-loop n−1`). Dither `sierra2_4a` (default),
  `sierra2`, `floyd_steinberg`, `bayer` (`bayerScale` 0–5, default 2), `none`.
- **Frames.** round(duration × fps), at least one — measured with ffmpeg 6.1's `fps` filter (7 frames at 30 fps → 4 at
  15; 45 → 19 at 12.5; 1 → 1). The job fails `FRAME_COUNT_MISMATCH` (retryable) when the file differs.
- **Sound.** None; the plan's first warning is `GIF_NO_AUDIO` (also naming a requested credits file that is not
  written). Caption streams are refused; burn-in and sidecars work.
- **Progress and cleanup.** Render 0–80 % (stages "GIF 1/2 · …"), palette 80–86 %, frames 86–99 %. The intermediate
  and palette are in the job's scratch directory, deleted after the conversion and with the directory on any end;
  a cancel removes the output directory (job partial).

## 3. Audio only (AF-EXP-002)

- The planner returns before anything visual is checked (`planAudioOnly`): visual blockers, missing templates, roto or
  warp analysis do not refuse an audio file; audio effects without a processor still do (`AUDIO_EFFECT_UNSUPPORTED`),
  as on every path. Offline audio clips warn `OFFLINE_MEDIA`.
- The mix is `renderAudio` → `renderMixdown`, the one offline mixer every export path uses, over the export range at
  the export's channels (1 / 2 / 6, 5.1 folded by BS.775), rate (44.1 / 48 / 96 kHz, SoX when present) and loudness
  normalisation (the Mix's, or `audio.normalize`), with the delivery's decoded check for M4A (lossy) and for any
  resampled file. FLAC counts as lossless (no codec headroom).
- Encoders: WAV `pcm_s16le` / `pcm_s24le` (`-rf64 auto` past 4 GiB), FLAC `flac` (`-sample_fmt s16` / `s32` → 24-bit),
  M4A `aac` (bit rate, default 192 kb/s stereo, 384 for 5.1; `ipod` muxer with `+faststart`). The checked AAC encode
  of a normalised delivery is stream-copied. 16-bit files are not dithered (as every PCM export path).
- The file's duration is checked against the range: |file − range| ≤ max(1 frame, 50 ms), else `DURATION_MISMATCH`.
- Refusals (`VALIDATION_FAILED`): `video` or `videoOnly` with an audio container, a codec other than the container's
  (WAV = `pcm`, FLAC = `flac`, M4A = `aac`), `bitDepth` with M4A or a video container, FLAC in a video container,
  caption streams. Burned-in captions do not apply; sidecars do.

## 4. Editor and MCP (AF-EXP-003)

- Export mode ▸ **Export As**: *Animated GIF* shows Frame Rate, Width (empty = automatic), Loop (Forever / Play once /
  a number of times), Dither, Palette, plus Engine, Previews, Proxies and the caption Burn In / Sidecar rows; codec,
  encoder, colour, sound and smart-render rows are hidden, Sound Check is not offered. *Audio Only – WAV / FLAC* show
  Bit Depth, *M4A* Bit Rate (128–320 kb/s), with Audio Channels, Sample Rate, Loudness, Credits and caption sidecars;
  picture rows and Engine are hidden. The Summary line and the downloaded name's extension follow the file. The
  disabled "Audio Only" destination placeholder was removed.
- MCP `start_export {format}`: options of another format (`preset`, `crf`, `videoBitrateKbps` with GIF / audio, `gif`
  outside GIF, audio options with GIF, `audioBitDepth` outside WAV / FLAC, `audioBitrateKbps` outside M4A) are refused
  by name (`E_INVALID_PARAM`); `plan.deliverable` and `result.gif` / `result.container` / `result.audioCodec` describe
  the file.

## 5. Validation (measured 2026-10-31 / 11-01, shared 4-core host under load from 10 agents, ffmpeg 6.1 system build with `JASPER_FFMPEG_LGPL_ONLY=1`)

| Check | Result | Rerun |
|---|---|---|
| GIF frame 10 (15 fps) vs the Program still of sequence frame 20 at 320 px, SSIM (ffmpeg `ssim`, RGB, all planes); tolerance ≥ 0.95 (`GIF_SSIM_MIN`) | 0.9755 (4:4:4 intermediate); 0.916 with 4:2:2; neighbouring frames ≈ 0.85 | `apps/engine/test/export-gif-audio.test.ts` |
| GIF ffprobe: codec `gif`, 320×180, 30 packets for 2 s at 15 fps; NETSCAPE loop 0; loop 1 → no block; loop 3 → 2; 1 s at 10 fps → 10; 2 s at 12.5 → 25 | pass | same |
| WAV 16 / 24, FLAC 16 @ 44.1 kHz, FLAC 24 mono, M4A 128 kb/s @ 44.1 kHz on a 1 s range: codec, rate, channels, bits, duration within 50 ms | pass | same |
| 24-bit WAV vs the 24-bit PCM stream of a ProRes MOV export of the same range | sample-identical (max difference 0) | same |
| M4A normalised to −20 LUFS / −1 dBTP, measured on the decoded file | within 0.5 LU, true peak ≤ −0.9 dBTP | same |
| Cancel during "GIF 1/2": output and scratch directories removed | pass | same |
| MCP GIF (480×270, 10 fps, 20 frames, loop 2 plays), WAV 16-bit mono 44.1 kHz, M4A 128 kb/s, refusals | pass | `apps/mcp/test/export-gif-audio.test.ts` |
| Export dialog rows, settings reaching plan / export, extension, remembered choice | pass | `apps/web/test/export-gif-audio.test.tsx` |
| Running dev engine (port 48080, vendor LGPL FFmpeg 7.1.5): 1280×720 30 fps footage, `start_export {format: gif, fps 15, width 640}` → native path, progress through "GIF 1/2 · Encoding (native)" 0–71 %, "GIF 2/2 · Building the palette" 80 %, "Writing frames" 86–99 %; 60 frames 640×360; GIF frame 30 vs `render_frame` at sequence frame 60 (640 px): SSIM 0.987, burned-in source timecode 00:00:02.000 / 60 identical (inspected side by side) | pass | §5 commands in this note |
| Same sequence with a text layer, from Export mode ▸ Export As ▸ Animated GIF in headless Chromium (Playwright): plan "Auto → Hybrid (1 layer pre-rendered by Remotion)", job done, 60 frames; GIF frame 30 vs `render_frame` at frame 60: SSIM 0.986, text identical side by side. Forced `engine: remotion` (MCP): `renderPath: remotion`, SSIM 0.954 against the native still | pass | — |
| Export mode screenshots (Playwright, 1600×1000): GIF rows (Frame Rate, Width with automatic placeholder, Loop + plays, Dither, Palette, note, Engine / Previews / Proxies; codec, colour, sound and smart-render rows hidden), WAV rows (Bit Depth, channels, rate, loudness; picture rows and Engine hidden), M4A (Bit Rate), Spanish catalogue | pass | — |
| Running dev engine: `start_export {format: flac, audioBitDepth 16, normalizeLufs −16}` → FLAC 16-bit 48 kHz stereo, 4.000 s; `ebur128` of the file −16.0 LUFS | pass | — |

## 6. Limits

- The automated GIF tests exercise the native path; the hybrid and Remotion paths were verified by hand in the running
  app (§5), not by a test in the default gate (they need a headless browser).
- The Summary line (`outputDescription`) is English in every language, as it was before this work.
- GIF estimates (≈ 0.25 byte per pixel and frame) and FLAC (≈ 60 % of PCM) are assumptions, labelled in the code.
- The intermediate renders every sequence frame of the range at the GIF size; long GIFs at high sequence rates cost
  render time and scratch space (ProRes 4444 ≈ 330 Mbit/s at 1080p30).
- Export settings are remembered in the browser's storage (not the project document): no schema change.
