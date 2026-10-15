# Processing test resource ownership

This before-edit supplement covers the shared `proc` helper in
`apps/engine/test/processing-steps.test.ts`. Original cases retain their KEEP
dispositions in [engine3.md](engine3.md); no cases are added, removed or recounted.
The change is test resource ownership, with no production or assertion changes.

## Evidence and decision before editing

Integration `b66fbab5` failed the upscale preservation case at its unchanged
600000 ms deadline. The real output completed about 73 seconds later while the
following chain case was already running. The helper had discarded its
`AbortController`; Vitest could neither cancel the operation nor await its end.
This is direct RED evidence of a test-lifecycle defect, separately from the
original watchdog failure.

Read-only FFprobe and stream-copy hashing of the late output verified 150 frames
at 25/1 fps, ProRes bt709, doubled width (2560), and identical 93054-byte audio
streams, SHA256
`9b0c89ba06c37a97b1f38aa230fc7d7f324583962ef161a534803a4eaab7a942`.
The sidecar recorded 150 frames and 673.58 seconds total. The original JavaScript
return object was unavailable: these artifact checks do not retroactively pass
`expect(res.frames)` or the timed-out test. A prior integrated run passed this
case in 571791.781816 ms. The test and processing owners were unchanged since
`6c2baa39`.

Host samples after the failure showed load averages around 120 on 16 CPUs and
CPU pressure around 97%, with the test process at nice 0. They demonstrate
contention and progress, not a controlled explanation of every elapsed second.
No numerical defect or deadlock was established. Full evidence is saved in the
validation run's `upscale-timeout-triage.{md,json}` and
`upscale-late-output-validation.json` artifacts.

**REWRITE the helper lifecycle only:** retain each operation's abort controller
and register Vitest's public `onTestFinished` hook to request cancellation and
join its promise within the existing hook budget. The normal test still awaits that promise,
so genuine operation failures remain visible. Cleanup also awaits a rejection
without masking the already-recorded test failure. Do not increase any test or
hook timeout, change fixtures, or add a production cancellation seam.

## Full behavioral bar for affected cases

All paths below are `apps/engine/test/processing-steps.test.ts`. Each original
case remains KEEP; only its shared resource cleanup is rewritten.

| Case or same-contract family | Six-item justification and remaining owner |
| --- | --- |
| `every step keeps frame count, rate and audio`: `deblock`, `denoise-atadenoise`, `denoise-fftdnoiz`, `stabilize-vidstab`, `stabilize-deshake`, `dejudder`, `upscale`, `chain` | **1:** S07 §8 test 2 explicitly specifies `clip-b.mp4`, six seconds of 720p25, frame/rate preservation and bit-exact copied audio; §8 test 6 specifies 2× upscaling. **2:** dropped/extra frames, changed rate, lost/reencoded audio, wrong output format or scale fail output checks. **3:** input packet counts, rate and audio bytes come from the independent input file; ProRes/bt709 and scale are requested output requirements. **4:** real `runProc` with real FFmpeg, step dispatch and generated ONNX model is the processing CLI boundary. **5:** decoder, encoder or step implementation changes preserve the same file observations. **6:** the single-frame tile test cannot observe the container, audio or 150-frame stream; each method and composed chain can independently break preservation. No stronger remaining owner covers all these step outputs. |
| `vid.stab (WASM): motion variance drops ≥ 60 %` | **1:** S07 §8 test 3 requires this reduction on the authored shaky clip. **2:** residual visible camera shake breaches the threshold. **3:** independent phase-correlation measurements of source/output frames produce variance; the 60% target comes from the spec. **4:** real `runProc` file output. **5:** no private stage or call-shape assertion. **6:** the generic preservation test cannot detect ineffective stabilization; this owns the WASM path's quality contract. |
| `deshake: motion variance drops ≥ 40 %` | **1:** S07 §8 test 3 separately specifies deshake's 40% threshold. **2:** ineffective fallback stabilization leaves measurable shake. **3:** measured source/output motion and spec threshold, independent of stabilization implementation. **4:** real processed file. **5:** internal refactors retain the same motion observations. **6:** the WASM threshold and container preservation do not own deshake's independent fallback behavior. |
| `reduces uneven frame-to-frame motion by at least 50%` | **1:** S07 §8 test 4 requires the per-pair motion coefficient of variation to decrease by at least 50%. **2:** visible uneven movement remains when dejudder does not retime correctly. **3:** source/output motion is measured independently with phase correlation and the spec threshold. **4:** real `runProc` output frames. **5:** no private cadence decisions are asserted. **6:** the container count test cannot distinguish correct retiming from unchanged motion. |
| `ranges starting mid-motion retime their edge frames like the whole file does` | **1:** PST-013 requires outside context for range boundaries, also documented in the test's contract comment. **2:** wrong first/last retimed frames differ from the corresponding full-file output. **3:** the full-file behavior is the independent equivalence relation for a range operation; the source-difference guard proves the relevant edge actually changed, so a common no-op cannot pass. **4:** public whole-file and range requests through `runProc`, compared as decoded frames. **5:** the algorithm may change while preserving range/whole equivalence. **6:** the numerical whole-file quality test does not exercise missing neighboring frames at a range boundary. |
| `noise sigma of a flat patch drops ≥ 40 % (medium) with every method` | **1:** S07 §8 test 5 sets the 40% noise reduction on the noisy fixture. **2:** visible residual noise exceeds the threshold for any supported method. **3:** independent decoded patch statistics and a spec-defined ratio. **4:** real file processing for atadenoise, fftdnoiz and nlmeans. **5:** implementation details and filter arrangement are unobserved. **6:** frame/audio preservation cannot detect ineffective denoising, and the three methods are distinct execution paths. |
| `deblock reduces 8x8 blockiness ≥ 25 %` | **1:** S07 §8 test 5 requires the block-edge metric to fall by at least 25%. **2:** visible block boundaries remain too strong. **3:** independently measured source/output gradients and spec threshold. **4:** actual output file from `runProc`. **5:** no filter graph string or internal collaborator shape is asserted. **6:** preservation tests do not measure removed compression artifacts. |

## Fixture and coverage assessment

Preserve the explicitly required 1280×720×150 fixture, 25 fps, all thresholds and
the 600000 ms upscale deadline. The work is 138240000 input pixel-frames and
552960000 output pixel-frames. A smaller acceptance fixture would change S07 §8
test 2, so no such rewrite is justified.

`tiles are seamless on a gradient and mix blends linearly` remains the separate
large-raster owner: its real ONNX model processes a 1200×1000 gradient, including
last-tile/remainder regions, against explicit nearest-neighbour source samples.
Its 96×64 cases exercise linear mixing. That single-frame seam does not own
audio/container/stream preservation. The 720p preservation input currently uses
the whole-frame path, not the tiled path.

Existing shared audio-bearing alternatives are larger or change the required
scenario: `frame-code-aac.mp4` has 64 1080p frames (about 96% of the current pixel
workload), `clip-a.mp4` has 300 1080p frames, and transition clips have 240 720p
frames. Small timing/import fixtures have no audio. The 320×180 camera clip in
`sync-audio.test.ts` is test-local and depends on that suite's lifetime. No
fixture, model, snapshot or helper becomes unused; none is removed.

## Callers and risks

- `proc` is private test support. Its only callers are the cases enumerated
  above; no production caller exists and no export is added.
- `runProc` is used by `apps/engine/src/processing/proc/cli.ts`, which already
  owns and aborts its controller. It retains its public signal contract.
- `ffio.ts` maintains a module-global child set. Merely sending a delayed abort
  after advancing tests could kill the next test's children. The hook must join
  the owned promise before advancing.
- Joining `runProc` proves JavaScript operation settlement, not child reaping by
  itself: the rejection path does not await `RawWriter.close`, and decoder
  cleanup sends SIGTERM without awaiting exit. The scheduled real-PID probe
  must verify actual process exit before the next case; no such result is
  claimed from static inspection.
- The installed Vitest 4.1.11 public declaration documents `onTestFinished` as
  running on pass/fail. Current cases do not dynamically skip. Its existing hook
  timeout stays unchanged; a stuck cleanup remains a reported failure. An
  uninterruptible model call can defer cancellation until that call returns;
  this patch does not claim to change production cancellation latency. If the
  cleanup hook itself times out, Vitest can advance while its promise remains
  pending; this remains a visible validation failure, not successful cleanup.
- Normal operation errors still reject the test's original await. Cleanup's
  settlement observation consumes only that same already-awaited promise;
  numerical assertions and error checks are not caught or suppressed.

## Validation plan and current limits

1. Static checks: focused Biome, TypeScript syntax diagnostics, unchanged
   assertion/deadline/fixture comparison and `git diff --check`.
2. When the parent schedules runtime: a disposable validation copy forces a
   short timeout during an actual processing operation. An external monitor must
   first observe active decoder/encoder PIDs and incomplete output; cancellation
   before child startup is inconclusive. Verify those exact owned PIDs are gone
   and the operation has settled before a following sentinel case. Record any
   residual model-worker/pipe risks and cleanup-wait behavior. Keep the committed
   600000 ms deadline untouched. Exercise the real lifecycle and actual child
   processes, not a mock that implements cancellation.
3. Rerun the unchanged upscale acceptance case, then the affected file and
   required integrated gates as scheduled. The lifecycle fix alone cannot turn
   the original watchdog failure into a pass.

No new heavy runtime, build or package typecheck was launched while the parent's
full suite was active. GREEN cleanup validation and the original acceptance
rerun are pending; the recorded overlap is the RED evidence.

Completed static checks: focused Biome passed (one file); TypeScript parse
diagnostics were empty; `git diff --check` passed. A byte comparison against
`b66fbab5` confirmed every test body, assertion, fixture and deadline is unchanged.
These checks establish the patch's narrow scope, not runtime cleanup success.
Independent cross-review confirmed the installed public hook runs after success
or failure, including watchdog failure, and is awaited within its existing
budget; static review is clear with the process-exit limits stated above.
