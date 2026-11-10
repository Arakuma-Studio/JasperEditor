# Export performance: phases, loudness passes, parallel segments, GPU

Work note for the native / hybrid export speed-up (`apps/engine/src/export/service.ts`, `segments.ts`,
`run-report.ts`). Figures are labelled **measured** (with machine and load) or **estimated** (`≈`, with a basis).

## Starting point (measured on the user's PC)

Machine: RTX 3080 Ti, 24 logical cores, NVIDIA driver 595.99, Ubuntu; the user's session otherwise idle (reported by
the coordinator). Sequence 1920×1080 @ 60 fps, 15:31, 361 cuts on V1/A1, 1,930 subtitle clips on V4 (each with
`jasper.transform` keyframes + `jasper.s.shake`), 17 animated text cards on V2 (≈ 6 s each). Export
`draft-720p-h264`, `normalizeLufs: -14`, hybrid path, NVENC. Total 19.5 min:

| Phase | Wall time | Utilisation |
|---|---:|---|
| audio mix + loudness + layer bake (concurrent) | 5.8 min | GPU 21 %, CPU 46 % (ffmpeg 5.9 cores, render Chrome 2.0) |
| planning layers | 1 min | |
| encode (one native graph) | 12.8 min, ≈ 73 fps (55,860 frames) | GPU 2.6 %, NVENC 5 %, NVDEC 0 %, CPU 45 % (ffmpeg 6.4 cores, node 2.6) |

The composite was one `filter_complex` with one `overlay=…:format=rgb` per layer over a sequence-size background
(≈ 2,000 chained overlays): every frame traverses every overlay (`enable=` skips the drawing, not the traversal) and
the graph runs on few threads, so more than half the CPU and nearly all of the GPU idled.

## 1. Instrumentation

Every export job result now carries `timings` (`ExportTimingsSchema`: `totalMs` and, per phase, `startMs` from the
job's start and the summed `ms`) and, on the native / hybrid paths, `pipeline` (`ExportPipelineSchema`: `decode`
`nvdec | cpu`, `composite` `gpu | cpu`, `segments`, `overlays` of the largest graph, `compositeSize`, `reason` when the
range was not split). The plan carries the expected `pipeline` (its `overlays` is the number of top-level visual
layers of the busiest segment, an upper bound: kernel streams draw a run of constant layers through one overlay).
The job log ends with one `timings (total …)` line. Phases: `masters`, `audio`, `bake`, `audioWait`, `plan`,
`bakeWait`, `encode` (or `still`), `join`, `frameCheck`, `remotion`, `finish`; they overlap (the mix runs while layers
bake), which `startMs` shows. MCP: `start_export`'s `plan.pipeline`, and `result.pipeline` / `result.timings` in
`start_export {wait: true}` and `wait_for_job` (the job result is passed through; no tool text changed).

Tests: `apps/engine/test/export.test.ts` ("plans and exports a 2-track sequence…") and
`apps/mcp/test/export-delivery.test.ts`.

## 2. "Normalizing loudness" twice

The label is the progress stage of every written delivery pass (`writeDeliveryWav` in `audio/mixdown.ts`, called by
`solveDelivery` in `audio/deliver.ts`); `audio/service.ts:532/567` is the per-media Normalize job, not exports. A
normalised lossy export writes several passes, each a gain + true-peak-limiter pass over the whole mix, and each shows
the same label. The delivery now counts them by purpose (`DeliveryOutcome.passKinds`, in the job log's `audio:` line):

- `converge`: secant steps of the loudness convergence under the limiter (wp-note sound-design "Fix: lossy-codec
  true-peak headroom and loudness convergence"). **Necessary**: each runs at new parameters, and the pass that lands
  is the delivered file. A loud or speech mix pushed to −14 LUFS takes 3–4 (measured below).
- `alternative`: lower-ceiling candidates written while the round's first AAC encode runs, so that a round whose first
  encode overshoots the true peak does not need another round. Speculative: wasted when the first encode meets the
  target (it did in both speech runs below).
- `rewrite`: parameters measured earlier, written again because a later pass overwrote the output.

**Duplicated work found and removed**: a candidate measured at its predicted gain got a second, "secant" pass when it
missed the aim, but when the push was at its cap (initial gain + 6 dB, typical for quiet speech normalised to
−14 LUFS) the secant step returned the gain just measured, and the identical pass was written again (same bytes, same
measurement). The second pass is now skipped when its gain equals the first's: the first measurement is kept.
Loudness results are identical (same parameters, same files, same decoded check).

Measured with `node --import tsx` on a scratch driver calling `solveDelivery` (AAC 128 kb/s, −14 LUFS / −1 dBTP,
`parallel: 3`, the draft preset's delivery), this host (16 logical cores, shared, load ≈ 2 before / ≈ 29 after the
change, so only pass counts compare):

| Mix | Passes before → after (converge / alternative) | Encodes | Decoded LUFS / dBTP (before = after) |
|---|---|---:|---|
| speech-like 20 s | 8 (4 / 4) → 6 (4 / 2) | 3 | −14.197 / −1.405 |
| speech-like 120 s | 8 (4 / 4) → 6 (4 / 2) | 3 | −14.194 / −1.586 |
| `loudMix` 60 s (test fixture) | 9 (4 / 5) → 9 (4 / 5) | 6 | −13.982 / −1.727 |

One pass over 120 s of stereo took ≈ 1.65 s at low load here (13.2 s for 8), so ≈ 13 s for the 15:31 sequence
(estimated: linear in length); the user's PC reported ≈ 2.5 min between the two labels, concurrent with the layer
bake. Remaining limit: candidates are still written before the first encode is checked; making them lazy would save
their passes when the first encode meets the target, but changes the encode counters and, where the 8-encode cap is
reached, the search order — not done here. Test: `apps/engine/test/audio-deliver.test.ts` ("writes no pass twice…",
fails before the change: 6 distinct of 8 written passes).

## 3. Parallel picture segments

`segments.ts` splits the export range into frame-exact segments; `service.ts` (`runNative`) builds each one as an
export of its own sub-range (`buildNativeGraph` with `snapshot.range` = the segment, picture only), runs them at
once, checks each segment's frame count and parameter sets, and joins them with the sound by stream copy
(`joinSegments`: concat demuxer + the mix through `mixAudioFilters`, the chain a one-graph export applies, or the
delivery's checked encode copied).

- **Only their own layers**: `drawStack` already clips every layer to `[range.start, range.end)` and drops the ones
  outside; a layer that starts before the segment starts mid-layer exactly as a range export starts (seek windows,
  fades started inside a ramp, keyframes sampled at absolute frames, kernel streams planned from the segment's first
  frame). Each segment is therefore the range export of its frames.
- **Boundaries**: `count` near-equal parts; each inner boundary moves to the nearest clip start / end on the lowest
  video track within a quarter segment (a segment then starts on a fresh source), else stays on its frame (any frame
  is exact). Every segment is its own encode, so it starts with a key frame; the concat demuxer continues each
  segment's timestamps from the previous one's duration (measured with B-frames: libx264 `-bf 3` at 60000/1001,
  three 100-frame MP4 segments joined: 300 frames, every PTS step 1001 in 1/60000, first PTS 0).
- **How many** (`JASPER_EXPORT_SEGMENTS`: `auto` default, a number, `1` = off): `auto` takes
  `min(⌊length / JASPER_EXPORT_SEGMENT_MIN_SEC (20 s)⌋, ⌊CPU slots / JASPER_EXPORT_SEGMENT_SLOTS (3)⌋, cap)`, the cap
  being `JASPER_EXPORT_HW_SESSIONS` (default 4) for hardware encoders and 16 otherwise. Consumer NVIDIA drivers
  limited concurrent NVENC sessions (3 before 2023, 5 and later 8 in later drivers, per NVIDIA's support matrix as
  reported; undocumented assumption for older drivers); on the user's PC (driver 595.99) 12 concurrent `h264_nvenc`
  sessions ran (measured: `nvidia-smi encoder.stats.sessionCount` = 12, all exited 0). 4 stays well under every
  limit.
- **One graph** (plan / result `pipeline.reason`): segments off; an encoder whose segments are not known to join
  (`JOINABLE`: H.264 / HEVC encoders and ProRes; VP9 / AV1 / GIF intermediates keep one graph); alpha masters; an
  output rate that differs from the sequence's or a frame count that differs from the range; shorter than two
  minimum segments; too few CPU slots. Stills always use one graph. Segments whose parameter sets differ (never seen;
  checked by the SHA-256 of each segment's extradata) are re-rendered as one graph.
- **Failures**: the first failing segment's error is the job's (`killedComposite` for an OOM kill, stream errors as
  before); the others are stopped (their abort signal); a cancelled job stops every segment; the segment files live
  in the job's scratch directory, removed on success, failure and cancellation; pipelined-bake restarts and
  background failures behave as with one graph.
- **Threads**: each segment's encoder / motion threads and its filter graph (`-filter_complex_threads`) get
  `⌊slots / segments⌋` (ffmpeg's default is one filter thread per CPU in every graph); kernel stream workers are
  divided over every stream of every segment.
- **Sound**: the sound of a segmented export (the mix WAV through `mixAudioFilters` and the deliverable's encoder, or
  silence; the delivery's checked encode is used as it is) is encoded into the scratch directory while the segments
  render (phase `sound`), so the join only copies (measured: join 7.8 s → 0.2 s on the 200 s bench below).

Identity with one graph: the composite of each segment is the one-graph composite of its frames, so a ProRes export
(intra-only: each frame encoded on its own) decodes to identical frames (`framemd5`) and identical sound; an H.264
export differs only by encoder decisions at the segment starts (key frames: SSIM 0.9895 on the first frame of a
segment, ≥ 0.98 everywhere; OpenH264, this host). Program-preview parity is therefore that of the one-graph path.
Tests: `apps/engine/test/export-segments.test.ts` (ProRes identity, H.264 SSIM / timestamps / key frames / colour
tags / sound, a failing segment, cancellation); the one-graph suites `export.test.ts`, `blend-export.test.ts`,
`export-gif-audio.test.ts`, `edit-structure-export.test.ts`, `subtitles-export.test.ts`, `time-export.test.ts` pass
unchanged.

Measured on this host (16 logical cores, no GPU, shared with other agents: load average 7 → 33 during the runs, so
only indicative): a 60 s 1080p60 sequence (24 cuts on V1, 120 sub-pixel keyframed stills on V2), exported 1280×720
H.264 (OpenH264) — one graph: encode 381 s; `auto` (3 segments): encode 232 s + join 10 s (1.57×; before the
filter-thread budget and the concurrent sound encode).

Measured on the user's PC (RTX 3080 Ti, 24 logical cores, driver 595.99; the user's desktop session running, load
average 2–18 during the runs; scratch driver `zz-bench-segments`, not committed): synthetic 1080p60 sequences (a V1
cut every 300 frames alternating two H.264 sources, a sub-pixel keyframed still every 30 frames on V2, drawn by one
kernel stream), exported 1280×720 H.264 with `h264_nvenc`, `normalize` off:

| Sequence | Mode | Encode | Join | Total job | Notes |
|---|---|---:|---:|---:|---|
| 63.5 s (3,810 fr.) | one graph | 30.0 s | — | 31.7 s | ffmpeg ≈ 10 cores: `fc0` thread 80 %, slice threads ≈ 29 % each |
| 63.5 s | 3 segments | 24.1–24.7 s | 2.5 s | 29.0 s | 3 × ffmpeg ≈ 4.4 cores, ≈ 21 % idle (CPU-bound) |
| 203.5 s (12,210 fr.) | one graph (NVDEC) | 96.2 s | — | 101.2 s | |
| 203.5 s | `auto` = 4 segments (NVDEC) | 72.1 s | 0.2 s | 78.3 s | 1.29× total; peak VRAM 3.9 GB (baseline ≈ 2.4 GB) |

So on CPU-bound pictures segments give 1.2–1.3× here, because one graph already spreads its per-pixel work over
slice threads; the per-frame CPU cost dominates (§4). On the user's sequence one graph used ≈ 45 % of the CPU at
73 fps with ≈ 400–2,000 overlays and hundreds of open inputs per graph, where splitting also cuts the per-frame
traversal and the open inputs per graph: its gain must be measured there (see "To verify on the GPU PC").

## 4. Composite at output size (evaluated, not implemented)

A downscaled export (1920×1080 sequence → 1280×720 draft) composites at the sequence size and scales at the end. The
per-frame CPU cost is dominated by full-size pixel work: measured on the user's PC, converting one 1080p H.264 frame
to RGBA with the composite's swscale flags (`bicubic+accurate_rnd+full_chroma_int+full_chroma_inp`) takes ≈ 34 ms of
CPU (103.7 user-seconds for 3,000 frames), decoding it ≈ 6 ms. Compositing the same synthetic sequence (120 s,
3,630 frames, one graph) at 1280×720 instead of 1920×1080 took 16.2 s instead of 29.1 s of encode (measured, user's PC,
load 6–8): **≈ 1.8× per frame** is the potential.

Not implemented in this change, because every layer kind would have to be placed with the extra output scale and
compared (SSIM against the full-size composite and the Program preview, AGENTS §4) kind by kind: Motion
(`P' = s·P`, `scale' = s·scale`) is simple, but `jasper.transform` and `jasper.s.shake` parameters (sequence pixels,
the user's subtitles), the kernel streams' and lowered layers' per-frame matrices, sequence-space baked rectangles at
fractional positions (`overlay` places whole pixels), adjustment layers and nested sequences (effects in sequence
pixels), and the layer bake itself (rendered at sequence size by Remotion) each need their own scaling and their own
SSIM gate, with the full-size composite kept for any kind that does not pass. This is the largest remaining CPU
win; recorded as the next step.

## 5. GPU pipeline

What the shipped LGPL FFmpeg 7.1 offers (checked on the user's PC): hwaccels `cuda`, `vaapi`, `qsv`, `drm`, `opencl`,
`vulkan`; filters `scale_cuda`, `overlay_cuda`, `hwupload_cuda`, `colorspace_cuda`, `bilateral_cuda`,
`chromakey_cuda`, `bwdif_cuda`, Vulkan / OpenCL filters; encoders `h264_nvenc`, `hevc_nvenc`; no NPP (nonfree, never
used).

**NVDEC decode (implemented, `gpu.ts`)**: the main graph's own video inputs whose codec ffmpeg's decoders can decode
through NVDEC (H.264, HEVC, VP9, AV1; not libvpx alpha) get `-hwaccel cuda -hwaccel_device jcu`, with one
`-init_hw_device cuda=jcu` per process; frames are downloaded (NV12) and the CPU composite is unchanged (the filter
graph text is identical); ffmpeg falls back to its software decoder for a stream the GPU cannot decode. Availability:
the `cuda` hwaccel and a working device, probed once per ffmpeg binary (`probeCudaDecode`: a tiny
`hwupload_cuda`/`hwdownload` run); `JASPER_EXPORT_NVDEC=0` turns it off. Each NVDEC input keeps its own surfaces and
ffmpeg opens every input of a graph at once: measured on the user's PC, 4 segments × 16 inputs took +5.9 GB of video
memory and ≈ 40 inputs per graph +7.3 GB, so at most `JASPER_EXPORT_NVDEC_MAX_INPUTS` (16) inputs of an export, shared
by its segments, decode on the GPU (peak +1.5 GB measured on the 200 s bench) and the rest on the CPU. Plan and result
`pipeline.decode` say `nvdec` when any input uses it.

Verified on the user's PC (load 2–5): one 1080p H.264 source decoded by NVDEC and converted with the composite's
swscale flags gives identical RGBA frames to the CPU decoder (`framemd5`, all frames); an export with H.264 cuts, a
scaled picture-in-picture and a still, ProRes, CPU decode vs NVDEC (one graph, and 3 segments) decodes to identical
frames (240 of 240); the same export as H.264 (`h264_nvenc`), NVDEC + 3 segments vs CPU decode in one graph: SSIM min
0.9989, mean 0.9997. Gain: NVDEC saves ≈ 5.6 ms of CPU per decoded 1080p frame (103.7 → 86.8 user-seconds for 3,000
frames decoded + converted), ≈ 5 % of the 200 s bench's encode with 4 segments (75.9 s → 72.4 s) and nothing
measurable with one graph — the YUV → RGBA conversion, not the decode, is the CPU cost.

**GPU composite (evaluated, not used)**: `overlay_cuda` blends only YUV planes (`yuv420p`, `nv12`, `yuva420p`
overlays) with straight alpha; the composite's layers are premultiplied-aware RGBA blended in RGB
(`overlay=format=rgb`), so moving them to the GPU means converting every layer to `yuva420p` (chroma subsampling of
the layer and of its alpha edge, a different blend space): a change of colour and edges that the SSIM gate would have
to accept per layer kind, and every layer drawn by the kernels / bakes would still be uploaded from the CPU each
frame. `scale_cuda` (7.1) converts between YUV formats only (no YUV → RGB with the composite's matrix and rounding),
`colorspace_cuda` converts YUV ranges / matrices only. A Vulkan YUV → RGBA conversion (`scale_vulkan=format=rgba`)
failed to negotiate formats with this build. No GPU composite path ships; the SSIM-gated per-kind route of §4 applies
to it too.

**NVENC** encodes every segment (sessions measured above); frames are uploaded from the CPU composite.

## To verify on the GPU PC (coordinator)

On the user's real project (prj_SC0SEK431T1QPQYF, 15:31, `draft-720p-h264`, `normalizeLufs: -14`, hybrid, NVENC),
with an engine on its own port and appdir started from this branch:

1. The job result's `timings` (phases `audio`, `bake`, `audioWait`, `plan`, `encode`, `sound`, `join`, `frameCheck`,
   `finish`) and `pipeline` (`segments` should be 4 with the default policy on 24 cores and NVENC; `overlays` per
   graph; `decode: nvdec`), against the 19.5 min baseline (encode 12.8 min at ≈ 73 fps).
2. The job log's `audio:` line: passes by kind (converging / candidates / rewritten) and their time.
3. CPU / GPU / NVENC / NVDEC utilisation during `encode` (`nvidia-smi dmon`, `top`), peak video memory.
4. `JASPER_EXPORT_SEGMENTS=6` and `=8` (and `JASPER_EXPORT_HW_SESSIONS` to allow them) against the default 4: the
   cores left idle decide whether the cap should rise.
5. `verify_export` on the result (black / flash frames at cuts and at the segment boundaries listed in the job log).
