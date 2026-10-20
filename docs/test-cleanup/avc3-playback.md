# avc3 browser oracle follow-up

## Before-edit disposition

Base: `32d7fdce`. This record supersedes the two KEEP dispositions for
`apps/engine/test/gaps-avc3-playback.test.ts` in `engine3.md`.

Product sources: [S04 RN-011 and QA-006](../specs/04-media-render-and-backend.md)
require accurate non-keyframe smart cuts and artifact-free decoding in Chromium
and other decoders; [the area worknote](../wp-notes/gaps.md) records the avc3
Chrome/Electron interoperability regression.

The full default run reports Chrome failing after 16.559 s and Electron passing
on the same MP4. Its final assertion stack is not yet available: the Chrome
failure is **unresolved**, not established as a callback-count failure. The
preserved output is `/var/lib/orquester/tmp/jasper-avc3-electron-XeK2ot/smart.mp4`.
There is no production change proposed from this result.

Independent oracle defect: [requestVideoFrameCallback §1 and §4.2](https://wicg.github.io/video-rvfc/)
explicitly allow missed callbacks under main-thread load and provide no strict
delivery timing guarantee. Consequently, receiving at least 45 callbacks in a
54-frame playback, more than 10 after a seek, and opportunistically observing
both exact join frames are not browser playback contracts. Half-speed playback
does not change this guarantee. This conclusion does not depend on which
assertion failed in the current run.

| Original test name / path | Disposition, detectable failure, and stronger owner | Six-item justification for the retained contract |
| --- | --- | --- |
| `plays to the end with every frame and seeks across the copy / encode joins`, `apps/engine/test/gaps-avc3-playback.test.ts` | **REWRITE** only the unsupported delivery quotas and opportunistic join-frame observation. Retain real exported bytes, duration, media errors, playback completion, every observed timestamp/code pair, and forward/backward seeks; verify decoded frames after paused seeks to authored output frames 19, 20, 30 and 5 with literal source codes 29, 30, 40 and 15. Detects an incompatible avc3 parameter-set transition, wrong decoded frame, broken seeking or stalled playback. `smart-render.test.ts` owns MP4 frame count, FFmpeg decode, frame codes and copied-byte fidelity; it cannot detect Chrome-specific decoding failures. | **1:** AGENTS §4 exact export fidelity, S04 QA-006 smart-cut decoder interoperability, and the documented avc3 browser interoperability regression in `docs/wp-notes/gaps.md`; HTML seeking and canvas image-source contracts. **2:** corrupt/wrong frames, failure to finish or failure to seek are visible in the browser. **3:** fixture source frames 10…63 and literal sought codes are authored independently of export implementation; callbacks supply observations, not expected values. **4:** public export HTTP API and real Chrome `HTMLVideoElement` decoding of the resulting MP4. **5:** encoder/planner internals can change while the exported content and browser behavior remain the same. **6:** actual browser decoding is the lowest seam for Chrome interoperability; FFmpeg decoding cannot substitute for it and no retained E2E duplicates this smart-rendered fixture. |
| `plays in Electron with every frame code right`, `apps/engine/test/gaps-avc3-playback.test.ts` | **REWRITE** the unsupported callback quota to non-vacuous observations, retaining playback-to-ended, media errors and every observed timestamp/code pair; apply the same deterministic decoded-frame checks to Electron's decoder. Detects a shipped Electron decoder incompatibility even when Chrome/FFmpeg accept the file. The preceding Chrome case shares the exported artifact but has a different decoder owner. | **1:** AGENTS §4 exact export fidelity and the documented Chrome/Electron avc3 interoperability regression; the desktop shell uses Electron's decoder. **2:** failed playback, corrupt frames or broken seek results are visible in the desktop runtime. **3:** authored literal source codes and target timestamps are independent of production encoding. **4:** an actual Electron `BrowserWindow` and `HTMLVideoElement` using the real MP4. **5:** production export refactors preserve these observations. **6:** Electron is the lowest stable seam for the shipped decoder contract; Chrome and FFmpeg do not own that compatibility. |

Public-seam census: production export flows call `ExportService.renderSmart`;
Chrome and the desktop shell consume exported media through ordinary video
decoders. No test-only production seam, export or injection hook is introduced
or needed. Existing test-local browser probes remain local.

First-candidate risk and validation: the old probe comments claim paused headless seeks do not
repaint. The proposed probe must register a real video-frame callback before
seeking, await both `seeked` and presentation, and keep the media paused while
reading the exact target. No sleep, tolerance increase, retry-until-expected
pixel, or deadline increase is allowed. A paused-seam failure blocks this rewrite
rather than permitting a weaker fallback. [HTML canvas image sources](https://html.spec.whatwg.org/multipage/canvas.html#image-sources-for-2d-rendering-contexts)
requires the frame at the current playback position; [HTML seeking](https://html.spec.whatwg.org/multipage/media.html#seeking)
waits for decodable data before completion.

Validation commands: `JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run
apps/engine/test/gaps-avc3-playback.test.ts --maxWorkers=1`,
`pnpm --filter @jasper/engine typecheck`, changed-file Biome and
`git diff --check`. Existing 30 s playback, 300 s Chrome-test, 120 s Electron-child
and 180 s Electron-test limits remain unchanged. Each browser additionally performs four
paused seek operations, each bounded by a 30 s watchdog within those unchanged outer budgets. Captured MP4 and decoder result
JSON must remain available outside version control for review.

## Second pre-edit decision: decoded current-position seam

The failed first draft is recorded below and is not counted as passing. Separate
diagnostic probes on the preserved original smart export and untouched
`frame-code.mp4` control establish a fixture-delivery defect: the original
HTTP interception ignored `Range: bytes=0-` and returned an unconditional 200.
Chrome reported `seekable=[[0,0]]` for **both** fully buffered files. Every
requested seek emitted `seeked` at currentTime 0 and retained the initial code
(10 for the export, 0 for the source). The original forward/backward playback
checks did not assert their requested positions and could therefore replay the
start instead. This is distinct from the still-unclassified full-run failure.

With the same bytes fully materialized as Blob URLs, both files exposed their
full seekable ranges. All four export targets decoded to literal codes
29/30/40/15, and all four corresponding source-control targets did too. Each
canvas read happened synchronously after `seeked`, with readyState 4 and
seeking=false; no presentation callback, sleep or retry was awaited. Incremental
records: `/tmp/jasper-test-prune2/avc3-canvas-diagnostic-v2.jsonl` (HTTP defect)
and `avc3-canvas-diagnostic-v3.jsonl` (all eight Blob/control targets passed).

The second rewrite will supply the exported bytes as a Blob in Chrome (Electron
continues reading the real file), await `seeked`, and inspect the decoded current
frame directly. HTML seeking steps 12–17 require available decoded data before
completion; the canvas image-source rule requires the current playback frame.
The literal expected codes remain unchanged. The observed currentTime must fall
in the independently requested frame interval; seeking must be false and data
available. This removes the unnecessary presentation-callback prerequisite
without removing boundary decoding or forward/backward playback checks. The
six-item justifications above remain applicable; this is a lower stable browser
seam for the same exact decoded-frame contract, not a weaker fallback. No HTTP
Range server or production seam is added. The existing outer budgets stay fixed.

## First draft runtime result (abandoned)

**The first candidate failed runtime validation and was not integrated.**

The exact targeted command above ran with one worker and the original outer
budgets: Chrome failed with `seek frame 30 did not present` at the new 30 s
paused-presentation watchdog; Electron passed. Chrome took 83.167 s; the file
reported 135.734 s of tests, 340.63 s of cold imports and 484.45 s total. Host
load after the run was 87.11 on the shared 16-core host. These measurements do
not establish why the earlier unchanged Chrome test failed.

The Chrome probe completed both waits for targets 19 and 20 before target 30
stalled, but its result never returned, so their frame/code values were not yet
asserted. The Electron artifact records exact target media times/codes
`0.633333/29`, `0.666667/30`, `1/40`, `0.166667/15`, duration 1.8 s, ended=true,
no media error and 15 correct playback samples. Artifacts:

- `/tmp/jasper-test-prune2/avc3-rewrite.log`
- `/var/lib/orquester/tmp/jasper-avc3-electron-GHQTby/smart.mp4`
- `/var/lib/orquester/tmp/jasper-avc3-electron-GHQTby/result.json`
- Export job `job_d4b1eb134cf7fc5c` in
  `/var/lib/orquester/tmp/jasper-engine-uUxVon/engine/jobs.jsonl` succeeded with
  54 frames, 1.8 s and 30062 bytes through libopenh264 smart copy.

Cross-review found the independent expectations and static synchronization
sound, but required actual paused presentation validation. Chrome did not
satisfy that condition. That candidate was stopped without retry, tolerance or
deadline changes, and without production edits. The later current-position
diagnostic and implementation are separate evidence, not a claim this candidate
passed. Its timeout did not save the individual seeked/rVFC flags, so it cannot
identify which signal was missing. The original full-run Chrome assertion is
still unresolved pending its stack.


## Interim current-position validation

Both original declarations are REWRITE; no original test was added or deleted.
The authoritative engine3 census is now 22 DELETE / 31 REWRITE / 174 KEEP (227
rows), replacing two previous KEEP dispositions. The revised shared page probe is
independently executed by real Chrome and Electron. Production code, outer
budgets and every observed playback timestamp/code assertion remain unchanged.
The invalid HTTP media fixture and duplicate Electron page-probe source were
removed; no production seam or generated fixture was added.

`JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run
apps/engine/test/gaps-avc3-playback.test.ts --maxWorkers=1` **passed both tests before
the fresh-start assertion below was added**:
113.88 s of tests, 203.49 s imports, 326.26 s total. Log:
`/tmp/jasper-test-prune2/avc3-rewrite-canvas.log`. This validates the interim
Blob/current-position oracle, not the abandoned rVFC prerequisite or the later
fresh-start assertion.

Chrome and Electron both returned paused target positions/codes:
`0.65/29`, `0.683333/30`, `1.016666/40`, `0.183333/15`, with seeking=false and
readyState=4 at every target. Both played the 1.8 s file to ended with no media
error; all sampled timestamp/code pairs were correct. Chrome observed 13
callbacks from the start, 6 after the forward seek, and 14 after the backward
seek; Electron observed 16. These are diagnostic measurements, not new callback
quotas. The independent sought-frame checks prove content even when callback
delivery skips those exact frames.

Interim artifacts, retained outside git:

- Chrome export:
  `/var/lib/orquester/tmp/jasper-engine-itLtPI/renders/job_91cb6587d129d450/output.mp4`.
- Chrome JSON: the same path suffixed `.chrome.json`, `.chrome-seek-30.json` and
  `.chrome-seek-5.json`.
- Electron copy and JSON:
  `/var/lib/orquester/tmp/jasper-avc3-electron-U14NAK/smart.mp4` and `result.json`.

Scoped Biome and `git diff --check` passed. At this interim stage, semantic engine
typecheck and final cross-review remained pending. No full repository gate is claimed by this follow-up;
the integration coordinator owns those checks. The full-default original
Chrome assertion remains unclassified until its final stack is emitted.

## Cross-review refinement before final edit

The four paused target checks use the already-played video. Cross-review found
that the two fresh-video seek-and-play probes still needed their own actual
start-position assertion: an ignored initial seek could replay from zero and
pass every timestamp/code observation. Capture currentTime immediately after
that initial `seeked`, before playback, and assert frame intervals 30 and 5.
This is the same independently authored seek contract and remains at the public
media-element seam; it detects the demonstrated clamping-to-zero failure without
adding a declaration, sleep, tolerance or deadline. Repeat both browser cases
and the semantic engine typecheck after this assertion change.

## Interrupted final-source checks

The first run after adding the fresh-start assertion printed two passing tests
(93.87 s of tests, 142.24 s imports, 237.65 s total), but the command returned
143 (SIGTERM). The concurrent semantic typecheck also returned 143 without a
compiler result. Neither command counts as a successful final gate. Logs are
`/tmp/jasper-test-prune2/avc3-rewrite-canvas-final.log` and
`/tmp/jasper-test-prune2/avc3-engine-typecheck-final.log`. The signal sender and
cause are unknown; no product change follows from those interrupted commands.
Their saved decoder results remain evidence of completed assertions only:
Chrome export `job_cf3c921536af6fbd` in
`/var/lib/orquester/tmp/jasper-engine-tjsbvk/renders/` and Electron artifacts in
`/var/lib/orquester/tmp/jasper-avc3-electron-cQsH0R/`.

Final static cross-review cleared the fresh-start interval assertions, literal
paused-target codes, every observed playback code, standalone shared probe and
unchanged two-test census. Clean runtime and semantic typecheck completion are
still required before integrating the candidate.

## Traced final-source failure

The next final-source run returned exit 1 normally: Chrome failed the retained
playback-code assertion, `frame 5: expected 16 to be 15`; Electron passed. Chrome
recorded 46 samples with only `[5,16]` mismatching, followed by correct `[6,16]`.
Its four paused targets all returned the required 29/30/40/15 codes. Electron's
29 playback samples and all four targets were correct. Both reached ended at
duration 1.8 s without a media error. This is a failed gate, not a passing retry.
No assertion was removed or relaxed in response.

- Log: `/tmp/jasper-test-prune2/avc3-rewrite-canvas-final-retry.log`.
- Chrome MP4 and JSON:
  `/var/lib/orquester/tmp/jasper-engine-B8VZdX/renders/job_59e06ed4ae212200/output.mp4`
  and the same path suffixed `.chrome.json`.
- Electron MP4 and JSON:
  `/var/lib/orquester/tmp/jasper-avc3-electron-doLiH2/smart.mp4` and `result.json`.
- Signal trace `/tmp/jasper-test-prune2/avc3-final-signal.*` records Vitest's
  normal worker termination by its parent; the Vitest and pnpm leaders exited
  1. It does not explain the preceding commands' unexplained 143 exits.
- The final-source semantic engine typecheck retry **exited 0**; log:
  `/tmp/jasper-test-prune2/avc3-engine-typecheck-final-retry.log`.

The exact-code assertion remains in place while investigating whether callback
metadata and a later canvas read are synchronized. The rVFC specification only
promises best-effort drawing synchronization. A potential stable observation is
an immutable [`VideoFrame(video)` snapshot](https://w3c.github.io/webcodecs/#videoframe-interface):
the constructor copies the current decoded frame and its presentation timestamp.
Drawing that frame would pair pixels with their own timestamp while preserving
the exact authored `code = output frame + 10` assertion. This is a proposed
measurement correction, not an implemented or validated alternative; both real
decoders and the untouched source control must establish its behavior first.

## Third pre-edit decision: immutable playback samples

The WebCodecs [constructor](https://www.w3.org/TR/webcodecs/#videoframe-constructors)
and [frame initialization](https://www.w3.org/TR/webcodecs/#initialize-frame-from-other-frame)
specify that `new VideoFrame(video)` retains the current decoded frame's resource
and timestamp unless an override is supplied. The revised sample will construct
that frame with **no timestamp override**, draw that same immutable frame, derive
its observed frame index from `timestamp / 1e6`, and close it in `finally`.
rVFC remains a sampling trigger. The exact `code === observed frame + 10`
assertion applies to every snapshot; no mismatch filtering or tolerance is added.
The four paused literal targets, fresh starts, completion, duration, errors,
non-vacuity and all budgets remain unchanged.

Before editing the repository test, a separate diagnostic passed in Chrome and
then Electron against both the failing run's preserved smart MP4 and untouched
`frame-code.mp4` source. Every native-timestamp/pixel pair and all eight paused
targets per decoder were correct. Records:
`/tmp/jasper-test-prune2/avc3-snapshot-chrome.jsonl` and
`/tmp/jasper-test-prune2/avc3-snapshot-electron.jsonl`. The first Electron launch
omitted the existing owner's `--ozone-platform=headless` flag and could not
initialize X11; it made no decoder observation. Repeating with the owner's
headless flag exited 0. This setup error is preserved in
`avc3-snapshot-electron.log`; the actual decoder run is in
`avc3-snapshot-electron-headless.log`.

The prior `[5,16]` / `[6,16]` failure is consistent with cross-observation timing,
but this diagnostic does not conclusively attribute that earlier failure. The
measurement change follows the public snapshot guarantee, rather than declaring
the earlier export correct because a later run passed. Cross-review cleared the
snapshot design before implementation.

Both original REWRITE dispositions retain their six-item bar: **1** exact smart
cut decoding and authored frame content remain independently required by S04 and
AGENTS §4, with WebCodecs specifying the observation; **2** a frame with the wrong
pixels for its PTS fails; **3** expected source code remains the authored trim
offset, not a value computed by the exporter; **4** `VideoFrame(video)` snapshots
the actual Chrome/Electron HTML media decoder through a public interface;
**5** exporter/planner refactors cannot affect the assertion while preserving
decoded content; **6** each real decoder is still its separate compatibility
owner, without adding a decoder or demuxer. Chrome's intercepted fixture page
uses localhost as the installed Chromium's trusted fixture context;
this does not change engine authentication or browser security flags. No
production seam is introduced. Final runtime, semantic types and static review
must be repeated on the implementation.

## Completed snapshot-oracle validation

The final implementation passed both real decoder tests with exit 0 under
`JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run
apps/engine/test/gaps-avc3-playback.test.ts --maxWorkers=1` (wrapped in signal
tracing). The file reported 122.17 s of tests, 213.43 s imports and 343.77 s total;
log `/tmp/jasper-test-prune2/avc3-snapshot-final-test.log`. All original outer
budgets remained fixed. The final semantic `pnpm --filter @jasper/engine
typecheck` also exited 0; log
`/tmp/jasper-test-prune2/avc3-snapshot-final-types.log`. Scoped Biome and
`git diff --check` passed, and independent static cross-review cleared the exact
snapshot implementation. No repository-wide gate is claimed here.

Both decoders returned paused positions/codes `0.65/29`, `0.683333/30`,
`1.016666/40`, `0.183333/15`, each with seeking=false and readyState=4. Chrome's
fresh forward/backward playback starts were independently measured as 1.016666
and 0.183333 s. Every playback reached ended with no error and duration 1.8 s.
All native snapshot timestamp/code pairs were correct: Chrome observed 33
samples initially, 6 after the forward start and 13 after the backward start;
Electron observed 17. These counts are recorded measurements, not quotas.

Final artifacts retained outside git:

- Chrome exported MP4:
  `/var/lib/orquester/tmp/jasper-engine-Gq1pyL/renders/job_35fa61b6d8461dbe/output.mp4`.
- Chrome JSON: that path suffixed `.chrome.json`, `.chrome-seek-30.json`, and
  `.chrome-seek-5.json`.
- Electron copied MP4 and JSON:
  `/var/lib/orquester/tmp/jasper-avc3-electron-quhoap/smart.mp4` and `result.json`.

This completes two REWRITE dispositions, with no declaration added or deleted;
engine3 remains 22 DELETE / 31 REWRITE / 174 KEEP. Removed support is the invalid
HTTP media interception and duplicate Electron probe source. No production code
or seam changed. Earlier failed/interrupted attempts remain recorded above.

The subsequently completed full-default report identifies the original Chrome
failure: `frame 1 after a seek to 5: expected 12 to be 11`. This is an exact
callback-time/pixel mismatch, not a callback-count failure. The old probe did not
save that failing seek's image and callback together, so the stack alone cannot
establish its cause. The independent snapshot and paused-seek checks above passed
without relaxing any frame-code equality. Earlier pending-stack statements record
what was known at those stages.
