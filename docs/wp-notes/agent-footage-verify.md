# Agent footage editing — export verification and delivery targets (spec 18 §2.5 AF-VER)

Status: implemented 2026-10-31 (AF-VER-001…005). Spec: [`docs/specs/18-agent-footage-editing.md`](../specs/18-agent-footage-editing.md)
§2.5. Ideas adapted (no code) from kajisho5/ffmpeg-skill (MIT): the row shape, the format / judgement split, three
tolerances and pinning documented thresholds to code by a test — [`licenses/ported/ffmpeg-skill.md`](../../licenses/ported/ffmpeg-skill.md).

## Behaviour

- **What an export records.** Every export writes `verify.json` beside `output.*` in its job directory
  (`apps/engine/src/export/verify-context.ts`, written atomically by `ExportService.finishExport`): the sequence, the
  frame range and rate, the timecode start, what was asked (container; video codec, size, rate, the encoder's pixel
  format, alpha; audio codec, rate, channels), the loudness normalisation, and the picture cuts of the range from the
  cut map (`analyzePictureCuts`, ≤ 5 000) with what the timeline intends at each: black before / after (no picture on
  that side — a gap or a cut to / from nothing —, a solid darker than 16/255, a one-sided transition (fade) on either
  clip, or a dip / fade-to-black transition) and an effect over it (a two-sided transition, or a graphic / adjustment
  layer within ±3 frames). Verification judges the file against this record, whatever the document has become since.
  Writing it never fails an export (a failure is logged; the checks that need it then say `unverified`).
- **Engine job `export-verify`** (`POST /api/exports/:jobId/verify {target?, checks?: 'fast' | 'full'}` → 202 job; result
  `ExportVerifyResult` in `packages/api/src/exports.ts`). 404 `NOT_FOUND` for an unknown or non-export job, 409
  `EXPORT_NOT_FINISHED` for one that has not succeeded; a job whose file was cleaned up fails `NOT_FOUND`
  (non-retryable) with "export again". Jobs dedupe per export, check set and target, show in the Jobs panel as children
  of the export (`parentId`), and carry `origin: agent` when an agent asked.
- **Rows.** `{id, kind: 'format' | 'judgement', status: 'pass' | 'warn' | 'fail' | 'unverified', measured, expected,
  tolerance, at?: {sec, frame, timecode}, message}`; `verified` = no `fail` row and no `unverified` format row; `counts`
  per status. A check with findings lists one row per finding (at most 50, then one row counting the rest); a clean
  check is one `pass` row. `at.frame` is the sequence frame the file time shows (range start + ⌊sec × fps⌋), its
  timecode with the sequence's start timecode and drop-frame setting.
  - `decode` (format): both streams decode with no decoder error lines.
  - `streams` (format): video codec, frame size, frame rate (±0.01 fps), pixel format (same chroma subsampling, at
    least the bit depth, alpha when asked: the encoder's input `nv12` is the file's `yuv420p`, a ProRes 4444 decodes as
    12-bit), audio codec, sample rate and channels; a stream the export did not ask for (audio of a picture-only export)
    fails. Without a record (exports of older builds) `unverified`.
  - `duration` (format): |format duration − range| ≤ max(1 frame, 50 ms).
  - `av-skew` (format): |audio end − video end| ≤ 250 ms; ends are the last packets' pts + duration, read from the last
    10 s of the file only. A file with one kind of stream passes ("nothing to compare").
  - `cut-black` (judgement, fail): a run of frames with normalised mean luma < 16/255 lasting ≥ 100 ms that touches the
    ±2 frames of a cut, counted only on the sides where the timeline intends a picture; its length is followed past the
    window (up to the run length needed).
  - `cut-flash` (judgement): one frame within ±2 of a cut whose luma differs by > 0.25 from both neighbours in the same
    direction (a stray white or black frame); `fail`, or `warn` when an effect is over the cut (it may be designed).
  - `cut-click` (judgement, fail): within ±10 ms of a cut, a sample-to-sample step more than 12 dB over the local RMS
    of the steps (centred 20 ms, without ±2 ms around the step), at least −60 dBFS, and isolated (no other step ≥ half of
    it outside ±2 ms in the window). See "Click definition" for why the RMS is of the steps.
  - `loudness` (judgement, fail when off): BS.1770-4 integrated loudness (the audio DSP package's `LoudnessMeter`, the
    meter of every export and Sound Check) within 1.0 LU of the export's normalisation target, else of the delivery
    target's level; `unverified` when there is neither, or the audio is too short or quiet to gate.
  - `true-peak` (format): true peak ≤ ceiling + 0.1 dB; the ceiling is the export's normalisation ceiling, else the
    target's (−1 dBTP), else 0 dBTP (full scale: over it the decoded file clips).
  - `silence` (judgement, warn): spans where every channel is at or under −90 dBFS for more than 2 s.
  - `target-*` with `target` (`DELIVERY_TARGETS` id): `target-container` (format: a container the platform takes),
    `target-aspect` (pass at the target's shape ±1 %; judgement warn for another shape the platform takes; format fail
    for a shape it refuses, with the auto_reframe_sequence hint), `target-resolution` (judgement: warn under or over the
    recommended size), `target-duration` (format: within the platform's minimum / maximum), `target-frame-rate` (format
    fail outside the platform's range; judgement warn for an accepted rate it does not recommend; 23.976 / 29.97 / 59.94
    count as 24 / 30 / 60), `target-size` (format: under the upload limit) and `target-loudness` (judgement warn more
    than 1 LU off the level the platform plays at; `unverified` for platforms that publish none, or under `fast`).
- **Fast checks** (`checks: 'fast'`): probe only — `streams`, `duration`, `av-skew` (+ the target rows). MCP
  `start_export {wait: true}` and `wait_for_job` on a finished export run them and return `output` (container, duration,
  streams with their ends, size), `rows` and `verified` beside the job body (AF-VER-002); when the fast job cannot run
  they return `verificationError` instead and the export result stands.
- **MCP `verify_export {projectId, exportId, target?, checks?, timeoutSeconds?}`** (`apps/mcp/src/tools/verify.ts`):
  refuses a job of another kind or project and an unfinished export; waits (default 300 s, then `timedOut` with the job
  id for wait_for_job); returns the result and `next` (fix format rows unasked, ask about judgement rows, report what
  was measured, at most three review passes).
- **Delivery presets (AF-VER-004).** `deliveryExportFormat` (`packages/project/src/delivery/export.ts`, pure) gives a
  target's export: H.264 CRF 18 + AAC 256 kb/s 48 kHz stereo in MP4 — the engine's LGPL encoder selector
  (`apps/engine/src/tools/encoders.ts`, D-13) picks the H.264 encoder (hardware, OpenH264) or substitutes AV1 / VP9 and
  says so in the plan —; the sequence's shape fitted into the recommended frame size (no padding, even sizes); the
  sequence rate when the platform takes it, else the nearest recommended rate; loudness normalisation to the platform
  level (−14 LUFS where none is published: `DELIVERY_DEFAULT_LUFS`, an assumption) at its true-peak ceiling. A vertical
  target for a horizontal sequence, or a shape outside the accepted range, is refused (`E_INVALID_PARAM`, hint
  `auto_reframe_sequence`) — never cropped. MCP presets `delivery-<target id>` (`list_export_presets` names their
  `target`; `start_export` refuses with the hint); Export dialog ▸ Preset lists "<platform> – H.264" beside Match
  Sequence (the Format select is then fixed to H.264; a refused shape shows the reason in the footer and disables
  Export).
- **Editor (AF-VER-005).** Jobs panel: a finished export row has **Verify** (runs the full check), a finished
  verification row **Results**; the export-finished toast has **Verify** beside Download. The Verify Export dialog
  (`apps/web/src/export/VerifyDialog.tsx`) runs the job, shows its stage, then the summary (Verified / Not verified with
  counts) and the rows grouped Fail / Warn / Pass / Not checked, each with its check name, Format / Judgement chip,
  timecode, message and measured / expected / tolerance; **Go to** opens the exported sequence if another is active and
  seeks the Program monitor to the row's frame, then closes the dialog. The Delivery target select re-runs the check with
  a platform's rows. Engine errors appear in the dialog.

## How it measures

`apps/engine/src/export/verify-measure.ts`; every input with `-protocol_whitelist file,crypto,data`.

- ffprobe `-show_format -show_streams` (validated with zod) and `-read_intervals <duration − 10 s>% -show_entries
  packet=…` for the stream ends.
- Picture: one decode of the first video stream through `extractplanes=y,scale=64:36:flags=area,format=gray` (the luma
  plane area-averaged; LGPL filters), raw to a pipe; each frame becomes one mean, kept only for the frames around cuts.
  Normalised luma = (Y − 16) / 219 for limited-range video, Y / 255 for full range (`color_range` pc / jpeg, `yuvj*`).
  "Mean luma < 16/255" in the spec is read on this normalised scale: limited-range black is Y = 16, so a raw reading
  would never find black (assumption, labelled).
- Sound: one decode of the first audio stream at its own rate and channels, streamed in 1 s blocks through the
  loudness meter (BS.1770-4 with 4× true peak), the silence run tracker and the click windows (only cut ± 22 ms kept per
  cut, freed when complete). Memory is bounded by the cut count, not the file length.

## Click definition

The spec says "a step exceeding 12 dB over the local RMS". Measured against the RMS of the signal, a tone cut without
a fade at its peak (+0.2 → −0.2, RMS 0.14) is a 0.4 step, only 9 dB over — the commonest edit click would pass. The
local RMS is therefore the RMS of the sample-to-sample steps around it (a 200 Hz tone of 0.2 has a step RMS of 0.0037:
the same jump is 40 dB over). Broadband sound (noise, cymbals) has steps as large as its RMS everywhere: the isolation
rule (no other step of half the size outside ±2 ms within ±10 ms) keeps it from counting; the test feeds pseudo-random
noise and gets no click. Measured on the AAC fixture (256 kb/s): a 2-sample spike of 0.6 on a 0.1 tone 3 ms after the
cut is found at its sample (±3 ms), far over 12 dB.

## Validation

Tests (run with `JASPER_FFMPEG_LGPL_ONLY=1`):

- `apps/engine/test/export-verify.test.ts`: fixtures made in the test with lavfi (MPEG-4 Part 2 + AAC in MP4, 320×180,
  30 fps, 3 s, a cut at 1.5 s): clean (all ten rows pass, `verified`), fast checks, 4 black frames at the cut (exact
  `cut-black` row: 133 ms at 00:00:01:15; intended black when the context says a gap follows), a white flash frame
  (`cut-flash` fail; warn under an effect), an injected click (`cut-click`), audio 0.5 s short (`av-skew` −0.5 s),
  quiet audio (`loudness` fail) and a hot sine (`true-peak` fail), 2.3 s of digital silence (`silence` warn), mismatched
  stream settings and an export without a record, the YouTube / Shorts / Reels target rows; unit tests of the click and
  picture detectors and pixel-format matching; the thresholds table pinned to `VERIFY_THRESHOLDS`.
- `packages/project/test/delivery-targets.test.ts`: the delivery targets table below pinned to `DELIVERY_TARGETS`
  (value and official / assumption label per limit), `deliveryExportFormat` (fit, refusal with the Auto Reframe hint,
  rate choice, default loudness).
- `apps/mcp/test/export-verify.test.ts`: jasper-mcp over stdio against a real LGPL-only engine: `start_export {wait}`
  returns the fast rows and `output`; `verify_export` on a jump cut and a cut to a gap (intended black) verifies;
  `target: youtube-shorts` fails `target-aspect`; `delivery-youtube-shorts` on a 16:9 sequence is refused with
  auto_reframe_sequence; `delivery-youtube` exports 1920×1080 at −14 LUFS and verifies against YouTube.

## Limits

- Intended black is read from the cut map's view of the top-level sequence: black inside a nested sequence's own gaps,
  footage that is itself dark (night shots, a fade baked into the media) or keyframed opacity fades that the cut map
  still counts as a picture can make a `cut-black` row the user must judge (it is a judgement row for that reason).
- Only the first video and first audio stream are decoded; extra audio or subtitle streams are probed (`streams`) but
  not decoded.
- `cut-click` looks only within ±10 ms of picture cuts; audio-only edits (J / L cuts) are not cut points of the cut map.
  Sound Check's CLICK finding covers clip edges of the mix before export.
- Platform limits change; the table records what the official pages said on 2026-10-31. YouTube's level (−14 LUFS) is
  community measurement, not published. X's in-app (140 s) and Instagram's in-app (3 min) limits could not be confirmed
  from official pages; the API limits are used. The Export dialog does not remember the platform preset per sequence
  (the remembered choices keep the Match Sequence settings).
- Row messages are English (as other engine-composed messages for agents); the editor translates its own labels, group
  names and chips.

## Thresholds

`VERIFY_THRESHOLDS` (`apps/engine/src/export/verify.ts`); `apps/engine/test/export-verify.test.ts` pins this table to the
code. Spec 18 AF-VER-001 sets the checks; the 1.0 LU loudness tolerance, the +0.1 dB true-peak tolerance and the 0.25 s
A/V end skew are adapted from kajisho5/ffmpeg-skill (MIT, `licenses/ported/ffmpeg-skill.md`).

| Key | Value | Unit | Check: meaning |
|---|---|---|---|
| `durationToleranceSec` | 0.05 | s | `duration`: \|file − range\| ≤ max(1 frame, this) |
| `avSkewMaxSec` | 0.25 | s | `av-skew`: \|audio end − video end\| |
| `frameRateToleranceFps` | 0.01 | fps | `streams` / `target-frame-rate`: rates this close are the same |
| `cutWindowFrames` | 2 | frames | `cut-black` / `cut-flash`: frames each side of a cut judged |
| `blackLuma` | 0.062745 | normalised luma | `cut-black`: 16/255; a frame whose mean luma is under it is black |
| `blackMinSec` | 0.1 | s | `cut-black`: shortest black run reported |
| `flashJump` | 0.25 | normalised luma | `cut-flash`: step against both neighbours |
| `clickWindowSec` | 0.01 | s | `cut-click`: ± search window around the cut |
| `clickOverRmsDb` | 12 | dB | `cut-click`: sample step over the local RMS of the steps |
| `clickRmsWindowSec` | 0.02 | s | `cut-click`: centred neighbourhood of the local RMS |
| `clickIsolationSec` | 0.002 | s | `cut-click`: left out of the RMS; no other step ≥ half outside it |
| `clickMinStepDbfs` | -60 | dBFS | `cut-click`: smaller steps are dither |
| `loudnessToleranceLu` | 1 | LU | `loudness` / `target-loudness` |
| `truePeakToleranceDb` | 0.1 | dB | `true-peak`: ≤ ceiling + this |
| `defaultTruePeakCeilingDbtp` | 0 | dBTP | `true-peak`: ceiling without normalisation or target |
| `silenceDbfs` | -90 | dBFS | `silence`: every channel at or under this is digital silence |
| `silenceMinSec` | 2 | s | `silence`: spans longer than this are listed |
| `aspectTolerance` | 0.01 | relative | `target-aspect`: shapes this close are the same |

## Delivery targets

`DELIVERY_TARGETS[].limits` (`packages/project/src/delivery/targets.ts`); `packages/project/test/delivery-targets.test.ts` pins every row of
this table to the code (value, and "official" vs "assumption" against `assumptions`). Hard limits become `format` rows
of a delivery check, recommendations `judgement` rows. Sizes in bytes read GB / MB as 10^9 / 10^6 (the stricter
reading). Where a platform has a separate API or in-app limit the default-account upload limit an export most likely
meets is taken and the other is named.

| Target | Limit | Value | Source (accessed 2026-10-31) | Basis |
|---|---|---|---|---|
| `youtube` | `maxDurationSec` | 43200 | https://support.google.com/youtube/answer/71673 | official: "256 GB or 12 hours, whichever is less" (verified accounts; unverified accounts: 15 min) |
| `youtube` | `minDurationSec` | none | https://support.google.com/youtube/answer/71673 | official: no minimum stated |
| `youtube` | `maxFileSizeBytes` | 256000000000 | https://support.google.com/youtube/answer/71673 | official: 256 GB (read as 10^9 bytes, the stricter reading) |
| `youtube` | `recommendedSize` | 1920x1080 | https://support.google.com/youtube/answer/1722171 | official: 16:9 standard; 1080p row of the bitrate table |
| `youtube` | `aspectRange` | none | https://support.google.com/youtube/answer/1722171 | official: the player adapts to vertical and square videos; no shape is refused |
| `youtube` | `frameRates` | 24,25,30,48,50,60 | https://support.google.com/youtube/answer/1722171 | official: "Common frame rates include: 24, 25, 30, 48, 50, 60" |
| `youtube` | `minFrameRate` | none | https://support.google.com/youtube/answer/1722171 | official: none stated |
| `youtube` | `maxFrameRate` | 60 | — | assumption: the highest rate the encoding page lists |
| `youtube` | `containers` | mp4,mov,webm | https://support.google.com/youtube/troubleshooter/2888402 | official: supported formats list .MOV, .MP4, WebM (MP4 recommended) |
| `youtube` | `loudnessLufs` | -14 | — | assumption: YouTube publishes no level; ≈ −14 LUFS is community measurement ("Stats for nerds" content loudness) |
| `youtube` | `truePeakDbtp` | -1 | — | assumption: no published ceiling; −1 dBTP is the EBU R128 s1 / AES TD1008 streaming practice |
| `youtube-shorts` | `maxDurationSec` | 180 | https://support.google.com/youtube/answer/10059070 | official: Shorts "up to 3 minutes long" |
| `youtube-shorts` | `minDurationSec` | none | https://support.google.com/youtube/answer/10059070 | official: no minimum stated |
| `youtube-shorts` | `maxFileSizeBytes` | 256000000000 | https://support.google.com/youtube/answer/71673 | official: the YouTube upload limit |
| `youtube-shorts` | `recommendedSize` | 1080x1920 | https://support.google.com/youtube/answer/12779649 | official: square or vertical, "maximum resolution of 1080p" |
| `youtube-shorts` | `aspectRange` | 0.01-1 | https://support.google.com/youtube/answer/12779649 | official: "square or vertical aspect ratio" (≤ 1; 0.01 stands for no lower bound) |
| `youtube-shorts` | `frameRates` | 24,25,30,48,50,60 | https://support.google.com/youtube/answer/1722171 | official: the YouTube encoding page |
| `youtube-shorts` | `minFrameRate` | none | https://support.google.com/youtube/answer/1722171 | official: none stated |
| `youtube-shorts` | `maxFrameRate` | 60 | — | assumption: the highest rate the encoding page lists |
| `youtube-shorts` | `containers` | mp4,mov,webm | https://support.google.com/youtube/troubleshooter/2888402 | official: YouTube supported formats |
| `youtube-shorts` | `loudnessLufs` | -14 | — | assumption: YouTube publishes no level; ≈ −14 LUFS is community measurement ("Stats for nerds" content loudness) |
| `youtube-shorts` | `truePeakDbtp` | -1 | — | assumption: no published ceiling; −1 dBTP is the EBU R128 s1 / AES TD1008 streaming practice |
| `instagram-reels` | `maxDurationSec` | 900 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: Reel specifications "15 mins maximum" (publishing API; the app is reported at 3 min, unconfirmed) |
| `instagram-reels` | `minDurationSec` | 3 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: "3 seconds minimum" |
| `instagram-reels` | `maxFileSizeBytes` | 300000000 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: "300MB maximum" (publishing API) |
| `instagram-reels` | `recommendedSize` | 1080x1920 | — | assumption: 9:16 is recommended and width ≤ 1920 px (official); 1080 × 1920 is the common full-HD size (Meta ads recommend 1440 × 2560) |
| `instagram-reels` | `aspectRange` | 0.01-10 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: "0.01:1 to 10:1", 9:16 recommended |
| `instagram-reels` | `frameRates` | 24,25,30,60 | — | assumption: common rates inside the official 23–60 fps range |
| `instagram-reels` | `minFrameRate` | 23 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: "23-60 FPS" |
| `instagram-reels` | `maxFrameRate` | 60 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: "23-60 FPS" |
| `instagram-reels` | `containers` | mp4,mov | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: "MOV or MP4" |
| `instagram-reels` | `loudnessLufs` | none | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | official: the specification publishes no playback loudness level (help centre and developer docs searched); none |
| `instagram-reels` | `truePeakDbtp` | -1 | — | assumption: no published ceiling; −1 dBTP is the EBU R128 s1 / AES TD1008 streaming practice |
| `tiktok` | `maxDurationSec` | 600 | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: the longest video the posting API takes is 10 minutes (creators: 3 min by default; 60 min in TikTok Studio is reported, unconfirmed) |
| `tiktok` | `minDurationSec` | none | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: none stated |
| `tiktok` | `maxFileSizeBytes` | 4000000000 | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: "Maximum of 4GB" |
| `tiktok` | `recommendedSize` | 1080x1920 | — | assumption: 9:16 recommended at 540 × 960 or larger (ads spec, https://ads.tiktok.com/help/article/video-ads-specifications); 1080 × 1920 inside the official 360–4096 px |
| `tiktok` | `aspectRange` | none | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: only 360–4096 px per side is stated |
| `tiktok` | `frameRates` | 24,25,30,60 | — | assumption: common rates inside the official 23–60 fps range |
| `tiktok` | `minFrameRate` | 23 | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: "Minimum of 23 FPS" |
| `tiktok` | `maxFrameRate` | 60 | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: "Maximum of 60 FPS" |
| `tiktok` | `containers` | mp4,mov,webm | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: MP4 (recommended), WebM, MOV |
| `tiktok` | `loudnessLufs` | none | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | official: the specification publishes no playback loudness level (help centre and developer docs searched); none |
| `tiktok` | `truePeakDbtp` | -1 | — | assumption: no published ceiling; −1 dBTP is the EBU R128 s1 / AES TD1008 streaming practice |
| `x` | `maxDurationSec` | 1200 | https://docs.x.com/x-api/media/quickstart/best-practices | official: "0.5 seconds–20 minutes" (default accounts; Premium 125 min; the in-app 140 s limit is reported, unconfirmed) |
| `x` | `minDurationSec` | 0.5 | https://docs.x.com/x-api/media/quickstart/best-practices | official: 0.5 s |
| `x` | `maxFileSizeBytes` | 8000000000 | https://docs.x.com/x-api/media/quickstart/best-practices | official: 8 GB (Premium 16 GB) |
| `x` | `recommendedSize` | 1280x720 | https://docs.x.com/x-api/media/quickstart/best-practices | official: recommended 1280 × 720 (720 × 1280, 720 × 720) |
| `x` | `aspectRange` | 0.3333-3 | https://docs.x.com/x-api/media/quickstart/best-practices | official: aspect ratio 1:3 to 3:1 |
| `x` | `frameRates` | 30,60 | https://docs.x.com/x-api/media/quickstart/best-practices | official: 30 or 60 fps recommended |
| `x` | `minFrameRate` | none | https://docs.x.com/x-api/media/quickstart/best-practices | official: none stated |
| `x` | `maxFrameRate` | 60 | https://docs.x.com/x-api/media/quickstart/best-practices | official: 60 fps or less |
| `x` | `containers` | mp4,mov | — | assumption: H.264 High Profile + AAC-LC are official; the page names no container — MP4 and MOV are what X apps upload |
| `x` | `loudnessLufs` | none | https://docs.x.com/x-api/media/quickstart/best-practices | official: the specification publishes no playback loudness level (help centre and developer docs searched); none |
| `x` | `truePeakDbtp` | -1 | — | assumption: no published ceiling; −1 dBTP is the EBU R128 s1 / AES TD1008 streaming practice |
| `linkedin` | `maxDurationSec` | 900 | https://www.linkedin.com/help/linkedin/answer/a548372 | official: "Maximum video duration: 15 minutes" |
| `linkedin` | `minDurationSec` | 3 | https://www.linkedin.com/help/linkedin/answer/a548372 | official: 3 s (desktop; 2 s on mobile) |
| `linkedin` | `maxFileSizeBytes` | 5000000000 | https://www.linkedin.com/help/linkedin/answer/a548372 | official: 75 KB – 5 GB |
| `linkedin` | `recommendedSize` | 1080x1080 | — | assumption: no recommended size is published; 1080 × 1080 is the square (1:1) full-HD frame inside 256 × 144 – 4096 × 2304 |
| `linkedin` | `aspectRange` | 0.4167-2.4 | https://www.linkedin.com/help/linkedin/answer/a548372 | official: 1:2.4 to 2.4:1 |
| `linkedin` | `frameRates` | 24,25,30,60 | — | assumption: common rates inside the official 10–60 fps range |
| `linkedin` | `minFrameRate` | 10 | https://www.linkedin.com/help/linkedin/answer/a548372 | official: "Frame rates: 10fps - 60 fps" |
| `linkedin` | `maxFrameRate` | 60 | https://www.linkedin.com/help/linkedin/answer/a548372 | official: "Frame rates: 10fps - 60 fps" |
| `linkedin` | `containers` | mp4,mov,webm | https://www.linkedin.com/help/linkedin/answer/a548372 | official: MP4, MOV, WEBM among others |
| `linkedin` | `loudnessLufs` | none | https://www.linkedin.com/help/linkedin/answer/a548372 | official: the specification publishes no playback loudness level (help centre and developer docs searched); none |
| `linkedin` | `truePeakDbtp` | -1 | — | assumption: no published ceiling; −1 dBTP is the EBU R128 s1 / AES TD1008 streaming practice |
