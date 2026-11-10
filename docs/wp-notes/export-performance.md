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
