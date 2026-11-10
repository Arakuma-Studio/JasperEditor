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
