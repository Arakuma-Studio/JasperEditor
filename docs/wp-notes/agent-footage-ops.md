# Agent footage editing — media derivation ops (spec 18 §2.7 AF-OPS-001…002)

Every `NativeRecipeSchema` op that had no runner now runs on the engine: `conform-cfr`, `reverse`, `denoise-audio`,
`extract-audio`, `time-stretch` and `range` (loudness-normalize, transcode, stabilize and `process` already had
theirs). Each is an engine job; its output becomes a derived media through `media.derive` (one undo step).

## Flow

| Layer | Files | What |
|---|---|---|
| Model | `packages/project/src/process/derive.ts` | `DERIVE_OPS`, `DERIVE_LIMITS`, `deriveProblems` (refusal codes against a probe), `rangeFrames` (exact BigInt frame range), `deriveSourceKinds` / `derivedKind` |
| Command | `packages/project/src/commands/handlers/process.ts` (`media.derive`) | Source kinds per op (audio ops and timing ops take video or audio; conform-cfr video); audio ops make an `audio` asset; the recipe is re-checked with `deriveProblems` (`E_OUT_OF_MEDIA` / `E_INVALID_PARAM`); a `range` of a constant-rate video records `sourceRange` (`origin: 'process'`) so it is a version of its source and `replaceInClips` keeps the clips on the same source frames; `denoise-audio` may switch audio clips (like loudness); `extract-audio`, `reverse`, `time-stretch` and `conform-cfr` refuse `replaceInClips` (timing or streams differ) |
| API | `packages/api/src/processing.ts`, `routes.ts` (`mediaDerive`), `jobs.ts` (kind `derive`), engine-client `deriveMedia` | `POST /api/media/:key/derive {projectId?, recipe}` (`?wait=1` answers the finished job). The recipe schema is strict (unknown keys → 400) so the hash covers exactly what ran |
| Engine | `apps/engine/src/processing/derive-plan.ts` (pure FFmpeg plans), `derive.ts` (`DeriveService`), route in `routes/processing.ts` | Refusals at submit are HTTP 422 with the code; the job re-checks them, probes stream start times (zod-validated ffprobe), runs the passes, publishes atomically and registers the file with `registerDerived` |
| MCP | `apps/mcp/src/tools/derive.ts` (`derive_media`, `DERIVE_GUIDE`) | Pre-checks with `deriveProblems`, waits (default) and commits one `media.derive` ("Derive Media"); `wait: false` returns the job; a second call reuses the file |
| Web | `apps/web/src/derive/` (`model.ts`, `DeriveMediaDialog.tsx`, `register.ts`), registered from `commands/process.ts` | Project panel item ▸ **Derive Media ▸** Conform to Constant Frame Rate… / Reverse… / Denoise Audio… / Extract Audio… / Time Stretch… / Subclip Range… (only the ops the media kind supports). One dialog per op: fields, live validation with the engine's codes, progress and Stop while the job runs, engine refusals and job failures shown as `CODE — explanation (engine message)`. Closing the dialog keeps the job; its result is still added |

Refusal codes: `UNSUPPORTED_MEDIA`, `NO_VIDEO`, `NO_AUDIO`, `UNSUPPORTED_RATE`, `OUT_OF_RANGE`, `EMPTY_RANGE`,
`MEDIA_OFFLINE`, `ENCODER_UNAVAILABLE`; job failures `DERIVE_FAILED` (retryable), `DISK_FULL`, `JOB_CANCELLED`.

## Outputs, reuse and atomicity

- Video results: QuickTime, ProRes 422 HQ (`prores_ks` profile 3; 4444 profile 4 with alpha) + 24-bit PCM for every
  audio stream — the processing outputs' format (S07). The picture is decoded with the matrix every export path
  assumes for the original (`inColor`) and written BT.709 limited range with the original's primaries/transfer tags
  (the same rule as the ProRes transcode in `gaps/media-jobs.ts`). Rotation is applied (FFmpeg autorotate), so the
  file is upright with no display matrix.
- Audio results: 24-bit PCM WAV (`-rf64 auto`: RF64 past 4 GB) or FLAC (extract-audio `format: 'flac'`; FFmpeg keeps
  16-bit sources 16-bit and writes higher depths as 24-bit). An audio media keeps its first audio stream.
- Content-addressed: `<appdir>/media/processed/<fingerprint[0:32]>/<recipeHash[0:24]>/<stem>.<op><ext>` with a sidecar
  `<file>.json` `{recipeHash, recipeVersion, recipe, from, output.bytes, notes}`. `recipeHash` = sha256 of the
  canonical (sorted-key) JSON `{fromFingerprint, recipe, recipeVersion}` (S01:AST-020); `DERIVE_RECIPE_VERSION` = 1.
  A file with a matching sidecar and size is reused (`reused: true`); a registration failure deletes the sidecar.
- Atomic: FFmpeg writes `.partial-<jobId><ext>` in the output directory (reverse segments in the job's scratch
  directory); the partial is fsynced, renamed into place and the directory fsynced, then the sidecar is written with
  `atomicWriteJson`. Cancel/failure delete the partial (`addPartial`) and the scratch directory.
- Every input is opened with `LOCAL_PROTOCOLS` (`-protocol_whitelist file,crypto,data`, imported from
  `sounds/decode.ts` until the shared helper lands), including the concat-demuxer join. Every filter text passes
  `assertLgplFilters`; filters used: `fps`, `setpts`, `trim`, `reverse`, `scale`, `format`, `aresample`, `asetpts`,
  `atrim`, `areverse`, `apad`, `atempo`, `asetrate`, `afftdn` — all LGPL. Encoders: `prores_ks`, `pcm_s24le`, `flac`.

## Ops

| Op | FFmpeg | Notes |
|---|---|---|
| conform-cfr | `fps=fps=N/D` (+ `-r N/D -fps_mode cfr`), audio `aresample=async=1` | 1…240 fps. Frames are placed on the new grid by timestamp (repeated or dropped), so sync is kept; `async=1` fills audio timestamp gaps. The video ends at the last source frame (a VFR file whose last frame has no duration can end ≤ 1–2 frames before its audio; measured: 98 frames at 25 fps for a 4.0 s VFR source whose last frame starts at 3.9 s) |
| reverse | per segment: `-copyts -ss <t−2 s>`; video `fps=fps=R:start_time=<vs>,trim=…,reverse,setpts=PTS-STARTPTS`; audio `atrim=…,areverse,asetpts=PTS-STARTPTS`; segments joined last-first with the concat demuxer (`-c copy`) | **Memory:** `reverse`/`areverse` buffer a whole segment. A video segment holds ≤ `REVERSE_VIDEO_BUDGET_BYTES` = 512 MB of decoded frames, estimated at 4 B/pixel (≤ 8-bit) or 8 B/pixel (deeper) — 64 frames of 1080p 8-bit, 8 frames of 4K 10-bit — and at most `REVERSE_MAX_SEGMENT_SEC` = 10 s. Audio-only: ≤ 64 MB of samples at 8 B/sample, at most 60 s (≈ 87 s of 48 kHz stereo → 60 s). Boundaries sit half a frame before a frame start on the `fps` grid anchored at the stream start (no float rounding at the edge; variable-rate sources come out constant-rate at their average rate). Each pass seeks 2 s before its segment so `trim` sees the boundary frame |
| denoise-audio | `afftdn=nr=<6+30·s>:nf=<−50+20·s>:tn=0` on the first audio stream | Strength s 0…1: noise reduction 6…36 dB (FFmpeg's default 12 dB ≈ s 0.2), noise floor −50…−30 dB. The floor is fixed (`tn=0`) — measured on white hiss + a 440 Hz tone: `tn=1` left −45 dBFS hiss nearly untouched (0.00578 → 0.00468 RMS at nr 21 / nf −40) while `tn=0` removed it (→ 0.00052) with the tone's level within 0.1 %; at −25 dBFS hiss `tn=1` did nothing measurable. Result: 24-bit WAV |
| extract-audio | `-map 0:<streamIndex> -vn` → `pcm_s24le` WAV or FLAC | The stream index must be an audio stream of the probe (`NO_AUDIO` names the audio streams) |
| time-stretch | video `setpts=(PTS-STARTPTS)/r,fps=fps=<source rate>`; audio with pitch `apad=pad_dur=0.25,atempo…,atrim=end=D/r`; without `asetrate=round(sr·r),aresample=sr` | `rate` 0.25…4 (2 = twice as fast). `atempo` instances are chained with every factor in 0.5…2 (`atempoFactors`: 0.25 → 0.5·0.5, 3 → 2·1.5): one instance outside that range skips or repeats samples rather than overlapping them. Each `atempo` drops ≈ 23 ms at end of stream when flushing (measured: 0.5 → 7.977 s instead of 8 s), so the input is padded with 0.25 s of silence and the output cut to exactly D/r. The picture is put back on the source's frame grid (frames repeated or dropped). Stream start offsets are kept, scaled by 1/r: every stream is measured from the earliest stream start, a later audio start becomes leading silence (`adelay`) and a later video start a later first timestamp, before the retime (measured: audio starting 0.2 s after the picture comes out 0.100 s after at 2×; ±0.002 s resampled, ≈ 0.011 s with `atempo`, whose overlap-add window blurs the onset) |
| range | `-copyts -ss <t0−2 s>`; video `trim=start=vs+(S−½)/R:end=vs+(E−½)/R,setpts=PTS-STARTPTS`; audio `atrim=start=vs+S/R:end=vs+E/R` | `[inFlicks, outFlicks)` → the frames whose start lies in it (`rangeFrames`, `ceil(in·R)` … `ceil(out·R)`, exact BigInt). Constant-rate video records `range {startFrame, endFrame}` → `sourceRange`; variable-rate video trims by timestamp, comes out constant-rate at its average rate and records none; audio is sample-exact |

Trimmed and reversed pictures end with `fps=fps=<rate>` after `setpts`, which gives every frame its duration: without
it the last frame has duration 0 and FFmpeg 7.1's mov muxer leaves it outside the edit list, so decoders drop it
(measured with the vendored LGPL 7.1: 99 of 100 frames after `reverse`, 49 of 50 after `trim`; FFmpeg 6.1 kept them).

## Editor and command rules

- Derived media are not imports: "Transcribe on import" (`speech/auto.tsx` `autoTargets`) skips media with a
  `derivation` (Derive Media results, processed and loudness versions).
- A derive job that finishes after its project was closed or switched is not committed to the closed session: the
  dialog (or, once it is gone, a toast) shows `PROJECT_CLOSED` telling the user to open the project and run Derive
  Media again — the finished file is reused by recipe hash, so it is instant.
- `replaceInClips` of an audio version (denoise-audio, and loudness-normalize — the same helper,
  `useNormalizedAudio`) is refused (`E_INVALID_PARAM`, naming each clip and its stream) when a clip plays another
  audio stream than the processed one (the source's first): before, a clip on stream 2 of a two-stream camera file
  silently switched to the processed stream 1. The loudness path had this bug on main before spec 18.

## Validation (measured)

- `packages/project/test/derive-ops.test.ts` (13): recipe checks, `rangeFrames` at 30 and 29.97 fps (10 h exact),
  `media.derive` for every op (kinds, item names, dedupe, invariants), range `sourceRange` + clip swap keeping
  source frames, refusals.
- `apps/engine/test/derive-ops.test.ts` (17, `JASPER_FFMPEG_LGPL_ONLY=1`, lavfi media): plans are LGPL and
  local-only; forced 15-frame segments reverse 100 frames and 192 000 samples exactly (frame lumas mirrored, max sample
  error < 1e-4); conform-cfr of a VFR file → `r_frame_rate = avg_frame_rate = 25/1`, every packet 40 ms, audio 4.0 s;
  reverse: output frame 0 = input's last frame, both audio streams carried, second run reused; denoise −15 dB on hiss
  with the tone kept; extract-audio FLAC 44.1 kHz mono / WAV 24-bit stereo; time-stretch 2× with pitch → 50 frames,
  2.000 s, 1 kHz stays 1 kHz; 0.5× without pitch → 6 s, 440 → 220 Hz; 0.25× with pitch → 12 s at 440 Hz; range →
  `{25, 50}`, frames identical to source frames 25…49, audio 48 000 samples; audio range sample-exact; refusals
  (`NO_AUDIO`, `UNSUPPORTED_RATE`, `OUT_OF_RANGE`, `EMPTY_RANGE`, `UNSUPPORTED_MEDIA`, `MEDIA_OFFLINE`, 400 for unknown
  keys / ops); a cancelled reverse leaves no partial and no scratch directory.
- Running app (dev stack, vendored LGPL FFmpeg 7.1, headless Chromium): Project panel ▸ take.mov context menu shows
  the Derive Media group with the six ops; Subclip Range with Out before In shows `EMPTY_RANGE — …` and keeps Derive
  disabled; Subclip Range 3–4.5 s and Time Stretch 2× each added a media in a new "Processed" bin with a success
  toast; the document then held `take [Range 3.000–4.500 s].mov` (sourceRange firstFrame 75, 38 frames, item
  "take.mov [Range · frames 75–112]") and `take [Time-stretched 2×].mov`.
- `apps/mcp/test/derive.test.ts`: `derive_media` reverse (+ reuse: same media id; undo needs an editor session and is covered by the web test), extract-audio, range frames, refusals.
- `apps/web/test/derive-media.test.tsx`: menu entries per kind, form defaults, NO_AUDIO / EMPTY_RANGE shown and
  Derive disabled, engine 422 code shown in the dialog, job → one "Derive Media" undo step, failed job code shown.

## Limits

- Audio timestamps of Matroska sources are milliseconds: reverse segment joints of an MKV can be off by < 1 ms of
  audio (a few samples doubled or dropped per joint, every ≤ 10 s). MP4/MOV/WAV timestamps are sample-exact (tested).
- Reverse mirrors each stream in full: when a source's audio runs past its last video frame by δ, the reversed audio
  leads the reversed picture by δ (typically under one frame).
- `denoise-audio` and `extract-audio` of an audio media with several streams use the first / chosen stream; a WAV
  holds one stream.
- `time-stretch` changes the picture's timing by dropping or repeating frames (no frame blending / optical flow).
- Clips cannot switch to reverse / time-stretch / conform-cfr results (`replaceInClips` refused): place them as new
  media. The spec 01 AST-021 "placeholder before the file exists" flow is not used: the asset is added when the job
  has produced the file (the same as `process` and loudness versions).
