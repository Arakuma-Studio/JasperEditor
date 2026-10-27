# Script-guided transcript correction (spec 17)

Work note for [spec 17](../specs/17-script-correction.md). Each work package of the programme keeps its own section.

## Model (alignment, candidates, decisions)

The pure model: `packages/project/src/script-fix/`, public entry `@jasper/project/script-fix`. It has no commands,
persistence, engine or UI code. Everything is deterministic and never throws: inputs over the bounds come back as
`{ok: false, code: 'E_LIMIT'}`, and malformed score results give no score.

Pipeline for each media transcript (SC-014):

`parseScript` → `alignTranscript` → `findFixCandidates` → `buildScoreWindows` → engine scores
`scoreRequestWindows(windows)` (SC-092) → `candidateScores` → `decideFix` → `replaceWordsEdit` (the SC-050 edit).

Method and numbers come from the scriptfix spike: private research
`.prproj-analysis/research/scriptfix/FINDINGS.md`, cited below as F§n, with its prototype `sfcore.py`, `sfalign.py`,
`sfjobs.py`, `sffinal.py` and `mac/sfscore.py`. Wherever spec 17 differs from the spike, the spec wins, and the
difference is listed below.

### Script (SC-002, F§2.1)
- Tokens split on whitespace. Glued words are split at `/` and `…` between letters.
- Each token keeps its 0-based `line`. `section` increments at each heading line.
- Kinds:
  - `paren`: inside `(…)`.
  - `heading`: a line of ≤ 8 words that starts with `short | guion short | video largo | largo | intro | outro`
    (case and accents ignored) or ends in `:`.
  - `word`: everything else.
  - `paren` and `heading` tokens are directions: skipping them is free and they are never offered as fixes.
- A standalone `&` reads `y` (es) or `and` (other languages).
- `summary` gives the counts the drawer shows: sections, direction groups and tokens, heading lines and tokens.
- Proper-noun evidence for SC-023 is collected per normalised word:
  - brand-like spelling, i.e. mixed case such as `iOS` or digits between letters;
  - or capitalised in more mid-sentence occurrences than it is written in lower case.
  - Sentence starts and all-caps words (scripts contain random capitals, F§2.7) don't count.
- Deliberate differences from `script_tokens`:
  - **Lines ending in `:`.** The spike only accepted such lines when they had no letters; the spec accepts any line
    ending in `:`.
  - **Accents.** Heading keywords ignore accents.
  - **Unclosed `(`.** It ends at the next blank line. In the spike it ran to the end of the script.
  - **`&`.** It is a word (F§5.4).

### Normalisation, numbers, phonetic similarity (SC-010 … SC-012, F§2.1–2.2)
- Normalisation is the cleanup's `cleanupNorm`. Function words are the cleanup's stop lists, plus the spike's Spanish
  additions (`ha he han e u ni nos`).
- Numbers from 0 to 999,999 in Spanish (the spike's `num_es`) and English:
  - A token written with digits (plus an optional unit suffix such as `3d` or `60s`) matches its spoken form in
    either language: `24` = `veinticuatro` = `twentyfour`, `3d` = `tresd`.
  - `un`, `una` and `one` = `1`.
  - Multi-word numbers match through merge cells: `treinta y dos` ↔ `32`.
- Phonetic key: exactly the spike's `pkey` (rules in SC-012).
  - English drops the Spanish `ll`, `qu`, `gu`, `g(e/i)` and `c(e/i)` rules, so every `c` becomes `k`.
  - Other languages have no key.
- psim = 1 − weighted Levenshtein / longest key. Equal keys score 0.95; equal strings 1.
  - Costs: `PSIM_SUBSTITUTION_COSTS` and `PSIM_INDEL_COSTS`, the tables of SC-012.
  - They are held in integer tenths, so psim is exactly symmetric.
  - The neutral fallback uses unit costs on the normalised strings.

### Alignment (SC-013 … SC-016, F§2.3)
- Viterbi over transcript tokens with three states: H (aligned), I (transcript word inserted) and OFF.
- Cells, moves, weights and the 1:1 Dice prefilter (key bigrams ≥ 0.45) are the spike's `align`, `sim_matrix` and
  `merge_cells`. Identical digit tokens score +3, as in `sim_matrix`.
- **Bounded cost (SC-015) without changing the result.**
  - Every cell of a row can be reached by a landing at the same base: a jump from the row's best cell (−4) or an
    entry from OFF (−2).
  - A cell scoring below that base can never lead to a better path than the landing, so it is dropped.
  - Consequently only positions whose 1:1 score is ≥ −max(insertion, offWord) can survive a landing. These come from
    the vocabulary similarity index.
  - Merge cells are generated row by row. Candidates come from length-sorted bigram postings, visiting only the key
    lengths that can still reach psim 0.7. The distance stops early once it exceeds the threshold.
  - Validation:
    - **Dense port.** A dense, line-by-line port of the spike's DP (`test/script-fix-reference.ts`) gives the same
      score and path on 300 random fast-check cases.
    - **Prototype paths.** The prototype's own paths are reproduced step for step on 7 invented cases
      (`test/fixtures/script-fix-parity.json`).
- **Degenerate input only.** A word repeated more than about 1,000 times hits per-token caps (sole approximation):
  - live cells, `maxActivePerRow` (shrunk to fit `maxStoredCells`);
  - landing positions and merge cells, the ones nearest the previous best cell;
  - `maxMergeCellsPerRow`.
  - Such rows are counted in `report.cappedRows`, which is 0 on the 2 h benchmark.
- `E_LIMIT` above 200,000 transcript words or 60,000 script tokens.
- Report (SC-016): exact, substituted, inserted and off-script token counts and shares, backward jumps (retakes),
  skipped script tokens, used and unused script lines. `unusedScriptLines` combines the reports of several media.

### Candidates (SC-020 … SC-026, SC-073; F§2.4, §4.2, §5)
- **Regions.** Maximal runs of non-exact steps between exact cells, with no jump or OFF inside. They need anchors on
  each side (≥ 2 exact cells, or one exact content word) and at most 4 + 4 words.
- **Kinds.**
  - `sub`; `merge` (a merge cell inside the region); `del` (script-only words).
  - `ins` is never offered: an ad-lib can't be told from an ASR insertion (F§5.3).
  - As in the spike, a region may combine a merge with an inserted word. The candidate then replaces both, and the
    audio decides.
- **Never offered** (`skippedCounts`):
  - any digit on either side;
  - script words with a letter repeated three or more times;
  - regions touching directions;
  - unanchored or oversized regions;
  - rejected fingerprints (unless `includeRejected`);
  - glossary hits overlapping a script candidate.
- **Categories** come from the script side:
  - `proper`: brand-like, a proper-noun norm of the script, or a glossary target word;
  - `english`: Spanish transcripts only — `ENGLISH_LOANWORDS`, or English spelling hints such as `sh`, `th`, `ck`,
    `oo`, `ee`, `ph`, `w`, `k`, or a final letter that Spanish words don't end in;
  - `function`;
  - `other`.
- **Joins (SC-024).** An exact merge cell whose token counts differ (`glimmer box` ↔ `Glimmerbox`) becomes a
  no-audio `join`, but only when the script side is proper. `me dio` ↔ `medio` stays as it is.
- **Mixed regions (SC-025).** These are split at step boundaries into proper/English runs and plain runs. Each part
  is decided on its own (`mixed: true`), which fixes F§4.1's single false correction.
- **Glossary (SC-073).**
  - Input: `{from: string[], to, lang?}`. Entries in another language are ignored.
  - Matching is greedy: longest `from` first, left to right, no overlaps.
  - Candidates are `proper`. An entry that changes only the split or casing (same normalised concatenation) needs
    no audio.
- **Display form (SC-031, F§2.7).** `script` holds the replacement words exactly as written into the transcript:
  - script spelling, with outer punctuation removed;
  - script casing for proper words only;
  - the ASR region's leading `¿¡«"(` and trailing `.,;:!?…»")`;
  - the first word capitalised when the ASR word was (mixed-case names such as `iOS` keep their case).
- **Fingerprint (SC-026).** `sf1~<media>~hash64(asr norms | script norms | ±2 context norms)`. It contains no times,
  so it survives re-transcription. Repeated takes share it, and `id` adds `#2`, `#3`, ….

### Windows, scores, decisions, edits (SC-030 … SC-034, SC-040 … SC-042; F§2.5–2.6)
- **Windows.**
  - Split at gaps ≥ 1 s. Stretches longer than 28 s split at their largest gap; ties go to the middle (`sfjobs.windows`).
  - Consecutive stretches are packed into windows of ≤ 28 s (spec addition).
  - Padding is 0.25 s before and 0.35 s after, at most half the gap and 20 ms clear of the neighbouring words
    (`sfjobs.bounds`, clamped so a window never starts after its first word).
  - Only windows with candidates are returned. A candidate spanning two windows, or an insertion at a window edge,
    is returned as `unplaced`.
- **Readings.** Reading `asr` holds the window's ASR words. One reading per candidate replaces its region with the
  display words.
- **Δ.**
  - Δ = LL_k − LL_0.
  - Δ_tok = Δ / max(script-region tokens, ASR-region tokens, 1).
  - Region token counts are sums of the SC-092 per-word `tokens`.
- **Decision (SC-034).**
  - No-audio joins and glossary spellings: `spelling` group, `deltaTok: null`.
  - `del`: fixed when Δ_tok ≥ 0.
  - `sub`, `merge`, `glossary`: fixed when Δ_tok ≥ the audio margin. Otherwise the spelling rule applies: a `proper`
    or `english` candidate with psim ≥ 0.8 is fixed when Δ_tok ≥ the spelling margin.
  - Otherwise: Maybe (unselected) when Δ_tok ≥ the Maybe margin, else keep.
  - Fixes decided by audio, including the spelling rule, go to the `fix` group. `rule` names which rule applied.
- **Edits.**
  - Audio-decided words take reading k's forced times, clamped in order into `bounds`: from the previous word's end
    to the next word's start, with zero-length neighbours excluded (SC-040).
  - Confidence = the word's forced `probability` (SC-041).
  - No-audio fixes spread the words over the region's span by character count (`spreadTokens`, SC-042), with no
    confidence.
  - `replaceWordsEdit` returns `{start, end, expect, words}`: the span the words lie in, the exact old texts (`[]`
    for `del`) and the new words.

### Defaults

| Group | Setting | Value |
|---|---|---|
| Cells (`ALIGN_DEFAULTS`) | exact content / function word | +3 / +1.5 |
| | mismatch | max(−1.5, 4·psim − 3) |
| | merge cells | psim ≥ 0.7, (4·psim − 3)·(a+b)/2 (exact 3·(a+b)/2) |
| Moves | insertion | −1 |
| | skip ≤ 8 | 0.5 + 0.5 × spoken tokens; directions free |
| | jump | −4 |
| | OFF | −2 enter, −2 leave, −0.4 per word |
| | Dice prefilter | 0.45 |
| Candidates | anchors | 2 exact cells or 1 exact content word |
| | region | ≤ 4 transcript + ≤ 4 script words |
| Bounds | E_LIMIT | 200,000 words / 60,000 tokens |
| | live cells per token | 1,024 (≤ 30,000,000 stored) |
| | merge cells per token | 512 |
| Windows (`SCORE_WINDOW_DEFAULTS`) | split | gaps ≥ 1 s |
| | length | ≤ 28 s, packed |
| | pads | 0.25 s / 0.35 s, ≤ ½ gap, 20 ms clear |
| Decisions (`DECISION_PRESETS`) | careful | audio −1.0, spelling −4 (psim ≥ 0.8), del 0, Maybe −3 |
| | standard | audio −1.5, spelling −5, del 0, Maybe −4 |
| | generous | audio −2.0, spelling −5, del 0, Maybe −4 |

### Validation
- **`test/script-fix-parity.test.ts`.** Prototype outputs from running the spike code with `nice` on the host, on
  invented Spanish text only (4 hand-written cases and 3 seeded random ones):
  - phonetic keys and psim (15 pairs);
  - script tokens;
  - alignment paths, step for step;
  - offered regions;
  - unpacked windows and bounds (hand-written cases only — the random cases have equal gaps everywhere, so the
    prototype's split is a floating-point tie).
- **`test/script-fix-golden.test.ts`** (SC-101). Invented es and en cases covering:
  - names, merges, joins, `del`, `ins`, retakes, off-script chatter;
  - directions, headings, `&`, numbers, stylised spellings, mixed regions, display form;
  - fingerprints, rejections, glossary;
  - the decision table and the Maybe band;
  - windows → fake scores → Δ_tok → edit, and malformed results.
- **`test/script-fix-property.test.ts`** (SC-100, fast-check):
  - parser and aligner never throw and are deterministic;
  - every transcript token is covered once, in order;
  - E_LIMIT is returned at the bounds;
  - the aligner equals the dense port;
  - candidates sit between exact anchors, are never `ins` and contain no digits;
  - psim is symmetric and in [0, 1].
- **`test/script-fix-perf.test.ts`** (SC-015). A load-scaled 5 s budget on the 2 h case, plus a bounded degenerate
  case.

### Measurements
`pnpm exec tsx packages/project/bench/script-fix.ts`. Results are in `packages/project/bench/script-fix.results.json`.
- Conditions:
  - Build VM, AMD EPYC-Rome, 16 vCPU, 32 GB, Node 24.22.1, measured under the bench lock.
  - Load average was 7.5–7.7 from other agents' work: the VM was shared, not quiet.
  - Synthetic input (`test/script-fix-synth.ts`): 20,000 transcript words (133 min) against 6,004 script tokens.
    Retakes, chatter, misrecognitions, drops and insertions; the script is read about 3 times.
- Result: aligned 85.6 %, off-script 9.1 %, 214 retake jumps, 740,887 merge cells, 791 candidates, 307 windows.
- Time (median of 5 runs):

  | Step | Median |
  |---|---|
  | `parseScript` | 43 ms |
  | `alignTranscript` | 2,362 ms |
  | `findFixCandidates` | 37 ms |
  | `buildScoreWindows` | 9 ms |
  | **Total** | **2,455 ms** (target ≤ 5 s) |

- Memory: peak RSS +116 MB over the first run (target ≤ 300 MB).
- Before the optimisations, on the same input: 11.7 s median. Merge lookups used Map counters and every psim was
  computed in full. Same machine and load, but measured with the CPU profiler attached, so the figure is inflated
  and not strictly comparable.
- Degenerate case (20,000 × "la" against 6,000 × "la"): 7.8 s, every row capped, still OK.

### Limitations and assumptions
- **Thresholds and margins.**
  - They are the spike's, tuned on 16 of the user's items with mlx fp16 (F§1, §10).
  - They have not been re-measured with the editor's ONNX fp32 scorer; that is the SC-103 / SC-105 harnesses.
- **Score result times.** The SC-092 result word times are assumed to be absolute media flicks, like the request
  windows. If the scorer returns window-relative times, the engine must add the window start before calling
  `decideFix`.
- **Assumptions (not measured):**
  - the English loanword list and spelling hints;
  - proper-noun detection, i.e. mid-sentence capitals and brand-like spellings. The spike used a hand-pruned list of
    the user's own names, which can't ship.
- **Numbers.** Number words without digits ("dos" vs "tos") are not treated as numbers. That rule is the spike's
  digit test.
- **Glossary and the number rule.** The number rule also applies to glossary entries: an entry with digits is never
  offered.
- **`del` with no gap.** A `del` between words that touch (no gap) gets zero-length inserted words, because the edit
  must stay inside the gap and its neighbours keep their times exactly (SC-041).
- **Glued words.** Splits and glued words that are not exact concatenations are still missed at alignment
  (F§4.3: 2 of 96).
- **Homophones.** Undecidable by audio; the script wins ties (F§5.2).
- **Retakes.** Every take gets its own candidates; repeated takes share the fingerprint, so rejecting one rejects
  all.

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
