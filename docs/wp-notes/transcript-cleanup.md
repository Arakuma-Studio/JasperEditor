# Transcript cleanup (spec 14): voice analysis, detector, tight auto-cut

Work note of [spec 14](../specs/14-transcript-cleanup.md). This note grows with the implementation; each section
records what is shipped, how it was checked and what is left.

## Voice analysis (TC-001, TC-002, TC-060 analysis half)

The engine measures every 10 ms of one audio stream of a media file and keeps the result as a media derivative. The
cleanup detector (TC-010 …), word-bound refinement (TC-004) and the hallucination guard (TC-003) read it; agents read
it through `get_voice_analysis`.

### Where the code lives

| Layer | File | What |
|---|---|---|
| DSP (pure) | `packages/audio-dsp/src/voice.ts` | `VoiceFeatureExtractor` (level, voicing, flatness of frames), byte quantisation, `classifyVoiceFrames`, `voiceLevels`, and the floor / speech-level rule shared with the speech VAD: `levelStats` + `speechThresholdDb` |
| Contract (pure) | `packages/project/src/cleanup/voice-analysis.ts` | `VoiceAnalysis` type, `buildVoiceAnalysis`, binary file `encodeVoiceAnalysis` / `decodeVoiceAnalysis`, `summarizeVoiceAnalysis`, `voiceRuns`, `voiceAnalysisPage`, frame ↔ time helpers |
| API | `packages/api/src/voice.ts`, `routes.ts` (`voiceAnalyze`, `voiceAnalysisGet`), `jobs.ts` (`voice-analysis`) | request / job-result schemas; re-exports the decoder for clients |
| Engine | `apps/engine/src/voice/{service,pool,worker}.ts`, `routes/voice.ts` | the job, worker threads, cache, routes |
| Client | `packages/engine-client` `analyzeVoice`, `getVoiceAnalysis` | job request; file fetched and validated |
| MCP | `apps/mcp/src/tools/voice.ts` | `get_voice_analysis`, `VOICE_GUIDE` (server instructions) |

`packages/project` holds the contract so the pure detector (`packages/project/src/cleanup/`), the engine and the
clients share one type and one parser (ARCHITECTURE §3.1: project → audio-dsp only; api re-exports for
engine-client).

### Signals (definitions)

Source: the research prototype that reproduced the user's cuts (private `.prproj-analysis/research/edits/mac/feats.py`
and `common.py frame_classes`; FINDINGS §6.1); the spec's TC-001 wording. Audio is decoded to 16 kHz mono.

- **Frame** k = decoded samples [160k, 160k + 160) — media time k × 10 ms from the stream's first decoded sample (the
  timeline the speech worker's transcripts use: both decode from the start without a seek). The last frame may be
  partial; frame count = ⌈samples / 160⌉.
- **Level**: RMS in dBFS over 25 ms (400 samples) centred on the frame: samples [160k − 120, 160k + 280), zero outside
  the file; `10·log10(mean(x²) + 1e-12)`. *Deviation from the prototype*, labelled: the prototype's window started at
  the frame (its frames sit 7.5 ms later); centred windows make frame k describe its own 10 ms.
- **Voicing**: mean-removed window, biased autocorrelation r(l) (linear, via a 1024-point FFT), `max r(l) / (r(0) +
  1e-9)` over lags 40…227 (400 Hz … 70 Hz). For a periodic signal r(l) ≈ (400 − l)/400 · r(0), so a 140 Hz voice
  reads ≈ 0.7 — the prototype's thresholds were set on this measure.
- **Flatness**: Hann (symmetric) window, 512-point power spectrum (the even bins of the 1024-point transform of the
  same zero-padded window — identical values), bins 9…191 (300 Hz – 6 kHz): geometric / arithmetic mean of
  `|X|² + 1e-12`.
- Bytes: level q = round((dB + 120) / 0.5) clamped 0…255 (−120 … +7.5 dBFS); voicing and flatness q = round(x · 255).
  Non-finite decoder samples count as 0.

**Levels** (shared with the speech VAD, TC-002): frames above −100 dBFS; noise floor = 10th, speech level = 95th
percentile (lower nearest rank: `s[⌊(n − 1)·p⌋]`); speech threshold = max(floor + 0.3·(speech − floor), floor + 6).
Computed on the quantised levels for the file and for each 60 s window (6000 frames; the last may be shorter); null
when every frame is digital silence.

**Classes** (computed on the quantised planes, so anyone can recompute them from the file):

1. speech: level > threshold and voicing ≥ 0.45, or level ≥ threshold + 10 dB; gaps < 60 ms (6 frames) inside speech
   closed, then speech runs < 40 ms (4 frames) dropped (prototype post-processing);
2. breath-like: not speech, level > floor + 5 dB, voicing < 0.5, flatness > 0.15; gaps < 30 ms closed; only runs of
   120–900 ms (12–90 frames) stay breath-like;
3. silence: the rest (everything when the stream is digital silence).

Classes use the **file** levels (as calibrated by the prototype); the per-window levels are in the result for
consumers that need a local floor (edge placement in drifting rooms, TC-021). *Assumption*, labelled: the prototype
used only file levels; using window levels for the classes is not calibrated.

`VOICE_ANALYSIS_VERSION` (1) must be bumped whenever any of this changes: cached files of another version are
recomputed.

### TC-002: one floor / threshold rule

`apps/engine/src/speech/core/vad.ts` `vadThreshold` now calls `levelStats` + `speechThresholdDb` from
`@jasper/audio-dsp`; its body was the same computation. `apps/engine/test/voice-vad-shared.test.ts` compares it with
the previous implementation (kept verbatim in the test) on 2000 random level arrays (plain arrays and Float32Array,
digital silence, the −100 boundary): bit-identical (`Object.is`). The speech worker's 10 ms non-overlapping `frameDb`
is a different measurement (word-bound repair) and stays.

### The job (`voice-analysis`)

`POST /api/media/:key/voice-analysis[?wait=1]` `{streamIndex?, projectId?}` → job (dedupe per fingerprint + stream).

1. A valid cached file → the job finishes at once (`cached: true`, nothing decoded).
2. FFmpeg (the engine's resolved, LGPL-checked binary) decodes the stream from its first sample:
   `-map 0:<stream> -af aresample=16000:<soxr | swr long filter> -ac 1 -f f32le` (the resampler options of the audio
   mixer, `resamplerArgs`), read with the mixer's `PcmStreamReader` (decoder failures → `TOOL_FAILED` with stderr).
3. Samples are handed out in 10 s blocks (plus the window's 120 / 280 samples of context) to up to 2 worker threads
   (`voice-worker.mjs`, bundled by `apps/engine/scripts/build.mjs`, shipped by `apps/desktop/scripts/package.mjs`;
   `JASPER_VOICE_WORKER` overrides, `off` = in-thread). At most 2 blocks per thread are in flight (bounded memory:
   ≈ 4 × 640 KB of samples plus the output planes). A block's frames depend only on its samples, so any split gives
   the same bytes (property-tested).
4. `buildVoiceAnalysis` classifies; the file is written atomically (`atomicWriteFile`: same-directory temp, fsync,
   rename, directory fsync). The job result (`VoiceAnalysisJobResult`) carries totals and the file's URL; the frames
   stay in the file.

Errors: unknown media 404 `ASSET_NOT_FOUND`; no audio 422 `UNSUPPORTED_MEDIA`; a stream that is not audio 400; media
offline → `ASSET_NOT_FOUND` (retryable); a stream longer than 24 h → `VOICE_ANALYSIS_TOO_LONG`; a worker that throws,
exits or crashes after starting → `VOICE_ANALYSIS_FAILED` (retryable; every worker is ended, no file); a worker that
cannot start (missing bundle, vitest) → in-thread analysis between `setImmediate` yields, logged in the job log.
Cancel aborts the decoder (process tree tracked by the job), ends the workers and writes nothing. Progress = decoded /
expected samples, with the speed in × real time.

### The cache file

`<cache>/<fingerprint hex>/voice-analysis-<hash12>.bin`, hash = sha256 of `{kind, version, stream, rate}`. It is a
`media-cache` entry of the cache registry (`apps/engine/src/cache/layout.ts`), so cache GC, Clean Unused and the cache
move treat it like the waveform peaks. Format (little-endian, `VOICE_ANALYSIS_FORMAT` 1):

| Offset | Bytes | Content |
|---|---|---|
| 0 | 4 | magic `JVA1` |
| 4 | 4 | u32 header length H (2 … 262 144) |
| 8 | H | ASCII JSON header (`VoiceAnalysisHeaderSchema`, strict): format, analysisVersion, fingerprint, stream, sampleRate 16000, frameStep 160, window 400, levelMinDb −120, levelStepDb 0.5, samples, frameCount, levels {floorDb, speechDb, speechThresholdDb, breathFloorDb}, counts {silence, breath, speech}, windowFrames 6000, windows [{startFrame, frameCount, floorDb, speechDb, speechThresholdDb}] |
| 8 + H | N | level plane (N = frameCount) |
| … | N | voicing plane |
| … | N | flatness plane |
| … | N | class plane (0 silence, 1 breath-like, 2 speech) |
| end − 4 | 4 | CRC-32 (IEEE) of all preceding bytes |

Size: 4 bytes per frame — 1,446,302 bytes for one hour (measured, below). `decodeVoiceAnalysis` never throws and
refuses anything inconsistent: size caps (24 h of frames, header ≤ 256 KiB, file ≤ the largest valid file), magic,
ASCII-only header, schema (finite dB in −200…50, literal constants, no unknown keys), exact file size, CRC, class bytes
≤ 2, counts equal to the class plane, frame count = ⌈samples / 160⌉, windows exactly tiling the frames, and — when
the engine reads its cache — the fingerprint, stream and version it expects. A file that fails is a cache miss: GET
answers 404 and the next job overwrites it. The engine validates before serving `GET`, and the client validates again.

### Routes and client

- `GET /api/media/:key/voice-analysis?streamIndex=N` → the file (`application/octet-stream`, `no-store`); 404
  `VOICE_ANALYSIS_NOT_FOUND` when none.
- `EngineClient.analyzeVoice(key, {streamIndex?, projectId?}, wait?)`, `EngineClient.getVoiceAnalysis(key, stream?)`
  → a decoded `VoiceAnalysis` (EngineError `VOICE_ANALYSIS_NOT_FOUND` / `INVALID_RESPONSE`).

### MCP: `get_voice_analysis`

`{projectId, mediaId, stream?, summary?, fromSeconds?, seconds?, stepMs?, analyze?}` (read-only; strict). Reads the
cached analysis or runs the job (progress notifications; cancelling the request cancels the job; 15 min wait, then a
`jobId` to follow). Returns the totals (`summarizeVoiceAnalysis`: duration, levels, seconds / runs / longest run per
class, 60 s windows). `summary: false` adds a page (default 60 s, ≤ 600 s, ≤ 6000 points): loudest level, mean
voicing / flatness and majority class per point, class runs in seconds, `nextFromSeconds`. `analyze: false` only reads
(E_NOT_FOUND otherwise). Guide: `VOICE_GUIDE` in the server instructions.

### For the detector (contract notes)

- Read `classes` for speech / breath / silence; `level` (dB = −120 + q/2) and the file / window
  `floorDb` / `speechDb` for level-referenced edges (TC-021: out = first frame after kept speech below floor + 20 dB;
  in = first frame at the onset reaching floor + 25 dB).
- Times: frame k starts at k / 100 s of media time (`voiceFrameSeconds`, `voiceFrameAt`); transcripts are in flicks of
  the same media timeline.
- The type and the file are stable for version 1; a change of features or classes bumps `VOICE_ANALYSIS_VERSION`, a
  change of layout bumps `VOICE_ANALYSIS_FORMAT`.

### Validation (rerunnable)

| Check | Where | Result |
|---|---|---|
| Features vs the prototype formulas computed directly (no FFT), ±1 quantisation step | `packages/audio-dsp/test/voice.test.ts` | pass |
| Any block split = one pass (fast-check) | same | pass |
| Synthetic classes: voiced tones at 140/220 Hz and a quiet voiced tone → speech; loud unvoiced noise → speech; 400 ms noise burst → breath-like; 60 ms and 1.5 s bursts → silence; floor → silence; 50 ms dip closed; 5 ms click dropped; digital silence → silence, null levels | same | pass |
| Build / encode / decode round trip; reader fuzz (random bytes, random bytes behind a valid magic, every single-byte change, truncations, extensions, schema-invalid headers with valid CRC); CRC = zlib | `packages/project/test/voice-analysis.test.ts` | pass |
| VAD threshold bit-identical to the speech worker's previous code (2000 cases) | `apps/engine/test/voice-vad-shared.test.ts` | pass |
| Job = pure analysis of the same samples, byte for byte (in-thread, bundled worker threads over 65 s / 7 blocks, missing-worker fallback); cache hit; damaged cache file replaced; stream choice in a 2-stream 48 kHz Matroska file (silent stream → null levels); request validation; cancel (no file, next job fine); decoder failure `TOOL_FAILED`; offline `ASSET_NOT_FOUND`; crashing worker `VOICE_ANALYSIS_FAILED` retryable, engine still serving; cache entry kind `media-cache` | `apps/engine/test/voice-analysis.test.ts` | pass |
| Real speech (LJ Speech, public domain, `fixtures/speech/lj-composite.flac`): > 70 % of utterance-core frames speech, < 2 % speech between utterances | same | pass |
| Client fetch / validation / errors | `packages/engine-client/test/voice.test.ts` | pass |
| MCP tool: cached read, on-demand job, pages, refusals, failed job, annotations, guide | `apps/mcp/test/voice.test.ts` | pass |

### Performance (TC-060, analysis half) — measured

`pnpm exec tsx apps/engine/bench/voice-analysis.ts 60 1,2,4` on the build VM (AMD EPYC-Rome, 16 vCPU, Node 24.22.1,
vendored LGPL FFmpeg), under the shared bench lock, load average 3.1–4.5 (other agents' idle stacks). Input: a
synthetic 60 min speech-like recording, AAC-LC 160 kb/s 48 kHz stereo (75.4 MB), empty cache, the full job (queue,
decode, worker threads, classification, atomic write):

| Worker threads | Wall time | × real time |
|---|---|---|
| FFmpeg decode + resample alone | 3.35 s | — |
| 1 | 18.6 s | 193× |
| 2 (shipped: the job asks for 2 CPU slots) | 9.4 s | 382× |
| 4 | 5.8 s | 615× |

Target ≤ 2 min per hour: met with margin. File: 360,000 frames, 1,446,302 bytes.

### Limitations

- The stream is downmixed to mono before analysis: speech on one channel of a stereo pair is measured 6 dB lower (the
  thresholds are relative, so the classes hold unless the other channel carries loud unrelated sound).
- Classes use file-level thresholds; per-window levels are reported but not used for classes (see above).
- The thresholds come from one user's microphone and room (prototype calibration); the calibration report on their
  material (TC-071) belongs to the detector work.
- No UI yet: the Clean Up panel (TC-040 …) is the cleanup agent's work; the analysis runs from the MCP tool, the
  client and the route.
