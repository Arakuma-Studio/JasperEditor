# wp script-correction: script-guided transcript correction (spec 17)

## Speech scoring and glossary prompts

Package `scscore` (spec 17 SC-030…037, SC-040, SC-074, SC-075, SC-092, SC-103). Code:
`apps/engine/src/speech/worker/score.ts` (job), `worker/whisper.ts` (`encodeRange`, `scoreReadings`,
glossary carry and guard), `core/glossary.ts` (pure prompt composition and guard), `worker/cli.ts`
(`jasper-speech score`), `speech/service.ts` (`SpeechService.score`), `packages/api/src/speech.ts`
(`SpeechScoreRequestSchema`, `SpeechScoreResultSchema`, `TranscribeOptions.glossary`), MCP `transcribe {glossary}`.
Research behind it: the private scriptfix spike (FINDINGS §2.5, §2.6, §6, §7; prototype `mac/sfscore.py`, mlx).

### Scoring (SC-032, SC-040)

- **Window encoding**: samples [start, end) (≤ 30 s, else `SPEECH_WINDOW_TOO_LONG`) are read as mel frames from the
  frame of `start` and zero-padded to 3000 frames — the same window construction as transcription (whole-file
  normalisation, OpenAI `transcribe()` slicing). Windows sharing a range (several candidates of the same audio) are
  processed together and encoded once; the job reports `encoderPasses`.
- **Tokens**: `[sot, lang, transcribe, notimestamps] + Σ encode(' ' + word) + [eot]` (English-only models:
  `[sot, notimestamps] + …`, as their alignment pass). Per-word `encode(' ' + word)` concatenated = GPT-2
  pre-tokenisation of the words joined by spaces, so token spans map to words (not `splitToWordTokens`, which splits
  punctuation off). No prompt (research: a 60-word previous-text prompt changed 6.4 % of decisions and was 4× slower).
  Refusals (`SpeechRefusal`, worker exit 4, never retried on another device): `SPEECH_TOKENIZER_CANNOT_ENCODE`
  (tokenizer without BPE merges), `SPEECH_READING_TOO_LONG` (> 448 tokens), `SPEECH_WINDOW_TOO_LONG`,
  `SPEECH_WINDOW_OUT_OF_RANGE`, `SPEECH_LANGUAGE_UNKNOWN`, `SPEECH_LANGUAGE_UNSUPPORTED`, `INVALID_SPEC`.
- **One uncached decoder pass per reading**, batched (default 8 per pass, fewer when the logits + cross-attention
  of the batch would exceed ≈ 256 MB), right-padded with `eot`: the decoder is causal, so padding never changes an
  earlier row (test: batch 1 and batch 8 give equal scores and times).
- **LL** = Σ over every text token and `eot` of the full-vocabulary log-softmax (timestamps included in the
  normaliser, as the prototype's `logits − logsumexp`); row p − 1 predicts token p. Per word: token count, Σ
  log-probabilities, mean token probability (full vocabulary; the confidence of a fixed word, SC-041). Reading
  `tokens` = text tokens + 1 (eot). A non-finite score (fp16 overflow on a GPU) fails the attempt, which reruns on
  the CPU.
- **Forced times** from the same pass: cross-attention of the model's alignment heads over the window's frames,
  OpenAI `find_alignment` (z-score over the rows, median filter, mean over heads, DTW) via the transcription's
  `alignTokens` / `wordTimings` — SC-040 "the worker's existing heads and filters" — then `refineWords` against the
  audio (energy VAD, the voice analysis' presence frames when it already exists) with `keepAll` (one timed word per
  scored word; bounds repaired, grown and tightened, nothing dropped). Clamping into [previous end, next start]
  is the caller's (the aligner knows the neighbours).

### Delivery

- `jasper-speech score <spec.json> <out.json>`: same protocol as transcription (NDJSON `progress` per scored reading
  and `device` per attempt; exit 0 / 2 / 3 / 4 refused / 130 cancelled). The spec (`ScoreJobSpec`, zod-validated in
  the worker): `{modelDir, modelId, input: {path, stream?, ffmpeg} | {f32}, language, threads?, device?: {encoder,
  decoder, calibrate?}, files?, scratch?, durationSec?, voiceAnalysis?, batch?, windows: [{id, start, end (samples),
  readings: [{id, words}]}]}` (≤ 20,000 windows, ≤ 64 readings, ≤ 224 words of ≤ 128 characters). Output
  (`ScoreJobOutput`): `{modelId, language, samples, windows: [{id, readings: [{id, logprob, tokens, words: [{text,
  tokens, logprob, probability, start, end}]}]}], timings: {decodeMs, loadMs, scoreMs}, device: {encoder, decoder,
  threads, fallbacks}, profile: {encoderPasses, readings, decoderRuns, encoderMs, decoderMs, windowSec}, guard:
  {frames}}`. The media is decoded once (streamed), the model loaded once.
- Devices (SC-035): `withDeviceFallback` (shared with transcription): session fallbacks recorded, a GPU error →
  the job once more on the CPU inside the worker, a crashed GPU worker → once more on the CPU by the engine; the plan
  is transcription's (encoder on the best GPU, decoder where its calibration put it — scoring runs no greedy steps,
  so it never calibrates).
- Cancellation (SC-036): checked between windows and batches in the worker; `SpeechService.score` SIGTERMs the
  worker on abort and SIGKILLs it after 1 s, and the worker itself exits 1 s after SIGTERM even mid-ONNX-run (test:
  a worker ignoring SIGTERM ends within 2 s).
- `SpeechService.score(req: SpeechScoreRequest, signal: AbortSignal, opts?: SpeechScoreOptions):
  Promise<SpeechScoreResult>` — engine-internal, no route (the `transcript-fix` job of `scengine` calls it with
  `{onProgress, log, trackChild, scratchDir, threads}` from its job context). Request (strict zod): `{mediaId (the
  engine media key = the asset's engine-store locator key), language, model?, device?: auto|cpu|gpu, streamIndex?,
  windows: [{id, start, end (media flicks, ≤ 30 s), readings: [{id, words}]}]}`; flicks → samples with floor/ceil,
  results back with `round(samples × 44100)`. Result: `{device (SpeechDeviceReport), model, fallback? (job-level
  first, then session, then unavailable), windows: [{id, readings: [{id, logprob, tokens, words: [{text, tokens,
  logprob, probability, start, end}]}]}], timings?}`. Errors: `JobError {code, message, retryable: false, detail?}`
  (`INVALID_SPEC`, `ASSET_NOT_FOUND`, `NO_AUDIO`, `MEDIA_OFFLINE`, `SPEECH_MODEL_*`, `BINARY_MISSING`, the refusals,
  `SPEECH_SCORE_FAILED`, `JOB_CANCELLED`). Additions to the spec's SC-092 shape (all optional): `streamIndex`
  (multi-stream media), `timings`.

### Glossary prompts (SC-074) and the guard (SC-075)

- `TranscribeOptions.glossary?: string[]` (≤ 40 terms, each ≤ 64 characters, trimmed; normalised — whitespace,
  duplicates by normalised form — and part of the transcription dedupe key). The caller chooses the terms (script
  proper/English terms + personal glossary, most frequent first: `scalign` / the web Transcribe option); the engine
  only carries them.
- Prompt text `" Term1, Term2, Term3."` (the research form). Carried into every window like openai-whisper's
  `carry_initial_prompt`, but only the glossary: the verbatim / custom initial prompt keeps OpenAI's default
  semantics (carrying the verbatim prompt into every window derailed tiny.en, speech wp-note §11.3). Window prompt =
  [what remains of the initial prompt in the running text] + glossary + [later previous text], ≤ 223 tokens; the
  oldest running text goes first, never the glossary; terms that do not fit after the initial prompt are left out
  (`guard.glossary.terms` = carried terms). Decision (assumption, not measured): the glossary sits after the initial
  prompt as the spec orders it; the research's `verbglossC` carried both.
- Guard: after a window's decode with the glossary, when one carried term occurs ≥ 3 times with starts within 10 s
  (1–6 consecutive words whose normalised concatenation equals the term's, so split/glued spellings count), the window
  is decoded again with the same seed and without the glossary; the unprompted result (text, segments, word times) is
  kept when its text differs. Reported as `guard.glossary {terms, tokens, events, replaced}` in the worker output,
  `TranscriptionResult.guard` and MCP `transcribe`.
- MCP `transcribe {glossary?: string[]}` (strict schema, the caps above) with the tool description and
  `SPEECH_GUIDE` updated. Web: the Transcribe dialog's "Names from: Off / Script / Script + glossary" needs the term
  extraction (`scalign`) and the personal glossary (`scglossary`), so it is left to the `scweb` package.

### Tests

- `apps/engine/test/speech-score.test.ts` (fake ONNX Runtime, 14): LL incl. eot over the full vocabulary (exact
  value), the decoder input `[sot, notimestamps] + words + [eot]` without a prompt, row p − 1 → token p with
  context-dependent logits (per-word tokens / log-probabilities, eot outside every word), batching equivalence (3
  passes vs 1), one encoder pass per distinct range and request order kept, forced DTW times in media samples,
  refusals (each code; a refusal on a GPU plan is not retried), cancellation between windows, GPU fault → CPU retry,
  session fallback, no calibration, CPU failure not retried; glossary normalisation, composition and cap (property
  test), whole-term budget, guard matching, carry into the prompt, guard re-decode (replaced / same text).
- `apps/engine/test/speech-score-service.test.ts` (fake worker, 6): flicks ↔ samples, device plan without
  calibration, spec shape; validation errors; crashed GPU worker → CPU retry with `fallback`; refusals and failures
  as JobErrors (refusals not retried); cancellation ≤ 2 s with a worker that ignores SIGTERM; glossary validation,
  normalisation into the spec, dedupe key, guard report.
- `apps/mcp/test/speech.test.ts`: `transcribe {glossary}` passed through, > 40 terms / > 64 characters refused.
- `apps/engine/test/speech-score.e2e.test.ts` (SC-103, real models; gated like `speech-model.e2e`; `SPEECH_SCORE_BENCH=1`
  adds the cost run): see the measurements.

### Measurements (build VM, 2026-10-27)

Machine: orquester build VM, 16 shared AMD EPYC-Rome vCPU, 30 GB, Node 24.22.1, onnxruntime-node 1.30.0, CPU only,
8 threads; models downloaded by the engine's pinned catalogue (`whisper-tiny.en`, `whisper-large-v3-turbo` fp32).
Fixture `fixtures/speech/lj-composite.flac` (public domain, 71.6 s, 12 sentences; 57.9 s = 0.966 min of speech by
the fixture's measured utterance bounds). Windows: the transcript's words split at gaps ≥ 1 s and packed to ≤ 28 s
(3 windows). Rerun: `JASPER_SPEECH_MODELS_DIR=<dir> [SPEECH_SCORE_BENCH=1] pnpm exec vitest run
apps/engine/test/speech-score.e2e.test.ts --maxWorkers=1` (`SCORE_MARGIN` / `SCORE_BENCH` lines).

**SC-103 / margin re-check** (measured; 10 typical confusions of fixture words, e.g. block→black, wall→war,
carton→cartoon; Δ_tok = (LL_script − LL_asr) / max region tokens):

| Model (ONNX fp32) | corrupted transcript: Δ_tok min / median / max | corrupted script: Δ_tok max | script word times vs truth |
|---|---|---|---|
| whisper-tiny.en | 2.86 / 7.71 / 9.68 (10 of 10 ≥ −1.5: fixed) | −2.86 (10 of 10 < −1.5: kept) | start/end errors ≤ 50 ms |
| whisper-large-v3-turbo | 3.07 / 8.84 / 11.20 (10 of 10 fixed) | −3.07 (10 of 10 kept) | ≤ 30 ms |

Truth for word times = the uncorrupted transcription's word bounds (which `speech-model.e2e` holds within
18 ms mean / 40 ms max of the fixture's measured sentence bounds); utterance-initial/final words are also checked
against those bounds. The spike's mlx fp16 turbo distribution for corrupted phonetic neighbours (Spanish, n = 240):
p50 −9.75, p99 −2.34, max −1.82; here (English read speech, n = 10) turbo's corrupted-script Δ_tok p50 −8.84, max
−3.07 — the same range, so the Standard margin −1.5 keeps a ≥ 1.5 nats/token gap on these cases. Limits: n = 10, read
English, no natural recognition errors; the Spanish re-tuning belongs to the Mac accuracy harness (SC-105). With
unpacked windows (8 windows, one per gap-separated part) the same 20 cases also passed (min Δ_tok 2.38 tiny.en,
2.85 turbo).

**SC-037 cost** (measured, bench lock held, load average 4.0 → 8.6 from other agents' typechecks and dev stacks;
turbo, CPU, batch 8; the research rate of 6.3 candidate readings per speech minute → 6 candidates + 3 ASR readings;
median of 3 runs):

| Measure | Value |
|---|---|
| Scoring wall time (1 job: decode 0.6 s, model load 5.8 s, scoring 18.4 s) | 26.2 s = 27.1 s per speech minute |
| Scoring without the once-per-job load and decode | 18.4 s = **19.0 s per speech minute** (target ≤ 20 s: met) |
| of which encoder (3 passes) / decoder (3 passes, 9 readings) | 15.2 s (5.05 s per window, 83 %) / 1.56 s |
| Transcription of the same audio, no previous text (`conditionOnPreviousText: false`) | 34.2 s (RTF 0.367) = 35.4 s per speech minute |
| Transcription, default (previous text) | 28.4 s |
| Unpacked windows (8 encoder passes) | 49.6 s per speech minute (packing to ≤ 28 s is essential) |

≈ 13 s per speech minute on long recordings (estimate; basis: the research's 2.3 packed windows per speech minute ×
5.05 s + 8.6 readings × 0.17 s, load amortised). Mac and NVIDIA figures: not measured here (SC-105 harness / a GPU box).

**Glossary on a real model** (measured, same VM): turbo greedy with the glossary Wilkins / Abingdon / pantaloons
carried (3 terms, 11 prompt tokens): WER 2.56 % (§11.7 of the speech wp-note: 1.92 % without), "Abingdon" spelled
right, 0 guard events. One English clip only; the research's Spanish glossary effects (names 73 % → 94 % exact,
some chatter dropped) are not re-measured here.

### Limitations

- The editor's window packing (SC-030) and decisions (SC-033/034) are `scalign` / `scengine`; the e2e test has its own
  copy of the packing rule.
- Scoring always zero-pads to 30 s: the encoder costs the same for a 5 s and a 28 s window.
- `refineWords` uses the energy VAD of the whole file plus the voice analysis only when it already exists (scoring
  does not start one).
- GPU scoring paths are covered with the fake ONNX Runtime only (no GPU on the VM).
