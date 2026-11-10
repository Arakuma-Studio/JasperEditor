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
- The type and the file are stable for version 1; a change of features or classes bumps `VOICE_ANALYSIS_VERSION`, a
  change of layout bumps `VOICE_ANALYSIS_FORMAT`.

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
strict removal below, which are deliberate differences; the restart coverage below changes labels in 3 of the 16
recordings (seeds 2, 3 and 7), which the test lists word by word with the port's labels (kept ranges unchecked there).

Deliberate differences from the prototype (labelled):
- **A restart / retake must re-say what it removes** (Clean Up report on a 57-min Spanish video: 29 of 81 restart
  findings rejected). The prototype's restart rule cut from any earlier copy of a repeated 3-gram (or content 2-gram) up
  to the repeat, never checking the words in between: lists ("el tema oscuro de Unity, la barra de menús de Unity"),
  comparisons ("mis juegos en mi motor funcionan mejor que mis juegos en Unity") and a 2-gram said again in the next
  sentence lost words said once (one finding: 30 s). A restart now needs the continuation (the next 2 × attempt-length
  words) to repeat all the attempt's content words in order (lexical markers such as "pues" exempt) and
  every number. The take rule keeps its ≥ 60 % LCS share but the later take must re-say every number (digits or number
  words, `lists.ts` `numbers`): "Me quedan nueve días" is no retake of "Me quedan seis días y…". In the port fixture the
  change only drops cross-sentence restarts and keeps the first words of a last take the prototype cut; a true restart
  that swaps its last word ("y luego le puse, y luego le añadí…") is no longer flagged — not distinguishable by tokens
  from a list ("o tipo caricatura, o tipo de goma"). Regression test `cleanup-rules.test.ts` "restarts and retakes
  re-say what they remove". A cut-off last word counts as re-said by a word that starts with it ("Y funcionan con
  cual…" → "cualquier"; large-v3-turbo fragment D, where the middle false start stayed between two takes). Since the
  third large-v3-turbo run the restart rule also (`ruleRestarts`):
  - matches the re-said words across ASR variants (`sameWord`: "brillito" / "brillitos", "efecto" / "efectos") and
    lets an attempt of ≥ 6 content words keep up to 15 % (at least one) unmatched;
  - starts the retry where the words before both copies still match, one ASR substitution between two matches allowed
    ("que pueda ser en un mes…" / "¿Que puedo hacer en un mes…"), so the first word of the last take is never cut;
  - leaves one or two words without content after a pause, said into the restart point (< 0.15 s before it), to the
    retry ("… en un par | En el Jasper Engine": the n-gram matched "el Jasper Engine"); a word apart from it stays in
    the attempt (run 4, fragment E: "de" 0.43 s before "¿Que puedo hacer…" was left out of the hidden retake);
  - follows a chain: when an attempt is not said again right after, but its n-gram comes back in later attempts, each
    within the window of the one before, the attempts up to the last copy whose words it says (any order, the same
    garble allowance) are one restart ("…que puedo hacer … dólares. ¿Qué puedo hacer…? ¿Qué puedo hacer…? … ¿Que puedo
    hacer … dólares?", fragment E).
  An ending re-said right after a run of retries (the longest ending of ≥ 3 words, 2 of them content words, that the
  words after the run start with, within 3 more words) goes with the retries (`detector.ts`).
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
  with < 0.3 s gap, or a cut-off word "jue- juego"; allow-list "no no", "sí sí", "ta ta ta"…), lexical markers at a
  clause start followed by a comma or ≥ 150 ms (review, confidence 0.3), head / tail (with a script; the tail ends at the last unit on script — a said line or, after it, a unit passing the off-script vocabulary test — see "Calibration"), ASR suspects
  (confidence < 0.4, words < 40 ms or > 2.5 s, segment scores: compression ratio > 2.4, mean log-probability < −1,
  no-speech probability > 0.6 — read from the speech worker's `Transcript.segments` when present, ignored when absent),
  known hallucination phrases over non-speech (share of speech frames < 0.5).
- Spanish vocalic fillers are the prototype's `STRICT_FILLERS` (eh, em, emm, ehm, mm, mmm, hmm, mhm, ah, aah, eeh, ehh,
  uh, um, eee, ee, aa, m, e). The spec's "a / aa" is read as the drawn-out vowel: the bare preposition "a" is never a
  filler (it would cut "voy a casa").
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
head-tail, untranscribed, asr-suspect, hallucination. `suggested` is the rule's action (`remove` / `review`); `off` rules do not
run.

Fingerprint (TC-013): `<mediaId>~<stream>~<kind>~<round(start × 10)>~<round(end × 10)>~<fnv1a(normalised text)>` —
100 ms resolution; a repeated identical one gets `~2`, `~3`. Rejected fingerprints persist in `Sequence.cleanup.rejected`
and keep their findings unaccepted on later runs.

Take groups: the units the take rule linked (unit a said again as unit b) are joined with union-find; each take has its
range, words, text, mean probability, script line and coverage (with a script) and `complete` (≥ 60 % of the
distinct content tokens the group's take saying the most says, or of the best coverage — distinct, so a take that
re-says itself inside says no more: large-v3-turbo fragment E's first take, "¿Qué puedo hacer…" three times in 32
words, made the final 18-word take that alone says "de millones de dólares" incomplete, and the cut dropped it).
Chosen: the last complete take; with a script an earlier take covering ≥ 20 % more of the line wins (its retake /
false-start / restart labels are cleared and the other takes, the last one included, become retakes). **Safety
check** (every group, retakes and hidden retakes alike, `losesContent`): a cut never removes real content — content
words (no stop word, ≥ 3 letters) and numbers — that the kept take does not say — else the latest take whose choice
loses none is kept, and with none the takes that would lose words are only suggested for review (a later take
removed then reads "Later take", `reason.params.later`). Words match across ASR variants (`sameWord`, `lists.ts`):
equal, the same number ("9" / "nueve"), equal after Spanish sound folding (silent h, b/v, c/z/s, qu/k, ll/y, w/u),
within a third of their length in edits ("Inunity" / "Unity", "vivecoder" / "wavecoder", "pueda" / "puedo"; 4+
letters), or a cut-off last word as a prefix of its completion; up to 15 % (at least one) of a take's words may stay
unmatched when it has ≥ 6, never two in a row ("de millones de dólares" on E always counts). Trailing sentences of
an earlier take that the later kept take mostly does not say are an aside, not content ("… toda su vida. ¿Y por qué
va a decir puta?"), so a clean last take is kept over the take with the aside. The first version matched words
exactly and turned the second large-v3-turbo run's good cuts ("las piensas" / "los pies", "Inunity", "vivecoder")
into review-only takes — leaving one sentence twice in fragment E — and kept fragment B's aside take over the clean
last take. The kept take is reported as what stays of it: words its own restarts, false starts or fillers remove at
its edges are trimmed from its range, words and text (fragment A: "… para poder subirlos" said again right after),
so no finding overlaps it; a restart in its middle still lies inside (limit). Takes are compared on what they say once
their own restarts are out (a unit that restarts inside says no more than its last attempt; fragment C's "meterle …
quise, meterle … tener en Unity," joined its group only so), with ASR variants; a unit a restart removes whole is still
an earlier take of what follows but never the later take of a hit, and the tail of an attempt whose start a restart
removed is a take of a later unit that says all of it. Real content counts what stays after the kept take within the
restart window too (fragment E's "pueda ser" is said by the last question, not by the kept "Ok, wow…" take). What
lies between a group's first take and its kept take within the restart window goes with the retries: fragments of
≤ 2 words ("No,", "a ver", "no.") and units whose words the kept take mostly says ("En toda su puta vida", "Y el otro
1 %"). The aside of an earlier take is the longest run of its trailing sentences the later kept take mostly does not
say. Only the
take rule's labels carry the group id; a restart inside a take keeps none, so its reason names the words that re-say
it. Script (TC-012): lines are sentences (. ? ! … and line breaks); a unit says a
line when ≥ 60 % of its content words appear in order in it (LCS); the report lists every line and whether a take says
it.

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
whisper-large-v3-turbo transcripts of the six ~80 s fragments of the reporter's recording from runs 2, 3 and 4 of the
hidden-retake test, every mode (re-decode on, `chunking: "vad"`, re-decode off), 30 distinct transcripts, text and
times only, plus the speech without words and the silence inside a word the reporter measured (run 4, fragment E:
voice at 38.14–39.34 and 39.80–42.10, silence in the stretched "de" after 42.10). The spec is written by hand per
fragment as the speaker meant it — phrases the edit says exactly once (the last clean take of each sentence, and what
only one take says: "millones de dólares" on E), phrases it never says (asides, garbled takes, cut-off attempts), no
run of five words twice, every word all kept or all removed (within a frame), the measured wordless voice of E (an
attempt) removed, and no kept take of a group losing a word — and two invariants for every case: every second removed
between the first and the last word lies within a finding that removes (or 0.1 s and a frame of it), and rejecting
every finding removes nothing there. It runs through `analyzeSequenceCleanup` (Fast preset, 30 fps, speech under every
word). At 0b492215c 12 of the first 24 failed (B ×5, C b, D ×2, E ×4); at f11b859fb 13 of 30 and the rejection
invariant failed (the run-4 E cut of 1.8 s without a finding; words split by the kept word's ±50 ms of sound and frame
snapping; a 0.12 s gap cut without a pause finding); all pass now. Limit: without the re-decode
(fragment A, mode c) "a" stretched over the second "poder subirlos" (1.03 s) goes as a drawn vowel, so that case
asserts "poder subirlos" and "la Play Store" apart.

An accepted removal of words takes the voice without words inside it (`sequence.ts`): an untranscribed span kept for
review never punches a hole into it (run 3, fragment E: "Que puedo hacer en un mes lo mismo" had no words at
38.14–39.34 inside the hidden retake 31.88–42.48), and the detector proposes such voice for removal with the run of
retries around it (`suggested: remove`, still reviewable). Test: `cleanup-hidden-retakes.test.ts` "voice without words
inside a removed retake goes with it".

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
  47.67 / 56.3 grazed onsets — all edges of pause cuts); after speech followed by speech (a join) it starts where the
  decay falls below the level edges' out threshold (the calibrated Fast out point inside the decay); at a tail it
  starts at the first silent frame — no silence within 0.25 s, no tail pause.
- **Decisions**: a pause is cut only when its finding is accepted. Every path plans through `analyzeSequenceCleanup`
  (the editor's planner worker, the engine job behind `analyze_voice` / `plan_cleanup`, `apply_cleanup`), so a rule
  set to review removes nothing anywhere until its findings are accepted.
- **Final frame check** (`sequence.ts` `keepUnexplained`, after frame snapping and the frame guards): every sequence
  frame whose media time is not inside an accepted finding or a removed word's sound stays; beyond a finding's edge at
  most one frame may go, and only over measured silence (the frame grid cannot follow a finding's edge). A short piece
  or a sliver the guards would drop stays rather than merging into a cut.
- **The last kept piece keeps its fading tail** (`keepTail`): it grows over the decay after it (frames above measured
  silence, outside removed words' times) to silence, ≤ 0.25 s — a join may cut inside a decay, the clip's end may not.
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

Spoken symbols: a word that is only a symbol said as a word and punctuation ("%", "%...", "€", "$", "&", "+", "@",
"°") is a candidate word with the symbol's name as its token ("porciento" / "percent"), so it covers its sound: the
second large-v3-turbo run left "%" ("por ciento", −10 to −24 dBFS) of a removed restart audible as voice without words
in every mode, and opened a hole inside an accepted restart.

Frame findings (with a voice analysis): **pause** = a non-speech run longer than `maxGapS` between speech frames inside
the words' span; **breath** = a breath-like run within 30 ms of speech; **untranscribed** = see above. A rejected pause
is kept by the planner; a breath is kept before an onset when rejected (Fast) or unless accepted (Natural's `keep`
policy, ≤ 600 ms).

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
   into the word); then removed ranges shorter than `minCutFrames` (2) are not cut and kept slivers shorter than
   `minSliverFrames` (3) are dropped.
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
| Golden Fast preset (TC-070): synthetic recording of voiced tones with known word timings (Whisper-like offsets), head chatter, an abandoned take, a false start, a filler between pauses, off-script chatter, an in-line restart, a standalone marker, breaths, long pauses, a cough; real voice-analysis code | `packages/project/test/cleanup-golden.test.ts` | removed words P = 1.00, R = 1.00; removed time P = 1.00, R = 0.96 (thresholds 0.9 / 0.9 / 0.95 / 0.9); largest silence left 0.02 s; last take chosen and named with its script line; cough flagged, kept, removed when accepted; in points within −40…+60 ms of the onset, out points in the decay; without a script P ≥ 0.9 (R 0.46: chatter needs the script); Natural keeps more, lists for review |
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
  hallucinations) with "n of m cut" per kind, **Cut all / Keep all** per kind (clears the item decisions of the kind),
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
