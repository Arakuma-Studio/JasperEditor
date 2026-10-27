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
