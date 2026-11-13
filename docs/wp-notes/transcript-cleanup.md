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

1. speech: level > threshold and voicing ≥ 0.45, or level ≥ threshold + 10 dB, or **quiet speech** (version 2, below);
   gaps < 60 ms (6 frames) inside speech closed, then speech runs < 40 ms (4 frames) dropped (prototype
   post-processing);
2. breath-like: not speech, level > floor + 5 dB, voicing < 0.5, flatness > 0.15; gaps < 30 ms closed; only runs of
   120–900 ms (12–90 frames) stay breath-like;
3. silence: the rest (everything when the stream is digital silence).

Classes use the **file** levels (as calibrated by the prototype); the per-window levels are in the result for
consumers that need a local floor (edge placement in drifting rooms, TC-021). *Assumption*, labelled: the prototype
used only file levels; using window levels for the classes is not calibrated.

**Quiet speech** (version 2, `quietSpeechFrames` in `voice.ts`). Reported on `cut_v5.wav`, a loudness-normalised
mixdown of the user's dense cut (large-v3-turbo run at main 1da79efd8, `/tmp/je-words-local/results.json` on the
build host): its stored analysis had floor −30.5 dBFS, speech level −10.5, threshold −24.5, and the 21 words the
speech guard still dropped as `silence` ("sistema de", "con física", "que mis", "su", "un", "Así"…) lay over voice at
−17 … −25 dBFS with 0–7 % speech frames; 22 of the 37 deletions Fix Transcript's gap rule left failed only on its
50 % speech share. Cause: with the pauses cut and the dynamics compressed, a tenth of the frames is quiet speech, so
the 10th-percentile floor lies inside the speech and the level threshold above the quieter words (on the raw source
the same analysis works). A frame under the threshold is now speech when it is all of:
- above max(speech level − 28 dB, local floor + 6 dB). The local floor is the 2nd percentile of the frames above
  digital silence over 6 s centred on the frame (per 50 frames, sliding byte histogram): the quietest 120 ms of 6 s
  reach the gaps between words and the stop closures even in dense speech (minimum statistics, R. Martin, "Noise
  power spectral density estimation based on optimal smoothing and minimum statistics", IEEE TSAP 9(5), 2001). 28 dB:
  de Jong & Wempe ("Praat script to detect syllable nuclei and measure speech rate automatically", Behavior Research
  Methods 41(2), 2009) count nuclei down to 25 dB under the 99th-percentile intensity, and our speech level is the
  95th (≈ 3 dB lower); 6 dB is the threshold's own minimum margin;
- voiced (≥ 0.45, the speech rule's voicing): noise beds, rumble and breaths are not;
- inside a syllable: between the dips around a voiced peak of the level (clamped at the local floor) that stands
  6 dB over the dip on one side and 3 dB over the dip on the other within 250 ms (the cleanup detector's syllable dip;
  de Jong & Wempe ask 2 dB; the asymmetry keeps a quiet syllable next to a louder one or a loud consonant), with
  another such peak within 600 ms (syllabic rhythm). A steady hum or tone has no such peak, a ±2 dB flutter is too
  shallow, a lone voiced blip has no rhythm.
Spectral flatness is not used beyond the voicing test, and no plane is added: the classes stay computable from the
stored planes and the file format is unchanged. Where max(speech − 28, local floor + 6) is at or above the threshold
— every recording with pauses and a speech level ≥ ≈ 40 dB over its floor — nothing changes. The header's levels
(floor, speech level, threshold) keep their definitions (TC-002 is unchanged; the speech worker's energy VAD still
uses the level rule alone). *Assumptions*, labelled: 28 / 6 / 6 / 3 dB, 6 s, 2 %, 250 / 600 ms come from the cited
methods and synthetic signals, not from the reporter's file.

`VOICE_ANALYSIS_VERSION` (2) must be bumped whenever any of this changes: cached files of another version are
recomputed (the cache file name hashes the version; the engine and the speech worker refuse other versions).

### TC-002: one floor / threshold rule

`apps/engine/src/speech/core/vad.ts` `vadThreshold` calls `levelStats` + `speechThresholdDb` from
`@jasper/audio-dsp`. Independent floor/threshold vectors in `apps/engine/test/speech-core.test.ts` and
`packages/audio-dsp/test/voice.test.ts` protect the 30 % rule, the 6 dB minimum and digital-silence behavior.
The speech worker's 10 ms non-overlapping `frameDb` is a different measurement (word-bound repair) and stays.

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
- The type and the file layout are stable (format 1; analysis version 2 since quiet speech); a change of features or
  classes bumps `VOICE_ANALYSIS_VERSION`, a change of layout bumps `VOICE_ANALYSIS_FORMAT`.

### Validation (rerunnable)

| Check | Where | Result |
|---|---|---|
| Features vs the prototype formulas computed directly (no FFT), ±1 quantisation step | `packages/audio-dsp/test/voice.test.ts` | pass |
| Any block split = one pass (fast-check) | same | pass |
| Synthetic classes: voiced tones at 140/220 Hz and a quiet voiced tone → speech; loud unvoiced noise → speech; 400 ms noise burst → breath-like; 60 ms and 1.5 s bursts → silence; floor → silence; 50 ms dip closed; 5 ms click dropped; digital silence → silence, null levels | same | pass |
| Build / encode / decode round trip; reader fuzz (random bytes, random bytes behind a valid magic, every single-byte change, truncations, extensions, schema-invalid headers with valid CRC); CRC = zlib | `packages/project/test/voice-analysis.test.ts` | pass |
| VAD threshold follows independently specified floor / speech vectors | `apps/engine/test/speech-core.test.ts`, `packages/audio-dsp/test/voice.test.ts` | pass |
| Job = pure analysis of the same samples, byte for byte (in-thread, bundled worker threads over 65 s / 7 blocks, missing-worker fallback); cache hit; damaged cache file replaced; stream choice in a 2-stream 48 kHz Matroska file (silent stream → null levels); request validation; cancel (no file, next job fine); decoder failure `TOOL_FAILED`; offline `ASSET_NOT_FOUND`; crashing worker `VOICE_ANALYSIS_FAILED` retryable, engine still serving; cache entry kind `media-cache` | `apps/engine/test/voice-analysis.test.ts` | pass |
| Real speech (LJ Speech, public domain, `fixtures/speech/lj-composite.flac`): > 70 % of utterance-core frames speech, < 2 % speech between utterances | same | pass |
| Dense, loudness-normalised speech (synthetic: syllables back to back, file floor −30.5 dBFS inside the speech, quiet words peaking at −17 … −25): > 98 % of the quiet syllables' voiced frames speech, every quiet word ≥ 50 % speech; a steady hum and a noise bed at −27 dBFS (under the threshold): no speech frame. Fails on version 1 (53 % of those frames) | `packages/audio-dsp/test/voice.test.ts` | pass |
| The speech guard over that kind of mixdown's voice analysis (file written, read back through `voiceAnalysisMask`): six trailing quiet words per phrase at the reported levels all stay. Fails on version 1 (8 words removed as `silence`) | `apps/engine/test/speech-dense-speech.test.ts` | pass |
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
- Classes use file-level thresholds; per-window levels are reported but not used for classes (see above); quiet
  speech uses a local floor.
- Quiet speech needs voicing and syllables: whispered or unvoiced quiet words stay non-speech; voiced, rhythmic
  non-speech at a level within 28 dB of the speech — a melodic music bed, a background talker — becomes speech
  where it is ≥ 6 dB over the local floor (the level rule already called such sound speech above the threshold).
  The 21 reported words have not been re-measured on `cut_v5.wav` with version 2 (no audio on this host).
- Measured on the LJ fixture (system FFmpeg for the variants, one-off script): raw, and compressed + loudness-normalised
  with its pauses kept, version 2 changes no frame; with its pauses cut (silenceremove 60 ms) and compressed +
  normalised (floor −27.5, threshold −21.5 dBFS — the reported shape) it adds 279 of 5525 frames (5 %) as speech and
  removes none; with every other utterance 14 dB down, pauses cut, the speech share rises from 69.6 to 76.3 %.
- The thresholds come from one user's microphone and room (prototype calibration); the calibration on their material
  is in "Calibration on the user's material (TC-071)" below.
- The Clean Up UI and the cleanup MCP tools are described in "Clean Up UI and MCP" below.

## Detector, planner and commands (TC-010 … TC-033, TC-060 pure half)

Branch `feat/wf-cleanup`. The detector flags "probably wrong" speech with typed, explained findings; the planner turns
the accepted ones into kept pieces whose edit points come from the audio level; `cleanup.apply` cuts any number of
ranges as one undoable edit. Everything up to the command is pure (`packages/project/src/cleanup/`), so the editor,
the engine and agents run the same code.

### Where the code lives

| Layer | File | What |
|---|---|---|
| Lists | `cleanup/lists.ts` | per-language vocalic fillers, lexical markers, emphasis allow-list, stop words, single vowels, hallucination phrases (Spanish, English, a language-neutral union for `und`); `cleanupNorm` |
| Settings | `cleanup/schema.ts` | `CleanupSettings` (rules, thresholds, edges, gaps, guards, joins), Fast / Natural, presets, `Sequence.cleanup` schema + `repairSequenceCleanup`, finding types |
| Rules | `cleanup/rules.ts` | restart, takes (retake / false start), vocalic fillers + drawn vowels, off-script, marker phrases, stutter, lexical review, ASR suspects |
| Script | `cleanup/script.ts` | script lines, tokens, line matching (LCS) |
| Detector | `cleanup/detector.ts` | `detectCleanup`: hallucination guard, rule order, take groups + script choice, frame findings (pause, breath, untranscribed voice), fingerprints |
| Edges | `cleanup/edges.ts` | level-referenced in / out points, frame-boundary snapping |
| Planner | `cleanup/plan.ts` | `planMediaCuts` (one media, seconds), strict removal, harsh-cut test |
| Sequence | `cleanup/sequence.ts` | `analyzeSequenceCleanup` (speech clips, one detection per media, decisions, frames, guards, removed ranges, stats) |
| Fillers | `cleanup/fillers.ts` | the language-aware default of `transcript.removeFillers` (command and MCP dry run) |
| Result schema | `cleanup/analysis-schema.ts` | zod schema of the analysis (engine file, clients) |
| Commands | `commands/{schemas,handlers}/cleanup.ts`, `commands/multi-range.ts` | `cleanup.apply`, `cleanup.configure`, the one-pass cutter; level mode of `transcript.removePauses` |
| Rendering | `audio-fade.ts`, `transitions.ts`, `render/snapshot.ts`, `compositions/src/audio/graph.ts` | `AudioClip.edgeFades` → sub-frame equal-power fades in every path |
| Engine | `apps/engine/src/cleanup/{service,presets}.ts`, `routes/cleanup.ts` | the `cleanup-analysis` job, the user preset library |
| API / client | `packages/api/src/cleanup.ts`, `routes.ts`; `EngineClient.analyzeCleanup` / `getCleanupAnalysis` | contracts |

### Port of the research prototype

The rules that reproduced the user's cuts are the private prototype `.prproj-analysis/research/edits/mac/autocut.py`
(`detect`, `cut`) and `common.py` (`norm`, `clean_words`, `frame_classes`); FINDINGS §6. The TypeScript is a faithful
port: same rule order (fillers → restarts → takes → off-script → marker phrases), same comparisons, the same float
arithmetic on seconds (k × 0.01 doubles, truncation and rounding where the prototype truncates and rounds), so it labels
the same words and keeps the same ranges. **Port check** (`packages/project/test/cleanup-port.test.ts`): 16 synthetic
recordings (1,644 words: retakes, restarts, false starts, fillers, marker phrases, off-script chatter, hallucinations;
Whisper-like timestamp offsets; quantised levels and classes), each run through the prototype itself by a generator kept
with the private research (`.prproj-analysis/box/cleanup-port/gen.py`, synthetic inputs only) and through the port with
the prototype's presets `fast` and `calm` → identical per-word labels, identical guard decisions, kept ranges equal to
1e-9 s (fixture `test/fixtures/cleanup-port.json`, 419 KB). The check switches off the spec's added rules and the
strict removal below, which are deliberate differences; restarts, false starts and retakes compare as one class
("repeat": the repeat mechanism replaced the prototype's rules), and the repeats that differ — 5 of the 16 recordings
(seeds 2, 3, 6, 7, 8) — are listed word by word with the port's class (kept ranges unchecked there).

Deliberate differences from the prototype (labelled):
- **Restarts, false starts and retakes are one mechanism: repeats by alignment** (`repeats.ts`, section "Repeats by
  alignment" below). The prototype's restart rule (a repeated 3-gram / content 2-gram cuts everything back to its earlier
  copy) and take rule (units sharing ≥ 60 % of their content words) cut words said once — lists, comparisons, a 2-gram
  said again in the next sentence (Clean Up report: 29 of 81 restart findings rejected) — and the rounds 3–5 special
  cases piled onto them overfitted the corpus (each held-out round found new failures). An attempt now goes only when
  the speech after it says every one of its content words again, in order and from its start.
- **After removed words the in point never lands inside the first kept word** (level mode): the prototype's in point
  (first frame from 80 ms before the piece that reaches floor + 25 dB, up to 100 ms after it) clipped soft onsets —
  "déjenme" at −48 dBFS reached the threshold 70 ms in, and the cut ended 73 ms into the kept take (reporter's
  large-v3-turbo run; the other cuts there landed −127…+23 ms). When the word before the piece's first kept word is
  removed, the in point is now at most that word's start (no earlier than the search start); after a pause the
  calibrated in point stays. In the port fixture this moves in points of 5 of the 8 `fast` recordings up to 69 ms
  earlier (seen 7–69 ms); the check accepts exactly that — earlier by ≤ 100 ms, at a kept word's start after a
  removed word — and still compares every other edge to 1e-9 s. On the frame grid such an edge — the in point of a
  kept word after removed words, the out point before a removed word — takes the boundary at or before it
  (`MediaPlan.tight` → `keptToFrames`), not the quietest one within 10 ms, which had put the "déjenme" cut end 7 ms
  into its onset (71.967 s) and the start of the fragment F cut 35 ms into the removed "Windows" (second
  large-v3-turbo run).
- **Strict removal**: the prototype joined kept words across gaps ≤ `maxGapS` before looking at removed words, so a
  removed word closer than 120 ms to kept ones stayed (a short filler glued to words, the first copy of an immediate
  restart). The planner cuts the removed word's own speech frames out of the joined range (kept words' frames ± 50 ms
  win where timestamps disagree), and no edge moves into removed sound (the in-point search 80 ms back, the out-point
  walk through loud frames, pads, the gap policy are all bounded by the neighbouring removed spans). Such cuts land in
  loud sound more often; the harsh-cut guard below skips them when no quiet frame is near.
- Spec rules the prototype did not have: drawn-out single vowels > 0.95 s (voiced frames), stutters (1–3 words repeated
  with < 0.3 s gap, or a cut-off word "jue- juego"; allow-list "no no", "sí sí", "ta ta ta"…; a reduplication — one
  content word said again at once, the run ending its phrase or of three or more: "Guiño, guiño.", "boing, boing, boing" —
  is only reviewed, round 6), the conjunctions "y" / "e" / "o" / "u" said into the next word ("e" before an i- word, or
  between content words) are no vocalic fillers (round 6, N: "Godot e incluso"), lexical markers at a
  clause start followed by a comma or ≥ 150 ms (review, confidence 0.3), head / tail (with a script; the tail ends at the last unit on script — a said line or, after it, a unit passing the off-script vocabulary test — see "Calibration"), ASR suspects
  (confidence < 0.4, words < 40 ms or > 2.5 s, segment scores: compression ratio > 2.4, mean log-probability < −1,
  no-speech probability > 0.6 — read from the speech worker's `Transcript.segments` when present, ignored when absent),
  known hallucination phrases over non-speech (share of speech frames < 0.5).
- Spanish vocalic fillers are the prototype's `STRICT_FILLERS` (eh, em, emm, ehm, mm, mmm, hmm, mhm, ah, aah, eeh, ehh,
  uh, um, eee, ee, aa, m, e). The spec's "a / aa" is read as the drawn-out vowel: the bare preposition "a" is never a
  filler (it would cut "voy a casa").
- **Interjections that open an exclamation** (round 8, H8): a marker phrase of one interjection (oh, ay, uy, uf, wow,
  guau) the recogniser wrote with a comma before a word that is no marker or filler is no filler phrase — round 7 U b
  removed the loud "Oh," of "Oh, | shit, a ver." (0.75 s pause after it); the lexical review still lists it. Test:
  `cleanup-rules.test.ts` "an interjection written with a comma before a word opens an exclamation" (fails on
  9031bd0f3).
- Marker phrases: the spec's Spanish list (este, o sea, pues, bueno, vale, tipo, en plan, a ver, es decir, digamos,
  ¿sabes?, ¿no?, nada, vamos, ok) plus the prototype's standalone tokens (esto, osea, ay, oh, a, ver, okay, sí, no); a
  phrase between pauses ≥ 0.3 s of ≤ 2 words made only of them (and vocalic fillers) is a filler phrase. English
  lists are an **assumption** (not measured on this user): `DEFAULT_FILLERS` + uhh, hm, ahh…; markers you know, I mean,
  like, so, well, okay, right, basically, actually, literally, kind of, sort of, anyway, yeah, oh.
- **Off-script share over content words.** The prototype took the in-script share over every non-filler token, and
  function words ("cómo", "lo", "de", "la") are in any Spanish script, so chatter such as "¿Cómo lo puedo
  pronunciar? Cloud…" scored 2 / 5 ≥ 0.35 and stayed. A 57-minute Spanish recording with a script and
  `offScript: "remove"` got no off-script findings. The phrase still needs ≥ `offScriptMinTokens` non-filler
  tokens, but the share is taken over its content words (no stop words, ≥ 3 letters). The phrase also needs two content
  words to be judged (one when `offScriptMinTokens` is 1), so a single reworded word cannot condemn an on-script
  fragment. The port fixture labels are unchanged. Regression test: `cleanup-rules.test.ts` "off-script chatter is
  found although its function words occur in the script" (fails before the change). The tail's "on script" test
  (see "Calibration") keeps the all-token share it was calibrated with. Limitation: the vocabulary is the whole
  script, so on a long script more chatter words occur somewhere in it, and recall drops with script length. Not
  measured on the user's material.
- **Untranscribed voice** (speech runs ≥ 150 ms without a word) is flagged for review and kept unless accepted
  ("never auto-removed", TC-011). The prototype cut it as part of the gap; on the user's material that was 1–2 % of the
  removed time (FINDINGS §3.1), so Fast keeps a little more there until the user accepts those findings.
- Natural is the prototype's `calm` with the spec's values: pieces ≥ 0.4 s (calm 0.25), 0.25 s air inside a sentence and
  0.5 s between sentences (`keepGapS`, `keepGapSentenceS`; calm had only its 0.10 / 0.15 s pads = 0.25 s), retakes /
  stutters / off-script / marker phrases / breaths for review.

### Findings and retake groups

`detectCleanup(input) → {findings, groups, words, guarded, script}` per media. A finding is a run of words with one
label (or a frame run): `{id, kind, range (media flicks), words [first, last] | null, confidence, reason {key:
'cleanup.reason.<kind>', params: {text, seconds, takes?, kept?, line?}}, suggested, group?, fingerprint}`. Kinds: pause,
breath, filler-vocalic, filler-phrase, filler-lexical, restart, false-start, retake, hidden-retake, stutter, off-script,
head-tail, untranscribed, asr-suspect, hallucination, and **fragment** — made by the sequence planner, not the detector
(round 12, below). `suggested` is the rule's action (`remove` / `review`); `off` rules do not run.

Fingerprint (TC-013): `<mediaId>~<stream>~<kind>~<round(start × 10)>~<round(end × 10)>~<fnv1a(normalised text)>` —
100 ms resolution; a repeated identical one gets `~2`, `~3`. Rejected fingerprints persist in `Sequence.cleanup.rejected`
and keep their findings unaccepted on later runs.

Take groups: the retake attempts of one sentence (an attempt that is a whole clause: it starts a clause, ends one and
holds ≥ 3 content words) and the take that stays — the last retry, which no later link removes — form a group; each take
has its range, words, text, mean probability, script line and coverage (with a script) and `complete` (the kept take,
or an attempt not written broken off). Chosen: the last take; with a script an earlier take covering ≥ 20 % more of
the line wins when it says every content word of the last take (the other takes become retakes, removed when the
chosen take says them, else review). The safety check of the old groups (`losesContent`, the aside and broken-off-unit
rules, the "ending re-said after a run of retries" rule) is gone: an attempt is linked only when its retry says it
again (coverage below), so the kept take never misses what a removed take said. Only the group's attempts and asides
carry the group id; a restart inside the kept take is its own finding (the corpus checks that no kept take loses a word
to its own group). Script (TC-012): lines are sentences (. ? ! … and line breaks); a unit says a line when ≥ 60 % of
its content words appear in order in it (LCS); the report lists every line and whether a take says it.

Hidden retakes (fix "hidden retakes", reported on a 57-minute Spanish recording with large-v3-turbo: 21 restarts and
retakes kept in one cut because the transcript held each repeated phrase once). The recogniser now decodes the
windows around stretched words and short wordless voice again (wp-notes/speech.md §11.3 "Hidden takes") and stores the
ranges whose words it replaced as `Transcript.redecoded` (media flicks; carried by `transcriptAttachPlan` from
`guard.redecoded` of the job result through `transcript.attach`, merged inside a mix's coverage like segments, and
bound to the recognition's `createdAt`: after a build that predates the field transcribes the media again, the old
ranges no longer count and repair drops them). The
existing restart and take rules find the recovered takes; after every rule ran, a run of one restart / false-start /
retake label with a word whose midpoint lies in such a range becomes kind **hidden-retake** (same action as the rule
that found it — no new setting — and the same group). The cut is the restart's: from the first take's first word up
to the kept take's first word, so with three or four takes only the last stays (each restart point closes the earlier
attempt); retake groups keep their choice (the last complete take, or the take closest to the script). Its reason
carries both takes: `text` (cut) and `kept` (the group's kept take when it lies in another take of a group, else the
as many words that follow it). Review
panel label "Hidden retakes", MCP `plan_cleanup` / `analyze_voice` findings and reason text name it.

Script repeats: a run of one restart / false-start / stutter label whose words, followed by as many words after it,
occur in a row in the attached script loses its label — the script itself says the repeat ("boing boing boing").
Applies to every transcript with a script, not only re-decoded ranges. Test: `packages/project/test/cleanup-hidden-
retakes.test.ts` (fails without the relabel, the script check or the stored ranges; its second case fails when a
mark of an earlier recognition still counts); "hidden retakes of a real recording": word lists of the reporter's
large-v3-turbo runs (fragments A, B, C, D, E, F) — the safety check and distinct-token completeness, ASR variants,
the aside take, the later-take reason, the cut-off attempt, the reason / range of a group's finding, the kept take's
range, "%" as a word, the in / out points and their frames next to a cut; each fails without its fix. Limit: without a script a
deliberate repeat is judged by the existing rules only (the allow list).

Real-take corpus (`packages/project/test/cleanup-real-takes.test.ts`, `fixtures/cleanup-real-takes.json`): the
whisper-large-v3-turbo transcripts of ~80 s fragments of the reporter's recording from runs 2–5 of the hidden-retake
test, every mode (re-decode on, `chunking: "vad"`, re-decode off), text and times only, plus the speech without words
and the silence inside a word the reporter measured (run 4, fragment E: voice at 38.14–39.34 and 39.80–42.10, silence
in the stretched "de" after 42.10). Runs 2–4 give 30 transcripts of fragments A–F; run 5 (code = main at 45ac32f6b,
large-v3-turbo on CUDA) adds 14 held-out ones — E again and the new G–L (L the control without takes), default and
chunked — whose spec was written from the listening judgements of that run before the code was changed for them; run
6 (main at 170f832bb, `/tmp/je-hr6-local/results.json` on the build host) adds 16 — M–R with takes, S and T controls,
default and chunked — with their spec written from that run's listening judgements. Each case carries a `dup`
reference (the media time a correct edit removes as repeats, asides and hallucinations): for A–L the take, restart,
stutter and hallucination removals of 170f832bb, which pass the case's spec and the round-5 listening; for M–T written
from the round-6 judgements. The
spec is written by hand per fragment as the speaker meant it — phrases the edit says exactly once (the last clean take
of each sentence, and what only one take says: "millones de dólares" on E), phrases it never says (asides, garbled
takes, cut-off attempts), media time that must go (J's stray "igual"), every word kept on L, no run of five words
twice, every word all kept or all removed (within a frame), the measured wordless voice of E (an attempt) removed, and
no kept take of a group losing a word — and three invariants for every case: every removed second, head and tail
included, lies inside a finding that removes (beyond its edge at most a frame of silence) and never takes measured
voice beyond it; rejecting every finding removes nothing at all; with every rule on review nothing is removed. It runs
through `analyzeSequenceCleanup` (Fast preset, 30 fps, speech under every word). History: at 0b492215c 12 of the first
24 failed, at f11b859fb 13 of 30; at 2557f0b20 44 of the 46 cases failed the new invariants (head / tail trims and gap
cuts without a finding) and G, I, K failed their spec (the aside, two missed restarts); at 170f832bb, after round 6,
the new cases N, O, Q, R, T failed their spec (and P on "Guiño, guiño"); with repeats by alignment all 60 pass (split,
metrics and the held-out result: "Repeats by alignment" below); run 7 (round 8) adds U–AB as a third split, run 9
(round 10) AC–AH as a fourth, run 11 (round 11) AI–AN as a fifth (regression coverage, below). Limits: without the re-decode (fragment A, mode c) "a" stretched over the second "poder
subirlos" (1.03 s) goes as a drawn vowel, so that case asserts "poder subirlos" and "la Play Store" apart. Run 5 E
default ("keeps 40.12–42.10, so that clause plays twice; stray 'de' split at 42.1") passes on this transcript at
2557f0b20 already — the corpus voice (speech under every word, silence after 42.10) does not reproduce it; the real
voice analysis decides which words the hallucination guard drops, and the take groups depend on that. With the
partitioned sound a removed "de" now goes whole with its finding; whether the clause still plays twice needs the
real-model rerun. H "rápida" stretched 2.2 s over speech is not resolved by the transcript.

An accepted removal of words takes the voice without words inside it (`sequence.ts`): an untranscribed span kept for
review never punches a hole into it (run 3, fragment E: "Que puedo hacer en un mes lo mismo" had no words at
38.14–39.34 inside the hidden retake 31.88–42.48), and the detector proposes such voice for removal with the run of
retries around it (`suggested: remove`, still reviewable). Test: `cleanup-hidden-retakes.test.ts` "voice without words
inside a removed retake goes with it".

**No cut inside a kept word; breaths spare onsets; slivers; hummed stock phrases** (round 6). A pause never covers the
frames of a word's time (`wordHold`: the word's frames but measured silence at its edges; a word longer than 1 s holds
other sound and is not protected), and the planner's pause compression and kept extents follow the same frames — the
round-6 cuts inside "gelatina", "ChatGPT", "reescribirlo" and the bursts of "Triste." are gone. A breath finding never
covers a kept word's time, and a breath-like run ending right at the onset of a word spelled with a fricative or
affricate (f, s, z, j, x, ch, sh, th, ph, c/g before e/i, h) is that word's frication (round 6: breaths took the onsets of
"Physics", "jugando", "chiquita" at −22 to −31 dBFS); what is left must still be ≥ 120 ms (the breath class's minimum).
A review-only word finding (ASR suspect, lexical marker) shorter than 0.15 s alone between two removed pauses is
proposed for removal (`suggested: remove`, still reviewable): round 6 left "pasa?" (0.10 s) and "¿Qué" (0.13 s) as
slivers. A known stock phrase (the hallucination list; "suscríbete al canal" added) over speech-classed voice with no
frame of frication — voicing < 0.45, flatness ≥ 0.2, ≥ 10 dB over the floor — and ≥ 0.3 s of speech is a
`hallucination` finding for **review** (round 6, M: "¡Suscríbete al canal!" decoded over 4.9 s of humming, zero-crossing
rate 500–800 /s against 3,600–9,700 /s on a real "s"). *Assumption*, labelled: the frication thresholds come from the
voice analysis' own speech / breath classes and are not calibrated on the humming (only its zero-crossing rate was
measured), hence review, never remove by default; it needs the voicing and flatness planes (`CleanupVoice` takes them
when present). Tests: `cleanup-rules.test.ts` "round 6 local fixes" (the breath / pause, sliver and hummed-phrase cases
fail on ff80a7438, before the fixes).

**Every removal has a finding** — head and tail included, and "review" removes nothing until accepted, on every path.
History: run 4, fragment E cut 1.8 s of a take that no finding covered (a stretched "de" touched the end of the take's
voice run). The held-out run 5 (fragments G–L, `/tmp/je-hr5-local/results.json` on the build host) still found cuts
without a finding: G "un" 27.40–27.53; F voice between two accepted pauses that was only a review finding or none
(26.07–26.30, 52.13–52.40); J (chunked) a tail trim 66.3–70.96 that took quiet audio and the word "al"; the last word's
fading tail (40–150 ms) in G, H and L; many 33–67 ms slivers. `analyze_voice` with every rule set to review still cut
34–50 s per fragment, the same ranges as rejecting every finding. Causes: the planner cut every non-speech run longer
than `maxGapS`, and the head and tail before the first / after the last word, whatever the findings said — a pause
stayed only when explicitly rejected; kept pieces shorter than `minPieceS` and slivers under `minSliverFrames` were
merged into the cut next to them; the coverage check allowed 0.1 s of removed voice next to any finding or kept piece.
The rules now:
- **Frame analysis partitions the sound** (`detector.ts` `frameFindings`, over the analysed regions = the clips' media
  spans, not only between the first and the last word): every speech frame belongs to a word — its time, voice within
  0.15 s of it (`UNCOVERED_MARGIN_S`) or a shorter wordless rest beside it — to untranscribed voice (a wordless stretch
  ≥ `untranscribedMinS`), or is a blip (a wordless speech run shorter than that between non-speech) that a pause holds.
  A gap ≤ `maxGapS` is split between its neighbours. What a word holds is `DetectResult.sound[k]`; a finding that
  removes words spans their sound (its fingerprint keeps the words' times). So findings that remove two neighbours
  leave nothing between them, and nothing else is removable.
- **Pauses at the head and tail too**: a run of non-speech (and blips) longer than `maxGapS` anywhere in a region is a
  pause finding, so a head / tail trim is a reviewable finding like any pause (without a voice analysis: the time
  between words, head and tail included, as word mode cuts it). Never over a **quiet word** (a word ≤ `maxWordS` with
  no speech frame under it: kept as its time, `quietWord`).
- **Pause edges in measured silence** (`pauseEdges`; silence = a frame that is not speech and < floor + 6 dB,
  `silentFrame`, the speech threshold's minimum margin): before speech, the pause ends after the last silent frame
  within 0.25 s of the onset, so no cut clips a rising onset (S3: run 5 H 14.067 took ≈ 50 ms of "Unity", H 51.73 and I
  47.67 / 56.3 grazed onsets — all edges of pause cuts); after speech followed by speech (a join) it takes a word's
  fading tail only — after the word's time, unvoiced, under the level edges' out threshold and 30 dB under the word's
  own loudest frame (round 11, below); at a tail it starts at the first silent frame — no silence within 0.25 s, no tail pause. Voiced sound under the speech threshold
  leading into an onset (voicing ≥ 0.5 above measured silence, `voicedFrame`, breaks of ≤ 30 ms) is the onset's: the
  pause ends before it — at the last silent frame within 0.25 s before it, else at its first voiced frame (round 8,
  H8: U b's pause took the soft "a" of a missed "a ver" at −40…−31 dBFS after 0.25 s of other sound; needs the voicing
  plane). Test: `cleanup-rules.test.ts` "a pause ends before voiced sound under the speech threshold…" (fails on
  9031bd0f3).
- **Decisions**: a pause is cut only when its finding is accepted. Every path plans through `analyzeSequenceCleanup`
  (the editor's planner worker, the engine job behind `analyze_voice` / `plan_cleanup`, `apply_cleanup`), so a rule
  set to review removes nothing anywhere until its findings are accepted.
- **Final frame check** (`sequence.ts` `keepUnexplained`, after frame snapping and the frame guards): every sequence
  frame whose media time is not inside an accepted finding or a removed word's sound stays; beyond a finding's edge at
  most one frame may go, and only over measured silence (the frame grid cannot follow a finding's edge). A short piece
  or a sliver the guards would drop stays rather than merging into a cut.
- **Voice without words stays unless its own finding is accepted** (round 8, H5): a frame holding speech of an
  untranscribed finding that is not accepted (outside accepted removals of words around it) stays whatever else covers
  it — the final frame check protects it — and a join's pause takes only a word's decay below the out threshold, never
  voice without words. Round 7 (large-v3-turbo, both modes) cut 0.227 s of voiced sound (−34…−51 dBFS) of an
  unaccepted untranscribed finding in the control AA and 0.07 s in U b: the pause's decay walk went back over it.
  Test: `cleanup-property.test.ts` "a sequence plan removes nothing outside accepted findings…" now draws voice
  without words in gaps (murmurs after a word, contiguous or apart, 3–30 dB over the floor) and checks that no removed
  speech frame of an unaccepted untranscribed finding lies outside an accepted removal of words (fails on 9031bd0f3;
  either half of the fix alone passes it).
- **The last kept piece keeps its fading tail** (`keepTail`): it grows over the decay after it (frames above measured
  silence, outside removed words' times) to silence, ≤ 0.25 s — a join may cut inside a decay, the clip's end may not.
  Since round 12 the decay ends where it is measured silence **and** 30 dB under the last word's peak, and 80 ms of the
  silence after it stay (`phraseTailEnd`).
- The planner's own re-plan (`covered`, `UNCOVERED_TOLERANCE_S`) stays as a first pass; a piece shorter than
  `minPieceS` holding a kept word stays; gaps of exactly `maxGapS` join.
Tests (all fail on 2557f0b20 — 44 of the 46 corpus cases, both corpus invariants, the property):
`cleanup-real-takes.test.ts` — every removed second, head and tail included, lies inside a removing finding or within
a frame of one; measured voice never beyond a finding; rejecting every finding removes nothing at all; with every rule
on review nothing is removed. `cleanup-property.test.ts` "a sequence plan removes nothing outside accepted findings…":
random transcripts and voice masks (rising onsets, decays, breaths), random rule actions and kind decisions — every
removed 10 ms lies in an accepted finding or within a frame of one over silence; reject-all and all-review remove
nothing; no cut takes a kept word's rising onset after silence nor the last kept word's decay (without `keepTail` it
fails on the decay). Limits: an onset after more than 0.25 s of non-silent non-speech (a breath, room noise) keeps the
pause end at its first speech frame; the classes and levels are the voice analysis' (a fade it measures under floor +
6 dB counts as silence); timestamps that cover another word's onset give it to that word.

**No cut splits a word** (strict removal): next to a cut the edge sits on the word boundary — the in point of a kept
word after removed words is not before the removed word's end, the out point before a removed word not after its
start (the kept word's ±50 ms of sound had put edges up to 70 ms into removed words) — and frame snapping floors both
(`MediaPlan.tight`). The F cut now starts at "Windows"' start (4.30, frame 129). The port check uses the prototype's
edges (`strictRemoval: false`).

**Cut edges in continuous voice** (round 8, H10 / H6). Round 7's listening heard cuts start inside continuous voice
and keep 20–30 ms of a removed word ("WTF, | no puede ser" Z b at 14.6 inside "no" 14.57–14.63; "mucho o | que" W b at
71.1; Z a, W a): the planner's out point before a removed word takes the frame boundary at or before it, but the
final frame check put that frame back because the part before the finding's start was not silence. Now (1) a removal
of words that starts right after another word with speech in every frame between them starts at the quietest 10 ms
frame (the latest of equals) from 80 ms before its first word — after the first 60 % of the word before — up to the
frame holding its start, never inside the removed word (`startValley`; a fricative onset is quieter than the vowel
before it, so the search stops at the word); (2) the final frame check lets the frame at or before an accepted removal
of words' start go when every 10 ms before the start in that frame is speech or silence (continuous voice — never a
kept word's fading decay): the removed word goes whole, the kept word before it loses less than a frame at its
quietest point. The corpus and the sequence property allow exactly that frame (before word findings only).
(3) A word's voice that runs on after its time to the end of its speech run, up to 0.4 s (`WORD_TAIL_S`, *assumption*
from W a), is the word's sound, not untranscribed voice: W a's removed hidden retake "que aparece un bug rarísimo."
ended at the word's timestamp 72.63 while the voice ran to 72.97, and the 0.19 s beyond the 0.15 s margin stayed as a
review finding ("[-mo]"). Tests: `cleanup-cut-edges.test.ts` (both fail on f90d998c6: 17 ms of the removed "no" kept;
the tail an untranscribed finding). Limits: when the quietest point lies more than a frame before the removed word's
timestamp, the cut still takes the boundary at or before the timestamp, so up to that distance of what the levels call
its onset stays; levels are 10 ms frames, the grid 33 ms at 30 fps.

Spoken symbols: a word that is only a symbol said as a word and punctuation ("%", "%...", "€", "$", "&", "+", "@",
"°") is a candidate word with the symbol's name as its token ("porciento" / "percent"), so it covers its sound: the
second large-v3-turbo run left "%" ("por ciento", −10 to −24 dBFS) of a removed restart audible as voice without words
in every mode, and opened a hole inside an accepted restart.

**Speech a stretched word holds** (run 5: H "rápida" stretched 2.2 s over continuous speech at −10 to −24 dBFS,
G chunked "en" holding 1.4 s; both kept with no finding while the speech likely repeats a phrase): a word longer than
1 s — or, since round 12, at least 0.6 s and three times what its syllables take at the speaker's pace (`stretchedWord`)
— with at least half its frames speech — the speech worker's hidden-take trace — gets an **untranscribed** finding
over its speech after the first 0.5 s (`frameFindings`; *assumption*: a word holds at most 0.5 s, from these two
cases), with the word as `reason.params.text` ("Speech inside the stretched word "…": maybe a take written once" in
the Review panel and MCP). It follows the untranscribed rule (review in both presets), so nothing changes until it is
accepted; accepted, its range is cut out of the kept word (`sequence.ts`, before the frame grid). Test:
`cleanup-real-takes.test.ts` "speech a stretched word holds is flagged…" (fails without the finding and without the
cut). Limit: the word's midpoint may then lie in the cut, so the Review transcript strikes the word although its own
first 0.5 s stay. The speech worker now also decodes such words alone (speech.md §11.3).

Frame findings (with a voice analysis): **pause** = a non-speech run longer than `maxGapS` between speech frames inside
the words' span; **breath** = a breath-like run within 30 ms of speech; **untranscribed** = see above. A rejected pause
is kept by the planner; a breath is kept before an onset when rejected (Fast) or unless accepted (Natural's `keep`
policy, ≤ 600 ms).

### Repeats by alignment (round 6)

`repeats.ts` `ruleRepeats` replaces the prototype's restart and take rules and every special case rounds 3–5 added to
them (`ruleRestarts` with its chain search, garble, stutter-at-the-restart-point, lead-in and stretched-lead cases;
`ruleTakes` with the unit groups, `losesContent`, the aside / broken-off-unit rules and "an ending re-said after a run
of retries" in `detector.ts`). Six rounds of real-model validation had each fixed the failing corpus cases with a new
rule, and each held-out round found new failures. The mechanism (vocalic fillers already labelled are transparent):

1. **Candidates.** A retry opening p: a 3-gram said again within `restartWindowWords` words (one word after the first
   may be garbled in place: "que pueda ser" / "que puedo hacer"), a 2-gram with a content word within
   `restartWindowWords2`, or two clause starts (sentence end or ≥ `phraseGapS` before) within 80 words whose first words
   match, both within `restartWindowS`. The retry may open with lead words (one or two function words, or one content
   word, said into it after a boundary: "Y | bueno, …", "| ahora diseñé …", "…-ge… | que de hecho …").
2. **Alignment.** The attempt [q, e) is aligned (LCS over content words — no stop word, ≥ 3 letters or a digit, or a
   number word; `sameWord` ASR variants) with the retry R: from p to its next copy of the same opening, at most
   min(2 × |attempt| + 8, |attempt| + 24) words; when R is itself abandoned, with up to 4 later copies (a chain of
   takes). Prefix: the attempt's first content word is among R's first three (a short attempt: all its words in order
   among R's first, its first word first or second).
3. **Remove** when every content word is said again, forgiving only: a word garbled in place (`soundsAlike` between the
   re-said words around it; up to a third of the attempt: "le lee da esa imagen" / "le ves a imagen"), a cut-off last
   word said whole ("cual…" → "cualquier"), the last word of an attempt written broken off after three re-said words
   ("en lugar…" → "en vez de"), and in an attempt of ≥ 6 content words one word (15 %, never two in a row) the speech
   right after R says. Numbers and alphanumerics ("3D", "2D", "tres" = "3") are never forgiven. Words an inner restart
   already removes do not count against a take that holds it.
4. **Adjacency.** Between attempt and retry only fillers, other attempts of the same retry (each must be removed by its
   own link), marker words ("a ver"), or one aside after an attempt of ≥ 3 content words before a retry that starts a
   clause: whole clauses, ≤ 16 words, ≤ 5 s of speech, never holding the retry of an earlier attempt ("Uf, me quedé sin
   aire.", "¿Y por qué va a decir puta? En toda su puta vida").
5. **Sentences.** An attempt that starts inside a sentence never runs over its end (O: "una plantilla 2D o 3D. | la
   imagen de la plantilla 2D…" — the old 3-gram anchor cut "o 3D"); if it finishes that sentence it must be re-said word
   for word (R b: "Bueno, no lo reescribí yo." is no restart of "Lo reescribí a mis agentes…"). A retry starts an
   attempt of its own (the next attempt may start there).
6. **Complete retry.** A retry that is said again later and ends broken off is complete only when that later copy
   removes it as its own attempt (a chain); a retry removed inside another link's aside or attempt leaves the attempt
   for review. The recogniser's "…" alone (often a pause: "… en mi motor…… y correr…") does not make a retry incomplete.
7. **Review** when one whole clause shares ≥ `retakeSimilarity` of its content words with the clause after it, in order
   and from its start, but is not re-said in full (never when it holds a number the retry does not say).
8. **Deliberate repetition** is never an attempt: one content word said again at once, the run ending its phrase or of
   three or more ("Guiño, guiño.", "boing, boing, boing"); the stutter rule only reviews it.

   Round 8 (H7): the copies of a one-word reduplication may be up to 0.5 s apart, inclusive (`REDUPLICATION_GAP_S`, or
   `stutterGapS` when larger; *assumption*: the upper end of a comma pause). Round 7 cut the first "Hola," of the
   greeting "Hola, hola." (copies 0.30 s apart) as a retake in both modes because the guard wanted < 0.30 s; what tells
   a reduplication from a restart is that the run ends its phrase, not the gap ("Ya. Ya me pasó" stays a false start).
   Test: `cleanup-rules.test.ts` "a greeting said twice with a comma pause is deliberate" (fails on 9031bd0f3).

**Round 8 additions** (from the round-7 listening of large-v3-turbo runs; each has a test in `cleanup-rules.test.ts`
"round 8 fixes" that fails on 11161ed77 — two of them use the reported words of fragment U b / W a):
- Rule 3, an **inserted word**: a word the recogniser likely inserted (below) is forgiven when the re-said words around
  it are next to each other in the retry (U b: "Tengo solo 30 días para hacer un ¡Suscríbete! motor…" was kept and the
  two attempts before it only reviewed — 25 words heard twice).
- Rule 3, an **ASR doubling**: a word right next to a matched one (≤ `stutterGapS` apart) that sounds like the same retry
  word is forgiven in place (W a: "crecieron crashean" for one "crashean", said again as "crecían", kept the 17-word
  "Play Store" sentence for review).
- Rule 3, a **corrected word**: in an attempt with one aside before its retry, a content word the retry replaces by
  another one is forgiven when the aside opens — after an optional correction marker ("no", "perdón", "digo", "mejor
  dicho", "quiero decir", "o sea"; "sorry", "I mean") — with that word, or with the one or two attempt words before it
  and then that word; at most one per four content words (W: "…dependo completamente de Unity. | No, de ellos, no tengo
  que repetir tanto. | …completamente de ellos." had no finding in either mode; mode a has no "No,"). An aside that
  opens with a correction marker over a clause whose retry says most of it from its start (`retakeSimilarity`) gives
  at least a review link over attempt and aside.
- Rule 6: a retry counts as removed by another link only where that link's attempt or aside lies — not its whole span
  up to its retry (a chain's link spans the abandoned copy between, which it does not remove). W a: "Y sí, es cierto,
  pero tengo mis razones. | sí, es cierto, Y sí, es cierto, pero…" kept "Y" and the abandoned "sí, es cierto," for
  review because the first copy's link to the third swallowed the third's "Y".
- **Words the recogniser likely inserted** (`detector.ts`, `RuleContext.inserted`; hallucination findings for review
  where no removal takes them, else they go with it — the hummed stock phrase inside a removed attempt no longer gets a
  finding of its own): stock phrases over voice without frication (round 6), a stock phrase **woven** into other speech
  — its words in order within 10 words and 4 s of its first, not contiguous (U a: the recovery decode wrote "¡Suscríbete
  | Tengo al solo 30 días para hacer canal! un motor", so the hidden retake started at "un", mid-attempt, in continuous
  voice) —, **garbage**: words in another writing system than the transcript's language (`foreignScriptWord`; Hangul
  in Spanish) and the ≤ 2 words between two of them (U a: "Pen 와 blah blah금u"; "와" normalised to nothing and was not
  a word at all), and words over **unvoiced noise** (below).
- **Text over unvoiced noise** (H9): words with no voiced frame (`voicedFrame`) in their time ± 30 ms, at least half of
  it above measured silence — a Spanish or English word holds a vowel — are one hallucination finding per run: removed
  (the hallucination rule's action) when the run is alone between pauses ≥ `phraseGapS`, else for review (round 7:
  "¿Qué pasa?" over noise at −27…−49 dBFS, zero-crossing rate 1,500–10,000 /s, stayed as 0.2–0.7 s asr-suspect pieces
  between removed pauses). Needs the voicing plane. *Assumption*: a whispered word would count as noise.

**Round 10** (from the round-9 listening of large-v3-turbo runs, `/tmp/je-hr9-local/` on the build host; tests in
`cleanup-rules.test.ts` "round 10 fixes", each failing on a8d587fcc):
- **Every removal of a take is guarded centrally** (`detector.ts` `guardRepeats`, after every rule and the hidden-retake
  relabel; restart, false start, retake, hidden retake, stutter — whichever rule labelled it). Run 9 AD cut "las
  sombras." — the end of "…se renderizan las luces y las sombras." — as a false start because the next sentence, 15 s
  later, opened with "las sombras funcionan…": rule 4 bounds *what* lies between attempt and retry (nothing here), not the
  silence, and rule 5 accepted an attempt that finishes its sentence when its words are re-said in order. A label run
  becomes a review when it fails either check:
  - *Adjacency*: the silence after any of its words is ≤ 5 s (`ADJACENT_MAX_S`), unless the run opens a clause and, up
    to that word, is broken off mid-sentence (no sentence end) or a whole take (≥ 3 content words). *Assumption* from the
    corpus: the longest silence after a take that starts inside a sentence or is shorter than a clause is 4.55 s (AE
    "…imagen. | el procesador…"); whole takes wait longer (fragment B, second run: 12 s after "…en toda su vida. ¿Y por
    qué va a decir puta?"; run 2: 12.5 s after "el otro 1 %…"), so a fixed few seconds for every kind would lose them.
  - *Sentences*: a run that finishes a sentence the kept words before it began (the kept word before it ends no
    sentence and is a function word, or is said into the run without a pause ≥ `phraseGapS`) needs the kept speech right
    after it (other removals between, no silence over 5 s) to say that sentence's last content word again within the
    retry span; after a function word ("…las luces y | las sombras.") that copy must end a sentence too (W a: "…mucho o |
    que aparece un bug rarísimo. | que aparece un bug rarísimo." stays removed). The sentence ends at the run's first
    sentence end (an aside after it may end another); "…" and an inserted stock phrase ("¡Suscríbete!") end none.
  Fillers, hallucinations, off-script and head / tail findings have no retry and are not guarded (a filler removed at a
  sentence end takes no word of the sentence). Tests: the AD words with a 15 s and a 1 s pause and without the period
  (each variant fails on a8d587fcc); the property "a removed take never takes the end of a sentence the kept words
  began, unless said again right after it" (random pieces of sentences sharing words, pauses up to 15 s; fails without
  the guard); and the same invariant on every corpus case.
- **A stock phrase over voiced speech needs non-speech evidence** (H5): over speech without a frame of frication it is a
  hummed hallucination only when its loudest frame also stays 6 dB under the file's speech level
  (`HUM_BELOW_SPEECH_DB`, `belowSpeech`; no levels, no flag). Run 9 AC flagged the real "gracias" (−6…−10 dBFS, voicing
  0.78–0.87; its final /s/ at flatness 0.10–0.18 fell under the frication test). *Assumption*, labelled: two
  measurements of one speaker — round 6's humming peaked at −17 dBFS, the real word at speech level. The round-6 and
  round-8 hum tests now hum at −35 dBFS (speech −25 dBFS).
- **Slivers** (H11, H12): a review-only word shorter than 0.15 s between two removed pauses stays for review when it
  holds a voiced frame at the speech threshold or louder — a sound said on purpose (AG a: the mouth sound "Pup.", voiced,
  −16 dBFS, was removed); noise words (round 6 "pasa?", "¿Qué") still go. A review-only sliver after a removed pause
  that touches a removal of words (within 20 ms) goes with it: AD a kept the recogniser's "Bueno," (0.12 s) written
  over the onset of a removed take's "Así" as a 0.13 s blip cut in voice.
- **A correction with an inserted word** (H3): the corrected-word rule (round 8) skips one function word among the
  aside's opening words. AE b (chunked) wrote the correction "cada La frame, no imagen." — "La" inserted —, so the
  aside did not open with "cada frame" and the take "…en cada imagen del juego." stayed as the kept take of its group
  with the correction after it (22 words heard twice); mode a wrote "Frame, no imagen." (and the span was re-decoded),
  which the rule already took.
- **Broken-off attempts said again word for word** (H2, H4, H6; no finding in either mode of run 9):
  - with an aside (AF: "Sí, ya sé que Roblox usa… ¿Dónde está el enojado? | Sí, ya sé que Roblox usa el WoW" — two content
    words, under rule 4's three; AG a: "es… Espera. | es extremadamente rápido."): an attempt up to its first cut-off
    word that the retry opens with word for word (after up to two lead words; the cut-off word as a prefix), then a
    whole-clause aside — ≤ 3 words after an attempt of fewer than four words, else rule 4's limits — before a retry that
    starts a clause. Candidates and the opening check judge an attempt broken off within its first three words by those
    words (the aside's content words are not the attempt's);
  - with a different cut-off word (AC: "lo peor es que el tor… | Y lo peor es que el motor…"; "tor" is no prefix of
    "motor" and the attempt has one other content word): rule 3 forgives a cut-off last word after three or more words
    said again word for word;
  - a lead word said into the attempt (AG b: "Y es… | es extremadamente rápido."): a clause-start word without content
    before an attempt broken off within two words makes the attempt a candidate; the lead joins it as before.
  - A word ending in a letter and a hyphen ("tor-", chunked AC) is written broken off (`CUT_OFF`), and a retry's lead
    words may follow such a word.
- **A dropped word** (H5, rule 3): in an attempt written broken off with ≥ 6 content words, one content word (not the
  first or last, never a number) the retry leaves out between two re-said neighbours with no content word between them
  is forgiven. AC's abandoned first take "Bueno, ok, gracias por avisar, hermano, muy amable de tu parte después de
  haber casi… | … después de casi explotar mi puta laptop." (15 words) was only reviewed in both modes.
- **A pause ends before a soft onset by level, not only by voicing** (round-8 H8 residual): going back from an onset,
  frames above measured silence within 20 dB of the word's first 100 ms (`ONSET_RAMP_DB`) that rise into it (each at
  most 3 dB over the next, `RAMP_STEP_DB`), up to 0.25 s, belong to the word; the pause ends before them as before (at
  the last silent frame within 0.25 s before them, else at their first frame). U b's soft "a" of a missed "a ver"
  (−42…−31 dBFS) measured voicing 0.13–0.41, under the round-8 voicing test (0.5), so the pause 2.267–2.433 still ended
  inside it on the real audio. *Assumption*, labelled: the "a" sat 10–17 dB under the speech after it; a breath at that
  level right before an onset now stays with the pause's edge (its breath finding still decides it).
- **Text over noise with stray voiced frames** (round-8 H9 residual): a word holds a vowel only with 3 voiced frames in a
  row (`VOWEL_MIN_FRAMES`, 30 ms); AA b's "¿Qué" over noise had three stray ones (two in a row) and stayed as an
  ASR-suspect review; AH b's "¿Qué se hace?" (one voiced frame) now reads as one run of noise words. Round 11 narrowed
  this to words with strong non-speech evidence (below: it flagged loud real words).
- **Garbled tokens in a take** (round-8 H3 residual, rule 3): a number written twice next to itself ("30 treinta") is
  one number; and in an attempt of ≥ 6 content words, one word per six that the recogniser marked unsure (confidence
  under `lowConfidence`, an ASR suspect) between two re-said neighbours is forgiven. Fresh U a's re-decode wrote take 1
  as "Hoy voy a ser mi propio janeter Unity. Tengo solo 30 treinta días. Pen Espérate," and it stayed (15 words heard
  twice). The corpus transcripts carry no confidences (0.9 throughout), so this is measured on the unit test only;
  the run-7 U a transcript in the corpus (Hangul garbage, no re-decode) is unchanged.
- **Asides of take chains** (after the first held-out-r9 evaluation; precision first): an aside between an attempt and
  its retry goes with the attempt by default only when it holds no word the recogniser inserted (stock phrase, another
  writing system, noise) and has at most 3 words, or every content word of it is a stock word (discourse and
  correction markers, "espera", "perdón", "disculpa", "wait", "sorry"), a word the recogniser was unsure of, or a word
  the attempt or the take that stays says (the retry and the speech right after it) — `asideGoes`. Any other aside is
  its own review finding (same kind, `suggested: review`) while the attempt is still removed. So AF's "¿Dónde está el
  enojado?", B's "¿Y por qué va a decir puta? En toda su puta vida", N's "Uf, me quedé sin aire.", W's "No, de ellos, no
  tengo que repetir tanto." and X's "Ya no soy argentino." are proposed, not cut; AG's "Espera." (1 word), AE b's "cada
  La frame, no imagen." (said by the attempt and the take) and U a's "Tengo solo 30 treinta días. Pen Espérate," still
  go. The corpus spec checks the edit with those aside reviews accepted (`asideReviews`) and the default precision on
  the default; the recall gate counts an aside proposed for review as found, and the default recall is reported apart.
  Tests: the B, W and AF tests now assert the aside's review finding (each fails on e1c59f1c1).
- **A false start restarts a sentence**: a false start (≤ 2 words) whose retry clause has one or two words is reviewed
  (AG: the name tried out, "¿Cómo lo puedo pronunciar? Cloud | Cloud Code."); "Primero, | primero diseñé la carretera"
  still goes. A rule set to off now labels nothing, not even its review links (it used to label review-tier links).
  Test: `cleanup-rules.test.ts` "a false start whose retry is one or two words is reviewed" (fails on e1c59f1c1).
- Numbers: the tens (treinta … noventa, cien; thirty … ninety, hundred) are number words with their values, so "30
  treinta" is one number. With them, run 7 U a's "tengo sólo treinta días Pen 와 blah blah금u Unity" — whose end is the
  garbled take that stays — linked to "Tengo solo 30 días…" with its garbage forgiven word by word (4 wrong words on
  held-out-r7); an attempt with two or more content words after its last re-said one is now no full cover (1 wrong word
  left: the stretched "와" before the garbled take).
- Limits left by round 10: H6's name variants across a long aside (above, "Round 10 (`held-out-r9`)"); AH b's "pasa?"
  (no voiced frame, but mostly at measured silence, so not "noise" by the unvoiced-sound test) stays an ASR-suspect
  review; the hum level (6 dB under the speech level) and the onset ramp (20 dB, 3 dB steps) are assumptions from one
  speaker's few measurements and need the real-audio rerun; the cut-edge limit of round 8 (W a 71.4, Z b 14.567) is
  unchanged.

**Round 11** (from the round-11 real-audio validation of main 42d6ab3c6, large-v3-turbo both modes, fragments AI–AN and
re-plans of run 9's transcripts, `/tmp/je-hr11-local/` on the build host; tests in `cleanup-rules.test.ts` "round 11
fixes" and `cleanup-property.test.ts`, each failing on 42d6ab3c6):
- **A pause never takes a word** (B1, safety). A join's pause took the decay before it while frames were speech of a word
  (`owner`, which includes the word's own time) under the out threshold — floor + 20 dB, an absolute level. AJ (floor
  −48 dB → −28 dBFS): accepted pauses removed the quiet off-mic words "las", "3" and "que..." (−28…−35 dBFS, speech,
  voicing 0.59–0.82) with no word finding and split "y" at 24.000; AK (floor −42 dB → −22 dBFS) trimmed the last vowels
  of "detalle,", "no?", "teléfono,", "Unity." at −22…−27 dBFS inside their times. Now the decay walk (`decayFrame`)
  takes only frames after every word's time, unvoiced (`voicedFrame`), held by a word (its margin), under the out
  threshold **and** 30 dB under that word's own loudest frame (`DECAY_BELOW_PEAK_DB`; *assumption*, labelled: the
  conservative end of the 25–30 dB the report proposes, not calibrated on the user's cuts). A pause still holds measured
  silence at a word's edges (loose timestamps, `wordHold`), and a word longer than 1 s is still unprotected (it holds
  other sound). Effect on Fast: a join's out point now sits where the voice analysis stops calling the tail speech, or
  30 dB under the word's peak — on the golden synthetic voice (124 dB/s decay, floor −64 dB) 0.22 s after a word's tone
  instead of ≈ 0.16 s, at its first frame of measured silence (the golden edge bound now says that, not "< 0.2 s").
  Tests: AJ a's words with the run's levels and AK's "detalle," tail (each fails on 42d6ab3c6); the sequence property
  now asserts that a kept word's time loses no frame that is not silence unless an accepted removal of the next words
  starts there (its valley, round 8), and that a pause takes a kept word's running-on speech only 30 dB under its peak
  (fails on 42d6ab3c6); the corpus asserts that no word's time is removed without a finding that removes it (the frame
  at or before the start of a removal of the next words aside).
- **Noise needs strong non-speech evidence** (B2, precision; regression of round 10's 3-frame vowel). The vowel rule
  alone flagged loud real words: AM "negra" (−11…−21.5 dBFS, speech level −9.5), AK a "megas.", AC "si", the control
  AA's "que", U a "shit," — hallucination reviews — and AG a's "No." (−22.5 dBFS, speech-classed, voicing 0.31–0.63
  never three frames in a row), alone between pauses, was **removed**; AG a's "Espera." became a review, so it no
  longer went with "es...". A word is now noise only when the voice analysis calls most of its frames something else than
  speech, it stays `LOUD_WORD_DB` (12 dB) under the file's speech level, it holds no vowel run and half of it is above
  silence (`unvoicedSound`; no levels, no flag). A loud word is never noise, whatever its voicing frames say. Noise
  words go only alone between pauses that go (the pause rule removes); else review. *Assumption*, labelled: 12 dB from
  run 11's flagged real words (1.5–11 dB under the speech level) and the noise words of rounds 7–9 (15 dB or more under
  it). Test: AG a's words ("No.", "Espera.") and AM's "negra" with the run's levels (both fail on 42d6ab3c6). Left as
  it was: the hummed stock-phrase rule keeps its 6 dB (`HUM_BELOW_SPEECH_DB`, review only, its own frication evidence).
- **An inserted word over a removed take's tail** (B3): AI b wrote "…miden dos... metros. | y pantallas ultra -wide
  que miden dos metros." — "metros." (inserted over the decay of "dos") was taken as the retry's lead word ("one content
  word may lead the retry"), so it stayed with 0.2 s of the abandoned take's tail. A word that ends a sentence is no lead
  (it is not said into the retry); the attempt is then broken off at "dos..." and "metros." goes as its one-word aside.
  Test: corpus case AI-r11b (fails on 42d6ab3c6).
- **One word written as two** (B4): AM a wrote the mumbled attempt "nos e[ncontramos]" as "y aquí no sé", 10.6 s before
  "aquí nos encontramos con un problema enorme."; mode b ("y aquí nos") was linked. A content 2-gram said again whose
  second word the attempt wrote as two words that begin with it and sound like it (`splitWord`) is a candidate, and a
  short attempt's opening counts the pair as that word. Test: corpus case AM-r11a (fails on 42d6ab3c6). Limit: only a
  word split in two in a short attempt's opening; "Cloudecode" / "Cloud Decode" (round 10, H6) is still not linked.
- **An off-mic exchange is no filler or stutter** (B5, conservative): a filler phrase with no word within 12 dB of the
  speech level is reviewed, not removed (AJ's off-mic answer "Sí." at −27 dBFS, speech level −8.5 dBFS), and a stutter's
  first copy must be said in one go — no pause ≥ `phraseGapS` inside it (AJ b: "que... | Así que, así", 5.7 s apart,
  was a 2-gram stutter). Test: `cleanup-rules.test.ts` "an off-mic exchange before the takes…" (fails on 42d6ab3c6).
- Corpus (`CLEANUP_CORPUS=held-out-r11`): run 11's twelve transcripts (AI–AN, both modes) with their `dup` references,
  `alt` spans (removal right but not required: the "y" of AI's retry, AN's whispered noise word — counted right, not
  required for recall; a new field of this split's references, defined by the judgements before the evaluation) and
  `debatable` spans (AJ's off-mic aside), the run's measured levels (`levels`: floor, speech level, threshold; words 6 dB
  under the speech level) and measured quiet speech (`quiet`: AJ's aside at −30 dBFS, AM's mumbled attempt at −35
  dBFS), plus a spec per fragment (AJ's aside kept or removed whole: `together`). Its bug reports were read before the
  fixes, and the recording has no unused gaps left for a blind split: it is regression coverage, not a held-out
  measurement. At 42d6ab3c6 AI-r11b, AJ-r11a, AJ-r11b and AM-r11a fail their spec; strict precision 0.984 (62 / 63, the
  "que..." stutter), recall 0.950 (57 / 60 — the pause over AM a's quiet "sé" counted as a hit). After the round:
  12 / 12, precision 1.000 (65 / 65), recall 1.000 (60 / 60); every earlier split unchanged.
- **A removal of words never takes the kept word's fading decay before it** (the sequence property's "tail frame
  removed", ≈ 1 in 2,000 runs, also on main; reproduced with fast-check seed −1982316913, run 369, and seed 1227731568).
  Two detector causes: a short gap (≤ `maxGapS`) was split at its midpoint, so a removed word after a kept one took the
  last frames of its decay above silence — it now splits at measured silence (decay to the word before, rising onset to
  the word after, the silence halved; without silence at the quietest frame, `gapSplit`; identical where gaps are
  silence, so the corpus is unchanged); and a quiet word (no speech under it — a zero-length word on the first frame of
  a decay, which the hallucination guard removes) took the whole decay after it — a quiet word now keeps its own time,
  and the sound running on past it goes to the word whose speech it continues (`soundSide`). The property's decay check
  also expected the last kept word's decay kept when the plan keeps sound after it (voice without words left for
  review): that is a join, where the Fast style may cut inside a decay, so the check now skips it. Both inputs are
  pinned as examples (`PINNED_DECAYS`, each fails without its half of the fix); 3 × 10,000 random runs pass.
- Limits left by round 11: the 30 dB and 12 dB levels are assumptions from this speaker's runs; the real-audio rerun
  must show that join out points stay acceptable (they now keep the tail down to the speech threshold); the corpus voice
  has no voicing plane, so B2 is measured on the unit tests only; a pause still covers measured silence inside a word's
  loose timestamps and the inside of words longer than 1 s.

**Round 12** (a user's real cut of the 57-minute Spanish talking head made with main 4e2dd3342, reported by the agent
editing it; tests in `cleanup-slivers-tails.test.ts` and `apps/engine/test/speech-hidden-takes.test.ts`, each failing on
4e2dd3342):
- **No kept sliver between cuts** (S1). Applying left 35 V1 / A1 clips of 1–7 frames, cut from far-away moments (a 1–2
  frame flash of another pose: "…mi propio | Unity | Tengo solo 30 días"); some held no word, others one short word
  ("Y", "Unity", "En", "No"). Cause: a short planner piece holding a kept word stays (round 5, strict removal: a word
  alone between removed pauses or takes), and the frame guards' `minSliverFrames` drop was undone by the final frame
  check (round 5, "Every removal has a finding"), which puts back every frame no accepted finding explains — nothing
  reconciled the two. On the corpus 26 such pieces (3–9 frames: "pasa?", "¡Viva!", "No.", "las", "3", "Pero"…). Now,
  after the final frame check and the tail, `resolveSlivers` (`sequence.ts`) takes each kept piece shorter than
  `guards.minSliverFrames` (10, a preset setting; was 3) that does not span its clip: (1) joined to a neighbour across
  the removed gap when that gap is ≤ `minSliverFrames` long and holds only silence or pause (no removed word's time, no
  speech, breath or voiced frame, nothing of a removed word's sound above measured silence); else (2) a **fragment**
  finding over it (`range` = the sliver's media time, `words` = the kept words whose midpoint lies in it, reason
  params `text`, `frames`, `between: words | cuts`) — suggested for removal when it holds no word and no voice, or
  when removed words lie on both sides of it (a piece of another take); else for review (a word alone between pauses);
  never for voice without words left for review (its own untranscribed finding decides, round 7); (3) an accepted
  fragment goes; any other sliver grows over the silent frames beside it (after it first) to `minSliverFrames` when
  there are enough. Nothing goes without an accepted finding: the fragment is a finding like the others (Review panel
  "Isolated fragments", MCP `analyze_voice` / `plan_cleanup` findings with the reason "N frames kept alone between
  removed words / cuts", accept / reject by id or fingerprint). The clip's new last piece keeps its tail after an
  accepted fragment at the end. Corpus after the change: no kept piece under 10 frames; 13 review fragments (the words
  alone between pauses, grown), none removed by default; precision / recall unchanged.
- **Sentence ends keep their tail and some air** (S2). About 30 kept clips ended 30–180 ms before the last word
  finished ("azul.", "lo arreglen.", "verdad.", "web.", "romper.", "espacio."). Cause (from the code; the reporter's
  audio was not re-measured here): a join's pause took every non-speech frame after the speech class ended — a soft or
  unvoiced word end under the speech threshold — and, inside the word's time, any frame within 6 dB of the floor. Now a word that ends a sentence (". ? !", not "…"), and the clip's last kept
  word, keeps its fading decay until a frame is both measured silence and `DECAY_BELOW_PEAK_DB` (30 dB) under the
  word's own peak — the round-11 relative bound, so a quiet word's tail near the floor still counts — ≤ 0.25 s and
  never past the next onset (the pause's end, the next kept piece or word, removed words); then `TAIL_PAD_S` (80 ms, of the 60–100 ms asked) of
  the measured silence after it stay, at most half of it (so a cut remains): `phraseTailEnd` in the planner (step 4b),
  the detector's pause edges and `keepTail`. Inside a sentence the Fast join style is unchanged (it still cuts inside
  the decay). Golden: removed-time recall 0.96 → 0.89 (the truth cuts inside the four sentence-final decays; bound
  lowered to 0.85 with that reason), out points after a sentence end or at the clip's end may lie 80 ms past measured
  silence. Review sliver rule (round 6 / 10): it measures the word's own time, not its sound (which now holds that air).
- **Quiet speech is voice, not a pause** (S2). A whole phrase without words, "es un keke." about 20 dB under normal
  speech (332.4–333.05 s), was cut as a pause: the classes call it non-speech (under the speech threshold) and the
  transcript has no words there. A run of non-speech frames above measured silence (≤ 30 ms of silence inside), at
  least `untranscribedMinS` long, peaking within 25 dB of the file's speech level, holding two vowels (three voiced
  frames in a row) with a dip of 6 dB under both between them — syllables, unlike a hum, a breath or a decay — is voice
  (`quietSpeech`): never a pause, untranscribed voice for review unless a word beside it holds it; the final frame
  check protects its voiced frames like speech. *Assumption*, labelled: one reported phrase, the reporter's description
  (voiced, rising and falling, 15–25 dB under the speech level); needs the voicing plane (the corpus voice has none, so
  the corpus is unchanged). How the hallucination guard weighs the classes: "Hallucinations need non-speech evidence"
  below.
- **Stretched words by the speaker's pace** (S3). "y es extra… ¡extremadamente!" was written as one "extremadamente"
  of 0.95 s (244.76–245.75); the > 1 s rule missed it. A word now also counts as stretched when it lasts at least 0.6 s
  and `STRETCH_RATIO` (3) times its syllables (vowel groups) × the speaker's median seconds per syllable over the
  transcript's words of two or more syllables up to 1 s (`stretch.ts`, ≥ 20 such words, else the 1 s rule only) —
  for the Clean Up finding (`frameFindings`) and the speech worker's hidden-take trigger (`suspectWindows` in
  `core/gaps.ts`; its per-word decode in `run.ts` keeps 1 s); `wordHold` keeps 1 s (a word's inside stays protected).
  *Measured* on the corpus (11,736 words of this speaker, pace 0.11–0.16 s per syllable, median 0.12): 56 words
  qualify at 3× (drawn-out "un", "mi", "de", "y", the stretched words of fragment E's hidden takes, phrase-final names
  such as "DirectX,"), 157 at 2×, 305 at 1.5×. **Limit**: the reported word itself is not caught. Its six syllables
  take 0.72 s at the speaker's pace, so 0.95 s is 1.3× — and the same speaker's clean "extremadamente" in run 9 (AG)
  lasted 0.88 / 0.92 s (1.22 / 1.28×). Duration cannot separate them; a ratio that low would flag hundreds of normal
  words. A restart inside a word needs another trace (a pause or a level dip inside the word's time, a second onset),
  which this round does not add.
- Corpus at the end of the round (Fast, corpus voice): dev 0.997 (2303 / 2311) / 0.960 (0.996 with asides proposed),
  held out 1.000 (338 / 338) / 0.973, held-out-r7 0.998 (479 / 480) / 0.870 (0.984), held-out-r9 0.992 (260 / 262) /
  0.976, held-out-r11 1.000 (65 / 65) / 1.000 — identical to round 11 (the corpus voice has speech under every word
  and no voicing plane, so the tails and quiet speech do not move word removals; the fragments are all for review).
- Limits left by round 12: a fragment for review that has no silence beside it (a word between two kept-for-review
  removals, or rejected) stays shorter than the minimum; the 80 ms pad, the 25 dB / 6 dB quiet-speech thresholds and
  the 3× / 0.6 s stretch rule need the real-audio rerun on the reporter's project; the syllable count is a vowel-group
  approximation (digits have none: the 1 s rule only).

**Hallucinations need non-speech evidence; head / tail on the script alignment** (round 13: real large-v3-turbo + Clean
Up of `cut_v5.wav`, the loudness-normalised mixdown of the user's 15:31 cut, at main 37fd05e43 with voice analysis v2,
`/tmp/je-words2-local/` on the build host; tests in `cleanup-mixdown.test.ts`, each failing on 37fd05e43):
- **Script words removed as hallucinations** (precision). Clean Up removed 21.8 s by default with 41 hallucination
  findings, all accepted: 37 were script words over audible voice ("que", "tarjeta", "hizo", "lo arreglen.", "su",
  "aparezcan", "fue"…, peaks −9.0…−27.7 dBFS, speech level −10.5, confidence 0.876–1.0). The prototype guard (TC-003)
  drops a word whose frames are under 20 % speech or breath, and voice analysis v2 still gives these short words 0–40 %.
  On a mixdown a low share is no evidence. Now a word is never dropped or flagged by the guard's share test, a known
  phrase over non-speech or the noise rule when the script says it in sequence (`ScriptAligner`, `script.ts`: at least
  3 of its 6 neighbours found in order around one occurrence of its token, the script side allowing one token more per
  side — `ALIGNED_SUPPORT`). The share test also spares a word the recogniser is sure of (confidence ≥ 0.8,
  `CONFIDENT_WORD`) and one whose loudest frame comes within 20 dB of the speech level around it (the lower of the
  file's speech level and the median loudest frame of up to 4 words each side within 10 s that are not over
  non-speech themselves — `NEAR_SPEECH_DB`, `nearSpeechLevel`). What is left is removed only over positive evidence:
  over measured silence (half its frames `silentFrame`) or outside the audio; any other share-test word is a
  hallucination for review. A known phrase over non-speech near the speech level (a real "gracias", or music) is for
  review; the noise rule (no vowel run, `LOUD_WORD_DB`) removes a confident word no more (review). Stock phrases,
  other writing systems, woven phrases and identical runs are unchanged. *Measured* basis: confidence — the 37 script
  words 0.876–1.0 (36 ≥ 0.976), the four flagged words without a script counterpart 0.18, 0.29, 0.77, 0.99 ("the",
  over voice), the raw source's clear inventions ("кстати.", a stretched "Y", "Ok,", "No,") 0–0.61, and the noise words
  of runs 6–9 were ASR suspects; level — the 37 sat at most 17.2 dB under the speech level. *Assumption*, labelled: the
  noise rule keeps 12 dB, not 20, because runs 7–9's noise words peaked ≈ 17–33 dB under that speaker's speech level
  (run 7's level was not recorded; run 11's −5.5…−9.5 dBFS), and the noise rule has its own vowel evidence. The V b and
  AA b noise tests now give their words confidence 0.3 (both were ASR suspects in the runs); a sure word over noise is
  reviewed.
- **Head / tail over scripted speech** (precision). With voice analysis v1 the same cut lost 681 s of 931 s: three
  head findings covered 0–666 s of scripted speech. Units are phrases split at `takeGapS` (0.6 s); a dense cut has no
  such pause, so no unit says one line (v2: no line said at all), and the first unit that did came into being only
  where the guard dropped words. The head now ends at the first word on script and the tail starts after the last —
  a said unit, or a word with `ALIGNED_SUPPORT` over every transcript word, the guard's included (never the voice
  classes), with the words before / after it that have 2 neighbours on script (`LOOSE_SUPPORT`: the transcript's
  first "Hoy" before "voy a ser mi propio Unity.") — and the unit holding that word stays whole (the closing
  "Suscríbete. ¡Chao!", "chau" in the script). The tail's off-script-share extension is unchanged. A head or tail
  longer than a quarter of the transcript's span (`HEAD_TAIL_MAX_SHARE`) or holding 5 words with 2 neighbours on script
  is only reviewed. *Assumption*, labelled: a quarter, from the TC-071 shorts' ≈ 10 s of pre-roll over 13 recordings.
- Offline replay (`/tmp/hm-replay/replay.mts` on the build host: the run's words, confidences and script with a
  synthetic voice — every word speech at −12 dBFS, the flagged words at their measured peak and speech share; the
  real voice file was not available): 37fd05e43 gives 39 hallucination removals (the run: 41) and no head / tail;
  with the 128 words v1 dropped (level unknown, −20 dBFS assumed) it gives v1's three head findings exactly
  (0.01–40.66, 41.04–464.13, 465.5–666.48 s). This round gives no hallucination finding and no head / tail in both
  (with the 128 at −40 dBFS — over silence, far under the speech — only the unsure, off-script "Y", "C.", "Mmm...",
  "un" and "eh." go, plus "suscríbete," and "Si" without the script);
  the only flagged word still removed is "eh." (a vocalic filler). The real-file rerun is pending.
- Raw source (600–1500 s, words and script of the same run, no voice): 37fd05e43's three head findings (2.71–6.33 and
  11.26–16.88 s, script lines said in a unit holding two; 52.54–54.41 s, the aside "¿Cómo que Linux no tiene
  esto... No puede ser") are gone — the aside comes after the first word on script and is no longer cut (its words
  are in the script's vocabulary, so the off-script rule does not take it either).
- Corpus (Fast, corpus voice) identical to round 12: dev 0.997 (2303 / 2311) / 0.960, held out 1.000 (338 / 338) /
  0.973, held-out-r7 0.998 (479 / 480) / 0.870, held-out-r9 0.992 (260 / 262) / 0.976, held-out-r11 1.000 (65 / 65) /
  1.000; the port fixture's guarded words and labels unchanged. Limits: the replay's voice is synthetic; the aligner matches
  exact normalised tokens (a misrecognised word counts against its neighbours, "ser" for "hacer"); a dense cut is one
  unit, so pre-roll said without a 0.6 s pause before the first line is never head; on a mixdown the floor lies
  within 6 dB of quiet words (−31.6 dBFS here), so an unsure, off-script, quiet word reads as over silence and goes;
  the 0.8 confidence and 20 dB levels come from one speaker's runs.

Kinds follow the structure: ≤ 2 words a false start, a whole clause (clause start, clause end, ≥ 3 content words) a
retake (with a group), else a restart; inside re-decoded ranges they become hidden retakes as before. The settings keep
their meaning (the windows, `retakeSimilarity`, `takeGapS`, `phraseGapS`, `falseStartGapS` for false starts by clause);
no setting was added, so `Sequence.cleanup` needs no schema change.

**Validation** (`cleanup-real-takes.test.ts`): the mechanism was developed against the dev fragments A–F, M, N, O, Q and
evaluated on the held-out G–L, P, R, S, T only at the end (`CLEANUP_CORPUS=dev|held-out`). Caveat: round 6's listening
judgements of P, R, S, T were read before the development (they define items 4, 5, 8, 9), so the held-out split
measures generalisation of the rules, not blindness to those failures. Metrics: each removing word finding's removed
words against the case's `dup` reference (a filler finding's filler or marker token is right too); recall = `dup`
words (fillers aside) removed. Measured (both modes, Fast, corpus voice):

| Split, code | Spec cases | Removed words precision | Repeat recall |
|---|---|---|---|
| dev, ff80a7438 + da2514402 | 34 / 34 | 0.997 (2394 / 2402) | 0.996 (2294 / 2303) |
| held out, first evaluation (da2514402) | 19 / 24 | 0.989 (271 / 274) | 0.774 (260 / 336) |
| held out after its fixes (0108b4021; no longer held out) | 24 / 24 | 1.000 (338 / 338) | 0.973 (327 / 336) |
| dev at 0108b4021 | 34 / 34 | 0.997 (2394 / 2402) | 0.996 (2294 / 2303) |
| round 8: run 7 (U–AB, both modes) at main 9031bd0f3 | 12 / 16 | 0.996 (456 / 458) | 0.812 (411 / 506) |
| round 8: run 7, first evaluation (f6b5d509f; held out) | 16 / 16 | 1.000 (541 / 541) | 0.974 (493 / 506) |
| round 8: dev / held out of round 6 at f6b5d509f | 34 / 34, 24 / 24 | 0.997 (2393 / 2401), 1.000 (338 / 338) | 0.996, 0.973 |
| round 10: run 9 (AC–AH, both modes) at main a8d587fcc | 4 / 12 | 0.973 (179 / 184) | 0.689 (175 / 254) |
| round 10: run 9, first evaluation (e1c59f1c1; held out) | 11 / 12 | **0.959 (260 / 271)** (excluding debatable spans, information only: 1.000) | 0.976 (248 / 254) |
| round 10 after the aside / false-start rules: dev | 34 / 34 | 0.997 (2303 / 2311) | 0.960 (2210 / 2303); 0.996 with asides proposed for review |
| … held out (round 6) | 24 / 24 | 1.000 (338 / 338) | 0.973 (327 / 336) |
| … held-out-r7 | 16 / 16 | 0.998 (479 / 480) | 0.870 (440 / 506); 0.984 with asides proposed for review |
| … held-out-r9 (no longer blind: it informed these rules) | 11 / 12 + AG-r9a expected failure | 0.992 (260 / 262) (excluding debatable, information only: 1.000) | 0.976 (248 / 254) |
| round 11: run 11 (AI–AN, both modes) at main 42d6ab3c6 | 8 / 12 | 0.984 (62 / 63) | 0.950 (57 / 60) |
| round 11 after its fixes: held-out-r11 (regression coverage, not blind) | 12 / 12 | 1.000 (65 / 65) | 1.000 (60 / 60) |
| … dev, held out, held-out-r7, held-out-r9 | unchanged | 0.997, 1.000, 0.998, 0.992 | 0.960, 0.973, 0.870, 0.976 (with asides proposed: 0.996, 0.973, 0.984, 0.976) |
| round 12 (slivers, sentence-end tails, quiet speech, stretch by pace): every split | unchanged | 0.997, 1.000, 0.998, 0.992, 1.000 | 0.960, 0.973, 0.870, 0.976, 1.000 |
| round 13 (hallucinations need non-speech evidence, head / tail on the script alignment): every split | unchanged | 0.997, 1.000, 0.998, 0.992, 1.000 | 0.960, 0.973, 0.870, 0.976, 1.000 |

Per kind at 0108b4021 (dev / held out): hidden-retake 0.997 / 1.000, retake 0.999 / 1.000, restart 0.998 / 1.000,
false start 1.000 / 1.000, stutter — / 1.000, filler-vocalic 0.943 / —, filler-phrase 1.000 / 1.000, hallucination
1.000 / —. The dev "wrong" words: two stretched lead "y" removed as drawn vowels (A c, O b; the corpus voice has speech
under every word, so the drawn-vowel rule sees them held), "que pueda ser" at the start of E r5a's second take (the
170f832bb reference kept it; the case's spec passes), and "¡No!" in M (the judgement wants it out; the reference
missed it). Missed: "Triste." and the hummed "¡Suscríbete al canal!" of M (the hallucination finding is review, and the
corpus voice has no frication planes), and in the held-out R b the garbled "de hecho fue mi pin -up -ge…" (not re-said:
kept). The first held-out evaluation failed G (a take holding its own restart), I a (two garbles in a row), R a (the
spec's "never" phrase matched the kept "rehechos" as an ASR variant — a test error, fixed) and R b, where "no lo
reescribí yo." was removed: the one false removal, fixed by rule 5's word-for-word requirement. The corpus asserts
precision ≥ 0.99 and recall ≥ 0.95 per split.

Round 8 (`CLEANUP_CORPUS=held-out-r7`): run 7 (main at 9031bd0f3, large-v3-turbo on CUDA, `/tmp/je-hr7-local/` on the
build host) adds 16 cases — U–Z with takes, AA and AB controls, default and chunked — with their spec and `dup`
references written from that run's listening judgements and duplicate references before the evaluation, and the
voice without words the judgements call retries (U, and W a's tail of "rarísimo.") as `voiced`. Development used the
dev split and round 6's held-out split; run 7 was evaluated once at the end and prompted no further change. Caveat, as
in round 6: run 7's bug reports (H1–H10) were read before the development and two unit tests use its words (U b, W
a), so the split measures how the rules generalise over the whole fragments, not blindness to those failures. The
main baseline reproduces round 7's live numbers (0.996 / 0.811). Missed at f6b5d509f: U a's first take (the default
run wrote it as garbage, "janeter … Pen 와 blah blah금u": a review finding here, and the speech re-decode now decodes
that span again — speech.md §11.3), W a's "o" before the removed restart (the retry was written without it) and Z a's
second "¡Llevo" (the recogniser wrote "Llevo, llevo" once). The one dev change: F's "Oh, | ¿cómo que…" is no longer a
filler phrase (an interjection that opens an exclamation, round 8 H8). Not measurable on the corpus voice (speech under
every word, no voicing plane): H5, H8's pause, H9 and the edges — their tests are synthetic (property, rules, cut
edges).

Round 10 (`CLEANUP_CORPUS=held-out-r9`): run 9 (main at a8d587fcc, large-v3-turbo on CUDA, `/tmp/je-hr9-local/` on
the build host) adds 12 cases — AC–AG with takes, AH the control, default and chunked — with their spec, `dup`
references and `debatable` spans (media time the judgements call editorially debatable: the AF aside "¿Dónde está el
enojado?", AG's pronunciation aside, AE's hum) written from that run's judgements before the development. Development
used the dev, held-out and held-out-r7 splits and unit tests built from the reported words (as in round 8, run 9's bug
reports were read first); run 9 was evaluated once, at e1c59f1c1: precision 0.959 (11 wrong words, all in debatable
spans — the AF aside, 8 words in both modes, which the new verbatim-attempt link took with its attempt as rule 4's
asides go in N and W, and AG's false starts "Cloud" / "Cloudcode Cloud," inside the pronunciation aside, also removed
at main), under the 0.99 requirement. A word removed in a debatable span counts as wrong in the asserted precision;
the precision without them is printed for information only, never as the gate. The first evaluation prompted the
precision-first rules below ("asides of take chains", "a false start restarts a sentence"), so run 9 is no longer a
blind split. The 6 missed words are H6's first take of the name, "(Se) llama Cloud Code / Cloudecode
(No,)" — linked to the later "Se llama Cloud Decode." neither by name nor by aside: the pronunciation aside between
them (25 words, 15 s) is beyond rule 4's limits; single-token variants such as "Code" / "Decode" already match
(`sameWord`, a third of the length in edits), one-to-two token variants ("Cloudecode" / "Cloud Decode") do not.
AG-r9a's spec case is an expected failure (`KNOWN_FAILURES`) for that reason; AG-r9b passes only because the chunked
run writes the name as one word. Not measurable on the corpus voice: H5 (the hummed-phrase level), H8 (the onset
ramp), H9 (noise words), the slivers — their tests are synthetic or use the reported words.

Round-6 items on this transcript corpus: 1 (N, a sentence twice) fixed by rule 4's aside; 2 (O, "o 3D" lost) by rules
2 and 5; 3 (Q, missed restart) by rule 3's broken-off last word; 4 (T, false positive) by rules 2 and 4 (no prefix, not
adjacent); 5 (R a, "tres" / "3") by number folding; 8 (reduplication) by rule 8; 9 (lead words, finished sentence) by
lead words and rule 5. Items 6, 7, 10 are frame-level ("No cut inside a kept word…" above). Not re-measured on audio:
the corpus voice is speech under every word, so edges, breaths, frication and the harsh-cut guard need the real-model
rerun.

Performance (spot measurement, not the bench harness: the full `bench/cleanup.ts` run did not finish within 10 min on
the loaded build VM, load 17–21): `detectCleanup` on the bench's synthetic hour (`hour(3600)`), min of runs through
tsx, 6 runs — 1.5 s at 0108b4021 (load 16) against 24.8 s for 170f832bb's detector on the same host (load ≈ 17); the recorded 42 ms of
`bench/cleanup.results.json` predates rounds 3–6 and was not re-measured.

Limits: the alignment is lexical — a restart that swaps a content word without a break-off mark ("y luego le puse, y
luego le añadí") stays (review at most); an aside longer than 16 words or 5 s keeps both takes for review; the
frication test is uncalibrated (review only); kind names changed for some links (a whole-clause restart is now a retake
with a group).

### Planning (TC-020 … TC-026)

`analyzeSequenceCleanup({doc, seq, voice, settings?, script?, language?, decisions?, scope?})` (dry run, never changes
the document):
1. Speech clips: enabled audio clips on audio tracks whose media has a transcript (all of them, or `scope.clipIds`
   with their linked partners and clip groups, inside `scope.range`). A reversed, retimed (≠ 100 %) or time-remapped
   one refuses the analysis with `E_UNSUPPORTED` naming it (TC-020).
2. One detection per media + stream over the words those clips play, with the sequence's settings (preset + overrides),
   script, edited lists for the transcript's language and rejected fingerprints.
3. Decisions: a finding is removed when accepted (`accept` ids / fingerprints > `reject` > `acceptKinds` /
   `rejectKinds` > persisted rejections > `suggested === 'remove'`); `retakes: {groupId: takeIndex}` keeps that take and
   removes the others.
4. Per clip: `planMediaCuts` (below) in media seconds; the "avoid harsh cuts" guard (TC-023): an accepted vocalic
   filler, marker phrase or stutter whose cut has no frame below the in-threshold within ±30 ms of either edge stays
   (`plan.skipped`, one re-plan).
5. Frames: each edge snaps to a frame boundary of the clip's placement — boundaries within `snapWindowS` (10 ms)
   compete on the level of their 10 ms frame (quietest wins), else an in point snaps down and an out point up (never
   into the word); then removed ranges shorter than `minCutFrames` (2) are not cut, the final frame check puts back
   what no accepted finding explains, and a kept piece shorter than `minSliverFrames` (10 since round 12, was 3) is
   joined to a neighbour, offered as a `fragment` finding or grown over silence (`resolveSlivers`, round 12).
6. A sequence range is removed only where **every** speech clip covering it removes it (two microphones on two tracks
   keep each other's speech).
7. `plan = {sequenceId, clipIds, ranges [{start, end, reasons}], kept, stats, skipped, fadeMs, jlFrames}`; reasons per
   range are the removed time's kinds by share (accepted word findings first, else the frame class: silence → pause,
   breath, speech → untranscribed). `stats = {inputDuration, outputDuration, removedByKind (s), joins, cutsPerMinute,
   deadAirPerMinute (non-speech seconds per output minute), largestSilenceLeft (joins included)}`.

`planMediaCuts` (prototype `cut` + the differences above): kept words' speech frames (± 50 ms) → join across gaps ≤
`maxGapS` (and rejected pauses) → cut non-speech runs > `maxGapS` inside → subtract removed words → edges: **level**
(TC-021; out = first frame after the last kept speech frame below reference + `outDb`, in = first frame from 80 ms
before the onset reaching reference + `inDb`, reference the noise floor or the speech level), **speech** (speech-frame
bounds) or **word** (word times; media without a voice analysis) → pads → breath before the onset (policy) → the gap
policy's air (`keepGapS` inside a sentence, `keepGapSentenceS` after . ? !, never into speech) → merge → drop pieces <
`minPieceS`.

| Preset | maxGap | air in / between sentences | edges | pads before / after | breaths | min piece | join fade | retakes, stutters, off-script, marker phrases |
|---|---|---|---|---|---|---|---|---|
| Fast (`builtin.fast`) | 0.12 s | 0 / 0 | level, floor + 20 / + 25 dB | 0 / 0 | removed | 0.25 s | 4 ms | removed |
| Natural (`builtin.natural`) | 0.45 s | 0.25 / 0.5 s | speech frames | 0.10 / 0.15 s | kept ≤ 600 ms | 0.4 s | 10 ms | review (restarts, false starts, vocalic fillers removed) |

User presets: `{id: cup_…, name, description?, basedOn?: builtin.fast | builtin.natural, settings: overrides}` in the
user library (below); `resolvePresetSettings`.

### Applying (TC-030 … TC-032)

- `cleanup.apply {sequenceId?, clipIds?, ranges: [{start, end} (frames) | {clipId, start, end} (media flicks)] (≤
  100,000), mode?: extract | lift | mute | markers, fadeMs? (0–30, default 0), jlFrames? (−30…30, default 0),
  markerName?}` — one command, one undo step. Speech clips = `clipIds` + the clips of source ranges (else every
  transcribed audio clip); targets = them + linked partners + clip-group members; a target on a locked track refuses
  with `E_TRACK_LOCKED` (blocking ids); source ranges on a retimed clip refuse with `E_UNSUPPORTED`; empty ranges and
  unknown clips with `E_INVALID_PARAM` / `E_NOT_FOUND`. Ranges are sorted and merged; the result lists every input
  range (`applied`, `reason`), `merged`, `frames`, `joins`, `tracks`, `fades`, `jl`.
  - **extract** = `cutRanges` with ripple: the targets' tracks and every unlocked sync-locked track lose the ranges
    (non-sync-locked tracks do not move; locked tracks never change), exactly what one `range.extract` per range on
    those tracks, right to left, gives (property-tested on random timelines with links, J / L edges, groups, sync lock,
    locked tracks and markers; ids aside), in one pass: each clip is cut by the ranges that overlap it (binary search),
    right parts after range k relinked per original link, then every clip and marker moves left by the removed frames
    before it (prefix sums). O((clips + ranges) · log ranges) plus the splits.
  - **lift**: the same cuts without the ripple.
  - **mute**: Volume keys on the targets' audio clips: −96 dB over each range with ramps of `fadeMs` (at least 1 ms;
    shortened to half the gap between close ranges), the clip's own keys inside a ramp dropped, values outside kept.
    A dB-linear ramp, not equal power. Reversed / remapped audio clips refuse.
  - **markers**: one range marker per merged range (`markerName`, default "Clean Up"), nothing else changes.
  - `fadeMs`: every cut edge of an audio clip gets `edgeFades` (below). `jlFrames` (extract only): at each join on the
    targets' audio tracks the sound edit rolls by n frames (> 0 the incoming sound leads: J cut; < 0 the outgoing lags:
    L cut) where the media has the handles and both pieces are longer than n; the others stay straight
    (`W_DURATION_CLAMPED` names how many).
- `cleanup.configure {sequenceId?, settings?: {presetId?, overrides?} | null, mergeOverrides?, script?: {name, text ≤
  256 KB} | null, lists?: {<lang>: {fillers?, markers?, allow?} | null}, reject?, unreject?, clearRejected?}` — partial
  updates of `Sequence.cleanup`, validated strictly (`E_INVALID_PARAM`; more than 20,000 rejections `E_LIMIT`).
- `transcript.removePauses` (TC-032) gains `mode: 'transcript' | 'level'`, `padBefore` / `padAfter` (s), `outDb` /
  `inDb`, `voice: [{mediaId, analysis (base64 of the voice-analysis file)}]` and `fadeMs`. Old calls behave exactly as
  before (transcript mode, `minSeconds` 1, `keepSeconds` 0.1 on both sides; `padAfter` / `padBefore` default to
  `keepSeconds`). Level mode runs the planner with every word kept, `maxGapS = minSeconds`, level edges (floor + 20 /
  + 25 dB) and the pads (default 0), and removes only time between the selected words; it needs the voice analysis of
  every clip's media (`E_INVALID_PARAM` names the missing ones; retimed clips `E_UNSUPPORTED`).
- `transcript.removeFillers` without `fillers`: per word, its transcript language's vocalic list — the sequence's
  edited list, else Spanish's; English and unknown languages keep `DEFAULT_FILLERS` (unchanged for old callers);
  `language` forces one; `fadeMs`. Both commands now ripple through `cutRanges` (the same result as before, in one
  pass). The MCP `remove_fillers` dry run uses the same default. Both default `fadeMs` to Clean Up's 4 ms join fade
  ("Join fades of range cuts" below); `fadeMs: 0` keeps hard cuts.
- New error code `E_UNSUPPORTED` (`commands/types.ts`, MCP hint).

### Join micro-fades through the audio fade model (TC-024)

Transitions are whole frames (≥ 33 ms at 30 fps); a 4 ms declick is not. `AudioClip.edgeFades = {inMs?, outMs?}` (0 <
ms ≤ 30) are equal-power fades inside the clip at its edges. `resolveAudioTransitions` turns them into `RenderAudioFade`s
with fractional `start` / `frames` and `edge: true`, so every consumer of the existing fade model renders them: the
offline mixer of every export path (`audioFadeGain` per sample), the preview mix graph (follows them with one-sample
automation pieces — the default 8-sample pieces missed a 4 ms quarter sine by 4.5e-4, measured), the Remotion layer;
inside a nested sequence `flattenNestAudio` keeps them as fades of the flattened piece (mapped through the nest clip's
placement, speed and direction) instead of sampling them per frame into `nestGain`. An edge that has an audio
transition plays the transition's fade only. A split gives the left part the fade in and the right part the fade out;
Join Through Edits gives the joined clip the left fade in and the right fade out. Interchange exporters cannot carry
sub-frame fades: every format (FCP7, FCPXML, OTIO, EDL, AAF, OMF) names them in its report ("not carried", instead
"hard cuts at its edges").

### Join fades of range cuts

`verify_export` on a user's 15:31 export flagged 19 `cut-click` rows (a sample step 12.5–29.7 dB over the local RMS
within ±10 ms of the cut). Clean Up's joins did not click; the flagged cuts came from `range.extract` /
`transcript_extract` and `clip.split` + ripple delete, which left hard butt joins: two moments of a recording meeting
mid-waveform make a sample step at the cut. Those edits now give the audio edges they cut the same fade as Clean Up
(`JOIN_FADE_MS` = the Fast preset's `joins.fadeMs`, 4 ms, `commands/join-fades.ts`), as `edgeFades` in the same
transaction (one undo step), so preview and every export path render them through the fade model above:

- `range.extract`, `range.lift`, `transcript.extract`, `transcript.lift` (`joinFades?`, default true): the new out edge
  of a piece ending at the range start and the new in edge of a piece starting at its end, on every audio track the
  cut touches (sync-locked followers included, as Clean Up's extract). Edges the range does not move (a clip that
  starts or ends exactly at a range bound) keep what they had. The result has `fades` (edges written). Picture
  clips never get `edgeFades`.
- `transcript.removeFillers` / `transcript.removePauses`: `fadeMs` defaults to 4 (was 0); `fadeMs: 0` keeps hard cuts.
- `clip.extract` (ripple delete; `joinFades?`, default true): a new butt join between two pieces of one recording
  (same media, not a through edit) — what `clip.split` + delete makes — gets the fade on both sides; sides that
  already fade keep theirs. A join between different recordings is a deliberate edit and stays as it was.
- `audio.smoothJoins {sequenceId?, tracks?, from?, to?, at?, fadeMs? (default 4, ≤ 30)}` [Smooth Audio Joins] for
  existing projects: both sides of every hard audio join — two enabled audio clips butted on a track whose sound jumps
  (another recording, or another moment of one; `isThroughEdit` is false) with no transition over the edit — in
  `[from, to]` of the tracks (default every unlocked audio track) get the fade; sides that already fade keep theirs.
  `at` (sequence frames, e.g. the `at.frame` of verify_export's cut-click rows) keeps the joins within one frame of
  one of them; the result `{joins, fades, fadeMs, unmatched?}` lists the times with no hard join. Refusals: a picture
  track `E_INVALID_PARAM`, a named locked track `E_TRACK_LOCKED`, `to < from` `E_INVALID_PARAM`. In the editor:
  Clip ▸ Audio Options ▸ Smooth Audio Joins (In to Out when both are set, else the whole sequence).

The fade is 4 ms on each side of the join, inside the clips (no handles needed): it attenuates at most the 4 ms next
to the cut and removes nothing. Measured in the offline mixer every export path uses (`join-fades.test.ts`, a 220 Hz
tone, a 31-frame extract that jumps a third of a cycle; verify_export's step-over-RMS measure): the hard cut is over
the 12 dB threshold, the faded join under it.

Limits: an edge that meets a gap (after a lift) is faded only when a range cut made it; `audio.smoothJoins` handles
butt joins only, not a clip that starts or stops abruptly next to silence. Nested-sequence audio and synthetic sound
clips are not `AudioClip`s and get no fades (a join inside a nest is smoothed by running the command on the nested
sequence). The click detection itself stays in verify_export: `audio.smoothJoins` does not listen; `at` narrows it to
the flagged cuts.

### Engine

- `POST /api/cleanup/analyze[?wait=1]` `{projectId, sequenceId?, document? (envelope or document), clipIds?, range?,
  presetId?, overrides?, script? | null, language?, decisions?, analyzeVoice?}` → `cleanup-analysis` job (priority
  interactive, 1 CPU slot). It reads the request's document or the live one (`agent.query doc.get`: the open editor's,
  else the saved project), reads or computes (child `voice-analysis` jobs, cancelled with the parent) the voice
  analysis of every speech media, resolves the settings (request preset → built-in or user preset; else the sequence's;
  then `overrides`) and runs `analyzeSequenceCleanup`. Result `CleanupAnalysisJobResult` = `{analysisId, url, findings,
  byKind, groups, ranges, stats, voice: {cached, analysed, missing [{mediaId, reason}]}, elapsedMs}`; media without a
  usable analysis (offline, not in the engine store, no audio, `analyzeVoice: false`) are planned in word mode and
  listed. Errors: refusals become job errors (`E_UNSUPPORTED`, `SEQUENCE_NOT_FOUND`, `PRESET_NOT_FOUND`,
  `VALIDATION_FAILED`; 422 with `wait=1`).
- `GET /api/cleanup/analyses/:id` → `CleanupAnalysisFile {format, version, analysisId, projectId, sequenceId, revision
  (−1 for a sent document), createdAt, analysis}` — the 16 newest analyses are kept in memory (they are cheap to redo:
  the voice analyses are cached); 404 `CLEANUP_ANALYSIS_NOT_FOUND` after that.
- User presets: `<appdir>/presets/cleanup-presets.json` (`appdirPaths().cleanupPresetsFile`), `GET / POST
  /api/cleanup-presets`, `PUT / DELETE /api/cleanup-presets/:id` (DELETE from an agent asks the user in the editor,
  as for effect presets), event `cleanupPresets.changed {revision}`. Serialized atomic writes, revision per change,
  unreadable entries kept aside in `invalid`, an unreadable file renamed `*.corrupt-<time>`, built-ins never stored
  (`builtin.*` → 404 read-only), at most 500 presets.
- Client: `EngineClient.analyzeCleanup(req, wait)`, `getCleanupAnalysis(id)`; presets through `call('cleanupPresets…')`.

### Validation (rerunnable, build VM)

| Check | Where | Result |
|---|---|---|
| Port = prototype (16 synthetic recordings, both presets) | `packages/project/test/cleanup-port.test.ts` | identical labels, guard decisions, kept ranges (1e-9 s), except the listed restart-coverage differences (3 recordings) |
| Golden Fast preset (TC-070): synthetic recording of voiced tones with known word timings (Whisper-like offsets), head chatter, an abandoned take, a false start, a filler between pauses, off-script chatter, an in-line restart, a standalone marker, breaths, long pauses, a cough; real voice-analysis code | `packages/project/test/cleanup-golden.test.ts` | removed words P = 1.00, R = 1.00; removed time P = 1.00, R = 0.89 (thresholds 0.9 / 0.9 / 0.95 / 0.85; 0.96 / 0.9 before round 12's sentence-end tails); largest silence left 0.02 s; last take chosen and named with its script line; cough flagged, kept, removed when accepted; in points within −40…+60 ms of the onset, out points in the decay; without a script P ≥ 0.9 (R 0.46: chatter needs the script); Natural keeps more, lists for review |
| Planning properties (fast-check, 300 + 200 runs): pieces sorted / disjoint / ≥ min piece, no removed word's sound kept, a kept word's loud core never split (unless the timestamps give part of it to a removed word), no non-speech run > maxGap (+ edge allowance) inside a Fast piece | `cleanup-property.test.ts` | pass |
| One-pass extract = successive `range.extract` (150 random timelines) + invariants | `cleanup-property.test.ts` | pass |
| `cleanup.apply` / `cleanup.configure` / removePauses / removeFillers: links, groups, sync lock, locked tracks, source ranges, fades, J / L, lift / mute / markers, 1,500 ranges, undo (previous document untouched) / redo (same timeline), refusals, invariants (`verify` mode) | `cleanup-commands.test.ts` | pass |
| Mixer: equal-power curve sample by sample over 192 samples at both sides of a join, the same inside a nested sequence, transitions win; INV-CLEANUP and repair (idempotent) | `cleanup-render.test.ts` | pass |
| Range cuts / `clip.extract` / `audio.smoothJoins` join fades: faces only, untouched edges, opt-outs, existing fades kept, through edits skipped, `at`, refusals, one revision, previous document untouched, invariants; the joins in the offline mixer under verify_export's 12 dB click threshold (hard cut over it) | `join-fades.test.ts` | pass |
| Preview while playing (headless Chrome, Web Audio) = export across a cleanup join | `packages/compositions/test/audio-preview-mix-oracle.test.ts` "cleanup joins" | worst 3.0e-8 (threshold 1e-4) |
| Interchange reports edge fades (6 formats) | `packages/interchange/test/cleanup-edge-fades.test.ts` | pass |
| Engine job = pure analysis of the same samples (16 kHz WAV through FFmpeg), cache reuse, word mode, refusals; preset CRUD, restart, invalid entries, corrupt file, user preset drives the analysis | `apps/engine/test/cleanup.test.ts` | pass |

### Performance (TC-060, pure half) — measured

`pnpm exec tsx packages/project/bench/cleanup.ts` (results: `packages/project/bench/cleanup.results.json`); fixture:
one hour of synthetic speech (7,148 words, 360,000 voice frames), a 30 fps sequence with the hour on linked V1 +
A1 and music on a sync-locked A2. Build VM (AMD EPYC-Rome, 16 vCPU, Node 24.22.1), 2026-10-26, under the shared bench lock, load average 12.3 → 11.5 (other agents' test runs; the benchmark is single-threaded), production invariant mode (incremental); 1 warm-up + 7 runs, medians.

| Case | Median | Target |
|---|---|---|
| `detectCleanup`, 1 h (Fast) | 42 ms (31–72) | ≤ 200 ms |
| `analyzeSequenceCleanup`, 1 h (detect + plan + frames + stats) | 142 ms (136–164); 882 ranges, 28.7 cuts / min | — |
| `cleanup.apply`, 1,500 ranges, one transaction (production invariant check), 4 ms fades | 453 ms (428–620); 4,503 clips after, 1 revision = one undo step | ≤ 2 s |

### Limitations

- The UI (TC-040 … TC-044) and the MCP tools (TC-050, TC-051): "Clean Up UI and MCP" below.
- Calibration on the user's material (TC-071): below; it found and fixed the head / tail rule (tail side). It predates
  the restart / retake coverage rule, which is not re-measured there (needs the private harness).
- Edge placement uses the file's noise floor (as the prototype); the per-60 s window levels are not used yet.
- "Quietest sample region" snapping works on the 10 ms frames of the voice analysis, not on samples.
- Mute mode ramps in dB (exponential-like), not equal power; at least 1 ms.
- English word lists are an assumption (not measured on English material).

## Clean Up UI and MCP (TC-040 … TC-044, TC-050, TC-051, TC-060 UI side, TC-070, TC-071)

Branch `feat/wf-cleanupui`. The editor's review of a cleanup and the agent tools, on the core above.

### Where the code lives

| Layer | File | What |
|---|---|---|
| Review helpers (pure) | `packages/project/src/cleanup/review.ts` | `cleanupFindingMedia` (a finding's media, by its fingerprint prefix), `cleanupFindingFrames` (where it plays in the sequence), `cleanupRejectionChanges`, `cleanupApplyCommands` (the Apply transaction) — shared by the editor and MCP so both apply the same edit |
| Derived preview | `packages/session/src/derived-preview.ts`, `react/index.ts` `useDerivedPreviewDocument` | a temporary timeline the Program monitor plays (never committed, saved or in History); frame maps `toDerivedFrame` / `toOriginalFrame` |
| Web | `apps/web/src/panels/text/cleanup/` | `controller.ts` (per-session state: analyze, review, decisions, re-plan, apply, previews), `model.ts` (pure UI model), `planner.ts` + `plan.worker.ts` (live re-planning off the main thread), `CleanupMode.tsx`, `SettingsDrawer.tsx` + `settings-fields.ts`, `ScriptDrawer.tsx`, `FindingsList.tsx`, `CleanupTranscript.tsx`, `RetakeGroups.tsx`, `TimelineOverlay.tsx`, `register.tsx` (Program chip) |
| Web wiring | `panels/text/TranscriptTab.tsx` (Edit / Clean Up switch), `commands/cleanup.ts`, `commands/keymap-defaults.ts`, `shell/menus/model.ts`, `panels/program/ProgramMonitor.tsx`, `panels/timeline/TimelinePanel.tsx` | menu, commands, keys, Program and Timeline hooks |
| MCP | `apps/mcp/src/tools/cleanup.ts`, `server.ts` | `analyze_voice`, `plan_cleanup`, `apply_cleanup`, `set_cleanup_settings`, `attach_script`; `CLEANUP_GUIDE` in the server instructions and the resource `jasper://guide/cleanup` |

### The Clean Up mode (TC-040)

Text panel ▸ Transcript has an **Edit / Clean Up** switch; **Sequence ▸ Clean Up Voice…** (and the Text panel menu, UI
command `transcript.cleanUpVoice`) opens it. Its toolbar: **preset** (Fast, Natural, the user presets of the engine
library; "(edited)" when the sequence overrides it — choosing one is an undoable `cleanup.configure` that drops the
overrides), **Settings…**, **Script…**, **scope** (whole sequence, In to Out, selected clips — a missing In / Out or
selection refuses with a reason) and **Analyze** / **Analyze Again**.

- Settings drawer: every value of `CleanupSettings` (14 rules remove / review / off, 22 detection thresholds, 7
  edit-point values, 5 gap / breath values, 5 guards, 2 join values) with its unit — s, ms, dB, %, words, letters,
  frames (`settings-fields.ts`; a test checks the drawer covers the schema key for key and that the shown bounds map
  inside the schema's). Each change is one undoable `cleanup.configure {mergeOverrides}` (repeated edits of one field
  coalesce); edited fields are marked; **Reset to preset**; **Save as Preset** (engine library, `basedOn` the current
  built-in, the user preset's values plus the overrides) and **Delete Preset** (user presets); **Word lists** per
  language (Spanish, English): fillers, discourse markers, emphasis repeats — empty = the built-in list.
- Script drawer: paste or load a text file (≤ 256 KB, the size shown), attach / update / detach (`cleanup.configure
  script`, undoable); after an analysis it lists the script lines never said.
- Analyze sends the committed document (an envelope) to the engine's `cleanup-analysis` job, so the analysis is of
  exactly what the editor holds; progress and stage come from the job (polled every 300 ms) with **Cancel** (cancels the
  job and its voice-analysis children). The editor stays usable: the long part runs in the engine.

### Review (TC-041, TC-042)

- **Statistics** (live, `plan.stats`): length before → after, cuts, cuts per minute, dead air per minute, longest
  silence left, the four largest removed kinds; notes for media without a voice analysis (cut at word timings),
  fillers kept by "avoid harsh cuts", script lines said.
- **Findings list**, grouped by kind in a fixed order (retakes, restarts, false starts, repeats, fillers, filler
  phrases, discourse markers, off-script, head / tail, pauses, breaths, voice without words, transcription suspects,
  hallucinations, isolated fragments) with "n of m cut" per kind, **Cut all / Keep all** per kind (clears the item decisions of the kind),
  and per row ✂ cut / ↺ keep / ▶ play 1 s around it, the time, the reason in the user's language, the confidence.
  Virtualised: fixed row heights, only the rows in view (± 240 px) are in the DOM; the current row is kept in view.
- **Transcript** (the analysed words, virtualised in blocks of ≤ 80 words measured as they render): what the plan
  removes is struck through — exactly the words whose midpoint lies in a removed range, i.e. what Apply cuts — in the
  colour of the accepted finding's kind (retake red, restart orange, false start mango, repeat rose, filler purple,
  filler phrase violet, discourse marker lavender, off-script cyan, head / tail teal, pause blue, breath cerulean, voice
  without words yellow, suspect warning, hallucination magenta; design tokens); review findings not accepted have a
  dotted warning underline; lexical fillers are lighter; pauses, breaths and voice without words are chips where they
  sit. A click selects the finding and seeks.
- **Retake groups**: each group's takes side by side (time, mean probability, complete / cut off, share of the script
  line), the kept one ticked; a click keeps another take (`decisions.retakes`).
- **Keys** (Text panel scope; enabled only while a review is open in Clean Up mode and no text field, list box or
  dialog has the focus, so they never take a key from another panel or from typing; the Text panel had no bindings
  before): ↑ / ↓ previous / next finding, Enter cut, Backspace / Delete keep, U clear, Shift+Enter / Shift+Backspace the
  whole kind, Space ±1 s, Shift+Space play the result, Esc stop a preview, Ctrl+Enter (mac Cmd+Enter) Apply.
  **Auto-advance** (default on) moves to the next finding after a decision.
- **Timeline overlay** while reviewing: every removed range across the tracks (danger tint), and on the speech clips'
  tracks the padding at the edges of each kept piece (non-speech before its first / after its last speech frame,
  success tint) and the kept pauses inside it (non-speech runs ≥ 100 ms, warning tint). Hidden once stale or in Edit
  mode.
- **Re-planning**: every decision and every settings / script / list change re-runs `analyzeSequenceCleanup` with
  the analysed document and the voice analyses (fetched once after the job) in a worker (`plan.worker.ts`; main
  thread after a yield where workers are unavailable; the engine job again if a voice analysis could not be fetched).
  Only the newest answer is used. A change of what the analysis read — the sequence's clips, tracks, links, groups,
  frame rate, or the transcripts or media — marks the review **stale**: Apply and the previews refuse with "The
  sequence changed since the analysis: Analyze again".
- **Play result** builds the plan applied (the same `cleanup.apply` Apply would run) as a derived preview: the Program
  monitor plays it (chip "Playing the Clean Up result (not applied)" with Stop), the session's document, History and
  saved state are untouched; the playhead is mapped into the shorter timeline and back on Stop (re-seeked after the
  Player has the sequence back). **Play removed** plays only the removed ranges. A preview ends on Stop, Esc, any
  committed edit (stale), a gesture, or closing.

### Apply (TC-043)

One transaction labelled "Clean Up Voice: N cuts" (N = removed ranges; localised): `cleanup.configure` with the
rejections to remember (findings rejected by item or by kind that the sequence does not remember yet) and to forget
(remembered ones accepted now), then one `cleanup.apply` (extract, the plan's fade and J / L offset). One undo step;
Redo re-applies it. Later analyses keep remembered rejections unless accepted again.

### MCP (TC-050, TC-051)

| Tool | Annotations | What |
|---|---|---|
| `analyze_voice {projectId, sequenceId? \| clipId? \| mediaId?, preset?, settings?, script?, language?, from?, to?, inOut?, offset?, limit?, include?, kinds?}` | read-only | the engine job (progress notifications; cancelling the request cancels it); summary (`analysisId`, revision, settings, media, stats, cuts, per-kind found / suggested / accepted, skipped) and pages (≤ 1000 per list, `nextOffset`) of findings (id, kind, suggestion, accepted, confidence, text, English reason, media seconds, sequence frames + timecode, words, group, fingerprint), retake groups, removed ranges and script lines. `mediaId` analyses the whole media on a scratch sequence sent with the request (media time; not applicable) |
| `plan_cleanup {… , decisions?}` | read-only | the same with decisions: accept / reject (ids of the same analysis or fingerprints), acceptKinds / rejectKinds, retakes `{groupId: takeIndex}` |
| `apply_cleanup {… , decisions?, analysisId?, mode?, rememberRejections?}` | destructive | plans on the live document and applies `cleanupApplyCommands` as one transaction "Agent: Clean Up Voice: N cuts" with `expectedRevision` = the revision planned; `E_STALE` when `analysisId` is of an older document; refused (`E_APPROVAL_DENIED`) when the project turned off "Allow agents to apply transcript-cleanup proposals" (spec 15 EA-001, default on); no approval card otherwise (no command of it needs one, AGENTS / `approvalReasons`) |
| `set_cleanup_settings {preset?, settings?, merge?, reset?, lists?, clearRejected?, unreject?}` | edit, idempotent | `cleanup.configure` |
| `attach_script {text \| path \| detach, name?}` | edit, idempotent | `cleanup.configure script` (absolute UTF-8 file ≤ 256 KB of text) |

Arguments are strict (unknown keys are errors at any depth); failures are tool errors with a code and a hint. The
guide (server instructions and `jasper://guide/cleanup` "Cleaning up speech") gives the recommended policy: accept the
removals; review retake groups — last complete take unless cut off, much less probable or further from the script;
never cut "untranscribed" findings without listening; decide review findings; check `largestSilenceLeft` (≤ ≈ 0.25 s)
and cuts per minute (Fast ≈ 17–23) before applying.

### Responsiveness (TC-060, UI side) — measured

`pnpm exec tsx apps/web/bench/cleanup-review.ts` (results `apps/web/bench/cleanup-review.results.json`): the hour of
`packages/project/bench/cleanup.ts` (7,148 words, 1,277 findings, 883 removed ranges), one decision. Build VM (AMD
EPYC-Rome, 16 vCPU, Node 24.22.1), 2026-10-26, under the shared bench lock, load average 10.8 (other agents' test
runs; the bench is single-threaded); 1 warm-up + 7 runs, medians.

| Work per decision, 1 h | Where | Median |
|---|---|---|
| re-plan (`analyzeSequenceCleanup` with the decision) | planner worker | 151.6 ms (137.5–166.3) |
| transcript marks (`wordMarks`) | main thread | 6.1 ms |
| findings list (`groupFindings` + `listLayout`) | main thread | 1.2 ms |
| inline chips (`inlineFindings`) | main thread | 0.8 ms |
| timeline bands (`overlayBands`) | main thread | 2.3 ms |

The main thread's share is ≈ 10 ms per decision for an hour, plus rendering what is in view (both lists are
virtualised). On the dev stack (VM, Chromium, the generated 17 s clip) a second Analyze with the voice analysis cached
took 1.2 s from the click to the review.

### Calibration on the user's material (TC-071) — measured

The research prototype's scoring (`.prproj-analysis/research/edits/mac/autocut.py` `score`, unchanged) run on the
**shipped** code: a Node harness bundled from the branch (`VoiceFeatureExtractor` → `buildVoiceAnalysis` →
`analyzeSequenceCleanup` with the Fast preset, the item's script attached, one audio clip at 100 % on a 59.94 fps
sequence; private harness `.prproj-analysis/box/cleanup-calib/calib-shipped.ts`) on the 16 items of the edits research
(13 shorts, 3 long: the raw mic recordings decoded to 16 kHz, mlx-whisper turbo word timings, the user's real cuts as
ground truth), on the user's Mac (Mac16,6, M4 Max, macOS 26, Node 22.21.1; load average 1.0–2.1 from other activity;
the shared heavy-compute lock held for the 60 s analysis pass over ≈ 6.5 h of audio). Scored inside the user's range
(their first to last kept piece); P / R and edges are means over items, output / user and dead air medians.

| Run | Removed words P / R | Removed time P / R | User edit points ≤ 50 / ≤ 150 ms | Output / user (range) | Dead air s/min |
|---|---|---|---|---|---|
| prototype `fast`, shorts | 0.901 / 0.778 | 0.982 / 0.952 | 0.719 / 0.826 | 1.085 (1.05–1.57) | 0.61 |
| shipped Fast before the fix, shorts | 0.795 / 0.820 | 0.960 / 0.955 | 0.605 / 0.776 | 1.007 (0.91–1.90) | 0.68 |
| **shipped Fast, shorts** | **0.890 / 0.808** | **0.979 / 0.954** | **0.642 / 0.824** | **1.082 (1.00–1.90)** | **0.68** |
| shipped Fast at 30 fps, shorts | 0.889 / 0.806 | 0.979 / 0.953 | 0.651 / 0.815 | 1.082 (1.00–1.91) | 0.73 |
| prototype `fast`, long | 0.909 / 0.794 | 0.991 / 0.980 | 0.719 / 0.845 | 1.088 (1.01–1.19) | 0.42 |
| **shipped Fast, long** | **0.880 / 0.821** | **0.990 / 0.977** | **0.696 / 0.848** | **1.101 (1.06–1.20)** | **0.51** |

Findings and fix:
- **Fixed — the head / tail rule cut paraphrased closing lines.** It cut everything after the last speech unit that
  matched a script line at ≥ 60 %; the user rewords the outro, so in 12 of 13 shorts the last line never matched and
  the closing sentences were cut (head / tail precision 0.17: 31 of 187 flagged words were removed by the user). The
  tail now ends at the last unit on script — one that says a line or, after it, one that passes the off-script
  vocabulary test (≥ `offScriptMinTokens` content tokens, ≥ `offScriptSimilarity` of them in the script). Head / tail
  precision on shorts 0.42 (8 of 19); time kept outside the user's range over the 13 shorts 10.0 s (prototype 30.1 s,
  before the fix 3.1 s), long 1.8 s. Regression test `cleanup-rules.test.ts` "a paraphrased closing line is not tail
  chatter" (fails before the fix). A symmetric head side was measured and rejected: it kept 24.9 s of the pre-roll the
  user cuts, for +0.003 shorts precision.
- **Edit points ≤ 50 ms: 0.64 / 0.70 against the prototype's 0.72**, by the deliberate differences listed in "Port of
  the research prototype" (ablation on shorts, one change at a time, relative to the code before the head / tail fix): strict removal (+0.027 at ≤ 50 ms when off; also
  long precision 0.880 → 0.902, recall 0.821 → 0.792), the centred 25 ms analysis window (edges ≈ 7 ms later than the
  prototype's window, signed out-point median +17 ms vs +9 ms; +0.024 at ≤ 50 ms with the prototype's window, no
  change in precision / recall). The ≤ 150 ms share equals the prototype's. Frame grid (30 / 59.94 / 1000 fps), the
  frame guards, the harsh-cut guard, the added rules (stutter, drawn vowels, lexical review, hallucination phrases),
  keeping voice without words for review and an engine-style float decode instead of the int16 WAV changed nothing
  or ≤ 0.003 on the aggregates.
- **Output / user up to 1.90 (one chatty dev-session short)**: speech without words that the spec keeps for review
  (48 findings, 30 s on that item); accepting them (or the agent policy after listening) removes it.

Conditions and limits: the same 16 items the prototype was tuned on (no held-out set); raw Whisper word timings
without the engine's word-bound refinement or segment scores; only aggregates are recorded here (the per-item results
stay on the Mac, `~/JasperAnalysis/work/edits/cleanup-calib/out/fast`).

### Validation (rerunnable, build VM)

| Check | Where | Result |
|---|---|---|
| Derived preview: never touches the document / History, ends on edits / gestures / close, refusals; frame maps inverse (fast-check) | `packages/session/test/derived-preview.test.ts` | pass |
| Review helpers: media and frames of findings, rejections remembered / forgotten, the Apply transaction (one transaction, the sequence shorter by the removed frames, rejection persists in a re-run) | `packages/project/test/cleanup-review.test.ts` | pass |
| Head / tail regression (paraphrased closing line kept; chatter after it removed; strict head) | `packages/project/test/cleanup-rules.test.ts` | pass; fails on the previous detector |
| UI model: decisions, word marks = plan ranges, grouping / virtual geometry (fast-check), navigation, timeline bands, previews, scope, staleness, the settings drawer covers the schema with valid bounds | `apps/web/test/cleanup-model.test.ts` | pass |
| UI: Analyze through the job, stats, findings, struck words, retakes; decisions / retake / settings re-plan; Play result (derived, nothing committed, playhead mapped back) and Play removed; Apply = one entry "Clean Up Voice: N cuts", rejection remembered, Undo / Redo; staleness; failures shown, Cancel; review keys enabled only in review and not while typing; Sequence ▸ Clean Up Voice… | `apps/web/test/cleanup-ui.test.tsx` | pass |
| MCP: strict, annotated tools, guide and resource; pages; clip / media targets, presets and overrides; refusals; plan with decisions; apply in one transaction with the rejection; agent-proposals setting; `E_STALE`; settings and script | `apps/mcp/test/cleanup.test.ts` | pass |
| Browser e2e on a generated clip (`scripts/fixtures/cleanup.mjs`): analyze, review, keep / re-cut a finding, overlay, Play result, Apply (picture and sound cut together), Undo | `e2e/cleanup.spec.ts` | pass (VM, Chromium; `e2e/captions.spec.ts` still passes with the Edit / Clean Up switch) |
| Dev stack (VM, Chromium): menu → Clean Up → Analyze → keys ↓ / Backspace re-plan → Play result chip → Stop → Apply → History "Clean Up Voice: 5 cuts" → Ctrl+Z | manual, screenshots inspected | as described |

### Limitations

- The Timeline keeps drawing the sequence while "Play result" plays the shorter derived timeline (as "Hear proposal"
  does): its playhead follows the derived frames until Stop maps them back.
- "Cuts" in the History label counts removed ranges (head and tail included), not joins.
- The analysis job's progress has no ETA; a first voice analysis of an hour takes ≈ 10 s on the build VM (measured in
  "Voice analysis").
- The review of a sequence ends when another sequence is analysed (one review per editor session).
