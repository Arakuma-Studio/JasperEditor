# Export performance: phases, loudness passes, parallel segments, GPU, warm render browsers

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

## 4. Composite at output size

Measured potential before the change: compositing a synthetic sequence at 1280×720 instead of 1920×1080 took 16.2 s
instead of 29.1 s of encode (≈ 1.8× per frame); converting one 1080p frame to RGBA with the composite's swscale flags
costs ≈ 34 ms of CPU. Implemented in §7.

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

## 6. Out of memory with many source inputs (fixed)

The coordinator's run of the user's real project (15:31, 1,930 subtitles, 380 inputs of one 57 min recording,
`draft-720p-h264`) ran out of memory before the first frame on main (one graph of 380 inputs: 75 GB, OOM kill, the PC
unreachable for ≈ 10 min) and on this branch (4 segments of 90–102 inputs: ≈ 12 GB each under a 48 GB cap, 15–16 GB
under 60 GB). Cause, measured by replaying segment 0 (100 inputs, 1,200 frames): ffmpeg opens every input at once and
each decoder used the default thread count (24 cores → 16 H.264 frame threads), each with its frame buffers —
26.6 GB peak / 47 s with the default, 7.8 GB / 43 s with `-threads 2` per input, 6.3 GB / 58 s with 1. Replaying the
4 min single graph (104 inputs) with 2 decoder threads: `-filter_complex_threads` 24 (default) 8.3 GB / 39.8 s, 4
threads 7.8 GB / 46.9 s — filter threads cost little memory, so they are only shared out between segments (§3).

Fix:
- **Decoder threads** (`memory.ts` `decoderThreadsFor`, `capDecoderThreads`): every file input of a composite process
  gets `-threads N` before its `-i`, N = round(4 × graph threads / file inputs) clamped to 2…8 (2 in many-input graphs,
  up to 8 for a few long sources); the warp / sub-pixel decoder processes get 2.
- **A real estimate** (`compositeProfile`, `estimateFrom`): the first fix run with the shipped FFmpeg 7.1 still ran
  out of memory (7 segments × 55 inputs, 4 at a time: ≈ 10–11 GB each, killed at 6 s of encoding), although every
  input had `-threads 2`. Replays on the user's PC: that segment (59 inputs, 600 frames) peaks at 11.9 GB with the
  vendor FFmpeg 7.1.5 and 4.7 GB with the system FFmpeg 6.1.1; 20 synthetic inputs of an overlay chain 4.0 GB (7.1)
  vs 1.6 GB (6.1), the same with clips of 0.6, 2.2 or 6.2 s and with 1, 6 or 24 filter threads; the same 20 inputs
  consumed one after another (`concat`) 1.5 GB vs 1.0 GB. FFmpeg 7.1 runs each decoder in its own thread and holds
  ≈ 200 MB per 1080p input of an overlay chain from the start (≈ 181 MB at 1 thread). Media inputs are therefore
  costed at FFmpeg 7.1's 170 MB + 14 MB per decoder thread at 1080p (conservative for 6.1), scaled by the decoded
  picture; the other inputs keep their earlier measured costs. The budget (`compositeMemoryBudget`) is the smallest of 60 % of the RAM or of the
  engine's cgroup limit — now found from `/proc/self/cgroup` and its ancestors, so a systemd scope or a container
  counts —, 80 % of `MemAvailable` and 80 % of the room left in the cgroup.
- **Segments by memory** (`planPictureSegments`): the graphs running at once must fit; when they do not, the range is
  cut into more, shorter segments (down to 2 s, at most 64, `JASPER_EXPORT_MAX_SEGMENTS`,
  `JASPER_EXPORT_SEGMENT_MEMORY_MIN_SEC`) that run `concurrency` at a time (a pool, in range order), fewer at once when
  even the shortest do not fit. The planner refuses the native path by name (plan blocker; `auto` goes to Remotion)
  only when no segmentation fits, and the job refuses with `INSUFFICIENT_MEMORY` if the memory was taken between plan
  and run. Plan and result `pipeline` carry `concurrency` and `memoryBytes` (the estimate).
- **Watchdog** (`runNative`): the running composites' resident memory (`/proc/<pid>/status`) is sampled every second;
  past the budget the most recently started segment is stopped and queued again with one segment fewer at a time,
  and a lone composite past it fails the export with `INSUFFICIENT_MEMORY` (retryable) — the system's OOM killer never
  decides, whatever the estimate missed.
- **Job log**: ffmpeg command lines are shortened in the middle past 2,000 characters (they pushed the segment list
  and the `audio:` line out of the 64,000-character log), the phase summary is logged when an export fails too, and an
  export's log is written to `engine/logs/jobs/<jobId>.log` when it succeeds as well.

The duplicate-pass fix of §2 does not apply to this project's mix: its 10 passes / 6 encodes are convergence steps,
lower-ceiling candidates and decoded-check rounds of a loud mix (none repeats parameters); the `audio:` log line now
survives to show the split.

Tests: `apps/engine/test/export-memory.test.ts` (the built command caps every file input's decoder threads; the plan
splits into more, shorter segments run fewer at a time to fit, or names the blocker; a range one graph cannot hold is
planned as segments) — all three fail on the previous commit.

**Full export of the real project after the fix** (measured on the user's PC: RTX 3080 Ti, 24 logical cores, 94 GB,
driver 595.99, the user's desktop session and live engine running, load1 1.4–1.6 before; engine of this branch in a
systemd scope `MemoryMax=40G`, `MemorySwapMax=0`, vendor LGPL FFmpeg 7.1.5, perf defaults; layer-bake cache reused
from earlier runs, so `bake` is 2.2 s instead of minutes; job `job_556227dc22e8094e`): **succeeded, 655.7 s job /
666 s wall** (the original run: 19.5 min with an uncached bake; the earlier attempts of main and this branch ran out of
memory). 55,860 frames, `pipeline` = NVDEC decode, CPU composite, 24 segments, 4 at a time, estimate 21.3 GB of a
24.0 GB budget (the cgroup's 40 GB × 0.6).

| Phase | Start | Time |
|---|---:|---:|
| audio (mix 41.2 s + delivery: 10 passes 84.9 s — 6 converging, 4 candidates —, 6 encodes 95.8 s summed, decoded checks 31.3 s) | 0 s | 165.2 s |
| bake (cached) | 0 s | 2.2 s |
| audioWait | 2.2 s | 163.0 s |
| plan | 165.2 s | 8.6 s |
| encode (24 segments, 4 at a time) | 173.7 s | 476.3 s — **117 fps** (one graph: ≈ 73 fps in the original run) |
| frameCheck | 650.0 s | 4.2 s |
| join | 654.1 s | 0.8 s |
| finish | 655.1 s | 0.6 s |

During `encode` (108 samples): CPU busy 71 % mean / 90 % max (ffmpeg 9.5 cores, node kernel streams 5.2 cores), load1
21 mean; GPU 8 % mean / 31 % max, NVENC 7 % / 20 %, NVDEC 6 % / 92 %; peak scope memory 18.1 GB, composites' summed
RSS 14.9 GB (largest single 4.9 GB) — under the 21.3 GB estimate; peak video memory 3.6 GB; host MemAvailable ≥ 58.7 GB.
`verify_export`: every format row passes (decode, streams h264 1280×720 60 fps + AAC 48 kHz stereo, duration 931 s,
A/V skew 0, true peak −2.32 dBTP); judgement rows: no black or flash at 360 cuts, loudness −13.9 LUFS, no silence;
`cut-click` flags 20 cuts — the same clicks main's export of the first 4 min shows at the same cuts (11.5 s, 15.2 s,
131.4 s, 164.7 s, …), i.e. in the edit's audio, which segmentation does not touch.

The critical path is now the audio delivery (165 s, the composite waits 163 s for it) and the encode, CPU-bound at
71–90 % with the composite at the sequence size (§4).

**Watchdog, measured** (user's PC, first 4 min of the real project, an engine patched for the test only to the old
optimistic 50 MB per input and `JASPER_EXPORT_MEMORY_BUDGET_MB=9000`, so that the plan's 7 segments × 4 at a time
under-estimate the real memory): the composites reached 9.1 GB; the watchdog stopped segment 1 and queued it again
(3 at a time), then segment 2 at 8.9 GB (2 at a time); the export succeeded, 14,400 frames, peak scope memory 10.2 GB.
(A first version restarted the stopped segment in its own lane at once and stopped it 54 times — fixed: one stop at a
time, lanes wait while the lowered limit is reached.)

**Audio overlap**: the full run spent 163 s with the composite waiting for the loudness delivery (`audioWait`). A
segmented export no longer waits: its segments render while the mix is delivered, and the sound is encoded and joined
when it is ready (a failed mix fails the export and stops the segments); one graph still waits, as the mix is one of
its inputs.

**Final full export with the audio overlap** (same machine and conditions as the run above, load1 1.4–1.6 before,
layer-bake cache reused; engine at f5d1f9993 in a `MemoryMax=40G` scope; job `mfull3`): **succeeded, 517.7 s job /
528 s wall** (655.7 s before the overlap; 19.5 min in the original run with an uncached bake). 55,860 frames; 24
segments, 4 at a time, NVDEC.

| Phase | Start | Time |
|---|---:|---:|
| bake (cache check) | 0 s | 16.5 s |
| plan | 16.5 s | 8.8 s |
| encode (24 segments, 4 at a time) | 25.3 s | 488.7 s — 114 fps |
| audio (mix 89.7 s + delivery: 10 passes 169.1 s, 6 encodes 146.9 s summed, decoded checks 73.6 s), beside the encode | 0 s | 333.2 s |
| frameCheck / join / finish | 514.0 s | 2.5 / 0.7 / 0.5 s |

During `encode`: CPU busy 85 % mean / 91 % max (ffmpeg 11.5 cores, node 6.4 cores: mixer and kernel streams), load1
25 mean; GPU 8 % / 22 %, NVENC 9 % / 17 %, NVDEC 10 % / 67 %; peak scope memory 19.0 GB, composites' summed RSS 16.4 GB
(largest 5.1 GB), estimate 21.3 GB; peak video memory 3.6 GB. The audio delivery took twice as long sharing the CPU
but is off the critical path. `verify_export`: every format row passes (duration 931 s, A/V skew 0, true peak
−2.32 dBTP), no black or flash at the cuts, loudness −13.9 LUFS; `cut-click` flags 19 cuts, the edit's own clicks as
above. The machine is now CPU-bound in the encode: the next gain is §4 (composite at output size).

## 7. Composite at the output size (implemented)

`output-size.ts`, `native.ts`, `service.ts`, `packages/project` `resolveLayerProps`, the layer bake.

**Model.** Every layer's picture stays in layer pixels — the source scaled to its box, then its effects (Crop, flips,
colour; everything else is baked), masks (layer-box coordinates) and crops (percent of the box) — and only its
placement changes: the layer matrix `M = P + R·S·(q − A)` becomes `s·M` on a canvas `s` × the sequence size, i.e.
Position × s and Scale / Scale Width × s, applied after evaluation (`RenderVisualClip.outputScale`, render-only), so
keyframes, eases, spatial tangents and expressions are untouched. Transform and S_Shake are layer-space effects
(their points are fractions of the box, the shake's offsets are box-relative: `registry/fx/...transform.ts`,
`render/lowered.ts`), so the lowered subtitle path (kernel taps composed with Motion) needs nothing else. The video
chain's Motion resample is merged with the box scale (`mergeResize`), so a 1080p source goes to its 720p box in one
swscale pass; the graph's canvas, background, mattes, kernel streams and blend pipeline are 1280×720 and there is no
final downscale. Nested sequences draw at their own size and the nest clip's Motion places them (exact, no gain inside).

**Pictures placed in sequence pixels.** Baked masters with a crop rectangle, full-frame masters, shake-run masters
and GPU transition spans are scaled to the output canvas with their rectangles. A rectangle must land on whole output
pixels: when the export composites at the output size the layer bake aligns rectangles to `bakeGrid` (lcm(2, q) for
s = p/q: 6 px for 1080p → 720p) and renders masters, runs and spans at the output size (Remotion `scale`; `scale` is
part of the bake key, rectangles stay in sequence px). Sheet stills and layer stills keep their sizes (downscaled
in the graph: exact). Any picture still off the grid (an extension that does not align) makes the export prepare and
composite again at the sequence size, named in the plan / result.

**Fallbacks** (`pipeline.composite = { device, size: 'output' | 'sequence', fallbackReasons }`): an output aspect
ratio different from the sequence (fit / fill bars), adjustment layers (they process the sequence-size composite with
crops in sequence-frame percent), `JASPER_EXPORT_COMPOSITE_SIZE=sequence`, and pictures off the output grid. Stills
and alpha masters are drawn at the sequence size.

**Not done here.** Scaling at decode on the GPU (NVDEC + `scale_cuda`): `scale_cuda` interpolates differently from the
composite's swscale (bicubic, accurate rounding, full-chroma) and would need its own SSIM gate; NVDEC still downloads
full-size NV12 frames and swscale converts them straight to the output size. The memory estimate stays at the decode
size (CPU or NVDEC decode buffers are full size), conservative for the smaller layer frames.

**Fidelity gate.** `apps/engine/test/export-output-size.e2e.test.ts` (REMOTION_E2E=1): 1080p30, 120 frames, a cropped
video, a nested sequence, a masked sub-pixel still, a baked title card with a keyframed Gaussian blur, subtitle words
with Transform keyframes (pop-in) and S_Shake, exported 1280×720 ProRes composited at the output size vs at the sequence
size (then scaled). Measured on the user's PC (RTX 3080 Ti, load ≈ 1.6): composite size `output`, no fallback; SSIM per
frame min 0.9981, mean 0.9985; PSNR min 46.1 dB; text regions: 99.88–99.99 % (subtitles) and 99.67–100 % (title) of
channel values within 24 levels. `apps/engine/test/export-output-size.test.ts` (light, footage + sub-pixel still +
crop + picture-in-picture, 640×360 from 1080p): SSIM ≥ 0.98 per frame; the plan's composite size and fallbacks; the
built graph scales sources straight to their output boxes with no final downscale. `layer-bake.test.ts`: a master of
an output-size export has the scale in its key and a rectangle on whole output pixels.

**Full export of the real project at the output size** (user's PC: RTX 3080 Ti, 24 logical cores, 94 GB, driver
595.99; engine of this branch in a systemd scope `MemoryMax=40G`, `MemorySwapMax=0`, vendor LGPL FFmpeg 7.1.5,
defaults; the user's desktop — Chrome, Discord — used part of the GPU during the run: 26 % mean / 64 % max over the
run, desktop-only before it 18–45 %; the idle check ignored GPU load, user approved; load1 1.5 before).

*Bake cache cleared* (the layer cache moved aside: 1,947 layers ready, 17 master renders at 1280×720, 1,202 stills
rendered; job `mout1`): **succeeded, 518.1 s job / 529 s wall**; composite `output` 1280×720, 24 segments, 4 at a time,
NVDEC. The original run (sequence-size composite, bake uncached): 19.5 min.

| Phase | Start | Time |
|---|---:|---:|
| bake (uncached) | 0 s | 245.1 s |
| audio (beside the bake and the encode) | 0 s | 258.1 s |
| plan | 245.1 s | 12.6 s |
| encode (24 segments, 4 at a time) | 257.7 s | 255.1 s — **219 fps** (sequence-size composite: 489 s, 114 fps) |
| frameCheck / join / finish | 512.9 s | 3.9 / 0.8 / 0.5 s |

During `encode`: CPU busy 84 % mean / 100 % max (ffmpeg 10.8 cores, node 5.2), load1 26; GPU 21 % / 43 % (desktop
included), NVENC 14 % / 32 %, NVDEC 16 % / 100 %; peak scope memory 12.7 GB (sequence size: 19.0 GB), composites'
summed RSS 9.3 GB (largest 3.1 GB); peak video memory 3.9 GB. `verify_export`: every format row passes (duration 931 s,
A/V skew 0, true peak −2.32 dBTP), no black or flash at the cuts, loudness −13.9 LUFS, `cut-click` the edit's own 19
clicks as before. Against the previous sequence-size export of the same project (`full3.mp4`, both NVENC): SSIM over
all 55,860 frames mean 0.9973, 1st percentile 0.9925, min 0.9874, none under 0.98.

*Bake cache warm* (job `mout2`, right after, same engine): **succeeded, 269.9 s job / 280 s wall** (sequence-size
composite, warm cache: 517.7 s). Bake 3.2 s, plan 9.0 s, **encode 252.5 s from 12.2 s — 221 fps**, audio 198.6 s beside
the encode (the delivery reused the previous run's solved parameters in this engine process: 1 pass, 1 encode; the mix
took 138 s sharing the CPU), frameCheck 3.8 s, join 0.8 s, finish 0.5 s. During `encode`: CPU 82 % mean / 89 % max
(ffmpeg 9.5 cores, node 6.1), GPU 18 % / 30 % (desktop included), NVENC 15 % / 33 %, NVDEC 15 % / 100 %; peak scope
memory 13.2 GB, composites' summed RSS 9.3 GB; video memory 3.8 GB. `verify_export` as above; SSIM against
`full3.mp4` identical to the uncached run (the same pictures: mean 0.9973, min 0.9874).

The encode is still the critical path, CPU-bound at 82–84 %: the sequence-size layer pictures (lowered subtitle stills
drawn by the node kernel, 6 cores) and the per-segment startup are the next costs; scaling at decode on the GPU is the
next measured step (see "Not done here").

## 8. Layer bake and audio delivery throughput

`layer-bake/service.ts`, `layer-bake/extension.ts`, `remotion/page-pool.ts`, `remotion/service.ts`,
`audio/deliver.ts`, `audio/mixdown.ts`, `sound-design/measure-core.ts` / `measure-pool.ts`, `export/service.ts`.

After §7 the bake (masters before the composite) and the audio delivery (beside it) were the critical path. Measured
on the user's PC (RTX 3080 Ti, 24 logical cores, 94 GB, driver 595.99; the user's desktop session running — Chrome,
Discord, ≈ 30–55 % GPU before the runs —, load1 2.3–3.5 before each run, no foreign ffmpeg; engines in a systemd
scope `MemoryMax=40G`, `MemorySwapMax=0`, vendor LGPL FFmpeg 7.1.5, appdir copied without `cache/`, layer cache
empty), the real project (15:31, 1080p60 → `draft-720p-h264`, `normalizeLufs: -14`):

**Where the bake time went** (main 067d90f93, job `base1`, child-job progress sampled every 2 s, utilisation every 5 s):
- 17 animated title masters (363 frames each) rendered **6 at a time on 1 page each**: the page budget was 12
  (`remotionConcurrency`), but `pageShares` split it over all 17 masters (`round(12 × 363 / 6171)` = 1 page) while at
  most 6 renders run at once — 6 pages used of 12. Three waves of ≈ 90 s, ≈ 4.0 frames/s per page.
- The render pages mostly wait: during the bake the CPU was 32 % busy (Chrome 1.4 cores on average), the node main
  thread 0.65 core. One page renders ≈ 5 frames/s whatever the load (Remotion's per-frame seek, `waitForReady`
  polling on `requestAnimationFrame`, `Target.activateTarget` + background override + `Page.captureScreenshot`), so
  throughput comes from more renders, not more CPU per page. Measured per render: 1 page ≈ 5.2 frames/s (own
  browser), 2 pages ≈ 10, 4 pages ≈ 11–12; the shared browser's browser and GPU processes ran at ≈ 90 % of a core
  each with 8 pages (4.0 frames/s per page there, 5.2 with a browser per render).
- ProRes masters are not stitched while they render: Remotion's parallel encoding only covers H.264/H.265
  (`canUseParallelEncoding`), so each master's PNG frames are encoded after its last frame. The stitch (prores_ks
  4444, 363 frames at 1280×720) cost 49 CPU-seconds at ffmpeg's default thread count (one per core) against 35–36
  with 1–4 threads, and a wave of masters finishing together saturated every core for ≈ 5–25 s while the pages
  idled: the pool only freed a render's pages when its stitch, remux, frame count and crop check were done.

**Changes (bake).**
- Shares among the renders in flight (`pageShares(frames, budget, atOnce)`): 17 masters, 12 pages, 6 at once → 2
  pages each (also for mg pre-renders).
- The native path's bakes get one page per granted CPU slot (`NativePrepareContext.bakePages` = min(slots, cores):
  24 here) instead of the Remotion path's half (a bake page is latency-bound, ≈ 0.5 core), and up to 12 bakes in
  flight (`MAX_BAKES_IN_FLIGHT`): 12 renders × 2 pages ≈ 105 frames/s against 6 × 2 ≈ 60 and 6 × 4 ≈ 66 (bake-only
  runs, same machine).
- Several shared render browsers per export (`acquireBrowser`): a render takes the least busy browser of its export
  or opens one when that would serve more than `pagesPerBrowser` (2) pages, at most 8 browsers (Remotion's launcher
  adds process signal listeners per browser; Node warns past 10); all are closed with the export's session.
- A render that captured its frames gives its pages back while it is stitched and checked
  (`PageGrant.release`, `EnsureMeta.onRendered`, the child job's `framesCaptured`); it no longer counts against the
  renders in flight. A full-frame re-render after a failed crop check renders on top of the budget (rare).
- The stitch runs with `2 × pages` threads (at least 2, at most the cores) through Remotion's `ffmpegOverride`:
  the same bytes (default, 1, 2 and 4 threads gave byte-identical files), ≈ 27 % less CPU.
- The crop check decodes a master once and splits the alpha into its 1-px strips (was one ffmpeg per strip).
- Knobs: `JASPER_LAYER_BAKE_PAGES` (bake page budget), `JASPER_LAYER_BAKE_PAGES_PER_BROWSER`, and the existing
  `JASPER_LAYER_BAKE_PARALLEL` / `JASPER_LAYER_BAKE_SHARED_BROWSER`.

Cache keys and recipes are unchanged: the run of this branch rendered the same 1,752 cache entries (17 masters,
1,735 stills) **byte for byte** as main (`cmp` of every `master.mov` / `still.png`).

**Where the audio time went.** The arithmetic "≈ 56 s mix + 10 × 13 s passes" left out the decoded checks and the
encodes, and assumed an idle thread. main's `audio:` line (`base1`): mix 79.3 s (56 s on an idle host: the mixer
ran on the engine's main thread beside the bake's render orchestration), 10 passes 154.6 s (≈ 15.5 s each, every
one on the main thread; the 6 converging passes are sequential by construction, and each lower-ceiling candidate
starts from the points its predecessor measured — `gainAtCeiling` — so they are not independent), decoded checks
65.9 s (one candidate after the other, on the main thread), 6 AAC encodes 140 s summed (partly overlapped):
301 s. The live engine's 404 s is the same work under more load (its bake took 377 s too).

**Changes (audio).**
- The pass-1 mix (`renderPass1`), the delivery's passes (`runDeliveryPassRequest`) and its decoded checks
  (`measureEncodedAudio`) run on the measurement workers (`exportAudioWorkers`: ops `mixPass1`, `deliveryPass`,
  `encodedMeasure`, up to 3 workers; in-thread where no worker starts). Same functions, same float operations: a
  delivery through real worker threads writes a byte-identical WAV, encode and outcome (test below). An audio-only
  export keeps its mix in-thread (it reports the mix's progress and runs nothing beside it). Each op is bounded by
  10 minutes or 10 × the audio's duration; a worker crash fails the export (`MEASURE_FAILED`, retryable).
- The decoded check of each encode starts as soon as the encode is written: a round's candidates are decoded side by
  side and while its alternatives are converged, and are still judged in order of preference (the same pick).
- Not changed: the search (the same passes, candidates and encodes), so the delivered audio is the same.

**Full export, before vs after** (same machine and conditions as above; uncached bake):

| | main 067d90f93 (`base1`) | this branch (`new2`) |
|---|---:|---:|
| total job (wall) | 554.6 s (565.6 s) | **398.9 s (409.7 s)** |
| bake (from 0) | 274.7 s | **98.0 s** |
| plan | 14.3 s @274.7 | 10.0 s @98.0 |
| encode | 260.1 s @289.1 (215 fps) | 285.3 s @108.0 (196 fps) |
| audio (from 0) | 301.2 s: mix 79.3 s, passes 154.6 s, encodes 140.3 s summed, decoded checks 65.9 s | 313.1 s: mix 91.8 s, passes 163.1 s, encodes 122.1 s summed, decoded checks 59.2 s (summed) |
| during the bake | CPU 32 % (max 100), Chrome 1.4 cores, node main 0.65, GPU 27 % (desktop included) | CPU 74 % (max 100), Chrome 6.5 cores, ffmpeg 5.4, node main 0.48, GPU 39 % |
| during the encode | CPU 81 %, GPU 24 % | CPU 83 %, GPU 22 % |
| peak scope memory | 15.2 GB | 15.5 GB |

The committed code (286d94920, `new3`, same conditions, load1 2.3 before): 408.5 s job / 419.4 s wall, bake 96.9 s,
plan 9.4 s @96.9, encode 296.8 s @106.2 (188 fps), audio 323.3 s (mix 91.6 s, passes 168.6 s), CPU 74 % / Chrome 6.3
cores during the bake; the same file content and cache bytes as main. An earlier run before the stitch-thread cap and
the browser limit (`new1`): 403.1 s, bake 105.4 s. The encode's spread (285–297 s) follows the audio work beside it.
The output is the same file content: the video and audio packets of `new2.mp4` and `base1.mp4` have equal MD5s
(SSIM 1.00000 on all 55,860 frames); `verify_export` on `new2`: every format row passes (decode, streams h264
1280×720 60 fps + AAC 48 kHz stereo, duration 931 s, A/V skew 0, true peak −2.32 dBTP), no black or flash at 360
cuts, loudness −13.9 LUFS, no silence; `cut-click` flags the edit's own 19 clicks (§6).

The audio now overlaps the encode instead of the bake and ends at 313 s, 80 s before the encode: off the critical
path, but its ≈ 1.5 cores slow the CPU-bound encode (285 s against 260 s with the audio mostly done before it).
The critical path is bake 98 s + plan 10 s + encode 285 s.

**Remaining limits.** One master render still tops out at ≈ 11 frames/s and every frame is captured as a PNG and
encoded after the render (Remotion's ProRes path); streaming the frames into our own stitcher would overlap the
stitch with the render (same encoder arguments, to be checked byte-for-byte) but not reduce its CPU, and the bake
is CPU-bound now (74 % mean, bursts at 100 %). The delivery's search is serial (6 converging passes of ≈ 16 s);
fewer passes (predicting the gain, lazy candidates) would change the delivered parameters within the tolerances, not
done. Lowering the audio workers' priority would give the encode its cores back but risks a late sound on machines
the encode saturates.

Tests: `page-pool.test.ts` ("more masters than renders in flight share the whole budget…", "a render that captured
its frames gives its pages to the next render…"), `layer-bake.test.ts` ("a native export bakes as many titles at once
as its CPU slots allow…", "a browser serves at most pagesPerBrowser pages…"), `audio-deliver.test.ts` ("decodes the
encodes of a round side by side…": the round's two decoded checks run at once, and the outcome equals the
one-at-a-time delivery) — all fail on main; `sound-design-measure-worker.test.ts` ("a delivery whose passes and
decoded checks run on worker threads writes the same WAV, encode and outcome", bundled worker).

## 9. Subtitle / text drawing off the CPU (investigation)

After §7 the warm export encodes at 221 fps with the CPU 82–84 % busy; the node kernel streams drawing the lowered
subtitles take ≈ 5.2 cores of it (uncached run, encode after the audio: node 5.2 cores, ffmpeg 10.8).

**What the kernel draws** (measured on the user's PC: the tap stream instrumented, uncommitted, over the first 4 min of
the real project, 5 segments, 14,379 frames): 14,312 frames drawn, on average **10.3 taps** per frame over a
**73,177 px** rectangle (≈ 690,000 tap-pixels per frame; up to 40 taps), 3 coverage stages per tap (the layer box, the
Transform effect's box, the S_Shake canvas). **No frame repeats the previous one** (0 identical tap programs) and **no
frame's taps share one map** (0 frames): S_Shake moves the picture every frame and the Transform effect's 360° shutter
spreads 8–40 taps along that motion.

- **(b) caching cue rasters and letting ffmpeg transform them** is therefore not faithful: there is no repeated frame
  to reuse, and one transformed raster per frame would drop the shutter taps (the motion blur the composition draws).
- **(c) cheaper CPU kernel**: per-tap-pixel cost measured with real frames (dumped tap programs and pictures, kernel
  run as the workers run it) ≈ 24–66 ns on the user's PC (under the other agent's load: load1 ≈ 30). Skipping samples
  whose bilinear footprint is fully transparent (a per-picture mask; byte-identical output on all 39 dumped frames)
  saves only ≈ 5 %; removing closure-captured loop bounds nothing measurable. The work is inherent (10 bilinear RGBA
  samples per pixel); a SIMD / premultiplied-float rewrite is estimated at ≈ 1.5–2× (≈ 1.5–2.5 cores freed), not byte
  exact.
- **(a) the GPU**: the render browser could draw it, but every frame would leave Chrome through the DevTools protocol
  (≈ 150 MB/s of RGBA at 221 fps): not viable. **FFmpeg's OpenCL is**: the shipped LGPL build has `program_opencl`,
  `openclsrc`, `overlay_opencl`, `hwupload` / `hwdownload`, and an OpenCL device opens on the RTX 3080 Ti (NVIDIA CUDA
  platform; an RGBA upload / download round trip ran). Plan: port `drawTaps` (taps, coverage stages, bilinear
  premultiplied sum, `sum / wsum`) to an OpenCL kernel run by `program_opencl` with two inputs per frame — the cue's
  picture and a small float "program" frame with that frame's taps, both written by node instead of the drawn frame —
  then `hwdownload` into the CPU overlay; float32 on the GPU instead of float64: an SSIM / text-edge gate against the
  kernel, the kernel kept as the fallback (no OpenCL device, a program that does not fit) and reported in `pipeline`.
  Built in §10.

## 10. Kernel streams on the OpenCL device (implemented)

`stream/opencl.ts`, `stream/taps.ts`, `native.ts`, `service.ts`.

**Route.** Every kernel stream (`TapStreamPlan`: the lowered subtitles / text stills, baked stills placed in sequence
space, sub-pixel stills; one or many members) whose frames fit the OpenCL program gets `plan.gpu`, a layout of its
input frame: `inW × inH` RGBA, the frame's program in the first `progRows` rows (one little-endian float32 per pixel,
bytes in R, G, B, A) and the member's picture below it (top-left of a canvas the size of the stream's largest
picture, every mip level counted). Node writes one such frame per output frame instead of the drawn pixels
(`streamGpuTaps`: no kernel threads, pictures decoded and prefetched as before), and the composite's chain for the
stream becomes `hwupload, program_opencl=source=<taps.cl>:kernel=jasper_taps:size=<outW>x<outH>, hwdownload,
format=rgba` before the unchanged `setpts` / fades / `overlay`. The process gets `-init_hw_device <device>
-filter_hw_device jcl` (one OpenCL device per process; NVDEC's CUDA device is separate). The shipped LGPL FFmpeg 7.1
runs it as a separate executable; `program_opencl`'s `size` option sets the output size with an input (checked: an
input of 64×48 gave 16×8 frames). The program file is content-addressed in the temp directory
(`jasper-opencl/taps-<sha>.cl`), written atomically and again when missing.

**Maths.** `jasper_taps` is `drawTaps` per output pixel (one work item per pixel of the stream's frame): the same taps
in the same order, the picture's clip coverage and every stage's coverage (½ px ramps, product, early-out at 0), the
clamped bilinear premultiplied sample (texel centres at i + ½), `acc += k·Σ c·a / 255`, `acc.a += k·a`, then
`255 / a` normalisation, `min(255)` and `floor(x + 0.5)`; texels are read with nearest sampling and turned back into
bytes (`× 255`, round to nearest), bilinear weights are computed in the program (the hardware filter's 8-bit
fractions are not used). Values the CPU kernel derives once per tap — clamped clip, ½-texel sample bounds, the
`1 / hypot` edge gradients of the clip and every stage — are computed in float64 by node and sent as float32
(`encodeGpuFrame`); taps the CPU kernel skips (w ≤ 0, empty clip) are left out. Differences: float32 maps and sums
on the GPU (the CPU kernel computes in float64 and accumulates in float32); `drawLayer`'s one-tap fast path is drawn
by the same multi-tap formula (equal up to rounding, `subtitle-lowered.test.ts`). The row-span shortcut of the CPU
kernel only skips coverage computations that are 1; the GPU computes them.

**Fallbacks** (`pipeline.kernel = { device: 'opencl' | 'cpu', streams: { opencl, cpu }, fallbackReasons }`; the plan
says the device the probe found, the result what ran):
- no OpenCL GPU, a failed self-test, `JASPER_EXPORT_OPENCL=0`, stills (one frame): every stream on the CPU kernel;
- a stream with a frame of more than 256 taps or a tap of more than 8 stages, or a picture / stream larger than
  8192 px (the image size every full-profile OpenCL device supports): that stream on the CPU kernel, by name;
- a VAAPI encoder (its `hwupload` needs the process's one filter device): the graph's streams on the CPU kernel;
- a pipelined still that comes out larger than its stream's canvas: `BakeChangedError`, the export prepares again
  without pipelined stills (the existing restart);
- a composite that fails with an error naming OpenCL or the upload / download (device lost, out of video memory): the
  export is rendered again with the CPU kernel, the error line in `fallbackReasons` (e2e test below: the OpenCL driver
  hidden from the ICD loader after the probe; on the RTX 3080 Ti the reason read `the OpenCL kernel failed:
  [AVHWDeviceContext @ …] Failed to get number of OpenCL platforms: -1001.`).

**Availability** (`probeOpenClTaps`, once per ffmpeg binary and device for the engine's lifetime): the device opens
(`opencl=jcl:,device_type=gpu` by default: an OpenCL runtime on the CPU would take the cores the kernel is moved off;
`JASPER_EXPORT_OPENCL_DEVICE=any` or `<platform>.<device>` picks another), `program_opencl` builds the program, and a
self-test frame (3 rotated, scaled taps with 2 stages each over a partly transparent 23×17 picture) matches the CPU
kernel within 2 levels per channel. Frames are written little-endian (big-endian hosts use the CPU kernel).

**Fidelity** (float32 vs the CPU kernel):
- The 39 real-project frames dumped from the kernel (`/tmp/je-mine/tapdump`, 1–40 taps, 3 stages, pictures up to
  1059×214, streams 766–822 × 186–198), all drawn by `program_opencl` exactly as the composite runs them, against
  `drawTaps`: worst difference **1 level**, 451 of 25,389,936 values differ (measured on the user's PC, RTX 3080 Ti,
  driver 595.99); with POCL 3.0 (CPU OpenCL, this host, dev only) worst 1 level, 445 values differ.
- Export of two moving, rotating sub-pixel stills on one track (one kernel stream), OpenCL (POCL) vs CPU kernel, 50
  frames ProRes: SSIM min 0.999999 (`export-opencl.test.ts`, runs the comparison only where a device passes the
  probe).
- `export-opencl.e2e.test.ts` (JASPER_OPENCL_E2E=1, needs an OpenCL GPU and Remotion): the probe; the dumped frames
  (`JASPER_TAPDUMP_DIR`) per pixel (worst ≤ 2 levels, < 0.1 % of values differing); subtitle words with Transform
  pop-in keyframes, a 360° shutter and S_Shake exported 1280×720 with the OpenCL kernel vs the CPU kernel (SSIM ≥ 0.998
  per frame, ≥ 99.5 % of the text region's values within 2 levels); the CPU re-render after an OpenCL failure.
  Measured on the user's PC (RTX 3080 Ti, driver 595.99, load1 ≈ 1.7, at 0029f19b1): all 4 pass — dumped frames worst
  1 level, 451 values differ; the subtitle export SSIM per frame min 1.000000 (PSNR min 89.1 dB), text regions
  99.993–100 % of values within 2 levels; the CPU re-render's result `{device: cpu, streams: {opencl: 0, cpu: 1}}`.
  `export-opencl.test.ts` on the same PC (OpenCL path): SSIM min 0.999999.

**Cost of the route** (measured on the user's PC, another agent's export running, load1 ≈ 20): the 39 dumped frames
repeated 50 times (1,950 frames, ≈ 694,000 tap-pixels per frame, input 1059×217, output 822×198) through `hwupload,
program_opencl, hwdownload` in one ffmpeg: 635 fps, ffmpeg 3.10 s user + 0.77 s system = **≈ 2.0 ms of CPU per
frame** (NVIDIA's OpenCL waits for each frame's kernel and transfers on the filter thread), against ≈ 17–46 ms of CPU
per frame for the CPU kernel at 24–66 ns per tap-pixel (§9).

Light suites on this host (no GPU; POCL for the OpenCL path): `export-opencl.test.ts` passes with and without a
device; `subtitle-lowered.test.ts`'s fast-check cases time out at 5 s with this host at load ≈ 60–95 (they pass on the
user's PC; the kernel code is unchanged).

Tests: `apps/engine/test/export-opencl.test.ts` — the plan and the result say where kernel streams are drawn (the
CPU kernel and the probe's reason without a device; on a device, the export against the CPU kernel's, SSIM ≥ 0.999);
the built graph runs `hwupload, program_opencl, hwdownload` for the stream, with the input frame size of the layout,
one OpenCL device as the filter device, and the rest of the graph unchanged; streams that do not fit (taps, picture
size) and a VAAPI encoder stay on the CPU kernel by name. All three fail on the previous commit (no `kernel`
report, no `openCl` route).

**Full export of the real project** (user's PC: RTX 3080 Ti, 24 logical cores, 94 GB, driver 595.99; engine of
this branch merged with main at 0029f19b1, in a systemd scope `MemoryMax=40G`, `MemorySwapMax=0`, vendor LGPL FFmpeg
7.1.5, defaults: 24 segments, 4 at a time, NVDEC, output-size composite; prj_SC0SEK431T1QPQYF, 15:31, 55,860 frames,
`draft-720p-h264`, `normalizeLufs: -14`). Each run started after the idle check (3 samples: load1 < 8, no other
ffmpeg); the user's desktop (Chrome, Discord) used the GPU as it pleased (10–45 % before the runs). The CPU-kernel
baseline is the same build with `JASPER_EXPORT_OPENCL=0`, run in the same session. *Warm* = layer cache warm, the
second export of the engine process (as `mout2` in §7: the delivery reuses the solved loudness parameters); *cold* =
the layer cache moved aside, the first export of a new engine (restored afterwards). Job time from the job result.

| Run | Job | Bake | Encode (start → time) | fps | Audio (beside) | CPU busy mean / max | node / ffmpeg cores | GPU · NVENC · NVDEC mean (max) | Composites' RSS sum (largest) | Video memory |
|---|---:|---:|---|---:|---:|---|---|---|---|---:|
| warm, CPU kernel | 264.7 s | 1.6 s | 13.7 s → 245.5 s | 227.6 | 179.3 s | 83 % / 90 % | 6.3 / 9.9 | 23 (39) · 17 (33) · 15 (100) % | 9.3 GB (3.1) | 4.3 GB |
| warm, **OpenCL** | **223.0 s** | 1.7 s | 15.0 s → **200.4 s** | **278.7** | 189.9 s | **70 %** / 84 % | **0.75** / 12.1 | 26 (48) · 21 (36) · 18 (75) % | 10.1 GB (3.4) | 4.9 GB |
| cold, CPU kernel | 375.5 s | 93.8 s | 102.5 s → 267.7 s | 208.7 | 321.4 s | 85 % / 93 % | 6.6 / 9.9 | 15 (30) · 16 (37) · 11 (62) % | 9.5 GB (3.2) | 4.3 GB |
| cold, **OpenCL** | 381.9 s | 110.3 s | 118.9 s → 255.8 s | 218.4 | 284.2 s | **70 %** / 86 % | **1.3** / 11.3 | 49 (100) · 15 (24) · 15 (100) % | 10.4 GB (3.4) | 5.5 GB |

Other phases: plan 8.6–13.3 s, frameCheck 4.0–6.2 s, join 0.8 s, finish 0.5 s. Peak scope memory 15.0 GB (CPU
kernel) / 16.9 GB (OpenCL) over cold + warm (the scope's peak spans both runs of an engine, the cold bake included).

- **The CPU is freed**: the node kernel threads go from ≈ 6.3 cores to ≈ 0.6–1.3 (the rest is the engine and the
  mixer), ffmpeg takes ≈ 2 cores more (the uploads, downloads and NVIDIA's waits for each frame on the filter
  threads, ≈ 0.5 core per running stream), and the machine is 70 % busy during the encode instead of 83–85 %.
- **Warm: the encode is 18 % faster** (245.5 → 200.4 s, 228 → 279 fps) and the job 16 % (264.7 → 223.0 s; §7's
  pre-merge baseline: 269.9 s, 221 fps).
- **Cold: the job is not shorter** (375.5 vs 381.9 s): its critical path is the bake (93.8 vs 110.3 s, the render
  browsers' variation) and the loudness delivery running beside the encode (it ends at 321 / 284 s); the encode itself
  4 % faster (267.7 → 255.8 s).
- **Other GPU load slows the OpenCL route**: each composite's filter thread waits for its stream's frame on the GPU,
  so the encode follows the GPU's other users. Runs of this branch with the desktop's GPU use at ≥ 49 % mean during
  the encode encoded at 218–231 fps (this cold run; a pre-merge cold run 231 fps at 55 %; a pre-merge warm run whose
  17 masters were re-rendered just before, 222 fps at 56 %), runs at ≤ 37 % at 262–279 fps (pre-merge warm 262 fps).
  With the CPU kernel the encode is CPU-bound and ignores the GPU's load. Per-segment composite lifetimes are equal
  (37.1 s CPU kernel, 37.3 s OpenCL in the 56 % run; 31.8 s in the 37 % run): the four composites at a time, not the
  CPU, now bound the encode — more segments at once (`JASPER_EXPORT_HW_SESSIONS`) are the next measurement.
- One pre-merge CPU-kernel run overlapped a redeploy of the user's live engine (13:23–13:25) and is not used.

**Picture and checks** (warm OpenCL export): `verify_export` — every format row passes (decode, streams h264
1280×720 60 fps + AAC 48 kHz stereo, duration 931 s, A/V skew 0, true peak −2.32 dBTP), no black or flash at the
cuts, loudness −13.9 LUFS; `cut-click` flags the edit's own 19 cuts as before. SSIM against `/tmp/je-mine/out2.mp4`
(the CPU-kernel export of §7; the CPU-kernel run here is the same file, byte for byte in size and SSIM) over all
55,860 frames: mean 0.99928, 1st percentile 0.99526, min 0.98922, none under 0.98; cold OpenCL vs cold CPU kernel:
mean 0.99928, min 0.98923. The lowest frames (40,666–40,674) differ over the whole picture (mean 0.42 levels, max 48,
rows 80–719 — video and text alike) and look identical: NVENC's decisions diverging from slightly different input
(the kernel itself differs by ≤ 1 level), not the text drawing. The lossless gates are the dumped frames and the
ProRes e2e above.

**Not done**: an asynchronous OpenCL route (the filter thread waits per frame; `program_opencl` finishes each frame)
and moving the sub-pixel video streams (`streamLayer`, decoded per frame) to the GPU; more concurrent segments to turn
the freed cores into speed.

## 11. Colour conversion on the GPU (investigation; nothing shipped)

Question: after §10 the warm export encodes at ≈ 279 fps with 4 composites at a time, each using ≈ 3.1 cores, and
6–8 at a time gain nothing. Can the composite's per-pixel CPU work move to the GPU faithfully and make the encode
measurably (> 5 %) faster? **Answer: no, not with the shipped FFmpeg 7.1.** Faithful GPU conversions were built (≤ 1
level from swscale), but every GPU stage FFmpeg offers runs synchronously on the composite's single filter-graph thread,
so the per-composite latency rises more than the CPU falls, and the export gets slower. Nothing is shipped; the data
follows.

Machine for everything below: the user's PC (RTX 3080 Ti, driver 595.99, 24 logical / 12 physical cores, 94 GB), the
vendor LGPL FFmpeg 7.1.5, heavy runs in a systemd scope `MemoryMax=40G`, no other ffmpeg running, the user's desktop
using 17–31 % of the GPU at the start of each run (recorded, not controlled). Scratch scripts were in `/tmp/gc-prof` on
that PC (not committed).

**Where one composite's CPU goes** (one 1080p60 H.264 window of the real project's recording, 1,200 frames, to a
1280×720 RGBA layer as `native.ts` builds it; each row adds one step; load1 2.0–3.5; CPU = user + system of the
process):

| Step | NVDEC decode: CPU / frame | CPU decode: CPU / frame |
|---|---:|---:|
| decode (NVDEC: decode + download of NV12) | 1.2 ms | 5.6 ms |
| + `scale=1280:720:in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp,format=rgba` | + 11.5 ms | + 10.6 ms |
| + `overlay=format=rgb` onto the 1280×720 background | + 2.8 ms | + 2.5 ms |
| + output conversion to `yuv420p` (same flags) | + 3.1 ms | + 3.2 ms |
| + `h264_nvenc` | + 0.9 ms | + 1.8 ms |

The input conversion is ≈ 60 % of the per-frame CPU. Its cost is the accurate full-chroma conversion, not the resize:
a 720p `yuv444p` → RGBA conversion with the same flags and no resize still costs 8.2 ms (`scale_cuda` resizing on the
GPU first: 11.3 cpu-s instead of 15.2 for the window; and `scale_cuda`'s 4-tap bicubic is not swscale's widened
filter). In the real segments (captured command lines of the warm OpenCL export `gt-m-warm-cl`, 24 segments, 4 at a
time), the filter threads take 69 % of the composites' CPU, the CPU H.264 / ProRes decoders 24 % (most inputs decode on
the CPU: 16 NVDEC inputs per export, §5), NVENC 2.6 %.

**Faithful GPU conversions built** (reference: the CPU path above over 1,100 frames of the window, RGBA compared per
channel):
- *OpenCL* (`program_opencl`): `program_opencl` runs its kernel once per output plane and hands each input's plane of the
  same index, so an RGBA output sees only the Y plane of a YUV input. The route that works: `format=yuv420p,
  extractplanes`, the three planes stacked into one gray frame (`hstack` U|V, `vstack` under Y), one `hwupload`, a
  2×2 RGBA frame split off the same stream as the first input (it sets the output format; a looped constant frame
  desynchronises the framesync: 460 of 1,100 frames), then `hwdownload`. The kernel is swscale's filter in float:
  bicubic B = 0, C = 0.6, support widened by the ratio when downscaling, weights normalised per tap row, clamped edges,
  BT.709 limited → full, centred chroma (vf_scale ignores the stream's `chroma_location=left`: the left-sited variant
  was off by up to 20 levels). Result: **max 1 level, 0.33 % of values differ**. CPU: 5.1 ms per frame instead of 14.6
  (NVDEC), of which the copies and transfers alone are 4.4 ms.
- *Vulkan* (`libplacebo`, in the vendor build): a user shader (mpv hook format) on the `LUMA` and `CHROMA` planes
  resamples each straight to the layer size with the same filter, libplacebo converts the matrix, `dithering=-1`,
  `setparams=chroma_location=center` before it (libplacebo honours `left`: Cb off by up to 12 levels otherwise).
  Fed NVDEC-downloaded (or CPU-decoded) frames: **max 1 level, 9.4 % of values differ** (mean +0.13 on R and B),
  identical over two runs; CPU 1.6 ms per frame plus ≈ 1.1 s on the main thread per process (Vulkan device start). Fed Vulkan-decoded
  frames (no download at all) it is wrong: the 1088-row decode surface shifts the luma mapping, and from frame ≈ 1,000
  of the window on the output no longer matches any reference frame (mean error 1.2–1.6, max 255) although the
  Vulkan decoder's own frames are bit-identical to the CPU decoder's (`framemd5`).
- *NVENC fed RGBA* (moving the output conversion into the encoder): the driver converts with BT.601 (FFmpeg tags the
  stream `bt470bg`): Y off by up to 15 levels, mean +1.06, against the CPU conversion on a lossless encode. Rejected.

**Export throughput** (the 24 captured segments replayed by a scratch pool, the node-fed kernel stream input and its
overlay removed from every graph, everything else as the engine runs it; wall of the whole pool; CPU summed over the
composites):

| Variant | At a time | Pool wall | CPU (s) | Filter threads | Decoders | NVIDIA event thread | CPU busy | Failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| current CPU conversion | 4 | **168.8 s / 165.8 s** (two runs) | 2,305 / 2,289 | 1,585 | 558 | 16 | 71 % / 70 % | 0 |
| OpenCL conversion | 4 | 224.6 s (+ 33–35 %) | 2,288 | 1,256 | 660 | 205 | 58 % | 0 |
| OpenCL conversion | 6 / 8 | 237.3 s / 242.5 s | 3,200 / 3,769 | 1,791 / 2,117 | 867 / 1,004 | 324 / 396 | 76 % / 86 % | 0 |
| libplacebo conversion | 4 | 217.0 s (+ 29–31 %) | 1,464 | 808 | 449 | 30 | 41 % | 1 |
| libplacebo conversion | 6 | 190.5 s (with 9 segments failed) | 1,408 | 753 | 428 | 33 | 41 % | 9 |
| *bound*: CPU conversion with `flags=bilinear` (not faithful) | 4 | 141.0 s (− 15 %) | 1,775 | 955 | — | — | 66 % | 0 |

- **OpenCL**: the filter threads lose 330 cpu-s but NVIDIA's OpenCL waits by spinning — its event-handler thread goes
  from 16 to 205 cpu-s at 4 at a time and further with more composites, and the filter threads spin in the blocking
  transfers — so the CPU total does not fall, while each composite's filter thread now waits per layer frame for the
  upload, the kernel and the download: segments take 36.5 s instead of 27 s each. More at a time only adds spinning.
- **libplacebo**: the CPU does fall by 36 % (Vulkan waits sleep), but the composites are latency-bound (41 % busy:
  34.4 s per segment at 4, 44.3 s at 6), and every `libplacebo` instance (one per video layer: 19–90 per segment, all
  created at graph start) keeps its own textures and upload slabs: `VK_ERROR_OUT_OF_DEVICE_MEMORY` on the 12 GB card
  with 4–6 composites.
- **The bound**: removing ≈ 500 cpu-s of conversion without adding latency gives ≈ 15 %; a GPU route has to avoid the
  synchronous wait on the graph thread to come near it.
- **Hiding the latency inside one ffmpeg failed**: each layer's conversion in its own `-filter_complex` (each graph
  has its own thread in 7.1) handed to the composite through `rawvideo` loopback decoders (`-dec`) did not finish with
  OpenCL (stopped after 5 min; the segment takes 15 s) and crashed (SIGSEGV) with libplacebo.

GPU load was not the limit: during the OpenCL pool at 8 at a time the GPU's SM activity averaged 42 %, NVENC 15 %,
NVDEC 15 % (`nvidia-smi dmon`, desktop included).

**What could still work** (not attempted; each is a larger change than this investigation): a conversion that does not
block the graph thread — an asynchronous GPU filter (or a YUV → RGB mode for `scale_cuda`, whose CUDA waits block
instead of spinning) in our own LGPL FFmpeg build, which would need `--enable-cuda-llvm` (clang; `--enable-cuda-nvcc` is
nonfree), a manifest and `pnpm ffmpeg:check` provenance; or converting the video track in a separate process per
segment that feeds the composite RGBA through a pipe, as the kernel streams do. CPU-side, outside this task's GPU
scope: an opaque full-frame video layer over the opaque background costs the 2.8 ms overlay per frame although the
result is the layer itself (removed in §12).

## 12. Exact composite simplifications on the CPU (implemented: the base sliced in time, NVDEC to the longest inputs)

`native.ts` (`drawStack`, `buildNativeGraph`), `gpu.ts`. Question: after §11 (no GPU route), which CPU work of the
composite can go without changing a single output value? Every change below is exact: the composite's frames are
byte-identical to the previous graph's (checked per frame, below), so preview parity is unchanged.

**The base, sliced in time.** spec 13 AS-076 made an opaque full-frame video the composite's base only when it covered
the whole range — never in a cut-heavy edit (each of the real project's 24 segments has 12–20 V1 clips). Now every
such layer is the base *for its frames*: a layer is `covering` when the document says it is opaque and fills the frame
exactly — a video clip (no override) whose source has no alpha, Normal blend, no 3D, fades, masks or effects other than
flips and colour effects, Opacity 100 % (no alpha stage after Motion) and Motion that places it at 0,0 with a constant
scale to exactly W × H (no pixel test). Its frames replace the background there: the covering layers (disjoint in time)
are concatenated with the background colour between them (`tpad … stop_mode=add` up to the next piece, a `color`
source before the first, `concat`, then `settb=1/fps,setpts=N`, the background's own timestamps) and the stack draws
the other layers over that stream as before. Layers drawn earlier (lower) that overlap a piece are hidden on its
frames by switching their overlay off there (`enable='…*not(between(t,…))'`); a layer joins only if every lower layer
overlapping it can be switched off that way (an overlay with an `enable` window) and it overlaps no other piece. A
blend-mode layer (a process boundary of the blend pipeline) closes the base; nested stacks keep the blend; rates whose
time base `settb` cannot represent exactly (terms above 100,000) keep it too. Why it is exact (FFmpeg 7.1
`vf_overlay.c`, `blend_slice_packed_rgb`): a source pixel with alpha 255 is copied (`case 255`), and its alpha too, so
blending an opaque full-frame layer over anything gives the layer; an overlay whose `enable` is false passes its main
input through; `eof_action=pass` after a source that ends early shows the composite below, which on a piece's frames
is the background (`tpad` adds background-coloured frames, `ff_fill_rectangle` writes the same RGBA bytes as `color`).
`JASPER_EXPORT_COVER_BASE=0` keeps the blends.

On the real project the busiest graph goes from 26 overlays to 3 (`pipeline.overlays`): the V1 clips are no longer
blended, nor traversed while disabled (every overlay of the old chain ran its framesync and `enable` evaluation on
every frame of the segment).

**NVDEC to the longest inputs.** The per-segment NVDEC cap (§5: 16 per export / segments at a time = 4) went to the
first eligible inputs in clip order; the graph now marks every eligible input and gives the cap to the ones that decode
the most media (their `-t`), the others decode on the CPU as before (the same decoded pictures, §5). From the captured
command lines of the warm export (decoded frames = `-t` × 60 plus the pre-roll from the keyframe before each seek,
keyframes every 250 frames in this recording): NVDEC decodes 38.3 % of the 107,013 decoded frames instead of 27.4 %.

**Fidelity.**
- `apps/engine/test/export-composite-base.test.ts`: 720p, two solids below, full-frame `clip-a` spans, a `clip-b`
  at 50 %, a `clip-a` span at 60 % opacity, a gap where the (non-black) background shows, a translucent scaled solid
  above; the built graph has the two spans as base pieces (5 overlays instead of 7), each lower solid switched off on
  its piece's frames; ProRes 4444 of both graphs decodes to identical frames (56 of 56). Fails on the previous commit.
- `export-gpu-decode.test.ts` ("gives the capped GPU decoders to the inputs that decode the longest"): 10, 40 and 20
  frames, cap 2 → the 40- and 20-frame inputs. Fails on the previous commit.
- Real project, all 24 segments (the warm export's captured command lines, replayed without the node-fed kernel stream,
  the graph rewritten the way the builder now writes it, `framemd5` of the `yuv420p` frames given to the encoder): all
  55,860 frames identical. The full exports below: see "Picture".

**Composites alone** (the 24 segments of each build's warm export, captured from the engine and replayed 4 at a time
as in §11 — kernel stream input and its overlay removed, NVENC output; user's PC: RTX 3080 Ti, driver 595.99, 24
logical / 12 physical cores, vendor LGPL FFmpeg 7.1.5, load1 12–23 at the start of each pool, desktop GPU 17–29 %):

| Graphs | Pool wall | CPU (s) | Filter threads | CPU H.264 decoders | CPU busy | NVDEC mean |
|---|---:|---:|---:|---:|---:|---:|
| main a7b7b099b (2 runs) | 170.2 / 177.1 s | 2,315 / 2,392 | 1,593 / 1,641 | 428 / 446 | 71 / 73 % | 21 % |
| this branch (2 runs) | 133.6 / 147.5 s | 1,939 / 2,057 | 1,304 / 1,366 | 354 / 385 | 76 / 78 % | 40 % |

−19 % wall and −15 % CPU (means). The filter threads lose ≈ 290 cpu-s, more than the background blend alone (2.8 ms ×
55,860 frames ≈ 156 cpu-s, §11): the disabled overlays of the old chain cost the rest.

**Full export of the real project** (same machine; engines in a systemd scope `MemoryMax=40G`, `MemorySwapMax=0`,
appdir `.stage-perf`, defaults: 24 segments, 4 at a time, NVDEC, OpenCL kernel, output-size composite;
prj_SC0SEK431T1QPQYF, 15:31, 55,860 frames, `draft-720p-h264`, `normalizeLufs: -14`; each run after the idle check —
load1 < 6, no other ffmpeg, desktop GPU use allowed and recorded; *cold* = layer cache moved aside, first export of a
new engine; *warm* = the engine's second or third export, the delivery reusing its solved loudness):

| Run | Job | Bake | Encode (start → time) | fps | Audio (beside) | CPU busy mean / max | GPU · NVENC · NVDEC mean | Overlays (largest graph) |
|---|---:|---:|---|---:|---:|---|---|---:|
| main, cold | 406.0 s | 116.7 s | 126.4 s → 271.4 s | 205.9 | 292.3 s | 72 / 90 % | 62 · 15 · 12 % | 26 |
| branch, cold | **351.3 s** | 98.8 s | 108.3 s → **233.7 s** | 239.0 | 284.3 s | 73 / 86 % | 56 · 18 · 22 % | 3 |
| main, warm (2 runs) | 224.0 / 228.4 s | 1.7 s | 13.7 → 203.3 / 14.0 → 207.5 s | 274.7 / 269.2 | 138.4 / 162.5 s | 73 / 84 % | 38 · 20 · 22 % | 26 |
| branch, warm (2 runs) | **206.3 / 200.2 s** | 1.8 s | 15.6 → 181.6 / 18.9 → 172.2 s | 307.7 / 324.4 | 193.9 / 189.9 s | 77 / 87 % | 43 · 21 · 29 % | 3 |

- **Warm: the job is 10 % shorter** (means 226.2 → 203.3 s; 223.0 s in §10) and the encode 14 % (205.4 → 176.9 s).
- **Cold: the encode is 14 % shorter** (271.4 → 233.7 s); the job 13 % (406.0 → 351.3 s), part of which is the bake's
  run-to-run spread (116.7 vs 98.8 s; one run each).
- Other phases: plan 9.5–17.0 s, frameCheck 4.0–6.1 s. Peak scope memory 14.6 GB (branch) / 17.6 GB (main), each over
  its engine's runs; the largest composite's resident memory 3.3–3.5 GB in both builds.
- An unrelated `node` process outside the engines' scopes (not started by this work) held 2.3–6.5 GB of video memory
  for ≈ 40 s at a time during several runs of both builds (peak device memory 9.6–11.6 GB in those runs, 5.0–5.5 GB
  without); it is recorded, not controlled.

**Picture.** The video packets of each branch export are byte-identical to main's under the same conditions (MD5 of
the stream-copied video: both warm runs of each build `fcb13c07…`, both cold runs `7ee2c881…`; the cold and warm files
differ from each other because the cold run re-renders the 17 masters), and so are the audio packets. SSIM of the warm
branch export against `/tmp/je-mine/out2.mp4` (the CPU-kernel export of §7, as in §10) over all 55,860 frames: mean
0.99937, 1st percentile 0.99506, min 0.98962, none under 0.98 — main's warm export of this session by construction
(identical packets; §10 measured another OpenCL run: mean 0.99928).
`verify_export` on the warm branch export: every format row passes (decode, streams h264 1280×720 60 fps + AAC
48 kHz stereo, duration 931 s, A/V skew 0, true peak −2.32 dBTP), no black or flash at 360 cuts, loudness −13.9 LUFS,
no silence; `cut-click` flags the edit's own 19 cuts, as before.

**Evaluated, not done.**
- *One decoder for all the V1 pieces of a segment* (prototype, not shipped): the pieces of one source read by one
  input through the concat demuxer (`inpoint` / `outpoint` per piece, `duration 1000` so each piece's timestamps sit in
  their own window, `-seek_timestamp 1` so FFmpeg adds no offset), split back by `trim` on those windows into the
  unchanged per-piece chains, NVDEC on that one input. Exact: the replayed 24 segments give all 55,860 frames
  identical (`framemd5`). It decodes every V1 frame on the GPU with one NVDEC session per segment instead of 4 of
  ≈ 15 inputs: pool CPU 1,508 cpu-s (−23 % from this branch's graphs, −35 % from main's), but NVDEC is then busy 92.5 %
  on average and the pool takes 137.8 s, no faster than the base alone (133.5 s in the same pool session); decoding
  every other segment's pieces on the CPU instead: 129.3 s, 1,790 cpu-s. Shipping it would also need each source's
  container start time (FFmpeg's `-ss` is relative to it, the concat demuxer's `inpoint` is not), which media records
  do not store. Worth it where the CPU, not the decoder, is the limit.
- *Continuing to decode across nearby cuts of one source instead of seeking*: of the 337 cut transitions in the
  segments, 89 jump less far forward in the source than the seek's pre-roll; continuing there saves 8,886 of the
  107,013 decoded frames (8 %, ≈ 2 % of the composite CPU). 45,016 of the decoded frames are pre-roll (from the
  keyframe before each seek, every 250 frames here) that the per-clip seeks cannot avoid.
- *A cheaper exact YUV → RGBA conversion*: not attempted. Assumption, not measured: with `accurate_rnd` and the
  full-chroma flags swscale converts through its generic C vertical scaler / full-chroma RGB writer, and another
  route (other pixel format, order or flags) rounds differently, so it would not be bit-identical.
- *Culling layers hidden or off-screen*: a lower layer hidden by a base piece is still decoded and converted on those
  frames (only its blend is skipped); skipping its conversion would need its input split around the piece. The real
  project has no such layer (its 384 full-frame overlays were the V1 clips and the 23 master spans above them), and no
  layer off the canvas or at 0 % opacity.
- *Redundant conversions*: none found — each layer is converted to RGBA once, the composite to `yuv420p` once.

## 13. Short motion-graphics exports: warm render browsers, the bundle over HTTP, no composition page, fewer pages (implemented)

`remotion/service.ts`, `remotion/browser-pool.ts`, `remotion/page-pool.ts`, `mg-bundles/text-measure.ts`
(`serveBundleForMeasuring`), `compositions/src/render-host.ts` (`sequenceComposition`), `layer-bake/service.ts`.

**Report.** Through the headless engine and the CLI, a 1080×1350 @ 30 fps design (a photo with an eased push-in and a
fade, a two-line Oswald title with the `mask-reveal` per-character preset; optionally the photo with Sapphire
Halftone + Noise) took ≈ 7 s per second of video: 2 s without effects 22–25 s, 6 s with halftone + noise 42.8 s, against
2.4–4.6 s for the same design as an HTML page rendered by headless Chrome (8 browsers, PNG screenshots, x264). The
user's own test projects (`soffy-stuff/work/tooltest/jasper-editor`, same host) show where: the export is hybrid; the
title and, with effects, the photo are layer-bake masters (Remotion renders, ProRes 4444), and those bakes were 17 of
the 24 s (2 s) and 31–36 s of the 42 s (6 s, both masters at once). An identical re-export (bakes cached) took 5.7 s.

**Bench.** This host (16 logical cores, 61 GB, no GPU: WebGL is SwiftShader; shared with other agents, so the load is
reported with every figure), LGPL FFmpeg 7.1.5 (`JASPER_FFMPEG_LGPL_ONLY=1`), system Google Chrome, dev engine
(`tsx apps/engine/src/cli.ts`), OpenH264. The four designs are rebuilt by a script of CLI calls copied from the user's
`make-test.sh` (2 s / 6 s × without / with halftone + noise; the noise's amount stays at its default 0) and exported
with `jasper export --out … --json`, the layer cache emptied before each export (`rm -rf <appdir>/cache/layers/*`):
`apps/engine/bench/mg-export.sh` (the same CLI calls and measurements; the figures here used the report's own photo,
an 800×1000 PNG, passed with `--image`; the script defaults to the `pnpm fixtures` still).

**Where the time went (measured, before).** Phases of one cold 2 s export without effects (load 1.9 → 4.2): job
21.9 s = bake 17.5 s, then plan 0.1, encode 4.0, frame check 0.2 s (the 3.9 s mix runs beside the bake). Inside the
bake of the 60-frame title master (976×702, 6 pages; temporary instrumentation, load 17–22): shared browser launch
0.9 s, `selectComposition` 4.6 s, frames 11.3 s, stitch (Remotion's ProRes 4444) 3.8 s, BT.709 remux 0.2 s, frame
count 0.3 s, crop check 1.5 s. The photo master with halftone + noise (1080×1350, 60 frames, 6 pages, load 9–19):
`selectComposition` 8.7 s, frames 43.4 s, stitch 9.4 s. A render's frames, timed in isolation (`renderFrames`, the same
props, a browser of its own, load ≈ 9): the first frame after 10.2 s, the other 59 in 2.4 s (24.5 frames/s).
So the fixed costs — pages loading the bundle — dominated the short masters, not the per-frame work:

- *A page loading the compositions bundle* (`bundle.js` 12.6 MB plus chunks, measured over CDP: `Performance.getMetrics`
  and a CPU profile of the load): 2.8–6.6 s until Remotion's globals exist, 1.7–4.2 s of it script (compile and the
  modules' top-level evaluation), with 4 pages loading at once (3 runs, load 5–10). Remotion serves the bundle from
  its own server on a new port per render with `Cache-Control: no-store`, and opens a fresh browser per render (or
  per export with the shared bake browsers), so every page of every render paid it again: `selectComposition` (one
  page, only to compute the size, fps and duration) and then each of the render's pages.
- The same bundle served cacheable at a stable URL, after two loads in the browser (Chrome writes V8's code cache on a
  script's second load): 1.8–2.7 s with 4 at once, ≈ 1.0–1.25 s of script (3 runs interleaved with the above).
- *Too many pages for short masters*: `pageShares` gave a page per 10 frames (60 frames → 6 pages, 180 → 16), each
  page loading the bundle and keeping a 1080×1350 window composited in software. Measured (`renderFrames`, the
  title's props, warm browser with the cacheable bundle, load 9–12, the third of three runs each): 2 pages 5.2 s,
  3 pages 6.2 s, 6 pages 7.4 s.
- *Per-frame work of the halftone layer* (SwiftShader runs the shaders in the browser's one GPU process): one browser,
  2 pages 4.2 frames/s, 6 pages 4.6 frames/s; three browsers of 2 pages each 6.6 frames/s (load 8–15).
- *Remotion's ProRes 4444 stitch* of the halftone frames: `prores_ks`'s rate control searches quantisers per slice,
  ≈ 1.4 CPU-s per 1080×1350 frame (60 frames: 83–90 CPU-s, 21–24 s at 4 threads; load ≈ 25). Sampled over a whole
  cold 6 s export with effects (CPU of every process of the engine's tree, load 10–19): the stitch 261 CPU-s (before)
  / 303 (after) of ≈ 1,000 / 930 in all, Chrome (SwiftShader) ≈ 620 / 510, the composite ffmpeg 89 / 97, node 30 / 23.

**Changes.**
1. *The bundle over loopback HTTP, cacheable* (`RemotionService.renderServeUrl`): the serve-URL directory (content
   addressed: the dev source hash or the prebuilt stamp) is served once per process by `serveBundleForMeasuring`
   (random path prefix, 127.0.0.1, `unref`ed) with `Cache-Control: public, max-age=31536000, immutable`, and every
   render, sheet and still loads it from there (falls back to the directory when the server cannot start).
2. *Warm render browsers* (`BrowserPool`, `openSharedBrowser`): a browser a render, a bake session, a still, the text
   measurer, a poster or a PSD export used goes back to a pool instead of being closed: its pages are closed, it loads
   the bundle once more the first time it is idle (so the next render's pages find V8's code cache), and the next
   `openSharedBrowser` gets it. At most `JASPER_RENDER_BROWSERS_IDLE` (4) idle, closed after
   `JASPER_RENDER_BROWSER_IDLE_SEC` (300 s) unused or after 50 holders, or when its launch options (executable, probed
   `gl`) changed; an idle browser that does not answer a CDP round trip within 3 s (crashed, hung) is closed and a new
   one launched; engine shutdown closes them all (`RemotionService.stop` from `CoreServices.stop`). Renders that
   used to let Remotion open a browser of their own (one-page renders, stills without a shared browser) take a pooled
   one. Idle, two warm browsers used 0.35 CPU-s in 20 s. After the engine stopped, none of its Chrome processes was
   left.
3. *The sequence composition from the document* (`sequenceComposition`, the `calculateSequenceMetadata` of the
   bundle, the default props overridden by the input props, like `remotion_calculateComposition`): no
   `selectComposition` page. Props without a document with settings and a duration still ask the bundle. Checked
   against the real `selectComposition` (`remotion-warm.e2e.test.ts`: equal `VideoConfig`s for a 1080×1350 @ 30 and
   an empty 29.97 document).
4. *A page renders at least 30 frames* (`MIN_FRAMES_PER_PAGE` 10 → 30): a 60-frame master renders on 2 pages, a
   180-frame one on 6; long masters keep their share of the budget (the 17 × 363-frame bake of §8: 2 pages each, as
   before). With changes 1–3 in place, bake medians of 3 interleaved runs, floor 10 → 30 (load 12–23): 2 s 6.4 → 4.5 s,
   2 s with effects 31.5 → 25.8 s, 6 s 18.7 → 12.0 s, 6 s with effects 97.2 → 81.9 s.
5. The bake job's and the export's logs get each master's phases: `layer-bake "SOFFY": remotion master: 180 frames
   880×702 on 6 page(s): setup 0 ms, frames 13494 ms, stitch 9362 ms, remux + count 511 ms`.

**Output.** Every frame is the same: the decoded video of the four exports after the change has the same `framemd5`
as before (2 s / 6 s, with and without effects; three runs each), and so does every intermediate variant measured.

**Result (measured).** Three interleaved rounds (main 4e2dd3342 in a detached checkout, then this branch, each
round restarting the engine and making one unmeasured warm-up export first; this host as above, other agents' load
8–20), each design exported once per round with an empty layer cache; wall = the CLI call (`jasper export`), job /
bake = the job result's `timings`, CPU = every process of the engine's tree sampled each 0.5 s (Chrome's processes
included; medians):

| Design | Before: wall (median of 3) | After: wall (median of 3) | Before → after: job, bake | Sampled CPU before → after | Load (1-min) before / after |
|---|---:|---:|---|---|---|
| 2 s, no effects | **26.0 s** (14.5, 36.7, 26.0) | **15.9 s** (10.3, 20.5, 15.9) | 23.3 → 13.9 s, 18.4 → 9.0 s | 173 → 82 CPU-s | 9, 18, 16 / 16, 13, 15 |
| 2 s, halftone + noise | **48.1 s** (44.7, 68.8, 48.1) | **36.7 s** (26.1, 47.3, 36.7) | 46.2 → 34.6 s, 42.2 → 31.7 s | 448 → 240 CPU-s | 8, 16, 13 / 14, 12, 13 |
| 6 s, no effects | **50.2 s** (50.2, 76.5, 50.2) | **27.5 s** (22.8, 34.7, 27.5) | 47.9 → 25.7 s, 36.4 → 14.0 s | 488 → 248 CPU-s | 13, 16, 12 / 11, 13, 10 |
| 6 s, halftone + noise | **95.8 s** (92.9, 139.3, 95.8) | **79.9 s** (79.9, 101.1, 75.4) | 93.5 → 78.3 s, 84.4 → 69.4 s | 1028 → 808 CPU-s | 16, 20, 14 / 13, 19, 13 |

So ≈ 13 → 8 s per second of video without effects at 2 s, 8.4 → 4.6 s at 6 s, and 16.0 → 13.3 s with halftone + noise
at 6 s (whose floor is its SwiftShader frames and ProRes stitch, below). The first export after an engine start
launches its browsers cold (not in the table). Rerun: `ENGINE_PID=<engine pid> apps/engine/bench/mg-export.sh --appdir
<its appdir> --image <png> --runs 1` against an engine started from main, then from this branch, alternately (the
script's header has the engine command line).

**Evaluated, not shipped.**
- *Frame ranges of one master in separate browsers* (each range a Remotion render with `frameRange`, joined by stream
  copy: ProRes is intra-only): more GPU processes for SwiftShader (6.6 against 4.2–4.6 frames/s above) and the
  stitches overlap the rendering. Not exact: the halftone photo's frames from 45 on (the first frame of the second
  range) came out ±1 on 0.16 % of their channel values (max difference 1; frames rendered by a page that started at
  frame 45 rather than before it, where the layer's scale keyframes end). The title layer was identical. Under this
  host's load (25–40) two runs each gave no wall-time gain (bake 107 / 124 s split against 125 / 91 s whole).
- *JPEG intermediates*: every Remotion render here is an alpha master (straight-alpha ProRes 4444 for the native
  composite), so PNG captures stay (JPEG has no alpha). The Remotion export path already captures PNG on purpose
  (`renderMedia`: JPEG's 4:2:0 and ringing blurred thin strokes past Program preview).
- *A cheaper master codec*: the ProRes 4444 stitch is now the largest single cost of a heavy master (above). UtVideo
  (`gbrap`, lossless, LGPL FFmpeg's own encoder) encoded the same 60 halftone frames in 13.6 CPU-s instead of 83–90,
  into 33 MB instead of 49 MB, and is exact where ProRes is lossy; `prores_ks -qscale:v 4` took 24 CPU-s but lost
  quality (PSNR against the PNG frames 55.6 dB, the default 72.9 dB); `-filter_threads` changes nothing (same bytes,
  same time). Changing the master format changes S11:LBK-003's ProRes 4444 master, the bake recipe (cache version),
  the composite's input conversion and the graded path: a decision of its own, not made here.
- *The crop check* (`clippedAtBorder`): cropping the 1-px strips before the RGBA conversion gives the same YMAX values
  (checked on a 180-frame master) in 9.4–10.4 instead of 16.7–17.3 CPU-s; the ProRes decode is most of the rest.
  Small next to the above; not done.
- *The export's own encode* (composite + OpenH264): 1.3–13 s here; the photo is drawn by a node kernel stream
  (`pipe:3`, 5.9 MB per frame) and composited by ffmpeg (≈ 1.6 s of the 4 s for 60 frames with a synthetic input).
  Unchanged.

**Remaining limits.** Without a GPU the halftone layer's frames (SwiftShader) and their ProRes stitch remain: ≈ 87 % of
the sampled CPU of a cold 6 s export with effects after the change (Chrome 510 + stitch 303 of 930 CPU-s, one run). The first export after the engine starts launches its browsers and loads the bundle
cold (no code cache yet); a re-export of an unchanged design reuses the cached bakes (≈ 5 s). The ±1 history
dependence of the halftone frames above is the compositions' (a page's earlier frames change later ones): which frame
a page starts at already depends on the page count (the budget follows the cores); the new floor gives short masters
fewer pages, and the four designs came out identical.
